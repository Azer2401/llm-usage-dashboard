'use strict';

const fs = require('fs');
const { dashboardPool, aitmPool } = require('../db');
const { getUserQuotaSummary, checkServiceLimits, findWindowViolation } = require('./quota');

// ─── GoClaw channel-side enforcement ─────────────────────────────────────────
// GoClaw v3.14 applies `gateway.quota` ONLY on the channel-inbound path
// (WhatsApp and friends). Web chat (`chat.send`) is never quota-checked by the
// gateway — it is gated by the AITM backend's preflight instead. Three facts
// about v3.14 shape this module:
//
//   1. `gateway.quota.groups` is keyed by the RAW channel user id (a WhatsApp
//      JID such as 62812…@s.whatsapp.net or …@lid). There is no `user:` prefix
//      anywhere in the Go source, so the keys written by the pre-Docker host
//      deployment never matched anything.
//   2. A QuotaWindow of 0 means UNLIMITED, so a block has to be a positive
//      integer (1 = first message in the window passes, the rest are refused
//      with a "quota exceeded" reply).
//   3. The quota checker is constructed once, at gateway startup, and only when
//      quota is already enabled in the loaded config. There is no SIGHUP handler
//      and the on-disk config watcher is dead code, so writing the file has no
//      effect until the container restarts. Hot group edits need the
//      `config.patch` WebSocket RPC, which is not implemented here.
//
// Modes (GOCLAW_THROTTLE_MODE):
//   off     — evaluate nothing
//   report  — evaluate and audit-log who should be blocked, touch no config
//             (default; there is currently no WhatsApp traffic to police)
//   enforce — additionally write the quota groups into GOCLAW_CONFIG_PATH, which
//             must be the GoClaw container's own config (/app/data/config.json,
//             i.e. the goclaw-data volume mounted into this container). The
//             first switch to enforce needs one GoClaw restart so the checker
//             gets instantiated; group edits after that still need a restart
//             until a config.patch client exists.
const THROTTLE_MODE   = (process.env.GOCLAW_THROTTLE_MODE || 'report').toLowerCase();
const GOCLAW_CONFIG   = process.env.GOCLAW_CONFIG_PATH || '/app/data/config.json';
const THROTTLE_BLOCK  = Math.max(1, parseInt(process.env.THROTTLE_BLOCK_LIMIT || '1', 10));

// Sender ids flagged by the previous run, so audit rows are written on
// transitions only. Process-local: in report mode a restart re-flags once, and
// in enforce mode the state is re-seeded from the config file below.
const flagged = new Map();

// ─── Config helpers ───────────────────────────────────────────────────────────
function readGoclawConfig() {
  if (!fs.existsSync(GOCLAW_CONFIG)) return {};
  return JSON.parse(fs.readFileSync(GOCLAW_CONFIG, 'utf-8'));
}

function writeGoclawConfig(config) {
  try { fs.copyFileSync(GOCLAW_CONFIG, GOCLAW_CONFIG + '.bak'); } catch {}
  fs.writeFileSync(GOCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Kept for the admin "reset throttle" route. v3.14 cannot be signalled into a
 * reload, so this only reports what the operator has to do.
 */
function reloadGoclaw() {
  console.warn(`[Throttle] ⚠️  Quota config written to ${GOCLAW_CONFIG} — restart the GoClaw container to apply it (v3.14 has no SIGHUP reload; hot edits need the config.patch WS RPC)`);
  return false;
}

// ─── Main throttle check ──────────────────────────────────────────────────────
/**
 * Evaluates every mapped HR/HM member against all limit types:
 * - Plan quota (messages when the plan defines them, otherwise legacy tokens)
 * - HR-admin rolling windows (5 hours / 7 days, per member)
 * - Service-specific hit count or cost limits (e.g. N8N Scout)
 *
 * In enforce mode a member over any limit gets a blocking quota group keyed by
 * their raw GoClaw sender id; clearing the limits removes it again.
 */
async function runThrottleCheck() {
  const actions = [];
  if (THROTTLE_MODE === 'off') {
    return { mode: THROTTLE_MODE, actions, configChanged: false, requiresRestart: false };
  }
  const enforce = THROTTLE_MODE === 'enforce';

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

  // Load GoClaw config (enforce mode only — report mode must not touch it)
  let config = null;
  if (enforce) {
    // Writing to a path GoClaw does not read is the exact failure this module
    // used to have, so refuse instead of silently "enforcing" nothing.
    if (!fs.existsSync(GOCLAW_CONFIG)) {
      const msg = `GOCLAW_THROTTLE_MODE=enforce but ${GOCLAW_CONFIG} does not exist — mount GoClaw's own config volume into this container (see the commented goclaw_goclaw-data volume in docker-compose.yaml)`;
      console.error(`[Throttle] ❌ ${msg}`);
      return { mode: THROTTLE_MODE, error: msg, actions, configChanged: false, requiresRestart: false };
    }
    try {
      config = readGoclawConfig();
    } catch (err) {
      console.error(`[Throttle] Cannot read GoClaw config at ${GOCLAW_CONFIG}:`, err.message);
      return { mode: THROTTLE_MODE, error: err.message, actions, configChanged: false, requiresRestart: false };
    }
    if (!config.gateway) config.gateway = {};
    if (!config.gateway.quota) config.gateway.quota = { enabled: true, groups: {} };
    if (!config.gateway.quota.groups) config.gateway.quota.groups = {};

    const groups = config.gateway.quota.groups;
    // v3.14 matches the raw JID; drop keys left behind by the host deployment
    for (const key of Object.keys(groups)) {
      if (key.startsWith('user:')) delete groups[key];
    }
    // Re-seed transition state from what is already on disk so a restarted
    // dashboard can still clear a stale block
    for (const user of users) {
      if (groups[user.goclaw_sender_id]) flagged.set(user.user_id, true);
    }
  }

  let configChanged = false;

  for (const user of users) {
    const groupKey = user.goclaw_sender_id;
    const throttleReasons = [];

    // Get user's quota summary (handles individual and company-level assignments)
    let quotaSummary;
    try {
      quotaSummary = await getUserQuotaSummary(user.user_id);
    } catch (err) {
      console.error(`[Throttle] Error getting quota summary for ${user.email}:`, err.message);
      continue;
    }

    // ── 1. Check plan quota (messages are the enforcement unit when defined) ──
    if (quotaSummary.hasMessageQuota) {
      if (quotaSummary.totalRemainingMessages <= 0) {
        throttleReasons.push(`MESSAGE_QUOTA_EXHAUSTED (used ${quotaSummary.usedMessages}/${quotaSummary.planMessages ?? '∞'} messages)`);
      }
    } else if (quotaSummary.totalRemainingTokens <= 0) {
      if (quotaSummary.assignment) {
        throttleReasons.push(`TOKEN_QUOTA_EXHAUSTED (used ${quotaSummary.usedRecurringTokens}/${quotaSummary.planQuota})`);
      } else {
        throttleReasons.push('NO_ACTIVE_PLAN_OR_QUOTA');
      }
    }

    // ── 2. Check the HR-admin rolling windows the web chat also enforces ──────
    const windowBlock = findWindowViolation(quotaSummary.windows);
    if (windowBlock) {
      const d = windowBlock.details;
      throttleReasons.push(`${windowBlock.reason} (${d.used}/${d.limit} in ${d.window === 'fiveHour' ? '5h' : '7d'})`);
    }

    // ── 3. Check service limits for registered active services ────────────────
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
    if (shouldThrottle === (flagged.get(user.user_id) || false)) continue;
    flagged.set(user.user_id, shouldThrottle);

    if (enforce) {
      if (shouldThrottle) {
        config.gateway.quota.groups[groupKey] = { hour: THROTTLE_BLOCK, day: THROTTLE_BLOCK, week: THROTTLE_BLOCK };
      } else {
        delete config.gateway.quota.groups[groupKey];
      }
      configChanged = true;
    }

    const auditAction = shouldThrottle
      ? (enforce ? 'throttle.apply' : 'throttle.flag')
      : (enforce ? 'throttle.restore' : 'throttle.clear');
    actions.push({
      userId: user.user_id,
      senderId: groupKey,
      action: shouldThrottle ? 'throttled' : 'restored',
      enforced: enforce,
      ...(shouldThrottle ? { reasons: throttleReasons } : {}),
    });

    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), 'system', $1, 'user', $2, $3, NOW())
    `, [auditAction, user.user_id, JSON.stringify({
      reasons: throttleReasons,
      goclawSenderId: groupKey,
      enforced: enforce,
    })]);

    console.log(`[Throttle] ${shouldThrottle ? '🔴' : '🟢'} ${shouldThrottle ? 'Blocked' : 'Cleared'} ${user.name} (${groupKey})${enforce ? '' : ' [report mode — not enforced]'}${shouldThrottle ? `: ${throttleReasons.join(', ')}` : ''}`);
  }

  let requiresRestart = false;
  if (configChanged) {
    config.gateway.quota.enabled = true;
    if (Object.keys(config.gateway.quota.groups).length === 0) {
      delete config.gateway.quota.groups;
    }
    writeGoclawConfig(config);
    requiresRestart = true;
    reloadGoclaw();
  }

  return {
    mode: THROTTLE_MODE,
    actions,
    configChanged,
    requiresRestart,
    blockedUsers: [...flagged.entries()].filter(([, v]) => v).map(([userId]) => userId),
  };
}

// ─── Company sync from AITM ───────────────────────────────────────────────────
/**
 * Keeps llm_companies and llm_user_mappings.company_id in sync with the AITM
 * companies/employees tables. llm_companies.id reuses the AITM company id so
 * both databases share one company identity space.
 */
async function syncCompaniesFromAitm() {
  const { rows: aitmCompanies } = await aitmPool.query(`
    SELECT c.id, c.name FROM companies c
    WHERE EXISTS (SELECT 1 FROM employees e WHERE e.company_id = c.id)
  `);
  for (const c of aitmCompanies) {
    await dashboardPool.query(`
      INSERT INTO llm_companies (id, name, is_active, created_at, updated_at)
      VALUES ($1, $2, true, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
    `, [c.id, c.name]);
  }

  const { rows: employees } = await aitmPool.query(`
    SELECT user_id, company_id FROM employees WHERE company_id IS NOT NULL
  `);
  let mappingsUpdated = 0;
  for (const emp of employees) {
    const res = await dashboardPool.query(`
      UPDATE llm_user_mappings SET company_id = $1, updated_at = NOW()
      WHERE user_id = $2 AND COALESCE(company_id, '') IS DISTINCT FROM $1
    `, [emp.company_id, emp.user_id]);
    mappingsUpdated += res.rowCount;
  }

  return { companies: aitmCompanies.length, mappingsUpdated };
}

// ─── Trial plan auto-assignment ───────────────────────────────────────────────
/**
 * Companies without any active plan assignment get the default trial plan
 * (message-limited) so new signups are capped at N messages until a sysadmin
 * assigns a paid plan.
 */
async function ensureTrialAssignments() {
  const trialPlanName = process.env.DEFAULT_TRIAL_PLAN_NAME || 'Demo Trial';
  const planRes = await dashboardPool.query(`
    SELECT id, quota_type FROM llm_token_plans WHERE name = $1 AND is_active = true
  `, [trialPlanName]);
  if (planRes.rows.length === 0) return 0;
  const plan = planRes.rows[0];

  const { rows: companies } = await dashboardPool.query(`
    SELECT id, name FROM llm_companies WHERE is_active = true
  `);

  let created = 0;
  for (const company of companies) {
    const activeRes = await dashboardPool.query(`
      SELECT id FROM llm_plan_assignments WHERE company_id = $1 AND is_active = true
    `, [company.id]);
    if (activeRes.rows.length > 0) continue;

    const start = new Date();
    const reset = new Date(start);
    if (plan.quota_type === 'YEARLY') {
      reset.setFullYear(reset.getFullYear() + 1); reset.setMonth(0, 1); reset.setHours(0, 0, 0, 0);
    } else {
      reset.setMonth(reset.getMonth() + 1); reset.setDate(1); reset.setHours(0, 0, 0, 0);
    }

    await dashboardPool.query(`
      INSERT INTO llm_plan_assignments (id, user_id, company_id, plan_id, starts_at, reset_at, is_active, created_at, updated_at)
      VALUES (gen_random_uuid(), NULL, $1, $2, $3, $4, true, NOW(), NOW())
    `, [company.id, plan.id, start, reset]);

    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), 'system', 'plan.assign.trial', 'llm_plan_assignment', $1, $2, NOW())
    `, [company.id, JSON.stringify({ planId: plan.id, planName: trialPlanName, auto: true })]);

    console.log(`[Throttle] 🎁 Auto-assigned trial plan "${trialPlanName}" to company ${company.name}`);
    created++;
  }
  return created;
}

module.exports = {
  runThrottleCheck,
  syncCompaniesFromAitm,
  ensureTrialAssignments,
  readGoclawConfig,
  writeGoclawConfig,
  reloadGoclaw,
  THROTTLE_MODE,
  GOCLAW_CONFIG,
};
