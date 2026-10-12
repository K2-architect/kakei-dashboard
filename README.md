# kakei-dashboard（家計ダッシュボード）

個人用の家計ダッシュボードです。

- 画面：このリポジトリ（GitHub Pages）　https://k2-architect.github.io/kakei-dashboard/
- データ：個人のスプレッドシート「家計簿」にひも付いた Apps Script「家計簿取得」。画面からは JSON を POST して読み書きします（`gas/app_api.js`）
- ログイン：Google アカウント。許可したメールアドレスだけが使えます

`?demo=1` を付けて開くと、ログインなしで見本データ（架空の数字）の画面を見られます。

## ファイル

| 場所 | 中身 |
| --- | --- |
| `index.html`、`assets/` | 画面 |
| `config.js` | OAuth クライアントID と API の URL |
| `gas/` | Apps Script のソース（clasp で同期）。`コード.js` と `無題.js` は別の仕組みなので触らない |
| `tests/` | 架空データでのテストと、見本データを作るスクリプト |

## 初期設定（最初の1回だけ）

1. Google Cloud で OAuth クライアントID（ウェブ アプリケーション）を作る。
   - 承認済みの JavaScript 生成元：`https://k2-architect.github.io`
   - 承認済みのリダイレクト URI：`https://k2-architect.github.io/kakei-dashboard/`
2. クライアントID を `config.js` と `gas/app_api.js`（`APP_API_CLIENT_ID`）に書く。
3. `cd gas && clasp push` で Apps Script に反映する。
4. Apps Script のエディタで `appApiSetup` を実行する。権限の画面では、すべての項目にチェックを入れて許可する。
   - 使える人は、実行した本人のアカウントだけになります。
5. ［デプロイ］→［新しいデプロイ］→ 種類「ウェブアプリ」、次のユーザーとして実行「自分」、アクセスできるユーザー「全員」。
6. できた URL（末尾が `/exec`）を `config.js` の `API_URL` に書いて push する。

## Apps Script のコードを直したとき

コードを変えても、デプロイを新しいバージョンにしないと `/exec` の URL は古いコードのままです。

```
shasum -a 256 -c tests/untouched.sha256   # 触らないファイルが変わっていないことを確かめる
cd gas
clasp push
clasp create-deployment -i AKfycbwG55WNj-ADyYrhVqyJhWZht_kKm3_x6W5shI2EnPHviVvzisSk9qWy8s7CzJgnznV9Xg -d "説明"
```

エディタから行う場合は、［デプロイ］→［デプロイを管理］→ API 用のデプロイを編集 → バージョン「新しいバージョン」→ デプロイ。どちらの方法でも URL は変わりません。

## 画面を直したとき

`main` に push すると、1〜2分で GitHub Pages に反映されます。ホーム画面のアプリは、一度閉じて開き直すと新しい画面になります。

## 元に戻す（ロールバック）

- **画面**：`git revert <コミット>` して push する。
- **API**：［デプロイを管理］→ API 用のデプロイを編集 → バージョンを前の番号に戻す。
- **前のダッシュボード**：旧デプロイ（バージョン2、アクセスは自分のみ）は残してあります。URL は Apps Script の［デプロイを管理］で確認できます。

## ログインを切る（セッションの失効）

- **全員をログインし直しにする**：エディタで `appApiNewSecret` を実行する。それまでのログインはすべて使えなくなります。端末をなくしたときはこれを行います。
- **使える人を変える**：［プロジェクトの設定］→［スクリプト プロパティ］の `ALLOWED_EMAILS` を書き換える（カンマ区切り）。外した人は、ログイン済みでもすぐ使えなくなります。
- ログインは30日で切れます。切れたら、もう一度「Google でログイン」を押します。

## うまくいかないとき

- **ログインの後に何も起きない・画面が白くなる**：ログイン画面の「うまくいかないときは、ページを移動してログイン」を使う。
- **LINE などのアプリの中で開いた**：Google のログインが使えません。Safari で開き直す。
- **「このアカウントでは使えません」**：`ALLOWED_EMAILS` に入っていないアカウントでログインしています。
