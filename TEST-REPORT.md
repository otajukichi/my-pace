> 過去の実装・検証資料です。本文中の手順・時間予算・制限・試験数は当時の記録で、今回の導入やロールバックを指示しません。現在の手順は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md)、設計は PRACTICAL-SYNC-DESIGN.md を優先してください。旧インストーラー、初期 bootstrap、ストア移動、秘密情報・OAuth・公開権限・トリガーの変更を今回の更新で繰り返さないでください。

# MyPace 0.3 最終ローカル検証レポート

検証日: 2026-10-06 UTC。本人専用 Drive ライター、署名済み API、任意の本人設定トリガーを含む、ローカル検証済みの候補です。本番稼働の完了報告ではありません。

## 最終コードの確認

- `npm run verify`: 全対象の構文検査、代表テスト **1,289 / 1,289 成功**（2026-10-07 コア互換修正直後の全体確認。最終のパーサー任意化は下記の焦点試験で追加確認）、失敗・スキップ0、公開ファイルの明示リストによる静的ビルド成功
- 取込ランタイム単独の全試験: **899 / 899 成功**。固定フォルダー配置、原子的 GAS 生成、維持管理、復旧、定期取込、梱包形式の互換性を含む
- 独立確認: 認証/署名/キュー35、ビルド/配信4、大規模2、所有者修復30、空確認19、復旧状態11の **101 / 101 成功**。さらに最終配置23・所有者修復30・生成 GAS 5の **58 / 58 成功**（一部重複する別の確認）
- インストーラーの敵対的条件試験: **17 / 17 成功**。最終ファイルを埋め込んだ別コピーへの適用・再実行は、リリース時に改めて確認
- `MyPaceComplete.gs` は OwnerImportKit + SecureSync + web-entry の正確な結合。各ライブラリーと Web/所有者/定期実行の入口は一度だけ存在

認証済み Web 復旧は信頼された設定から1回8リンクに制限します。復旧途中と本人の設定待ちは503になり、記録を空扱いにせず、同じ未送信操作IDを保持します。設定待ちは自動再試行すれば解決する状態として扱いません。hint のない旧保存先も確認し、必要なときだけ本人が既存の保存先を維持したまま修復できます。

統合 GAS の署名なし POST は `REQUEST_FORBIDDEN` で拒否し Drive 呼出し0、GET は `POST_REQUIRED` だけを返す模擬試験を含みます。静的ビルドとローカル配信は公開ファイルの明示リストを共有し、未登録 `.env` / `.json` / `.js`、既知パスの symlink、古い dist 内の余分な秘密ファイルを公開しません。

インストーラーの確認には、事前検査、再実行、Git index/.env/無関係なファイル/ログ/dist の保持、変更済みソース・衝突・symlink・hardlink・パス脱出・秘密ファイルの拒否、チェックサム不一致、検証中の変更、途中失敗後の復旧、並行編集を上書きしない復旧拒否を含みます。瞬間的な同時編集まで完全に防ぐ仕組みではないため、適用中はソースを編集しないでください。強制終了時は表示されたバックアップを保全して確認してください。

## 性能と大規模試験の範囲

定期取込モデルは15分間隔、12,000呼出しの予約枠で、同じ保存先・履歴・台帳に31 MiB / 157,033行の合成ファイルを二つ順に投入しています。二つ目のために新規保存先へリセットしていません。

- 1呼出し100msの時計モデル: 最初8回、合計17 tick / 9,522要求、見える枠待ち0回、checkpoint 17件。最大モデル実行66.6秒、最大予約11,045呼出し、合計5.01時間相当
- 1呼出し300msの時計モデル: 最初14回、合計33 tick / 10,984要求、見える枠待ち2回、checkpoint 31件。最大モデル実行117.3秒、最大予約11,580呼出し、合計26.40時間相当
- 双方とも、公開された全サンプル数と元ファイル全体の SHA-256 を独立に照合

これらの経過時間は実 Google の完了予定時刻ではありません。大量の初回取込は翌日以降へ続く可能性があります。実要求数と保守的な予約量は別で、予約台帳は Google アカウント全体の残量ではありません。

別の大規模2試験は、113,600,000バイト/160万行のパーサー、および114,000,061バイト/200万点の GAS 互換ストリーミング/梱包層でハッシュと再開を確認したものです。100 MiB超の実 Drive 全体を本番で取り込んだ試験とは区別します。

変更なしの1日モデルは新しい不変履歴を増やさず、3ソースで2,375要求（キャッシュなし2,582）、145ソースの識別情報モデルで3,402要求（毎回キャッシュ消失3,567）でした。後者は145件を完全取込済みの資産履歴のモデルではありません。現在の梱包は最大4,096保存点/256 KiB、公開経路ページは最大1,024点/256 KiBを保ちます。

認証済み復旧には従来の「生涯4,096 checkpoint で停止」という制限はありません。4,101件の本物の checkpoint を、hint 全消失から65回の有界呼出しで復旧し、4,102件目を書けることを確認しています。保持期限/GCは未実装で、Drive 容量・他の有限な構造・サービス速度に上限がないという意味ではありません。詳細は `storage/CURRENT-PERFORMANCE.md` と `storage/MAINTENANCE-LIMIT.md` を参照してください。

## 実施していない段階と必須の本人操作

- 実ブラウザーの IndexedDB、複数タブ、Google ログイン/ログアウト、未送信キューの受入
- 実 Google ID トークンを公式ライブラリーで検証する試験
- 追加 `userinfo.email` 同意、本人 subject 固定、秘密設定、OAuth 公開状態の確認
- 本番 Vercel / Apps Script のデプロイ、実フォルダーの取込・中断・復旧、アプリ保存の受入
- 同じ保存フォルダーを正確な非共有 my-pace 配下へ本人が移動し、配置を再確認する操作
- 実トリガー設置と、BUSY・予約枠待ちを含む実運用の確認

依存取得は作業環境のポリシー HTTP 403 で停止し、回避していません。**最初の本番ログイン前に**、通常の許可された環境で `google-auth-library` 10.9.1 を導入する必要があります。模擬認証や模擬 Drive 試験の成功は本番動作の証明ではありません。

この成果物の作成中に、外部設定変更、デプロイ、Git push、実 Drive データ変更、実トリガー設置は行っていません。再開は `MORNING-GUIDE.md`、詳細設定は `GOOGLE-DRIVE.md`、実機確認は `ACCEPTANCE-CHECKLIST.md` を使ってください。

## GAS 互換修正（2026-10-07）

初回の実 Apps Script 保存で論理代入演算子 `??=` が拒否されました。Node の試験だけでは GAS の構文・組込み API の差を検出できていませんでした。GAS に含まれるソースから論理代入、TextEncoder、Object.hasOwn、Array.at への依存を除きました。公開ブラウザー側でも同じデータ意味を維持します。

修正後は ES2020 パーサーと利用不可 API の検査、制限した実行環境で習慣/バックアップ/UTF-8 と取込・チェックポイント再開を確認しています。コア修正直後の全体1,289/1,289が成功しました。最終の焦点試験は18/18成功。内部Acornを持たないNodeを模擬した場合も、実行試験13件は成功し、パーサー専用5件だけを明示的にスキップします。追加依存やダウンロードは不要です。実 Apps Script での保存・認可・本番受入は引き続き本人の確認が必要です。元データ、署名方式、保存先、Googleの4権限は変更していません。

## OAuth information page addition — 2026-10-07

- Added static Japanese about/privacy/use pages, owner-only purpose and real storage/authentication/data deletion descriptions, broad Drive read scope disclosure and official provider links. No new personal contact details are published.
- Public assets increase from 31 to exactly 35; source/private files remain excluded. Three tests cover UTF-8/static accessibility/link targets, real HTTP 200/CSP versus private-route 404, and focus/responsive/footer styles; existing four build-security tests also pass.
- Final `npm run verify` passed: syntax checks, 1,297 tests with zero failures, and a 35-asset build. Eight installer safety scenarios also passed.
- Real visual/keyboard/mobile browser QA remains a local review gate: cloud browser localhost access returned ERR_BLOCKED_BY_CLIENT; a local Chromium launch was blocked by runtime socket restrictions. Static checks are not a substitute for rendered-browser testing.
- No Git mutation, push, deployment, Google configuration change, sign-in, or data migration is performed. After local content review and authorized deployment, verify all three HTTPS public URLs before registering them in Branding. No OAuth acceptance guarantee.
