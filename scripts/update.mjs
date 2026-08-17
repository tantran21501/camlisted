// 매일 실행: data/streams.json(카탈로그)을 갱신한다. DB 없이 JSON 파일만 사용한다.
// 1) 기존 행 생존 확인 — 중지되면 삭제하지 않고 status='offline'으로 기록 보존, 다시 라이브면 'live'로 복귀
// 2) 오탐(제외 키워드)은 확정 삭제
// 3) 키워드 검색으로 신규 라이브 CCTV 후보 탐색 및 검증 후 추가
// 4) 카테고리 자동분류, 채널 국가, 라이브 시작 시각을 함께 채워넣음
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadStreams, saveStreams,
  loadBlocklist, saveBlocklist,
  loadBlockedChannels,
  loadScannedChannels, saveScannedChannels,
  loadChannelSeeds, saveChannelSeeds,
  loadCategories,
} from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEYWORDS_PATH = path.join(ROOT, 'config', 'keywords.json');
const KEYWORDS_VIDEO_PATH = path.join(ROOT, 'config', 'keywords-video.json');
const EXCLUDE_KEYWORDS_PATH = path.join(ROOT, 'config', 'exclude-keywords.json');
const NO_EMBED_KEYWORDS_PATH = path.join(ROOT, 'config', 'no-embed-keywords.json');

const API_KEY = process.env.YOUTUBE_API_KEY;
const BASE = 'https://www.googleapis.com/youtube/v3';

if (!API_KEY) {
  console.error('환경변수 YOUTUBE_API_KEY 가 설정되어 있지 않습니다.');
  process.exit(1);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }
  return res.json();
}

// 조건 태그(일반 영상 전용): 제목에서 날씨/시간/사건 태그를 뽑는다.
// 밤/낮/눈은 CLIP 썸네일 분석(classify_thumbnails.py)이 보완한다.
const TAG_KEYWORDS = {
  night: ['night', 'nightlife', 'nighttime', 'nightvision', '밤 ', '야간', '심야', '夜', 'noche', 'nuit'],
  rain: ['rain', 'rainy', '빗길', '우천', '비오는', '雨', 'lluvia'],
  heavy_rain: ['heavy rain', 'torrential', '폭우', '호우', '豪雨', '暴雨'],
  snow: ['snow', 'snowstorm', 'snowfall', '눈길', '눈오는', '雪', 'nieve'],
  heavy_snow: ['heavy snow', 'blizzard', '폭설', '大雪', '暴雪'],
  accident: ['accident', 'crash', '사고', '추돌', '충돌', '事故', 'accidente'],
  fire: ['fire', 'wildfire', 'bushfire', '화재', '火災', '火灾', 'incendio'],
  violence: ['fight', 'assault', 'brawl', '싸움', '폭행', '몸싸움', '난투'],
};

// 라틴 문자 키워드는 단어 경계를 요구한다. 부분문자열로 보면 'train'·'Ukraine'·'terrain'이
// 전부 rain(비)이 되고 'firefighter'가 fire와 violence(fight)를 동시에 달았다.
// 한글·일본어·중국어는 단어 경계라는 게 없으므로 기존대로 포함 검사한다.
const TAG_MATCHERS = Object.fromEntries(
  Object.entries(TAG_KEYWORDS).map(([tag, kws]) => [tag, kws.map(k => {
    if (!/^[\x20-\x7e]+$/.test(k)) return { test: (h) => h.includes(k) };
    const esc = k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}(?:e?s)?\\b`, 'i');
  })])
);

function tagsFromTitle(title) {
  const haystack = (title || '').toLowerCase();
  const tags = [];
  for (const [tag, matchers] of Object.entries(TAG_MATCHERS)) {
    if (tag === 'fire' && haystack.includes('firework')) continue;
    if (matchers.some(m => m.test(haystack))) tags.push(tag);
  }
  if (tags.includes('heavy_rain') && !tags.includes('rain')) tags.push('rain');
  if (tags.includes('heavy_snow') && !tags.includes('snow')) tags.push('snow');
  return tags;
}

// 제목 지명 → 국가 추정. 채널 국가는 "운영자의 나라"라 촬영지와 다를 수 있어서,
// 제목에 명확한 도시/나라명이 있으면 그쪽을 우선한다 (모호한 지명은 넣지 않음).
// 배열 순서가 우선순위: 'new mexico'(US)가 'mexico'(MX)보다, 'venice beach'(US)가 'venice'(IT)보다 먼저.
const TITLE_COUNTRY_RULES = [
  ['US', ['usa', 'new york', 'nyc', 'times square', 'new mexico', 'venice beach', 'los angeles', 'san francisco', 'chicago', 'miami', 'seattle', 'las vegas', 'hawaii', 'florida', 'california', 'texas', 'alaska', 'boston', 'new orleans', 'washington dc', '미국', 'ニューヨーク']],
  ['KR', ['korea', 'seoul', 'busan', 'incheon', 'gangnam', 'jeju', '서울', '부산', '인천', '대구', '대전', '울산', '제주', '경기', '강원', '한국', '韓国', 'ソウル', '釜山']],
  ['JP', ['japan', 'tokyo', 'osaka', 'kyoto', 'shibuya', 'shinjuku', 'nagoya', 'fukuoka', 'sapporo', 'okinawa', 'akihabara', '일본', '도쿄', '오사카', '日本', '東京', '大阪', '京都', '渋谷', '新宿', '沖縄', '札幌', '福岡', '県', 'ライブカメラ']],
  ['CN', ['beijing', 'shanghai', 'shenzhen', 'guangzhou', 'chongqing', '中国', '北京', '上海', '深圳', '广州', '중국']],
  ['TW', ['taiwan', 'taipei', '台湾', '台灣', '台北', '대만']],
  ['HK', ['hong kong', '香港', '홍콩']],
  // 'タイ'는 リアルタイム(리얼타임) 등에 부분일치로 걸리는 오탐이 있어 제외
  ['TH', ['thailand', 'bangkok', 'pattaya', 'phuket', 'chiang mai', '태국', '방콕']],
  ['VN', ['vietnam', 'hanoi', 'saigon', 'ho chi minh', 'da nang', '베트남', '하노이']],
  ['PH', ['philippines', 'manila', 'cebu', '필리핀']],
  ['ID', ['indonesia', 'jakarta', 'bali', '인도네시아', '발리']],
  ['MY', ['malaysia', 'kuala lumpur', '말레이시아']],
  ['SG', ['singapore', '싱가포르', 'シンガポール']],
  ['IN', ['india', 'mumbai', 'delhi', 'bangalore', 'kolkata', '인도 ']],
  ['PK', ['pakistan', 'karachi', 'lahore']],
  ['BD', ['bangladesh', 'dhaka']],
  ['LK', ['sri lanka', 'colombo']],
  ['NP', ['nepal', 'kathmandu']],
  ['KH', ['cambodia', 'phnom penh', 'angkor', '캄보디아']],
  ['LA', ['laos', 'vientiane']],
  ['MM', ['myanmar', 'yangon']],
  ['GB', ['london', 'england', 'scotland', 'wales', 'manchester', 'liverpool', 'edinburgh', '영국', '런던', 'ロンドン']],
  ['DE', ['germany', 'berlin', 'munich', 'hamburg', 'frankfurt', 'cologne', 'deutschland', 'münchen', '독일', '베를린']],
  ['FR', ['france', 'paris', 'marseille', 'lyon', '프랑스', '파리', 'パリ']],
  ['IT', ['italy', 'italia', 'rome', 'roma', 'venice', 'venezia', 'milan', 'milano', 'naples', 'napoli', '이탈리아', '로마', '베네치아']],
  ['ES', ['spain', 'madrid', 'barcelona', 'sevilla', 'mallorca', 'tenerife', 'canary', 'espana', 'españa', '스페인', '바르셀로나']],
  ['PT', ['portugal', 'lisbon', 'lisboa', '포르투갈']],
  ['NL', ['netherlands', 'amsterdam', 'rotterdam', 'holland', '네덜란드']],
  ['BE', ['belgium', 'brussels', '벨기에']],
  ['CH', ['switzerland', 'zurich', 'geneva', '스위스']],
  ['AT', ['austria', 'vienna', 'wien', '오스트리아']],
  ['CZ', ['czech', 'prague', 'praha', '프라하']],
  ['PL', ['poland', 'warsaw', 'krakow', '폴란드']],
  ['HU', ['hungary', 'budapest', '헝가리', '부다페스트']],
  ['GR', ['greece', 'athens', 'santorini', 'crete', '그리스', '산토리니']],
  ['TR', ['turkey', 'türkiye', 'istanbul', 'antalya', '터키', '이스탄불']],
  ['RU', ['russia', 'moscow', 'петербург', 'москва', '러시아', '모스크바']],
  ['UA', ['ukraine', 'kyiv', 'kiev', 'odessa', '우크라이나']],
  ['RO', ['romania', 'bucharest', '루마니아']],
  ['HR', ['croatia', 'zagreb', '크로아티아']],
  ['RS', ['serbia', 'belgrade']],
  ['NO', ['norway', 'oslo', '노르웨이']],
  ['SE', ['sweden', 'stockholm', '스웨덴']],
  ['FI', ['finland', 'helsinki', '핀란드']],
  ['DK', ['denmark', 'copenhagen', '덴마크']],
  ['IS', ['iceland', 'reykjavik', '아이슬란드']],
  ['IE', ['ireland', 'dublin', '아일랜드']],
  ['AE', ['dubai', 'abu dhabi', '두바이']],
  ['SA', ['saudi', 'riyadh', 'mecca']],
  ['IL', ['israel', 'tel aviv']],
  ['EG', ['egypt', 'cairo', '이집트']],
  ['MA', ['morocco', 'marrakech', '모로코']],
  ['KE', ['kenya', 'nairobi', '케냐']],
  ['NA', ['namibia', 'namib']],
  ['ZA', ['south africa', 'cape town', 'johannesburg', '남아공']],
  ['BR', ['brazil', 'brasil', 'rio de janeiro', 'sao paulo', 'copacabana', '브라질']],
  ['AR', ['argentina', 'buenos aires', '아르헨티나']],
  ['CL', ['chile', 'santiago', '칠레']],
  ['PE', ['peru', 'lima', 'machu picchu', '페루']],
  ['CO', ['colombia', 'bogota', 'medellin', '콜롬비아']],
  ['CR', ['costa rica', '코스타리카']],
  ['CU', ['cuba', 'havana', '쿠바']],
  ['MX', ['mexico', 'cancun', 'guadalajara', '멕시코', '칸쿤']],
  ['CA', ['canada', 'toronto', 'vancouver', 'montreal', 'niagara', '캐나다', '토론토', '나이아가라']],
  ['AU', ['australia', 'sydney', 'melbourne', 'brisbane', 'gold coast', '호주', '시드니']],
  ['NZ', ['new zealand', 'auckland', 'queenstown', '뉴질랜드']],
];

// 제목에 쓰인 문자(스크립트)로 나라를 추정 — 지명 사전으로 못 잡을 때의 보조 신호.
function inferCountryFromScript(title) {
  const s = String(title || '');
  if (/[぀-ヿ]/.test(s)) return 'JP'; // 히라가나·가타카나
  if (/[가-힣]/.test(s)) return 'KR'; // 한글
  if (/[฀-๿]/.test(s)) return 'TH'; // 태국
  if (/[֐-׿]/.test(s)) return 'IL'; // 히브리
  if (/[ऀ-ॿ]/.test(s)) return 'IN'; // 데바나가리
  if (/[ঀ-৿]/.test(s)) return 'BD'; // 벵골
  if (/[຀-໿]/.test(s)) return 'LA'; // 라오
  if (/[က-႟]/.test(s)) return 'MM'; // 미얀마
  return null;
}

// 제목으로 나라 추정: (1) 지명 사전 → (2) 문자(스크립트) 보조
function inferCountryFromTitle(title) {
  const lower = String(title || '').toLowerCase();
  for (const [code, patterns] of TITLE_COUNTRY_RULES) {
    for (const p of patterns) {
      if (/^[a-z0-9 .'-]+$/.test(p)) {
        const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`).test(lower)) return code;
      } else if (lower.includes(p.toLowerCase())) {
        return code;
      }
    }
  }
  return inferCountryFromScript(title);
}

// 세로 영상(쇼츠 등) 판별 — videos.list의 player 파트에 maxHeight를 지정하면
// 실제 영상 비율대로 embedWidth/embedHeight가 내려온다.
function isVerticalInfo(info) {
  const w = Number(info?.player?.embedWidth);
  const h = Number(info?.player?.embedHeight);
  return !!(w && h && h > w);
}

// ISO 8601 재생시간(PT1H2M3S)을 초 단위로 변환
function parseDurationSeconds(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

// videoId -> {snippet, liveStreamingDetails, status, player, contentDetails} 맵으로 반환
async function getVideoInfo(videoIds) {
  const map = new Map();
  for (const batch of chunk(videoIds, 50)) {
    if (batch.length === 0) continue;
    const url = `${BASE}/videos?part=snippet,liveStreamingDetails,status,player,contentDetails&maxHeight=720&id=${batch.join(',')}&key=${API_KEY}`;
    const data = await fetchJson(url);
    for (const item of data.items || []) {
      map.set(item.id, {
        snippet: item.snippet,
        liveStreamingDetails: item.liveStreamingDetails || {},
        status: item.status || {},
        player: item.player || {},
        contentDetails: item.contentDetails || {},
      });
    }
  }
  return map;
}

// 라이브가 다시보기(VOD) 저장 없이 끝나면 재생 가능한 콘텐츠가 없다 — duration으로 걸러낸다.
function hasPlayableDuration(info) {
  const secs = parseDurationSeconds(info?.contentDetails?.duration);
  return secs != null && secs > 0;
}

function isValidFor(contentType, info) {
  if (!info) return false;
  if (contentType === 'video') {
    return (info.status?.privacyStatus === 'public' || info.status?.privacyStatus === 'unlisted') && hasPlayableDuration(info);
  }
  return info.snippet?.liveBroadcastContent === 'live';
}

// API 응답으로 실제 content_type을 판별한다. (등록 시 잘못 골랐어도 여기서 교정)
function trueContentType(info) {
  if (!info) return null;
  if (info.snippet?.liveBroadcastContent === 'live') return 'live';
  if ((info.status?.privacyStatus === 'public' || info.status?.privacyStatus === 'unlisted') && hasPlayableDuration(info)) return 'video';
  return null;
}

async function getChannelCountries(channelIds) {
  const map = new Map();
  const uniqueIds = [...new Set(channelIds.filter(Boolean))];
  for (const batch of chunk(uniqueIds, 50)) {
    if (batch.length === 0) continue;
    const url = `${BASE}/channels?part=snippet&id=${batch.join(',')}&key=${API_KEY}`;
    const data = await fetchJson(url);
    for (const item of data.items || []) {
      if (item.snippet?.country) map.set(item.id, item.snippet.country);
    }
  }
  return map;
}

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};
function decodeHtmlEntities(str) {
  return (str || '').replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, m => HTML_ENTITIES[m]);
}

function snippetThumbnail(snippet) {
  return (
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url
  );
}

async function searchLiveByKeyword(keyword, maxResults = 25) {
  const url = `${BASE}/search?part=snippet&type=video&eventType=live&maxResults=${maxResults}&q=${encodeURIComponent(keyword)}&key=${API_KEY}`;
  const data = await fetchJson(url);
  return (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title),
      channelTitle: decodeHtmlEntities(item.snippet.channelTitle),
      channelId: item.snippet.channelId,
      thumbnail: snippetThumbnail(item.snippet),
      matchedKeyword: keyword,
      contentType: 'live',
    }));
}

async function searchChannelLive(channelId, maxResults = 25) {
  const url = `${BASE}/search?part=snippet&type=video&eventType=live&channelId=${channelId}&maxResults=${maxResults}&key=${API_KEY}`;
  const data = await fetchJson(url);
  return (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title),
      channelTitle: decodeHtmlEntities(item.snippet.channelTitle),
      channelId: item.snippet.channelId,
      thumbnail: snippetThumbnail(item.snippet),
      matchedKeyword: 'channel scan',
      contentType: 'live',
    }));
}

async function searchChannelVideos(channelId, maxResults = 25) {
  const url = `${BASE}/search?part=snippet&type=video&order=date&channelId=${channelId}&maxResults=${maxResults}&key=${API_KEY}`;
  const data = await fetchJson(url);
  return (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title),
      channelTitle: decodeHtmlEntities(item.snippet.channelTitle),
      channelId: item.snippet.channelId,
      thumbnail: snippetThumbnail(item.snippet),
      matchedKeyword: 'channel scan',
      contentType: item.snippet.liveBroadcastContent === 'live' ? 'live' : 'video',
    }));
}

async function searchVideoByKeyword(keyword, maxResults = 25) {
  const url = `${BASE}/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(keyword)}&key=${API_KEY}`;
  const data = await fetchJson(url);
  return (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet.title),
      channelTitle: decodeHtmlEntities(item.snippet.channelTitle),
      channelId: item.snippet.channelId,
      thumbnail: snippetThumbnail(item.snippet),
      matchedKeyword: keyword,
      contentType: 'video',
    }));
}

// search.list는 하루 100회로 고정. 실행당 검색 예산 (하루 두 번 돌리므로 반으로 나눔).
const SEARCH_BUDGET_PER_RUN = 47;
const MAX_LIVE_KEYWORDS_PER_RUN = 20;
const MAX_VIDEO_KEYWORDS_PER_RUN = 20;

function selectRotatingSubset(list, maxPerRun) {
  if (list.length <= maxPerRun) return list;
  const dayIndex = Math.floor(Date.now() / 86400000);
  const start = (dayIndex * maxPerRun) % list.length;
  const subset = [];
  for (let i = 0; i < maxPerRun; i++) {
    subset.push(list[(start + i) % list.length]);
  }
  return subset;
}

async function main() {
  const [keywordsRaw, keywordsVideoRaw, excludeRaw, noEmbedRaw] = await Promise.all([
    readFile(KEYWORDS_PATH, 'utf-8'),
    readFile(KEYWORDS_VIDEO_PATH, 'utf-8').catch(() => '{"keywords":[]}'),
    readFile(EXCLUDE_KEYWORDS_PATH, 'utf-8').catch(() => '{"keywords":[]}'),
    readFile(NO_EMBED_KEYWORDS_PATH, 'utf-8').catch(() => '{"keywords":[]}'),
  ]);
  const keywords = JSON.parse(keywordsRaw).keywords || [];
  const keywordsVideo = JSON.parse(keywordsVideoRaw).keywords || [];
  const excludeKeywords = (JSON.parse(excludeRaw).keywords || []).map(k => k.toLowerCase());
  const compilePatterns = (key) => (JSON.parse(excludeRaw)[key] || []).flatMap(p => {
    try { return [new RegExp(p, 'i')]; }
    catch { console.warn(`  제외 패턴 컴파일 실패(무시): ${key} / ${p}`); return []; }
  });
  const junkPatterns = compilePatterns('patterns_all');
  const videoJunkPatterns = compilePatterns('patterns_video');
  const noEmbedKeywords = (JSON.parse(noEmbedRaw).keywords || []).map(k => k.toLowerCase());

  const [categoryRows, blocklistRows, blockedChannelRows, channelSeeds] = await Promise.all([
    loadCategories(),
    loadBlocklist(),
    loadBlockedChannels(),
    loadChannelSeeds(),
  ]);
  const categories = categoryRows.filter(c => c.key !== 'other');
  const blockedIds = new Set(blocklistRows.map(r => r.video_id));
  const blockedChannelIds = new Set(blockedChannelRows.map(r => r.channel_id));

  // 재시작 루프 차단: 관리자가 지운 라이브는 채널이 방송을 껐다 켜면 새 videoId로 돌아오므로
  // (채널ID, 제목) 쌍과 일치하는 후보를 검색 단계에서 함께 걸러낸다.
  const normTitle = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const blockedPairs = new Set(
    blocklistRows.filter(r => r.channel_id && r.title).map(r => `${r.channel_id}::${normTitle(r.title)}`)
  );
  const isBlockedRestart = (r) =>
    r.channelId && r.title && blockedPairs.has(`${r.channelId}::${normTitle(r.title)}`);
  console.log(`차단목록: videoId ${blockedIds.size}건, 채널 ${blockedChannelIds.size}건, (채널,제목) 쌍 ${blockedPairs.size}건`);

  const isExcluded = (title, channelTitle) => {
    const haystack = `${title} ${channelTitle}`.toLowerCase();
    return excludeKeywords.some(k => haystack.includes(k));
  };
  const isJunkTitle = (title, channelTitle) => {
    const haystack = `${title} ${channelTitle}`.toLowerCase();
    return junkPatterns.some(re => re.test(haystack));
  };
  const isJunkVideo = (title, channelTitle) => {
    const haystack = `${title} ${channelTitle}`.toLowerCase();
    return videoJunkPatterns.some(re => re.test(haystack));
  };
  const isNoEmbed = (title, channelTitle) => {
    const haystack = `${title} ${channelTitle}`.toLowerCase();
    return noEmbedKeywords.some(k => haystack.includes(k));
  };

  const classifyCategory = (title, channelTitle) => {
    const haystack = `${title} ${channelTitle}`.toLowerCase();
    for (const row of categories) {
      if ((row.keywords || []).some(k => haystack.includes(k.toLowerCase()))) return row.key;
    }
    return 'other';
  };

  // JSON 상태 로드. 배열의 객체 참조를 그대로 수정하면 저장은 마지막에 한 번만 하면 된다.
  const snapshot = await loadStreams();
  const streams = snapshot.streams;
  const existingRows = streams;
  console.log(`기존 목록 ${existingRows.length}건 생존 확인 중...`);

  const infoMap = await getVideoInfo(existingRows.map(r => r.video_id));
  const blocklistAdds = []; // {video_id, channel_id?, title?, created_at}
  const addToBlocklist = (video_id, channel_id, title) => {
    const rec = { video_id, created_at: new Date().toISOString() };
    if (channel_id) rec.channel_id = channel_id;
    if (title) rec.title = title;
    blocklistAdds.push(rec);
  };

  const toDelete = [];
  const verticalIds = [];
  const HAS_EMBEDDABLE = existingRows.length > 0 && 'embeddable' in existingRows[0];
  let validCount = 0;
  let offlineCount = 0;

  for (const row of existingRows) {
    let contentType = row.content_type || 'live';
    const info = infoMap.get(row.video_id);

    // 세로 영상(쇼츠 등)은 사이트 성격에 안 맞음 -> 삭제 + 차단목록 (비율은 안 변하니 재수집 방지)
    if (info && isVerticalInfo(info)) {
      verticalIds.push(row.video_id);
      continue;
    }

    // 임베드 차단 영상: 삭제하지 않고 embeddable=false로 표시 → 썸네일 + 유튜브 링크로 노출
    const embOk = !info || info.status?.embeddable !== false;

    // content_type 자동 교정
    const correctType = trueContentType(info);
    const contentTypeFixed = correctType && correctType !== contentType ? correctType : null;
    if (contentTypeFixed) contentType = contentTypeFixed;

    if (!isValidFor(contentType, info)) {
      // 아직 승인 안 된 대기 영상이 라이브 종료/비공개가 됐으면 오프라인 유예(7일) 없이 바로 삭제한다.
      if (row.approval_status === 'pending') {
        toDelete.push(row.video_id);
        continue;
      }
      offlineCount += 1;
      if (row.status !== 'offline' || !row.offline_since) {
        row.status = 'offline';
        row.offline_since = row.offline_since || new Date().toISOString();
      }
      continue;
    }

    const { snippet, liveStreamingDetails } = info;
    const title = decodeHtmlEntities(snippet.title);
    const channelTitle = decodeHtmlEntities(snippet.channelTitle);
    if (isExcluded(title, channelTitle)) {
      toDelete.push(row.video_id);
      continue;
    }

    validCount += 1;
    const embFinal = isNoEmbed(title, channelTitle) ? false : embOk;
    if (HAS_EMBEDDABLE && row.embeddable !== embFinal) {
      row.embeddable = embFinal;
    }
    if (contentTypeFixed) {
      row.content_type = contentTypeFixed;
      if (contentTypeFixed === 'video' && (row.thumbnail || '').includes('hqdefault_live')) {
        row.thumbnail = `https://i.ytimg.com/vi/${row.video_id}/hqdefault.jpg`;
      }
    }
    if (row.status !== 'live') {
      row.status = 'live';
      row.offline_since = null;
    }
    if (!row.title || !row.channel_title) {
      row.title = title;
      row.channel_title = channelTitle;
      row.thumbnail = row.thumbnail || snippetThumbnail(snippet);
    }
    if (!row.channel_id && snippet.channelId) {
      row.channel_id = snippet.channelId;
    }
    if (!row.category) {
      row.category = classifyCategory(title, channelTitle);
      row.category_source = 'keyword';
    }
    if (contentType === 'live' && !row.started_at && liveStreamingDetails?.actualStartTime) {
      row.started_at = liveStreamingDetails.actualStartTime;
    }
    if (contentType === 'video' && !row.published_at && snippet.publishedAt) {
      row.published_at = snippet.publishedAt;
    }
    if (contentType === 'video' && row.duration_seconds == null) {
      const dur = parseDurationSeconds(info.contentDetails?.duration);
      if (dur) row.duration_seconds = dur;
    }
    // 조건 태그가 아직 없는 일반 영상은 제목에서 1회 추출
    if (contentType === 'video' && (!row.tags || row.tags.length === 0)) {
      const titleTags = tagsFromTitle(title);
      if (titleTags.length) row.tags = titleTags;
    }
  }

  console.log(`  -> 유효 ${validCount}건, 오프라인 전환 ${offlineCount}건, 오탐 삭제 ${toDelete.length}건`);

  // 오탐 확정 삭제
  for (const id of toDelete) {
    const idx = streams.findIndex(r => r.video_id === id);
    if (idx >= 0) streams.splice(idx, 1);
  }

  // (1차) 제목(지명+언어)으로 나라를 (재)분류한다. 유저 수정('user')은 절대 건드리지 않는다.
  let titleInferred = 0;
  for (const row of existingRows) {
    if (row.country_source === 'user') continue;
    const inferred = inferCountryFromTitle(row.title);
    if (!inferred || inferred === row.country) continue;
    row.country = inferred;
    row.country_source = 'title';
    titleInferred += 1;
  }
  if (titleInferred) console.log(`제목으로 국가 분류/교정: ${titleInferred}건`);

  // (2차) 여전히 국가가 비어있는 유효한 행들은 channels.list의 채널 국가로 채움
  const rowsNeedingCountry = existingRows.filter(r =>
    !r.country && !['user', 'title'].includes(r.country_source) && isValidFor(r.content_type || 'live', infoMap.get(r.video_id)));
  const countryMap = await getChannelCountries(rowsNeedingCountry.map(r => infoMap.get(r.video_id)?.snippet?.channelId));
  for (const row of rowsNeedingCountry) {
    const channelId = infoMap.get(row.video_id)?.snippet?.channelId;
    const country = countryMap.get(channelId);
    if (country) {
      row.country = country;
      row.country_source = 'channel';
    }
  }

  // 신규 탐색: 이미 카탈로그에 존재하는(라이브/오프라인 불문) videoId는 후보에서 제외
  const knownIds = new Set([
    ...existingRows.map(r => r.video_id).filter(id => !toDelete.includes(id)),
    ...blockedIds,
  ]);
  const candidateMap = new Map();
  let searchCallsUsed = 0;

  const liveKeywordsToday = selectRotatingSubset(keywords, MAX_LIVE_KEYWORDS_PER_RUN);
  console.log(`라이브 키워드 검색: 전체 ${keywords.length}개 중 오늘 ${liveKeywordsToday.length}개 사용`);
  for (const keyword of liveKeywordsToday) {
    try {
      const results = await searchLiveByKeyword(keyword);
      searchCallsUsed += 1;
      for (const r of results) {
        if (knownIds.has(r.videoId) || candidateMap.has(r.videoId)) continue;
        if (r.channelId && blockedChannelIds.has(r.channelId)) continue;
        if (isExcluded(r.title, r.channelTitle)) continue;
        if (isBlockedRestart(r)) continue;
        candidateMap.set(r.videoId, r);
      }
      console.log(`  검색 "${keyword}": ${results.length}건 조회`);
    } catch (err) {
      searchCallsUsed += 1;
      console.error(`  검색 실패 "${keyword}":`, err.message);
    }
  }

  // 라이브 외 일반 영상(블랙박스/야생동물/군중 등) 탐색
  const videoKeywordsToday = selectRotatingSubset(keywordsVideo, MAX_VIDEO_KEYWORDS_PER_RUN);
  console.log(`영상 키워드 검색: 전체 ${keywordsVideo.length}개 중 오늘 ${videoKeywordsToday.length}개 사용`);
  for (const keyword of videoKeywordsToday) {
    try {
      const results = await searchVideoByKeyword(keyword);
      searchCallsUsed += 1;
      for (const r of results) {
        if (knownIds.has(r.videoId) || candidateMap.has(r.videoId)) continue;
        if (r.channelId && blockedChannelIds.has(r.channelId)) continue;
        if (isExcluded(r.title, r.channelTitle)) continue;
        if (isBlockedRestart(r)) continue;
        candidateMap.set(r.videoId, r);
      }
      console.log(`  영상 검색 "${keyword}": ${results.length}건 조회`);
    } catch (err) {
      searchCallsUsed += 1;
      console.error(`  영상 검색 실패 "${keyword}":`, err.message);
    }
  }

  // ===== 부족 카테고리 부스트 검색 =====
  const BOOST_SEARCHES_PER_RUN = 12;
  const BOOST_CATEGORY_COUNT = 6;
  const categoryCounts = new Map(categories.map(c => [c.key, 0]));
  for (const row of existingRows) {
    if (categoryCounts.has(row.category)) categoryCounts.set(row.category, categoryCounts.get(row.category) + 1);
  }
  const underfilled = [...categoryCounts.entries()].sort((a, b) => a[1] - b[1]).slice(0, BOOST_CATEGORY_COUNT);
  console.log(`부족 카테고리 부스트: ${underfilled.map(([k, n]) => `${k}(${n})`).join(', ')}`);
  const boostDayIndex = Math.floor(Date.now() / 86400000);
  const perBoostCategory = Math.max(1, Math.floor(BOOST_SEARCHES_PER_RUN / BOOST_CATEGORY_COUNT));
  for (const [catKey] of underfilled) {
    const catKeywords = categories.find(c => c.key === catKey)?.keywords || [];
    if (!catKeywords.length) continue;
    for (let i = 0; i < perBoostCategory; i++) {
      const kw = catKeywords[(boostDayIndex + i) % catKeywords.length];
      const query = /^[\x20-\x7e]+$/.test(kw) && !/cam|webcam/i.test(kw) ? `${kw} cam` : kw;
      try {
        const results = await searchLiveByKeyword(query);
        searchCallsUsed += 1;
        for (const r of results) {
          if (knownIds.has(r.videoId) || candidateMap.has(r.videoId)) continue;
          if (r.channelId && blockedChannelIds.has(r.channelId)) continue;
          if (isExcluded(r.title, r.channelTitle)) continue;
          if (isBlockedRestart(r)) continue;
          candidateMap.set(r.videoId, r);
        }
        console.log(`  부스트 검색 [${catKey}] "${query}": ${results.length}건 조회`);
      } catch (err) {
        searchCallsUsed += 1;
        console.error(`  부스트 검색 실패 [${catKey}] "${query}":`, err.message);
      }
    }
  }

  // 시드 채널(구독 목록 등)의 일반 업로드 영상 수집: 채널당 1회, 최근 영상 25개.
  const seedVideoRows = channelSeeds.filter(c => !c.video_scanned_at);
  if (seedVideoRows.length) {
    const seedVideoBudget = Math.max(0, SEARCH_BUDGET_PER_RUN - searchCallsUsed);
    const seedsToVideoScan = seedVideoRows
      .map(r => r.channel_id)
      .filter(id => !blockedChannelIds.has(id))
      .slice(0, seedVideoBudget);
    console.log(`시드 채널 일반영상 스캔: 대상 ${seedVideoRows.length}개 중 ${seedsToVideoScan.length}개 처리`);
    for (const channelId of seedsToVideoScan) {
      try {
        const results = await searchChannelVideos(channelId);
        searchCallsUsed += 1;
        for (const r of results) {
          if (knownIds.has(r.videoId) || candidateMap.has(r.videoId)) continue;
          if (isExcluded(r.title, r.channelTitle)) continue;
          if (isBlockedRestart(r)) continue;
          candidateMap.set(r.videoId, r);
        }
      } catch (err) {
        searchCallsUsed += 1;
        console.error(`  시드 영상스캔 실패 ${channelId}:`, err.message);
      }
    }
    if (seedsToVideoScan.length) {
      const scannedAt = new Date().toISOString();
      for (const seed of channelSeeds) {
        if (seedsToVideoScan.includes(seed.channel_id)) seed.video_scanned_at = scannedAt;
      }
    }
  }

  // 채널 단위 전체 스캔: 이미 아는 채널(생존 행 + 이번에 새로 찾은 후보)의 다른 라이브도 함께 수집.
  const scannedSet = await loadScannedChannels();
  const observedChannelIds = new Set();
  for (const seed of channelSeeds) observedChannelIds.add(seed.channel_id);
  for (const row of existingRows) {
    if ((row.content_type || 'live') !== 'live') continue;
    const channelId = infoMap.get(row.video_id)?.snippet.channelId;
    if (channelId && isValidFor('live', infoMap.get(row.video_id))) observedChannelIds.add(channelId);
  }
  for (const c of candidateMap.values()) if (c.contentType === 'live' && c.channelId) observedChannelIds.add(c.channelId);

  const channelScanBudget = Math.max(0, SEARCH_BUDGET_PER_RUN - searchCallsUsed);
  const unscannedChannelIds = [...observedChannelIds].filter(id => !scannedSet.has(id) && !blockedChannelIds.has(id));
  const channelIdsToScan = unscannedChannelIds.slice(0, channelScanBudget);
  console.log(`채널 전체 스캔: 대상 ${unscannedChannelIds.length}개 중 ${channelIdsToScan.length}개 처리 (남은 검색 예산 ${channelScanBudget}회, 나머지는 다음 실행에 이어서)`);

  for (const channelId of channelIdsToScan) {
    try {
      const results = await searchChannelLive(channelId);
      for (const r of results) {
        if (knownIds.has(r.videoId) || candidateMap.has(r.videoId)) continue;
        if (isExcluded(r.title, r.channelTitle)) continue;
        if (isBlockedRestart(r)) continue;
        candidateMap.set(r.videoId, r);
      }
    } catch (err) {
      console.error(`  채널 스캔 실패 ${channelId}:`, err.message);
    }
  }
  if (channelIdsToScan.length) {
    for (const id of channelIdsToScan) scannedSet.add(id);
  }

  console.log(`신규 후보 ${candidateMap.size}건 검증 중...`);
  const candidateIds = [...candidateMap.keys()];
  const candidateInfoMap = await getVideoInfo(candidateIds);

  let junkVideo = 0, junkTitle = 0;
  const newCandidates = [...candidateMap.values()].filter(c => {
    const info = candidateInfoMap.get(c.videoId);
    if (!isValidFor(c.contentType, info)) return false;
    // 신규 후보에만 건다. 기존 행은 관리자가 직접 검수해서 남겨둔 것이라 정규식이 뒤집을 자격이 없다.
    if (isJunkTitle(c.title, c.channelTitle)) { junkTitle += 1; return false; }
    // 길이로는 거르지 않는다 (짧다는 건 사이트에서 결격 사유가 아니라 원본 사건 영상의 특징).
    if (c.contentType === 'video' && isJunkVideo(c.title, c.channelTitle)) { junkVideo += 1; return false; }
    return HAS_EMBEDDABLE || info?.status?.embeddable !== false;
  });
  if (junkTitle) console.log(`  -> 뉴스·음향·강좌·게임 패턴 제외: ${junkTitle}건`);
  if (junkVideo) console.log(`  -> 모음집·제품데모 패턴 제외(일반영상): ${junkVideo}건`);
  const newCountryMap = await getChannelCountries(newCandidates.map(c => c.channelId));

  const newRows = newCandidates.map(c => {
    const info = candidateInfoMap.get(c.videoId);
    return {
      video_id: c.videoId,
      title: c.title,
      channel_title: c.channelTitle,
      channel_id: c.channelId || null,
      thumbnail: c.thumbnail,
      matched_keyword: c.matchedKeyword,
      source: 'keyword',
      content_type: c.contentType,
      status: 'live',
      // 자동 수집분도 AI 검수를 거치도록 승인 대기로 넣는다
      approval_status: 'pending',
      category: classifyCategory(c.title, c.channelTitle),
      category_source: 'keyword',
      // 제목의 지명이 채널 국가보다 촬영지에 가까우므로 우선한다
      country: inferCountryFromTitle(c.title) || newCountryMap.get(c.channelId) || null,
      country_source: inferCountryFromTitle(c.title) ? 'title' : (newCountryMap.get(c.channelId) ? 'channel' : null),
      started_at: c.contentType === 'live' ? (info.liveStreamingDetails?.actualStartTime || null) : null,
      published_at: c.contentType === 'video' ? (info.snippet?.publishedAt || null) : null,
      duration_seconds: c.contentType === 'video' ? parseDurationSeconds(info.contentDetails?.duration) : null,
      tags: c.contentType === 'video' ? tagsFromTitle(c.title) : [],
      ...(HAS_EMBEDDABLE ? { embeddable: isNoEmbed(c.title, c.channelTitle) ? false : info?.status?.embeddable !== false } : {}),
    };
  });

  // 세로 영상(쇼츠 등)은 삽입 전에 거르고 차단목록에 올린다 (비율은 안 변하니 재수집 방지)
  const newVerticalIds = newCandidates
    .filter(c => isVerticalInfo(candidateInfoMap.get(c.videoId)))
    .map(c => c.videoId);
  const insertRows = newRows.filter(r => !newVerticalIds.includes(r.video_id));
  if (newVerticalIds.length) {
    for (const id of newVerticalIds) addToBlocklist(id, null, null);
    console.log(`  -> 세로 영상 제외: ${newVerticalIds.length}건 (차단목록 등록)`);
  }

  console.log(`  -> 검증 통과 신규 ${insertRows.length}건`);
  if (insertRows.length) {
    // 카탈로그에 이미 있으면 중복 삽입하지 않는다
    const existingIds = new Set(streams.map(r => r.video_id));
    streams.push(...insertRows.filter(r => !existingIds.has(r.video_id)));
  }

  // 7일 임시등록 만료 처리: 7일이 지난 pending user 제보는 삭제한다.
  // 자동 수집(keyword) 대기분은 만료 대상에서 제외 — 삭제하면 다음날 검색에서 또 발견돼
  // 대기→삭제→재발견을 반복하며 쿼터만 낭비하므로, AI가 승인/삭제할 때까지 대기 상태로 둔다.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const expiredRows = streams.filter(r =>
    r.approval_status === 'pending' && r.source === 'user' && r.added_at && r.added_at < sevenDaysAgo);
  if (expiredRows.length) {
    const expiredIds = new Set(expiredRows.map(r => r.video_id));
    for (let i = streams.length - 1; i >= 0; i--) {
      if (expiredIds.has(streams[i].video_id)) streams.splice(i, 1);
    }
    console.log(`임시등록 만료로 삭제: ${expiredRows.length}건`);
  }

  // 7일 연속 오프라인(방송 중지/영상 삭제) 상태인 항목 정리.
  // 차단목록에는 절대 올리지 않는다 — 재검색/재제보로 다시 들어올 수 있게 둔다.
  const staleOfflineRows = streams.filter(r =>
    r.status === 'offline' && r.offline_since && r.offline_since < sevenDaysAgo);
  if (staleOfflineRows.length) {
    const staleIds = new Set(staleOfflineRows.map(r => r.video_id));
    for (let i = streams.length - 1; i >= 0; i--) {
      if (staleIds.has(streams[i].video_id)) streams.splice(i, 1);
    }
    console.log(`7일 연속 오프라인으로 삭제: ${staleOfflineRows.length}건 (차단목록에는 미등록)`);
  }

  // 같은 채널 + 완전 동일 제목의 "라이브" 중복 정리: 대표 1개(최신)를 남긴다.
  // 일반 영상(video)은 제목이 같아도 다른 날짜의 녹화본일 수 있으므로 절대 건드리지 않는다.
  const dupGroups = new Map();
  for (const r of streams) {
    if (r.content_type !== 'live') continue;
    if (!r.title || !r.channel_title) continue;
    const k = `${r.channel_title}||${r.title}`;
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(r);
  }
  const dupIds = [];
  for (const rows of dupGroups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')));
    dupIds.push(...rows.slice(1).map(r => r.video_id));
  }
  if (dupIds.length) {
    const dupSet = new Set(dupIds);
    for (let i = streams.length - 1; i >= 0; i--) {
      if (dupSet.has(streams[i].video_id)) {
        const row = streams[i];
        streams.splice(i, 1);
        addToBlocklist(row.video_id, row.channel_id, row.title);
      }
    }
    console.log(`동일 제목+채널 중복 삭제: ${dupIds.length}건 (차단목록 등록으로 재수집 방지)`);
  }

  // 생존확인 루프에서 발견한 기존 세로 영상 삭제 + 차단목록 등록
  if (verticalIds.length) {
    const vSet = new Set(verticalIds);
    for (let i = streams.length - 1; i >= 0; i--) {
      if (vSet.has(streams[i].video_id)) {
        const row = streams[i];
        streams.splice(i, 1);
        addToBlocklist(row.video_id, row.channel_id, row.title);
      }
    }
    console.log(`세로 영상 삭제: ${verticalIds.length}건 (차단목록 등록)`);
  }

  // 차단목록 병합 (video_id 중복 제거, 최신 유지)
  if (blocklistAdds.length) {
    const byId = new Map(blocklistRows.map(r => [r.video_id, r]));
    for (const rec of blocklistAdds) {
      const prev = byId.get(rec.video_id);
      if (!prev) byId.set(rec.video_id, rec);
    }
    await saveBlocklist([...byId.values()]);
    console.log(`차단목록 갱신: +${blocklistAdds.length}건 (총 ${byId.size}건)`);
  }

  await saveStreams(snapshot);
  await saveScannedChannels(scannedSet);
  await saveChannelSeeds(channelSeeds);

  console.log(`완료: 카탈로그 ${streams.length}건 (유효 ${validCount}, 오프라인 ${offlineCount}, 오탐삭제 ${toDelete.length}, 신규 ${insertRows.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});