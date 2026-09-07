'use strict';

// ─── Bootstrap env ────────────────────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

const express  = require('express');
const cron     = require('node-cron');
const http     = require('http');
const { URL }  = require('url');

const { testConnections } = require('./src/db');
const { runThrottleCheck, syncCompaniesFromAitm, ensureTrialAssignments, THROTTLE_MODE, GOCLAW_CONFIG } = require('./src/services/throttle');
const { syncGoclawTraces, computeDailyAggregates } = require('./src/services/usage-sync');

const adminUsageRoutes  = require('./src/routes/admin-usage');
const adminPlansRoutes  = require('./src/routes/admin-plans');
const userUsageRoutes   = require('./src/routes/user-usage');
const internalRoutes    = require('./src/routes/internal');

const PORT          = parseInt(process.env.PORT || '3003', 10);
const CRON_THROTTLE = parseInt(process.env.CRON_THROTTLE_MINUTES || '5', 10);
const CRON_SYNC     = parseInt(process.env.CRON_GOCLAW_SYNC_MINUTES || '5', 10);
const GOCLAW_API    = process.env.GOCLAW_API_URL   || 'http://localhost:18790';
const GOCLAW_TOKEN  = process.env.GOCLAW_GATEWAY_TOKEN || '';

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/admin',    adminUsageRoutes);
app.use('/api/admin',    adminPlansRoutes);
app.use('/api/me',       userUsageRoutes);
app.use('/api/internal', internalRoutes);

// ─── GoClaw API Proxy ─────────────────────────────────────────────────────────
function proxyToGoclaw(req, res, apiPath) {
  const url = new URL(apiPath, GOCLAW_API);
  const qs  = new URL(req.url, 'http://localhost').searchParams;
  for (const [k, v] of qs.entries()) url.searchParams.set(k, v);

  const opts = {
    hostname: url.hostname,
    port:     url.port,
    path:     url.pathname + url.search,
    method:   req.method,
    headers:  { 'Authorization': `Bearer ${GOCLAW_TOKEN}` },
    timeout:  15000,
  };
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    opts.headers['Content-Type'] = 'application/json';
  }

  const proxyReq = http.request(opts, (proxyRes) => {
    res.status(proxyRes.statusCode);
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
    }
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => res.status(502).json({ error: 'GoClaw API unavailable', detail: err.message }));
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ error: 'GoClaw API timeout' }); });
  if (req.method !== 'GET' && req.method !== 'DELETE' && req.body) {
    proxyReq.write(JSON.stringify(req.body));
  }
  proxyReq.end();
}

const { requireAuth, requireAdmin } = require('./src/auth');
app.get('/api/goclaw/usage/summary',       requireAuth, requireAdmin, (req, res) => proxyToGoclaw(req, res, '/v1/usage/summary'));
app.get('/api/goclaw/usage/timeseries',    requireAuth, requireAdmin, (req, res) => proxyToGoclaw(req, res, '/v1/usage/timeseries'));
app.get('/api/goclaw/usage/breakdown',     requireAuth, requireAdmin, (req, res) => proxyToGoclaw(req, res, '/v1/usage/breakdown'));
app.get('/api/goclaw/usage-caps/policies', requireAuth, requireAdmin, (req, res) => proxyToGoclaw(req, res, '/v1/usage-caps/policies'));
app.get('/api/goclaw/contacts',            requireAuth, requireAdmin, (req, res) => proxyToGoclaw(req, res, '/v1/contacts'));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
// GoClaw traces sync (every N minutes)
cron.schedule(`*/${CRON_SYNC} * * * *`, async () => {
  console.log(`[Cron] 🔄 Syncing GoClaw traces...`);
  try { await syncGoclawTraces(); } catch (err) { console.error('[Cron] Sync error:', err.message); }
});

// Throttle check (every N minutes)
cron.schedule(`*/${CRON_THROTTLE} * * * *`, async () => {
  console.log(`[Cron] 🛡️  Running throttle check...`);
  try {
    const sync = await syncCompaniesFromAitm();
    if (sync.mappingsUpdated > 0) console.log('[Cron] Company sync:', sync);
    const trials = await ensureTrialAssignments();
    if (trials > 0) console.log(`[Cron] Trial plans auto-assigned: ${trials}`);
    const result = await runThrottleCheck();
    if (result.actions?.length) {
      console.log(`[Cron] Throttle actions (${result.mode} mode):`, result.actions);
      if (result.requiresRestart) console.log('[Cron] ⚠️  GoClaw container restart required to apply the quota config change');
    }
  } catch (err) { console.error('[Cron] Throttle error:', err.message); }
});

// Daily aggregate (at midnight)
cron.schedule('0 0 * * *', async () => {
  console.log('[Cron] 📊 Computing daily aggregates...');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  try { await computeDailyAggregates(yesterday); } catch (err) { console.error('[Cron] Aggregate error:', err.message); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 LLM Usage Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`   Throttle check: every ${CRON_THROTTLE} minutes (channel mode: ${THROTTLE_MODE})`);
  console.log(`   GoClaw sync:    every ${CRON_SYNC} minutes`);
  console.log(`   GoClaw API:     ${GOCLAW_API}`);
  if (THROTTLE_MODE === 'enforce') {
    console.log(`   Channel quota:  ${GOCLAW_CONFIG}\n`);
  } else {
    console.log(`   ⚠️  Channel (WhatsApp) quotas are NOT enforced in "${THROTTLE_MODE}" mode —`);
    console.log(`      members reaching agents outside the talent app are only audit-flagged.`);
    console.log(`      Web chat is enforced per request by the AITM backend preflight.\n`);
  }
  await testConnections();
});
