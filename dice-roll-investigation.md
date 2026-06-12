# ダイスロール演出 調査レポート

調査日: 2026-06-12

---

## 1. 現状のダイス演出の仕組み（コードの流れ）

### 全体フロー

```
ユーザーがチャットパレットからコマンド送信
  → ChatMessage が作成される (isDicebot判定)
  → DiceBot.onStoreAdded() で SEND_MESSAGE イベントをフック
  → BCDice.diceRollAsync() でゲームシステムに応じたダイスロール実行
  → DiceRollResult 生成（result, rands, detailedRands, isCritical, isFumble等）
  → DiceBot.sendResultMessage() で結果をチャットに投稿
    ├─ EventSystem.trigger('DICE_CUT_IN_STRUCTURED') → DiceCutinComponent（アドバンスモード用オーバーレイ）
    └─ CutInLauncher.diceRollCutIn() → CutInWindowComponent（サイドメニューのカットイン画像＋音声）
```

### 各モードのカットイン

| モード | コンポーネント | 機能 |
|--------|----------------|------|
| アドバンスモード | `DiceCutinComponent` | SVGダイス図形＋出目表示＋キャラ画像のオーバーレイ演出 |
| サイドメニュー | `CutInWindowComponent` | カットイン画像＋音声＋ダイス結果テキストのオーバーレイ |
| テーブル上 | `DiceSymbolComponent` | テーブル上の3Dダイスシンボル（画像ベース） |

### 判定フラグ

- **roomMode**: `GameTable.roomMode` が `'advanced'` の時のみ `DiceCutinComponent` が有効
- **diceCutinEnabled**: `GameTable.diceCutinEnabled` (デフォルト `true`)
- **CutIn.diceActivate**: カットイン設定で「ダイスロール時に自動再生」が有効なもの

---

## 2. コンポーネント・ファイル一覧

### ダイスロールカットイン演出（アドバンスモード）

| ファイル | 役割 |
|----------|------|
| `src/app/component/dice-cutin/dice-cutin.component.ts` | ★ メインのダイスカットインロジック |
| `src/app/component/dice-cutin/dice-cutin.component.html` | カットイン表示HTML |
| `src/app/component/dice-cutin/dice-cutin.component.css` | アニメーション・レイアウトCSS |

### カットインウィンドウ（サイドメニュー用）

| ファイル | 役割 |
|----------|------|
| `src/app/component/cut-in-window/cut-in-window.component.ts` | カットインウィンドウ制御 |
| `src/app/component/cut-in-window/cut-in-window.component.html` | 画像＋音声＋ダイス結果テキスト |
| `src/app/component/cut-in-window/cut-in-window.component.css` | スタイリング |

### ダイスシンボル（テーブル上）

| ファイル | 役割 |
|----------|------|
| `src/app/component/dice-symbol/dice-symbol.component.ts` | テーブル上のダイス操作・アニメーション |
| `src/app/component/dice-symbol/dice-symbol.component.html` | 3Dダイス表示 |
| `src/app/component/dice-symbol/dice-symbol.component.css` | スタイリング |
| `src/app/class/dice-symbol.ts` | DiceSymbolモデル（faces, diceRoll） |

### BCDice連携

| ファイル | 役割 |
|----------|------|
| `src/app/class/dice-bot.ts` | ★ BCDice連携のメイン。ダイスロール実行・結果送信・リソース操作 |
| `src/app/class/bcdice/bcdice-loader.ts` | BCDiceダイナミックローダー |
| `src/app/class/KariDice.ts` | カスタムダイスボット「仮ダイス」（2d6+ゾロ目判定） |
| `src/app/class/IdoDice.ts` | カスタムダイスボット「イドの証明」（1d100判定システム） |

### カットイン管理

| ファイル | 役割 |
|----------|------|
| `src/app/class/cut-in-launcher.ts` | カットイン起動管理・ネットワーク同期 |
| `src/app/class/cut-in.ts` | CutInモデル（画像・音声・タグ・diceActivate等） |

### 設定

| ファイル | 役割 |
|----------|------|
| `src/app/class/game-table.ts` | `roomMode`, `diceCutinEnabled` フラグ |
| `src/app/class/peer-cursor.ts` | `diceImageType`, `diceImageIndex`（ダイス画像識別子） |

### 画像リソース

| ディレクトリ | 内容 |
|--------------|------|
| `src/assets/images/dice/4_dice/` | D4画像 (4枚) |
| `src/assets/images/dice/6_dice/` | D6画像 (7枚: 0-6) |
| `src/assets/images/dice/8_dice/` | D8画像 (9枚: 0-8) |
| `src/assets/images/dice/10_dice/` | D10画像 (10枚) |
| `src/assets/images/dice/12_dice/` | D12画像 (13枚) |
| `src/assets/images/dice/20_dice/` | D20画像 (21枚: 0-20) |
| `src/assets/images/dice/100_dice/` | D100画像 (11枚: 10刻み) |
| `src/assets/images/april_dice/` | エイプリルフール用ダイス画像 |

### モジュール登録

- `src/app/app.module.ts`: `DiceCutinComponent` を declarations に登録
- `src/app/app.component.html`: `<dice-cutin></dice-cutin>` を配置

---

## 3. ダイスの画像・3D表現の定義箇所

### テーブル上のダイスシンボル（DiceSymbolComponent）
- **画像ベース**: `DiceSymbol.faces` に紐づく画像ファイルを `img` タグで表示
- `DiceSymbol.makeDiceFace(type)` でタイプに応じた面を生成
- `DiceType` enum: `D2, D4, D6, D8, D10, D10_10TIMES, D12, D20`
- 画像は `src/assets/images/dice/{N}_dice/` に格納
- アニメーション: Angular Animations `@diceRoll` で回転＋バウンス

### カットイン演出のダイス（DiceCutinComponent）
- **SVGベース**: `getRawDiceSvg(shape)` でインラインSVGを生成
- `DiceShape` type: `'d4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100'`
- 各面に応じた多角形SVG（d4=三角形, d6=四角形, d8=菱形, ...）
- CSSでダイスの形ごとに異なるアニメーション（`diceRollD4` ～ `diceRollD100`）
- 出目は `.dice-value-overlay` でSVG上にテキスト表示

---

## 4. BCDiceの結果パース方法

### BCDiceから返される DiceRollResult 構造

```typescript
interface DiceRollResult {
  id: string;              // ゲームシステムID（例: "SwordWorld2.5"）
  result: string;          // 結果テキスト（例: "SwordWorld2.5 : (2d6+3) ＞ 6[2,4]+3 ＞ 9"）
  isSecret: boolean;
  rands: [number, number][];              // [sides, value] の配列
  detailedRands: { kind: string; sides: number; value: number; }[];
  isSuccess: boolean;
  isFailure: boolean;
  isCritical: boolean;
  isFumble: boolean;
}
```

### DiceCutinComponent の2つのパス

#### パスA: `tryCutin(msg: ChatMessage)` — テキストベース解析
`UPDATE_GAME_OBJECT` イベントで ChatMessage を検知し、`msg.text` を正規表現でパース。

1. **出目抽出**: `extractDiceValues(text)`
   - `[カンマ/スペース区切りの数値]` 形式を全て抽出
   - SW2.5形式: `2D:[6,5 4,3]=11,7` → `[6,5,4,3]`
   - 汎用形式: `[3,5,2]` → `[3,5,2]`
2. **合計値抽出**: `→ 数字` の最後の数字をtotalに
3. **ダイス形状推定**: `detectDiceShape(expression)` でコマンド内の `d6`, `d20` 等から形状を判定
4. **特殊ラベル判定**: テキスト内の「クリティカル」「ファンブル」「成功」「失敗」等を正規表現で検出

#### パスB: `tryStructuredCutin(rollResult)` — 構造化データ利用
`DICE_CUT_IN_STRUCTURED` イベントで BCDice の生データを受け取る。

1. **detailedRands** から `kind === 'normalDice'` のエントリを抽出
2. `sides` → `sidesToShape()` でダイス形状を判定
3. `value` が出目

### テキスト解析の正規表現パターン

`parseDiceResult()` 内で5つのパターンを試行:

| パターン | 例 | 正規表現 |
|----------|-----|----------|
| A (有利/不利) | `(AT+9A) → [14,7]+9 → 23` | `\(([^)]+)\)\s*[→＞]\s*\[([^\]]+)\]([^→＞]*?)[→＞]\s*(\d+)` |
| B (標準ダイス) | `(2d6+3) → 6[2,4]+3 → 9` | `\(([^)]+)\)\s*[→＞]\s*(\d+)\[([^\]]*)\]([^→＞]*?)[→＞]\s*(\d+)` |
| D (修飾なし) | `(AT+9) → 16+9 → 25` | `\(([^)]+)\)\s*[→＞]\s*(\d[\d+\-]*?)\s*[→＞]\s*(\d+)` |
| C (シンプル) | `(1d100) → 45` | `\(([^)]+)\)\s*[→＞]\s*(\d+)` |
| E (＞記号) | `(1D10+8+2) ＞ 3[3]+8+2 ＞ 23` | 全角＞も→に置換後にパターン適用 |

---

## 5. 成功/失敗/クリティカルの判定ロジック

### 既存の判定（テキストベース）

`DiceCutinComponent.tryCutin()` 内:

```typescript
const isCritical = /クリティカル|Critical|critical|\*\*/.test(text);
const isFumble = /ファンブル|Fumble|fumble/.test(text);
```

さらに以下の特殊ラベルを順次チェック:
- 回転数（SW2.5: `(\d+)回転`）
- スペシャル、クリティカル、ファンブル
- 絶対成功/絶対失敗、自動成功/自動失敗
- 大成功/大失敗、超成功/超失敗、劇的成功/劇的失敗
- 成功/失敗（汎用、最後のフォールバック）

### BCDice構造化フラグ

`DiceRollResult` には BCDice から直接フラグが返される:
- `isSuccess` / `isFailure` / `isCritical` / `isFumble`

`tryStructuredCutin()` では `rollResult.isCritical`, `rollResult.isFumble` を使用。

### D20のクリティカル/ファンブル

`checkCritical()` / `checkFumble()` は **1d20限定** で:
- クリティカル: `1d20` の結果が 20
- ファンブル: `1d20` の結果が 1

**問題点**: 他のシステム（クトゥルフ、SW等）の特殊判定には対応していない。

---

## 6. 問題点（なぜ6面ダイスになってしまうか）

### 根本原因: `extractDiceValues()` のフォールバック

```typescript
// ダイス値がない場合は1個だけtotal値のダイスを表示
const finalDiceResults = diceResults.length > 0 
  ? diceResults 
  : [{ value: total, shape: 'd6' as DiceShape }];
```

**テキストからダイス出目が抽出できなかった場合、デフォルトで `d6` になる。**

### 出目抽出が失敗するケース

1. **BCDice結果テキストに `[...]` 形式がない場合**
   - 例: `(AR+8+(0*5*1)+0+0) → 25`
   - `extractDiceValues()` は `[数字リスト]` を探すが存在しない

2. **ゲームシステムが独自フォーマットを使う場合**
   - `result` テキストの形式が予想パターンと合わない
   - SW2.5の `2D:[6,5 4,3]=11,7` は部分対応

3. **構造化データ（detailedRands）が空の場合**
   - 一部のゲームシステムは `detailedRands` を返さない
   - この場合 `rands`（`[sides, value][]`）にフォールバック

4. **ダイス形状推定の失敗**
   - `detectDiceShape()` はコマンド文字列内の `d6`, `d20` 等を探す
   - `AR+8+(0*5*1)+0+0` のようなコマンドには `dN` が含まれない → デフォルト `d6`

### 修正が必要なファイル一覧

| 優先度 | ファイル | 修正内容 |
|--------|----------|----------|
| ★高 | `dice-cutin.component.ts` | `extractDiceValues()` の改善、フォールバック時のshape推定ロジック追加 |
| ★高 | `dice-cutin.component.ts` | `tryCutin()` のフォールバック: `d6` → テキスト解析で適切なshapeを選択 |
| ★高 | `dice-cutin.component.ts` | BCDice結果の `rands`/`detailedRands` を優先的に使うようロジック変更 |
| 中 | `dice-bot.ts` | `sendResultMessage()` で構造化データをイベントに含める（既に対応済み） |
| 中 | `cut-in-launcher.ts` | `diceRollCutIn()` にrollResultを渡す（既に対応済み） |
| 低 | `cut-in-window.component.html` | ダイス結果表示UIの改善 |
| 低 | `dice-cutin.component.html` | 修正値・基本出目の表示追加 |

---

## 7. BCDice結果から「出目」「修正値」「最終結果」を抽出する方法の提案

### 対象コマンド例: `AR+8+(0*5*1)+0+0`

このコマンドのBCDice結果（想定）:
```
AR+8+(0*5*1)+0+0 ＞ 17+8+(0*5*1)+0+0 ＞ 25
```
または:
```
AR+8 ＞ 17[17]+8 ＞ 25
```

### 提案パーサー設計

#### 方針: 3段階のフォールバック

1. **構造化データ（detailedRands/rands）を最優先**
2. **テキストの `[...]` から出目を抽出**
3. **フォールバック: total値のみ表示（shapeはd6ではなく「不明」として汎用表示）**

```typescript
// 提案: 新しいパーサーメソッド
interface ParsedDiceResult {
  baseRolls: number[];      // 基本の出目（ダイスそのものの値）例: [17]
  modifier: number;          // 修正値の合計 例: +8
  modifierBreakdown: string; // 修正値の内訳 例: "+8+(0*5*1)+0+0"
  total: number;             // 最終結果 例: 25
  diceShape: DiceShape;      // ダイス形状
  rawExpression: string;     // 元のコマンド
}
```

#### 実装案

```typescript
parseAdvancedResult(text: string, rollResult?: DiceRollResult): ParsedDiceResult {
  // Step 1: 構造化データがあれば使用
  if (rollResult?.detailedRands?.length > 0) {
    const baseRolls = rollResult.detailedRands
      .filter(d => d.kind === 'normalDice')
      .map(d => d.value);
    const total = this.extractTotal(text);
    const modifier = total - baseRolls.reduce((a, b) => a + b, 0);
    const diceShape = this.sidesToShape(rollResult.detailedRands[0].sides);
    return { baseRolls, modifier, modifierBreakdown: `+${modifier}`, total, diceShape, rawExpression: text };
  }

  // Step 2: rands があれば使用
  if (rollResult?.rands?.length > 0) {
    const baseRolls = rollResult.rands.map(([sides, value]) => value);
    const total = this.extractTotal(text);
    const modifier = total - baseRolls.reduce((a, b) => a + b, 0);
    const diceShape = this.sidesToShape(rollResult.rands[0][0]);
    return { baseRolls, modifier, modifierBreakdown: `+${modifier}`, total, diceShape, rawExpression: text };
  }

  // Step 3: テキスト解析
  // パターン: (command) ＞ value[roll1,roll2,...]+mod1+mod2 ＞ total
  // パターン: (command) ＞ value+mod1+mod2 ＞ total
  // パターン: (command) ＞ total
  const match = text.match(/\(([^)]+)\)\s*[→＞]\s*(?:([^→＞\[]+)\[([^\]]*)\]|([^→＞]+?))\s*[→＞]\s*(\d+)/);
  if (match) {
    const expression = match[1];
    const rolls = match[3] ? match[3].split(/[\s,]+/).map(Number) : [];
    const diceValue = rolls.length > 0 ? rolls : [parseInt(match[2] || match[4], 10)];
    const total = parseInt(match[5], 10);
    const modifier = total - diceValue.reduce((a, b) => a + b, 0);
    // ...
  }

  // フォールバック: totalのみ
  const total = this.extractTotal(text);
  return { 
    baseRolls: [total], 
    modifier: 0, 
    modifierBreakdown: '', 
    total, 
    diceShape: 'd100', // d6ではなく汎用的なshape
    rawExpression: text 
  };
}

private extractTotal(text: string): number {
  const match = text.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}
```

#### AR+8+(0*5*1)+0+0 の場合のパース手順

1. BCDiceが結果を返す。`detailedRands` に `{ kind: 'normalDice', sides: 100, value: 17 }` が含まれる
2. `baseRolls = [17]`
3. `total = 25`（テキストの最後の数字）
4. `modifier = 25 - 17 = 8`
5. `diceShape = sidesToShape(100) = 'd100'`
6. 結果: `{ baseRolls: [17], modifier: 8, total: 25, diceShape: 'd100' }`

**修正値の内訳**を詳細に表示したい場合、コマンド文字列（`AR+8+(0*5*1)+0+0`）から最初のダイス部分を除いた残りを `modifierBreakdown` として抽出する。

---

## 8. 成功/失敗/クリティカル演出を追加するための実装案

### 案A: BCDiceの構造化フラグを活用（推奨）

すでに `DiceRollResult` に `isSuccess`, `isFailure`, `isCritical`, `isFumble` が含まれている。

```typescript
// dice-cutin.component.ts の tryStructuredCutin() を拡張
private tryStructuredCutin(rollResult: any) {
  // ... 既存のロジック ...

  // BCDiceの構造化フラグを直接使用
  const isCritical = rollResult.isCritical || false;
  const isFumble = rollResult.isFumble || false;
  const isSuccess = rollResult.isSuccess || false;
  const isFailure = rollResult.isFailure || false;

  // 成功度に応じた演出
  let specialLabel = '';
  let specialLabelClass = 'label-special';

  if (isCritical) {
    specialLabel = 'クリティカル!';
    specialLabelClass = 'label-success';
  } else if (isFumble) {
    specialLabel = 'ファンブル...';
    specialLabelClass = 'label-failure';
  } else if (isSuccess) {
    specialLabel = '成功!';
    specialLabelClass = 'label-success';
  } else if (isFailure) {
    specialLabel = '失敗...';
    specialLabelClass = 'label-failure';
  }

  // ... dataに反映 ...
}
```

### 案B: 汎用テキストパーサーの改善

`tryCutin()` のテキストベース判定を強化:

```typescript
// 既存のテキストベース判定に加えて、BCDice結果テキストの形式を拡張
// 全角＞は既に→に置換済み（dice-bot.ts sendResultMessage()）

// 「→ 成功」「→ 失敗」パターンに対応
const successFailureMatch = text.match(/[→＞]\s*(成功|失敗|クリティカル|ファンブル|スペシャル)/);
```

### 案C: 演出の強化（HTML/CSS）

#### HTMLの拡張（dice-cutin.component.html）

```html
<!-- 基本出目・修正値・最終結果の表示 -->
<div class="dice-section">
  <div class="dice-expression">{{data.diceExpression}}</div>
  
  <!-- ダイス表示 -->
  <div class="dice-container">
    <div *ngFor="let dice of data.diceResults" class="dice dice-{{dice.shape}}">
      <div class="dice-body" [innerHTML]="getDiceSvgSafe(dice.shape)"></div>
      <div class="dice-value-overlay">{{dice.value}}</div>
    </div>
  </div>
  
  <!-- 修正値の内訳（新規追加） -->
  <div class="modifier-breakdown" *ngIf="data.modifierBreakdown">
    <span class="base-value">出目: {{data.baseRollsText}}</span>
    <span class="modifier-value">修正: {{data.modifierBreakdown}}</span>
  </div>
  
  <!-- 最終結果 -->
  <div class="total-section">
    <span class="total-label">結果</span>
    <span class="total-value">{{data.total}}</span>
    <span class="special-label" [class]="data.specialLabelClass">
      {{data.specialLabel}}
    </span>
  </div>
</div>
```

#### CSS追加（アニメーション強化）

```css
/* 成功時: 緑のグロウ */
.cutin-card.success {
  border-color: rgba(68, 255, 136, 0.8);
  box-shadow: 0 0 40px rgba(68, 255, 136, 0.5);
  background: linear-gradient(135deg, rgba(10, 40, 20, 0.95), rgba(15, 50, 25, 0.95));
}

/* 失敗時: 赤のグロウ */
.cutin-card.failure {
  border-color: rgba(255, 68, 68, 0.8);
  box-shadow: 0 0 40px rgba(255, 68, 68, 0.5);
  background: linear-gradient(135deg, rgba(40, 10, 10, 0.95), rgba(50, 15, 15, 0.95));
}

/* 修正値の内訳表示 */
.modifier-breakdown {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: #8898c0;
  font-family: 'Courier New', monospace;
}

.base-value {
  color: #aac0ff;
}

.modifier-value {
  color: #ffcc66;
}
```

---

## 9. 修正が必要なファイル一覧（サマリ）

### 即時修正（出目がd6になる問題）

1. **`src/app/component/dice-cutin/dice-cutin.component.ts`**
   - `tryCutin()` のフォールバック: `d6` 固定 → `rands`/`detailedRands` から適切なshapeを取得
   - `extractDiceValues()` の改善: `[...]` 形式がない場合でもテキスト解析で出目を抽出
   - 新規メソッド追加: `parseAdvancedResult()` — 構造化データ優先のパーサー

### 機能追加（修正値表示・成功失敗演出）

2. **`src/app/component/dice-cutin/dice-cutin.component.html`**
   - 修正値の内訳表示エリア追加
   - 成功/失敗に応じたカードスタイルのクラスバインディング追加

3. **`src/app/component/dice-cutin/dice-cutin.component.css`**
   - `.cutin-card.success` / `.cutin-card.failure` スタイル追加
   - 修正値内訳のスタイル追加

### データモデル拡張

4. **`src/app/component/dice-cutin/dice-cutin.component.ts`**（`DiceCutinData` インターフェース）
   ```typescript
   interface DiceCutinData {
     // 既存フィールド...
     baseRolls: number[];        // 基本の出目
     baseRollsText: string;      // "17" 等
     modifierValue: number;      // 修正値の合計
     modifierBreakdown: string;  // "+8+(0*5*1)+0+0" 等
   }
   ```

---

## 10. BCDiceコマンド `AR+8+(0*5*1)+0+0` のパース提案

### このコマンドの構造

- `AR`: ゲームシステム固有のコマンド（おそらくアリアンロッド系）
- `+8`: 修正値
- `+(0*5*1)`: 計算式による修正値（結果: 0）
- `+0+0`: 追加修正値

### BCDiceが返すデータ（推測）

```typescript
// rands / detailedRands にダイスロール結果が含まれる
// 例: sides=100, value=17 の1個
detailedRands: [{ kind: 'normalDice', sides: 100, value: 17 }]

// result テキスト
result: "GameSystem : (AR+8+(0*5*1)+0+0) → 17+8+(0*5*1)+0+0 → 25"
```

### パース手順

```
1. detailedRandsから: baseRolls = [17], diceShape = d100
2. テキストの最後の数字: total = 25
3. modifier = total - sum(baseRolls) = 25 - 17 = 8
4. 修正値内訳: コマンド "AR+8+(0*5*1)+0+0" から "AR" 部分（ダイス指示）を除去
   → "+8+(0*5*1)+0+0" をそのまま表示
5. 結果:
   - 基本の出目: 17
   - 修正値: +8+(0*5*1)+0+0
   - 最終結果: 25
   - ダイス形状: d100
```

### 実装のポイント

```typescript
// 修正値の内訳をテキストから抽出するヘルパー
private extractModifierBreakdown(expression: string, baseRoll: number, total: number): string {
  // コマンド文字列の最初のダイス指示（AR, 2d6, 1d100等）を除去
  // 残りの "+..." 部分をmodifierBreakdownとして保持
  const dicePattern = /^(AR|\d*[dD]\d+|AT|KD)/i;
  const remainder = expression.replace(dicePattern, '');
  return remainder || `+${total - baseRoll}`;
}
```

---

## 11. アーキテクチャ図

```
┌─────────────────────────────────────────────────┐
│                   ユーザー操作                     │
│            チャットパレット → コマンド送信            │
└──────────────┬──────────────────────────────────┘
               │ SEND_MESSAGE イベント
               ▼
┌─────────────────────────────────────────────────┐
│              DiceBot (dice-bot.ts)               │
│  ┌──────────────────────────────────────┐       │
│  │ 1. gameSystem.COMMAND_PATTERN チェック │       │
│  │ 2. BCDice.diceRollAsync() 実行        │       │
│  │ 3. DiceRollResult 生成                │       │
│  │ 4. sendResultMessage()                │       │
│  │    ├─ ChatMessage投稿                   │       │
│  │    ├─ DICE_CUT_IN_STRUCTURED イベント   │       │
│  │    └─ CutInLauncher.diceRollCutIn()    │       │
│  └──────────────────────────────────────┘       │
└──────────┬───────────────────┬──────────────────┘
           │                   │
           ▼                   ▼
┌─────────────────┐  ┌──────────────────────────┐
│ DiceCutinComp   │  │  CutInLauncher           │
│ (アドバンスモード) │  │  └→ CutInWindowComp     │
│                 │  │     (サイドメニューカットイン) │
│ • SVGダイス表示  │  │     • 画像+音声            │
│ • 出目オーバーレイ│  │     • ダイス結果テキスト     │
│ • キャラ画像     │  │                           │
│ • 成功/失敗ラベル│  │                           │
└─────────────────┘  └──────────────────────────┘
```
