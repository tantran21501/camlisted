# 📹 Camlisted — YouTube Live Cams & Footage data pipeline

A daily-updated, categorized catalog of publicly available YouTube live cams and real-world footage — traffic cams, beaches, wildlife feeds, dashcams, city streets, and more. The output of this repository is **data**, not a website: every run produces `data/streams.json` (a JSON snapshot of the catalog) plus supporting JSON files, committed back to the repo.

> The public-facing static site (HTML/CSS/JS) was removed. This repo now only builds and maintains the data catalog. To build your own frontend, consume `data/streams.json`.

## What the pipeline does

Runs twice daily on GitHub Actions ([`.github/workflows/update.yml`](.github/workflows/update.yml)):

1. **Discovery** — searches YouTube in ~15 languages for live cams, dashcam and street footage, within the free API quota
2. **Liveness tracking** — offline streams get a `status='offline'` mark (with a 7-day removal countdown), and can return to `live` if they come back online
3. **Classification** — CLIP zero-shot thumbnail classification (`classify_thumbnails.py`) assigns categories from `config/categories.json`; false positives are removed; an optional Gemini pass (`ai_review.mjs`) reviews the pending-approval queue when `GEMINI_API_KEY` is set
4. **Vehicle counts** — `detect_vehicles.py` counts vehicles in traffic-cam frames (data collection only)
5. **Commit** — all changed JSON under `data/` and `config/` is committed

## Architecture

```
┌─────────────────┐   daily cron    ┌──────────────────┐
│ GitHub Actions   │ ──────────────▶│ YouTube Data API │
│ scripts/update.mjs│               └──────────────────┘
└────────┬────────┘
         │ saves / commits
         ▼
┌─────────────────┐
│ data/streams.json│  ← single source of truth (JSON)
│ + config/*.json  │
└─────────────────┘
```

- **Backend**: none. A single Node script handles discovery, liveness checks, classification, and cleanup, writing results to JSON files that are committed.
- **Quota budgeting**: YouTube's `search.list` allows ~100 calls/day; the script budgets these across keyword rotations and uses cheap `videos.list`/`channels.list` calls for everything else.

## Repo layout

- `scripts/update.mjs` — main pipeline (YouTube API → catalog)
- `scripts/state.mjs` — JSON read/write helpers for the catalog and blocklists
- `scripts/classify_thumbnails.py`, `scripts/detect_vehicles.py` — Python steps (CLIP / YOLO)
- `scripts/ai_review.mjs` — optional Gemini review of the pending queue
- `data/streams.json` — the catalog snapshot (schema: `streams-v2`)
- `config/` — keywords, category/tag definitions, blocklists
- `.github/workflows/update.yml` — the daily automation

## Running locally

```sh
export YOUTUBE_API_KEY=your_key
node scripts/update.mjs
python scripts/classify_thumbnails.py
node scripts/ai_review.mjs   # optional; needs GEMINI_API_KEY
```

No database, no accounts, no build step.

## License

[MIT](LICENSE) — the code is free to use. Video content belongs to its respective YouTube creators and is subject to [YouTube's Terms of Service](https://www.youtube.com/t/terms).