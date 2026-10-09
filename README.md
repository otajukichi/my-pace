# マイペース (MyPace)

日記・習慣・起床・予定・ランニングを扱う個人用アプリです。

## 既存環境の修正版導入

本番基準 `4ff0b1c537f78f02141fab4ef8aa811cf21fce59` からの手順は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md)。短い再開案内は [MORNING-GUIDE.md](MORNING-GUIDE.md)、既存接続の方針は [GOOGLE-DRIVE.md](GOOGLE-DRIVE.md) を参照してください。

ソースの適用だけではクラウド・ブラウザーを移行しません。Drive の明示的な writerFence 有効化と、各ブラウザーの退避・明示承認後の IndexedDB 更新には別々の旧版互換性制限があります。アプリ管理用の非公開ストアを手編集・共有せず、元 CSV と未送信記録を保持します。新しいトリガーを自動設置せず、Drive の履歴削除・GC も行いません。

## 開発用の検査

Node.js 20 以上を使用します。既存の依存関係と lockfile を保ちます。

```bash
npm run verify
```

`npm start` は静的な開発画面を起動します。実際の認証・同期は本番 API と Google 側の受入確認が必要です。既存データと同じ origin で新しい画面を試す際も、ブラウザーの退避・移行確認を省略しないでください。

設計と制限は [PRACTICAL-SYNC-DESIGN.md](PRACTICAL-SYNC-DESIGN.md)。模擬試験合格と本番のブラウザー・Google・Drive・Vercel での動作確認は別です。以前の日付の技術報告は履歴資料で、現在の導入手順ではありません。

## ランニングの地図

GPX・CSVのGPSルートを背景地図と推定速度の色で確認できます。表示の意味、読み込み上限、地図提供元への通信と検査状況は [RUNNING-MAP.md](RUNNING-MAP.md) を参照してください。
