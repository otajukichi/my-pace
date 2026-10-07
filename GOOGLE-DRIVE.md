# 本人専用 Google Drive 接続

## 保存と認証

所有者は `yakitorihanbagu0412@gmail.com`。アプリの永続データは固定した Google Drive 保存先へ、単一の Apps Script ライターから書き込みます。設定がない、保存先が消えた、権限がない場合に別の保存先を自動作成しません。実データを公開フォルダーへ移さないでください。

公開画面とデータ API は別です。API は Google の署名検証済み ID トークン、確認済み本人メール、固定した Google subject と署名済みセッションで制限します。セッションは Secure / HttpOnly / SameSite=Strict、有効期間30日。プレビュー環境で本番秘密を使わず、コードも VERCEL_ENV=preview を拒否します。

## A. 同じ Apps Script プロジェクトを準備

1. 既存の所有者用プロジェクトを開きます。別プロジェクトを第二ライターとして作らないでください。
2. `gas/MyPaceComplete.gs` 全体を一つのスクリプトとして配置します。これは OwnerImportKit + SecureSync + web-entry を各一度含みます。`storage/gas/OwnerImportKit.gs`、`gas/SecureSync.gs`、`gas/web-entry.gs` を追加で貼らないでください。既存プロジェクト内に旧 MyPace の同名関数がある場合は、コピーを保存してから重複しない形に置換します。`doPost` を二重に置かないでください。
3. `storage/gas/appsscript.json` を参照し、既存マニフェストへ必要な設定を統合します。無関係な設定を消さず、Drive Advanced Service v3 と必要な権限を確認します。`Session.getEffectiveUser()` 用の `https://www.googleapis.com/auth/userinfo.email` は追加同意が必要です。従来の Drive データアクセス許可とは別です。
4. 所有者のエディターで `MyPaceImportBootstrap` を明示実行します。既存の固定保存先がある場合は再作成しません。生成された store ID を確認します。
5. Script Properties に `MYPACE_STORE_ID` と `MYPACE_WRITER_SECRET` を設定します。後述のサーバー値と一致させます。秘密をソースへ直書きしないでください。
6. Google Drive で、既存の `my-pace` フォルダー（ID `1kqtRzzNKZAq7-HE83XIN_JErtBn9YM_6`）が本人所有・非共有であることを先に確認します。bootstrap で作成された同じ `MyPace Private Store` フォルダー（store ID と一致）を、My Drive 直下からそこへ本人が移動します。コピーや再作成はせず、metadata/assets の子フォルダーと固定 ID を保ちます。その後、同じスクリプトで `MyPaceImportStatus` を実行して配置を確認します。元の My Drive 直下かこの正確な移動先だけを許可し、自動移動や任意の移動先設定はしません。確認に失敗したら保存先をリセットせず原因を確認します。
7. Apps Script の「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」を選び、「次のユーザーとして実行」は自分（所有者）、「アクセスできるユーザー」は「全員（Anyone）」を本人が確認して選びます。サーバーは Google ログイン Cookie を送らないため、匿名の到達性が必要です。「Google アカウントを持つ全員」や「自分のみ」とは異なります。この操作で Web エンドポイント自体は誰でも到達可能になりますが、有効な署名・本人・保存先・時刻・操作検証を通らない要求は Drive に触れません。設定の意味を確認したうえでデプロイし、`/exec` URL を控えます。組織ポリシーなどで「全員」が選べなければここで止めます。制限を回避する代替経路は使いません。

## B. 秘密と Vercel の設定

`.env.example` はキーの見本です。実際の `.env` は Git に追加しません。サーバー専用の秘密は、それぞれ独立した32バイト以上の暗号学的乱数にしてください。自分の端末で次のコマンドを別々に実行できます。出力をチャットに貼らず、対応する設定欄へ入力します。

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

- `MYPACE_ORIGIN`: 本番の正確な HTTPS origin、末尾スラッシュなし
- `GOOGLE_CLIENT_ID`: 既存 Google Identity Web クライアント ID（公開識別子）
- `MYPACE_SESSION_SECRET`: セッション用秘密
- `MYPACE_SECURITY_GENERATION`: 例 `1`。変更すると既存セッションを無効化
- `MYPACE_OWNER_SUB`: 初回の検証済み本人ログインで確認する固定 subject
- `MYPACE_WRITER_URL`: 同じ Apps Script のバージョン付き `/exec` URL
- `MYPACE_WRITER_SECRET`: Apps Script と共有する別の秘密
- `MYPACE_STORE_ID`: bootstrap で確認した固定 store ID

通常の許可された環境で `npm install --ignore-scripts --no-audit --no-fund` を実行し、`google-auth-library` 10.9.1 を導入します。今回のクラウド作業では取得が HTTP 403 ポリシー制限で停止しており、実ライブラリーによる認証を検証していません。 これは最初の本番ログインより前に完了させる必須手順です。

最初は `MYPACE_OWNER_SUB` を空にし、他の必要設定をそろえます。本人ログインの検証が通ると初期設定用 ownerSubject だけを返し、まだデータセッションは発行しません。ログイン画面に表示される Google 識別子（ownerSubject）を自分で確認し、`MYPACE_OWNER_SUB` へ固定してから再デプロイ・再ログインします。ID トークンをコピーして公開したり、チャットへ貼ったりしないでください。

Vercel は Node.js 20以上、Build Command `npm run build`、Output Directory `dist` と `api/` Node Functions を使用します。Project Root は `package.json`・`api/`・`server/` があるアプリ全体のルートです。`dist` だけをアップロードする静的デプロイでは認証・同期 API が動きません。既存プロジェクト設定が一致するか確認してください。`api/sync.js` の最大実行時間は60秒です。Production だけに実秘密を設定してください。設定してからビルド・デプロイし、受入確認に進みます。

## C. Google 側の本人操作

Google Identity の許可 origin を本番 origin と一致させます。Google Cloud OAuth の公開ステータスが Testing のままなら、Production への変更と表示された確認は本人が行います。変更だけで検証要否や全ユーザーへの公開が保証されるわけではなく、画面の案内に従ってください。API キーや Picker の設定は今回の方式には不要です。

## D. データ移行と限界

- 元の localStorage は残ります。自動上書きせず、移行プレビューの追加・競合を確認してから進みます
- 未送信キューへの IndexedDB 保存が完了してから画面を成功扱いにします。キュー保存と Drive 反映は別の状態です
- 同じ記録の競合は双方を表示して明示選択します。新しい状態になった古いダイアログは拒否します
- 大きな GPS データはフォルダー取込で段階処理します。通常の1記録は UTF-8 120,000 バイトが上限です。巨大な旧 inline GPX を含む記録は黙って切り捨てず拒否します。これは50 MB超などの大きな元 CSV を分割取込する経路のファイルサイズ上限とは別です
- 取込済み GPS の表示は手入力ランと別で、距離や庭の報酬を捏造しません
- 実ブラウザーの IndexedDB と本番 Drive / Apps Script / Vercel の結合試験は別途必要です

参考: [Google ID トークン検証](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)、[Apps Script Web アプリ](https://developers.google.com/apps-script/guides/web)、[Vercel 関数時間](https://vercel.com/docs/functions/configuring-functions/duration)。

取込を実行している間は同じ Apps Script のロックを使うため、画面からの同期が待ち・再試行になることがあります。最初の受入では取込と画面操作を分けて確認してください。並行運用の速度・待ち時間は未検証です。

手動取込はエディターで `MyPaceImportStart` → 必要に応じて `MyPaceImportResume`。`MyPaceImportStatus` は中断チェックポイントの復旧を進める場合があり、完全な読取専用操作ではありません。詳細は storage/OWNER-KIT.md を参照してください。そちらは単独取込キットの説明です。この統合版の Web デプロイには本ページの署名受付・本人認証設定を使います。

公開サイトの画面自体を非公開にする設定と、記録データ API の本人認証は別です。このコードは画面が公開されていても記録 API を本人に限定する設計で、Web サイト全体の非公開化を行うものではありません。ブラウザーへ Google Drive アクセストークンを渡す経路はありません。

## E. 自動取込を有効にする（本人が Google で操作）

本番の少量取込・中断・再開試験が通り、OAuth 公開状態と追加同意を確認してから設定します。定期処理は同じ統合 GAS に含まれますが、コードはトリガーを勝手に作りません。

1. 同じ所有者プロジェクトの Script Properties に `MYPACE_WRITER_SECRET` を設定済みか確認します。署名受付と同じ秘密を使います。新しい保存先は効率的な履歴復旧と変更なし確認用の固定 ID も bootstrap で確保します。既存の保存先は自動改造しません。
2. Apps Script 左側「トリガー」→「トリガーを追加」。実行関数 `MyPaceImportScheduledTick`、イベントのソース「時間主導型」、分ベースのタイマー「15分おき」を、所有者アカウントで選びます。同じ関数のトリガーは一つだけにします。追加の `script.scriptapp` scope はこのコードでは不要です。
3. 未完了の取込は各回に再開します。完了後の新しいフォルダー走査は標準1時間おきです。毎回全ファイルを取り込み直す意味ではありません。5分おきは、消費量を確認できる場合の一時的な追いつき運用に限って検討し、通常は15分おきに戻します。頻度を上げても予約枠は増えません。
4. 止める場合は Google のトリガー画面でこの関数のトリガーだけを削除します。進行中の呼出しが直ちに止まるわけではありません。記録や取込途中状態を消す操作は不要です。

### 待ち・再開・日次枠

通常の確認は呼出し間60秒まで、未完了処理の追いつきは120秒までの枠で進みます。追いつきを有効にした構成では、コールド復旧も例外的に120秒の枠を使います。個々の Google 呼出し自体を途中停止することはできません。同じライターのロックを使うため、アプリが BUSY と未送信状態になり、後から再試行する場合があります。Drive 反映前に保存済みと扱わないことを実機で確認してください。

取込・最終確認の進捗が変わらない試行が3回続くと、本人確認が必要な状態で止まります。走査や復旧を含むすべての失敗が一律3回で止まる意味ではありません。

ローリング予約は保守的な24〜25時間の窓で **12,000呼出し・1時間の実行枠** です。上限では次の枠の回復まで待ちます。画面の「取込の実行枠の回復待ち」「再開の目安」はこの取込処理の予約枠についての表示で、Google アカウント全体の残量ではありません。事前確認・空確認や他のアプリの呼出しは仕事の予約台帳の外でも発生します。Google の実際の使用状況を確認し、必要なら実行頻度を下げてください。

### 履歴の復旧や既存保存先の設定待ち

「履歴の復旧・再試行待ち」は保存先の長い履歴を分割して確認している状態です。記録と未送信操作を保持したまま、時間をおいて「今すぐ同期」で続きを確認します。復旧が済むまで、空の保存先として扱ったり新しい記録で置き換えたりしません。

「保存先の設定待ち」が出た場合だけ、`storage/MAINTENANCE-LIMIT.md` を読み、同じ所有者プロジェクトで秘密設定を確認してから `MyPaceRepairRecoveryConfiguration` を本人が実行します。その後 `MyPaceRecoverStorage` を ready になるまで必要に応じて実行します。これは既存保存先を維持する明示的な修復です。設定・anchor・履歴・元 CSV を手で削除したり、別の保存先を作り直したりしないでください。

現在の性能証拠と制限は TEST-REPORT.md と `storage/CURRENT-PERFORMANCE.md`、実行の詳細は `storage/OWNER-SCHEDULING.md` を参照してください。模擬実行時間は実 Google での完了予定時刻ではありません。

## OAuth Branding の説明ページ（内容確認後に公開）

この追加分だけでは公開・OAuth 設定の変更は行いません。まず `npm run verify` と `npm start` で `/about.html`、`/privacy.html`、`/terms.html` を開き、説明が本人の運用と一致するか確認してください。個人名・メールアドレスを新しい公開ページには掲載していません。連絡先が別途必要な場合は、掲載内容を本人が決めてから追加してください。

本人の承認後に GitHub / Vercel へ公開し、ログアウトしたブラウザーでも次の3ページが HTTPS・200で開くこと、リンク切れや保護画面がないことを確認します。その確認が済んでから Google Auth Platform → Branding に登録します。存在確認前の URL 登録は行いません。

- アプリのホームページ: https://my-pace-gules.vercel.app/about.html
- アプリのプライバシー ポリシー: https://my-pace-gules.vercel.app/privacy.html
- アプリの利用規約: https://my-pace-gules.vercel.app/terms.html

アプリ名が画面と Branding で一致することも確認してください。ページ追加は Google の承認や Publish の有効化を保証しません。必要な項目・ドメイン所有確認・審査等は Cloud の実際の表示に従います。一般ユーザー向けサービスへ変える場合は、現在の個人用の説明をそのまま使わず、運用とデータの扱いを再確認します。

参考: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)、[OAuth の本番公開準備](https://support.google.com/cloud/answer/15549049)。
