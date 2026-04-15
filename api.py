from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import tempfile
import os
from dotenv import load_dotenv

load_dotenv()
import pandas as pd
import numpy as np # <-- Aggiunto per i calcoli geometrici

# Import corretti (che puntano alla tua cartella src)
from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer

app = FastAPI(title="The Admiralty API")

# Setup per far comunicare React col server locale
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
        
        # SALVATAGGIO ROTTA: Se il Garmin non ha la bussola (cog_deg è tutto NaN)
        # la calcoliamo matematicamente dalle coordinate GPS!
        if df['cog_deg'].isna().all():
            print("⚠️ Bussola non rilevata nel file FIT. Calcolo la rotta dal GPS...")
            d_lon = df['lon'].diff()
            d_lat = df['lat'].diff()
            # Formula nautica per il Course Over Ground (Bearing)
            df['cog_deg'] = np.degrees(np.arctan2(d_lon * np.cos(np.radians(df['lat'])), d_lat)) % 360
            
            # Riempiamo il primo punto (che risulta NaN) col secondo
            df['cog_deg'] = df['cog_deg'].bfill()
        
        # Rimuoviamo i record dove il GPS ha perso il segnale per non sfalsare le medie
        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])
        
        sog_max = float(df['sog_knots'].max())
        sog_avg = float(df['sog_knots'].mean())
        distance_nm = float((df['sog_knots'] / 3600).sum())

        # --- FASE 2: API METEO (VERSIONE SICURA) ---
        print("2/4 Recupero Meteo da Stormglass...")
        api_twd = None 
        
        # Carica le variabili dal file .env se esiste
        from dotenv import load_dotenv
        load_dotenv()
        
        # Recupera la chiave dalle variabili di sistema
        api_key = os.getenv("STORMGLASS_API_KEY")
        
        if api_key:
            import requests
            try:
                # Usiamo la logica "cruda" che abbiamo testato con successo
                start_ts = int(pd.to_datetime(df.index[0]).timestamp())
                test_lat = float(df['lat'].iloc[0])
                test_lon = float(df['lon'].iloc[0])
                
                url = f"https://api.stormglass.io/v2/weather/point?lat={test_lat}&lng={test_lon}&params=windDirection&start={start_ts}&end={start_ts}"
                headers = {"Authorization": api_key}
                
                response = requests.get(url, headers=headers)
                if response.status_code == 200:
                    api_twd = response.json()['hours'][0]['windDirection']['sg']
                    print(f" ✅ VENTO SCARICATO CON SUCCESSO: {api_twd}°")
                else:
                    print(f" ❌ ERRORE API ({response.status_code}): {response.text}")
            except Exception as e:
                print(f" ⚠️ ERRORE DURANTE LA CHIAMATA: {e}")
        else:
            print("⚠️ Nessuna API KEY trovata nelle variabili d'ambiente. Salto il meteo reale.")

        # --- FASE 3: CALCOLO VENTO ---
        print("3/4 Calcolo TWD Finale...")
        wind_estimator = WindEstimator()
        
        # Passiamo il vento di Stormglass all'algoritmo. 
        # Se Stormglass fallisce (api_twd=None), l'algoritmo fa tutto da solo!
        computed_twd = wind_estimator.estimate_twd(df, api_twd=api_twd)
        
        if computed_twd is None:
            computed_twd = 0.0
        print(f" -> TWD Definitiva Calcolata: {computed_twd}°")

        # --- FASE 4: MANOVRE E TWA ---
        print("4/4 Calcolo Manovre e Angoli...")
        analyzer = ManeuverAnalyzer()
        df = analyzer.tag_points_of_sail(df, computed_twd)
        maneuvers_log = analyzer.detect_maneuvers(df, computed_twd)
        print(f" -> Trovate {len(maneuvers_log)} manovre.")

        df['twa'] = analyzer.angular_diff(df['cog_deg'], computed_twd).abs()

        # --- FASE 5: OUTPUT JSON ---
        print("5/5 Generazione Output...")
        
        # SOLO ORA possiamo trasformare gli eventuali NaN rimasti in 0.0 per compiacere React
        df = df.fillna(0.0)
        
        map_df = df.iloc[::5] # Sub-campionamento per non far esplodere la mappa
        
        track_data = []
        for _, row in map_df.iterrows():
            if row['lat'] != 0.0 and row['lon'] != 0.0:
                track_data.append({
                    "lat": float(row['lat']),
                    "lon": float(row['lon']),
                    "sog_knots": float(row['sog_knots']),
                    "twa": float(row['twa']),
                    "andatura": str(row.get('andatura', 'Sconosciuta'))
                })

        # Estraiamo la data REALE di partenza. Nei file FIT l'orario si trova sempre nell'indice (index).
        try:
            real_start_time = str(df.index[0])
        except Exception:
            real_start_time = "2024-01-01T12:00:00Z"

        report = {
            "session_info": {
                "file_name": file.filename,
                "start_time": real_start_time, # <-- ORA E' LA DATA REALE!
                "duration_seconds": len(df),
                "distance_nm": round(distance_nm, 2),
                "sog_max_kts": round(sog_max, 2),
                "sog_avg_kts": round(sog_avg, 2)
            },
            "environment": {
                "api_twd_deg": api_twd,
                "computed_twd_deg": float(computed_twd)
            },
            "track_data": track_data,
            "maneuvers": maneuvers_log
        }
        
        print(f"✅ Analisi completata! Punti mappa estratti: {len(track_data)}")
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