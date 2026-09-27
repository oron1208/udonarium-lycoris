# Follow-up: image zoom still blurry

User confirmed the original-image URL change did not fix their visible blur. The earlier image tests established source dimensions, not raster sharpness in the real 3D table.

Reference: https://github.com/TK11235/udonarium at bf11844114dba35240dbdfcf64cfde93d15ff44c (`src/styles.css`, lines 181–204).

Missing upstream fixes ported into local `src/styles.css`:

- `.chrome-smooth-image-trick { overflow: visible; }` alongside inherited transform-style. Upstream explicitly describes this as a Windows desktop Chrome 119 near-camera image rendering workaround.
- A transparent zero-sized pseudo-element on `.is-3d:has(> .chrome-smooth-image-trick)`, described upstream as the Chrome 138 workaround for the z-axis of an element rotated 180 degrees about Z.

Original-image source handling from the prior change remains. Communication changes and lighting changes remain untouched.

Verification: a local headless Chrome 147 fixture displayed a 1000px source in a 100px image under perspective/translateZ at 5x magnification. Before/after screenshots were pixel-identical; this Linux environment did not reproduce the user's blur. Files: `/tmp/lycoris-image-raster-check/{before,after,comparison}.png`. This is NOT evidence that the reported issue is resolved. User's browser/GPU and affected display mode are still needed for confirmation.

Build destination: `/tmp/lycoris-upstream-image-review`. The local service will receive the built CSS with an old-build backup and its runtime config preserved. VPS remains unchanged.

## Resume / verified local delivery (2026-09-06 12:57 JST)

On resume the local server was stopped. Restarted via Gateway-managed background execution (session rapid-kelp). Contrary to the earlier delivery report, dist still served styles.e40aa6b38df0db4e.css containing only transform-style:inherit. The review build contained both workarounds in styles.474e687db71da5fc.css. Verified the main JS bundles were byte-identical, staged the complete review build with existing config.yaml preserved, and swapped it into local dist. Backup: dist/udonarium-lycoris-backup-20260906-125735. HTTP-fetched index and CSS now confirm both workaround rules and byte equality to the deployed CSS. VPS untouched. User visual confirmation is still required; no claim of resolved blur.

## Upload compression audit (2026-09-06 13:02 JST)

User requested comparison of image compression, not CSS. Refetched upstream; origin/master remains bf11844114dba35240dbdfcf64cfde93d15ff44c. Upstream FileArchiver.handleImage rejects files over 2 MiB and otherwise stores original bytes. Lycoris FileArchiver.handleImage automatically compresses direct image uploads over 2 MiB (preserveImageBytes=false): maximum dimension 1920, PNG remains PNG but can lose spatial resolution, all non-PNG types converted to JPEG with quality parameter 0.85. Worker and main-thread fallback both implement this. Processed bytes replace input before ImageStorage.addAsync; original is not retained by that import. ZIP imports pass preserveImageBytes=true and bypass this compression. Separate 128px thumbnails do not replace context.blob. Server media upload streams bytes to file, no image transcoder found. Compression code present in currently deployed main bundle. This is an evidenced potential cause of zoom detail loss, not proof for the specific user image without comparing original/stored dimensions and bytes. No code changes made in this audit.
