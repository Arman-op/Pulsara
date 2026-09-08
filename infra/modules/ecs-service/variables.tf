variable "name" {
  description = "Full resource name, already prefixed with project and environment."
  type        = string
}

variable "container_name" {
  description = "Name of the container inside the task definition. The release workflow patches the image of the container with this name, so it is part of the deployment contract."
  type        = string
}

variable "cluster_id" {
  description = "ARN of the ECS cluster to run in."
  type        = string
}

variable "cluster_name" {
  description = "Name of the same cluster. Application Auto Scaling addresses a service by \"service/<cluster>/<service>\" and will not take an ARN."
  type        = string
}

variable "image" {
  description = "Fully-qualified image reference to run at bootstrap."
  type        = string
}

variable "cpu" {
  description = "Fargate CPU units."
  type        = number
}

variable "memory" {
  description = "Fargate memory, MiB."
  type        = number
}

variable "container_port" {
  description = "Port the process listens on."
  type        = number
}

variable "environment" {
  description = "Plain environment variables. Nothing secret belongs here: this ends up in the task-definition JSON, which anybody with describe-task-definition can read."
  type        = list(object({ name = string, value = string }))
  default     = []
}

variable "secrets" {
  description = "Secrets Manager references, resolved by the ECS agent before the container starts."
  type        = list(object({ name = string, valueFrom = string }))
  default     = []
}

variable "health_check_command" {
  description = "Container-level health check. Empty disables it, which is right for a container with no way to answer."
  type        = list(string)
  default     = []
}

variable "execution_role_arn" {
  description = "Role the ECS agent uses to pull the image, write logs and resolve secrets."
  type        = string
}

variable "task_role_arn" {
  description = "Role the application itself runs as."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets the tasks get their addresses from."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups applied to each task's network interface."
  type        = list(string)
}

variable "target_group_arn" {
  description = "Load-balancer target group tasks register with."
  type        = string
}

variable "min_capacity" {
  description = "Fewest tasks autoscaling may run."
  type        = number
}

variable "max_capacity" {
  description = "Most tasks autoscaling may run."
  type        = number
}

variable "cpu_target_percent" {
  description = "Average CPU utilisation the target-tracking policy holds."
  type        = number
}

variable "health_check_grace_period_seconds" {
  description = "How long after a task starts the load balancer's verdict is ignored. Covers migrations, connection pools and anything else that happens before the first request can be served."
  type        = number
  default     = 60
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
}

variable "aws_region" {
  description = "Region, for the log driver configuration."
  type        = string
}
