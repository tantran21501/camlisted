"""트래픽 계열 라이브캠 프레임에서 차량을 세어 vehicle_observations에 쌓는다 (1단계: 수집만).

왜 이걸 만드나: 애드센스가 두 번 "가치가 별로 없는 콘텐츠"로 반려했고, 그 판정의 핵심은
"이 사이트에만 있는 것이 무엇인가"다. 링크 목록에 문단을 얹는 걸로는 안 바뀐다.
카탈로그에서 가장 많은 트래픽 계열 카메라를 실제로 분석해 만든 숫자는 다른 데 없는 자료가 된다.

지금은 페이지를 만들지 않는다. 프레임 한 장은 표본이 아니기 때문이다(PTZ 오분류 사건과 같은 함정).
몇 주 쌓아 표본이 생긴 뒤에 집계 페이지를 낸다.

프레임 출처: hqdefault_live.jpg — 유튜브가 라이브용으로 주는 현재 화면 스냅샷. 480x360이고
최대 5분마다 갱신된다. 플레이어 iframe에서 픽셀을 읽는 건 브라우저가 원천 차단하므로
(cross-origin: contentDocument SecurityError, canvas는 iframe을 인자로 받지도 않음)
자동 수집으로 접근 가능한 프레임은 이것뿐이다. 다운로드해서 분석만 하고 저장하지 않는다.

환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, (선택) DRY_RUN=1, LIMIT
"""

import io
import os
import sys
import collections

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
DRY_RUN = os.environ.get("DRY_RUN") == "1"
LIMIT = int(os.environ.get("LIMIT", "600"))

# 차량이 실제로 찍히는 카테고리만. 나머지(해변·야생동물 등)를 돌려봐야 0에 가깝고 시간만 쓴다.
CATEGORIES = "traffic,avenue,downtown,parking"
# COCO 클래스 → 우리 컬럼. 480x360에서 안정적으로 구분되는 건 이 4종뿐이다
# (SUV/세단 같은 세분류는 이 해상도에서 무리 — 차 한 대가 26~48px에 불과하다).
VEHICLE_CLASSES = {2: "cars", 3: "motorcycles", 5: "buses", 7: "trucks"}
CONF = 0.35  # 실측에서 진짜 차량이 0.42~0.82로 잡혔고, 그 아래는 노면 얼룩이 섞이기 시작한다

if not SUPABASE_URL or not SERVICE_KEY:
    print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.", file=sys.stderr)
    sys.exit(1)

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}

# 색 판정 규칙 (PIL HSV: H·S·V 모두 0~255). 아직 검증 전이라 결과는 brightness로 걸러 써야 한다.
# 흰/은/회색은 이 해상도에서 사실상 구분되지 않으므로 굳이 나누지 않는다.
COLOR_RULES = [
    ("white",  lambda h, s, v: v > 170 and s < 45),
    ("black",  lambda h, s, v: v < 65),
    ("gray",   lambda h, s, v: s < 45),
    ("red",    lambda h, s, v: (h < 8 or h > 240) and s >= 45),
    ("orange", lambda h, s, v: 8 <= h < 20 and s >= 45),
    ("yellow", lambda h, s, v: 20 <= h < 40 and s >= 45),
    ("green",  lambda h, s, v: 40 <= h < 110 and s >= 45),
    ("blue",   lambda h, s, v: 110 <= h < 190 and s >= 45),
]


def fetch_targets():
    url = (
        f"{SUPABASE_URL}/rest/v1/streams"
        f"?select=video_id,category,country"
        f"&content_type=eq.live&status=eq.live&approval_status=eq.approved"
        f"&or=(visibility.is.null,visibility.eq.listed)"
        f"&category=in.({CATEGORIES})"
        f"&limit={LIMIT}"
    )
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def download_frame(video_id):
    from PIL import Image
    url = f"https://i.ytimg.com/vi/{video_id}/hqdefault_live.jpg"
    try:
        r = requests.get(url, timeout=15)
        if r.status_code != 200 or len(r.content) < 1000:
            return None
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def color_of(hsv_crop):
    """박스 가운데 절반의 HSV 중앙값으로 대표색을 고른다.
    가장자리는 노면·그림자가 섞여서 그대로 쓰면 전부 회색으로 쏠린다."""
    import numpy as np
    h, w = hsv_crop.shape[:2]
    if h < 4 or w < 4:
        return "unknown"
    c = hsv_crop[h // 4: 3 * h // 4, w // 4: 3 * w // 4]
    if c.size == 0:
        c = hsv_crop
    hh, ss, vv = (int(np.median(c[:, :, i])) for i in range(3))
    for name, test in COLOR_RULES:
        if test(hh, ss, vv):
            return name
    return "other"


def insert_rows(rows):
    if DRY_RUN or not rows:
        return
    r = requests.post(f"{SUPABASE_URL}/rest/v1/vehicle_observations",
                      headers=HEADERS, json=rows, timeout=60)
    r.raise_for_status()


def main():
    targets = fetch_targets()
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

    for t in targets:
        vid = t["video_id"]
        img = download_frame(vid)
        if img is None:
            no_frame += 1
            continue
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
            "vehicles": n,
            "cars": kinds.get("cars", 0),
            "trucks": kinds.get("trucks", 0),
            "buses": kinds.get("buses", 0),
            "motorcycles": kinds.get("motorcycles", 0),
            "colors": dict(colors) or None,
            "brightness": brightness,
        })

        # 한 번에 다 보내면 실패 시 통째로 날아가므로 나눠서 적재
        if len(rows) >= 100:
            insert_rows(rows)
            rows = []

    insert_rows(rows)
    print(f"완료: 분석 {seen}대 / 썸네일없음 {no_frame}대 / 차량 총 {total_vehicles}대")
    if by_country:
        top = ", ".join(f"{c}:{n}" for c, n in by_country.most_common(6))
        print(f"  국가별 차량 수(상위): {top}")


main()
