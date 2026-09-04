terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

/**
 * One load-balanced Fargate service: log group, task definition, service and a
 * target-tracking autoscaling policy.
 *
 * The two services this is instantiated for differ in almost every value and in
 * none of the structure, which is exactly the case a module is for. Writing
 * them out twice would mean every future change — a deployment setting, a log
 * retention rule, a circuit breaker — has to be made twice and will eventually
 * be made once.
 */

resource "aws_cloudwatch_log_group" "this" {
  # The conventional /ecs/ prefix, which is what CloudWatch's own console
  # groupings and most log-insight examples expect.
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days

  tags = { Name = var.name }
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory

  execution_role_arn = var.execution_role_arn
  task_role_arn      = var.task_role_arn

  /**
   * Explicit rather than inherited. Both images are built on GitHub's x86
   * runners, and an ARM64 task definition pulling an amd64 image fails at
   * start-up with an exec-format error that reads like a corrupt image.
   *
   * ARM64 is roughly 20% cheaper for the same Fargate size and is the obvious
   * next lever, but it is a change to the build — a buildx cross-compile — and
   * not a value to flip here.
   */
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name  = var.container_name
      image = var.image
      # A single-container task: if it exits, the task is finished either way,
      # and marking it non-essential would let a dead task sit registered.
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        },
      ]

      environment = var.environment
      secrets     = var.secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "task"
        }
      }

      healthCheck = length(var.health_check_command) == 0 ? null : {
        command     = var.health_check_command
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 15
      }

      # The API traps SIGTERM and drains; this is how long it is given before
      # SIGKILL. Below the default 30 there is no point trapping the signal.
      stopTimeout = 30

      # Left writable: Node writes to /tmp, and nginx writes its own temp and
      # pid paths. Locking it down means declaring tmpfs mounts for both, which
      # is worth doing and is a change to test against the images rather than
      # to assert here.
      readonlyRootFilesystem = false
    },
  ])

  tags = { Name = var.name }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  launch_type     = "FARGATE"

  # The floor, not the running count. Autoscaling owns the number from here on,
  # which is why it is ignored below.
  desired_count = var.min_capacity

  platform_version = "LATEST"

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = var.security_group_ids
    # Private subnets with a NAT route out. A public IP would both be useless —
    # nothing may reach these ports except the load balancer — and undo the
    # reason the subnets are private.
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  /**
   * Never fewer than the current count during a deployment, and up to double.
   * The alternative — allowing the minimum to drop below 100% — means a rolling
   * deployment runs briefly at reduced capacity, which is how a routine release
   * turns into a latency incident at peak.
   */
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  /**
   * The most valuable four lines in this file. Without the circuit breaker, a
   * deployment whose tasks crash on start-up retries indefinitely: the old
   * tasks keep serving, the release appears to hang, and somebody notices an
   * hour later. With it, ECS gives up and puts the previous task definition
   * back on its own.
   */
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # A shell in a running task, authorised by IAM and logged in CloudTrail,
  # instead of a bastion host standing permanently in a public subnet.
  enable_execute_command = true

  lifecycle {
    /**
     * Both of these are owned by something other than Terraform, and saying so
     * is what stops this configuration fighting the systems that own them.
     *
     * `task_definition` is set by the release workflow, which registers a new
     * revision per commit. Without this line the next `terraform apply` would
     * quietly roll production back to whatever image tag the variables happen
     * to name — a rollback nobody asked for, triggered by an unrelated change.
     *
     * `desired_count` is set by the autoscaling policy below. Without this line
     * every apply would reset a scaled-out fleet to its minimum.
     */
    ignore_changes = [task_definition, desired_count]
  }

  tags = { Name = var.name }
}

# --- Autoscaling ------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity
}

/**
 * Target tracking on average CPU, rather than step scaling on an alarm.
 *
 * Target tracking states the goal — hold the fleet near this utilisation — and
 * lets the service work out the step sizes. Step scaling makes those a matter
 * of guessing thresholds, and the guesses go stale the moment the workload
 * changes shape.
 *
 * The asymmetric cooldowns are the important part. Scaling out is cheap and
 * reversible, so it happens quickly; scaling in throws away warm capacity, so
 * it waits five minutes to be sure the load really has gone. Equal cooldowns
 * produce a fleet that oscillates around the target all afternoon.
 */
resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value = var.cpu_target_percent

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    scale_out_cooldown = 60
    scale_in_cooldown  = 300
  }
}
