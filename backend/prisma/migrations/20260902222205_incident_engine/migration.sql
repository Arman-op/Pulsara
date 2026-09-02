-- CreateEnum
CREATE TYPE "IncidentSource" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "IncidentEventKind" AS ENUM ('OPENED', 'STATUS_CHANGED', 'SEVERITY_CHANGED', 'ASSIGNED', 'COMMENTED', 'RESOLVED', 'REOPENED');

-- DropIndex
DROP INDEX "Incident_serviceId_idx";

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "dedupeKey" VARCHAR(200),
ADD COLUMN     "isOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "source" "IncidentSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "IncidentEvent" (
    "id" SERIAL NOT NULL,
    "incidentId" UUID NOT NULL,
    "kind" "IncidentEventKind" NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncidentEvent_incidentId_createdAt_idx" ON "IncidentEvent"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_serviceId_isOpen_idx" ON "Incident"("serviceId", "isOpen");

-- CreateIndex
CREATE INDEX "Incident_isOpen_severity_idx" ON "Incident"("isOpen", "severity");

-- AddForeignKey
ALTER TABLE "IncidentEvent" ADD CONSTRAINT "IncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Deduplication guarantee, expressed as a partial unique index.
--
-- Prisma's schema language cannot express a partial index, so it is written
-- here by hand. It enforces the alerting engine's core invariant in the
-- database rather than in application logic: at most ONE open incident may
-- exist per dedupe key.
--
-- This matters because the engine reacts to status transitions, and a service
-- that flaps produces a transition every probe interval. Without the
-- constraint, two concurrent scheduler ticks could both observe "no open
-- incident" and both insert one. With it, the second insert fails and the
-- engine treats the failure as "already open", which is the correct outcome.
--
-- The index is partial on purpose: resolved incidents must be allowed to share
-- a dedupe key with each other and with a new open one, because the same
-- condition legitimately recurs.
CREATE UNIQUE INDEX "Incident_open_dedupe_unique"
  ON "Incident" ("dedupeKey")
  WHERE "isOpen" AND "dedupeKey" IS NOT NULL;
