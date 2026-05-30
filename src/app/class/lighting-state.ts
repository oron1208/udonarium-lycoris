export interface LightingEffectState {
  enabled: boolean;
  nightMode: boolean;
  intensity: number;
  tint: string;
  paMode: boolean;
  spotlights: boolean;
  spotlightColor: string;
  spotlightCount: number;
  lasers: boolean;
  laserColor: string;
  laserSpeed: number;
  flames: boolean;
  flameLevel: number;
  haze: boolean;
}

export const LIGHTING_STATE_STORAGE_KEY = 'udonarium.lycoris.lighting.state.v1';
export const LIGHTING_STATE_CHANGED = 'LIGHTING_STATE_CHANGED';

export const DEFAULT_LIGHTING_STATE: LightingEffectState = {
  enabled: false,
  nightMode: true,
  intensity: 0.55,
  tint: '#00030c',
  paMode: false,
  spotlights: false,
  spotlightColor: '#fff3c4',
  spotlightCount: 2,
  lasers: false,
  laserColor: '#4cf3ff',
  laserSpeed: 1,
  flames: false,
  flameLevel: 0.5,
  haze: false,
};

export function loadLightingState(): LightingEffectState {
  try {
    const raw = localStorage.getItem(LIGHTING_STATE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LIGHTING_STATE };
    return { ...DEFAULT_LIGHTING_STATE, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULT_LIGHTING_STATE };
  }
}

export function saveLightingState(state: LightingEffectState) {
  try { localStorage.setItem(LIGHTING_STATE_STORAGE_KEY, JSON.stringify(state)); } catch (_) { }
}
