# Udonarium Lycoris local migration plan

Target: migrate local Maco environment from legacy `udonarium_lily` path/service naming to `udonarium-lycoris`, without touching ConoHa.

## Strategy

1. Preserve rollback path first.
2. Stop only the local user service.
3. Rename project directory atomically with `mv`.
4. Leave a compatibility symlink from old path to new path.
5. Create a new `udonarium-lycoris.service` using the same env drop-ins.
6. Disable/stop old `udonarium-lily.service` only after new service starts.
7. Verify HTTPS UI, API status, developer admin page, SkyWay token endpoint.

## Rollback

If verification fails:

1. Stop `udonarium-lycoris.service`.
2. Disable/remove new service.
3. Remove old compatibility symlink if present.
4. Move `/home/maco/.openclaw/workspace/projects/udonarium-lycoris` back to `/home/maco/.openclaw/workspace/projects/udonarium_lily`.
5. Restore saved `udonarium-lily.service` files if needed.
6. `systemctl --user daemon-reload && systemctl --user start udonarium-lily.service`.

## Verification gates

- `systemctl --user status udonarium-lycoris.service` active running
- `curl -k https://127.0.0.1:12081/v1/status` returns `{ "ok": true }`
- `curl -k https://127.0.0.1:12081/dev-admin` contains `Udonarium Developer Admin`
- SkyWay token endpoint returns HTTP 200 for a test request
- Old path exists as symlink for compatibility
