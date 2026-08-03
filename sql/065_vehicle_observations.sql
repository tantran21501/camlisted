-- 트래픽 계열 라이브캠 프레임에서 차량을 세어 매일 밤 쌓는다 (1단계: 수집만).
--
-- 왜: 애드센스가 두 번 "가치가 별로 없는 콘텐츠"로 반려했고, 링크 위에 문단을 얹는 걸로는
-- 그 판정이 안 바뀐다. 필요한 건 "이 사이트에만 있는 데이터"인데, 카탈로그에서 가장 많은
-- 트래픽 계열(traffic/avenue/downtown/parking 436대, 16개국)이 그걸 만들 수 있는 유일한 재료다.
-- YOLO11n으로 480x360 썸네일에서 차량이 실제로 잡히는 것은 확인했다(박스 26~48px, 확신도 0.42~0.82).
--
-- 설계 메모
-- * 한 카메라의 한 프레임 = 한 행. 개별 차량이 아니라 집계만 저장한다(하루 ~436행이면 충분).
-- * 프레임 한 장은 표본이 아니다 — PTZ 오분류 사건에서 배운 그대로다. 그래서 "오늘의 통계"를
--   바로 만들지 않고 몇 주를 쌓은 뒤에 집계 페이지를 낸다. observed_at으로 나중에 기간을 자른다.
-- * brightness: 색상 판정은 야간·역광에서 무너지므로, 나중에 "주간 프레임만"으로 거를 수 있게
--   프레임 평균 밝기를 같이 남긴다. 색상 통계를 낼 때 이 값으로 필터링할 것.
-- * colors는 jsonb — 색 분류 규칙은 아직 검증 전이라 바뀔 수 있고, 컬럼으로 굳히면 그때마다
--   마이그레이션이 필요하다.

create table if not exists vehicle_observations (
  id            bigint generated always as identity primary key,
  video_id      text not null references streams(video_id) on delete cascade,
  observed_at   timestamptz not null default now(),
  vehicles      int  not null,                 -- 탐지된 차량 총합
  cars          int  not null default 0,
  trucks        int  not null default 0,
  buses         int  not null default 0,
  motorcycles   int  not null default 0,
  colors        jsonb,                         -- {"white":3,"gray":2,...} (검증 전 — brightness로 걸러 쓸 것)
  brightness    int,                           -- 프레임 평균 밝기 0~255 (주/야 판별용)
  model         text not null default 'yolo11n'
);

-- 집계는 "특정 카메라의 기간별" 또는 "특정 날짜 전체"로 조회하므로 두 방향 다 인덱스를 둔다
create index if not exists vehicle_obs_video_time on vehicle_observations (video_id, observed_at desc);
create index if not exists vehicle_obs_time       on vehicle_observations (observed_at desc);

alter table vehicle_observations enable row level security;

-- 차량 대수·색상일 뿐 개인정보가 없고, 나중에 공개 집계 페이지에서 읽어야 하므로 공개 읽기.
-- 쓰기 정책은 두지 않는다 → 야간 작업(service_role)만 기록할 수 있다.
drop policy if exists "vehicle_obs_public_read" on vehicle_observations;
create policy "vehicle_obs_public_read" on vehicle_observations for select using (true);

-- 확인용
select count(*) as rows_now from vehicle_observations;
