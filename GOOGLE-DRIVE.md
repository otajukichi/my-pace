# Google Drive 同期（個人用・初版）

Google Drive への保存は任意です。未接続のまま、これまでどおり端末で使えます。接続・フォルダー選択だけでは記録を送信しません。

## 本人が行う初回確認

1. 記録があるアドレスで「設定 → 保存と復元 → JSON を保存」を実行します。localhost と Vercel は別の保存領域です。Vercel に記録がない場合は、その JSON を復元してから保存内容を決めてください。
2. 更新を自分で適用・検証・公開した後、`https://my-pace-gules.vercel.app` を開きます。
3. 「設定 → Google Drive → 接続設定」に、Google Cloud の **Web OAuth クライアント ID** と **制限付きブラウザー用 API キー** を入力します。どちらもチャットや GitHub に貼りません。保存チェックは任意で、外すと以前の保存設定も消します。
4. 「Google の準備」を押すと Google の SDK を読み込みます。その後、別のクリックで「Google に接続」を押します。ポップアップが閉じられた場合は再度押してください。
5. 「my-pace を選択」で、Google Picker から本人所有の `my-pace` フォルダーを選びます。ID を知っているだけでは利用許可になりません。選択した本人所有・非共有・フォルダー種別・追加可能・非削除をアプリ側でも検証します。
6. 「Drive を確認」で既存の同期版を調べます。既存の版があれば、空の端末データを自動で採用しません。「版を選んで復元」か、内容を確認して「端末の記録を採用」を選びます。復元は端末の全件置換です。
7. 初回は「Drive に保存」を押し、日記・予定・起床・習慣・ランの位置情報・庭の設定の送信を確認します。アプリが書込み後に同じ内容を読み直し、ハッシュと厳密な記録形式を検証します。
8. 別のブラウザープロファイルでも接続・Picker 選択を行い、「Drive を確認 → 版を選んで復元」で件数と内容の一致を確認してください。これが実際の端末間の読戻し確認です。SDK・OAuth・Picker と本番ヘッダーのライブ動作は、このパッチのオフラインテストでは確認できません。
9. 手動保存とアプリ内の読戻し確認に成功すると、「開いている間の自動保存を有効にする」を選べます。毎回の新しいページセッションで明示的に有効にします。

## 認証情報と設定

- プロジェクト番号: `402304619999`、Drive API / Google Picker API を使用。
- 許可するスコープ: `https://www.googleapis.com/auth/drive.file` のみ。
- OAuth Web origin: `https://my-pace-gules.vercel.app`。ポップアップ型なので redirect URI は使いません。
- Picker API キーの Website restrictions は本番の `https://my-pace-gules.vercel.app/*` と `https://docs.google.com/*`。API restrictions は Google Picker API と Google Drive API。アプリ内ではサーバー側のキー制限までは確認できません。
- ローカルで接続試験をする場合は、実際に使う localhost/127.0.0.1 の origin と Web referrer を Google Cloud に本人が追加する必要があります。本番だけを登録した設定でローカル接続が失敗しても、アプリの通常機能は使えます。
- OAuth クライアント ID と制限付き API キーはブラウザー向け識別情報です。client secret、refresh token、パスワードは不要で、アプリには入れません。
- アクセストークンはメモリーだけに保持します。localStorage、JSON バックアップ、ログ、リポジトリーには保存しません。
- 接続設定は本人が保存チェックした場合のみ、記録とは別の localStorage キーに保存します。共有ブラウザープロファイルでは他の利用者も読めます。記録の JSON バックアップには入りません。
- 「接続を解除」はこのページの接続とトークンを破棄し、同期を止めます。Google アカウント側のアプリ許可は取り消しません。Drive のファイルも削除しません。

## 保存・競合・制限

- 既存の記録キー `rhythm.personal.v1` と schema 2、JSON import/export、直後の1回の Undo は維持します。
- Drive に保存するのは `mypace-<変更ID>.json` の版付きスナップショットです。同期情報は既存 state の外側に置きます。既存版を上書き・削除しません。送信直前にも保存先が本人所有・非共有・追加可能であることを確認します。
- `running_data` と既存 CSV を列挙・読取り・書込みしません。Drive 全体やフォルダー以下すべての読取り権限は要求しません。
- 端末保存と Drive 反映は別です。通信エラーや認証切れでも端末記録を残します。送信する版と事前生成した Drive ID を、送信前に端末へ保存します。結果不明の再試行は同じ ID と内容を確認します。
- 送信中に編集した新しい内容を、古い送信の完了だけで「反映済み」にしません。必要なら次の保存を行います。
- 同時に別端末で変更すると複数の末端版ができます。日時だけで勝者を決めません。両方を残し、自動保存を止め、本人の選択を待ちます。履歴欠損・壊れた JSON・不一致ハッシュ・異なるデータセットの混在も停止します。
- 原子的な上書きチェックは Drive version に期待しません。ここでの安全策は追記だけの版管理・事後検証・競合停止です。
- ページを閉じている間は同期しません。認証期限切れでは本人の再接続が必要です。自動保存は編集をまとめて送信し、接続中の online/再表示時にも未送信分を再確認します。Drive の変更を常時監視する機能はありません。
- Web Locks のないブラウザーでは安全のため Drive 書込みと自動保存を無効にします。手動の確認・復元と通常の端末保存は利用できます。
- この初版の **Drive 保存は1版 5,000,000 bytes まで**。Google が小さいファイル向けに案内する multipart upload を使います。大きい状態は送信前に停止し、端末データを残します。通常のローカル JSON は従来の12MiB上限を維持します。大きいGPXを継続同期する場合は resumable upload の追加が必要です。
- 版の親関係とハッシュを小さな Drive 属性に保存し、一覧をページングして履歴のつながりを確認します。通常は現在の末端版だけを読み、過去の GPX を毎回すべてダウンロードしません。未変更の状態は新しい版を作りません。「版を選んで復元」は25版ごとの一覧から過去版も選べ、選んだ版だけを読みます。確認画面でその版の通常の JSON バックアップも保存できます。
- 安全上、履歴一覧10,000版・同時分岐64版・読み込む末端分岐の合計64MiBを上限にし、省略せず停止します。64MiBは蓄積した過去履歴全体の制限ではありません。履歴上限が近づいたら、通常のJSONバックアップを確保し、保持版数やフォルダー移行を拡張してください。この版は指定フォルダー固定です。自動整理・削除はしません。手動で過去版を削除すると親参照が欠けて止まるので、勝手に整理しないでください。
- localStorage の空き容量が足りず送信待ちを保存できない場合はアップロードを開始しません。記録自体の端末保存には通常どおり容量制約があります。

## セキュリティヘッダー

開発サーバーと `vercel.json` に同じ CSP を適用します。スクリプトは自分の origin と GIS/Google API SDK、接続は Google の GIS と Drive、フレームは GIS と Picker に限定。script の inline/eval や全 origin ワイルドカードは許可しません。Picker のダイアログ配置にはインライン style が必要なため、style のみ許可します。COOP は `same-origin-allow-popups`、Referrer-Policy は `strict-origin-when-cross-origin`。通常のアプリ読み込み時は外部 SDK を読み込みません。

このアプリ独自の暗号化やサーバー側認証はありません。ブラウザーで動く同一 origin のコードと、本人が読み込みを許可した Google SDK が信頼範囲です。

## 公式資料

- [GIS トークンモデル](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google Picker とキー制限](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Drive の権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [ファイルの新規アップロードと再試行](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [GIS の CSP / COOP](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)
