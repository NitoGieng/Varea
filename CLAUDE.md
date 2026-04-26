# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working agreement — Git & GitHub

As you work in this repo, commit and push regularly so the remote always holds the latest saved state of the project. Never lose work.

- After each meaningful change (a feature added, a bug fixed, a refactor completed), make a commit locally and push to `origin/main`.
- Write **clean, descriptive commit messages** in the imperative mood that explain the *why*, not a restatement of the diff. Avoid placeholders like `k`, `wip`, `update`, or `fix`.
- Remote: `https://github.com/NitoGieng/Varea.git` (renamed from `STA` — use the new URL).
- Do not push broken code intentionally. If something is mid-flight and doesn't run, say so and wait for confirmation before pushing.
- Confirm with the user before any destructive git operation (force push, `reset --hard`, branch deletion, history rewrite).

## Project overview

Varea (formerly STA) analyzes `.FIT` / `.CSV` telemetry files from GPS watches to extract sailing/windsurfing performance metrics (true wind direction, points of sail, maneuver efficiency, VMG). The repo contains **one Python core engine** and **three user-facing surfaces** that all consume it:

- `main.py` — CLI: reads a `.FIT`, writes a `session_report.json`.
- `app.py` — Streamlit dashboard (legacy/prototype UI, still functional).
- `api.py` — FastAPI server on port 8000, consumed by the React frontend.
- `the-admiralty/` — React 19 + Vite + TS + Tailwind frontend (the "real" UI). Calls `POST /api/analyze` on the FastAPI server.

All three Python entry points import the same modules under `src/`; changes to the engine affect every surface.

## Commands

### Python (from repo root)

```bash
# CLI analysis
python main.py path/to/session.fit --output report.json

# Streamlit dashboard
streamlit run app.py

# FastAPI backend (serves /api/analyze for the React frontend)
python api.py          # uvicorn on 0.0.0.0:8000
```

There is no `requirements.txt` / `pyproject.toml` yet. Deps live in `.venv/`. Known imports: `fastapi`, `uvicorn`, `streamlit`, `pandas`, `numpy`, `plotly`, `requests`, `fitparse`, `python-dotenv`, `fpdf2` (fpdf).

### Frontend (`the-admiralty/`)

```bash
cd the-admiralty
npm run dev       # Vite dev server
npm run build     # tsc -b && vite build
npm run lint      # eslint .
npm run preview   # preview production build
```

### Environment

`.env` at repo root must contain `STORMGLASS_API_KEY=...`. Without it, the pipeline still runs but skips the satellite wind lookup and falls back to the GPS-only heuristic estimator.

## Architecture

### The Core Engine (`src/`) — the part that matters

Pipeline is the same across all entry points: **ingest → enrich → estimate wind → tag + detect maneuvers → emit report**.

- **`src/ingestion/fit_parser.py`** — `TelemetryIngestor.process()` decodes `.FIT` (via `fitparse`) or `.CSV`, converts semicircles→degrees and m/s→knots, resamples to **1 Hz**, applies outlier masking (SOG cap 50 kts, accel cap 15 kts/s), and 3-sample rolling smoothing on `sog_knots`. Returns a `DataFrame` indexed by timestamp with at least `lat`, `lon`, `sog_knots`, `cog_deg`.

- **`src/environment/stormglass_api.py`** — `StormglassClient.fetch_weather_for_session(df)` pulls historical `windDirection` (e altri parametri) per la **avg lat/lon** della sessione e cacha la risposta in `data/cache/<md5>.json` (chiave: lat/lon arrotondati a 0.1° + data) tramite `JSONCacheManager`. Tutti e tre i frontend (CLI/Streamlit/FastAPI) usano questo client: nessuna cache parallela.

- **`src/heuristics/wind_vectors.py`** — `WindEstimator.estimate_twd()` infers TWD by histogramming valid COG (SOG > 4 kts), smoothing circularly, picking the two dominant peaks (tack/gybe directions), and returning the midpoint. If Stormglass provides `api_twd`, it's used as a sanity check/fallback. This is the **only** source of wind when the API is unavailable.

- **`src/heuristics/maneuvers.py`** — `ManeuverAnalyzer.tag_points_of_sail(df, twd)` labels each row (Bolina / Traverso / Lasco-Poppa) based on the angular diff between `cog_deg` and TWD. `detect_maneuvers()` scans for tack/gybe events and returns a list of `{timestamp, type, sog_in, sog_min, delta_v}` dicts used downstream for the "maneuver efficiency" metrics.

### Critical nuances

- **COG fallback**: Many Garmin `.FIT` files have missing or all-zero `cog_deg`. `main.py`, `api.py` e `tools/dump_maneuvers.py` ricostruiscono COG da lat/lon via bearing sferico (helper condiviso `main._reconstruct_cog_from_gps`). `app.py` (Streamlit legacy) ha la sua copia inline. Se aggiungi una nuova entry point, importa l'helper di main.py per non divergere.

- **Dynamic TWD condivisa**: `main._build_dynamic_twd` è l'unica fonte della curva TWD time-varying — `main.py`, `api.py` e `tools/dump_maneuvers.py` la chiamano tutti. Con dati Stormglass interpola fra i valori orari (unwrap circolare → `np.interp` su epoch-seconds → re-wrap mod 360); senza, fa fallback su blocchi 30-min stimati dal GPS. `app.py` (Streamlit legacy) usa ancora un TWD costante. Tutte le TWA / andature downstream consumano questa curva.

- **Dual-track API response**: `api.py` returns two parallel arrays — `track_data` (every 5th point, for the map) and `high_res_track` (full 1 Hz, for the start-analysis view). Adding a new field means deciding which track(s) it belongs in based on downstream consumption.

- **Stateless backend, stateful frontend**: FastAPI does a one-shot analyze-and-return per upload. All session state (filters, time windows, view mode) lives in `Dashboard.tsx` React state.

### Frontend structure (`the-admiralty/src/`)

- `App.tsx` just renders `Dashboard`.
- `pages/Dashboard.tsx` — the shell. Holds uploaded telemetry, time-window filter state (relative + absolute clock), and switches between views: `overview`, `maneuvers`, `lab`, `start`.
- `pages/Maneuvers.tsx`, `pages/StartAnalysis.tsx` — view-specific panels.
- `components/charts/` — Plotly/Recharts wrappers (`TelemetryMap`, `ManeuverFootprint`, etc.).

### Language note

All in-code comments, docstrings, and user-facing strings are in **Italian**. When editing, match the existing language rather than translating to English.
