-- CreateEnum
CREATE TYPE "ProbeType" AS ENUM ('HTTP', 'TCP');

-- DropIndex
DROP INDEX "Metric_host_type_timestamp_idx";

-- AlterTable
ALTER TABLE "Metric" DROP CONSTRAINT "Metric_pkey",
DROP COLUMN "timestamp",
ADD COLUMN     "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "unit" VARCHAR(20) NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Metric_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "responseTime",
DROP COLUMN "uptime",
ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "consecutiveSuccesses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "expectedStatusMax" INTEGER NOT NULL DEFAULT 399,
ADD COLUMN     "expectedStatusMin" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "isMonitored" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "probeIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "probeTarget" VARCHAR(2048),
ADD COLUMN     "probeTimeoutMs" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "probeType" "ProbeType";

-- CreateTable
CREATE TABLE "ProbeResult" (
    "id" SERIAL NOT NULL,
    "serviceId" UUID NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "statusCode" INTEGER,
    "error" VARCHAR(500),
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProbeResult_serviceId_checkedAt_idx" ON "ProbeResult"("serviceId", "checkedAt" DESC);

-- CreateIndex
CREATE INDEX "ProbeResult_checkedAt_idx" ON "ProbeResult"("checkedAt");

-- CreateIndex
CREATE INDEX "Metric_host_type_recordedAt_idx" ON "Metric"("host", "type", "recordedAt" DESC);

-- CreateIndex
CREATE INDEX "Metric_recordedAt_idx" ON "Metric"("recordedAt");

-- CreateIndex
CREATE INDEX "Service_isMonitored_lastCheckedAt_idx" ON "Service"("isMonitored", "lastCheckedAt");

-- AddForeignKey
ALTER TABLE "ProbeResult" ADD CONSTRAINT "ProbeResult_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

