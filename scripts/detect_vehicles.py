"""트래픽 계열 라이브캠 프레임에서 차량을 세어 vehicle_observations.json에 쌓는다 (1단계: 수집만).

왜 이걸 만드나: 애드센스가 두 번 "가치가 별로 없는 콘텐츠"로 반려했고, 그 판정의 핵심은
"이 사이트에만 있는 것이 무엇인가"다. 링크 목록에 문단을 얹는 걸로는 안 바뀐다.
카탈로그에서 가장 많은 트래픽 계열 카메라를 실제로 분석해 만든 숫자는 다른 데 없는 자료가 된다.

지금은 페이지를 만들지 않는다. 프레임 한 장은 표본이 아니기 때문이다(PTZ 오분류 사건과 같은 함정).
몇 주 쌓아 표본이 생긴 뒤에 집계 페이지를 낸다.

프레임 출처: hq720_live.jpg — 유튜브가 라이브용으로 주는 현재 화면 스냅샷의 1280x720판.
처음에는 480x360짜리 hqdefault_live만 쓰다가 색상 판정이 무너지길래 찾아냈다. 같은 순간의
같은 화면인지는 화면에 박힌 타임스탬프가 두 장 모두 동일한 것으로 확인했다(정적 썸네일이
아니다). 실측 200대 중 182대가 720p를 주고, 나머지는 sddefault_live(640x480) →
hqdefault_live(480x360) 순으로 내려가면 전부 커버된다.

해상도를 올린 이유는 차 한 대가 차지하는 픽셀이다. 480p에선 박스 폭이 26~48px이라 차체
색이 압축에 뭉개져서, 은색 차가 하늘빛을 받으면 그대로 파랑으로 찍혔다. 720p에선 중앙값
84px이 되고 검출되는 차량 수도 대당 1.08대에서 1.29대로 늘었다.

플레이어 iframe에서 픽셀을 읽는 건 브라우저가 원천 차단하므로(cross-origin:
contentDocument SecurityError, canvas는 iframe을 인자로 받지도 않음) 자동 수집으로
접근 가능한 프레임은 이 썸네일뿐이다. 다운로드해서 분석만 하고 저장하지 않는다.

상태는 data/streams.json(대상 조회)과 data/vehicle_observations.json(관측 적재)에 저장한다 (DB 없음).
환경변수: (선택) DRY_RUN=1, LIMIT
"""

import io
import json
import os
import sys
import collections
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STREAMS_PATH = ROOT / "data" / "streams.json"
OBSERVATIONS_PATH = ROOT / "data" / "vehicle_observations.json"

DRY_RUN = os.environ.get("DRY_RUN") == "1"
LIMIT = int(os.environ.get("LIMIT", "600"))

# 차량이 실제로 찍히는 카테고리만. 나머지(해변·야생동물 등)를 돌려봐야 0에 가깝고 시간만 쓴다.
CATEGORIES = {"traffic", "avenue", "downtown", "parking"}
# COCO 클래스 → 우리 컬럼. 480x360에서 안정적으로 구분되는 건 이 4종뿐이다
# (SUV/세단 같은 세분류는 이 해상도에서 무리 — 차 한 대가 26~48px에 불과하다).
VEHICLE_CLASSES = {2: "cars", 3: "motorcycles", 5: "buses", 7: "trucks"}
CONF = 0.35  # 실측에서 진짜 차량이 0.42~0.82로 잡혔고, 그 아래는 노면 얼룩이 섞이기 시작한다

# 라이브 프레임 후보. 앞에서부터 시도해 처음 성공한 것을 쓴다.
FRAME_SOURCES = [("hq720_live", 1280), ("sddefault_live", 640), ("hqdefault_live", 480)]

# 색 판정 문턱 (PIL HSV: H·S·V 모두 0~255).
SAT_MIN = 70        # 이 아래는 색이 있다고 보지 않는다 (은색/회색 오검출 차단)
SAT_MIN_BLUE = 110  # 파랑만 더 엄격하게
VAL_DARK = 55       # 이보다 어두우면 색조를 믿을 수 없다 → 검정
VAL_WHITE = 165     # 무채색 중 이보다 밝으면 흰색, 아니면 회색


def classify_color(h, s, v):
    """차량 대표 HSV 하나를 색 이름으로. 애매하면 유채색이 아니라 무채색 쪽으로 민다."""
    achromatic = "white" if v > VAL_WHITE else "gray"
    if v < VAL_DARK:
        return "black"
    if s < SAT_MIN:
        return achromatic
    if h < 12 or h > 225:   # 빨강. 압축 때문에 순수 빨강이 자홍 쪽(h≈230~250)으로 밀린다
        return "red"
    if h < 22:
        return "orange"
    if h < 42:
        return "yellow"
    if h < 115:
        return "green"
    if h < 200:
        return "blue" if s >= SAT_MIN_BLUE else achromatic
    return "other"


def load_streams():
    with open(STREAMS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_observations():
    if not OBSERVATIONS_PATH.exists():
        return []
    with open(OBSERVATIONS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("items", [])


def save_observations(items):
    OBSERVATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OBSERVATIONS_PATH, "w", encoding="utf-8") as f:
        json.dump({"format": "vehicle-obs-v1", "items": items}, f, ensure_ascii=False)


def fetch_targets(snapshot):
    return [
        row for row in snapshot["streams"]
        if (row.get("content_type") or "live") == "live"
        and row.get("status") == "live"
        and row.get("approval_status") == "approved"
        and row.get("visibility") in (None, "listed")
        and row.get("category") in CATEGORIES
    ][:LIMIT]


def download_frame(video_id):
    """가장 큰 라이브 프레임부터 시도. (이미지, 가로폭) 또는 (None, 0)."""
    from PIL import Image
    for name, width in FRAME_SOURCES:
        try:
            r = requests.get(f"https://i.ytimg.com/vi/{video_id}/{name}.jpg", timeout=20)
            # 없는 해상도는 404와 함께 1KB짜리 회색 자리표시 이미지를 주기도 해서 크기도 같이 본다
            if r.status_code != 200 or len(r.content) < 2000:
                continue
            return Image.open(io.BytesIO(r.content)).convert("RGB"), width
        except Exception:
            continue
    return None, 0


def color_of(hsv_crop):
    """박스 가운데 절반의 HSV 중앙값으로 대표색을 고른다."""
    import numpy as np
    h, w = hsv_crop.shape[:2]
    if h < 6 or w < 6:
        return "unknown"
    c = hsv_crop[h // 4: 3 * h // 4, w // 4: 3 * w // 4]
    if c.size == 0:
        c = hsv_crop
    hh, ss, vv = (int(np.median(c[:, :, i])) for i in range(3))
    return classify_color(hh, ss, vv)


def main():
    snapshot = load_streams()
    targets = fetch_targets(snapshot)
    print(f"차량 관측 대상: {len(targets)}대 (dry_run={DRY_RUN})")
    if not targets:
        return

    import numpy as np
    from ultralytics import YOLO
    model = YOLO("yolo11n.pt")

    rows = []
    seen = 0
    no_frame = 0
    total_vehicles = 0
    by_country = collections.Counter()
    by_width = collections.Counter()

    for t in targets:
        vid = t["video_id"]
        img, frame_w = download_frame(vid)
        if img is None:
            no_frame += 1
            continue
        by_width[frame_w] += 1
        arr = np.array(img)
        hsv = np.array(img.convert("HSV"))
        brightness = int(arr.mean())

        res = model.predict(arr, conf=CONF, verbose=False)[0]
        kinds = collections.Counter()
        colors = collections.Counter()
        for b in res.boxes:
            cid = int(b.cls[0])
            col = VEHICLE_CLASSES.get(cid)
            if not col:
                continue
            x1, y1, x2, y2 = (int(v) for v in b.xyxy[0])
            kinds[col] += 1
            colors[color_of(hsv[max(0, y1):y2, max(0, x1):x2])] += 1

        n = sum(kinds.values())
        total_vehicles += n
        seen += 1
        if t.get("country"):
            by_country[t["country"]] += n

        rows.append({
            "video_id": vid,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "vehicles": n,
            "cars": kinds.get("cars", 0),
            "trucks": kinds.get("trucks", 0),
            "buses": kinds.get("buses", 0),
            "motorcycles": kinds.get("motorcycles", 0),
            "colors": dict(colors) or None,
            "brightness": brightness,
            # 어떤 해상도로 본 프레임인지. 색·대수 통계를 낼 때 해상도가 섞이면 안 되므로
            # (480p는 차를 덜 찾고 색도 더 틀린다) 나중에 이 값으로 잘라 쓴다.
            "frame_w": frame_w,
        })

        # 한 번에 다 저장하면 실패 시 통째로 날아가므로 나눠서 적재
        if len(rows) >= 100:
            items = load_observations() + rows
            if not DRY_RUN:
                save_observations(items)
            rows = []

    if rows:
        items = load_observations() + rows
        if not DRY_RUN:
            save_observations(items)
    print(f"완료: 분석 {seen}대 / 썸네일없음 {no_frame}대 / 차량 총 {total_vehicles}대")
    print("  프레임 해상도: " + ", ".join(f"{w}px {n}대" for w, n in sorted(by_width.items(), reverse=True)))
    if by_country:
        top = ", ".join(f"{c}:{n}" for c, n in by_country.most_common(6))
        print(f"  국가별 차량 수(상위): {top}")


main()