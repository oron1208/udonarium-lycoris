# Communication stability and token zoom fixes (2026-09-06)

## Implemented

### Bounded RTCDataChannel sender

The old sender processed one queued packet per zero-timeout callback and immediately retried send errors, without checking `bufferedAmount`. Under pressure it could spin on the same packet, repeatedly logging errors.

- A single scheduled drain batches up to 64 KiB per turn while preserving application packet order.
- Stop before the browser buffer exceeds 256 KiB; resume on `bufferedamountlow` (64 KiB).
- Temporary `OperationError` retries wait 100 ms, with at most five retries. Permanent errors notify the existing reconnect path.
- Disconnect cancels scheduled work and retry timers.

This reduces scheduler overhead for queued traffic and prevents tight retry loops. No measured real-world throughput multiplier is claimed; congestion/backpressure does not increase network bandwidth.

### Independent connection monitoring

The previous global monitor awaited each peer's stats sequentially. A rejection prevented scheduling the next cycle; a hung stats call stalled all peers. Repeated registration also started extra stats calls.

- Stats run independently, with at most one outstanding request per peer.
- Heartbeats continue separately even when a stats request does not settle.
- Errors are contained per peer; repeated registration is ignored.
- Timers stop when the last peer is removed; a WeakSet tracks outstanding work without permanently retaining removed peers.
- A newly opened channel starts its health timestamp at connection establishment, not construction.

### Original-resolution zoomable tokens

Both game-character and character-group rendered a resized bitmap based on `size * gridSize` / specified image height. Table zoom uses CSS transforms, so it neither changed that size nor regenerated the bitmap. The same small image was enlarged indefinitely. Reusing that URL across flat/3D modes could also preserve the obsolete thumbnail.

Both components now retain `imageFile.url` directly for normal/flat/top-down tokens, shadows, and flash overlays. Removed the fixed-size bitmap substitution and its asynchronous cache state. Native browser resampling handles zoom without throwing away source pixels; source changes take effect immediately.

Tradeoff: this removes the custom multistage thumbnail filtering on tabletop tokens, so distant minification may differ and full-resolution GPU image cost may be higher. Upload resizing and other canvas utilities are unchanged. Already low-resolution uploaded images cannot recover detail that is absent from their source.

## Verification commands

```sh
CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --ts-config=tsconfig.network-spec.json --include='src/app/class/core/system/network/{skyway2023,webrtc}/*.spec.ts'
CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --ts-config=tsconfig.image-spec.json --include='src/app/class/core/file-storage/character-image-zoom.spec.ts'
npx tsc --noEmit -p tsconfig.app.json
npx ng build --output-path=/tmp/lycoris-stability-review
```

Communication regression suite: 15 passed (7 prior recovery tests + 5 send flow-control tests + 3 monitor tests).
Image regression suite: 2 passed in Chrome Headless 147. Application typecheck and production build passed (existing CSS size warnings). Verified the final backend bundle contains the new sender/monitor logic.
Image tests exercise the actual component getters and a 1024px source displayed at 50px, zoomed 8x in Chrome, including stale-thumbnail and source-replacement cases.

## Delivery scope

Local source and isolated review build only. Existing lighting edits are preserved. No commit/push, VPS deployment, or replacement of the currently served local build.

Unverified: live multi-client SkyWay/TURN throughput, prolonged background-tab behavior, and visual comparison in a real 3D room on the user's GPU. After rollout, reload all clients and test concurrent token movement, large initial transfers, disconnect/rejoin, and token zoom in normal/flat/group modes.
