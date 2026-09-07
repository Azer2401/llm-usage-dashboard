'use strict';

const { dashboardPool, aitmPool } = require('../db');

// ─── Period helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the effective quota period window for an assignment.
 * If the stored reset_at is already in the past (periods are not auto-renewed
 * in the DB), re-anchor to the current calendar period based on quota_type.
 */
function getPeriodWindow(assignment, now = new Date()) {
  if (!assignment) return { start: null, end: null };
  const start = new Date(assignment.starts_at);
  const end = new Date(assignment.reset_at);
  if (!isNaN(end.getTime()) && end > now) {
    return { start, end };
  }
  if (assignment.quota_type === 'YEARLY') {
    return {
      start: new Date(now.getFullYear(), 0, 1),
      end: new Date(now.getFullYear() + 1, 0, 1),
    };
  }
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
}

const MESSAGE_EVENT_FILTER = `source_service = 'GOCLAW' AND feature_name = 'goclaw_chat'`;

// ─── Rolling window limits (HR-admin configurable, counted per member) ───────
const WINDOW_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};
const EMPTY_WINDOW_USAGE = { used: 0, oldest: null };

async function getCompanyMessageLimits(companyId) {
  if (!companyId) return null;
  const res = await dashboardPool.query(`
    SELECT company_id, five_hour_enabled, five_hour_limit, week_enabled, week_limit, updated_by, updated_at
    FROM llm_company_message_limits
    WHERE company_id = $1
  `, [companyId]);
  return res.rows[0] || null;
}

async function setCompanyMessageLimits(companyId, limits) {
  const { rows } = await dashboardPool.query(`
    INSERT INTO llm_company_message_limits
      (company_id, five_hour_enabled, five_hour_limit, week_enabled, week_limit, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (company_id) DO UPDATE SET
      five_hour_enabled = EXCLUDED.five_hour_enabled,
      five_hour_limit   = EXCLUDED.five_hour_limit,
      week_enabled      = EXCLUDED.week_enabled,
      week_limit        = EXCLUDED.week_limit,
      updated_by        = EXCLUDED.updated_by,
      updated_at        = NOW()
    RETURNING company_id, five_hour_enabled, five_hour_limit, week_enabled, week_limit, updated_by, updated_at
  `, [
    companyId,
    limits.fiveHourEnabled,
    limits.fiveHourLimit ?? null,
    limits.weekEnabled,
    limits.weekLimit ?? null,
    limits.updatedBy || null,
  ]);
  return rows[0];
}

async function getWindowMessageUsage(userId, windowMs) {
  const since = new Date(Date.now() - windowMs);
  const res = await dashboardPool.query(`
    SELECT COUNT(*) AS used, MIN(created_at) AS oldest
    FROM llm_usage_events
    WHERE user_id = $1
      AND status = 'SUCCESS'
      AND ${MESSAGE_EVENT_FILTER}
      AND created_at >= $2
  `, [userId, since]);
  return { used: Number(res.rows[0].used), oldest: res.rows[0].oldest || null };
}

function buildWindowState(enabled, limit, usage, windowMs) {
  if (!enabled || limit === null || limit === undefined) {
    return { enabled: false, limit: null, used: usage.used, remaining: null, pct: 0, freesAt: null };
  }
  const remaining = Math.max(0, limit - usage.used);
  const pct = limit > 0 ? Math.round((usage.used / limit) * 100) : 0;
  // Rolling window: the next slot frees when the oldest counted message ages out
  const freesAt = remaining === 0 && usage.oldest
    ? new Date(new Date(usage.oldest).getTime() + windowMs).toISOString()
    : null;
  return { enabled: true, limit, used: usage.used, remaining, pct, freesAt };
}

async function getWindowStates(userId, limits) {
  if (!limits) return null;
  const [fiveHourUsage, weekUsage] = await Promise.all([
    limits.five_hour_enabled && limits.five_hour_limit !== null
      ? getWindowMessageUsage(userId, WINDOW_MS.fiveHour)
      : Promise.resolve(EMPTY_WINDOW_USAGE),
    limits.week_enabled && limits.week_limit !== null
      ? getWindowMessageUsage(userId, WINDOW_MS.week)
      : Promise.resolve(EMPTY_WINDOW_USAGE),
  ]);
  return {
    fiveHour: buildWindowState(limits.five_hour_enabled, limits.five_hour_limit, fiveHourUsage, WINDOW_MS.fiveHour),
    week: buildWindowState(limits.week_enabled, limits.week_limit, weekUsage, WINDOW_MS.week),
  };
}

function findWindowViolation(windows) {
  if (!windows) return null;
  const defs = [
    ['fiveHour', 'FIVE_HOUR_LIMIT_EXCEEDED'],
    ['week', 'WEEK_LIMIT_EXCEEDED'],
  ];
  for (const [key, reason] of defs) {
    const w = windows[key];
    if (w && w.enabled && w.limit !== null && w.remaining <= 0) {
      return { reason, details: { window: key, used: w.used, limit: w.limit, freesAt: w.freesAt } };
    }
  }
  return null;
}

// ─── Quota Calculation ────────────────────────────────────────────────────────

/**
 * Get a user's current active plan assignment and its usage in the current period.
 * Supports individual plan assignment OR falling back to company-level plan assignment.
 *
 * Enforcement unit is chat messages (quota_messages) when the plan or any bundle
 * defines one; token figures are always kept for monitoring.
 */
async function getUserQuotaSummary(userId) {
  // Get user's company profile (WhatsApp mapping first, AITM employee fallback
  // so web-only users without a mapping row still get company limits)
  const mappingRes = await dashboardPool.query(`
    SELECT company_id FROM llm_user_mappings WHERE user_id = $1
  `, [userId]);
  let companyId = mappingRes.rows[0]?.company_id || null;
  if (!companyId) {
    const empRes = await aitmPool.query(`
      SELECT company_id FROM employees WHERE user_id = $1
    `, [userId]);
    companyId = empRes.rows[0]?.company_id || null;
  }

  // 1. Get active plan assignment (individual first, fallback to company)
  let planRes = await dashboardPool.query(`
    SELECT
      a.id AS assignment_id,
      a.plan_id,
      a.starts_at,
      a.reset_at,
      a.company_id,
      a.user_id,
      p.name AS plan_name,
      p.quota_type,
      p.quota_tokens,
      p.quota_messages
    FROM llm_plan_assignments a
    JOIN llm_token_plans p ON p.id = a.plan_id
    WHERE a.user_id = $1 AND a.is_active = true
    LIMIT 1
  `, [userId]);

  if (planRes.rows.length === 0 && companyId) {
    planRes = await dashboardPool.query(`
      SELECT
        a.id AS assignment_id,
        a.plan_id,
        a.starts_at,
        a.reset_at,
        a.company_id,
        a.user_id,
        p.name AS plan_name,
        p.quota_type,
        p.quota_tokens,
        p.quota_messages
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.company_id = $1 AND a.is_active = true
      LIMIT 1
    `, [companyId]);
  }

  const assignment = planRes.rows[0] || null;

  // 2. Get active bundle balances (both individual and company-level bundles)
  let bundleRes;
  if (companyId) {
    bundleRes = await dashboardPool.query(`
      SELECT
        id, quota_tokens, remaining_tokens, quota_messages, expires_at, created_at, company_id, user_id
      FROM llm_quota_bundles
      WHERE (user_id = $1 OR (company_id = $2 AND company_id IS NOT NULL))
        AND (remaining_tokens > 0 OR quota_messages IS NOT NULL)
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY expires_at ASC NULLS LAST
    `, [userId, companyId]);
  } else {
    bundleRes = await dashboardPool.query(`
      SELECT
        id, quota_tokens, remaining_tokens, quota_messages, expires_at, created_at, company_id, user_id
      FROM llm_quota_bundles
      WHERE user_id = $1
        AND (remaining_tokens > 0 OR quota_messages IS NOT NULL)
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY expires_at ASC NULLS LAST
    `, [userId]);
  }
  const bundles = bundleRes.rows;

  // 3. Calculate used recurring tokens + messages in the current period
  const { start: periodStart, end: periodEnd } = getPeriodWindow(assignment);
  let usedRecurringTokens = 0n;
  let usedMessages = 0;
  if (assignment && periodStart && periodEnd) {
    const scopeCompany = !!assignment.company_id;
    const usageRes = await dashboardPool.query(`
      SELECT
        COALESCE(SUM(total_tokens), 0) AS used_tokens,
        COUNT(*) FILTER (WHERE ${MESSAGE_EVENT_FILTER} AND status = 'SUCCESS') AS used_messages
      FROM llm_usage_events
      WHERE status = 'SUCCESS'
        AND quota_source = 'RECURRING'
        AND created_at >= $2
        AND created_at < $3
        AND ${scopeCompany
          ? `user_id IN (SELECT user_id FROM llm_user_mappings WHERE company_id = $1)`
          : `user_id = $1`}
    `, [scopeCompany ? assignment.company_id : userId, periodStart, periodEnd]);
    usedRecurringTokens = BigInt(usageRes.rows[0].used_tokens);
    usedMessages = Number(usageRes.rows[0].used_messages);
  }

  // 4. Token remainders (monitoring / legacy enforcement)
  const planQuota = assignment ? BigInt(assignment.quota_tokens) : 0n;
  const remainingRecurring = planQuota > usedRecurringTokens ? planQuota - usedRecurringTokens : 0n;
  const tokenBundles = bundles.filter(b => BigInt(b.remaining_tokens) > 0n);
  const remainingBundle = tokenBundles.reduce((acc, b) => acc + BigInt(b.remaining_tokens), 0n);
  const totalRemaining = remainingRecurring + remainingBundle;

  // 5. Message remainders (enforcement unit when defined)
  const planMessages = assignment && assignment.quota_messages !== null && assignment.quota_messages !== undefined
    ? Number(assignment.quota_messages)
    : null;
  const messageBundles = bundles.filter(b => b.quota_messages !== null && b.quota_messages !== undefined);
  const hasMessageQuota = planMessages !== null || messageBundles.length > 0;

  const remainingPlanMessages = planMessages !== null ? Math.max(0, planMessages - usedMessages) : 0;
  // Messages beyond the plan consume message bundles, earliest expiry first
  let overage = planMessages !== null ? Math.max(0, usedMessages - planMessages) : usedMessages;
  let remainingBundleMessages = 0;
  for (const b of messageBundles) {
    const has = Number(b.quota_messages);
    const consumed = Math.min(has, overage);
    overage -= consumed;
    remainingBundleMessages += has - consumed;
  }
  const totalRemainingMessages = remainingPlanMessages + remainingBundleMessages;

  // 6. HR-admin rolling window limits (per member)
  const limits = await getCompanyMessageLimits(companyId);
  const windows = await getWindowStates(userId, limits);

  return {
    assignment,
    bundles,
    limits,
    windows,
    periodStart,
    periodEnd,
    usedRecurringTokens: Number(usedRecurringTokens),
    remainingRecurringTokens: Number(remainingRecurring),
    remainingBundleTokens: Number(remainingBundle),
    totalRemainingTokens: Number(totalRemaining),
    planQuota: Number(planQuota),
    hasMessageQuota,
    planMessages,
    usedMessages,
    remainingPlanMessages,
    remainingBundleMessages,
    totalRemainingMessages,
  };
}

/**
 * Preflight check: Can the user run an LLM operation?
 * Message-quota plans gate on remaining messages; legacy token-only plans gate on tokens.
 * Returns { allowed, reason, availableTokens, ...summary }
 */
async function preflightCheck(userId, estimatedTokens = 0) {
  const summary = await getUserQuotaSummary(userId);

  const windowViolation = findWindowViolation(summary.windows);
  if (windowViolation) {
    return {
      allowed: false,
      reason: windowViolation.reason,
      details: windowViolation.details,
      available: summary.totalRemainingTokens,
      ...summary,
    };
  }

  if (summary.hasMessageQuota) {
    if (summary.totalRemainingMessages <= 0) {
      return { allowed: false, reason: 'MESSAGE_QUOTA_EXHAUSTED', available: summary.totalRemainingTokens, ...summary };
    }
    return { allowed: true, available: summary.totalRemainingTokens, estimatedTokens, ...summary };
  }

  const available = summary.totalRemainingTokens;
  if (available <= 0) {
    return { allowed: false, reason: 'INSUFFICIENT_QUOTA', available, ...summary };
  }
  if (estimatedTokens > 0 && estimatedTokens > available) {
    return { allowed: false, reason: 'ESTIMATED_EXCEEDS_QUOTA', available, estimatedTokens, ...summary };
  }
  return { allowed: true, available, estimatedTokens, ...summary };
}

/**
 * Deduct tokens from user/company quota after successful LLM execution.
 * Tokens remain the monitoring ledger; message limits are count-based (no deduction).
 * Priority: recurring first, then bundles (oldest expiry first).
 */
async function deductQuota(client, userId, totalTokens, eventId) {
  if (totalTokens <= 0) return { recurringDeducted: 0, bundleDeducted: 0 };

  // Get user's company profile
  const mappingRes = await client.query(`
    SELECT company_id FROM llm_user_mappings WHERE user_id = $1
  `, [userId]);
  const companyId = mappingRes.rows[0]?.company_id || null;

  let remaining = BigInt(totalTokens);
  let recurringDeducted = 0n;
  let bundleDeducted = 0n;
  let quotaSource = 'RECURRING';

  // 1. Get active plan to check remaining recurring (individual first, fallback to company)
  let planRes = await client.query(`
    SELECT a.id AS assignment_id, a.starts_at, a.reset_at, a.company_id, a.user_id, p.quota_tokens, p.quota_type
    FROM llm_plan_assignments a
    JOIN llm_token_plans p ON p.id = a.plan_id
    WHERE a.user_id = $1 AND a.is_active = true
    LIMIT 1
  `, [userId]);

  if (planRes.rows.length === 0 && companyId) {
    planRes = await client.query(`
      SELECT a.id AS assignment_id, a.starts_at, a.reset_at, a.company_id, a.user_id, p.quota_tokens, p.quota_type
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.company_id = $1 AND a.is_active = true
      LIMIT 1
    `, [companyId]);
  }

  const plan = planRes.rows[0];
  if (plan) {
    const { start, end } = getPeriodWindow(plan);
    // Calculate total used in this plan period (for user or company)
    let usedRes;
    if (plan.company_id) {
      usedRes = await client.query(`
        SELECT COALESCE(SUM(total_tokens), 0) AS used
        FROM llm_usage_events
        WHERE status = 'SUCCESS'
          AND quota_source = 'RECURRING'
          AND created_at >= $1
          AND created_at < $2
          AND id != $3
          AND user_id IN (
            SELECT user_id FROM llm_user_mappings WHERE company_id = $4
          )
      `, [start, end, eventId, plan.company_id]);
    } else {
      usedRes = await client.query(`
        SELECT COALESCE(SUM(total_tokens), 0) AS used
        FROM llm_usage_events
        WHERE user_id = $1
          AND status = 'SUCCESS'
          AND quota_source = 'RECURRING'
          AND created_at >= $2
          AND created_at < $3
          AND id != $4
      `, [userId, start, end, eventId]);
    }

    const used = BigInt(usedRes.rows[0].used);
    const planRemaining = BigInt(plan.quota_tokens) - used;
    if (planRemaining > 0n) {
      const deductFromPlan = remaining < planRemaining ? remaining : planRemaining;
      recurringDeducted = deductFromPlan;
      remaining -= deductFromPlan;
    }
  }

  // 2. If still have remaining, deduct from token bundles (user or company bundles)
  if (remaining > 0n) {
    quotaSource = recurringDeducted > 0n ? 'BOTH' : 'BUNDLE';

    let bundlesRes;
    if (companyId) {
      bundlesRes = await client.query(`
        SELECT id, remaining_tokens
        FROM llm_quota_bundles
        WHERE (user_id = $1 OR (company_id = $2 AND company_id IS NOT NULL))
          AND remaining_tokens > 0
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY expires_at ASC NULLS LAST
        FOR UPDATE
      `, [userId, companyId]);
    } else {
      bundlesRes = await client.query(`
        SELECT id, remaining_tokens
        FROM llm_quota_bundles
        WHERE user_id = $1
          AND remaining_tokens > 0
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY expires_at ASC NULLS LAST
        FOR UPDATE
      `, [userId]);
    }

    for (const bundle of bundlesRes.rows) {
      if (remaining <= 0n) break;
      const bundleHas = BigInt(bundle.remaining_tokens);
      const deductFromBundle = remaining < bundleHas ? remaining : bundleHas;
      await client.query(`
        UPDATE llm_quota_bundles
        SET remaining_tokens = remaining_tokens - $1, updated_at = NOW()
        WHERE id = $2
      `, [deductFromBundle.toString(), bundle.id]);
      bundleDeducted += deductFromBundle;
      remaining -= deductFromBundle;
    }
  }

  // Update quota_source on event
  await client.query(`
    UPDATE llm_usage_events
    SET quota_source = $1
    WHERE id = $2
  `, [quotaSource, eventId]);

  return {
    recurringDeducted: Number(recurringDeducted),
    bundleDeducted: Number(bundleDeducted),
  };
}

/**
 * Check if user/company has exceeded any service limits (hit count OR cost).
 * Enforces plan-specific service overrides if defined, falling back to global registry defaults.
 */
async function checkServiceLimits(userId, serviceName) {
  // 1. Get user's company profile
  const mappingRes = await dashboardPool.query(`
    SELECT company_id FROM llm_user_mappings WHERE user_id = $1
  `, [userId]);
  const companyId = mappingRes.rows[0]?.company_id || null;

  // 2. Get active plan assignment (individual first, fallback to company)
  let planRes = await dashboardPool.query(`
    SELECT plan_id, company_id
    FROM llm_plan_assignments
    WHERE user_id = $1 AND is_active = true
    LIMIT 1
  `, [userId]);

  if (planRes.rows.length === 0 && companyId) {
    planRes = await dashboardPool.query(`
      SELECT plan_id, company_id
      FROM llm_plan_assignments
      WHERE company_id = $1 AND is_active = true
      LIMIT 1
    `, [companyId]);
  }

  const assignment = planRes.rows[0] || null;

  // 3. Look up plan-specific override limits first
  let limitRecord = null;
  if (assignment) {
    const overrideRes = await dashboardPool.query(`
      SELECT ps.hit_limit_monthly, ps.cost_limit_monthly, sr.cost_currency
      FROM llm_plan_services ps
      JOIN llm_service_registry sr ON sr.id = ps.service_id
      WHERE ps.plan_id = $1 AND sr.service_name = $2 AND sr.is_active = true
    `, [assignment.plan_id, serviceName]);
    if (overrideRes.rows.length > 0) {
      limitRecord = overrideRes.rows[0];
    }
  }

  // 4. Fallback to global service registry limits if no override found
  if (!limitRecord) {
    const serviceRes = await dashboardPool.query(`
      SELECT hit_limit_monthly, cost_limit_monthly, cost_currency
      FROM llm_service_registry
      WHERE service_name = $1 AND is_active = true
    `, [serviceName]);
    if (serviceRes.rows.length === 0) return { exceeded: false };
    limitRecord = serviceRes.rows[0];
  }

  const reasons = [];
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // 5. Query user(s) usage: if it's a company plan assignment, sum usage across all company members!
  const isCompany = assignment && assignment.company_id;
  const userCondition = isCompany
    ? `user_id IN (SELECT user_id FROM llm_user_mappings WHERE company_id = $1)`
    : `user_id = $1`;
  const userParam = isCompany ? assignment.company_id : userId;

  // Check hit count. A 0/null limit means "not configured" — without this guard
  // `hits >= 0` is always true and every user is flagged as over limit.
  const hitLimit = Number(limitRecord.hit_limit_monthly);
  if (Number.isFinite(hitLimit) && hitLimit > 0) {
    const hitRes = await dashboardPool.query(`
      SELECT COUNT(*) AS hits
      FROM llm_usage_events
      WHERE ${userCondition}
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userParam, serviceName, monthStart]);
    const hits = parseInt(hitRes.rows[0].hits);
    if (hits >= hitLimit) {
      reasons.push({ type: 'HIT_LIMIT', hits, limit: hitLimit });
    }
  }

  // Check cost limit (same rule: 0/null = not configured)
  const costLimit = Number(limitRecord.cost_limit_monthly);
  if (Number.isFinite(costLimit) && costLimit > 0) {
    const costRes = await dashboardPool.query(`
      SELECT COALESCE(SUM(cost_amount), 0) AS total_cost
      FROM llm_usage_events
      WHERE ${userCondition}
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userParam, serviceName, monthStart]);
    const totalCost = parseFloat(costRes.rows[0].total_cost);
    if (totalCost >= costLimit) {
      reasons.push({ type: 'COST_LIMIT', totalCost, limit: costLimit, currency: limitRecord.cost_currency });
    }
  }

  return { exceeded: reasons.length > 0, reasons };
}

module.exports = {
  getUserQuotaSummary,
  preflightCheck,
  deductQuota,
  checkServiceLimits,
  getPeriodWindow,
  getCompanyMessageLimits,
  setCompanyMessageLimits,
  findWindowViolation,
};
