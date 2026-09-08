-- Incident actions join the audit trail.
--
-- PostgreSQL 12 and later permit ALTER TYPE ... ADD VALUE inside a transaction
-- provided the new value is not used in that same transaction, which is why
-- these four can share one migration. Nothing here writes an audit row.
ALTER TYPE "AuditAction" ADD VALUE 'INCIDENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'INCIDENT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'INCIDENT_SEVERITY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'INCIDENT_ASSIGNED';
