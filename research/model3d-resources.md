# 3D model resource persistence and sharing

> Current status (2026-11-10 afternoon): retained as a **hidden, default-off experiment**; further feature development is paused. Normal startup does not load the model renderer. Existing IDs and portable ZIP model data are preserved. See `../docs/model3d-experiment.md` for the opt-in and lifecycle contract.

## Scope

Models remain separate from image/audio resources: they must not enter image thumbnail decoding or audio playback. `ModelStorage` reuses the existing `Database`, `BlobIntegrity`, `FileReaderUtil`, `EventSystem`, and `BufferSharingTask` infrastructure, but owns a dedicated IndexedDB cache and `/api/media/model/:sha256` namespace.

`GameCharacter.model3dIdentifier` is a synchronized content hash. `model3dName` is a display label, not an identity. Two files with identical names and different bytes do not overwrite one another; repeated imports of the same content deduplicate. Existing enabled/scale/yaw/front-version values and the Z-up rotation conventions are unchanged.

## Lifecycle

- Import through the file panel or a model drop hashes the original bytes, stores a `ModelResource`, and offers a server upload. The current limit is 150 MiB, including ZIP imports. GLB/GLTF/VRM/FBX parsing remains in the rendering layer.
- The registry lists cached/announced metadata. Parsing and byte retrieval occur only when needed by a thumbnail or assignment. Concurrent parsing of one model shares a promise.
- A synchronized model ID triggers binding reconciliation. Retrieval prefers hash-verified IndexedDB bytes, then HTTP, then a peer. Successful transfers are verified before caching or rendering.
- Catalog announcements contain metadata only. A peer transfer uses a unique `model3d-<request UUID>` task ID, a specific expected sender, and a bounded receive size. Unknown, duplicate, wrong-peer, oversize, and hash-mismatched data are rejected. Unavailable/disconnected peers release requests.
- Cached library entries from other rooms are not automatically advertised or served. Opening a new network session resets publication/provider state and cancels old transfers. Only explicit imports, current character references, or resources already announced by the current room are eligible for publication.
- Reload/rejoin receives ordinary synchronized character properties and resolves model bytes from the cache. Model bytes are not embedded into the object/event snapshot.
- Binding reconciliation also handles remote replacement/unbinding. An assignment version and identity check prevent a slow asynchronous selection from resurrecting a model after the user unbinds or selects something else.
- A stored model reference does not make a token visible: models follow `isVisibleOnTable`, so inventory/removed tokens do not leave a 3D ghost on the table.
- Deleting a local library model clears current character references to it; it does not delete other participants' cache or the shared server file. Server media GC includes model resources and their snapshot hash references.

## Portable ZIPs

Room and individual-object saves scan XML `model3dIdentifier` attributes, resolve and deduplicate the referenced models, and include original bytes at `models/<hash>/<original basename>`. If referenced model bytes cannot be retrieved, saving aborts with a visible notice instead of silently producing an incomplete backup. It resolves the save operation normally so existing callers can reset their busy indicators. Import recognizes the model extensions independently of their ZIP-inferred MIME type. Character XML importing can assign a new character identifier, so tests locate the imported character by its model hash/name rather than assuming object-ID preservation.

This does not make external GLTF/FBX dependencies portable: models that reference separate textures/buffers retain the pre-existing loader limitations. No conversion or author-facing-axis autodetection was added.

## Isolated verification

```sh
npx ng build --configuration development --output-path tmp/spike-3d/model-storage-dev
node tools/verify-model3d-storage.cjs
npx ng build --configuration production --output-path tmp/spike-3d/model-storage-production
```

The acceptance test copies `unified-server.js` into a fresh `tmp/spike-3d/storage-<timestamp>/server`, symlinks dependencies and the dedicated build, and uses port 14449 and independent Chrome profiles/CDP ports 19561–19563. Only that **dedicated build's** config is changed. It does not touch running servers, the normal `dist`, VPS data, or the ordinary trial page.

The network fixture uses `websocket-signaling` and actual ordered WebRTC DataChannels. The existing fallback signaling transport has no complete simultaneous-offer/glare handling, so the fixture explicitly chooses the joiner as sole offerer; this is test transport setup, not a production fix. HTTP model requests are blocked at the joiner's browser to require peer transfer. SkyWay authentication and external TURN connectivity are not covered by this isolated fixture.

Check recorded results for UI import/thumbnail, server byte equality and hash rejection, late-join peer transfer, remote scale/yaw, reload without retransmission, corrupt-cache recovery, portable ZIP bytes/offline rendering, same-name distinct-content IDs, and unbind/rebind/async cancellation. The padded fixture uses an ignored GLB extension chunk with random bytes to exercise more than sixteen 32 KiB transfer chunks and window acknowledgements.

Existing regression scripts `handle-direction-e2e-test.cjs` and `front-and-cleanup-e2e-test.cjs` can be run against the isolated fixture by substituting its origin in temporary copies. Do not redeploy the ordinary trial page just to execute these regressions.

## Verified 2026-10-31

- `tmp/spike-3d/storage-1793432673833/results.json`: all 12 acceptance groups passed, no uncaught runtime exceptions. Peer model HTTP requests were blocked; real RTCDataChannel transfer, reload cache reuse, corrupt-cache recovery, and offline ZIP rendering passed. Unreferenced prior-room cache remained unannounced. Missing model bytes aborted backup with a visible message.
- `tmp/spike-3d/storage-regressions-1793432661114/`: both production regression scripts exited 0, with no runtime exceptions. Actual positive/negative handle drags, initial facing/migration, name clearances, image/flat/disabled/unbind switching, and upright yaw 0/90/131/180/270/360 passed.
- Production build succeeded. Existing warnings concern eval, CSS budgets, CommonJS modules, and a legacy stylesheet link, not model compilation errors.
- After testing, the local `udonarium-lycoris.service` was restarted and the ordinary trial UI updated atomically using `tmp/spike-3d/deploy-model-storage-trial.py`. Live `assets/config.yaml` was preserved (`skyway2023`). Bundle: `main-EL5BD2QS.js`, SHA-256 `fcfeaddb7768651242f431a2767d7b80e27897334c869de3f4e00ec2187b565e`; prior index: `tmp/spike-3d/trial-previous-index.html`.
- No VPS deployment/restart was performed. Isolated network evidence is not a SkyWay/remote-TURN end-to-end result.

## 2026-11-10: instance ownership follow-up

Skeleton-aware cloning, live token-size tracking, finite display settings, and explicit per-instance/cache/decoder disposal were added after comparing Axe. Parsing releases its input RAM copy and disposes late cancelled results. Persistence and sharing formats are unchanged. Source review and verification: `axe-3d-token-review-20261110.md`.
