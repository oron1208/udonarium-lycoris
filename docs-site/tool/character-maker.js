// ===== テンプレート定義 =====
const TEMPLATES = {
  custom: {
    resources: [],
    params: [],
    palette: '',
    dicebot: 'DiceBot'
  },
  cthulhu: {
    resources: [
      { name: 'HP', max: 10, current: 10 },
      { name: 'MP', max: 10, current: 10 },
      { name: 'SAN', max: 70, current: 70 }
    ],
    params: [
      { name: 'STR', value: '' },
      { name: 'CON', value: '' },
      { name: 'POW', value: '' },
      { name: 'DEX', value: '' },
      { name: 'APP', value: '' },
      { name: 'SIZ', value: '' },
      { name: 'INT', value: '' },
      { name: 'EDU', value: '' },
      { name: '回避', value: '' },
      { name: '目星', value: '' },
      { name: '聞き耳', value: '' },
      { name: '図書館', value: '' }
    ],
    palette: `CCB<={回避} 回避
CCB<={目星} 目星
CCB<={聞き耳} 聞き耳
CCB<={図書館} 図書館
1d3 耐久力ダメージ（小）
1d6 耐久力ダメージ（中）
2d6 耐久力ダメージ（大）
SAN 1d100 {SAN} SANチェック`,
    dicebot: 'Cthulhu'
  },
  dnd5e: {
    resources: [
      { name: 'HP', max: 20, current: 20 },
      { name: 'AC', max: 15, current: 15 }
    ],
    params: [
      { name: 'STR', value: '' },
      { name: 'DEX', value: '' },
      { name: 'CON', value: '' },
      { name: 'INT', value: '' },
      { name: 'WIS', value: '' },
      { name: 'CHA', value: '' },
      { name: 'AT', value: '' },
      { name: '命中強化', value: '' }
    ],
    palette: `AT+(+{AT}+{命中強化}) 攻撃ロール
1d20+{DEX} DEXセーヴ
1d20+{STR} STRセーヴ
1d20+{CON} CONセーヴ
1d8+{STR} ダメージ（d8武器）`,
    dicebot: 'DnD'
  },
  shinobi: {
    resources: [
      { name: 'HP', max: 30, current: 30 },
      { name: '変調', max: 0, current: 0 }
    ],
    params: [
      { name: '器術', value: '' },
      { name: '体術', value: '' },
      { name: '忍術', value: '' },
      { name: '謀術', value: '' },
      { name: '戦術', value: '' },
      { name: '妖術', value: '' }
    ],
    palette: `SG+(+{器術}) 器術判定
SG+(+{体術}) 体術判定
SG+(+{忍術}) 忍術判定
SG+(+{謀術}) 謀術判定
SG+(+{戦術}) 戦術判定`,
    dicebot: 'Shinobigami'
  }
};

let currentTemplate = 'custom';
let imageData = null; // base64
let imageFileName = '';

// ===== テンプレート選択 =====
function selectTemplate(templateId) {
  currentTemplate = templateId;
  const template = TEMPLATES[templateId];

  // ボタン更新
  document.querySelectorAll('.template-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.template === templateId);
  });

  // リソース生成
  const resourceList = document.getElementById('resourceList');
  const resourceEmpty = document.getElementById('resourceEmpty');
  resourceList.innerHTML = '';
  if (template.resources.length > 0) {
    resourceEmpty.style.display = 'none';
    template.resources.forEach(r => addResourceRow(r.name, r.max, r.current));
  } else {
    resourceEmpty.style.display = 'block';
  }

  // 能力値生成
  const paramList = document.getElementById('paramList');
  const paramEmpty = document.getElementById('paramEmpty');
  paramList.innerHTML = '';
  if (template.params.length > 0) {
    paramEmpty.style.display = 'none';
    template.params.forEach(p => addParamRow(p.name, p.value));
  } else {
    paramEmpty.style.display = 'block';
  }

  // チャットパレット
  document.getElementById('paletteText').value = template.palette;
  document.getElementById('paletteDicebot').value = template.dicebot;

  updatePreview();
}

// ===== リソース行 =====
function addResource() {
  document.getElementById('resourceEmpty').style.display = 'none';
  addResourceRow('', '', '');
}

function addResourceRow(name, max, current) {
  const list = document.getElementById('resourceList');
  const row = document.createElement('div');
  row.className = 'resource-row';
  row.innerHTML = `
    <input type="text" placeholder="名前（HP等）" value="${escapeHtml(name || '')}" oninput="updatePreview()">
    <input type="number" placeholder="最大値" value="${max !== '' && max !== undefined ? max : ''}" oninput="updatePreview()">
    <input type="number" placeholder="現在値" value="${current !== '' && current !== undefined ? current : ''}" oninput="updatePreview()">
    <button class="btn-remove" onclick="removeRow(this, 'resourceEmpty')" title="削除">✕</button>
  `;
  list.appendChild(row);
  updatePreview();
}

// ===== 能力値行 =====
function addParam() {
  document.getElementById('paramEmpty').style.display = 'none';
  addParamRow('', '');
}

function addParamRow(name, value) {
  const list = document.getElementById('paramList');
  const row = document.createElement('div');
  row.className = 'param-row';
  row.innerHTML = `
    <input type="text" placeholder="名前（STR等）" value="${escapeHtml(name || '')}" oninput="updatePreview()">
    <input type="text" placeholder="値" value="${escapeHtml(value || '')}" oninput="updatePreview()">
    <button class="btn-remove" onclick="removeRow(this, 'paramEmpty')" title="削除">✕</button>
  `;
  list.appendChild(row);
  updatePreview();
}

function removeRow(btn, emptyId) {
  const row = btn.parentElement;
  const list = row.parentElement;
  row.remove();
  if (list.children.length === 0) {
    document.getElementById(emptyId).style.display = 'block';
  }
  updatePreview();
}

// ===== 画像ドロップ =====
function setupImageDrop() {
  const zone = document.getElementById('imageDropZone');
  const input = document.getElementById('imageInput');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleImageFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', e => {
    if (e.target.files.length > 0) handleImageFile(e.target.files[0]);
  });
}

function handleImageFile(file) {
  if (!file.type.startsWith('image/')) return;
  imageFileName = file.name;
  const reader = new FileReader();
  reader.onload = e => {
    imageData = e.target.result;
    document.getElementById('imageDropZone').style.display = 'none';
    document.getElementById('imagePreview').style.display = 'flex';
    document.getElementById('previewImg').src = imageData;
    updatePreview();
  };
  reader.readAsDataURL(file);
}

function removeImage() {
  imageData = null;
  imageFileName = '';
  document.getElementById('imageDropZone').style.display = 'block';
  document.getElementById('imagePreview').style.display = 'none';
  document.getElementById('imageInput').value = '';
  updatePreview();
}

// ===== XMLドロップ（インポート）=====
function setupXMLDrop() {
  const zone = document.getElementById('xmlDropZone');
  const input = document.getElementById('xmlInput');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleXMLFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', e => {
    if (e.target.files.length > 0) handleXMLFile(e.target.files[0]);
  });
}

function handleXMLFile(file) {
  const reader = new FileReader();
  // ZIPかXMLか判定
  if (file.name.endsWith('.zip')) {
    reader.onload = async e => {
      try {
        const zip = await JSZip.loadAsync(e.target.result);
        // XMLファイルを探す
        let xmlFile = null;
        let imageFiles = [];
        zip.forEach((path, entry) => {
          if (path.endsWith('.xml')) xmlFile = entry;
          else if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(path)) imageFiles.push(entry);
        });
        if (xmlFile) {
          const xmlText = await xmlFile.async('text');
          parseXML(xmlText);
        }
        // 最初の画像をコマ画像に設定
        if (imageFiles.length > 0) {
          const imgEntry = imageFiles[0];
          const imgBlob = await imgEntry.async('blob');
          imageFileName = imgEntry.name;
          const reader2 = new FileReader();
          reader2.onload = ev => {
            imageData = ev.target.result;
            document.getElementById('imageDropZone').style.display = 'none';
            document.getElementById('imagePreview').style.display = 'flex';
            document.getElementById('previewImg').src = imageData;
            updatePreview();
          };
          reader2.readAsDataURL(new File([imgBlob], imgEntry.name, { type: imgBlob.type }));
        }
      } catch (err) {
        console.error('ZIP展開エラー:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    reader.onload = e => {
      parseXML(e.target.result);
    };
    reader.readAsText(file);
  }
}

function parseXML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');

  // 名前
  const nameEl = doc.querySelector('data[name="name"]');
  if (nameEl) document.getElementById('charName').value = nameEl.textContent || '';

  // サイズ
  const sizeEl = doc.querySelector('data[name="size"]');
  if (sizeEl) document.getElementById('charSize').value = sizeEl.textContent || '1';

  // リソース
  const resourceList = document.getElementById('resourceList');
  resourceList.innerHTML = '';
  const resourceContainer = doc.querySelector('data[name="リソース"]');
  if (resourceContainer) {
    document.getElementById('resourceEmpty').style.display = 'none';
    resourceContainer.querySelectorAll(':scope > data').forEach(d => {
      const name = d.getAttribute('name');
      const max = d.textContent || '';
      const current = d.getAttribute('currentValue') || max;
      addResourceRow(name, max, current);
    });
  }

  // 能力値
  const paramList = document.getElementById('paramList');
  paramList.innerHTML = '';
  const abilityContainer = doc.querySelector('data[name="能力値"]');
  if (abilityContainer) {
    document.getElementById('paramEmpty').style.display = 'none';
    abilityContainer.querySelectorAll(':scope > data').forEach(d => {
      addParamRow(d.getAttribute('name'), d.textContent || '');
    });
  }

  // 技能
  const skillContainer = doc.querySelector('data[name="技能"]');
  if (skillContainer) {
    document.getElementById('paramEmpty').style.display = 'none';
    skillContainer.querySelectorAll(':scope > data').forEach(d => {
      addParamRow(d.getAttribute('name'), d.textContent || '');
    });
  }

  // チャットパレット
  const paletteEl = doc.querySelector('chat-palette');
  if (paletteEl) {
    const dicebot = paletteEl.getAttribute('dicebot') || 'DiceBot';
    document.getElementById('paletteDicebot').value = dicebot;
    // パレット内容（cdata）
    const paletteLines = [];
    paletteEl.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.CDATA_SECTION_NODE) {
        paletteLines.push(n.textContent);
      }
    });
    document.getElementById('paletteText').value = paletteLines.join('').trim();
  }

  // テンプレートをカスタムに
  selectTemplate('custom');

  updatePreview();
}

// ===== XML生成 =====
function generateXML() {
  const name = document.getElementById('charName').value.trim() || 'キャラクター';
  const size = document.getElementById('charSize').value || '1';
  const initiative = document.getElementById('initiative').value.trim();
  const palette = document.getElementById('paletteText').value.trim();
  const dicebot = document.getElementById('paletteDicebot').value;

  const id = 'char_' + Date.now();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<character location.name="table" location.x="0" location.y="0" posZ="0" rotate="0" roll="0" />\n`;
  xml += `  <data name="character">\n`;
  xml += `    <data name="common">\n`;
  xml += `      <data name="name">${escapeXml(name)}</data>\n`;
  xml += `      <data name="size">${escapeXml(size)}</data>\n`;
  xml += `      <data name="altitude">0</data>\n`;
  xml += `      <data name="imageIdentifier">${imageData ? escapeXml(imageFileName || 'image.png') : ''}</data>\n`;
  xml += `    </data>\n`;

  // リソース
  const resources = getResourceData();
  if (resources.length > 0) {
    xml += `    <data name="detail">\n`;
    xml += `      <data name="リソース">\n`;
    resources.forEach(r => {
      xml += `        <data name="${escapeXml(r.name)}" type="numberResource" currentValue="${escapeXml(r.current)}">${escapeXml(r.max)}</data>\n`;
    });
    xml += `      </data>\n`;
  }

  // 能力値
  const params = getParamData();
  const needDetailClose = resources.length > 0;
  if (params.length > 0) {
    if (resources.length === 0) xml += `    <data name="detail">\n`;
    xml += `      <data name="能力値">\n`;
    params.forEach(p => {
      xml += `        <data name="${escapeXml(p.name)}">${escapeXml(p.value)}</data>\n`;
    });
    xml += `      </data>\n`;
  }

  // イニシアチブ
  if (initiative) {
    if (resources.length === 0 && params.length === 0) xml += `    <data name="detail">\n`;
    xml += `      <data name="情報">\n`;
    xml += `        <data name="イニシアチブ">${escapeXml(initiative)}</data>\n`;
    xml += `      </data>\n`;
  }

  if (resources.length > 0 || params.length > 0 || initiative) {
    xml += `    </data>\n`;
  }

  xml += `  </data>\n`;

  // チャットパレット
  if (palette) {
    xml += `  <chat-palette dicebot="${escapeXml(dicebot)}">${escapeXml(palette)}</chat-palette>\n`;
  }

  xml += `</character>`;
  return xml;
}

function getResourceData() {
  const rows = document.querySelectorAll('#resourceList .resource-row');
  const data = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name = inputs[0].value.trim();
    const max = inputs[1].value.trim();
    const current = inputs[2].value.trim() || max;
    if (name) data.push({ name, max, current });
  });
  return data;
}

function getParamData() {
  const rows = document.querySelectorAll('#paramList .param-row');
  const data = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name = inputs[0].value.trim();
    const value = inputs[1].value.trim();
    if (name) data.push({ name, value });
  });
  return data;
}

// ===== プレビュー更新 =====
function updatePreview() {
  const output = document.getElementById('xmlOutput');
  const name = document.getElementById('charName').value.trim();
  if (!name) {
    output.textContent = '← キャラクター名を入力してください';
    return;
  }
  output.textContent = generateXML();
}

// ===== エクスポート =====
function downloadXML() {
  const name = document.getElementById('charName').value.trim() || 'キャラクター';
  const xml = generateXML();
  
  if (imageData) {
    // 画像がある場合はZIPで出力
    const zip = new JSZip();
    zip.file(name + '.xml', xml);
    // base64からバイナリに変換
    const base64Data = imageData.split(',')[1];
    zip.file(imageFileName || 'image.png', base64Data, { base64: true });
    zip.generateAsync({ type: 'blob' }).then(blob => {
      saveAs(blob, name + '.zip');
    });
  } else {
    // 画像なしはXML単体
    const blob = new Blob([xml], { type: 'application/xml' });
    saveAs(blob, name + '.xml');
  }
}

function copyXML() {
  const xml = generateXML();
  navigator.clipboard.writeText(xml).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = '✅ コピーしました！';
    setTimeout(() => btn.textContent = orig, 2000);
  }).catch(() => {
    // フォールバック
    const textarea = document.createElement('textarea');
    textarea.value = xml;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}

// ===== ユーティリティ =====
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
  selectTemplate('custom');
  setupImageDrop();
  setupXMLDrop();
});
