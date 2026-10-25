# 現タブ全文編集

チャットパレットの分類タブを選び、「追加・編集」→「現タブ全文編集」で、
そのタブの本文だけをまとめて編集できる。

- タブ名・タブ順・ほかのタブ・共通欄はそのまま保持する。
- 「共通」を選んだ場合は共通欄だけを編集する。
- 折りたたみや空行、変数定義も本文に含む。検索・折りたたみ状態で内容を省略しない。
- 本文を空にして保存しても、名前付きタブは削除しない。
- 「すべて」表示ではタブを特定できないためボタンを無効にする。
- タブ区切りを本文に追加することはできない。タブ構成ごとの編集には従来の
  「全文テキスト編集」を使う。
- 編集中に共有本文が更新された場合は保存を拒否し、未保存入力を残す。
- 既存のチャパレ本文に書き戻すので、保存形式は変更しない。

## 検証

```sh
node tools/test-palette-tab-source.cjs
npx ng build --configuration development --output-path tmp/palette-tab-source/dev
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY NO_PROXY=127.0.0.1,localhost node tools/verify-palette-tab-source.cjs tmp/palette-tab-source/dev/browser
```

前者は本文の境界、同名タブ、空タブ、CRLF保持など16条件を確認する。
後者は隔離relayとfresh Chromeを起動し、実マウス・キー入力でタブ選択、
編集・保存、キャンセル、共通欄、空欄、同時編集、既存の全文編集を確認する。
14439/14440と19551が空いている状態で実行する。
証跡は `tmp/palette-tab-source/<時刻>-tab-source-local/` へ保存する。
