#!/usr/bin/env python3
"""
AI Location Resolver — Gemini fallback for unresolved cameras.

Run after location_resolver.py:

  python3 ai_location_resolver.py

Environment (from .env or shell):
  GEMINI_API_KEY
  GEMINI_MODEL (optional, default gemini-2.5-flash)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: python3 -m pip install requests")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DATA_DIR = ROOT_DIR / "data"
sys.path.insert(0, str(SCRIPT_DIR))

from location_resolver import (  # noqa: E402
    COUNTRIES,
    country_matches,
    geocode,
    iter_records,
    load_json,
    log_progress,
    save_json,
    valid_coords,
)

GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models"
BATCH_SIZE = 10
MODEL_FALLBACKS = ["gemini-flash-latest", "gemini-2.0-flash", "gemini-2.0-flash-lite"]


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def channel_country_code(item: Dict[str, Any]) -> Optional[str]:
    loc = item.get("location") or {}
    country = loc.get("country")
    if not country:
        return None
    if isinstance(country, str) and len(country) == 2:
        return country.upper()
    for code, name in COUNTRIES.items():
        if name == country or code == country:
            return code.upper() if len(code) == 2 else code
    return None


def build_prompt(items: List[Dict[str, Any]]) -> str:
    payload = []
    for item in items:
        loc = item.get("location") or {}
        payload.append({
            "video_id": item.get("video_id"),
            "title": item.get("title", ""),
            "channel_title": item.get("channel_title", ""),
            "channel_country": channel_country_code(item),
            "failed_hints": item.get("location_hints") or [],
            "prior_location": {
                "country": loc.get("country"),
                "level": loc.get("level"),
            } if loc else None,
        })

    return f"""You are a geolocation extractor for an Earth Camera directory of REAL-WORLD live streams.
Your job: determine where the CAMERA is physically located (filming location), NOT the uploader's country.

For each item, respond with structured JSON. Rules:

1. geocode_query — SHORT string optimized for OpenStreetMap/Nominatim (3-8 words).
   Format: "Landmark, City, Country" or "City, Region, Country".
   No emojis, no LIVE/4K/music junk, do NOT copy the full title.
   Example: "Yeouido, Seoul, South Korea"

2. lat/lng — ONLY fill when you are VERY confident (famous landmark with known coords).
   Default to null; we will geocode geocode_query instead.

3. resolvable=false when:
   - Hardware/product demo (Axis, Reolink, Hikvision, Dahua, Amcrest, PTZ test)
   - Generic backyard/bird feeder with NO city or region in title/channel
   - Music/ambient stream with no geographic place
   - No geographic clue at all

4. Filming location beats channel country. Korean title with 서울/한강 -> KR even if channel unclear.

5. failed_hints are BAD regex guesses — do NOT reuse them (e.g. wrong country, junk words).

6. location_title — short human label for UI (e.g. "Yeouido, Han River, Seoul").

7. country — ISO 3166-1 alpha-2 uppercase, or null.

8. confidence: 0.9 exact landmark, 0.7 city, 0.5 region, 0.3 country-only, 0.0 unresolvable.

9. level: place | city | region | country | unknown

Items:
{json.dumps(payload, ensure_ascii=False, indent=2)}

Respond ONLY as a JSON array, one object per item:
[{{"video_id":"...","resolvable":true,"confidence":0.85,"geocode_query":"Place, City, Country","location_title":"Short label","lat":null,"lng":null,"city":"...","region":"...","country":"KR","level":"place","reason":"..."}}]"""


def model_candidates() -> List[str]:
    preferred = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()
    seen, out = set(), []
    for model in [preferred, *MODEL_FALLBACKS]:
        if model and model not in seen:
            seen.add(model)
            out.append(model)
    return out


def request_gemini(api_key: str, model: str, prompt: str) -> requests.Response:
    url = f"{GEMINI_API}/{model}:generateContent?key={api_key}"
    return requests.post(
        url,
        headers={"Content-Type": "application/json"},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0,
            },
        },
        timeout=120,
    )


def call_gemini(api_key: str, prompt: str) -> List[Dict[str, Any]]:
    quota_hit = False
    for round_idx in range(3):
        if round_idx:
            wait = round_idx * 15
            print(f"  Retrying Gemini after transient error ({wait}s)...")
            time.sleep(wait)

        for model in model_candidates():
            try:
                response = request_gemini(api_key, model, prompt)
            except requests.RequestException as exc:
                print(f"  Model {model} request failed: {exc}", file=sys.stderr)
                continue

            if response.ok:
                data = response.json()
                text = (
                    data.get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text", "[]")
                )
                parsed = json.loads(text or "[]")
                if not isinstance(parsed, list):
                    raise ValueError(f"Expected JSON array from {model}")
                print(f"  Gemini model: {model}")
                return parsed

            body = response.text.replace("\n", " ")[:400]
            print(f"  Model {model} unavailable ({response.status_code}): {body}")
            if response.status_code == 429:
                quota_hit = True
            if response.status_code not in {404, 400}:
                time.sleep(2)

        if quota_hit:
            break

    raise RuntimeError("All Gemini models failed or quota exhausted")


def parse_ai_rows(raw: List[Dict[str, Any]], items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    by_id = {item["video_id"]: item for item in items if item.get("video_id")}
    out: Dict[str, Dict[str, Any]] = {}
    for row in raw:
        if not isinstance(row, dict):
            continue
        vid = row.get("video_id")
        if not vid and "i" in row:
            idx = row["i"]
            if isinstance(idx, int) and 0 <= idx < len(items):
                vid = items[idx].get("video_id")
        if not vid:
            continue
        out[vid] = row
    return out


def geocode_variants(ai: Dict[str, Any]) -> List[str]:
    queries: List[str] = []
    seen = set()

    def add(q: Optional[str]) -> None:
        if not q:
            return
        q = " ".join(str(q).split())
        key = q.casefold()
        if key and key not in seen:
            seen.add(key)
            queries.append(q)

    add(ai.get("geocode_query"))
    city, region, country = ai.get("city"), ai.get("region"), ai.get("country")
    country_name = COUNTRIES.get((country or "").upper(), country)
    if city and country_name:
        add(f"{city}, {country_name}")
    if city and region and country_name:
        add(f"{city}, {region}, {country_name}")
    title = ai.get("location_title")
    if title and country_name and country_name.casefold() not in str(title).casefold():
        add(f"{title}, {country_name}")
    return queries


def apply_ai_resolution(
    item: Dict[str, Any],
    ai: Dict[str, Any],
    geocode_cache: Dict[str, Any],
    delay: float,
) -> Dict[str, Any]:
    result = dict(item)
    result["ai"] = ai
    expected_country = (ai.get("country") or "").upper() or None
    evidence_label = ai.get("location_title") or ai.get("geocode_query") or ai.get("reason")

    if not ai.get("resolvable"):
        result["status"] = "unresolved"
        result["ai_reason"] = ai.get("reason")
        return result

    lat, lng = ai.get("lat"), ai.get("lng")
    if valid_coords(lat, lng):
        address = {"country_code": expected_country} if expected_country else {}
        if not expected_country or country_matches(address, expected_country):
            conf = min(float(ai.get("confidence") or 0.7), 0.85)
            result["location"] = {
                "lat": float(lat),
                "lng": float(lng),
                "city": ai.get("city"),
                "region": ai.get("region"),
                "country": expected_country,
                "level": ai.get("level") or "place",
                "confidence": conf,
                "source": "gemini-gps",
                "renderable": (ai.get("level") or "place") != "country",
                "evidence": [evidence_label] if evidence_label else [ai.get("reason", "Gemini")],
            }
            result["status"] = "resolved"
            return result

    candidates: List[Dict[str, Any]] = []
    for query in geocode_variants(ai):
        try:
            geo = geocode(query, geocode_cache, delay, expected_country=expected_country)
        except requests.RequestException as exc:
            print(f"[geocode] {query}: {exc}", file=sys.stderr)
            continue
        if not geo:
            continue
        candidates.append({
            "query": query,
            "lat": geo["lat"],
            "lng": geo["lng"],
            "display_name": geo.get("display_name"),
            "source": "gemini-geocoder",
            "evidence": [evidence_label or query],
        })
        address = geo.get("address") or {}
        conf = min(float(ai.get("confidence") or 0.7), 0.75)
        result["location"] = {
            "lat": geo["lat"],
            "lng": geo["lng"],
            "city": address.get("city") or address.get("town") or address.get("village") or ai.get("city"),
            "region": address.get("state") or address.get("region") or ai.get("region"),
            "country": (address.get("country_code") or expected_country or "").upper() or None,
            "level": ai.get("level") or "place",
            "confidence": conf,
            "source": "gemini-geocoder",
            "renderable": True,
            "evidence": [evidence_label or query],
        }
        result["location_candidates"] = candidates
        result["status"] = "resolved"
        return result

    result["location_candidates"] = candidates
    result["status"] = "unresolved"
    result["ai_reason"] = ai.get("reason") or "Geocode failed for AI query"
    return result


def merge_results(
    results_doc: Dict[str, Any],
    processed: List[Dict[str, Any]],
) -> Dict[str, Any]:
    by_id = {item["video_id"]: item for item in processed if item.get("video_id")}
    unresolved = list(results_doc.get("unresolved_cameras") or [])
    cameras = list(results_doc.get("cameras") or [])
    sources = Counter(results_doc.get("resolution_sources") or {})

    still_unresolved = []
    for item in unresolved:
        vid = item.get("video_id")
        updated = by_id.get(vid)
        if updated and updated.get("status") == "resolved":
            cameras.append(updated)
            src = (updated.get("location") or {}).get("source")
            if src:
                sources[src] += 1
        else:
            still_unresolved.append(updated or item)

    results_doc["cameras"] = cameras
    results_doc["unresolved_cameras"] = still_unresolved
    results_doc["resolved"] = len(cameras)
    results_doc["unresolved"] = len(still_unresolved)
    results_doc["resolution_sources"] = dict(sources)
    results_doc["ai_resolved_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return results_doc


def catalog_stats(streams_path: Path, results_path: Path) -> tuple[int, int]:
    total = 0
    if streams_path.exists():
        total = len(list(iter_records(load_json(streams_path))))
    baseline = 0
    if results_path.exists():
        doc = load_json(results_path)
        baseline = doc.get("resolved", len(doc.get("cameras") or []))
    return total, baseline


def main() -> None:
    parser = argparse.ArgumentParser(description="Gemini AI fallback for unresolved camera locations")
    parser.add_argument("--unresolved", default=str(DATA_DIR / "locations_unresolved.json"))
    parser.add_argument("--results", default=str(DATA_DIR / "location_resolve.json"))
    parser.add_argument("--ai-cache", default=str(DATA_DIR / "ai-location-cache.json"))
    parser.add_argument("--geocode-cache", default=str(DATA_DIR / "geocode-cache.json"))
    parser.add_argument("--env", default=str(ROOT_DIR / ".env"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.1)
    args = parser.parse_args()

    load_dotenv(Path(args.env).expanduser())

    streams_path = DATA_DIR / "streams.json"
    results_path = Path(args.results).expanduser()
    catalog_total, baseline_resolved = catalog_stats(streams_path, results_path)

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("GEMINI_API_KEY not set — skipping AI location resolve.")
        if catalog_total:
            log_progress("total", baseline_resolved, catalog_total, note="regex-only (AI skipped)")
        sys.exit(0)

    unresolved_path = Path(args.unresolved).expanduser()
    if not unresolved_path.exists():
        print(f"No unresolved file at {unresolved_path} — skipping.")
        if catalog_total:
            log_progress("total", baseline_resolved, catalog_total, note="no unresolved file")
        sys.exit(0)

    items = load_json(unresolved_path)
    if not isinstance(items, list):
        raise SystemExit("Unresolved file must be a JSON array")
    if not items:
        print("No unresolved cameras — nothing to do.")
        if catalog_total:
            log_progress("total", baseline_resolved, catalog_total, note="nothing unresolved")
        sys.exit(0)

    ai_cache_path = Path(args.ai_cache).expanduser()
    geocode_cache_path = Path(args.geocode_cache).expanduser()
    ai_cache = load_json(ai_cache_path) if ai_cache_path.exists() else {}
    if not isinstance(ai_cache, dict):
        ai_cache = {}
    geocode_cache = load_json(geocode_cache_path) if geocode_cache_path.exists() else {}
    if not isinstance(geocode_cache, dict):
        geocode_cache = {}

    print(f"Processing {len(items)} unresolved cameras with Gemini...")
    if catalog_total:
        log_progress("ai", baseline_resolved, catalog_total, note=f"starting ({len(items)} unresolved)")

    ai_by_id: Dict[str, Dict[str, Any]] = {}
    pending = [item for item in items if item.get("video_id") not in ai_cache]
    cached_count = len(items) - len(pending)
    if cached_count:
        print(f"  Using {cached_count} cached AI responses")

    for item in items:
        vid = item.get("video_id")
        if vid and vid in ai_cache:
            ai_by_id[vid] = ai_cache[vid]

    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start:start + BATCH_SIZE]
        if not batch:
            continue
        print(f"  Gemini batch {start // BATCH_SIZE + 1} ({len(batch)} items)...")
        prompt = build_prompt(batch)
        rows = call_gemini(api_key, prompt)
        parsed = parse_ai_rows(rows, batch)
        for item in batch:
            vid = item["video_id"]
            ai = parsed.get(vid)
            if not ai:
                print(f"  Warning: no AI row for {vid}", file=sys.stderr)
                continue
            ai_cache[vid] = ai
            ai_by_id[vid] = ai
        time.sleep(1)

    processed: List[Dict[str, Any]] = []
    resolved_count = 0
    for idx, item in enumerate(items, 1):
        vid = item.get("video_id")
        ai = ai_by_id.get(vid, {})
        result = apply_ai_resolution(item, ai, geocode_cache, args.sleep)
        processed.append(result)
        if result.get("status") == "resolved":
            resolved_count += 1
            loc = result.get("location") or {}
            print(f"  RESOLVED {vid}: {loc.get('source')} — {loc.get('evidence')}")
        else:
            print(f"  UNRESOLVED {vid}: {result.get('ai_reason') or ai.get('reason', 'unknown')}")

        if catalog_total and (idx % 10 == 0 or idx == len(items)):
            log_progress(
                "ai",
                baseline_resolved + resolved_count,
                catalog_total,
                note=f"processed {idx}/{len(items)} unresolved",
            )

    save_json(ai_cache_path, ai_cache)
    save_json(geocode_cache_path, geocode_cache)

    print(f"\nAI pass: {resolved_count}/{len(items)} resolved")

    if args.dry_run:
        print("Dry run — location_resolve.json not updated.")
        if catalog_total:
            log_progress("total", baseline_resolved + resolved_count, catalog_total, note="dry run")
        return

    if not results_path.exists():
        print(f"Results file not found: {results_path} — skipping merge.")
        if catalog_total:
            log_progress("total", baseline_resolved + resolved_count, catalog_total, note="merge skipped")
        return

    results_doc = load_json(results_path)
    merged = merge_results(results_doc, processed)
    save_json(results_path, merged)
    save_json(unresolved_path, merged.get("unresolved_cameras") or [])

    print(f"Merged:   {results_path}")
    print(f"Updated:  resolved={merged['resolved']} unresolved={merged['unresolved']}")
    if catalog_total:
        log_progress("ai", merged["resolved"], catalog_total, note="complete")
        log_progress("total", merged["resolved"], catalog_total, note="after regex + AI")
    print("Sources:")
    for source, count in Counter(merged.get("resolution_sources") or {}).most_common():
        print(f"  {source}: {count}")


if __name__ == "__main__":
    main()
