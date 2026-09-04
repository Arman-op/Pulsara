/**
 * One load balancer, one hostname, two services behind it.
 *
 * The client is the default target and the API takes the paths that belong to
 * it. Serving both from a single origin is what removes cross-site cookies and
 * CORS from production entirely: the refresh cookie is first-party, so no
 * `SameSite=None` is needed, and browsers that are tightening third-party
 * cookie behaviour do not get a say in whether sessions survive.
 */

resource "aws_lb" "this" {
  name               = local.name
  load_balancer_type = "application"
  internal           = false

  subnets         = aws_subnet.public[*].id
  security_groups = [aws_security_group.alb.id]

  # An idle WebSocket is not an idle connection to Socket.IO — it pings every
  # 25 seconds — so the default 60 is survivable. The larger value is for the
  # long-polling fallback, whose held request can legitimately sit open.
  idle_timeout = 120

  # Rejects requests whose headers ALB cannot parse rather than passing them
  # through, which is what closes request-smuggling tricks against the origin.
  drop_invalid_header_fields = true

  enable_http2               = true
  enable_deletion_protection = var.environment == "production"
  preserve_host_header       = true

  tags = { Name = local.name }
}

# --- Target groups ----------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name     = "${local.name}-api"
  port     = local.api_port
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id
  # Fargate tasks use awsvpc networking, so targets are registered by IP.
  target_type = "ip"

  /**
   * Liveness, not readiness, and the choice matters.
   *
   * `/api/health/ready` touches the database. Pointing the load balancer at it
   * means a database failover deregisters every task at once and the ALB
   * answers 503 for the whole fleet — replacing a partial outage with a total
   * one, for a dependency that no amount of task replacement will fix.
   * `/api/health` answers whether this process is alive, which is the only
   * question the load balancer can act on.
   */
  health_check {
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  /**
   * Sticky, because Socket.IO opens with HTTP long-polling and only then
   * upgrades. The handshake and the poll that follows it have to reach the same
   * task, and with several tasks and no shared adapter they otherwise do not —
   * the symptom is a client that connects, disconnects and retries forever
   * while every individual request looks successful.
   *
   * The better fix is the Socket.IO Redis adapter, which would make any task
   * able to serve any session and let this be removed. The cache is already
   * here; wiring the adapter is a change to the application, not to this file.
   */
  stickiness {
    type            = "lb_cookie"
    cookie_duration = 3600
    enabled         = true
  }

  # Long enough for an in-flight request to finish, short enough that a
  # deployment is not dominated by waiting. The API's own shutdown stops
  # accepting and drains within this window.
  deregistration_delay = 30

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = local.web_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"

  health_check {
    path                = "/"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # nginx serving static files holds nothing worth draining.
  deregistration_delay = 10

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name}-web" }
}

# --- Listeners --------------------------------------------------------------

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  # 301 rather than 302: the redirect is permanent policy, and a permanent
  # redirect is the one browsers and HSTS preloading cache.
  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"

  # TLS 1.2 floor with 1.3 available. Anything older exists only for clients
  # that cannot run this application anyway.
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = aws_acm_certificate_validation.this.certificate_arn

  # Everything not claimed by a rule below is the single-page client, including
  # every deep link — the client owns routing, so /alerts must return index.html
  # rather than a 404 from the API.
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  # Only one rule exists; the number leaves room to insert ahead of it later
  # without renumbering.
  priority = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      # /api and /socket.io both with and without a trailing segment: the bare
      # forms are real endpoints, and a pattern of "/api/*" alone does not match
      # them.
      values = local.api_path_patterns
    }
  }
}
