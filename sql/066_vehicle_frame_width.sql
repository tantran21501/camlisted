-- 차량 관측 행에 "어떤 해상도 프레임으로 봤는지"를 남긴다.
--
-- 왜 필요한가: 처음엔 480x360(hqdefault_live)만 썼는데, 그 해상도에서는 차 한 대가 26~48px이라
-- 차체 색이 압축에 뭉개진다. 첫날 439행을 받아보니 파랑 비율이 프레임 밝기에 따라 15%→30%로
-- 요동쳤고, 실제 크롭을 눈으로 확인하니 파랑으로 찍힌 것 대부분이 은색·흰색 차였다.
-- 1280x720(hq720_live)으로 올리니 박스 폭 중앙값이 84px이 되고 검출 차량 수도 대당 1.08→1.29로 늘었다.
--
-- 해상도가 다르면 대수도 색도 비교가 안 되므로, 집계할 때 반드시 이 값으로 잘라 써야 한다.
-- 기존 행(2026-08-04 수집분 439건)은 null로 남는데, 그게 곧 "구 방식(480p·옛 색규칙)"이라는 표시다.
-- 지우지 않고 두는 이유는 대수 자체는 그대로 참고할 수 있어서다. 색상 집계에서만 빼면 된다.

alter table vehicle_observations add column if not exists frame_w int;

comment on column vehicle_observations.frame_w is
  '분석에 쓴 라이브 프레임의 가로 픽셀 (1280=hq720_live, 640=sddefault_live, 480=hqdefault_live). null이면 2026-08-04 구 방식 수집분 — 색상 집계에서 제외할 것.';

-- 확인용
select coalesce(frame_w::text, '(구방식)') as frame_w, count(*)
from vehicle_observations group by 1 order by 1;
