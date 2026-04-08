// 薬剤在庫管理アプリ — Vercel サーバーレスAPI
// Upstash Redis でデータ永続化
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

// Upstash Redis クライアント
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Googleスプレッドシートに変更ログを送信（非同期、失敗してもAPIは止めない）
function logToSheet(action, userName, itemName, details) {
  const webhookUrl = process.env.SHEET_WEBHOOK_URL;
  if (!webhookUrl) return;
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timestamp = jst.toISOString().replace('T', ' ').substring(0, 19);
  const payload = JSON.stringify({
    timestamp,
    action,
    userName: userName || '不明',
    itemName: itemName || '',
    details: details || '',
  });
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(() => {}); // エラーは無視
}

// ルームデータの読み書き
async function getRoom(id) {
  const data = await redis.get(`med:${id}`);
  return data || null;
}
async function saveRoom(id, room) {
  await redis.set(`med:${id}`, JSON.stringify(room));
}

// メンバー追跡（名前があればmembersに追加）
function trackMember(room, name) {
  if (!name) return;
  if (!Array.isArray(room.members)) room.members = [];
  const existing = room.members.find(m => m.name === name);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
  } else {
    room.members.push({ name, joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
  }
}

// リクエストボディ取得
async function parseBody(req) {
  if (req.body) return req.body;
  return {};
}

module.exports = async (req, res) => {
  // CORS対応
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    // === ログインエンドポイント（互換性のため残す） ===
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const passcode = body.passcode || '';
      if (passcode !== process.env.LOGIN_PASSCODE) {
        return res.status(401).json({ error: 'Invalid passcode' });
      }
      const token = crypto.randomBytes(16).toString('hex');
      // セッションは30日間有効
      await redis.set(`session:${token}`, '1', { ex: 60 * 60 * 24 * 30 });
      return res.status(200).json({ token });
    }

    // === ルーム作成 ===
    if (pathname === '/api/create' && req.method === 'POST') {
      const body = await parseBody(req);
      const id = crypto.randomBytes(4).toString('hex');
      const room = {
        id,
        name: body.name || '薬剤管理',
        medicines: [],
        members: [],
        pushSubscriptions: [],
        created: new Date().toISOString(),
      };
      await saveRoom(id, room);
      return res.status(200).json({ id });
    }

    // === ルーム取得 ===
    if (pathname.match(/^\/api\/room\/[^/]+$/) && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const userName = url.searchParams.get('user') || '';
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);
      // メンバー追跡
      if (userName) {
        trackMember(room, userName);
        await saveRoom(id, room);
      }
      // pushSubscriptionsは返さない
      const { pushSubscriptions, ...safeData } = room;
      return res.status(200).json(safeData);
    }

    // === 薬剤追加 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/add$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const medicine = {
        mid: crypto.randomBytes(4).toString('hex'),
        name: (body.name || '').trim(),
        quantity: parseInt(body.quantity) || 1,
        unit: (body.unit || '個').trim(),
        expiryDate: body.expiryDate || '',
        location: (body.location || '').trim(),
        category: (body.category || '').trim(),
        memo: (body.memo || '').trim(),
        barcode: (body.barcode || '').trim(),
        addedBy: (body.addedBy || '').trim(),
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (!medicine.name) return res.status(400).json({ error: '薬剤名は必須です' });

      room.medicines.push(medicine);
      await saveRoom(id, room);
      logToSheet('追加', medicine.addedBy, medicine.name, `数量:${medicine.quantity} 単位:${medicine.unit} 期限:${medicine.expiryDate || 'なし'} 場所:${medicine.location} カテゴリ:${medicine.category}`);
      return res.status(200).json({ status: 'ok', medicine });
    }

    // === 薬剤更新 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/update$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const med = room.medicines.find(m => m.mid === body.mid);
      if (!med) return res.status(404).json({ error: '薬剤が見つかりません' });

      if (body.name !== undefined) med.name = (body.name || '').trim();
      if (body.quantity !== undefined) med.quantity = parseInt(body.quantity) || 0;
      if (body.unit !== undefined) med.unit = (body.unit || '個').trim();
      if (body.expiryDate !== undefined) med.expiryDate = body.expiryDate;
      if (body.location !== undefined) med.location = (body.location || '').trim();
      if (body.category !== undefined) med.category = (body.category || '').trim();
      if (body.memo !== undefined) med.memo = (body.memo || '').trim();
      med.updatedBy = (body.updatedBy || '').trim();
      med.updatedAt = new Date().toISOString();

      await saveRoom(id, room);
      logToSheet('更新', med.updatedBy, med.name, `数量:${med.quantity} 単位:${med.unit} 期限:${med.expiryDate || 'なし'} 場所:${med.location}`);
      return res.status(200).json({ status: 'ok' });
    }

    // === 薬剤削除 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/delete$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const idx = room.medicines.findIndex(m => m.mid === body.mid);
      if (idx === -1) return res.status(404).json({ error: '薬剤が見つかりません' });
      const deletedName = room.medicines[idx].name;
      room.medicines.splice(idx, 1);
      await saveRoom(id, room);
      logToSheet('削除', body.deletedBy || '', deletedName, '');
      return res.status(200).json({ status: 'ok' });
    }

    // === 数量増減 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/adjust$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const med = room.medicines.find(m => m.mid === body.mid);
      if (!med) return res.status(404).json({ error: '薬剤が見つかりません' });

      const delta = parseInt(body.delta) || 0;
      med.quantity = Math.max(0, med.quantity + delta);
      med.updatedBy = (body.updatedBy || '').trim();
      med.updatedAt = new Date().toISOString();

      // 使用ログ
      if (!Array.isArray(room.usageLog)) room.usageLog = [];
      room.usageLog.push({
        mid: body.mid,
        name: med.name,
        delta,
        newQty: med.quantity,
        by: body.updatedBy || '',
        at: new Date().toISOString(),
      });
      // ログ上限100件
      if (room.usageLog.length > 100) room.usageLog = room.usageLog.slice(-100);

      await saveRoom(id, room);
      logToSheet('数量変更', body.updatedBy, med.name, `${delta > 0 ? '+' : ''}${delta} → 在庫:${med.quantity}`);
      return res.status(200).json({ status: 'ok', quantity: med.quantity });
    }

    // === プッシュ通知サブスクリプション登録 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/subscribe$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      if (!Array.isArray(room.pushSubscriptions)) room.pushSubscriptions = [];

      // 重複チェック
      const endpoint = body.subscription?.endpoint;
      if (endpoint && !room.pushSubscriptions.find(s => s.endpoint === endpoint)) {
        room.pushSubscriptions.push(body.subscription);
      }

      await saveRoom(id, room);
      return res.status(200).json({ status: 'ok' });
    }

    // === 薬剤一括追加（CSVインポート用） ===
    if (pathname.match(/^\/api\/room\/[^/]+\/bulk-add$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const items = body.items || [];
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'インポートするデータがありません' });
      }
      if (items.length > 200) {
        return res.status(400).json({ error: '一度に200件までです' });
      }

      const added = [];
      const errors = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const name = (item.name || '').trim();
        const expiryDate = (item.expiryDate || '').trim();
        if (!name) { errors.push({ row: i + 1, error: '薬剤名が空です' }); continue; }

        const medicine = {
          mid: crypto.randomBytes(4).toString('hex'),
          name,
          quantity: parseInt(item.quantity) || 1,
          unit: (item.unit || '個').trim(),
          expiryDate,
          location: (item.location || '').trim(),
          category: (item.category || '').trim(),
          memo: (item.memo || '').trim(),
          barcode: (item.barcode || '').trim(),
          addedBy: (body.addedBy || '').trim(),
          addedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        room.medicines.push(medicine);
        added.push(medicine);
      }

      await saveRoom(id, room);
      if (added.length > 0) {
        logToSheet('CSVインポート', body.addedBy || '', `${added.length}件一括追加`, added.slice(0, 5).map(m => m.name).join(', ') + (added.length > 5 ? ` 他${added.length - 5}件` : ''));
      }
      return res.status(200).json({ status: 'ok', added: added.length, errors });
    }

    // === 期限チェック（cron用） ===
    if (pathname === '/api/cron/check-expiry' && req.method === 'GET') {
      // Vercel Cron認証チェック
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // 全ルームの期限チェックはRedisのスキャンが必要
      // 簡易版: 個別ルームのチェックはクライアント側で実施
      return res.status(200).json({ status: 'ok', message: 'Cron executed' });
    }

    // === VAPID公開鍵の取得 ===
    if (pathname === '/api/vapid-key' && req.method === 'GET') {
      return res.status(200).json({
        publicKey: process.env.VAPID_PUBLIC_KEY || ''
      });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
