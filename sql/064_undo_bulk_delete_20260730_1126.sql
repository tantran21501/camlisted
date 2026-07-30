-- 2026-07-30 11:26:58 KST(=02:26:58 UTC) 일괄 삭제 되돌리기 (50건).
--
-- 063과 같은 버그가 한 번 더 났다. 수정 커밋은 11:14:54에 푸시됐지만 관리자 브라우저 탭은
-- 그 전에 열려 있어서 캐시된 옛 app.js가 계속 돌고 있었다 — 배포와 "이미 열린 탭에 적용"은
-- 다르다. 강력 새로고침(Ctrl+Shift+R) 전까지는 고친 코드가 적용되지 않는다.
--
-- 063과 동일하게 차단만 해제한다. streams 행은 지워졌고 blocklist에는 video_id/channel_id/
-- title만 남아 카테고리·국가는 복원되지 않는다 → 오늘 밤 update.mjs가 다시 수집하며 재분류.

-- (1) 복구 대상 건수 확인
select count(*) as to_unblock
  from blocklist
 where created_at between '2026-07-30T02:26:00Z' and '2026-07-30T02:28:00Z';

-- (2) 되살릴 목록 확인 (제목 보고 쓰레기/정상 판단)
select video_id, title, channel_id
  from blocklist
 where created_at between '2026-07-30T02:26:00Z' and '2026-07-30T02:28:00Z'
 order by title;

-- (3) 차단 해제
delete from blocklist
 where created_at between '2026-07-30T02:26:00Z' and '2026-07-30T02:28:00Z';

-- (4) 확인 — 0이어야 한다
select count(*) as remaining
  from blocklist
 where created_at between '2026-07-30T02:26:00Z' and '2026-07-30T02:28:00Z';
