# Reproduced 3D image blur caused by invisible flash overlay

User supplied upstream/lycoris screenshots showing sharp upstream image versus blurry Lycoris image and labels. Upload compression alone does not explain the UI text.

## Reproduction

Chrome Headless 147, actual current local app loaded via CDP. Clone a game-character DOM (retaining Angular CSS attributes), replace image URLs with the same 1024px stripe/text source, place under perspective=1000px and translateZ(700px)/rotateX(55deg). Remove irrelevant buff/controls for framing. Keep the normal image and its opacity-zero screen-blend duplicate.

- With flash overlay present (opacity 0, mix-blend-mode screen), the normal image loses fine stripe detail and text is blurred.
- Set only the duplicate's display to none: fine stripes return. Same source, geometry, and resolution. Difference sums RGB: 21376743, 21389980, 21389980 (not a quality metric, just confirms distinct screenshots).
- Removing host will-change:transform alone in the no-overlay fixture produced pixel-identical images. Do not claim that hint caused this instance or remove unrelated transforms.
- Evidence: /tmp/lycoris-layer-check/actual-before.png and actual-after.png; CDP reproducer live.cjs, post-build regression.cjs in the same directory.

## Fix

Both game-character and character-group: normal and flat flash overlays use display:none outside flash animation. Existing char-anim-flash selector sets display:block during the animation. Opacity/blend/effect animation unchanged. No upstream rotation changes or compression policy changes.

This reproduces a concrete rendering defect in the local environment; the user's specific Windows/GPU result still needs confirmation. Original user screenshots show different poses and magnifications, so no numeric cross-app image-quality ratio is claimed.

## Delivery and verification
Production build passed; local deployed main.1a3b3bdb6a30f625.js, HTTP index/main match verified. Backup dist/udonarium-lycoris-backup-20260906-131851. Post-build live DOM check: idle display none, active block, after none, original width 1024. Screenshots reproduce old behavior by forcing overlay display:block then clearing the override to exercise the shipped CSS. Fine stripes are restored in the shipped idle state. VPS unchanged.
