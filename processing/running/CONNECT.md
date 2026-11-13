# 完成済みのDriveデータを画面につなぐ

2026-11-13の `NEW_CSV_PASS` を受けた次の工程。CSV処理の検証は合格として引き継ぐ。**12段階・24時間監視・新CSV取り込みを再実行する必要はない。** 既存のApps Scriptコード・プロパティ・キャッシュ・トリガー・元CSVを変更しない。

## 今回できること

`/?source=drive#records` で、Googleログインした本人だけが完成済みの表示データを読める。現在のカレンダー・ルート概形・月間集計・速度付き地図・RUNNING LOG・探索済み範囲・新しく走った距離をそのまま使う。上部の接続ボタンから更新・ログアウト・元の表示への復帰ができる。日記・名前・配色の保存先は従来のブラウザー内。

通常URLと `/?source=local#records` は従来方式。公開ビルドの静的データは引き続き空。接続設定がなくても従来画面が動き、Driveプレビューは設定不足と表示する。

```text
Apps Script（今回変更しない）→ 既存 derived / new-csv-index.json と JSON群
                                             ↓ 読み取りのみ
Googleログイン → Vercel Functions → MyPaceの現在の画面
```

- Googleの公式認証ライブラリでコード交換・IDトークン検証。state・nonce・PKCEを使用。
- 固定した `derived` フォルダの所有者であり、そのフォルダが非共有であることを確認。別アカウントではログイン不可。読み込み時も所有・共有状態を確認する。
- Googleトークンは暗号化したHttpOnly Cookieに保持。ブラウザーのJSやlocalStorageへ渡さない。セッションは最長30日、Google側で失効した場合は再ログイン。
- APIが受け付けるのは `index.json` と `objects/<SHA-256>.json` のみ。Drive IDやCSVの指定は不可。サーバー側の接続先以外を読まない。
- 内容ハッシュで固定されたファイルはSHA-256を照合。本文は128KiB以下。応答は `private, no-store`、CDNにも保存しない。GPS・トークン・Googleのエラー本文をサーバーログへ出さない。
- 履歴・概形は軽い一覧から取得。日別は選んだ日の経路、月別は月の軽量経路、分析は詳細を開いたとき、探索マスクは表示範囲のブロックだけ取得。キャッシュはブラウザーのメモリー内。地図の探索・新しい道を生CSVから再計算しない。
- CSV変換・Drive書き込み・Apps Scriptの起動を行うAPIは追加していない。画面を開くための初回全件CSV処理はない。

## あなたの操作：初回だけ

### 1. GoogleのWeb用OAuthクライアントを用意

既存のGoogle Cloudプロジェクトを使える。Apps Scriptの関連付けを変える必要はない。

1. Google Cloudで **Google Drive API** が有効か確認する。課金アカウントや有料サービスの追加は不要。
2. Google Auth Platformの対象は個人Gmailなので **External**。まずTestingの場合は、Driveのフォルダを所有するアカウントをテストユーザーに入れる。
3. データアクセスは `openid`、メール、`https://www.googleapis.com/auth/drive.readonly`。このGoogle権限自体はDrive全体の読取権限であることを確認して同意する。アプリの実装では指定した表示用フォルダだけを読む。別のApps Scriptが作成済みのファイルなので、`drive.file` だけではそのまま読めない。[Driveの権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
4. クライアント種類 **ウェブアプリケーション** を作る。既存の適切なWebクライアントがあれば再利用できる。リダイレクトURIを `https://現在のMyPaceのドメイン/api/google-auth` にする。URL末尾・プロトコル・ドメインを完全一致させる。ローカルでも使うなら `http://127.0.0.1:4173/api/google-auth` を追加する。
5. クライアントIDとシークレットを次の環境変数へ保存する。GitHubやチャットへ貼る必要はない。

Testingのままだと、このDrive権限ではGoogleの更新トークンは7日で失効する。継続利用ではOAuthの公開ステータスをIn productionにすることで、このTesting固有の7日制限を外せる。本人専用は審査免除の対象だが未確認アプリの警告が出る場合がある。OAuthの公開ステータスを変えても、Driveの共有設定やアプリの所有者制限は変わらない。[トークンの期限](https://developers.google.com/identity/protocols/oauth2#expiration)、[個人利用の扱い](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#personal-use)

### 2. Vercelに接続設定を保存

現在のプロジェクトの **Settings → Environment Variables** に以下を設定し、同じコードを再デプロイする。Hobbyのまま使う。Previewにも設定する場合、GoogleのリダイレクトURIと `MYPACE_ORIGIN` にその環境の固定ドメインを用いる。

| 変数 | 値 |
| --- | --- |
| `MYPACE_ORIGIN` | 実際のMyPaceのURLの先頭部分。例 `https://your-project.vercel.app`。末尾 `/` なし |
| `GOOGLE_CLIENT_ID` | Web用OAuthクライアントのID |
| `GOOGLE_CLIENT_SECRET` | そのシークレット |
| `MYPACE_SESSION_SECRET` | 32文字以上のランダムな秘密値 |
| `MYPACE_DRIVE_FOLDER_ID` | **既存の「MyPace 差分更新検証 … / derived」** のフォルダID |
| `MYPACE_DRIVE_CATALOG` | `new-csv-index.json` |

作業中のPCの `.env.local` には、接続先フォルダIDとランダムなセッション秘密値を設定済み。未入力はGoogleクライアントID・シークレット。Vercelへコピーする際は `MYPACE_ORIGIN` を公開ドメインへ変更する。このファイルはGit・静的ビルドの対象外。

別のチェックアウトでは `.env.example` を `.env.local` へコピーして設定する。秘密値はパスワード生成ツールなどで作る。ローカル起動は `npm ci` → `npm start`。**Vercelで使うときにPCを起動しておく必要はない。** Vercel Functionsはアクセス時だけ動き、Hobbyの無料枠を使う。有料プラン・常駐サーバー・外部DB・Cronは追加していない。[Vercel Functionsの枠](https://vercel.com/docs/functions/limitations#cost-and-usage)

### 3. 画面を開く

MyPace右上の「ローカル」→「Googleでログイン」。完了するとDriveプレビューへ移動する。

今回は **実記録4件** が対象。以前のローカル画面にあった全件を取り込んだわけではない。前の3CSVと今回の1CSVの完成結果を表示する。検証用の人工記録1件は、その固定IDだけを履歴から除外する。Googleの検証用カタログには人工記録の探索マスクも残っているが、実記録周辺の表示には関係しない。検証データを削除して整え直す作業は要求しない。

実際のGoogleログインを通した公開環境の表示確認は、この設定後に行う。確認は **日を選ぶ → 月表示 → 詳細を開閉 → 接続メニューから元の表示へ戻す** で十分。処理検証の再実行・新CSV追加・24時間待機は不要。問題があれば画面のエラー文だけを返す。GPS画像やIDの共有は不要。

## 切り戻し

接続メニューの「元の表示方式に戻す」、または `/?source=local#records` を開く。従来の `data/running.json` 読込へ戻り、Driveの応答を使わない。公開版では空データ、元のPCでは元のローカルデータになる。日記・配色は保持する。Googleとのログインを終了する場合は「ログアウト」。Cookieを削除し、画面を再読込してメモリー内の個人データを破棄する。

接続機能そのものを止める場合はVercelで `MYPACE_DRIVE_FOLDER_ID` を外して再デプロイする。セッション秘密値の変更も既存セッションを無効にする。Googleの原本・表示用データ・キャッシュへ復旧操作は不要。

## 開発側で確認したこと

- Googleから完成JSONだけを読み取り、Git対象外のローカルデータで既存UIを表示。実記録4件の日別経路・分析・月別経路が読めることを確認。
- ローカルブラウザーで1366×768のスクロールなし、速度付き経路、詳細開閉、日別／月別遷移、元方式への復帰、390px幅の表示、JS例外なしを確認。
- このブラウザー確認のGoogle通信部分は、読み取った完成JSONへのテスト用差し替え。**実Google OAuthの同意・Vercel環境変数の設定完了を意味しない。** 製品コードに認証を省略するモードはない。
- 自動テスト147件成功。合成データの認証テストで、state/nonce/PKCE、他者・共有フォルダ拒否、未ログイン・別Origin・CSV指定拒否、トークン更新、ハッシュ不一致、ログアウトを確認。
- 公開ビルドが空データで、認証用サーバーコード・設定・ローカル完成データを静的出力へ含めないことを確認。

## 過去の大量CSVと日次枠

今回の接続は完成データを読むだけなので、Apps Scriptの変換時間枠を消費しない。まだ変換していない過去CSVを大量に追加する場合は別途、日ごとの処理予算・途中保存・翌日再開を持つ継続運用へ進める。

個人アカウントのトリガー総実行時間は90分／日、1実行は6分。枠はユーザー単位で共有され、単純な午前0時リセットではなく最初の要求から24時間。Googleの残量は内部計測値から厳密には求められない。[Googleの割り当て](https://developers.google.com/apps-script/guides/services/quotas)

大量取り込みは、監視込みの内部予算を余裕を持って設定し、超える前に途中状態を保存して再開を予約する方式が適する。新しい記録を優先し、過去分を順次追加できる。ただし過去分が加わると「新しく走った道」の基準も変わるので、関連する後続記録の集計も更新する。これらの運用スケジューラーは**今回の読み取り接続では追加していない**。現在の検証トリガーは終了済みで、日々の継続監視が既に有効になっているわけではない。
