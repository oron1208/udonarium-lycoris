'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lzbase62 = require('lzbase62');
const { WebSocketServer } = require('./signaling-server/node_modules/ws');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}
const PORT = Number(process.env.PORT || 12081);
const WEB_ROOT = path.join(__dirname, 'dist', 'udonarium-lycoris');
const DATA_ROOT = path.join(__dirname, 'data', 'rooms');
const MEDIA_ROOT = path.join(__dirname, 'data', 'media');
const MEDIA_AUDIT_LOG = path.join(__dirname, 'data', 'media-audit.log');
const MAX_SIGNAL_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 100 * 1024 * 1024);
const HEARTBEAT_MS = 30000;
const SAVE_DEBOUNCE_MS = Number(process.env.ROOM_SAVE_DEBOUNCE_MS || 1000);
const SAVE_MAX_DEBOUNCE_MS = Number(process.env.ROOM_SAVE_MAX_DEBOUNCE_MS || 10000);
const EMPTY_ROOM_LOBBY_MS = Number(process.env.EMPTY_ROOM_LOBBY_MS || 5 * 60 * 1000);
const ROOM_GC_MS = Number(process.env.ROOM_GC_MS || 24 * 60 * 60 * 1000);
const ROOM_GC_INTERVAL_MS = Number(process.env.ROOM_GC_INTERVAL_MS || 60 * 60 * 1000);
const MEDIA_GC_MS = Number(process.env.MEDIA_GC_MS || 90 * 24 * 60 * 60 * 1000);
const MEDIA_GC_INTERVAL_MS = Number(process.env.MEDIA_GC_INTERVAL_MS || ROOM_GC_INTERVAL_MS);
const MEDIA_MAX_TOTAL_BYTES = Number(process.env.MEDIA_MAX_TOTAL_BYTES || 20 * 1024 * 1024 * 1024);
const MAX_ROOM_EVENTS = Number(process.env.MAX_ROOM_EVENTS || 5000);
const EVENTS_SNAPSHOT_THRESHOLD = Number(process.env.EVENTS_SNAPSHOT_THRESHOLD || 200);
const MIN_SNAPSHOT_SAVE_INTERVAL_MS = Number(process.env.MIN_SNAPSHOT_SAVE_INTERVAL_MS || 15000);
const MIN_SNAPSHOT_EVENT_ADVANCE = Number(process.env.MIN_SNAPSHOT_EVENT_ADVANCE || 100);
const DEV_ADMIN_TOKEN = process.env.DEV_ADMIN_TOKEN || '';
// When events since last snapshot exceed this, server requests snapshot save from clients
const ROOM_ID_PATTERN = /^(\w{6})(\w{3})(\w*)-(\w*)/i;
const MEDIA_HASH_PATTERN = /\b[a-f0-9]{64}\b/ig;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

const peers = new Map(); // peerId -> WebSocket
const roomStates = new Map(); // roomKey -> { roomKey, seq, events, updatedAt, saveTimer }
const devClientSessions = new Map(); // sessionId -> { sessionId, peerId, roomKey, ip, updatedAt }
let developerAnnouncements = [];
let developerAnnouncementSeq = 0;
const developerJoinTokens = new Map(); // token -> { roomId, roomName, digestPassword, roomChannelName, roomKey, expiresAt }
const developerDeletedRooms = new Map(); // roomKey -> expiresAt

let stats = {
  startedAt: new Date().toISOString(),
  connectionsTotal: 0,
  relayedSignals: 0,
  relayedDataMessages: 0,
  replayedDataMessages: 0,
  savedRooms: 0,
  savedMedia: 0,
  deletedMedia: 0,
  rejectedSignals: 0,
};

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(path.dirname(MEDIA_AUDIT_LOG), { recursive: true });
fs.mkdirSync(path.join(MEDIA_ROOT, 'image'), { recursive: true });
fs.mkdirSync(path.join(MEDIA_ROOT, 'audio'), { recursive: true });
loadRoomStates();
stats.savedMedia = countSavedMedia();

function getRoomKey(peerId) {
  const match = ROOM_ID_PATTERN.exec(String(peerId || ''));
  return match ? `room:${match[2]}:${match[3]}:${match[4] || ''}` : 'lobby';
}

function getRoomKeyFromRoomInfo(roomId, roomName, digestPassword) {
  if (!roomId) return 'lobby';
  return `room:${roomId}:${lzbase62.compress(String(roomName || ''))}:${digestPassword || ''}`;
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function roomFile(roomKey) {
  const safe = Buffer.from(roomKey).toString('base64url');
  return path.join(DATA_ROOT, `${safe}.json`);
}

function loadRoomStates() {
  for (const name of fs.readdirSync(DATA_ROOT)) {
    if (!name.endsWith('.json')) continue;
    try {
      const room = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, name), 'utf8'));
      if (!room || !room.roomKey || !Array.isArray(room.events)) continue;
      room.saveTimer = null;
      roomStates.set(room.roomKey, room);
    } catch (error) {
      console.warn('[storage] failed to load room file', name, error.message);
    }
  }
  stats.savedRooms = roomStates.size;
}

function getRoomState(roomKey) {
  if (!roomStates.has(roomKey)) {
    roomStates.set(roomKey, { roomKey, seq: 0, snapshotSeq: 0, snapshot: null, events: [], updatedAt: new Date().toISOString(), lastEmptyAt: null, saveTimer: null, firstDirtyAt: 0 });
    stats.savedRooms = roomStates.size;
  }
  const room = roomStates.get(roomKey);
  if (room.snapshotSeq == null) room.snapshotSeq = 0;
  if (!Array.isArray(room.events)) room.events = [];
  if (room.updatedAt == null) room.updatedAt = new Date().toISOString();
  if (room.lastEmptyAt === undefined) room.lastEmptyAt = null;
  return room;
}

function saveRoomStateSoon(roomKey) {
  const room = roomStates.get(roomKey);
  if (!room || roomKey === 'lobby') return;
  const now = Date.now();
  if (!room.firstDirtyAt) room.firstDirtyAt = now;
  if (now - room.firstDirtyAt >= SAVE_MAX_DEBOUNCE_MS) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    saveRoomState(roomKey);
    return;
  }
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveRoomState(roomKey), SAVE_DEBOUNCE_MS);
  room.saveTimer.unref?.();
}

function saveRoomState(roomKey, touchUpdatedAt = true) {
  const room = roomStates.get(roomKey);
  if (!room || roomKey === 'lobby') return;
  if (touchUpdatedAt) room.updatedAt = new Date().toISOString();
  const serializable = { roomKey: room.roomKey, seq: room.seq, snapshotSeq: room.snapshotSeq || 0, snapshot: room.snapshot || null, events: room.events, updatedAt: room.updatedAt, lastEmptyAt: room.lastEmptyAt || null };
  const tmp = `${roomFile(roomKey)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(serializable));
  fs.renameSync(tmp, roomFile(roomKey));
  room.saveTimer = null;
  room.firstDirtyAt = 0;
}

function appendRoomEvent(roomKey, event) {
  const room = getRoomState(roomKey);
  room.seq++;
  const stored = { seq: room.seq, at: Date.now(), ...event };
  room.events.push(stored);
  if (room.events.length > MAX_ROOM_EVENTS) room.events.splice(0, room.events.length - MAX_ROOM_EVENTS);
  room.updatedAt = new Date().toISOString();

  // Auto-request snapshot when events pile up past threshold
  const snapshotSeq = room.snapshotSeq || 0;
  const uncommitedEvents = room.seq - snapshotSeq;
  if (uncommitedEvents > EVENTS_SNAPSHOT_THRESHOLD) {
    requestSnapshotFromClients(roomKey);
  }

  saveRoomStateSoon(roomKey);
  return stored;
}

function allPeerIds() {
  const livePeerIds = Array.from(peers.keys());
  const liveRoomKeys = new Set(Array.from(peers.values()).map(ws => ws.roomKey).filter(roomKey => roomKey && roomKey !== 'lobby'));
  const now = Date.now();
  const recentEmptyRoomPeerIds = [];

  for (const room of roomStates.values()) {
    const roomKey = room.roomKey;
    if (!roomKey || roomKey === 'lobby' || liveRoomKeys.has(roomKey)) continue;
    if (!room.lastEmptyAt || now - Number(room.lastEmptyAt) > EMPTY_ROOM_LOBBY_MS) continue;
    const peerId = roomKeyToPlaceholderPeerId(roomKey);
    if (peerId) recentEmptyRoomPeerIds.push(peerId);
  }

  return livePeerIds.concat(recentEmptyRoomPeerIds).sort();
}

function roomKeyToPlaceholderPeerId(roomKey) {
  const match = /^room:([^:]+):([^:]*):(.*)$/.exec(roomKey || '');
  if (!match) return null;
  return `000000${match[1]}${match[2]}-${match[3] || ''}`;
}

function requestSnapshotFromClients(roomKey) {
  // Throttle: only request once per 5 seconds per room
  const room = getRoomState(roomKey);
  if (room._lastSnapshotRequestAt && Date.now() - room._lastSnapshotRequestAt < 5000) return;
  room._lastSnapshotRequestAt = Date.now();
  console.log(`[relay] requesting snapshot save room=${roomKey} seq=${room.seq} snapshotSeq=${room.snapshotSeq || 0} eventsBehind=${room.seq - (room.snapshotSeq || 0)}`);
  // Ask one most-up-to-date connected client. Asking everyone causes multiple huge
  // snapshot uploads and then repeated processing under load.
  let bestTarget = null;
  for (const target of peers.values()) {
    if (target.roomKey !== roomKey || target.readyState !== target.OPEN) continue;
    if (!bestTarget || Number(target.lastSeq || 0) > Number(bestTarget.lastSeq || 0)) bestTarget = target;
  }
  if (bestTarget) send(bestTarget, { type: 'snapshot-save-request', roomKey, seq: room.seq });
}

function activePeerCountInRoom(roomKey) {
  let count = 0;
  for (const peer of peers.values()) if (peer.roomKey === roomKey) count++;
  return count;
}

function markRoomEmptyIfNeeded(roomKey) {
  if (!roomKey || roomKey === 'lobby' || activePeerCountInRoom(roomKey) > 0) return;
  const room = getRoomState(roomKey);
  room.lastEmptyAt = Date.now();
  saveRoomState(roomKey, false);
}

function cleanupOldRooms() {
  const now = Date.now();
  for (const [roomKey, room] of roomStates.entries()) {
    if (!roomKey || roomKey === 'lobby' || activePeerCountInRoom(roomKey) > 0) continue;
    const updatedAtMs = Date.parse(room.updatedAt || '');
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs <= ROOM_GC_MS) continue;

    if (room.saveTimer) clearTimeout(room.saveTimer);
    roomStates.delete(roomKey);
    try {
      fs.unlinkSync(roomFile(roomKey));
      console.log(`[storage] deleted stale room=${roomKey}`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[storage] failed to delete stale room', roomKey, error.message);
    }
  }
  stats.savedRooms = roomStates.size;
}

function collectReferencedMediaHashes() {
  const hashes = new Set();
  for (const room of roomStates.values()) {
    if (!room || room.roomKey === 'lobby') continue;

    // Room snapshots/events store image/audio identifiers as plain strings.
    // Server media identifiers are SHA-256 hex hashes, so scan serialized room state.
    const text = JSON.stringify({ snapshot: room.snapshot || null, events: room.events || [] });
    let match;
    MEDIA_HASH_PATTERN.lastIndex = 0;
    while ((match = MEDIA_HASH_PATTERN.exec(text))) hashes.add(match[0].toLowerCase());
  }
  return hashes;
}

function countSavedMedia() {
  let count = 0;
  for (const kind of ['image', 'audio']) {
    const dir = path.join(MEDIA_ROOT, kind);
    try {
      for (const name of fs.readdirSync(dir)) if (/^[a-f0-9]{64}$/i.test(name)) count++;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[media-gc] failed to count media', kind, error.message);
    }
  }
  return count;
}

function safeReadMediaMeta(kind, hash) {
  try {
    const meta = JSON.parse(fs.readFileSync(mediaMetaPath(kind, hash), 'utf8'));
    return meta && typeof meta === 'object' ? meta : {};
  } catch (_) {
    return {};
  }
}

function appendMediaAudit(action, detail = {}) {
  const entry = { at: new Date().toISOString(), action, ...detail };
  try {
    fs.appendFileSync(MEDIA_AUDIT_LOG, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.warn('[media-audit] failed to write log', error.message);
  }
  return entry;
}

function collectMediaReferences() {
  const references = new Map();
  for (const room of roomStates.values()) {
    if (!room || room.roomKey === 'lobby') continue;
    const text = JSON.stringify({ snapshot: room.snapshot || null, events: room.events || [] });
    const seenInRoom = new Set();
    let match;
    MEDIA_HASH_PATTERN.lastIndex = 0;
    while ((match = MEDIA_HASH_PATTERN.exec(text))) seenInRoom.add(match[0].toLowerCase());
    for (const hash of seenInRoom) {
      if (!references.has(hash)) references.set(hash, []);
      references.get(hash).push({
        roomKey: room.roomKey,
        seq: room.seq || 0,
        snapshotSeq: room.snapshotSeq || 0,
        updatedAt: room.updatedAt || null,
        activePeers: activePeerCountInRoom(room.roomKey),
      });
    }
  }
  return references;
}

function readMediaAuditLogs(limit = 200, filter = {}) {
  let text = '';
  try {
    text = fs.readFileSync(MEDIA_AUDIT_LOG, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[media-audit] failed to read log', error.message);
    return [];
  }
  const kind = filter.kind || '';
  const hash = filter.hash || '';
  const max = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const lines = text.trim().split('\n').filter(Boolean).slice(-max * 4);
  const logs = [];
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (kind && item.kind !== kind) continue;
      if (hash && item.hash !== hash) continue;
      logs.push(item);
    } catch (_) { }
  }
  return logs.slice(-max).reverse();
}

function collectMediaEntries() {
  const entries = [];
  const references = collectMediaReferences();
  for (const kind of ['image', 'audio']) {
    const dir = path.join(MEDIA_ROOT, kind);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[media-gc] failed to read media dir', kind, error.message);
      continue;
    }

    for (const name of names) {
      if (!/^[a-f0-9]{64}$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        const hash = name.toLowerCase();
        const meta = safeReadMediaMeta(kind, hash);
        const refs = references.get(hash) || [];
        entries.push({
          kind,
          hash,
          file,
          metaFile: `${file}.json`,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          atimeMs: stat.atimeMs,
          name: meta.name || hash,
          type: meta.type || '',
          bytes: Number(meta.bytes || stat.size),
          updatedAt: meta.updatedAt || null,
          createdAt: meta.createdAt || meta.updatedAt || null,
          uploadedFrom: meta.uploadedFrom || '',
          userAgent: meta.userAgent || '',
          referenced: refs.length > 0,
          references: refs,
        });
      } catch (error) {
        if (error.code !== 'ENOENT') console.warn('[media-gc] failed to stat media', file, error.message);
      }
    }
  }
  return entries;
}

function deleteMediaEntry(entry, reason) {
  try {
    const meta = safeReadMediaMeta(entry.kind, entry.hash);
    fs.unlinkSync(entry.file);
    fs.rmSync(entry.metaFile, { force: true });
    appendMediaAudit('delete', { kind: entry.kind, hash: entry.hash, reason, name: meta.name || entry.name || entry.hash, bytes: entry.size || meta.bytes || 0 });
    console.log(`[media-gc] deleted ${reason} ${entry.kind} hash=${entry.hash}`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[media-gc] failed to delete media', entry.file, error.message);
    return false;
  }
}

function cleanupMediaCapacity(entries, referenced) {
  if (!Number.isFinite(MEDIA_MAX_TOTAL_BYTES) || MEDIA_MAX_TOTAL_BYTES <= 0) return 0;
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes <= MEDIA_MAX_TOTAL_BYTES) return 0;
  let deleted = 0;
  const oldestFirst = entries.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
  const passes = [
    { reason: 'capacity-unreferenced', allow: entry => !referenced.has(entry.hash) },
    { reason: 'capacity-oldest', allow: () => true },
  ];
  for (const pass of passes) {
    for (const entry of oldestFirst) {
      if (totalBytes <= MEDIA_MAX_TOTAL_BYTES) return deleted;
      if (!pass.allow(entry)) continue;
      if (!fs.existsSync(entry.file)) continue;
      if (deleteMediaEntry(entry, pass.reason)) {
        totalBytes -= entry.size;
        deleted++;
      }
    }
  }
  return deleted;
}

function cleanupUnreferencedMedia() {
  const referenced = collectReferencedMediaHashes();
  const now = Date.now();
  let deleted = 0;

  const entries = collectMediaEntries();
  for (const entry of entries) {
    if (referenced.has(entry.hash)) continue;
    const ageMs = now - entry.mtimeMs;
    if (ageMs <= MEDIA_GC_MS) continue;
    if (deleteMediaEntry(entry, 'expired-unreferenced')) deleted++;
  }

  deleted += cleanupMediaCapacity(entries, referenced);

  if (deleted > 0) stats.deletedMedia += deleted;
  stats.savedMedia = countSavedMedia();
}

// ===== Audio Library API =====
const AUDIO_LIBRARY_ROOT = path.join(__dirname, 'audio-library');
let audioLibraryCache = null;
let audioLibraryCacheTime = 0;
const AUDIO_LIBRARY_CACHE_TTL = 5 * 60 * 1000; // 5分キャッシュ

function buildAudioLibraryIndex() {
  const tracks = [];
  let categories = [];
  try {
    categories = fs.readdirSync(AUDIO_LIBRARY_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[audio-library] failed to read root', error.message);
    return { tracks: [] };
  }

  for (const category of categories) {
    const catDir = path.join(AUDIO_LIBRARY_ROOT, category);
    // meta.jsonがあれば読み込む
    let meta = {};
    const metaPath = path.join(catDir, 'meta.json');
    try {
      if (fs.existsSync(metaPath)) {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (Array.isArray(meta)) {
          // 配列形式の場合はオブジェクトに変換
          const obj = {};
          for (const item of meta) {
            if (item.file) obj[item.file] = item;
          }
          meta = obj;
        }
      }
    } catch (error) {
      console.warn('[audio-library] failed to read meta.json', category, error.message);
    }

    // ディレクトリ内の音声ファイルをスキャン
    let files = [];
    try {
      files = fs.readdirSync(catDir).filter(f => /\.(mp3|ogg|wav|m4a|aac|flac)$/i.test(f));
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[audio-library] failed to read category dir', category, error.message);
      continue;
    }

    for (const file of files) {
      const m = meta[file] || {};
      const id = m.id || `${category}-${path.parse(file).name}`;
      const name = m.name || path.parse(file).name;
      const duration = m.duration || null;
      tracks.push({
        id,
        name,
        category: m.category || category,
        url: `/audio-library/${category}/${file}`,
        duration,
      });
    }
  }

  console.log(`[audio-library] index built: ${tracks.length} tracks, ${categories.length} categories`);
  return { tracks };
}

function handleAudioLibraryList(req, res) {
  const now = Date.now();
  if (audioLibraryCache && now - audioLibraryCacheTime < AUDIO_LIBRARY_CACHE_TTL) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(JSON.stringify(audioLibraryCache));
    return;
  }
  audioLibraryCache = buildAudioLibraryIndex();
  audioLibraryCacheTime = now;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(JSON.stringify(audioLibraryCache));
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message, predicate = () => true) {
  for (const ws of peers.values()) {
    if (ws.readyState === ws.OPEN && predicate(ws)) send(ws, message);
  }
}

function broadcastPeerList() {
  const list = allPeerIds();
  for (const ws of peers.values()) send(ws, { type: 'peers', peers: list });
}

function unregister(ws) {
  const previousRoomKey = ws.roomKey;
  if (ws.peerId && peers.get(ws.peerId) === ws) {
    peers.delete(ws.peerId);
    ws.peerId = null;
    ws.roomKey = null;
    markRoomEmptyIfNeeded(previousRoomKey);
    broadcastPeerList();
  }
}

function register(ws, id, sinceSeq = 0) {
  if (!id || typeof id !== 'string' || id.length > 512) {
    send(ws, { type: 'error', errorType: 'invalid-id', message: 'Peer id is required' });
    return;
  }

  const existing = peers.get(id);
  if (existing && existing !== ws && existing.readyState === existing.OPEN) existing.close(4000, 'replaced by reconnect');

  unregister(ws);
  ws.peerId = id;
  ws.roomKey = getRoomKey(id);
  ws.lastSeq = Number(sinceSeq || 0);
  if (ws.roomKey && ws.roomKey !== 'lobby') getRoomState(ws.roomKey).lastEmptyAt = null;
  peers.set(id, ws);
  console.log(`[relay] register peer=${id} room=${ws.roomKey} since=${ws.lastSeq} peers=${peers.size}`);
  send(ws, { type: 'registered', id });
  sendRoomSnapshot(ws, ws.lastSeq);
  broadcastPeerList();
}

function sendRoomSnapshot(ws, sinceSeq = 0) {
  if (!ws.roomKey || ws.roomKey === 'lobby') return;
  const room = getRoomState(ws.roomKey);
  const since = Number(sinceSeq || 0);
  const snapshotSeq = room.snapshotSeq || 0;
  const includeSnapshot = !!room.snapshot && (!since || since < snapshotSeq);
  const baseSeq = Math.max(since, snapshotSeq);
  const events = room.events.filter(event => event.seq > baseSeq && event.from !== ws.peerId && !event.to);
  if (!includeSnapshot && events.length < 1) return;
  stats.replayedDataMessages += events.length;
  console.log(`[relay] send snapshot room=${ws.roomKey} to=${ws.peerId} since=${sinceSeq} seq=${room.seq} snapshotSeq=${snapshotSeq} snapshot=${includeSnapshot ? 'yes' : 'no'} events=${events.length}`);
  send(ws, { type: 'room-snapshot', roomKey: ws.roomKey, seq: room.seq, snapshotSeq, snapshot: includeSnapshot ? room.snapshot : null, events });
}

function broadcastRoomSnapshot(roomKey) {
  if (!roomKey || roomKey === 'lobby') return;
  const room = roomStates.get(roomKey);
  if (!room || !room.snapshot) return;
  for (const target of peers.values()) {
    if (target.readyState === target.OPEN && target.roomKey === roomKey) {
      send(target, { type: 'room-snapshot', roomKey, seq: room.seq, snapshotSeq: room.snapshotSeq || 0, snapshot: room.snapshot, events: [] });
    }
  }
}

function saveSnapshot(ws, message) {
  if (!ws.peerId || !ws.roomKey || ws.roomKey === 'lobby') {
    send(ws, { type: 'error', errorType: 'not-in-room', message: 'Join a room before snapshot-save' });
    return;
  }
  const room = getRoomState(ws.roomKey);
  const oldCount = room.snapshot && room.snapshot.data && Array.isArray(room.snapshot.data.objects) ? room.snapshot.data.objects.length : 0;
  const newCount = message.snapshot && Array.isArray(message.snapshot.objects) ? message.snapshot.objects.length : 0;

  // A partially-synced browser can otherwise overwrite the canonical room snapshot.
  // That is especially dangerous after a long session because old event history has
  // already been compacted into the snapshot. Reject obviously regressive snapshots
  // and keep the previous full snapshot + following events as the recovery base.
  if (oldCount >= 50 && newCount > 0 && newCount < Math.floor(oldCount * 0.85)) {
    console.warn(`[relay] reject snapshot room=${ws.roomKey} from=${ws.peerId} objects=${newCount} previous=${oldCount} seq=${room.seq}`);
    send(ws, { type: 'snapshot-rejected', seq: room.seq, snapshotSeq: room.snapshotSeq || 0, reason: 'object-count-regressed', objects: newCount, previousObjects: oldCount });
    return;
  }

  const now = Date.now();
  const currentBehind = room.seq - (room.snapshotSeq || 0);
  if (room.snapshot && currentBehind < MIN_SNAPSHOT_EVENT_ADVANCE && room.lastSnapshotSavedAt && now - room.lastSnapshotSavedAt < MIN_SNAPSHOT_SAVE_INTERVAL_MS) {
    send(ws, { type: 'snapshot-ack', seq: room.seq, snapshotSeq: room.snapshotSeq || 0 });
    return;
  }

  room.seq += 1;
  room.snapshotSeq = room.seq;
  room.lastSnapshotSavedAt = now;
  room.snapshot = { at: now, from: ws.peerId, data: message.snapshot };
  room.events = room.events.filter(event => event.seq > room.snapshotSeq);
  room.updatedAt = new Date().toISOString();
  console.log(`[relay] save snapshot room=${ws.roomKey} from=${ws.peerId} seq=${room.seq} objects=${newCount} previous=${oldCount}`);
  saveRoomStateSoon(ws.roomKey);
  send(ws, { type: 'snapshot-ack', seq: room.seq, snapshotSeq: room.snapshotSeq });
  // Do not broadcast the full snapshot to already-connected peers. They already
  // receive live relay events; broadcasting 2000+ objects on every save freezes clients.
  // New/reconnecting peers fetch the canonical snapshot through sendRoomSnapshot().
}

function relay(ws, message) {
  if (!ws.peerId) {
    send(ws, { type: 'error', errorType: 'not-registered', message: 'Register before signaling' });
    return;
  }

  const target = peers.get(message.to);
  if (!target || target.readyState !== target.OPEN || target.roomKey !== ws.roomKey) {
    send(ws, { type: 'unavailable', id: message.to });
    return;
  }

  stats.relayedSignals++;
  send(target, { ...message, from: ws.peerId });
}

function relayData(ws, message) {
  if (!ws.peerId || !ws.roomKey || ws.roomKey === 'lobby') {
    send(ws, { type: 'error', errorType: 'not-in-room', message: 'Join a room before relay-data' });
    return;
  }

  if (message.to) {
    const target = peers.get(message.to);
    if (!target || target.readyState !== target.OPEN || target.roomKey !== ws.roomKey) {
      send(ws, { type: 'unavailable', id: message.to });
      return;
    }
    // Targeted relay-data is usually transient peer-to-peer payload such as image or
    // buffer sharing chunks. Persisting it bloats room history and makes late joins
    // replay huge obsolete payloads, so only broadcast room-state events are stored.
    const room = getRoomState(ws.roomKey);
    room.seq++;
    ws.lastSeq = room.seq;
    send(ws, { type: 'ack', seq: room.seq });
    stats.relayedDataMessages++;
    send(target, { type: 'relay-data', seq: room.seq, from: ws.peerId, to: message.to, container: message.container });
    return;
  }

  const stored = appendRoomEvent(ws.roomKey, { type: 'relay-data', from: ws.peerId, container: message.container });
  const outbound = { type: 'relay-data', seq: stored.seq, from: ws.peerId, container: message.container };
  ws.lastSeq = stored.seq;
  send(ws, { type: 'ack', seq: stored.seq });

  for (const target of peers.values()) {
    if (target !== ws && target.readyState === target.OPEN && target.roomKey === ws.roomKey) {
      stats.relayedDataMessages++;
      send(target, outbound);
    }
  }
}

function relayResyncRequest(ws) {
  if (!ws.peerId || !ws.roomKey || ws.roomKey === 'lobby') return;
  console.log(`[relay] resync request room=${ws.roomKey} from=${ws.peerId}`);
  for (const target of peers.values()) {
    if (target !== ws && target.readyState === target.OPEN && target.roomKey === ws.roomKey) {
      send(target, { type: 'resync-request', from: ws.peerId });
    }
  }
}

function serveStatic(req, res) {
  let rawPath;
  try {
    rawPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: malformed URI');
    return;
  }
  let urlPath = rawPath.replace(/^\/+/, '');
  if (!urlPath) urlPath = 'index.html';
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_ROOT, safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        fs.readFile(path.join(WEB_ROOT, 'index.html'), (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(indexData);
        });
      } else {
        console.error('[web] static read failed', filePath, err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Server error');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const immutable = /\.[a-f0-9]{8,}\./i.test(path.basename(filePath));
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    res.end(data);
  });
}

function serveDeveloperAdmin(req, res) {
  const filePath = path.join(__dirname, 'dev-admin.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end('Developer admin panel not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function mediaPath(kind, hash) {
  return path.join(MEDIA_ROOT, kind, hash);
}

function mediaMetaPath(kind, hash) {
  return `${mediaPath(kind, hash)}.json`;
}

function isValidMediaRequest(kind, hash) {
  return (kind === 'image' || kind === 'audio') && /^[a-f0-9]{64}$/i.test(hash || '');
}

function handleMediaGet(req, res, kind, hash) {
  if (!isValidMediaRequest(kind, hash)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Invalid media path');
    return;
  }
  const file = mediaPath(kind, hash);
  const metaFile = mediaMetaPath(kind, hash);
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end('Not found');
    return;
  }
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
    if (fs.existsSync(metaFile)) fs.utimesSync(metaFile, now, now);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[media] failed to touch media', kind, hash, error.message);
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) { }
  const contentType = meta.type || (kind === 'image' ? 'image/*' : 'audio/*');
  const fileName = meta.name || hash;
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-File-Name': encodeURIComponent(fileName),
  });
  fs.createReadStream(file).pipe(res);
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.socket.remoteAddress || '';
}

function getWebSocketIp(ws) {
  return ws.clientIp || (ws._socket && ws._socket.remoteAddress) || '';
}

function requireDeveloper(req, res) {
  if (!DEV_ADMIN_TOKEN) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: false, error: 'developer-mode-disabled', message: 'Set DEV_ADMIN_TOKEN to enable developer APIs.' }));
    return false;
  }

  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = String(req.headers['x-dev-admin-token'] || bearer || '');
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(DEV_ADMIN_TOKEN);
  if (tokenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(tokenBuffer, expectedBuffer)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    return false;
  }

  return true;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function getRoomDetails() {
  cleanupDeveloperDeletedRooms();
  const peerDetails = getPeerDetails();
  const activeCounts = new Map();
  const activeRooms = new Map();
  for (const peer of peerDetails) {
    const roomKey = peer.roomKey || 'lobby';
    if (developerDeletedRooms.has(roomKey)) continue;
    activeCounts.set(roomKey, (activeCounts.get(roomKey) || 0) + 1);
    if (!activeRooms.has(roomKey)) {
      activeRooms.set(roomKey, {
        roomKey,
        roomId: peer.roomId || '',
        roomName: peer.roomName || '',
        source: 'active-peer',
      });
    }
  }
  const rooms = Array.from(roomStates.values()).map(room => ({
    roomKey: room.roomKey,
    roomId: '',
    roomName: '',
    source: 'saved-state',
    peers: activeCounts.get(room.roomKey) || activePeerCountInRoom(room.roomKey),
    seq: room.seq,
    snapshotSeq: room.snapshotSeq || 0,
    hasSnapshot: !!room.snapshot,
    snapshotObjects: room.snapshot && room.snapshot.data && Array.isArray(room.snapshot.data.objects) ? room.snapshot.data.objects.length : 0,
    events: room.events.length,
    updatedAt: room.updatedAt,
    lastEmptyAt: room.lastEmptyAt || null,
    savePending: !!room.saveTimer,
  })).filter(room => !developerDeletedRooms.has(room.roomKey));
  const known = new Set(rooms.map(room => room.roomKey));
  for (const room of activeRooms.values()) {
    if (known.has(room.roomKey)) continue;
    rooms.push({
      ...room,
      peers: activeCounts.get(room.roomKey) || 0,
      seq: 0,
      snapshotSeq: 0,
      hasSnapshot: false,
      snapshotObjects: 0,
      events: 0,
      updatedAt: null,
      lastEmptyAt: null,
      savePending: false,
    });
  }
  return rooms.sort((a, b) => String(a.roomKey || '').localeCompare(String(b.roomKey || '')));
}

function publishDeveloperMessage(message) {
  const item = { id: ++developerAnnouncementSeq, createdAt: new Date().toISOString(), ...message };
  developerAnnouncements.push(item);
  if (developerAnnouncements.length > 50) developerAnnouncements = developerAnnouncements.slice(-50);
  broadcast(item);
  return item;
}

function getPeerDetails() {
  const wsPeers = Array.from(peers.values()).map(ws => ({
    source: 'websocket',
    peerId: ws.peerId || null,
    roomKey: ws.roomKey || null,
    ip: getWebSocketIp(ws),
    lastSeq: ws.lastSeq || 0,
    readyState: ws.readyState,
    isAlive: !!ws.isAlive,
    updatedAt: null,
  }));
  const now = Date.now();
  const httpPeers = [];
  for (const [sessionId, session] of devClientSessions.entries()) {
    if (now - Number(session.updatedAt || 0) > 30000) {
      devClientSessions.delete(sessionId);
      continue;
    }
    httpPeers.push({
      source: 'http-heartbeat',
      peerId: session.peerId || null,
      roomKey: session.roomKey || null,
      roomId: session.roomId || '',
      roomName: session.roomName || '',
      digestPassword: session.digestPassword || '',
      roomChannelName: session.roomChannelName || '',
      ip: session.ip || '',
      lastSeq: null,
      readyState: null,
      isAlive: true,
      updatedAt: new Date(session.updatedAt).toISOString(),
    });
  }
  return wsPeers.concat(httpPeers).sort((a, b) => String(a.roomKey || '').localeCompare(String(b.roomKey || '')) || String(a.peerId || '').localeCompare(String(b.peerId || '')));
}

async function handleDeveloperClientApi(req, res, requestPath) {
  if (req.method === 'GET' && requestPath.startsWith('/api/dev/join-room/')) {
    cleanupDeveloperJoinTokens();
    let token;
    try { token = decodeURIComponent(requestPath.slice('/api/dev/join-room/'.length)); } catch (e) { sendJson(res, 400, { ok: false, error: 'malformed-uri' }); return true; }
    const entry = developerJoinTokens.get(token);
    if (!entry) {
      sendJson(res, 404, { ok: false, error: 'join-token-not-found' });
      return true;
    }
    developerJoinTokens.delete(token);
    sendJson(res, 200, { ok: true, entry });
    return true;
  }

  if (req.method === 'GET' && requestPath === '/api/dev/announcements') {
    const url = new URL(req.url, 'http://localhost');
    const since = Number(url.searchParams.get('since') || 0);
    sendJson(res, 200, { ok: true, seq: developerAnnouncementSeq, announcements: developerAnnouncements.filter(item => item.id > since) });
    return true;
  }

  if (req.method === 'POST' && requestPath === '/api/dev/client-heartbeat') {
    try {
      const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
      const sessionId = String(body.sessionId || '').slice(0, 128);
      if (!sessionId) return sendJson(res, 400, { ok: false, error: 'session-id-required' });
      const peerId = String(body.peerId || '').slice(0, 512);
      const roomId = String(body.roomId || '').slice(0, 64);
      const roomName = String(body.roomName || '').slice(0, 256);
      const digestPassword = String(body.digestPassword || '').slice(0, 128);
      const roomChannelName = String(body.roomChannelName || '').slice(0, 256);
      const roomKey = roomId ? getRoomKeyFromRoomInfo(roomId, roomName, digestPassword) : (peerId ? getRoomKey(peerId) : 'lobby');
      devClientSessions.set(sessionId, {
        sessionId,
        peerId,
        roomId,
        roomName,
        digestPassword,
        roomChannelName,
        roomKey,
        ip: getClientIp(req),
        updatedAt: Date.now(),
      });
      sendJson(res, 200, { ok: true });
      return true;
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'bad-request' });
      return true;
    }
  }

  return false;
}

function cleanupDeveloperJoinTokens() {
  const now = Date.now();
  for (const [token, entry] of developerJoinTokens.entries()) {
    if (Number(entry.expiresAt || 0) <= now) developerJoinTokens.delete(token);
  }
}

function cleanupDeveloperDeletedRooms() {
  const now = Date.now();
  for (const [roomKey, expiresAt] of developerDeletedRooms.entries()) {
    if (Number(expiresAt || 0) <= now) developerDeletedRooms.delete(roomKey);
  }
}

function findActiveRoomAccess(roomKey) {
  const now = Date.now();
  for (const session of devClientSessions.values()) {
    if (now - Number(session.updatedAt || 0) > 30000) continue;
    if (session.roomKey !== roomKey) continue;
    if (!session.roomId || !session.roomName || !session.digestPassword || !session.roomChannelName) continue;
    return session;
  }
  return null;
}

function findActiveRoomPeerIds(roomKey) {
  const now = Date.now();
  const peerIds = new Set();
  for (const session of devClientSessions.values()) {
    if (now - Number(session.updatedAt || 0) > 30000) continue;
    if (session.roomKey !== roomKey) continue;
    if (session.peerId) peerIds.add(session.peerId);
  }
  for (const peer of peers.values()) {
    if (peer.roomKey !== roomKey) continue;
    if (peer.peerId) peerIds.add(peer.peerId);
  }
  return Array.from(peerIds);
}

function deleteRoom(roomKey) {
  const room = roomStates.get(roomKey);
  if (room && room.saveTimer) clearTimeout(room.saveTimer);
  roomStates.delete(roomKey);
  developerDeletedRooms.set(roomKey, Date.now() + Math.max(ROOM_GC_MS, 24 * 60 * 60 * 1000));
  for (const [sessionId, session] of devClientSessions.entries()) {
    if (session.roomKey === roomKey) devClientSessions.delete(sessionId);
  }
  try { fs.unlinkSync(roomFile(roomKey)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  stats.savedRooms = roomStates.size;
}

async function handleDeveloperApi(req, res, requestPath) {
  if (!requestPath.startsWith('/api/dev/')) return false;
  if (!requireDeveloper(req, res)) return true;

  try {
    if (req.method === 'GET' && requestPath === '/api/dev/status') {
      const mediaEntries = collectMediaEntries();
      sendJson(res, 200, {
        ok: true,
        enabled: true,
        clientIp: getClientIp(req),
        peers: getPeerDetails(),
        rooms: getRoomDetails(),
        media: {
          count: mediaEntries.length,
          bytes: mediaEntries.reduce((sum, entry) => sum + entry.size, 0),
          maxBytes: MEDIA_MAX_TOTAL_BYTES,
          gcAfterMs: MEDIA_GC_MS,
          deletedTotal: stats.deletedMedia,
        },
      });
      return true;
    }

    if (req.method === 'GET' && requestPath === '/api/dev/media') {
      const url = new URL(req.url, 'http://localhost');
      const kind = String(url.searchParams.get('kind') || 'all');
      const referenced = String(url.searchParams.get('referenced') || 'all');
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 500), 2000));
      let media = collectMediaEntries();
      if (kind === 'image' || kind === 'audio') media = media.filter(entry => entry.kind === kind);
      if (referenced === 'yes') media = media.filter(entry => entry.referenced);
      if (referenced === 'no') media = media.filter(entry => !entry.referenced);
      if (q) media = media.filter(entry => entry.hash.includes(q) || String(entry.name || '').toLowerCase().includes(q) || String(entry.type || '').toLowerCase().includes(q));
      media.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const totalBytes = media.reduce((sum, entry) => sum + entry.size, 0);
      sendJson(res, 200, { ok: true, media: media.slice(0, limit), total: media.length, totalBytes, logs: readMediaAuditLogs(80) });
      return true;
    }

    if (req.method === 'GET' && requestPath === '/api/dev/media-logs') {
      const url = new URL(req.url, 'http://localhost');
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 200), 1000));
      const kind = String(url.searchParams.get('kind') || '');
      const hash = String(url.searchParams.get('hash') || '').toLowerCase();
      sendJson(res, 200, { ok: true, logs: readMediaAuditLogs(limit, { kind, hash }) });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/delete-media') {
      const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
      const kind = String(body.kind || '');
      const hash = String(body.hash || '').toLowerCase();
      const reason = String(body.reason || 'admin-delete').slice(0, 256) || 'admin-delete';
      if (!isValidMediaRequest(kind, hash)) return sendJson(res, 400, { ok: false, error: 'invalid-media' });
      const file = mediaPath(kind, hash);
      if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: 'media-not-found' });
      const stat = fs.statSync(file);
      const entry = { kind, hash, file, metaFile: mediaMetaPath(kind, hash), size: stat.size };
      const deleted = deleteMediaEntry(entry, reason);
      if (deleted) stats.deletedMedia++;
      stats.savedMedia = countSavedMedia();
      sendJson(res, 200, { ok: true, deleted, kind, hash, reason });
      return true;
    }

    if (req.method === 'GET' && requestPath === '/api/dev/rooms') {
      sendJson(res, 200, { ok: true, rooms: getRoomDetails() });
      return true;
    }

    if (req.method === 'GET' && requestPath === '/api/dev/peers') {
      sendJson(res, 200, { ok: true, peers: getPeerDetails() });
      return true;
    }

    if (req.method === 'GET' && requestPath.startsWith('/api/dev/join-room/')) {
      cleanupDeveloperJoinTokens();
      let token;
      try { token = decodeURIComponent(requestPath.slice('/api/dev/join-room/'.length)); } catch (e) { sendJson(res, 400, { ok: false, error: 'malformed-uri' }); return true; }
      const entry = developerJoinTokens.get(token);
      if (!entry) {
        sendJson(res, 404, { ok: false, error: 'join-token-not-found' });
        return true;
      }
      developerJoinTokens.delete(token);
      sendJson(res, 200, { ok: true, entry });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/announce') {
      const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: 'text-required' });
      const announcement = publishDeveloperMessage({
        type: 'developer-announcement',
        text,
        level: body.level || 'warning',
        startsAt: body.startsAt || null,
      });
      sendJson(res, 200, { ok: true, delivered: peers.size + devClientSessions.size, announcement });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/create-join-room') {
      const body = JSON.parse(await readRequestBody(req) || '{}');
      const roomKey = String(body.roomKey || '').slice(0, 512);
      cleanupDeveloperDeletedRooms();
      if (developerDeletedRooms.has(roomKey)) {
        sendJson(res, 410, { ok: false, error: 'room-deleted', message: 'この部屋は開発者により削除済みです。' });
        return true;
      }
      const access = findActiveRoomAccess(roomKey);
      if (!access) {
        sendJson(res, 404, { ok: false, error: 'active-room-access-not-found', message: '入室できるアクティブな部屋情報が見つかりません。部屋に誰かが入っている必要があります。' });
        return true;
      }
      cleanupDeveloperJoinTokens();
      const token = crypto.randomBytes(24).toString('base64url');
      const entry = {
        roomKey: access.roomKey,
        roomId: access.roomId,
        roomName: access.roomName,
        digestPassword: access.digestPassword,
        roomChannelName: access.roomChannelName,
        peerIds: findActiveRoomPeerIds(roomKey),
        developerName: body.developerName || '開発者',
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
      developerJoinTokens.set(token, entry);
      const relativeUrl = `/?devJoin=${encodeURIComponent(token)}`;
      const origin = getRequestOrigin(req);
      sendJson(res, 200, { ok: true, token, url: origin ? `${origin}${relativeUrl}` : relativeUrl, expiresAt: new Date(entry.expiresAt).toISOString() });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/clear-announcement') {
      developerAnnouncements = [];
      const announcement = publishDeveloperMessage({
        type: 'developer-announcement-clear',
        clear: true,
      });
      sendJson(res, 200, { ok: true, delivered: peers.size + devClientSessions.size, announcement });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/delete-room') {
      const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
      const roomKey = String(body.roomKey || '');
      if (!roomKey || roomKey === 'lobby') return sendJson(res, 400, { ok: false, error: 'invalid-room-key' });
      let kicked = 0;
      for (const ws of peers.values()) {
        if (ws.roomKey === roomKey) {
          send(ws, { type: 'developer-announcement', level: 'danger', text: 'この部屋は開発者により削除されました。接続を終了します。', createdAt: new Date().toISOString() });
          ws.close(4001, 'room deleted by developer');
          kicked++;
        }
      }
      deleteRoom(roomKey);
      publishDeveloperMessage({
        type: 'developer-room-deleted',
        roomKey,
        level: 'danger',
        text: 'この部屋は開発者により削除されました。',
      });
      sendJson(res, 200, { ok: true, roomKey, kicked });
      return true;
    }

    if (req.method === 'POST' && requestPath === '/api/dev/kick') {
      const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
      const ip = String(body.ip || '').trim();
      const peerId = String(body.peerId || '').trim();
      const roomKey = String(body.roomKey || '').trim();
      if (!ip && !peerId && !roomKey) return sendJson(res, 400, { ok: false, error: 'target-required' });
      let kicked = 0;
      for (const ws of peers.values()) {
        const matchesIp = ip && getWebSocketIp(ws) === ip;
        const matchesPeer = peerId && ws.peerId === peerId;
        const matchesRoom = roomKey && ws.roomKey === roomKey;
        if (matchesIp || matchesPeer || matchesRoom) {
          send(ws, { type: 'developer-announcement', level: 'danger', text: '開発者によりサーバーから切断されました。', createdAt: new Date().toISOString() });
          ws.close(4002, 'kicked by developer');
          kicked++;
        }
      }
      sendJson(res, 200, { ok: true, kicked });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'not-found' });
    return true;
  } catch (error) {
    console.error('[dev-api] error', error);
    sendJson(res, 500, { ok: false, error: 'server-error', message: error.message });
    return true;
  }
}

async function handleSkyWayToken(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const appId = process.env.SKYWAY_APP_ID || process.env.SKYWAY_APPLICATION_ID || '';
  const secret = process.env.SKYWAY_SECRET_KEY || process.env.SKYWAY_SECRET || '';
  if (!appId || !secret) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'SkyWay credentials are not configured. Set SKYWAY_APP_ID and SKYWAY_SECRET_KEY.' }));
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(req, 64 * 1024) || '{}');
    const channelName = String(body.channelName || '');
    const peerId = String(body.peerId || '');
    if (!channelName || !peerId || channelName.includes('*') || peerId.includes('*')) throw new Error('invalid-argument');

    let tokenModule;
    try {
      tokenModule = require('@skyway-sdk/token');
    } catch (_) {
      tokenModule = require('./signaling-server/node_modules/@skyway-sdk/token');
    }
    const { SkyWayAuthToken, uuidV4, nowInSec } = tokenModule;
    const lobbySize = Number(process.env.SKYWAY_LOBBY_SIZE || 4);
    const lobbyName = `udonarium-lobby-*-of-${lobbySize}`;
    const props = {
      jti: uuidV4(),
      iat: nowInSec(),
      exp: nowInSec() + Number(process.env.SKYWAY_TOKEN_TTL_SEC || 60 * 60 * 24),
      scope: {
        appId,
        rooms: [
          {
            name: channelName,
            methods: ['create', 'updateMetadata', 'close'],
            member: { name: peerId, methods: ['publish', 'subscribe', 'updateMetadata'] },
          },
          {
            name: lobbyName,
            methods: ['create', 'updateMetadata', 'close'],
            member: { name: peerId, methods: ['publish', 'subscribe', 'updateMetadata'] },
          },
        ],
        turn: { enabled: true },
      },
      version: 3,
    };
    const token = new SkyWayAuthToken(props).encode(secret);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ token }));
  } catch (err) {
    console.error('[skyway] token error', err);
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Bad request' }));
  }
}

function handleMediaPut(req, res, kind, hash) {
  if (!isValidMediaRequest(kind, hash)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Invalid media path');
    req.resume();
    return;
  }

  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  if (!contentType.startsWith(`${kind}/`)) {
    res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Expected ${kind}/*`);
    req.resume();
    return;
  }

  const finalFile = mediaPath(kind, hash);
  const metaFile = mediaMetaPath(kind, hash);
  if (fs.existsSync(finalFile)) {
    const stat = fs.statSync(finalFile);
    const meta = safeReadMediaMeta(kind, hash);
    appendMediaAudit('dedupe', { kind, hash: hash.toLowerCase(), name: meta.name || hash, bytes: stat.size, ip: getClientIp(req) });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, exists: true, hash }));
    req.resume();
    return;
  }

  const tmp = `${finalFile}.${process.pid}.${Date.now()}.tmp`;
  const out = fs.createWriteStream(tmp);
  const sha = crypto.createHash('sha256');
  let bytes = 0;
  let rejected = false;

  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > MAX_MEDIA_BYTES && !rejected) {
      rejected = true;
      req.destroy();
      out.destroy();
      fs.rm(tmp, { force: true }, () => { });
      return;
    }
    sha.update(chunk);
  });

  req.pipe(out);

  req.on('error', () => {
    fs.rm(tmp, { force: true }, () => { });
  });

  out.on('error', error => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
    }
    fs.rm(tmp, { force: true }, () => { });
  });

  out.on('finish', () => {
    if (rejected) {
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Media too large');
      }
      return;
    }
    const actualHash = sha.digest('hex');
    if (actualHash.toLowerCase() !== hash.toLowerCase()) {
      fs.rm(tmp, { force: true }, () => { });
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Hash mismatch');
      return;
    }
    fs.renameSync(tmp, finalFile);
    let name;
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || hash)); } catch (e) { name = hash; }
    const now = new Date().toISOString();
    const meta = {
      hash,
      kind,
      type: contentType,
      name,
      bytes,
      createdAt: now,
      updatedAt: now,
      uploadedFrom: getClientIp(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    appendMediaAudit('save', { kind, hash: hash.toLowerCase(), name, bytes, type: contentType, ip: meta.uploadedFrom });
    console.log(`[media] save ${kind} hash=${hash} bytes=${bytes}`);
    res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, hash, bytes }));
  });
}

function createAppHandler() {
  return async (req, res) => {
  const requestPath = req.url.split('?')[0];
  if (await handleDeveloperClientApi(req, res, requestPath)) return;
  if (await handleDeveloperApi(req, res, requestPath)) return;

  if (requestPath === '/dev-admin' || requestPath === '/dev-admin/') {
    serveDeveloperAdmin(req, res);
    return;
  }

  if (requestPath === '/v1/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (requestPath === '/v1/skyway2023/token') {
    handleSkyWayToken(req, res);
    return;
  }

  const mediaMatch = requestPath.match(/^\/api\/media\/(image|audio)\/([a-f0-9]{64})$/i);
  if (mediaMatch) {
    const [, kind, hash] = mediaMatch;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (req.method === 'HEAD') req.method = 'GET';
      handleMediaGet(req, res, kind, hash);
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      handleMediaPut(req, res, kind, hash);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (req.url === '/health' || req.url === '/api/status') {
    const rooms = {};
    for (const ws of peers.values()) rooms[ws.roomKey || 'unregistered'] = (rooms[ws.roomKey || 'unregistered'] || 0) + 1;
    const roomDetails = Array.from(roomStates.values()).map(room => ({
      roomKey: room.roomKey,
      seq: room.seq,
      snapshotSeq: room.snapshotSeq || 0,
      hasSnapshot: !!room.snapshot,
      snapshotObjects: room.snapshot && room.snapshot.data && Array.isArray(room.snapshot.data.objects) ? room.snapshot.data.objects.length : 0,
      snapshotFrom: room.snapshot ? room.snapshot.from : null,
      events: room.events.length,
      updatedAt: room.updatedAt,
      lastEmptyAt: room.lastEmptyAt || null,
      savePending: !!room.saveTimer,
      dirtyForMs: room.firstDirtyAt ? Date.now() - room.firstDirtyAt : 0,
    }));
    const referencedMedia = collectReferencedMediaHashes();
    const media = {
      saved: countSavedMedia(),
      referenced: referencedMedia.size,
      gcAfterMs: MEDIA_GC_MS,
      deletedTotal: stats.deletedMedia,
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, peers: peers.size, rooms, roomDetails, media, ...stats }));
    return;
  }

  // ===== Audio Library API =====
  if (requestPath === '/api/audio-library' && req.method === 'GET') {
    handleAudioLibraryList(req, res);
    return;
  }

  // ===== Audio Library 静的配信 =====
  if (requestPath.startsWith('/audio-library/')) {
    const subPath = requestPath.substring('/audio-library/'.length);
    const safeSub = path.normalize(subPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(AUDIO_LIBRARY_ROOT, safeSub);
    // ディレクトリトラバーサル対策
    if (!filePath.startsWith(AUDIO_LIBRARY_ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
    return;
  }

  if (req.url === '/signaling') {
    res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Use WebSocket' }));
    return;
  }

  serveStatic(req, res);
};
}

const appHandler = createAppHandler();

// Try HTTPS with self-signed cert (SkyWay 2023 requires secure context for WebRTC)
const certPath = path.join(DATA_ROOT, '..', 'server-cert.pem');
const keyPath = path.join(DATA_ROOT, '..', 'server-key.pem');
let server;
let httpsPort = null;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  try {
    const sslOpts = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };
    server = https.createServer(sslOpts, appHandler);
    httpsPort = PORT;
    // Also start HTTP on PORT+1 for redirect/backward compat
    const httpServer = http.createServer(appHandler);
    httpServer.listen(PORT + 1, '0.0.0.0', () => {
      console.log(`  HTTP:      http://0.0.0.0:${PORT + 1}`);
    });
  } catch (e) {
    console.warn('Failed to read SSL certs, falling back to HTTP:', e.message);
    server = http.createServer(appHandler);
  }
} else {
  server = http.createServer(appHandler);
}

const wss = new WebSocketServer({ server, path: '/signaling', maxPayload: MAX_SIGNAL_BYTES });

wss.on('connection', (ws, req) => {
  ws.peerId = null;
  ws.roomKey = null;
  ws.lastSeq = 0;
  ws.isAlive = true;
  ws.clientIp = getClientIp(req);
  stats.connectionsTotal++;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      stats.rejectedSignals++;
      send(ws, { type: 'error', errorType: 'bad-json', message: 'Invalid JSON' });
      return;
    }

    switch (message.type) {
      case 'register': register(ws, message.id, message.sinceSeq); break;
      case 'list': send(ws, { type: 'peers', peers: allPeerIds() }); break;
      case 'sync-request': sendRoomSnapshot(ws, Number(message.sinceSeq || 0)); break;
      case 'resync-request': relayResyncRequest(ws); break;
      case 'snapshot-save': saveSnapshot(ws, message); break;
      case 'offer':
      case 'answer':
      case 'ice': relay(ws, message); break;
      case 'relay-data': relayData(ws, message); break;
      default:
        stats.rejectedSignals++;
        send(ws, { type: 'error', errorType: 'unknown-type', message: `Unknown type: ${message.type}` });
    }
  });

  ws.on('close', () => unregister(ws));
  ws.on('error', () => unregister(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      unregister(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

setInterval(cleanupOldRooms, ROOM_GC_INTERVAL_MS).unref();
setInterval(cleanupUnreferencedMedia, MEDIA_GC_INTERVAL_MS).unref();
cleanupOldRooms();
cleanupUnreferencedMedia();

process.on('SIGTERM', () => {
  for (const roomKey of roomStates.keys()) saveRoomState(roomKey, false);
  process.exit(0);
});

server.listen(httpsPort || PORT, '0.0.0.0', () => {
  const scheme = httpsPort ? 'https' : 'http';
  console.log(`Udonarium Lycoris self-hosted server on ${scheme}://0.0.0.0:${httpsPort || PORT}`);
  console.log(`  Web UI:    ${scheme}://0.0.0.0:${httpsPort || PORT}`);
  console.log(`  Relay WS:  ${scheme === 'https' ? 'wss' : 'ws'}://0.0.0.0:${httpsPort || PORT}/signaling`);
  console.log(`  Status:    ${scheme}://0.0.0.0:${httpsPort || PORT}/api/status`);
  console.log(`  Storage:   ${DATA_ROOT}`);
});
