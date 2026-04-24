from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pathlib import Path
import tempfile
import os
import requests 
import json
from dotenv import load_dotenv

load_dotenv()
import pandas as pd
import numpy as np 

from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer

app = FastAPI(title="The Admiralty API")

CACHE_FILE = "weather_cache.json"

def get_cached_weather(session_id):
    session_id_str = str(session_id)
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r') as f:
                cache = json.load(f)
                return cache.get(session_id_str)
        except Exception:
            return None
    return None

def save_cached_weather(session_id, api_data):
    session_id_str = str(session_id)
    cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r') as f:
                cache = json.load(f)
        except Exception:
            pass
            
    cache[session_id_str] = api_data
    
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=4)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# GZip sulle risposte >1KB. Il payload /api/analyze cresce linearmente con la
# durata della sessione (high_res_track 1Hz): una sessione 6h è ~2-3MB di JSON
# ad alta compressibilità (molti float ripetuti, campi andatura testuali).
# La compressione browser-side è trasparente ed è lo standard per questo caso.
app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.post("/api/analyze")
async def analyze_fit_file(file: UploadFile = File(...)):
    print(f"\n--- Ricevuto file: {file.filename} ---")
    if not (file.filename.lower().endswith('.fit') or file.filename.lower().endswith('.csv')):
        raise HTTPException(status_code=400, detail="Il file deve essere .FIT o .CSV")

    suffix = Path(file.filename).suffix
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        content = await file.read()
        temp_file.write(content)
        temp_file_path = Path(temp_file.name)

    try:
        # --- FASE 1: INGESTIONE ---
        print("1/4 Ingestione dati...")
        ingestor = TelemetryIngestor(temp_file_path)
        df = ingestor.process()
        
        # SALVATAGGIO ROTTA
        if df['cog_deg'].isna().all():
            print("⚠️ Bussola non rilevata nel file FIT. Calcolo la rotta dal GPS...")
            d_lon = df['lon'].diff()
            d_lat = df['lat'].diff()
            df['cog_deg'] = np.degrees(np.arctan2(d_lon * np.cos(np.radians(df['lat'])), d_lat)) % 360
            df['cog_deg'] = df['cog_deg'].bfill()
        
        # Pulizia dati
        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])
        
        sog_max = float(df['sog_knots'].max())
        sog_avg = float(df['sog_knots'].mean())
        distance_nm = float((df['sog_knots'] / 3600).sum())

        lat_start = df['lat'].iloc[0]
        lon_start = df['lon'].iloc[0]
        start_ts = int(pd.to_datetime(df.index[0]).timestamp())
        end_ts = int(pd.to_datetime(df.index[-1]).timestamp())
        STORMGLASS_API_KEY = os.getenv("STORMGLASS_API_KEY")

        wind_estimator = WindEstimator()
        analyzer = ManeuverAnalyzer()

        global_computed_twd = wind_estimator.estimate_twd(df)
        if global_computed_twd is None:
            global_computed_twd = 0.0

        # --- FASE 2: RICHIESTA DATI METEO ---
        print("2/4 Controllo Dati Meteo...")
        api_twd_list = None
        
        skip_cache = os.environ.get('VAREA_SKIP_WEATHER_CACHE', '').strip() == '1'
        cached_data = None if skip_cache else get_cached_weather(start_ts)

        if skip_cache:
            print("⏭️  VAREA_SKIP_WEATHER_CACHE=1 → cache ignorata, forzo chiamata API.")

        if cached_data:
            print("🟢 Dati meteo trovati nella CACHE locale!")
            api_twd_list = cached_data
        elif STORMGLASS_API_KEY:
            print("🟠 Dati non in cache. Chiamata API Stormglass...")
            url = f"https://api.stormglass.io/v2/weather/point"
            params = {
                'lat': lat_start,
                'lng': lon_start,
                'params': 'windDirection',
                'start': start_ts,
                'end': end_ts,
                'source': 'sg'
            }
            headers = {'Authorization': STORMGLASS_API_KEY}
            try:
                response = requests.get(url, params=params, headers=headers)
                if response.status_code == 200:
                    data = response.json()
                    # Capturo sia i TWD che i timestamp reali dei bin orari.
                    # Stormglass allinea le ore sui bordi :00 (es. 10:00, 11:00),
                    # NON uniformemente su [start_ts, end_ts]. Usare linspace
                    # come proxy sposta le curve TWD fino a 30 min dai valori
                    # reali, generando TWA sbagliato a blocchi e manovre
                    # fantasma. Salvo il formato esteso in cache.
                    api_twd_list = [
                        {
                            'time': hour['time'],
                            'twd': hour['windDirection']['sg'],
                        }
                        for hour in data['hours']
                    ]
                    save_cached_weather(start_ts, api_twd_list)
                else:
                    print(f"❌ Errore API Stormglass ({response.status_code})")
            except Exception as e:
                print(f"❌ Errore di connessione a Stormglass: {e}")
        else:
            print("⚠️ Nessuna API Key. Uso la stima GPS.")
        
        # --- RESAMPLING A 1Hz ---
        # Interpolazione LIMITATA a gap di 30s. Su file multi-ora l'auto-pause
        # Garmin (o una pausa pranzo) crea buchi da decine di minuti: senza
        # limit, la resample+interpolate riempie quei gap con punti GPS lineari
        # fra il "prima" e il "dopo", generando tracciato fittizio, SOG interpolata
        # e manovre fantasma nel segmento inventato. Gap >30s restano NaN e le
        # righe vengono droppate subito dopo: il detector riceve solo sample reali.
        print("Standardizzazione frequenza a 1Hz...")
        df.index = pd.to_datetime(df.index)
        df = df.resample('1s').interpolate(method='linear', limit=30, limit_direction='forward')
        df['cog_deg'] = df['cog_deg'].ffill(limit=30)
        pre_drop = len(df)
        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])
        dropped = pre_drop - len(df)
        if dropped > 0:
            print(f"   → scartate {dropped}s di gap temporali (>30s, pausa o segnale perso).")

        # --- FASE 3: CALCOLO VENTO DINAMICO ---
        print("3/4 Generazione Curva Vento Dinamica...")
        if api_twd_list and len(api_twd_list) > 0:
            # Backward-compat cache: vecchie entry sono liste piatte di TWD,
            # nuove sono liste di dict {'time', 'twd'}. Rilevo il formato e
            # ricostruisco api_times coerenti.
            first_elem = api_twd_list[0]
            if isinstance(first_elem, dict):
                # Formato nuovo: tempi reali dai bordi orari Stormglass
                api_twd_values = np.asarray([e['twd'] for e in api_twd_list], dtype=float)
                api_time_strs = [e['time'] for e in api_twd_list]
                api_times = np.array(
                    [pd.Timestamp(t).timestamp() for t in api_time_strs],
                    dtype=float,
                )
            else:
                # Formato legacy: solo TWD, ricostruisco i tempi come linspace
                # (approssimazione con errore fino a 30 min — accettabile solo
                # per cache esistenti che l'utente non vuole rigenerare).
                api_twd_values = np.asarray(api_twd_list, dtype=float)
                api_times = np.linspace(start_ts, end_ts, len(api_twd_values))

            if len(api_twd_values) == 1:
                # Singola ora: TWD costante su tutta la sessione.
                df['twd_dynamic'] = float(api_twd_values[0])
            else:
                # Interpolazione tempo-indicizzata con unwrap circolare.
                # L'unwrap e' l'unica interpolazione stabile sul cerchio: se
                # TWD passa da 350° a 10° (rotazione oraria +20°) lineare sui
                # gradi grezzi produrrebbe -340° e farebbe ruotare il TWD di
                # 340° nel senso sbagliato, falsando ogni TWA e generando
                # manovre fantasma quando il COG costante viene confrontato
                # con il TWD ruotato al contrario.
                api_rad_unwrapped = np.unwrap(np.radians(api_twd_values))
                # df_times in epoch-seconds int64. Passare per datetime64[s]
                # evita la dipendenza dall'unita' interna di DatetimeIndex:
                # in pandas 3.x astype('int64') diretto produrrebbe
                # microsecondi invece di nanosecondi, rompendo silenziosamente.
                df_times = df.index.values.astype('datetime64[s]').astype('int64')
                twd_interp_rad = np.interp(df_times, api_times, api_rad_unwrapped)
                df['twd_dynamic'] = np.degrees(twd_interp_rad) % 360
        else:
            df['twd_dynamic'] = np.nan
            try:
                df.index = pd.to_datetime(df.index)
                for interval, block in df.groupby(pd.Grouper(freq='30min')):
                    if len(block) > 20: 
                        twd_block = wind_estimator.estimate_twd(block)
                        if twd_block is not None:
                            mid_idx = block.index[len(block)//2]
                            df.loc[mid_idx, 'twd_dynamic'] = twd_block

                valid_nodes = df['twd_dynamic'].dropna()
                if not valid_nodes.empty:
                    unwrapped_rads = np.unwrap(np.radians(valid_nodes.values))
                    df.loc[valid_nodes.index, 'twd_dynamic'] = unwrapped_rads
                    df['twd_dynamic'] = df['twd_dynamic'].interpolate(method='time')
                    df['twd_dynamic'] = (np.degrees(df['twd_dynamic']) % 360)
                    df['twd_dynamic'] = df['twd_dynamic'].bfill().ffill()
                else:
                    df['twd_dynamic'] = global_computed_twd
            except Exception as e:
                df['twd_dynamic'] = global_computed_twd

        # --- FASE 4: MANOVRE E TWA ---
        print("4/4 Calcolo Manovre e Angoli...")
        df = analyzer.tag_points_of_sail(df, df['twd_dynamic'])
        maneuvers_log = analyzer.detect_maneuvers(df, df['twd_dynamic'])
        df['twa'] = analyzer.angular_diff(df['cog_deg'], df['twd_dynamic']).abs()

        # --- FASE 5: OUTPUT JSON DOPPIO BINARIO ---
        print("5/5 Generazione Output...")
        df = df.fillna(0.0)
        
        # BINARIO 1: Mappa (1 punto ogni 5 secondi, leggero)
        map_df = df.iloc[::5] 
        track_data = []
        for idx, row in map_df.iterrows():
            if row['lat'] != 0.0 and row['lon'] != 0.0:
                track_data.append({
                    "timestamp": str(idx),
                    "lat": float(row['lat']),
                    "lon": float(row['lon']),
                    "sog_knots": float(row['sog_knots']),
                    "twa": float(row['twa']),
                    "andatura": str(row.get('andatura', 'Sconosciuta'))
                })

        # BINARIO 2: Alta Risoluzione 1Hz — StartAnalysis, mappa (solo sessioni <= 1h)
        # e grafico SOG delle manovre (sempre). Arricchito con lat/lon/twa/andatura.
        high_res_track = []
        for idx, row in df.iterrows():
            if row['lat'] == 0.0 and row['lon'] == 0.0:
                continue
            high_res_track.append({
                "timestamp": str(idx),
                "lat": float(row['lat']),
                "lon": float(row['lon']),
                "sog_knots": float(row['sog_knots']),
                "cog_deg": float(row['cog_deg']),
                "twa": float(row['twa']),
                "andatura": str(row.get('andatura', 'Sconosciuta'))
            })

        try:
            real_start_time = str(df.index[0])
            real_end_time = str(df.index[-1])
            duration_sec = int((pd.to_datetime(real_end_time) - pd.to_datetime(real_start_time)).total_seconds())
        except Exception:
            real_start_time = "2024-01-01T12:00:00Z"
            duration_sec = len(df)
            
        # Report mostra il primo TWD orario. Gestisco sia il formato nuovo
        # ({'time','twd'}) sia il legacy (lista piatta) per non rompere
        # la UI quando si lavora con cache vecchie.
        if api_twd_list:
            first = api_twd_list[0]
            api_twd_display = first['twd'] if isinstance(first, dict) else first
        else:
            api_twd_display = None

        report = {
            "session_info": {
                "file_name": file.filename,
                "start_time": real_start_time, 
                "duration_seconds": duration_sec,
                "distance_nm": round(distance_nm, 2),
                "sog_max_kts": round(sog_max, 2),
                "sog_avg_kts": round(sog_avg, 2)
            },
            "environment": {
                "api_twd_deg": api_twd_display,
                "computed_twd_deg": float(global_computed_twd),
                "is_estimated": api_twd_list is None
            },
            "track_data": track_data,
            "high_res_track": high_res_track, # <-- IL NUOVO MOTORE È QUI
            "maneuvers": maneuvers_log
        }
        
        print(f"✅ Analisi completata! Punti HR: {len(high_res_track)}")
        return report

    except Exception as e:
        print(f"❌ ERRORE CRITICO in Python: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        os.unlink(temp_file_path)

if __name__ == "__main__":
    import uvicorn
    print("🚀 Avvio di The Admiralty API sulla porta 8000...")
    uvicorn.run(app, host="0.0.0.0", port=8000)