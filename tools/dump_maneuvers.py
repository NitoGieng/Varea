"""Dump diagnostico delle manovre: prerequisito per il rewrite del classificatore.

Prende un .FIT, esegue la pipeline identica ad api.py (resampling gap-aware a 1Hz
+ TWD dinamica Stormglass o GPS-fallback), poi emette due CSV:

  <prefix>_summary.csv   — una riga per manovra con tutte le feature usate dal
                           classificatore attuale (cross_min/max, delta_cog,
                           pre/post TWA mediana, durata turn, SOG collapse
                           ratio). L'utente aggiunge una colonna `type_truth`
                           a mano → è la ground truth per il nuovo detector.

  <prefix>_timeline.csv  — finestra [-30s, +30s] attorno a ogni manovra: ts,
                           lat, lon, sog, cog, twd, twa_signed, mure,
                           andatura. Da aprire in Excel per ispezione visiva.

Uso:
  python -m tools.dump_maneuvers path/to/session.fit --prefix output/sessione1

Il tool NON ri-classifica: legge le decisioni che il detector attuale ha preso
e le espone accanto alle feature, per capire dove sbaglia.
"""

import argparse
import os
import sys
from pathlib import Path
import pandas as pd
import numpy as np
from dotenv import load_dotenv

# Permette import del pacchetto src.* quando il tool è lanciato da repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.ingestion.fit_parser import TelemetryIngestor
from src.environment.stormglass_api import StormglassClient
from src.heuristics.wind_vectors import WindEstimator
from src.heuristics.maneuvers import ManeuverAnalyzer

# Riuso diretto degli helper di main.py per non duplicare (se main.py cambia
# la ricostruzione TWD/COG, il dump resta allineato al backend).
from main import _reconstruct_cog_from_gps, _build_dynamic_twd


# Finestra di contesto attorno a ogni manovra nel timeline CSV.
_TIMELINE_PRE_S = 30
_TIMELINE_POST_S = 30

# Stesse bande del classificatore attuale (src/heuristics/maneuvers.py) —
# replicate qui per estrarre le feature in modalità read-only, senza rieseguire
# detect_maneuvers.
_COG_PRE_LO = 10
_COG_PRE_HI = 5
_COG_POST_LO = 5
_COG_POST_HI = 10
_CROSS_WINDOW_PRE = 15
_CROSS_WINDOW_POST = 5
_CLASS_WINDOW_LAG_S = 8
_CLASS_WINDOW_LEN_S = 12


def _circular_mean_deg(values_deg: np.ndarray) -> float:
    if len(values_deg) == 0:
        return float('nan')
    rad = np.radians(values_deg)
    return float(np.degrees(np.arctan2(np.mean(np.sin(rad)), np.mean(np.cos(rad)))))


def _angular_diff(a, b):
    return (a - b + 180) % 360 - 180


def _run_pipeline(fit_path: Path):
    """Esegue la stessa catena di api.py fino al dataframe 1Hz con
    twd_dynamic + andatura + mure calcolati. Ritorna (df, maneuvers).
    """
    load_dotenv()
    api_key = os.getenv('STORMGLASS_API_KEY')

    ingestor = TelemetryIngestor(fit_path)
    df = ingestor.process()

    if df['cog_deg'].isna().all():
        df['cog_deg'] = _reconstruct_cog_from_gps(df)
    df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

    start_ts = int(pd.to_datetime(df.index[0]).timestamp())
    end_ts = int(pd.to_datetime(df.index[-1]).timestamp())

    api_twd_list = None
    if api_key:
        try:
            client = StormglassClient(api_key=api_key)
            weather = client.fetch_weather_for_session(df)
            hours = weather.get('hours', [])
            api_twd_list = [
                {'time': h['time'], 'twd': h['windDirection']['sg']}
                for h in hours
                if h.get('windDirection', {}).get('sg') is not None
            ]
            if not api_twd_list:
                api_twd_list = None
        except Exception as e:
            print(f"[!] Stormglass non disponibile: {e}. Fallback GPS.")

    wind_estimator = WindEstimator()
    global_twd = wind_estimator.estimate_twd(df) or 0.0

    df.index = pd.to_datetime(df.index)
    df = df.resample('1s').interpolate(method='linear', limit=30, limit_direction='forward')
    df['cog_deg'] = df['cog_deg'].ffill(limit=30)
    df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

    df['twd_dynamic'] = _build_dynamic_twd(
        df, api_twd_list, start_ts, end_ts, wind_estimator, global_twd
    )

    analyzer = ManeuverAnalyzer()
    df = analyzer.tag_points_of_sail(df, df['twd_dynamic'])
    maneuvers = analyzer.detect_maneuvers(df.copy(), df['twd_dynamic'])

    # `tag_points_of_sail` aggiunge `twa` (assoluto) ma non `twa_signed` né
    # `mure`: li ricalcolo qui perché servono al timeline CSV.
    df['twa_signed'] = _angular_diff(df['cog_deg'], df['twd_dynamic'])
    df['mure'] = analyzer._compute_stable_mure(df['twa_signed'])

    return df, maneuvers


def _extract_features(df: pd.DataFrame, maneuver: dict) -> dict:
    """Ricalcola le feature che il classificatore ha visto per questa manovra.
    Replica la logica di maneuvers.py:175-325 in lettura, senza ridecidere.
    """
    ts = pd.Timestamp(maneuver['timestamp'])
    if ts.tzinfo is not None:
        ts = ts.tz_convert(None)
    # L'indice di df può essere tz-naive o tz-aware; normalizzo per get_loc.
    idx_ref = df.index
    if idx_ref.tz is not None:
        ts = ts.tz_localize(idx_ref.tz) if ts.tzinfo is None else ts
    try:
        i = idx_ref.get_loc(ts)
    except KeyError:
        # Timestamp non esatto (raro): nearest.
        i = idx_ref.get_indexer([ts], method='nearest')[0]
    if isinstance(i, slice):
        i = i.start

    n = len(df)
    twa_abs = df['twa_signed'].abs()

    # Cross window (firma fisica: passaggio a prua vs a poppa)
    cross_lo = max(0, i - _CROSS_WINDOW_PRE)
    cross_hi = min(n, i + _CROSS_WINDOW_POST)
    cross_win = twa_abs.iloc[cross_lo:cross_hi]
    cross_min = float(cross_win.min()) if len(cross_win) else float('nan')
    cross_max = float(cross_win.max()) if len(cross_win) else float('nan')
    n_low = int((cross_win < 30).sum())
    n_high = int((cross_win > 150).sum())

    # Δcog pre/post (sanity gate fisico)
    pre_cog_win = df['cog_deg'].iloc[max(0, i - _COG_PRE_LO):max(0, i - _COG_PRE_HI)].to_numpy()
    post_cog_win = df['cog_deg'].iloc[min(n, i + _COG_POST_LO):min(n, i + _COG_POST_HI)].to_numpy()
    pre_cog = _circular_mean_deg(pre_cog_win)
    post_cog = _circular_mean_deg(post_cog_win)
    delta_cog = abs(_angular_diff(post_cog, pre_cog)) if len(pre_cog_win) and len(post_cog_win) else float('nan')

    # Andatura pre/post stabile (voto fallback)
    pre_twa = twa_abs.iloc[max(0, i - _CLASS_WINDOW_LAG_S - _CLASS_WINDOW_LEN_S):max(0, i - _CLASS_WINDOW_LAG_S)]
    post_twa = twa_abs.iloc[min(n, i + _CLASS_WINDOW_LAG_S):min(n, i + _CLASS_WINDOW_LAG_S + _CLASS_WINDOW_LEN_S)]
    pre_twa_med = float(pre_twa.median()) if len(pre_twa) else float('nan')
    post_twa_med = float(post_twa.median()) if len(post_twa) else float('nan')

    # Feature foil-specifiche (che il classificatore v2 userà)
    sog_in = float(maneuver.get('sog_in') or 0.0)
    sog_min = float(maneuver.get('sog_min') or 0.0)
    sog_collapse_ratio = (sog_min / sog_in) if sog_in > 0.1 else float('nan')

    return {
        'ts_utc': str(ts),
        'ts_local_hhmmss': ts.strftime('%H:%M:%S'),
        'type_detected': maneuver.get('type'),
        'type_truth': '',  # campo da annotare a mano
        'twd_at_maneuver': maneuver.get('twd_at_maneuver'),
        # Gate Δcog
        'pre_cog': round(pre_cog, 1) if not np.isnan(pre_cog) else '',
        'post_cog': round(post_cog, 1) if not np.isnan(post_cog) else '',
        'delta_cog': round(delta_cog, 1) if not np.isnan(delta_cog) else '',
        # Segnale crossing
        'cross_min_twa': round(cross_min, 1) if not np.isnan(cross_min) else '',
        'cross_max_twa': round(cross_max, 1) if not np.isnan(cross_max) else '',
        'n_samples_low_band': n_low,   # |TWA| < 30°  (virata)
        'n_samples_high_band': n_high, # |TWA| > 150° (strambata)
        # Voto mediana andatura
        'pre_twa_median': round(pre_twa_med, 1) if not np.isnan(pre_twa_med) else '',
        'post_twa_median': round(post_twa_med, 1) if not np.isnan(post_twa_med) else '',
        # Feature foil v2
        'sog_in': sog_in,
        'sog_min': sog_min,
        'sog_out': maneuver.get('sog_out'),
        'sog_collapse_ratio': round(sog_collapse_ratio, 2) if not np.isnan(sog_collapse_ratio) else '',
        'duration_s': maneuver.get('duration_s'),
        'recovery_time_s': maneuver.get('recovery_time_s'),
        'delta_v': maneuver.get('delta_v'),
    }


def _build_timeline(df: pd.DataFrame, maneuvers: list) -> pd.DataFrame:
    """Per ogni manovra emette una finestra [-30s, +30s] con telemetria raw."""
    rows = []
    idx_ref = df.index
    for m_num, m in enumerate(maneuvers, start=1):
        ts = pd.Timestamp(m['timestamp'])
        if ts.tzinfo is not None and idx_ref.tz is None:
            ts = ts.tz_convert(None)
        try:
            i = idx_ref.get_loc(ts)
        except KeyError:
            i = idx_ref.get_indexer([ts], method='nearest')[0]
        if isinstance(i, slice):
            i = i.start

        lo = max(0, i - _TIMELINE_PRE_S)
        hi = min(len(df), i + _TIMELINE_POST_S + 1)
        window = df.iloc[lo:hi]

        for offset, (ts_row, row) in enumerate(window.iterrows(), start=lo - i):
            rows.append({
                'maneuver_num': m_num,
                'type_detected': m.get('type'),
                'offset_s': offset,
                'ts_utc': str(ts_row),
                'lat': round(row['lat'], 6),
                'lon': round(row['lon'], 6),
                'sog_knots': round(row['sog_knots'], 2),
                'cog_deg': round(row['cog_deg'], 1),
                'twd_deg': round(row['twd_dynamic'], 1),
                'twa_signed': round(row['twa_signed'], 1),
                'twa_abs': round(abs(row['twa_signed']), 1),
                'mure': int(row['mure']),
                'andatura': row.get('andatura', ''),
            })
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser(description="Dump ground-truth delle manovre (pipeline Varea)")
    parser.add_argument('file_path', type=str, help='Path al .FIT (o .CSV)')
    parser.add_argument('--prefix', type=str, default='maneuvers',
                        help='Prefisso file di output (default: maneuvers → maneuvers_summary.csv, maneuvers_timeline.csv)')
    args = parser.parse_args()

    fit_path = Path(args.file_path)
    if not fit_path.exists():
        print(f"Errore: {fit_path} non esiste.")
        return

    print(f"Pipeline su: {fit_path.name}")
    df, maneuvers = _run_pipeline(fit_path)
    print(f"Manovre rilevate: {len(maneuvers)}")

    summary_rows = [_extract_features(df, m) for m in maneuvers]
    summary_df = pd.DataFrame(summary_rows)
    summary_path = f"{args.prefix}_summary.csv"
    summary_df.to_csv(summary_path, index=False)
    print(f"[OK] Summary: {summary_path} ({len(summary_rows)} righe)")

    timeline_df = _build_timeline(df, maneuvers)
    timeline_path = f"{args.prefix}_timeline.csv"
    timeline_df.to_csv(timeline_path, index=False)
    print(f"[OK] Timeline: {timeline_path} ({len(timeline_df)} righe)")

    print("\nAnnotare 'type_truth' (Virata/Strambata) nel summary e salvarlo:")
    print("diventa il ground truth per la validazione del classificatore v2.")


if __name__ == '__main__':
    main()
