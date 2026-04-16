from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
        
        cached_data = get_cached_weather(start_ts)
        
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
                    api_twd_list = [hour['windDirection']['sg'] for hour in data['hours']]
                    save_cached_weather(start_ts, api_twd_list)
                else:
                    print(f"❌ Errore API Stormglass ({response.status_code})")
            except Exception as e:
                print(f"❌ Errore di connessione a Stormglass: {e}")
        else:
            print("⚠️ Nessuna API Key. Uso la stima GPS.")
        
        # --- RESAMPLING A 1Hz ---
        print("Standardizzazione frequenza a 1Hz...")
        df.index = pd.to_datetime(df.index)
        df = df.resample('1s').interpolate(method='linear')
        df['cog_deg'] = df['cog_deg'].ffill()

        # --- FASE 3: CALCOLO VENTO DINAMICO ---
        print("3/4 Generazione Curva Vento Dinamica...")
        if api_twd_list and len(api_twd_list) > 0: 
            twd_points = np.linspace(api_twd_list[0], api_twd_list[-1], len(df))
            df['twd_dynamic'] = twd_points
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

        # BINARIO 2: Alta Risoluzione per Start Analysis (1Hz puro, solo essenziali)
        high_res_track = []
        for idx, row in df.iterrows():
            high_res_track.append({
                "timestamp": str(idx),
                "sog_knots": float(row['sog_knots']),
                "cog_deg": float(row['cog_deg'])
            })

        try:
            real_start_time = str(df.index[0])
            real_end_time = str(df.index[-1])
            duration_sec = int((pd.to_datetime(real_end_time) - pd.to_datetime(real_start_time)).total_seconds())
        except Exception:
            real_start_time = "2024-01-01T12:00:00Z"
            duration_sec = len(df)
            
        api_twd_display = api_twd_list[0] if api_twd_list else None

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