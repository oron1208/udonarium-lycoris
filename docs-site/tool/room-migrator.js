(() => {
  'use strict';

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  const ADVANCED_TABLE_DEFAULTS = {
    roomMode: 'advanced',
    lightingEnabled: 'false',
    lightingNightMode: 'true',
    lightingIntensity: '0.55',
    lightingTint: '#00030c',
    lightingAmbientLight: 'false',
    lightingAmbientIntensity: '0.35',
    lightingPaMode: 'false',
    lightingSpotlights: 'false',
    lightingSpotlightColor: '#fff3c4',
    lightingSpotlightCount: '2',
    lightingLasers: 'false',
    lightingLaserColor: '#4cf3ff',
    lightingLaserSpeed: '1',
    lightingFlames: 'false',
    lightingFlameLevel: '0.5',
    lightingHaze: 'false',
    visionEnabled: 'false',
    initialObjectsPlaced: 'false',
    diceCutinEnabled: 'true',
    extendedDiceBotEnabled: 'false',
    combatActive: 'false',
    combatRound: '1',
    combatTurnIndex: '0',
    combatOrder: '[]',
    combatBgmIdentifier: '',
    combatActedSet: '[]',
    combatJoinAllTableCharacters: 'true',
    combatJoinSelectedCharacters: 'false',
    combatIncludeHiddenInventoryCharacters: 'true'
  };

  let selectedFile = null;

  const els = {
    input: document.getElementById('roomFileInput'),
    dropZone: document.getElementById('dropZone'),
    selectedFile: document.getElementById('selectedFile'),
    convertBtn: document.getElementById('convertBtn'),
    resultCard: document.getElementById('resultCard'),
    resultLog: document.getElementById('resultLog')
  };

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setLog(lines) {
    els.resultCard.hidden = false;
    els.resultLog.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
  }

  function setSelectedFile(file) {
    selectedFile = null;
    els.convertBtn.disabled = true;

    if (!file) return;
    if (!/\.(zip|xml)$/i.test(file.name)) {
      setLog(['エラー: .zip または .xml ファイルを選択してください。']);
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setLog([`エラー: ファイルサイズが大きすぎます。上限は50MBです。`, `選択ファイル: ${formatBytes(file.size)}`]);
      return;
    }

    selectedFile = file;
    els.selectedFile.hidden = false;
    els.selectedFile.textContent = `選択中: ${file.name} (${formatBytes(file.size)})`;
    els.convertBtn.disabled = false;
    els.resultCard.hidden = true;
  }

  function migrateXmlText(xmlText, fileName) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      return { xmlText, changed: false, tableCount: 0, addedCount: 0, error: `${fileName}: XML解析に失敗しました` };
    }

    const tables = Array.from(doc.getElementsByTagName('game-table'));
    let addedCount = 0;

    for (const table of tables) {
      for (const [name, value] of Object.entries(ADVANCED_TABLE_DEFAULTS)) {
        if (!table.hasAttribute(name) || name === 'roomMode') {
          if (!table.hasAttribute(name)) addedCount++;
          table.setAttribute(name, value);
        }
      }
    }

    if (tables.length === 0) {
      return { xmlText, changed: false, tableCount: 0, addedCount: 0 };
    }

    const serializer = new XMLSerializer();
    let out = serializer.serializeToString(doc);
    if (!out.startsWith('<?xml')) {
      out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
    }
    return { xmlText: out, changed: true, tableCount: tables.length, addedCount };
  }

  function outputFileName(name) {
    return name.replace(/\.(zip|xml)$/i, '') + '_lycoris_advanced.zip';
  }

  async function convertXmlFile(file) {
    const xmlText = await file.text();
    const result = migrateXmlText(xmlText, file.name);
    const zip = new JSZip();
    zip.file(file.name.replace(/\.xml$/i, '_advanced.xml'), result.xmlText);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    saveAs(blob, outputFileName(file.name));
    return {
      fileCount: 1,
      xmlCount: 1,
      tableCount: result.tableCount,
      addedCount: result.addedCount,
      errors: result.error ? [result.error] : []
    };
  }

  async function convertZipFile(file) {
    const inputZip = await JSZip.loadAsync(file);
    const outputZip = new JSZip();
    const entries = [];
    inputZip.forEach((path, entry) => entries.push({ path, entry }));

    let xmlCount = 0;
    let tableCount = 0;
    let addedCount = 0;
    const errors = [];

    for (const { path, entry } of entries) {
      if (entry.dir) {
        outputZip.folder(path);
        continue;
      }

      if (/\.xml$/i.test(path)) {
        xmlCount++;
        const text = await entry.async('text');
        const result = migrateXmlText(text, path);
        tableCount += result.tableCount;
        addedCount += result.addedCount;
        if (result.error) errors.push(result.error);
        outputZip.file(path, result.xmlText);
      } else {
        const data = await entry.async('arraybuffer');
        outputZip.file(path, data, { binary: true });
      }
    }

    const blob = await outputZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    saveAs(blob, outputFileName(file.name));
    return { fileCount: entries.length, xmlCount, tableCount, addedCount, errors };
  }

  async function convertSelectedFile() {
    if (!selectedFile) return;
    els.convertBtn.disabled = true;
    els.convertBtn.textContent = '変換中...';
    setLog(['変換を開始しました...', 'ブラウザ内で処理しています。サーバーには送信していません。']);

    try {
      const result = /\.zip$/i.test(selectedFile.name)
        ? await convertZipFile(selectedFile)
        : await convertXmlFile(selectedFile);

      const log = [
        '変換が完了しました。',
        `処理ファイル数: ${result.fileCount}`,
        `XMLファイル数: ${result.xmlCount}`,
        `アドバンス化したテーブル数: ${result.tableCount}`,
        `補完した属性数: ${result.addedCount}`,
      ];
      if (result.tableCount === 0) log.push('注意: game-tableが見つかりませんでした。部屋データではない可能性があります。');
      if (result.errors.length) log.push('', '警告:', ...result.errors);
      setLog(log);
    } catch (error) {
      console.error(error);
      setLog(['変換に失敗しました。', error && error.message ? error.message : String(error)]);
    } finally {
      els.convertBtn.disabled = false;
      els.convertBtn.textContent = '変換してダウンロード';
    }
  }

  els.input.addEventListener('change', e => setSelectedFile(e.target.files && e.target.files[0]));
  els.convertBtn.addEventListener('click', convertSelectedFile);

  ['dragenter', 'dragover'].forEach(type => {
    els.dropZone.addEventListener(type, e => {
      e.preventDefault();
      els.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(type => {
    els.dropZone.addEventListener(type, e => {
      e.preventDefault();
      els.dropZone.classList.remove('dragover');
    });
  });
  els.dropZone.addEventListener('drop', e => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    setSelectedFile(file);
  });
})();
