# Runbook

What to do when something is wrong, written for whoever is holding the pager
rather than for whoever wrote the code.

Each entry says how to tell the problem is real, how to fix it, and how to
confirm the fix worked. Where a command is destructive or irreversible it says
so before the command, not after.

> Names in `${...}` come from `terraform output` in [`infra/`](./infra) —
> `terraform output -json github_actions_variables` prints most of them. At the
> defaults the cluster is `pulsara-production`, the services are
> `pulsara-production-api` and `pulsara-production-web`, and `${SECRET_PREFIX}`
> is `pulsara-production/`.

**Contents**

- [The health-check worker has stalled](#the-health-check-worker-has-stalled)
- [Rotating the GitHub App private key](#rotating-the-github-app-private-key)
- [Rolling back a bad ECS deployment](#rolling-back-a-bad-ecs-deployment)
- [A release failed part-way through](#a-release-failed-part-way-through)
- [Redis is unavailable](#redis-is-unavailable)
- [The database is unreachable or failing over](#the-database-is-unreachable-or-failing-over)
- [Incidents are not opening, or will not stop opening](#incidents-are-not-opening-or-will-not-stop-opening)
- [Rotating the JWT signing keys](#rotating-the-jwt-signing-keys)
- [Getting a shell in a running task](#getting-a-shell-in-a-running-task)

---

## The health-check worker has stalled

**Symptom.** Service cards stop advancing: `lastCheckedAt` frozen, uptime
percentages unchanged, no new `ProbeResult` rows. Nothing errors — the UI shows
the last figures it had, which is exactly what makes this easy to miss.

### Confirm it is real

The one number that distinguishes a stalled worker from a quiet system:

```bash
curl -s https://${DOMAIN}/metrics | grep pulsara_service_last_check_age_seconds
```

Every probed service exports its own schedule beside it, so compare the two
rather than against one threshold that is wrong for everything but the median:

```bash
curl -s https://${DOMAIN}/metrics | grep pulsara_service_probe_interval_seconds
```

An age several times larger than that service's interval is a stall. If the
ages are fine the problem is elsewhere — a service that is genuinely healthy and
unchanging looks identical on the dashboard.

Then find out which half is stuck. With Redis configured, probing is a BullMQ
queue; without it, an in-process timer.

```bash
# Is the queue backing up, or is nothing being enqueued at all?
redis-cli -u "$REDIS_URL" --scan --pattern "${REDIS_KEY_PREFIX}:queue:probes:*" | head
redis-cli -u "$REDIS_URL" llen "${REDIS_KEY_PREFIX}:queue:probes:wait"
```

### The three causes, in the order they actually happen

**1. The repeatable scheduler was lost.** The sweep is a repeatable job; if
Redis was flushed or failed over, the schedule can be gone while the workers sit
idle. Jobs waiting: zero. Workers: alive. Nothing moves.

*Fix:* restart the API tasks. The scheduler is re-registered at boot, and the
job id is deterministic, so a restart cannot create a duplicate sweep.

```bash
aws ecs update-service --cluster ${ECS_CLUSTER} \
  --service ${ECS_SERVICE_API} --force-new-deployment
```

**2. Jobs are piling up faster than they drain.** Waiting count climbing,
`lastCheckedAt` ages growing steadily rather than frozen. Usually one slow
target holding a worker slot until timeout, multiplied by too little
concurrency.

*Fix:* find the slow target and either raise its own timeout or lower it —

```sql
SELECT name, "probeTarget", "probeIntervalSeconds", "probeTimeoutMs", "lastCheckedAt"
FROM "Service"
WHERE "isMonitored" = true AND "probeType" IS NOT NULL
ORDER BY "lastCheckedAt" NULLS FIRST
LIMIT 10;
```

The slow one is at the top of that list. Lower its `probeTimeoutMs` so it stops
holding a slot for five seconds, or raise `PROBE_MAX_CONCURRENCY` if the fleet
has genuinely outgrown it — the first is a row in the database, the second is a
task-definition change and goes through a release.

**3. The whole process is wedged.** No probes, no host samples, no logs.
`pulsara_host_sample_age_seconds` is also stale. This is not a probe problem; go
to [Rolling back a bad ECS deployment](#rolling-back-a-bad-ecs-deployment) or
force a new deployment as above.

### Confirm the fix

```bash
curl -s https://${DOMAIN}/metrics | grep pulsara_service_last_check_age_seconds
```

Ages should fall below each service's `probe_interval_seconds` within two
cycles. Do not close this out on "the dashboard looks fine" — the dashboard
looked fine while it was broken.

### Note

Probing being down does **not** page anyone by itself: the alert engines open
incidents from observations, and an absent observation is not a failed one. That
is deliberate — treating "no data" as "down" would page the whole fleet on every
deploy — and it is exactly why the metric above exists. Alert on
`pulsara_service_last_check_age_seconds` in whatever scrapes `/metrics`.

---

## Rotating the GitHub App private key

Do this on a schedule, and immediately if the `.pem` was ever pasted anywhere it
should not have been — a chat message, a terminal on a shared machine, a CI log.

**The key is not the App.** Rotating it does not change the App id, the
installation, the permissions or the webhook secret. Nothing needs
reinstalling, and no repository connection is lost.

### 1. Generate the new key first

At *Settings → Developer settings → GitHub Apps → Pulsara → Private keys*,
**Generate a private key**. GitHub allows more than one key to be valid at
once, which is what makes this a zero-downtime rotation: generate, deploy,
*then* revoke.

### 2. Put it in Secrets Manager

The private key is stored as one field of the `github-app` secret, so it has to
be written as a whole JSON document — `put-secret-value` replaces the value, it
does not merge.

```bash
# Read what is there now, so the other two fields survive.
aws secretsmanager get-secret-value \
  --secret-id ${SECRET_PREFIX}/github-app \
  --query SecretString --output text > /tmp/github-app.json

# Convert the .pem to a single-line JSON string value.
node -e "console.log(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8')))" new-key.pem

# Edit /tmp/github-app.json, replacing private_key with that value, then:
aws secretsmanager put-secret-value \
  --secret-id ${SECRET_PREFIX}/github-app \
  --secret-string file:///tmp/github-app.json

shred -u /tmp/github-app.json new-key.pem   # or rm, on a filesystem without shred
```

### 3. Restart the API so it reads the new value

Secrets are resolved by the ECS agent when a container starts, so a running task
holds the old key until it is replaced. No new task definition is needed — the
task definition references the secret by ARN, and an ARN is stable across value
changes.

```bash
aws ecs update-service --cluster ${ECS_CLUSTER} \
  --service ${ECS_SERVICE_API} --force-new-deployment
aws ecs wait services-stable --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE_API}
```

### 4. Confirm, then revoke the old key

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://${DOMAIN}/api/integrations/github/connections | jq '.data[] | {repo: .fullName, lastSyncedAt, lastSyncError}'
```

`lastSyncError` must be null and `lastSyncedAt` must be recent. The installation
token is cached in-process and renewed five minutes before it expires, so a
success recorded before the restart can be the *old* key still working — wait
for a sync that happened after the restart before believing it.

Only then delete the old key in GitHub. Reversed, this becomes an outage: the
App cannot mint installation tokens, every sync fails, and the Pipelines page
goes stale while looking merely quiet.

### If it goes wrong

Symptom is `lastSyncError` mentioning a JWT or a 401 from GitHub. The old key
still exists if you have not deleted it yet — put it back with step 2 and
restart. Webhook deliveries are unaffected throughout: they are verified with
the webhook secret, not the private key, so live updates keep working even while
polling is broken. That is why the Pipelines page can look healthy during this
failure.

---

## Rolling back a bad ECS deployment

**First: check whether it already rolled itself back.** The services have a
deployment circuit breaker with rollback enabled, so a revision whose tasks fail
to start or fail their health checks is reverted by ECS without anybody doing
anything.

```bash
aws ecs describe-services --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE_API} \
  --query 'services[0].deployments[].{status:status,taskDefinition:taskDefinition,rollout:rolloutState,reason:rolloutStateReason}'
```

A `rolloutState` of `FAILED` with the previous task definition back in
`PRIMARY` means the circuit breaker did its job. Nothing to roll back; find out
why the tasks would not start.

The circuit breaker does **not** catch a deployment that starts cleanly and is
wrong — a bad query, a broken screen, a regression. That is this procedure.

### 1. Find the revision to go back to

```bash
aws ecs list-task-definitions --family-prefix ${ECS_TASK_FAMILY_API} \
  --sort DESC --max-items 10
```

Revisions are registered one per release, so the previous revision is the
previous commit. To confirm which commit a revision actually runs:

```bash
aws ecs describe-task-definition --task-definition ${ECS_TASK_FAMILY_API}:42 \
  --query 'taskDefinition.containerDefinitions[0].image'
```

The image tag is the commit SHA. That is the whole reason tags are immutable and
never `latest`.

### 2. Check whether the schema moved

**This is the step that turns a two-minute rollback into an incident if it is
skipped.** Migrations run before the service is updated, so a rollback puts old
code in front of a newer schema.

```bash
git diff --name-only <good-sha> <bad-sha> -- backend/prisma/migrations/
```

- **No migrations in that range** — roll back freely. Continue to step 3.
- **Additive only** (new table, new nullable column, new index): old code
  ignores what it does not know about. Roll back, then decide about the
  migration separately.
- **Destructive** (a dropped or renamed column, a narrowed type): **do not roll
  back the code alone.** Old code will query columns that no longer exist and
  fail on every request — the same outage, with a different error. Fix forward,
  or restore the database to a point-in-time before the migration and accept the
  data loss deliberately.

### 3. Move the service back

```bash
aws ecs update-service --cluster ${ECS_CLUSTER} --service ${ECS_SERVICE_API} \
  --task-definition ${ECS_TASK_FAMILY_API}:42 --force-new-deployment

aws ecs wait services-stable --cluster ${ECS_CLUSTER} --services ${ECS_SERVICE_API}
```

`wait services-stable` is the difference between "the API accepted my request"
and "tasks running the old revision are passing health checks". Do not report
the rollback done before it returns.

### 4. Confirm

```bash
curl -sf https://${DOMAIN}/api/health && echo
curl -s https://${DOMAIN}/metrics | grep pulsara_host_sample_age_seconds
```

Then check that the client is on a matching revision. The two services deploy
separately, so a rollback of the API alone can leave a client calling an
endpoint that no longer exists — roll `${ECS_SERVICE_WEB}` back to the same
commit unless you know the change was API-only.

### 5. Stop the next merge from redeploying it

`main` still contains the bad commit, and the next merge to it will deploy
again. Revert it in git. A rollback that is not reflected in the branch is a
rollback with a timer on it.

---

## A release failed part-way through

The release workflow is ordered so that failure is survivable: build, migrate,
deploy the API, deploy the client. Where it stopped determines what is true.

| Failed at | State | What to do |
| :--- | :--- | :--- |
| **Build** | Nothing changed. Images may be in ECR; nothing runs them. | Fix and re-run. |
| **Migrate** | Schema may be partly applied. Services untouched, still on the old revision and the old schema. | See below — this is the one that needs judgement. |
| **Deploy the API** | Schema is new, API may be mid-rollout. The circuit breaker reverts a failing rollout, which leaves old code against a new schema. | Additive migrations are fine; otherwise fix forward urgently. |
| **Deploy the client** | API and schema are new and healthy; the client is old. | Usually harmless. Re-run the workflow. |

**A failed migration.** Prisma applies migrations one at a time and records each
in `_prisma_migrations`, so a failure leaves earlier ones applied and marks the
failing one. It does not roll the whole set back.

```sql
SELECT migration_name, finished_at, rolled_back_at, logs
FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
```

A row with `finished_at` null is the one that failed. Two ways forward, and the
choice depends on whether the migration did anything before it failed:

- **It changed nothing** (a syntax error, a constraint rejected outright). Mark
  it rolled back so Prisma will retry a corrected version:
  `prisma migrate resolve --rolled-back <migration_name>`. Then push a commit
  fixing the migration, which is what triggers the next release.
- **It changed something and then failed part-way.** Do not mark it rolled back
  — Prisma will replay it against a schema that has already had half of it
  applied. Write a new migration that reconciles the actual state, or restore
  the database to a point in time before the release.

Either way the fix is a new commit. **Re-running the same release changes
nothing**: the next run attempts the same migration against the same
half-applied schema and fails identically. And do not reach for the service
update on its own — deploying code past a failed migration is exactly what the
workflow's exit-code check exists to prevent.

---

## Redis is unavailable

**Expected behaviour: the system stays up.** Redis is optional by design. The
read cache falls through to PostgreSQL, and probe scheduling reverts to an
in-process timer.

**What actually degrades.** With more than one API task and no queue, *every*
replica probes *every* service — so the endpoints being monitored see load
multiplied by the replica count. On a small fleet that is invisible; on a large
one it is a self-inflicted denial of service against the things you are
watching.

**So:** if Redis will be down for more than a few minutes, scale the API to one
task.

```bash
aws ecs update-service --cluster ${ECS_CLUSTER} --service ${ECS_SERVICE_API} --desired-count 1
```

Autoscaling will fight this. Suspend it first, and remember to restore both:

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/${ECS_CLUSTER}/${ECS_SERVICE_API} \
  --suspended-state DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true
```

Cached data cannot be stale after an outage — the cache is empty, not wrong.

---

## The database is unreachable or failing over

`/api/health` deliberately does **not** touch the database, and the load
balancer health check points at it. That is why a database outage returns errors
rather than removing every task from the load balancer and turning a partial
outage into a total one.

`/api/health/ready` does touch it, and is the endpoint to check by hand:

```bash
curl -s https://${DOMAIN}/api/health/ready | jq
```

**During a Multi-AZ failover** (one to two minutes) connections are refused,
then re-established. Prisma reconnects on its own. Nothing to do but wait —
restarting tasks mid-failover makes it slower, not faster.

**If it does not come back:** check the instance and its recent events.

```bash
aws rds describe-db-instances --db-instance-identifier ${DB_IDENTIFIER} \
  --query 'DBInstances[0].{status:DBInstanceStatus,az:AvailabilityZone,multiAZ:MultiAZ}'
aws rds describe-events --source-identifier ${DB_IDENTIFIER} \
  --source-type db-instance --duration 60
```

**Connection exhaustion** looks like a database outage and is not one: errors
about too many connections, appearing right after a scale-out. The connection
string sets `connection_limit=5` per task precisely because Prisma's default
pool size times the autoscaling ceiling exceeds what a small instance allows.
Scale in, then either raise the instance class or lower the limit — the limit is
in the `database-url` secret, so changing it is `put-secret-value` and a
restart, with no new task definition.

---

## Incidents are not opening, or will not stop opening

**Nothing opens.** Check the engine is on and the thresholds are what you think:
`HOST_ALERTS_ENABLED`, `DEPLOYMENT_ALERTS_ENABLED`, and the
`*_ALERT_THRESHOLD_PERCENT` values. Then remember hysteresis: a threshold must
be exceeded for `HOST_ALERT_SUSTAINED_SAMPLES` *consecutive* samples. At the
two-second default that is a few seconds, but a spiky signal that keeps dipping
below the line never accumulates a streak. That is the feature working.

**One incident, opening and closing repeatedly.** A resource sitting exactly on
its threshold. Widen the gap between opening and recovery by raising
`HOST_ALERT_RECOVERY_SAMPLES` rather than by moving the threshold — the
threshold is the thing you actually believe.

**An automated incident will not stay closed.** Resolving it by hand works, and
then it comes straight back — because the condition is still true. The engine
re-evaluates on every sample once a breaching streak is established, finds no
open incident for that dedupe key, and opens a new one. This is working as
intended: an alert you can silence while the thing it is about is still
happening is not an alert. Fix the condition, or move the threshold
deliberately.

The reverse does not happen. Recovery auto-resolves only incidents with
`source = AUTOMATED`; one a person raised is left alone, because they may be
tracking something no probe can see and closing their investigation because an
endpoint answered 200 would be worse than leaving it open.

**Duplicates for the same condition.** Should be impossible — a partial unique
index (`Incident_open_dedupe_unique`, on `dedupeKey WHERE isOpen`) enforces at
most one open incident per dedupe key in the database rather than in application
code, which is what makes two concurrent scheduler ticks safe. If duplicates
appear, the index is missing; check that the `incident_engine` migration
applied.

---

## Rotating the JWT signing keys

Rotating both at once signs everybody out. That is sometimes the point (a
suspected key compromise), and sometimes an unwanted side effect of routine
hygiene — decide which before you start.

```bash
aws secretsmanager put-secret-value --secret-id ${SECRET_PREFIX}/jwt-access-secret \
  --secret-string "$(openssl rand -base64 48)"
aws secretsmanager put-secret-value --secret-id ${SECRET_PREFIX}/jwt-refresh-secret \
  --secret-string "$(openssl rand -base64 48)"

aws ecs update-service --cluster ${ECS_CLUSTER} --service ${ECS_SERVICE_API} --force-new-deployment
```

The two values must differ — the API refuses to start if they match, because an
access token that could be replayed as a refresh token would defeat holding the
short-lived one in memory.

**Rotating the access key alone** expires every session within
`ACCESS_TOKEN_TTL_SECONDS`, and clients silently re-obtain one with their
refresh cookie. Nobody is signed out. This is the routine rotation.

**Rotating the refresh key** invalidates every refresh cookie. Everyone signs in
again. Use it when a session must not survive.

To end one person's sessions rather than everyone's, do not touch these keys —
`DELETE /api/auth/sessions` revokes that user's refresh tokens and stamps their
`sessionsValidFrom`, which is checked on every request, so their existing access
tokens stop working immediately rather than at the end of their TTL.

---

## Getting a shell in a running task

There is no bastion. ECS Exec is authorised by IAM and logged in CloudTrail.

```bash
aws ecs list-tasks --cluster ${ECS_CLUSTER} --service-name ${ECS_SERVICE_API} \
  --query 'taskArns[0]' --output text

aws ecs execute-command --cluster ${ECS_CLUSTER} --task <task-arn> \
  --container api --interactive --command "/bin/sh"
```

Needs the Session Manager plugin locally. The container runs as the
unprivileged `node` user, so this is for reading — logs, environment, a quick
`node -e` against the database — not for changing anything. Anything worth
changing goes through a release, where it is reviewed and recorded.
