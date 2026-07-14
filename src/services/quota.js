'use strict';

const { aitmPool } = require('../db');

// ─── Quota Calculation ────────────────────────────────────────────────────────

/**
 * Get a user's current active plan assignment and its usage in the current period.
 */
async function getUserQuotaSummary(userId) {
  // 1. Get active plan assignment
  const planRes = await aitmPool.query(`
    SELECT
      a.id AS assignment_id,
      a.plan_id,
      a.starts_at,
      a.reset_at,
      p.name AS plan_name,
      p.quota_type,
      p.quota_tokens
    FROM llm_plan_assignments a
    JOIN llm_token_plans p ON p.id = a.plan_id
    WHERE a.user_id = $1 AND a.is_active = true
    LIMIT 1
  `, [userId]);

  const assignment = planRes.rows[0] || null;

  // 2. Get active bundle balances
  const bundleRes = await aitmPool.query(`
    SELECT
      id, quota_tokens, remaining_tokens, expires_at, created_at
    FROM llm_quota_bundles
    WHERE user_id = $1
      AND remaining_tokens > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY expires_at ASC NULLS LAST
  `, [userId]);
  const bundles = bundleRes.rows;

  // 3. Calculate used recurring tokens in current period
  let usedRecurringTokens = 0n;
  if (assignment) {
    const usageRes = await aitmPool.query(`
      SELECT COALESCE(SUM(total_tokens), 0) AS used
      FROM llm_usage_events
      WHERE user_id = $1
        AND status = 'SUCCESS'
        AND quota_source = 'RECURRING'
        AND created_at >= $2
        AND created_at < $3
    `, [userId, assignment.starts_at, assignment.reset_at]);
    usedRecurringTokens = BigInt(usageRes.rows[0].used);
  }

  // 4. Calculate remainders
  const planQuota = assignment ? BigInt(assignment.quota_tokens) : 0n;
  const remainingRecurring = planQuota > usedRecurringTokens ? planQuota - usedRecurringTokens : 0n;
  const remainingBundle = bundles.reduce((acc, b) => acc + BigInt(b.remaining_tokens), 0n);
  const totalRemaining = remainingRecurring + remainingBundle;

  return {
    assignment,
    bundles,
    usedRecurringTokens: Number(usedRecurringTokens),
    remainingRecurringTokens: Number(remainingRecurring),
    remainingBundleTokens: Number(remainingBundle),
    totalRemainingTokens: Number(totalRemaining),
    planQuota: Number(planQuota),
  };
}

/**
 * Preflight check: Can the user run an LLM operation with estimatedTokens?
 * Returns { allowed, availableTokens, remainingRecurringTokens, remainingBundleTokens, reason }
 */
async function preflightCheck(userId, estimatedTokens = 0) {
  const summary = await getUserQuotaSummary(userId);
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
 * Deduct tokens from user quota after successful LLM execution.
 * Priority: recurring first, then bundles (oldest expiry first).
 */
async function deductQuota(client, userId, totalTokens, eventId) {
  if (totalTokens <= 0) return { recurringDeducted: 0, bundleDeducted: 0 };

  let remaining = BigInt(totalTokens);
  let recurringDeducted = 0n;
  let bundleDeducted = 0n;
  let quotaSource = 'RECURRING';

  // Get active plan to check remaining recurring
  const planRes = await client.query(`
    SELECT a.starts_at, a.reset_at, p.quota_tokens,
           COALESCE(SUM(e.total_tokens), 0) AS used
    FROM llm_plan_assignments a
    JOIN llm_token_plans p ON p.id = a.plan_id
    LEFT JOIN llm_usage_events e
      ON e.user_id = a.user_id
      AND e.status = 'SUCCESS'
      AND e.quota_source = 'RECURRING'
      AND e.created_at >= a.starts_at
      AND e.created_at < a.reset_at
      AND e.id != $2
    WHERE a.user_id = $1 AND a.is_active = true
    GROUP BY a.starts_at, a.reset_at, p.quota_tokens
    LIMIT 1
  `, [userId, eventId]);

  const plan = planRes.rows[0];
  if (plan) {
    const planRemaining = BigInt(plan.quota_tokens) - BigInt(plan.used);
    if (planRemaining > 0n) {
      const deductFromPlan = remaining < planRemaining ? remaining : planRemaining;
      recurringDeducted = deductFromPlan;
      remaining -= deductFromPlan;
    }
  }

  // If still have remaining, deduct from bundles
  if (remaining > 0n) {
    quotaSource = recurringDeducted > 0n ? 'BOTH' : 'BUNDLE';
    const bundlesRes = await client.query(`
      SELECT id, remaining_tokens
      FROM llm_quota_bundles
      WHERE user_id = $1
        AND remaining_tokens > 0
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY expires_at ASC NULLS LAST
      FOR UPDATE
    `, [userId]);

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
 * Check if user has exceeded any N8N Scout service limits (hit count OR cost).
 * Returns { exceeded, reasons: [] }
 */
async function checkServiceLimits(userId, serviceName) {
  const serviceRes = await aitmPool.query(`
    SELECT hit_limit_monthly, cost_limit_monthly, cost_currency
    FROM llm_service_registry
    WHERE service_name = $1 AND is_active = true
  `, [serviceName]);
  if (serviceRes.rows.length === 0) return { exceeded: false };

  const service = serviceRes.rows[0];
  const reasons = [];

  // Monthly period start
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Check hit count
  if (service.hit_limit_monthly) {
    const hitRes = await aitmPool.query(`
      SELECT COUNT(*) AS hits
      FROM llm_usage_events
      WHERE user_id = $1
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userId, serviceName, monthStart]);
    const hits = parseInt(hitRes.rows[0].hits);
    if (hits >= parseInt(service.hit_limit_monthly)) {
      reasons.push({ type: 'HIT_LIMIT', hits, limit: service.hit_limit_monthly });
    }
  }

  // Check cost limit
  if (service.cost_limit_monthly) {
    const costRes = await aitmPool.query(`
      SELECT COALESCE(SUM(cost_amount), 0) AS total_cost
      FROM llm_usage_events
      WHERE user_id = $1
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userId, serviceName, monthStart]);
    const totalCost = parseFloat(costRes.rows[0].total_cost);
    const limit = parseFloat(service.cost_limit_monthly);
    if (totalCost >= limit) {
      reasons.push({ type: 'COST_LIMIT', totalCost, limit, currency: service.cost_currency });
    }
  }

  return { exceeded: reasons.length > 0, reasons };
}

module.exports = { getUserQuotaSummary, preflightCheck, deductQuota, checkServiceLimits };
