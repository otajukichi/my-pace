# 次の検証：変更の検出・差分更新・24時間の待機コスト

**`ORIGINAL_SOURCE_CHANGED` で停止している場合は、まず[診断専用の手順](DIAGNOSTICS.md)へ進んでください。以下の開始・再開操作はまだ行いません。**

前回の大きいCSV3件の初回変換は、2026年11月9日に利用者がGoogle Apps Scriptで実行し、`TARGET_MET`・全出力の照合一致・時間切れなしと報告しました。今回のコードは、その次の検証です。**今回の差分更新キットのGoogle上での実測は、これから行います。**

PCの常駐サーバーは使いません。既存アプリ、旧Apps Script、前回の検証プロジェクト、元CSVを切り替えたり書き換えたりしません。本番への接続は今回の検証が済んだ後の工程です。

## 検証範囲

1. 追加・内容変更・名前変更・削除・対象外への移動・復元を検出する。
2. 新規／内容変更のCSVだけを読み、処理済みの元CSVは読み直さない。
3. 経路・速度・距離・ペース・区間・カレンダー・月間集計・探索済み範囲・新しく走った道を一式で更新する。
4. 途中保存から再開し、完成した出力だけを最後の `index.json` で参照する。
5. 変更のない状態を5分間隔で24時間確認し、待機コストを別に計測する。

ファイル一覧で得られるID・サイズ・MD5などを比較します。MD5はDriveが計算した値で、確認のために毎回CSV本文を取得する必要はありません。改名と内容変更を区別します。[Driveのファイル情報](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)

## 自動操作するのは検証専用のコピー

新しい非公開フォルダをMy Drive直下に作ります。

```text
MyPace 差分更新検証 …/
├─ raw/       処理対象の検証用CSV
├─ derived/   表示用の結果
├─ system/    途中状態・計算キャッシュ
└─ parked/    移動の検証で一時的に置く場所
```

前回使った実CSV3件を、必要な段階でGoogle側でコピーします。原本への書き込み・移動・削除は行いません。新しいフォルダのコピーを使って、コードが改名・移動・ゴミ箱への移動・復元を自動で行います。永久削除はしません。[Driveでのコピー](https://developers.google.com/workspace/drive/api/guides/create-file#copy_an_existing_file)

内容変更には、小さい**合成CSV**を追加して使います。閉じた四角の経路から一辺を取り除いた経路へ、同じファイルIDのまま内容を書き換え、囲まれた探索範囲が引き直されることも照合します。大きい実CSVの変更を何度も行う性能検証ではありません。

## 実行する12段階

| 段階 | 操作 | 確認すること |
| --- | --- | --- |
| `baseline` | 最も古い実CSVをコピーして取り込む | 最初の表示用データが一致する |
| `append` | 最も新しい実CSVを追加 | 新しいCSVだけを読み、既存計算を再利用する |
| `backfill` | 中間の日付の実CSVを後から追加 | 後日の「新しく走った道」も正しく更新する |
| `unchanged` | 操作しない | 元CSVの取得・再変換がゼロ |
| `rename` | コピーの名前を変更 | 改名を検出し、元CSVの取得・再変換はゼロ |
| `add_control` | 四角の合成経路を追加 | 探索範囲・集計へ加わる |
| `edit_content` | 合成CSVの内容を変更 | 同じIDの内容変更を検出し、結果を更新する |
| `move_out` | 実CSVのコピーを `parked` へ移動 | 対象外になった記録の寄与を取り除く |
| `move_back` | `raw` へ戻す | 元CSVを再取得せず、検証済みキャッシュから復元 |
| `trash` | 合成CSVをゴミ箱へ移動 | 削除を結果に反映する |
| `restore` | 合成CSVを復元 | 同じ内容を再取得せず復元する |
| `final_unchanged` | 再び操作しない | 更新後も再取得・再変換がゼロ |

各段階の照合値は、同じ入力をNode版で**独立したキャッシュから全件再計算**して用意しています。Google側ではカタログの一致に加え、参照するすべての表示用ファイルをDriveから読み戻してハッシュを検証します。改名・変更なしの段階は、直前に検証した世代が維持されることを確認します。

コピーのDrive IDは実行時に決まります。ローカル照合を可能にするため、表示用データの識別子には検証専用の固定キーを使います。**変更の検出・途中状態・取得済み判定は、コピーの実際のDrive IDと内容の照合値を使います。** この固定キーと既知の3件のチャンクハッシュは検証専用であり、任意のCSVを受け入れる本番監視ではありません。

## 用意済みの私有キット

今回使うファイルは、作業中のPCの次の場所にあります。

```text
/home/jukichi/workspace/my-pace/data/running-gas-incremental/Code.gs
/home/jukichi/workspace/my-pace/data/running-gas-incremental/appsscript.json
```

GitHub上の [incremental-host.gs](incremental-host.gs) は部品で、単体では動きません。設定済み `Code.gs` を使ってください。Driveの個別IDや照合値を含むため、設定済みキットはGitHubにもチャットにも貼りません。照合用データ・キャッシュには実GPSが含まれます。

開発側で再生成する場合のみ、既存の私有設定と元CSVがある環境で次を実行します。利用者が検証を始める際に、このコマンドを実行する必要はありません。

```bash
npm run prepare:gas-incremental -- --manifest data/running-gas-selection.json
```

## 第1段階：差分更新の検証を開始する

1. 元CSVのあるGoogleアカウントで、[新しいApps Scriptプロジェクト](https://script.google.com/home/start)を作り、名前を「MyPace 差分更新検証」にする。
2. ローカルの **`data/running-gas-incremental/Code.gs`** の全文を、エディタの `コード.gs` に貼り付ける。前回の `running-gas-probe` と取り違えない。
3. プロジェクト設定でマニフェスト表示を有効にし、`appsscript.json` も今回のキットの同名ファイルで置き換えて保存する。
4. **`startMyPaceIncrementalProbe`** を選んで実行し、Googleの権限確認を進める。
5. ログの `SCHEDULED` と、トリガー一覧の `myPaceIncrementalTick` を確認する。
6. タブを閉じて待つ。PCを停止してもGoogle側で処理が進む。デプロイ・公開URL・PCサーバーは不要。

操作を行う回と、変更を見つける回を分け、さらに別の起動でも同じ内容であることを確認してから処理します。そのため、12段階全体は待ち時間だけでもおおむね2時間以上かかります。実行時間とは区別してください。5分の起動時刻は厳密な保証ではありません。[時間主導トリガー](https://developers.google.com/apps-script/guides/triggers/installable)

既存の `drive.readonly` と `drive.file`、Google APIへの通信、トリガー管理の権限を使います。新しいデフォルトCloudプロジェクトのままで開始してください。コピー作成などの権限エラーが出た場合は、エラーと段階を返してください。手動でDrive全体への書込権限へ広げたり、原本を移動したりしないでください。

レポートの `lastError.driveReasons` にGoogleの理由コードが残る場合があります。たとえば `appNotAuthorizedToFile` なら、そのファイルに対するアプリの認可がコピー操作を許していないことが手がかりになります。本文・IDを含み得るGoogleのエラー応答は、そのままログへ出しません。前回は読込だけだったため、今回追加するコピー操作の認可もGoogleで確認する項目です。

## 第1段階の結果

**`showMyPaceIncrementalProbeReport`** を実行すると、GPS・Drive IDを含まない集計JSONがログに出ます。

- `FUNCTIONAL_PASS`、`functionalPassed: true`、`completedStages: 12` が合格の目安。
- `results` の全段階が `matched: true`。
- 変更なし・改名・移動・復元・削除の段階で `rawBytesRequested: 0`。
- 変更なし・改名の段階で正規化・経路・探索の再計算がゼロ。
- 最長実行240秒以内、Googleの実行履歴に6分の時間切れがない。
- 終了時に検証用トリガーが自動で消える。

`FUNCTIONAL_TIMING_MISSED` は照合が終わっても時間目標を満たさない場合です。初回の実データ3件だけの検証とは作業量が違うため、全体時間だけで比較せず、各段階の `results` と通信内訳を見ます。

## 第2段階：変更なしを24時間測る

第1段階が合格したら、同じプロジェクトで **`startMyPaceIdleProbe`** を一度実行します。`IDLE_RUNNING` を確認したら、検証用フォルダには何も追加・変更せず、そのまま24時間以上待ちます。第1段階の実行予算への計上値が30分を超えた場合は、開始から25時間以上空けて第2段階を始め、同じ日枠に測定が重ならないようにします。

この段階は**同じ一覧確認処理だけ**を5分間隔で動かします。通常1ページの場合、1回につき `raw` フォルダの情報と、その直下のファイル一覧の2リクエストです。CSV本文、途中保存、計算キャッシュ、表示用データは読まず、Driveへの書き込みもしません。集計は小さなScript Propertiesに保存します。

24時間経過後の定期実行で終了し、トリガーを自動削除します。再び `showMyPaceIncrementalProbeReport` を実行します。

- `IDLE_PASS`、`idle.completed: true`。
- `idle.elapsedSeconds` が86,400秒以上、確認240回以上。通常は約288回。
- `idle.rawBytesRequested: 0`。
- `idle.accountedExecutionSeconds` が1,800秒以内を最初の目安にする。
- トリガーが消え、実行履歴に時間切れがない。

`idle.totalPollMs` はフォルダ確認処理そのもの、`idle.measuredExecutionSeconds` は周辺処理も含む自己計測です。`accountedExecutionSeconds` は終了処理の余裕を足した**実行予算への計上値**で、金銭的な課金時間ではありません。Apps Scriptの実行履歴も合わせて確認します。

今回の240回という下限は起動遅延を許容するための検証値です。長い空白や遅延があった場合は、合格表示だけで反映速度を保証せず、実行履歴も報告してください。24時間待った後に初めて次の実行が来るため、終了はちょうど24時間とは限りません。

## コストの内訳と上限

| レポートの値 | 含むもの |
| --- | --- |
| `fixtureRequests` | コピー作成・改名・移動など、検証条件を作る操作 |
| `pollRequests` / `pollMs` | フォルダ情報・ファイル一覧の確認 |
| `processingRequests` | CSV取得、途中保存、計算キャッシュ、出力の作成 |
| `verificationRequests` | 照合のための読み戻しなど |
| `rawBytesRequested` | 元CSV本文を要求したバイト数。再試行分も数える |
| `normalizedComputed` / `normalizedReused` | CSVからの変換数と、変換済みデータの再利用数 |
| `displayComputed`、`freshComputed`、`corridorComputed` 等 | 新しく行った計算。`Reused` は再利用 |
| 各段階の `measuredWorkSeconds` | 待ち時間を除く作業単位の実測合計。検証操作・照合を含み、起動時の共通処理は含まない |
| 各段階の `elapsedSeconds` | 次の起動を待った時間も含む経過時間 |

カテゴリはその段階の補助保存等も含み、API種類ごとの課金明細ではありません。再利用回数は起動をまたいだ再読込を含み、ユニークなファイル数とは異なります。実際の通常運用では行わない、検証用操作と全出力の読み戻しも総量に含めます。

この検証全体の通信は6,000回まで。実行時間は直近24時間を覆う時間単位の集計で60分までに制限し、各実行前に6分を予約します。正常終了時に自己計測値＋1秒へ置き換え、突然止まった回は6分を計上したままにします。時間単位で丸めるため、最大25時間分を保守的に数えます。1回は90秒を目安に次の作業単位へ進まず途中保存しますが、実行中のGoogleの通信や計算を強制中断するものではありません。

第1段階は開始から24時間以内、第2段階は開始から30時間を超えても終わらなければ次の起動で停止します。個人アカウントのトリガー90分／日は他のスクリプトも使う枠です。他の処理の使用量はこのコードでは取得できません。[Apps Scriptの割り当て](https://developers.google.com/apps-script/guides/services/quotas)

## 停止・失敗時

- 自分で止めるときは **`stopMyPaceIncrementalProbe`**。この検証の次回以降のトリガーだけを削除し、コピーや途中データは残す。実行中の処理があればロックにより `BUSY` になるので、その回の終了後にもう一度実行する。
- 再開は **`startMyPaceIncrementalProbe`**。段階・開始時刻・計測値を引き継ぐ。第2段階なら第2段階の続きを行う。
- `IN_PROGRESS` は次回へ続く通常の状態。
- `DRIVE_RETRYABLE` / `DRIVE_TRANSPORT_ERROR` は次回に再試行する。
- `DRIVE_INCOMPLETE_INVENTORY` は一覧が不完全なため停止。削除扱いにしない。
- `SOURCE_*` / `FIXTURE_*` / `REFERENCE_*` / `*_INTEGRITY` は入力・検証条件・照合の異常。直前の完成済み世代を保ったまま止める。
- `IDLE_INPUT_CHANGED` は24時間の変更なしという測定条件が変わったため停止。
- `EXECUTION_BUDGET_REACHED` / `REQUEST_BUDGET_REACHED` は設定した枠へ到達。計測状態を消して成功扱いにはしない。

途中状態・出力は残ります。原本や旧プロジェクトの削除は不要です。エラー時にキットを変更する前に、観測結果をCodexへ返してください。

## 結果を返す書式

```text
【MyPace 差分更新・待機コスト検証】
対象コミット：
コード変更：なし / あり（内容）
第1段階の開始・終了日時（JST）：
第1段階終了後の showMyPaceIncrementalProbeReport のJSON：

第2段階の開始・終了日時（JST）：
第2段階終了後の showMyPaceIncrementalProbeReport のJSON：

Googleの実行履歴：
- 失敗・時間切れ・長い実行間隔の有無：
- 最長の実行時間：
- エラーの時刻、関数名、エラー文（あれば）：
- ほかのスクリプトの割り当てエラー：あり / なし / 不明
各段階終了後の検証用トリガー：消えた / 残っている
気になった点：
```

第1段階で止まった場合は、第1段階の結果だけで構いません。CSV、設定済みコード、途中状態、表示用GPSファイルの本文は添付せず、集計レポートを返してください。

## チャッピーへ渡すメッセージ

```text
MyPaceの次の検証を一緒に進めてください。
リンク先の processing/running/gas/INCREMENTAL.md を読んで、
新規Apps Scriptへの設定 → 差分更新の12段階 → 合格後の24時間監視を案内してください。
前回の3件CSV変換は合格していますが、今回のGoogle実測はまだです。
設定済みコードはPCの data/running-gas-incremental/ にあります。
個人データをチャットへ貼ったり、旧プロジェクトや原本を編集したりする必要はありません。
最後に、この文書の書式でCodexに返す結果をまとめてください。
```

## この検証でまだ証明しないこと

- 年単位で増えた履歴の処理速度・保存容量・キャッシュの整理。
- 任意の新CSVを受け入れる本番監視、認証付きのアプリ読込。
- 1分間隔での監視コスト。今回は5分で測り、その後に判断する。
- 突然のGoogle実行強制終了の実測。手動停止・チャンク境界の再開・応答消失はローカルで検証済み。故意に6分上限まで走らせる検証は行わず、時間切れが発生した場合は時間目標の未達として扱う。
- Googleの全サービス・他のスクリプトを含めたアカウント全体の利用量。

実装は [incremental-host.gs](incremental-host.gs)、[共通の検証定義](../sync-probe.js)、[キット生成](../../../scripts/build-running-gas-incremental.mjs)、[自動テスト](../../../tests/running-gas-incremental.test.mjs)にあります。
