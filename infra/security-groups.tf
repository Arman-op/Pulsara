/**
 * The network boundary, written as rules that reference each other rather than
 * CIDR blocks.
 *
 * Every rule below except the two on the load balancer names a *security
 * group* as its source. That is the difference between "the database accepts
 * connections from 10.20.16.0/20" and "the database accepts connections from
 * the API tasks": the first stays true if somebody later puts something else in
 * that subnet, and the second does not.
 *
 * Rules are separate resources rather than inline blocks, because an inline
 * `ingress` block is authoritative — adding one by hand for an incident, then
 * running Terraform, silently removes it, and the plan output for an inline
 * change reads as a whole-group replacement rather than as one rule.
 */

# --- Load balancer ----------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public entry point: HTTP and HTTPS from the internet"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"

  cidr_ipv4   = "0.0.0.0/0"
  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  # Port 80 exists only to redirect. Closing it does not improve security; it
  # just means somebody typing the bare hostname gets a connection refused
  # instead of being sent to HTTPS.
  description = "HTTP from anywhere, redirected to HTTPS"

  cidr_ipv4   = "0.0.0.0/0"
  from_port   = 80
  to_port     = 80
  ip_protocol = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id = aws_security_group.alb.id
  description       = "To the API tasks"

  referenced_security_group_id = aws_security_group.api.id
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id = aws_security_group.alb.id
  description       = "To the client tasks"

  referenced_security_group_id = aws_security_group.web.id
  from_port                    = local.web_port
  to_port                      = local.web_port
  ip_protocol                  = "tcp"
}

# --- API tasks --------------------------------------------------------------

resource "aws_security_group" "api" {
  name        = "${local.name}-api"
  description = "API tasks: from the load balancer only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-api" }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id = aws_security_group.api.id
  description       = "From the load balancer"

  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = local.api_port
  to_port                      = local.api_port
  ip_protocol                  = "tcp"
}

/**
 * Unrestricted egress, and it is worth saying why rather than leaving it as an
 * unexamined default. The API legitimately reaches arbitrary hosts: service
 * health checks probe whatever URL somebody registered, and that is the whole
 * point of the feature. Constraining egress to a list would break the product's
 * primary function, so the control that matters here is what can reach *in*.
 */
resource "aws_vpc_security_group_egress_rule" "api_all" {
  security_group_id = aws_security_group.api.id
  description       = "Probes reach arbitrary registered targets, by design"

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "-1"
}

# --- Client tasks -----------------------------------------------------------

resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Client tasks: from the load balancer only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-web" }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id = aws_security_group.web.id
  description       = "From the load balancer"

  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = local.web_port
  to_port                      = local.web_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "web_all" {
  security_group_id = aws_security_group.web.id
  # nginx serves files off its own filesystem and calls nothing, but the task
  # still has to pull its image and ship its logs.
  description = "Image pulls and log shipping"

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "-1"
}

# --- Data stores ------------------------------------------------------------

resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "PostgreSQL: from the API tasks only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-database" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_api" {
  security_group_id = aws_security_group.database.id
  # The migration job runs as a one-off task on this same security group, which
  # is why there is no second rule for it, and no bastion.
  description = "PostgreSQL from the API tasks"

  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "cache" {
  name        = "${local.name}-cache"
  description = "Redis: from the API tasks only"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_api" {
  security_group_id = aws_security_group.cache.id
  description       = "Redis from the API tasks"

  referenced_security_group_id = aws_security_group.api.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

/**
 * Neither data store gets an egress rule. A security group with no egress rules
 * allows nothing out, which is correct for both: PostgreSQL and Redis answer
 * connections, they do not make them.
 */
