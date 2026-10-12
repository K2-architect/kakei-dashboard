# このリポジトリでの決まり

家計ダッシュボード（個人用）。画面は GitHub Pages、データは Apps Script の API、置き場所は個人の Google スプレッドシート「家計簿」。

## 必ず守ること

1. **スプレッドシートのデータを書き換える前に、必ず本人に確認をとる。**
   - 読むだけの操作は確認なしでよい。
   - 書き込み API（`tx.setCategory`）のテストは、確認をとったうえで行い、テストした行は元に戻す。
2. **お金のデータを外に出さない。** このリポジトリは公開。
   - 実データ・スナップショット・実際の金額が写ったスクリーンショット・スプレッドシートの中身は、コミットしない。
   - テストと見本のデータは架空の数字で作る（`tests/make-demo.js`）。
   - コミットしてよい識別子は、OAuth クライアントID・GAS の URL・スクリプトID だけ。
   - 秘密の値（`SESSION_SECRET`、`ALLOWED_EMAILS`）は GAS のスクリプト プロパティに置く。
3. **今のアプリを止めない。** 旧デプロイ（バージョン2）は、本人が OK を出すまで更新も削除もしない。
4. **計算ロジックは変えない。** `gas/app.js` の `appCompute_` と、その下の小物の関数はそのまま使う。
5. **`gas/コード.js` と `gas/無題.js` には触らない。** 同じ Apps Script プロジェクトにある別の仕組み（JCB メール取込、共同家計簿からの連携）。`clasp push` は全ファイルを上書きするので、ここに置いたまま中身を変えない。push の前に `shasum -a 256 -c tests/untouched.sha256` で確かめる。
6. 文言は今の画面に合わせる。日本語で、専門用語を避ける。

## 決まりごと

- GAS の関数名は `app` で始める（`doGet`・`doPost` は例外）。API まわりは `appApi` で始める。
- API は POST だけ。`Content-Type: text/plain`、本文は `{ action, session, payload }`、返事は `{ ok, data }` か `{ ok:false, error:{ code, message } }`。
- 「全員」がアクセスできるデプロイなので、`doGet` で画面やデータを返さない。
- 日付は文字列で返す。
- データは端末に保存しない（保存するのはログインのセッションとメールアドレスだけ）。

## 確かめ方

```
node tests/api.test.js     # API と認証（架空の値）
node tests/make-demo.js    # 計算の確認と、見本データ assets/demo-data.js の作り直し
python3 -m http.server     # http://localhost:8000/?demo=1 で見本データの画面を見る
```
