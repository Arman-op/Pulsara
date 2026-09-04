output "service_name" {
  description = "ECS service name, as the release workflow's ECS_SERVICE_* variable."
  value       = aws_ecs_service.this.name
}

output "task_definition_family" {
  description = "Task-definition family, as the release workflow's ECS_TASK_FAMILY_* variable. The workflow reads the current revision of this family and registers a new one from it."
  value       = aws_ecs_task_definition.this.family
}

output "task_definition_arn" {
  description = "ARN of the revision Terraform registered. Only the bootstrap one; the workflow registers every revision after it."
  value       = aws_ecs_task_definition.this.arn
}

output "container_name" {
  description = "Container name, as the release workflow's ECS_CONTAINER_* variable. The workflow patches the image of the container with this name and fails loudly if no container matches."
  value       = var.container_name
}

output "log_group_name" {
  description = "CloudWatch log group the tasks write to."
  value       = aws_cloudwatch_log_group.this.name
}
