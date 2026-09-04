/**
 * The cluster and the two services on it.
 */

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    # Per-task CPU, memory and network metrics. Autoscaling works off service
    # metrics either way; this is what makes "which task is hot" answerable
    # after the fact, when the fleet has already scaled and moved on.
    name  = "containerInsights"
    value = "enhanced"
  }

  tags = { Name = local.name }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  /**
   * FARGATE only, deliberately. FARGATE_SPOT is roughly 70% cheaper and can be
   * reclaimed with two minutes' notice — fine for a stateless client, and wrong
   * for an API holding WebSocket sessions, since a reclaim drops every
   * connected dashboard. Splitting the two across different capacity providers
   * is a real option and a decision to take on purpose, not a default.
   */
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# --- API --------------------------------------------------------------------

module "api_service" {
  source = "./modules/ecs-service"

  name           = "${local.name}-api"
  container_name = "api"
  cluster_id     = aws_ecs_cluster.this.arn
  cluster_name   = aws_ecs_cluster.this.name
  aws_region     = var.aws_region

  image          = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
  cpu            = var.api_cpu
  memory         = var.api_memory
  container_port = local.api_port

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.api.id]
  target_group_arn   = aws_lb_target_group.api.arn

  min_capacity       = var.api_min_capacity
  max_capacity       = var.api_max_capacity
  cpu_target_percent = var.cpu_target_percent
  log_retention_days = var.log_retention_days

  # The API opens its database pool and starts its collector before it serves,
  # so the load balancer's first verdict would otherwise arrive too early.
  health_check_grace_period_seconds = 90

  # The same check the image declares. ECS ignores a Dockerfile HEALTHCHECK
  # unless the task definition repeats it, which is a quiet way to end up with
  # no container-level check at all.
  health_check_command = [
    "CMD-SHELL",
    "node -e \"fetch('http://127.0.0.1:${local.api_port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
  ]

  /**
   * Plain environment, and every value here is one somebody could read from
   * `describe-task-definition` without it mattering. Anything that would matter
   * is in `secrets` below and never appears in this JSON.
   */
  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(local.api_port) },
    { name = "LOG_LEVEL", value = "info" },
    { name = "CORS_ORIGINS", value = local.cors_origins },

    # Every replica records host metrics, and without a distinct label their
    # samples would be indistinguishable from each other. The task's own id
    # would be ideal; the service name is what is knowable at this point.
    { name = "TELEMETRY_HOST_ID", value = "${local.name}-api" },

    { name = "METRICS_COLLECTION_ENABLED", value = "true" },
    { name = "PROMETHEUS_METRICS_ENABLED", value = "true" },
    { name = "HOST_ALERTS_ENABLED", value = "true" },

    # Redis is present, so probing is queue-backed: the sweep is singular across
    # the fleet rather than multiplied by the number of running tasks.
    { name = "PROBES_ENABLED", value = "true" },
    { name = "CACHE_ENABLED", value = "true" },
    { name = "REDIS_KEY_PREFIX", value = local.name },

    { name = "GITHUB_MONITORED_REPO", value = var.github_monitored_repo },
    { name = "GITHUB_SYNC_ENABLED", value = tostring(var.enable_github_integration) },
    { name = "DEPLOYMENT_ALERTS_ENABLED", value = "true" },
  ]

  secrets = local.api_secrets

  # A service registered with a target group that is not yet attached to a
  # listener never reaches steady state, and Terraform cannot infer the ordering
  # from the resource graph alone.
  depends_on = [aws_lb_listener.https, aws_lb_listener_rule.api]
}

# --- Client -----------------------------------------------------------------

module "web_service" {
  source = "./modules/ecs-service"

  name           = "${local.name}-web"
  container_name = "web"
  cluster_id     = aws_ecs_cluster.this.arn
  cluster_name   = aws_ecs_cluster.this.name
  aws_region     = var.aws_region

  image          = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}"
  cpu            = var.web_cpu
  memory         = var.web_memory
  container_port = local.web_port

  execution_role_arn = aws_iam_role.task_execution.arn
  task_role_arn      = aws_iam_role.task.arn

  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.web.id]
  target_group_arn   = aws_lb_target_group.web.arn

  min_capacity       = var.web_min_capacity
  max_capacity       = var.web_max_capacity
  cpu_target_percent = var.cpu_target_percent
  log_retention_days = var.log_retention_days

  # nginx is serving before the process has finished starting.
  health_check_grace_period_seconds = 20

  health_check_command = [
    "CMD-SHELL",
    "wget --spider -q http://127.0.0.1:${local.web_port}/ || exit 1",
  ]

  /**
   * No environment and no secrets, and that is not an omission. Vite inlines
   * every VITE_* value at build time, so this image already contains its API
   * origin — which is why the release workflow passes it as a build argument
   * and why an image built for one deployment cannot be repointed at another.
   */
  environment = []
  secrets     = []

  depends_on = [aws_lb_listener.https]
}
