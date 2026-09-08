terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  /**
   * Deliberately a partial configuration: the bucket, key and lock table are
   * supplied at `init` time rather than committed.
   *
   *   terraform init \
   *     -backend-config=bucket=pulsara-tfstate-<account-id> \
   *     -backend-config=key=production/terraform.tfstate \
   *     -backend-config=region=eu-west-1 \
   *     -backend-config=use_lockfile=true
   *
   * Naming the bucket here would hard-code one account's infrastructure into a
   * public repository, and it would make standing up a second environment a
   * matter of editing tracked code rather than passing a different key.
   *
   * The state is sensitive. It holds the generated database password and the
   * JWT signing keys in clear text — that is a property of Terraform, not of
   * this configuration — so the bucket must have encryption and public-access
   * blocking on, and read access restricted to the people who could read those
   * secrets from Secrets Manager anyway.
   */
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  # Applied to every resource that supports tagging, so cost allocation and
  # "what is this and who owns it" do not depend on remembering per resource.
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repository  = var.repository
    }
  }
}
