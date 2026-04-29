"""Regression test del classificatore manovre.

Esegue la pipeline manovre (TelemetryIngestor + COG fallback + TWD dinamica
Stormglass/GPS + ManeuverAnalyzer) sui file di riferimento annotati a mano
dall'utente, e verifica che dentro la finestra regata:

  - vengano rilevate esattamente N manovre quante la ground truth indica;
  - ogni manovra detected sia accoppiabile a un timestamp truth entro
    --tolerance secondi (default: 10);
  - il tipo (Virata/Strambata) corrisponda a quello annotato.

NON e' una calibrazione: gli unici valori "fissati" qui sono i timestamp
osservati visivamente dall'utente al cronometro, non costanti del detector.
Se una modifica a src/heuristics/maneuvers.py o ai codepath TWD
(_build_dynamic_twd, Stormglass cache) rompe questo test, sta peggiorando
casi noti — fermarsi, capire perche', non rilassare la tolleranza.

Uso:
  python -m tools.validate_detector
  python -m tools.validate_detector --tolerance 15
  python -m tools.validate_detector --dataset poppi

Aggiungere una nuova regata: estendere REFERENCE_DATASETS con un nuovo dict.
Le finestre race_window_utc devono includere ~30s di margine prima/dopo le
manovre estreme, cosi' la stessa lista cattura tutte le detected anche con
qualche secondo di lag.

Exit code: 0 se tutti i dataset passano, 1 altrimenti (utile in CI / pre-commit).
"""

import argparse
import sys
from pathlib import Path
import pandas as pd

# Permette import del pacchetto src.* / tools.* quando il tool e' lanciato da repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.dump_maneuvers import _run_pipeline


# Tolleranza temporale di default: il filtro Schmitt+dwell ha un lag intrinseco
# di ~5-7s, e su poppi.FIT il delta osservato detected-vs-truth e' +2/+7s.
# 10s lascia ~3s di margine prima che un drift del filtro sfori la tolleranza.
DEFAULT_TOLERANCE_S = 10


# Dataset di riferimento. Ogni entry: file_path relativo alla repo root,
# finestra UTC della regata (con margine), e ground truth come (timestamp_utc, type).
# I timestamp sono UTC perche' l'indice del DataFrame post-resample e' UTC tz-naive
# e il match e' diretto. La conversione da CEST/locale e' fatta una volta a mano
# quando l'utente fornisce le annotazioni.
REFERENCE_DATASETS = [
    {
        "name": "poppi 2026-04-10 (regata pomeriggio)",
        "file_path": "poppi.FIT",
        "race_window_utc": ("2026-04-10T13:38:00", "2026-04-10T13:52:00"),
        # Ground truth: 4 virate + 6 strambate, fornite dall'utente in CEST
        # (UTC+2 per data DST 10 aprile 2026), convertite qui a UTC.
        "ground_truth": [
            ("2026-04-10T13:40:12", "Virata"),
            ("2026-04-10T13:42:16", "Virata"),
            ("2026-04-10T13:42:44", "Virata"),
            ("2026-04-10T13:43:40", "Strambata"),
            ("2026-04-10T13:44:47", "Strambata"),
            ("2026-04-10T13:45:33", "Strambata"),
            ("2026-04-10T13:47:36", "Virata"),
            ("2026-04-10T13:49:25", "Strambata"),
            ("2026-04-10T13:50:07", "Strambata"),
            ("2026-04-10T13:51:09", "Strambata"),
        ],
    },
]


def _ts(s) -> pd.Timestamp:
    ts = pd.Timestamp(s)
    if ts.tzinfo is not None:
        ts = ts.tz_convert(None)
    return ts


def _validate_dataset(ds: dict, tolerance_s: int):
    """Ritorna (status, lines) dove status in {'PASS','FAIL','SKIP'}."""
    lines = []
    name = ds["name"]
    fit_path = Path(ds["file_path"])

    if not fit_path.exists():
        return "SKIP", [f"  [SKIP] {name}: file '{fit_path}' non trovato (gitignored?)"]

    win_start = _ts(ds["race_window_utc"][0])
    win_end = _ts(ds["race_window_utc"][1])

    truth = [{"ts": _ts(t), "type": typ} for t, typ in ds["ground_truth"]]

    _, maneuvers = _run_pipeline(fit_path)

    # Detected nella sola finestra regata: il file puo' coprire ore di sessione
    # ma il validatore giudica solo la finestra annotata.
    detected = []
    for m in maneuvers:
        ts = _ts(m["timestamp"])
        if win_start <= ts <= win_end:
            detected.append({"ts": ts, "type": m["type"]})

    # Greedy nearest-neighbor matching: per ogni truth, scelgo il detected non
    # ancora accoppiato piu' vicino entro tolerance. Greedy e' sufficiente
    # perche' n e' piccolo (~10) e i timestamp non si sovrappongono.
    used_detected = set()
    matches = []
    missed = []
    for t in truth:
        best_idx = None
        best_dt = None
        for i, d in enumerate(detected):
            if i in used_detected:
                continue
            dt = abs((d["ts"] - t["ts"]).total_seconds())
            if dt <= tolerance_s and (best_dt is None or dt < best_dt):
                best_idx = i
                best_dt = dt
        if best_idx is None:
            missed.append(t)
        else:
            used_detected.add(best_idx)
            d = detected[best_idx]
            matches.append({
                "truth": t,
                "detected": d,
                "dt": (d["ts"] - t["ts"]).total_seconds(),
            })

    extras = [d for i, d in enumerate(detected) if i not in used_detected]
    type_errors = [m for m in matches if m["truth"]["type"] != m["detected"]["type"]]

    passed = (len(missed) == 0 and len(extras) == 0 and len(type_errors) == 0)

    lines.append(f"  Dataset: {name}")
    lines.append(f"  File:    {fit_path}")
    lines.append(f"  Window:  {win_start} -> {win_end} UTC")
    lines.append(
        f"  Truth: {len(truth)} | Detected (in window): {len(detected)} | "
        f"Matched: {len(matches)} | Type errors: {len(type_errors)} | "
        f"Missed: {len(missed)} | Extra: {len(extras)}"
    )
    lines.append("")
    lines.append("  truth_utc            type_truth   detected_utc         type_det     dt[s]  st")
    lines.append("  " + "-" * 84)
    for m in matches:
        ok = m["truth"]["type"] == m["detected"]["type"]
        lines.append(
            f"  {m['truth']['ts']}  {m['truth']['type']:<11s}  "
            f"{m['detected']['ts']}  {m['detected']['type']:<11s}  "
            f"{m['dt']:+5.1f}  {'OK ' if ok else 'ERR'}"
        )
    for t in missed:
        lines.append(
            f"  {t['ts']}  {t['type']:<11s}  "
            f"{'(MISSED)':<19s}  {'':<11s}      -  MIS"
        )
    for d in extras:
        lines.append(
            f"  {'(no truth)':<19s}  {'':<11s}  "
            f"{d['ts']}  {d['type']:<11s}      -  EXT"
        )

    return ("PASS" if passed else "FAIL"), lines


def main():
    parser = argparse.ArgumentParser(
        description="Regression test del classificatore manovre Varea"
    )
    parser.add_argument(
        "--tolerance", type=int, default=DEFAULT_TOLERANCE_S,
        help=f"Tolleranza in secondi sul match timestamp (default: {DEFAULT_TOLERANCE_S})",
    )
    parser.add_argument(
        "--dataset", type=str, default=None,
        help="Nome (substring) del singolo dataset da validare (default: tutti)",
    )
    args = parser.parse_args()

    targets = REFERENCE_DATASETS
    if args.dataset:
        targets = [d for d in REFERENCE_DATASETS if args.dataset.lower() in d["name"].lower()]
        if not targets:
            print(f"Nessun dataset matcha '{args.dataset}'. Disponibili:")
            for d in REFERENCE_DATASETS:
                print(f"  - {d['name']}")
            sys.exit(2)

    print(f"Validate detector -- tolerance +/-{args.tolerance}s, {len(targets)} dataset")
    print("=" * 88)

    summary = []
    fail_count = 0
    skip_count = 0
    for ds in targets:
        status, lines = _validate_dataset(ds, args.tolerance)
        for line in lines:
            print(line)
        print()
        print(f"  -> {status}")
        print("=" * 88)
        summary.append((ds["name"], status))
        if status == "FAIL":
            fail_count += 1
        elif status == "SKIP":
            skip_count += 1

    print()
    print("Summary:")
    for name, status in summary:
        print(f"  [{status}] {name}")

    if fail_count > 0:
        print()
        print(f"FAIL: {fail_count} dataset non passano. NON committare modifiche al detector.")
        sys.exit(1)
    if skip_count == len(summary):
        print()
        print("Tutti i dataset SKIP: nessun file di riferimento presente.")
        sys.exit(2)
    print()
    print("OK: tutti i dataset disponibili passano.")
    sys.exit(0)


if __name__ == "__main__":
    main()
