import { ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameTable } from '@udonarium/game-table';
import { GameCharacter } from '@udonarium/game-character';
import { Terrain } from '@udonarium/terrain';
import { LightingEffectState } from '@udonarium/lighting-state';

interface LightSource {
  x: number; // screen px
  y: number; // screen px
  radius: number; // screen px
  color: string;
  intensity: number;
  type: string;
}

@Component({
  selector: 'lighting-layer',
  templateUrl: './lighting-layer.component.html',
  styleUrls: ['./lighting-layer.component.css']
})
export class LightingLayerComponent implements OnInit, OnDestroy {
  @ViewChild('lightCanvas', { static: true }) canvasRef: ElementRef<HTMLCanvasElement>;

  state: LightingEffectState = {
    enabled: false, nightMode: true, intensity: 0.55, tint: '#00030c',
    paMode: false, spotlights: false, spotlightColor: '#fff3c4', spotlightCount: 2,
    lasers: false, laserColor: '#4cf3ff', laserSpeed: 1,
    flames: false, flameLevel: 0.5, haze: false
  };

  private animFrame: number = 0;
  private flickerPhase = 0;

  constructor(private ngZone: NgZone, private cdr: ChangeDetectorRef) { }

  private get table(): GameTable {
    return ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
  }

  ngOnInit() {
    this.loadFromTable();
    this.startRenderLoop();
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        const obj = ObjectStore.instance.get(event.data.identifier);
        if (obj instanceof GameTable || obj instanceof GameCharacter || obj instanceof Terrain) {
          this.ngZone.run(() => {
            this.loadFromTable();
            this.cdr.markForCheck();
          });
        }
      })
      .on('SELECT_GAME_TABLE', event => {
        this.ngZone.run(() => {
          this.loadFromTable();
          this.cdr.markForCheck();
        });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }

  private loadFromTable() {
    const t = this.table;
    if (!t) return;
    this.state = {
      enabled: t.lightingEnabled,
      nightMode: t.lightingNightMode,
      intensity: t.lightingIntensity,
      tint: t.lightingTint,
      paMode: t.lightingPaMode,
      spotlights: t.lightingSpotlights,
      spotlightColor: t.lightingSpotlightColor,
      spotlightCount: t.lightingSpotlightCount,
      lasers: t.lightingLasers,
      laserColor: t.lightingLaserColor,
      laserSpeed: t.lightingLaserSpeed,
      flames: t.lightingFlames,
      flameLevel: t.lightingFlameLevel,
      haze: t.lightingHaze,
    };
  }

  private gatherLightSources(): LightSource[] {
    const sources: LightSource[] = [];
    const table = this.table;
    if (!table) return sources;

    const gridSize = table.gridSize || 50;

    // ゲームテーブル要素のtransformを取得
    const gameTableEl = document.getElementById('app-game-table');
    const tableRect = gameTableEl ? gameTableEl.getBoundingClientRect() : null;

    const characters = ObjectStore.instance.getObjects<GameCharacter>(GameCharacter);
    for (const c of characters) {
      if (!c.lightSourceEnabled) continue;
      if (c.location.name !== 'table') continue;
      const localX = c.location.x * gridSize + gridSize / 2;
      const localY = c.location.y * gridSize + gridSize / 2;
      let x = localX, y = localY;
      if (tableRect) {
        x = tableRect.left + localX;
        y = tableRect.top + localY;
      }
      const radiusPx = c.lightRadius * gridSize;
      sources.push({ x, y, radius: radiusPx, color: c.lightColor, intensity: c.lightIntensity, type: c.lightType });
    }

    const terrains = ObjectStore.instance.getObjects<Terrain>(Terrain);
    for (const t of terrains) {
      if (!t.lightSourceEnabled) continue;
      if (t.location.name !== 'table') continue;
      const localX = t.location.x * gridSize + (t.width || 1) * gridSize / 2;
      const localY = t.location.y * gridSize + (t.depth || 1) * gridSize / 2;
      let x = localX, y = localY;
      if (tableRect) {
        x = tableRect.left + localX;
        y = tableRect.top + localY;
      }
      const radiusPx = t.lightRadius * gridSize;
      sources.push({ x, y, radius: radiusPx, color: t.lightColor, intensity: t.lightIntensity, type: t.lightType });
    }

    return sources;
  }

  private startRenderLoop() {
    const render = () => {
      this.renderCanvas();
      this.animFrame = requestAnimationFrame(render);
    };
    this.animFrame = requestAnimationFrame(render);
  }

  private renderCanvas() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const active = this.state.enabled && this.state.nightMode;
    if (!active) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
      return;
    }

    canvas.style.display = 'block';
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const darkness = this.state.intensity;
    this.flickerPhase += 0.02;

    // 暗幕を描画
    ctx.fillStyle = `rgba(0, 0, 0, ${darkness})`;
    ctx.fillRect(0, 0, w, h);

    // 光源の穴を開ける (destination-out)
    ctx.globalCompositeOperation = 'destination-out';

    const lights = this.gatherLightSources();
    for (const light of lights) {
      const flicker = light.type === 'torch' || light.type === 'campfire'
        ? Math.sin(this.flickerPhase * 3 + light.x * 0.01) * 0.08 +
          Math.sin(this.flickerPhase * 7 + light.y * 0.02) * 0.05
        : 0;

      const effectiveIntensity = Math.min(1, light.intensity + flicker);
      const r = Math.max(10, light.radius);

      const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r);
      grad.addColorStop(0, `rgba(0, 0, 0, ${effectiveIntensity})`);
      grad.addColorStop(0.6, `rgba(0, 0, 0, ${effectiveIntensity * 0.5})`);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(light.x - r, light.y - r, r * 2, r * 2);
    }

    ctx.globalCompositeOperation = 'source-over';

    // 光源の色づけ (screen blend相当)
    ctx.globalCompositeOperation = 'source-atop';
    for (const light of lights) {
      const r = Math.max(10, light.radius);
      const grad = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, r * 0.7);
      const alpha = light.intensity * 0.3;
      grad.addColorStop(0, light.color + Math.round(alpha * 255).toString(16).padStart(2, '0'));
      grad.addColorStop(1, light.color + '00');
      ctx.fillStyle = grad;
      ctx.fillRect(light.x - r, light.y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  get overlayStyle() {
    return {
      '--lighting-tint': this.state.tint,
      '--lighting-intensity': `${this.state.enabled && this.state.nightMode ? this.state.intensity : 0}`,
      '--spotlight-color': this.state.spotlightColor,
      '--laser-color': this.state.laserColor,
      '--laser-speed': `${Math.max(0.35, this.state.laserSpeed)}s`,
      '--flame-level': `${this.state.flameLevel}`,
    };
  }

  get spotlightSlots(): number[] {
    const count = Math.max(1, Math.min(4, Math.floor(this.state.spotlightCount || 1)));
    return Array.from({ length: count }, (_, i) => i);
  }
}
