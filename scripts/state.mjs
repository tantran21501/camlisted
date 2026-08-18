// JSON-only 상태 저장소 헬퍼.
// Supabase를 전부 걷어내고, 카탈로그/차단목록/스캔기록 등을 git에 커밋되는 JSON 파일로 관리한다.
// - data/streams.json        : 카탈로그 전체 (방문자가 받는 스냅샷과 동일한 파일 = source of truth)
// - data/locations.json      : 카메라 위치 스냅샷 (video_id, title, category, country, lat/lng)
// - data/location_resolve.json : 위치 해석 디버그 (regex + AI 상세 결과)
// - data/locations_unresolved.json : 위치 미해결 목록
// - data/geocode-cache.json  : Nominatim geocode cache
// - data/ai-location-cache.json : Gemini location cache
// - data/blocklist.json      : 관리자가 지운 videoId (재수집 방지)
// - data/blocked_channels.json : 채널 통째 차단 목록
// - data/scanned_channels.json : 채널 스캔 완료 기록 (쿼터 절약 dedup)
// - data/channel_seeds.json  : 수동 등록 시드 채널
// - data/ai_review_log.json  : AI 검수 판정 로그 (관리자 복구 이력 겸용)
// - data/vehicle_observations.json : 차량 관측 실험 데이터
// - config/categories.json   : 카테고리 정의 (원래 DB 테이블)
// - config/condition_tags.json : 조건 태그 정의 (원래 DB 테이블)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_DIR = path.join(ROOT, 'config');

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

const dataFile = (name) => path.join(DATA_DIR, name);

// ---- 카탈로그 (data/streams.json) ----
// 스냅샷 포맷(streams-v2)은 하위 호환성을 위해 유지한다 (외부 소비자/역방향 호환).
export async function loadStreams() {
  const snap = await readJson(dataFile('streams.json'), { format: 'streams-v2', generatedAt: null, count: 0, commentCounts: {}, submitterNames: {}, streams: [] });
  return { ...snap, streams: snap.streams || [] };
}

export async function saveStreams(snapshot) {
  await writeJson(dataFile('streams.json'), {
    format: 'streams-v2',
    generatedAt: new Date().toISOString(),
    count: snapshot.streams.length,
    commentCounts: {},
    submitterNames: {},
    streams: snapshot.streams,
  });
}

// ---- 차단목록 (videoId) ----
export async function loadBlocklist() {
  return (await readJson(dataFile('blocklist.json'), { items: [] })).items || [];
}

export async function saveBlocklist(items) {
  await writeJson(dataFile('blocklist.json'), { format: 'blocklist-v1', items });
}

// ---- 채널 차단목록 ----
export async function loadBlockedChannels() {
  return (await readJson(dataFile('blocked_channels.json'), { items: [] })).items || [];
}

export async function saveBlockedChannels(items) {
  await writeJson(dataFile('blocked_channels.json'), { format: 'blocked-channels-v1', items });
}

// ---- 스캔 완료 채널 ----
export async function loadScannedChannels() {
  const s = await readJson(dataFile('scanned_channels.json'), { channel_ids: [] });
  return new Set(s.channel_ids || []);
}

export async function saveScannedChannels(channelIds) {
  await writeJson(dataFile('scanned_channels.json'), { format: 'scanned-v1', channel_ids: [...channelIds].sort() });
}

// ---- 시드 채널 ----
export async function loadChannelSeeds() {
  return (await readJson(dataFile('channel_seeds.json'), { items: [] })).items || [];
}

export async function saveChannelSeeds(items) {
  await writeJson(dataFile('channel_seeds.json'), { format: 'channel-seeds-v1', items });
}

// ---- AI 검수 로그 ----
export async function loadAiReviewLog() {
  return (await readJson(dataFile('ai_review_log.json'), { items: [] })).items || [];
}

export async function saveAiReviewLog(items) {
  await writeJson(dataFile('ai_review_log.json'), { format: 'ai-review-v1', items });
}

// ---- 차량 관측 ----
export async function loadVehicleObservations() {
  return (await readJson(dataFile('vehicle_observations.json'), { items: [] })).items || [];
}

export async function saveVehicleObservations(items) {
  await writeJson(dataFile('vehicle_observations.json'), { format: 'vehicle-obs-v1', items });
}

// ---- config (정적) ----
export async function loadCategories() {
  return (await readJson(path.join(CONFIG_DIR, 'categories.json'), [])).filter(c => c && c.key);
}

export async function loadConditionTags() {
  return (await readJson(path.join(CONFIG_DIR, 'condition_tags.json'), [])).filter(c => c && c.key);
}