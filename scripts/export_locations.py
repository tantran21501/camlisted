#!/usr/bin/env python3
"""
Export merged locations snapshot for the catalog.

Joins data/streams.json with data/location_resolve.json into data/locations.json.

Output schema (locations-v1):
  video_id, title, category, country, location_lat, location_lng
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DATA_DIR = ROOT_DIR / "data"

sys.path.insert(0, str(SCRIPT_DIR))

from location_resolver import (  # noqa: E402
    iter_records,
    load_json,
    log_progress,
    save_json,
    valid_coords,
)


def coords_from_camera(camera: Dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    loc = camera.get("location") or {}
    if loc.get("renderable") is False:
        return None, None
    lat, lng = loc.get("lat"), loc.get("lng")
    if valid_coords(lat, lng):
        return float(lat), float(lng)
    return None, None


def build_locations_snapshot(
    streams_path: Path,
    resolve_path: Path,
) -> Dict[str, Any]:
    streams_doc = load_json(streams_path)
    streams = list(iter_records(streams_doc))

    resolve_doc = load_json(resolve_path) if resolve_path.exists() else {}
    resolved_by_id: Dict[str, Dict[str, Any]] = {}
    for camera in resolve_doc.get("cameras") or []:
        vid = camera.get("video_id")
        if vid:
            resolved_by_id[vid] = camera

    locations: List[Dict[str, Any]] = []
    resolved_count = 0

    for stream in streams:
        vid = stream.get("video_id") or stream.get("videoId") or stream.get("id")
        if not vid:
            continue

        camera = resolved_by_id.get(vid, {})
        lat, lng = coords_from_camera(camera)
        if lat is not None and lng is not None:
            resolved_count += 1

        locations.append({
            "video_id": vid,
            "title": stream.get("title") or camera.get("title") or "",
            "category": stream.get("category"),
            "country": stream.get("country"),
            "location_lat": lat,
            "location_lng": lng,
        })

    return {
        "format": "locations-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(locations),
        "resolved": resolved_count,
        "locations": locations,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export data/locations.json from streams + resolve results")
    parser.add_argument("--streams", default=str(DATA_DIR / "streams.json"))
    parser.add_argument("--resolve", default=str(DATA_DIR / "location_resolve.json"))
    parser.add_argument("--output", default=str(DATA_DIR / "locations.json"))
    args = parser.parse_args()

    streams_path = Path(args.streams).expanduser()
    resolve_path = Path(args.resolve).expanduser()
    output_path = Path(args.output).expanduser()

    if not streams_path.exists():
        raise SystemExit(f"Streams file not found: {streams_path}")

    snapshot = build_locations_snapshot(streams_path, resolve_path)
    save_json(output_path, snapshot)

    unresolved = snapshot["count"] - snapshot["resolved"]
    print("=== Locations Export Complete ===")
    log_progress("export", snapshot["resolved"], snapshot["count"], note="locations.json written")
    print(f"Streams:  {streams_path}")
    print(f"Resolve:  {resolve_path if resolve_path.exists() else '(missing — all null coords)'}")
    print(f"Output:   {output_path}")
    print(f"Total:    {snapshot['count']}")
    print(f"Resolved: {snapshot['resolved']}")
    print(f"Unresolved: {unresolved}")


if __name__ == "__main__":
    main()
