// 薬剤名検索API — GTINコードから薬剤名を取得
module.exports = async (req, res) => {
    // CORS設定
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { code } = req.query;
    if (!code) {
        return res.status(400).json({ error: 'codeパラメータが必要です' });
    }

    // GTINからJANコードを抽出（先頭の0を除去して13桁にする）
    let jan = code;
    if (jan.length === 14 && jan.startsWith('0')) {
        jan = jan.substring(1); // 14桁→13桁
    } else if (jan.length === 14 && jan.startsWith('1')) {
        jan = jan.substring(1); // 14桁→13桁
    }

    try {
        // 方法1: Yahoo Shopping APIで検索
        const yahooResult = await searchYahoo(jan);
        if (yahooResult) {
            return res.json({ name: yahooResult, source: 'yahoo', jan: jan });
        }

        // 方法2: 汎用バーコードDBで検索
        const upcResult = await searchUPCItemDB(code);
        if (upcResult) {
            return res.json({ name: upcResult, source: 'upcitemdb', jan: jan });
        }

        return res.json({ name: null, source: null, jan: jan });
    } catch (e) {
        return res.json({ name: null, error: e.message, jan: jan });
    }
};

// Yahoo Shoppingで商品名を検索
async function searchYahoo(jan) {
    try {
        const url = `https://shopping.yahoo.co.jp/search?p=${jan}`;
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MedManager/1.0)' },
            redirect: 'follow'
        });
        const html = await resp.text();

        // 商品名を抽出（検索結果の最初のタイトル）
        const titleMatch = html.match(/<a[^>]*class="[^"]*ItemList[^"]*Title[^"]*"[^>]*>([^<]+)<\/a>/i);
        if (titleMatch) return titleMatch[1].trim();

        // 別パターン
        const altMatch = html.match(/<h3[^>]*><a[^>]*>([^<]+)<\/a><\/h3>/);
        if (altMatch) return altMatch[1].trim();

        return null;
    } catch {
        return null;
    }
}

// UPC Item DB（無料トライアルAPI）で検索
async function searchUPCItemDB(code) {
    try {
        const resp = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`, {
            headers: { 'Accept': 'application/json' }
        });
        const data = await resp.json();
        if (data.items && data.items.length > 0) {
            return data.items[0].title;
        }
        return null;
    } catch {
        return null;
    }
}
