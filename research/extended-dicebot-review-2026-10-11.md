# 拡張ダイスボット不調の確認結果

## 対象と結論

2026-10-11、おれおん依頼「アドバンスモードで拡張ダイスボットON、関数関係が動かない」「関数はすべて動いてない」を調査。
基準コード: `6871cb63e46cb5ee65449890022409ba73d8155b`。

**通常チャットの送信経路では関数処理を呼ばず、9種類すべて未計算のまま送信する。チャットパレットの送信経路では数値だけの9種類は動作するが、関数引数の数式を正しく扱えない実不具合がある。**

どの入力欄・具体式で報告されたかは未特定。ユーザーへ例と入力場所を質問したところ「関数はすべて動いてない」との回答。利用者の症状をパレットも全滅と断定せず、経路別結果を示す。

今回アプリコード・本番配信の変更はしていない。ネットワーク改善は引き続き保留。

## 実施した検証

- 実ソースのChatPaletteをTypeScript transpileし、同期基盤のみstubした計算単体プローブ。
- 同じソースでdevelopmentビルド成功。
- 作業用ディレクトリ内にunified-server.jsを複製。部屋・素材データも隔離し、専用14319ポートへ配信。本番の部屋・素材・設定は使用しない。
- 新規ChromeプロファイルとCDPで2タブを同じ隔離Relay部屋へ接続。
- fixtureでアドバンスモードを設定し、オプションの拡張ダイスボットONはtrusted clickで実行。
- 実ブラウザのChatPaletteComponent.sendChatとChatWindowComponent.sendChatに同じ入力を渡し、実ChatTabに生成されたメッセージ本文を比較。キーボード入力そのもののE2Eではない。gameSystem=nullで前処理を確認し、BCDiceの乱数結果とは分離。
- 別タブの後入室時にONを取得、先行タブでOFFへ変更すると後続タブもOFFとなることを確認。
- Chromeと検証サーバーは終了。SkyWay実通信、実利用者の部屋、別ウィンドウ経路は未検証。

## 再現結果

ONのチャットパレット送信:

```text
{max(3,7,5)}    → 7
{min(3,7,5)}    → 3
{sum(3,5,7)}    → 15
{avg(10,15,14)} → 13
{abs(-4)}       → 4
{ceil(3.2)}     → 4
{floor(3.8)}    → 3
{round(3.5)}    → 4
{clamp(15,1,10)}→ 10
```

通常チャットでは上記9件すべてが入力文字列のまま残る（例 `{max(3,7,5)}` → `{max(3,7,5)}`）。

パレット変数 `//Lv=5`, `//X=10`, `//TX=3` を登録したONのチャットパレット送信:

```text
{ceil({Lv}/2)}d6        → d6       （期待: 3d6）
距離: {abs({X}-{TX})}   → 距離: 10 （期待: 距離: 7）
```

単体プローブで追加確認:

```text
HP={clamp({HP}-1d6,0,999)} → HP=（HP=20）
K(21+5)[10]+(7+2)         → K+26[10]+9
{max({abs(-3)},{abs(-7)})} → 7
AT+(2+(3*4))               → AT+14
```

`clamp`内部のダイスを評価する仕組みはなく、ガイドの当該例は現行実装と不整合。ダイスを数学関数内で振る機能まで修正対象に含めるかは別途仕様を決める。

## 原因とコード位置

1. **通常チャットは未接続**
   - `src/app/component/chat-window/chat-window.component.ts:498` のsendChatは入力をそのままChatMessageServiceへ渡す。拡張ON判定もChatPalette.evaluate呼出しもない。
   - 対照的に `chat-palette.component.ts:349,357,363` はON設定を引数にevaluateを呼ぶ。
   - オプション説明と公式ガイドは「チャットパレットで使える」と記載。通常チャット対応は現行仕様にない経路だが、「部屋全体で有効」という利用者の期待とは混同しやすい。

2. **関数の引数で四則演算をしない／数値判定が緩い**
   - `src/app/class/chat-palette.ts:179` のevaluateFunctionは引数をカンマで分け、数値または変数名として解決するだけ。
   - `5/2` は数値扱いされず、変数名としても見つからないため値がなくなり、関数全体が空になる。
   - `10-3` は数値判定 `/^[-\d.]+$/` を通過してしまい、parseFloatで10となる。計算する前に誤った数値を採用する。
   - 外側の括弧式計算は関数置換より後なので、消された引数を救済できない。

3. **設定共有は今回の隔離Relay試験で正常**
   - `src/app/class/game-table.ts` のextendedDiceBotEnabledはSyncVar。
   - `options-panel.component.ts:185` は設定変更後にtable.update。
   - serialized contextでは `syncData.attributes.extendedDiceBotEnabled` にtrueを確認。
   - 同じ卓を見ている後入室者へのON取得と、参加中のOFF反映を実通信で確認。
   - フラグはGameTableの属性なので、別テーブルへ切り替えた場合の設定保持は今回の共有試験とは別。

4. **ガイドにも不整合**
   - `docs-site/guide/extended-dicebot.html` のLv/2、X-TXの実践例は上記不具合で期待通り動かない。
   - 関数内1d6の例はBCDice前処理という説明と整合しない。
   - K直後の括弧は保持されると説明するが、実装は置換する。
   - 波括弧付きの関数ネスト不可と説明するが、単体プローブでは上記max/absが動く。

## 修正を進める場合の推奨範囲

1. ON時の各入力経路の適用範囲を明確化。通常チャットも対象にするなら発言者のキャラ変数・対象指定・二重評価・OFF時の既存動作を揃える。全送信メッセージへ無条件の置換を足さない。
2. 関数引数に許可された四則演算を正しく解析し、不正な式・未解決変数を黙って0や途中の数値へ変換しない。正負・小数・括弧・最大値指定・対象変数をテストする。
3. ダイスを含む関数の仕様は別に決める。対応しないならガイド例を修正し、勝手な結果や空文字へ変換しない。
4. ON/OFF、9関数、パレット変数＋算術、通常チャット、マクロ/VN、参加者間の設定共有、BCDiceへの実送信を回帰検証。
5. ガイド記述を実装と一致させる。

## 検証ログ

- `tmp/extended-dice-review/evaluator-baseline.json`: 計算単体プローブ結果。
- `tmp/extended-dice-review/browser-baseline.json`: 実ブラウザ・2クライアント結果（DONE=true）。
- `tmp/extended-dice-review/browser-baseline.log`: 実行ログ。
- `tmp/extended-dice-review/probe.cjs`: 隔離検証ハーネス。fixture server/devビルドの準備が必要。
- `tmp/extended-dice-review/build.log`: developmentビルド成功ログ。
