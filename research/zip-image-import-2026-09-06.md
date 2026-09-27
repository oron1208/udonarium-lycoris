# ZIP image import options

User requested a confirmation only for large files inside ZIP archives, with original-quality import or selectable compression and small-print cautions.

- ZIP image entries exceeding 2 MiB trigger one modal before archive contents are imported. Default preserves original bytes; cancel imports nothing from that ZIP. Smaller images remain unchanged.
- Compression presets: 3840px / JPEG quality .95, 1920px / .85, 1280px / .70. PNG stays PNG; other formats besides JPEG remain unchanged to avoid losing transparency/animation. Ineffective or failed compression preserves the original.
- Changed images receive their actual SHA-256 identifier. XML text/attribute references are remapped before XML loading; old hashes are not reused for different bytes (server uploads verify SHA-256).
- Existing direct-file upload behavior is not changed. Existing room assets are not modified in place. Original ZIP is never overwritten.
- Regression tests (ChromeHeadless): six passed, covering dialog default/presets, XML remapping, small archives without prompt, cancellation before mutation, original byte hash preservation, and compressed hash/metadata consistency. Compression itself uses the existing worker/fallback implementation; ZIP tests stub compression to isolate import/hash behavior.
- Application TypeScript check and diff whitespace check passed.

Production build passed (existing component CSS budget warnings). Deployed to local dist with config preserved; backup dist/udonarium-lycoris-backup-20260906-130903. HTTP index/main byte equality verified, main.f4c3fc457c9435cb.js contains the new dialog. VPS unchanged.
