'use strict';

const fs = require('fs');
const path = require('path');
const { dashboardPool, aitmPool } = require('../db');

const GOCLAW_PID    = parseInt(process.env.GOCLAW_PID || '0', 10);
const GOCLAW_CONFIG = process.env.GOCLAW_CONFIG_PATH || '/home/devops/apps/config.json';

// ─── Config helpers ───────────────────────────────────────────────────────────
function readGoclawConfig() {
  return JSON.parse(fs.readFileSync(GOCLAW_CONFIG, 'utf-8'));
}

function writeGoclawConfig(config) {
  const backup = GOCLAW_CONFIG + '.bak';
  try { fs.copyFileSync(GOCLAW_CONFIG, backup); } catch {}
  fs.writeFileSync(GOCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function reloadGoclaw() {
  if (!GOCLAW_PID) {
    console.warn('[Throttle] GOCLAW_PID not set — cannot reload');
    return false;
  }
  try {
    process.kill(GOCLAW_PID, 'SIGHUP');
    console.log(`[Throttle] Sent SIGHUP to GoClaw PID ${GOCLAW_PID}`);
    return true;
  } catch (err) {
    console.error('[Throttle] Failed to send SIGHUP:', err.message);
    return false;
  }
}

const { getUserQuotaSummary, checkServiceLimits } = require('./quota');

// ─── Main throttle check ──────────────────────────────────────────────────────
/**
 * Runs the unified throttle check for ALL limit types:
 * - Token quota (recurring plan exhausted OR bundle quota exhausted)
 * - Service-specific hit count OR cost limits (e.g. N8N Scout)
 *
 * When ANY limit is exceeded, reduces the user's GoClaw message request quota
 * in config.json and sends SIGHUP. Auto-restores when limits are clear.
 */
async function runThrottleCheck() {
  const actions = [];

  const DEFAULT_THROTTLE_LIMIT = parseInt(process.env.DEFAULT_THROTTLE_REQUEST_LIMIT || '1', 10);

  // ── Get all HR/HM users from AITM DB ─────────────────────────────────────────
  const { rows: aitmUsers } = await aitmPool.query(`
    SELECT
      u.id AS user_id,
      u.name,
      u.email,
      ur.role_name AS role
    FROM users u
    JOIN employees e ON e.user_id = u.id
    JOIN user_roles ur ON ur.id = e.user_role_id
    WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
  `);

  // Get mappings from Dashboard DB
  const { rows: mappings } = await dashboardPool.query(`
    SELECT user_id, goclaw_sender_id FROM llm_user_mappings WHERE goclaw_sender_id IS NOT NULL
  `);
  const mappingMap = new Map(mappings.map(m => [m.user_id, m.goclaw_sender_id]));

  const users = aitmUsers
    .filter(u => mappingMap.has(u.user_id))
    .map(u => ({ ...u, goclaw_sender_id: mappingMap.get(u.user_id) }));

  // Load GoClaw config
  let config;
  try {
    config = readGoclawConfig();
  } catch (err) {
    console.error('[Throttle] Cannot read GoClaw config:', err.message);
    return { error: err.message, actions };
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.quota) config.gateway.quota = { enabled: true, default: { hour: 20, day: 100, week: 500 }, groups: {} };
  if (!config.gateway.quota.groups) config.gateway.quota.groups = {};

  let configChanged = false;

  for (const user of users) {
    const groupKey = `user:${user.goclaw_sender_id}`;
    const isCurrentlyThrottled = !!config.gateway.quota.groups[groupKey];
    const throttleReasons = [];

    // Get user's quota summary (handles individual and company-level assignments)
    let quotaSummary;
    try {
      quotaSummary = await getUserQuotaSummary(user.user_id);
    } catch (err) {
      console.error(`[Throttle] Error getting quota summary for ${user.email}:`, err.message);
      continue;
    }

    // ── 1. Check token quota ──────────────────────────────────────────────────
    if (quotaSummary.totalRemainingTokens <= 0) {
      if (quotaSummary.assignment) {
        throttleReasons.push(`TOKEN_QUOTA_EXHAUSTED (used ${quotaSummary.usedRecurringTokens}/${quotaSummary.planQuota})`);
      } else {
        throttleReasons.push('NO_ACTIVE_PLAN_OR_QUOTA');
      }
    }

    // ── 2. Check Service Limits for registered active services ────────────────
    try {
      const { rows: activeServices } = await dashboardPool.query(`
        SELECT service_name, display_name FROM llm_service_registry WHERE is_active = true
      `);
      for (const svc of activeServices) {
        const limitCheck = await checkServiceLimits(user.user_id, svc.service_name);
        if (limitCheck.exceeded) {
          for (const reason of limitCheck.reasons) {
            if (reason.type === 'HIT_LIMIT') {
              throttleReasons.push(`${svc.display_name.toUpperCase()}_HIT_LIMIT (${reason.hits}/${reason.limit})`);
            } else if (reason.type === 'COST_LIMIT') {
              throttleReasons.push(`${svc.display_name.toUpperCase()}_COST_LIMIT ($${reason.totalCost.toFixed(2)}/$${reason.limit.toFixed(2)})`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Throttle] Error checking service limits for ${user.email}:`, err.message);
    }

    const shouldThrottle = throttleReasons.length > 0;

    // ── Apply throttle config change ──────────────────────────────────────────
    if (shouldThrottle && !isCurrentlyThrottled) {
      config.gateway.quota.groups[groupKey] = {
        hour: DEFAULT_THROTTLE_LIMIT,
        day:  DEFAULT_THROTTLE_LIMIT,
      };
      configChanged = true;
      actions.push({ userId: user.user_id, senderId: user.goclaw_sender_id, action: 'throttled', reasons: throttleReasons });

      await dashboardPool.query(`
        INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
        VALUES (gen_random_uuid(), 'system', 'throttle.apply', 'user', $1, $2, NOW())
      `, [user.user_id, JSON.stringify({ reasons: throttleReasons, goclawSenderId: user.goclaw_sender_id })]);

      console.log(`[Throttle] 🔴 Throttled ${user.name} (${user.goclaw_sender_id}): ${throttleReasons.join(', ')}`);

    } else if (!shouldThrottle && isCurrentlyThrottled) {
      delete config.gateway.quota.groups[groupKey];
      configChanged = true;
      actions.push({ userId: user.user_id, senderId: user.goclaw_sender_id, action: 'restored' });

      await dashboardPool.query(`
        INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
        VALUES (gen_random_uuid(), 'system', 'throttle.restore', 'user', $1, $2, NOW())
      `, [user.user_id, JSON.stringify({ goclawSenderId: user.goclaw_sender_id })]);

      console.log(`[Throttle] 🟢 Restored ${user.name} (${user.goclaw_sender_id})`);
    }
  }

  if (configChanged) {
    config.gateway.quota.enabled = true;
    if (Object.keys(config.gateway.quota.groups).length === 0) {
      delete config.gateway.quota.groups;
    }
    writeGoclawConfig(config);
    reloadGoclaw();
  }

  return { actions, configChanged };
}

module.exports = { runThrottleCheck, readGoclawConfig, writeGoclawConfig, reloadGoclaw };
