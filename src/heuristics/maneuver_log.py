"""Log diagnostico leggibile delle manovre rilevate.

Scrive un .txt compatto (una riga per manovra con le feature del classificatore)
nella root del backend. Serve per confrontare il conteggio del detector con
la ground-truth memorizzata dall'atleta: aprendolo dopo ogni upload si
vede subito perché una strambata è stata marcata come virata (o viceversa).

Il file viene sovrascritto ad ogni analisi.
"""
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import pandas as pd


def _circular_mean_deg(values: np.ndarray) -> float:
    if len(values) == 0:
        return float('nan')
    rad = np.radians(values)
    return float(np.degrees(np.arctan2(np.mean(np.sin(rad)), np.mean(np.cos(rad)))))


def _angular_diff(a, b):
    return (a - b + 180) % 360 - 180


def _ts_local(ts: pd.Timestamp) -> str:
    """Converte un timestamp (assunto UTC, .FIT spec) all'ora locale di sistema.
    Serve per allineare il log con l'orologio che l'atleta ricorda, non con UTC.
    """
    py_dt = ts.to_pydatetime()
    if py_dt.tzinfo is None:
        py_dt = py_dt.replace(tzinfo=timezone.utc)
    return py_dt.astimezone().strftime('%H:%M:%S')


def write_diagnostic_log(
    out_path: Path,
    fit_filename: str,
    df: pd.DataFrame,
    maneuvers: list,
    twd_series: pd.Series,
) -> None:
    """Genera maneuvers_log.txt con totali + una riga per manovra.

    Colonne della riga manovra (stessa semantica usata dal classificatore in
    src/heuristics/maneuvers.py, replicata qui in sola lettura):
      - cross_min/max  : estremi di |TWA| nella finestra [i-15, i+5]s
      - n_lo / n_hi    : sample con |TWA|<30° / |TWA|>150° (bande virata / strambata)
      - Δcog           : rotazione COG tra finestre pre/post stabili (sanity-gate)
      - TWA pre/post   : mediana di |TWA| su finestre [i-20,i-8]s e [i+8,i+20]s
      - collapse       : sog_min / sog_in (feature foil: bassi = splashdown)
    """
    twa_signed = pd.Series(
        _angular_diff(df['cog_deg'].to_numpy(), twd_series.to_numpy()),
        index=df.index,
    )
    twa_abs = twa_signed.abs()

    tot_v = sum(1 for m in maneuvers if 'virata' in (m.get('type') or '').lower())
    tot_s = sum(1 for m in maneuvers if 'strambata' in (m.get('type') or '').lower())
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    dur_s = len(df)

    lines = [
        f"[Varea] Log manovre — analisi {now}",
        f"File: {fit_filename}",
        f"Durata sessione: {dur_s}s ({dur_s // 3600}h {(dur_s % 3600) // 60:02d}m)",
        f"Totali: {tot_v}V  /  {tot_s}S   ({len(maneuvers)} manovre)",
        "",
        "Legenda:",
        "  cross_min/max = estremi di |TWA| nella finestra [-15s, +5s] attorno all'evento",
        "  n_lo / n_hi   = sample con |TWA|<30° (virata) / |TWA|>150° (strambata)",
        "  Δcog          = rotazione COG tra finestre pre/post stabili (sanity-gate)",
        "  TWA pre/post  = mediana di |TWA| su [-20s,-8s] e [+8s,+20s]",
        "  collapse      = sog_min / sog_in  (foil: basso = splashdown, alto = fly-through)",
        "",
        "  # | ora      | tipo       | cross_min | cross_max | n_lo | n_hi | Δcog   | TWA pre | TWA post | sog_in | sog_min | sog_out | coll.",
        "-" * 145,
    ]

    idx_ref = df.index
    total = len(df)

    for n, m in enumerate(maneuvers, start=1):
        ts = pd.Timestamp(m['timestamp'])
        if ts.tzinfo is not None and idx_ref.tz is None:
            ts = ts.tz_convert(None)
        try:
            i = idx_ref.get_loc(ts)
        except KeyError:
            i = int(idx_ref.get_indexer([ts], method='nearest')[0])
        if isinstance(i, slice):
            i = i.start

        # Finestra di crossing fisico
        cross_win = twa_abs.iloc[max(0, i - 15):min(total, i + 5)]
        cross_min = float(cross_win.min()) if len(cross_win) else float('nan')
        cross_max = float(cross_win.max()) if len(cross_win) else float('nan')
        n_low = int((cross_win < 30).sum())
        n_high = int((cross_win > 150).sum())

        # Δcog tra finestre pre/post stabili
        pre_cog_win = df['cog_deg'].iloc[max(0, i - 10):max(0, i - 5)].to_numpy()
        post_cog_win = df['cog_deg'].iloc[min(total, i + 5):min(total, i + 10)].to_numpy()
        pre_cog = _circular_mean_deg(pre_cog_win)
        post_cog = _circular_mean_deg(post_cog_win)
        delta_cog = (
            abs(_angular_diff(post_cog, pre_cog))
            if len(pre_cog_win) and len(post_cog_win)
            else float('nan')
        )

        # TWA pre/post (voto mediana di fallback del classificatore)
        pre_twa = twa_abs.iloc[max(0, i - 20):max(0, i - 8)]
        post_twa = twa_abs.iloc[min(total, i + 8):min(total, i + 20)]
        pre_twa_med = float(pre_twa.median()) if len(pre_twa) else float('nan')
        post_twa_med = float(post_twa.median()) if len(post_twa) else float('nan')

        tipo = (m.get('type') or '?').upper()
        sog_in = float(m.get('sog_in') or 0.0)
        sog_min = float(m.get('sog_min') or 0.0)
        sog_out = float(m.get('sog_out') or 0.0)
        collapse = (sog_min / sog_in) if sog_in > 0.1 else float('nan')

        lines.append(
            f"{n:>3} | {_ts_local(ts)} | {tipo:<10} | "
            f"{cross_min:>8.1f}° | {cross_max:>8.1f}° | "
            f"{n_low:>4} | {n_high:>4} | {delta_cog:>5.1f}° | "
            f"{pre_twa_med:>6.1f}° | {post_twa_med:>7.1f}° | "
            f"{sog_in:>5.1f}  | {sog_min:>6.1f}  | {sog_out:>6.1f}  | {collapse:>4.2f}"
        )

    Path(out_path).write_text("\n".join(lines) + "\n", encoding='utf-8')
