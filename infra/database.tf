/**
 * PostgreSQL, in private subnets, reachable only from the API tasks.
 *
 * There is no bastion and no public endpoint. The one thing that ever needs to
 * run SQL from outside a request — `prisma migrate deploy` — runs as a one-off
 * ECS task on the API's own security group, which is what makes "no route in"
 * affordable rather than merely aspirational.
 */

resource "aws_db_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = local.name }
}

/**
 * `rds.force_ssl` refuses any connection that is not TLS. Without it the
 * database will happily accept plaintext, and "we use TLS" becomes a property
 * of every client's connection string rather than of the server.
 *
 * The connection string below asks for `sslmode=require`, which encrypts but
 * does not verify the server certificate. Verifying it (`verify-full`) needs
 * the RDS CA bundle inside the image and pins the deployment to a certificate
 * rotation schedule; inside a VPC where the only route to port 5432 is from one
 * security group, the residual risk is an attacker who is already inside the
 * network boundary.
 */
resource "aws_db_parameter_group" "this" {
  name_prefix = "${local.name}-"
  family      = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Logs any statement slower than a second, which is the cheapest possible
  # answer to "the dashboard got slow and nobody knows why".
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "random_password" "database" {
  length = 32
  # RDS rejects '/', '@', '"' and spaces outright, and the rest of these would
  # need percent-encoding in the connection string the API is handed.
  override_special = "!#$%&*()-_=+[]{}<>?"
}

resource "aws_db_instance" "this" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = replace(var.project, "-", "_")
  username = "pulsara_app"
  password = random_password.database.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.this.name

  # Never. The only route to this instance is one security group inside the VPC.
  publicly_accessible = false

  multi_az = var.db_multi_az

  backup_retention_period = var.db_backup_retention_days
  # Both windows are UTC and deliberately outside European and American working
  # hours. Leaving them unset lets AWS pick, and AWS picks differently per
  # region, so a maintenance restart lands mid-afternoon somewhere.
  backup_window      = "02:00-03:00"
  maintenance_window = "sun:03:30-sun:04:30"

  # Patch releases only. A major version upgrade changes the query planner and
  # occasionally the SQL; it is a decision, not a maintenance window.
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  deletion_protection = var.db_deletion_protection
  # A destroy that leaves no snapshot is a destroy nobody can undo, and the
  # timestamped name is because the identifier has to be unique per account.
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  performance_insights_enabled    = var.db_performance_insights
  enabled_cloudwatch_logs_exports = ["postgresql"]

  lifecycle {
    ignore_changes = [
      # Otherwise every plan after the first shows a diff, because the
      # timestamp in the name is evaluated afresh each run.
      final_snapshot_identifier,
      /**
       * So that a password rotated against the instance directly — by an
       * operator during an incident, or by a Secrets Manager rotation function
       * later — is not silently reverted by the next unrelated apply. The
       * generated value is the bootstrap one, not a permanent claim on it.
       */
      password,
    ]
  }

  tags = { Name = local.name }
}
