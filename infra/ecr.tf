/**
 * One repository per image.
 *
 * Tags are immutable. The release workflow tags every image with the commit
 * SHA, and immutability turns that from a convention into a guarantee: a tag
 * cannot be moved to different content after a task definition has recorded it,
 * so "which commit is running" has exactly one answer.
 */

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}/api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-api" }
}

resource "aws_ecr_repository" "web" {
  name                 = "${local.name}/web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-web" }
}

/**
 * Expiry, because storage is billed and every merge to main adds an image.
 *
 * Untagged layers go quickly: they are what a replaced manifest leaves behind
 * and nothing can run them. Tagged images are kept thirty deep, which is enough
 * to roll back a long way — a rollback is `update-service` onto an older task
 * definition, and it fails if the image it names has been swept.
 */
locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the most recent 30 tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy     = local.ecr_lifecycle_policy
}
