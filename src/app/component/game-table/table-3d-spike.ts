// 3Dコマ（GLB）表示のスパイク実証レイヤ。
// 卓のCSS 3D transform（perspective + translate/rotate）と同じ射影をWebGLカメラで再現し、
// GLBモデルを卓面に立たせる。カメラ同期の正しさは window.__spike3d.compare() で
// 「同じ3D座標に置いたDOMマーカーの実描画位置」と「three.jsの射影位置」を突き合わせて証明する。
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GameCharacter } from '@udonarium/game-character';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { EventSystem } from '@udonarium/core/system';
import { ModelStorage, ModelKind } from '@udonarium/core/file-storage/model-storage';
import { cloneModelScene, disposeModelInstance, disposeModelResources, modelFootprint, modelScaleFactor, modelAngle } from './model3d-scene';

interface BoundModel {
  scene: THREE.Object3D; object: THREE.Object3D; wrapper: THREE.Object3D;
  element?: HTMLElement; height: number; footprint: number; modelId?: string;
}

interface RegistryModel {
  name: string; size: number; kind: ModelKind; identifier: string;
  buffer?: ArrayBuffer | string; thumb?: string; scene?: THREE.Object3D;
  parsing?: Promise<THREE.Object3D>;
}

export interface SpikeViewState {
  posX: number; posY: number; posZ: number;
  rotX: number; rotY: number; rotZ: number; // deg
  flat: boolean;
}

export class Table3dSpike {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera();
  private tableRoot = new THREE.Group();
  private container: HTMLElement;
  private tableEl: HTMLElement;
  private state: () => SpikeViewState;
  private gltfLoader: GLTFLoader = null;
  private dracoLoader: DRACOLoader;
  private ktx2Loader: KTX2Loader;
  private marker: HTMLDivElement;
  private rafId = 0;
  private dead = false;
  private frameCount = 0;
  private perspectivePx = 1000;
  private perspectiveKnown = false;
  private cw = 0; private ch = 0;
  private lastCw = 0; private lastCh = 0;
  private lastTw = 0; private lastTh = 0;
  private tl = new THREE.Vector3();
  private calibrated = false;
  private needRecal = true;
  ready = false;
  models: THREE.Object3D[] = [];
  private tmpM = new THREE.Matrix4();
  // GLBのY-up/+Z正面 → 卓のZ-up/+Y正面（通常の視点で手前）。旧変換は正面を奥(-Y)へ向けていた。
  private toTableQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  private dropHandler: (event: DragEvent) => void = null;
  private dragOverHandler: (event: DragEvent) => void = null;
  private pointerDownHandler: (event: PointerEvent) => void = null;
  private modelRegistry = new Map<string, RegistryModel>();
  private thumbRenderer: THREE.WebGLRenderer = null;
  private pendingModelId: string = null;
  private bindingLoads = new Map<string, string>();
  private assignmentVersions = new Map<string, number>();
  private retryBindingsAt = new Map<string, number>();
  private boundModels = new Map<string, BoundModel>();

  constructor(container: HTMLElement, tableEl: HTMLElement, state: () => SpikeViewState) {
    this.container = container;
    this.tableEl = tableEl;
    this.state = state;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;pointer-events:none;z-index:5;';
    document.body.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.tableRoot.matrixAutoUpdate = false;
    this.scene.add(this.tableRoot);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-300, -420, 900);
    this.scene.add(sun);

    // 圧縮GLB対応: Draco/KTX2/meshoptデコーダーを設定したローダーを使う
    const dracoLoader = this.dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('/assets/draco/');
    const ktx2Loader = this.ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath('/assets/basis/');
    ktx2Loader.detectSupport(this.renderer);
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(dracoLoader);
    this.gltfLoader.setKTX2Loader(ktx2Loader);
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

    this.marker = document.createElement('div');
    this.marker.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;pointer-events:none;';this.marker.style.transform = 'translate3d(0px, 0px, 0px)';
    tableEl.appendChild(this.marker);
    // 試験用: GLB/GLTF/VRMファイルをページにドロップすると卓上に配置される（本実装では専用UIに置き換え）
    this.dragOverHandler = (event: DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    };
    this.dropHandler = (event: DragEvent) => {
      const files = event.dataTransfer ? event.dataTransfer.files : null;
      if (!files || files.length < 1) {
        // Discord等のアプリから直接ドラッグすると File 一覧が空で届くことがある
        if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault();
          this.showNotice('ファイルを取得できませんでした。一度PCに保存してからドロップするか、左下の「＋3Dモデル」ボタンから選んでください');
          console.warn('[table3d-spike] drop: File一覧が空（アプリからの直接ドラッグは不可の可能性）');
        }
        return;
      }
      const modelFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const name = files[i].name.toLowerCase();
        if (name.endsWith('.glb') || name.endsWith('.gltf') || name.endsWith('.vrm') || name.endsWith('.fbx')) modelFiles.push(files[i]);
      }
      if (modelFiles.length < 1) {
        this.showNotice('対応形式は .glb .gltf .vrm .fbx です: ' + Array.from(files).map(f => f.name).slice(0, 3).join(', '));
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const local = this.screenToTableLocal(event.clientX, event.clientY);
      const tw = this.tableEl.offsetWidth, th = this.tableEl.offsetHeight;
      const baseX = local ? THREE.MathUtils.clamp(local.x, 0, tw) : tw / 2;
      const baseY = local ? THREE.MathUtils.clamp(local.y, 0, th) : th / 2;
      const hitChar = this.hitTestCharacter(baseX, baseY);
      let bindElement: HTMLElement = null;
      if (hitChar) {
        for (const el of document.elementsFromPoint(event.clientX, event.clientY) as HTMLElement[]) {
          const host = el.closest ? (el.closest('game-character') as HTMLElement) : null;
          if (host) { bindElement = host; break; }
        }
      }
      modelFiles.forEach((file, i) => this.loadModelFile(file, baseX + i * 40, baseY + i * 40, i === 0 ? hitChar : null, i === 0 ? bindElement : null));
    };
    window.addEventListener('dragover', this.dragOverHandler, true);
    window.addEventListener('drop', this.dropHandler, true);
    // 3D表示中は立ち絵本体・影・発光レイヤ・俯瞰アイコンを隠す。
    // 名前やバフ、操作ハンドルは残し、平面モード・3D無効・割当解除では元の画像表示へ戻す。
    if (!document.getElementById('spike3d-hide-icon')) {
      const st = document.createElement('style');
      st.id = 'spike3d-hide-icon';
      st.textContent = `
        body:not(.spike3d-flat) game-character.spike3d-bound:not(.spike3d-off)
          img:is(.image, .flat-character-image, .topdown-icon-image) {
          visibility: hidden;
        }
        /* rollも3DモデルではYaw。名前・バフの直立フレームを横倒しにしない。 */
        body:not(.spike3d-flat) game-character.spike3d-bound:not(.spike3d-off) .rotate-frame {
          transform: none !important;
        }
      `;
      document.head.appendChild(st);
    }
    // 3Dモデル管理はファイル一覧パネルの「3D」タブから（window.__spike3d APIを経由）
    // 選択中の3Dモデルがある状態でコマをクリックしたら、そのコマへ割り当てる
    this.pointerDownHandler = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const host = target ? (target.closest('game-character') as HTMLElement) : null;
      if (!host || !this.pendingModelId) return;
      const local = this.screenToTableLocal(event.clientX, event.clientY);
      if (!local) return;
      const c = this.hitTestCharacter(
        THREE.MathUtils.clamp(local.x, 0, this.tableEl.offsetWidth),
        THREE.MathUtils.clamp(local.y, 0, this.tableEl.offsetHeight));
      if (!c) return;
      const pid = this.pendingModelId;
      this.pendingModelId = null;
      const m = this.modelRegistry.get(pid);
      if (!m) { this.showNotice('3Dモデルが見つかりません'); return; }
      void this.assignRegistryModel(pid, c, host);
    };
    window.addEventListener('pointerdown', this.pointerDownHandler, true);
    this.ready = true;
    (window as any).__spike3d = this.debugApi();
    EventSystem.register(this).on('MODEL3D_CHANGED', () => this.syncRegistry());
    void ModelStorage.instance.ready.then(() => { if (!this.dead) this.syncRegistry(); });
  }

  start() { if (!this.rafId) this.frameCb(); }

  private frameCb = () => {
    if (this.dead) return;
    this.rafId = requestAnimationFrame(this.frameCb);
    this.frameCount++;
    if (this.frameCount % 60 === 0) this.reconcileBindings();
    const s = this.state();
    if (s.flat) { this.canvas.style.display = 'none'; document.body.classList.add('spike3d-flat'); return; }
    document.body.classList.remove('spike3d-flat');
    if (this.frameCount === 1 || this.frameCount % 60 === 0) this.syncPerspective();
    if (!this.perspectiveKnown) return;
    if (!this.syncCanvasRect()) return;
    this.canvas.style.display = 'block';
    const tw = this.tableEl.offsetWidth, th = this.tableEl.offsetHeight;
    if (tw !== this.lastTw || th !== this.lastTh) {
      this.lastTw = tw; this.lastTh = th;
      this.needRecal = true;
    }
    if (this.needRecal || !this.calibrated) this.calibrate();
    this.updateCamera();
    this.updateTableRoot();
    this.updateBoundModels();
    this.renderer.render(this.scene, this.camera);
  };

  /** canvasをperspectiveコンテナのrectへ固定配置する（コンテナはstaticなのでfixedで追従） */
  private syncCanvasRect(): boolean {
    const r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    this.cw = r.width; this.ch = r.height;
    const st = this.canvas.style;
    st.left = r.left + 'px'; st.top = r.top + 'px'; st.width = r.width + 'px'; st.height = r.height + 'px';
    if (this.lastCw !== this.cw || this.lastCh !== this.ch) {
      this.lastCw = this.cw; this.lastCh = this.ch;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(this.cw, this.ch, false);
    }
    return true;
  }

  private syncPerspective() {
    const p = getComputedStyle(this.container).perspective;
    const v = parseFloat(p);
    if (p === 'none' || !isFinite(v) || v <= 0) { this.perspectiveKnown = false; return; }
    this.perspectivePx = v;
    this.perspectiveKnown = true;
  }

  /** CSS perspective(d)・原点コンテナ中央と等価なカメラ行列（単位はすべてpx） */
  private updateCamera() {
    const w = this.cw, h = this.ch, d = this.perspectivePx;
    const n = 10, f = 50000;
    this.camera.projectionMatrix.set(
      2 * d / w, 0, 0, 0,
      0, 2 * d / h, 0, 0,
      0, 0, -(f + n) / (f - n), -2 * f * n / (f - n),
      0, 0, -1, 0
    );
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorldInverse.set(
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, 1, -d,
      0, 0, 0, 1
    );
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
  }

  private buildTableParts(): { o: THREE.Vector3; mCss: THREE.Matrix4 } {
    const parts = getComputedStyle(this.tableEl).transformOrigin.split(' ');
    const o = new THREE.Vector3(parseFloat(parts[0]) || 0, parseFloat(parts[1]) || 0, 0);
    const s = this.state();
    const deg = Math.PI / 180;
    // CSSのtransform文字列と同じ順: translate(可換) → rotateY → rotateX → rotateZ
    const mCss = new THREE.Matrix4().makeTranslation(s.posX, s.posY, s.posZ)
      .multiply(new THREE.Matrix4().makeRotationY(s.rotY * deg))
      .multiply(new THREE.Matrix4().makeRotationX(s.rotX * deg))
      .multiply(new THREE.Matrix4().makeRotationZ(s.rotZ * deg));
    return { o, mCss };
  }

  private updateTableRoot() {
    const { o, mCss } = this.buildTableParts();
    this.tableRoot.matrix
      .makeTranslation(this.tl.x + o.x, this.tl.y + o.y, this.tl.z + o.z)
      .multiply(mCss)
      .multiply(this.tmpM.makeTranslation(-o.x, -o.y, -o.z));this.tableRoot.matrixWorldNeedsUpdate = true;
  }

  private setMarker(x: number, y: number, z: number) {
    this.marker.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, ' + z + 'px)';
  }

  private measureMarker(): { x: number; y: number } {
    const r = this.marker.getBoundingClientRect();
    const c = this.container.getBoundingClientRect();
    return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
  }

  private projectCss(v: THREE.Vector3): { x: number; y: number } {
    const d = this.perspectivePx;
    const k = d / (d - v.z);
    return { x: this.cw / 2 + v.x * k, y: this.ch / 2 + v.y * k };
  }

  projectLocal(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.tableRoot.matrix).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.cw, y: (0.5 - v.y * 0.5) * this.ch };
  }

  /** 卓要素のレイアウト位置ずれ(tl)をマーカー実測で求める。回転・射影は独立に検証される。 */
  calibrate(): { residualX: number; residualY: number } {
    this.syncPerspective();
    this.syncCanvasRect();
    const { o, mCss } = this.buildTableParts();
    const v0 = new THREE.Vector3(-o.x, -o.y, -o.z).applyMatrix4(mCss).add(o);
    this.setMarker(0, 0, 0);
    const target = this.measureMarker();
    const tl = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      const p = this.projectCss(tl.clone().add(v0));
      const ex = target.x - p.x, ey = target.y - p.y;
      if (Math.abs(ex) < 0.05 && Math.abs(ey) < 0.05) break;
      const f = (this.perspectivePx - (tl.z + v0.z)) / this.perspectivePx;
      tl.x += ex * f;
      tl.y += ey * f;
    }
    this.tl.copy(tl);
    this.calibrated = true;
    this.needRecal = false;
    const p = this.projectCss(tl.clone().add(v0));
    return { residualX: p.x - target.x, residualY: p.y - target.y };
  }

  /** 同一3D座標について、ブラウザ実描画（マーカー）とthree.js射影の差をpxで返す */
  compare(x: number, y: number, z: number) {
    this.syncPerspective();
    this.syncCanvasRect();
    if (this.needRecal || !this.calibrated) this.calibrate();
    this.updateCamera();
    this.updateTableRoot();
    this.setMarker(x, y, z);
    const browser = this.measureMarker();
    const three = this.projectLocal(x, y, z);
    return { browser, three, dx: three.x - browser.x, dy: three.y - browser.y };
  }

  /** 画面座標を卓テーブル平面のローカル座標へ逆射影する（ドロップ配置用） */
  private screenToTableLocal(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.perspectiveKnown || !this.calibrated) return null;
    const rect = this.container.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const point = new THREE.Vector3((sx / this.cw) * 2 - 1, 1 - (sy / this.ch) * 2, 0.5);
    const world = point.unproject(this.camera);
    const camPos = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
    const ray = new THREE.Ray(camPos, world.sub(camPos).normalize());
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(new THREE.Matrix4().extractRotation(this.tableRoot.matrix));
    const planePoint = new THREE.Vector3(0, 0, 0).applyMatrix4(this.tableRoot.matrix);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    return hit.applyMatrix4(new THREE.Matrix4().copy(this.tableRoot.matrix).invert());
  }

  /** モデルを最大辺100pxに正規化し、底面中心を原点に揃える */
  private prepareModel(root: THREE.Object3D, targetSize: number = 100): THREE.Object3D {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = targetSize / maxDim;
    const inner = new THREE.Object3D();
    inner.scale.setScalar(scale);
    inner.position.set(-(box.min.x + size.x / 2) * scale, -box.min.y * scale, -(box.min.z + size.z / 2) * scale);
    inner.add(root);
    const wrapper = new THREE.Object3D();
    wrapper.quaternion.copy(this.toTableQuat);
    wrapper.add(inner);
    return wrapper;
  }

  private async loadModelFile(file: File, x: number, y: number, bindTo: GameCharacter = null, bindElement: HTMLElement = null) {
    this.showNotice('読み込み中: ' + file.name);
    try {
      const resource = await ModelStorage.instance.add(file.name, file);
      this.syncRegistry();
      if (bindTo) await this.assignRegistryModel(resource.identifier, bindTo, bindElement);
      else {
        const scene = await this.parseRegistryEntry(this.modelRegistry.get(resource.identifier));
        if (!this.dead) this.placePrepared(file.name, cloneModelScene(scene), x, y, resource.identifier);
      }
    } catch (error) { console.error('[table3d-spike] ファイル読み込み失敗:', error); this.showNotice('3Dモデル読み込み失敗: ' + file.name); }
  }

  /** Assignable resources are persisted separately; this places an unbound preview on the table. */
  private placePrepared(name: string, scene: THREE.Object3D, x: number, y: number, modelId: string) {
    const wrapper = this.prepareModel(scene);
    wrapper.userData.model3dIdentifier = modelId;
    wrapper.position.set(x, y, 0);
    this.tableRoot.add(wrapper);
    this.models.push(wrapper);
    console.log('[table3d-spike] 3Dモデルを配置しました:', name);
    this.showNotice('3Dモデルを配置しました: ' + name);
  }

  /** registryエントリをparseして THREE.Object3D を得る（2回目以降はキャッシュ） */
  private parseRegistryEntry(m: RegistryModel): Promise<THREE.Object3D> {
    if (m.scene) return Promise.resolve(m.scene);
    if (m.parsing) return m.parsing;
    m.parsing = (async () => {
      if (!m.buffer) {
        const file = await ModelStorage.instance.ensure(m.identifier, m.name);
        if (!file?.blob) throw new Error('3Dモデル本体が取得できません: ' + m.name);
        m.buffer = m.kind === 'gltf' ? await file.blob.text() : await file.blob.arrayBuffer();
      }
      if (this.dead || this.modelRegistry.get(m.identifier) !== m) throw new Error('3Dモデルの読み込みが取り消されました');
      const scene = await new Promise<THREE.Object3D>((resolve, reject) => {
        if (m.kind === 'fbx') {
          try { resolve(new FBXLoader().parse(m.buffer as ArrayBuffer, '')); } catch (e) { reject(e); }
          return;
        }
        this.gltfLoader.parse(m.buffer as any, '', g => resolve(g.scene), e => reject(e));
      });
      if (this.dead || this.modelRegistry.get(m.identifier) !== m) {
        disposeModelResources([scene]);
        throw new Error('3Dモデルの読み込みが取り消されました');
      }
      // The original bytes remain in ModelStorage; do not retain another large RAM copy.
      m.buffer = undefined;
      m.scene = scene;
      return scene;
    })().finally(() => { m.parsing = null; m.buffer = undefined; });
    return m.parsing;
  }

  private syncRegistry() {
    if (this.dead) return;
    for (const file of ModelStorage.instance.list()) {
      if (!this.modelRegistry.has(file.identifier)) this.modelRegistry.set(file.identifier, {
        identifier: file.identifier, name: file.name, kind: file.kind, size: file.size,
      });
    }
    this.reconcileBindings();
  }

  private async assignRegistryModel(modelId: string, character: GameCharacter, element: HTMLElement = null): Promise<boolean> {
    const model = this.modelRegistry.get(modelId);
    if (!model) return false;
    const version = (this.assignmentVersions.get(character.identifier) || 0) + 1;
    this.assignmentVersions.set(character.identifier, version);
    const previousId = character.model3dIdentifier;
    try {
      const scene = await this.parseRegistryEntry(model);
      if (this.dead || ObjectStore.instance.get(character.identifier) !== character
        || this.assignmentVersions.get(character.identifier) !== version || character.model3dIdentifier !== previousId
        || this.modelRegistry.get(modelId) !== model) return false;
      // Store identity only after parsing succeeds; a rejected selection keeps the previous assignment.
      this.bindModel(character, cloneModelScene(scene), element);
      this.boundModels.get(character.identifier).modelId = modelId;
      character.model3dName = model.name;
      character.model3dIdentifier = modelId;
      ModelStorage.instance.share(modelId);
      this.showNotice('3Dモデルを割り当てました: ' + model.name);
      return true;
    } catch (error) { console.warn('[table3d-spike] 割当失敗:', error); this.showNotice('3Dモデルを取得・読み込みできません: ' + model.name); return false; }
  }

  private removeBinding(identifier: string) {
    const entry = this.boundModels.get(identifier);
    if (!entry) return;
    this.tableRoot.remove(entry.object);
    disposeModelInstance(entry.scene);
    const i = this.models.indexOf(entry.wrapper || entry.object); if (i >= 0) this.models.splice(i, 1);
    if (entry.element) { entry.element.classList.remove('spike3d-bound', 'spike3d-off'); entry.element.style.removeProperty('--spike3d-taglift'); }
    this.boundModels.delete(identifier);
  }

  /** Reconcile synchronized IDs after room load, late join, replacement, or remote unbinding. */
  private reconcileBindings() {
    if (this.dead) return;
    for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
      const identifier = c.model3dIdentifier;
      if (/^[a-f0-9]{64}$/.test(identifier || '')) ModelStorage.instance.share(identifier);
      const bound = this.boundModels.get(c.identifier);
      if (bound && bound.modelId !== identifier) this.removeBinding(c.identifier);
      if (!/^[a-f0-9]{64}$/.test(identifier || '') || this.boundModels.get(c.identifier)?.modelId === identifier
        || this.bindingLoads.get(c.identifier) === identifier || (this.retryBindingsAt.get(c.identifier) || 0) > Date.now()) continue;
      this.bindingLoads.set(c.identifier, identifier);
      void (async () => {
        try {
          const file = await ModelStorage.instance.ensure(identifier, c.model3dName);
          if (!file) throw new Error('model unavailable');
          if (this.dead || c.model3dIdentifier !== identifier || ObjectStore.instance.get(c.identifier) !== c) return;
          if (!this.modelRegistry.has(identifier)) this.modelRegistry.set(identifier, {
            identifier, name: file.name, kind: file.kind, size: file.size,
          });
          const scene = await this.parseRegistryEntry(this.modelRegistry.get(identifier));
          if (this.dead || c.model3dIdentifier !== identifier || ObjectStore.instance.get(c.identifier) !== c) return;
          this.bindModel(c, cloneModelScene(scene));
          this.boundModels.get(c.identifier).modelId = identifier;
          this.retryBindingsAt.delete(c.identifier);
        } catch (error) { this.retryBindingsAt.set(c.identifier, Date.now() + 10000); console.warn('[table3d-spike] 3Dモデル復元待ち:', c.model3dName, error); }
        finally { if (this.bindingLoads.get(c.identifier) === identifier) this.bindingLoads.delete(c.identifier); }
      })();
    }
  }

  /** モデルのサムネイル画像(dataURL)を生成する（ファイル一覧の3Dタブ用プレビュー） */
  private renderThumb(m: { name: string; thumb?: string; scene?: THREE.Object3D }): string {
    if (!m.scene) return '';
    if (!this.thumbRenderer) this.thumbRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    const r = this.thumbRenderer;
    r.setSize(128, 128);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(35, 1, 1, 100000);
    const obj = cloneModelScene(m.scene);
    scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3()).length() || 1;
    cam.position.set(c.x + s * 0.7, c.y + s * 0.55, c.z + s * 0.85);
    cam.lookAt(c);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 1.3));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(s, s * 2, s);
    scene.add(dir);
    try {
      r.render(scene, cam);
      return r.domElement.toDataURL('image/png');
    } finally {
      disposeModelInstance(obj);
      scene.clear();
    }
  }

  /** 卓ローカル座標からコマを検索（ドロップ先の割当用。試験なのでグリッド50px固定） */
  private hitTestCharacter(x: number, y: number): GameCharacter | null {
    let best: GameCharacter = null;
    let bestDist = Infinity;
    for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
      const size = modelFootprint(c.size);
      if (x < c.location.x - 20 || x > c.location.x + size + 20) continue;
      if (y < c.location.y - 20 || y > c.location.y + size + 20) continue;
      const cx = c.location.x + size / 2, cy = c.location.y + size / 2;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /** コマへ描画インスタンスを割り当てる（資源IDの保存・同期は呼び出し元で行う）。 */
  private bindModel(character: GameCharacter, scene: THREE.Object3D, element: HTMLElement = null) {
    const identifier = character.identifier;
    // 旧基準で手動調整済みのコマは見た目の向きを維持する（180度補正→新基準では0度）。
    // 未調整の0度は新しい正面へ直し、以後の再割当では補正を繰り返さない。
    if (character.model3dFrontVersion < 1) {
      const oldYaw = Number(character.model3dYaw) || 0;
      if (character.model3dName && oldYaw !== 0) character.model3dYaw = THREE.MathUtils.euclideanModulo(oldYaw, 360) - 180;
      character.model3dFrontVersion = 1;
    }
    this.removeBinding(identifier);
    if (element) element.classList.add('spike3d-bound');
    const size = modelFootprint(character.size);
    const wrapper = this.prepareModel(scene, size * 2);
    wrapper.updateMatrixWorld(true);
    // Y-up→Z-up補正後のモデルなので、卓の鉛直方向はZ。Yは奥行きであり高さではない。
    const height = new THREE.Box3().setFromObject(wrapper).getSize(new THREE.Vector3()).z;
    // 回転・倒しを適用するためのピボット（prepareModelの軸補正quaternionを壊さないように分離）
    const pivot = new THREE.Object3D();
    pivot.add(wrapper);
    this.tableRoot.add(pivot);
    this.boundModels.set(identifier, { scene, object: pivot, wrapper, element, height, footprint: size });
    // 3Dモデルの頭上に名前・バフ表示が来るよう高さをCSS変数で伝える
    this.models.push(wrapper);
    this.updateBoundModel(character, this.boundModels.get(identifier));
    console.log('[table3d-spike] コマに3Dモデルを割り当てました:', character.name);
  }

  private updateBoundModels() {
    for (const [identifier, entry] of Array.from(this.boundModels.entries())) {
      const c = ObjectStore.instance.get<GameCharacter>(identifier);
      if (!c) {
        this.removeBinding(identifier); continue;
      }
      this.updateBoundModel(c, entry);
    }
  }

  private updateBoundModel(c: GameCharacter, entry: BoundModel) {
    const size = modelFootprint(c.size);
    let x = c.location.x, y = c.location.y, z = (c as any).posZ || 0;
    // ドラッグ中はDOMのtransformが先行して動くため、割当時に拾った要素から実位置を読む（試験用の簡易追従）
    // 平面モードから戻るとコマのDOMが再作成されるため、非表示状態と追従先を付け直す。
    let el = entry.element;
    if (!el || !el.isConnected) {
      el = document.querySelector('game-character[data-identifier="' + CSS.escape(c.identifier) + '"]') as HTMLElement | null;
      entry.element = el;
      if (el) el.classList.add('spike3d-bound');
    }
    if (el) {
      const moved = el.querySelector('.component.is-3d') as HTMLElement | null;
      const t = moved ? getComputedStyle(moved).transform : '';
      if (t && t !== 'none') {
        try {
          const m = new DOMMatrixReadOnly(t);
          if (isFinite(m.m41) && (Math.abs(m.m41) > 0.01 || Math.abs(m.m42) > 0.01 || Math.abs(m.m43) > 0.01)) {
            x = m.m41; y = m.m42; z = m.m43 || z;
          }
        } catch (_) { /* transformの解析失敗時はlocation値を使う */ }
      }
    }
    entry.object.position.set(x + size / 2, y + size / 2, z);
    // コマの操作反映: 卓はZ-up（卓面=XY平面、Z=鉛直）。ターン(rotate/roll)と正面方向(model3dYaw)は
    // すべてZ軸（ワールド鉛直軸）回転に統一 → モデルは直立を保ったまま向きだけ変わる。
    // GLB固有のY-up→Z-up初期姿勢補正は子wrapper(toTableQuat)が担い、親pivotのZ回転と分離済み。
    const rotate = modelAngle(c.rotate);
    const roll = modelAngle(c.roll);
    const enabled = (c as any).model3dEnabled !== false;
    const scale = modelScaleFactor(c.model3dScale) * size / entry.footprint;
    const yaw = THREE.MathUtils.degToRad(-modelAngle(c.model3dYaw));
    entry.object.visible = enabled && c.isVisibleOnTable;
    // 足元ハンドルはDOMのrotateZ(+rotate)を動かす。卓ローカルを共有するpivotも同じ符号にする。
    // rollとモデル固有の正面補正は既存の向きを維持し、足元ハンドルの逆転だけを解消する。
    entry.object.rotation.set(0, 0, THREE.MathUtils.degToRad(rotate - roll) + yaw);
    if (entry.wrapper) entry.wrapper.scale.setScalar(scale);
    if (entry.element) {
      entry.element.classList.toggle('spike3d-off', !enabled);
      const lift = enabled ? Math.ceil((entry.height || 0) * scale) + 12 : 0;
      const val = lift + 'px';
      if (entry.element.style.getPropertyValue('--spike3d-taglift') !== val) entry.element.style.setProperty('--spike3d-taglift', val);
    }
  }

  /** ドロップ配置の成否を画面にも表示する（コンソールだけだと気づけないため） */

  private showNotice(text: string) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(0,0,0,.78);color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:10000;pointer-events:none;max-width:80vw;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  private debugApi() {
    const self = this;
    return {
      get ready() { return self.ready; },
      modelCount: () => self.models.length,
      boundCount: () => self.boundModels.size,
      canvasVisible: () => self.canvas.style.display !== 'none',
      tableSize: () => ({ w: self.tableEl.offsetWidth, h: self.tableEl.offsetHeight }),
      viewState: () => self.state(),
      calibrate: () => self.calibrate(),
      matrices: () => ({ tableRoot: self.tableRoot.matrix.elements.slice(), tableRootWorld: self.tableRoot.matrixWorld.elements.slice(), modelPositions: self.models.map(m => m.position.toArray()), modelWorlds: self.models.map(m => m.matrixWorld.elements.slice()), cameraInv: self.camera.matrixWorldInverse.elements.slice(), projection: self.camera.projectionMatrix.elements.slice() }),
      info: () => ({ triangles: self.renderer.info.render.triangles, calls: self.renderer.info.render.calls, memory: { ...self.renderer.info.memory }, canvasW: self.canvas.width, canvasH: self.canvas.height, rect: self.canvas.getBoundingClientRect().toJSON() }),
      canvasPixels: () => { const c2 = document.createElement('canvas'); c2.width = self.canvas.width; c2.height = self.canvas.height; const ctx = c2.getContext('2d'); ctx.drawImage(self.canvas, 0, 0); const d = ctx.getImageData(0, 0, c2.width, c2.height).data; const pr = Math.min(window.devicePixelRatio || 1, 2); const reds = []; for (let y = 0; y < c2.height; y += 2) { for (let x = 0; x < c2.width; x += 2) { const i = (y * c2.width + x) * 4; if (d[i + 3] > 40 && d[i] > 60 && d[i] > d[i + 1] + 15 && d[i] > d[i + 2] + 15) reds.push({ x: Math.round(x / pr), y: Math.round(y / pr), rgb: [d[i], d[i + 1], d[i + 2]] }); } } return { total: reds.length, first: reds.slice(0, 8) }; },
      compare: (x: number, y: number, z: number) => self.compare(x, y, z),
      registerModel: async (name: string, buffer: ArrayBuffer | string, size: number) => {
        const file = await ModelStorage.instance.add(name, new Blob([buffer]));
        self.syncRegistry();
        return file.identifier;
      },
      listModels: () => Array.from(self.modelRegistry.entries()).map(p => ({ id: p[0], name: p[1].name, size: p[1].size, kind: p[1].kind, thumb: p[1].thumb || '' })),
      buildThumb: async (id: string) => {
        const m = self.modelRegistry.get(id);
        if (!m) return null;
        try {
          if (!m.scene) m.scene = await self.parseRegistryEntry(m);
          if (!m.thumb) m.thumb = self.renderThumb(m);
          return m.thumb;
        } catch (e) { console.warn('[table3d-spike] サムネイル生成失敗:', m.name, e); return null; }
      },
      removeModel: async (id: string) => {
        for (const c of ObjectStore.instance.getObjects<GameCharacter>(GameCharacter)) {
          if (c.model3dIdentifier === id) {
            self.assignmentVersions.set(c.identifier, (self.assignmentVersions.get(c.identifier) || 0) + 1);
            c.model3dIdentifier = ''; c.model3dName = ''; self.removeBinding(c.identifier);
          }
        }
        const removed = self.modelRegistry.get(id);
        self.modelRegistry.delete(id);
        for (const preview of self.models.slice()) {
          if (preview.userData.model3dIdentifier !== id) continue;
          self.tableRoot.remove(preview);
          disposeModelInstance(preview);
          self.models.splice(self.models.indexOf(preview), 1);
        }
        if (removed?.scene) disposeModelResources([removed.scene]);
        if (self.pendingModelId === id) self.pendingModelId = null;
        await ModelStorage.instance.remove(id);
        return true;
      },
      selectModel: (id: string) => { self.pendingModelId = id; },
      selectedModel: () => self.pendingModelId,
      clearSelection: () => { self.pendingModelId = null; },
      registryCount: () => self.modelRegistry.size,
      assignModel: (modelId: string, charId: string) => {
        const m = self.modelRegistry.get(modelId);
        const c = ObjectStore.instance.get<GameCharacter>(charId);
        if (!m || !c) return false;
        let host = document.querySelector('game-character[data-identifier="' + charId + '"]') as HTMLElement | null;
        const old = self.boundModels.get(c.identifier);
        if (old && old.element) host = old.element;
        return self.assignRegistryModel(modelId, c, host);
      },
      unbindModel: (charId: string) => {
        const c = ObjectStore.instance.get<GameCharacter>(charId);
        if (!c) return false;
        self.assignmentVersions.set(c.identifier, (self.assignmentVersions.get(c.identifier) || 0) + 1);
        self.removeBinding(c.identifier);
        c.model3dIdentifier = '';
        (c as any).model3dName = '';
        return true;
      },
      isBound: (charId: string) => self.boundModels.has(charId),
      boundInfo: () => Array.from(self.boundModels.entries()).map(p => ({ id: p[0], visible: p[1].object.visible, height: (p[1].height || 0) * p[1].wrapper.scale.x, scale: p[1].wrapper ? p[1].wrapper.scale.x : null, taglift: p[1].element ? p[1].element.style.getPropertyValue('--spike3d-taglift') : null, rot: { x: +(p[1].object.rotation.x || 0).toFixed(3), y: +(p[1].object.rotation.y || 0).toFixed(3), z: +(p[1].object.rotation.z || 0).toFixed(3) } })),
      setModel3d: (charId: string, key: string, value: any) => { const c = ObjectStore.instance.get<GameCharacter>(charId); if (c) (c as any)[key] = value; },
      screenToTable: (x, y) => { const l = self.screenToTableLocal(x, y); return l ? { x: Math.round(l.x), y: Math.round(l.y) } : null; },
      charLocations: () => ObjectStore.instance.getObjects<GameCharacter>(GameCharacter).map(c => ({ name: c.name, id: c.identifier, x: c.location.x, y: c.location.y, rotate: (c as any).rotate || 0, roll: (c as any).roll || 0 })),
      setRotate: (id: string, v: number) => { const c = ObjectStore.instance.get<GameCharacter>(id); if (c) (c as any).rotate = v; },
      setRoll: (id: string, v: number) => { const c = ObjectStore.instance.get<GameCharacter>(id); if (c) (c as any).roll = v; },
    };
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    EventSystem.unregister(this);
    cancelAnimationFrame(this.rafId);
    for (const id of Array.from(this.boundModels.keys())) this.removeBinding(id);
    for (const preview of this.models) disposeModelInstance(preview);
    disposeModelResources(Array.from(this.modelRegistry.values()).flatMap(m => m.scene ? [m.scene] : []));
    this.models.length = 0;
    this.tableRoot.clear();
    this.modelRegistry.clear();
    this.dracoLoader.dispose();
    this.ktx2Loader.dispose();
    this.renderer.dispose();
    if (this.thumbRenderer) { this.thumbRenderer.dispose(); this.thumbRenderer = null; }
    this.canvas.remove();
    if (this.dragOverHandler) window.removeEventListener('dragover', this.dragOverHandler, true);
    if (this.dropHandler) window.removeEventListener('drop', this.dropHandler, true);
    if (this.pointerDownHandler) window.removeEventListener('pointerdown', this.pointerDownHandler, true);
    document.getElementById('spike3d-hide-icon')?.remove();
    document.body.classList.remove('spike3d-flat');
    this.marker.remove();
    delete (window as any).__spike3d;
  }
}
