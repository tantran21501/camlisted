-- 2026-07-30 01:45:17 UTC 일괄 삭제 되돌리기 (76건).
--
-- 무슨 일이 있었나: 관리자가 승인 대기 큐에서 좋은 캠을 하나씩 승인하고, 남은 쓰레기만
-- "전체 선택 → 일괄 삭제"로 지웠다. 그런데 "전체 선택" 버튼이 render() 시점의 목록을
-- 클로저에 붙잡고 있었고, 하나씩 승인한 항목은 화면(refreshCard)에서만 사라지고 그 목록에는
-- 남아 있었다. 그래서 이미 승인한 카메라들까지 선택에 섞여 함께 삭제됐다.
-- 클라이언트 쪽 원인은 js/app.js에서 고쳤다(클릭 시점에 목록 재계산 + 승인 시 선택 해제
-- + 승인된 항목이 삭제 선택에 있으면 경고).
--
-- 복구 방식: streams 행 자체는 지워졌고 blocklist에는 video_id/channel_id/title만 남아
-- 카테고리·국가·화질 같은 값은 복원할 수 없다. 그래서 "차단만 해제"한다 —
-- 그러면 오늘 밤 update.mjs가 아직 살아있는 라이브를 정상적으로 다시 수집하고,
-- 제목·채널·국가·카테고리를 새로 채운다. (차단이 남아 있으면 수집기가 영구히 건너뛴다.)
--
-- 주의: 이 시각에 지운 것 중 정말로 지우고 싶었던 쓰레기 영상도 섞여 있다. 다시 들어오면
-- 승인 대기(pending)로 잡히니, 내일 큐에서 그때 다시 지우면 된다 — 이번엔 위 수정 덕분에
-- 승인한 것이 함께 지워지지 않는다.

-- (1) 지금 복구 대상이 몇 건인지 먼저 확인
select count(*) as to_unblock
  from blocklist
 where created_at between '2026-07-30T01:45:00Z' and '2026-07-30T01:46:00Z';

-- (2) 되살릴 목록을 눈으로 확인 (제목 보고 쓰레기/정상 판단 가능)
select video_id, title, channel_id
  from blocklist
 where created_at between '2026-07-30T01:45:00Z' and '2026-07-30T01:46:00Z'
 order by title;

-- (3) 차단 해제 — 이 줄을 실행하면 오늘 밤 수집기가 다시 주워온다
delete from blocklist
 where created_at between '2026-07-30T01:45:00Z' and '2026-07-30T01:46:00Z';

-- (4) 확인: 위 시각의 차단 기록이 0이어야 한다
select count(*) as remaining
  from blocklist
 where created_at between '2026-07-30T01:45:00Z' and '2026-07-30T01:46:00Z';
