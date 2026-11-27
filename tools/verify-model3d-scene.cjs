// Actual Three.js scene ownership checks, not mocks of the renderer implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
(async () => {
  const out = path.join(root, 'tmp/spike-3d', 'scene-unit-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, 'model3d-scene.mjs');
  const source = fs.readFileSync(path.join(root, 'src/app/component/game-table/model3d-scene.ts'), 'utf8');
  fs.writeFileSync(target, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  const T = await import('three');
  const { cloneModelScene, disposeModelInstance, disposeModelResources, modelScaleFactor, modelAngle } = await import(pathToFileURL(target));
  const geometry = new T.BoxGeometry();
  const count = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weights, 4));
  const texture = new T.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const material = new T.MeshBasicMaterial({ map: texture });
  const sourceScene = new T.Group(), bone = new T.Bone(), mesh = new T.SkinnedMesh(geometry, material);
  bone.name = 'hip'; sourceScene.add(bone, mesh); mesh.bind(new T.Skeleton([bone]));
  // Reproduce the old failure first: Object3D.clone leaves the original skeleton in every copy.
  const old = sourceScene.clone();
  assert.equal(old.children[1].skeleton, mesh.skeleton);
  const a = cloneModelScene(sourceScene), b = cloneModelScene(sourceScene);
  const am = a.children[1], bm = b.children[1];
  assert.notEqual(am.skeleton, mesh.skeleton); assert.notEqual(am.skeleton, bm.skeleton);
  assert.equal(am.skeleton.bones[0], a.children[0]); assert.equal(bm.skeleton.bones[0], b.children[0]);
  am.skeleton.bones[0].position.x = 5;
  assert.equal(bm.skeleton.bones[0].position.x, 0); assert.equal(bone.position.x, 0);
  assert.equal(am.geometry, bm.geometry); assert.equal(am.material, bm.material);
  console.log('PASS independent bones and shared immutable mesh resources');
  const disposed = { geometry: 0, material: 0, texture: 0, skeletonA: 0, skeletonB: 0 };
  geometry.addEventListener('dispose', () => disposed.geometry++);
  material.addEventListener('dispose', () => disposed.material++);
  texture.addEventListener('dispose', () => disposed.texture++);
  for (const [skel, key] of [[am.skeleton, 'skeletonA'], [bm.skeleton, 'skeletonB']]) {
    skel.computeBoneTexture(); skel.boneTexture.addEventListener('dispose', () => disposed[key]++);
  }
  disposeModelInstance(a);
  assert.deepEqual(disposed, { geometry: 0, material: 0, texture: 0, skeletonA: 1, skeletonB: 0 });
  assert(bm.skeleton.boneTexture);
  console.log('PASS removing one token preserves the other token and cache');
  disposeModelInstance(b);
  sourceScene.add(new T.Mesh(geometry, [material, material]));
  disposeModelResources([sourceScene, sourceScene]);
  assert.deepEqual(disposed, { geometry: 1, material: 1, texture: 1, skeletonA: 1, skeletonB: 1 });
  console.log('PASS shared cached resources released exactly once');
  for (const value of [NaN, Infinity, -Infinity, '', null, undefined, -20, 0, 'oops']) {
    assert.equal(modelScaleFactor(value), 1);
    assert(Number.isFinite(modelAngle(value)));
  }
  assert.equal(modelScaleFactor(1000), 3); assert.equal(modelScaleFactor(5), 0.2);
  assert.equal(modelAngle(-450), -450); assert.equal(modelAngle(360), 360); assert.equal(modelScaleFactor('160'), 1.6);
  console.log('PASS malformed synchronized values cannot poison scene transforms');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: 4, disposed }, null, 2));
  console.log('EVIDENCE', out);
})().catch(error => { console.error(error); process.exitCode = 1; });
