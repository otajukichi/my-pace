# MyPace

自分のペースで取り組みを続けるためのアプリです。現在はランニングを中心に作っています。

## 画面

- ロゴからホームへ移動できます。
- 上部の「ランニング」「英会話」でカテゴリを切り替えます。ホームと英会話の内容は準備中です。
- ランニングは、走った日のカレンダー、ルート概形の一覧、月間集計、速度に応じて色が変わる地図を表示します。
- 地図下のRUNNING LOGから、ペース推移と区間をその場で開閉できます。
- 地図は走った道と囲まれた範囲を明るくし、新しく走った道の推定距離を表示します。
- 朝・昼・晩の配色は時間で切り替わり、設定から固定もできます。
- 日記は活動に依存せず、呼び名とともに利用中のブラウザーへ保存します。

PCではスクロールを使わず、画面の高さに合わせて余白・表示件数・詳細の開閉で情報量を調整します。スマートフォンにも対応しています。

## ローカルで使う

Node.js 20以上を使います。初回に認証用パッケージをインストールします。

```bash
npm ci
npm start
```

`http://127.0.0.1:4173/#records` を開きます。通常URLはGoogleのログイン状態に応じて表示します。従来のローカル記録を確認する場合は `http://127.0.0.1:4173/?source=local#records` を開き、`data/running.json` から読み込みます。このファイルはGitに含めません。個人データのない公開画面は下記の公開用ビルドで作ります。

```bash
npm test
npm run build
```

通常のビルドは、ローカルに記録があればその記録を含みます。その出力はローカル専用で、公開してはいけません。記録がない場合は空の記録でビルドします。

## 個人情報を含めない公開用ビルド

```bash
npm run build:public
```

公開用ビルドは、ローカルに記録が存在しても必ず `{"days":[]}` を出力します。実際のGPSや記録を読み込ませません。Vercelもこのコマンドでビルドする設定です。

未ログイン時はログイン案内を表示し、個人のランニング記録は取得しません。天気は東京駅周辺の公開サンプル地点を使います。右上のアカウントアイコンからGoogleでログインすると、通常URLで本人のDrive記録を自動表示します。ログアウトするとDrive記録の表示を消します。検証用の切替は「設定 → 接続の確認」に残しています。設定と戻し方は [画面接続の手順](processing/running/CONNECT.md) を参照してください。

接続先は `MYPACE_ROOT_FOLDER_ID` で指定するMyPace共通管理フォルダです。その中の `running/derived/index.json` を正式な目次とし、参照する完成済みJSONだけを読みます。旧 `MYPACE_DRIVE_FOLDER_ID` と目次名の設定 `MYPACE_DRIVE_CATALOG` は使いません。今回の接続では検証済みJSONを新構造へコピーし、合格した目次をコピー先で `index.json` に改名します。元のApps Scriptとデータは保持します。コピー先への継続更新や、英語・日記・設定のDrive保存はまだ実装していません。

日記・呼び名はそのブラウザーに保存され、GitHubやサーバーへは送信しません。ローカル版と公開版のブラウザーデータは自動同期されません。

## GitHubへの保存範囲

アプリのコード・合成データによるテスト・この説明を保存します。次はローカルに保持し、Gitから除外します。

- `data/`：個人のランニング記録・GPS
- `screenshots/`：実際の記録や位置が写る可能性のある画像
- `docs/`：個人的な構想・対話・作業メモ
- `旧my-pace/`：個人の連携設定が含まれる旧実装・Google連携基盤
- `dist/`、環境変数ファイル、GPS交換ファイル、CSV、秘密鍵等

旧Google連携はローカルの `旧my-pace/` に残しています。クラウドの保存データ、認証情報、トリガーは変更しません。この除外設定は過去のGit履歴を書き換えるものではありません。

## 構成

- `app.js`：画面の状態と操作
- `lib/navigation.js`：ホームとカテゴリの定義
- `lib/running-*.js`、`lib/run-*.js`：記録・集計・カレンダー・分析
- `lib/map.js`、`lib/exploration*.js`：地図・探索表示
- `scripts/serve.mjs`：ローカル専用サーバー
- `scripts/build.mjs`：公開ファイルを限定して生成するビルド
- `api/weather-area.js`：公開側でサンプル地点のみを返すAPI
- `api/google-auth.js`、`api/running-drive.js`、`server/drive-auth.js`：本人認証と完成JSONの読み取り専用接続
- `processing/running/`：元CSVから軽い表示用データを生成する処理。ローカル実行・保存形式・次の連携工程は [処理の説明](processing/running/README.md) を参照してください。

ランニング表示用データの生成は `npm run prepare:running -- --input data/raw` で試せます。入力・出力・キャッシュは `data/` 内だけで扱います。現在の画面の読込先や、Driveの自動処理を切り替えるコマンドではありません。

Apps Scriptでは初回3件・差分12段階・24時間監視・未登録CSV1件の取り込みがGoogle実環境で合格しました（[実測結果](processing/running/gas/RESULTS.md)）。現在は [完成データの画面接続](processing/running/CONNECT.md) へ進んでいます。過去の大規模検証をやり直す必要はありません。元のApps Scriptやキャッシュは変更せず、常時監視への切り替えはまだ行っていません。`watch:running` はローカル検証用で、常駐運用には採用していません。

背景地図は [OpenStreetMap](https://www.openstreetmap.org/copyright)、天気は [Open-Meteo](https://open-meteo.com/) を使います。公開用設定は [Vercelの設定仕様](https://vercel.com/docs/project-configuration/vercel-json)に従っています。
