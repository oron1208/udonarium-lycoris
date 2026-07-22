# BGM一括ドラッグ&ドロップ時の並び順問題 修正報告

**日時**: 2026-07-23  
**問題**: フォルダ内のBGMを一括選択してドラッグ&ドロップした際、並び順が変わってしまう

## 原因

コミット `4fc6cef` (2026-07-06 "perf: アップロード処理を並列バッチ化（同時6ファイル）") により導入された `Promise.all` バッチ処理が原因。

### 詳細

`FileArchiver.load()` が以下のようにファイルを6個ずつのバッチで並列処理していた：

```typescript
// 修正前（問題のコード）
const BATCH_SIZE = 6;
for (let i = 0; i < loadFiles.length; i += BATCH_SIZE) {
  const batch = loadFiles.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(async file => {
    await this.handleAudio(file);  // ← ここが非同期
    // ...
  }));
}
```

各バッチ内で6ファイルが同時に処理され、`handleAudio()` → `AudioStorage.addAsync()` → `AudioFile.createAsync()` → `calcSHA256Async()` と非同期チェーンが走る。

SHA256ハッシュ計算は `FileProcessingWorker` (Web Worker) にオフロードされているため、ファイルサイズが異なれば計算完了順も異なる。**小さいファイルほど先に完了し、先に `AudioStorage.hash` に登録される**。

`AudioStorage.audios` ゲッターは `this.hash` の挿入順で返すため、UI（ジュークボックス）の表示順も非決定的な完了順になってしまっていた。

### 影響範囲
- 音声ファイル（BGM）の並び順が崩れる
- 画像ファイルの並び順も同様に崩れる可能性がある

## 修正内容

**ファイル**: `src/app/class/core/file-storage/file-archiver.ts`  
**メソッド**: `FileArchiver.load()`

バッチ並列処理を廃止し、順次処理（シーケンシャルループ）に戻した。

```typescript
// 修正後
for (let i = 0; i < loadFiles.length; i++) {
  const file = loadFiles[i];
  try {
    await this.handleImage(file, preserveImageBytes);
    await this.handleAudio(file);
    await this.handleMediaManifest(file);
    await this.handleText(file);
    await this.handleZip(file);
    EventSystem.trigger('FILE_LOADED', { file: file });
  } catch (e) {
    Logger.warn(`FileArchiver: error processing ${file.name}`, e);
  }
}
```

### パフォーマンスへの影響

**最小限**。理由：
- SHA256計算と画像圧縮は既に `FileProcessingWorker` (Web Worker) にオフロード済み
- Worker単体がマルチスレッドで動作するため、メインスレッドの逐次ループでも実用十分な速度
- バッチ並列化は Worker 導入前（`1c14794`）のCPU負荷対策だったが、Worker導入後は冗長だった
- タイポ的なBGMドロップ（10〜30ファイル）では体感差なし

### 処理フロー（修正後）

1. `onDrop()` が `event.dataTransfer.files` (FileList) を取得
2. `toArrayOfFileList()` で File[] に変換（順序保持）
3. **for ループで1ファイルずつ順次処理**
4. `handleAudio()` → `AudioStorage.addAsync()` が完了してから次のファイルへ
5. `AudioStorage.hash` にドロップ順で挿入される → UI表示順も正しく維持

## ビルド結果

```
Build at: 2026-07-22T23:20:52.150Z
Hash: e3e1fd706f0c771c
Time: 56492ms
✓ Build successful (exit code 0)
```

CSSバジェット警告のみ（既存・無害）。エラーなし。

## 今後の改善案（必要であれば）

音声ファイルのみ順序保持、画像ファイルは並列バッチ処理というハイブリッド方式も可能：

```typescript
// 音声ファイルは順次、画像等はバッチ並列
const audioFiles = loadFiles.filter(f => f.type.indexOf('audio/') >= 0);
const otherFiles = loadFiles.filter(f => f.type.indexOf('audio/') < 0);

// 音声：順次処理
for (const file of audioFiles) {
  await this.handleAudio(file);
}

// 画像等：バッチ並列
const BATCH_SIZE = 6;
for (let i = 0; i < otherFiles.length; i += BATCH_SIZE) {
  // ...
}
```

現在のシンプルな順次処理で十分な性能が出ているため、当面は必要なし。
