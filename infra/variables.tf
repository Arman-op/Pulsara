/**
 * Every value that differs between deployments, and nothing that does not.
 *
 * The validation blocks are the same idea as the Zod schema the API validates
 * its environment with: fail at plan time with a sentence somebody can act on,
 * rather than at apply time with an AWS API error, or — worse — succeed and
 * produce something subtly wrong.
 */

variable "project" {
  description = "Short name prefixed to every resource. Lower-case, no spaces."
  type        = string
  default     = "pulsara"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project))
    error_message = "project must be 2-21 lower-case letters, digits or hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment. Part of every resource name, so two environments never collide."
  type        = string
  default     = "production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "environment must be 2-16 lower-case letters, digits or hyphens, starting with a letter."
  }
}

variable "repository" {
  description = "owner/name of the GitHub repository. Used for resource tags and, critically, for the OIDC trust policy."
  type        = string
  default     = "Arman-op/Pulsara"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "repository must be in owner/name form."
  }
}

variable "deploy_branch" {
  description = "The only branch whose workflow runs may assume the deploy role."
  type        = string
  default     = "main"
}

variable "aws_region" {
  description = "Region everything is created in."
  type        = string
  default     = "eu-west-1"
}

# --- Remote state -----------------------------------------------------------

/**
 * The backend block cannot interpolate — it is read before variables exist — so
 * the bucket and key are passed to `init` with -backend-config. These two
 * variables exist because the CI plan role needs a policy naming exactly those
 * objects, and duplicating the values into an IAM policy by hand is how the
 * two drift apart.
 */

variable "state_bucket" {
  description = "S3 bucket holding the Terraform state, so the CI plan role can be scoped to it."
  type        = string
}

variable "state_key" {
  description = "Key of the state object within that bucket."
  type        = string
  default     = "production/terraform.tfstate"
}

# --- Network ----------------------------------------------------------------

variable "vpc_cidr" {
  description = "Address space for the VPC. Must be large enough for two /24 public subnets and two /20 private ones."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid CIDR block of /20 or larger."
  }
}

variable "az_count" {
  description = "Availability zones to spread across. Two is the minimum an ALB will accept."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4
    error_message = "az_count must be between 2 and 4: an ALB requires two, and beyond four the NAT bill outgrows the benefit."
  }
}

variable "single_nat_gateway" {
  description = <<-EOT
    Route every private subnet through one NAT gateway instead of one per zone.

    The cost tradeoff, at roughly $33/month per gateway plus data processing:
    one gateway saves about $33/month per additional zone, and makes that zone's
    failure remove outbound internet access for every private subnet — Secrets
    Manager, ECR pulls and the GitHub API all stop. It does not take down
    in-VPC traffic, so the database and cache stay reachable.

    True is right for a portfolio deployment and for staging. False is right for
    anything whose availability somebody has promised.
  EOT
  type        = bool
  default     = true
}

# --- DNS and certificates ---------------------------------------------------

variable "domain_name" {
  description = "Fully-qualified name the application is served on, e.g. pulsara.example.com. The client and API share it, which is what makes every request same-origin."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]+\\.[a-z]{2,}$", var.domain_name))
    error_message = "domain_name must be a fully-qualified domain name."
  }
}

variable "route53_zone_id" {
  description = "Hosted zone that already delegates domain_name. Terraform adds the validation and alias records to it; it does not create or delegate the zone."
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]+$", var.route53_zone_id))
    error_message = "route53_zone_id must be a Route 53 zone id, e.g. Z1234567890ABC."
  }
}

# --- Images -----------------------------------------------------------------

variable "api_image_tag" {
  description = "Tag of the API image to run. The deploy workflow registers new task-definition revisions itself, so this is the bootstrap value only."
  type        = string
  default     = "bootstrap"
}

variable "web_image_tag" {
  description = "Tag of the client image to run. As above."
  type        = string
  default     = "bootstrap"
}

# --- ECS --------------------------------------------------------------------

variable "api_cpu" {
  description = "Fargate CPU units for one API task. 1024 = 1 vCPU."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) for one API task. Must be a valid pairing with api_cpu."
  type        = number
  default     = 1024
}

variable "web_cpu" {
  description = "Fargate CPU units for one client task. Serving static files needs very little."
  type        = number
  default     = 256
}

variable "web_memory" {
  description = "Fargate memory (MiB) for one client task."
  type        = number
  default     = 512
}

variable "api_min_capacity" {
  description = "Fewest API tasks. Two, so a single task failing or being replaced during a deployment is not an outage."
  type        = number
  default     = 2
}

variable "api_max_capacity" {
  description = "Most API tasks autoscaling may reach. A ceiling is what stops a runaway loop becoming a runaway bill."
  type        = number
  default     = 6
}

variable "web_min_capacity" {
  description = "Fewest client tasks."
  type        = number
  default     = 2
}

variable "web_max_capacity" {
  description = "Most client tasks."
  type        = number
  default     = 4
}

variable "cpu_target_percent" {
  description = <<-EOT
    Average CPU utilisation autoscaling aims to hold.

    Not higher: the target is an average across tasks, and scaling out takes a
    minute or two, so a target near saturation means the fleet is already
    struggling by the time a new task is accepting traffic.
  EOT
  type        = number
  default     = 60

  validation {
    condition     = var.cpu_target_percent > 20 && var.cpu_target_percent < 90
    error_message = "cpu_target_percent must be between 20 and 90; outside that range the policy either never settles or never scales in time."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Logs are never free and rarely read after a month."
  type        = number
  default     = 30
}

# --- Database ---------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage (GiB). Autoscales up to db_max_allocated_storage."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Ceiling for storage autoscaling. Telemetry is append-only and the retention sweep is what bounds it; this bounds the bill if the sweep ever stops."
  type        = number
  default     = 100
}

variable "db_multi_az" {
  description = <<-EOT
    Run a synchronous standby in the second availability zone.

    The cost tradeoff: Multi-AZ roughly doubles the instance bill — on a
    db.t4g.micro that is a few dollars a month, on anything real it is not — and
    buys automatic failover in one to two minutes with no data loss.

    Single-AZ does not mean "no backups". Automated backups and point-in-time
    recovery still run, so the loss is not the data, it is the time: recovery
    from a zone failure means restoring a snapshot into a new instance, which is
    tens of minutes of downtime and loses whatever happened since the last
    transaction log shipment.

    False is honest for a portfolio deployment. True is the only defensible
    answer for a system anybody is paged for.
  EOT
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. Above zero this also enables point-in-time recovery."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1
    error_message = "Backups must be retained for at least one day: zero disables point-in-time recovery entirely."
  }
}

variable "db_performance_insights" {
  description = <<-EOT
    Enable RDS Performance Insights.

    Off by default because it is not supported on the smallest burstable
    classes, and db.t4g.micro is the default here — enabling it there fails the
    apply rather than degrading gracefully. Turn it on together with a larger
    instance class; seven days of retention is free, and it is the difference
    between "the dashboard got slow" and "this query got slow".
  EOT
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Refuse to destroy the database. Turn it off deliberately, in a separate apply, before tearing an environment down."
  type        = bool
  default     = true
}

# --- Cache ------------------------------------------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_replica_count" {
  description = <<-EOT
    Read replicas in the replication group.

    One replica in the second zone enables automatic failover and roughly
    doubles the cache bill. Nothing in Redis here is a record of anything — it
    holds cache entries and queued probe jobs — so losing it costs a cold cache
    and a missed probe sweep, not data. Zero is a defensible choice; the failure
    mode is a few seconds of slower reads.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.redis_replica_count >= 0 && var.redis_replica_count <= 3
    error_message = "redis_replica_count must be between 0 and 3."
  }
}

# --- Optional integrations --------------------------------------------------

variable "enable_firebase_auth" {
  description = <<-EOT
    Inject the Firebase service-account credentials into the API task.

    Leave false until somebody has put a value into the secret Terraform
    creates. A task definition that references an empty secret fails to start,
    with an error about the secret rather than about the deployment — and the
    private key is deliberately not managed by Terraform, because a value that
    passes through Terraform is a value that lives in the state file.
  EOT
  type        = bool
  default     = false
}

variable "enable_github_integration" {
  description = "Inject the GitHub App credentials into the API task. Same rule as enable_firebase_auth: the secret is created empty and filled in by a person."
  type        = bool
  default     = false
}

variable "github_monitored_repo" {
  description = "Repository whose Actions runs the Pipelines view mirrors."
  type        = string
  default     = "Arman-op/Pulsara"
}
