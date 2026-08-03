// IndexNow: 이번 실행에서 실제로 바뀐 페이지만 검색엔진(Bing·Yandex 등)에 직접 알린다.
//
// 왜 필요한가: 구글에는 사이트맵을 내고 있지만 Bing 쪽은 사실상 비어 있었다(90일 유입 2명, 0%).
// 그런데 ChatGPT의 웹 검색은 상당 부분 Bing 인덱스에 기대므로, Bing이 우리 페이지를 모르면
// LLM이 인용할 창구도 좁아진다. 실제로 chatgpt.com 유입(7일 10명)이 google(4명)보다 많은데도
// Bing 색인은 비어 있는 상태였다.
//
// 크롤러가 우연히 들르길 기다리는 대신 "바뀐 URL"을 밀어 넣는 방식이라 계정도 비용도 없다.
// 소유권 확인은 키 파일(https://camlisted.com/<key>.txt)을 우리가 호스팅한다는 사실로 이뤄지므로,
// 키가 저장소에 공개로 들어 있는 것은 정상이다.
//
// 보낼 URL은 git으로 고른다 — 매일 400여 페이지를 통째로 재전송하면 바뀌지도 않은 걸 계속
// 알리는 셈이라 예의에 어긋나고, 실제로 내용이 바뀐 것만 골라야 신호가 정확하다.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://camlisted.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10000; // IndexNow 1회 요청 상한
// robots.txt에서 막았거나 noindex로 둔 페이지는 알릴 이유가 없다
const SKIP = new Set(['account.html', 'stats.html', 'cheers.html', '404.html']);

// 저장소 루트의 <key>.txt를 찾아 키를 얻는다 (파일명이 곧 키)
async function findKey() {
  const names = await readdir(ROOT);
  const f = names.find((n) => /^[0-9a-f]{32}\.txt$/.test(n));
  if (!f) throw new Error('IndexNow 키 파일(<32자리hex>.txt)을 저장소 루트에서 못 찾음');
  return f.replace(/\.txt$/, '');
}

// 직전 커밋에서 바뀐 html 파일 → URL.
// 주의: 생성물에 변화가 없는 날은 커밋 자체가 안 생긴다. 그때 HEAD~1..HEAD를 그대로 보면
// 무관한 예전 커밋(예: 코드 수정)의 파일을 "바뀐 페이지"로 착각해 엉뚱한 URL을 알리게 된다.
// 그래서 HEAD가 이번 실행이 만든 재생성 커밋일 때만 비교한다.
function changedUrls() {
  let out;
  try {
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (subject !== 'Regenerate SEO pages') {
      console.log(`IndexNow: 이번 실행에서 생성물 커밋이 없었음 (HEAD="${subject}") — 전송 안 함`);
      return [];
    }
    out = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    console.log('IndexNow: 직전 커밋과 비교할 수 없어 건너뜀');
    return [];
  }
  const urls = [];
  for (const line of out.split('\n')) {
    const rel = line.trim();
    if (!rel.endsWith('.html')) continue;
    if (SKIP.has(rel)) continue;
    // 홈은 /index.html이 아니라 / 로 알린다 (canonical과 맞춤)
    urls.push(rel === 'index.html' ? `${SITE}/` : `${SITE}/${rel}`);
  }
  return [...new Set(urls)].slice(0, MAX_URLS);
}

async function main() {
  const urlList = changedUrls();
  if (!urlList.length) {
    console.log('IndexNow: 바뀐 페이지 없음 — 전송 안 함');
    return;
  }
  const key = await findKey();
  const body = { host: 'camlisted.com', key, keyLocation: `${SITE}/${key}.txt`, urlList };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const text = (await res.text()).slice(0, 300);

  // 200/202가 정상. 403은 키 파일이 아직 배포 안 됐다는 뜻이라 다음 실행에 저절로 풀린다.
  if (res.ok) {
    console.log(`IndexNow: ${urlList.length}개 URL 전송 완료 (HTTP ${res.status})`);
  } else if (res.status === 403) {
    console.log(`IndexNow: 키 검증 실패(403) — ${SITE}/${key}.txt 가 아직 배포 안 됐을 수 있음. 다음 실행에서 재시도됨`);
  } else {
    console.log(`IndexNow: 전송 실패 (HTTP ${res.status}) ${text}`);
  }
  console.log(`  예시: ${urlList.slice(0, 3).join(' , ')}${urlList.length > 3 ? ` … 외 ${urlList.length - 3}개` : ''}`);
}

// 이 단계는 부가 기능이라, 실패해도 야간 자동화 전체를 깨뜨리지 않는다
main().catch((err) => console.log('IndexNow 건너뜀:', err.message));
