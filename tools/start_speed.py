"""Velocità al taglio della linea di partenza.

Prende un .FIT + l'ora locale della partenza (HH:MM:SS) e stampa la SOG in una
finestra ± qualche secondo attorno al taglio. Usa la stessa pipeline di
ingestion/resampling di api.py, così il numero combacia con quello che la
Dashboard mostra per lo stesso istante.

Uso:
  python -m tools.start_speed path/to/session.fit 15:38:28
  python -m tools.start_speed path/to/session.fit 15:38:28 --window 10

Nessuna chiamata di rete: non serve Stormglass né il classificatore manovre —
solo telemetria raw già ricampionata a 1 Hz.
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
import pandas as pd

# Permette import del pacchetto src.* quando il tool è lanciato da repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.ingestion.fit_parser import TelemetryIngestor

# Riuso l'helper di main.py per la ricostruzione COG: i .FIT Garmin senza
# bussola hanno cog_deg vuoto e senza questo fallback la colonna resta NaN.
from main import _reconstruct_cog_from_gps


def _parse_start_time(s: str, session_date: pd.Timestamp) -> pd.Timestamp:
    """Accetta 'HH:MM:SS' (ora locale) o ISO completo. Nel primo caso applica
    la data della sessione e la timezone di sistema, così il timestamp finisce
    coerente con l'indice UTC del dataframe.
    """
    s = s.strip()
    if 'T' in s or ' ' in s:
        return pd.Timestamp(s)

    try:
        hms = datetime.strptime(s, '%H:%M:%S').time()
    except ValueError:
        raise SystemExit(f"Formato ora non valido: '{s}'. Usa HH:MM:SS.")

    local_date = session_date.astimezone().date() if session_date.tzinfo else session_date.date()
    local_dt = datetime.combine(local_date, hms).astimezone()
    return pd.Timestamp(local_dt).tz_convert('UTC').tz_localize(None)


def _ts_local(ts: pd.Timestamp) -> str:
    py_dt = ts.to_pydatetime()
    if py_dt.tzinfo is None:
        py_dt = py_dt.replace(tzinfo=timezone.utc)
    return py_dt.astimezone().strftime('%H:%M:%S')


def main():
    parser = argparse.ArgumentParser(description="SOG al taglio della linea di partenza")
    parser.add_argument('file_path', type=str, help='Path al .FIT (o .CSV)')
    parser.add_argument('start_time', type=str,
                        help='Ora del taglio linea, HH:MM:SS locale (es. 15:38:28) o ISO completo')
    parser.add_argument('--window', type=int, default=5,
                        help='Finestra ± secondi attorno al taglio (default: 5)')
    args = parser.parse_args()

    fit_path = Path(args.file_path)
    if not fit_path.exists():
        raise SystemExit(f"Errore: {fit_path} non esiste.")

    print(f"Pipeline su: {fit_path.name}")
    ingestor = TelemetryIngestor(fit_path)
    df = ingestor.process()

    if df['cog_deg'].isna().all():
        df['cog_deg'] = _reconstruct_cog_from_gps(df)
    df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

    df.index = pd.to_datetime(df.index)
    df = df.resample('1s').interpolate(method='linear', limit=30, limit_direction='forward')
    df['cog_deg'] = df['cog_deg'].ffill(limit=30)
    df = df.dropna(subset=['lat', 'lon', 'sog_knots'])

    target = _parse_start_time(args.start_time, df.index[0])

    if target < df.index[0] or target > df.index[-1]:
        raise SystemExit(
            f"Timestamp {_ts_local(target)} fuori dalla sessione "
            f"({_ts_local(df.index[0])} → {_ts_local(df.index[-1])})."
        )

    try:
        i = df.index.get_loc(target)
    except KeyError:
        i = int(df.index.get_indexer([target], method='nearest')[0])
    if isinstance(i, slice):
        i = i.start

    w = max(1, int(args.window))
    lo = max(0, i - w)
    hi = min(len(df), i + w + 1)
    window = df.iloc[lo:hi]

    print()
    print(f"Finestra +/-{w}s attorno a {_ts_local(target)} (locale):")
    print("  ora      | d_s | SOG (kts) | COG (deg)")
    print("-" * 46)
    for idx, (ts, row) in enumerate(window.iterrows(), start=lo):
        marker = ' <--' if idx == i else ''
        offset = idx - i
        print(
            f"  {_ts_local(ts)} | {offset:+3d} | "
            f"{row['sog_knots']:>8.2f}  | {row['cog_deg']:>5.1f}{marker}"
        )

    sog_at = float(df.iloc[i]['sog_knots'])
    cog_at = float(df.iloc[i]['cog_deg'])
    sog_max = float(window['sog_knots'].max())
    sog_avg = float(window['sog_knots'].mean())

    print()
    print(f"SOG al taglio ({_ts_local(df.index[i])}): {sog_at:.2f} kts (COG {cog_at:.1f} deg)")
    print(f"Picco nella finestra: {sog_max:.2f} kts | media: {sog_avg:.2f} kts")


if __name__ == '__main__':
    main()
