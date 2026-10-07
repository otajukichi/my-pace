# マイペース 0.3 · 本人専用 Google Drive 同期候補

習慣・ランニング・早起き・予定・日記・庭を、自分のペースで記録するアプリです。
今回のコードには本人専用ログイン、端末の未送信キュー、競合の明示解決、同じ Google Drive ライターを使う保存・フォルダー取込の接続を含みます。

**コードとローカル模擬試験の成果物です。本番設定・デプロイ・実データ受入試験は完了していません。** 最初に [MORNING-GUIDE.md](MORNING-GUIDE.md) を読んでください。

## ローカル画面と検証

Node.js 20 以上が必要です。

```sh
cd /home/jukichi/workspace/my-pace
npm run verify
npm start
```

http://127.0.0.1:5173 を開きます。静的ローカルサーバーは `/api/` を実行しません。画面の表示確認用であり、これだけでクラウド同期が使えるわけではありません。更新後は再読み込みし、終了は Ctrl+C。

- `npm run verify`: 全ソース構文検査、代表的なアプリ・認証境界・保存・取込模擬試験、静的ビルド
- `npm run test:heavy`: 100 MB 超を含む大規模試験（追加・時間がかかる場合あり）
- `npm run build`: `dist/` に公開用静的ファイルを出力。明示した公開ファイルだけを使い、`server/`、`gas/`、`storage/`、未登録ファイルは入りません。前の `dist/` はプロジェクト外の保護されたバックアップへ移し、古い余分なファイルを新しい公開物に残しません

実際の Google ID トークン検証には `google-auth-library` 10.9.1 が必要です。通常の許可された開発環境で `npm install --ignore-scripts --no-audit --no-fund` を実行してください。今回の作業環境では依存パッケージの取得がポリシーの HTTP 403 で止まり、回避していません。模擬試験の成功は依存インストールや実認証の成功を意味しません。

## 構成

- `src/`: 公開画面、IndexedDB キュー、表示用エンティティ変換
- `api/`, `server/`: Vercel Node API、本人認証、署名済みライター呼出し
- `storage/`: 固定された本人 Drive 保存先とフォルダー取込の実装・模擬試験
- `gas/`: 同一 Apps Script プロジェクト用の署名受付・ドメイン実装
- `.env.example`: 変数名だけの見本。実秘密は自分の設定画面だけに入力

ブラウザーに Drive 書込みトークンや署名秘密を渡しません。元の localStorage データは残し、移行はプレビューと明示確認を経て行います。別データベースや別ライターは作りません。定期取込のサーバー用処理も含みますが、トリガーの設置は本人が Google の画面で行います。LINE 自動送信・データ削除/GC は今回の実装範囲外です。

詳しい手順・制約は [GOOGLE-DRIVE.md](GOOGLE-DRIVE.md)、受入項目は [ACCEPTANCE-CHECKLIST.md](ACCEPTANCE-CHECKLIST.md)、画面の意図は [UI-DESIGN.md](UI-DESIGN.md) を参照してください。
