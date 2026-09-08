-- CreateEnum
CREATE TYPE "CiProvider" AS ENUM ('GITHUB');

-- DropForeignKey
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_userId_fkey";

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "actorAvatarUrl" VARCHAR(2048),
ADD COLUMN     "actorLogin" VARCHAR(120),
ADD COLUMN     "commitMessage" VARCHAR(500),
ADD COLUMN     "commitSha" VARCHAR(40),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "event" VARCHAR(60),
ADD COLUMN     "externalId" VARCHAR(64) NOT NULL,
ADD COLUMN     "externalUrl" VARCHAR(2048),
ADD COLUMN     "provider" "CiProvider" NOT NULL DEFAULT 'GITHUB',
ADD COLUMN     "repoConnectionId" UUID,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "workflowName" VARCHAR(200),
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Stage" DROP COLUMN "logs",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "externalId" VARCHAR(64),
ADD COLUMN     "externalUrl" VARCHAR(2048),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RepoConnection" (
    "id" UUID NOT NULL,
    "provider" "CiProvider" NOT NULL DEFAULT 'GITHUB',
    "owner" VARCHAR(120) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "externalId" VARCHAR(64),
    "defaultBranch" VARCHAR(200),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" VARCHAR(500),
    "lastEtag" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepoConnection_isActive_idx" ON "RepoConnection"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RepoConnection_provider_owner_name_key" ON "RepoConnection"("provider", "owner", "name");

-- CreateIndex
CREATE INDEX "Deployment_repoConnectionId_createdAt_idx" ON "Deployment"("repoConnectionId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_provider_externalId_key" ON "Deployment"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_deploymentId_externalId_key" ON "Stage"("deploymentId", "externalId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "RepoConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

