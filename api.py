from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pathlib import Path
import tempfile
import os
from dotenv import load_dotenv

load_dotenv()
import numpy as np
import pandas as pd

from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer
from src.heuristics.maneuver_log import write_diagnostic_log
from main import _reconstruct_cog_from_gps, _build_dynamic_twd

# Log manovre sovrascritto ad ogni analisi. Path relativo alla CWD del processo
# api.py (= root backend), così dopo un upload l'atleta lo apre senza cercarlo.
MANEUVERS_LOG_FILE = "maneuvers_log.txt"

app = FastAPI(title="The Admiralty API")

# CORS: in produzione (Render) settare ALLOWED_ORIGINS con la lista delle
# origini consentite separate da virgola (es. "https://varea.vercel.app").
# In assenza della env var (=sviluppo locale) lasciamo "*" cosi' il Vite
# dev server su porta variabile non viene bloccato.
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "*").strip()
_allowed_origins = (
    ["*"] if _allowed_origins_env == "*"
    else [o.strip() for o in _allowed_origins_env.split(",") if o.strip()]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
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
        print("1/5 Ingestione dati...")
        ingestor = TelemetryIngestor(temp_file_path)
        df = ingestor.process()

        # Bussola GPS-fallback (alcuni .FIT Garmin hanno cog_deg vuoto). Riuso
        # l'helper di main.py: senza COG il detector resterebbe cieco al moto.
        if df['cog_deg'].isna().all():
            print("⚠️ Bussola non rilevata nel file FIT. Calcolo la rotta dal GPS...")
            df['cog_deg'] = _reconstruct_cog_from_gps(df)

        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

        sog_max = float(df['sog_knots'].max())
        sog_avg = float(df['sog_knots'].mean())
        distance_nm = float((df['sog_knots'] / 3600).sum())

        start_ts = int(pd.to_datetime(df.index[0]).timestamp())
        end_ts = int(pd.to_datetime(df.index[-1]).timestamp())

        wind_estimator = WindEstimator()
        analyzer = ManeuverAnalyzer()

        global_computed_twd = wind_estimator.estimate_twd(df)
        if global_computed_twd is None:
            global_computed_twd = 0.0

        # --- FASE 2: METEO STORMGLASS ---
        # Stesso codepath di main.py / dump_maneuvers: query avg-lat/lon e
        # cache condivisa in data/cache/ (JSONCacheManager). Prima il backend
        # viveva su un cache separato (weather_cache.json) keyed sullo start
        # lat/lon: stessa sessione, TWD diversa, manovre classificate
        # diversamente fra UI e CLI. Ora un unico source of truth.
        print("2/5 Recupero dati meteo (Stormglass)...")
        api_key = os.getenv("STORMGLASS_API_KEY")
        api_twd_list = None
        if api_key:
            client = StormglassClient(api_key=api_key)
            try:
                weather_data = client.fetch_weather_for_session(df)
                hours = weather_data.get('hours', [])
                api_twd_list = [
                    {'time': h['time'], 'twd': h['windDirection']['sg']}
                    for h in hours
                    if h.get('windDirection', {}).get('sg') is not None
                ]
                if not api_twd_list:
                    api_twd_list = None
                    print("   → risposta Stormglass priva di windDirection valido.")
            except Exception as e:
                print(f"   [!] Errore Stormglass: {e}. Fallback GPS.")
        else:
            print("⚠️ Nessuna API Key. Uso la stima GPS.")

        # --- FASE 3: RESAMPLING 1Hz GAP-AWARE ---
        # Interpolazione LIMITATA a gap di 30s. Su file multi-ora l'auto-pause
        # Garmin (o una pausa pranzo) crea buchi da decine di minuti: senza
        # limit, la resample+interpolate riempie quei gap con punti GPS lineari
        # fra il "prima" e il "dopo", generando tracciato fittizio, SOG interpolata
        # e manovre fantasma nel segmento inventato. Gap >30s restano NaN e le
        # righe vengono droppate subito dopo: il detector riceve solo sample reali.
        print("3/5 Standardizzazione frequenza a 1Hz...")
        df.index = pd.to_datetime(df.index)
        df = df.resample('1s').interpolate(method='linear', limit=30, limit_direction='forward')
        df['cog_deg'] = df['cog_deg'].ffill(limit=30)
        pre_drop = len(df)
        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])
        dropped = pre_drop - len(df)
        if dropped > 0:
            print(f"   → scartate {dropped}s di gap temporali (>30s, pausa o segnale perso).")

        # --- FASE 4: TWD DINAMICA ---
        print("4/5 Generazione curva vento dinamica...")
        df['twd_dynamic'] = _build_dynamic_twd(
            df, api_twd_list, start_ts, end_ts, wind_estimator, global_computed_twd
        )

        # --- FASE 5: MANOVRE E TWA ---
        print("5/5 Calcolo manovre e angoli...")
        df = analyzer.tag_points_of_sail(df, df['twd_dynamic'])
        maneuvers_log = analyzer.detect_maneuvers(df, df['twd_dynamic'])
        df['twa'] = analyzer.angular_diff(df['cog_deg'], df['twd_dynamic']).abs()

        # --- VMG: Velocity Made Good ---
        # vmg = sog * cos(twa), signed: positivo = guadagno verso vento (bolina),
        # negativo = perdita relativa al vento (lasco/poppa). Punto-per-punto sul
        # resample 1Hz: NaN dove twa o sog mancano. Il frontend interrompe la
        # linea sui null. Aggregati: bolina come signed (positivo), lasco come
        # |vmg| medio (positivo, "velocita' verso sottovento") cosi' l'UI mostra
        # entrambi i KPI come numeri positivi confrontabili.
        df['vmg_knots'] = df['sog_knots'] * np.cos(np.radians(df['twa']))
        vmg_valid_mask = df['vmg_knots'].notna()

        bolina_mask = df['andatura'] == 'Bolina'
        lasco_mask = df['andatura'] == 'Lasco/Poppa'

        def _safe_float(v):
            return None if pd.isna(v) else float(v)

        vmg_bolina_avg = _safe_float(df.loc[bolina_mask, 'vmg_knots'].mean()) if bolina_mask.any() else None
        vmg_bolina_max = _safe_float(df.loc[bolina_mask, 'vmg_knots'].max()) if bolina_mask.any() else None
        vmg_lasco_avg = _safe_float(df.loc[lasco_mask, 'vmg_knots'].abs().mean()) if lasco_mask.any() else None
        # SOG media in bolina/lasco sullo stesso periodo: serve al frontend per
        # mostrare la riga di confronto "Vel. media bolina X -> VMG effettiva Y"
        # senza dover ricalcolare lato client (single source of truth).
        sog_bolina_avg = _safe_float(df.loc[bolina_mask, 'sog_knots'].mean()) if bolina_mask.any() else None
        sog_lasco_avg = _safe_float(df.loc[lasco_mask, 'sog_knots'].mean()) if lasco_mask.any() else None

        # Log diagnostico leggibile nella root del backend. Non blocca la
        # risposta API se per qualche motivo la scrittura fallisce.
        try:
            write_diagnostic_log(
                Path(MANEUVERS_LOG_FILE),
                file.filename,
                df,
                maneuvers_log,
                df['twd_dynamic'],
            )
            tot_v = sum(1 for m in maneuvers_log if 'virata' in (m.get('type') or '').lower())
            tot_s = sum(1 for m in maneuvers_log if 'strambata' in (m.get('type') or '').lower())
            print(f"📄 Log manovre: {MANEUVERS_LOG_FILE}  ({tot_v}V / {tot_s}S)")
        except Exception as e:
            print(f"⚠️  Scrittura log manovre fallita: {e}")

        # --- OUTPUT JSON DOPPIO BINARIO ---
        df = df.fillna(0.0)

        # BINARIO 1: Mappa (1 punto ogni 5 secondi, leggero)
        # vmg_knots e' null quando twa non era disponibile (TWD assente) cosi'
        # il frontend interrompe la linea VMG senza fittizi 0.0 dopo il fillna.
        map_df = df.iloc[::5]
        track_data = []
        for idx, row in map_df.iterrows():
            if row['lat'] != 0.0 and row['lon'] != 0.0:
                vmg_valid = bool(vmg_valid_mask.loc[idx]) if idx in vmg_valid_mask.index else False
                track_data.append({
                    "timestamp": str(idx),
                    "lat": float(row['lat']),
                    "lon": float(row['lon']),
                    "sog_knots": float(row['sog_knots']),
                    "twa": float(row['twa']),
                    "andatura": str(row.get('andatura', 'Sconosciuta')),
                    "vmg_knots": float(row['vmg_knots']) if vmg_valid else None
                })

        # BINARIO 2: Alta Risoluzione 1Hz — StartAnalysis, mappa (solo sessioni <= 1h)
        # e grafico SOG delle manovre (sempre). Arricchito con lat/lon/twa/andatura/vmg.
        high_res_track = []
        for idx, row in df.iterrows():
            if row['lat'] == 0.0 and row['lon'] == 0.0:
                continue
            vmg_valid = bool(vmg_valid_mask.loc[idx]) if idx in vmg_valid_mask.index else False
            high_res_track.append({
                "timestamp": str(idx),
                "lat": float(row['lat']),
                "lon": float(row['lon']),
                "sog_knots": float(row['sog_knots']),
                "cog_deg": float(row['cog_deg']),
                "twa": float(row['twa']),
                "andatura": str(row.get('andatura', 'Sconosciuta')),
                "vmg_knots": float(row['vmg_knots']) if vmg_valid else None
            })

        try:
            real_start_time = str(df.index[0])
            real_end_time = str(df.index[-1])
            duration_sec = int((pd.to_datetime(real_end_time) - pd.to_datetime(real_start_time)).total_seconds())
        except Exception:
            real_start_time = "2024-01-01T12:00:00Z"
            duration_sec = len(df)

        api_twd_display = api_twd_list[0]['twd'] if api_twd_list else None

        # Timeline TWD oraria: serve al frontend per (a) il mini-grafico TWD vs
        # tempo nella panoramica, (b) la freccia del vento nel Lab interpolata
        # all'istante della manovra invece di usare la media globale, (c) la
        # rotazione del vento nel report PDF. Stormglass restituisce 1 punto/h:
        # il frontend replica l'unwrap+lerp di _build_dynamic_twd via utils/wind.ts
        # per coerenza con i tag manovre lato backend. None se Stormglass off.
        twd_timeline = None
        if api_twd_list:
            twd_timeline = [
                {"timestamp": str(e['time']), "twd_deg": float(e['twd'])}
                for e in api_twd_list
            ]

        # Helper per arrotondare gli aggregati VMG senza far esplodere None.
        def _round_or_none(v, ndigits):
            return None if v is None else round(v, ndigits)

        report = {
            "session_info": {
                "file_name": file.filename,
                "start_time": real_start_time,
                "duration_seconds": duration_sec,
                "distance_nm": round(distance_nm, 2),
                "sog_max_kts": round(sog_max, 2),
                "sog_avg_kts": round(sog_avg, 2),
                # Aggregati VMG sull'intera sessione. Le card della Panoramica
                # ricalcolano questi valori sul track filtrato dal clock usando
                # vmg_knots punto-per-punto: questi sono il "summary globale"
                # esposto per altri consumatori (PDF, CLI, futuri export).
                "vmg_bolina_avg_kts": _round_or_none(vmg_bolina_avg, 2),
                "vmg_bolina_max_kts": _round_or_none(vmg_bolina_max, 2),
                "vmg_lasco_avg_kts": _round_or_none(vmg_lasco_avg, 2),
                "sog_bolina_avg_kts": _round_or_none(sog_bolina_avg, 2),
                "sog_lasco_avg_kts": _round_or_none(sog_lasco_avg, 2)
            },
            "environment": {
                "api_twd_deg": api_twd_display,
                "computed_twd_deg": float(global_computed_twd),
                "is_estimated": api_twd_list is None,
                "twd_timeline": twd_timeline
            },
            "track_data": track_data,
            "high_res_track": high_res_track,
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
