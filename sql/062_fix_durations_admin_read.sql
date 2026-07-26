-- Recent Visitors 표의 Stay 칸이 전부 '–'로 나오는 문제.
--
-- 원인 진단: 기록은 정상이다. visit_durations INSERT 정책(029)은 살아 있고, anon 키로 실제
-- INSERT를 해보면 201이 떨어진다. 집계 뷰 daily_duration_stats도 값을 잘 돌려준다
-- (7/26 134세션, 7/25 111세션 …). 뷰는 소유자 권한으로 실행되어 RLS를 우회하기 때문이다.
-- 즉 데이터는 쌓이는데 stats.js가 읽는 "원본 테이블 SELECT"만 막혀 있다.
-- 그 SELECT를 여는 게 031인데, 이게 적용되지 않은 것으로 보인다.
--
-- 031을 그대로 다시 돌리면 정책이 이미 있을 때 에러가 나므로, 여기서는 몇 번을 돌려도
-- 안전하도록 drop 후 create 한다.

drop policy if exists "visit_durations_admin_read" on visit_durations;
create policy "visit_durations_admin_read"
  on visit_durations for select to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- 진단 중에 anon 키로 넣어본 테스트 행 정리 (visit_log에 없는 키라 화면에는 안 잡히지만,
-- daily_duration_stats의 오늘 세션 수에는 1건 섞여 있다)
delete from visit_durations where visitor_key = '00000000-0000-0000-0000-0000deadbeef';

-- 확인용: 정책이 실제로 걸렸는지, 최근 데이터가 있는지
select policyname, cmd, roles
  from pg_policies
 where tablename = 'visit_durations'
 order by policyname;

select (created_at at time zone 'Asia/Seoul')::date as kst_date,
       count(*) as segments,
       count(distinct visitor_key) as visitors
  from visit_durations
 group by 1
 order by 1 desc
 limit 7;
