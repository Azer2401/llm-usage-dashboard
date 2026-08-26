'use strict';

const { Router } = require('express');
const { requireInternalKey } = require('../auth');
const { dashboardPool, aitmPool } = require('../db');
const { preflightCheck, deductQuota, checkServiceLimits } = require('../services/quota');

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
      userId,
      estimatedTokens:          estimatedTokens,
      availableTokens:          result.available,
      remainingRecurringTokens: result.remainingRecurringTokens,
      remainingBundleTokens:    result.remainingBundleTokens,
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
    if (!['SUCCESS', 'FAILED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

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

module.exports = router;
