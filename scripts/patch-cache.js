// index.htmlのrenderGroupSection関数をキャッシュ方式に書き換えるスクリプト
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// 旧関数の開始と終了を見つけて置き換え
const startMarker = '    function renderGroupSection() {';
const startIdx = content.indexOf(startMarker);
if (startIdx === -1) {
  console.error('renderGroupSection が見つかりません');
  process.exit(1);
}

// 対応する閉じ括弧を見つける（ブレース数をカウント）
let braceCount = 0;
let endIdx = -1;
let inFunction = false;
for (let i = startIdx; i < content.length; i++) {
  if (content[i] === '{') {
    braceCount++;
    inFunction = true;
  }
  if (content[i] === '}') {
    braceCount--;
    if (inFunction && braceCount === 0) {
      endIdx = i + 1;
      break;
    }
  }
}

if (endIdx === -1) {
  console.error('関数の終端が見つかりません');
  process.exit(1);
}

const oldCode = content.substring(startIdx, endIdx);
console.log('旧コードの長さ:', oldCode.length);

const newCode = `    // グループデータキャッシュ（即表示用）
    function getGroupCache() {
        try { return JSON.parse(localStorage.getItem('med_groupCache') || '{}'); } catch(e) { return {}; }
    }
    function setGroupCache(gid, data) {
        try {
            var cache = getGroupCache();
            cache[gid] = data;
            localStorage.setItem('med_groupCache', JSON.stringify(cache));
        } catch(e) {}
    }

    // グループUI描画（キャッシュまたはAPIデータから）
    function buildGroupUI(groupIds, groupDataMap) {
        var dashSection = document.getElementById('groupDashSection');
        var dashList = document.getElementById('groupDashList');
        var listSection = document.getElementById('groupListSection');
        dashSection.classList.remove('hidden');
        dashList.innerHTML = '';
        listSection.innerHTML = '';
        var rendered = 0;
        for (var gi = 0; gi < groupIds.length; gi++) {
            var gid = groupIds[gi];
            var group = groupDataMap[gid];
            if (!group) continue;
            rendered++;
            (function(gid, group) {
                var roomIds = group.roomIds || [];
                var btn = document.createElement('button');
                btn.style.cssText = 'background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;width:100%;margin-bottom:6px;padding:12px;border:none;border-radius:10px;font-size:13px;font-weight:900;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;';
                btn.innerHTML = '<span>📊 ' + group.name + '</span><span style="font-size:11px;opacity:0.7;">' + roomIds.length + '院</span>';
                btn.addEventListener('click', function() { openDashboard(gid); });
                dashList.appendChild(btn);
                var history = getHistory();
                var clinicHtml = '';
                for (var ri = 0; ri < roomIds.length; ri++) {
                    var found = history.find(function(h) { return h.id === roomIds[ri]; });
                    var cName = found ? found.name : roomIds[ri].substring(0, 8) + '...';
                    clinicHtml += '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 6px;background:rgba(139,92,246,0.08);border-radius:6px;margin-bottom:3px;">' +
                        '<span style="font-size:11px;color:#c4b5fd;">🏥 ' + cName + '</span>' +
                        '<button style="background:none;border:none;color:#f87171;font-size:10px;cursor:pointer;padding:2px 6px;" onclick="removeRoomFromGroup(\\'' + gid + '\\',\\'' + roomIds[ri] + '\\')">✕</button>' +
                        '</div>';
                }
                var card = document.createElement('div');
                card.style.cssText = 'padding:10px;background:#0f172a;border:1px solid #334155;border-radius:10px;margin-bottom:8px;';
                card.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><div style="font-size:13px;color:#a78bfa;font-weight:900;">🏢 ' + group.name + '</div><span style="font-size:10px;color:#64748b;">' + roomIds.length + '院</span></div>' +
                    '<div style="margin:6px 0;">' + clinicHtml + '</div>' +
                    '<div style="font-size:10px;color:#475569;">ID: <span style="font-family:monospace;color:#94a3b8;cursor:pointer;" onclick="copyGid(\\'' + gid + '\\')">' + gid + '</span> 📋</div>' +
                    '<div style="display:flex;gap:4px;margin-top:6px;"><button class="btn btn-outline" style="font-size:10px;padding:4px 8px;" onclick="manageGroupClinics(\\'' + gid + '\\')">➕ クリニック追加</button><button class="btn btn-outline" style="font-size:10px;padding:4px 8px;color:#f87171;border-color:#f87171;" onclick="leaveGroup(\\'' + gid + '\\')">離脱</button></div>';
                listSection.appendChild(card);
            })(gid, group);
        }
        if (rendered === 0) {
            dashSection.classList.add('hidden');
        }
    }

    function renderGroupSection() {
        var dashSection = document.getElementById('groupDashSection');
        var dashList = document.getElementById('groupDashList');
        var listSection = document.getElementById('groupListSection');
        if (!dashList || !listSection) return;
        var groupIds = getGroupIds();
        if (groupIds.length === 0) {
            dashSection.classList.add('hidden');
            listSection.innerHTML = '<div style="font-size:12px;color:#64748b;line-height:1.6;">系列のクリニック間で在庫を横断的に確認できます。<br>「✨ グループ作成」からグループを作って、クリニックを追加してください。</div>';
            return;
        }
        // 1) キャッシュから即描画（ラグなし）
        var cache = getGroupCache();
        var hasCached = false;
        for (var ci = 0; ci < groupIds.length; ci++) {
            if (cache[groupIds[ci]]) { hasCached = true; break; }
        }
        if (hasCached) {
            buildGroupUI(groupIds, cache);
        }
        // 2) バックグラウンドでAPIから最新取得
        var pending = groupIds.length;
        var freshData = {};
        for (var gi = 0; gi < groupIds.length; gi++) {
            (function(gid) {
                apiCall('GET', '/api/group/' + gid, null, function(st, group) {
                    pending--;
                    if (st === 200 && group) {
                        freshData[gid] = group;
                        setGroupCache(gid, group);
                    } else if (st === 404) {
                        removeGroupId(gid);
                    }
                    if (pending === 0) {
                        var newJson = JSON.stringify(freshData);
                        var cacheJson = JSON.stringify(cache);
                        if (newJson !== cacheJson || !hasCached) {
                            buildGroupUI(getGroupIds(), freshData);
                        }
                    }
                });
            })(groupIds[gi]);
        }
    }`;

content = content.substring(0, startIdx) + newCode + content.substring(endIdx);
fs.writeFileSync(filePath, content, 'utf8');
console.log('✅ renderGroupSection をキャッシュ方式に書き換え完了');
