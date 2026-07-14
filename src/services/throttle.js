'use strict';

const fs = require('fs');
const path = require('path');
const { aitmPool } = require('../db');

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

// ─── Main throttle check ──────────────────────────────────────────────────────
/**
 * Runs the unified throttle check for ALL limit types:
 * - Token quota (recurring plan exhausted)
 * - Bundle quota (all bundles exhausted)
 * - N8N Scout hit count limit
 * - N8N Scout cost limit
 *
 * When ANY limit is exceeded, reduces the user's GoClaw message request quota
 * in config.json and sends SIGHUP. Auto-restores when limits are clear.
 */
async function runThrottleCheck() {
  const actions = [];

  // ── Get all HR/HM users with plan assignments ──────────────────────────────
  const { rows: users } = await aitmPool.query(`
    SELECT
      u.id AS user_id,
      u.name,
      u.email,
      ur.role_name AS role,
      -- Mapping to GoClaw WhatsApp sender_id
      m.goclaw_sender_id,
      -- Active plan quota
      a.id AS assignment_id,
      a.starts_at,
      a.reset_at,
      p.quota_tokens AS plan_quota,
      p.quota_type,
      -- Throttle settings
      COALESCE(
        (SELECT throttle_request_limit FROM user_token_limits WHERE user_id = m.goclaw_sender_id),
        1
      ) AS throttle_req_limit,
      COALESCE(
        (SELECT original_request_limit FROM user_token_limits WHERE user_id = m.goclaw_sender_id),
        20
      ) AS original_req_limit,
      COALESCE(
        (SELECT warning_threshold_pct FROM user_token_limits WHERE user_id = m.goclaw_sender_id),
        80
      ) AS warning_pct
    FROM users u
    JOIN employees e ON e.user_id = u.id
    JOIN user_roles ur ON ur.id = e.user_role_id
    LEFT JOIN llm_user_mappings m ON m.user_id = u.id
    LEFT JOIN llm_plan_assignments a ON a.user_id = u.id AND a.is_active = true
    LEFT JOIN llm_token_plans p ON p.id = a.plan_id
    WHERE ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
  `);

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
    if (!user.goclaw_sender_id) continue; // No GoClaw mapping — skip throttle

    const groupKey = `user:${user.goclaw_sender_id}`;
    const isCurrentlyThrottled = !!config.gateway.quota.groups[groupKey];
    const throttleReasons = [];

    // ── 1. Check token quota ──────────────────────────────────────────────────
    if (user.assignment_id && user.plan_quota) {
      const { rows: usageRows } = await aitmPool.query(`
        SELECT COALESCE(SUM(total_tokens), 0) AS used
        FROM llm_usage_events
        WHERE user_id = $1
          AND status = 'SUCCESS'
          AND quota_source IN ('RECURRING', 'BOTH')
          AND created_at >= $2
          AND created_at < $3
      `, [user.user_id, user.starts_at, user.reset_at]);
      const used = BigInt(usageRows[0].used);
      const quota = BigInt(user.plan_quota);
      if (used >= quota) {
        throttleReasons.push(`TOKEN_QUOTA_EXHAUSTED (${used}/${quota})`);
      }
    }

    // ── 2. Check bundle quota ─────────────────────────────────────────────────
    const { rows: bundles } = await aitmPool.query(`
      SELECT SUM(remaining_tokens) AS total_remaining
      FROM llm_quota_bundles
      WHERE user_id = $1
        AND remaining_tokens > 0
        AND (expires_at IS NULL OR expires_at > NOW())
    `, [user.user_id]);
    // If they had bundles but now exhausted, and no plan → throttle
    const { rows: hadBundles } = await aitmPool.query(`
      SELECT COUNT(*) AS cnt FROM llm_quota_bundles WHERE user_id = $1
    `, [user.user_id]);
    const hasBundles = parseInt(hadBundles[0].cnt) > 0;
    const bundleRemaining = bundles[0].total_remaining ? parseInt(bundles[0].total_remaining) : 0;

    if (hasBundles && bundleRemaining === 0 && !user.assignment_id) {
      throttleReasons.push('BUNDLE_EXHAUSTED');
    }

    // ── 3. Check N8N Scout limits ─────────────────────────────────────────────
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const { rows: scouts } = await aitmPool.query(`
      SELECT
        sr.service_name,
        sr.hit_limit_monthly,
        sr.cost_limit_monthly,
        COUNT(e.id) AS hit_count,
        COALESCE(SUM(e.cost_amount), 0) AS total_cost
      FROM llm_service_registry sr
      LEFT JOIN llm_usage_events e
        ON e.feature_name = sr.service_name
        AND e.user_id = $1
        AND e.status = 'SUCCESS'
        AND e.created_at >= $2
      WHERE sr.source_service = 'N8N' AND sr.is_active = true
      GROUP BY sr.service_name, sr.hit_limit_monthly, sr.cost_limit_monthly
    `, [user.user_id, monthStart]);

    for (const scout of scouts) {
      if (scout.hit_limit_monthly && parseInt(scout.hit_count) >= parseInt(scout.hit_limit_monthly)) {
        throttleReasons.push(`${scout.service_name.toUpperCase()}_HIT_LIMIT (${scout.hit_count}/${scout.hit_limit_monthly} hits)`);
      }
      if (scout.cost_limit_monthly && parseFloat(scout.total_cost) >= parseFloat(scout.cost_limit_monthly)) {
        throttleReasons.push(`${scout.service_name.toUpperCase()}_COST_LIMIT ($${scout.total_cost}/$${scout.cost_limit_monthly})`);
      }
    }

    const shouldThrottle = throttleReasons.length > 0;

    // ── Apply throttle config change ──────────────────────────────────────────
    if (shouldThrottle && !isCurrentlyThrottled) {
      config.gateway.quota.groups[groupKey] = {
        hour: parseInt(user.throttle_req_limit) || 1,
        day:  parseInt(user.throttle_req_limit) || 1,
      };
      configChanged = true;
      actions.push({ userId: user.user_id, senderId: user.goclaw_sender_id, action: 'throttled', reasons: throttleReasons });

      await aitmPool.query(`
        INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
        VALUES (gen_random_uuid(), 'system', 'throttle.apply', 'user', $1, $2, NOW())
      `, [user.user_id, JSON.stringify({ reasons: throttleReasons, goclawSenderId: user.goclaw_sender_id })]);

      console.log(`[Throttle] 🔴 Throttled ${user.name} (${user.goclaw_sender_id}): ${throttleReasons.join(', ')}`);

    } else if (!shouldThrottle && isCurrentlyThrottled) {
      delete config.gateway.quota.groups[groupKey];
      configChanged = true;
      actions.push({ userId: user.user_id, senderId: user.goclaw_sender_id, action: 'restored' });

      await aitmPool.query(`
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
