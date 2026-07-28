// 국가별/카테고리별 정적 SEO 페이지 생성기
// 매일 갱신 워크플로 마지막에 실행되어 /country/*.html, /c/*.html, browse.html, sitemap.xml을
// 다시 만들고 커밋한다. 검색 수요의 대부분이 "live cam 도시/나라" 형태라서,
// 실제 콘텐츠가 HTML에 박힌 페이지가 있어야 구글이 색인/랭킹할 수 있다.
import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = 'https://camlisted.com';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://chgodrjjalsrgyxuwjyq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_IPRYfUNkhfTLWohT6gjXYw_APGRcPuP';
// 브라우저에 심는 공개(anon/publishable) 키 — SUPABASE_KEY(운영 시 service role)를 절대 HTML에 넣으면 안 됨
const SUPABASE_ANON_KEY = 'sb_publishable_IPRYfUNkhfTLWohT6gjXYw_APGRcPuP';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MIN_COUNTRY_ENTRIES = 3;   // 이보다 적은 나라는 페이지를 만들지 않음 (얇은 페이지는 SEO에 역효과)
const MAX_ENTRIES_PER_PAGE = 150;

async function fetchAllRows(table, columns = '*') {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryNameOf(code) {
  if (code === 'XX') return 'International'; // 여러 나라가 섞인 모음집용 예약 코드
  try { return regionNames.of(code) || code; } catch { return code; }
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// browse 페이지는 본 사이트의 css/style.css + 공통 헤더(about/stats와 동일한 구조)를 그대로 사용해
// 메인 페이지와 톤을 맞춘다. 아래는 지도/목록 전용 추가 스타일 (사이트 CSS 변수 사용).
const PAGE_CSS = `
  .browse-intro { color: var(--muted); margin-bottom: 16px; }
  /* 순위표 (최장수 라이브) — 넓은 표라 좁은 화면에서는 표 자체만 가로 스크롤시킨다 */
  .rank-wrap { overflow-x: auto; margin: 18px 0 28px; }
  .rank-table { border-collapse: collapse; width: 100%; min-width: 620px; font-size: 0.92rem; }
  .rank-table th, .rank-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .rank-table th { color: var(--muted); font-weight: 600; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .rank-table td.rank { color: var(--muted); font-variant-numeric: tabular-nums; width: 3em; }
  .rank-table td.age { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .rank-table tr:hover td { background: var(--card-bg); }
  .rank-table a { color: var(--text); text-decoration: none; }
  .rank-table a:hover { color: var(--accent); text-decoration: underline; }
  .rank-table .meta { color: var(--muted); font-size: 0.85rem; }
  .rank-note { color: var(--muted); font-size: 0.88rem; }
  .browse-list { columns: 3; column-gap: 32px; padding: 0; }
  .browse-list li { list-style: none; margin-bottom: 6px; break-inside: avoid; }
  .browse-list a { color: var(--text); text-decoration: none; }
  .browse-list a:hover { color: var(--accent); }
  .browse-list .count { color: var(--muted); font-size: 0.85rem; }
  /* 지구본 박스(.globe-box)와 같은 크기의 카드로 맞춘다 — svg는 안에서 비율 유지하며 중앙 배치 */
  .map-wrap { position: relative; margin: 0; height: 460px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .map-wrap svg { width: 100%; height: 100%; display: block; touch-action: none; }
  @media (max-width: 900px) { .map-wrap { height: 320px; } }
  .map-wrap path { stroke: var(--bg, #0d1117); stroke-width: 0.5; }
  .map-wrap path[data-href] { cursor: pointer; }
  .map-wrap path:hover { filter: brightness(1.6); stroke: #ffffff; }
  .map-wrap.zoomed svg { cursor: grab; }
  .map-wrap.grabbing svg { cursor: grabbing; }
  .map-zoom { position: absolute; right: 10px; bottom: 10px; display: flex; flex-direction: column; gap: 6px; z-index: 11; }
  .map-zoom button { width: 34px; height: 34px; border-radius: 8px; background: rgba(0,0,0,.7); border: 1px solid var(--border); color: #fff; font-size: 1.15rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .map-zoom button:hover { border-color: var(--accent); }
  .map-tip { position: fixed; z-index: 10; background: rgba(0,0,0,.85); border: 1px solid var(--border); color: #fff; padding: 5px 10px; border-radius: 6px; font-size: 0.85rem; pointer-events: none; white-space: nowrap; }
  .map-tip.pinned { position: absolute; transform: translate(-50%, -110%); border-color: var(--accent); }
  .map-note { color: var(--muted); font-size: 0.8rem; margin-bottom: 4px; }
  .map-legend { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 0.8rem; margin-bottom: 18px; }
  .map-legend .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; margin-right: 5px; vertical-align: -2px; }
  .map-type-filter { margin: 4px 0 14px; color: var(--muted); font-size: 0.85rem; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .map-type-filter button { background: var(--card-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 0.8rem; }
  .map-type-filter button.active { color: #fff; border-color: var(--accent); }
  @media (max-width: 700px) { .browse-list { columns: 2; } }
  .map-globe-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
  /* min-width:0 — svg(고유폭 900px)나 캔버스가 트랙을 밀어내지 못하게 (없으면 한쪽이 짜부라짐) */
  .mg-col { min-width: 0; }
  .globe-box { position: relative; height: 460px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #000; }
  .globe-sel-label { position: absolute; top: 10px; left: 12px; z-index: 5; background: rgba(0,0,0,.7); border: 1px solid var(--accent); border-radius: 6px; padding: 4px 10px; color: #fff; font-size: 0.9rem; font-weight: 600; pointer-events: none; }
  .globe-bar { display: flex; gap: 12px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .random-btn { background: var(--accent); color: #fff; border: 0; border-radius: 999px; padding: 6px 14px; font-size: 0.85rem; font-weight: 600; cursor: pointer; }
  .panel { position: fixed; right: 0; top: 0; bottom: 0; width: min(var(--panel-w, 500px), 100%); z-index: 40; background: rgba(13,17,23,.97); border-left: 1px solid var(--border); padding: 16px; display: none; flex-direction: column; gap: 10px; }
  .panel-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 5; }
  .panel-resize:hover { background: var(--accent); opacity: 0.5; }
  .panel.open { display: flex; }
  /* 패널이 열린 동안 본문(지도·목록)을 패널 폭만큼 밀어내 가려지지 않게 — 드래그 중에도 --panel-w를 그대로 따라간다 */
  body.panel-open { padding-right: min(var(--panel-w, 500px), 100vw); }
  .panel .close { position: absolute; top: 10px; right: 12px; background: none; border: 0; color: var(--muted); font-size: 1.4rem; cursor: pointer; }
  .panel h2 { font-size: 1.1rem; color: #fff; padding-right: 30px; margin: 0; }
  .panel .sub { color: var(--muted); font-size: 0.85rem; }
  .panel .player { aspect-ratio: 16/9; background: #000; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .panel .player iframe { width: 100%; height: 100%; border: 0; }
  .panel ul { list-style: none; overflow-y: auto; flex: 1; margin: 0; padding: 0; }
  .panel li { margin-bottom: 6px; }
  .panel li button { display: flex; gap: 8px; align-items: flex-start; width: 100%; background: none; border: 0; color: var(--text); text-align: left; cursor: pointer; font-size: 0.82rem; padding: 4px; border-radius: 6px; }
  .panel li button img { width: 96px; aspect-ratio: 16/9; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #000; }
  .panel li button .meta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .panel li button:hover { background: var(--card-bg); }
  .panel li.active button { outline: 1px solid var(--accent); }
  .panel li .lv { color: var(--accent); font-weight: 700; font-size: 0.7rem; margin-right: 6px; }
  .panel a.browse-all { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
  .cam-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .cam-meta:empty { display: none; }
  .cam-info { flex-basis: 100%; color: var(--muted); font-size: 0.78rem; }
  .cam-badge { background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; font-size: 0.75rem; color: var(--muted); }
  .cam-edit { margin-left: auto; color: var(--accent); text-decoration: none; font-size: 0.8rem; }
  .cam-cat-edit, .cam-country-edit { background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px; color: var(--text); font-size: 0.75rem; padding: 3px 8px; cursor: pointer; max-width: 45%; }
  .cam-cond { background: var(--card-bg); border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 0.72rem; padding: 2px 8px; cursor: pointer; }
  .cam-cond.on { color: var(--accent); border-color: var(--accent); }
  .cam-cat-edit.saved, .cam-country-edit.saved { border-color: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.3); }
  .panel-filter { display: flex; gap: 8px; }
  .panel-filter button { background: var(--card-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 0.75rem; cursor: pointer; }
  .panel-filter button.active { color: #fff; border-color: var(--accent); }
  @media (max-width: 900px) {
    .map-globe-row { grid-template-columns: 1fr; }
    .panel { top: auto; bottom: 0; height: 85%; width: 100% !important; border-left: 0; border-top: 1px solid var(--border); }
    .panel .player { max-height: 34vh; }
    .panel-resize { display: none; }
    /* 좁은 화면에선 패널이 하단 시트로 전체 폭을 덮으므로 본문까지 밀면 화면 밖으로 사라진다 — 밀지 않음 */
    body.panel-open { padding-right: 0; }
  }
`;

function pageHtml({ title, description, canonicalPath, h1, intro, introData = '', bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${SITE}${canonicalPath}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${SITE}${canonicalPath}">
<link rel="stylesheet" href="/css/style.css">
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="header-actions">
    <a href="/" class="auth-btn" id="backLink">← Back to site</a>
  </div>
  <h1 id="browseH1">${escapeHtml(h1)}</h1>
</header>
<main class="policy-page stats-page">
  <p class="browse-intro" ${introData}>${escapeHtml(intro)}</p>
  ${bodyHtml}
</main>
</body>
</html>
`;
}

function entryCard(s) {
  const isLive = s.content_type === 'live';
  const thumb = s.thumbnail || `https://i.ytimg.com/vi/${s.video_id}/hqdefault.jpg`;
  const badge = isLive
    ? '<span class="badge live">LIVE</span>'
    : (s.duration_seconds ? `<span class="badge">${formatDuration(s.duration_seconds)}</span>` : '');
  return `
    <a class="entry" href="https://www.youtube.com/watch?v=${encodeURIComponent(s.video_id)}" target="_blank" rel="noopener">
      <div class="thumb" data-vid="${escapeHtml(s.video_id)}"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(s.title)}" loading="lazy" width="320" height="180">${badge}</div>
      <div class="entry-body"><strong>${escapeHtml(s.title)}</strong><span>${escapeHtml(s.channel_title || '')}</span></div>
    </a>`;
}

// 국가/카테고리 페이지는 index.html(본 앱)을 템플릿으로 사용한다:
// - 크롤러: #grid 안에 미리 박아둔 정적 카드 목록을 읽음 (SEO)
// - 방문자: 앱이 로드되면서 필터(window.__presetCountry/-Category)가 걸린 실제 화면으로 대체됨
//   → 투표/즐겨찾기/태그·카테고리·국가 수정 등 메인과 완전히 동일한 기능
// ----- SEO 본문 텍스트 헬퍼 (페이지마다 실제 데이터로 유니크한 글을 만들어 순위·AdSense 독자콘텐츠에 기여) -----
function truncTitle(t) {
  const s = (t || '').replace(/\s+/g, ' ').trim();
  return s.length > 55 ? s.slice(0, 54) + '…' : s;
}
function topLabels(list, keyFn, labelFn, n) {
  const counts = new Map();
  for (const s of list) {
    const k = keyFn(s);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => labelFn(k)).filter(Boolean);
}
function humanList(arr) {
  const a = arr.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}
function exampleTitles(list, n) {
  const seen = new Set(); const out = [];
  for (const s of list) {
    const t = truncTitle(s.title);
    if (!t || seen.has(t)) continue;
    seen.add(t); out.push(`“${escapeHtml(t)}”`);
    if (out.length >= n) break;
  }
  return out;
}
function introSection(paras, linkRows = []) {
  const ps = paras.filter(Boolean).map(p => `<p>${p}</p>`).join('');
  return `<section class="seo-intro">${ps}${linkRows.filter(Boolean).join('')}</section>\n`;
}
function linkRow(label, links) {
  if (!links.length) return '';
  return `<nav class="seo-links"><span class="seo-links-label">${escapeHtml(label)}:</span> ${links.join(' ')}</nav>`;
}

// ----- 페이지 하단 에디토리얼 -----
// AdSense "thin content" 반려의 직접 원인: 페이지가 카드(임베드 링크)뿐이고 원본 산문이 없음.
// 아래는 (1) 사람이 쓴 카테고리/국가 소개 (템플릿 아님, 페이지마다 고유),
// (2) 실데이터에서 뽑는 사실 문단(채널 구성·실측 화질·조건 태그·최장 방송),
// (3) FAQ + FAQPage 구조화 데이터. 전부 그리드 아래(.seo-outro)에 들어간다.
const CATEGORY_NOTES = {
  beach: `Beach cams are the comfort food of the live-cam world: waves on a loop, weather you can read at a glance, and a horizon that resets your attention span. Surfers use them to check swell before driving out, expats use them to look in on a hometown shore, and plenty of people just leave one open as a window they don't have. They are also the easiest way to compare seasons — the same strip of sand in July and January is two different worlds.`,
  parking: `Parking lots and garages are where the classic fixed-CCTV look lives on: high angles, wide lenses, constant low-level motion. That makes them oddly watchable — and genuinely useful. Vehicle-detection and occupancy-counting models are usually trained and tested on exactly this perspective, so a steady public parking feed is one of the few places to see that footage without owning a camera.`,
  traffic: `Traffic cams are the workhorses of public webcams — intersections, highway gantries and roundabouts streamed by cities and road authorities around the clock. Watch one long enough and you can read a whole city's rhythm: rush hour building, night deliveries, the odd near-miss. For computer-vision work they are the canonical test scene for vehicle tracking, counting and flow estimation.`,
  harbor: `Harbor cams reward patience. Container ships slide in over twenty minutes, tugs fuss around them, ferries keep schedules you can set a clock by. Port authorities and waterfront hotels run most of these feeds, and ship-spotters pair them with AIS trackers to identify every vessel that passes.`,
  mountain: `Mountain cams exist for two audiences: skiers checking snow before a trip, and everyone else watching clouds pour over a ridge at sunrise. Resorts run most of them, which means they tend to be well-maintained, high up, and pointed at the best view the operator could find. Time-lapse fans get more weather drama per hour here than any other category.`,
  downtown: `Downtown cams are people-watching at scale: crosswalks, shopping streets, plazas framed from a second-story window. They are the fastest way to feel a city's pulse without being there — and the background audio of a busy street is half the appeal. Pedestrian-flow and crowd-density research leans heavily on exactly this kind of fixed street view.`,
  dashcam: `Dashcam footage is the moving-camera counterpart to everything else on this site: forward-facing driving video across weather, traffic cultures and road quality that varies wildly by country. It is the standard raw material for lane-detection and driving-perception work, and as pure viewing it doubles as a road trip you don't have to drive.`,
  wildlife: `Wildlife cams are the category people get attached to. Eagle nests with named chicks, backyard feeders with regulars, waterholes that fill at dusk — operators from conservation groups to hobbyists keep these running for years, and their comment sections become small communities. No other category rewards checking back daily quite like this one.`,
  indoor: `Indoor feeds cover the spaces the other categories miss: shop counters, aquarium tanks, workshops, waiting rooms. Lighting is controlled and the framing is close, which makes them a different technical world from outdoor cams — and a useful one for anyone testing detection models under artificial light.`,
  walk: `Walking tours are the one genre here where the camera moves like a person. Steady first-person footage through markets, old towns and back streets has become its own YouTube profession, and the good ones are shot in 4K with clean audio. If you want the texture of a city — pavement, signage, crowd noise — this is the closest thing to being there.`,
  train: `Rail cams have one of the most devoted audiences on YouTube: level crossings, station platforms and trackside views where the payoff is a scheduled event you can wait for. Railfans keep timetables in the chat, and the long quiet stretches between trains are part of the appeal, not a bug.`,
  river: `River cams are slow television in the best sense — barge traffic, changing water levels, birds working the banks. In flood season they turn practical fast: locals genuinely use these feeds to watch levels rise hour by hour.`,
  plaza: `Public squares concentrate everything a street cam does into one frame: foot traffic, events, pigeons, weather. Because plazas host markets and festivals, the same camera can show a different scene every week — and for crowd-analysis work, few fixed views offer more natural variation.`,
  park: `Park cams sit at the calm end of the spectrum: lawns, paths, dog walkers, seasons changing on the same row of trees. Municipalities run many of them as amenity cameras, which keeps them stable for years — good for watching, and good for anyone who needs a consistent outdoor baseline scene.`,
  alley: `Alley and backstreet cams show the unglamorous side of the urban feed — service lanes, narrow passages, the occasional delivery bike. The framing is tight and the light is tricky, which is precisely why security-camera research cares about this setting more than the postcard views.`,
  construction: `Construction cams are time-lapse machines. Developers mount them to document a build from groundbreaking to topping-out, so the archive matters as much as the live view: scrub back far enough and you can watch a tower assemble itself. Machinery detection and site-safety monitoring are the standard technical uses.`,
  aerial: `Aerial and rooftop views trade detail for scope — whole districts, coastlines or valleys in one frame. They are the establishing shots of the webcam world, and the first place to look when weather is the thing you actually want to watch.`,
  skyline: `Skyline cams are the postcard category: a city's silhouette from a tall building, running through golden hour into night. They are many people's default "leave it on" feed, and the day-night cycle on a good skyline cam is a lighting dataset all by itself.`,
  coast: `Coastal cams cover the dramatic edges beaches leave out — cliffs, lighthouses, breakwaters taking storm swell. The draw is weather as spectacle: the same camera that shows a flat calm sea in summer earns its keep the first time a front rolls through.`,
  resort: `Resort cams are marketing that happens to be genuinely pleasant to watch: pool decks, ski-lift bases, beachfront terraces maintained by hotels that want the view to look good year-round. Reliability is their quiet strength — an operator with a business reason rarely lets the camera go down.`,
  avenue: `Avenue cams frame the long straight view — boulevards, main streets, tree-lined approaches where traffic and pedestrians share the frame. They sit between a traffic cam and a downtown cam: enough vehicles to be useful, enough sidewalk life to be watchable.`,
  airport: `Airport cams serve one of YouTube's great niche audiences: planespotters. Runway views with ATC audio, taxiway pans, holds short of the threshold — regulars identify every type on sight and the chat reads like a logbook. Movement is scheduled, which makes these feeds unusually predictable to test against.`,
  space: `The space category points up instead of out: night-sky cameras, aurora watchers, observatory feeds and launch streams. These cams trade constant motion for rare payoffs — a clear night, a pass, a launch window — and the communities around them treat every one as an event.`,
  space_view: `The space category points up instead of out: night-sky cameras, aurora watchers, observatory feeds and launch streams. Rare payoffs, devoted audiences.`,
};
const COUNTRY_NOTES = {
  JP: `Japan has arguably the densest public-webcam culture in the world. Municipalities, rail operators, hotels and volunteers keep official 24/7 cameras on river levels, level crossings, coastlines and Mt. Fuji from a dozen angles — a legacy of using live cameras for disaster awareness that doubles as some of the most reliable scenery streaming anywhere.`,
  US: `The United States contributes the widest spread of any country here: eagle nests in Pennsylvania, Florida beach cams, city skylines, construction time-lapses and a deep bench of hobbyist operators. If a webcam genre exists, an American channel is probably running one of its best examples.`,
  KR: `South Korea's public feeds skew official — city governments and broadcasters run stable cameras on beaches, ports and historic sites, and the country's excellent network infrastructure shows in stream quality.`,
  ES: `Spain is one of Europe's strongest webcam countries, with city halls and tourism boards streaming plazas, beaches and traffic corridors. Vigo's municipal traffic-camera network alone accounts for a remarkable share of consistently reliable feeds.`,
  IT: `Italian cams lean scenic by default — panoramic operators like Panocam blanket the country's coastlines, piazzas and mountain towns, meaning even the "traffic" cams often come with a postcard backdrop.`,
  DE: `German feeds mix engineering and patience: harbor cams on the Elbe, kestrel nest boxes in Berlin apartment blocks, autobahn views and construction documentation, typically run with the reliability you would expect.`,
  GB: `British cams cluster around wildlife and weather — nest boxes, garden feeders, harbor towns and seafronts where the changing sky is the main event.`,
  NL: `The Netherlands streams its infrastructure: rail projects, canal crossings and port operations, including official project cameras from ProRail documenting station works live.`,
  BR: `Brazilian beach cams are a genre of their own — tourism operators run 24/7 views of Praia Grande, Rio and the Santos coast where the beach itself is the town square.`,
  TH: `Thai feeds capture street life the way few countries do: markets, temples, beach roads and the constant choreography of scooters, often run by resorts and local businesses.`,
  ID: `Indonesian cams are dominated by official city CCTV — Yogyakarta's government network streams intersections around the clock, offering an unusually candid view of Southeast Asian urban traffic.`,
  PH: `Philippine feeds tend to be community-run — barangay halls, basketball courts and neighborhood streets, closer to daily life than tourist framing.`,
  TW: `Taiwan runs polished official cameras on harbors, mountain passes and city intersections, with typhoon season turning coastal cams into essential viewing.`,
  FR: `French cams favor the scenic-municipal blend: harbor towns, ski resorts and city panoramas, generally well-kept and long-running.`,
  CH: `Swiss cams are mountain cams — resorts and cable-car operators stream summits, valleys and rail lines with typically Swiss uptime.`,
  AT: `Austrian feeds center on alpine resorts and valley towns, where the same camera earns its keep in ski season and green season alike.`,
  NO: `Norwegian cams offer the northern specialties: aurora watchers, fjord panoramas and harbor views where daylight itself changes character by month.`,
  GR: `Greek cams point at what you would hope — island harbors, old-town streets and seafronts, largely run by local tourism operators.`,
  PT: `Portuguese feeds concentrate on the Atlantic: surf beaches, river mouths and Lisbon viewpoints where the weather rolls in on camera.`,
  TR: `Turkish cams span two continents' worth of scenes — Istanbul streetscapes, coastal resorts and mountain towns, with a strong municipal presence.`,
  IN: `Indian feeds skew toward temples, ghats and street scenes — some of the most crowded, visually dense public cameras anywhere, which is exactly their appeal.`,
  AU: `Australian cams are beach infrastructure: surf lifesaving clubs and councils stream the coastline so thoroughly that checking the cam before a swim is routine.`,
  CA: `Canadian feeds mix wilderness and weather — harbor towns, mountain resorts and wildlife cameras where winter is the co-star.`,
  MX: `Mexican cams lean resort and plaza — beachfronts, malecóns and town squares run by hotels and municipalities.`,
  CZ: `Czech feeds favor town squares and rail — historic plazas streamed year-round, plus a healthy planespotting and train-watching community.`,
  PL: `Polish cams cover market squares, mountain resorts and the Baltic coast, with municipal operators keeping the core feeds stable.`,
  HR: `Croatian cams are Adriatic cams — harbors, old towns and beaches streamed for a tourism audience that plans trips around them.`,
};

function topCounts(list, keyFn, n) {
  const counts = new Map();
  for (const s of list) { const k = keyFn(s); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// 아래 사실 문단 헬퍼들은 카테고리/국가 페이지와 조합 페이지가 함께 쓴다.
// 임계값을 인자로 받는 이유: 캠이 수백 개인 카테고리 페이지와 5개짜리 조합 페이지는
// "문단을 쓸 만큼 데이터가 있다"의 기준이 달라야 한다.
function resolutionParagraph(list, minMeasured) {
  let measured = 0; const q = { hd2160: 0, hd1440: 0, hd1080: 0, hd720: 0 };
  for (const s of list) if (s.max_quality) { measured++; if (q[s.max_quality] != null) q[s.max_quality]++; }
  if (measured < minMeasured) return '';
  const bits = [];
  if (q.hd2160) bits.push(`${q.hd2160} in 4K`);
  if (q.hd1440) bits.push(`${q.hd1440} in QHD`);
  if (q.hd1080) bits.push(`${q.hd1080} in full HD`);
  if (q.hd720) bits.push(`${q.hd720} in HD`);
  if (!bits.length) return '';
  return `Resolution figures here are measured, not scraped from titles: Camlisted records the real playback quality when a feed is opened. ${measured} of these feeds have been measured so far — ${humanList(bits)}.`;
}

function conditionParagraph(list, placeName, minKinds) {
  const tagCount = new Map();
  for (const s of list) for (const t of (s.tags || [])) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const cond = ['night', 'rain', 'snow', 'fog', 'accident', 'fire'].map(t => [t, tagCount.get(t) || 0]).filter(([, n]) => n > 0);
  if (cond.length < minKinds) return '';
  return `Condition tags mark what a clip actually shows, so you can jump straight to a scenario: currently ${humanList(cond.map(([t, n]) => `${n} ${t} ${n === 1 ? 'scene' : 'scenes'}`))}${placeName ? ` tagged in ${escapeHtml(placeName)}` : ' tagged here'}.`;
}

function longestRunningParagraph(list, minYears) {
  const oldest = list.filter(s => s.content_type === 'live' && s.started_at)
    .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))[0];
  if (!oldest) return '';
  const yr = new Date(oldest.started_at).getFullYear();
  if (new Date().getFullYear() - yr < minYears) return '';
  return `The longest-running live camera in this set has been broadcasting continuously since ${yr} — “${escapeHtml(truncTitle(oldest.title))}”.`;
}

// 실데이터에서 뽑는 사실 문단들 — 같은 문장 틀이라도 수치·채널·태그가 페이지마다 실제로 다르다.
function factsParagraphs(list, placeName = '') {
  const out = [];
  const chans = topCounts(list, s => s.channel_title, 3).filter(([, n]) => n >= 3);
  if (chans.length) {
    out.push(`Much of this collection comes from dedicated operators — ${humanList(chans.map(([name, n]) => `${escapeHtml(name)} (${n} feeds)`))} — channels that keep cameras running year-round rather than posting one-off clips.`);
  }
  for (const p of [
    resolutionParagraph(list, 5),
    conditionParagraph(list, placeName, 2),
    longestRunningParagraph(list, 1),
  ]) if (p) out.push(p);
  return out;
}

// 현지 시간대 -> "밤 장면이 UTC 몇 시에 잡히나". 야간 영상을 찾는 사람에게 실제로 쓰이는 정보이고,
// 국가마다 값이 달라 페이지마다 고유한 문장이 된다.
function nightWindowUtc(code) {
  const tz = COUNTRY_TZ[code];
  if (!tz) return null;
  let offsetMin;
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
    const m = label.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return null;
    offsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch { return null; }
  const utcAt = (localHour) => {
    const mins = ((localHour * 60 - offsetMin) % 1440 + 1440) % 1440;
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  };
  const abs = Math.abs(offsetMin);
  const off = `UTC${offsetMin < 0 ? '−' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { off, from: utcAt(22), to: utcAt(5) };
}

// 조합(국가×카테고리) 페이지 본문.
// 카테고리·국가 소개문(CATEGORY_NOTES/COUNTRY_NOTES)을 여기에 복제하면 수십 개 조합 페이지에
// 똑같은 문단이 반복돼 오히려 중복 콘텐츠가 된다. 그래서 이 조합의 실제 데이터에서만 문장을 만든다.
// 캠이 COMBO_MIN(5)개뿐인 조합에서도 최소 두 문단은 나오게 해서, 앞으로 자동 생성될 새 조합
// 페이지가 알맹이 없는 껍데기로 남지 않게 한다 (애드센스의 '가치 없는 콘텐츠' 반려 사유).
function comboFactsParagraphs(cb, countryTotal) {
  const out = [];
  const n = cb.list.length;
  const lower = cb.label.toLowerCase();
  const place = escapeHtml(cb.name);

  // (1) 운영 주체 구성 — 목록이 비어있지 않은 한 항상 나온다
  const distinct = new Set(cb.list.map(s => s.channel_title).filter(Boolean)).size;
  const top = topCounts(cb.list, s => s.channel_title, 3);
  if (distinct === 1 && top.length) {
    out.push(`All ${n} feeds on this page are run by a single operator, ${escapeHtml(top[0][0])}, pointing several cameras at ${lower} scenes around ${place}. That usually means consistent framing and uptime across the whole set — and that one outage takes all of them down at once.`);
  } else if (distinct >= n) {
    out.push(`No single operator dominates here: all ${n} feeds come from ${distinct} different channels, so camera height, framing and image quality vary noticeably from one to the next.`);
  } else if (top.length) {
    const led = top.filter(([, k]) => k >= 2).map(([nm, k]) => `${escapeHtml(nm)} (${k})`);
    out.push(`These ${n} feeds come from ${distinct} channels${led.length ? `, led by ${humanList(led)}` : ''} — a mix of operators running multiple cameras and one-off contributors, which is why framing varies across the page.`);
  }

  // (2) 그 나라 카탈로그에서 이 카테고리가 차지하는 비중
  if (countryTotal > 0) {
    const pct = Math.round((n / countryTotal) * 100);
    out.push(`${escapeHtml(cb.label)} makes up ${pct > 0 ? `${pct}%` : 'under 1%'} of the ${countryTotal} cameras Camlisted currently tracks in ${place}, so this page is a slice of that catalogue rather than the whole of it.`);
  }

  // (3) 야간 촬영 시간대 (UTC 환산)
  const nw = nightWindowUtc(cb.code);
  if (nw) {
    out.push(`${place} runs on ${nw.off}, so the overnight stretch that yields low-light footage falls roughly between ${nw.from} and ${nw.to} UTC — worth knowing if you are after night scenes rather than daylight.`);
  }

  // (4~6) 캠이 적어도 걸릴 수 있게 임계값을 낮춘 공통 사실 문단
  for (const p of [
    resolutionParagraph(cb.list, 3),
    conditionParagraph(cb.list, cb.name, 1),
    longestRunningParagraph(cb.list, 1),
  ]) if (p) out.push(p);

  return out;
}

// 운영자(채널) 페이지 본문. 한 채널이 카메라를 어디에 몇 대 두고 무엇을 찍는지는
// 채널마다 완전히 다르므로, 여기서 나오는 문장은 자연히 페이지마다 고유하다.
function channelFactsParagraphs(chn, countryNameOf, catLabelByKey, singleCountryPct) {
  const out = [];
  const list = chn.list;
  const n = list.length;
  const name = escapeHtml(chn.title);
  const liveCount = list.filter(s => s.content_type === 'live').length;

  // (1) 어느 나라에 몇 대를 두고 있나
  // 여러 나라에 걸친 게 드물다는 비교는 하드코딩하지 않고 그때그때 실제 비율로 말한다
  // (카탈로그가 커지면 이 비율도 같이 변해야 문장이 계속 사실이다)
  const countries = topCounts(list, s => s.country, 4);
  if (countries.length === 1) {
    out.push(`${name} runs all ${n} of its cameras in ${escapeHtml(countryNameOf(countries[0][0]))}, so this page doubles as a local view of that one country rather than a world tour.`);
  } else if (countries.length > 1) {
    const spread = countries.map(([c, k]) => `${escapeHtml(countryNameOf(c))} (${k})`);
    const total = new Set(list.map(s => s.country).filter(Boolean)).size;
    out.push(`${name} spreads its cameras across ${total} countries — mostly ${humanList(spread)}. That puts it in the minority here: ${singleCountryPct}% of the operators Camlisted indexes keep every camera inside a single country.`);
  }

  // (2) 무엇을 찍나
  const cats = topCounts(list, s => s.category, 3).filter(([k]) => k);
  if (cats.length) {
    const labels = cats.map(([k, c]) => `${escapeHtml(catLabelByKey.get(k) || k).toLowerCase()} (${c})`);
    out.push(`By subject the set leans towards ${humanList(labels)}${cats.length === 1 ? ' — a single-theme operator' : ''}. Camlisted files each camera by what it actually shows, and signed-in visitors can correct that classification when it looks wrong.`);
  }

  // (3) 라이브 비중 — 이 사이트에서 운영자를 판단하는 실질 기준
  if (liveCount === n) {
    out.push(`Every one of these ${n} entries is a continuously running live stream rather than a recorded upload, which is the pattern of an operator maintaining fixed cameras rather than posting clips.`);
  } else if (liveCount === 0) {
    out.push(`All ${n} entries are recorded uploads rather than live streams, so this is an archive to scrub through rather than something to watch in real time.`);
  } else {
    out.push(`${liveCount} of the ${n} entries are live right now and ${n - liveCount} are recorded, so the channel mixes standing cameras with clips it has kept.`);
  }

  for (const p of [
    resolutionParagraph(list, 3),
    longestRunningParagraph(list, 1),
  ]) if (p) out.push(p);

  return out;
}

function faqBlock(qas) {
  const html = `<h2>Frequently asked questions</h2>` +
    qas.map(([q, a]) => `<h3>${escapeHtml(q)}</h3><p>${a}</p>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: qas.map(([q, a]) => ({
      '@type': 'Question', name: q,
      acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') },
    })),
  };
  return { html, jsonLd };
}

function outroSection(heading, paras, faqHtml = '') {
  const body = paras.filter(Boolean).map(p => `<p>${p}</p>`).join('');
  if (!body && !faqHtml) return '';
  return `<section class="seo-outro">${heading ? `<h2>${escapeHtml(heading)}</h2>` : ''}${body}${faqHtml}</section>\n`;
}

// 공유 미리보기 이미지: 페이지 첫 캠의 유튜브 썸네일 (자산 없이 실제 캠 미리보기가 뜸)
function ogImageOf(entries) {
  const first = entries.find(s => s.video_id);
  return first ? `https://i.ytimg.com/vi/${first.video_id}/hqdefault.jpg` : '';
}
// 페이지 구조화 데이터: CollectionPage + BreadcrumbList (JSON-LD 배열)
function collectionJsonLd({ name, url, description, crumbs, extra }) {
  const blocks = [{
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name, url: SITE + url, description,
    isPartOf: { '@type': 'WebSite', name: 'Camlisted', url: SITE + '/' },
  }];
  if (crumbs?.length) {
    blocks.push({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: SITE + c.path })),
    });
  }
  for (const b of extra || []) blocks.push(b);
  return JSON.stringify(blocks);
}

// 홈 전용 정적 색인 블록의 자리. 매 실행마다 이 구간을 통째로 갈아끼우므로 반복 생성해도 누적되지 않는다.
const HOME_STATIC_RE = /<!--HOME_STATIC_START-->[\s\S]*?<!--HOME_STATIC_END-->/;

function appPage(indexTemplate, { title, description, canonicalPath, h1, presetScript, staticGrid, intro = '', outro = '', ogImage = '', jsonLd = '' }) {
  let html = indexTemplate;
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${SITE}${canonicalPath}$2`);
  html = html.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(title)}$2`);
  html = html.replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  html = html.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${SITE}${canonicalPath}$2`);
  if (ogImage) {
    html = html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${escapeHtml(ogImage)}$2`);
    html = html.replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${escapeHtml(ogImage)}$2`);
    html = html.replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escapeHtml(title)}$2`);
    html = html.replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escapeHtml(description)}$2`);
  }
  // 페이지별 구조화 데이터(JSON-LD)를 </head> 앞에 추가 (홈의 WebSite 스키마와 별개)
  if (jsonLd) html = html.replace('</head>', `<script type="application/ld+json">${jsonLd}</script>\n</head>`);
  // 하위 폴더에서도 css/js 상대경로가 동작하도록 (반드시 다른 URL보다 먼저 선언되어야 함)
  html = html.replace('<head>', '<head>\n<base href="/">');
  // h1을 페이지 주제로 교체 (data-i18n을 떼서 언어 전환 시 일반 제목으로 덮어쓰이지 않게)
  html = html.replace(/<h1[^>]*><a href="\.\/" class="site-title-link" data-i18n="site_h1">[^<]*<\/a><\/h1>/,
    `<h1><a href="./" class="site-title-link">${escapeHtml(h1)}</a></h1>`);
  html = html.replace('<main id="grid" class="grid">', `${intro}<main id="grid" class="grid">${staticGrid}`);
  // 에디토리얼 본문은 그리드 아래에 둔다 — 방문자에겐 목록이 먼저, 크롤러에겐 원본 산문이 같은 문서에
  if (outro) html = html.replace('</main>', `</main>\n${outro}`);
  html = html.replace(HOME_STATIC_RE, ''); // 홈 전용 정적 색인 블록 — 국가/카테고리 페이지엔 자체 staticGrid가 있으므로 제외
  // app.js 앞에 프리셋 필터를 심는다. 캐시버스팅(?v=...)이 붙어도 매칭되도록 정규식을 쓴다 —
  // 예전엔 문자열 그대로 찾다가 index.html에 ?v=가 붙은 뒤로 8일간 조용히 실패했고, 그동안
  // 모든 카테고리·국가 페이지가 필터 없이 전체 목록을 그렸다. 못 찾으면 이제 즉시 실패시킨다.
  const appScriptRe = /<script src="js\/app\.js[^"]*"><\/script>/;
  if (!appScriptRe.test(html)) {
    throw new Error('index.html에서 app.js 스크립트 태그를 찾지 못했습니다 — 프리셋 주입 위치가 바뀌었는지 확인하세요');
  }
  html = html.replace(appScriptRe, (tag) => `<script>${presetScript}</script>\n${tag}`);
  return html;
}


// 국가 코드 -> 대략적 중심좌표 (지구본 포인트용)
const COUNTRY_CENTROIDS = {
  US: [39.8, -98.6], CA: [56.1, -106.3], MX: [23.6, -102.5], BR: [-14.2, -51.9], AR: [-38.4, -63.6],
  CL: [-35.7, -71.5], PE: [-9.2, -75.0], CO: [4.6, -74.3], CR: [9.7, -83.8], CU: [21.5, -77.8],
  GB: [54.0, -2.0], IE: [53.4, -8.2], FR: [46.2, 2.2], DE: [51.2, 10.4], NL: [52.1, 5.3],
  BE: [50.5, 4.5], CH: [46.8, 8.2], AT: [47.5, 14.6], IT: [41.9, 12.6], ES: [40.5, -3.7],
  PT: [39.4, -8.2], GR: [39.1, 21.8], TR: [39.0, 35.2], RU: [61.5, 105.3], UA: [48.4, 31.2],
  PL: [51.9, 19.1], CZ: [49.8, 15.5], HU: [47.2, 19.5], RO: [45.9, 24.9], BG: [42.7, 25.5],
  HR: [45.1, 15.2], RS: [44.0, 21.0], NO: [60.5, 8.5], SE: [60.1, 18.6], FI: [61.9, 25.7],
  DK: [56.3, 9.5], IS: [64.9, -19.0], IN: [20.6, 79.0], PK: [30.4, 69.3], BD: [23.7, 90.4],
  LK: [7.9, 80.8], NP: [28.4, 84.1], CN: [35.9, 104.2], TW: [23.7, 121.0], HK: [22.3, 114.2],
  JP: [36.2, 138.3], KR: [36.5, 127.9], TH: [15.9, 100.9], VN: [14.1, 108.3], PH: [12.9, 121.8],
  ID: [-0.8, 113.9], MY: [4.2, 101.9], SG: [1.35, 103.8], KH: [12.6, 105.0], LA: [19.9, 102.5],
  MM: [21.9, 95.9], AU: [-25.3, 133.8], NZ: [-40.9, 174.9], AE: [23.4, 53.8], SA: [23.9, 45.1],
  IL: [31.0, 34.9], EG: [26.8, 30.8], MA: [31.8, -7.1], KE: [-0.02, 37.9], ZA: [-30.6, 22.9],
  NA: [-22.9, 18.5], MO: [22.2, 113.5], MT: [35.9, 14.4], LU: [49.8, 6.1], EE: [58.6, 25.0],
  LV: [56.9, 24.6], LT: [55.2, 23.9], SK: [48.7, 19.7], SI: [46.2, 15.0],
};

// 국가별 대표(수도) IANA 시간대 — 현지 시각 표시용 (브라우저 Intl이 서머타임까지 처리)
const COUNTRY_TZ = {
  US: 'America/New_York', CA: 'America/Toronto', MX: 'America/Mexico_City', BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires', CL: 'America/Santiago', PE: 'America/Lima', CO: 'America/Bogota',
  CR: 'America/Costa_Rica', CU: 'America/Havana', GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris',
  DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna',
  IT: 'Europe/Rome', ES: 'Europe/Madrid', PT: 'Europe/Lisbon', GR: 'Europe/Athens', TR: 'Europe/Istanbul',
  RU: 'Europe/Moscow', UA: 'Europe/Kyiv', PL: 'Europe/Warsaw', CZ: 'Europe/Prague', HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest', BG: 'Europe/Sofia', HR: 'Europe/Zagreb', RS: 'Europe/Belgrade', NO: 'Europe/Oslo',
  SE: 'Europe/Stockholm', FI: 'Europe/Helsinki', DK: 'Europe/Copenhagen', IS: 'Atlantic/Reykjavik',
  IN: 'Asia/Kolkata', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', LK: 'Asia/Colombo', NP: 'Asia/Kathmandu',
  CN: 'Asia/Shanghai', TW: 'Asia/Taipei', HK: 'Asia/Hong_Kong', JP: 'Asia/Tokyo', KR: 'Asia/Seoul',
  TH: 'Asia/Bangkok', VN: 'Asia/Ho_Chi_Minh', PH: 'Asia/Manila', ID: 'Asia/Jakarta', MY: 'Asia/Kuala_Lumpur',
  SG: 'Asia/Singapore', KH: 'Asia/Phnom_Penh', LA: 'Asia/Vientiane', MM: 'Asia/Yangon', AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland', AE: 'Asia/Dubai', SA: 'Asia/Riyadh', IL: 'Asia/Jerusalem', EG: 'Africa/Cairo',
  MA: 'Africa/Casablanca', KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg', NA: 'Africa/Windhoek',
  MO: 'Asia/Macau', MT: 'Europe/Malta', LU: 'Europe/Luxembourg', EE: 'Europe/Tallinn', LV: 'Europe/Riga',
  LT: 'Europe/Vilnius', SK: 'Europe/Bratislava', SI: 'Europe/Ljubljana',
};
// 공식 시간대가 여러 개인 나라 (수도 기준 시각 옆에 "~" 표시로 지역마다 다름을 알림)
const MULTI_TZ_CODES = ['US', 'CA', 'MX', 'BR', 'RU', 'ID', 'AU'];

// 3D 지구본 페이지: 나라 포인트를 클릭하면 그 나라의 라이브 캠이 옆 패널에서 바로 재생된다.
// three.js + globe.gl(MIT, CDN)을 사용하는 별도 페이지 — 앱 본체와 독립적.
async function writeGlobePage(countByCode, slugByCode, visible, today, CAT_META_JSON) {
  const globeCountries = [];
  const vidsByCode = {};
  for (const [code, c] of countByCode) {
    const cen = COUNTRY_CENTROIDS[code];
    if (!cen) continue;
    const total = c.live + c.video;
    if (!total) continue;
    globeCountries.push({
      code, name: countryNameOf(code), lat: cen[0], lng: cen[1],
      live: c.live, video: c.video,
      href: slugByCode.has(code) ? `/country/${slugByCode.get(code)}.html` : `/?country=${code}`,
    });
    // 나라별 재생 후보: 라이브 우선 최대 30개 (id, 제목, 라이브 여부)
    const list = visible.filter(s => s.country === code);
    const lives = list.filter(s => s.content_type === 'live');
    const nonLives = list.filter(s => s.content_type !== 'live');
    const pick = lives.slice(0, 25).concat(nonLives.slice(0, 15)); // 라이브 25 + 일반영상 15 (한쪽이 정원을 다 차지하지 않게)
    vidsByCode[code] = pick.map(s => [s.video_id, s.title.slice(0, 70), s.content_type === 'live' ? 1 : 0, s.category || '', (s.tags || []).join(','), s.channel_title || '', s.max_quality || '', s.duration_seconds || 0, s.upvote_count || 0, s.downvote_count || 0]);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3D Globe – Camlisted Live Cams Around the World</title>
<meta name="description" content="Spin the globe and drop into live cams around the world — ${visible.length}+ YouTube live cams and videos, updated daily.">
<link rel="canonical" href="${SITE}/globe.html">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: #000; color: #e6e6e6; font-family: system-ui, sans-serif; overflow: hidden; }
  #globe { position: absolute; inset: 0; }
  .topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: linear-gradient(rgba(0,0,0,.8), transparent); flex-wrap: wrap; }
  .topbar a.back { color: #9aa4b2; text-decoration: none; font-size: 0.9rem; }
  .topbar a.back:hover { color: #fff; }
  .topbar h1 { font-size: 1rem; font-weight: 600; color: #fff; }
  .topbar .hint { color: #9aa4b2; font-size: 0.8rem; }
  .random-btn { margin-left: auto; background: #ff3b3b; color: #fff; border: 0; border-radius: 999px; padding: 8px 16px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  .panel { position: fixed; right: 0; top: 0; bottom: 0; width: min(500px, 100%); z-index: 6; background: rgba(13,17,23,.96); border-left: 1px solid #2a2f3a; padding: 16px; display: none; flex-direction: column; gap: 10px; }
  .panel-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 5; }
  .panel-resize:hover { background: #ff3b3b; opacity: 0.5; }
  .panel.open { display: flex; }
  .panel .close { position: absolute; top: 10px; right: 12px; background: none; border: 0; color: #9aa4b2; font-size: 1.4rem; cursor: pointer; }
  .panel h2 { font-size: 1.1rem; color: #fff; padding-right: 30px; }
  .panel .sub { color: #9aa4b2; font-size: 0.85rem; }
  .panel .player { aspect-ratio: 16/9; background: #000; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .panel .player iframe { width: 100%; height: 100%; border: 0; }
  .panel ul { list-style: none; overflow-y: auto; flex: 1; }
  .panel li { margin-bottom: 6px; }
  .panel li button { display: flex; gap: 8px; align-items: flex-start; width: 100%; background: none; border: 0; color: #cdd6e0; text-align: left; cursor: pointer; font-size: 0.82rem; padding: 4px; border-radius: 6px; }
  .panel li button img { width: 96px; aspect-ratio: 16/9; object-fit: cover; border-radius: 4px; flex-shrink: 0; background: #000; }
  .panel li button .meta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .panel li button:hover { background: #1d232c; color: #fff; }
  .panel li.active button { background: #241417; color: #fff; outline: 1px solid #ff3b3b; }
  .panel li .lv { color: #ff3b3b; font-weight: 700; font-size: 0.7rem; margin-right: 6px; }
  .panel a.browse-all { color: #ff3b3b; text-decoration: none; font-size: 0.9rem; }
  .cam-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .cam-meta:empty { display: none; }
  .cam-info { flex-basis: 100%; color: #9aa4b2; font-size: 0.78rem; }
  .cam-badge { background: #161b22; border: 1px solid #2a2f3a; border-radius: 999px; padding: 2px 9px; font-size: 0.75rem; color: #9aa4b2; }
  .cam-edit { margin-left: auto; color: #ff3b3b; text-decoration: none; font-size: 0.8rem; }
  .cam-cat-edit, .cam-country-edit { background: #161b22; border: 1px solid #2a2f3a; border-radius: 999px; color: #e6e6e6; font-size: 0.75rem; padding: 3px 8px; cursor: pointer; max-width: 45%; }
  .cam-cond { background: #161b22; border: 1px solid #2a2f3a; border-radius: 999px; color: #9aa4b2; font-size: 0.72rem; padding: 2px 8px; cursor: pointer; }
  .cam-cond.on { color: #ff3b3b; border-color: #ff3b3b; }
  .cam-cat-edit.saved, .cam-country-edit.saved { border-color: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.3); }
  .panel-filter { display: flex; gap: 8px; }
  .panel-filter button { background: #161b22; color: #9aa4b2; border: 1px solid #2a2f3a; border-radius: 999px; padding: 3px 10px; font-size: 0.75rem; cursor: pointer; }
  .panel-filter button.active { color: #fff; border-color: #ff3b3b; }
  @media (max-width: 640px) {
    .panel { top: auto; bottom: 0; height: 85%; width: 100% !important; border-left: 0; border-top: 1px solid #2a2f3a; }
    .panel .player { max-height: 34vh; }
    .panel-resize { display: none; }
  }
</style>
</head>
<body>
<div class="topbar">
  <a class="back" href="/browse.html">← Map</a>
  <h1>🌐 Camlisted Globe</h1>
  <span class="hint">Drag to spin · click a point to watch</span>
  <button type="button" class="random-btn" id="randomBtn">🎲 Random cam</button>
</div>
<div id="globe"></div>
<aside class="panel" id="panel">
  <div class="panel-resize" id="panelResize"></div>
  <button type="button" class="close" id="panelClose">×</button>
  <h2 id="panelTitle"></h2>
  <div class="sub" id="panelSub"></div>
  <div class="player" id="player"></div>
  <div class="cam-meta" id="panelCamMeta"></div>
  <div class="panel-filter" id="panelFilter">
    <button type="button" data-f="all" class="active">All</button>
    <button type="button" data-f="live">🔴 Live</button>
    <button type="button" data-f="video">🎬 Videos</button>
  </div>
  <ul id="camList"></ul>
  <a class="browse-all" id="browseAll" href="#">Browse all →</a>
</aside>
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"><\/script>
<script src="https://unpkg.com/globe.gl@2.32.0/dist/globe.gl.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"><\/script>
<script>
  // browse.html 안에 iframe으로 임베드될 때는 상단의 뒤로가기/제목을 숨긴다
  if (new URLSearchParams(location.search).has('embed')) {
    document.querySelector('.topbar .back').style.display = 'none';
    document.querySelector('.topbar h1').style.display = 'none';
  }
  var COUNTRIES = ${JSON.stringify(globeCountries)};
  var VIDS = ${JSON.stringify(vidsByCode)};
  var CATM = ${CAT_META_JSON};
  var CONDLABEL = { night: '🌙 Night', day: '☀️ Day', rain: '🌧 Rain', heavy_rain: '⛈ Heavy rain', snow: '❄️ Snow', heavy_snow: '🌨 Heavy snow', accident: '💥 Accident', fire: '🔥 Fire', violence: '🥊 Violence', fog: '🌫 Fog' };
  var UILANG = localStorage.getItem('lang') || 'en';
  var EDITLABEL = ({ en: 'Edit on site', ko: '사이트에서 수정', ja: 'サイトで編集', zh: '在网站编辑', es: 'Editar en el sitio' })[UILANG] || 'Edit on site';
  var QLABEL = { hd2160: '4K', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
  function fmtDur(s) { s = Number(s); if (!s) return ''; var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0') : m + ':' + String(x).padStart(2, '0'); }
  var CC = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
  function countryOpts(cur) {
    var dn; try { dn = new Intl.DisplayNames([UILANG], { type: 'region' }); } catch (e) {}
    var arr = CC.map(function (c) { return [c, dn ? (dn.of(c) || c) : c]; }).sort(function (a, b) { return a[1].localeCompare(b[1]); });
    var html = '<option value="">\\ud83c\\udf0d ?</option><option value="XX"' + (cur === 'XX' ? ' selected' : '') + '>International/Mixed</option>';
    arr.forEach(function (x) { html += '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + x[1] + '</option>'; });
    return html;
  }
  window.__vidById = {}; window.__editHref = '/'; window.__panelCode = '';
  function renderCamMeta(id) {
    var meta = document.getElementById('panelCamMeta');
    if (!meta) return;
    var v = window.__vidById[id];
    if (!v) { meta.innerHTML = ''; return; }
    var html = '';
    var info = [];
    if (v[5]) info.push(String(v[5]).replace(/</g, '&lt;'));      // 채널
    if (v[6] && QLABEL[v[6]]) info.push(QLABEL[v[6]]);            // 화질
    if (v[7]) info.push(fmtDur(v[7]));                            // 길이
    info.push('\\ud83d\\udc4d ' + (v[8] || 0) + ' \\ud83d\\udc4e ' + (v[9] || 0)); // 추천/비추천
    html += '<div class="cam-info">' + info.join(' \\u00b7 ') + '</div>';
    var cat = v[3];
    var tags = (v[4] || '').split(',').filter(Boolean);
    if (window.__me) {
      // 로그인 시: 카테고리 select + (일반영상) 조건 토글 칩 — 메인 카드와 동일하게 바로 수정
      var opts = Object.keys(CATM).map(function (k) {
        return '<option value="' + k + '"' + (k === cat ? ' selected' : '') + '>' + (CATM[k].icon ? CATM[k].icon + ' ' : '') + (CATM[k][UILANG] || CATM[k].en || k) + '</option>';
      }).join('');
      html += '<select class="cam-country-edit">' + countryOpts(window.__panelCode) + '</select>';
      html += '<select class="cam-cat-edit">' + opts + '</select>';
      if (v[2] === 0) {
        html += Object.keys(CONDLABEL).map(function (t) {
          return '<button type="button" class="cam-cond' + (tags.indexOf(t) >= 0 ? ' on' : '') + '" data-t="' + t + '">' + CONDLABEL[t] + '</button>';
        }).join('');
      }
      meta.innerHTML = html;
      function flash(el) { el.classList.add('saved'); setTimeout(function () { el.classList.remove('saved'); }, 1000); }
      meta.querySelector('.cam-cat-edit').addEventListener('change', function () {
        var el = this, val = el.value;
        window.__sbc.rpc('set_stream_category', { p_video_id: id, p_category: val }).then(function (r) {
          if (r.error) { alert(r.error.message); } else { v[3] = val; flash(el); }
        });
      });
      meta.querySelector('.cam-country-edit').addEventListener('change', function () {
        var el = this;
        window.__sbc.rpc('set_stream_country', { p_video_id: id, p_country: el.value || null }).then(function (r) {
          if (r.error) { alert(r.error.message); } else { flash(el); }
        });
      });
      [].forEach.call(meta.querySelectorAll('.cam-cond'), function (btn) {
        btn.addEventListener('click', function () {
          var t = btn.dataset.t, i = tags.indexOf(t);
          if (i >= 0) tags.splice(i, 1); else tags.push(t);
          btn.classList.toggle('on');
          window.__sbc.rpc('set_stream_tags', { p_video_id: id, p_tags: tags.slice() }).then(function (r) {
            if (r.error) { alert(r.error.message); btn.classList.toggle('on'); if (i >= 0) tags.push(t); else tags.splice(tags.indexOf(t), 1); }
            else { v[4] = tags.join(','); }
          });
        });
      });
    } else {
      if (cat && CATM[cat]) html += '<span class="cam-badge">' + (CATM[cat].icon ? CATM[cat].icon + ' ' : '') + String(CATM[cat][UILANG] || CATM[cat].en || cat).replace(/</g, '&lt;') + '</span>';
      tags.forEach(function (t) { html += '<span class="cam-badge cond">' + (CONDLABEL[t] || t) + '</span>'; });
      html += '<a class="cam-edit" href="' + window.__editHref + '">\\u270f\\ufe0f ' + EDITLABEL + '</a>';
      meta.innerHTML = html;
    }
  }
  window.__sbc = window.supabase.createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY}');
  window.__me = null;
  window.__sbc.auth.getSession().then(function (r) {
    window.__me = r.data.session ? r.data.session.user : null;
    if (window.__playingId) renderCamMeta(window.__playingId);
  });
  var maxTotal = Math.max.apply(null, COUNTRIES.map(function (c) { return c.live + c.video; }));
  var selectedCode = null;

  var globe = Globe()(document.getElementById('globe'))
    .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
    .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
    .pointsData(COUNTRIES)
    .pointLat('lat').pointLng('lng')
    .pointColor(function (d) { return d.code === selectedCode ? '#ffd21f' : '#ff3b3b'; })
    .pointAltitude(function (d) { return 0.01 + 0.1 * Math.sqrt((d.live + d.video) / maxTotal); })
    .pointRadius(function (d) { return 0.4 + 1.1 * Math.sqrt((d.live + d.video) / maxTotal); })
    .pointLabel(function (d) { return d.name + ' — Live: ' + d.live + ' · Videos: ' + d.video; })
    .onPointClick(function (d) { openPanel(d); });
  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.6;
  globe.pointOfView({ lat: 20, lng: 10, altitude: 2.5 }); // 지구본 전체가 프레임 안에 들어오게 넉넉히

  var panel = document.getElementById('panel');
  function openPanel(d, autoplayRandom) {
    selectedCode = d.code;
    globe.pointsData(COUNTRIES); // 선택 핀 색상 갱신
    globe.controls().autoRotate = false; // 보는 동안 회전 멈춤 (패널 닫으면 재개)
    panel.classList.add('open');
    document.getElementById('panelTitle').textContent = d.name;
    document.getElementById('panelSub').textContent = 'Live: ' + d.live + ' · Videos: ' + d.video;
    document.getElementById('browseAll').href = d.href;
    var vids = VIDS[d.code] || [];
    window.__editHref = d.href;
    window.__panelCode = d.code;
    window.__vidById = {};
    vids.forEach(function (v) { window.__vidById[v[0]] = v; });
    var list = document.getElementById('camList');
    list.innerHTML = '';
    function markActive(li) {
      [].forEach.call(list.querySelectorAll('li.active'), function (x) { x.classList.remove('active'); });
      if (li) li.classList.add('active');
    }
    vids.forEach(function (v) {
      var li = document.createElement('li');
      li.dataset.live = v[2];
      var b = document.createElement('button');
      b.innerHTML = '<img src="https://i.ytimg.com/vi/' + v[0] + '/mqdefault.jpg" loading="lazy" alt="">'
        + '<span class="meta">' + (v[2] ? '<span class="lv">LIVE</span>' : '') + v[1].replace(/</g, '&lt;') + '</span>';
      b.addEventListener('click', function () { markActive(li); play(v[0]); });
      li.appendChild(b);
      list.appendChild(li);
    });
    var pf = document.getElementById('panelFilter');
    [].forEach.call(pf.querySelectorAll('button'), function (x) { x.classList.toggle('active', x.dataset.f === 'all'); });
    if (vids.length) {
      var idx = autoplayRandom ? Math.floor(Math.random() * vids.length) : 0;
      markActive(list.children[idx]);
      play(vids[idx][0]);
    } else {
      document.getElementById('player').innerHTML = '';
    }
    // 줌인하지 않고 회전만 한다 (줌인하면 임베드 프레임 높이에 따라 구가 잘림).
    // 유저가 직접 줌아웃해뒀다면 그 레벨을 존중하고, 최소 2.3은 보장.
    var alt = Math.max(globe.pointOfView().altitude, 2.3);
    globe.pointOfView({ lat: d.lat, lng: d.lng, altitude: alt }, 900);
  }
  function play(id) {
    window.__playingId = id;
    document.getElementById('player').innerHTML =
      '<iframe src="https://www.youtube.com/embed/' + id + '?autoplay=1&mute=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
    renderCamMeta(id);
  }
  document.getElementById('panelClose').addEventListener('click', function () {
    panel.classList.remove('open');
    document.getElementById('player').innerHTML = '';
    selectedCode = null;
    globe.pointsData(COUNTRIES);
    globe.controls().autoRotate = true; // 회전 재개
  });
  document.getElementById('randomBtn').addEventListener('click', function () {
    var pool = [];
    COUNTRIES.forEach(function (c) { for (var i = 0; i < c.live + c.video; i++) pool.push(c); });
    openPanel(pool[Math.floor(Math.random() * pool.length)], true);
  });
  document.getElementById('panelFilter').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
    var f = b.dataset.f;
    [].forEach.call(document.getElementById('camList').children, function (li) {
      li.style.display = (f === 'all' || (f === 'live') === (li.dataset.live === '1')) ? '' : 'none';
    });
  });
  (function () {
    // 패널 좌우 폭 드래그로 조정 (기기별 저장) — 데스크톱만
    var panel = document.getElementById('panel');
    var handle = document.getElementById('panelResize');
    var saved = localStorage.getItem('panelWidth');
    if (saved && window.innerWidth > 900) panel.style.width = saved + 'px';
    var dragging = false;
    handle.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.width = Math.max(320, Math.min(window.innerWidth - e.clientX, window.innerWidth - 80)) + 'px';
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      localStorage.setItem('panelWidth', parseInt(panel.style.width, 10));
    });
  })();
<\/script>
</body>
</html>
`;
  await writeFile(path.join(ROOT, 'globe.html'), html);
  console.log(`globe.html 생성 (국가 ${globeCountries.length}개)`);
}

// 프런트엔드(js/app.js mapRow)가 카드에 실제로 쓰는 컬럼만. `select('*')`로 29개를 다 받으면
// 행마다 컬럼 이름이 통째로 반복돼 페이로드가 배로 커진다.
const STREAM_COLUMNS = [
  'video_id', 'title', 'channel_title', 'channel_id', 'thumbnail', 'matched_keyword',
  'added_at', 'source', 'added_by', 'upvote_count', 'downvote_count', 'visibility',
  'status', 'country', 'category', 'max_quality', 'started_at', 'content_type',
  'published_at', 'approval_status', 'offline_since', 'duration_seconds', 'tags', 'embeddable',
].join(',');

// 목록 전체를 정적 스냅샷으로 떨어뜨린다. 방문자는 이 파일을 CDN에서 받으므로
// 평상시 Supabase 조회가 0건이 되고, HN/레딧발 트래픽 급증에도 DB가 영향을 받지 않는다.
// 낮 동안 바뀌는 값(투표수, 신규 제보)은 app.js가 작은 델타 쿼리로 따로 덧씌운다.
async function writeStreamSnapshot(streams) {
  // 카드에 같이 뜨는 댓글 수·제보자 닉네임도 함께 굽는다. 이 둘 때문에 방문자마다
  // comments 전체(1000행 페이징)와 profiles를 또 조회하고 있었다.
  const commentCounts = {};
  for (const row of await fetchAllRows('comments', 'video_id')) {
    commentCounts[row.video_id] = (commentCounts[row.video_id] || 0) + 1;
  }
  const submitterIds = [...new Set(streams.filter(s => s.source === 'user' && s.added_by).map(s => s.added_by))];
  const submitterNames = {};
  if (submitterIds.length) {
    const { data } = await supabase.from('profiles').select('id,display_name').in('id', submitterIds);
    for (const row of data || []) submitterNames[row.id] = row.display_name;
  }

  const snapshot = {
    // 1단계 때 쓰던 같은 이름의 파일이 camelCase 스키마였다. app.js가 그걸 잘못 집어
    // 빈 카드를 그리는 일이 없도록 포맷을 명시하고 프런트에서 검사한다.
    format: 'streams-v2',
    generatedAt: new Date().toISOString(),
    count: streams.length,
    commentCounts,
    submitterNames,
    streams,
  };
  const file = path.join(ROOT, 'data', 'streams.json');
  await mkdir(path.dirname(file), { recursive: true }); // 저장소에 data/가 비어 있으면 git이 폴더를 안 남긴다
  await writeFile(file, JSON.stringify(snapshot));
  const kb = Math.round((await readFile(file)).length / 1024);
  console.log(`data/streams.json 생성 (${streams.length}건, ${kb}KB)`);
}

function sortForPage(list) {
  // 라이브 먼저, 그 안에서는 추천 많은 순 → 최신 순
  return [...list].sort((a, b) =>
    (a.content_type === 'live' ? 0 : 1) - (b.content_type === 'live' ? 0 : 1)
    || (b.upvote_count || 0) - (a.upvote_count || 0)
    || String(b.added_at || '').localeCompare(String(a.added_at || ''))
  );
}

async function main() {
  const [streams, categoriesRes, indexTemplate] = await Promise.all([
    fetchAllRows('streams', STREAM_COLUMNS),
    supabase.from('categories').select('key,label_en,label_ko,label_ja,label_zh,label_es,icon,sort_order').order('sort_order'),
    readFile(path.join(ROOT, 'index.html'), 'utf-8'),
  ]);
  // 패널에서 클릭한 영상의 카테고리·조건을 보여주기 위한 참조 데이터
  const catMeta = {};
  for (const c of (categoriesRes.data || [])) {
    catMeta[c.key] = { icon: c.icon || '', en: c.label_en, ko: c.label_ko, ja: c.label_ja, zh: c.label_zh, es: c.label_es };
  }
  const CAT_META_JSON = JSON.stringify(catMeta);
  if (categoriesRes.error) throw categoriesRes.error;
  const categories = categoriesRes.data || [];
  // visibility='hidden'은 여기서도 빼야 한다. 예전엔 승인 여부만 봤는데, 그러면 관리자가 내린
  // 영상이 앱 화면에서만 사라지고 정적 그리드·streams.json에는 그대로 남았다. 크롤러와 애드센스가
  // 읽는 건 그 정적 HTML이라, "숨김"이 정작 숨겨야 할 상대에게는 통하지 않았다.
  const visible = streams.filter(s =>
    s.approval_status !== 'pending' && s.title &&
    (s.visibility == null || s.visibility === 'listed')
  );
  // 인트로에 쓸 "메인 노출 수" = 메인 페이지 카운트와 같은 기준 (라이브 + 공개 + 승인). 오프라인은 뺀다.
  const mainVisibleCount = streams.filter(s =>
    s.approval_status !== 'pending' && s.title && s.status === 'live' &&
    (s.visibility == null || s.visibility === 'listed')
  ).length;
  const today = new Date().toISOString().slice(0, 10);
  console.log(`전체 ${streams.length}건 중 공개 ${visible.length}건으로 페이지 생성`);
  await writeStreamSnapshot(streams);

  // 홈페이지 공유 미리보기(og:image/twitter:image)를 현재 최상위 라이브 캠 썸네일로 갱신 →
  // 링크를 공유할 때 실제 캠 미리보기가 뜨고, 매일 신선한 유효 이미지로 유지된다.
  // (실제 index.html 기록은 국가/카테고리 집계가 끝난 뒤, 정적 색인 블록과 함께 아래에서 한 번에 수행)
  const homeTop = visible.filter(s => s.content_type === 'live')
    .sort((a, b) => (b.upvote_count || 0) - (a.upvote_count || 0))[0] || visible[0];

  await mkdir(path.join(ROOT, 'country'), { recursive: true });
  await mkdir(path.join(ROOT, 'c'), { recursive: true });

  const sitemapUrls = [
    { loc: `${SITE}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${SITE}/browse.html`, priority: '0.8', changefreq: 'daily' },
    { loc: `${SITE}/about.html`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${SITE}/feedback.html`, priority: '0.5', changefreq: 'weekly' },
    { loc: `${SITE}/cheers.html`, priority: '0.4', changefreq: 'weekly' },
    { loc: `${SITE}/privacy.html`, priority: '0.3', changefreq: 'yearly' },
    { loc: `${SITE}/terms.html`, priority: '0.3', changefreq: 'yearly' },
  ];

  // 카테고리 라벨/아이콘 조회용
  const catLabelByKey = new Map(categories.map(c => [c.key, c.label_en || c.key]));
  const catIconByKey = new Map(categories.map(c => [c.key, c.icon || '']));

  // 그룹핑: 국가별 / 카테고리별 / (국가×카테고리) 조합별
  const byCountry = new Map();
  const byCombo = new Map(); // `${code}::${catkey}` -> list
  for (const s of visible) {
    if (s.country) {
      if (!byCountry.has(s.country)) byCountry.set(s.country, []);
      byCountry.get(s.country).push(s);
    }
    if (s.country && s.category && s.category !== 'other') {
      const ck = `${s.country}::${s.category}`;
      if (!byCombo.has(ck)) byCombo.set(ck, []);
      byCombo.get(ck).push(s);
    }
  }

  // 페이지를 만들 국가 확정 (슬러그 미리 계산 — 조합 페이지 링크에 필요)
  const countrySlugByCode = new Map();
  for (const [code, list] of byCountry) {
    if (list.length >= MIN_COUNTRY_ENTRIES) countrySlugByCode.set(code, slugify(countryNameOf(code)));
  }

  // 조합(국가×카테고리) 페이지 대상 확정: 충분한 캠이 있고 국가 페이지가 존재하는 조합만 (롱테일 검색어 겨냥)
  const COMBO_MIN = 5;
  const combos = [];
  const combosByCountry = new Map();
  const combosByCategory = new Map();
  for (const [ck, list] of byCombo) {
    if (list.length < COMBO_MIN) continue;
    const [code, catkey] = ck.split('::');
    if (!countrySlugByCode.has(code)) continue;
    const cb = { code, catkey, list, name: countryNameOf(code), slug: countrySlugByCode.get(code),
      label: catLabelByKey.get(catkey) || catkey, icon: catIconByKey.get(catkey) || '' };
    combos.push(cb);
    if (!combosByCountry.has(code)) combosByCountry.set(code, []);
    combosByCountry.get(code).push(cb);
    if (!combosByCategory.has(catkey)) combosByCategory.set(catkey, []);
    combosByCategory.get(catkey).push(cb);
  }
  for (const arr of combosByCountry.values()) arr.sort((a, b) => b.list.length - a.list.length);
  for (const arr of combosByCategory.values()) arr.sort((a, b) => b.list.length - a.list.length);

  // ===== 국가별 페이지 =====
  const countryPages = [];
  for (const [code, list] of byCountry) {
    if (!countrySlugByCode.has(code)) continue;
    const name = countryNameOf(code);
    const slug = countrySlugByCode.get(code);
    const liveCount = list.filter(s => s.content_type === 'live').length;
    const videoCount = list.length - liveCount;
    const entries = sortForPage(list).slice(0, MAX_ENTRIES_PER_PAGE);
    const topCats = topLabels(list, s => s.category, k => catLabelByKey.get(k), 4);
    const ex = exampleTitles(list, 2);
    const p1 = `Camlisted tracks <strong>${list.length}</strong> live cams and real-world videos from ${escapeHtml(name)} — ${liveCount} streaming live right now and ${videoCount} recorded clips. They span ${humanList(topCats) || 'a range of everyday scenes'} and more, every feed pulled from public YouTube streams and re-checked daily so dead links fall away on their own.`;
    const p2 = ex.length
      ? `Current highlights include ${humanList(ex)}. It's all free to watch with no account — filter by category, video quality, or live status, or open the map to explore ${escapeHtml(name)} by location.`
      : `Everything is free to watch with no account — filter by category, quality, or live status.`;
    const comboLinks = (combosByCountry.get(code) || []).slice(0, 12)
      .map(cb => `<a href="/country/${cb.slug}/${cb.catkey}.html">${cb.icon ? cb.icon + ' ' : ''}${escapeHtml(cb.label)}</a>`);
    const intro = introSection([p1, p2], [linkRow(`Categories in ${name}`, comboLinks)]);
    const faq = faqBlock([
      [`How many live webcams does ${name} have on Camlisted?`,
        `${liveCount} live YouTube cameras from ${escapeHtml(name)} are listed right now, alongside ${videoCount} recorded clips. The exact number shifts daily — every feed is re-checked each night and dead streams drop off automatically.`],
      [`What kinds of scenes can I watch in ${name}?`,
        topCats.length
          ? `The current mix is strongest in ${humanList(topCats.map(c => c.toLowerCase()))}.${ex.length ? ` Recent examples include ${humanList(ex)}.` : ''}`
          : `A changing mix of live cameras and recorded footage, updated nightly.`],
      ['Is it free to watch? Do I need an account?',
        'Yes, and no account is needed. Every feed is a public YouTube stream embedded from its original channel — Camlisted links to sources and never hosts or downloads video.'],
      ['How current is this list?',
        'The whole catalogue is verified once a day: an automated job confirms each stream is still live or public, fills in missing details, and retires anything that has gone offline.'],
    ]);
    const outro = outroSection(`About live cams in ${name}`,
      [COUNTRY_NOTES[code], ...factsParagraphs(list, name)], faq.html);
    const html = appPage(indexTemplate, {
      title: `${name} Live Cams & Webcams — Watch Free | Camlisted`,
      description: `${liveCount} live cams and ${videoCount} videos from ${name}${topCats.length ? ' — ' + topCats.slice(0, 3).join(', ').toLowerCase() : ''}. Free, no sign-up, verified daily.`,
      canonicalPath: `/country/${slug}.html`,
      h1: `Live Cams & Footage in ${name}`,
      presetScript: `window.__presetCountry=${JSON.stringify(code)};`,
      staticGrid: entries.map(entryCard).join(''),
      intro,
      outro,
      ogImage: ogImageOf(entries),
      jsonLd: collectionJsonLd({
        name: `Live Cams in ${name}`, url: `/country/${slug}.html`, description: `${list.length} live cams and videos from ${name}.`,
        crumbs: [{ name: 'Home', path: '/' }, { name: name, path: `/country/${slug}.html` }],
        extra: [faq.jsonLd],
      }),
    });
    await writeFile(path.join(ROOT, 'country', `${slug}.html`), html);
    countryPages.push({ code, name, slug, count: list.length });
    sitemapUrls.push({ loc: `${SITE}/country/${slug}.html`, priority: '0.8', changefreq: 'daily' });
  }
  countryPages.sort((a, b) => b.count - a.count);
  console.log(`국가 페이지 ${countryPages.length}개 생성`);

  // ===== 카테고리별 페이지 =====
  const categoryPages = [];
  for (const cat of categories) {
    if (cat.key === 'other') continue;
    const list = visible.filter(s => s.category === cat.key);
    if (!list.length) continue;
    const liveCount = list.filter(s => s.content_type === 'live').length;
    const videoCount = list.length - liveCount;
    const entries = sortForPage(list).slice(0, MAX_ENTRIES_PER_PAGE);
    const label = cat.label_en || cat.key;
    const lower = label.toLowerCase();
    const topCountries = topLabels(list, s => s.country, code => countryNameOf(code), 4);
    const ex = exampleTitles(list, 2);
    const p1 = `Browse <strong>${list.length}</strong> ${lower} live cams and videos gathered from around the world — ${liveCount} live and ${videoCount} recorded. Coverage is strongest in ${humanList(topCountries) || 'many countries'}, with fresh public YouTube feeds added and verified every day.`;
    const p2 = ex.length
      ? `Right now you can watch ${humanList(ex)}, among others. No sign-up needed — sort by most-upvoted or newest, or narrow to a single country below.`
      : `No sign-up needed — sort by most-upvoted or newest, and jump straight to any country.`;
    const comboLinks = (combosByCategory.get(cat.key) || []).slice(0, 15)
      .map(cb => `<a href="/country/${cb.slug}/${cb.catkey}.html">${escapeHtml(cb.name)}</a>`);
    const intro = introSection([p1, p2], [linkRow(`${label} cams by country`, comboLinks)]);
    const faq = faqBlock([
      [`How many ${lower} live cams are there?`,
        `${liveCount} live ${lower} cameras are streaming right now, plus ${videoCount} recorded clips${topCountries.length ? `, with the deepest coverage in ${humanList(topCountries)}` : ''}. The list is re-verified every night.`],
      [`What are ${lower} cams useful for?`,
        `Beyond watching for its own sake, fixed public cameras of this kind are widely used as reference and test footage — checking how detection or tracking models behave on real scenes instead of curated datasets.`],
      ['Is it free to watch? Do I need an account?',
        'Yes, and no account is needed. Every feed is a public YouTube stream embedded from its original channel — Camlisted links to sources and never hosts or downloads video.'],
    ]);
    const outro = outroSection(`About ${lower} cams`,
      [CATEGORY_NOTES[cat.key], ...factsParagraphs(list)], faq.html);
    const html = appPage(indexTemplate, {
      title: `${label} Live Cams — Free 24/7 Webcams | Camlisted`,
      description: `${liveCount} live ${lower} cams and ${videoCount} videos${topCountries.length ? ' from ' + topCountries.slice(0, 3).join(', ') : ''}. Curated from YouTube, verified daily, free to watch.`,
      canonicalPath: `/c/${cat.key}.html`,
      h1: `${cat.icon ? cat.icon + ' ' : ''}${label} Live Cams & Videos`,
      presetScript: `window.__presetCategory=${JSON.stringify(cat.key)};`,
      staticGrid: entries.map(entryCard).join(''),
      intro,
      outro,
      ogImage: ogImageOf(entries),
      jsonLd: collectionJsonLd({
        name: `${label} Live Cams`, url: `/c/${cat.key}.html`, description: `${list.length} ${lower} live cams and videos worldwide.`,
        crumbs: [{ name: 'Home', path: '/' }, { name: `${label} cams`, path: `/c/${cat.key}.html` }],
        extra: [faq.jsonLd],
      }),
    });
    await writeFile(path.join(ROOT, 'c', `${cat.key}.html`), html);
    categoryPages.push({
      key: cat.key, label, icon: cat.icon, count: list.length,
      labels: { ko: cat.label_ko, ja: cat.label_ja, zh: cat.label_zh, es: cat.label_es },
    });
    sitemapUrls.push({ loc: `${SITE}/c/${cat.key}.html`, priority: '0.8', changefreq: 'daily' });
  }
  console.log(`카테고리 페이지 ${categoryPages.length}개 생성`);

  // ===== 국가 × 카테고리 조합 페이지 (롱테일 SEO: "Japan street live cams" 류) =====
  const comboCountrySlugs = new Set(combos.map(cb => cb.slug));
  for (const slug of comboCountrySlugs) await mkdir(path.join(ROOT, 'country', slug), { recursive: true });
  for (const cb of combos) {
    const liveCount = cb.list.filter(s => s.content_type === 'live').length;
    const videoCount = cb.list.length - liveCount;
    const entries = sortForPage(cb.list).slice(0, MAX_ENTRIES_PER_PAGE);
    const ex = exampleTitles(cb.list, 2);
    const lower = cb.label.toLowerCase();
    const p1 = `${cb.label} live cams in ${escapeHtml(cb.name)} — <strong>${cb.list.length}</strong> feeds (${liveCount} live right now, ${videoCount} recorded), curated from public YouTube streams and re-checked daily.`;
    const p2 = ex.length
      ? `Examples include ${humanList(ex)}. Free to watch, no sign-up — this page zooms in on ${lower} scenes specifically within ${escapeHtml(cb.name)}.`
      : `Free to watch, no sign-up — a focused view of ${lower} scenes within ${escapeHtml(cb.name)}.`;
    const backLinks = [
      `<a href="/country/${cb.slug}.html">All ${escapeHtml(cb.name)} cams</a>`,
      `<a href="/c/${cb.catkey}.html">${escapeHtml(cb.label)} worldwide</a>`,
    ];
    const intro = introSection([p1, p2], [linkRow('See also', backLinks)]);
    // 조합 페이지엔 데이터 사실만 넣는다 — 카테고리 소개문까지 복제하면 수십 페이지에 같은 문단이 반복돼
    // 오히려 중복 콘텐츠가 된다. 사실 문단은 조합마다 수치·채널이 달라 고유하다.
    const comboFacts = comboFactsParagraphs(cb, (byCountry.get(cb.code) || []).length);
    const comboFaq = faqBlock([
      [`How many ${lower} cams in ${cb.name} are live right now?`,
       `${liveCount} of the ${cb.list.length} ${lower} feeds listed for ${escapeHtml(cb.name)} are broadcasting live at the moment${videoCount === 0 ? ', and none of them are recorded clips' : videoCount === 1 ? '; the remaining one is a recorded clip' : `; the remaining ${videoCount} are recorded clips`}. Camlisted re-checks every feed once a day and moves anything that has stopped to offline instead of deleting it.`],
      [`Do I need an account to watch them?`,
       `No. Every feed on this page is a public YouTube stream and plays for free without signing in. An account only adds voting, favourites and the ability to correct a camera's category or country.`],
      [`Can I use this footage for computer vision work?`,
       `The links are free to browse and each one carries its measured resolution, so you can tell at a glance whether a ${lower} camera in ${escapeHtml(cb.name)} is worth opening. The footage itself stays on YouTube under its own licence — Camlisted only points at it and never hosts or re-encodes video.`],
    ]);
    const outro = outroSection(`About ${lower} cams in ${cb.name}`, comboFacts, comboFaq.html);
    const html = appPage(indexTemplate, {
      title: `${cb.name} ${cb.label} Live Cams | Camlisted`,
      description: `${cb.list.length} ${lower} live cams and videos in ${cb.name}, ${liveCount} live now. Free to watch, verified daily on Camlisted.`,
      canonicalPath: `/country/${cb.slug}/${cb.catkey}.html`,
      h1: `${cb.icon ? cb.icon + ' ' : ''}${cb.name} · ${cb.label} Live Cams`,
      presetScript: `window.__presetCountry=${JSON.stringify(cb.code)};window.__presetCategory=${JSON.stringify(cb.catkey)};`,
      staticGrid: entries.map(entryCard).join(''),
      intro,
      outro,
      ogImage: ogImageOf(entries),
      jsonLd: collectionJsonLd({
        name: `${cb.name} ${cb.label} Live Cams`, url: `/country/${cb.slug}/${cb.catkey}.html`, description: `${cb.list.length} ${lower} live cams in ${cb.name}.`,
        crumbs: [{ name: 'Home', path: '/' }, { name: cb.name, path: `/country/${cb.slug}.html` }, { name: cb.label, path: `/country/${cb.slug}/${cb.catkey}.html` }],
        extra: [comboFaq.jsonLd],
      }),
    });
    await writeFile(path.join(ROOT, 'country', cb.slug, `${cb.catkey}.html`), html);
    sitemapUrls.push({ loc: `${SITE}/country/${cb.slug}/${cb.catkey}.html`, priority: '0.6', changefreq: 'weekly' });
  }
  console.log(`조합 페이지 ${combos.length}개 생성`);

  // ===== 운영자(채널) 페이지 =====
  // 카메라를 여러 대 굴리는 채널은 그 자체가 사람들이 찾는 대상이다("Virtual Railfan" 같은
  // 브랜드 검색어). 그런데 지금까지는 한 운영자의 카메라를 모아보는 방법이 아예 없었다.
  // 데이터는 이미 channel_id로 다 들어와 있어서 페이지만 뽑으면 된다.
  const CHANNEL_MIN = 5;   // 이보다 적으면 페이지를 만들지 않는다 (얇은 페이지 방지)
  const byChannel = new Map();
  for (const s of visible) {
    if (!s.channel_id || !s.channel_title) continue;
    if (!byChannel.has(s.channel_id)) byChannel.set(s.channel_id, []);
    byChannel.get(s.channel_id).push(s);
  }
  const channels = [];
  const usedChannelSlugs = new Set();
  for (const [cid, list] of [...byChannel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < CHANNEL_MIN) continue;
    const title = list[0].channel_title;
    // 채널명이 겹치거나(동명이인) 슬러그가 비는(전부 비ASCII) 경우가 있어 채널ID 꼬리를 붙여 유일하게 만든다
    let slug = slugify(title).slice(0, 60);
    if (!slug || usedChannelSlugs.has(slug)) slug = `${slug ? slug + '-' : 'channel-'}${cid.slice(-6).toLowerCase()}`;
    if (usedChannelSlugs.has(slug)) continue; // 그래도 겹치면 건너뛴다 (사실상 발생하지 않음)
    usedChannelSlugs.add(slug);
    channels.push({ id: cid, title, slug, list });
  }
  // 페이지 문장에서 인용할 "운영자 중 단일 국가 비율" — 하드코딩하지 않고 매 실행 실제 값을 쓴다
  const singleCountryPct = channels.length
    ? Math.round(channels.filter(c => new Set(c.list.map(s => s.country).filter(Boolean)).size <= 1).length / channels.length * 100)
    : 0;
  await mkdir(path.join(ROOT, 'ch'), { recursive: true });
  for (const chn of channels) {
    const liveCount = chn.list.filter(s => s.content_type === 'live').length;
    const videoCount = chn.list.length - liveCount;
    const entries = sortForPage(chn.list).slice(0, MAX_ENTRIES_PER_PAGE);
    const name = escapeHtml(chn.title);
    const countryNames = topCounts(chn.list, s => s.country, 3).map(([c]) => escapeHtml(countryNameOf(c)));
    const ex = exampleTitles(chn.list, 2);
    const p1 = `All <strong>${chn.list.length}</strong> cameras and videos Camlisted tracks from <strong>${name}</strong> on YouTube — ${liveCount} live right now, ${videoCount} recorded${countryNames.length ? `, filmed in ${humanList(countryNames)}` : ''}.`;
    const p2 = ex.length
      ? `Examples include ${humanList(ex)}. Free to watch, no sign-up — every feed is re-checked once a day, so anything that has stopped shows as offline instead of quietly 404ing.`
      : `Free to watch, no sign-up — every feed is re-checked once a day, so anything that has stopped shows as offline instead of quietly 404ing.`;
    const catLinks = topCounts(chn.list, s => s.category, 4)
      .filter(([k]) => k && categoryPages.some(c => c.key === k))
      .map(([k]) => `<a href="/c/${k}.html">${escapeHtml(catLabelByKey.get(k) || k)}</a>`);
    const intro = introSection([p1, p2], [
      linkRow('Also in', catLinks),
      `<nav class="seo-links"><a href="https://www.youtube.com/channel/${encodeURIComponent(chn.id)}" target="_blank" rel="noopener nofollow">Visit ${name} on YouTube &rarr;</a></nav>`,
    ]);
    const facts = channelFactsParagraphs(chn, countryNameOf, catLabelByKey, singleCountryPct);
    const faq = faqBlock([
      [`How many cameras does ${chn.title} have on Camlisted?`,
       `${chn.list.length}${chn.list.length === MAX_ENTRIES_PER_PAGE ? ' or more' : ''} — ${videoCount === 0 ? `all of them live streams, ${liveCount} broadcasting right now` : liveCount === 0 ? `all of them recorded uploads rather than live streams` : `${liveCount} broadcasting live at the moment and ${videoCount} recorded`}. The list is rebuilt nightly from YouTube, so it follows the channel as cameras are added or retired.`],
      [`Is this an official ${chn.title} page?`,
       `No. Camlisted is an independent directory and has no affiliation with ${name}. It links to the channel's public YouTube streams and never hosts, mirrors or re-encodes the video.`],
      [`How do I follow this operator?`,
       `Open any camera here and use the subscribe button, or visit the channel on YouTube directly. Camlisted itself needs no account to browse.`],
    ]);
    const html = appPage(indexTemplate, {
      title: `${chn.title} — All ${chn.list.length} Live Cams | Camlisted`,
      description: `Every live cam and video from ${chn.title}: ${chn.list.length} feeds, ${liveCount} live now${countryNames.length ? `, filmed in ${countryNames.join(', ')}` : ''}. Free to watch, verified daily.`,
      canonicalPath: `/ch/${chn.slug}.html`,
      h1: `${chn.title} · Live Cams`,
      presetScript: `window.__presetChannel=${JSON.stringify(chn.id)};`,
      staticGrid: entries.map(entryCard).join(''),
      intro,
      outro: outroSection(`About ${chn.title}`, facts, faq.html),
      ogImage: ogImageOf(entries),
      jsonLd: collectionJsonLd({
        name: `${chn.title} Live Cams`, url: `/ch/${chn.slug}.html`,
        description: `${chn.list.length} live cams and videos from ${chn.title}.`,
        crumbs: [{ name: 'Home', path: '/' }, { name: chn.title, path: `/ch/${chn.slug}.html` }],
        extra: [faq.jsonLd],
      }),
    });
    await writeFile(path.join(ROOT, 'ch', `${chn.slug}.html`), html);
    sitemapUrls.push({ loc: `${SITE}/ch/${chn.slug}.html`, priority: '0.6', changefreq: 'weekly' });
  }
  console.log(`운영자 페이지 ${channels.length}개 생성 (카메라 ${channels.reduce((a, c) => a + c.list.length, 0)}대 커버)`);

  // ===== 최장수 라이브 랭킹 =====
  // started_at은 "지금 돌고 있는 방송이 시작된 시각"(liveStreamingDetails.actualStartTime)이라,
  // 여기 오르려면 한 번도 안 끊긴 단일 방송이어야 한다. 방송을 재시작하면 videoId가 바뀌며 0으로 리셋된다.
  // 웹캠 목록의 최대 불만이 "링크가 죽어있다"인데 이 페이지는 정확히 그 반대를 보여준다.
  const DAY_MS = 86400000;
  const nowMs = Date.now();
  const runners = visible
    .filter(s => s.content_type === 'live' && s.status === 'live' && s.started_at)
    .map(s => ({ ...s, days: Math.floor((nowMs - new Date(s.started_at).getTime()) / DAY_MS) }))
    .filter(s => s.days >= 0)
    .sort((a, b) => b.days - a.days);

  if (runners.length >= 20) {
    const RANK_SHOWN = 100;
    const chSlugById = new Map(channels.map(c => [c.id, c.slug]));
    const catKeysWithPage = new Set(categoryPages.map(c => c.key));
    // 표 안에서는 좁게(8 yr 47 d), 문장 안에서는 읽히게(8 years and 47 days) 쓴다
    const fmtAge = (d) => {
      const y = Math.floor(d / 365), r = d % 365;
      return y ? `${y} yr ${r} d` : `${d} d`;
    };
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const fmtAgeLong = (d) => {
      const y = Math.floor(d / 365), r = d % 365;
      if (!y) return plural(d, 'day');
      if (!r) return plural(y, 'year');
      return `${plural(y, 'year')} and ${plural(r, 'day')}`;
    };
    const nfmt = (n) => n.toLocaleString('en-US');
    const median = (arr) => {
      const a = [...arr].sort((x, y) => x - y);
      return a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2);
    };
    const atLeast = (y) => runners.filter(s => s.days >= 365 * y).length;
    const medianDays = median(runners.map(s => s.days));
    const top = runners[0];

    // 카테고리별 수명 중앙값 — "어떤 종류의 카메라가 오래 사는가"는 여기서만 나오는 데이터다
    const byCatDays = new Map();
    for (const s of runners) {
      if (!s.category) continue;
      if (!byCatDays.has(s.category)) byCatDays.set(s.category, []);
      byCatDays.get(s.category).push(s.days);
    }
    const catLongevity = [...byCatDays.entries()]
      .filter(([, v]) => v.length >= 10)
      .map(([k, v]) => ({ key: k, label: catLabelByKey.get(k) || k, med: median(v), n: v.length }))
      .sort((a, b) => b.med - a.med);

    const veterans = runners.filter(s => s.days >= 365 * 5);
    const vetCountries = topCounts(veterans, s => s.country, 3);
    const vetOperators = topCounts(veterans, s => s.channel_title, 3).filter(([, n]) => n >= 2);

    const rankRows = runners.slice(0, RANK_SHOWN).map((s, i) => {
      const opSlug = chSlugById.get(s.channel_id);
      const cSlug = s.country ? countrySlugByCode.get(s.country) : null;
      const startYear = new Date(s.started_at).getUTCFullYear();
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td><a href="https://www.youtube.com/watch?v=${encodeURIComponent(s.video_id)}" target="_blank" rel="noopener">${escapeHtml(truncTitle(s.title))}</a>
          <div class="meta">${opSlug ? `<a href="/ch/${opSlug}.html">${escapeHtml(s.channel_title || '')}</a>` : escapeHtml(s.channel_title || '')}</div></td>
        <td>${cSlug ? `<a href="/country/${cSlug}.html">${escapeHtml(countryNameOf(s.country))}</a>` : escapeHtml(s.country ? countryNameOf(s.country) : '—')}</td>
        <td>${s.category && catKeysWithPage.has(s.category) ? `<a href="/c/${s.category}.html">${escapeHtml(catLabelByKey.get(s.category) || s.category)}</a>` : escapeHtml(s.category ? (catLabelByKey.get(s.category) || s.category) : '—')}</td>
        <td class="age">${fmtAge(s.days)}<div class="meta">since ${startYear}</div></td>
      </tr>`;
    }).join('');

    const catTable = catLongevity.length >= 4 ? `
      <h2>Which kinds of camera last longest</h2>
      <p>Grouping the same set by subject shows the gap plainly. This is median age, so it describes the typical camera in each group rather than its record holder — categories with fewer than ten live cameras are left out.</p>
      <div class="rank-wrap"><table class="rank-table">
        <thead><tr><th>Category</th><th>Median age</th><th>Live cams counted</th></tr></thead>
        <tbody>${catLongevity.map(c => `<tr><td>${catKeysWithPage.has(c.key) ? `<a href="/c/${c.key}.html">${escapeHtml(c.label)}</a>` : escapeHtml(c.label)}</td><td class="age">${fmtAge(c.med)}</td><td class="meta">${c.n}</td></tr>`).join('')}</tbody>
      </table></div>` : '';

    const longestFaq = faqBlock([
      ['What counts as "continuously running"?',
       `The clock is YouTube's own start time for the broadcast that is playing right now. If an operator stops and restarts a stream, YouTube issues a new video and the count begins again at zero — so every camera on this list has held a single unbroken broadcast for the age shown. A camera that has filmed the same view for a decade across several restarts will not appear near the top.`],
      ['How often is this list updated?',
       `Nightly. Camlisted re-checks every stream once a day, and a camera drops off this page as soon as its broadcast ends. That is the point of the list: everything here was still running at the last check.`],
      ['Why are there so few very old streams?',
       `Because staying live is hard. Across ${nfmt(runners.length)} live cameras with a known start time the median age is ${fmtAgeLong(medianDays)} — power cuts, expired keys, storms and channel changes end most broadcasts long before their first birthday. The ${nfmt(atLeast(5))} cameras past five years are the exception, not the norm.`],
    ]);

    const longestBody = `
      <div class="rank-wrap"><table class="rank-table">
        <thead><tr><th>#</th><th>Camera</th><th>Country</th><th>Category</th><th>Running for</th></tr></thead>
        <tbody>${rankRows}</tbody>
      </table></div>
      <p class="rank-note">Showing the top ${Math.min(RANK_SHOWN, runners.length)} of ${nfmt(runners.length)} live cameras with a known start time. Updated ${escapeHtml(today)}.</p>

      <section class="seo-outro">
        <h2>What the numbers say</h2>
        <p>Most live cams do not last. Of the ${nfmt(runners.length)} broadcasting right now with a start time on record, the median has been up for just ${fmtAgeLong(medianDays)}. Past that the field thins fast: ${nfmt(atLeast(1))} have run over a year, ${nfmt(atLeast(3))} over three, and only ${nfmt(atLeast(5))} have held a single unbroken broadcast for five years or more.</p>
        <p>The current record holder is “${escapeHtml(truncTitle(top.title))}”${top.channel_title ? ` from ${escapeHtml(top.channel_title)}` : ''}${top.country ? ` in ${escapeHtml(countryNameOf(top.country))}` : ''}, streaming without a break for ${fmtAgeLong(top.days)} — since ${new Date(top.started_at).getUTCFullYear()}. That is one continuous YouTube broadcast, not a channel that has been posting since then.</p>
        ${vetCountries.length ? `<p>The five-year club skews geographically: ${humanList(vetCountries.map(([c, n]) => `${escapeHtml(countryNameOf(c))} (${n})`))} account for much of it${vetOperators.length ? `, and a handful of operators carry several each — ${humanList(vetOperators.map(([n, k]) => `${escapeHtml(n)} (${k})`))}` : ''}. Longevity tends to follow whoever treats the camera as infrastructure rather than a project.</p>` : ''}
        ${catLongevity.length >= 4 ? `<p>Subject matter matters more than you might expect. ${escapeHtml(catLongevity[0].label)} cameras run a median ${fmtAgeLong(catLongevity[0].med)}, while ${escapeHtml(catLongevity[catLongevity.length - 1].label)} cameras manage ${fmtAgeLong(catLongevity[catLongevity.length - 1].med)}. Cameras bolted to a building someone maintains outlast cameras set up for a season or a view that shifts.</p>` : ''}
        ${longestFaq.html}
      </section>
      ${catTable}
      <p><a href="/browse.html">Browse every country, category and operator &rarr;</a></p>
      <script type="application/ld+json">${JSON.stringify([
        longestFaq.jsonLd,
        {
          '@context': 'https://schema.org', '@type': 'ItemList',
          name: 'The Longest-Running Live Cams on YouTube',
          description: `YouTube live cams ranked by unbroken broadcast length. Updated ${today}.`,
          numberOfItems: Math.min(RANK_SHOWN, runners.length),
          itemListOrder: 'https://schema.org/ItemListOrderDescending',
          itemListElement: runners.slice(0, 20).map((s, i) => ({
            '@type': 'ListItem', position: i + 1, name: truncTitle(s.title),
            url: `https://www.youtube.com/watch?v=${encodeURIComponent(s.video_id)}`,
          })),
        },
      ])}<\/script>
    `;

    const longestHtml = pageHtml({
      title: 'The Longest-Running Live Cams on YouTube – Camlisted',
      description: `The YouTube live cams that have streamed longest without stopping — ${atLeast(5)} have run over five years unbroken, led by ${truncTitle(top.title)} at ${fmtAge(top.days)}. Updated daily.`,
      canonicalPath: '/longest-running-live-cams.html',
      h1: 'The Longest-Running Live Cams on YouTube',
      intro: `Ranked by how long each broadcast has run without ever stopping. ${atLeast(5)} of these cameras have been live for more than five years straight. Updated ${today}.`,
      bodyHtml: longestBody,
    });
    await writeFile(path.join(ROOT, 'longest-running-live-cams.html'), longestHtml);
    sitemapUrls.push({ loc: `${SITE}/longest-running-live-cams.html`, priority: '0.7', changefreq: 'daily' });
    console.log(`최장수 라이브 랭킹 생성 (${runners.length}대 중 상위 ${Math.min(RANK_SHOWN, runners.length)} · 5년+ ${atLeast(5)}대 · 최고 ${fmtAge(top.days)})`);
  } else {
    console.log('최장수 라이브 랭킹 건너뜀 — started_at 있는 라이브가 너무 적음');
  }

  // ===== 세계지도 (choropleth) — 영상 수에 따라 색이 진해지고, 호버 툴팁 + 클릭 이동 =====
  // 지도 경로 데이터: jsvectormap(MIT, Natural Earth 기반)에서 추출한 config/world_map_paths.json
  const countByCode = new Map(); // code -> { live, video }
  for (const s of visible) {
    if (!s.country) continue;
    if (!countByCode.has(s.country)) countByCode.set(s.country, { live: 0, video: 0 });
    countByCode.get(s.country)[s.content_type === 'live' ? 'live' : 'video'] += 1;
  }
  // 뚜렷한 구간별 색상 (연속 그라데이션은 구분이 잘 안 보여서 단계형으로)
  const MAP_BUCKETS = [
    { min: 200, color: '#ff3b3b', label: '200+' },
    { min: 50, color: '#ff7a45', label: '50–199' },
    { min: 10, color: '#ffb020', label: '10–49' },
    { min: 1, color: '#f2e284', label: '1–9' },
    { min: 0, color: '#232a35', label: 'None' },
  ];
  const heatColor = (count) => MAP_BUCKETS.find(b => count >= b.min).color;
  const slugByCode = new Map(countryPages.map(c => [c.code, c.slug]));

  // ===== 홈페이지 정적 색인 블록 =====
  // 홈은 카드를 전부 JS로 그려서 크롤러에겐 사실상 빈 페이지였다(헤더 문구와 필터 라벨만 읽힘).
  // 검색엔진이 읽을 실제 텍스트(대표 캠 제목)와 국가/카테고리 페이지로 가는 내부 링크를 여기서 심는다.
  const isHomeListed = (s) => s.status === 'live' && (s.visibility == null || s.visibility === 'listed');
  const homeCatCount = new Map();
  for (const s of visible) {
    if (!isHomeListed(s)) continue;
    const k = s.category || 'other';
    homeCatCount.set(k, (homeCatCount.get(k) || 0) + 1);
  }
  const homePopular = visible
    .filter(s => s.content_type === 'live' && isHomeListed(s))
    .sort((a, b) => (b.upvote_count || 0) - (a.upvote_count || 0) || new Date(b.added_at) - new Date(a.added_at))
    .slice(0, 40);
  const homeStatic = `<!--HOME_STATIC_START-->
    <section class="home-index">
      <h2>Live cams on Camlisted</h2>
      <p>Camlisted is a free, daily-updated directory of public <strong>YouTube live cams</strong> and real-world
      footage. Every stream listed here is a publicly available YouTube broadcast &mdash; traffic and street cams,
      beaches and harbours, mountains and wildlife, airports and train stations. An automated job checks every cam
      each day, so streams that go offline are removed and new ones are added on their own.
      <strong>${mainVisibleCount}</strong> cams are live right now (updated ${escapeHtml(today)}).</p>
      <h3>Popular live cams right now</h3>
      <ul class="home-index-list">
        ${homePopular.map(s => `<li>${escapeHtml(truncTitle(s.title))}${s.channel_title ? ` &mdash; ${escapeHtml(s.channel_title)}` : ''}${s.country ? ` (${escapeHtml(countryNameOf(s.country) || s.country)})` : ''}</li>`).join('')}
      </ul>
      <h3>Live cams by category</h3>
      <ul class="home-index-links">
        ${categories.map(c => {
          // 페이지가 실제로 생성된 카테고리만 링크한다 — 'other'는 페이지를 안 만드는데
          // 여기서 전체 카테고리를 돌면서 /c/other.html 링크를 만들어 404를 가리키고 있었다
          // (GSC가 2026-07-25 크롤에서 잡아냄)
          if (!categoryPages.some(p => p.key === c.key)) return '';
          const n = homeCatCount.get(c.key) || 0;
          return n ? `<li><a href="/c/${c.key}.html">${escapeHtml(c.label_en || c.key)} live cams</a> <span>${n}</span></li>` : '';
        }).join('')}
      </ul>
      <h3>Live cams by country</h3>
      <ul class="home-index-links">
        ${[...countryPages].sort((a, b) => b.count - a.count).slice(0, 60)
          .map(c => `<li><a href="/country/${c.slug}.html">${escapeHtml(c.name)} live cams</a> <span>${c.count}</span></li>`).join('')}
      </ul>
      <h3>Live cams by operator</h3>
      <ul class="home-index-links">
        ${channels.slice(0, 40)
          .map(c => `<li><a href="/ch/${c.slug}.html">${escapeHtml(c.title)}</a> <span>${c.list.length}</span></li>`).join('')}
      </ul>
      <p><a href="/longest-running-live-cams.html">The longest-running live cams on YouTube &rarr;</a></p>
      <p><a href="/browse.html">Browse every country, category and operator &rarr;</a></p>
    </section>
  <!--HOME_STATIC_END-->`;
  let resolvedIndex = indexTemplate.replace(HOME_STATIC_RE, homeStatic);
  // 홈 공유 미리보기(og:image/twitter:image)를 오늘의 대표 라이브 캠 썸네일로 갱신
  if (homeTop?.video_id) {
    resolvedIndex = resolvedIndex.replace(/(\/vi\/)[^/]*(\/hqdefault\.jpg")/g, `$1${homeTop.video_id}$2`);
  }
  await writeFile(path.join(ROOT, 'index.html'), resolvedIndex);
  console.log(`홈 정적 색인 블록 생성 (대표 캠 ${homePopular.length}건 · 국가 링크 ${Math.min(countryPages.length, 60)}개)`);
  const mapPaths = JSON.parse(await readFile(path.join(ROOT, 'config', 'world_map_paths.json'), 'utf-8'));
  const mapSvgPaths = Object.entries(mapPaths).map(([code, v]) => {
    const c = countByCode.get(code) || { live: 0, video: 0 };
    const total = c.live + c.video;
    const href = slugByCode.has(code) ? `/country/${slugByCode.get(code)}.html` : (total ? `/?country=${code}` : '');
    return `<path d="${v.path}" fill="${heatColor(total)}" data-code="${code}" data-name="${escapeHtml(countryNameOf(code) || v.name)}" data-live="${c.live}" data-video="${c.video}"${href ? ` data-href="${href}"` : ''}></path>`;
  }).join('');
  const mapSection = `
      <div class="map-wrap">
        <svg viewBox="0 0 900 441" role="img" aria-label="World map of available cams by country">${mapSvgPaths}</svg>
        <div id="mapTip" class="map-tip" hidden></div>
        <div id="mapPinTip" class="map-tip pinned" hidden></div>
        <div class="map-zoom">
          <button type="button" id="mapZoomIn" aria-label="Zoom in">+</button>
          <button type="button" id="mapZoomOut" aria-label="Zoom out">−</button>
          <button type="button" id="mapZoomReset" aria-label="Reset view">⤾</button>
        </div>
      </div>
      <div class="globe-bar">
        <div class="map-type-filter" style="margin:0">Show:
          <button type="button" data-type="all" class="active">All</button>
          <button type="button" data-type="live">🔴 Live</button>
          <button type="button" data-type="video">🎬 Videos</button>
        </div>
        <div class="map-legend" style="margin:0">
          ${[...MAP_BUCKETS].reverse().map(b => `<span><span class="sw" style="background:${b.color}"></span><span${b.min === 0 ? ' class="legend-none"' : ''}>${b.label}</span></span>`).join('')}
        </div>
      </div>
      <p class="map-note" id="mapHoverNote">Hover a country to see how many cams it has — click to browse. Scroll to zoom, drag to pan.</p>
      <script>
        (function () {
          var tip = document.getElementById('mapTip');
          var paths = [].slice.call(document.querySelectorAll('.map-wrap path'));
          var mapType = 'all';

          // ---- 확대/이동 (viewBox 조작) ----
          var svg = document.querySelector('.map-wrap svg');
          var wrap = document.querySelector('.map-wrap');
          var BASE = { w: 900, h: 441 };
          var vb = { x: 0, y: 0, w: 900, h: 441 };
          var MINW = BASE.w / 8; // 최대 8배 확대
          var moved = false;
          function applyVB() {
            svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
            wrap.classList.toggle('zoomed', vb.w < BASE.w - 0.5);
            if (window.__repaintMap) window.__repaintMap();
          }
          function clampVB() {
            if (vb.w > BASE.w) { vb.w = BASE.w; vb.h = BASE.h; }
            if (vb.x < 0) vb.x = 0;
            if (vb.y < 0) vb.y = 0;
            if (vb.x + vb.w > BASE.w) vb.x = BASE.w - vb.w;
            if (vb.y + vb.h > BASE.h) vb.y = BASE.h - vb.h;
          }
          function zoomAt(factor, cx, cy) {
            var nw = vb.w / factor;
            if (nw > BASE.w) nw = BASE.w;
            if (nw < MINW) nw = MINW;
            var nh = nw * (BASE.h / BASE.w);
            vb.x = cx - (cx - vb.x) * (nw / vb.w);
            vb.y = cy - (cy - vb.y) * (nh / vb.h);
            vb.w = nw; vb.h = nh;
            clampVB(); applyVB();
          }
          function svgPoint(e) {
            var r = svg.getBoundingClientRect();
            return { x: vb.x + (e.clientX - r.left) / r.width * vb.w, y: vb.y + (e.clientY - r.top) / r.height * vb.h };
          }
          svg.addEventListener('wheel', function (e) {
            e.preventDefault();
            var p = svgPoint(e);
            zoomAt(e.deltaY < 0 ? 1.25 : 1 / 1.25, p.x, p.y);
          }, { passive: false });
          document.getElementById('mapZoomIn').addEventListener('click', function () { zoomAt(1.5, vb.x + vb.w / 2, vb.y + vb.h / 2); });
          document.getElementById('mapZoomOut').addEventListener('click', function () { zoomAt(1 / 1.5, vb.x + vb.w / 2, vb.y + vb.h / 2); });
          document.getElementById('mapZoomReset').addEventListener('click', function () { vb = { x: 0, y: 0, w: BASE.w, h: BASE.h }; applyVB(); });
          // 확대 상태에서 드래그로 이동 (드래그하면 클릭은 무시해 실수 재생 방지)
          var panning = false, startX, startY, startVBx, startVBy;
          svg.addEventListener('pointerdown', function (e) {
            moved = false;
            if (vb.w >= BASE.w - 0.5) return; // 확대 안 됐으면 클릭 그대로 동작
            panning = true; startX = e.clientX; startY = e.clientY; startVBx = vb.x; startVBy = vb.y;
            wrap.classList.add('grabbing');
            try { svg.setPointerCapture(e.pointerId); } catch (_) {}
          });
          svg.addEventListener('pointermove', function (e) {
            if (!panning) return;
            var r = svg.getBoundingClientRect();
            if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 4) moved = true;
            vb.x = startVBx - (e.clientX - startX) / r.width * vb.w;
            vb.y = startVBy - (e.clientY - startY) / r.height * vb.h;
            clampVB(); applyVB();
          });
          function endPan(e) { panning = false; wrap.classList.remove('grabbing'); try { svg.releasePointerCapture(e.pointerId); } catch (_) {} }
          svg.addEventListener('pointerup', endPan);
          svg.addEventListener('pointercancel', endPan);
          function bucketColor(n) {
            if (!n) return '#232a35';
            if (n >= 200) return '#ff3b3b';
            if (n >= 50) return '#ff7a45';
            if (n >= 10) return '#ffb020';
            return '#f2e284';
          }
          function countOf(p) {
            var live = Number(p.dataset.live), video = Number(p.dataset.video);
            return mapType === 'live' ? live : mapType === 'video' ? video : live + video;
          }
          function repaint() {
            var selPath = null;
            paths.forEach(function (p) {
              var sel = p.dataset.code === window.__selCode;
              p.setAttribute('fill', bucketColor(countOf(p)));
              p.style.stroke = sel ? '#ffffff' : '';
              p.style.strokeWidth = sel ? '1.8' : '';
              if (sel) { selPath = p; p.parentNode.appendChild(p); } // 테두리가 이웃에 가려지지 않게 맨 위로
            });
            // 선택된 나라 위에 호버 툴팁과 같은 형태의 라벨을 고정으로 띄운다
            var pin = document.getElementById('mapPinTip');
            if (pin) {
              if (selPath) {
                var W = window.__L || { live: 'Live', videos: 'Videos' };
                pin.textContent = selPath.dataset.name + ' — ' + W.live + ': ' + selPath.dataset.live + ' · ' + W.videos + ': ' + selPath.dataset.video;
                var wrapRect = pin.parentNode.getBoundingClientRect();
                var pr = selPath.getBoundingClientRect();
                var topPos = pr.top - wrapRect.top;
                if (topPos < 36) topPos = 36; // 위쪽 가장자리 나라도 툴팁이 카드 안에 보이게
                pin.hidden = false; // 폭 측정을 위해 먼저 표시
                var half = pin.offsetWidth / 2 + 6;
                var leftPos = pr.left - wrapRect.left + pr.width / 2;
                if (leftPos < half) leftPos = half; // 좌우 가장자리 나라도 카드 안에 들어오게
                if (leftPos > wrapRect.width - half) leftPos = wrapRect.width - half;
                pin.style.left = leftPos + 'px';
                pin.style.top = topPos + 'px';
              } else {
                pin.hidden = true;
              }
            }
          }
          window.__repaintMap = repaint;
          window.addEventListener('resize', repaint);
          paths.forEach(function (p) {
            p.addEventListener('mousemove', function (e) {
              var W = window.__L || { live: 'Live', videos: 'Videos' };
              tip.textContent = p.dataset.name + ' — ' + W.live + ': ' + p.dataset.live + ' · ' + W.videos + ': ' + p.dataset.video;
              tip.hidden = false;
              tip.style.left = (e.clientX + 14) + 'px';
              tip.style.top = (e.clientY + 14) + 'px';
            });
            p.addEventListener('mouseleave', function () { tip.hidden = true; });
            // 클릭하면 페이지 이동 대신 공유 패널을 열어 바로 재생 (3D 지구본과 동일한 UX)
            if (p.dataset.href) p.addEventListener('click', function () { if (moved) return; if (window.openCountry) window.openCountry(p.dataset); });
          });
          document.querySelectorAll('.map-type-filter button').forEach(function (b) {
            b.addEventListener('click', function () {
              mapType = b.dataset.type;
              document.querySelectorAll('.map-type-filter button').forEach(function (x) {
                x.classList.toggle('active', x === b);
              });
              repaint();
            });
          });
        })();
      </script>`;

  // browse의 공유 패널/인라인 지구본용 데이터
  const vidsAllByCode = {};
  const globeCountriesInline = [];
  for (const [code, c] of countByCode) {
    const total = c.live + c.video;
    if (!total) continue;
    const list = visible.filter(s => s.country === code);
    const lives = list.filter(s => s.content_type === 'live');
    const nonLives = list.filter(s => s.content_type !== 'live');
    const pick = lives.slice(0, 25).concat(nonLives.slice(0, 15)); // 라이브 25 + 일반영상 15 (한쪽이 정원을 다 차지하지 않게)
    vidsAllByCode[code] = pick.map(s => [s.video_id, s.title.slice(0, 70), s.content_type === 'live' ? 1 : 0, s.category || '', (s.tags || []).join(','), s.channel_title || '', s.max_quality || '', s.duration_seconds || 0, s.upvote_count || 0, s.downvote_count || 0]);
    const cen = COUNTRY_CENTROIDS[code];
    if (cen) {
      globeCountriesInline.push({
        code, name: countryNameOf(code), lat: cen[0], lng: cen[1],
        live: c.live, video: c.video,
        href: slugByCode.has(code) ? `/country/${slugByCode.get(code)}.html` : `/?country=${code}`,
      });
    }
  }

  await writeGlobePage(countByCode, slugByCode, visible, today, CAT_META_JSON);
  sitemapUrls.push({ loc: `${SITE}/globe.html`, priority: '0.7', changefreq: 'daily' });

  // ===== browse.html (전체 색인 — 크롤러와 사용자 모두의 진입점) =====
  const browseHtml = pageHtml({
    title: 'Browse Live Cams by Country & Category – Camlisted',
    description: `Browse ${visible.length}+ YouTube live cams and real-world videos by country or category: traffic, beaches, harbors, dashcam footage and more.`,
    canonicalPath: '/browse.html',
    h1: 'Browse by Country & Category',
    intro: `${mainVisibleCount} live cams and videos, organized by where and what they show. Updated ${today}.`,
    introData: `data-n="${mainVisibleCount}" data-d="${today}"`,
    bodyHtml: `
      <div class="map-globe-row">
        <div class="mg-col">
          <div class="globe-box">
            <div id="globe" style="width:100%;height:100%"></div>
            <div id="globeSelLabel" class="globe-sel-label" hidden></div>
          </div>
          <div class="globe-bar">
            <span class="map-note" id="globeHint">Drag to spin · click a point to watch</span>
            <button type="button" class="random-btn" id="randomBtn">🎲 Random cam</button>
            <a href="/globe.html" style="color:var(--muted);font-size:0.8rem;text-decoration:none">⛶ Fullscreen</a>
          </div>
        </div>
        <div class="mg-col">
          ${mapSection}
        </div>
      </div>
      <aside class="panel" id="panel">
        <div class="panel-resize" id="panelResize"></div>
        <button type="button" class="close" id="panelClose">×</button>
        <h2 id="panelTitle"></h2>
        <div class="sub" id="panelSub"></div>
        <div class="player" id="player"></div>
        <div class="cam-meta" id="panelCamMeta"></div>
        <div class="panel-filter" id="panelFilter">
          <button type="button" data-f="all" class="active">All</button>
          <button type="button" data-f="live">🔴 Live</button>
          <button type="button" data-f="video">🎬 Videos</button>
        </div>
        <ul id="camList"></ul>
        <a class="browse-all" id="browseAll" href="#">Browse all →</a>
      </aside>
      <script src="https://unpkg.com/three@0.160.0/build/three.min.js"><\/script>
      <script src="https://unpkg.com/globe.gl@2.32.0/dist/globe.gl.min.js"><\/script>
      <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"><\/script>
      <script>
        // 인라인 3D 지구본 + (2D 지도와 공유하는) 국가 패널
        var GC = ${JSON.stringify(globeCountriesInline)};
        var VIDS = ${JSON.stringify(vidsAllByCode)};
        var TZ = ${JSON.stringify(COUNTRY_TZ)};
        var MTZ = ${JSON.stringify(MULTI_TZ_CODES)};
        var CATM = ${CAT_META_JSON};
        var CONDLABEL = { night: '🌙 Night', day: '☀️ Day', rain: '🌧 Rain', heavy_rain: '⛈ Heavy rain', snow: '❄️ Snow', heavy_snow: '🌨 Heavy snow', accident: '💥 Accident', fire: '🔥 Fire', violence: '🥊 Violence', fog: '🌫 Fog' };
        var UILANG = localStorage.getItem('lang') || 'en';
        var EDITLABEL = ({ en: 'Edit on site', ko: '사이트에서 수정', ja: 'サイトで編集', zh: '在网站编辑', es: 'Editar en el sitio' })[UILANG] || 'Edit on site';
        var QLABEL = { hd2160: '4K', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };
        function fmtDur(s) { s = Number(s); if (!s) return ''; var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0') : m + ':' + String(x).padStart(2, '0'); }
        var CC = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
        function countryOpts(cur) {
          var dn; try { dn = new Intl.DisplayNames([UILANG], { type: 'region' }); } catch (e) {}
          var arr = CC.map(function (c) { return [c, dn ? (dn.of(c) || c) : c]; }).sort(function (a, b) { return a[1].localeCompare(b[1]); });
          var html = '<option value="">\\ud83c\\udf0d ?</option><option value="XX"' + (cur === 'XX' ? ' selected' : '') + '>International/Mixed</option>';
          arr.forEach(function (x) { html += '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + x[1] + '</option>'; });
          return html;
        }
        window.__vidById = {}; window.__editHref = '/'; window.__panelCode = '';
        function renderCamMeta(id) {
          var meta = document.getElementById('panelCamMeta');
          if (!meta) return;
          var v = window.__vidById[id];
          if (!v) { meta.innerHTML = ''; return; }
          var html = '';
          var info = [];
          if (v[5]) info.push(String(v[5]).replace(/</g, '&lt;'));
          if (v[6] && QLABEL[v[6]]) info.push(QLABEL[v[6]]);
          if (v[7]) info.push(fmtDur(v[7]));
          info.push('\\ud83d\\udc4d ' + (v[8] || 0) + ' \\ud83d\\udc4e ' + (v[9] || 0));
          html += '<div class="cam-info">' + info.join(' \\u00b7 ') + '</div>';
          var cat = v[3];
          var tags = (v[4] || '').split(',').filter(Boolean);
          if (window.__me) {
            var opts = Object.keys(CATM).map(function (k) {
              return '<option value="' + k + '"' + (k === cat ? ' selected' : '') + '>' + (CATM[k].icon ? CATM[k].icon + ' ' : '') + (CATM[k][UILANG] || CATM[k].en || k) + '</option>';
            }).join('');
            html += '<select class="cam-country-edit">' + countryOpts(window.__panelCode) + '</select>';
            html += '<select class="cam-cat-edit">' + opts + '</select>';
            if (v[2] === 0) {
              html += Object.keys(CONDLABEL).map(function (t) {
                return '<button type="button" class="cam-cond' + (tags.indexOf(t) >= 0 ? ' on' : '') + '" data-t="' + t + '">' + CONDLABEL[t] + '</button>';
              }).join('');
            }
            meta.innerHTML = html;
            var flash = function (el) { el.classList.add('saved'); setTimeout(function () { el.classList.remove('saved'); }, 1000); };
            meta.querySelector('.cam-cat-edit').addEventListener('change', function () {
              var el = this, val = el.value;
              window.__sbc.rpc('set_stream_category', { p_video_id: id, p_category: val }).then(function (r) {
                if (r.error) { alert(r.error.message); } else { v[3] = val; flash(el); }
              });
            });
            meta.querySelector('.cam-country-edit').addEventListener('change', function () {
              var el = this;
              window.__sbc.rpc('set_stream_country', { p_video_id: id, p_country: el.value || null }).then(function (r) {
                if (r.error) { alert(r.error.message); } else { flash(el); }
              });
            });
            [].forEach.call(meta.querySelectorAll('.cam-cond'), function (btn) {
              btn.addEventListener('click', function () {
                var t = btn.dataset.t, i = tags.indexOf(t);
                if (i >= 0) tags.splice(i, 1); else tags.push(t);
                btn.classList.toggle('on');
                window.__sbc.rpc('set_stream_tags', { p_video_id: id, p_tags: tags.slice() }).then(function (r) {
                  if (r.error) { alert(r.error.message); btn.classList.toggle('on'); if (i >= 0) tags.push(t); else tags.splice(tags.indexOf(t), 1); }
                  else { v[4] = tags.join(','); }
                });
              });
            });
          } else {
            if (cat && CATM[cat]) html += '<span class="cam-badge">' + (CATM[cat].icon ? CATM[cat].icon + ' ' : '') + String(CATM[cat][UILANG] || CATM[cat].en || cat).replace(/</g, '&lt;') + '</span>';
            tags.forEach(function (t) { html += '<span class="cam-badge cond">' + (CONDLABEL[t] || t) + '</span>'; });
            html += '<a class="cam-edit" href="' + window.__editHref + '">\\u270f\\ufe0f ' + EDITLABEL + '</a>';
            meta.innerHTML = html;
          }
        }
        window.__sbc = window.supabase.createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY}');
        window.__me = null;
        window.__sbc.auth.getSession().then(function (r) {
          window.__me = r.data.session ? r.data.session.user : null;
          if (window.__playingId) renderCamMeta(window.__playingId);
        });
        var selLabelTimer = null;
        function localTime(code) {
          var tz = TZ[code];
          if (!tz) return '';
          try {
            var t = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
            return ' \\u00b7 \\ud83d\\udd50 ' + t + (MTZ.indexOf(code) >= 0 ? '~' : '');
          } catch (e) { return ''; }
        }
        var maxTotal = Math.max.apply(null, GC.map(function (c) { return c.live + c.video; }));
        var selectedCode = null;

        var globeBox = document.getElementById('globe');
        var globe = Globe()(globeBox)
          .width(globeBox.clientWidth)
          .height(globeBox.clientHeight)
          .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
          .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
          .pointsData(GC)
          .pointLat('lat').pointLng('lng')
          .pointColor(function (d) { return d.code === selectedCode ? '#ffd21f' : '#ff3b3b'; })
          .pointAltitude(function (d) { return 0.01 + 0.1 * Math.sqrt((d.live + d.video) / maxTotal); })
          .pointRadius(function (d) { return 0.4 + 1.1 * Math.sqrt((d.live + d.video) / maxTotal); })
          .pointLabel(function (d) {
            var W = window.__L || { live: 'Live', videos: 'Videos' };
            return d.name + ' — ' + W.live + ': ' + d.live + ' · ' + W.videos + ': ' + d.video;
          })
          .onPointClick(function (d) { openPanel(d); });
        globe.controls().autoRotate = true;
        globe.controls().autoRotateSpeed = 0.6;
        globe.pointOfView({ lat: 20, lng: 10, altitude: 2.5 });
        // 칼럼 폭이 바뀌면 캔버스도 따라가게 (고정 크기 캔버스가 레이아웃을 밀어내는 것 방지)
        window.addEventListener('resize', function () {
          globe.width(globeBox.clientWidth);
          globe.height(globeBox.clientHeight);
        });

        var panel = document.getElementById('panel');
        function openPanel(d, autoplayRandom) {
          selectedCode = d.code;
          window.__selCode = d.code;
          globe.pointsData(GC);
          if (window.__repaintMap) window.__repaintMap();
          globe.controls().autoRotate = false;
          var gc = GC.find(function (c) { return c.code === d.code; });
          if (gc) {
            var alt = Math.max(globe.pointOfView().altitude, 2.3);
            globe.pointOfView({ lat: gc.lat, lng: gc.lng, altitude: alt }, 900);
          }
          panel.classList.add('open');
          document.body.classList.add('panel-open');
          var gsl = document.getElementById('globeSelLabel');
          if (gsl) {
            var paint = function () { gsl.textContent = d.name + localTime(d.code); };
            paint();
            gsl.hidden = false;
            clearInterval(selLabelTimer);
            selLabelTimer = setInterval(paint, 60000); // 분이 바뀌면 갱신
          }
          document.getElementById('panelTitle').textContent = d.name;
          var W = window.__L || { live: 'Live', videos: 'Videos' };
          document.getElementById('panelSub').textContent = W.live + ': ' + d.live + ' · ' + W.videos + ': ' + d.video;
          document.getElementById('browseAll').href = d.href;
          var vids = VIDS[d.code] || [];
          window.__editHref = d.href;
          window.__panelCode = d.code;
          window.__vidById = {};
          vids.forEach(function (v) { window.__vidById[v[0]] = v; });
          var list = document.getElementById('camList');
          list.innerHTML = '';
          function markActive(li) {
            [].forEach.call(list.querySelectorAll('li.active'), function (x) { x.classList.remove('active'); });
            if (li) li.classList.add('active');
          }
          vids.forEach(function (v) {
            var li = document.createElement('li');
            li.dataset.live = v[2];
            var b = document.createElement('button');
            b.innerHTML = '<img src="https://i.ytimg.com/vi/' + v[0] + '/mqdefault.jpg" loading="lazy" alt="">'
              + '<span class="meta">' + (v[2] ? '<span class="lv">LIVE</span>' : '') + v[1].replace(/</g, '&lt;') + '</span>';
            b.addEventListener('click', function () { markActive(li); play(v[0]); });
            li.appendChild(b);
            list.appendChild(li);
          });
          var pf = document.getElementById('panelFilter');
          pf.querySelector('[data-f="all"]').textContent = W.all || 'All';
          pf.querySelector('[data-f="live"]').textContent = W.liveBtn || '\ud83d\udd34 Live';
          pf.querySelector('[data-f="video"]').textContent = W.videosBtn || '\ud83c\udfac Videos';
          [].forEach.call(pf.querySelectorAll('button'), function (x) { x.classList.toggle('active', x.dataset.f === 'all'); });
          if (vids.length) {
            var idx = autoplayRandom ? Math.floor(Math.random() * vids.length) : 0;
            markActive(list.children[idx]);
            play(vids[idx][0]);
          } else {
            document.getElementById('player').innerHTML = '';
          }
        }
        window.openCountry = function (ds) {
          openPanel({ code: ds.code, name: ds.name, live: Number(ds.live), video: Number(ds.video), href: ds.href });
        };
        function play(id) {
          window.__playingId = id;
          document.getElementById('player').innerHTML =
            '<iframe src="https://www.youtube.com/embed/' + id + '?autoplay=1&mute=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>';
          renderCamMeta(id);
        }
        function closePanel() {
          panel.classList.remove('open');
          document.body.classList.remove('panel-open');
          document.getElementById('player').innerHTML = '';
          var gsl = document.getElementById('globeSelLabel');
          if (gsl) gsl.hidden = true;
          clearInterval(selLabelTimer);
          selectedCode = null;
          window.__selCode = null;
          globe.pointsData(GC);
          if (window.__repaintMap) window.__repaintMap();
          globe.controls().autoRotate = true;
        }
        document.getElementById('panelClose').addEventListener('click', closePanel);
        // 패널이 열려 있을 때 바깥(지도/지구본·패널 외 영역)을 클릭하거나 Esc를 누르면 닫는다.
        // 지도·지구본·랜덤 버튼은 .map-globe-row 안에 있어 클릭해도 닫히지 않는다(패널을 여는/바꾸는 조작).
        document.addEventListener('click', function (e) {
          if (!panel.classList.contains('open')) return;
          if (e.target.closest('#panel') || e.target.closest('.map-globe-row')) return;
          closePanel();
        });
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
        });
        document.getElementById('randomBtn').addEventListener('click', function () {
          var pool = [];
          GC.forEach(function (c) { for (var i = 0; i < c.live + c.video; i++) pool.push(c); });
          openPanel(pool[Math.floor(Math.random() * pool.length)], true);
        });
        document.getElementById('panelFilter').addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (!b) return;
          [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('active', x === b); });
          var f = b.dataset.f;
          [].forEach.call(document.getElementById('camList').children, function (li) {
            li.style.display = (f === 'all' || (f === 'live') === (li.dataset.live === '1')) ? '' : 'none';
          });
        });
        (function () {
          // 패널 좌우 폭 드래그로 조정 (기기별 저장) — 데스크톱만.
          // panel.style.width 대신 --panel-w 커스텀 프로퍼티를 갱신한다: .panel과 body.panel-open의
          // padding-right가 같은 값을 참조하므로, 드래그하는 동안 본문(지도·목록)도 실시간으로 따라 밀린다.
          var handle = document.getElementById('panelResize');
          var saved = localStorage.getItem('panelWidth');
          if (saved && window.innerWidth > 900) document.documentElement.style.setProperty('--panel-w', saved + 'px');
          var dragging = false;
          handle.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; });
          window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var w = Math.max(320, Math.min(window.innerWidth - e.clientX, window.innerWidth - 80));
            document.documentElement.style.setProperty('--panel-w', w + 'px');
          });
          window.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false; document.body.style.userSelect = '';
            var w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-w'), 10);
            if (w) localStorage.setItem('panelWidth', w);
          });
        })();
      </script>
      <h2 id="hCat">By Category</h2>
      <ul class="browse-list">
        ${categoryPages.map(c => `<li><a href="/c/${c.key}.html" data-cat data-icon="${c.icon || ''}" data-lko="${escapeHtml(c.labels.ko || c.label)}" data-lja="${escapeHtml(c.labels.ja || c.label)}" data-lzh="${escapeHtml(c.labels.zh || c.label)}" data-les="${escapeHtml(c.labels.es || c.label)}">${c.icon ? c.icon + ' ' : ''}${escapeHtml(c.label)}</a> <span class="count">(${c.count})</span></li>`).join('')}
      </ul>
      <h2 id="hCountry">By Country</h2>
      <ul class="browse-list">
        ${countryPages.map(c => `<li><a href="/country/${c.slug}.html" data-code="${c.code}">${escapeHtml(c.name)}</a> <span class="count">(${c.count})</span></li>`).join('')}
      </ul>
      <h2 id="hOperator">By Operator</h2>
      <ul class="browse-list">
        ${channels.map(c => `<li><a href="/ch/${c.slug}.html">${escapeHtml(c.title)}</a> <span class="count">(${c.list.length})</span></li>`).join('')}
      </ul>
      <p style="margin-top:24px"><a href="/longest-running-live-cams.html">The longest-running live cams on YouTube &rarr;</a></p>
      <script>
        // 본 사이트의 언어 설정(localStorage 'lang')을 그대로 따라 페이지 문구를 바꾼다
        (function () {
          var dict = {
            en: { back: '\\u2190 Back to site', h1: 'Browse by Country & Category', intro: '{n} live cams and videos, organized by where and what they show. Updated {d}.', byCategory: 'By Category', byCountry: 'By Country', mapNote: 'Hover a country to see how many cams it has \\u2014 click to browse. Scroll to zoom, drag to pan.', show: 'Show:', all: 'All', liveBtn: '\\ud83d\\udd34 Live', videosBtn: '\\ud83c\\udfac Videos', none: 'None', live: 'Live', videos: 'Videos', intl: 'International / Mixed', ghint: 'Drag to spin \\u00b7 click a point to watch', random: '\\ud83c\\udfb2 Random cam', browseAll: 'Browse all \\u2192', selected: 'Selected:' },
            ko: { back: '\\u2190 사이트로 돌아가기', h1: '국가·카테고리별 둘러보기', intro: '{n}개의 라이브 캠과 영상을 장소·내용별로 정리했습니다. {d} 업데이트.', byCategory: '카테고리별', byCountry: '국가별', mapNote: '나라에 마우스를 올리면 캠 개수가 보이고, 클릭하면 해당 나라 영상으로 이동합니다. 스크롤로 확대, 드래그로 이동.', show: '표시:', all: '전체', liveBtn: '\\ud83d\\udd34 라이브', videosBtn: '\\ud83c\\udfac 일반영상', none: '없음', live: '라이브', videos: '일반영상', intl: '국제/혼합', ghint: '드래그로 회전 \\u00b7 포인트를 클릭해 시청', random: '\\ud83c\\udfb2 랜덤 캠', browseAll: '전체 보기 \\u2192', selected: '선택됨:' },
            ja: { back: '\\u2190 サイトへ戻る', h1: '国・カテゴリ別に見る', intro: '{n}件のライブカメラと動画を場所と内容で整理。{d} 更新。', byCategory: 'カテゴリ別', byCountry: '国別', mapNote: '国にカーソルを合わせると台数が表示され、クリックでその国の映像へ移動します。スクロールで拡大、ドラッグで移動。', show: '表示:', all: 'すべて', liveBtn: '\\ud83d\\udd34 ライブ', videosBtn: '\\ud83c\\udfac 動画', none: 'なし', live: 'ライブ', videos: '動画', intl: '国際/混合', ghint: 'ドラッグで回転 \\u00b7 ポイントをクリックで視聴', random: '\\ud83c\\udfb2 ランダム', browseAll: 'すべて見る \\u2192', selected: '選択中:' },
            zh: { back: '\\u2190 返回网站', h1: '按国家和分类浏览', intro: '{n}个直播摄像头和视频，按地点和内容整理。{d} 更新。', byCategory: '按分类', byCountry: '按国家', mapNote: '将鼠标悬停在国家上可查看数量，点击进入该国视频。滚动缩放，拖动平移。', show: '显示:', all: '全部', liveBtn: '\\ud83d\\udd34 直播', videosBtn: '\\ud83c\\udfac 视频', none: '无', live: '直播', videos: '视频', intl: '国际/混合', ghint: '拖动旋转 \\u00b7 点击圆点观看', random: '\\ud83c\\udfb2 随机', browseAll: '查看全部 \\u2192', selected: '已选择:' },
            es: { back: '\\u2190 Volver al sitio', h1: 'Explorar por país y categoría', intro: '{n} cámaras en vivo y videos, organizados por lugar y contenido. Actualizado {d}.', byCategory: 'Por categoría', byCountry: 'Por país', mapNote: 'Pasa el cursor sobre un país para ver cuántas cámaras tiene; haz clic para explorarlas. Rueda para acercar, arrastra para mover.', show: 'Mostrar:', all: 'Todo', liveBtn: '\\ud83d\\udd34 En vivo', videosBtn: '\\ud83c\\udfac Videos', none: 'Ninguno', live: 'En vivo', videos: 'Videos', intl: 'Internacional/Mixto', ghint: 'Arrastra para girar \\u00b7 clic para ver', random: '\\ud83c\\udfb2 Aleatoria', browseAll: 'Ver todo \\u2192', selected: 'Seleccionado:' },
          };
          // 본 사이트(i18n.js detectInitialLang)와 동일: 저장된 설정이 없으면 무조건 영어
          var lang = localStorage.getItem('lang') || 'en';
          if (!dict[lang]) lang = 'en';
          var L = dict[lang];
          window.__L = L;
          if (lang === 'en') return;
          document.getElementById('backLink').textContent = L.back;
          document.getElementById('browseH1').textContent = L.h1;
          var intro = document.querySelector('.browse-intro');
          intro.textContent = L.intro.replace('{n}', intro.dataset.n).replace('{d}', intro.dataset.d);
          document.getElementById('hCat').textContent = L.byCategory;
          document.getElementById('hCountry').textContent = L.byCountry;
          var mhn = document.getElementById('mapHoverNote'); if (mhn) mhn.textContent = L.mapNote;
          var gh = document.getElementById('globeHint'); if (gh) gh.textContent = L.ghint;
          var rb = document.getElementById('randomBtn'); if (rb) rb.textContent = L.random;
          var ba = document.getElementById('browseAll'); if (ba) ba.textContent = L.browseAll;
          var mtf = document.querySelector('.map-type-filter');
          mtf.childNodes[0].textContent = L.show + ' ';
          mtf.querySelector('[data-type="all"]').textContent = L.all;
          mtf.querySelector('[data-type="live"]').textContent = L.liveBtn;
          mtf.querySelector('[data-type="video"]').textContent = L.videosBtn;
          var none = document.querySelector('.legend-none');
          if (none) none.textContent = L.none;
          document.querySelectorAll('a[data-cat]').forEach(function (a) {
            var label = a.dataset['l' + lang];
            if (label) a.textContent = (a.dataset.icon ? a.dataset.icon + ' ' : '') + label;
          });
          var dn = null;
          try { dn = new Intl.DisplayNames([lang], { type: 'region' }); } catch (e) {}
          function localName(code) {
            if (code === 'XX') return L.intl;
            if (!dn) return null;
            try { return dn.of(code); } catch (e) { return null; }
          }
          document.querySelectorAll('a[data-code]').forEach(function (a) {
            var n = localName(a.dataset.code);
            if (n) a.textContent = n;
          });
          document.querySelectorAll('.map-wrap path[data-code]').forEach(function (p) {
            var n = localName(p.dataset.code);
            if (n) p.dataset.name = n;
          });
        })();
        // 인트로의 영상 개수는 생성 시점에 박히므로, 페이지 열 때 실시간 개수로 갱신 (첫 숫자만 교체)
        (function () {
          fetch('${SUPABASE_URL}/rest/v1/streams?select=video_id&status=eq.live&title=not.is.null&or=(approval_status.is.null,approval_status.neq.pending)&or=(visibility.is.null,visibility.eq.listed)', {
            headers: { apikey: '${SUPABASE_ANON_KEY}', Prefer: 'count=exact', Range: '0-0' },
          }).then(function (r) {
            var cr = r.headers.get('content-range') || '';
            var n = Number((cr.split('/')[1] || '').trim());
            if (!n) return;
            var intro = document.querySelector('.browse-intro');
            intro.dataset.n = n;
            intro.textContent = intro.textContent.replace(/[\\d,]+/, n.toLocaleString());
          }).catch(function () {});
        })();
      </script>`,
  });
  await writeFile(path.join(ROOT, 'browse.html'), browseHtml);

  // ===== sitemap.xml =====
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
  await writeFile(path.join(ROOT, 'sitemap.xml'), sitemap);
  console.log(`sitemap.xml 갱신 (URL ${sitemapUrls.length}개)`);

  // ===== 더 이상 생성되지 않는 옛 페이지 정리 =====
  // 조합 페이지는 캠 수가 COMBO_MIN 밑으로 떨어지면 다음 실행부터 안 만들어지는데, 예전에 써둔
  // 파일은 그대로 남아 계속 서빙된다. 사이트맵과 내부 링크에서는 빠졌는데 URL만 살아있는 이런
  // 고아 페이지가 바로 애드센스가 '가치 없는 콘텐츠'로 집어내는 대상이다(내용도 갱신이 멈춘 채다).
  const keepPaths = new Set(
    sitemapUrls.map(u => u.loc.slice(SITE.length + 1))
      .filter(p => p.startsWith('c/') || p.startsWith('country/') || p.startsWith('ch/'))
  );
  const pruned = [];
  const pruneDir = async (dir, isTop) => {
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { await pruneDir(full, false); continue; }
      if (!it.name.endsWith('.html')) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (keepPaths.has(rel)) continue;
      await rm(full);
      pruned.push(rel);
    }
    // 조합이 통째로 사라진 나라는 빈 폴더만 남으므로 같이 치운다 (c/·country/ 자신은 유지)
    if (!isTop) { try { await rmdir(dir); } catch { /* 비어있지 않으면 그대로 둔다 */ } }
  };
  for (const top of ['c', 'country', 'ch']) await pruneDir(path.join(ROOT, top), true);
  if (pruned.length) {
    console.log(`고아 페이지 ${pruned.length}개 삭제:`);
    for (const p of pruned) console.log(`  - ${p}`);
  } else {
    console.log('고아 페이지 없음');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
