/* Project Tracker - Service Worker v2
 * 전략:
 *  - HTML/JS/CSS 같은 셸 파일: network-first → 항상 최신 시도, 안 되면 캐시
 *  - 외부 API 호출(Worker): 캐시 안 함 (network-only)
 *  - 새 버전 SW가 설치되면 즉시 활성화 → 옛 캐시 자동 폐기
 */

const CACHE = 'tracker-shell-v3';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL_FILES).catch(() => {}))
  );
  // 새 SW를 기다리지 않고 바로 활성화
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      // 이전 버전 캐시 모두 삭제
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
      ),
      // 이미 열려있는 PWA 탭들도 이 새 SW가 즉시 제어
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 외부 출처(Notion Worker)는 SW가 손대지 않음 → 항상 네트워크
  if (url.origin !== self.location.origin) return;

  // network-first: 항상 최신 시도, 실패하면 캐시
  event.respondWith(
    fetch(req)
      .then(res => {
        // 정상 응답이면 캐시 갱신
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
  );
});
