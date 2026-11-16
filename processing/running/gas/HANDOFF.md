# ChatGPTと進めるランニング処理の検証

> 2026-11-17時点：初回・差分・アイドル・新CSV・本人認証付き本番画面の確認まで完了。この文書は実施済みの手順資料です。次は [本番の継続取り込み](PRODUCTION.md)。過去の検証を再実行する必要はありません。

> この文書は初回の3件CSV検証を開始した時点の記録です。2026年11月9日に利用者からGoogleでの合格が報告されました。その後の検証も完了し、現在の次工程は [PRODUCTION.md](PRODUCTION.md) を参照してください。

この文書は、MyPaceの開発を引き継いだChatGPT（チャッピー）と、利用者が一緒に検証するための案内です。実装・ローカル検証はCodexが行い、Googleへの初回設定と実測を利用者が行い、その結果をCodexへ返します。

## 今回確かめること

**Google Driveにある大きいCSVを3件、PCを起動したままにせず、1日分の制限内で表示用データに変換できるか。** 有料のサーバーは使いません。

表示用データには、経路・速度・距離・ペース・区間・カレンダー・月間集計だけでなく、**探索済み範囲と、新しく走った道の推定距離も含めます。** この2つを後回しにして合格とはしません。

今回は「最初の3件を処理する実測」です。新しいCSVを見つける監視、長年の履歴に毎日3件追加する性能、アプリからの認証付き読込は、まだこの検証の対象ではありません。既存アプリの表示は切り替わりません。

## 現状と読む順番

1. この文書で検証範囲を確認する。
2. [操作マニュアル](README.md)に沿ってGoogleへ設定する。
3. 結果の意味を調べる場合は、[処理全体の説明](../README.md)と次のコードを見る。

| ファイル | 役割 |
| --- | --- |
| [probe-host.gs](probe-host.gs) | Googleのトリガー、Driveの分割取得・途中保存、制限と測定結果 |
| [probe-core.js](../probe-core.js) | CSVの途中状態と表示用データの組み立て |
| [derive.js](../derive.js) | 距離・速度・ペース等の算出 |
| [incremental.mjs](../incremental.mjs) / [mask.mjs](../mask.mjs) | 新しく走った道と探索済み範囲の計算・再利用 |
| [build-running-gas-probe.mjs](../../../scripts/build-running-gas-probe.mjs) | 共通処理と私有設定から貼り付け用コードを生成 |
| [running-gas-probe.test.mjs](../../../tests/running-gas-probe.test.mjs) | 模擬サービスでの再開・照合・異常時の検証 |

引き渡し時点でローカルの自動テスト105件が通り、手元の対象3件でも模擬Apps Script環境とローカル変換の出力一致を確認しています。**Google上の実行時間・通信時間・割り当ては未測定です。** `simulation-report.json` があっても、Googleで成功した証拠にはしません。

`WORKER.md` にあるPC常駐ワーカーのOAuthや起動手順は今回使いません。Googleの新しい検証用Apps Scriptプロジェクトだけで実行します。

## GitHubと手元のファイルの違い

GitHubにはコードの原本・テスト・手順だけを置きます。**貼り付け用の設定済みコードは、作業中のPCの次の場所にあります。**

```text
/home/jukichi/workspace/my-pace/data/running-gas-probe/Code.gs
/home/jukichi/workspace/my-pace/data/running-gas-probe/appsscript.json
```

GitHubにある `probe-host.gs` は部品なので、単体では実行できません。GitHubから取得した直後の別環境にも、私有設定や元CSVはありません。上記の用意済みファイルを使えば、利用者がDrive IDを調べて手入力する必要はありません。

設定済み `Code.gs` と `config.json` には個別のDrive ID、元CSVと `reference/` にはGPSが含まれます。これらはGitHubにも検証用チャットにも貼らず、Googleの自分用プロジェクトへ直接コピーします。結果を相談するときは、後述の集計レポートを使います。

このリポジトリは非公開です。ChatGPTのGitHub接続から閲覧できない場合は、この文書と[操作マニュアル](README.md)の本文を渡してください。リポジトリやDriveを一般公開する必要はありません。

## 利用者とChatGPTが行う手順

1. 元CSVを保管しているGoogleアカウントで、**新しいApps Scriptプロジェクト**を作る。旧MyPaceプロジェクトは使わない。
2. [操作マニュアルの「Googleで測定を始める操作」](README.md#googleで測定を始める操作)に従って、手元の `Code.gs` と `appsscript.json` を貼り付ける。
3. `startMyPaceThreeCsvProbe` を一度実行し、権限を許可する。ログに `SCHEDULED` が出たことと、トリガー一覧に `myPaceProbeTick` があることを確認する。
4. ブラウザーを閉じてよい。PCの電源も不要。Googleの5分ごとの実行で続きを処理する。何度も開始を押したり、手動で連続実行したりする必要はない。
5. 後ほど、Apps Scriptの「実行数」で処理が進んでいるかを見る。途中の状況を確認したいときは `showMyPaceThreeCsvProbeReport` を実行する。頻繁なポーリングは不要。
6. 完了または停止後、もう一度 `showMyPaceThreeCsvProbeReport` を実行し、そのログのJSONを保存する。出力できない場合は、そのエラーと直近の実行ログだけでもよい。
7. 下の書式でCodexへ返す。Googleの「完了」は関数の終了を示すだけなので、アプリ側の `status` と照合結果も確認する。

Googleへの初回認証は利用者の操作が必要です。検証中は、My Drive直下に作られる「MyPace ランニング処理検証 …」フォルダへ途中状態・結果が保存されます。元CSVには書き込みません。

## 合格と判断する条件

| 確認するもの | 目安 |
| --- | --- |
| 実行環境 | レポートの `environment` が `apps-script` |
| 完成 | `phase: done`、`completedSources: 3`、`matchesLocalReference: true` |
| 出力範囲 | 経路・分析・カレンダー・月間集計・探索・新しい道の一式が照合一致 |
| 所要時間 | 開始から24時間以内（待ち時間も含む） |
| 累積実行時間 | `chargedExecutionSeconds` が3,600秒以内 |
| 1回の実行時間 | `maximumExecutionSeconds` が240秒以内、実行履歴に6分の時間切れがない |
| 通信回数 | 全Drive通信が3,000回以内。確認用の読込も消費する |
| 終了処理 | この検証用の `myPaceProbeTick` トリガーが自動で消えている |

最終の `status` は `TARGET_MET` が目安です。レポートの自己計測だけでなく、Googleの実行履歴も照らし合わせます。保存済み `report.json` には最後の実行時間の予約分が残る場合があるため、終了後に `showMyPaceThreeCsvProbeReport` で取得した値も返してください。

個人アカウントのトリガー実行時間は90分／日で、同じユーザーのほかのスクリプトも枠を使います。この検証は自身の60分を目安にしていますが、他の処理が使った分を自動取得する機能はありません。既存スクリプトの割り当てエラーがあれば、それも結果に添えます。[Googleの割り当て](https://developers.google.com/apps-script/guides/services/quotas)

通過しても「長年の履歴への日々の追加まで確認済み」とはしません。次は既存履歴への追加・修正・削除をGoogle上で測り、それから自動検知とアプリ接続へ進みます。

## 止まったとき

- `IN_PROGRESS` は途中保存して次回へ進む状態です。失敗ではありません。
- `DRIVE_RETRYABLE` / `DRIVE_TRANSPORT_ERROR` は次の実行で再試行します。続く場合は、回数と最後のログを返します。
- `SOURCE_*` / `REFERENCE_*` / `*_INTEGRITY` などは、入力や照合の異常です。無理に続行せず、エラーコードを返します。
- `BENCHMARK_BUDGET_REACHED` / `REQUEST_BUDGET_REACHED` は検証枠に達した状態です。枠を増やしたり計測値を消したりして合格扱いにはしません。
- 認証・API・権限のエラーは、操作した段階とエラー文を返します。アカウント名・ID・URLなど個人に固有の情報は省いて構いません。

利用者が止めたい場合は **`stopMyPaceThreeCsvProbe`** を実行します。次回以降の検証用トリガーを停止し、途中データは残ります。すでに実行中の回を強制中断する操作ではありません。手動停止後の再開は `startMyPaceThreeCsvProbe` ですが、開始時刻と計測予算は引き継ぎます。

ChatGPT側で原因を調べるときも、まずログとコードを照合してください。制限・権限・入力3件・計測状態を変更する必要が出たら、変更案と観測結果をCodexへ返し、同じ測定条件のまま原因を追えるようにします。

## Codexへ返す書式

以下をコピーして、分かる範囲を埋めてください。位置情報のあるスクリーンショットやCSVは不要です。

```text
【MyPace Apps Script 実測結果】
対象コード：案内されたGitHubのコミットURL（またはSHA）
コード変更：なし / あり（変更点）
開始・確認日時：JSTで記入
到達した操作：認証前 / SCHEDULED / 実行中 / 完了 / 停止

showMyPaceThreeCsvProbeReport の出力：
（集計JSONをそのまま貼る。取得できなければエラーコード）

Googleの実行履歴：
- myPaceProbeTick の完了・失敗・時間切れの件数：
- 最長の実行時間：
- エラーがある場合、その回の時刻・関数名・エラー文：
- ほかのスクリプトの割り当てエラー：あり / なし / 不明

検証用トリガー：残っている / 自動で消えた / 手動停止した
気になった点：
```

返す集計JSONはGPS座標・元ファイルID・認証情報を出さない実装です。`checkpoint.json`、計算キャッシュ、表示用ファイルの本文はGPSを含むため、代わりに添付しないでください。

## チャッピーに渡す最初のメッセージ

```text
MyPaceのGoogle Apps Script検証を一緒に進めてください。
次に貼るGitHubリンクのHANDOFF.mdと、同じフォルダのREADME.mdを読んでください。
リンクが開けない場合は、その2文書の本文を私から渡します。

目的は、大きいCSV3件をGoogle側だけで処理し、経路・集計に加えて
探索済み範囲と新しく走った道も、1日分の制限内で生成できるかの実測です。
ローカルテストは済んでいますが、Google上ではまだ測っていません。
手元のPCには非公開の設定済みキットがあります。
既存プロジェクトを編集せず、新規Apps Scriptへの設定を一手順ずつ案内してください。
個人のCSV・GPS・Drive ID・認証情報をチャットへ貼る前提にはしないでください。
終わったらHANDOFF.mdの書式で、Codexに返す観測結果をまとめてください。
```
