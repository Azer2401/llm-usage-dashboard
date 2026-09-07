-- HR-admin configurable rolling message limits per company (counted per member).
-- Windows: trailing 5 hours and trailing 7 days; each independently toggleable.
CREATE TABLE IF NOT EXISTS "llm_company_message_limits" (
    "company_id" TEXT NOT NULL,
    "five_hour_enabled" BOOLEAN NOT NULL DEFAULT false,
    "five_hour_limit" INTEGER,
    "week_enabled" BOOLEAN NOT NULL DEFAULT false,
    "week_limit" INTEGER,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_company_message_limits_pkey" PRIMARY KEY ("company_id"),
    CONSTRAINT "llm_company_message_limits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "llm_companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
