'use strict';

/**
 * ユドナリウムリコリス 掲示板APIサーバー
 * /bb/api/posts/:category        GET    投稿一覧取得
 * /bb/api/posts/:category        POST   新規投稿
 * /bb/api/posts/:category/:id/replies  POST  返信
 *
 * データはJSONファイルに保存（軽量・外部DB不要）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BOARD_PORT || 12090);
const DATA_DIR = path.join(__dirname, 'data', 'board');
const MAX_NAME_LEN = 50;
const MAX_TITLE_LEN = 200;
const MAX_BODY_LEN = 5000;
const MAX_REPLY_LEN = 2000;
const MAX_POSTS_PER_CATEGORY = 500;

// カテゴリ whitelist
const VALID_CATEGORIES = ['request', 'bug'];

// --- Utilities ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getFilePath(category) {
  return path.join(DATA_DIR, `${category}.json`);
}

function loadPosts(category) {
  const file = getFilePath(category);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}

function savePosts(category, posts) {
  ensureDir(DATA_DIR);
  // 古いものから削除（上限超過時）
  if (posts.length > MAX_POSTS_PER_CATEGORY) {
    posts = posts.slice(-MAX_POSTS_PER_CATEGORY);
  }
  fs.writeFileSync(getFilePath(category), JSON.stringify(posts, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function escapeForLog(str) {
  return String(str).replace(/[\n\r]/g, ' ').slice(0, 100);
}

// 簡易スパム対策：同一IPから短時間に連続投稿を制限
const rateLimiter = new Map(); // ip -> [{ time, category }]
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分
const RATE_LIMIT_MAX = 5; // 1分間に5投稿まで

function checkRateLimit(ip) {
  const now = Date.now();
  const entries = rateLimiter.get(ip) || [];
  const recent = entries.filter(e => now - e.time < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push({ time: now });
  rateLimiter.set(ip, recent);
  return true;
}

// 定期的に古いエントリをクリーンアップ（メモリリーク対策）
setInterval(() => {
  const now = Date.now();
  for (const [ip, entries] of rateLimiter.entries()) {
    const recent = entries.filter(e => now - e.time < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      rateLimiter.delete(ip);
    } else {
      rateLimiter.set(ip, recent);
    }
  }
}, 5 * 60 * 1000).unref();

// --- HTTP Server ---

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 100 * 1024) { // 100KB limit
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  // ヘルスチェック
  if (pathname === '/bb/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  // ルーティング: /bb/api/posts/:category
  let m = pathname.match(/^\/bb\/api\/posts\/([a-z]+)$/);
  if (m) {
    const category = m[1];
    if (!VALID_CATEGORIES.includes(category)) {
      sendJson(res, 400, { error: 'Invalid category' });
      return;
    }

    if (method === 'GET') {
      const posts = loadPosts(category);
      sendJson(res, 200, posts);
      return;
    }

    if (method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
      if (!checkRateLimit(ip)) {
        sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment.' });
        return;
      }

      try {
        const raw = await readBody(req);
        const obj = JSON.parse(raw);

        const name = sanitize(obj.name, MAX_NAME_LEN) || '名無しさん';
        const title = sanitize(obj.title, MAX_TITLE_LEN);
        const body = sanitize(obj.body, MAX_BODY_LEN);

        if (!title || !body) {
          sendJson(res, 400, { error: 'Title and body are required' });
          return;
        }

        const posts = loadPosts(category);
        const post = {
          id: genId(),
          name,
          title,
          body,
          category,
          created_at: new Date().toISOString(),
          ip_hash: require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 8),
          replies: [],
        };
        posts.push(post);
        savePosts(category, posts);

        console.log(`[${category}] New post: "${escapeForLog(title)}" by ${escapeForLog(name)} (${ip})`);
        sendJson(res, 201, post);
      } catch (e) {
        console.error('Post error:', e.message);
        sendJson(res, 500, { error: 'Internal server error' });
      }
      return;
    }
  }

  // ルーティング: /bb/api/posts/:category/:id/replies
  m = pathname.match(/^\/bb\/api\/posts\/([a-z]+)\/([a-z0-9]+)\/replies$/);
  if (m && method === 'POST') {
    const category = m[1];
    const postId = m[2];
    if (!VALID_CATEGORIES.includes(category)) {
      sendJson(res, 400, { error: 'Invalid category' });
      return;
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    if (!checkRateLimit(ip)) {
      sendJson(res, 429, { error: 'Rate limit exceeded. Please wait a moment.' });
      return;
    }

    try {
      const raw = await readBody(req);
      const obj = JSON.parse(raw);

      const name = sanitize(obj.name, MAX_NAME_LEN) || '名無しさん';
      const body = sanitize(obj.body, MAX_REPLY_LEN);

      if (!body) {
        sendJson(res, 400, { error: 'Reply body is required' });
        return;
      }

      const posts = loadPosts(category);
      const post = posts.find(p => p.id === postId);
      if (!post) {
        sendJson(res, 404, { error: 'Post not found' });
        return;
      }

      const reply = {
        id: genId(),
        name,
        body,
        created_at: new Date().toISOString(),
        ip_hash: require('crypto').createHash('sha256').update(ip).digest('hex').slice(0, 8),
      };
      post.replies = post.replies || [];
      post.replies.push(reply);
      savePosts(category, posts);

      console.log(`[${category}] New reply on "${escapeForLog(post.title)}" by ${escapeForLog(name)} (${ip})`);
      sendJson(res, 201, reply);
    } catch (e) {
      console.error('Reply error:', e.message);
      sendJson(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  ensureDir(DATA_DIR);
  console.log(`Bulletin board API server running on http://127.0.0.1:${PORT}`);
  console.log(`  Data dir: ${DATA_DIR}`);
});
