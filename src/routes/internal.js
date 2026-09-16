'use strict';

const { Router } = require('express');
const { requireInternalKey } = require('../auth');
const { dashboardPool, aitmPool } = require('../db');
const { preflightCheck, deductQuota, checkServiceLimits, getUserQuotaSummary, getPeriodWindow, setCompanyMessageLimits, findWindowViolation } = require('../services/quota');

const router = Router();
router.use(requireInternalKey);

// ─── POST /api/internal/preflight ────────────────────────────────────────────
router.post('/preflight', async (req, res) => {
  try {
    const { userId, sourceService, featureName, workflowName, executionId, estimatedTokens = 0, modelName, metadata } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Validate sourceService matches the internal key used
    if (sourceService && sourceService !== req.internalService) {
      return res.status(403).json({ error: 'Source service mismatch', code: 'LLM_SOURCE_SERVICE_MISMATCH' });
    }

    // Validate user exists and is HR/HM
    const userRes = await aitmPool.query(`
      SELECT u.id FROM users u
      JOIN employees e ON e.user_id = u.id
      JOIN user_roles ur ON ur.id = e.user_role_id
      WHERE u.id = $1 AND ur.role_name IN ('HUMAN RESOURCES', 'HIRING MANAGER')
    `, [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found or not eligible for quota monitoring' });
    }

    // Check N8N Scout service limits (hit + cost) if applicable
    if (featureName && req.internalService === 'N8N') {
      const serviceLimitCheck = await checkServiceLimits(userId, featureName);
      if (serviceLimitCheck.exceeded) {
        // Record rejection event
        await dashboardPool.query(`
          INSERT INTO llm_usage_events (id, user_id, source_service, feature_name, workflow_name, execution_id,
            model_name, prompt_tokens, completion_tokens, total_tokens, cost_amount, status, metadata_json, created_at)
          VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 'REJECTED', $7, NOW())
        `, [userId, req.internalService, featureName, workflowName, executionId, modelName,
            JSON.stringify({ reason: 'SERVICE_LIMIT_EXCEEDED', reasons: serviceLimitCheck.reasons, ...metadata })]);

        return res.json({
          allowed: false,
          reason: 'SERVICE_LIMIT_EXCEEDED',
          details: serviceLimitCheck.reasons,
        });
      }
    }

    // Run quota preflight for LLM token usage
    const result = await preflightCheck(userId, estimatedTokens);

    if (!result.allowed) {
      // Record rejection event
      await dashboardPool.query(`
        INSERT INTO llm_usage_events (id, user_id, source_service, feature_name, workflow_name, execution_id,
          model_name, prompt_tokens, completion_tokens, total_tokens, cost_amount, status, metadata_json, created_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 'REJECTED', $7, NOW())
      `, [userId, req.internalService, featureName, workflowName, executionId, modelName,
          JSON.stringify({ reason: result.reason, estimatedTokens, ...metadata })]);
    }

    res.json({
      allowed:                  result.allowed,
      reason:                   result.reason || null,
      details:                  result.details || null,
      userId,
      estimatedTokens:          estimatedTokens,
      availableTokens:          result.available,
      remainingRecurringTokens: result.remainingRecurringTokens,
      remainingBundleTokens:    result.remainingBundleTokens,
      // Message-quota state, so callers can drive their own warning thresholds
      // without a second round trip to /quota-summary.
      hasMessageQuota:          !!result.hasMessageQuota,
      usedMessages:             result.usedMessages ?? 0,
      planMessages:             result.planMessages ?? null,
      totalRemainingMessages:   result.totalRemainingMessages ?? null,
      periodEnd:                result.periodEnd || null,
      planName:                 result.assignment ? result.assignment.plan_name : null,
      windows:                  result.windows || null,
    });
  } catch (err) {
    console.error('[Internal] POST /preflight error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/internal/events ────────────────────────────────────────────────
router.post('/events', async (req, res) => {
  try {
    const {
      userId, sourceService, featureName, workflowName,
      executionId, requestId, modelName, providerName,
      promptTokens = 0, completionTokens = 0, totalTokens = 0,
      costAmount = 0, costCurrency = 'IDR',
      status, latencyMs, metadata,
    } = req.body;

    if (!userId || !status) return res.status(400).json({ error: 'userId and status required' });
    if (!['SUCCESS', 'FAILED', 'REJECTED', 'PENDING'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    // Idempotency check
    if (requestId) {
      const existing = await dashboardPool.query(`SELECT id FROM llm_usage_events WHERE request_id = $1`, [requestId]);
      if (existing.rows.length > 0) {
        return res.json({ id: existing.rows[0].id, status: 'DUPLICATE_IGNORED' });
      }
    }

    // Validate source service
    if (sourceService && sourceService !== req.internalService) {
      return res.status(403).json({ error: 'Source service mismatch', code: 'LLM_SOURCE_SERVICE_MISMATCH' });
    }

    const client = await dashboardPool.connect();
    try {
      await client.query('BEGIN');

      // Insert usage event
      const { rows } = await client.query(`
        INSERT INTO llm_usage_events (
          id, user_id, source_service, feature_name, workflow_name,
          execution_id, request_id, model_name, provider_name,
          prompt_tokens, completion_tokens, total_tokens,
          cost_amount, cost_currency, status, latency_ms,
          quota_source, metadata_json, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          'PENDING', $16, NOW()
        ) RETURNING id
      `, [
        userId, req.internalService, featureName, workflowName,
        executionId, requestId || null, modelName, providerName,
        promptTokens, completionTokens, totalTokens,
        costAmount, costCurrency, status, latencyMs || null,
        JSON.stringify(metadata || {}),
      ]);

      const eventId = rows[0].id;
      let deducted = { recurringDeducted: 0, bundleDeducted: 0 };

      // Deduct quota only on SUCCESS and if there are tokens to deduct
      if (status === 'SUCCESS' && totalTokens > 0) {
        deducted = await deductQuota(client, userId, totalTokens, eventId);
      }

      await client.query('COMMIT');

      // Get updated quota summary
      const summary = await preflightCheck(userId, 0);

      res.json({
        id:     eventId,
        status: 'RECORDED',
        deducted: {
          recurringTokens: deducted.recurringDeducted,
          bundleTokens:    deducted.bundleDeducted,
        },
        remaining: {
          remainingRecurringTokens: summary.remainingRecurringTokens,
          remainingBundleTokens:    summary.remainingBundleTokens,
          totalRemainingTokens:     summary.available,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Internal] POST /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/internal/quota-summary ─────────────────────────────────────────
// HR-facing plan/quota summary consumed by the AITM backend (navbar + chat chip).
router.post('/quota-summary', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const summary = await getUserQuotaSummary(userId);
    const { start: periodStart, end: periodEnd } = getPeriodWindow(summary.assignment);

    // AITM company context (single source of truth for company + HR admin)
    const compRes = await aitmPool.query(`
      SELECT c.id, c.name, c."hrAdminId"
      FROM employees e
      JOIN companies c ON c.id = e.company_id
      WHERE e.user_id = $1
    `, [userId]);
    const company = compRes.rows[0] || null;
    const isHrAdmin = !!(company && company.hrAdminId === userId);

    let memberCount = 0;
    let seatsAllocated = 0;
    let members = null;
    if (company) {
      const sRes = await dashboardPool.query(`
        SELECT COUNT(*)::int AS seats FROM llm_user_mappings WHERE company_id = $1
      `, [company.id]);
      seatsAllocated = sRes.rows[0].seats;
      const mRes = await aitmPool.query(`
        SELECT u.id AS user_id, u.name, u.email, ur.role_name AS role
        FROM employees e
        JOIN users u ON u.id = e.user_id
        JOIN user_roles ur ON ur.id = e.user_role_id
        WHERE e.company_id = $1
        ORDER BY u.name
      `, [company.id]);
      memberCount = mRes.rows.length;

      if (isHrAdmin) {
        let usageMap = {};
        if (periodStart && periodEnd && mRes.rows.length > 0) {
          const ids = mRes.rows.map(r => r.user_id);
          const uRes = await dashboardPool.query(`
            SELECT user_id, COUNT(*) AS used_messages
            FROM llm_usage_events
            WHERE user_id = ANY($1)
              AND feature_name = 'goclaw_chat'
              AND (status = 'SUCCESS' OR status = 'PENDING')
              AND created_at >= $2 AND created_at < $3
            GROUP BY user_id
          `, [ids, periodStart, periodEnd]);
          for (const u of uRes.rows) usageMap[u.user_id] = Number(u.used_messages);
        }
        members = mRes.rows.map(r => ({
          userId: r.user_id,
          name: r.name,
          email: r.email,
          role: r.role,
          usedMessages: usageMap[r.user_id] || 0,
        }));
      }
    }

    // Quota status badge (message-based when a message quota exists)
    let quotaStatus = 'NO_PLAN';
    if (summary.hasMessageQuota || summary.assignment) {
      const used = summary.hasMessageQuota ? summary.usedMessages : summary.usedRecurringTokens;
      const quota = summary.hasMessageQuota ? (summary.planMessages ?? 0) : summary.planQuota;
      const remaining = summary.hasMessageQuota ? summary.totalRemainingMessages : summary.totalRemainingTokens;
      const pct = quota > 0 ? (used / quota) * 100 : 0;
      if (remaining <= 0) quotaStatus = 'EXHAUSTED';
      else if (pct >= 90) quotaStatus = 'CRITICAL';
      else if (pct >= 70) quotaStatus = 'WARNING';
      else quotaStatus = 'HEALTHY';
    }

    // A rolling-window block outranks the plan badge: the member cannot send now,
    // even though the plan quota itself may still have messages left.
    const windowBlock = findWindowViolation(summary.windows);
    if (windowBlock) quotaStatus = 'EXHAUSTED';

    res.json({
      userId,
      plan: summary.assignment ? {
        name:          summary.assignment.plan_name,
        quotaType:     summary.assignment.quota_type,
        quotaMessages: summary.assignment.quota_messages !== null && summary.assignment.quota_messages !== undefined ? Number(summary.assignment.quota_messages) : null,
        quotaTokens:   Number(summary.assignment.quota_tokens),
        maxMembers:    summary.assignment.max_members !== null && summary.assignment.max_members !== undefined ? Number(summary.assignment.max_members) : null,
        overMemberCap: summary.assignment.max_members !== null && summary.assignment.max_members !== undefined
          ? seatsAllocated > Number(summary.assignment.max_members)
          : false,
        startsAt:      summary.assignment.starts_at,
        resetAt:       summary.assignment.reset_at,
      } : null,
      messages: {
        hasQuota:        summary.hasMessageQuota,
        used:            summary.usedMessages,
        planQuota:       summary.planMessages,
        remainingPlan:   summary.remainingPlanMessages,
        remainingBundle: summary.remainingBundleMessages,
        totalRemaining:  summary.totalRemainingMessages,
        periodStart:     periodStart ? periodStart.toISOString() : null,
        periodEnd:       periodEnd ? periodEnd.toISOString() : null,
      },
      tokens: {
        usedRecurring: summary.usedRecurringTokens,
        planQuota:     summary.planQuota,
        totalRemaining: summary.totalRemainingTokens,
      },
      // HR-admin rolling window limits (per member): 5h and 1w
      windows: summary.windows,
      quotaStatus,
      company: company ? {
        id: company.id,
        name: company.name,
        isHrAdmin,
        memberCount,
        seatsAllocated,
        members,
      } : null,
    });
  } catch (err) {
    console.error('[Internal] POST /quota-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/internal/member-unlink ───────────────────────────────────────
// Called by the AITM backend when an HR admin removes a member from the
// company: drop the mapping (which otherwise lingers as a ghost row, since it
// lives in this database with no FK to AITM users), end any individual
// assignment, and hand the now-standalone account its own Demo Trial plan so
// it keeps limited access instead of silently drawing on the company plan.
router.post('/member-unlink', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    await dashboardPool.query(`DELETE FROM llm_user_mappings WHERE user_id = $1`, [userId]);
    await dashboardPool.query(`
      UPDATE llm_plan_assignments
      SET is_active = false, ended_at = NOW(), updated_at = NOW()
      WHERE user_id = $1 AND is_active = true
    `, [userId]);

    const planRes = await dashboardPool.query(`
      SELECT id, name, quota_type FROM llm_token_plans
      WHERE LOWER(name) = 'demo trial' AND is_active = true LIMIT 1
    `);
    let demoPlanAssigned = false;
    let planName = null;
    if (planRes.rows.length > 0) {
      const plan = planRes.rows[0];
      const start = new Date();
      const reset = new Date(start);
      if (plan.quota_type === 'YEARLY') {
        reset.setFullYear(reset.getFullYear() + 1); reset.setMonth(0); reset.setDate(1); reset.setHours(0, 0, 0, 0);
      } else {
        reset.setMonth(reset.getMonth() + 1); reset.setDate(1); reset.setHours(0, 0, 0, 0);
      }
      await dashboardPool.query(`
        INSERT INTO llm_plan_assignments (id, user_id, plan_id, company_id, starts_at, reset_at, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4, true, NOW(), NOW())
      `, [userId, plan.id, start, reset]);
      demoPlanAssigned = true;
      planName = plan.name;
    }

    await dashboardPool.query(`INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'member.unlink', 'aitm_user', $2, $3, NOW())`,
      ['system', userId, JSON.stringify({ demoPlanAssigned, planName })]);

    res.json({ unlinked: true, demoPlanAssigned, planName });
  } catch (err) {
    console.error('[Internal] POST /member-unlink error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/internal/company-limits ────────────────────────────────────────
// HR-admin configurable rolling message limits (per member). Written by the
// AITM backend after it verifies the caller is the company's hrAdminId.
router.put('/company-limits', async (req, res) => {
  try {
    const { companyId, fiveHourEnabled, fiveHourLimit, weekEnabled, weekLimit, updatedBy } = req.body;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    if (typeof fiveHourEnabled !== 'boolean' || typeof weekEnabled !== 'boolean') {
      return res.status(400).json({ error: 'fiveHourEnabled and weekEnabled must be booleans' });
    }

    const parseLimit = (value, enabled, name) => {
      if (!enabled) return { value: null };
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return { error: `${name} must be a positive integer when the window is enabled` };
      return { value: n };
    };
    const fiveHour = parseLimit(fiveHourLimit, fiveHourEnabled, 'fiveHourLimit');
    if (fiveHour.error) return res.status(400).json({ error: fiveHour.error });
    const week = parseLimit(weekLimit, weekEnabled, 'weekLimit');
    if (week.error) return res.status(400).json({ error: week.error });

    const row = await setCompanyMessageLimits(companyId, {
      fiveHourEnabled,
      fiveHourLimit: fiveHour.value,
      weekEnabled,
      weekLimit: week.value,
      updatedBy,
    });

    res.json({ ok: true, limits: row });
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Company not found' });
    console.error('[Internal] PUT /company-limits error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Plan Seat Allocation Endpoints ──────────────────────────────────────────
// GET /api/internal/company/:companyId/plan-seats
router.get('/company/:companyId/plan-seats', async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });

    // 1. Get active company plan
    const planRes = await dashboardPool.query(`
      SELECT p.id, p.name, p.max_members, p.quota_messages, p.quota_tokens, p.quota_type,
             a.id AS assignment_id, a.starts_at, a.reset_at
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.company_id = $1 AND a.is_active = true
      ORDER BY a.created_at DESC LIMIT 1
    `, [companyId]);
    const planRow = planRes.rows[0] || null;

    // 2. Get allocated members from llm_user_mappings
    const seatRes = await dashboardPool.query(`
      SELECT user_id, created_at AS allocated_at, updated_at
      FROM llm_user_mappings
      WHERE company_id = $1
      ORDER BY created_at ASC
    `, [companyId]);
    const allocatedRows = seatRes.rows;
    const userIds = allocatedRows.map(r => r.user_id);

    // 3. Resolve user details from AITM
    let userDetailsMap = {};
    if (userIds.length > 0) {
      try {
        const aitmRes = await aitmPool.query(`
          SELECT u.id AS user_id, u.name, u.email, ur.role_name AS role
          FROM users u
          LEFT JOIN employees e ON e.user_id = u.id
          LEFT JOIN user_roles ur ON ur.id = e.user_role_id
          WHERE u.id = ANY($1)
        `, [userIds]);
        for (const u of aitmRes.rows) userDetailsMap[u.user_id] = u;
      } catch (aitmErr) {
        console.warn('[Internal] Could not resolve AITM user details:', aitmErr.message);
      }
    }

    // 4. Resolve message usage per user in current period
    let usageMap = {};
    if (userIds.length > 0 && planRow?.starts_at && planRow?.reset_at) {
      try {
        const usageRes = await dashboardPool.query(`
          SELECT user_id, COUNT(*)::int AS used_messages
          FROM llm_usage_events
          WHERE source_service = 'GOCLAW' AND feature_name = 'goclaw_chat' AND status = 'SUCCESS'
            AND created_at >= $1 AND created_at < $2
            AND user_id = ANY($3)
          GROUP BY user_id
        `, [planRow.starts_at, planRow.reset_at, userIds]);
        for (const u of usageRes.rows) usageMap[u.user_id] = u.used_messages;
      } catch (usageErr) {
        console.warn('[Internal] Could not resolve user message usage:', usageErr.message);
      }
    }

    const maxSeats = planRow?.max_members !== null && planRow?.max_members !== undefined
      ? Number(planRow.max_members)
      : null;
    const seatsUsed = allocatedRows.length;
    const canAddMember = maxSeats === null || seatsUsed < maxSeats;

    const allocatedMembers = allocatedRows.map(r => {
      const u = userDetailsMap[r.user_id];
      return {
        userId: r.user_id,
        name: u?.name || 'Unknown User',
        email: u?.email || '',
        role: u?.role || 'MEMBER',
        allocatedAt: r.allocated_at,
        usedMessages: usageMap[r.user_id] || 0,
      };
    });

    res.json({
      companyId,
      // Field names are the AITM frontend's PlanSeatsData contract; the
      // seatsUsed/maxSeats/canAddMember aliases are kept for older callers.
      planName: planRow ? planRow.name : null,
      maxMembers: maxSeats,
      seatsAllocated: seatsUsed,
      availableSeats: maxSeats === null ? null : Math.max(0, maxSeats - seatsUsed),
      canAllocateMore: canAddMember,
      plan: planRow ? {
        id: planRow.id,
        name: planRow.name,
        maxMembers: maxSeats,
        quotaMessages: planRow.quota_messages !== null ? Number(planRow.quota_messages) : null,
        quotaTokens: Number(planRow.quota_tokens),
        quotaType: planRow.quota_type,
      } : null,
      seatsUsed,
      maxSeats,
      canAddMember,
      allocatedMembers,
    });
  } catch (err) {
    console.error('[Internal] GET /company/:companyId/plan-seats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/internal/company/:companyId/plan-seats
router.post('/company/:companyId/plan-seats', async (req, res) => {
  try {
    const { companyId } = req.params;
    const { userId, actorUserId } = req.body;
    if (!companyId || !userId) return res.status(400).json({ error: 'companyId and userId required' });

    // 1. Check company plan and member cap
    const planRes = await dashboardPool.query(`
      SELECT p.id, p.name, p.max_members
      FROM llm_plan_assignments a
      JOIN llm_token_plans p ON p.id = a.plan_id
      WHERE a.company_id = $1 AND a.is_active = true
      ORDER BY a.created_at DESC LIMIT 1
    `, [companyId]);
    const plan = planRes.rows[0] || null;

    if (plan && plan.max_members !== null && plan.max_members !== undefined) {
      const { rows: currentSeats } = await dashboardPool.query(
        `SELECT COUNT(*)::int AS count FROM llm_user_mappings WHERE company_id = $1`,
        [companyId]
      );
      if (currentSeats[0].count >= Number(plan.max_members)) {
        return res.status(409).json({
          error: 'PLAN_SEAT_LIMIT_REACHED',
          message: `Kapasitas kursi AI plan telah penuh (${currentSeats[0].count}/${plan.max_members}). Cabut kursi anggota lain atau upgrade plan.`,
          seatsUsed: currentSeats[0].count,
          maxSeats: Number(plan.max_members),
        });
      }
    }

    // 2. Upsert into llm_user_mappings
    const { rows } = await dashboardPool.query(`
      INSERT INTO llm_user_mappings (id, user_id, company_id, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET company_id = $2, updated_at = NOW()
      RETURNING *
    `, [userId, companyId]);

    // 3. Record audit log
    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'company.seat_allocated', 'llm_user_mapping', $2, $3, NOW())
    `, [actorUserId || 'system', userId, JSON.stringify({ userId, companyId })]);

    res.json({ success: true, mapping: rows[0] });
  } catch (err) {
    console.error('[Internal] POST /company/:companyId/plan-seats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/internal/company/:companyId/plan-seats/:userId
router.delete('/company/:companyId/plan-seats/:userId', async (req, res) => {
  try {
    const { companyId, userId } = req.params;
    const { actorUserId } = req.body || {};
    if (!companyId || !userId) return res.status(400).json({ error: 'companyId and userId required' });

    await dashboardPool.query(`
      UPDATE llm_user_mappings SET company_id = NULL, updated_at = NOW()
      WHERE user_id = $1 AND company_id = $2
    `, [userId, companyId]);

    await dashboardPool.query(`
      INSERT INTO llm_audit_logs (id, actor_user_id, action, target_type, target_id, after_json, created_at)
      VALUES (gen_random_uuid(), $1, 'company.seat_revoked', 'llm_user_mapping', $2, $3, NOW())
    `, [actorUserId || 'system', userId, JSON.stringify({ userId, companyId })]);

    res.json({ success: true, message: 'Plan seat revoked successfully' });
  } catch (err) {
    console.error('[Internal] DELETE /company/:companyId/plan-seats/:userId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

