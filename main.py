import os
import json
import argparse
from pathlib import Path
import pandas as pd
import numpy as np
from dotenv import load_dotenv

from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer


def _reconstruct_cog_from_gps(df: pd.DataFrame) -> pd.Series:
    """Ricostruisce COG da lat/lon via bearing sferico. Serve per .FIT Garmin
    senza bussola, dove cog_deg arriva vuoto o a zero.
    """
    d_lon = df['lon'].diff()
    d_lat = df['lat'].diff()
    cog = np.degrees(np.arctan2(d_lon * np.cos(np.radians(df['lat'])), d_lat)) % 360
    return cog.bfill()


def _build_dynamic_twd(
    df: pd.DataFrame,
    api_twd_list: list | None,
    start_ts: int,
    end_ts: int,
    wind_estimator: WindEstimator,
    global_twd: float,
) -> pd.Series:
    """Costruisce curva TWD time-varying. Logica identica a api.py per parità
    fra CLI e backend (vedi api.py:160-222 per razionale dell'unwrap circolare
    e del fallback a blocchi 30-min).
    """
    if api_twd_list and len(api_twd_list) > 0:
        first = api_twd_list[0]
        if isinstance(first, dict):
            api_twd_values = np.asarray([e['twd'] for e in api_twd_list], dtype=float)
            api_times = np.array(
                [pd.Timestamp(e['time']).timestamp() for e in api_twd_list],
                dtype=float,
            )
        else:
            api_twd_values = np.asarray(api_twd_list, dtype=float)
            api_times = np.linspace(start_ts, end_ts, len(api_twd_values))

        if len(api_twd_values) == 1:
            return pd.Series(float(api_twd_values[0]), index=df.index)

        api_rad_unwrapped = np.unwrap(np.radians(api_twd_values))
        df_times = df.index.values.astype('datetime64[s]').astype('int64')
        twd_interp_rad = np.interp(df_times, api_times, api_rad_unwrapped)
        return pd.Series(np.degrees(twd_interp_rad) % 360, index=df.index)

    # Fallback GPS: blocchi 30-min, unwrap, interpolazione tempo-indicizzata
    twd = pd.Series(np.nan, index=df.index)
    for _, block in df.groupby(pd.Grouper(freq='30min')):
        if len(block) > 20:
            twd_block = wind_estimator.estimate_twd(block)
            if twd_block is not None:
                mid_idx = block.index[len(block) // 2]
                twd.loc[mid_idx] = twd_block

    valid = twd.dropna()
    if valid.empty:
        return pd.Series(float(global_twd), index=df.index)

    unwrapped = np.unwrap(np.radians(valid.values))
    twd.loc[valid.index] = unwrapped
    twd = twd.interpolate(method='time')
    twd = (np.degrees(twd) % 360).bfill().ffill()
    return twd


def main():
    parser = argparse.ArgumentParser(description="Varea Telemetry Analyzer (CLI)")
    parser.add_argument("file_path", type=str, help="Percorso del file .FIT o .CSV da analizzare")
    parser.add_argument("--output", type=str, default="session_report.json", help="Path JSON di output")
    args = parser.parse_args()

    file_path = Path(args.file_path)
    if not file_path.exists():
        print(f"Errore: {file_path} non esiste.")
        return

    load_dotenv()
    api_key = os.getenv('STORMGLASS_API_KEY')
    if not api_key:
        print("[!] STORMGLASS_API_KEY non trovata. Uso stima GPS.")

    print(f"Inizio analisi: {file_path.name}")

    try:
        # --- FASE 1: INGESTIONE ---
        print("1/5 Ingestione .FIT...")
        ingestor = TelemetryIngestor(file_path)
        df = ingestor.process()

        # Ricostruzione COG se la bussola manca (documentato come divergenza
        # nota in CLAUDE.md — qui la CLI si allinea ad api.py).
        if df['cog_deg'].isna().all():
            print("   → bussola assente, ricostruisco COG dal GPS.")
            df['cog_deg'] = _reconstruct_cog_from_gps(df)

        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

        sog_max = float(df['sog_knots'].max())
        sog_avg = float(df['sog_knots'].mean())
        distance_nm = float((df['sog_knots'] / 3600).sum())
        start_ts = int(pd.to_datetime(df.index[0]).timestamp())
        end_ts = int(pd.to_datetime(df.index[-1]).timestamp())

        # --- FASE 2: METEO ---
        print("2/5 Recupero dati meteo (Stormglass)...")
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

        wind_estimator = WindEstimator()
        global_twd = wind_estimator.estimate_twd(df)
        if global_twd is None:
            global_twd = 0.0

        # --- FASE 3: RESAMPLING 1Hz GAP-AWARE ---
        # Limite 30s sull'interpolate: pause/auto-pause non generano tracciato
        # fittizio che farebbe emettere manovre fantasma nel buco.
        print("3/5 Resampling 1Hz...")
        df.index = pd.to_datetime(df.index)
        df = df.resample('1s').interpolate(method='linear', limit=30, limit_direction='forward')
        df['cog_deg'] = df['cog_deg'].ffill(limit=30)
        pre_drop = len(df)
        df = df.dropna(subset=['lat', 'lon', 'sog_knots'])
        dropped = pre_drop - len(df)
        if dropped > 0:
            print(f"   → scartati {dropped}s di gap (>30s, pausa o segnale perso).")

        # --- FASE 4: TWD DINAMICA ---
        print("4/5 Curva TWD dinamica...")
        df['twd_dynamic'] = _build_dynamic_twd(
            df, api_twd_list, start_ts, end_ts, wind_estimator, global_twd
        )

        # --- FASE 5: MANOVRE ---
        print("5/5 Tagging andature + manovre...")
        analyzer = ManeuverAnalyzer()
        df = analyzer.tag_points_of_sail(df, df['twd_dynamic'])
        maneuvers_log = analyzer.detect_maneuvers(df, df['twd_dynamic'])
        print(f"   → {len(maneuvers_log)} manovre rilevate.")

        # --- OUTPUT ---
        df = df.fillna(0.0)

        api_twd_display = None
        if api_twd_list:
            first = api_twd_list[0]
            api_twd_display = first['twd'] if isinstance(first, dict) else first

        report = {
            "session_info": {
                "file_name": file_path.name,
                "start_time": str(df.index[0]),
                "duration_seconds": len(df),
                "distance_nm": round(distance_nm, 2),
                "sog_max_kts": round(sog_max, 2),
                "sog_avg_kts": round(sog_avg, 2),
            },
            "environment": {
                "api_twd_deg": api_twd_display,
                "computed_twd_deg": float(global_twd),
                "is_estimated": api_twd_list is None,
            },
            "telemetry_track": {
                "lats": df['lat'].tolist(),
                "lons": df['lon'].tolist(),
                "speeds": df['sog_knots'].tolist(),
            },
            "maneuvers": maneuvers_log,
        }

        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)

        print(f"✅ Report salvato: {args.output}")

    except Exception as e:
        print(f"❌ Errore critico: {e}")
        raise


if __name__ == "__main__":
    main()
