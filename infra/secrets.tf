/**
 * Every credential the API needs, in Secrets Manager, injected into the task
 * definition by ARN.
 *
 * The distinction that matters is between the secrets Terraform *generates* and
 * the secrets Terraform merely *makes room for*.
 *
 * Generated here: the database password, the two JWT signing keys, the Redis
 * auth token. They have no existence outside this deployment, nobody has to
 * copy them anywhere, and rotating one is a matter of changing the value and
 * restarting the service. The cost is that they are in the Terraform state
 * file, which is why the backend documentation insists on an encrypted bucket
 * with restricted read access.
 *
 * Created empty: the Firebase service-account key and the GitHub App private
 * key. Those are issued by somebody else, they identify this deployment to a
 * third party, and a value that passes through Terraform is a value in a state
 * file and in every plan output that ever touched it. Terraform creates the
 * container; a person puts the value in with `aws secretsmanager
 * put-secret-value`; the corresponding `enable_*` variable then switches on the
 * injection.
 */

locals {
  secret_prefix = "${local.name}/"

  /**
   * Seven days rather than the thirty-day default. The default is a real
   * footgun: a destroyed secret keeps its name reserved for a month, so
   * tearing an environment down and standing it back up fails with
   * "already scheduled for deletion" and no obvious way forward.
   */
  secret_recovery_days = 7
}

# --- Generated --------------------------------------------------------------

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.secret_prefix}database-url"
  description             = "PostgreSQL connection string for the API and for migrations"
  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id

  /**
   * `connection_limit` is set explicitly because Prisma's default pool size is
   * derived from the CPU count of the *container*, and multiplying that by the
   * autoscaling ceiling comfortably exceeds what a small RDS instance allows.
   * The failure mode is not gradual: connections are refused, and every task
   * that was healthy a second ago starts returning 500s.
   */
  secret_string = format(
    "postgresql://%s:%s@%s:%d/%s?schema=public&sslmode=require&connection_limit=5",
    aws_db_instance.this.username,
    urlencode(random_password.database.result),
    aws_db_instance.this.address,
    aws_db_instance.this.port,
    aws_db_instance.this.db_name,
  )
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "${local.secret_prefix}redis-url"
  description             = "ElastiCache connection string, with auth token"
  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id = aws_secretsmanager_secret.redis_url.id

  # `rediss://`, not `redis://`: the extra s is what makes ioredis negotiate TLS,
  # and without it the auth token below crosses the network in clear text.
  secret_string = format(
    "rediss://:%s@%s:%d",
    urlencode(random_password.redis_auth.result),
    aws_elasticache_replication_group.this.primary_endpoint_address,
    aws_elasticache_replication_group.this.port,
  )
}

/**
 * Two distinct keys, because the API refuses to start if they match: an access
 * token that could be replayed as a refresh token would defeat the entire
 * point of holding the short-lived one in memory.
 */
resource "random_password" "jwt_access" {
  length  = 64
  special = false
}

resource "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt_access" {
  name                    = "${local.secret_prefix}jwt-access-secret"
  description             = "HMAC key for access tokens"
  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret_version" "jwt_access" {
  secret_id     = aws_secretsmanager_secret.jwt_access.id
  secret_string = random_password.jwt_access.result
}

resource "aws_secretsmanager_secret" "jwt_refresh" {
  name                    = "${local.secret_prefix}jwt-refresh-secret"
  description             = "HMAC key for refresh tokens"
  recovery_window_in_days = local.secret_recovery_days
}

resource "aws_secretsmanager_secret_version" "jwt_refresh" {
  secret_id     = aws_secretsmanager_secret.jwt_refresh.id
  secret_string = random_password.jwt_refresh.result
}

# --- Created empty, filled in by a person -----------------------------------

/**
 * Stored as JSON so that one secret holds the whole credential and ECS pulls
 * out the three fields it needs by key. Splitting it into three secrets would
 * triple the per-secret charge and, worse, allow a deployment to run with two
 * thirds of a service account.
 *
 * Put a value in with:
 *
 *   aws secretsmanager put-secret-value \
 *     --secret-id pulsara-production/firebase \
 *     --secret-string file://firebase.json
 *
 * where the file is {"project_id": "...", "client_email": "...",
 * "private_key": "-----BEGIN PRIVATE KEY-----\n...\n"} — the escapes kept
 * literal, exactly as the API's environment schema expects them.
 */
resource "aws_secretsmanager_secret" "firebase" {
  name                    = "${local.secret_prefix}firebase"
  description             = "Firebase Admin service account: project_id, client_email, private_key"
  recovery_window_in_days = local.secret_recovery_days
}

/**
 * Likewise for the GitHub App: {"app_id": "...", "private_key": "...",
 * "webhook_secret": "..."}. The webhook secret lives here rather than beside
 * the others because it is half of a pair — the other half is configured on
 * the App in GitHub, and the two have to be set together or deliveries are
 * rejected.
 */
resource "aws_secretsmanager_secret" "github_app" {
  name                    = "${local.secret_prefix}github-app"
  description             = "GitHub App credentials: app_id, private_key, webhook_secret"
  recovery_window_in_days = local.secret_recovery_days
}

/**
 * The task definition references secrets by ARN, and an ARN is stable across
 * value changes — so rotating any of these is `put-secret-value` followed by
 * `update-service --force-new-deployment`, with no Terraform run and no new
 * task-definition revision.
 */
locals {
  api_secrets = concat(
    [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "REDIS_URL", valueFrom = aws_secretsmanager_secret.redis_url.arn },
      { name = "JWT_ACCESS_SECRET", valueFrom = aws_secretsmanager_secret.jwt_access.arn },
      { name = "JWT_REFRESH_SECRET", valueFrom = aws_secretsmanager_secret.jwt_refresh.arn },
    ],
    var.enable_firebase_auth ? [
      { name = "FIREBASE_PROJECT_ID", valueFrom = "${aws_secretsmanager_secret.firebase.arn}:project_id::" },
      { name = "FIREBASE_CLIENT_EMAIL", valueFrom = "${aws_secretsmanager_secret.firebase.arn}:client_email::" },
      { name = "FIREBASE_PRIVATE_KEY", valueFrom = "${aws_secretsmanager_secret.firebase.arn}:private_key::" },
    ] : [],
    var.enable_github_integration ? [
      { name = "GITHUB_APP_ID", valueFrom = "${aws_secretsmanager_secret.github_app.arn}:app_id::" },
      { name = "GITHUB_APP_PRIVATE_KEY", valueFrom = "${aws_secretsmanager_secret.github_app.arn}:private_key::" },
      { name = "GITHUB_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.github_app.arn}:webhook_secret::" },
    ] : [],
  )

  # What the execution role is allowed to read. Enumerated rather than
  # wildcarded, so a secret added to the account is not automatically readable
  # by these tasks.
  api_secret_arns = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.redis_url.arn,
    aws_secretsmanager_secret.jwt_access.arn,
    aws_secretsmanager_secret.jwt_refresh.arn,
    aws_secretsmanager_secret.firebase.arn,
    aws_secretsmanager_secret.github_app.arn,
  ]
}
