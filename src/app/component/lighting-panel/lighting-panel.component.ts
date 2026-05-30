import { Component, NgZone, OnInit } from '@angular/core';
import { EventSystem } from '@udonarium/core/system';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { GameTable } from '@udonarium/game-table';
import { LightingEffectState } from '@udonarium/lighting-state';
import { PanelService } from 'service/panel.service';

@Component({
  selector: 'lighting-panel',
  templateUrl: './lighting-panel.component.html',
  styleUrls: ['./lighting-panel.component.css']
})
export class LightingPanelComponent implements OnInit {
  state: LightingEffectState = {
    enabled: false, nightMode: true, intensity: 0.55, tint: '#00030c',
    paMode: false, spotlights: false, spotlightColor: '#fff3c4', spotlightCount: 2,
    lasers: false, laserColor: '#4cf3ff', laserSpeed: 1,
    flames: false, flameLevel: 0.5, haze: false
  };
  colors = ['#fff3c4', '#ff4fd8', '#4cf3ff', '#7dff6a', '#9b5cff', '#ff5a20'];

  constructor(
    private panelService: PanelService,
    private ngZone: NgZone
  ) {}

  private get table(): GameTable {
    return ObjectStore.instance.getObjects<GameTable>(GameTable).find(t => t.selected) ||
      ObjectStore.instance.getObjects<GameTable>(GameTable)[0];
  }

  ngOnInit() {
    this.loadFromTable();
    EventSystem.register(this)
      .on('UPDATE_GAME_OBJECT', event => {
        const obj = ObjectStore.instance.get(event.data.identifier);
        if (obj instanceof GameTable && obj === this.table) {
          this.loadFromTable();
        }
      })
      .on('LIGHTING_PANEL_CLOSED', event => {
        this.ngZone.run(() => { this.panelService.close(); });
      });
  }

  ngOnDestroy() {
    EventSystem.unregister(this);
    EventSystem.trigger('LIGHTING_PANEL_CLOSED', {});
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

  private saveToTable() {
    const t = this.table;
    if (!t) return;
    t.lightingEnabled = this.state.enabled;
    t.lightingNightMode = this.state.nightMode;
    t.lightingIntensity = this.state.intensity;
    t.lightingTint = this.state.tint;
    t.lightingPaMode = this.state.paMode;
    t.lightingSpotlights = this.state.spotlights;
    t.lightingSpotlightColor = this.state.spotlightColor;
    t.lightingSpotlightCount = this.state.spotlightCount;
    t.lightingLasers = this.state.lasers;
    t.lightingLaserColor = this.state.laserColor;
    t.lightingLaserSpeed = this.state.laserSpeed;
    t.lightingFlames = this.state.flames;
    t.lightingFlameLevel = this.state.flameLevel;
    t.lightingHaze = this.state.haze;
    t.update();
  }

  update(patch: Partial<LightingEffectState> = {}) {
    this.state = { ...this.state, ...patch };
    this.saveToTable();
  }

  toggle(key: keyof LightingEffectState) { this.update({ [key]: !this.state[key] } as any); }

  setPreset(name: string) {
    switch (name) {
      case 'night':
        this.update({ enabled: true, nightMode: true, intensity: 0.55, tint: '#00030c', haze: false, spotlights: false, lasers: false, flames: false, paMode: false });
        break;
      case 'live':
        this.update({ enabled: true, nightMode: true, intensity: 0.5, tint: '#00020a', haze: true, spotlights: true, spotlightCount: 3, lasers: true, flames: false, paMode: true });
        break;
      case 'uo':
        this.update({ enabled: true, nightMode: true, intensity: 0.45, tint: '#120300', haze: true, spotlights: true, spotlightColor: '#ff8a18', lasers: false, flames: true, flameLevel: 0.9, paMode: true });
        break;
      case 'off':
        this.update({ enabled: false });
        break;
    }
  }

  setColor(key: 'spotlightColor' | 'laserColor' | 'tint', color: string) { this.update({ [key]: color } as any); }
}
