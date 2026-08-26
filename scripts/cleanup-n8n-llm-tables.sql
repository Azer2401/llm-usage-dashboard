-- ==============================================================================
-- Cleanup Script: Drop old dashboard tables from n8n_db (port 5432)
-- IMPORTANT: Execute this ONLY after verifying that the LLM Dashboard on port 5434
-- is working as expected.
-- ==============================================================================

DROP TABLE IF EXISTS llm_plan_services CASCADE;
DROP TABLE IF EXISTS llm_plan_assignments CASCADE;
DROP TABLE IF EXISTS llm_quota_bundles CASCADE;
DROP TABLE IF EXISTS llm_usage_daily_aggregates CASCADE;
DROP TABLE IF EXISTS llm_usage_events CASCADE;
DROP TABLE IF EXISTS llm_user_mappings CASCADE;
DROP TABLE IF EXISTS llm_service_registry CASCADE;
DROP TABLE IF EXISTS llm_internal_service_keys CASCADE;
DROP TABLE IF EXISTS llm_audit_logs CASCADE;
DROP TABLE IF EXISTS llm_companies CASCADE;
DROP TABLE IF EXISTS llm_token_plans CASCADE;

-- Optional: clean up Prisma migration history for dashboard tables from n8n_db
-- DELETE FROM _prisma_migrations WHERE migration_name LIKE '%llm%';
