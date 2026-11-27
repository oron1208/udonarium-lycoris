// スパイク用の最小GLB（赤い柱1メッシュ、y-up・底面原点）を生成し、base64のTS定数も出す。
const fs = require('fs');
const path = require('path');
const W = 24, H = 60, D = 24, hw = W / 2, hd = D / 2;
const faces = [
  { n: [1, 0, 0], v: [[hw, 0, hd], [hw, 0, -hd], [hw, H, -hd], [hw, H, hd]] },
  { n: [-1, 0, 0], v: [[-hw, 0, -hd], [-hw, 0, hd], [-hw, H, hd], [-hw, H, -hd]] },
  { n: [0, 1, 0], v: [[-hw, H, hd], [hw, H, hd], [hw, H, -hd], [-hw, H, -hd]] },
  { n: [0, -1, 0], v: [[hw, 0, hd], [-hw, 0, hd], [-hw, 0, -hd], [hw, 0, -hd]] },
  { n: [0, 0, 1], v: [[-hw, 0, hd], [hw, 0, hd], [hw, H, hd], [-hw, H, hd]] },
  { n: [0, 0, -1], v: [[hw, 0, -hd], [-hw, 0, -hd], [-hw, H, -hd], [hw, H, -hd]] },
];
const positions = [], normals = [], indices = [];
faces.forEach((face, fi) => {
  face.v.forEach(p => { positions.push(...p); normals.push(...face.n); });
  const b = fi * 4;
  indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
});
const posBuf = Buffer.alloc(positions.length * 4);
positions.forEach((v, i) => posBuf.writeFloatLE(v, i * 4));
const normBuf = Buffer.alloc(normals.length * 4);
normals.forEach((v, i) => normBuf.writeFloatLE(v, i * 4));
const idxBuf = Buffer.alloc(indices.length * 2);
indices.forEach((v, i) => idxBuf.writeUInt16LE(v, i * 2));
const bin = Buffer.concat([posBuf, normBuf, idxBuf]);
const gltf = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'SpikePillar' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{ name: 'SpikeRed', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.12, 0.12, 1], metallicFactor: 0, roughnessFactor: 0.85 } }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: normBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length + normBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-hw, 0, -hd], max: [hw, H, hd] },
    { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
  ],
};
let json = Buffer.from(JSON.stringify(gltf));
while (json.length % 4) json = Buffer.concat([json, Buffer.from([0x20])]);
let binPad = bin;
while (binPad.length % 4) binPad = Buffer.concat([binPad, Buffer.from([0])]);
const total = 12 + 8 + json.length + 8 + binPad.length;
const glb = Buffer.alloc(total);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(total, 8);
glb.writeUInt32LE(json.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
json.copy(glb, 20);
const bh = 20 + json.length;
glb.writeUInt32LE(binPad.length, bh);
glb.writeUInt32LE(0x004e4942, bh + 4);
binPad.copy(glb, bh + 8);
const outDir = path.join(__dirname, '..', 'tmp', 'spike-3d');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'spike-token.glb'), glb);
const tsPath = path.join(__dirname, '..', 'src', 'app', 'component', 'game-table', 'spike-glb.ts');
fs.writeFileSync(tsPath, '// 生成ファイル: node tools/make-spike-glb.cjs で再生成する\nexport const SPIKE_GLB_BASE64 =\n  ' + JSON.stringify(glb.toString('base64')) + ';\n');
console.log('GLB bytes', glb.length, 'TS bytes', fs.statSync(tsPath).size);
