# MyPace 修正版の再開ガイド

現在の基準は本番ソース `4ff0b1c537f78f02141fab4ef8aa811cf21fce59` です。
導入は [PRACTICAL-SYNC-INSTALL.md](PRACTICAL-SYNC-INSTALL.md) の順に行います。

```bash
cd /home/jukichi/workspace
bash my-pace-practical-sync.sh --check /home/jukichi/workspace/my-pace
bash my-pace-practical-sync.sh --apply /home/jukichi/workspace/my-pace
```

この二つはクラウドやブラウザーのデータ形式を更新しません。想定外の差分があれば停止し、強制上書きしません。
以前の overnight/STORE_YIELD 用インストーラーは今回使いません。ストアの再作成、秘密情報・公開権限の変更、CSV の再取込、新しいトリガーの追加も行いません。

GAS/API/画面の公開、Drive の明示的な有効化、各ブラウザーの退避と形式更新は、上記手順の別段階です。旧版へ戻せない二つの境界を公開前に確認してください。模擬試験と本番の受入確認は別です。
