# ランニングデータの自動更新

> このPC常駐方式は、運用方式として採用しません。コードはローカル検証用に残しています。現在の方針はGoogle側で処理することで、[Apps Scriptの3件実測](gas/README.md)を先に行います。以下は以前のローカルワーカーの操作資料であり、今からこのOAuth設定や常駐設定を行う必要はありません。

経路・集計・探索済み範囲・新しく走った道の距離は、以前の変換処理から一式に含まれています。今回追加したのは、その一式の差分更新と自動実行です。画面や既存Google連携の切り替えは行っていません。

## 今回の変更

| 場面 | 以前 | 今回 |
| --- | --- | --- |
| 変更なし | CSVは再読込しないが、探索などは全体を再計算 | 通常の監視では変換自体を省略。日次検査でも計算結果を再利用 |
| 新しい記録 | 新CSVを読んだあと全記録の表示・探索を計算 | 新しい経路を作り、変化した依存関係・探索範囲を更新 |
| 過去の修正・削除 | 全体を計算し直す | 後日の近くの道の評価を更新し、不要になった探索への寄与を取り除く |
| 途中で停止 | 再実行が必要。ロックが残る場合あり | 次の実行で、取得済みチャンク・完成済み計算から再開 |
| Driveに追加 | 自動検知なし | 変更履歴の定期確認。通常はCSVをダウンロードしない |

新しく走った道の定義は変更していません。以前の日に走った道から約30m以上離れた走行距離の推定で、同日の走行同士は互いに差し引きません。探索の囲み判定は、記録が増えても同じ計算を再利用できる固定格子へ整理しています。

## 実行場所

このワーカーは**自分のLinux PCで実行するNode.jsプログラム**です。クラウドの常時実行サービスではありません。PCの停止・スリープ中は更新せず、次の起動時に追いつきます。Node.js 20以上と `flock` を使い、有料サービス・LLM・追加npmパッケージは不要です。元のアプリや旧Apps Scriptの設定を流用・上書きしません。

変換したデータは最初にローカルの `data/running-display/` に保存します。Driveへの保存を有効にした場合は、My Driveの直下に新しい非公開フォルダ `MyPace running display` を作り、そこだけを出力先にします。**元CSVと既存のGoogle連携フォルダは変更・削除しません。**

## ローカルだけで開始する

```bash
npm run watch:running -- --input data/raw
```

標準では10秒ごとに確認します。書き込み途中のファイルを拾わないよう、同じ状態を別の確認タイミングでも観測してから処理します。終了は Ctrl+C です。単発の検証は末尾に `--once` を付けます。

## Driveを接続する

CodexのDrive接続に与えた権限は、この別プロセスの認証情報として取り出して使いません。ワーカー自身に対するGoogle認証が一度必要です。

1. 既存のGoogle CloudプロジェクトでDrive APIが有効になっていることを確認します。OAuthの「デスクトップ アプリ」クライアントJSONを取得し、`data/google-client.json` に保存します。既存のWeb用クライアントやApps Script設定を削除・変更する必要はありません。
2. 認証コマンドを実行し、表示されたURLを**同じPC**のブラウザーで開きます。記録を保存しているアカウントで許可します。

   ```bash
   npm run authorize:running -- --client data/google-client.json
   ```

   元CSVを読む `drive.readonly` と、このワーカー自身が作ったファイルを管理する `drive.file` を使います。PKCEと一時的なループバック受信先で認証し、更新用トークンは `data/running-worker/oauth.json` に権限600で保存します。トークンをチャットに貼らないでください。

3. 非公開の `data/running-worker.json` を用意します。記録フォルダIDはフォルダURLの末尾です。個人のIDはGit管理対象に書きません。

   ```json
   {
     "sourceFolder": "YOUR_RUNNING_CSV_FOLDER_ID",
     "tokenPath": "data/running-worker/oauth.json",
     "state": "data/running-worker",
     "output": "data/running-display",
     "cache": "data/running-cache",
     "intervalSeconds": 300,
     "publishToDrive": true
   }
   ```

4. 単発実行で認証・取得・変換・非公開保存を確認し、その後監視を起動します。

   ```bash
   npm run watch:running -- --config data/running-worker.json --once
   npm run watch:running -- --config data/running-worker.json
   ```

   `publishToDrive: false` にすれば取得・ローカル変換までで止まります。変更履歴は5分ごと、完全な一覧との照合は1日ごとです。OAuthアプリがテスト状態の場合など、Google側の設定によって再認証が必要になることがあります。[Googleの更新トークンの期限](https://developers.google.com/identity/protocols/oauth2#expiration)を確認してください。

## 常駐・復旧

ログイン時から動かす場合は、自分のユーザー用systemdサービスとして上の監視コマンドを登録できます。サービスは1つだけにしてください。同じ出力フォルダを複数PCから同時更新する構成は対象外です。

PCの強制終了後も、再度同じコマンドを起動すればOSのロックが解放され、完成済みの処理を使って再開します。ダウンロードは8MiB単位で進捗を保存します。途中でCSVが差し替わった場合は、そのファイルを取り直します。原本が不正・重複期間・全件消失などの場合は勝手に正常扱いせず、以前の完成したカタログを維持します。

`data/running-worker/status.json` に最新の状態を保存します。`data/running-cache/last-report.json` に変換処理の再利用数・計算数・入出力量を保存します。

| 主な状態・エラー | 意味と対応 |
| --- | --- |
| `unchanged` | 新しい内容なし。通常は変換処理も実行していない |
| `settling` | 書き込みが止まったことを次の確認で確かめる |
| `updated` | ローカル変換と、有効ならDrive保存まで完了 |
| `DRIVE_AUTH_*` | ワーカーの認証・更新トークンを確認。必要なら認証コマンドを再実行 |
| `DRIVE_HTTP_403` | Drive API・アカウント・対象フォルダのアクセス権を確認 |
| `DRIVE_HTTP_429` / `DRIVE_NETWORK_ERROR` | 制限・通信障害。時間を空けて自動再試行する |
| `DRIVE_RANGE_NOT_HONORED` | 部分取得が成立していない。巨大ファイルの丸ごと取得へは切り替えない |
| `EMPTY_INVENTORY_REQUIRES_REVIEW` | 入力一覧が空。フォルダ設定や削除状況を確認。表示データを自動で空にしない |
| `OVERLAPPING_SOURCES_REQUIRE_SELECTION` | 同じ時間帯の異なる記録が重複。入力フォルダから対象を選ぶ |
| `DRIVE_OUTPUT_MUST_BE_OWNER_ONLY` | 出力先が共有されている。新しいGPSの公開を避けて停止 |
| `EXPLORATION_*_LIMIT` | 新しい地域・記録の処理上限に達した。旧カタログを維持し、分割などを検討 |

失敗時は最大1時間まで間隔を延ばしながら再試行します。個人の位置、原本名、認証情報はログに出しません。処理途中の派生物や古い世代は復旧のため残しています。削除整理はまだ自動化していないため、保存容量の管理は今後の工程です。

## まだ接続していない部分

現在のブラウザー画面は引き続き `data/running.json` を読みます。今回の自動更新が成功しても、まだその画面の記録が自動で変わるわけではありません。次の工程は、本人認証を伴う取得口から `lib/running-artifacts.js` を使い、表示中の月・日・探索範囲だけ読むように画面を接続することです。

GitHubと公開ビルドに含まれるのは処理コードと合成テストだけです。元CSV・生成物・キャッシュ・Drive ID・OAuth情報は `data/` 内に限定します。
