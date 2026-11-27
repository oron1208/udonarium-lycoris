// A request to the developer APIs that is answered with 400 or 404 must not take the server down with it,
// and the page for an unknown path must still be served after it. Found on the public server on 2026-11-27:
// the answer was written and the handler went on to write the page over it.
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), { fixture, delay } = require('./lib/lightweight-browser.cjs');
process.env.DEV_ADMIN_TOKEN = 'test-token';
let env;
const results = [];
const record = (name, detail) => { results.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log('PASS', name, JSON.stringify(detail || '')); };
const call = (method, route, body, token = 'test-token') => fetch('http://127.0.0.1:' + env.port + route, {
  method, signal: AbortSignal.timeout(4000),
  headers: Object.assign(token ? { authorization: 'Bearer ' + token } : {}, body ? { 'content-type': 'application/json' } : {}),
  body: body ? JSON.stringify(body) : undefined,
});
const alive = async () => { try { return (await call('GET', '/v1/status')).status; } catch (_) { return 'dead'; } };
(async () => { try {
  env = await fixture('dist/release-20261127/browser', 'dev-api', 14879, 20079, { serverSource: path.join(root, 'unified-server.js') });
  assert.equal(await alive(), 200);
  const refused = [
    ['heartbeat-without-a-session', '/api/dev/client-heartbeat', {}],
    ['delete-room-without-a-room', '/api/dev/delete-room', {}],
    ['delete-room-for-the-lobby', '/api/dev/delete-room', { roomKey: 'lobby' }],
    ['announce-without-text', '/api/dev/announce', {}],
    ['delete-media-without-a-target', '/api/dev/delete-media', {}],
    ['delete-media-that-is-not-there', '/api/dev/delete-media', { kind: 'image', hash: 'a'.repeat(64) }],
    ['kick-without-a-target', '/api/dev/kick', {}],
  ];
  for (const [name, route, body] of refused) {
    const status = (await call('POST', route, body)).status;
    await delay(300);
    assert.ok(status === 400 || status === 404, name + ' ' + status);
    assert.equal(await alive(), 200, name + ' took the server down');
    record(name + '-is-refused-and-the-server-stays', { status });
  }
  assert.equal((await call('POST', '/api/dev/client-heartbeat', { sessionId: 'probe-session' })).status, 200);
  const listed = await (await call('GET', '/api/dev/peers')).json();
  assert.ok((listed.peers || []).some(peer => peer.source === 'http-heartbeat'), 'heartbeat kept');
  record('a-heartbeat-with-a-session-is-kept');
  const page = await call('GET', '/some/path/that/does/not/exist');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<app-root/);
  assert.equal(await alive(), 200);
  record('the-page-for-an-unknown-path-is-still-served');
  assert.equal((await call('GET', '/api/dev/peers', null, 'wrong-token')).status, 403);
  assert.equal(await alive(), 200);
  record('a-wrong-token-is-refused-and-the-server-stays');
} catch (e) { results.push({ name: 'FAIL', error: e.stack }); console.error(e.stack); process.exitCode = 1; }
finally {
  if (env) await env.close();
  fs.mkdirSync(path.join(root, 'tmp/server-dev-api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/server-dev-api/results.json'), JSON.stringify(results, null, 1));
  console.log(results.filter(r => r.passed).length + ' passed, ' + results.filter(r => !r.passed).length + ' failed');
} })();
