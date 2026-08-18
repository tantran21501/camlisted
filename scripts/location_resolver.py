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
  python3 location_resolver.py \
    --input ../data/streams.json \
    --output ../data/location_resolve.json

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
USER_AGENT = "EarthCameraLocationResolver/0.2"

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
DATA_DIR = ROOT_DIR / "data"


def log_progress(stage: str, resolved: int, total: int, *, note: str = "") -> None:
    """Emit a grep-friendly progress line for CI/worker logs."""
    pct = (100.0 * resolved / total) if total else 0.0
    msg = f"[locations/{stage}] {resolved}/{total} ({pct:.1f}%)"
    if note:
        msg += f" — {note}"
    print(msg, flush=True)

US_STATE_CODES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
    "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin",
    "WY": "Wyoming", "DC": "District of Columbia",
}

CA_PROVINCES = {
    "AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba", "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador", "NS": "Nova Scotia", "NT": "Northwest Territories",
    "NU": "Nunavut", "ON": "Ontario", "PE": "Prince Edward Island", "QC": "Quebec",
    "SK": "Saskatchewan", "YT": "Yukon",
}

BR_STATES = {
    "AC": "Acre", "AL": "Alagoas", "AP": "Amapá", "AM": "Amazonas",
    "BA": "Bahia", "CE": "Ceará", "DF": "Distrito Federal", "ES": "Espírito Santo",
    "GO": "Goiás", "MA": "Maranhão", "MT": "Mato Grosso", "MS": "Mato Grosso do Sul",
    "MG": "Minas Gerais", "PA": "Pará", "PB": "Paraíba", "PR": "Paraná",
    "PE": "Pernambuco", "PI": "Piauí", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte",
    "RS": "Rio Grande do Sul", "RO": "Rondônia", "RR": "Roraima", "SC": "Santa Catarina",
    "SP": "São Paulo", "SE": "Sergipe", "TO": "Tocantins",
}

COUNTRIES = {
    "US": "United States", "USA": "United States", "CA": "Canada", "JP": "Japan",
    "KR": "South Korea", "CN": "China", "SG": "Singapore", "MY": "Malaysia",
    "TH": "Thailand", "VN": "Vietnam", "PH": "Philippines", "ID": "Indonesia",
    "AU": "Australia", "NZ": "New Zealand", "GB": "United Kingdom", "UK": "United Kingdom",
    "FR": "France", "DE": "Germany", "IT": "Italy", "ES": "Spain", "NL": "Netherlands",
    "BE": "Belgium", "CH": "Switzerland", "AT": "Austria", "SE": "Sweden", "NO": "Norway",
    "DK": "Denmark", "FI": "Finland", "PL": "Poland", "CZ": "Czechia", "IE": "Ireland",
    "PT": "Portugal", "BR": "Brazil", "MX": "Mexico", "CL": "Chile", "JM": "Jamaica",
    "VA": "Vatican City", "PR": "Puerto Rico", "VI": "United States Virgin Islands",
    "TW": "Taiwan", "AR": "Argentina", "CO": "Colombia", "PE": "Peru", "GR": "Greece",
}

COUNTRY_NAME_TO_CODE = {
    "united states": "US", "usa": "US", "america": "US",
    "united kingdom": "GB", "uk": "GB", "england": "GB", "great britain": "GB",
    "south korea": "KR", "korea": "KR", "republic of korea": "KR",
    "japan": "JP", "china": "CN", "taiwan": "TW",
    "singapore": "SG", "malaysia": "MY", "thailand": "TH", "vietnam": "VN",
    "philippines": "PH", "indonesia": "ID", "australia": "AU", "new zealand": "NZ",
    "france": "FR", "germany": "DE", "deutschland": "DE", "italy": "IT", "italia": "IT",
    "spain": "ES", "españa": "ES", "espana": "ES", "netherlands": "NL", "belgium": "BE",
    "switzerland": "CH", "austria": "AT", "sweden": "SE", "norway": "NO", "denmark": "DK",
    "finland": "FI", "poland": "PL", "czechia": "CZ", "czech republic": "CZ",
    "ireland": "IE", "portugal": "PT", "brazil": "BR", "brasil": "BR", "mexico": "MX",
    "chile": "CL", "jamaica": "JM", "vatican": "VA", "vaticano": "VA",
    "vatican city": "VA", "holy see": "VA", "puerto rico": "PR",
    "usvi": "VI", "u.s. virgin islands": "VI", "us virgin islands": "VI",
    "united states virgin islands": "VI", "canada": "CA", "greece": "GR",
    "argentina": "AR", "colombia": "CO", "peru": "PE",
}

LANDMARK_ALIASES = {
    "camp nou": "Camp Nou, Barcelona, Spain",
    "spotify camp nou": "Camp Nou, Barcelona, Spain",
    "nuevo camp nou": "Camp Nou, Barcelona, Spain",
    "vaticano": "St. Peter's Square, Vatican City",
    "vatican": "St. Peter's Square, Vatican City",
    "praça são pedro": "St. Peter's Square, Vatican City",
    "praca sao pedro": "St. Peter's Square, Vatican City",
    "cruz bay": "Cruz Bay, St. John, United States Virgin Islands",
    "negril beach": "Negril Beach, Jamaica",
    "negril": "Negril, Jamaica",
    "olongapo city": "Olongapo City, Philippines",
    "olongapo": "Olongapo, Philippines",
    "deerfield beach": "Deerfield Beach, Florida, United States",
    "puerto rico": "Puerto Rico",
}

# All Latin regexes run on casefold() text. CJK/Hangul is unchanged by casefold.
HARDWARE_RE = re.compile(r"\b(?:axis|reolink|hikvision|dahua|amcrest)\b|\b[qpv]\d{3,4}\b")

HINT_STOPWORDS = {
    "live", "directo", "vivo", "webcam", "webcams", "camera", "cameras", "cam", "cams",
    "cctv", "today", "hoy", "night", "ao vivo", "en directo", "en vivo",
    "all capitals please", "interactive", "control", "analytics", "highway",
    "footage", "aerial", "panorama", "real-time", "realtime", "stream", "streaming",
    "east", "west", "north", "south", "left", "right", "please", "capitals",
    "distance", "meters", "official", "nuevo", "nuevas", "obras", "explore",
    "travel", "culture", "food", "markets", "festivals", "night walks",
    "peaceful", "backyard", "bird feeder", "heavy rain", "sky cam",
    "gesehen", "24h", "com", "prefecture", "clima", "agora", "turquoise",
    "waters", "mountains", "house", "chill", "club", "entertained",
    "randomly", "watchers", "bernard", "francois", "world", "omg",
    "sportverse", "praca", "praça", "terminal", "bus", "web",
}

FUNCTION_WORDS = {
    "a", "an", "and", "or", "but", "in", "at", "on", "from", "to", "for", "with",
    "by", "as", "is", "are", "was", "be", "this", "that", "it", "its", "via",
    "near", "overlooking", "located", "desde", "bei", "aus", "em", "en",
    "heavy", "rain", "y", "und", "mit", "dem", "der", "die", "das", "von",
    "del", "por", "para", "hoy", "today", "night",
}

CONNECTORS = {
    "de", "del", "da", "do", "dos", "das", "di", "von", "van", "la", "le", "el",
    "san", "santa", "st", "st.", "of", "the", "du", "des",
}
CONNECTOR = r"(?:de|del|da|do|dos|das|di|von|van|la|le|el|san|santa|st\.?|of|the|du|des)"

COUNTRY_ONLY_SKIP = {
    "KR", "US", "GB", "JP", "CN", "TW", "DE", "FR", "IT", "ES", "BR", "CA",
    "AU", "MX", "NL", "SE", "NO", "DK", "FI", "PL", "AT", "CH", "BE", "PT",
}

JARGON_RE = re.compile(
    r"\b(?:live|webcam|webcams|camera|cameras|cam|cams|cctv|24/?7|"
    r"4k|hd|fhd|uhd|real[- ]?time|ao vivo|en directo|en vivo|"
    r"aerial|footage|interactive|control|ptz)\b"
)
EMOJI_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\U00002700-\U000027BF\U00002600-\U000026FF"
    r"🔴🏗🚤☁️🇰🇷🇯🇲🇹🇭🇵🇱🇩🇪🇪🇸🇧🇷🇨🇱🇯🇵]"
)
DATE_RE = re.compile(
    r"\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b"
    r"|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{2,4}\b"
    r"|\b\d{1,2}:\d{2}\s*[～~-]?"
)
CHANNEL_PREFIX_RE = re.compile(
    r"\b(?:cict|fox\d+|cctv|tv|studio filmowe|paróquia|paroquia|arquidiocese)\b"
)
CHANNEL_SUFFIX_RE = re.compile(
    r"\b(?:live|lives?|webcam|webcams|news|cctv|drone|tv|24/?7|"
    r"parks department|観光協会|live tv|sky cam|ao vivo)\b|"
    r"morgenpost|zeitung|nachrichten"
)
LANDMARK_KEYWORDS = (
    "beach", "river", "lake", "falls", "mountain", "harbor", "harbour",
    "tower", "bridge", "square", "crossing", "downtown", "airport",
    "station", "port", "bay", "plaza", "street", "road", "park",
    "praça", "praca", "stadion", "stadium", "marktplatz", "faro",
    "pier", "camp nou", "collegium", "gulf", "valley", "渓谷",
    "masjid", "mosque", "cathedral", "church", "temple",
)

US_STATE_FOLD = {k.casefold(): v for k, v in US_STATE_CODES.items()}
CA_PROVINCE_FOLD = {k.casefold(): v for k, v in CA_PROVINCES.items()}
BR_STATE_FOLD = {k.casefold(): v for k, v in BR_STATES.items()}

AMBIGUOUS_ADMIN = {c for c in {*US_STATE_FOLD, *CA_PROVINCE_FOLD} if c in FUNCTION_WORDS or c in CONNECTORS or c in {"ok", "hi", "co", "id"}}
UNAMBIGUOUS_ADMIN_ALT = "|".join(
    sorted(({*US_STATE_FOLD, *CA_PROVINCE_FOLD} - AMBIGUOUS_ADMIN), key=len, reverse=True)
)
ADMIN_CODE_ALT = "|".join(sorted({*US_STATE_FOLD, *CA_PROVINCE_FOLD}, key=len, reverse=True))

_WORD_STOP = sorted(
    (
        FUNCTION_WORDS
        | {w for w in HINT_STOPWORDS if " " not in w}
        | set(US_STATE_FOLD)
        | set(CA_PROVINCE_FOLD)
        | set(BR_STATE_FOLD)
    )
    - CONNECTORS,
    key=len,
    reverse=True,
)
WORD_STOP_ALT = "|".join(rf"{re.escape(w)}\b" for w in _WORD_STOP)
PLACE_WORD = rf"(?!{WORD_STOP_ALT})[^\W\d_]+(?:['.-][^\W\d_]+)*"
PLACE_NAME = rf"(?:{CONNECTOR}\s+)?{PLACE_WORD}(?:(?:\s+{CONNECTOR})?\s+{PLACE_WORD}){{0,5}}"
BR_CODE_ALT = "|".join(sorted(BR_STATE_FOLD, key=len, reverse=True))
COUNTRY_NAME_ALT = "|".join(
    re.escape(n) for n in sorted(
        (n for n in COUNTRY_NAME_TO_CODE if " " in n or len(n) > 3),
        key=len,
        reverse=True,
    )
)

CITY_ADMIN_COMMA_RE = re.compile(
    rf"\b({PLACE_NAME}),\s*({ADMIN_CODE_ALT})\.?(?=\s|$|,|\.)"
)
CITY_ADMIN_SPACE_RE = re.compile(
    rf"\b({PLACE_NAME})\s+({UNAMBIGUOUS_ADMIN_ALT})\.?(?=\s|$|,|\.)"
)
BR_CITY_STATE_RE = re.compile(
    rf"\b({PLACE_NAME})\s*[-–—]\s*({BR_CODE_ALT})\b"
)
CITY_COUNTRY_RE = re.compile(
    rf"\b({PLACE_NAME})(?:,\s*|\s+)({COUNTRY_NAME_ALT})\b"
)
PREPOSITION_RE = re.compile(
    rf"\b(?P<prep>in|at|from|near|overlooking|located in|located at|en|em|de|desde|bei|aus)\s+"
    rf"(?P<name>{PLACE_NAME})"
)
CITY_SUFFIX_RE = re.compile(rf"\b({PLACE_NAME})\s+city\b")
KABUPATEN_RE = re.compile(rf"\bkabupaten\s+({PLACE_WORD})")
NEWS_CITY_RE = re.compile(rf"\bnews\s+({PLACE_NAME})\b")
DIRECTIONAL_RE = re.compile(
    rf"\b({PLACE_WORD})-(?:west|east|north|south|nord|süd|sud|ost)\b"
)
JP_PREF_CITY_RE = re.compile(r"([\u3400-\u9fff]{1,10}県[\u3400-\u9fff]{1,10}市)")
JP_CITY_RE = re.compile(r"([\u3400-\u9fffぁ-んァ-ン]{1,10}市)")
KR_TOKEN_RE = re.compile(r"([가-힣]{2,8})")
KR_SKIP = {"실시간", "방송", "가능한", "합법적"}
WEAK_PREP = {"de", "en", "em", "del", "di"}


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


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip(" ,.-|•￨/;")


def fold_text(value: str) -> str:
    """Canonical lowercase form for Latin regex matching. CJK is unchanged."""
    return EMOJI_RE.sub(" ", value).casefold()


def display_hint(value: str) -> str:
    """Title-case Latin tokens for geocoder/evidence; leave CJK as-is."""
    value = normalize_space(value)
    if not value:
        return value
    if is_cjk(value) and not re.search(r"[a-zà-öø-ÿ]", value):
        return value
    parts = []
    for word in value.split():
        if word in CONNECTORS:
            parts.append(word)
        elif is_cjk(word):
            parts.append(word)
        else:
            parts.append(word[:1].upper() + word[1:] if word else word)
    return " ".join(parts)


def is_cjk(value: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", value))


def script_country(value: str) -> Optional[str]:
    if re.search(r"[ぁ-んァ-ン]|[都道府県市町村]", value):
        return "JP"
    if re.search(r"[가-힣]", value):
        return "KR"
    return None


def is_junk_hint(value: str) -> bool:
    key = normalize_space(value).casefold()
    if len(key) < 3:
        return True
    if key in HINT_STOPWORDS:
        return True
    if key.replace(" ", "") in {s.replace(" ", "") for s in HINT_STOPWORDS}:
        return True
    if re.fullmatch(r"[\d\W]+", key):
        return True
    if HARDWARE_RE.search(value):
        return True
    return False


def is_country_only_hint(value: str) -> bool:
    key = normalize_space(value).casefold()
    code = COUNTRY_NAME_TO_CODE.get(key)
    if code in COUNTRY_ONLY_SKIP:
        return True
    if mentioned_countries(value) and re.search(
        r"\b(?:travel|culture|food|markets|festivals|explore|news|live tv)\b",
        value.casefold(),
    ):
        # "Explore Korea Live TV" / "Korea Travel" — country-level, not a camera pin.
        if "," not in value and not re.search(r"[市県]", value):
            return True
    return False


def mentioned_countries(value: str) -> List[str]:
    if not value:
        return []
    found: List[str] = []
    for name in sorted(COUNTRY_NAME_TO_CODE, key=len, reverse=True):
        if re.search(rf"\b{re.escape(name)}\b", value.casefold()):
            code = COUNTRY_NAME_TO_CODE[name]
            if code not in found:
                found.append(code)
    script = script_country(value)
    if script and script not in found:
        found.append(script)
    return found


def country_name(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    return COUNTRIES.get(code.upper(), code)


def clean_place_text(value: str) -> str:
    cleaned = fold_text(value)
    cleaned = JARGON_RE.sub(" ", cleaned)
    cleaned = DATE_RE.sub(" ", cleaned)
    cleaned = re.sub(r"[|•￨/【】\[\]]+", " ", cleaned)
    cleaned = re.sub(r"[!]{2,}", " ", cleaned)
    return normalize_space(cleaned)


def us_ca_city_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for pattern in (CITY_ADMIN_COMMA_RE, CITY_ADMIN_SPACE_RE):
        for match in pattern.finditer(folded):
            city, code = match.group(1).strip(), match.group(2)
            if is_junk_hint(city):
                continue
            pretty = display_hint(city)
            if code in US_STATE_FOLD:
                hints.append(f"{pretty}, {US_STATE_FOLD[code]}, United States")
            elif code in CA_PROVINCE_FOLD:
                hints.append(f"{pretty}, {CA_PROVINCE_FOLD[code]}, Canada")
    return hints


def city_country_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for match in CITY_COUNTRY_RE.finditer(folded):
        city = match.group(1).strip()
        country = match.group(2).strip()
        if is_junk_hint(city) or len(city.split()) > 6:
            continue
        pretty_country = COUNTRY_NAME_TO_CODE.get(country)
        country_label = COUNTRIES.get(pretty_country, display_hint(country)) if pretty_country else display_hint(country)
        hints.append(f"{display_hint(city)}, {country_label}")
    return hints


def br_city_state_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for match in BR_CITY_STATE_RE.finditer(folded):
        city, code = match.group(1).strip(), match.group(2)
        if code in BR_STATE_FOLD and not is_junk_hint(city):
            hints.append(f"{display_hint(city)}, {BR_STATE_FOLD[code]}, Brazil")
    return hints


def preposition_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for match in PREPOSITION_RE.finditer(folded):
        candidate = match.group("name").strip(" ,.-")
        prep = match.group("prep")
        if prep in WEAK_PREP and len(candidate.split()) < 2:
            continue
        if not is_junk_hint(candidate):
            hints.append(display_hint(candidate))
    return hints


def admin_suffix_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for match in CITY_SUFFIX_RE.finditer(folded):
        city = normalize_space(match.group(0))
        if not is_junk_hint(city):
            hints.append(display_hint(city))
    for match in KABUPATEN_RE.finditer(folded):
        hints.append(f"{display_hint(match.group(1))}, Indonesia")
    for match in JP_PREF_CITY_RE.finditer(folded):
        hints.append(match.group(1))
    for match in JP_CITY_RE.finditer(folded):
        hints.append(match.group(1))
    for match in KR_TOKEN_RE.finditer(folded):
        token = match.group(1)
        if token not in KR_SKIP:
            hints.append(token)
    for match in NEWS_CITY_RE.finditer(folded):
        city = match.group(1).strip()
        if not is_junk_hint(city):
            hints.append(display_hint(city))
    return hints


def bilingual_parts(folded: str) -> List[str]:
    extra: List[str] = []
    for part in re.split(r"\s*[/|•￨]\s*|【|】|\[|\]", folded):
        cleaned = clean_place_text(part)
        if cleaned and not is_junk_hint(cleaned) and len(cleaned) <= 80:
            extra.append(display_hint(cleaned))
            for match in re.finditer(rf"\b({PLACE_NAME})\b", cleaned):
                token = match.group(1)
                if not is_junk_hint(token):
                    extra.append(display_hint(token))
    for match in DIRECTIONAL_RE.finditer(folded):
        extra.append(display_hint(match.group(1)))
    return extra


def dash_segment_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for part in re.split(r"\s+[-–—]\s+", folded):
        cleaned = clean_place_text(part)
        if cleaned and not is_junk_hint(cleaned) and len(cleaned.split()) <= 6:
            hints.append(display_hint(cleaned))
    return hints


def german_city_variants(name: str) -> List[str]:
    folded = name.casefold().strip()
    if not folded:
        return []
    variants = []
    if folded.endswith("er") and len(folded) > 5:
        variants.append(display_hint(folded[:-2] + "en"))
        variants.append(display_hint(folded[:-2]))
    variants.append(display_hint(folded))
    return [v for v in variants if v]


def channel_place_hints(channel_title: str) -> List[str]:
    if not channel_title:
        return []
    hints: List[str] = []
    folded = fold_text(channel_title)

    kabupaten = KABUPATEN_RE.search(folded)
    if kabupaten:
        hints.append(f"{display_hint(kabupaten.group(1))}, Indonesia")

    for match in JP_CITY_RE.finditer(folded):
        hints.append(match.group(1))

    cleaned = CHANNEL_PREFIX_RE.sub(" ", folded)
    cleaned = CHANNEL_SUFFIX_RE.sub(" ", cleaned)
    cleaned = re.sub(r"\d+", " ", cleaned)
    cleaned = clean_place_text(cleaned)
    if cleaned and not is_junk_hint(cleaned):
        hints.extend(german_city_variants(cleaned))
        hints.append(display_hint(cleaned))
        tokens = cleaned.split()
        if tokens:
            last = tokens[-1]
            if last == "usvi" and len(tokens) >= 2:
                hints.append("St. John, United States Virgin Islands")
            elif not is_junk_hint(last):
                hints.append(display_hint(last))

    return hints


def landmark_alias_hints(folded: str) -> List[str]:
    hints: List[str] = []
    for alias, place in LANDMARK_ALIASES.items():
        if re.search(rf"\b{re.escape(alias)}\b", folded):
            hints.append(place)
    return hints


def unique_hints(hints: Iterable[str], limit: int = 10) -> List[str]:
    structured, rest, seen = [], [], set()
    for hint in hints:
        hint = normalize_space(hint)
        if not hint or is_junk_hint(hint):
            continue
        key = hint.casefold()
        if key in seen:
            continue
        seen.add(key)
        if "," in hint or mentioned_countries(hint) or "市" in hint or "県" in hint:
            structured.append(hint)
        else:
            rest.append(hint)
    return (structured + rest)[:limit]


def location_hints(record: Dict[str, Any], yt: Dict[str, Any], channel: Dict[str, Any]) -> List[str]:
    title = text(record, "title") or yt.get("title", "")
    description = text(record, "description") or yt.get("description", "")
    channel_title = (
        text(record, "channel_title", "channelTitle") or yt.get("channel_title", "")
    )
    channel_description = channel.get("description", "") or ""

    if HARDWARE_RE.search(fold_text(title)):
        return []

    ordered: List[str] = []

    def absorb(source: str, include_title_fallback: bool = False) -> None:
        if not source:
            return
        folded = fold_text(source)
        ordered.extend(landmark_alias_hints(folded))
        ordered.extend(us_ca_city_hints(folded))
        ordered.extend(br_city_state_hints(folded))
        ordered.extend(city_country_hints(folded))
        ordered.extend(admin_suffix_hints(folded))
        ordered.extend(preposition_hints(folded))
        ordered.extend(bilingual_parts(folded))
        ordered.extend(dash_segment_hints(folded))
        for value in re.findall(r"\(([^()]{2,80})\)", folded):
            value = clean_place_text(value)
            if value:
                ordered.append(display_hint(value))
        if include_title_fallback and not HARDWARE_RE.search(folded):
            if any(word in folded for word in LANDMARK_KEYWORDS) or is_cjk(source):
                cleaned = clean_place_text(source)
                if cleaned:
                    ordered.append(display_hint(cleaned) if not is_cjk(cleaned) else cleaned)
            if re.fullmatch(r"[\u3040-\u30ff\u3400-\u9fff\s]{2,40}", source.strip()):
                ordered.append(source.strip())

    absorb(title, include_title_fallback=True)
    ordered.extend(channel_place_hints(channel_title))
    absorb(channel_title, include_title_fallback=False)
    absorb(description, include_title_fallback=False)
    absorb(channel_description, include_title_fallback=False)

    return unique_hints(ordered, limit=10)


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


def address_is_junk(address: Dict[str, Any], category: str = "", osm_type: str = "") -> bool:
    category = (category or "").lower()
    osm_type = (osm_type or "").lower()
    if category in {"amenity", "shop", "office", "craft"}:
        if osm_type not in {"fountain", "place_of_worship", "townhall", "university", "college"}:
            return True
    if address.get("amenity") or address.get("shop") or address.get("office"):
        if not (address.get("tourism") or address.get("leisure") or address.get("historic")):
            return True
    return False


def country_matches(address: Dict[str, Any], expected: Optional[str]) -> bool:
    if not expected:
        return True
    got = (address.get("country_code") or "").upper()
    if not got:
        return True
    expected = expected.upper()
    aliases = {
        "US": {"US", "PR", "VI", "GU", "AS", "MP"},
        "GB": {"GB", "UK"},
        "UK": {"GB", "UK"},
        "VA": {"VA", "IT"},
        "PR": {"PR", "US"},
        "VI": {"VI", "US"},
    }
    return got == expected or got in aliases.get(expected, set()) or expected in aliases.get(got, set())


def pick_geocode_hit(
    results: List[Dict[str, Any]],
    expected_country: Optional[str],
) -> Optional[Dict[str, Any]]:
    for item in results:
        address = item.get("address") or {}
        category = item.get("category") or item.get("class") or ""
        osm_type = item.get("type") or ""
        if address_is_junk(address, category, osm_type):
            continue
        if not country_matches(address, expected_country):
            continue
        if not valid_coords(item.get("lat"), item.get("lon")):
            continue
        return {
            "lat": float(item["lat"]),
            "lng": float(item["lon"]),
            "display_name": item.get("display_name"),
            "address": address,
            "category": category,
            "type": osm_type,
        }
    return None


def geocode(
    query: str,
    cache: Dict[str, Any],
    delay: float,
    expected_country: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    key = query.casefold().strip()
    if key in cache:
        cached = cache[key]
        if cached is None:
            return None
        if isinstance(cached, dict):
            address = cached.get("address") or {}
            if not address_is_junk(address, cached.get("category", ""), cached.get("type", "")):
                if country_matches(address, expected_country):
                    return cached
            # Stale junk / wrong-country cache from earlier runs.
            del cache[key]

    response = requests.get(
        NOMINATIM_API,
        params={
            "q": query,
            "format": "jsonv2",
            "limit": 5,
            "addressdetails": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    results = response.json()
    time.sleep(delay)

    if not results:
        cache[key] = None
        return None

    picked = pick_geocode_hit(results, expected_country)
    if picked is None:
        # Cache a country-agnostic pick so later calls with no expected country
        # can still reuse a non-junk hit; do not cache None if only country filter failed.
        generic = pick_geocode_hit(results, None)
        cache[key] = generic
        return None if expected_country else generic

    cache[key] = picked
    return picked


def hint_expected_country(
    hint: str,
    title: str,
    channel: Dict[str, Any],
) -> Tuple[Optional[str], Optional[str]]:
    """Return (hard expected country code, country name to append to the query).

    Channel country is append-only and must not be used as a hard filter:
    channel country is often the uploader's country, not the camera's.
    """
    hint_codes = mentioned_countries(hint)
    title_codes = mentioned_countries(title)
    script = script_country(hint) or script_country(title)

    if hint_codes:
        return hint_codes[0], None
    if title_codes:
        return title_codes[0], country_name(title_codes[0])
    if script:
        return script, country_name(script)

    channel_code = (channel.get("country") or "").upper() or None
    if channel_code:
        return None, country_name(channel_code) or channel_code
    return None, None


def build_queries(
    hint: str,
    title: str,
    channel: Dict[str, Any],
) -> List[Tuple[str, Optional[str]]]:
    expected, append_name = hint_expected_country(hint, title, channel)
    queries: List[Tuple[str, Optional[str]]] = []

    def add(query: str, country: Optional[str]) -> None:
        query = normalize_space(query)
        pair = (query, country)
        if query and pair not in queries:
            queries.append(pair)

    add(hint, expected)
    if (
        append_name
        and append_name.casefold() not in hint.casefold()
        and not is_cjk(hint)
        and len(hint.split()) <= 8
    ):
        add(f"{hint}, {append_name}", expected)

    return queries


def resolve(
    record: Dict[str, Any],
    yt: Dict[str, Any],
    channel: Dict[str, Any],
    cache: Dict[str, Any],
    use_geocode: bool,
    delay: float,
) -> Dict[str, Any]:

    vid = video_id(record)
    title = text(record, "title") or yt.get("title", "")
    result = {
        "video_id": vid,
        "title": title,
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
        for hint in hints:
            if is_country_only_hint(hint):
                continue
            for query, expected in build_queries(hint, title, channel):
                try:
                    geo = geocode(query, cache, delay, expected_country=expected)
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
    parser.add_argument("--input", default=str(DATA_DIR / "streams.json"))
    parser.add_argument("--output", default=str(DATA_DIR / "location_resolve.json"))
    parser.add_argument("--cache", default=str(DATA_DIR / "geocode-cache.json"))
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

    total = len(records)
    print(f"Loaded {total} stream records")
    log_progress("regex", 0, total, note="starting")

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

        if i % 100 == 0 or i == total:
            log_progress("regex", len(resolved), total, note=f"processed {i}/{total}")

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
    unresolved_path = DATA_DIR / "locations_unresolved.json"

    save_json(output_path, output)
    save_json(unresolved_path, unresolved)
    save_json(cache_path, cache)

    print("\n=== Location Resolution Complete ===")
    log_progress("regex", len(resolved), total, note="complete")
    log_progress("total", len(resolved), total, note="after regex (before AI)")
    print(f"Total:      {total}")
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
