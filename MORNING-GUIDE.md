# 朝の再開ガイド

コードの更新は一つの Bash でできます。Google の同意・秘密設定・デプロイは本人の操作が必要です。本番同期の受入はまだ終わっていません。

## 1. 右のターミナルでコードを更新

左の開発サーバーは必要なら Ctrl+C で止め、中央の Git 用ターミナルはそのままで大丈夫です。右で、ダウンロードしたファイルの実際の場所を指定します。

```sh
bash /実際の保存場所/my-pace-overnight-upgrade.sh --check /home/jukichi/workspace/my-pace
bash /実際の保存場所/my-pace-overnight-upgrade.sh /home/jukichi/workspace/my-pace
```

検査・テスト・ビルドが成功してからソースを反映します。想定外の既存変更があれば停止するので、強引に削除・リセットしないでください。適用中はファイルを編集しません。バックアップの場所は端末に表示されます。Git のステージ状態、`.env`、ブラウザーの記録、既存 `dist/` は保持します。

## 2. 左のターミナルで画面を確認

```sh
cd /home/jukichi/workspace/my-pace
npm run verify
npm start
```

http://127.0.0.1:5173 を再読み込みします。ここは静的な画面確認用です。本番の認証・同期 API は Vercel 側の設定後に使います。

## 3. Google と本番接続を仕上げる

更新されたアプリ内の **GOOGLE-DRIVE.md** を開き、A〜Eの順に進めます。

- 同じ Apps Script に `gas/MyPaceComplete.gs` を一度だけ配置し、追加の `userinfo.email` 同意と固定保存先を確認
- 作成した同じ保存フォルダーを既存の非共有 `my-pace` へ移し、配置を確認（詳細は「A」）
- 秘密は自分の設定画面にだけ入力。チャットや Git に貼らない。API キー / Picker は不要
- 最初の本番ログイン前に、通常の許可された環境で `npm install --ignore-scripts --no-audit --no-fund` を実行。今回の作業環境では依存取得が制限されています
- Vercel は `api/`・`server/` を含むアプリ全体からデプロイ。本人の Google 識別子を固定し、少量の保存・再読み込み・取込・中断/再開を確認
- 受入後、Google の画面で定期取込トリガーを一つ設定。推奨間隔・予約枠・止め方は「E」を確認。Google OAuth の公開状態変更も本人操作です

詳しい検証結果は TEST-REPORT.md、実機の確認項目は ACCEPTANCE-CHECKLIST.md にあります。旧記録とバックアップは、本番受入が終わるまで消さないでください。
