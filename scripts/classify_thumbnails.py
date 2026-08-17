"""CLIP 제로샷으로 썸네일을 보고 카테고리를 분류한다. **녹화 영상(content_type='video') 전용.**

매일 GitHub Actions에서 update.mjs 다음에 실행된다.
- 대상: 녹화 영상 중 아직 AI 분류를 안 거쳤고(ai_checked_at 없음), 유저가 직접
  카테고리를 고치지 않은(category_source != 'user') 행
- 저장된 썸네일을 내려받아 분류에만 쓰고 즉시 폐기한다 (디스크에 이미지 저장 안 함)
- 확신도가 낮으면 기존 카테고리를 유지하고 체크 기록만 남긴다
- 상태는 data/streams.json에 직접 쓴다 (DB 없음)

라이브를 제외하는 이유(2026-07-26): 라이브는 썸네일이 "지금 이 순간"의 한 프레임이라
스트림 전체를 대표하지 못한다. PTZ(회전) 카메라는 찍는 순간마다 다른 곳을 보고 있고,
낮/밤/날씨도 계속 바뀐다. 실제로 다낭의 PTZ 도로 카메라가 한 프레임 때문에 'indoor'로
분류됐는데, 같은 카메라를 나중에 다시 재보니 'traffic'을 0.96 확신도로 맞혔다.
게다가 확신도 임계값은 이런 오판을 못 걸러낸다 — 수족관을 'wildlife' 0.68로,
도심 스카이라인을 'aerial' 0.67로 "자신 있게" 틀린다.
라이브 카테고리는 제목·채널명을 읽는 Gemini(ai_review.mjs)가 맡는다. 여기서 라이브를
건드리지 않으면 ai_checked_at이 남지 않고, Gemini 재검수가 nullsFirst 정렬이라
새 라이브가 대기열 맨 앞으로 올라가 바로 분류된다.

환경변수: (선택) DRY_RUN=1, BATCH_LIMIT
"""

import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STREAMS_PATH = ROOT / "data" / "streams.json"
CATEGORIES_PATH = ROOT / "config" / "categories.json"

DRY_RUN = os.environ.get("DRY_RUN") == "1"
BATCH_LIMIT = int(os.environ.get("BATCH_LIMIT", "500"))
# 실측 테스트(정답 카테고리를 아는 10개 썸네일) 기준: 정답 케이스는 대부분 0.5~1.0,
# 오판 케이스는 낮은 점수에 몰려 있어 0.5 미만이면 기존 분류를 유지하는 게 더 정확했다
CONFIDENCE_THRESHOLD = 0.50

# 카테고리별 CLIP 프롬프트 (프롬프트별 확률을 카테고리 단위로 합산해 비교)
# 주의: dashcam/walk는 화면 내용이 아니라 "촬영 시점(1인칭)"으로 정의되는 장르라 CLIP이
# 장면만 보고는 traffic/downtown과 구분하지 못한다(실측 결과 거리 장면을 죄다 walk로 분류).
# 이 둘은 제목 키워드 분류에 맡기고, CLIP은 장면으로 구분되는 카테고리만 판별한다.
CATEGORY_PROMPTS = {
    "beach": [
        "a beach with sand and ocean waves",
        "a coastal shoreline with the sea",
    ],
    "parking": [
        "a parking lot with rows of parked cars",
    ],
    "traffic": [
        "a road intersection with car traffic",
        "cars driving on a highway or road",
    ],
    "harbor": [
        "a harbor with boats and ships docked at a marina",
        "a port waterfront with vessels on the water",
    ],
    "airport": [
        "an airport runway with airplanes taking off or landing",
        "airplanes parked at airport terminal gates",
    ],
    "train": [
        "a train on railway tracks",
        "a railway station platform with trains",
    ],
    "river": [
        "a river or canal waterfront",
    ],
    "plaza": [
        "an open public square or plaza in a city",
    ],
    "park": [
        "a green park with trees, grass and walking paths",
    ],
    "alley": [
        "a narrow alley between buildings",
    ],
    "construction": [
        "a construction site with cranes and heavy machinery",
    ],
    "aerial": [
        "an aerial view of the ground from a drone or high altitude",
    ],
    "mountain": [
        "a mountain landscape with peaks or forest hills",
        "a ski slope with snow in the mountains",
    ],
    "downtown": [
        "a city street with buildings, shops and pedestrians",
        "a downtown plaza or crossing in a city",
    ],
    "skyline": [
        "a wide panoramic view of a city skyline with many buildings seen from far away",
        "an aerial cityscape seen from a high observation point or tower",
    ],
    "wildlife": [
        "wild animals in nature",
        "birds or animals at a feeder or waterhole",
    ],
    "crowd": [
        "a large dense crowd of many people",
    ],
    "indoor": [
        "the interior of a room inside a building",
    ],
}

# 촬영 시점(장르) 기반이라 CLIP이 판별할 수 없는 카테고리 — 현재 카테고리가 이거면 건너뛴다
PERSPECTIVE_CATEGORIES = {"dashcam", "walk"}

# 조건 태그(일반 영상 전용): 썸네일에서 확실히 구분되는 밤/낮/눈만 CLIP으로 판별.
# 비(빗줄기)는 한 장의 썸네일로는 신뢰도가 낮아 제목 키워드(update.mjs)에 맡긴다.
CONDITION_PROMPTS = [
    ("night", "a photo taken at night, dark scene"),
    ("day", "a photo taken during the day in bright daylight"),
    ("snow", "a scene covered in snow"),
    ("nosnow", "a scene with no snow on the ground"),
]


def load_streams():
    with open(STREAMS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_streams(snapshot):
    snapshot["generatedAt"] = datetime.now(timezone.utc).isoformat()
    snapshot["count"] = len(snapshot["streams"])
    with open(STREAMS_PATH, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False)


def detect_condition_tags(model, processor, torch, img):
    texts = [p for _, p in CONDITION_PROMPTS]
    inputs = processor(text=texts, images=img, return_tensors="pt", padding=True)
    with torch.no_grad():
        out = model(**inputs)
    probs = out.logits_per_image.softmax(dim=-1)[0].tolist()
    scores = {name: probs[i] for i, (name, _) in enumerate(CONDITION_PROMPTS)}
    tags = []
    nd = scores["night"] + scores["day"]
    if nd > 0:
        if scores["night"] / nd >= 0.7:
            tags.append("night")
        elif scores["day"] / nd >= 0.7:
            tags.append("day")
    sn = scores["snow"] + scores["nosnow"]
    if sn > 0 and scores["snow"] / sn >= 0.75:
        tags.append("snow")
    return tags


def fetch_category_keys():
    """config/categories.json에 실제로 존재하는 카테고리만 CLIP 후보로 쓴다"""
    with open(CATEGORIES_PATH, "r", encoding="utf-8") as f:
        return {row["key"] for row in json.load(f)}


def fetch_targets(snapshot):
    # 녹화 영상만 + ai 분류 미체크 + 유저 수정분 제외
    # (라이브를 제외하는 이유는 모듈 docstring 참고 — 한 프레임이 스트림을 대표하지 못한다)
    return [
        row for row in snapshot["streams"]
        if (row.get("content_type") or "live") == "video"
        and "ai_checked_at" not in row
        and row.get("category_source") != "user"
    ][:BATCH_LIMIT]


def thumbnail_url(row):
    # fetch_targets가 content_type='video'만 가져오므로 항상 저장된 썸네일을 쓴다
    return row.get("thumbnail") or f"https://i.ytimg.com/vi/{row['video_id']}/hqdefault.jpg"


def download_image(url, fallback=None):
    from PIL import Image

    for candidate in [url, fallback]:
        if not candidate:
            continue
        try:
            r = requests.get(candidate, timeout=15)
            if r.status_code != 200 or len(r.content) < 1000:
                continue
            return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            continue
    return None


def main():
    snapshot = load_streams()
    rows = fetch_targets(snapshot)
    print(f"AI 분류 대상: {len(rows)}건 (dry_run={DRY_RUN})")
    if not rows:
        return

    import torch
    from transformers import CLIPModel, CLIPProcessor

    model_name = "openai/clip-vit-base-patch32"
    print(f"모델 로딩: {model_name}")
    model = CLIPModel.from_pretrained(model_name)
    processor = CLIPProcessor.from_pretrained(model_name)
    model.eval()

    valid_keys = fetch_category_keys()
    prompts = []
    prompt_category = []
    for cat, plist in CATEGORY_PROMPTS.items():
        if cat not in valid_keys:
            continue
        for p in plist:
            prompts.append(p)
            prompt_category.append(cat)

    changed = 0
    kept = 0
    skipped = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    tagged = 0

    for row in rows:
        vid = row["video_id"]
        is_video = (row.get("content_type") or "live") == "video"
        # 키워드가 dashcam/walk로 분류한 건 시점 기반 장르라 CLIP이 카테고리를 판단하지 않는다
        # (단, 일반 영상이면 조건 태그 분석은 수행)
        skip_category = row.get("category") in PERSPECTIVE_CATEGORIES

        payload = {"ai_checked_at": now_iso}
        img = download_image(thumbnail_url(row), fallback=row.get("thumbnail"))
        if img is None:
            # 썸네일 자체를 못 받으면 체크 기록만 남기고 넘어간다
            row.update(payload)
            skipped += 1
            continue

        if skip_category:
            kept += 1
        else:
            inputs = processor(text=prompts, images=img, return_tensors="pt", padding=True)
            with torch.no_grad():
                outputs = model(**inputs)
            probs = outputs.logits_per_image.softmax(dim=-1)[0]

            # 프롬프트별 확률을 카테고리 단위로 합산
            cat_scores = {}
            for i, cat in enumerate(prompt_category):
                cat_scores[cat] = cat_scores.get(cat, 0.0) + probs[i].item()
            best_cat, best_score = max(cat_scores.items(), key=lambda kv: kv[1])

            if best_score >= CONFIDENCE_THRESHOLD and best_cat != row.get("category"):
                payload["category"] = best_cat
                payload["category_source"] = "ai"
                changed += 1
                print(f"  {vid}: {row.get('category')} -> {best_cat} ({best_score:.2f})")
            else:
                kept += 1

        # 일반 영상이면 밤/낮/눈 조건 태그 분석 (기존 태그와 충돌하지 않는 것만 추가)
        if is_video:
            cond = detect_condition_tags(model, processor, torch, img)
            existing = row.get("tags") or []
            addable = []
            for t in cond:
                if t == "night" and "day" in existing:
                    continue
                if t == "day" and "night" in existing:
                    continue
                if t not in existing:
                    addable.append(t)
            if addable:
                payload["tags"] = existing + addable
                tagged += 1

        row.update(payload)

    if not DRY_RUN:
        save_streams(snapshot)
    print(f"완료: 카테고리 변경 {changed} / 유지 {kept} / 썸네일없음 {skipped} / 태그부여 {tagged}")


if __name__ == "__main__":
    main()