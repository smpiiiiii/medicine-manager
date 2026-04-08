// Google Apps Script — 薬剤管理ログ受信スクリプト
// このコードをスプレッドシートのApps Scriptに貼り付けてWebアプリとしてデプロイしてください
// デプロイ時: 実行ユーザー=自分、アクセス=全員
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([
    data.timestamp || new Date().toLocaleString('ja-JP'),
    data.action || '',
    data.userName || '',
    data.itemName || '',
    data.details || ''
  ]);
  return ContentService.createTextOutput(JSON.stringify({status:'ok'})).setMimeType(ContentService.MimeType.JSON);
}
