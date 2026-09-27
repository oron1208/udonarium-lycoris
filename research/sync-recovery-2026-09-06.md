# SkyWay realtime synchronization investigation (2026-09-06)

Scope: local source fixes; no VPS deployment, push, or replacement of the running server's frontend. Existing game-table lighting edits are untouched.

## Confirmed code defects

1. `PeerContext._createRoom()` generates a random session ID. The old `SkyWayConnection.makeFriendPeer()` nevertheless reconstructed destination IDs from user names. Consequently peer discovery and relay routing used nonexistent IDs. Discovery now uses actual SDK room membership, and peer-list messages carry actual connected session IDs. Display names no longer determine relay destinations (including duplicate names).
2. Failed attempts remained in `maybeUnavailablePeerIds`; close/timeout had no reliable recovery independent of peer-list gossip. Room membership is now reconciled every 5 seconds, with a 30-second deadline for pending connections. Already-pending attempts are not duplicated; departed members are removed. The interval stops on connection close.
3. Exceptions inside async zero-timeout callbacks left the outer send/receive promises unresolved. Following batches then waited forever. Both queues now settle and restore bandwidth accounting on failure; corrupt event batches are discarded, and compression failure falls back to the original bytes.
4. Canceling a not-yet-open stream could leave listeners and async subscriptions alive. Cancellation now disposes resources, unsubscribes local subscriptions, ignores late completion, and listens for RTCDataChannel closure. Late closure of a replaced stream cannot remove its replacement.

These are evidenced code defects matching the report, not proof of the exact cause of the historical incident. No affected-client log or cross-network live reproduction was available.

## Verification

Focused regression command:

```sh
CHROME_BIN=/opt/google/chrome/chrome npx ng test --watch=false --browsers=ChromeHeadless --ts-config=tsconfig.network-spec.json --include='src/app/class/core/system/network/skyway2023/*.spec.ts'
```

Result: **7/7 passed** in Chrome Headless 147. Application TypeScript check passed. Production build passed (existing CSS size warnings); output is isolated from the running service.

Seven cases: retry after failure, pending timeout/duplicate avoidance, stale close, malformed compression followed by good data, send exception followed by good data, actual-ID relay with duplicate display names, cancellation before opening.

The general spec configuration has pre-existing compilation errors (wrong component imports/names and missing Hammer types); the focused config isolates these networking tests without modifying unrelated tests.

## Rollout / manual checks

Build artifact: `/tmp/lycoris-sync-review`. Not automatically published to the running local service.

After local rollout, all testers should reload into the new build. The added peer-list fields are optional; old clients can still send ordinary data, but old-client relay behavior is not repaired remotely. Verify at least three clients, preferably on different networks:

- Join concurrently and confirm all clients show the same member count.
- Move a token on each client and observe it on both others without forced sync.
- Disconnect one client briefly, reconnect, then repeat movement in all directions.
- Repeat with two identical display names and a backgrounded tab.
- Check initial ZIP load and a manual forced sync as well.

Still unverified: real SkyWay/TURN recovery across networks, background-tab throttling, and interaction with initial snapshot import under sustained edits. A one-time snapshot restoring positions does not by itself prove the realtime P2P mesh is healthy.
