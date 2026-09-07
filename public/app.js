// ============================================================
// app.js — Main Application Logic
// LLM Usage Dashboard
// ============================================================
'use strict';

/* ─── Constants ─────────────────────────────────────────────────────────────── */
// Detect /quota/ subpath when served behind Nginx reverse proxy
const BASE_PATH    = window.location.pathname.startsWith('/quota') ? '/quota' : '';
const API_BASE     = window.location.origin + BASE_PATH;
const AITM_AUTH_URL = `${window.location.origin}/auth/login`; // AITM backend is always at domain root
const DIRECT_AUTH   = `${window.location.origin}/auth/login`;

/* ─── State ──────────────────────────────────────────────────────────────────── */
const state = {
  token:      null,
  user:       null,
  activePage: 'overview',
  charts:     {},
};

/* ─── Utility Functions ──────────────────────────────────────────────────────── */
function fmtTokens(n) {
  if (n === null || n === undefined) return '—';
  const num = Number(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function fmtCost(n, currency = 'IDR') {
  if (n === null || n === undefined) return '—';
  const num = parseFloat(n);
  return 'Rp ' + num.toLocaleString('id-ID', {
    minimumFractionDigits: num % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 6
  });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtLatency(ms) {
  if (!ms) return '—';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

function statusBadge(status) {
  const map = {
    HEALTHY:   ['badge-healthy',   '🟢', 'status_healthy'],
    WARNING:   ['badge-warning',   '🟡', 'status_warning'],
    CRITICAL:  ['badge-critical',  '🔴', 'status_critical'],
    EXHAUSTED: ['badge-exhausted', '⚫', 'status_exhausted'],
    NO_PLAN:   ['badge-no-plan',   '⚪', 'status_no_plan'],
    SUCCESS:   ['badge-success',   '✓', null],
    FAILED:    ['badge-failed',    '✗', null],
    REJECTED:  ['badge-rejected',  '⊘', null],
  };
  const [cls, icon, i18nKey] = map[status] || ['badge-no-plan', '?', null];
  const label = i18nKey ? t(i18nKey) : status;
  return `<span class="badge ${cls}">${icon} ${label}</span>`;
}

function sourceBadge(src) {
  const cls = { BACKEND: 'badge-backend', N8N: 'badge-n8n', GOCLAW: 'badge-goclaw' }[src] || 'badge-no-plan';
  return `<span class="badge ${cls}">${src}</span>`;
}

function progressBarClass(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'healthy';
}

/* ─── Toast ──────────────────────────────────────────────────────────────────── */
function showToast(message, type = 'success', duration = 3500) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✗', warning: '⚠️' };
  el.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => { el.style.animation = 'slideInRight 0.3s ease reverse'; setTimeout(() => el.remove(), 300); }, duration);
}

/* ─── Modal ──────────────────────────────────────────────────────────────────── */
const modal = {
  open(title, bodyHTML, footerHTML = '') {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHTML;
    document.getElementById('modal-footer').innerHTML = footerHTML;
    document.getElementById('modal-overlay').classList.add('open');
  },
  close() {
    document.getElementById('modal-overlay').classList.remove('open');
  },
};
document.getElementById('modal-close').addEventListener('click', modal.close);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') modal.close();
});

/* ─── API Client ─────────────────────────────────────────────────────────────── */
async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  if (res.status === 401) { handleLogout(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const GET    = (p)    => api('GET',    p);
const POST   = (p, b) => api('POST',   p, b);
const PATCH  = (p, b) => api('PATCH',  p, b);
const DEL    = (p)    => api('DELETE', p);

/* ─── Auth ───────────────────────────────────────────────────────────────────── */
// Login using AITM backend JWT
async function handleLogin(email, password) {
  let url = AITM_AUTH_URL;

  // Fallback for local development testing on port 3003
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    url = `${window.location.protocol}//${window.location.hostname}:3001/auth/login`;
  }

  let data;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed');
  } catch (err) {
    if (url.includes(':3001')) {
      // If port 3001 fails, try port 3000 as a last resort
      try {
        const fallbackUrl = `${window.location.protocol}//${window.location.hostname}:3000/auth/login`;
        const res = await fetch(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Login failed');
      } catch (err2) {
        throw new Error('Cannot reach AITM backend. Ensure it is running.');
      }
    } else {
      throw new Error(err.message || 'Cannot reach AITM backend.');
    }
  }

  const token = data.access_token;
  if (!token) throw new Error('No access token in response');

  // Decode payload
  const payload = JSON.parse(atob(token.split('.')[1]));
  if (!['ADMIN', 'HUMAN RESOURCES', 'HIRING MANAGER'].includes(payload.role)) {
    throw new Error('Access denied. This dashboard is for Admin, HR, and Hiring Managers only.');
  }

  state.token = token;
  state.user  = { id: payload.sub, email: payload.email, name: payload.name, role: payload.role };
  localStorage.setItem('llm_token', token);
  localStorage.setItem('llm_user',  JSON.stringify(state.user));
  showApp();
}

function handleLogout() {
  state.token = null;
  state.user  = null;
  localStorage.removeItem('llm_token');
  localStorage.removeItem('llm_user');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function restoreSession() {
  const token = localStorage.getItem('llm_token');
  const user  = localStorage.getItem('llm_user');
  if (!token || !user) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) { localStorage.clear(); return false; }
    state.token = token;
    state.user  = JSON.parse(user);
    return true;
  } catch { return false; }
}

/* ─── App Shell ──────────────────────────────────────────────────────────────── */
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderSidebar();
  renderUserCard();
  // ADMIN → admin overview, HR/HM → personal usage page
  const defaultPage = state.user?.role === 'ADMIN' ? 'overview' : 'my-usage';
  router.navigate(defaultPage);
}

function renderSidebar() {
  const isAdmin = state.user?.role === 'ADMIN';
  const nav = document.getElementById('sidebar-nav');
  const adminItems = isAdmin ? `
    <div class="sidebar-section">${t('section_admin')}</div>
    <button class="nav-item" data-page="overview">
      <span class="nav-icon">📊</span>${t('nav_overview')}
    </button>
    <button class="nav-item" data-page="users">
      <span class="nav-icon">👥</span>${t('nav_users')}
    </button>
    <button class="nav-item" data-page="events">
      <span class="nav-icon">📋</span>${t('nav_events')}
    </button>
    <button class="nav-item" data-page="workflows">
      <span class="nav-icon">⚙️</span>${t('nav_workflows')}
    </button>
    <button class="nav-item" data-page="plans">
      <span class="nav-icon">🔖</span>${t('nav_plans')}
    </button>
    <button class="nav-item" data-page="mappings">
      <span class="nav-icon">🗺️</span>${t('nav_mappings')}
    </button>
    <button class="nav-item" data-page="settings">
      <span class="nav-icon">🔧</span>${t('nav_settings')}
    </button>
  ` : '';

  nav.innerHTML = `
    ${adminItems}
    <div class="sidebar-section">${t('section_me')}</div>
    <button class="nav-item" data-page="my-usage">
      <span class="nav-icon">📈</span>${t('nav_my_usage')}
    </button>
    <button class="nav-item" data-page="my-events">
      <span class="nav-icon">🕐</span>${t('nav_my_events')}
    </button>
    <button class="nav-item" data-page="my-plan">
      <span class="nav-icon">📦</span>${t('nav_my_plan')}
    </button>
  `;

  nav.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => router.navigate(btn.dataset.page));
  });
}

function renderUserCard() {
  const u = state.user;
  if (!u) return;
  document.getElementById('user-name-display').textContent = u.name || u.email;
  document.getElementById('user-role-display').textContent = u.role || '';
  document.getElementById('user-avatar').textContent = (u.name || u.email || '?')[0].toUpperCase();
}

/* ─── Router ─────────────────────────────────────────────────────────────────── */
window.router = {
  current: null,
  navigate(page) {
    this.current = page;
    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });
    this.render();
  },
  render() {
    const page = this.current;
    const map = {
      'overview':  pages.overview,
      'users':     pages.users,
      'events':    pages.events,
      'workflows': pages.workflows,
      'plans':     pages.plans,
      'mappings':  pages.mappings,
      'settings':  pages.settings,
      'my-usage':  pages.myUsage,
      'my-events': pages.myEvents,
      'my-plan':   pages.myPlan,
    };
    const fn = map[page] || map['overview'];
    const titles = {
      overview: [t('page_overview'), t('page_overview_sub')],
      users:    [t('page_users'),    t('page_users_sub')],
      events:   [t('page_events'),   t('page_events_sub')],
      workflows:[t('nav_workflows'), ''],
      plans:    [t('page_plans'),    t('page_plans_sub')],
      mappings: [t('page_mappings'), t('page_mappings_sub')],
      settings: [t('page_settings'), t('page_settings_sub')],
      'my-usage':  [t('page_my_usage'),  t('page_my_usage_sub')],
      'my-events': [t('nav_my_events'),  ''],
      'my-plan':   [t('nav_my_plan'),    ''],
    };
    const [title, sub] = titles[page] || ['', ''];
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-sub').textContent = sub;
    fn();
  },
};

/* ─── Period Helpers ─────────────────────────────────────────────────────────── */
function getPeriod(preset = 'this_month') {
  const now = new Date();
  const p = {};
  switch (preset) {
    case 'today':
      p.from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      p.to   = now.toISOString(); break;
    case '7d':
      p.from = new Date(now - 7*86400000).toISOString();
      p.to   = now.toISOString(); break;
    case 'this_month':
      p.from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      p.to   = new Date(now.getFullYear(), now.getMonth()+1, 0, 23,59,59).toISOString(); break;
    case 'last_month':
      p.from = new Date(now.getFullYear(), now.getMonth()-1, 1).toISOString();
      p.to   = new Date(now.getFullYear(), now.getMonth(), 0, 23,59,59).toISOString(); break;
    case 'this_year':
      p.from = new Date(now.getFullYear(), 0, 1).toISOString();
      p.to   = now.toISOString(); break;
    default:
      p.from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      p.to   = now.toISOString();
  }
  return p;
}

function periodSelectorHTML(id = 'period', selected = 'this_month') {
  const opts = ['today','7d','this_month','last_month','this_year'];
  return `<select id="${id}" class="form-control" style="width:auto; padding:6px 28px 6px 10px; font-size:12px;">
    ${opts.map(o => `<option value="${o}" ${o===selected?'selected':''}>${t('period_'+o)}</option>`).join('')}
  </select>`;
}

/* ─── Charts ─────────────────────────────────────────────────────────────────── */
const CHART_PALETTE = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#14b8a6'];

function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

function createBarChart(canvasId, labels, datasets, opts = {}) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  state.charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: datasets.map((d, i) => ({
      backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] + 'cc',
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      borderWidth: 1, borderRadius: 4, ...d
    }))},
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } } },
        tooltip: { backgroundColor: '#0e1526', borderColor: '#1e293b', borderWidth: 1, titleColor: '#f1f5f9', bodyColor: '#94a3b8' },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#64748b', font: { size: 11 }, callback: v => fmtTokens(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
      ...opts,
    },
  });
}

function createLineChart(canvasId, labels, datasets) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  state.charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: datasets.map((d, i) => ({
      borderColor: CHART_PALETTE[i % CHART_PALETTE.length],
      backgroundColor: CHART_PALETTE[i % CHART_PALETTE.length] + '22',
      tension: 0.4, fill: true, pointRadius: 3, pointHoverRadius: 6, ...d
    }))},
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } } },
        tooltip: { backgroundColor: '#0e1526', borderColor: '#1e293b', borderWidth: 1, titleColor: '#f1f5f9', bodyColor: '#94a3b8' },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#64748b', font: { size: 11 }, callback: v => fmtTokens(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

function createDoughnutChart(canvasId, labels, data) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return;
  state.charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: CHART_PALETTE.slice(0, data.length).map(c => c + 'cc'), borderColor: CHART_PALETTE.slice(0, data.length), borderWidth: 1 }],
    },
    options: {
      responsive: true, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 }, boxWidth: 12, padding: 12 } },
        tooltip: { backgroundColor: '#0e1526', borderColor: '#1e293b', borderWidth: 1, titleColor: '#f1f5f9', bodyColor: '#94a3b8' },
      },
    },
  });
}

/* ─── Pages ──────────────────────────────────────────────────────────────────── */
const pages = {};

/* ── Overview ───────────────────────────────────────────────────────────────── */
pages.overview = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="stats-grid" id="stats-grid">
      ${Array(7).fill('<div class="stat-card"><div class="skeleton skeleton-card" style="height:70px"></div></div>').join('')}
    </div>
    <div class="charts-row">
      <div class="card"><div class="card-header"><div class="card-title">${t('chart_daily_trend')}</div>${periodSelectorHTML('overview-period')}</div>
        <div class="chart-container" style="height:220px"><canvas id="chart-trend"></canvas></div></div>
      <div class="card"><div class="card-header"><div class="card-title">${t('chart_by_source')}</div></div>
        <div class="chart-container" style="height:220px"><canvas id="chart-source"></canvas></div></div>
    </div>
    <div class="charts-row">
      <div class="card"><div class="card-header"><div class="card-title">${t('chart_by_feature')}</div></div>
        <div class="chart-container" style="height:220px"><canvas id="chart-feature"></canvas></div></div>
      <div class="card section">
        <div class="card-header"><div class="card-title">${t('chart_top_users')}</div></div>
        <div id="top-users-list"></div>
      </div>
    </div>
  `;

  document.getElementById('overview-period').addEventListener('change', async (e) => {
    await loadOverviewData(e.target.value);
  });

  await loadOverviewData('this_month');
};

async function loadOverviewData(preset = 'this_month') {
  const { from, to } = getPeriod(preset);
  try {
    const data = await GET(`/api/admin/overview?from=${from}&to=${to}`);
    if (!data) return;

    // Stats
    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat-card">
        <span class="stat-icon">🧮</span>
        <div class="stat-value">${fmtTokens(data.totalTokens)}</div>
        <div class="stat-label">${t('stat_total_tokens')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">💵</span>
        <div class="stat-value">${fmtCost(data.totalCost)}</div>
        <div class="stat-label">${t('stat_total_cost')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">✅</span>
        <div class="stat-value">${data.successfulRequests.toLocaleString()}</div>
        <div class="stat-label">${t('stat_successful')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">❌</span>
        <div class="stat-value">${data.failedRequests.toLocaleString()}</div>
        <div class="stat-label">${t('stat_failed')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">⊘</span>
        <div class="stat-value">${data.rejectedRequests.toLocaleString()}</div>
        <div class="stat-label">${t('stat_rejected')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">👤</span>
        <div class="stat-value">${data.activeUsers}</div>
        <div class="stat-label">${t('stat_active_users')}</div>
      </div>
      <div class="stat-card">
        <span class="stat-icon">🔴</span>
        <div class="stat-value">${data.exhaustedUsers}</div>
        <div class="stat-label">${t('stat_exhausted_users')}</div>
      </div>
    `;

    // Trend chart
    if (data.dailyTrend?.length) {
      createLineChart('chart-trend',
        data.dailyTrend.map(d => new Date(d.day).toLocaleDateString('en-GB', { day:'2-digit', month:'short' })),
        [{ label: t('stat_total_tokens'), data: data.dailyTrend.map(d => d.totalTokens) }]
      );
    }

    // Source donut
    if (data.bySource?.length) {
      createDoughnutChart('chart-source', data.bySource.map(d => d.source_service), data.bySource.map(d => d.totalTokens));
    }

    // Feature bar
    if (data.byFeature?.length) {
      createBarChart('chart-feature',
        data.byFeature.map(d => d.feature_name || 'unknown'),
        [{ label: t('stat_total_tokens'), data: data.byFeature.map(d => d.totalTokens) }],
        { indexAxis: 'y' }
      );
    }

    // Top users list
    const topList = document.getElementById('top-users-list');
    if (data.topUsers?.length) {
      topList.innerHTML = data.topUsers.map(u => {
        const pct = u.quotaTokens > 0 ? Math.min(100, Math.round((u.totalTokens / u.quotaTokens) * 100)) : 0;
        return `<div style="padding:8px 0; border-bottom:1px solid var(--border-subtle);">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <div>
              <div style="font-size:13px; font-weight:600;">${u.name}</div>
              <div style="font-size:11px; color:var(--text-muted);">${u.role}</div>
            </div>
            <div style="text-align:right; font-size:13px; font-weight:700;">${fmtTokens(u.totalTokens)}</div>
          </div>
          <div class="progress-wrap"><div class="progress-bar accent" style="width:${pct}%"></div></div>
        </div>`;
      }).join('');
    } else {
      topList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📊</div><p>${t('no_data')}</p></div>`;
    }
  } catch (err) {
    showToast(t('error_load'), 'error');
    console.error('[Overview]', err);
  }
}

/* ── Users & Quotas ──────────────────────────────────────────────────────────── */
pages.users = async function() {
  const content = document.getElementById('page-content');
  let search = '', quotaType = '', skip = 0, take = 20;

  content.innerHTML = `
    <div class="filters-bar" style="justify-content:space-between;">
      <div style="display:flex; gap:8px; align-items:center;">
        <input id="user-search" type="text" class="form-control" style="flex:1; max-width:300px;"
          placeholder="${t('search_placeholder')}" value="${search}" />
        <select id="user-quota-type" class="form-control" style="width:auto; padding:6px 28px 6px 10px; font-size:12px;">
          <option value="">${t('filter_quota_type')}</option>
          <option value="MONTHLY">${t('monthly')}</option>
          <option value="YEARLY">${t('yearly')}</option>
        </select>
        <button class="btn btn-ghost btn-sm" id="user-filter-btn">Filter</button>
      </div>
      <button class="btn btn-primary btn-sm" id="create-user-btn" onclick="showCreateUserModal(pages.users._reload)" style="gap:4px;">➕ Create User</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${t('col_user')}</th>
          <th>${t('col_role')}</th>
          <th>${t('col_plan')}</th>
          <th>${t('col_used')}</th>
          <th>${t('col_recurring_rem')}</th>
          <th>${t('col_bundle_rem')}</th>
          <th>${t('col_scout_hits')}</th>
          <th>${t('col_scout_cost')}</th>
          <th>${t('col_reset')}</th>
          <th>${t('col_status')}</th>
          <th>${t('col_actions')}</th>
        </tr></thead>
        <tbody id="users-tbody"><tr><td colspan="11" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table>
      <div class="pagination" id="users-pagination"></div>
    </div>
  `;

  // Create User button handler
  document.getElementById('create-user-btn').addEventListener('click', () => showCreateUserModal(loadUsers));

  async function loadUsers() {
    pages.users._reload = loadUsers; // expose for edit/delete callbacks
    const params = new URLSearchParams({ skip, take });
    if (search) params.set('search', search);
    if (quotaType) params.set('quotaType', quotaType);

    try {
      const data = await GET(`/api/admin/users?${params}`);
      if (!data) return;
      const tbody = document.getElementById('users-tbody');

      if (!data.items?.length) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:40px;"><div class="empty-state-icon">👥</div><p class="text-muted">${t('no_results')}</p></td></tr>`;
      } else {
        tbody.innerHTML = data.items.map(u => {
          const pct = u.quotaTokens > 0 ? Math.min(100, Math.round((u.usedRecurringTokens / u.quotaTokens) * 100)) : 0;
          return `<tr>
            <td>
              <div style="font-weight:600; font-size:13px;">${u.name}</div>
              <div class="text-muted text-xs">${u.email}</div>
            </td>
            <td><span class="text-sm text-secondary">${u.role}</span></td>
            <td><span style="font-size:12px;">${u.planName || '<span class="text-muted">—</span>'}</span>
                ${u.quotaType ? `<br><span class="text-xs text-muted">${t(u.quotaType.toLowerCase())}</span>` : ''}</td>
            <td>
              <div style="font-weight:600;">${fmtTokens(u.usedRecurringTokens)}</div>
              <div class="progress-wrap" style="width:90px; margin-top:4px;">
                <div class="progress-bar ${progressBarClass(pct)}" style="width:${pct}%"></div>
              </div>
            </td>
            <td style="font-size:12px;">${fmtTokens(u.remainingRecurringTokens)}</td>
            <td style="font-size:12px; color:${u.remainingBundleTokens > 0 ? 'var(--success)' : 'var(--text-muted)'};">${fmtTokens(u.remainingBundleTokens)}</td>
            <td style="font-size:12px;">${u.n8nScoutHitsMonth ?? '—'}</td>
            <td style="font-size:12px;">${fmtCost(u.n8nScoutCostMonth)}</td>
            <td style="font-size:12px;">${fmtDate(u.resetAt)}</td>
            <td>${statusBadge(u.status)}</td>
            <td>
              <div class="flex gap-2" style="flex-wrap:wrap;">
                <button class="btn btn-xs btn-outline" onclick="pages.users.viewDetail('${u.userId}')">${t('btn_view')}</button>
                <button class="btn btn-xs btn-ghost" onclick="pages.plans.showAssignModal('${u.userId}', '${u.name}')">${t('btn_assign_plan')}</button>
                <button class="btn btn-xs btn-ghost" onclick="pages.plans.showBundleModal('${u.userId}', '${u.name}')">${t('btn_add_bundle')}</button>
                <button class="btn btn-xs btn-ghost" style="color:var(--warning);" onclick="showEditUserModal('${u.userId}', '${u.name}', '${u.email}', '${u.role}', pages.users._reload)">✏️</button>
                <button class="btn btn-xs btn-ghost" style="color:var(--danger);" onclick="deleteUser('${u.userId}', '${u.name}', pages.users._reload)">🗑️</button>
              </div>
            </td>
          </tr>`;
        }).join('');
      }

      // Pagination
      const totalPages = Math.ceil(data.total / take);
      const currentPage = Math.floor(skip / take) + 1;
      document.getElementById('users-pagination').innerHTML = `
        <span>${t('showing', { from: skip+1, to: Math.min(skip+take, data.total), total: data.total })}</span>
        <div class="pagination-controls">
          <button class="btn btn-xs btn-ghost" onclick="usersGoPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>←</button>
          <span style="padding:4px 8px; font-size:12px;">${currentPage} / ${totalPages}</span>
          <button class="btn btn-xs btn-ghost" onclick="usersGoPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>→</button>
        </div>
      `;
    } catch (err) { showToast(t('error_load'), 'error'); }
  }

  window.usersGoPage = (p) => { skip = (p-1) * take; loadUsers(); };
  document.getElementById('user-filter-btn').addEventListener('click', () => {
    search = document.getElementById('user-search').value;
    quotaType = document.getElementById('user-quota-type').value;
    skip = 0; loadUsers();
  });
  document.getElementById('user-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { search = e.target.value; skip = 0; loadUsers(); } });

  loadUsers();
};

pages.users.viewDetail = async function(userId) {
  modal.open('User Detail', `<div class="skeleton skeleton-card"></div>`);
  try {
    const d = await GET(`/api/admin/users/${userId}`);
    if (!d) { modal.close(); return; }
    const pct = d.quota.planQuota > 0 ? Math.min(100, Math.round((d.quota.usedRecurringTokens / d.quota.planQuota) * 100)) : 0;
    modal.open(d.user.name, `
      <div class="text-sm text-muted">${d.user.email} • ${d.user.role}</div>
      ${d.user.goclawSenderId ? `<div class="text-xs text-muted" style="margin-top:4px;">📱 GoClaw: ${d.user.goclawDisplayName || d.user.goclawSenderId}</div>` : ''}

      <div class="quota-display" style="margin-top:16px;">
        <div class="quota-row"><span class="quota-label">Plan</span><span class="quota-value">${d.plan?.plan_name || '—'}</span></div>
        <div class="quota-row"><span class="quota-label">Quota</span><span class="quota-value">${fmtTokens(d.quota.planQuota)}</span></div>
        <div class="quota-row"><span class="quota-label">Used</span><span class="quota-value">${fmtTokens(d.quota.usedRecurringTokens)}</span></div>
        <div class="progress-wrap" style="margin:8px 0;"><div class="progress-bar ${progressBarClass(pct)}" style="width:${pct}%"></div></div>
        <div class="quota-row"><span class="quota-label">Remaining (Recurring)</span><span class="quota-value">${fmtTokens(d.quota.remainingRecurringTokens)}</span></div>
        <div class="quota-row"><span class="quota-label">Remaining (Bundle)</span><span class="quota-value">${fmtTokens(d.quota.remainingBundleTokens)}</span></div>
        <div class="quota-row"><span class="quota-label">Total Remaining</span><span class="quota-value" style="color:var(--success);">${fmtTokens(d.quota.totalRemainingTokens)}</span></div>
      </div>

      <div style="margin-top:16px;">
        <div class="card-title text-sm" style="margin-bottom:8px;">Usage by Feature</div>
        ${d.byFeature.length ? d.byFeature.map(f => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle); font-size:12px;">
          <span>${f.feature_name}</span><span>${fmtTokens(f.totalTokens)}</span></div>`).join('') : '<div class="text-muted text-sm">No data</div>'}
      </div>
    `);
  } catch { showToast(t('error_load'), 'error'); }
};

/* ── Events Log ──────────────────────────────────────────────────────────────── */
pages.events = async function() {
  const content = document.getElementById('page-content');
  let filters = { skip: 0, take: 20 };
  let period = 'this_month';

  content.innerHTML = `
    <div class="filters-bar">
      ${periodSelectorHTML('ev-period', period)}
      <select id="ev-source" class="form-control" style="width:auto; padding:6px 28px 6px 10px; font-size:12px;">
        <option value="">${t('filter_all_sources')}</option>
        <option value="BACKEND">BACKEND</option>
        <option value="N8N">N8N</option>
        <option value="GOCLAW">GOCLAW</option>
      </select>
      <select id="ev-status" class="form-control" style="width:auto; padding:6px 28px 6px 10px; font-size:12px;">
        <option value="">${t('filter_all_statuses')}</option>
        <option value="SUCCESS">SUCCESS</option>
        <option value="FAILED">FAILED</option>
        <option value="REJECTED">REJECTED</option>
      </select>
      <button class="btn btn-ghost btn-sm" id="ev-filter-btn">Filter</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>${t('col_time')}</th><th>${t('col_user')}</th><th>${t('col_source')}</th>
          <th>${t('col_feature')}</th><th>${t('col_model')}</th>
          <th>${t('col_prompt')}</th><th>${t('col_completion')}</th>
          <th>${t('col_total')}</th><th>${t('col_cost')}</th>
          <th>${t('col_latency')}</th><th>${t('col_status')}</th>
        </tr></thead>
        <tbody id="events-tbody"><tr><td colspan="11" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table>
      <div class="pagination" id="events-pagination"></div>
    </div>
  `;

  async function loadEvents() {
    const { from, to } = getPeriod(period);
    const params = new URLSearchParams({ from, to, skip: filters.skip, take: filters.take });
    if (filters.sourceService) params.set('sourceService', filters.sourceService);
    if (filters.status)        params.set('status', filters.status);
    try {
      const data = await GET(`/api/admin/events?${params}`);
      if (!data) return;
      const tbody = document.getElementById('events-tbody');
      tbody.innerHTML = data.items?.length ? data.items.map(e => `<tr>
        <td class="text-xs monospace" style="white-space:nowrap;">${fmtDateTime(e.created_at)}</td>
        <td>
          <div style="font-size:12px; font-weight:600;">${e.user_name || '—'}</div>
          <div class="text-xs text-muted">${e.user_email || ''}</div>
        </td>
        <td>${sourceBadge(e.source_service)}</td>
        <td class="text-xs">${e.feature_name || '—'}</td>
        <td class="text-xs monospace">${e.model_name || '—'}</td>
        <td class="text-sm">${fmtTokens(e.promptTokens)}</td>
        <td class="text-sm">${fmtTokens(e.completionTokens)}</td>
        <td class="text-sm font-semibold">${fmtTokens(e.totalTokens)}</td>
        <td class="text-xs">${fmtCost(e.costAmount)}</td>
        <td class="text-xs">${fmtLatency(e.latency_ms)}</td>
        <td>${statusBadge(e.status)}</td>
      </tr>`).join('') : `<tr><td colspan="11" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;

      const total = data.total;
      const currentPage = Math.floor(filters.skip / filters.take) + 1;
      const totalPages  = Math.ceil(total / filters.take);
      document.getElementById('events-pagination').innerHTML = `
        <span>${t('showing', { from: filters.skip+1, to: Math.min(filters.skip+filters.take, total), total })}</span>
        <div class="pagination-controls">
          <button class="btn btn-xs btn-ghost" onclick="evGoPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>←</button>
          <span style="padding:4px 8px; font-size:12px;">${currentPage} / ${totalPages}</span>
          <button class="btn btn-xs btn-ghost" onclick="evGoPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>→</button>
        </div>
      `;
    } catch { showToast(t('error_load'), 'error'); }
  }

  window.evGoPage = (p) => { filters.skip = (p-1) * filters.take; loadEvents(); };
  document.getElementById('ev-filter-btn').addEventListener('click', () => {
    filters.sourceService = document.getElementById('ev-source').value;
    filters.status = document.getElementById('ev-status').value;
    filters.skip = 0;
    loadEvents();
  });
  document.getElementById('ev-period').addEventListener('change', (e) => { period = e.target.value; filters.skip = 0; loadEvents(); });
  loadEvents();
};

/* ── Workflows ───────────────────────────────────────────────────────────────── */
pages.workflows = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>${t('col_source')}</th><th>${t('col_feature')}</th><th>${t('col_workflow')}</th>
    <th>Total Tokens</th><th>Total Cost</th><th>Success</th><th>Failed</th><th>Rejected</th><th>Avg Tokens/Req</th></tr></thead>
    <tbody id="wf-tbody"><tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
  </table></div>`;
  try {
    const data = await GET('/api/admin/workflows');
    if (!data) return;
    document.getElementById('wf-tbody').innerHTML = data.items?.length ? data.items.map(w => `<tr>
      <td>${sourceBadge(w.source_service)}</td>
      <td class="text-sm">${w.feature_name || '—'}</td>
      <td class="text-sm monospace">${w.workflow_name || '—'}</td>
      <td class="font-semibold">${fmtTokens(w.totalTokens)}</td>
      <td class="text-sm">${fmtCost(w.totalCost)}</td>
      <td class="text-success">${w.success_count}</td>
      <td class="text-danger">${w.failed_count}</td>
      <td class="text-warning">${w.rejected_count}</td>
      <td class="text-xs">${fmtTokens(w.avgTokensPerRequest)}</td>
    </tr>`).join('') : `<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;
  } catch { showToast(t('error_load'), 'error'); }
};

/* ── Plans & Assignments ─────────────────────────────────────────────────────── */
pages.plans = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="inner-tabs">
      <button class="inner-tab active" data-tab="plans">${t('tab_plans')}</button>
      <button class="inner-tab" data-tab="assignments">${t('tab_assignments')}</button>
      <button class="inner-tab" data-tab="bundles">${t('tab_bundles')}</button>
      <button class="inner-tab" data-tab="companies">Companies</button>
    </div>
    <div id="plans-tab-content"></div>
  `;

  document.querySelectorAll('.inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inner-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPlansTab(btn.dataset.tab);
    });
  });

  renderPlansTab('plans');
};

async function renderPlansTab(tab) {
  const area = document.getElementById('plans-tab-content');
  if (tab === 'plans') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">${t('page_plans')}</div>
        <button class="btn btn-primary btn-sm" id="btn-create-plan">+ ${t('btn_create_plan')}</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>${t('form_plan_name')}</th><th>${t('form_quota_type')}</th>
          <th>${t('col_quota_tokens')}</th><th>Message Limit</th><th>${t('col_price')}</th>
          <th>Services & Limits</th>
          <th>${t('col_assignments')}</th><th>${t('col_active')}</th><th>${t('col_actions')}</th>
        </tr></thead>
        <tbody id="plans-tbody"><tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    `;
    document.getElementById('btn-create-plan').addEventListener('click', () => showCreatePlanModal());
    loadPlans();
  } else if (tab === 'assignments') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">${t('page_assignments')}</div>
        <button class="btn btn-primary btn-sm" id="btn-assign">+ ${t('btn_assign')}</button>
      </div>
      <p class="text-muted text-sm" style="margin-bottom:16px;">Assign a recurring quota plan to an HR or HM user.</p>
      <div id="assignments-list">
        <div class="table-wrap"><table>
          <thead><tr><th>${t('col_user')}</th><th>${t('form_plan_name')}</th><th>${t('form_quota_type')}</th><th>${t('col_quota_tokens')}</th><th>Reset Date</th><th>Status</th></tr></thead>
          <tbody id="assignments-tbody"><tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
        </table></div>
      </div>
    `;
    document.getElementById('btn-assign').addEventListener('click', () => pages.plans.showAssignModal());
    loadAssignments();
  } else if (tab === 'bundles') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">One-time Token Bundles</div>
        <button class="btn btn-primary btn-sm" id="btn-add-bundle">+ ${t('btn_add_bundle')}</button>
      </div>
      <p class="text-muted text-sm" style="margin-bottom:16px;">Add a one-time token bundle to a user. Bundles supplement their recurring plan.</p>
      <div class="card">
        <p class="text-muted text-sm">Select a user to view their bundles.</p>
      </div>
    `;
    document.getElementById('btn-add-bundle').addEventListener('click', () => pages.plans.showBundleModal());
  } else if (tab === 'companies') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">Companies (HR Admin & Plans)</div>
        <button class="btn btn-ghost btn-sm" id="btn-refresh-companies">↻ Refresh</button>
      </div>
      <p class="text-muted text-sm" style="margin-bottom:16px;">Designate the HR admin per company and assign the company plan. The HR admin then manages members from the talent app; members share the company message quota.</p>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Company</th><th>Members</th><th>HR Admin</th><th>Active Plan</th><th>Actions</th>
        </tr></thead>
        <tbody id="aitm-companies-tbody"><tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    `;
    document.getElementById('btn-refresh-companies').addEventListener('click', () => loadAitmCompanies());
    loadAitmCompanies();
  }
}

async function loadAitmCompanies() {
  const data = await GET('/api/admin/aitm-companies').catch(() => null);
  const tbody = document.getElementById('aitm-companies-tbody');
  if (!data) { if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);">Failed to load.</td></tr>'; return; }
  tbody.innerHTML = data.items?.length ? data.items.map(c => {
    const admin = c.hrAdminName ? `${c.hrAdminName}<div class="text-xs text-muted">${c.hrAdminEmail}</div>` : '<span class="text-muted">— not set —</span>';
    const plan = c.activePlan
      ? `${c.activePlan.name}<div class="text-xs text-muted">${c.activePlan.quotaMessages !== null ? c.activePlan.quotaMessages + ' msg' : fmtTokens(c.activePlan.quotaTokens) + ' tok'} / ${c.activePlan.quotaType.toLowerCase()}</div>`
      : '<span class="text-muted">— none (trial auto) —</span>';
    return `<tr>
      <td style="font-weight:600;">${c.name}</td>
      <td><span class="badge badge-healthy">${c.memberCount}</span></td>
      <td>${admin}</td>
      <td>${plan}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-xs btn-ghost" onclick="showSetHrAdminModal('${c.id}')">Set HR Admin</button>
        <button class="btn btn-xs btn-ghost" onclick="showAssignPlanToCompanyModal('${c.id}')">Assign Plan</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;
}

window.showSetHrAdminModal = async function(companyId) {
  const [companiesData, employeesData] = await Promise.all([
    GET('/api/admin/aitm-companies').catch(() => ({ items: [] })),
    GET(`/api/admin/aitm-companies/${companyId}/employees`).catch(() => ({ items: [] })),
  ]);
  const company = (companiesData.items || []).find(c => c.id === companyId);
  const employees = employeesData.items || [];
  if (!company) return showToast('Company not found', 'error');
  if (!employees.length) return showToast('Company has no employees in AITM', 'error');

  modal.open(`Set HR Admin — ${company.name}`, `
    <p class="text-muted text-sm" style="margin-bottom:12px;">The HR admin sees the Company Config page (white-label + user management) in the talent app and receives the member usage overview.</p>
    <div class="form-group"><label class="form-label">HR Admin</label>
      <select id="ha-user" class="form-control">
        ${employees.map(e => `<option value="${e.user_id}" ${e.user_id === company.hrAdminId ? 'selected' : ''}>${e.name} — ${e.email} (${e.role})</option>`).join('')}
      </select></div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="ha-save">${t('save')}</button>
  `);

  document.getElementById('ha-save').addEventListener('click', async () => {
    const userId = document.getElementById('ha-user').value;
    try {
      await PATCH(`/api/admin/aitm-companies/${companyId}/hr-admin`, { userId });
      modal.close(); showToast('HR admin updated.', 'success');
      renderPlansTab('companies');
    } catch (err) { showToast(err.message, 'error'); }
  });
};

window.showAssignPlanToCompanyModal = function(companyId) {
  pages.plans.showAssignModal(null, null, companyId);
};

async function loadPlans() {
  const data = await GET('/api/admin/plans').catch(() => null);
  if (!data) return;
  const tbody = document.getElementById('plans-tbody');
  tbody.innerHTML = data.items?.length ? data.items.map(p => {
    const servicesHTML = p.services?.length
      ? p.services.map(s => {
          let limitStr = [];
          if (s.hitLimitMonthly) limitStr.push(`${s.hitLimitMonthly} hits`);
          if (s.costLimitMonthly) limitStr.push(`${fmtCost(s.costLimitMonthly)}`);
          if (limitStr.length === 0) limitStr.push('Unlimited');
          return `<div style="font-size:11px; margin-bottom:2px;">• <strong>${s.displayName}</strong>: ${limitStr.join(' / ')}</div>`;
        }).join('')
      : '<span class="text-muted text-xs">No service restrictions</span>';

    return `<tr>
      <td style="font-weight:600;">${p.name}</td>
      <td>${t(p.quota_type?.toLowerCase()) || p.quota_type}</td>
      <td>${fmtTokens(p.quotaTokens)}</td>
      <td>${p.quotaMessages !== null && p.quotaMessages !== undefined ? `<span class="badge badge-healthy">${p.quotaMessages} / period</span>` : '<span class="text-muted">token-based</span>'}</td>
      <td>${p.price_amount ? fmtCost(p.price_amount/100, p.currency) : '—'}</td>
      <td>${servicesHTML}</td>
      <td><span class="badge badge-healthy">${p.assignmentCount} users</span></td>
      <td>${p.is_active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-expired">Inactive</span>'}</td>
      <td><button class="btn btn-xs btn-ghost" onclick="showEditPlanModal('${p.id}')">Edit</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;
}

async function loadAssignments() {
  const data = await GET('/api/admin/users?take=50').catch(() => null);
  if (!data) return;
  const tbody = document.getElementById('assignments-tbody');
  const withPlan = data.items.filter(u => u.planName);
  tbody.innerHTML = withPlan.length ? withPlan.map(u => `<tr>
    <td><div style="font-weight:600; font-size:13px;">${u.name}</div><div class="text-xs text-muted">${u.email}</div></td>
    <td>${u.planName}</td>
    <td>${u.quotaType ? t(u.quotaType.toLowerCase()) : '—'}</td>
    <td>${fmtTokens(u.quotaTokens)}</td>
    <td>${fmtDate(u.resetAt)}</td>
    <td>${statusBadge(u.status)}</td>
  </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">No assignments yet.</td></tr>`;
}

async function showCreatePlanModal() {
  const svcsData = await GET('/api/admin/services').catch(() => ({ items: [] }));
  const services = svcsData.items || [];

  let servicesHTML = services.length ? services.map(svc => `
    <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px; border-bottom: 1px solid var(--border); padding-bottom:8px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
         <div style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" class="plan-svc-check" data-id="${svc.id}" style="width:auto;" />
            <span style="font-weight:600; font-size:13px; color:var(--text-main);">${svc.display_name}</span>
         </div>
      </div>
      <div class="plan-svc-limits-row" id="limits-row-${svc.id}" style="display:none; gap:12px; padding-left:22px; margin-top:4px;">
         <div style="flex:1;">
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Hit Limit/mo</label>
            <input type="number" class="form-control plan-svc-hits" data-id="${svc.id}" placeholder="Unlimited" style="height:28px; font-size:12px;" />
         </div>
         <div style="flex:1;">
            <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Cost Limit/mo (Rp)</label>
            <input type="number" class="form-control plan-svc-cost" data-id="${svc.id}" placeholder="Unlimited" style="height:28px; font-size:12px;" />
         </div>
      </div>
    </div>
  `).join('') : '<p class="text-muted text-xs">No registered services found.</p>';

  modal.open(t('btn_create_plan'), `
    <div class="form-group"><label class="form-label">${t('form_plan_name')}</label><input id="mp-name" class="form-control" placeholder="e.g. Silver Plan" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">${t('form_quota_type')}</label>
        <select id="mp-type" class="form-control"><option value="MONTHLY">${t('monthly')}</option><option value="YEARLY">${t('yearly')}</option></select></div>
      <div class="form-group"><label class="form-label">${t('form_quota_tokens')}</label><input id="mp-tokens" type="number" class="form-control" placeholder="100000000" min="1" /></div>
    </div>
    <div class="form-group"><label class="form-label">Message Limit / period (enforced)</label>
      <input id="mp-messages" type="number" class="form-control" placeholder="e.g. 20 — leave empty for token-only legacy plan" min="1" />
      <span class="text-xs text-muted" style="margin-top:4px; display:block;">When set, users are limited to this many chat messages per period; tokens keep being recorded for monitoring.</span></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Price (Rupiah)</label>
        <input id="mp-price" type="number" class="form-control" placeholder="e.g. 8000000" min="0" /></div>
      <div class="form-group"><label class="form-label">Currency</label>
        <input class="form-control" value="IDR" disabled /></div>
    </div>
    <div class="form-group"><label class="form-label">${t('form_description')}</label><input id="mp-desc" class="form-control" placeholder="Description…" /></div>
    
    <div class="form-group">
      <label class="form-label" style="font-weight:600; margin-bottom:8px; display:block;">Included Services & Limits</label>
      <div style="border: 1px solid var(--border); border-radius: 6px; padding: 12px; max-height: 250px; overflow-y: auto; background: var(--bg-hover);">
        ${servicesHTML}
      </div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="mp-save">${t('save')}</button>
  `);

  document.querySelectorAll('.plan-svc-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const limitsRow = document.getElementById(`limits-row-${e.target.dataset.id}`);
      if (limitsRow) limitsRow.style.display = e.target.checked ? 'flex' : 'none';
    });
  });

  document.getElementById('mp-save').addEventListener('click', async () => {
    const name = document.getElementById('mp-name').value.trim();
    const quotaType = document.getElementById('mp-type').value;
    const quotaTokens = parseInt(document.getElementById('mp-tokens').value);
    const quotaMessagesVal = document.getElementById('mp-messages').value;
    const quotaMessages = quotaMessagesVal ? parseInt(quotaMessagesVal) : null;
    const priceAmountVal = parseFloat(document.getElementById('mp-price').value) || 0;
    const description = document.getElementById('mp-desc').value.trim();

    if (!name || !quotaTokens) return showToast('Name and tokens required', 'error');

    const selectedServices = [];
    document.querySelectorAll('.plan-svc-check:checked').forEach(cb => {
      const serviceId = cb.dataset.id;
      const hitsVal = document.querySelector(`.plan-svc-hits[data-id="${serviceId}"]`).value;
      const costVal = document.querySelector(`.plan-svc-cost[data-id="${serviceId}"]`).value;
      selectedServices.push({
        serviceId,
        hitLimitMonthly: hitsVal ? parseInt(hitsVal) : null,
        costLimitMonthly: costVal ? parseFloat(costVal) : null
      });
    });

    try {
      await POST('/api/admin/plans', {
        name,
        quotaType,
        quotaTokens,
        quotaMessages,
        priceAmount: Math.round(priceAmountVal * 100),
        currency: 'IDR',
        description,
        services: selectedServices
      });
      modal.close(); showToast('Plan created.', 'success');
      renderPlansTab('plans');
    } catch (err) { showToast(err.message, 'error'); }
  });
}

window.showEditPlanModal = async function(planId) {
  const [plansData, svcsData] = await Promise.all([
    GET('/api/admin/plans').catch(() => null),
    GET('/api/admin/services').catch(() => ({ items: [] }))
  ]);
  if (!plansData) return showToast('Failed to load plans', 'error');
  const plan = plansData.items.find(p => p.id === planId);
  if (!plan) return showToast('Plan not found', 'error');
  const services = svcsData.items || [];

  let servicesHTML = services.length ? services.map(svc => {
    const mapped = plan.services?.find(ps => ps.serviceId === svc.id);
    const isChecked = !!mapped;
    const hitLimit = mapped && mapped.hitLimitMonthly !== null && mapped.hitLimitMonthly !== undefined ? mapped.hitLimitMonthly : '';
    const costLimit = mapped && mapped.costLimitMonthly !== null && mapped.costLimitMonthly !== undefined ? mapped.costLimitMonthly : '';

    return `
      <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px; border-bottom: 1px solid var(--border); padding-bottom:8px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
           <div style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" class="plan-svc-check" data-id="${svc.id}" ${isChecked ? 'checked' : ''} style="width:auto;" />
              <span style="font-weight:600; font-size:13px; color:var(--text-main);">${svc.display_name}</span>
           </div>
        </div>
        <div class="plan-svc-limits-row" id="limits-row-${svc.id}" style="display:${isChecked ? 'flex' : 'none'}; gap:12px; padding-left:22px; margin-top:4px;">
           <div style="flex:1;">
              <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Hit Limit/mo</label>
              <input type="number" class="form-control plan-svc-hits" data-id="${svc.id}" value="${hitLimit}" placeholder="Unlimited" style="height:28px; font-size:12px;" />
           </div>
           <div style="flex:1;">
              <label style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Cost Limit/mo (Rp)</label>
              <input type="number" class="form-control plan-svc-cost" data-id="${svc.id}" value="${costLimit}" placeholder="Unlimited" style="height:28px; font-size:12px;" />
           </div>
        </div>
      </div>
    `;
  }).join('') : '<p class="text-muted text-xs">No registered services found.</p>';

  modal.open('Edit Plan', `
    <div class="form-group"><label class="form-label">${t('form_plan_name')}</label>
      <input id="ep-name" class="form-control" value="${plan.name}" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">${t('form_quota_type')}</label>
        <select id="ep-type" class="form-control" disabled>
          <option value="MONTHLY" ${plan.quota_type === 'MONTHLY' ? 'selected' : ''}>Monthly</option>
          <option value="YEARLY" ${plan.quota_type === 'YEARLY' ? 'selected' : ''}>Yearly</option>
        </select>
        <span class="text-xs text-muted" style="margin-top:4px; display:block;">Quota type cannot be changed after creation.</span>
      </div>
      <div class="form-group"><label class="form-label">${t('form_quota_tokens')}</label>
        <input id="ep-tokens" type="number" class="form-control" value="${plan.quotaTokens || plan.quota_tokens || 0}" min="1" /></div>
    </div>
    <div class="form-group"><label class="form-label">Message Limit / period (enforced)</label>
      <input id="ep-messages" type="number" class="form-control" value="${plan.quotaMessages ?? ''}" placeholder="empty = token-only legacy plan" min="1" />
      <span class="text-xs text-muted" style="margin-top:4px; display:block;">Clear the value to switch the plan back to token-only enforcement.</span></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Price (Rupiah)</label>
        <input id="ep-price" type="number" class="form-control" value="${plan.price_amount ? (plan.price_amount / 100) : ''}" placeholder="e.g. 8000000" min="0" /></div>
      <div class="form-group"><label class="form-label">Currency</label>
        <input class="form-control" value="IDR" disabled /></div>
    </div>
    <div class="form-group"><label class="form-label">${t('form_description')}</label>
      <input id="ep-desc" class="form-control" value="${plan.description || ''}" /></div>
    <div class="form-group" style="display:flex; align-items:center; gap:8px;">
      <input id="ep-active" type="checkbox" ${plan.is_active ? 'checked' : ''} style="width:auto;" />
      <label class="form-label" style="margin:0;" for="ep-active">Active</label>
    </div>

    <div class="form-group">
      <label class="form-label" style="font-weight:600; margin-bottom:8px; display:block;">Included Services & Limits</label>
      <div style="border: 1px solid var(--border); border-radius: 6px; padding: 12px; max-height: 250px; overflow-y: auto; background: var(--bg-hover);">
        ${servicesHTML}
      </div>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="ep-save">${t('save')}</button>
  `);

  document.querySelectorAll('.plan-svc-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const limitsRow = document.getElementById(`limits-row-${e.target.dataset.id}`);
      if (limitsRow) limitsRow.style.display = e.target.checked ? 'flex' : 'none';
    });
  });

  document.getElementById('ep-save').addEventListener('click', async () => {
    const name = document.getElementById('ep-name').value.trim();
    const quotaTokens = parseInt(document.getElementById('ep-tokens').value);
    const quotaMessagesVal = document.getElementById('ep-messages').value;
    const quotaMessages = quotaMessagesVal ? parseInt(quotaMessagesVal) : null;
    const priceAmountVal = parseFloat(document.getElementById('ep-price').value) || 0;
    const description = document.getElementById('ep-desc').value.trim();
    const isActive = document.getElementById('ep-active').checked;

    if (!name || !quotaTokens || quotaTokens <= 0) return showToast('Name and tokens required', 'error');

    const selectedServices = [];
    document.querySelectorAll('.plan-svc-check:checked').forEach(cb => {
      const serviceId = cb.dataset.id;
      const hitsVal = document.querySelector(`.plan-svc-hits[data-id="${serviceId}"]`).value;
      const costVal = document.querySelector(`.plan-svc-cost[data-id="${serviceId}"]`).value;
      selectedServices.push({
        serviceId,
        hitLimitMonthly: hitsVal ? parseInt(hitsVal) : null,
        costLimitMonthly: costVal ? parseFloat(costVal) : null
      });
    });

    try {
      await PATCH(`/api/admin/plans/${planId}`, {
        name,
        quotaTokens,
        quotaMessages,
        priceAmount: Math.round(priceAmountVal * 100),
        currency: 'IDR',
        description,
        isActive,
        services: selectedServices
      });
      modal.close(); showToast('Plan updated.', 'success');
      renderPlansTab('plans');
    } catch (err) { showToast(err.message, 'error'); }
  });
};

pages.plans.showAssignModal = async function(userId, userName, presetCompanyId) {
  // Load users, companies and plans
  const [usersData, companiesData, plansData] = await Promise.all([
    GET('/api/admin/users?take=50').catch(() => ({ items: [] })),
    GET('/api/admin/companies').catch(() => ({ items: [] })),
    GET('/api/admin/plans').catch(() => ({ items: [] })),
  ]);
  const hrUsers = (usersData.items || []).filter(u => u.role !== 'CANDIDATE');
  const companies = (companiesData.items || []).filter(c => c.is_active);
  const plans = (plansData.items || []).filter(p => p.is_active);
  const planLabel = p => `${p.name} (${p.quotaMessages !== null && p.quotaMessages !== undefined ? p.quotaMessages + ' msg' : fmtTokens(p.quotaTokens) + ' tok'} / ${p.quota_type.toLowerCase()})`;

  modal.open(t('btn_assign') || 'Assign Plan', `
    <div class="form-group"><label class="form-label">Assignment Target</label>
      <select id="as-target-type" class="form-control">
        <option value="user" ${presetCompanyId ? '' : 'selected'}>Individual User</option>
        <option value="company" ${presetCompanyId ? 'selected' : ''}>Shared Company Quota</option>
      </select></div>
    <div class="form-group" id="as-user-wrap" style="${presetCompanyId ? 'display:none;' : ''}"><label class="form-label">${t('form_select_user') || 'Select User'}</label>
      <select id="as-user" class="form-control">
        ${hrUsers.map(u => `<option value="${u.userId}" ${u.userId === userId ? 'selected' : ''}>${u.name} (${u.role})</option>`).join('')}
      </select></div>
    <div class="form-group" id="as-company-wrap" style="${presetCompanyId ? '' : 'display:none;'}"><label class="form-label">Select Company</label>
      <select id="as-company" class="form-control">
        ${companies.map(c => `<option value="${c.id}" ${c.id === presetCompanyId ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select></div>
    <div class="form-group"><label class="form-label">${t('form_select_plan') || 'Select Plan'}</label>
      <select id="as-plan" class="form-control">
        ${plans.map(p => `<option value="${p.id}">${planLabel(p)}</option>`).join('')}
      </select></div>
    <div class="quota-banner warning" style="margin-top:8px;">⚠️ ${t('warning_replace_plan') || 'Assigning a new plan will deactivate any active plan for this target.'}</div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="as-confirm">${t('btn_assign') || 'Assign'}</button>
  `);

  const targetType = document.getElementById('as-target-type');
  const userWrap = document.getElementById('as-user-wrap');
  const companyWrap = document.getElementById('as-company-wrap');
  targetType.addEventListener('change', () => {
    if (targetType.value === 'user') {
      userWrap.style.display = 'block';
      companyWrap.style.display = 'none';
    } else {
      userWrap.style.display = 'none';
      companyWrap.style.display = 'block';
    }
  });

  document.getElementById('as-confirm').addEventListener('click', async () => {
    const isUser = targetType.value === 'user';
    const uid = isUser ? document.getElementById('as-user').value : null;
    const cid = !isUser ? document.getElementById('as-company').value : null;
    const pid = document.getElementById('as-plan').value;
    
    if (!pid) return showToast('Please select a plan', 'error');
    if (isUser && !uid) return showToast('Please select a user', 'error');
    if (!isUser && !cid) return showToast('Please select a company', 'error');

    try {
      await POST('/api/admin/assignments', { userId: uid, companyId: cid, planId: pid });
      modal.close(); showToast(t('assigned_ok') || 'Plan assigned successfully', 'success');
      renderPlansTab('assignments');
    } catch (err) { showToast((t('assigned_err') || 'Assignment failed:') + ' ' + err.message, 'error'); }
  });
};

pages.plans.showBundleModal = async function(userId, userName) {
  const [usersData, companiesData] = await Promise.all([
    GET('/api/admin/users?take=50').catch(() => ({ items: [] })),
    GET('/api/admin/companies').catch(() => ({ items: [] }))
  ]);
  const hrUsers = (usersData.items || []).filter(u => u.role !== 'CANDIDATE');
  const companies = (companiesData.items || []).filter(c => c.is_active);

  modal.open(t('btn_add_bundle') || 'Add Bundle', `
    <div class="form-group"><label class="form-label">Bundle Target</label>
      <select id="bun-target-type" class="form-control">
        <option value="user">Individual User</option>
        <option value="company">Shared Company Quota</option>
      </select></div>
    <div class="form-group" id="bun-user-wrap"><label class="form-label">${t('form_select_user') || 'Select User'}</label>
      <select id="bun-user" class="form-control">
        ${hrUsers.map(u => `<option value="${u.userId}" ${u.userId === userId ? 'selected' : ''}>${u.name} (${u.role})</option>`).join('')}
      </select></div>
    <div class="form-group" id="bun-company-wrap" style="display:none;"><label class="form-label">Select Company</label>
      <select id="bun-company" class="form-control">
        ${companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      </select></div>
    <div class="form-group"><label class="form-label">${t('form_quota_tokens_bundle') || 'Bundle Token Quota'}</label>
      <input id="bun-tokens" type="number" class="form-control" placeholder="100000" min="1" /></div>
    <div class="form-group"><label class="form-label">${t('form_expires_at') || 'Expires At'}</label>
      <input id="bun-exp" type="date" class="form-control" /></div>
    <div class="form-group"><label class="form-label">${t('form_note') || 'Note'}</label>
      <input id="bun-note" class="form-control" placeholder="Reason for bundle…" /></div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="bun-confirm">Add Bundle</button>
  `);

  const targetType = document.getElementById('bun-target-type');
  const userWrap = document.getElementById('bun-user-wrap');
  const companyWrap = document.getElementById('bun-company-wrap');
  targetType.addEventListener('change', () => {
    if (targetType.value === 'user') {
      userWrap.style.display = 'block';
      companyWrap.style.display = 'none';
    } else {
      userWrap.style.display = 'none';
      companyWrap.style.display = 'block';
    }
  });

  document.getElementById('bun-confirm').addEventListener('click', async () => {
    const isUser = targetType.value === 'user';
    const uid = isUser ? document.getElementById('bun-user').value : null;
    const cid = !isUser ? document.getElementById('bun-company').value : null;
    const tokens = parseInt(document.getElementById('bun-tokens').value);
    const exp = document.getElementById('bun-exp').value;
    const note = document.getElementById('bun-note').value.trim();

    if (isUser && !uid) return showToast('Please select a user', 'error');
    if (!isUser && !cid) return showToast('Please select a company', 'error');
    if (!tokens || tokens <= 0) return showToast('Please enter a valid token count', 'error');

    try {
      await POST('/api/admin/bundles', { userId: uid, companyId: cid, quotaTokens: tokens, expiresAt: exp || null, note });
      modal.close(); showToast(t('bundle_added') || 'Bundle added successfully', 'success');
      renderPlansTab('bundles');
    } catch (err) { showToast(err.message, 'error'); }
  });
};

/* ── Mappings ────────────────────────────────────────────────────────────────── */
pages.mappings = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div id="mappings-wrap">
      <div class="section-header">
        <div class="section-title">User Mapping</div>
        <button class="btn btn-primary btn-sm" onclick="showAddCompanyModal()">➕ Add Company</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>${t('col_aitm_user') || 'AITM User'}</th><th>${t('col_role') || 'Role'}</th>
          <th>Company</th>
          <th>${t('col_goclaw_contact') || 'GoClaw Contact'}</th>
          <th>${t('col_confidence') || 'Confidence'}</th><th>${t('col_mapped_at') || 'Mapped At'}</th><th>${t('col_actions') || 'Actions'}</th>
        </tr></thead>
        <tbody id="mappings-tbody"><tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    </div>
  `;
  await loadMappings();
};

async function loadMappings() {
  const [data, companiesData] = await Promise.all([
    GET('/api/admin/mappings').catch(() => null),
    GET('/api/admin/companies').catch(() => ({ items: [] }))
  ]);
  if (!data) return;
  
  const companies = companiesData.items || [];
  const tbody = document.getElementById('mappings-tbody');
  tbody.innerHTML = data.items?.length ? data.items.map(m => `<tr>
    <td>
      <div style="font-weight:600; font-size:13px;">${m.name}</div>
      <div class="text-xs text-muted">${m.email}</div>
    </td>
    <td class="text-xs text-secondary">${m.role}</td>
    <td>
      <select onchange="updateUserCompany('${m.user_id}', this.value)" class="form-control text-xs" style="width: auto; padding: 2px 4px; height: 26px;">
        <option value="">— No Company —</option>
        ${companies.map(c => `<option value="${c.id}" ${m.company_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
    </td>
    <td>
      ${m.goclaw_sender_id
        ? `<div style="font-size:13px; font-weight:600;">${m.goclaw_display_name || '—'}</div>
           <div class="text-xs monospace text-muted">${m.goclaw_sender_id}</div>`
        : `<span class="text-muted text-xs">${t('unmapped')}</span>`}
    </td>
    <td>${m.match_confidence
      ? `<span class="badge badge-${m.match_confidence === 'auto' ? 'backend' : 'healthy'}">${m.match_confidence === 'auto' ? t('conf_auto') : t('conf_manual')}</span>`
      : '—'}</td>
    <td class="text-xs">${fmtDate(m.mapped_at)}</td>
    <td>
      <button class="btn btn-xs btn-outline" onclick="showMappingModal('${m.user_id}','${m.name}', '${m.goclaw_sender_id || ''}', '${m.goclaw_display_name || ''}')">${t('btn_link')}</button>
      ${m.goclaw_sender_id ? `<button class="btn btn-xs btn-danger" onclick="unlinkMapping('${m.user_id}')" style="margin-left:4px;">${t('btn_unlink')}</button>` : ''}
    </td>
  </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;
}

window.updateUserCompany = async function(userId, companyId) {
  try {
    await PATCH(`/api/admin/mappings/${userId}/company`, { companyId: companyId || null });
    showToast('Company mapping updated', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.showMappingModal = async function(userId, userName, currentSenderId, currentDisplayName) {
  // Load GoClaw contacts for suggestions
  const contactsData = await GET('/api/admin/mappings/goclaw-contacts').catch(() => ({ items: [] }));
  const contacts = contactsData.items || [];

  modal.open(`Link: ${userName}`, `
    <p class="text-muted text-sm" style="margin-bottom:16px;">${t('page_mappings_sub')}</p>
    <div class="form-group"><label class="form-label">GoClaw Sender ID</label>
      <input id="map-sender-id" class="form-control" value="${currentSenderId}" placeholder="e.g. 628111234567:65@lid" /></div>
    <div class="form-group"><label class="form-label">Display Name</label>
      <input id="map-display" class="form-control" value="${currentDisplayName}" placeholder="Name in WhatsApp" /></div>
    ${contacts.length ? `
      <div class="form-group">
        <label class="form-label">Or pick from GoClaw contacts</label>
        <select id="map-contact-picker" class="form-control" onchange="fillMapping(this)">
          <option value="">— ${t('goclaw_contact_ph')} —</option>
          ${contacts.map(c => `<option value="${c.sender_id}" data-name="${c.display_name||''}">${c.display_name || c.sender_id}</option>`).join('')}
        </select>
      </div>
    ` : ''}
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="map-save-btn">${t('save')}</button>
  `);

  document.getElementById('map-save-btn').addEventListener('click', async () => {
    const senderId = document.getElementById('map-sender-id').value.trim();
    const displayName = document.getElementById('map-display').value.trim();
    try {
      await POST('/api/admin/mappings', { userId, goclawSenderId: senderId || null, goclawDisplayName: displayName || null });
      modal.close(); showToast(t('mapping_saved'), 'success');
      loadMappings();
    } catch (err) { showToast(err.message, 'error'); }
  });
};

window.fillMapping = function(sel) {
  const opt = sel.selectedOptions[0];
  if (!opt.value) return;
  document.getElementById('map-sender-id').value = opt.value;
  document.getElementById('map-display').value = opt.dataset.name || '';
};

window.unlinkMapping = async function(userId) {
  if (!confirm('Unlink this user from GoClaw? This will stop throttle enforcement for them.')) return;
  try {
    await POST('/api/admin/mappings', { userId, goclawSenderId: null, goclawDisplayName: null });
    showToast('Unmapped.', 'success');
    loadMappings();
  } catch (err) { showToast(err.message, 'error'); }
};

/* ── Settings & Audit ────────────────────────────────────────────────────────── */
pages.settings = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="inner-tabs">
      <button class="inner-tab active" data-tab="services">${t('tab_services') || 'Services'}</button>
      <button class="inner-tab" data-tab="companies">Companies</button>
      <button class="inner-tab" data-tab="audit">${t('tab_audit') || 'Audit Log'}</button>
    </div>
    <div id="settings-tab-content"></div>
  `;

  document.querySelectorAll('.inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inner-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSettingsTab(btn.dataset.tab);
    });
  });
  renderSettingsTab('services');
};

async function renderSettingsTab(tab) {
  const area = document.getElementById('settings-tab-content');
  if (tab === 'services') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">Registered Services</div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="recalculateCosts()">🔄 Recalculate Costs</button>
          <button class="btn btn-ghost btn-sm" onclick="runThrottleCheck()">▶ ${t('btn_run_throttle') || 'Run Throttle'}</button>
          <button class="btn btn-primary btn-sm" onclick="showAddServiceModal()">+ Add Service</button>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>${t('col_service') || 'Service'}</th><th>${t('col_source') || 'Source'}</th>
          <th>Pricing Type</th><th>Cost</th><th>Hit Limit/Mo</th><th>Cost Limit/Mo</th>
          <th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="services-tbody"><tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    `;
    const data = await GET('/api/admin/services').catch(() => null);
    if (data) {
      document.getElementById('services-tbody').innerHTML = data.items?.length ? data.items.map(s => `<tr>
        <td><div style="font-weight:600;">${s.display_name}</div><div class="text-xs monospace text-muted">${s.service_name}</div></td>
        <td>${sourceBadge(s.source_service)}</td>
        <td><span class="badge ${s.pricing_type === 'per_1k_tokens' ? 'badge-backend' : 'badge-frontend'}">${s.pricing_type === 'per_1k_tokens' ? 'Per 1K Tokens' : 'Per Hit'}</span></td>
        <td class="text-sm">${fmtCost(s.cost_per_hit, s.cost_currency)}</td>
        <td class="text-sm">${s.hit_limit_monthly || '—'}</td>
        <td class="text-sm">${s.cost_limit_monthly ? fmtCost(s.cost_limit_monthly, s.cost_currency) : '—'}</td>
        <td>${s.is_active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-expired">Off</span>'}</td>
        <td>
          <div style="display:flex; gap:4px;">
            <button class="btn btn-ghost btn-sm" onclick="showEditServiceModal('${s.id}')">✏️</button>
            ${s.is_active ? `<button class="btn btn-ghost btn-sm" onclick="deactivateService('${s.id}', '${s.display_name}')">🚫</button>` : ''}
          </div>
        </td>
      </tr>`).join('') : '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">No services registered.</td></tr>';
    }
  } else if (tab === 'companies') {
    area.innerHTML = `
      <div class="section-header">
        <div class="section-title">Companies</div>
        <button class="btn btn-primary btn-sm" onclick="showAddCompanyModal()">+ Add Company</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Company Name</th><th>Description</th><th>Members</th><th>Active Plans</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="companies-tbody"><tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    `;
    const data = await GET('/api/admin/companies').catch(() => null);
    if (data) {
      document.getElementById('companies-tbody').innerHTML = data.items?.length ? data.items.map(c => `<tr>
        <td><div style="font-weight:600;">${c.name}</div><div class="text-xs monospace text-muted">ID: ${c.id}</div></td>
        <td class="text-sm">${c.description || '—'}</td>
        <td class="text-sm">${c.memberCount || 0} members</td>
        <td class="text-sm">${c.activePlans || 0} active</td>
        <td>${c.is_active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-expired">Inactive</span>'}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="showEditCompanyModal('${c.id}', '${c.name}', '${c.description || ''}', ${c.is_active})">✏️</button>
        </td>
      </tr>`).join('') : '<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">No companies registered.</td></tr>';
    }
  } else if (tab === 'audit') {
    area.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody id="audit-tbody"><tr><td colspan="4" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
      </table></div>
    `;
    const data = await GET('/api/admin/audit').catch(() => null);
    if (data) {
      document.getElementById('audit-tbody').innerHTML = data.items?.length ? data.items.map(a => `<tr>
        <td class="text-xs monospace">${fmtDateTime(a.created_at)}</td>
        <td class="text-sm">${a.actor_name || a.actor_user_id}</td>
        <td><span class="badge badge-backend">${a.action}</span></td>
        <td class="text-xs monospace">${a.target_type}:${a.target_id?.slice(0,8)}…</td>
      </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; padding:40px; color:var(--text-muted);">No audit events yet.</td></tr>';
    }
  }
}

// ── Service Modals & Actions ──────────────────────────────────────────────────
window.showAddServiceModal = async function() {
  const featuresData = await GET('/api/admin/features').catch(() => ({ items: [] }));
  const features = featuresData.items || [];
  
  modal.open('Add Service Pricing', `
    <div class="form-group"><label class="form-label">Tracked Feature</label>
      <select id="asvc-feature" class="form-control">
        <option value="">— Select Feature —</option>
        ${features.map(f => `<option value="${f.featureName}">${f.featureName} (${f.eventCount} events, ${f.hasService ? 'Priced' : 'Unpriced'})</option>`).join('')}
        <option value="CUSTOM">Enter Custom Feature Name…</option>
      </select></div>
    <div class="form-group" id="asvc-custom-name-wrap" style="display:none;"><label class="form-label">Custom Feature Name</label>
      <input id="asvc-custom-name" class="form-control" placeholder="e.g. my_custom_tool_name" /></div>
    <div class="form-group"><label class="form-label">Display Name</label>
      <input id="asvc-display" class="form-control" placeholder="e.g. Custom Search Tool" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Source Service</label>
        <select id="asvc-source" class="form-control">
          <option value="BACKEND">BACKEND (AITM Backend)</option>
          <option value="GOCLAW">GOCLAW</option>
          <option value="N8N">N8N</option>
          <option value="CUSTOM">CUSTOM</option>
        </select></div>
      <div class="form-group"><label class="form-label">Pricing Type</label>
        <select id="asvc-pricing-type" class="form-control">
          <option value="per_hit">Per Hit (Flat rate)</option>
          <option value="per_1k_tokens">Per 1K Tokens (Token-based)</option>
        </select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Cost per Hit/1K Tokens (IDR)</label>
        <input id="asvc-cost" type="number" step="0.000001" class="form-control" value="0.000000" min="0" /></div>
      <div class="form-group"><label class="form-label">Currency</label>
        <input id="asvc-currency" class="form-control" value="IDR" disabled /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Monthly Hit Limit</label>
        <input id="asvc-hit-limit" type="number" class="form-control" placeholder="No Limit" /></div>
      <div class="form-group"><label class="form-label">Monthly Cost Limit</label>
        <input id="asvc-cost-limit" type="number" step="0.01" class="form-control" placeholder="No Limit" /></div>
    </div>
    <div class="form-group"><label class="form-label">Description</label>
      <input id="asvc-desc" class="form-control" placeholder="Description of service pricing..." /></div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="asvc-confirm">Create Service</button>
  `);

  const select = document.getElementById('asvc-feature');
  const customWrap = document.getElementById('asvc-custom-name-wrap');
  select.addEventListener('change', () => {
    if (select.value === 'CUSTOM') {
      customWrap.style.display = 'block';
    } else {
      customWrap.style.display = 'none';
      if (select.value) {
        document.getElementById('asvc-display').value = select.value
          .replace(/^(mcp_)?/, '')
          .replace(/__/g, ': ')
          .replace(/_/g, ' ')
          .split(' ')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
    }
  });

  document.getElementById('asvc-confirm').addEventListener('click', async () => {
    const featureName = select.value === 'CUSTOM' ? document.getElementById('asvc-custom-name').value.trim() : select.value;
    const displayName = document.getElementById('asvc-display').value.trim();
    const sourceService = document.getElementById('asvc-source').value;
    const pricingType = document.getElementById('asvc-pricing-type').value;
    const costPerHit = parseFloat(document.getElementById('asvc-cost').value) || 0;
    const costCurrency = document.getElementById('asvc-currency').value;
    const hitLimitMonthly = parseInt(document.getElementById('asvc-hit-limit').value) || null;
    const costLimitMonthly = parseFloat(document.getElementById('asvc-cost-limit').value) || null;
    const description = document.getElementById('asvc-desc').value.trim();

    if (!featureName) return showToast('Please select or enter a feature name', 'error');
    if (!displayName) return showToast('Please enter a display name', 'error');

    try {
      await POST('/api/admin/services', {
        serviceName: featureName,
        sourceService,
        displayName,
        pricingType,
        costPerHit,
        costCurrency,
        hitLimitMonthly,
        costLimitMonthly,
        description
      });
      modal.close();
      showToast('Service pricing registered successfully', 'success');
      renderSettingsTab('services');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

window.showEditServiceModal = async function(svcId) {
  const data = await GET('/api/admin/services').catch(() => null);
  if (!data) return showToast('Failed to load service details', 'error');
  const service = data.items.find(s => s.id === svcId);
  if (!service) return showToast('Service not found', 'error');

  modal.open('Edit Service Pricing', `
    <div class="form-group"><label class="form-label">Service Feature Name</label>
      <input class="form-control" value="${service.service_name}" disabled /></div>
    <div class="form-group"><label class="form-label">Display Name</label>
      <input id="esvc-display" class="form-control" value="${service.display_name}" /></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Pricing Type</label>
        <select id="esvc-pricing-type" class="form-control">
          <option value="per_hit" ${service.pricing_type === 'per_hit' ? 'selected' : ''}>Per Hit (Flat rate)</option>
          <option value="per_1k_tokens" ${service.pricing_type === 'per_1k_tokens' ? 'selected' : ''}>Per 1K Tokens (Token-based)</option>
        </select></div>
      <div class="form-group"><label class="form-label">Cost per Hit/1K Tokens (IDR)</label>
        <input id="esvc-cost" type="number" step="0.000001" class="form-control" value="${service.cost_per_hit}" min="0" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Currency</label>
        <input id="esvc-currency" class="form-control" value="IDR" disabled /></div>
      <div class="form-group"><label class="form-label">Monthly Hit Limit</label>
        <input id="esvc-hit-limit" type="number" class="form-control" value="${service.hit_limit_monthly || ''}" placeholder="No Limit" /></div>
    </div>
    <div class="form-group"><label class="form-label">Monthly Cost Limit</label>
      <input id="esvc-cost-limit" type="number" step="0.01" class="form-control" value="${service.cost_limit_monthly || ''}" placeholder="No Limit" /></div>
    <div class="form-group"><label class="form-label">Description</label>
      <input id="esvc-desc" class="form-control" value="${service.description || ''}" /></div>
    <div class="form-group" style="display:flex; align-items:center; gap:8px;">
      <input id="esvc-active" type="checkbox" ${service.is_active ? 'checked' : ''} style="width:auto;" />
      <label class="form-label" style="margin:0;" for="esvc-active">Active</label>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="esvc-confirm">Save Changes</button>
  `);

  document.getElementById('esvc-confirm').addEventListener('click', async () => {
    const displayName = document.getElementById('esvc-display').value.trim();
    const pricingType = document.getElementById('esvc-pricing-type').value;
    const costPerHit = parseFloat(document.getElementById('esvc-cost').value) || 0;
    const costCurrency = document.getElementById('esvc-currency').value;
    const hitLimitMonthly = parseInt(document.getElementById('esvc-hit-limit').value) || null;
    const costLimitMonthly = parseFloat(document.getElementById('esvc-cost-limit').value) || null;
    const description = document.getElementById('esvc-desc').value.trim();
    const isActive = document.getElementById('esvc-active').checked;

    if (!displayName) return showToast('Please enter a display name', 'error');

    try {
      await PATCH(`/api/admin/services/${svcId}`, {
        displayName,
        pricingType,
        costPerHit,
        costCurrency,
        hitLimitMonthly,
        costLimitMonthly,
        description,
        isActive
      });
      modal.close();
      showToast('Service pricing updated successfully', 'success');
      renderSettingsTab('services');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

window.deactivateService = async function(svcId, displayName) {
  if (!confirm(`Are you sure you want to deactivate pricing for "${displayName}"?`)) return;
  try {
    await DEL(`/api/admin/services/${svcId}`);
    showToast('Service pricing deactivated', 'success');
    renderSettingsTab('services');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.recalculateCosts = async function() {
  if (!confirm('Are you sure you want to recalculate cost_amount for all existing uncosted (0 cost) events based on current service registry pricing?')) return;
  try {
    const res = await POST('/api/admin/services/recalculate', {});
    showToast(`Recalculation complete. ${res.eventsUpdated} events updated across ${res.servicesProcessed} services.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ── Company Modals & Actions ──────────────────────────────────────────────────
window.showAddCompanyModal = function() {
  modal.open('Create Company Profile', `
    <div class="form-group"><label class="form-label">Company Name</label>
      <input id="acomp-name" class="form-control" placeholder="e.g. Lintasarta" /></div>
    <div class="form-group"><label class="form-label">Description</label>
      <input id="acomp-desc" class="form-control" placeholder="e.g. Lintasarta Subsidiary or Dept..." /></div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="acomp-confirm">Create Company</button>
  `);

  document.getElementById('acomp-confirm').addEventListener('click', async () => {
    const name = document.getElementById('acomp-name').value.trim();
    const description = document.getElementById('acomp-desc').value.trim();

    if (!name) return showToast('Please enter a company name', 'error');

    try {
      await POST('/api/admin/companies', { name, description });
      modal.close();
      showToast('Company profile created successfully', 'success');
      renderSettingsTab('companies');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

window.showEditCompanyModal = function(compId, name, desc, isActive) {
  modal.open('Edit Company Profile', `
    <div class="form-group"><label class="form-label">Company Name</label>
      <input id="ecomp-name" class="form-control" value="${name}" /></div>
    <div class="form-group"><label class="form-label">Description</label>
      <input id="ecomp-desc" class="form-control" value="${desc}" /></div>
    <div class="form-group" style="display:flex; align-items:center; gap:8px;">
      <input id="ecomp-active" type="checkbox" ${isActive ? 'checked' : ''} style="width:auto;" />
      <label class="form-label" style="margin:0;" for="ecomp-active">Active</label>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="ecomp-confirm">Save Changes</button>
  `);

  document.getElementById('ecomp-confirm').addEventListener('click', async () => {
    const newName = document.getElementById('ecomp-name').value.trim();
    const newDesc = document.getElementById('ecomp-desc').value.trim();
    const newActive = document.getElementById('ecomp-active').checked;

    if (!newName) return showToast('Please enter a company name', 'error');

    try {
      await PATCH(`/api/admin/companies/${compId}`, { name: newName, description: newDesc, isActive: newActive });
      modal.close();
      showToast('Company profile updated successfully', 'success');
      renderSettingsTab('companies');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

window.runThrottleCheck = async function() {
  try {
    const res = await POST('/api/admin/throttle/run', {});
    if (!res) return;
    const n = res.actions?.length || 0;
    const suffix = res.mode === 'enforce'
      ? (res.requiresRestart ? ' — restart GoClaw to apply.' : '.')
      : ` — "${res.mode}" mode: flagged only, channel limits are not enforced.`;
    showToast(`${t('throttle_run_ok') || 'Throttle check completed.'} ${n} action${n === 1 ? '' : 's'}${suffix}`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
};

/* ── My Usage ────────────────────────────────────────────────────────────────── */
pages.myUsage = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `<div id="my-usage-content"><div class="skeleton skeleton-card"></div></div>`;
  try {
    const data = await GET('/api/me/summary');
    if (!data) return;
    const q = data.quota;
    const bannerType = q.quotaStatus === 'CRITICAL' ? 'critical' : q.quotaStatus === 'WARNING' ? 'warning' : q.quotaStatus === 'EXHAUSTED' ? 'exhausted' : null;
    const bannerMsg  = q.quotaStatus === 'CRITICAL'  ? t('quota_critical',  { pct: 100 - q.usagePercentage })
                     : q.quotaStatus === 'WARNING'   ? t('quota_warning',   { pct: 100 - q.usagePercentage })
                     : q.quotaStatus === 'EXHAUSTED' ? t('quota_exhausted')
                     : q.quotaStatus === 'NO_PLAN'   ? t('no_plan')
                     : null;

    document.getElementById('my-usage-content').innerHTML = `
      ${bannerMsg ? `<div class="quota-banner ${bannerType}">${bannerMsg}</div>` : ''}

      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-icon">📦</span>
          <div class="stat-value">${data.plan?.name || '—'}</div>
          <div class="stat-label">${t('my_plan')}</div>
        </div>
        <div class="stat-card">
          <span class="stat-icon">🧮</span>
          <div class="stat-value">${fmtTokens(data.usageThisPeriod.totalTokens)}</div>
          <div class="stat-label">${t('my_used')}</div>
        </div>
        <div class="stat-card">
          <span class="stat-icon">✅</span>
          <div class="stat-value">${fmtTokens(q.totalRemainingTokens)}</div>
          <div class="stat-label">${t('my_remaining')}</div>
        </div>
        <div class="stat-card">
          <span class="stat-icon">🔄</span>
          <div class="stat-value">${fmtDate(data.plan?.resetAt)}</div>
          <div class="stat-label">${t('my_reset')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">${t('my_quota')}</div><div>${statusBadge(q.quotaStatus)}</div></div>
        <div class="quota-display">
          <div class="quota-row"><span class="quota-label">${t('my_recurring')}</span><span class="quota-value">${fmtTokens(q.remainingRecurringTokens)} / ${fmtTokens(q.planQuota)}</span></div>
          <div class="progress-wrap" style="margin:8px 0;"><div class="progress-bar ${progressBarClass(q.usagePercentage)}" style="width:${q.usagePercentage}%"></div></div>
          <div class="quota-row"><span class="quota-label">${t('my_bundle')}</span><span class="quota-value" style="color:var(--success)">${fmtTokens(q.remainingBundleTokens)}</span></div>
        </div>
        ${data.bundles?.length ? `
          <div style="margin-top:12px;">
            <div class="text-sm font-semibold" style="margin-bottom:8px;">Active Bundles</div>
            ${data.bundles.map(b => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border-subtle); font-size:12px;">
              <span>${b.expiresAt ? 'Expires ' + fmtDate(b.expiresAt) : 'No expiry'} ${b.note ? '• ' + b.note : ''}</span>
              <span class="font-semibold">${fmtTokens(b.remainingTokens)} / ${fmtTokens(b.quotaTokens)}</span>
            </div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  } catch (err) { showToast(t('error_load'), 'error'); }
};

/* ── My Events ───────────────────────────────────────────────────────────────── */
pages.myEvents = async function() {
  const content = document.getElementById('page-content');
  let period = 'this_month', skip = 0, take = 20;
  content.innerHTML = `
    <div class="filters-bar">
      ${periodSelectorHTML('mev-period', period)}
      <select id="mev-status" class="form-control" style="width:auto; padding:6px 28px 6px 10px; font-size:12px;">
        <option value="">${t('filter_all_statuses')}</option>
        <option value="SUCCESS">SUCCESS</option>
        <option value="FAILED">FAILED</option>
        <option value="REJECTED">REJECTED</option>
      </select>
      <button class="btn btn-ghost btn-sm" id="mev-filter-btn">Filter</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>${t('col_time')}</th><th>${t('col_source')}</th><th>${t('col_feature')}</th>
        <th>${t('col_model')}</th><th>${t('col_total')}</th>
        <th>${t('col_cost')}</th><th>${t('col_latency')}</th><th>${t('col_status')}</th>
      </tr></thead>
      <tbody id="mev-tbody"><tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">${t('loading')}</td></tr></tbody>
    </table>
    <div class="pagination" id="mev-pagination"></div></div>
  `;

  async function loadMyEvents() {
    const { from, to } = getPeriod(period);
    const params = new URLSearchParams({ from, to, skip, take });
    const statusVal = document.getElementById('mev-status')?.value;
    if (statusVal) params.set('status', statusVal);
    const data = await GET(`/api/me/events?${params}`).catch(() => null);
    if (!data) return;
    const tbody = document.getElementById('mev-tbody');
    tbody.innerHTML = data.items?.length ? data.items.map(e => `<tr>
      <td class="text-xs monospace">${fmtDateTime(e.created_at)}</td>
      <td>${sourceBadge(e.source_service)}</td>
      <td class="text-xs">${e.feature_name || '—'}</td>
      <td class="text-xs monospace">${e.model_name || '—'}</td>
      <td class="font-semibold">${fmtTokens(e.totalTokens)}</td>
      <td class="text-xs">${fmtCost(e.costAmount)}</td>
      <td class="text-xs">${fmtLatency(e.latency_ms)}</td>
      <td>${statusBadge(e.status)}</td>
    </tr>`).join('') : `<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">${t('no_results')}</td></tr>`;
    const totalPages = Math.ceil(data.total / take);
    const currentPage = Math.floor(skip / take) + 1;
    document.getElementById('mev-pagination').innerHTML = `
      <span>${t('showing', { from: skip+1, to: Math.min(skip+take, data.total), total: data.total })}</span>
      <div class="pagination-controls">
        <button class="btn btn-xs btn-ghost" onclick="mevGoPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>←</button>
        <span style="padding:4px 8px; font-size:12px;">${currentPage} / ${totalPages}</span>
        <button class="btn btn-xs btn-ghost" onclick="mevGoPage(${currentPage+1})" ${currentPage>=totalPages?'disabled':''}>→</button>
      </div>
    `;
  }
  window.mevGoPage = (p) => { skip = (p-1)*take; loadMyEvents(); };
  document.getElementById('mev-filter-btn').addEventListener('click', () => { skip = 0; loadMyEvents(); });
  document.getElementById('mev-period').addEventListener('change', (e) => { period = e.target.value; skip = 0; loadMyEvents(); });
  loadMyEvents();
};

/* ── My Plan ─────────────────────────────────────────────────────────────────── */
pages.myPlan = async function() {
  const content = document.getElementById('page-content');
  content.innerHTML = `<div id="my-plan-content"><div class="skeleton skeleton-card"></div></div>`;
  try {
    const [plan, bundles] = await Promise.all([
      GET('/api/me/plan').catch(() => null),
      GET('/api/me/bundles'),
    ]);
    const planHTML = plan ? `
      <div class="card" style="margin-bottom:16px;">
        <div class="card-header"><div class="card-title">Recurring Plan</div><span class="badge badge-active">Active</span></div>
        <div class="quota-display">
          <div class="quota-row"><span class="quota-label">Plan Name</span><span class="quota-value">${plan.name}</span></div>
          <div class="quota-row"><span class="quota-label">Quota Type</span><span class="quota-value">${t(plan.quota_type?.toLowerCase())}</span></div>
          <div class="quota-row"><span class="quota-label">Quota</span><span class="quota-value">${fmtTokens(plan.quotaTokens)}</span></div>
          <div class="quota-row"><span class="quota-label">Period</span><span class="quota-value">${fmtDate(plan.starts_at)} → ${fmtDate(plan.reset_at)}</span></div>
        </div>
      </div>
    ` : `<div class="card" style="margin-bottom:16px;"><div class="empty-state"><div class="empty-state-icon">📦</div><h3>No Active Plan</h3><p>${t('no_plan')}</p></div></div>`;

    const bundlesHTML = bundles?.items?.length ? bundles.items.map(b => `
      <div class="quota-display">
        <div class="quota-row">
          <span class="quota-label">${b.note || 'Token Bundle'}</span>
          <span class="badge badge-${b.bundle_status.toLowerCase()}">${t('bundle_' + b.bundle_status.toLowerCase())}</span>
        </div>
        <div class="quota-row"><span class="quota-label">Remaining</span><span class="quota-value">${fmtTokens(b.remainingTokens)} / ${fmtTokens(b.quotaTokens)}</span></div>
        ${b.expires_at ? `<div class="quota-row"><span class="quota-label">Expires</span><span class="quota-value">${fmtDate(b.expires_at)}</span></div>` : ''}
        <div class="progress-wrap"><div class="progress-bar accent" style="width:${Math.round((b.remainingTokens / b.quotaTokens) * 100)}%"></div></div>
      </div>
    `).join('') : `<p class="text-muted text-sm">No bundles.</p>`;

    document.getElementById('my-plan-content').innerHTML = `
      ${planHTML}
      <div class="card"><div class="card-header"><div class="card-title">Token Bundles</div></div>${bundlesHTML}</div>
    `;
  } catch (err) { showToast(t('error_load'), 'error'); }
};

/* ── User Management Modals ──────────────────────────────────────────────────── */
async function showCreateUserModal(onSuccess) {
  // Load companies for dropdown
  const companiesData = await GET('/api/admin/companies').catch(() => ({ items: [] }));
  const companies = companiesData.items || [];

  modal.open('➕ Create New User', `
    <div class="form-group">
      <label class="form-label">Full Name</label>
      <input type="text" id="cu-name" class="form-control" placeholder="Enter full name" required />
    </div>
    <div class="form-group">
      <label class="form-label">Email</label>
      <input type="email" id="cu-email" class="form-control" placeholder="user@example.com" required />
    </div>
    <div class="form-group">
      <label class="form-label">Password</label>
      <input type="password" id="cu-password" class="form-control" placeholder="Minimum 6 characters" required />
    </div>
    <div class="form-group">
      <label class="form-label">Role</label>
      <select id="cu-role" class="form-control">
        <option value="HUMAN RESOURCES">Human Resources</option>
        <option value="HIRING MANAGER">Hiring Manager</option>
        <option value="ADMIN">Admin</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Company</label>
      <select id="cu-company" class="form-control">
        <option value="">— No Company —</option>
        ${companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
      </select>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="cu-submit">Create User</button>
  `);

  document.getElementById('cu-submit').addEventListener('click', async () => {
    const name = document.getElementById('cu-name').value.trim();
    const email = document.getElementById('cu-email').value.trim();
    const password = document.getElementById('cu-password').value;
    const role = document.getElementById('cu-role').value;
    const companyId = document.getElementById('cu-company').value || null;

    if (!name || !email || !password) { showToast('Please fill all fields', 'error'); return; }
    if (password.length < 6) { showToast('Password must be at least 6 characters', 'error'); return; }

    try {
      const btn = document.getElementById('cu-submit');
      btn.disabled = true; btn.textContent = 'Creating…';
      await POST('/api/admin/users', { name, email, password, role, companyId });
      showToast(`User "${name}" created successfully!`, 'success');
      modal.close();
      if (typeof onSuccess === 'function') onSuccess();
    } catch (err) {
      showToast(err.message || 'Failed to create user', 'error');
      const btn = document.getElementById('cu-submit');
      if (btn) { btn.disabled = false; btn.textContent = 'Create User'; }
    }
  });
}
window.showCreateUserModal = showCreateUserModal;

async function showEditUserModal(userId, name, email, role, onSuccess) {
  // Load companies and current user mapping
  const [companiesData, mappingData] = await Promise.all([
    GET('/api/admin/companies').catch(() => ({ items: [] })),
    GET('/api/admin/mappings').catch(() => ({ items: [] }))
  ]);
  const companies = companiesData.items || [];
  const userMapping = (mappingData.items || []).find(m => m.user_id === userId);
  const currentCompanyId = userMapping?.company_id || '';

  modal.open('✏️ Edit User', `
    <div class="form-group">
      <label class="form-label">Full Name</label>
      <input type="text" id="eu-name" class="form-control" value="${name}" />
    </div>
    <div class="form-group">
      <label class="form-label">Email</label>
      <input type="email" id="eu-email" class="form-control" value="${email}" />
    </div>
    <div class="form-group">
      <label class="form-label">New Password (leave blank to keep current)</label>
      <input type="password" id="eu-password" class="form-control" placeholder="Leave blank to keep" />
    </div>
    <div class="form-group">
      <label class="form-label">Role</label>
      <select id="eu-role" class="form-control">
        <option value="HUMAN RESOURCES" ${role === 'HUMAN RESOURCES' ? 'selected' : ''}>Human Resources</option>
        <option value="HIRING MANAGER" ${role === 'HIRING MANAGER' ? 'selected' : ''}>Hiring Manager</option>
        <option value="ADMIN" ${role === 'ADMIN' ? 'selected' : ''}>Admin</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Company</label>
      <select id="eu-company" class="form-control">
        <option value="">— No Company —</option>
        ${companies.map(c => `<option value="${c.id}" ${c.id === currentCompanyId ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
    </div>
  `, `
    <button class="btn btn-ghost" onclick="modal.close()">${t('cancel')}</button>
    <button class="btn btn-primary" id="eu-submit">Save Changes</button>
  `);

  document.getElementById('eu-submit').addEventListener('click', async () => {
    const body = {};
    const newName = document.getElementById('eu-name').value.trim();
    const newEmail = document.getElementById('eu-email').value.trim();
    const newPass = document.getElementById('eu-password').value;
    const newRole = document.getElementById('eu-role').value;
    const newCompanyId = document.getElementById('eu-company').value || null;

    if (newName && newName !== name) body.name = newName;
    if (newEmail && newEmail !== email) body.email = newEmail;
    if (newPass) body.password = newPass;
    if (newRole !== role) body.role = newRole;
    // Always include companyId so it can be updated
    body.companyId = newCompanyId;

    try {
      const btn = document.getElementById('eu-submit');
      btn.disabled = true; btn.textContent = 'Saving…';
      await PATCH(`/api/admin/users/${userId}`, body);
      showToast('User updated successfully!', 'success');
      modal.close();
      if (typeof onSuccess === 'function') onSuccess();
    } catch (err) {
      showToast(err.message || 'Failed to update user', 'error');
      const btn = document.getElementById('eu-submit');
      if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
  });
}
window.showEditUserModal = showEditUserModal;

async function deleteUser(userId, name, onSuccess) {
  if (!confirm(`Are you sure you want to delete user "${name}"? This action cannot be undone.`)) return;
  try {
    await DEL(`/api/admin/users/${userId}`);
    showToast(`User "${name}" deleted`, 'success');
    if (typeof onSuccess === 'function') onSuccess();
  } catch (err) {
    showToast(err.message || 'Failed to delete user', 'error');
  }
}
window.deleteUser = deleteUser;

/* ─── Bootstrap ──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Lang toggle
  const langBtn = document.getElementById('lang-toggle');
  langBtn.textContent = currentLang === 'en' ? '🇮🇩 ID' : '🇬🇧 EN';
  langBtn.addEventListener('click', () => setLang(currentLang === 'en' ? 'id' : 'en'));

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => router.render());

  // Logout
  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    btn.disabled = true; btn.textContent = 'Signing in…';
    errEl.classList.remove('visible');
    try {
      await handleLogin(
        document.getElementById('login-email').value,
        document.getElementById('login-password').value,
      );
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add('visible');
    } finally {
      btn.disabled = false; btn.textContent = 'Sign In';
    }
  });

  // Restore session
  if (restoreSession()) {
    showApp();
  }
});
