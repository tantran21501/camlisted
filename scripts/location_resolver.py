#!/usr/bin/env python3
"""
Earth Camera - Location Resolver for Camlisted streams.json

Input:
  /Users/mac/work/Camlist/camlisted/data/streams.json

Resolution order:
  1. Coordinates already present in streams.json
  2. YouTube recordingDetails.location
  3. Location hints from title / description / channel
  4. Nominatim geocoding
  5. Channel country as non-renderable fallback

Environment:
  export YOUTUBE_API_KEY="..."

Example:
  python3 resolve_locations.py \
    --input /Users/mac/work/Camlist/camlisted/data/streams.json \
    --output ./location_results.json

Install:
  python3 -m pip install requests
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

try:
    import requests
except ImportError:
    print("Missing dependency: requests")
    print("Install with: python3 -m pip install requests")
    sys.exit(1)

YOUTUBE_API = "https://www.googleapis.com/youtube/v3"
NOMINATIM_API = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "EarthCameraLocationResolver/0.1"

US_STATE_CODES = {
    "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California",
    "CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia",
    "HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas",
    "KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts",
    "MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana",
    "NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico",
    "NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma",
    "OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina",
    "SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont",
    "VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin",
    "WY":"Wyoming","DC":"District of Columbia",
}

CA_PROVINCES = {
    "AB":"Alberta","BC":"British Columbia","MB":"Manitoba","NB":"New Brunswick",
    "NL":"Newfoundland and Labrador","NS":"Nova Scotia","NT":"Northwest Territories",
    "NU":"Nunavut","ON":"Ontario","PE":"Prince Edward Island","QC":"Quebec",
    "SK":"Saskatchewan","YT":"Yukon",
}

COUNTRIES = {
    "US":"United States","USA":"United States","CA":"Canada","JP":"Japan",
    "KR":"South Korea","CN":"China","SG":"Singapore","MY":"Malaysia",
    "TH":"Thailand","VN":"Vietnam","PH":"Philippines","ID":"Indonesia",
    "AU":"Australia","NZ":"New Zealand","GB":"United Kingdom","UK":"United Kingdom",
    "FR":"France","DE":"Germany","IT":"Italy","ES":"Spain","NL":"Netherlands",
    "BE":"Belgium","CH":"Switzerland","AT":"Austria","SE":"Sweden","NO":"Norway",
    "DK":"Denmark","FI":"Finland","PL":"Poland","CZ":"Czechia","IE":"Ireland",
    "PT":"Portugal","BR":"Brazil","MX":"Mexico",
}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def iter_records(data: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(data, list):
        yield from (x for x in data if isinstance(x, dict))
        return
    if isinstance(data, dict):
        for key in ("streams", "items", "videos", "data", "results"):
            value = data.get(key)
            if isinstance(value, list):
                yield from (x for x in value if isinstance(x, dict))
                return
        if data and all(isinstance(v, dict) for v in data.values()):
            yield from data.values()
            return
    raise ValueError("Unsupported streams.json structure")


def text(record: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def video_id(record: Dict[str, Any]) -> Optional[str]:
    value = text(record, "video_id", "videoId", "id")
    if value:
        return value
    url = text(record, "url", "video_url", "videoUrl", "watch_url")
    match = re.search(r"(?:v=|youtu\.be/|/live/)([A-Za-z0-9_-]{11})", url)
    return match.group(1) if match else None


def valid_coords(lat: Any, lng: Any) -> bool:
    try:
        lat, lng = float(lat), float(lng)
        return -90 <= lat <= 90 and -180 <= lng <= 180
    except (TypeError, ValueError):
        return False


def existing_coords(record: Dict[str, Any]) -> Optional[Tuple[float, float, str]]:
    for a, b in (
        ("latitude", "longitude"), ("lat", "lng"), ("lat", "lon"),
        ("location_latitude", "location_longitude"),
    ):
        if valid_coords(record.get(a), record.get(b)):
            return float(record[a]), float(record[b]), f"streams.{a}/{b}"

    loc = record.get("location")
    if isinstance(loc, dict):
        for a, b in (("latitude", "longitude"), ("lat", "lng"), ("lat", "lon")):
            if valid_coords(loc.get(a), loc.get(b)):
                return float(loc[a]), float(loc[b]), f"streams.location.{a}/{b}"
    return None


def us_city_state(value: str) -> Optional[str]:
    pattern = re.compile(
        r"\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}),\s*([A-Z]{2})\b"
    )
    for m in pattern.finditer(value):
        if m.group(2) in US_STATE_CODES:
            return f"{m.group(1).strip()}, {US_STATE_CODES[m.group(2)]}, United States"
    return None


def ca_city_province(value: str) -> Optional[str]:
    pattern = re.compile(
        r"\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}),\s*([A-Z]{2})\b"
    )
    for m in pattern.finditer(value):
        if m.group(2) in CA_PROVINCES:
            return f"{m.group(1).strip()}, {CA_PROVINCES[m.group(2)]}, Canada"
    return None


def location_hints(record: Dict[str, Any], yt: Dict[str, Any], channel: Dict[str, Any]) -> List[str]:
    title = text(record, "title") or yt.get("title", "")
    description = text(record, "description") or yt.get("description", "")
    channel_title = text(record, "channel_title", "channelTitle") or yt.get("channel_title", "")
    channel_description = channel.get("description", "")

    full = "\n".join(x for x in (title, description, channel_title, channel_description) if x)
    hints: List[str] = []

    for parser in (us_city_state, ca_city_province):
        result = parser(full)
        if result:
            hints.append(result)

    # "in Boston", "at St. Augustine", "located in Tokyo", etc.
    for m in re.finditer(
        r"\b(?:in|at|from|near|overlooking|located in|located at)\s+"
        r"([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})",
        full,
    ):
        candidate = re.split(
            r"\b(?:LIVE|Webcam|Camera|Cam|24/7)\b",
            m.group(1),
            flags=re.I,
        )[0].strip(" ,.-")
        if len(candidate) >= 3:
            hints.append(candidate)

    # Parenthesized location: "Golden Spike Tower (East)"
    for value in re.findall(r"\(([^()]{2,80})\)", title):
        value = value.strip()
        if len(value) >= 3:
            hints.append(value)

    # Landmark-like title fallback.
    if title and any(
        word in title.lower()
        for word in (
            "beach", "river", "lake", "falls", "mountain", "harbor", "harbour",
            "tower", "bridge", "square", "crossing", "downtown", "airport",
            "station", "port", "bay", "plaza", "street", "road", "park",
        )
    ):
        hints.append(title.strip())

    output, seen = [], set()
    for hint in hints:
        key = re.sub(r"\s+", " ", hint).strip().casefold()
        if key and key not in seen:
            seen.add(key)
            output.append(re.sub(r"\s+", " ", hint).strip())
    return output[:10]


def youtube_videos(api_key: str, ids: List[str]) -> Dict[str, Dict[str, Any]]:
    result = {}
    for i in range(0, len(ids), 50):
        response = requests.get(
            f"{YOUTUBE_API}/videos",
            params={
                "part": "snippet,recordingDetails",
                "id": ",".join(ids[i:i+50]),
                "key": api_key,
                "maxResults": 50,
            },
            timeout=30,
        )
        response.raise_for_status()
        for item in response.json().get("items", []):
            snippet = item.get("snippet") or {}
            loc = (item.get("recordingDetails") or {}).get("location") or {}
            result[item["id"]] = {
                "title": snippet.get("title", ""),
                "description": snippet.get("description", ""),
                "channel_id": snippet.get("channelId"),
                "channel_title": snippet.get("channelTitle", ""),
                "recording_location": loc,
            }
    return result


def youtube_channels(api_key: str, ids: List[str]) -> Dict[str, Dict[str, Any]]:
    result = {}
    for i in range(0, len(ids), 50):
        response = requests.get(
            f"{YOUTUBE_API}/channels",
            params={
                "part": "snippet",
                "id": ",".join(ids[i:i+50]),
                "key": api_key,
                "maxResults": 50,
            },
            timeout=30,
        )
        response.raise_for_status()
        for item in response.json().get("items", []):
            snippet = item.get("snippet") or {}
            result[item["id"]] = {
                "title": snippet.get("title", ""),
                "description": snippet.get("description", ""),
                "country": snippet.get("country"),
            }
    return result


def geocode(query: str, cache: Dict[str, Any], delay: float) -> Optional[Dict[str, Any]]:
    key = query.casefold().strip()
    if key in cache:
        return cache[key]

    response = requests.get(
        NOMINATIM_API,
        params={
            "q": query,
            "format": "jsonv2",
            "limit": 3,
            "addressdetails": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    results = response.json()

    if not results:
        cache[key] = None
        return None

    best = results[0]
    result = {
        "lat": float(best["lat"]),
        "lng": float(best["lon"]),
        "display_name": best.get("display_name"),
        "address": best.get("address") or {},
    }
    cache[key] = result
    time.sleep(delay)
    return result


def resolve(
    record: Dict[str, Any],
    yt: Dict[str, Any],
    channel: Dict[str, Any],
    cache: Dict[str, Any],
    use_geocode: bool,
    delay: float,
) -> Dict[str, Any]:

    vid = video_id(record)
    result = {
        "video_id": vid,
        "title": text(record, "title") or yt.get("title", ""),
        "channel_id": text(record, "channel_id", "channelId") or yt.get("channel_id"),
        "channel_title": text(record, "channel_title", "channelTitle") or yt.get("channel_title", ""),
        "location": None,
        "location_candidates": [],
        "location_hints": [],
        "status": "unresolved",
    }

    # 1. Coordinates already present.
    coords = existing_coords(record)
    if coords:
        lat, lng, source = coords
        result["location"] = {
            "lat": lat, "lng": lng, "level": "gps",
            "confidence": 1.0, "source": source,
            "renderable": True,
            "evidence": ["coordinates already present in streams.json"],
        }
        result["status"] = "resolved"
        return result

    # 2. YouTube recordingDetails.location.
    loc = yt.get("recording_location") or {}
    if valid_coords(loc.get("latitude"), loc.get("longitude")):
        result["location"] = {
            "lat": float(loc["latitude"]),
            "lng": float(loc["longitude"]),
            "level": "gps",
            "confidence": 1.0,
            "source": "youtube-recordingDetails",
            "renderable": True,
            "evidence": ["YouTube recordingDetails.location"],
        }
        result["status"] = "resolved"
        return result

    # 3. Text extraction + geocoding.
    hints = location_hints(record, yt, channel)
    result["location_hints"] = hints

    if use_geocode:
        country_code = channel.get("country")
        country_name = COUNTRIES.get((country_code or "").upper(), country_code)

        for hint in hints:
            query = hint
            if country_name and len(query.split()) <= 5 and country_name.casefold() not in query.casefold():
                query = f"{query}, {country_name}"

            try:
                geo = geocode(query, cache, delay)
            except requests.RequestException as exc:
                print(f"[geocode] {query}: {exc}", file=sys.stderr)
                continue

            if not geo:
                continue

            address = geo["address"]
            result["location_candidates"].append({
                "query": query,
                "lat": geo["lat"],
                "lng": geo["lng"],
                "display_name": geo["display_name"],
                "source": "place-hint-geocoder",
                "evidence": [hint],
            })

            result["location"] = {
                "lat": geo["lat"],
                "lng": geo["lng"],
                "city": address.get("city") or address.get("town") or address.get("village"),
                "region": address.get("state") or address.get("region"),
                "country": (address.get("country_code") or "").upper() or None,
                "level": "place",
                "confidence": 0.80,
                "source": "place-hint-geocoder",
                "renderable": True,
                "evidence": [hint],
            }
            result["status"] = "resolved"
            return result

    # 4. Country fallback. Never render this as a map point.
    if channel.get("country"):
        country = COUNTRIES.get(channel["country"].upper(), channel["country"])
        result["location"] = {
            "country": country,
            "level": "country",
            "confidence": 0.30,
            "source": "youtube-channel-country",
            "renderable": False,
            "evidence": ["YouTube channel country; not camera GPS"],
        }

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="/Users/mac/work/Camlist/camlisted/data/streams.json")
    parser.add_argument("--output", default="./location_results.json")
    parser.add_argument("--cache", default="./geocode-cache.json")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--no-youtube", action="store_true")
    parser.add_argument("--no-geocode", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.1)
    args = parser.parse_args()

    input_path = Path(args.input).expanduser()
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    records = list(iter_records(load_json(input_path)))
    if args.limit:
        records = records[:args.limit]

    print(f"Loaded {len(records)} stream records")

    api_key = os.getenv("YOUTUBE_API_KEY")
    if not args.no_youtube and not api_key:
        print("YOUTUBE_API_KEY is not set; skipping YouTube API enrichment.", file=sys.stderr)
        args.no_youtube = True

    video_ids = list(dict.fromkeys(v for v in (video_id(r) for r in records) if v))
    channel_ids = list(dict.fromkeys(
        c for c in (text(r, "channel_id", "channelId") for r in records) if c
    ))

    yt_map = {}
    channel_map = {}

    if not args.no_youtube:
        print(f"Fetching metadata for {len(video_ids)} videos...")
        yt_map = youtube_videos(api_key, video_ids)

        for item in yt_map.values():
            if item.get("channel_id"):
                channel_ids.append(item["channel_id"])
        channel_ids = list(dict.fromkeys(channel_ids))

        print(f"Fetching metadata for {len(channel_ids)} channels...")
        channel_map = youtube_channels(api_key, channel_ids)

    cache_path = Path(args.cache).expanduser()
    cache = load_json(cache_path) if cache_path.exists() else {}
    if not isinstance(cache, dict):
        cache = {}

    resolved, unresolved = [], []
    sources = Counter()

    for i, record in enumerate(records, 1):
        vid = video_id(record)
        yt = yt_map.get(vid, {})
        cid = text(record, "channel_id", "channelId") or yt.get("channel_id")
        channel = channel_map.get(cid, {})

        item = resolve(record, yt, channel, cache, not args.no_geocode, args.sleep)

        if item["status"] == "resolved":
            resolved.append(item)
        else:
            unresolved.append(item)

        source = (item.get("location") or {}).get("source")
        if source:
            sources[source] += 1

        if i % 100 == 0 or i == len(records):
            print(f"[{i}/{len(records)}] resolved={len(resolved)} unresolved={len(unresolved)}")

    output = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "input": str(input_path),
        "total": len(records),
        "resolved": len(resolved),
        "unresolved": len(unresolved),
        "resolution_sources": dict(sources),
        "cameras": resolved,
        "unresolved_cameras": unresolved,
    }

    output_path = Path(args.output).expanduser()
    unresolved_path = output_path.with_name("unresolved.json")

    save_json(output_path, output)
    save_json(unresolved_path, unresolved)
    save_json(cache_path, cache)

    print("\n=== Location Resolution Complete ===")
    print(f"Total:      {len(records)}")
    print(f"Resolved:   {len(resolved)}")
    print(f"Unresolved: {len(unresolved)}")
    print("Sources:")
    for source, count in sources.most_common():
        print(f"  {source}: {count}")
    print(f"Output:     {output_path}")
    print(f"Unresolved: {unresolved_path}")
    print(f"Cache:      {cache_path}")


if __name__ == "__main__":
    main()