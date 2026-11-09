# `ORIGINAL_SOURCE_CHANGED` の診断だけを実行する

**2026年11月9日の結果では、3件とも `parentMatches` だけが不成立でした。実際には設定フォルダのサブフォルダ内にあり、直下だけを認める実装が原因でした。修正版での確認・再開は[サブフォルダ対応の手順](SUBFOLDER-FIX.md)を参照してください。**

差分更新検証が、最初の `myPaceIncrementalTick` で `ORIGINAL_SOURCE_CHANGED`・`completedStages: 0` となり、停止した場合の手順です。**原因を確認するまで、差分検証は再開しません。**

このエラーは「CSVの内容が変わった」と確定するものではありません。コピー前に確認する6条件のうち、少なくとも1つが成立しなかったという意味です。`lastError.driveReasons: []` でも不自然ではありません。この判定はGoogleのエラー応答ではなく、MyPace側の条件確認だからです。

## 今回行う操作

1. **失敗した差分検証のApps Scriptプロジェクトをそのまま開く。** 同じGoogleアカウントを使います。新しいプロジェクトは作りません。
2. 更新済みのローカルファイル **`data/running-gas-incremental/Code.gs`** の全文で、プロジェクトの `コード.gs` を置き換えて保存します。GitHubの `incremental-host.gs` は部品なので、そのまま貼り付けても動きません。
3. **`appsscript.json`、スクリプトプロパティ、元CSV、共有設定は変更しません。** 設定済みキットの再生成も不要です。
4. 実行する関数を **`diagnoseMyPaceOriginalSources`** にして、1回だけ実行します。
5. 実行ログに出る `kind: "original-source-diagnostic"` のJSON全体を返してください。**`startMyPaceIncrementalProbe`、`myPaceIncrementalTick`、`startMyPaceIdleProbe` は実行しません。**

診断のために権限を広げる必要はありません。今回、マニフェストとOAuthスコープは変更していません。診断結果を見てから、修正と再検証の方法を決めます。

## 結果の読み方

`sources` は元CSV3件を **`source: 1`・`2`・`3`** で示します。これはキット内の並び順で、ファイル名やDrive IDではありません。

`metadataReadable: true` の各項目に、次の `checks` が入ります。**`true` は条件成立、`false` は不成立**です。`failedChecks` に不成立の条件名がすべて並びます。

| 条件名 | 確認していること |
| --- | --- |
| `ownedByMe` | 実行アカウントが所有者と判定されるか |
| `notShared` | 共有されていないと判定されるか |
| `notTrashed` | ゴミ箱にないと判定されるか |
| `parentMatches` | キットで指定したフォルダの直下、または配下のサブフォルダ内か（`schema: 2` から） |
| `sizeMatches` | ファイルサイズがキット作成時の値と一致するか |
| `md5Matches` | DriveのMD5がキット作成時の値と一致するか |

たとえば `failedChecks: ["notShared"]` なら、共有状態の確認で止まることが分かります。内容変更や別アカウントでの実行を意味するものではありません。診断後も、この条件を自動で緩めたり、共有設定を変更したりはしません。

`missingFields` は取得できなかった項目名、`invalidFields` は型や形式が想定と異なる項目名です。実際の値は出しません。これらが空でない場合、単純に「実ファイルが変わった」と判断せず、APIから得られた情報の不足も確認します。

`passesOriginalGuard` は元CSVの6条件全体の判定です。`schema: 1` では `parentMatches` が直下の一致だけを表していました。`schema: 2` は親をたどった配下の確認も含み、直接の親の一致は `directParentMatches` で別に示します。`folderLocation` の `DIRECT` は直下、`DESCENDANT` はサブフォルダ内です。`subfolderDepth: 1` なら、指定フォルダとCSVの間に1つのフォルダがあります。

従来のコードでは、たとえば `shared`・`trashed` が欠けていても、それぞれの否定条件が成立します。診断はその挙動を維持しつつ、不足項目を別に表示します。これによって不足を「共有なし／ゴミ箱になしを確認できた」と誤解しないようにします。

| 全体の `status` | 意味と次の対応 |
| --- | --- |
| `ORIGINAL_SOURCE_CHECK_FAILED` | 6条件に不成立あり。`failedChecks` と不足項目を返す |
| `ORIGINAL_SOURCE_CHECKS_PASSED` | 現時点では全条件が成立。自動再開はせず結果を返す |
| `METADATA_FIELDS_INCOMPLETE` | 従来の条件には通るが、項目の不足／形式不正あり。結果を返す |
| `DIAGNOSTIC_INCOMPLETE` | 1件以上の情報取得に失敗。他のCSVは引き続き診断して結果を返す |
| `DIAGNOSTIC_CONFIG_MISMATCH` | 保存された実行時のプロジェクト／設定と不一致。通信せず終了。設定や状態を消さず結果を返す |
| `DIAGNOSTIC_SETUP_INVALID` | 設定／保存状態などを読み取れなかった。生のエラーは表示せず終了。結果を返す |
| `BUSY` | 同じスクリプトの別実行がロックを使用中。完了後に診断関数だけを再実行する |

`configurationMatchesRun: true` なら、プロジェクトとキット設定が保存された実行時と一致しています。`null` は保存された開始状態が見つからなかったことを示します。今回の停止済みプロジェクトでは `true` を想定しています。`null` の場合も、新規開始せずそのまま結果を返してください。

取得失敗では、`METADATA_HTTP_ERROR` とHTTPステータス、`METADATA_TRANSPORT_ERROR`、`METADATA_RESPONSE_INVALID` のいずれかを出します。CSVのメタデータは読めても親フォルダの情報が読めない場合は、`folderMetadataReadable: false` になります。Googleの応答本文や生の例外は表示しません。403／404だけで原因を断定せず、結果を基に調べます。

## 診断が読み書きするもの

- 元CSV3件に対するメタデータ取得を3回行います。取得項目は `ownedByMe,shared,trashed,parents,size,md5Checksum` です。サブフォルダ内の場合は親フォルダの `mimeType,parents,trashed` も読みます。同じ親の情報は1回の診断内で再利用します。今回の構造では合計4回です。CSV本文・GPS・表示用ファイルは読み込みません。
- 親の追跡は1件あたり最大16階層です。対象外・循環・不正な親・フォルダ以外・ゴミ箱内・情報取得失敗では通過させません。ショートカットはたどりません。
- Driveへの書き込み、コピー、移動、削除、権限操作は行いません。
- スクリプトプロパティは読み取りだけです。停止状態、途中保存、計測値、エラー履歴を変更しません。
- トリガーの作成・削除は行いません。差分処理は再開しません。
- ログには判定結果だけを出します。Drive ID、ファイル名、GPS、メールアドレス、MD5の実値、ファイルサイズの実値は出しません。**設定済み `Code.gs` や `config.json` は引き続き非公開です。ログのJSONだけを返してください。**

Driveの `files.get` は `alt=media` を指定せず、必要なメタデータ項目を取得します。[取得APIの仕様](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)、[各項目の仕様](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)。診断自体のGoogleサービス利用は発生しますが、停止した検証の計測値には加算しません。

この診断で分かるのは**実行した時点の状態**です。旧コードが停止した瞬間のメタデータは保存されていないため、過去の原因を遡って断定するものではありません。今回追加したコードでは、今後同じ停止が起きた場合、`lastError.sourceDiagnostics` にその時点の条件別結果も残します。

## 開発側の更新・確認

今回の私有キットは、既存 `config.json` をそのまま `bundleIncrementalProbe(config)` に渡して **`Code.gs` だけ**更新します。`prepare:gas-incremental` を再実行して参照値を作り直す方法は使いません。不一致の手がかりを失ったり、保存された設定ハッシュとずれたりするのを避けるためです。

ローカルの合成データで、6条件の切り分け、値の非出力、メタデータへのGETのみ、停止後の状態・予算・トリガー保持、取得失敗時の継続、プロジェクト／設定不一致、同時実行ロックを検証しています。サブフォルダ内の入力で12段階すべてが一致することと、対象外へのフォルダ移動を次の起動時に検出してコピーを止めることも検証しています。
