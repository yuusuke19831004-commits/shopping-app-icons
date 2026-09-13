/**
 * 家族 買い物リスト - Service Worker
 *
 * 目的：静的ファイル（HTML/CSS/JS/アイコン等）だけを端末にキャッシュし、
 * 2回目以降の起動を高速化する。
 *
 * 【重要な方針】
 * ・Apps ScriptのAPI通信（データ取得・追加・購入・削除など）は
 *   絶対にキャッシュしない（network-only）。買い物データの鮮度は
 *   引き続きapp.js側のlocalStorageキャッシュ＋バックグラウンド取得で担保する。
 * ・静的ファイルは stale-while-revalidate（キャッシュがあれば即返しつつ、
 *   裏で最新版を取得してキャッシュを更新）。これにより「古いapp.jsが
 *   長期間残り続ける」事故を避けつつ、体感速度も上げる。
 * ・キャッシュ名にバージョン番号を付け、更新時は古いキャッシュをactivateで削除する。
 * ・skipWaiting() / clients.claim() により、新しいService Workerへ速やかに切り替える。
 *
 * 【app.js等を更新したときにやること】
 * このファイル冒頭の CACHE_VERSION の数字を必ず1つ上げてからデプロイする。
 * （例: 'v1' → 'v2'）。バージョンを上げないと、stale-while-revalidateにより
 * 最終的には更新されるが、切り替わりが1テンポ遅れる可能性があるため、
 * 「更新した日は必ずバージョンを上げる」運用にすることで確実性を最優先する。
 */

var CACHE_VERSION = 'v2';
var CACHE_NAME = 'shopping-app-static-' + CACHE_VERSION;

// キャッシュ対象は「同一オリジンの静的ファイルのみ」。
// Apps ScriptのURL（script.google.com）はここに含めない。
var STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-touch.png',
  './favicon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        // 1つのファイルが404等で失敗しても他のキャッシュ登録を止めないようにする
        return Promise.all(
          STATIC_ASSETS.map(function (url) {
            return cache.add(url).catch(function (err) {
              console.warn('[sw] キャッシュ登録に失敗（無視して続行）:', url, err);
            });
          })
        );
      })
  );
  // 新しいService Workerを待たせず即座にactivateへ進める
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (cacheNames) {
        // 今回のバージョン以外の古いキャッシュ（shopping-app-static-*）を削除する
        return Promise.all(
          cacheNames
            .filter(function (name) {
              return name.indexOf('shopping-app-static-') === 0 && name !== CACHE_NAME;
            })
            .map(function (name) { return caches.delete(name); })
        );
      })
      .then(function () {
        // 既に開いているタブも含め、すぐに新しいService Workerを使わせる
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // GET以外（POST等、Apps ScriptへのAPI書き込みも含む）はService Workerで
  // 一切介入せず、ブラウザの通常通信に任せる。
  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  // 同一オリジン以外（Apps Script Web API = script.google.com など）は
  // 絶対にキャッシュせず、素通しでネットワークへ流す（network-only）。
  if (url.origin !== self.location.origin) {
    return;
  }

  // 同一オリジンの静的ファイル：stale-while-revalidate
  // 1) キャッシュがあれば即座に返す（体感速度優先）
  // 2) 裏でネットワークから最新版を取得し、キャッシュを更新する
  // 3) キャッシュが無く、ネットワークも失敗した場合のみエラーになる
  //    （index.htmlへのnavigateだけは、フォールバックとしてキャッシュ済みindex.htmlを試みる）
  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var networkFetch = fetch(request)
          .then(function (response) {
            // 正常なレスポンスだけキャッシュを更新する
            if (response && response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(function (err) {
            // オフライン等でネットワーク取得に失敗した場合
            if (request.mode === 'navigate') {
              // 画面遷移（アプリ起動）の場合は、せめてキャッシュ済みindex.htmlを返す
              return cache.match('./index.html');
            }
            throw err;
          });
        // キャッシュがあれば即返し（裏でnetworkFetchが進む＝revalidate）、
        // 無ければネットワーク取得を待つ。
        return cached || networkFetch;
      });
    })
  );
});
