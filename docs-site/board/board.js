// API_BASE and CATEGORY are defined in the HTML page

let allPosts = [];

// --- Fetch posts ---
async function loadPosts() {
  const list = document.getElementById('postsList');
  try {
    const res = await fetch(`${API_BASE}/posts/${CATEGORY}`);
    if (!res.ok) throw new Error('API error');
    allPosts = await res.json();
    renderPosts();
  } catch (e) {
    list.innerHTML = '<p class="loading">読み込みに失敗しました。後でもう一度お試しください。</p>';
  }
}

function renderPosts() {
  const list = document.getElementById('postsList');
  if (allPosts.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>まだ投稿がありません。<br>最初の投稿をしてみましょう！</p></div>`;
    return;
  }
  list.innerHTML = allPosts.map(post => renderPostCard(post)).join('');
}

function renderPostCard(post) {
  const date = formatDate(post.created_at);
  const repliesHtml = post.replies && post.replies.length > 0
    ? `<div class="replies">${post.replies.map(r => renderReply(r)).join('')}</div>`
    : '';
  const replyForm = `
    <div class="reply-form">
      <button class="reply-toggle" onclick="toggleReply('${post.id}')">💬 返信</button>
      <div class="reply-form-inner" id="replyForm-${post.id}">
        <div class="form-row">
          <input type="text" id="replyName-${post.id}" placeholder="名無しさん" maxlength="50">
        </div>
        <div class="form-row">
          <textarea id="replyBody-${post.id}" placeholder="返信内容" maxlength="2000" rows="3"></textarea>
        </div>
        <button class="btn btn-primary" onclick="submitReply('${post.id}')">返信する</button>
      </div>
    </div>`;

  return `
    <div class="post-card fade-up">
      <div class="post-header">
        <div class="post-title">${escapeHtml(post.title)}</div>
        <div class="post-meta"><span class="post-name">${escapeHtml(post.name)}</span> · ${date}</div>
      </div>
      <div class="post-body">${escapeHtml(post.body)}</div>
      ${repliesHtml}
      ${replyForm}
    </div>`;
}

function renderReply(reply) {
  return `
    <div class="reply">
      <div class="reply-meta"><span class="post-name">${escapeHtml(reply.name)}</span> · ${formatDate(reply.created_at)}</div>
      <div class="reply-body">${escapeHtml(reply.body)}</div>
    </div>`;
}

// --- Submit post ---
async function submitPost() {
  const title = document.getElementById('inputTitle').value.trim();
  const body = document.getElementById('inputBody').value.trim();
  const name = document.getElementById('inputName').value.trim() || '名無しさん';

  if (!title || !body) {
    alert('タイトルと本文は必須です');
    return;
  }

  const btn = document.querySelector('#postForm .btn');
  btn.disabled = true;
  btn.textContent = '投稿中...';

  try {
    const res = await fetch(`${API_BASE}/posts/${CATEGORY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, title, body, category: CATEGORY })
    });
    if (!res.ok) throw new Error('API error');
    
    document.getElementById('inputTitle').value = '';
    document.getElementById('inputBody').value = '';
    document.getElementById('inputName').value = '';
    await loadPosts();
  } catch (e) {
    alert('投稿に失敗しました。後でもう一度お試しください。');
  } finally {
    btn.disabled = false;
    btn.textContent = CATEGORY === 'bug' ? '報告する' : '投稿する';
  }
}

// --- Submit reply ---
async function submitReply(postId) {
  const body = document.getElementById(`replyBody-${postId}`).value.trim();
  const name = document.getElementById(`replyName-${postId}`).value.trim() || '名無しさん';

  if (!body) {
    alert('返信内容を入力してください');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/posts/${CATEGORY}/${postId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, body })
    });
    if (!res.ok) throw new Error('API error');
    
    await loadPosts();
  } catch (e) {
    alert('返信に失敗しました。');
  }
}

// --- Toggle reply form ---
function toggleReply(postId) {
  const form = document.getElementById(`replyForm-${postId}`);
  form.classList.toggle('open');
}

// --- Helpers ---
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch {
    return iso;
  }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', loadPosts);

// Scroll animations for dynamically added elements
const boardObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      boardObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

// Observe new cards after render
const originalRender = renderPosts;
renderPosts = function() {
  originalRender();
  document.querySelectorAll('.post-card.fade-up:not(.visible)').forEach(el => boardObserver.observe(el));
};
