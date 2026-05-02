// 薬剤在庫マネージャー — Service Worker
// プッシュ通知の受信とキャッシュ管理

const CACHE_NAME = 'med-v25';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png'];

// インストール
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// アクティベート — 古いキャッシュを削除
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ（ネットワークファースト + キャッシュ更新）
self.addEventListener('fetch', e => {
  // API呼び出しはキャッシュしない
  if (e.request.url.includes('/api/')) return;

  // GETリクエストのみキャッシュ対象
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // 成功したレスポンスをキャッシュに保存
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // オフライン時はキャッシュから返す
        return caches.match(e.request).then(cached => {
          // ナビゲーションリクエスト（ページ遷移）でキャッシュがなければ / を返す
          if (!cached && e.request.mode === 'navigate') {
            return caches.match('/');
          }
          return cached;
        });
      })
  );
});

// プッシュ通知受信
self.addEventListener('push', e => {
  let data = { title: '薬剤在庫マネージャー', body: '消費期限のお知らせ' };
  try { data = e.data.json(); } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      data: data.url || '/',
    })
  );
});

// 通知クリック
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data || '/'));
});
