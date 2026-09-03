-- Access tokens issued before this moment are refused.
--
-- Nullable with no default: existing sessions stay valid, because this is a
-- hardening change and invalidating every live session to deploy it would be a
-- self-inflicted outage.
ALTER TABLE "User" ADD COLUMN "sessionsValidFrom" TIMESTAMP(3);
