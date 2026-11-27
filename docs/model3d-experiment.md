# 3D token experiment: hidden / paused

As requested on 2026-11-10, 3D token development is paused and the existing implementation is retained as a hidden experiment, not a normally available feature.

## Default behavior

- The model tab, model file input, and character-sheet model settings are absent.
- `table-3d-spike` and Three.js are lazy-loaded only after explicit developer opt-in. Normal sessions do not create the model WebGL renderer, model canvas, animation loop, or model drop/assignment listeners.
- Direct standalone GLB/GLTF/VRM/FBX imports are ignored while disabled.
- Existing model IDs/settings and cached model bytes are not removed. Models in room/character ZIPs remain importable/exportable as data. They are not parsed or rendered merely because their references are present.
- Ordinary image tokens, the CSS perspective tabletop, and its existing flat/perspective controls are unchanged. Hiding model rendering is not a promise that every part of the app stops using GPU acceleration.

The normal UI deliberately has no switch for this experiment. The opt-in is local to one browser origin, not synchronized to a room or another participant.

## Developer-only restoration

For authorized experimental testing, set this in the developer console, then reload:

```js
localStorage.setItem('lycoris.experimental.model3d', '1');
location.reload();
```

To return to the normal hidden state:

```js
localStorage.removeItem('lycoris.experimental.model3d');
location.reload();
```

The opt-in is sampled once per application load. An unavailable localStorage defaults to off. The gate is `src/app/class/experimental-features.ts`. The async loader also checks whether its table was destroyed before constructing the renderer.

## Verification

```sh
npx ng build --configuration development --output-path tmp/spike-3d/hidden-dev
node tools/verify-model3d-hidden.cjs tmp/spike-3d/hidden-dev/browser
npx ng build --configuration production --output-path tmp/spike-3d/hidden-production
```

The hidden-feature fixture uses isolated servers/profiles and two browsers. The default-off browser disables WebGL at startup; it checks the normal table, absent model UI/API, zero WebGL context requests, no 3D-layer/decoder fetches, disabled standalone intake, existing ZIP model bytes/reference round-trip, and visible ordinary image tokens. The opt-in browser verifies that the retained feature can still load and render a real model. Programmatic state setup is used; these are not new trusted pointer-interaction tests.

Existing dedicated model tests now opt in explicitly before page scripts run: `verify-model3d-storage.cjs`, `verify-model3d-scene-browser.cjs`, `verify-model3d-regressions.cjs`, and `verify-table3d-spike.cjs`.

Passing evidence: `tmp/spike-3d/hidden-check-1794295456141/results.json` (five behavior groups and runtime exceptions 0). Production delivery evidence is in `tmp/spike-3d/hidden-deploy/`, with the prior index retained for rollback. No VPS deployment or server restart is part of this change.

Local trial verified main: `main-FROZ6Z45.js`, SHA-256 `b6f90f650860cd096aa838b9dd880f6ee4b38cec3206a06ffcb494b3349f7c64`. The fresh production browser boot used `--disable-webgl`: table rendered, model API absent, WebGL context requests 0, model chunk not fetched, runtime exceptions 0. Environment config was preserved and all 595 non-config build files matched the trial webroot.
