/**
 * Outputs, chosen for a specific job: everything the release workflow needs as
 * a repository variable comes out of here.
 *
 * That is not a convenience. `.github/workflows/deploy.yml` addresses this
 * infrastructure by name — cluster, service, task family, container, subnets,
 * security groups — and every one of those names is decided in this directory.
 * Copying them by hand into GitHub settings is how a release ends up pointed at
 * a cluster that no longer exists, so they are printed rather than remembered:
 *
 *   terraform output -json github_actions_variables | jq -r 'to_entries[] | "\(.key)=\(.value)"'
 */

output "application_url" {
  description = "Where the application is served. Also the value of VITE_API_URL, because the client and the API share an origin."
  value       = local.application_url
}

output "alb_dns_name" {
  description = "The load balancer's own name. Useful for reaching the deployment before DNS has propagated, and for a health check that bypasses Route 53."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone of the load balancer, for anyone adding alias records outside this configuration."
  value       = aws_lb.this.zone_id
}

output "route53_record_name" {
  description = "The alias record created for the application."
  value       = aws_route53_record.ipv4.fqdn
}

output "ecr_api_repository_url" {
  description = "Registry path for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "ecr_web_repository_url" {
  description = "Registry path for the client image."
  value       = aws_ecr_repository.web.repository_url
}

output "database_endpoint" {
  description = "RDS endpoint. Not reachable from outside the VPC; printed so an operator can confirm which instance a task is talking to."
  value       = aws_db_instance.this.address
}

output "cache_endpoint" {
  description = "ElastiCache primary endpoint. Also unreachable from outside the VPC."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "log_groups" {
  description = "Where each service writes."
  value = {
    api = module.api_service.log_group_name
    web = module.web_service.log_group_name
  }
}

output "secret_arns" {
  description = "The Secrets Manager entries. ARNs, not values — the values are readable only by the task execution role and by whoever is allowed to call GetSecretValue."
  value = {
    database_url       = aws_secretsmanager_secret.database_url.arn
    redis_url          = aws_secretsmanager_secret.redis_url.arn
    jwt_access_secret  = aws_secretsmanager_secret.jwt_access.arn
    jwt_refresh_secret = aws_secretsmanager_secret.jwt_refresh.arn
    firebase           = aws_secretsmanager_secret.firebase.arn
    github_app         = aws_secretsmanager_secret.github_app.arn
  }
}

output "github_deploy_role_arn" {
  description = "Role .github/workflows/deploy.yml assumes over OIDC. Set as the AWS_DEPLOY_ROLE_ARN secret on the production environment."
  value       = aws_iam_role.github_deploy.arn
}

output "github_terraform_plan_role_arn" {
  description = "Role .github/workflows/infra.yml assumes to run a plan. Set as the AWS_TERRAFORM_PLAN_ROLE_ARN secret."
  value       = aws_iam_role.github_terraform_plan.arn
}

/**
 * The release workflow's entire configuration surface, in the shape it is
 * consumed. Every key here is a repository variable named in README.md.
 */
output "github_actions_variables" {
  description = "Repository variables for the release workflow, ready to copy."
  value = {
    AWS_REGION             = var.aws_region
    ECR_REPOSITORY_API     = aws_ecr_repository.api.name
    ECR_REPOSITORY_WEB     = aws_ecr_repository.web.name
    ECS_CLUSTER            = aws_ecs_cluster.this.name
    ECS_SERVICE_API        = module.api_service.service_name
    ECS_SERVICE_WEB        = module.web_service.service_name
    ECS_TASK_FAMILY_API    = module.api_service.task_definition_family
    ECS_TASK_FAMILY_WEB    = module.web_service.task_definition_family
    ECS_CONTAINER_API      = module.api_service.container_name
    ECS_CONTAINER_WEB      = module.web_service.container_name
    ECS_SUBNET_IDS         = join(",", aws_subnet.private[*].id)
    ECS_SECURITY_GROUP_IDS = aws_security_group.api.id
    VITE_API_URL           = local.application_url
    PRODUCTION_API_URL     = local.application_url
  }
}
