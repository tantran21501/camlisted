// AI 검수: 승인 대기 큐를 Gemini(무료 티어)로 자동 판정한다. DB 없이 JSON 파일만 사용한다.
// - approve: 진짜 고정 라이브캠 / 실환경 앰비언트·주행·워킹 영상 -> 바로 공개
// - reject:  뉴스/음악/게임/토크/리액션 등 성격에 안 맞는 것 -> 삭제(차단 안 함, 재검색으로 재유입 가능)
// - unsure:  애매하면 대기 큐에 남겨 사람이 검수
// 상태는 data/streams.json에, 판정 로그는 data/ai_review_log.json에 저장한다.
// GEMINI_API_KEY 시크릿이 없으면 아무것도 안 하고 조용히 종료(워크플로 안 깨짐).
import {
  loadStreams, saveStreams,
  loadCategories,
  loadAiReviewLog, saveAiReviewLog,
} from './state.mjs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.log('GEMINI_API_KEY 없음 — AI 검수 건너뜀');
  process.exit(0);
}

// 키가 무료로 접근 가능한 모델이 계정/지역마다 달라, 후보를 순서대로 시도해 먼저 되는 걸 쓴다.
// 2026-08-01 로그 기준 이 무료 키에서 실제로 되는 건 gemini-flash-latest 하나뿐이다:
// 2.0-flash / 2.0-flash-lite는 무료 할당량이 0(429 "free_tier_input_token_count, limit: 0"),
// 1.5-flash는 은퇴(404). 그래도 목록에 남겨두는 이유는 구글이 무료 정책을 바꿀 때 자동으로
// 주워 쓰기 위해서다 — 대신 폴백이 실질적으로 없으므로, 유일한 모델이 일시 오류(503)를 내면
// callGemini가 목록 전체를 다시 훑는다(그게 없어서 하루치 155건이 통째로 밀린 적이 있다).
const MODEL_CANDIDATES = (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [])
  .concat(['gemini-flash-latest', 'gemini-2.0-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash']);
let MODEL = null; // 첫 성공한 모델로 고정
const BATCH = 15;            // 한 요청에 15개 (요청 수 절약)
// 대기 큐 검수. 하루 수집량이 80~130건이라 450이면 당일 전부 소화하고도 3배 여유가 있다.
const MAX_PER_RUN = 450;
// 승인 카탈로그 재검수. 무료 키로 돌아온 지금은 무료 일일 한도를 대기 큐 검수와 나눠 쓰므로
// 60으로 유지한다. 카탈로그 한 바퀴가 2주에서 약 45일로 늘어나지만, 사람이 고친 분류는
// user 가드로 보호되고 방문자 20/일 규모에서 교정 지연은 실질 손해가 작다.
const AUDIT_PER_RUN = 60;

// 무료 일일 할당량이 소진되면 이후 요청은 전부 429다. 한 번 확인되면 플래그를 세워
// 남은 배치를 즉시 포기한다(계속 시도하면 수십 분을 낭비하고 쿼터만 더 태운다).
let QUOTA_EXHAUSTED = false;
const isQuotaExhausted = () => QUOTA_EXHAUSTED;
const DELAY_MS = 8000;       // 요청 간 간격 (무료 모델 분당 요청 한도 여유)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiUrl(model) {
  const template = process.env.GEMINI_URL;
  if (template) {
    return template
      .replace(/\{\{GEMINI_MODEL\}\}/g, model)
      .replace(/\{\{GEMINI_API_KEY\}\}/g, GEMINI_API_KEY);
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

function buildPrompt(items, categoryKeys) {
  return `You are a strict moderator for a directory of REAL-WORLD live cameras and ambient footage: fixed/mounted live cams (traffic, city streets, beaches, harbors, airports, train stations, nature/wildlife, skylines, plazas), dashcam driving footage, and first-person walking-tour videos.

APPROVE only if the video is genuinely one of these — a fixed camera view, or real-world ambient / walking / driving footage, with NO host talking to the camera and no edited entertainment. Raw CCTV / security-camera recordings of real events (earthquakes, accidents, fires, storms) ARE acceptable — this directory explicitly collects them; approve them as long as the footage itself is camera-recorded reality, not a news-program edit with anchors or graphics.

REJECT if it is: news broadcast or anchor desk, talk show, music video, a 24/7 music / BGM / lofi / relaxing-sound / white-noise / sleep livestream (reject even if the title says LIVE and shows a static image), gaming, reaction/commentary, tutorial, product review, talking-head vlog, sports match broadcast, movie/TV clip, or clearly unrelated/staged content.

IMPORTANT — background music does NOT make it a music stream. Many genuine live cams play music or ambience over the camera feed (e.g. an airport cam, a city skyline cam, or a tram cam with a relaxing soundtrack). APPROVE those: the camera view is the point. Only reject as a music stream when the picture itself is not a real-world camera view — a static image, album art, or looping animation with the music as the actual content. Likewise, commentary or narration over a genuine live camera feed is fine; reject only when a host on screen is the subject.

STRICTER RULE FOR NON-LIVE ITEMS (type "video"). A recorded upload has to earn its place; when in doubt, REJECT rather than "unsure". On top of everything above, reject a "video" item if it is:
- a compilation or clip aggregation — titles like "BEST OF ...", "... COMPILATION", "Top 10 ...", "Funniest / Craziest / Scariest ... Caught on Camera", "Fails", "Road Rage", "Caught in 4K". These are edited entertainment assembled from many sources, even though every clip in them is camera footage.
- a camera vendor or installer demo / sample / test clip — titles naming a product or model ("8MP Dahua sample video", "Hikvision 4K night vision test", "2MP vs 5MP"), or short clips whose point is to show what the hardware can do rather than to show a place.
- a fragment cut out of a news package, even when the footage itself is CCTV.
Length is NOT a criterion. A 20-second CCTV recording of an earthquake shaking a shop is exactly what this directory collects, and a 20-minute montage of crash clips is not. Judge whether it is one continuous unedited camera recording — of a place or of a single real event — rather than how long it runs.

If you cannot tell from the title and channel, use "unsure".

Also pick the best category key from this list (or "other"): ${categoryKeys.join(', ')}.

Determine the country where the camera is physically located, as an uppercase ISO 3166-1 alpha-2 code, using ALL available clues together:
- place names / cities / landmarks in the title,
- the language and script of the title (e.g. Japanese kana -> JP, Korean hangul -> KR, Thai script -> TH),
- the channel name (e.g. "Webcams de México" -> MX, a Japanese news channel -> JP),
- any other geographic hint.
Prefer the FILMING location over the channel owner's country when they conflict (a Japan walking-tour video on a Philippine channel is JP). Use null only when there is genuinely no clue. The "hint" field is the current best guess — confirm or correct it.

Items to judge:
${JSON.stringify(items.map((s, i) => ({ i, title: s.title, channel: s.channel_title, type: s.content_type, hint: s.country || null })))}

Give a short reason for each verdict, written in Korean (한국어, 20자 이내).

Respond ONLY as a compact JSON array, one object per item:
[{"i":0,"verdict":"approve|reject|unsure","category":"<key>","country":"<ISO2 or null>","reason":"<short>"}]`;
}

async function requestModel(model, prompt) {
  const url = geminiUrl(model);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  return res;
}

// 503(UNAVAILABLE)은 "지금 붐비니 잠시 후 다시"라는 뜻이라, 할당량 소진과 달리 기다리면 풀린다.
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

async function callGemini(prompt) {
  // 아직 모델을 못 정했으면 후보를 순서대로 시도해 200 나오는 걸 채택
  if (!MODEL) {
    for (let round = 0; round < 3; round++) {
      if (round) {
        console.log(`  일시적 오류로 모델 선택 실패 — ${round * 30}초 후 재시도 (${round}/2)`);
        await sleep(round * 30000);
      }
      let quotaHit = false;
      let transient = false;
      for (const cand of MODEL_CANDIDATES) {
        const res = await requestModel(cand, prompt);
        if (res.ok) {
          MODEL = cand;
          console.log(`AI 검수 모델 선택: ${cand}`);
          const data = await res.json();
          return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
        }
        const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 400);
        console.log(`  모델 ${cand} 사용 불가 (${res.status}) ${body}`);
        if (res.status === 429) quotaHit = true;
        if (TRANSIENT_STATUS.has(res.status)) transient = true;
        if (res.status !== 404 && res.status !== 400) await sleep(2000); // 429 등은 잠깐 쉬고 다음 후보
      }
      // 일시적 오류가 하나라도 섞였으면 기다렸다 다시 훑는다 (할당량 소진과 구분)
      if (transient) continue;
      // 후보 전부 429였다면 모델이 없는 게 아니라 그날 할당량이 끝난 것
      if (quotaHit) QUOTA_EXHAUSTED = true;
      throw new Error('사용 가능한 무료 모델 없음 (키/할당량 확인 필요)');
    }
    throw new Error('Gemini가 계속 일시적 오류(503 등)를 반환 — 다음 실행에서 재시도');
  }
  // 모델 고정 후: 429(분당 한도)나 503(일시 혼잡)이면 백오프 후 최대 2회 재시도
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await requestModel(MODEL, prompt);
    if (res.ok) {
      const data = await res.json();
      return JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
    }
    const retryable = res.status === 429 || TRANSIENT_STATUS.has(res.status);
    if (retryable && attempt < 2) { await sleep(20000); continue; }
    if (res.status === 429) QUOTA_EXHAUSTED = true; // 재시도까지 했는데 429 → 일일 한도
    throw new Error(`Gemini ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}

// 관리자가 한 번 "살리기(복구)"로 AI 판정을 뒤집은 영상 목록.
// 재검수가 같은 영상을 2주마다 또 숨기는 루프를 막기 위해, 이 목록은 다시 숨기지 않는다.
async function fetchAdminRestoredIds(logItems) {
  return new Set(logItems.filter(r => r.resolution === 'restored').map(r => r.video_id));
}

// 대기 큐 검수: 승인/거절제안/보류. (기존 동작 유지)
async function reviewPending(pending, categoryKeys, validCat, streams, logItems) {
  if (!pending.length) { console.log('AI 검수: 대기 큐가 비어 있음'); return false; }
  console.log(`AI 검수 대상: ${pending.length}건 (배치 ${BATCH})`);
  const now = new Date().toISOString();
  let approved = 0, rejected = 0, unsure = 0, failed = 0, quotaOut = false;

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    let verdicts;
    try {
      verdicts = await callGemini(buildPrompt(batch, categoryKeys));
    } catch (err) {
      console.error(`배치 ${i / BATCH} 실패:`, err.message);
      failed += batch.length;
      if (isQuotaExhausted()) { console.error('  → 무료 할당량 소진, 대기 큐 검수 중단 (남은 건 내일 처리)'); quotaOut = true; break; }
      await sleep(DELAY_MS);
      continue;
    }
    const byIndex = new Map((verdicts || []).map((v) => [v.i, v]));

    for (let j = 0; j < batch.length; j++) {
      const s = batch[j];
      const v = byIndex.get(j);
      if (!v) { unsure += 1; continue; }

      const verdict = ['approve', 'reject', 'unsure'].includes(v.verdict) ? v.verdict : 'unsure';
      logItems.push({
        video_id: s.video_id, title: s.title, channel_title: s.channel_title,
        verdict, reason: (v.reason || '').slice(0, 200),
        suggested_category: v.category || null, suggested_country: v.country || null,
      });

      // 거절이어도 즉시 삭제하지 않는다 — 로그에 남기고 대기 유지, 관리자가 로그에서 확정 삭제/복구.
      if (verdict === 'reject') { rejected += 1; continue; }

      // 승인 또는 보류: 카테고리·국가 교정을 함께 반영 (보류여도 큐에서 정확도 개선)
      const patch = {};
      if (verdict === 'approve') { patch.approval_status = 'approved'; patch.ai_checked_at = now; } // 방금 승인 → 재검수 대상에서 잠시 제외
      // 사람이 직접 고친 분류(category_source='user')는 국가와 마찬가지로 건드리지 않는다
      if (v.category && validCat.has(v.category) && s.category_source !== 'user' && v.category !== s.category) {
        patch.category = v.category;
        patch.category_source = 'ai';
      }
      if (v.country && /^[A-Z]{2}$/.test(v.country) && s.country_source !== 'user' && v.country !== s.country) {
        patch.country = v.country;
        patch.country_source = 'ai';
      }
      if (Object.keys(patch).length) Object.assign(s, patch);
      if (verdict === 'approve') approved += 1;
      else unsure += 1;
    }
    console.log(`  진행 ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
    if (i + BATCH < pending.length) await sleep(DELAY_MS);
  }

  console.log(`AI 검수 완료 — 승인 ${approved} / 거절제안 ${rejected}(대기유지·관리자 확인 필요) / 보류 ${unsure} / 실패 ${failed}`);
  return quotaOut;
}

// 승인(공개)된 카탈로그 재검수: 쓰레기로 판정되면 삭제 대신 visibility='hidden'(공개만 차단)로 내리고
// AI Review Log에 남긴다 → 관리자가 Keep(복구)/Confirm(삭제) 결정. 오탐이어도 데이터는 안 사라짐.
async function auditApproved(categoryKeys, validCat, streams, logItems) {
  const adminRestoredIds = await fetchAdminRestoredIds(logItems); // 관리자가 살린 건 다시 숨기지 않는다
  // ai_checked_at이 오래됐거나(없는) 것부터 순환 재검수 → 전체가 시간을 두고 한 바퀴 돈다.
  // 사람이 직접 제보/등록한 것(source='user')은 제외 — 사람이 검토해 넣은 걸 AI가 함부로 내리지 않는다.
  const rows = streams
    .filter(r => r.approval_status === 'approved' && r.source !== 'user')
    .sort((a, b) => String(a.ai_checked_at || '').localeCompare(String(b.ai_checked_at || '')))
    .slice(0, AUDIT_PER_RUN);
  if (!rows.length) { console.log('재검수: 승인 카탈로그 없음'); return; }
  console.log(`승인 카탈로그 재검수: ${rows.length}건 (오래된 순)`);
  const now = new Date().toISOString();
  let hidden = 0, kept = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let verdicts;
    try {
      verdicts = await callGemini(buildPrompt(batch, categoryKeys));
    } catch (err) {
      console.error(`재검수 배치 ${i / BATCH} 실패:`, err.message);
      failed += batch.length;
      if (isQuotaExhausted()) { console.error('  → 무료 할당량 소진, 재검수 중단 (다음 실행에서 이어서 순환)'); break; }
      await sleep(DELAY_MS);
      continue;
    }
    const byIndex = new Map((verdicts || []).map((v) => [v.i, v]));

    for (let j = 0; j < batch.length; j++) {
      const s = batch[j];
      const v = byIndex.get(j);
      const verdict = v && ['approve', 'reject', 'unsure'].includes(v.verdict) ? v.verdict : 'unsure';
      const patch = { ai_checked_at: now }; // 재검수했음을 표시 → 순환

      if (verdict === 'reject' && !adminRestoredIds.has(s.video_id)) {
        patch.visibility = 'hidden'; // 공개에서만 내림(삭제 아님) — Keep으로 복구 가능
        hidden += 1;
        logItems.push({
          video_id: s.video_id, title: s.title, channel_title: s.channel_title,
          verdict: 'reject', reason: ('재검수: ' + (v?.reason || '')).slice(0, 200),
          suggested_category: v?.category || null, suggested_country: v?.country || null,
        });
      } else {
        kept += 1;
        // 유지되는 건 카테고리·국가 교정만 겸함 (정확도 개선) — 단, 사람이 고친 건 둘 다 보호
        if (v?.category && validCat.has(v.category) && s.category_source !== 'user' && v.category !== s.category) { patch.category = v.category; patch.category_source = 'ai'; }
        if (v?.country && /^[A-Z]{2}$/.test(v.country) && s.country_source !== 'user' && v.country !== s.country) { patch.country = v.country; patch.country_source = 'ai'; }
      }
      Object.assign(s, patch);
    }
    console.log(`  재검수 진행 ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    if (i + BATCH < rows.length) await sleep(DELAY_MS);
  }

  console.log(`재검수 완료 — 숨김 ${hidden} / 유지 ${kept} / 실패 ${failed}`);
}

async function main() {
  const categories = await loadCategories();
  const categoryKeys = categories.filter(c => c.key !== 'other').map(c => c.key);
  const validCat = new Set([...categoryKeys, 'other']);

  const snapshot = await loadStreams();
  const streams = snapshot.streams;
  const logItems = await loadAiReviewLog();

  const pending = streams.filter(r => r.approval_status === 'pending').slice(0, MAX_PER_RUN);

  // 대기 큐 검수가 우선. 거기서 무료 할당량이 소진됐으면 재검수는 통째로 건너뛴다(시도해도 전부 429 낭비)
  const quotaOut = await reviewPending(pending, categoryKeys, validCat, streams, logItems);
  if (!quotaOut) {
    await auditApproved(categoryKeys, validCat, streams, logItems); // 이미 공개된 카탈로그도 순환 재검수
  }

  await saveStreams(snapshot);
  await saveAiReviewLog(logItems);
}

main().catch((err) => { console.error(err); process.exit(1); });