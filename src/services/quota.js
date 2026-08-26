'use strict';

const { dashboardPool } = require('../db');

// ─── Quota Calculation ────────────────────────────────────────────────────────

/**
 * Get a user's current active plan assignment and its usage in the current period.
 * Supports individual plan assignment OR falling back to company-level plan assignment.
 */
async function getUserQuotaSummary(userId) {
  // Get user's company profile
  const mappingRes = await dashboardPool.query(`
    SELECT company_id FROM llm_user_mappings WHERE user_id = $1
  `, [userId]);
  const companyId = mappingRes.rows[0]?.company_id || null;

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
      p.quota_tokens
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
        p.quota_tokens
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
        id, quota_tokens, remaining_tokens, expires_at, created_at, company_id, user_id
      FROM llm_quota_bundles
      WHERE (user_id = $1 OR (company_id = $2 AND company_id IS NOT NULL))
        AND remaining_tokens > 0
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY expires_at ASC NULLS LAST
    `, [userId, companyId]);
  } else {
    bundleRes = await dashboardPool.query(`
      SELECT
        id, quota_tokens, remaining_tokens, expires_at, created_at, company_id, user_id
      FROM llm_quota_bundles
      WHERE user_id = $1
        AND remaining_tokens > 0
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY expires_at ASC NULLS LAST
    `, [userId]);
  }
  const bundles = bundleRes.rows;

  // 3. Calculate used recurring tokens in current period
  let usedRecurringTokens = 0n;
  if (assignment) {
    if (assignment.company_id) {
      // Shared quota: sum usage of all users mapped to this company
      const usageRes = await dashboardPool.query(`
        SELECT COALESCE(SUM(total_tokens), 0) AS used
        FROM llm_usage_events
        WHERE status = 'SUCCESS'
          AND quota_source = 'RECURRING'
          AND created_at >= $2
          AND created_at < $3
          AND user_id IN (
            SELECT user_id FROM llm_user_mappings WHERE company_id = $1
          )
      `, [assignment.company_id, assignment.starts_at, assignment.reset_at]);
      usedRecurringTokens = BigInt(usageRes.rows[0].used);
    } else {
      // Individual quota
      const usageRes = await dashboardPool.query(`
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
 * Deduct tokens from user/company quota after successful LLM execution.
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
    SELECT a.id AS assignment_id, a.starts_at, a.reset_at, a.company_id, p.quota_tokens
    FROM llm_plan_assignments a
    JOIN llm_token_plans p ON p.id = a.plan_id
    WHERE a.user_id = $1 AND a.is_active = true
    LIMIT 1
  `, [userId]);

  if (planRes.rows.length === 0 && companyId) {
    planRes = await client.query(`
      SELECT a.id AS assignment_id, a.starts_at, a.reset_at, a.company_id, p.quota_tokens
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.company_id = $1 AND a.is_active = true
      LIMIT 1
    `, [companyId]);
  }

  const plan = planRes.rows[0];
  if (plan) {
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
      `, [plan.starts_at, plan.reset_at, eventId, plan.company_id]);
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
      `, [userId, plan.starts_at, plan.reset_at, eventId]);
    }

    const used = BigInt(usedRes.rows[0].used);
    const planRemaining = BigInt(plan.quota_tokens) - used;
    if (planRemaining > 0n) {
      const deductFromPlan = remaining < planRemaining ? remaining : planRemaining;
      recurringDeducted = deductFromPlan;
      remaining -= deductFromPlan;
    }
  }

  // 2. If still have remaining, deduct from bundles (user or company bundles)
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

  // Check hit count
  if (limitRecord.hit_limit_monthly !== null && limitRecord.hit_limit_monthly !== undefined) {
    const hitRes = await dashboardPool.query(`
      SELECT COUNT(*) AS hits
      FROM llm_usage_events
      WHERE ${userCondition}
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userParam, serviceName, monthStart]);
    const hits = parseInt(hitRes.rows[0].hits);
    if (hits >= parseInt(limitRecord.hit_limit_monthly)) {
      reasons.push({ type: 'HIT_LIMIT', hits, limit: limitRecord.hit_limit_monthly });
    }
  }

  // Check cost limit
  if (limitRecord.cost_limit_monthly !== null && limitRecord.cost_limit_monthly !== undefined) {
    const costRes = await dashboardPool.query(`
      SELECT COALESCE(SUM(cost_amount), 0) AS total_cost
      FROM llm_usage_events
      WHERE ${userCondition}
        AND feature_name = $2
        AND status = 'SUCCESS'
        AND created_at >= $3
    `, [userParam, serviceName, monthStart]);
    const totalCost = parseFloat(costRes.rows[0].total_cost);
    const limit = parseFloat(limitRecord.cost_limit_monthly);
    if (totalCost >= limit) {
      reasons.push({ type: 'COST_LIMIT', totalCost, limit, currency: limitRecord.cost_currency });
    }
  }

  return { exceeded: reasons.length > 0, reasons };
}

module.exports = { getUserQuotaSummary, preflightCheck, deductQuota, checkServiceLimits };
