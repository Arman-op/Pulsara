-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_ROLE_CHANGED', 'USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_PROFILE_UPDATED', 'PASSWORD_CHANGED', 'SESSIONS_REVOKED', 'SERVICE_CREATED', 'SERVICE_UPDATED', 'SERVICE_DELETED', 'REPO_CONNECTED', 'REPO_DISCONNECTED');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "ipAddress" VARCHAR(64),
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "resourceId" VARCHAR(120),
DROP COLUMN "action",
ADD COLUMN     "action" "AuditAction" NOT NULL,
ALTER COLUMN "resource" SET DATA TYPE VARCHAR(120);

-- CreateIndex
CREATE INDEX "AuditLog_resource_resourceId_createdAt_idx" ON "AuditLog"("resource", "resourceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);

