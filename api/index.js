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

// グループデータの読み書き
async function getGroup(id) {
  const data = await redis.get(`med-group:${id}`);
  return data || null;
}
async function saveGroup(id, group) {
  await redis.set(`med-group:${id}`, JSON.stringify(group));
}

// メンバー追跡（deviceIdがあれば同一デバイスは1人として扱う）
function trackMember(room, name, deviceId) {
  if (!name) return;
  if (!Array.isArray(room.members)) room.members = [];
  // deviceIdで検索（同じ端末なら名前が変わっても同一人物）
  if (deviceId) {
    const byDevice = room.members.find(m => m.deviceId === deviceId);
    if (byDevice) {
      // 管理人名も連動更新
      if (room.admin === byDevice.name && byDevice.name !== name) {
        room.admin = name;
      }
      byDevice.name = name;
      byDevice.lastSeen = new Date().toISOString();
      return;
    }
  }
  // 名前で検索（後方互換）
  const existing = room.members.find(m => m.name === name);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
    if (deviceId && !existing.deviceId) existing.deviceId = deviceId;
  } else {
    room.members.push({ name, deviceId: deviceId || '', joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
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
      const creatorName = (body.creator || '').trim();
      const deviceId = (body.deviceId || '').trim();
      const room = {
        id,
        name: body.name || '薬剤管理',
        admin: creatorName, // 作成者が管理人
        medicines: [],
        members: [],
        pushSubscriptions: [],
        created: new Date().toISOString(),
      };
      // 作成者をメンバーに追加
      if (creatorName) {
        trackMember(room, creatorName, deviceId);
      }
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
      // マイグレーション: adminが未設定の場合、最初のメンバーをadminに設定
      if (!room.admin && Array.isArray(room.members) && room.members.length > 0) {
        room.admin = room.members[0].name;
        await saveRoom(id, room);
      }
      // メンバー追跡
      if (userName) {
        const deviceId = url.searchParams.get('deviceId') || '';
        trackMember(room, userName, deviceId);
        await saveRoom(id, room);
      }
      // pushSubscriptionsは返さない
      const { pushSubscriptions, ...safeData } = room;
      return res.status(200).json(safeData);
    }

    // === 薬剤追加（同一名は自動ロット統合） ===
    if (pathname.match(/^\/api\/room\/[^/]+\/add$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const name = (body.name || '').trim();
      const qty = parseInt(body.quantity) || 1;
      const unit = (body.unit || '個').trim();
      const expiryDate = body.expiryDate || '';
      const addedBy = (body.addedBy || '').trim();
      if (!name) return res.status(400).json({ error: '薬剤名は必須です' });

      // 同一名の薬剤を検索（ロット統合）
      const existing = room.medicines.find(m => m.name === name && m.unit === unit);
      if (existing) {
        // ロット配列に追加
        if (!Array.isArray(existing.lots)) {
          // 既存データをロット化
          existing.lots = existing.expiryDate
            ? [{ expiryDate: existing.expiryDate, quantity: existing.quantity }]
            : [{ expiryDate: '', quantity: existing.quantity }];
        }
        // 同じ期限のロットがあれば数量加算
        const sameLot = existing.lots.find(l => l.expiryDate === expiryDate);
        if (sameLot) {
          sameLot.quantity += qty;
        } else {
          existing.lots.push({ expiryDate, quantity: qty });
        }
        // ロットを期限順ソート
        existing.lots.sort((a, b) => (a.expiryDate || '9999').localeCompare(b.expiryDate || '9999'));
        // 合計数量を更新
        existing.quantity = existing.lots.reduce((s, l) => s + l.quantity, 0);
        // 最も近い期限をメインに設定
        existing.expiryDate = existing.lots.find(l => l.expiryDate)?.expiryDate || '';
        existing.updatedBy = addedBy;
        existing.updatedAt = new Date().toISOString();
        // 場所・カテゴリは既存を優先、空なら新規値で埋める
        if (!existing.location && body.location) existing.location = body.location.trim();
        if (!existing.category && body.category) existing.category = body.category.trim();
        if (body.barcode && !existing.barcode) existing.barcode = body.barcode.trim();
        await saveRoom(id, room);
        logToSheet('ロット追加', addedBy, name, `+${qty} 期限:${expiryDate || 'なし'} 合計:${existing.quantity}`);
        return res.status(200).json({ status: 'ok', medicine: existing, merged: true });
      }

      // 新規薬剤
      const medicine = {
        mid: crypto.randomBytes(4).toString('hex'),
        name, quantity: qty, unit, expiryDate,
        location: (body.location || '').trim(),
        category: (body.category || '').trim(),
        memo: (body.memo || '').trim(),
        barcode: (body.barcode || '').trim(),
        lots: expiryDate ? [{ expiryDate, quantity: qty }] : [],
        addedBy, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      room.medicines.push(medicine);
      await saveRoom(id, room);
      logToSheet('追加', addedBy, name, `数量:${qty} 単位:${unit} 期限:${expiryDate || 'なし'} 場所:${medicine.location} カテゴリ:${medicine.category}`);
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
      if (body.unit !== undefined) med.unit = (body.unit || '個').trim();
      if (body.expiryDate !== undefined) med.expiryDate = body.expiryDate;
      if (body.location !== undefined) med.location = (body.location || '').trim();
      if (body.category !== undefined) med.category = (body.category || '').trim();
      if (body.memo !== undefined) med.memo = (body.memo || '').trim();

      // ロット別数量の更新（フロントエンドからlots配列が送られた場合）
      if (Array.isArray(body.lots)) {
        med.lots = body.lots.filter(l => l.quantity > 0); // 0個のロットは削除
        med.lots.sort((a, b) => (a.expiryDate || '9999').localeCompare(b.expiryDate || '9999'));
        // 総数はロットの合計から自動計算
        med.quantity = med.lots.reduce((s, l) => s + l.quantity, 0);
        // 最も近い期限をメインに設定
        med.expiryDate = med.lots.find(l => l.expiryDate)?.expiryDate || '';
      } else if (body.quantity !== undefined) {
        med.quantity = parseInt(body.quantity) || 0;
      }

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

    // === 数量増減（ロット対応：期限の近いものから消費） ===
    if (pathname.match(/^\/api\/room\/[^/]+\/adjust$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const med = room.medicines.find(m => m.mid === body.mid);
      if (!med) return res.status(404).json({ error: '薬剤が見つかりません' });

      const delta = parseInt(body.delta) || 0;
      const lotIndex = body.lotIndex !== undefined ? parseInt(body.lotIndex) : -1;

      if (Array.isArray(med.lots) && med.lots.length > 0) {
        if (lotIndex >= 0 && lotIndex < med.lots.length) {
          // 特定ロットの数量を変更
          med.lots[lotIndex].quantity = Math.max(0, med.lots[lotIndex].quantity + delta);
        } else if (delta < 0) {
          // 消費：期限の近いロットから自動消費
          let remain = Math.abs(delta);
          for (const lot of med.lots) {
            if (remain <= 0) break;
            const take = Math.min(lot.quantity, remain);
            lot.quantity -= take;
            remain -= take;
          }
        } else {
          // 追加：最後のロットに加算
          med.lots[med.lots.length - 1].quantity += delta;
        }
        // 空ロット削除
        med.lots = med.lots.filter(l => l.quantity > 0);
        // 合計再計算
        med.quantity = med.lots.reduce((s, l) => s + l.quantity, 0);
        med.expiryDate = med.lots.find(l => l.expiryDate)?.expiryDate || '';
      } else {
        med.quantity = Math.max(0, med.quantity + delta);
      }

      med.updatedBy = (body.updatedBy || '').trim();
      med.updatedAt = new Date().toISOString();

      // 使用ログ
      if (!Array.isArray(room.usageLog)) room.usageLog = [];
      room.usageLog.push({
        mid: body.mid, name: med.name, delta, newQty: med.quantity,
        by: body.updatedBy || '', at: new Date().toISOString(),
      });
      if (room.usageLog.length > 100) room.usageLog = room.usageLog.slice(-100);

      await saveRoom(id, room);
      logToSheet('数量変更', body.updatedBy, med.name, `${delta > 0 ? '+' : ''}${delta} → 在庫:${med.quantity}`);
      return res.status(200).json({ status: 'ok', quantity: med.quantity, lots: med.lots });
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

        const qty = parseInt(item.quantity) || 1;
        const unit = (item.unit || '個').trim();

        // 同一薬剤名+単位の既存データを検索（ロット統合）
        const existing = room.medicines.find(m => m.name === name && (m.unit || '個') === unit);
        if (existing) {
          if (!Array.isArray(existing.lots)) existing.lots = [];
          const sameLot = expiryDate ? existing.lots.find(l => l.expiryDate === expiryDate) : null;
          if (sameLot) { sameLot.quantity += qty; }
          else { existing.lots.push({ expiryDate, quantity: qty }); }
          existing.lots.sort((a, b) => (a.expiryDate || '9999').localeCompare(b.expiryDate || '9999'));
          existing.quantity = existing.lots.reduce((s, l) => s + l.quantity, 0);
          existing.expiryDate = existing.lots.find(l => l.expiryDate)?.expiryDate || '';
          existing.updatedAt = new Date().toISOString();
          existing.updatedBy = (body.addedBy || '').trim(); // インポート実行者を記録
          if (!existing.location && item.location) existing.location = item.location.trim();
          if (!existing.category && item.category) existing.category = item.category.trim();
          if (item.barcode && !existing.barcode) existing.barcode = item.barcode.trim();
          added.push(existing);
        } else {
          const medicine = {
            mid: crypto.randomBytes(4).toString('hex'),
            name, quantity: qty, unit, expiryDate,
            location: (item.location || '').trim(),
            category: (item.category || '').trim(),
            memo: (item.memo || '').trim(),
            barcode: (item.barcode || '').trim(),
            lots: expiryDate ? [{ expiryDate, quantity: qty }] : [],
            addedBy: (body.addedBy || '').trim(),
            addedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          room.medicines.push(medicine);
          added.push(medicine);
        }
      }

      await saveRoom(id, room);
      if (added.length > 0) {
        logToSheet('CSVインポート', body.addedBy || '', `${added.length}件一括追加`, added.slice(0, 5).map(m => m.name).join(', ') + (added.length > 5 ? ` 他${added.length - 5}件` : ''));
      }
      return res.status(200).json({ status: 'ok', added: added.length, errors });
    }

    // === 管理人譲渡 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/transfer-admin$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const requestBy = (body.requestBy || '').trim();
      const newAdmin = (body.newAdmin || '').trim();
      if (!newAdmin) return res.status(400).json({ error: '譲渡先を指定してください' });
      if (room.admin && room.admin !== requestBy) {
        return res.status(403).json({ error: '管理人のみ権限を譲渡できます' });
      }
      room.admin = newAdmin;
      await saveRoom(id, room);
      logToSheet('管理人譲渡', requestBy, '', `${requestBy} → ${newAdmin}`);
      return res.status(200).json({ status: 'ok', admin: newAdmin });
    }

    // === クリニック完全削除（管理人のみ） ===
    if (pathname.match(/^\/api\/room\/[^/]+\/delete-room$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const requestBy = (body.requestBy || '').trim();
      if (room.admin && room.admin !== requestBy) {
        return res.status(403).json({ error: '管理人のみクリニックを削除できます' });
      }
      // Redisからルームデータを完全削除
      await redis.del(`med:${id}`);
      logToSheet('クリニック削除', requestBy, room.name || '', '完全削除');
      return res.status(200).json({ status: 'ok' });
    }

    // === スタッフ退出 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/leave$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const userName = (body.userName || '').trim();
      if (!userName) return res.status(400).json({ error: '名前が必要です' });
      if (room.admin === userName) {
        return res.status(403).json({ error: '管理人は退出前に権限を譲渡してください' });
      }
      if (Array.isArray(room.members)) {
        room.members = room.members.filter(m => m.name !== userName);
      }
      await saveRoom(id, room);
      logToSheet('退出', userName, '', 'クリニックから退出');
      return res.status(200).json({ status: 'ok' });
    }

    // === メンバー削除（管理人のみ） ===
    if (pathname.match(/^\/api\/room\/[^/]+\/kick-member$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const requestBy = (body.requestBy || '').trim();
      const targetName = (body.targetName || '').trim();
      if (room.admin !== requestBy) {
        return res.status(403).json({ error: '管理人のみメンバーを削除できます' });
      }
      if (targetName === room.admin) {
        return res.status(400).json({ error: '管理人は削除できません' });
      }
      if (Array.isArray(room.members)) {
        room.members = room.members.filter(m => m.name !== targetName);
      }
      await saveRoom(id, room);
      logToSheet('メンバー削除', requestBy, targetName, '管理人により削除');
      return res.status(200).json({ status: 'ok' });
    }

    // === 薬剤一括削除 ===
    if (pathname.match(/^\/api\/room\/[^/]+\/bulk-delete$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const body = await parseBody(req);
      let room = await getRoom(id);
      if (!room) return res.status(404).json({ error: 'Not found' });
      if (typeof room === 'string') room = JSON.parse(room);

      const mids = body.mids || [];
      if (!Array.isArray(mids) || mids.length === 0) {
        return res.status(400).json({ error: '削除対象が指定されていません' });
      }
      const midSet = new Set(mids);
      const before = room.medicines.length;
      const deletedNames = room.medicines.filter(m => midSet.has(m.mid)).map(m => m.name);
      room.medicines = room.medicines.filter(m => !midSet.has(m.mid));
      const deleted = before - room.medicines.length;
      await saveRoom(id, room);
      logToSheet('一括削除', body.deletedBy || '', `${deleted}件`, deletedNames.slice(0, 5).join(', '));
      return res.status(200).json({ status: 'ok', deleted });
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

    // === 系列グループ作成 ===
    if (pathname === '/api/group/create' && req.method === 'POST') {
      const body = await parseBody(req);
      const groupName = (body.name || '').trim();
      if (!groupName) return res.status(400).json({ error: 'グループ名を入力してください' });
      const groupId = crypto.randomBytes(4).toString('hex');
      const group = {
        id: groupId,
        name: groupName,
        roomIds: [],
        createdBy: (body.createdBy || '').trim(),
        created: new Date().toISOString(),
      };
      // ルームIDが指定されていたら即追加
      if (body.roomId) {
        group.roomIds.push(body.roomId);
        let room = await getRoom(body.roomId);
        if (room) {
          if (typeof room === 'string') room = JSON.parse(room);
          room.groupId = groupId;
          room.groupName = groupName;
          await saveRoom(body.roomId, room);
        }
      }
      await saveGroup(groupId, group);
      return res.status(200).json({ status: 'ok', groupId, group });
    }

    // === 系列グループにルーム追加 ===
    if (pathname.match(/^\/api\/group\/[^/]+\/add-room$/) && req.method === 'POST') {
      const groupId = pathname.split('/')[3];
      const body = await parseBody(req);
      const roomId = (body.roomId || '').trim();
      if (!roomId) return res.status(400).json({ error: 'ルームIDを指定してください' });

      let group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
      if (typeof group === 'string') group = JSON.parse(group);

      // 重複排除（配列をSetで整理）
      var uniqueIds = Array.from(new Set(group.roomIds || []));
      if (!uniqueIds.includes(roomId)) {
        uniqueIds.push(roomId);
      }
      group.roomIds = uniqueIds;
      await saveGroup(groupId, group);
      // ルーム側にもグループ情報を保持
      let room = await getRoom(roomId);
      if (room) {
        if (typeof room === 'string') room = JSON.parse(room);
        room.groupId = groupId;
        room.groupName = group.name;
        await saveRoom(roomId, room);
      }
      return res.status(200).json({ status: 'ok', group });
    }

    // === 系列グループからルーム削除 ===
    if (pathname.match(/^\/api\/group\/[^/]+\/remove-room$/) && req.method === 'POST') {
      const groupId = pathname.split('/')[3];
      const body = await parseBody(req);
      const roomId = (body.roomId || '').trim();

      let group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
      if (typeof group === 'string') group = JSON.parse(group);

      group.roomIds = group.roomIds.filter(r => r !== roomId);
      await saveGroup(groupId, group);

      // ルーム側からもグループ情報を削除
      let room = await getRoom(roomId);
      if (room) {
        if (typeof room === 'string') room = JSON.parse(room);
        delete room.groupId;
        delete room.groupName;
        await saveRoom(roomId, room);
      }
      return res.status(200).json({ status: 'ok' });
    }

    // === 系列グループ情報取得 ===
    if (pathname.match(/^\/api\/group\/[^/]+$/) && req.method === 'GET') {
      const groupId = pathname.split('/')[3];
      let group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
      if (typeof group === 'string') group = JSON.parse(group);
      // roomIdsの重複排除（既存データ修復）
      if (group.roomIds) {
        var unique = Array.from(new Set(group.roomIds));
        if (unique.length !== group.roomIds.length) {
          group.roomIds = unique;
          await saveGroup(groupId, group);
        }
      }
      return res.status(200).json(group);
    }

    // === 系列横断在庫ダッシュボード ===
    if (pathname.match(/^\/api\/group\/[^/]+\/dashboard$/) && req.method === 'GET') {
      const groupId = pathname.split('/')[3];
      let group = await getGroup(groupId);
      if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
      if (typeof group === 'string') group = JSON.parse(group);

      const clinics = [];
      // 薬剤名→{name, unit, category, clinics: [{clinicId, clinicName, quantity, expiryDate, lots}]} のマップ
      const medMap = {};

      for (const roomId of group.roomIds) {
        let room = await getRoom(roomId);
        if (!room) continue;
        if (typeof room === 'string') room = JSON.parse(room);
        clinics.push({ id: roomId, name: room.name });

        if (!Array.isArray(room.medicines)) continue;
        for (const med of room.medicines) {
          const key = med.name + '___' + (med.unit || '個');
          if (!medMap[key]) {
            medMap[key] = {
              name: med.name,
              unit: med.unit || '個',
              category: med.category || '',
              clinics: [],
            };
          }
          medMap[key].clinics.push({
            clinicId: roomId,
            clinicName: room.name,
            quantity: med.quantity,
            expiryDate: med.expiryDate || '',
            lots: med.lots || [],
          });
        }
      }

      const medicines = Object.values(medMap);
      return res.status(200).json({ clinics, medicines, groupName: group.name });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
