# パスワード入室とページ離脱の回帰確認

パスワード入力の `keydown.enter` から直接モーダルを閉じると、フォームの
`submit` リスナーも破棄される。その後、ブラウザがEnterの既定動作として
暗黙送信を行い、`beforeunload` が出る。ダイアログをキャンセルすると
既に進んでいる入室処理だけが残る。

入室ボタンとEnterはネイティブのフォーム送信に統一する。送信イベントで
`preventDefault()` を呼んでから認証・モーダル破棄を行う。
離脱確認自体を無効にしない。

## 実ブラウザでの再現・検証

```sh
npx ng build --configuration production --output-path tmp/password-entry/fixed
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY NO_PROXY=127.0.0.1,localhost node tools/verify-password-entry.cjs tmp/password-entry/fixed/browser enter
```

第2引数で `click` / `enter` / `numpad` / `wrong-then-enter` /
`no-password` を切り替える。`ROOM_MODE=advanced` でアドバンス部屋も確認する。
修正前の再現を成功扱いにする場合だけ `EXPECT=buggy` を指定する。

- スクリプトは14439/14440の隔離サーバーと19551/19552の独立Chromeを起動する。
  設定取得だけをrelay用に差し替え、本番の部屋・認証情報には触らない。
- 実マウスクリックとCDPの実キーイベントを使う。合成KeyboardEventだけでは
  ブラウザの暗黙フォーム送信が起きず、この不具合を検出できない。
- ダイアログ0件、遷移要求0件、ページ維持、入室成功、例外0件を断言する。
- 入室後に意図的にリロードし、離脱確認が残り、キャンセルでページが維持されることも確認する。
- `tmp/password-entry/<時刻>-<操作>-<モード>/results.json` にロードした
  main名、イベント、結果を保存する。終了時に隔離プロセスを停止する。

2026-10-25確認：公開版と同一の `main-TZAMUF2H.js` はクリックでは正常だが、
Enterで `formSubmissionGet` と `beforeunload` が発生する。
