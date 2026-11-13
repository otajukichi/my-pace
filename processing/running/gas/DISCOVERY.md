# 次の確認は、新しいCSVを1件だけ

> 2026-11-13時点：初回・差分・アイドル・新CSV取り込みは合格済み。この文書は実施済みの手順資料です。次は [完成データを画面へ接続](../CONNECT.md)。過去の検証を再実行する必要はありません。

**前回合格した12段階と24時間監視は、やり直しません。** 既存のApps Scriptと処理済みデータを使い、未確認の「事前登録していないCSVを自動で取り込む」部分だけを確認します。以前案内した新規プロジェクト・A/Bの手順は撤回し、この手順に置き換えます。

## 操作

1. 前回合格した **「MyPace 差分更新検証」** プロジェクトを開く。
2. PCの **`data/running-gas-discovery/Code.gs`** の全文で `コード.gs` を置き換え、保存する。**マニフェスト・スクリプトプロパティはそのまま。新しいプロジェクトは作らない。**
3. **`startMyPaceNewCsvCheck`** を一度実行する。`WAITING_FOR_CSV` になったら準備完了。
4. Driveの前回の **「MyPace 差分更新検証 … / raw」** に、以前の3件とは別の日のランニングCSVを**コピーで1件だけ**追加する。元CSVは移動しない。ファイル名の指定やIDの登録は不要。
5. あとは自動。5分間隔で進み、追加から10〜15分程度＋変換時間が目安。ブラウザーもPCも閉じてよい。
6. **`showMyPaceNewCsvReport`** を実行し、短いJSONを返す。

別のCSVがまだなければ、次のランの記録ができてから始めれば十分です。待機を続ける必要はありません。

## 何が確認できたら終わるか

新しい1件を検出 → そのCSVだけを変換 → 経路・集計・探索済み範囲・新しく走った道を含む表示用データを更新 → 次の確認で再取得がないことを確認、で終了します。**トリガーは自動で消えます。24時間待つ試験はありません。**

完了の目印は次のとおりです。

```json
{
  "status": "NEW_CSV_PASS",
  "imported": true,
  "catalogChanged": true,
  "existingCsvReread": false,
  "unchangedPollPassed": true
}
```

レポートには `buildId`、取得バイト数、実行時間も出ます。GPS・ファイル名・Drive IDは出ません。`completedOutcome` は停止操作でも残ります。

今回は未知CSVのクラウド取込みを確認する短い試験です。未知CSVについて、事前に計算した正解との全出力照合を行うものではありません。計算・再開・既存データとの一致確認などの回帰検証は開発側のローカルテストで行います。

## 前回のデータと本番への影響

前回の合格済みチェックポイントと変換済みCSVを再利用します。既存CSV本文の再取得は禁止し、キャッシュが見つからなければ再変換を始めず停止します。

元CSV、前回のチェックポイント・`index.json`・レポートは変更しません。新しいフォルダも作りません。既存の `system` に今回用の途中状態、`derived` に `new-csv-index.json` と必要な出力だけを追加します。今回の処理からCSVを編集・削除する操作はありません。本番アプリにはまだ接続しません。

前回の実行予算も引き継ぎます。内部計測時間はGoogleの実計上時間と同一ではないため、長い実行やエラーがあれば、その実行履歴だけ添えてください。

## 止まったときだけ読む

| 状態 | 意味 |
| --- | --- |
| `WAITING_FOR_CSV` | 新しい1件を待っている |
| `CONFIRMING_CSV` / `PROCESSING` | 取込み中。次の自動実行へ続く |
| `CHECKING_NO_REREAD` | 取込み済み。次回の確認で終了する |
| `PASSED_PROJECT_REQUIRED` | 前回のプロジェクト・設定を確認できない。新規検証を始めずJSONを返す |
| `PASSED_CHECKPOINT_REQUIRED` / `BASELINE_CACHE_MISSING` | 保存済みの完了状態・変換データが見つからない。3件のやり直しは自動で行わない |
| `BASELINE_INPUT_CHANGED` / `ADD_ONE_CSV_ONLY` | 前回の入力が変わった、または新しいCSVが複数ある。状態を整理する前にJSONを返す |
| `DUPLICATE_CSV` / `OVERLAPPING_SOURCES_REQUIRE_SELECTION` | 同じ記録、または既存の記録と時間帯が重なるCSV。別の日の記録を使う必要がある |
| `DRIVE_RETRYABLE` / `DRIVE_TRANSPORT_ERROR` | 一時的な通信エラー。次回に再試行する |
| その他のエラー | 短いJSONを返す。原本・権限・スクリプトプロパティを変更しない |

手動で止める関数は **`stopMyPaceNewCsvCheck`**。再開は `startMyPaceNewCsvCheck` です。放置された場合も開始から4時間で終了します。期限や状態を消して再実行する必要はありません。

元のコードへ戻す必要があれば、この確認を停止してから、保存済みの `data/running-gas-incremental/Code.gs` を同じプロジェクトへ戻せます。前回のプロパティ・チェックポイントは保持しています。

## 返すもの

**`showMyPaceNewCsvReport` のJSONだけで大丈夫です。** エラーや極端に長い実行があった場合だけ、その時刻・関数名を添えてください。CSVや設定済みコードをチャットへ貼る必要はありません。

チャッピーへの引き継ぎ文：

> 前回合格したMyPace差分更新検証の同じプロジェクトで、新CSV1件の取込みだけ確認したいです。このDISCOVERY.mdに従って案内してください。12段階・24時間監視・新規プロジェクト作成は不要です。設定済みコードはPCのdata/running-gas-discovery/Code.gsにあります。最後にshowMyPaceNewCsvReportのJSONをまとめてください。

開発側でキットを生成する場合は `npm run prepare:gas-discovery`。以前の私有 `data/running-gas-incremental/config.json` から引継ぎ確認値を作ります。CSVの再読込・参照データの作り直しは不要です。
