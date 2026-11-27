// Rooms choose how they are carried: by the server, which is the default, or as a P2P room on purpose.
// Real browsers on the fixture server. SkyWay itself is reached only with ROOM_TRANSPORT_SKYWAY=1, which takes the
// real credentials from .env; otherwise the server only says that it issues tokens.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const WS = require('ws');
const lz = require('lzbase62');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const { fixture, delay } = require('./lib/lightweight-browser.cjs');

const build = process.env.LYCORIS_BUILD || 'tmp/relay-stabilization/dev/browser';
const out = path.join(root, 'tmp/room-transport');
const results = [];
let env;
const sockets = [];
const report = (name, ok, detail) => {
  results.push({ name, passed: !!ok, ...(detail ? { detail } : {}) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 700) : ''));
};
const button = (selector, text) => '[...document.querySelectorAll("' + selector + ' button")].find(b => b.textContent.trim() === ' + JSON.stringify(text) + ')';
const quoted = values => values.map(value => JSON.stringify(value)).join(', ');
// lzbase62.compress must be called once in a process: a second call never returns.
const KEPT_ROOM = '鯖';
const KEPT_NAME = lz.compress(KEPT_ROOM);

async function click(s, expression) {
  const wrapped = '(() => { const e = (' + expression + '); if (!e) throw Error("Missing click target");' +
    ' e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect();' +
    ' const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);' +
    ' return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: e === hit || e.contains(hit) }; })()';
  const point = await s.js(wrapped);
  assert(point.hit, 'Click blocked: ' + expression);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await s.call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await delay(250);
}

const state = s => s.js('(() => { const n = window.peer.networkService, c = n.connection;' +
  ' return { open: n.isOpen, room: n.peerContext.roomName, transport: n.transport, peers: n.peerIds.length,' +
  ' socket: c && c.socket ? c.socket.readyState : null, skyway: c && c.p2pAvailable }; })()');
const roomOf = s => s.js('(() => { const p = peer.networkService.peerContext; return { roomId: p.roomId, roomName: p.roomName }; })()');
const catalog = s => s.js('peer.gameRoomService.getCatalog().map(c => c.identifier + "@" + (+c.version).toFixed(3)).sort()');
const versionOf = async (s, id) => (await catalog(s)).find(x => x.startsWith(id + '@'));

// The fixture keeps every modal out of the way for tests that drive components directly. This one uses the lobby's buttons.
async function showModals(s) {
  const shown = await s.js('(() => { const style = [...document.querySelectorAll("style")].find(s => s.textContent === "modal,.modal-background{display:none!important}");' +
    ' if (style) style.textContent = ".modal-background{display:none!important}"; return !!style; })()');
  assert(shown, 'The fixture style that hides modals was not found');
}

// Rooms are opened from outside Angular here, so the menu's own state is brought up to date first.
async function openLobby(s) {
  await s.js('ng.applyChanges(document.querySelector("peer-menu")); true');
  await s.wait('(' + button('peer-menu', 'ロビー（ルーム一覧）を表示') + ')?.matches(":enabled")');
  await click(s, button('peer-menu', 'ロビー（ルーム一覧）を表示'));
  await s.wait('!!document.querySelector("lobby")');
}

async function nameRoom(s, name) {
  await s.wait('!!document.querySelector("room-setting input")');
  await s.js('(() => { const e = document.querySelector("room-setting input"); e.value = ' + JSON.stringify(name) +
    '; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
}

const listed = name => '[...document.querySelectorAll("lobby tr")].some(tr => tr.textContent.includes(' + JSON.stringify(name) + '))';
const rowOf = (s, name) => s.js('(() => { const c = ng.getComponent(document.querySelector("lobby"));' +
  ' const row = c.rooms.find(r => r.roomName === ' + JSON.stringify(name) + '); if (!row) return null;' +
  ' const tr = [...document.querySelectorAll("lobby tr")].find(tr => tr.textContent.includes(' + JSON.stringify(name) + '));' +
  ' return { transport: row.transport, members: row.peerContexts.length, badge: tr ? tr.querySelector(".transport-badge").textContent.trim() : null }; })()');

async function joinRow(s, name) {
  const row = '[...document.querySelectorAll("lobby tr")].find(tr => tr.textContent.includes(' + JSON.stringify(name) + ') && tr.querySelector("button"))';
  await s.wait(row + ' !== undefined');
  await click(s, row + '.querySelector("button")');
}

// Peers that are nothing but a socket to the server.
function rawSocket(message, done) {
  return new Promise((resolve, reject) => {
    const socket = new WS(env.origin.replace('http:', 'ws:') + '/signaling');
    sockets.push(socket);
    const timer = setTimeout(() => { socket.close(); reject(Error('socket timeout')); }, 5000);
    socket.on('open', () => socket.send(JSON.stringify(message)));
    socket.on('message', raw => {
      const reply = JSON.parse(raw.toString());
      if (!done(reply)) return;
      clearTimeout(timer);
      if (reply.type === 'error') { socket.close(); reject(Error(reply.errorType + ': ' + reply.message)); return; }
      resolve(reply);
    });
    socket.on('error', reject);
  });
}
// What the server lists. The socket has done its job and goes.
const listRooms = () => rawSocket({ type: 'list' }, reply => {
  if (reply.type !== 'peers') return false;
  sockets[sockets.length - 1].close();
  return true;
});
// A member of a room carried by the server. It stays for the rest of the run.
const keepRoom = () => rawSocket({ type: 'register', id: 'ffffffRLF' + KEPT_NAME + '-', mode: 'relay' }, reply => ['registered', 'error'].includes(reply.type));

const browsersLeft = () => Number(execSync("ps -eo args | grep -c 'user-data-dir=.*room-transport-'").trim() || 0);
function execSync(command) {
  try { return execFileSync('bash', ['-c', command], { encoding: 'utf8' }); } catch (_) { return '0\n'; }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  try {
    // 1. The server has no SkyWay credentials: a room has no choice to make.
    env = await fixture(build, 'room-transport', 14819, 20019);
    const a = await env.browser('a'), b = await env.browser('b');
    await showModals(a);
    await showModals(b);
    await openLobby(a);
    await click(a, button('lobby', '新しいルームを作成する'));
    await a.wait('!!document.querySelector("room-setting input")');
    const choice = await a.js('(() => { const c = ng.getComponent(document.querySelector("room-setting"));' +
      ' return { can: c.canChooseTransport, radios: document.querySelectorAll("room-setting input[name=roomTransport]").length }; })()');
    report('a-room-has-no-choice-where-the-server-has-no-skyway', !choice.can && choice.radios === 0, choice);
    await nameRoom(a, '既定の部屋');
    await click(a, button('room-setting', '新しいルームを作成'));
    await a.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "既定の部屋"');
    let sa = await state(a);
    report('a-new-room-is-carried-by-the-server', sa.open && sa.transport === 'relay', sa);
    const remembered = await a.js('JSON.parse(localStorage.getItem("udonarium.roomTransports.v1") || "{}")[peer.networkService.peerContext.roomId + peer.networkService.peerContext.roomName]');
    report('the-way-a-room-is-made-is-remembered', remembered === 'relay', { remembered });

    // 2. The lobby says how the room is carried, and enters it that way.
    await openLobby(b);
    await b.wait('!ng.getComponent(document.querySelector("lobby")).isReloading');
    await b.wait(listed('既定の部屋'));
    const row = await rowOf(b, '既定の部屋');
    report('the-lobby-names-the-way-a-room-is-carried', row && row.transport === 'relay' && row.badge === 'サーバー通信', row);
    await joinRow(b, '既定の部屋');
    await b.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "既定の部屋"');
    let sb = await state(b);
    report('joining-takes-the-rooms-way', sb.transport === 'relay' && sb.peers >= 2, sb);
    // A change made on A reaches B through the server.
    const target = await a.js('gt.characters[0].identifier');
    const before = await versionOf(a, target);
    await a.js('(() => { const t = gt.characters.find(c => c.identifier === ' + JSON.stringify(target) + ');' +
      ' t.location = { name: "table", x: 321, y: 234 }; return true; })()');
    await delay(600);
    const after = await versionOf(a, target);
    await b.wait('peer.gameRoomService.getCatalog().some(c => c.identifier === ' + JSON.stringify(target) + ' && (+c.version).toFixed(3) === ' + JSON.stringify((after || '@0').split('@')[1]) + ')', 100);
    const afterB = await versionOf(b, target);
    report('a-change-reaches-the-other-member-through-the-server', after !== before && afterB === after, { before, after, afterB });

    // 3. What AutoReconnect does: the same room again, without saying how.
    const ctx = await b.js('(() => { const p = peer.networkService.peerContext; return { userId: p.userId, roomId: p.roomId, roomName: p.roomName, password: p.password }; })()');
    await b.js('peer.networkService.connectionClose(); true');
    await b.js('peer.networkService.open(' + quoted([ctx.userId, ctx.roomId, ctx.roomName, ctx.password]) + '); true');
    await b.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "既定の部屋"');
    sb = await state(b);
    report('reconnecting-takes-the-remembered-way', sb.transport === 'relay' && sb.peers >= 2, sb);
    // The menu offers the lobby while nobody else is connected; the panel itself can still be opened in a room.
    await b.js('ng.getComponent(document.querySelector("peer-menu")).showLobby(); true');
    await b.wait('!!document.querySelector("lobby")');
    const shown = await b.js('(() => { const l = document.querySelector("lobby"); return l.textContent.includes("この部屋の通信方式") ? l.querySelector(".transport-badge").textContent.trim() : null; })()');
    report('the-lobby-says-how-the-current-room-is-carried', shown === 'サーバー通信', { shown });
    await env.close();
    env = null;
    for (let n = 0; n < 40 && 0 < browsersLeft(); n++) await delay(250);

    // 4. The server has SkyWay credentials: a room may be made as a P2P room on purpose.
    const realSkyWay = !!process.env.ROOM_TRANSPORT_SKYWAY;
    if (realSkyWay) {
      for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
        const match = /^\s*(SKYWAY_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    } else {
      process.env.SKYWAY_APP_ID = 'test-app';
      process.env.SKYWAY_SECRET_KEY = 'test-secret';
    }
    env = await fixture(build, 'room-transport-skyway', 14829, 20029);
    // SkyWay's tokens come from this origin. The fixture points the signaling setting at the relay socket.
    const writeConfig = async patch => {
      const file = path.join(env.web, 'assets/config.yaml');
      const config = yaml.load(fs.readFileSync(file, 'utf8'));
      patch(config);
      fs.writeFileSync(file, yaml.dump(config));
    };
    if (realSkyWay) await writeConfig(config => { config.webrtc.signalingUrl = ''; });
    const c = await env.browser('c'), d = await env.browser('d');
    await showModals(c);
    await showModals(d);
    await openLobby(c);
    await click(c, button('lobby', '新しいルームを作成する'));
    await c.wait('!!document.querySelector("room-setting input[name=roomTransport]")');
    const pick = await c.js('(() => ({ can: ng.getComponent(document.querySelector("room-setting")).canChooseTransport,' +
      ' checked: [...document.querySelectorAll("room-setting input[name=roomTransport]")].filter(i => i.checked).map(i => i.value) }))()');
    report('with-skyway-a-room-chooses-and-the-server-is-chosen-by-default', pick.can && pick.checked.join() === 'relay', pick);
    await click(c, 'document.querySelector("room-setting input[name=roomTransport][value=p2p]")');
    await nameRoom(c, 'あえてP2P');
    await click(c, button('room-setting', '新しいルームを作成'));
    await c.wait('peer.networkService.transport === "p2p"');
    await delay(1000);
    const sc = await state(c);
    const message = await listRooms();
    const announced = Object.keys(message.transports || {});
    report('a-room-made-as-p2p-is-carried-that-way', sc.transport === 'p2p', sc);
    report('a-p2p-room-announces-itself-to-the-lobby', announced.length === 1 && message.peers.includes(announced[0]), announced);
    const p2pRoom = await roomOf(c);
    if (realSkyWay) {
      await c.wait('peer.networkService.isOpen', 900);
      report('a-p2p-room-opens-over-skyway', true, await state(c));
    }

    await openLobby(d);
    await d.wait('!ng.getComponent(document.querySelector("lobby")).isReloading', 300);
    await d.wait(listed('あえてP2P'), 300);
    const row2 = await rowOf(d, 'あえてP2P');
    report('the-lobby-names-a-p2p-room', row2 && row2.transport === 'p2p' && row2.badge === 'P2P', row2);
    if (realSkyWay) {
      // What a P2P room is for: two members, member to member.
      await joinRow(d, 'あえてP2P');
      await d.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "あえてP2P"', 900);
      await delay(2000);
      const overD = await state(d), overC = await state(c);
      report('joining-a-p2p-room-connects-both-over-skyway', overD.transport === 'p2p' && overD.peers >= 1 && overC.peers >= 1, { c: overC, d: overD });
      const moved = await c.js('gt.characters[0].identifier');
      const was = await versionOf(d, moved);
      await c.js('(() => { const t = gt.characters.find(c => c.identifier === ' + JSON.stringify(moved) + ');' +
        ' t.location = { name: "table", x: 222, y: 333 }; return true; })()');
      await delay(600);
      const now = await versionOf(c, moved);
      await d.wait('peer.gameRoomService.getCatalog().some(c => c.identifier === ' + JSON.stringify(moved) + ' && (+c.version).toFixed(3) === ' + JSON.stringify((now || '@0').split('@')[1]) + ')', 200);
      report('a-change-reaches-the-other-member-over-skyway', now !== was && (await versionOf(d, moved)) === now, { was, now });
      const back = await d.js('(() => { const p = peer.networkService.peerContext; return { userId: p.userId, roomId: p.roomId, roomName: p.roomName, password: p.password }; })()');
      await d.js('peer.networkService.connectionClose(); true');
      await d.js('peer.networkService.open(' + quoted([back.userId, back.roomId, back.roomName, back.password]) + '); true');
      await d.wait('peer.networkService.transport === "p2p" && peer.networkService.isOpen', 900);
      report('reconnecting-takes-a-p2p-rooms-way', true, await state(d));
    }

    // 5. A list that is out of date: the room is tried the other way, and taken the way it is carried.
    await d.js('(() => { const n = peer.networkService; window.__errors = []; const previous = n.callback.onError;' +
      ' n.callback.onError = (...args) => { window.__errors.push(args[1]); if (previous) previous(...args); }; return true; })()');
    await d.js('peer.networkService.open("guest", ' + quoted([p2pRoom.roomId, p2pRoom.roomName]) + ', "", "relay"); true');
    await d.wait('peer.networkService.transport === "p2p"', 100);
    await delay(700);
    let sd = await state(d);
    let errors = await d.js('window.__errors');
    report('a-stale-listing-is-corrected-to-the-rooms-way', sd.transport === 'p2p' && !errors.includes('transport-mismatch'), { ...sd, errors });

    // A room carried by the server, entered as if it were a P2P room.
    await keepRoom();
    await d.js('peer.networkService.open("guest2", "RLF", ' + JSON.stringify(KEPT_ROOM) + ', "", "p2p"); true');
    await d.wait('peer.networkService.transport === "relay" && peer.networkService.isOpen && peer.networkService.peerContext.roomName === ' + JSON.stringify(KEPT_ROOM), 300);
    await delay(800);
    sd = await state(d);
    errors = await d.js('window.__errors');
    report('a-p2p-entry-into-a-server-carried-room-is-corrected', sd.transport === 'relay' && sd.peers >= 2 && !errors.includes('transport-mismatch'), { ...sd, errors });
    await env.close();
    env = null;
    for (let n = 0; n < 40 && 0 < browsersLeft(); n++) await delay(250);

    // 6. A deployment left at skyway2023: every room is P2P, as before, and nothing offers a choice.
    if (realSkyWay) {
      env = await fixture(build, 'room-transport-legacy', 14839, 20039);
      await writeConfig(config => { config.backend.mode = 'skyway2023'; config.webrtc.signalingUrl = ''; });
      const x = await env.browser('x'), y = await env.browser('y');
      await showModals(x);
      await showModals(y);
      await openLobby(x);
      await click(x, button('lobby', '新しいルームを作成する'));
      await x.wait('!!document.querySelector("room-setting input")');
      const old = await x.js('(() => ({ can: ng.getComponent(document.querySelector("room-setting")).canChooseTransport,' +
        ' radios: document.querySelectorAll("room-setting input[name=roomTransport]").length }))()');
      report('a-deployment-left-at-skyway-offers-no-choice', !old.can && old.radios === 0, old);
      await nameRoom(x, '前からのP2P');
      await click(x, button('room-setting', '新しいルームを作成'));
      await x.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "前からのP2P"', 900);
      const legacy = await state(x);
      report('a-new-room-there-is-carried-by-skyway', legacy.transport === 'p2p', legacy);
      await openLobby(y);
      await y.wait('!ng.getComponent(document.querySelector("lobby")).isReloading', 300);
      await y.wait(listed('前からのP2P'), 300);
      const oldRow = await rowOf(y, '前からのP2P');
      report('the-lobby-there-lists-the-room-as-p2p', oldRow && oldRow.transport === 'p2p' && oldRow.badge === 'P2P', oldRow);
      await joinRow(y, '前からのP2P');
      await y.wait('peer.networkService.isOpen && peer.networkService.peerContext.roomName === "前からのP2P"', 900);
      // Member to member takes a moment after the room is open.
      await y.wait('peer.networkService.peerIds.length >= 1', 150);
      await x.wait('peer.networkService.peerIds.length >= 1', 150);
      const legacyY = await state(y), legacyX = await state(x);
      report('joining-there-connects-over-skyway', legacyY.transport === 'p2p' && legacyY.peers >= 1 && legacyX.peers >= 1, { x: legacyX, y: legacyY });
    }
  } catch (error) {
    report('room-transport-flow', false, { error: error.stack || String(error) });
    process.exitCode = 1;
  } finally {
    for (const socket of sockets) socket.close();
    if (env) await env.close();
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
    const failed = results.filter(r => !r.passed).length;
    console.log(results.length - failed + ' passed, ' + failed + ' failed');
    if (failed) process.exitCode = 1;
  }
})();
