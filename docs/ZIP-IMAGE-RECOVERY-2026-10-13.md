# ZIP取り込み本人だけMISSINGが残る問題

## 修正前の実測

提供された部屋ZIPを、メディアが空の隔離Relayサーバーで実際のデータ読込から取り込んだ。
大きな画像の処理に1.2秒の待機を挿入してXML参照のGET 404が先に届く条件を固定し、PUTを一時保留した。

- 取り込み本人は画像blob（1,752,506 bytes）を所持しているが、`missing=true`で表示URLはMISSING SVG。
- PUT 201完了後も同じ状態が残る。通常の再描画を行ってもMISSING。
- 後から入るクライアントはGET 200で正常表示。

「アップロードされていない」ではなく、本人の表示状態が復旧しない不具合を再現した。

## 原因と修正

1. ZIP内で元の画像識別子が見つかる画像は`ImageStorage.replace()`を通る。
   前回までの`_add()`修正ではこの経路を修復できなかった。置換・context更新・追加でmissing再評価を統一した。
2. 通常アップロードは復旧を通知せず、補充時の`notifyRecovered()`も先にmissingラッチを削除していた。
   ストレージ側の「deleteが成功した場合のみ表示フラグ再評価」という条件を満たせなかった。
   通常HEAD/PUT成功でも通知し、ストレージ側がラッチと表示フラグを解除する。
3. ローカル置換・非同期の取得完了後にOnPush表示へ通知する経路が不足していた。
   ローカル専用`IMAGE_FILE_CHANGED`を変更完了後に発火し、コマ・地形・盤面・画像一覧等を再描画する。
   App側は既存の遅延NgZone更新でまとめて描画する。イベントはピアへ送らない。
4. MISSING SVGを`ImageState.URL`と誤認していた。状態判定を実データURLで行い、未所持画像の取得対象から外れないようにした。
   本当の欠落は引き続きMISSING表示になる。
5. カタログ取得の404で画像インスタンスを削除すると、参照が切れたり、その間に取り込んだblobを消す競合が起きる。
   補充待ちの同一インスタンスを保持する。またmergeには表示用getterではなく生contextを渡す。
6. 復旧後にmissing通知の重複抑止を解除し、同じ画像の2回目の欠落も検知できるようにした。
   サーバーの409はハッシュ不一致なので、アップロード成功として復旧を通知しない。

## 検証

- 提供ZIPの旧コード再現と修正版の復旧を、同じ手順で比較。
- 修正版ではローカルblob取り込み時点でMISSING解除。PUT完了でLOCAL_ONLYのラッチも解除。
- 同じ部屋の8画像の参照・ファイル名を内容SHA-256へ揃えたZIPで、盤面背景と全コマ画像を検証。
  本人8/8、後参加者8/8でblob所持・missing=false・サーバー欠落ラッチなし。
  後参加者は別BrowserContextでIndexedDB/HTTPキャッシュを共有しない。
  盤面CSSの背景URL更新とimgの実デコード、MISSING SVG残留ゼロ、ランタイム例外ゼロを確認。
- Karma回帰テスト10件成功。ZIP置換、context追加、生context merge、遅れて届く404、
  通知前のラッチ削除、実際の復旧通知、2回目の欠落、通常PUT成功、409拒否を含む。
- productionビルド成功。バージョン表記はv2.0を維持するhotfix。

回帰テストの実行（既存の無関係な壊れたspecを除く専用tsconfig）：

```sh
CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless \
  --include=src/app/class/core/file-storage/image-storage-recovery.spec.ts \
  --ts-config=tools/tsconfig.image-recovery.json
```

このE2Eは隔離Relay環境での実測であり、VPS上のユーザーの既存卓で操作検証したものではない。
スクリーンショット・CDPログ・旧新ビルド・デプロイ記録はローカル`tmp/zip-missing-recovery/`に保存。
