'use strict';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// ─── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

// ─── Dashboard DB Pool (llm_dashboard_db, port 5434) ─────────────────────────
const dashboardPool = new Pool({
  host:     process.env.DASHBOARD_DB_HOST     || 'localhost',
  port:     parseInt(process.env.DASHBOARD_DB_PORT || '5434', 10),
  database: process.env.DASHBOARD_DB_NAME     || 'llm_dashboard_db',
  user:     process.env.DASHBOARD_DB_USER     || 'llm_user',
  password: process.env.DASHBOARD_DB_PASSWORD || 'llmdevops2026',
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── AITM DB Pool (n8n_db, port 5432 - read-only for users/roles) ───────────
const aitmPool = new Pool({
  host:     process.env.AITM_DB_HOST     || 'localhost',
  port:     parseInt(process.env.AITM_DB_PORT || '5432', 10),
  database: process.env.AITM_DB_NAME     || 'n8n_db',
  user:     process.env.AITM_DB_USER     || 'n8n_user',
  password: process.env.AITM_DB_PASSWORD || 'n8ndevops',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── GoClaw DB Pool (pgvector, port 5433) ────────────────────────────────────
const goclawPool = new Pool({
  host:     process.env.GOCLAW_DB_HOST     || 'localhost',
  port:     parseInt(process.env.GOCLAW_DB_PORT || '5433', 10),
  database: process.env.GOCLAW_DB_NAME     || 'postgres',
  user:     process.env.GOCLAW_DB_USER     || 'postgres',
  password: process.env.GOCLAW_DB_PASSWORD || 'goclaw',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Log connection errors without crashing
dashboardPool.on('error', (err) => {
  console.error('[Dashboard DB] Unexpected client error:', err.message);
});

aitmPool.on('error', (err) => {
  console.error('[AITM DB] Unexpected client error:', err.message);
});

goclawPool.on('error', (err) => {
  console.error('[GoClaw DB] Unexpected client error:', err.message);
});

async function testConnections() {
  try {
    await dashboardPool.query('SELECT 1');
    console.log('[DB] ✅ Dashboard database connected (llm_dashboard_db:5434)');
  } catch (err) {
    console.error('[DB] ❌ Dashboard database connection failed:', err.message);
  }
  try {
    await aitmPool.query('SELECT 1');
    console.log('[DB] ✅ AITM database connected (n8n_db:5432)');
  } catch (err) {
    console.error('[DB] ❌ AITM database connection failed:', err.message);
  }
  try {
    await goclawPool.query('SELECT 1');
    console.log('[DB] ✅ GoClaw database connected (:5433)');
  } catch (err) {
    console.warn('[DB] ⚠️  GoClaw database not available:', err.message, '— GoClaw sync disabled');
  }
}

module.exports = { dashboardPool, aitmPool, goclawPool, testConnections };

