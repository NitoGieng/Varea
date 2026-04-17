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

- **`src/environment/stormglass_api.py`** — `StormglassClient` pulls historical `windDirection` for the session's start lat/lon and time range. `api.py` additionally implements a **session-level cache in `weather_cache.json`** keyed by start-timestamp to avoid burning API quota across reruns.

- **`src/heuristics/wind_vectors.py`** — `WindEstimator.estimate_twd()` infers TWD by histogramming valid COG (SOG > 4 kts), smoothing circularly, picking the two dominant peaks (tack/gybe directions), and returning the midpoint. If Stormglass provides `api_twd`, it's used as a sanity check/fallback. This is the **only** source of wind when the API is unavailable.

- **`src/heuristics/maneuvers.py`** — `ManeuverAnalyzer.tag_points_of_sail(df, twd)` labels each row (Bolina / Traverso / Lasco-Poppa) based on the angular diff between `cog_deg` and TWD. `detect_maneuvers()` scans for tack/gybe events and returns a list of `{timestamp, type, sog_in, sog_min, delta_v}` dicts used downstream for the "maneuver efficiency" metrics.

### Critical nuances

- **COG fallback**: Many Garmin `.FIT` files have missing or all-zero `cog_deg`. Both `app.py` and `api.py` reconstruct COG from consecutive GPS points using spherical trig (`np.arctan2(...)`) when needed. The CLI in `main.py` does **not** — so a CLI run on a Garmin file without a compass will degrade silently. If you add a new entry point, replicate the COG reconstruction.

- **Dynamic TWD in `api.py`**: Unlike `app.py` (single TWD for the whole session), `api.py` builds a **time-varying TWD curve**. With Stormglass data it linearly interpolates between the hourly API values over the session length; without it, it runs the estimator on rolling 30-min blocks, unwraps the angular series, interpolates, and re-wraps to 0–360°. All TWA / point-of-sail calculations downstream use this dynamic curve.

- **Dual-track API response**: `api.py` returns two parallel arrays — `track_data` (every 5th point, for the map) and `high_res_track` (full 1 Hz, for the start-analysis view). Adding a new field means deciding which track(s) it belongs in based on downstream consumption.

- **Stateless backend, stateful frontend**: FastAPI does a one-shot analyze-and-return per upload. All session state (filters, time windows, view mode) lives in `Dashboard.tsx` React state.

### Frontend structure (`the-admiralty/src/`)

- `App.tsx` just renders `Dashboard`.
- `pages/Dashboard.tsx` — the shell. Holds uploaded telemetry, time-window filter state (relative + absolute clock), and switches between views: `overview`, `maneuvers`, `lab`, `start`.
- `pages/Maneuvers.tsx`, `pages/StartAnalysis.tsx` — view-specific panels.
- `components/charts/` — Plotly/Recharts wrappers (`TelemetryMap`, `ManeuverFootprint`, etc.).

### Language note

All in-code comments, docstrings, and user-facing strings are in **Italian**. When editing, match the existing language rather than translating to English.
