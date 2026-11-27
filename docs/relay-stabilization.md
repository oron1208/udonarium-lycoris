# サーバー通信の安定化と部屋の通信方式（2026-11-27）

おれおんがサーバー通信で遭った「同期がズレる」「画像が出ない」を再現して直し、サーバー通信を既定にして、部屋を作るときだけ P2P を選べるようにした。

## 同期のズレ

- 原因: 部屋ログがスナップショットに圧縮されたあと、同じ接続で戻ったクライアントが他のメンバーからルーム束を受け取れない。スナップショットは追加と更新しかしないので、削除済みのキャラクターと子オブジェクトが幽霊として残る。ブラウザ同士では入室時のルーム束がこれを隠している。relay 単独で入るクライアント（Godot 版など）は常にこの危険がある。
- サーバー `unified-server.js`: 削除を `room.tombstones` に識別子と seq で記録し、子へ広げ、更新で解除する。`room-snapshot` に `deleted` を添える。カーソルがトリムされた領域に入っているときは `resync: 'gap'` でスナップショットを基底に戻す。`ping` に `pong` を返す。
- クライアント `websocket-relay-connection.ts`: `deleted` をローカル削除に適用する。gap ならスナップショットを最初から適用する。ハートビート（20秒ごとの ping、 pong が途切れたら接続を作り直す）。`online` ですぐ再接続。
- 個人通知（`to-pl-system-message` の接続確認・ログアウト）は各端末が自分用に作るので、部屋の状態に入れない。

## 画像が出ない

- 原因: ZIP 内の画像がハッシュ以外の名前（例: `zipcharimg.png`）だと、その名前がそのまま識別子になる。サーバーは SHA-256 の名前でしか画像を置けないので、上げた人にだけ見えて他のメンバーには出ない。
- 修正 `file-archiver.ts`: 取り込み時に内容の SHA-256 を識別子にし、XML の参照を置き換える。全員が assets に持つ画像と URL の画像はそのまま。

## 部屋の通信方式

- 既定はサーバー通信（`backend.mode: websocket-relay`）。
- 部屋作成ダイアログの「通信方式」で P2P（SkyWay 2023）を選ぶと、その部屋は P2P 方式になる。選択肢はサーバーが SkyWay のトークンを発行できるときだけ出る。
- ロビーの一覧に各部屋の方式を出す（サーバー通信 / P2P）。入室するときはその部屋の方式で接続する。
- P2P 部屋のメンバーはサーバーに在室通知だけを出す（`room-beacon.ts`）。部屋のデータは SkyWay を通る。
- サーバーは1つの部屋を1つの方式でしか受け付けない（`transport-mismatch`）。一覧が古くて違う方式で入ろうとしたら、クライアントがその部屋の方式で入り直す。
- 再接続（AutoReconnect、ページ再読み込みのあと）は部屋の方式を覚えている（`localStorage` の `udonarium.roomTransports.v1`）。
- Unity 版など、在室通知を出さないクライアントが作った P2P 部屋は、SkyWay のロビーから一覧に補う。
- `backend.mode: skyway2023` のままなら、従来どおり全部屋が P2P で、選択肢は出ない。

## 検証

どれもローカルの fixture サーバー（`tools/lib/lightweight-browser.cjs`）で動く。プロキシ除外が必要。

- `node tools/test-relay-tombstones.cjs`: サーバー単体、生の WebSocket。削除がログより長生きすること、スナップショットが削除済みオブジェクトを蘇らせないこと、ほか 8項目。
- `node tools/test-relay-transports.cjs`: サーバー単体。P2P 部屋の一覧への出方、方式が違うメンバーの拒否、P2P ソケットから部屋ログに何も入らないこと、SkyWay の資格情報の有無の伝え方、ほか 14項目。
- `node tools/verify-relay-convergence.cjs`: 実ブラウザ2台と生の WebSocket。ログが圧縮されたあとの戻り方 3通りと、後から入る人の中身が残った人と同じこと、6項目。
- `node tools/verify-relay-images.cjs`: 実ブラウザ3台。ZIP から上げたキャラクターの画像が、いたメンバー・後から入ったメンバー・サーバーの 3方で揃うこと、4項目。修正前は 4項目中 3つ失敗する。
- `node tools/verify-room-transport.cjs`: 実ブラウザ。ロビーのボタンと部屋作成ダイアログを実際に押す。既定の部屋がサーバー通信になること、一覧の表示、入室・再接続が部屋の方式を守ること、一覧が古いときの訂正、14項目。
- `ROOM_TRANSPORT_SKYWAY=1 node tools/verify-room-transport.cjs`: 同じ試験を本物の SkyWay（`.env` の資格情報）で。P2P 部屋が開くこと、ロビーから入って双方がつながること、変更がメンバー間で届くこと、再接続も P2P で戻ること。さらに `backend.mode: skyway2023` のままの部署（選択肢なし、全部屋 P2P）でも部屋が開き、ロビーに出て、入れること。22項目。

2026-11-27 14:22 時点の結果（同じビルド）: tombstones 8、transports 14、convergence 6、images 4、room-transport 14（SkyWay なし）・ 22（SkyWay あり）。すべて通過。

実機ではまだ見ていないこと: Godot 版・Unity 版がこのサーバーとやり取りする様子（形式は変えていない。P2P 部屋に relay で入ろうとすると `transport-mismatch` のエラーが返る）。Unity 版が作った P2P 部屋が SkyWay のロビーから補われること。

## VPS へ反映するとき

- VPS の `assets/config.yaml` は上書きしない方針なので、既定をサーバー通信にするには VPS 側の `backend.mode` を `websocket-relay` に変える必要がある。
- P2P を選べるようにするには、VPS のサーバーに `SKYWAY_APP_ID` と `SKYWAY_SECRET_KEY` が設定してあること（`/etc/udonarium-lily.env`）。
