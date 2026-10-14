// ===== Particle System =====
(function() {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * w;
      this.y = Math.random() * h;
      this.size = Math.random() * 2 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.3;
      this.speedY = (Math.random() - 0.5) * 0.3;
      this.opacity = Math.random() * 0.5 + 0.1;
      this.color = Math.random() > 0.4
        ? `rgba(230, 57, 70, ${this.opacity})`
        : `rgba(200, 30, 30, ${this.opacity})`;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      if (this.x < 0 || this.x > w || this.y < 0 || this.y > h) this.reset();
    }
    draw() {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(Math.random() * Math.PI);
      ctx.beginPath();
      // 花びらっぽい楕円形
      ctx.ellipse(0, 0, this.size * 1.8, this.size * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.restore();
    }
  }

  // Adjust count for performance
  const count = Math.min(80, Math.floor((w * h) / 15000));
  for (let i = 0; i < count; i++) particles.push(new Particle());

  function animate() {
    ctx.clearRect(0, 0, w, h);
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animate);
  }
  animate();
})();

// ===== Nav Scroll Effect =====
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 50);
});

// ===== Mobile Menu =====
const hamburger = document.getElementById('hamburger');
const navLinks = document.querySelector('.nav-links');
if (hamburger && navLinks) {
  hamburger.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });
  // Close on link click
  navLinks.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}

// ===== Update Timeline Archive =====
const updateTimeline = document.querySelector('#updates .timeline');
if (updateTimeline) {
  const visibleCount = 4;
  const items = Array.from(updateTimeline.querySelectorAll(':scope > .timeline-item'));
  if (items.length > visibleCount) {
    const archive = document.createElement('details');
    archive.className = 'timeline-archive';
    const summary = document.createElement('summary');
    summary.textContent = `過去のアップデート履歴を表示（${items.length - visibleCount}件）`;
    const archiveList = document.createElement('div');
    archiveList.className = 'timeline timeline-archive-list';
    items.slice(visibleCount).forEach(item => archiveList.appendChild(item));
    archive.append(summary, archiveList);
    updateTimeline.after(archive);
    archive.addEventListener('toggle', () => {
      summary.textContent = archive.open
        ? '過去のアップデート履歴を閉じる'
        : `過去のアップデート履歴を表示（${items.length - visibleCount}件）`;
    });
  }
}

// ===== Scroll Animations =====
const observerOptions = { threshold: 0.08, rootMargin: '0px 0px -10px 0px' };
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      const delay = Number(entry.target.dataset.delay || 0);
      setTimeout(() => {
        entry.target.classList.add('visible');
      }, delay);
      observer.unobserve(entry.target);
    }
  });
}, observerOptions);

document.querySelectorAll('.fade-in, .fade-up').forEach((el, i) => {
  el.dataset.delay = Math.min(i * 25, 160);
  observer.observe(el);
});

// ===== Smooth Scroll =====
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ===== Scroll Hint Fade =====
const scrollHint = document.querySelector('.scroll-hint');
window.addEventListener('scroll', () => {
  if (scrollHint) {
    const opacity = Math.max(0, 1 - window.scrollY / 300);
    scrollHint.style.opacity = opacity;
  }
});
