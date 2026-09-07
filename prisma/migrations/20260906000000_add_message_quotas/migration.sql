-- Message-based quotas: the enforced limit unit becomes chat messages sent.
-- Token columns remain untouched and continue to be recorded for monitoring.
ALTER TABLE llm_token_plans
  ADD COLUMN IF NOT EXISTS quota_messages INTEGER;

ALTER TABLE llm_quota_bundles
  ADD COLUMN IF NOT EXISTS quota_messages INTEGER;

-- Default trial plan auto-assigned to new company signups (20 messages / month).
INSERT INTO llm_token_plans
  (id, name, quota_type, quota_tokens, quota_messages, price_amount, currency, description, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'Demo Trial', 'MONTHLY', 100000, 20, 0, 'IDR',
   'Default trial plan for new company signups (20 messages/month)', true, NOW(), NOW())
ON CONFLICT (name) DO NOTHING;
