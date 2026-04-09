// 薬剤管理アプリ 拡張機能JS（v2）
// カテゴリフィルター、一括選択/削除、ロット表示、CSV日付パース強化、GS1検索、管理者メンバー削除、商品コード検索

(function() {
    // --- カテゴリフィルタークリックハンドラ ---
    document.getElementById('categoryTabs').addEventListener('click', function(e) {
        var tab = e.target.closest('[data-cat]');
        if (!tab) return;
        // currentCategory はグローバル（index.html側で定義）
        window._medCurrentCategory = tab.getAttribute('data-cat');
        var tabs = document.querySelectorAll('#categoryTabs .filter-tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
        tab.classList.add('active');
        if (window._medRenderMedicines) window._medRenderMedicines();
    });

    // --- 選択モード ---
    window.enterSelectMode = function() {
        window._medSelectMode = true;
        window._medSelectedMids = new Set();
        document.getElementById('bulkBar').classList.remove('hidden');
        document.getElementById('bulkBar').style.display = 'flex';
        document.getElementById('selectModeBtn').style.display = 'none';
        if (window._medRenderMedicines) window._medRenderMedicines();
    };
    window.exitSelectMode = function() {
        window._medSelectMode = false;
        window._medSelectedMids = new Set();
        document.getElementById('bulkBar').classList.add('hidden');
        document.getElementById('bulkBar').style.display = 'none';
        document.getElementById('selectModeBtn').style.display = '';
        if (window._medRenderMedicines) window._medRenderMedicines();
    };
    window.toggleSelectAll = function() {
        if (!window._medFilteredMids) return;
        var allSelected = true;
        for (var i = 0; i < window._medFilteredMids.length; i++) {
            if (!window._medSelectedMids.has(window._medFilteredMids[i])) { allSelected = false; break; }
        }
        if (allSelected) {
            window._medSelectedMids = new Set();
        } else {
            for (var j = 0; j < window._medFilteredMids.length; j++) {
                window._medSelectedMids.add(window._medFilteredMids[j]);
            }
        }
        if (window._medRenderMedicines) window._medRenderMedicines();
    };
    window.updateSelectCount = function() {
        var cnt = window._medSelectedMids ? window._medSelectedMids.size : 0;
        var el = document.getElementById('selectCount');
        if (el) el.textContent = cnt + '件選択中';
    };
    window.bulkDeleteSelected = function() {
        var mids = window._medSelectedMids ? Array.from(window._medSelectedMids) : [];
        if (mids.length === 0) { alert('削除する薬剤を選択してください'); return; }
        if (!confirm(mids.length + '件の薬剤を削除しますか？')) return;
        var roomId = window._medRoomId;
        var API = location.origin;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/api/room/' + roomId + '/bulk-delete', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            try {
                var r = JSON.parse(xhr.responseText);
                if (xhr.status === 200) {
                    window._medSelectedMids = new Set();
                    if (window.refreshRoomData) window.refreshRoomData();
                    if (window.showToast) window.showToast('🗑 ' + r.deleted + '件を削除しました');
                } else {
                    alert('削除に失敗: ' + (r.error || ''));
                }
            } catch(e) { alert('エラーが発生しました'); }
        };
        xhr.send(JSON.stringify({ mids: mids, deletedBy: window._medMyName || '' }));
    };

    // --- 日付パース（3パターンのみ） ---
    window.parseDateFlexible = function(str) {
        if (!str) return '';
        str = str.trim();
        // YYYY-MM-DD or YYYY/MM/DD
        var m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
        // YYYYMMDD
        m = str.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (m) return m[1] + '-' + m[2] + '-' + m[3];
        return str;
    };

    // --- GS1解析後の薬剤名検索強化 ---
    window.searchByBarcode = function(barcode) {
        if (!barcode || !window._medRoomData || !window._medRoomData.medicines) return null;
        return window._medRoomData.medicines.find(function(m) {
            return m.barcode === barcode || (m.barcode && barcode.indexOf(m.barcode) >= 0);
        }) || null;
    };

    // --- 管理者メンバー削除 ---
    window.kickMember = function(targetName) {
        if (!confirm(targetName + ' をメンバーから削除しますか？')) return;
        var roomId = window._medRoomId;
        var API = location.origin;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/api/room/' + roomId + '/kick-member', true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onload = function() {
            try {
                var r = JSON.parse(xhr.responseText);
                if (xhr.status === 200) {
                    if (window.showToast) window.showToast('🗑 ' + targetName + ' を削除しました');
                    if (window.refreshRoomData) window.refreshRoomData();
                } else {
                    alert('削除に失敗: ' + (r.error || ''));
                }
            } catch(e) { alert('エラーが発生しました'); }
        };
        xhr.send(JSON.stringify({ requestBy: window._medMyName || '', targetName: targetName }));
    };
})();
