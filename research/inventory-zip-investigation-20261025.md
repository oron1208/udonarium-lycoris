# インベントリ設定のZIP復元調査

## 状態

2026-10-25、公開版と同じソース（bc86ed6）で調査。
「以前の部屋ZIPを読み込んでもインベントリのソートなどの情報が空」という
報告そのものは未再現。原因未確定で、アプリのコード変更・公開変更はしていない。
実際に症状が出るZIPと、空になる箇所の確認が次に必要。

## 確認した経路

- `SaveDataService._saveRoomAsync()` は `DataSummarySetting.instance` を
  `summary.xml` として部屋ZIPへ保存する。
- `FileArchiver.handleZip()` → `handleText()` → `XML_LOADED` →
  `ObjectSerializer.parseXml()` → `DataSummarySetting.parseInnerXml()` で
  シングルトンの設定を更新する。
- ソート条件は `sortKeysJson`、インベントリ別条件は
  `inventorySortSettingsJson`、追加インベントリは
  `customInventoriesJson`、表示項目は `dataTag`。
- 旧形式の第1・第2条件は `sortTag` / `sortOrder` /
  `sortTag2nd` / `sortOrder2nd` から移行する。

## 実ブラウザ検証

隔離relay＋development build＋fresh Chromeで、実ファイル入力からZIPを読んだ。

1. 第1条件「先制・降順」、第2条件「HP・昇順」、表示項目
   「先制 HP MP / メモ」を設定。
2. テーブル専用条件「MP・降順／ソートOFF」、共有専用条件、追加インベントリを設定。
3. 実際の部屋保存サービスが `summary.xml` に各値を含めることを確認。
   ファイル収集後の圧縮・ダウンロード部分のみ計測用に差し替えた。
4. その保存ファイル一式でZIPを組み、別設定へ変更したあと再読込。
   ソート、表示項目、追加インベントリが元の設定へ復元した。
5. 新しいJSON属性のない旧形式XMLもZIP経由で復元した。
6. 手元の旧部屋ZIPを、summary単体だけでなくZIP全体で読み込み、
   保存されていたHP/nameソート・表示項目が復元した。
7. 明示的に `dataTag=""` を保存したZIPでは表示項目が空になった。
   これは入力値どおりの挙動であり、実際の報告ZIPに該当するかは未確認。

実行時例外0。旧部屋ZIP全体と現行保存データ一式の復元はassertでも確認した。
実ユーザーの部屋やVPS設定は変更していない。

## 証跡・再開

- `tmp/inventory-zip/probe.cjs`：実行用調査ハーネス
- `tmp/inventory-zip/probe-full.log`：最終結果
- `tmp/inventory-zip/<時刻>-probe-standard/results.json`：状態とXML
- `tmp/inventory-zip/before/browser`：変更前ソースのdevelopment build

問題のZIPが届いたら、まずZIP一覧と `summary.xml` の有無・属性を確認し、
このハーネスの実ファイル入力からそのZIP全体を読み込んで再現する。
元ZIPは上書きしない。空欄が意図した設定の場合もあるので、根拠なしに
デフォルト値で埋める修正は行わない。
