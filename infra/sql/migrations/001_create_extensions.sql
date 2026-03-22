-- 001: Enable required PostgreSQL extensions
-- pgcrypto: secure UUID generation via gen_random_uuid()
-- Security note: gen_random_uuid() uses OS-level CSPRNG, safe for unpredictable PKs

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
