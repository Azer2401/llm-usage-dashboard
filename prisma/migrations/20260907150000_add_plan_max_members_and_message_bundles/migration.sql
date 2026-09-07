-- Plan-level member cap, plus making message top-up bundles usable.
--
-- max_members is the tier limit set by the product manager. It counts AITM
-- `employees` rows for the company (true headcount), NOT llm_user_mappings.
-- NULL = unlimited, matching the "0 or NULL means not configured" convention
-- already used for llm_service_registry.cost_limit_monthly.
ALTER TABLE "llm_token_plans" ADD COLUMN IF NOT EXISTS "max_members" INTEGER;

-- A company-scoped bundle is one shared balance across all members, so it has
-- no owning user. quota.js already reads these (company_id IS NOT NULL) but the
-- NOT NULL on user_id made them impossible to create.
ALTER TABLE "llm_quota_bundles" ALTER COLUMN "user_id" DROP NOT NULL;

-- Bundles are looked up by company as well as by user.
CREATE INDEX IF NOT EXISTS "llm_quota_bundles_company_id_idx"
    ON "llm_quota_bundles"("company_id");
