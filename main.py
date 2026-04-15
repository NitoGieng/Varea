import os
import json
import argparse
from pathlib import Path
from dotenv import load_dotenv

# Import dei moduli del nostro Core Engine
from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer

def main():
    # 1. Configurazione Interfaccia a Riga di Comando (CLI)
    parser = argparse.ArgumentParser(description="Sail & Windsurf Telemetry Analyzer")
    parser.add_argument("file_path", type=str, help="Percorso del file .FIT da analizzare")
    parser.add_argument("--output", type=str, default="session_report.json", help="Percorso di salvataggio del report JSON (opzionale)")
    args = parser.parse_args()

    file_path = Path(args.file_path)
    if not file_path.exists():
        print(f"Errore: Il file {file_path} non esiste. Controlla il percorso.")
        return

    # 2. Caricamento Variabili d'Ambiente (.env)
    load_dotenv()
    api_key = os.getenv('STORMGLASS_API_KEY')
    if not api_key:
        print("[!] Avviso: STORMGLASS_API_KEY non trovata nel file .env. L'API non verrà interrogata.")

    print(f"Inizio analisi sessione: {file_path.name}")

    try:
        # --- FASE 1: Ingestione ---
        print("1/4 Decodifica e pulizia file binario .FIT...")
        ingestor = TelemetryIngestor(file_path)
        df = ingestor.process()
        
        # Calcolo Statistiche di base
        sog_max = df['sog_knots'].max()
        sog_avg = df['sog_knots'].mean()
        # Calcolo distanza nautica (SOG in nodi * tempo in ore).
        # A 1Hz, 1 secondo = 1/3600 ore.
        distance_nm = (df['sog_knots'].fillna(0) / 3600).sum()

        # --- FASE 2: Arricchimento Ambientale ---
        print("2/4 Recupero dati meteo-marini (API & Cache)...")
        api_twd = None
        if api_key:
            client = StormglassClient(api_key=api_key)
            try:
                weather_data = client.fetch_weather_for_session(df)
                # Estraiamo il TWD macro dal primo record per passarlo al motore euristico
                if 'hours' in weather_data and len(weather_data['hours']) > 0:
                    api_twd = weather_data['hours'][0].get('windDirection', {}).get('sg')
            except Exception as e:
                print(f"  [!] Rilevato errore API: {e}. Procedo in modalità offline (Fallback).")

        # --- FASE 3: Core Euristico ---
        print("3/4 Calcolo vettoriale della True Wind Direction (TWD)...")
        wind_estimator = WindEstimator()
        computed_twd = wind_estimator.estimate_twd(df, api_twd=api_twd)
        print(f"  -> TWD Calcolato: {computed_twd}°")

        # --- FASE 4: Analisi Manovre ---
        print("4/4 Tagging andature ed estrazione metriche manovre...")
        analyzer = ManeuverAnalyzer()
        df = analyzer.tag_points_of_sail(df, computed_twd)
        maneuvers_log = analyzer.detect_maneuvers(df, computed_twd)
        print(f"  -> Trovate {len(maneuvers_log)} manovre valide.")

        # --- FASE 5: Generazione Output ---
        print("Scrittura del file di Output...")
        
        # Prepariamo le liste per la mappa (rimuovendo eventuali NaN per evitare errori JSON)
        lats = df['position_lat_degrees'].fillna(0).tolist()
        lons = df['position_long_degrees'].fillna(0).tolist()
        speeds = df['sog_knots'].fillna(0).tolist()

        report = {
            "session_info": {
                "file_name": file_path.name,
                "duration_seconds": len(df),
                "distance_nm": round(distance_nm, 2),
                "sog_max_kts": round(sog_max, 2),
                "sog_avg_kts": round(sog_avg, 2)
            },
            "environment": {
                "api_twd_deg": api_twd,
                "computed_twd_deg": computed_twd
            },
            "telemetry_track": {
                "lats": lats,
                "lons": lons,
                "speeds": speeds
            },
            "maneuvers": maneuvers_log
        }

        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=4)
        
        print(f"✅ Analisi completata con successo! Report salvato in: {args.output}")

    except Exception as e:
        print(f"❌ Errore critico durante l'analisi: {e}")

if __name__ == "__main__":
    main()