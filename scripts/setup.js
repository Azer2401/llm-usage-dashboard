'use strict';

// ============================================================
// Setup Script — Run once to initialize the database
// Usage: node scripts/setup.js
// ============================================================

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
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

const DB_HOST     = process.env.AITM_DB_HOST     || 'localhost';
const DB_PORT     = process.env.AITM_DB_PORT     || '5432';
const DB_NAME     = process.env.AITM_DB_NAME     || 'ai_talent_db';
const DB_USER     = process.env.AITM_DB_USER     || 'postgres';
const DB_PASSWORD = process.env.AITM_DB_PASSWORD || 'postgres';

const PSQL = `PGPASSWORD=${DB_PASSWORD} psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME}`;

function run(label, cmd) {
  console.log(`\n[Setup] ${label}...`);
  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
    console.log(`[Setup] ✅ ${label} done`);
  } catch (err) {
    console.error(`[Setup] ❌ ${label} failed:`, err.message);
    process.exit(1);
  }
}

// 1. Install dependencies
run('Installing npm dependencies', 'npm install --prefix ' + path.join(__dirname, '..'));

// 2. Run Prisma migration
run('Running Prisma migration', `cd "${path.join(__dirname, '..')}" && npx prisma migrate deploy`);

// 3. Generate Prisma client
run('Generating Prisma client', `cd "${path.join(__dirname, '..')}" && npx prisma generate`);

// 4. Seed database
const seedFile = path.join(__dirname, 'seed.sql');
run('Seeding database', `${PSQL} -f "${seedFile}"`);

console.log('\n✅ Setup complete! Run: node server.js\n');
