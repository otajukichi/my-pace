MyPace 日別ランニング 更新手順

この文書は更新用です。すでに公開中の地図対応版と、writerFence 2 対応済みのストアを前提にします。初期設定・ストアの作り直しは行いません。

今回の変更
CSV から日別の経路・距離・平均速度・記録時間をサーバー側で準備します。画面は日付を選ぶ「記録」タブだけになり、OpenStreetMap の背景地図を標準で表示します。国土地理院にも切り替えられます。
手入力・編集・削除・GPX 読み込み・CSV の生データ表示はランニング画面から外れます。過去の記録や元 CSV は削除しません。従来の手入力・GPX 記録は従来の一括 JSON エクスポートに残り、CSV の日別集計には加算しません。
新しいブラウザーキャッシュは表示用データ専用です。既存の記録・未送信データとは別に保存します。

全体の順番
1. ローカルソースを更新
2. 取り込み定期実行を止め、更新前のバックアップを取る
3. GAS を貼り替え、同じ Web アプリ URL のまま更新
4. Vercel の設定とコードを更新
5. 所有者が変更検知と日別準備を明示的に有効化
6. 状態確認、バックアップ・分離復元の確認

1. ローカルソースを更新
my-pace-daily-running.sh を /home/jukichi/workspace に保存します。開発サーバーが動いていれば Ctrl+C で止めます。

cd /home/jukichi/workspace
bash my-pace-daily-running.sh --check /home/jukichi/workspace/my-pace && bash my-pace-daily-running.sh --apply /home/jukichi/workspace/my-pace

--check は基準のファイル内容を確認するだけです。失敗すると --apply は実行されません。
--apply は隔離コピーで整合性確認・全テスト・公開ファイルの確認・ビルドを行い、成功後にソースだけを更新します。数分以上、表示が増えない場合があります。
依存パッケージのインストール、外部通信、Git の変更、デプロイ、Drive の処理、有効化、データ移行・削除は実行しません。テスト用のローカル通信だけは使う場合があります。
.env、package-lock.json、node_modules、既存 dist、Git のステージ状態、対象外の編集を維持します。対象ファイルや基準ソースに違いがある場合は上書きせず停止します。強制上書きや初期化はせず、エラーを確認してください。
適用時に表示される Backup: の保存先を控えます。ここに保存されるのはローカルソースの退避で、Drive のデータバックアップとは別です。

2. 取り込み定期実行を止め、更新前のバックアップを取る
所有者の Apps Script プロジェクトを開き、現在のデプロイとトリガー設定を控えます。
「トリガー」に MyPaceImportScheduledTick がある場合だけ、そのトリガーを削除して定期実行を止めます。存在しなければ、この削除操作は飛ばします。実行中の取り込み処理があれば、終了したことを「実行数」で確認します。MyPaceBackupDailyTick などのバックアップ用トリガーは削除・変更しません。記録・元 CSV・ストア・Script Properties も削除しません。
手動の取り込み開始・再開も、以下の更新が揃うまで行いません。他の用途のトリガーは変更しません。
GAS を貼り替える前に、現在の版で MyPaceBackupNow を実行して更新直前のバックアップを取ります。backup-in-progress なら MyPaceBackupStatus の進捗を確認し、進んでいる場合だけ同じ MyPaceBackupNow を再実行して続けます。backup-complete を確認してから次へ進みます。進捗が変わらない、失敗・警告が出る場合は繰り返さず、結果を確認してください。既存版の復元確認は済んでいるため、ここで同じ旧版の復元テストを重ねる必要はありません。
元 CSV のフォルダーとブラウザー内の未送信記録をそのまま保持します。Drive バックアップは元 CSV やブラウザー内の未送信記録を含みません。更新のためにブラウザーの記録データを消したり、ストアを初期化したりしません。

3. GAS を貼り替え、同じ URL のまま更新
WSL のターミナルで実行します。

cd /home/jukichi/workspace
bash my-pace-daily-running.sh --copy-gas /home/jukichi/workspace/my-pace

UTF-8 clipboard exact match verified. と表示された場合だけ貼り付けます。コピーは Windows PowerShell の UTF-8 読み込みとクリップボードの往復一致を確認します。失敗した場合は貼り付けず、エラーを確認してください。
Apps Script で、既存の MyPaceComplete.gs の中身だけを全選択して全文を貼り替え、保存します。Code.gs、設定、確認用ファイルは残します。旧版と新版の中身を混ぜません。
「デプロイ」→「デプロイを管理」→既存 Web アプリの編集→「新バージョン」で更新します。新しい Web アプリを別に作らず、同じデプロイ URL を維持します。既存 MYPACE_WRITER_URL、秘密鍵、所有者 ID、ストア ID は変えません。
コードの保存・公開だけでは変更検知や日別準備は有効になりません。

4. Vercel の設定とコードを更新
Vercel の対象プロジェクトの Environment Variables で、Production に次の非秘密設定を追加します。

MYPACE_DRIVE_CHANGES_ENABLED=true

これは通知受信口だけの設定です。Preview では受信しません。日別 API 自体には追加の Vercel フラグはありません。日別画面用の新しい秘密鍵を作成する必要はありません。既存の環境変数を消したり変更したりしません。
プロジェクトの変更を確認します。

cd /home/jukichi/workspace/my-pace
git status

秘密情報や意図しない変更が含まれていないことを確認してから、普段どおりまとめてコミット・push します。無関係な作業が混ざっている場合は、ここで止めて整理してください。

git add -A
git commit -m "CSV の日別ランニング表示と変更検知、対応バックアップを追加" && git push origin main

Vercel の Production デプロイ成功と、対象コミットが反映されたことを確認します。環境変数はその設定を含む新しい Production デプロイで反映させます。
公開サイトを再読み込みします。この段階では日別準備がまだ有効でないため、未準備の表示になっても空の日とは判定しません。

5. 所有者が変更検知と日別準備を有効化
既存の Advanced Drive サービスが Changes.getStartPageToken / Changes.list / Changes.watch に対応していることを確認します。既存の承認済み drive.readonly / drive.file で動かす設計です。新しい OAuth スコープ、サービスアカウント、Pub/Sub、認証情報は追加しません。実際に追加権限の要求が出たら、その場で承認せず内容を確認してください。

Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」に次の非秘密設定を追加します。

名前: MYPACE_DRIVE_CHANGE_WEBHOOK
値: https://my-pace-gules.vercel.app/api/drive-changes

別の公開先へ変更した場合は、この値を推測で置き換えず対応を確認してください。設定は生成済みソースに直接書き込みません。
所有者のエディターから、次をこの順番で実行します。

MyPaceDriveChangesActivate
MyPaceDailyRoutesActivate
MyPaceDriveChangesStatus
MyPaceDailyRoutesStatus
MyPaceImportStatus

ここが初めて変更検知・日別準備を有効にする操作です。既存ストアや入力フォルダーは作り直しません。初回はフォルダーの情報を調べ、既存の取り込み済みデータも日別に準備します。
エラーがないことを確認後、「トリガー」で MyPaceImportScheduledTick の時間主導型・5 分おきのトリガーを 1 つだけ作成します。以前の取り込みトリガーや別の定期処理を重ねません。通知ごとに新しいトリガーを作りません。
次回の定期実行から通知登録・変更取り込み・日別準備を共通の予算内で進めます。通知が届かない場合は、保存済みの差分カーソルで原則 15 分ごとの確認を行います。

6. 状態と表示を確認
MyPaceDriveChangesStatus / MyPaceDailyRoutesStatus / MyPaceImportStatus を確認します。初回のフォルダー確認、通知登録、差分処理、取り込み、日別準備が進んでいること、エラーや警告・保留がないことを確認してください。
公開サイトの「ランニング」で日付を選び、経路・距離・平均速度・記録時間が一緒に表示されることを確認します。追加の準備中は、完成済みの表示を残します。準備失敗と通信失敗は区別して表示します。
日付は日本時間の午前 3 時で切り替わります。記録時間は同じファイル内の停止時間を含み、別ファイル間の空き時間は含みません。時間が重なるファイルは後のファイル全体を集計対象から外して通知し、元 CSV は残します。
地図は OpenStreetMap が標準です。地図タイルの表示地域と IP アドレス等は選択した地図配信先へ伝わります。記録の GPS 座標列や時刻列そのものを地図配信先に送る仕組みではありません。
GPX の試験アップロードは行いません。実際の新規記録で検証する場合は、試験範囲を別途確認してから行います。

バックアップの確認
日別データを公開した後は、今回の対応版 GAS でバックアップします。以前のバックアップ処理に戻さないでください。
MyPaceBackupNow を実行し、backup-in-progress なら MyPaceBackupStatus の進捗を確認します。進んでいる場合だけ同じ関数を再実行して続けます。backup-complete を確認した後、MyPaceBackupRestoreTest で本番とは別の復元先への確認を行います。復元も進捗を確認し、進んでいる場合だけ同じ復元関数を再実行します。バックアップ・復元とも、進捗が変わらない、失敗・警告が出る場合は繰り返さず、その結果を伝えて確認してください。
これは本番ストアへの切り替えではありません。元 CSV はバックアップ対象に含まれないため、元フォルダーをそのまま保持します。既存のバックアップ設定や継続中ジョブを初期化しません。
復元完了の合格条件は restore-verified です。MyPaceBackupStatus の lastRestore で verifiedDailyDays / verifiedDailyAssets を確認します。日別データがあるスナップショットでは、コピーした日別データを実際の GAS 読み出し経路で検証した結果が必要です。復元先の取り込み・日別準備は停止状態のままで、完成済みの日別表示には DAILY_PAUSED が付きます。新たな定期バックアップの有効化や本番への切り替えは、この更新手順では行いません。

確認済みの範囲と目標
自動テストの最終件数・合否は配布時の検証結果を確認してください。自動テストの成功は、公開環境での実測や実ブラウザー確認の代わりにはなりません。
保存から表示可能まで 30 分、地図タイルを除く最初の表示 2 秒は目標です。公開環境で実測済みの保証ではありません。初回の過去データ準備、大きなファイル、処理待ち、API 制限では時間が延びます。実ブラウザーの見た目・操作・タイル表示も別途確認が必要です。

困ったとき・戻すとき
ローカルソースだけを戻す場合は、適用時の Backup: の保存先を BACKUP_DIRECTORY に入れます。

cd /home/jukichi/workspace
bash my-pace-daily-running.sh --check --rollback BACKUP_DIRECTORY
bash my-pace-daily-running.sh --rollback BACKUP_DIRECTORY

適用後の編集があるファイルは上書きせず停止します。退避ファイルを消さず、エラーを確認してください。
この操作では、公開済み GAS / Vercel、有効化、トリガー、通知登録、Drive のデータ、バックアップ・復元の結果は元に戻りません。
有効化後に停止する場合は、最初に MyPaceDriveChangesPause、続いて MyPaceDailyRoutesPause を実行し、Vercel の MYPACE_DRIVE_CHANGES_ENABLED を false にして Production に反映し、存在する MyPaceImportScheduledTick のトリガーだけを削除して取り込みを停止します。バックアップ用トリガーは変更しません。通知チャネルは自然に期限切れになり、カーソル・キュー・記録・元 CSV・完成済み日別データは保持します。
旧 GAS を再デプロイするのは安全確認後に限ります。日別データを有効にした後は、対応する読み出し・バックアップ処理を維持してください。writerFence 2 より前のコードへの復帰、ストア初期化、入力 CSV の削除は行いません。
