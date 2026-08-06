-- approval_status가 NULL인 옛 행 309건을 approved로 채운다.
--
-- 왜 생겼나: 승인 절차(19단계)가 도입되기 전에 들어온 행들이다. 컬럼을 추가할 때 기존 행을
-- 채우지 않았고 기본값도 없어서 NULL로 남았다. 지금 삽입 경로(update.mjs, 유저 제보)는
-- 둘 다 'pending'을 명시하므로 새로 생기지는 않는다.
--
-- 왜 approved인가: 이 행들은 이미 사이트에 노출되고 있다. 프론트가 `approval_status !== 'pending'`
-- 으로 거르는데 자바스크립트에서 null !== 'pending' 이 참이기 때문이다. 즉 화면상으로는 이미
-- 승인된 것과 똑같이 동작한다. 데이터를 화면에 맞추는 것이지 새로 공개하는 게 아니다.
--
-- 부수적으로 조회 정합성 문제도 없앤다. SQL에서는 `approval_status <> 'pending'`이 NULL 행을
-- 걸러낸다(NULL 비교는 참이 아니라 NULL). 그래서 `= 'approved'`로 세면 3095, 프론트가 세면
-- 3399가 나와 같은 것을 두 값으로 세고 있었다. 실제로 이 300여 건이 통계와 패턴 검증 표본에서
-- 계속 빠져 있었다.

-- ── 1단계: 되돌릴 수 있게 대상 id를 먼저 남긴다 ──────────────────────────────
create table if not exists approval_backfill_20260807 as
select video_id, status, visibility, content_type, added_at
from streams
where approval_status is null;

select count(*) as 백업된_행수 from approval_backfill_20260807;

-- 어떤 것들인지 확인
select content_type, status, coalesce(visibility, '(null)') as visibility, count(*)
from approval_backfill_20260807
group by 1, 2, 3 order by 4 desc;

-- ── 2단계: 승인 처리 ─────────────────────────────────────────────────────────
update streams
set approval_status = 'approved'
where approval_status is null;

-- ── 3단계: 재발 방지 ─────────────────────────────────────────────────────────
-- 삽입 경로가 전부 값을 명시하므로 지금은 NULL이 안 생기지만, 새 경로가 빠뜨렸을 때
-- 검수를 건너뛰고 바로 공개되는 쪽으로 새는 것보다 대기 큐에 쌓이는 쪽이 안전하다.
alter table streams alter column approval_status set default 'pending';

-- ── 확인 ─────────────────────────────────────────────────────────────────────
select coalesce(approval_status, '(null)') as approval_status, count(*)
from streams group by 1 order by 2 desc;

-- 되돌리려면:
--   update streams s set approval_status = null
--   from approval_backfill_20260807 b where s.video_id = b.video_id;
-- 확인이 끝나 백업이 필요 없어지면:
--   drop table approval_backfill_20260807;
