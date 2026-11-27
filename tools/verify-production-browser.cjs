// The production build has none of the development handles, so this drives the real pages: the lobby's buttons,
// a ZIP through the import menu, a dragged piece. What the server then sees of each member tells whether a room
// took the way it was made with.
//   without ORIGIN: a fixture server here, with the build in LYCORIS_BUILD.
//   with ORIGIN=<site>: the site itself; the server's view of the members is read on the VPS over ssh.
// SkyWay itself is reached only with ROOM_TRANSPORT_SKYWAY=1 (.env credentials, fixture only).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const WS = require('ws');
const JSZip = require('jszip');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '..');
const { fixture, delay } = require('./lib/lightweight-browser.cjs');

const origin = process.env.ORIGIN || null;
const build = process.env.LYCORIS_BUILD || 'dist/release-20261127/browser';
const realSkyWay = !!process.env.ROOM_TRANSPORT_SKYWAY;
const withZip = !process.env.SKIP_ZIP;
const out = path.join(root, 'tmp', 'production-check-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const results = [];
let env;
const children = [];
const report = (name, ok, detail) => {
  results.push({ name, passed: !!ok, ...(detail ? { detail } : {}) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' ' + JSON.stringify(detail).slice(0, 600) : ''));
};
const button = (selector, text) => '[...document.querySelectorAll("' + selector + ' button")].find(b => b.textContent.trim() === ' + JSON.stringify(text) + ')';
const lobbyButton = () => button('peer-menu', 'ロビー（ルーム一覧）を表示');
const shown = s => s.js('(() => { const menu = document.querySelector("peer-menu"); const text = menu.textContent;' +
  ' const room = [...menu.querySelectorAll("span[style*=\\"font-weight: bold\\"]")].map(e => e.textContent.trim()).find(t => /^.+\\/\\w{3}$/.test(t)) || "";' +
  ' return { room, others: Number((text.match(/相手：(\\d+)人/) || [])[1]), service: /通信サービス：接続済み/.test(text) }; })()');

// A small PNG made here, so that no bundled image is involved.
const png = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = b => { let c = ~0; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const w = 40, h = 30, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x < w / 2 ? 200 : 40; raw[o + 1] = 60; raw[o + 2] = y < h / 2 ? 200 : 40; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();

async function ready(url) {
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(url)).ok) return; } catch (_) { }
    await delay(100);
  }
  throw Error('Not ready ' + url);
}

async function browser(name, port) {
  children.push(spawn('/opt/google/chrome/chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--window-size=1440,1000', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(out, name + '-profile'), 'about:blank'], { stdio: 'ignore' }));
  await ready('http://127.0.0.1:' + port + '/json/version');
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WS(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    // The import asks whether it is meant, and leaving a room with others in it asks too; a person clicks OK.
    if (message.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(String((message.params.exceptionDetails.exception || {}).description || message.params.exceptionDetails.text).slice(0, 200));
    const waiting = pending.get(message.id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    pending.delete(message.id);
    message.error ? waiting.reject(Error(JSON.stringify(message.error))) : waiting.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout ' + method)); }, 60000);
    pending.set(n, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async expression => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  };
  const wait = async (expression, attempts = 200) => {
    for (let n = 0; n < attempts; n++) {
      if (await js(expression)) return true;
      await delay(100);
    }
    throw Error('Wait timeout ' + expression.slice(0, 140));
  };
  const mouse = async (type, x, y, extra = {}) => { await call('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra)); };
  const click = async expression => {
    const point = await js('(() => { const e = (' + expression + '); if (!e) throw Error("Missing click target");' +
      ' e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect();' +
      ' const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);' +
      ' return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: e === hit || e.contains(hit) }; })()');
    await mouse('mousePressed', point.x, point.y);
    await mouse('mouseReleased', point.x, point.y);
    await delay(300);
    return point.hit;
  };
  const open = async () => {
    await call('Runtime.enable');
    await call('Page.enable');
    await call('Page.navigate', { url: (origin || env.origin) + '/' });
    await wait('!!document.querySelector("game-character") && !!document.querySelector("peer-menu")', 500);
  };
  await open();
  return { name, js, wait, click, call, ws, open, mouse, exceptions };
}

// Nothing outside Angular's events brings the page up to date here, as for a person who moves the mouse and clicks.
async function wake(s) {
  const point = await s.js('(() => { const r = document.querySelector("game-table").getBoundingClientRect(); return { x: r.left + r.width * 0.12, y: r.top + r.height * 0.5 }; })()');
  await s.mouse('mousePressed', point.x, point.y);
  await s.mouse('mouseReleased', point.x, point.y);
  await delay(350);
}
// What the menu shows once the page has caught up.
async function shownIs(s, test, attempts = 40) {
  let state = null;
  for (let n = 0; n < attempts; n++) {
    await wake(s);
    state = await shown(s);
    if (test(state)) return state;
  }
  return state;
}

async function toLobby(s) {
  for (let n = 0; n < 4 && await s.js('!!document.querySelector("modal .title-button button")'); n++) {
    await s.js('document.querySelector("modal .title-button button").click(); true');
    await delay(600);
  }
  for (let n = 0; n < 20; n++) {
    if (await s.js('(' + lobbyButton() + ')?.matches(":enabled")')) break;
    await wake(s);
  }
  await s.wait('(' + lobbyButton() + ')?.matches(":enabled")');
  await s.click(lobbyButton());
  await s.wait('!!document.querySelector("lobby")');
}

const rowOf = name => '[...document.querySelectorAll("lobby tr")].find(tr => tr.textContent.includes(' + JSON.stringify(name) + '))';
// The piece elements themselves have no size; the box that is drawn and dragged is their inner .component.
const pieces = '[...document.querySelectorAll("game-character")].map(p => p.querySelector(".component") || p)';
const places = s => s.js(pieces + '.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }).filter(p => 0 < p[2])');
const withImage = s => s.js('[...document.querySelectorAll("game-character")].filter(p => p.querySelector("img")).length');
const near = (points, point, tolerance) => points.some(p => Math.abs(p[0] - point[0]) <= tolerance && Math.abs(p[1] - point[1]) <= tolerance);
// What is in the first list and not in the second, point for point.
const only = (first, second, tolerance) => {
  const rest = second.map(p => p.slice());
  const out = [];
  for (const p of first) {
    const at = rest.findIndex(q => Math.abs(q[0] - p[0]) <= tolerance && Math.abs(q[1] - p[1]) <= tolerance);
    if (at < 0) out.push(p); else rest.splice(at, 1);
  }
  return out;
};

(async () => {
  const token = 'production-check-' + crypto.randomBytes(8).toString('hex');
  // The server's view of who is in a room. On the site it is read on the VPS itself: the token stays there,
  // taken from the file the container is started with.
  const ssh = ['-i', path.join(root, 'VPSサーバー設定/key-2026-05-23-15-23.pem'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', 'root@160.251.182.194'];
  const onTheServer = (route, method = 'GET', body = null) => {
    const quote = "'\"'\"'";
    const remote = 'curl -s --max-time 10 -X ' + method + ' -H "Authorization: Bearer $(sed -n \'s/^DEV_ADMIN_TOKEN=//p\' /etc/udonarium-lily.env | tr -d \'\\r\\n\')" -H "content-type: application/json" '
      + (body ? '-d ' + quote + JSON.stringify(body) + quote + ' ' : '') + 'http://127.0.0.1:12081' + route;
    return JSON.parse(execFileSync('ssh', ssh.concat([remote]), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  };
  const devApi = async (route, method = 'GET', body = null) => {
    if (origin) return onTheServer(route, method, body);
    return (await fetch((env ? env.origin : origin) + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  };
  const members = async () => {
    const listed = await devApi('/api/dev/peers');
    return (listed.peers || []).filter(peer => peer.source === 'websocket' && peer.roomKey && peer.roomKey !== 'lobby');
  };
  const ways = async () => (await members()).map(peer => peer.transport || 'relay');
  const forgetRooms = async () => {
    const keys = Array.from(new Set((await members()).map(peer => peer.roomKey)));
    for (const roomKey of keys) await devApi('/api/dev/delete-room', 'POST', { roomKey });
    return keys.length;
  };
  try {
    process.env.DEV_ADMIN_TOKEN = token;
    if (realSkyWay && !origin) {
      for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
        const match = /^\s*(SKYWAY_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    }
    if (!origin) {
      env = await fixture(build, 'production-check', 14859, 20059);
      if (realSkyWay) {
        // SkyWay's tokens come from this origin. The fixture points the signaling setting at the relay socket.
        const file = path.join(env.web, 'assets/config.yaml');
        const config = yaml.load(fs.readFileSync(file, 'utf8'));
        config.webrtc.signalingUrl = '';
        fs.writeFileSync(file, yaml.dump(config));
      }
    }
    const a = await browser('a', 20401), b = await browser('b', 20402);
    const main = await a.js('document.querySelector("script[src*=main]")?.src.split("/").pop()');
    const config = await (await fetch((origin || env.origin) + '/assets/config.yaml')).text();
    report('the-production-page-opens', !!(await a.js('!!document.querySelector("game-table")')) && !(await a.js('!!window.ng')), { main, served: /  mode: (\S+)/.exec(config)[1], site: origin || 'fixture' });

    // 1. A room made the default way.
    await toLobby(a);
    await a.click(button('lobby', '新しいルームを作成する'));
    await a.wait('!!document.querySelector("room-setting input")');
    const pick = await a.js('(() => ({ radios: [...document.querySelectorAll("room-setting input[name=roomTransport]")].map(i => i.value),' +
      ' checked: [...document.querySelectorAll("room-setting input[name=roomTransport]")].filter(i => i.checked).map(i => i.value) }))()');
    report('a-new-room-offers-the-choice-and-the-server-is-chosen', pick.radios.length === 2 ? pick.checked.join() === 'relay' : pick.radios.length === 0, pick);
    await a.js('(() => { const e = document.querySelector("room-setting input"); e.value = "動作確認"; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
    await a.click(button('room-setting', '新しいルームを作成'));
    const stateA = await shownIs(a, s => s.room.startsWith('動作確認/'));
    await delay(800);
    const first = await ways();
    report('a-room-made-the-default-way-is-carried-by-the-server', stateA.room.startsWith('動作確認/') && first.length === 1 && first[0] === 'relay', { room: stateA.room, ways: first });

    // 2. Another member finds it in the lobby and enters it.
    await toLobby(b);
    await b.wait(rowOf('動作確認') + ' && ' + rowOf('動作確認') + '.querySelector("button")', 300);
    const badge = await b.js(rowOf('動作確認') + '.querySelector(".transport-badge").textContent.trim()');
    await b.click(rowOf('動作確認') + '.querySelector("button")');
    const stateB = await shownIs(b, s => s.room.startsWith('動作確認/') && s.others >= 1, 80);
    const stateA2 = await shownIs(a, s => s.others >= 1, 40);
    const both = await ways();
    report('the-other-finds-the-room-in-the-lobby-and-both-are-connected', badge === 'サーバー通信' && stateB.others >= 1 && stateA2.others >= 1 && both.length === 2, { badge, a: stateA2, b: stateB, ways: both });

    if (withZip) {
      // 3. A character with its own image arrives through a ZIP, named by anything but its hash.
      let piecesBeforeB = 0;
      for (let n = 0; n < 40 && piecesBeforeB < 1; n++) { await wake(b); piecesBeforeB = await withImage(b); }
      const zip = new JSZip();
      zip.file('data.xml', '<?xml version="1.0" encoding="UTF-8"?><character location.name="table" location.x="500" location.y="300" isLock="false" rotate="0" roll="0"><data name="character"><data name="image"><data name="imageIdentifier" type="image">zipcharimg</data></data><data name="common"><data name="name">画像テスト</data><data name="size">1</data><data name="altitude">0</data><data name="initiative">0</data><data name="initiativeFormula"></data></data><data name="detail" type="noteGroup"></data><data name="buff-palette" type="note"></data></data><data name="chat-palette" type="note"></data></character>');
      zip.file('zipcharimg.png', png);
      const zipPath = path.join(out, 'image-character.zip');
      fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
      const hash = crypto.createHash('sha256').update(png).digest('hex');
      await a.js('window.confirm = () => true; true');
      await a.js('(() => { const item = [...document.querySelectorAll("li")].find(li => li.textContent.includes("データ読込")); if (!item) throw Error("no import menu item"); item.click(); return true; })()');
      await a.wait('!!document.querySelector("data-import-menu input[type=file]")');
      await a.call('DOM.enable');
      const document_ = await a.call('DOM.getDocument', { depth: 0 });
      const input = await a.call('DOM.querySelector', { nodeId: document_.root.nodeId, selector: 'data-import-menu input[type=file]' });
      await a.call('DOM.setFileInputFiles', { files: [zipPath], nodeId: input.nodeId });
      let held = null;
      for (let n = 0; n < 60 && !held; n++) {
        await delay(500);
        const response = await fetch((origin || env.origin) + '/api/media/image/' + hash);
        held = response.ok ? await response.arrayBuffer() : null;
      }
      let theirs = 0;
      for (let n = 0; n < 80 && theirs <= piecesBeforeB; n++) { await wake(b); theirs = await withImage(b); }
      const mine = await withImage(a);
      report('an-image-from-a-zip-is-held-by-the-server-and-shown-to-the-other', !!held && held.byteLength === png.length && theirs === piecesBeforeB + 1 && mine === theirs, { held: held ? held.byteLength : 0, expected: png.length, mine, theirs, before: piecesBeforeB, hash: hash.slice(0, 12) });

      // 4. That piece, dragged on one side, moves on the other.
      // A piece is taken where nothing lies over it. The chat window lies over the middle of the table at first,
      // as it does for a person, who moves it out of the way.
      const takePiece = '(() => { const pick = () => { for (const p of ' + pieces + ') { const r = p.getBoundingClientRect(); if (!(0 < r.width)) continue;' +
        ' for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const g of [0.5, 0.3, 0.7, 0.15, 0.85]) { const x = r.left + r.width * f, y = r.top + r.height * g; const top = document.elementFromPoint(x, y);' +
        ' if (top && top.closest("game-character") && top.closest("game-character") === p.closest("game-character")) return { cx: x, cy: y, x: r.left, y: r.top, w: r.width, h: r.height, under: top.tagName + "." + String(top.className).slice(0, 30) }; } } return null; }; return pick(); })()';
      let piece = await a.js(takePiece);
      let movedChat = false;
      if (!piece) {
        movedChat = await a.js('(() => { const chat = document.querySelector("chat-window"); const close = chat && chat.closest("ui-panel") && chat.closest("ui-panel").querySelector(".title-button button"); if (!close) return false; close.click(); return true; })()');
        await delay(800);
        piece = await a.js(takePiece);
      }
      if (!piece) throw Error('no piece could be taken');
      const beforeA = await places(a), beforeB = await places(b);
      const dx = 90, dy = 50;
      await a.mouse('mouseMoved', piece.cx, piece.cy, { button: 'none', buttons: 0 });
      await delay(150);
      await a.mouse('mousePressed', piece.cx, piece.cy);
      await delay(150);
      for (let n = 1; n <= 12; n++) { await a.mouse('mouseMoved', piece.cx + dx * n / 12, piece.cy + dy * n / 12, { button: 'left', buttons: 1 }); await delay(40); }
      await delay(150);
      await a.mouse('mouseReleased', piece.cx + dx, piece.cy + dy, { button: 'left', buttons: 0 });
      await delay(1200);
      await wake(a);
      await wake(b);
      const afterA = await places(a), afterB = await places(b);
      const from = [Math.round(piece.x), Math.round(piece.y)], to = [Math.round(piece.x + dx), Math.round(piece.y + dy)];
      // One place is given up and one is taken, the same ones on both sides.
      const gainedA = only(afterA, beforeA, 2), lostA = only(beforeA, afterA, 2);
      const gainedB = only(afterB, beforeB, 2), lostB = only(beforeB, afterB, 2);
      const mineMoved = gainedA.length === 1 && lostA.length === 1;
      const theirsMoved = gainedB.length === 1 && lostB.length === 1 && near(gainedB, gainedA[0] || [-1, -1], 2) && near(lostB, lostA[0] || [-1, -1], 2);
      report('a-piece-dragged-on-one-side-moves-on-the-other', mineMoved && theirsMoved, { mineMoved, theirsMoved, from, to, gainedA, lostA, gainedB, lostB, under: piece.under, chatMoved: movedChat, box: [Math.round(piece.w), Math.round(piece.h)] });
    }

    // 5. A room made as a P2P room on purpose, over SkyWay itself.
    if (realSkyWay) {
      await a.open();
      await b.open();
      await toLobby(a);
      await a.click(button('lobby', '新しいルームを作成する'));
      await a.wait('!!document.querySelector("room-setting input[name=roomTransport][value=p2p]")');
      await a.click('document.querySelector("room-setting input[name=roomTransport][value=p2p]")');
      await a.js('(() => { const e = document.querySelector("room-setting input"); e.value = "P2P確認"; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
      await a.click(button('room-setting', '新しいルームを作成'));
      const pA = await shownIs(a, s => s.room.startsWith('P2P確認/') && s.service, 200);
      const p2pWays = await ways();
      report('a-room-made-as-p2p-opens-over-skyway', pA.room.startsWith('P2P確認/') && pA.service && p2pWays.length === 1 && p2pWays[0] === 'p2p', { a: pA, ways: p2pWays });
      await toLobby(b);
      await b.wait(rowOf('P2P確認') + ' && ' + rowOf('P2P確認') + '.querySelector("button")', 300);
      const p2pBadge = await b.js(rowOf('P2P確認') + '.querySelector(".transport-badge").textContent.trim()');
      await b.click(rowOf('P2P確認') + '.querySelector("button")');
      const pB = await shownIs(b, s => s.room.startsWith('P2P確認/') && s.others >= 1, 300);
      const pA2 = await shownIs(a, s => s.others >= 1, 100);
      report('the-other-finds-the-p2p-room-and-both-are-connected', p2pBadge === 'P2P' && pB.others >= 1 && pA2.others >= 1, { badge: p2pBadge, a: pA2, b: pB });
    }
    report('no-uncaught-exception-on-either-page', a.exceptions.length === 0 && b.exceptions.length === 0, { a: a.exceptions.slice(0, 3), b: b.exceptions.slice(0, 3) });
    a.ws.close();
    b.ws.close();
  } catch (error) {
    report('production-check-flow', false, { error: error.stack || String(error) });
    process.exitCode = 1;
  } finally {
    // The room that was made for the look goes again, so that the lobby is as it was.
    try { console.log('verification rooms removed: ' + await forgetRooms()); } catch (error) { console.log('verification rooms not removed: ' + error.message); }
    for (const child of children) child.kill('SIGTERM');
    if (env) await env.close();
    const name = origin ? 'release-production-site' + (realSkyWay ? '-skyway' : '') : realSkyWay ? 'release-production-check-skyway' : 'release-production-check';
    fs.writeFileSync(path.join(root, 'tmp', name + '.json'), JSON.stringify(results, null, 1));
    const failed = results.filter(r => !r.passed).length;
    console.log(results.length - failed + ' passed, ' + failed + ' failed');
    if (failed) process.exitCode = 1;
  }
})();
