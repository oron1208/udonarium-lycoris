/** Local developer opt-in only. Not a synchronized room setting or a public options entry. */
export const MODEL3D_EXPERIMENT_KEY = 'lycoris.experimental.model3d';

export const MODEL3D_EXPERIMENT_ENABLED: boolean = (() => {
  try { return localStorage.getItem(MODEL3D_EXPERIMENT_KEY) === '1'; }
  catch { return false; }
})();
