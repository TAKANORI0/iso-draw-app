'use strict';

// iso-draw のオフライン用 Service Worker。
//
// Flutter 3.47 が生成する flutter_service_worker.js は「自分を unregister する
// だけのスタブ」で、キャッシュを持たない（Flutter が組み込みのオフライン SW を
// やめたため）。現場は電波が無いので、ここは自前で持つ。
//
// 方針:
//   ・アプリ本体（index.html / flutter_bootstrap.js / main.dart.js）は
//     **電波があれば必ず取り直す**（ネット優先・3秒で諦めてキャッシュ）。
//     ここをキャッシュ優先にしていたせいで、直した版が端末に何日も届かなかった。
//   ・それ以外（canvaskit・フォント・カタログ）は**キャッシュ優先**。
//     容量が大きく、版が変われば CACHE 名ごと入れ替わるので取り直す必要がない。
//   ・圏外ではどちらもキャッシュから返るので、起動できる。
//
// CACHE 名は配信のたびに tools/deploy_pages.ps1 が打ち替える。

const CACHE = 'iso-draw-20260819-2330';

/// 電波があるとき、ネットの応答をこの時間まで待つ（超えたらキャッシュを返す）
const NETWORK_TIMEOUT_MS = 3000;

// アプリ本体。ここが古いままだと「直したのに変わらない」になる
const SHELL = ['', 'index.html', 'flutter_bootstrap.js', 'main.dart.js', 'flutter.js'];

// 起動に要るものは全部先読みする。
// 「実際に読まれたものを fetch ハンドラで拾う」だけでは足りない:
// ブラウザのHTTPキャッシュから返った分は fetch イベントが飛ばないので、
// main.dart.js がキャッシュに入らないまま「オフラインでは起動しない」状態になる。
const CORE = [
  './',
  './index.html',
  './flutter_bootstrap.js',
  './main.dart.js',
  './flutter.js',
  './manifest.json',
  './version.json',
  './favicon.png',
  './icons/Icon-192.png',
  './icons/Icon-512.png',

  // レンダラ。Chrome系は chromium/、それ以外は canvaskit/ を読む。
  './canvaskit/chromium/canvaskit.js',
  './canvaskit/chromium/canvaskit.wasm',
  './canvaskit/canvaskit.js',
  './canvaskit/canvaskit.wasm',

  './assets/FontManifest.json',
  './assets/AssetManifest.bin',
  './assets/AssetManifest.bin.json',
  './assets/NOTICES',
  './assets/fonts/MaterialIcons-Regular.otf',

  // Roboto は同梱。入れておかないと fonts.gstatic.com を見に行く
  './assets/assets/fonts/Roboto-Regular.ttf',
  './assets/assets/fonts/Roboto-Medium.ttf',
  './assets/assets/fonts/Roboto-Bold.ttf',

  // 継手・支持金物のカタログ。これが無いと寸法が引けない
  './assets/assets/catalog/fittings.json',
  './assets/assets/catalog/support_bolt.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1つでも失敗したら install ごと失敗する addAll は使わない。
      // 現場では「一部だけ入っていない」より「起動できる」ほうが大事。
      await Promise.all(
        CORE.map((url) =>
          // cache: 'reload' でブラウザのHTTPキャッシュを迂回し、
          // 必ずネットワークから取り直して入れる（古い版を焼き付けない）
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => {
              if (!res.ok) throw new Error('status ' + res.status);
              return cache.put(url, res);
            })
            .catch((e) => console.warn('precache skipped', url, e))
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/// 同一オリジンのパスを、ベース（スコープ）からの相対名に直す
function shellName(url) {
  const scope = new URL(self.registration.scope);
  let path = url.pathname;
  if (path.startsWith(scope.pathname)) {
    path = path.slice(scope.pathname.length);
  }
  return path;
}

async function networkFirst(request, cache) {
  let timer;
  try {
    const response = await Promise.race([
      fetch(request, { cache: 'no-store' }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
      }),
    ]);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外部は素通し（そもそも無い）

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const isShell =
        request.mode === 'navigate' || SHELL.includes(shellName(url));

      // アプリ本体は電波があれば取り直す（古い版を掴み続けない）
      if (isShell) {
        try {
          return await networkFirst(request, cache);
        } catch (e) {
          const shell = await cache.match('./index.html', { ignoreSearch: true });
          if (request.mode === 'navigate' && shell) return shell;
          // 落ちる場合は下のキャッシュ優先へ落ちる
        }
      }

      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;

      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (e) {
        if (request.mode === 'navigate') {
          const shell = await cache.match('./index.html', { ignoreSearch: true });
          if (shell) return shell;
        }
        return new Response('オフラインです（この内容はまだ端末に入っていません）', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});
