'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load environment variables
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

const pool = new Pool({
  host: process.env.AITM_DB_HOST || 'localhost',
  port: parseInt(process.env.AITM_DB_PORT || '5432', 10),
  database: process.env.AITM_DB_NAME || 'n8n_db',
  user: process.env.AITM_DB_USER || 'n8n_user',
  password: process.env.AITM_DB_PASSWORD || 'n8ndevops',
});

async function run() {
  try {
    const migrationFile = path.join(__dirname, '../prisma/migrations/20260714000000_init_llm_tables/migration.sql');
    console.log(`[Migration] Reading migration SQL from: ${migrationFile}`);
    let sql = fs.readFileSync(migrationFile, 'utf8');
    // Strip UTF-8 BOM if present
    if (sql.charCodeAt(0) === 0xFEFF) {
      sql = sql.slice(1);
    }

    // Check if table llm_token_plans already exists
    const checkTable = await pool.query("SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'llm_token_plans');");
    const tableExists = checkTable.rows[0].exists;

    if (!tableExists) {
      console.log('[Migration] Applying SQL changes to AITM database...');
      await pool.query(sql);
      console.log('[Migration] ✅ SQL Migration successfully applied!');
    } else {
      console.log('[Migration] ⚠️  Tables already exist, skipping SQL migration.');
    }

    // Seed database if seed.sql exists
    const seedFile = path.join(__dirname, 'seed.sql');
    if (fs.existsSync(seedFile)) {
      console.log(`[Migration] Seeding database from: ${seedFile}`);
      let seedSql = fs.readFileSync(seedFile, 'utf8');
      if (seedSql.charCodeAt(0) === 0xFEFF) {
        seedSql = seedSql.slice(1);
      }
      await pool.query(seedSql);
      console.log('[Migration] ✅ Seeding completed successfully!');
    }
  } catch (err) {
    console.error('[Migration] ❌ Error deploying schema/seeding:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
