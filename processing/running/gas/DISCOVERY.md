# 次の検証：事前登録していないCSVの継続同期

初回3件・差分12段階・24時間アイドルのGoogle検証は、利用者から合格と報告されています。[受領した結果](RESULTS.md)を出発点に、今回は**CSVの内容やチャンクの正解を事前に知らない同期処理**を検証します。

前回の合格済みプロジェクトはそのまま残します。今回は新しいApps Scriptと、そのスクリプト専用の非公開フォルダを一つ作ります。本番アプリの読込先は切り替えません。原本・既存プロジェクト・権限設定は変更しません。PCの常駐処理、デプロイ、公開URLは不要です。

## 前回との違い

| 項目 | 合格済みの差分検証 | 今回 |
| --- | --- | --- |
| CSVの判定 | 実際のID・サイズ・MD5 | 同じ。本文を毎回読む必要はない |
| 読み取りの検証 | 事前に計算した各チャンクの正解と照合 | 読みながらMD5を積み上げ、DriveのMD5と最後に照合 |
| 対象の識別 | 検証用の固定キーが必要 | フォルダ直下のCSVを検出。固定キー・専用属性は不要 |
| 結果の照合 | 検証シナリオと同期処理が結び付いていた | コピー操作・正解照合を同期処理から分離 |
| 表示用の一式 | 経路・集計・探索範囲・新しい道 | 同じ一式。未変更の変換・計算を再利用 |
| 合格の記録 | 停止操作で最終ステータスが上書きされる | `completedOutcome` に完了時の結果を別保存 |
| ログ | 大きい全段階JSON | 通常は短い集計。詳細は段階ごとに出力 |

同期処理 [sync-engine.gs](sync-engine.gs) は、テスト用CSV一覧・正解カタログ・シナリオを参照しません。[fixtures.gs](fixtures.gs) が検証用コピーを操作し、[discovery-host.gs](discovery-host.gs) が同期結果を独立した全件再計算結果と照合します。自動試験で使う3件は前回と同じですが、受け入れ処理そのものを変えたため、新しい実装でも同じケースが通ることを確認します。

Driveの `md5Checksum` は通常のファイル本文のチェックサムです。監視時にはメタデータとして取得でき、計算のために本文をダウンロードする必要はありません。改名は内容変更と分け、本文取得中には `version` も照合します。[Driveのファイル情報](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)

MD5は途中状態を小さく保存して再開します。暗号署名や改ざん耐性を保証する用途ではなく、取得したバイト列とDriveが保持する内容の一致確認です。[アルゴリズム仕様](https://www.rfc-editor.org/rfc/rfc1321)

## フォルダのルール

```text
MyPace 継続同期検証 …/       ← 新しく一つ作る非公開フォルダ
├─ inbox/                   ← この直下の .csv だけを監視
├─ derived/                 ← 完成した表示用ファイルと世代別カタログ
├─ system/                  ← 途中状態・変換済みデータ・計算キャッシュ
└─ parked/                  ← 自動試験でコピーを一時移動する場所
```

今回採用する配置は、**入力CSVを一つのフォルダ直下へ置き、表示用データをその外に分ける**形です。日付別サブフォルダやファイル名の書式は不要です。名前は変更しても構いません。ショートカット、サブフォルダ内のCSV、共有ファイルは今回の受け入れ対象にしません。

前回の原本は現在の場所に残し、検証コードが必要な3件だけをGoogle側でコピーします。原本のあるフォルダを平らに整理する必要はありません。親フォルダ配下のサブフォルダも、前回修正した確認処理で扱います。

変更なしの監視は、通常1ページなら `inbox` のメタデータとファイル一覧の**2リクエスト**です。CSV・チェックポイント・表示用ファイルを読みません。Driveへも書き込まず、小さい計測値だけScript Propertiesに保存します。フォルダを分けることで、出力・キャッシュはこの一覧に混ざりません。

## 更新の進み方

1. 約5分ごとに入力一覧を確認する。
2. 前回と異なる内容を見つけたら、次の起動でも同じ一覧か確認する。アップロード直後の途中状態を取り込む可能性を減らすための待機で、常に確定する保証ではない。
3. 新規・内容変更のCSVだけを1MiBずつ読み、解析位置とチェックサム途中状態を保存する。最後にサイズ・MD5・メタデータを照合する。
4. 経路・速度・距離・ペース・区間・月間集計・カレンダー・探索済み範囲・新しい道を更新する。移動・削除も集計から取り除き、再登場した同じ内容はキャッシュを再利用する。
5. 出力を読み戻して確認し、入力一覧も再確認する。完成した世代だけを `derived/index.json` で参照する。

一般に検出には0〜5分程度、確認にはさらに次の起動まで待ちます。その後に変換時間がかかり、トリガーの遅延もあり得ます。今回は間隔を短くせず、既に実測した5分間隔を維持します。

直近2世代の参照を保存し、世代別カタログと出力を変更せず残します。途中で失敗しても、完成前の世代へ読込先を更新しません。応答だけ失われた場合は同じ出力IDで再試行します。今回、アプリの切替・復旧ボタンや古いキャッシュの自動削除は実装しません。

## 用意したファイル

```text
/home/jukichi/workspace/my-pace/data/running-gas-discovery/Code.gs
/home/jukichi/workspace/my-pace/data/running-gas-discovery/appsscript.json
/home/jukichi/workspace/my-pace/data/running-gas-discovery/build-info.json
```

`Code.gs` は設定済みの一式です。GitHubの `.gs` 部品を一つずつ貼る必要はありません。`build-info.json` の `buildId` とレポートの `buildId` が一致することで、貼り付けた処理コードを照合できます。この値は公開コードだけから生成し、GPSやDrive IDからは生成しません。

2026年11月12日に用意したキットは **`gas-ef70a6bb846ae3e68babc414`** です。Google上ではまだ実行していません。

設定済みコード、config、キャッシュ、表示用ファイルには個人情報を含み得るため、GitHubやチャットへ貼りません。すべてGit対象外の `data/` に置きます。開発側で再生成するときだけ次を使います。

```bash
npm run prepare:gas-discovery -- --manifest data/running-gas-selection.json
```

## A：Googleで自動検証する

1. 原本を持つGoogleアカウントで[新しいApps Script](https://script.google.com/home/start)を作り、名前を「MyPace 継続同期検証」にする。合格済みの「差分更新検証」を上書きしない。
2. `data/running-gas-discovery/Code.gs` の全文を `コード.gs` に貼る。`running-gas-incremental` や `running-gas-probe` と取り違えない。
3. 設定でマニフェスト表示を有効にし、`appsscript.json` を今回の同名ファイルで置き換える。保存する。
4. **`startMyPaceDiscoveryProbe`** を一度実行する。`SCHEDULED` と `myPaceDiscoveryTick` のトリガーを確認する。
5. ブラウザーを閉じて待ってよい。約5分ごとに自動処理する。待機だけでも約2時間程度を見込む。PCを停止しても継続する。
6. **`showMyPaceDiscoveryReport`** を実行し、短いJSONを確認する。

権限は前回と同じ `drive.readonly`、`drive.file`、外部API通信、トリガー管理です。新規プロジェクトではGoogleの確認画面が出ますが、マニフェストの権限を広げる必要はありません。

自動操作は[前回と同じ12段階](INCREMENTAL.md#実行する12段階)です。追加・改名・移動・ゴミ箱への移動・復元は検証用コピーだけに行います。内容変更には合成の四角い経路を使います。実CSVの原本は編集しません。

### Aの合格条件

- `status: DISCOVERY_PASS`
- `completedStages: 12`、`currentStage: done`
- `completedOutcome.status: DISCOVERY_PASS`
- `interruptedInvocations: 0`、最長実行240秒以内
- Googleの実行履歴に失敗・時間切れがなく、検証用トリガーが消えている
- `buildId` がローカルの `build-info.json` と一致する

`showMyPaceDiscoveryDetails` は通常の集計に加えて、12段階の結果を**1段階1ログ**で表示します。各段階の `matched: true` と再利用を確認できます。普段は短いレポートだけで十分です。

`DISCOVERY_TIMING_MISSED` は12段階の照合が終わっても時間目標を満たさなかった状態です。処理できたことと実行枠へ収まったことを分けて扱います。

## B：事前登録していないCSVを追加する

A合格後、**前回の3件とは別の日のCSV**があれば同じプロジェクトで試します。なければAの結果を先に返してください。新しいランの後にBへ進めます。A合格はBを実施したことにはしません。

1. **`startMyPaceDiscoveryWatch`** を実行して `WATCHING` を確認する。
2. Driveの「MyPace 継続同期検証 … / inbox」に、別のCSVを**コピーとして**追加する。原本は移動しない。サブフォルダには入れない。
3. 10〜15分程度を最初の確認目安にし、大きいCSVならさらに待つ。`showMyPaceDiscoveryReport` を確認する。
4. `watch.updates` が増え、`publishedSources` が増え、`pendingUpdate: false` になったら取込み完了。`lastError` は過去のエラーも残るため、現在の状態・更新数・実行履歴も合わせて確認する。
5. さらに数回の起動後も `watch.rawBytesRequested` が増えず、更新数も増えないことを確認する。
6. **`stopMyPaceDiscoveryProbe`** で止め、短いレポートとトリガーの消失を確認する。

この監視中、コードは `inbox` のCSVを書き換えません。Googleで手動追加した、専用属性のないCSVも検出します。既存CSVと時間帯が重なる別の記録は、どちらを採用するか勝手に決めず `OVERLAPPING_SOURCES_REQUIRE_SELECTION` で停止します。GPS内容が同じ重複エクスポートは二重計上しません。

監視は最長24時間で自動終了します。今回、24時間待つことは必須ではありません。`WATCH_COMPLETE` は監視期間の終了であり、未知CSVの正解との照合合格を意味しません。期間終了時に処理中なら `WATCH_INCOMPLETE` として、前の完成済みデータを残して止まります。

停止後は `status: USER_STOPPED` になりますが、Aの `completedOutcome` は消えません。合格後にAの開始関数を押しても、12段階をやり直したりフォルダを増やしたりしません。

## 失敗・再開

| 表示 | 意味・対応 |
| --- | --- |
| `IN_PROGRESS` / `WATCHING` | 次回へ続く通常の状態 |
| `DRIVE_RETRYABLE` / `DRIVE_TRANSPORT_ERROR` | 通信の問題。次回に再試行 |
| `ORIGINAL_SOURCE_CHANGED` | コピー前の原本メタデータ確認に失敗。個別情報を含まない条件診断が `lastError` に入る。原本を動かさず返報する |
| `SOURCE_CHANGED_*` / `SOURCE_CHECKSUM_MISMATCH` | 読取中の変更、またはバイト列が不一致。完成済み表示は保持。検証用コピーの状態を調べる |
| `DRIVE_INCOMPLETE_INVENTORY` | 一覧が不完全。削除扱いにせず停止 |
| `INPUT_NOT_OWNER_PRIVATE` / `OUTPUT_NOT_OWNER_PRIVATE` | 本人所有・非共有を確認できない。共有設定や権限を広げず返報する |
| `EMPTY_INVENTORY_REQUIRES_REVIEW` | 全CSV消失を空表示へ自動反映せず停止。今回の保護条件 |
| `REFERENCE_*` / `*_INTEGRITY` / `IMMUTABLE_*` | 照合不一致。再実行を重ねず短いレポートを返す |
| `EXECUTION_BUDGET_REACHED` / `REQUEST_BUDGET_REACHED` | 検証用上限。集計を消して回避しない |
| `PROJECT_OR_CONFIG_CHANGED` | 途中で処理コード・私有設定・プロジェクトが変わった。保存状態は引き継がない |

Aの再開は `startMyPaceDiscoveryProbe`、Bの再開は `startMyPaceDiscoveryWatch` です。開始時刻・予算をリセットしません。Bで入力を直した場合、入力一覧・版が変わった未完成の世代だけを破棄して取り直します。問題が不明な場合は、原本を編集せず先にレポートを返してください。

`showMyPaceDiscoveryReport` と `showMyPaceDiscoveryDetails` は読み取り専用です。トリガー・Drive・保存状態を変更しません。停止は専用のトリガーだけを削除し、コピー・キャッシュは残します。実行中はロックにより `BUSY` になるので、その回の終了後に停止します。

## 実行枠と今回の範囲

通信は累計6,000回まで。自己計測の予算は直近24時間を覆う時間単位の集計で60分まで（最大25時間分を保守的に保持）。起動時に6分を予約し、正常終了時に自己計測＋1秒へ置き換えます。突然中断した回は6分を計上したままです。90秒を目安に次の作業へ進まず再開に回しますが、進行中のAPI通信や計算を強制中断する仕組みではありません。

Googleの個人アカウントのトリガー実行枠は90分／日、1回の上限は6分です。他のスクリプトと共有する枠であり、`accountedMinutes` はGoogleの実計上値ではありません。Googleの実行履歴も確認してください。[Apps Scriptの割り当て](https://developers.google.com/apps-script/guides/services/quotas)

入力は25ファイルまで、1件512MiBまで、途中状態は4MiBまでの**検証上限**です。このサイズまでの性能を保証する値ではありません。全件の組立てはまだメモリ内で行い、長年の履歴・多数のGPS点・キャッシュ整理は別途検証します。記録IDはGPS内容から生成するため、内容訂正でIDが変わる場合があります。将来の日記との恒久的な関連付けは別のID設計が必要です。

今回のカタログは生成物の論理パスを持ちます。Driveの実ファイルIDへの安全な対応付けと認証付きアプリ読込は次工程です。この合格だけで本番接続済み・ロールバック操作実装済みとはしません。

## 結果を返す書式

```text
【MyPace 継続同期検証】
対象コミット：
buildId：
設定済みキットを貼り付けた後のコード変更：なし / あり（内容）
Aの開始・終了日時（JST）：
A終了後の showMyPaceDiscoveryReport：
Google実行履歴の最長時間・失敗・時間切れ：
A終了後の検証用トリガー：0個 / 残った

B：実施 / 未実施（別のCSVがないなど）
追加CSVの件数（ID・ファイル名・内容は不要）：
追加時刻・反映確認時刻（JST）：
B停止後の showMyPaceDiscoveryReport：
数回待ってCSVの再取得が増えなかったか：
B停止後の検証用トリガー：0個 / 残った
```

チャッピーへは次の案内と、この文書のGitHubリンクを渡せます。

> MyPaceの継続同期検証を手伝ってください。前回の3件・差分12段階・24時間アイドルは合格済みです。今回はDISCOVERY.mdに従い、新規Apps ScriptでAを実行し、合格後に別の日のCSVがあればBを試します。設定済みコードはPCのdata/running-gas-discovery/にあります。原本や前回の合格プロジェクトは変更せず、個人データをチャットに貼らずに進めてください。最後に結果を上の書式でまとめてください。
