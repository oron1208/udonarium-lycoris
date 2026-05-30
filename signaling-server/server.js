'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const port = Number(process.env.PORT || 18793);
const peers = new Map(); // peerId -> WebSocket

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peers: peers.size }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/signaling' });

wss.on('connection', ws => {
  ws.peerId = null;

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: 'error', errorType: 'bad-json', message: 'Invalid JSON' });
      return;
    }

    switch (message.type) {
      case 'register':
        register(ws, message.id);
        break;
      case 'list':
        send(ws, { type: 'peers', peers: Array.from(peers.keys()) });
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        relay(ws, message);
        break;
      default:
        send(ws, { type: 'error', errorType: 'unknown-type', message: `Unknown type: ${message.type}` });
    }
  });

  ws.on('close', () => unregister(ws));
  ws.on('error', () => unregister(ws));
});

function register(ws, id) {
  if (!id || typeof id !== 'string') {
    send(ws, { type: 'error', errorType: 'invalid-id', message: 'Peer id is required' });
    return;
  }
  const existing = peers.get(id);
  if (existing && existing !== ws && existing.readyState === existing.OPEN) {
    send(ws, { type: 'error', errorType: 'unavailable-id', message: 'Peer id is already used' });
    return;
  }
  unregister(ws);
  ws.peerId = id;
  peers.set(id, ws);
  send(ws, { type: 'registered', id });
  broadcastPeerList();
}

function unregister(ws) {
  if (ws.peerId && peers.get(ws.peerId) === ws) {
    peers.delete(ws.peerId);
    broadcastPeerList();
  }
  ws.peerId = null;
}

function relay(ws, message) {
  if (!ws.peerId) {
    send(ws, { type: 'error', errorType: 'not-registered', message: 'Register before signaling' });
    return;
  }
  const target = peers.get(message.to);
  if (!target || target.readyState !== target.OPEN) {
    send(ws, { type: 'unavailable', id: message.to });
    return;
  }
  send(target, { ...message, from: ws.peerId });
}

function broadcastPeerList() {
  const list = Array.from(peers.keys());
  for (const ws of peers.values()) send(ws, { type: 'peers', peers: list });
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

server.listen(port, () => {
  console.log(`Udonarium Lily signaling server listening on :${port}`);
});
