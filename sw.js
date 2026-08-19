'use strict';

// iso-draw のオフライン用 Service Worker。
//
// Flutter 3.47 が生成する flutter_service_worker.js は「自分を unregister する
// だけのスタブ」で、キャッシュを持たない（Flutter が組み込みのオフライン SW を
// やめたため）。現場は電波が無いので、ここは自前で持つ。
//
// 方針は stale-while-revalidate:
//   ・キャッシュにあれば**即返す**（電波が無くても開く）
//   ・裏で取り直してキャッシュを更新する（次回起動から新しい版になる）
// 版を上げたいときは CACHE の数字を上げる。古いキャッシュは activate で消える。

const CACHE = 'iso-draw-v2';

// 起動に要るものは**全部ここで先読みする**。
// 「実際に読まれたものを fetch ハンドラで拾う」だけでは足りない:
// ブラウザのHTTPキャッシュから返った分は fetch イベントが飛ばないので、
// main.dart.js がキャッシュに入らないまま「オフラインでは起動しない」状態になる（実測）。
//
// 一覧は performance.getEntriesByType('resource') で実測した読み込み順に合わせてある。
// 版を上げたらここも見直す（`flutter build web` の出力名は安定しているが、
// アセットを増やしたら足す）。
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
  // どちらを使うか端末で変わるので両方入れる（片方が無くても install は続く）。
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

  // 継手カタログ。これが無いと寸法が引けない
  './assets/assets/catalog/fittings.json',
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
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 外部は素通し（そもそも無い）

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });

      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      // キャッシュがあれば待たずに返す（オフラインでも即起動）
      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      // 圏外で初見のURL。画面遷移なら index.html を返して起動だけはさせる
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html', { ignoreSearch: true });
        if (shell) return shell;
      }
      return new Response('オフラインです（この内容はまだ端末に入っていません）', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })()
  );
});
