/**
 * Roles, and the OIDC trust that means no AWS key exists in GitHub.
 */

# --- ECS task roles ---------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

/**
 * The execution role belongs to the ECS agent, not to the application. It is
 * what pulls the image, writes to the log group and — the reason it needs an
 * inline policy — resolves the `secrets` block of the task definition before
 * the container starts.
 *
 * That is the whole point of injecting secrets this way. The values are fetched
 * by the agent and handed to the process as environment variables; they are
 * never in the task-definition JSON, so they are not in `describe-task-
 * definition` output, not in the console, and not in anyone's terminal history.
 */
resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    sid     = "ReadThisDeploymentsSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    # Enumerated, not wildcarded: a secret added to this account later should
    # not become readable by these tasks because of a pattern match.
    resources = local.api_secret_arns
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

/**
 * The task role is the application's own identity — what the code could use if
 * it called AWS. It calls none, so this grants nothing except the channel ECS
 * Exec needs.
 *
 * ECS Exec is here in place of a bastion. Getting a shell in a running task is
 * occasionally the only way to diagnose something, and the alternative — an
 * SSH host in a public subnet, with a key somebody has to hold — is a standing
 * piece of attack surface in exchange for a capability used twice a year.
 * Every session is authorised by IAM and logged in CloudTrail.
 */
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task_exec_channel" {
  statement {
    sid = "ECSExecSSMChannel"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_channel" {
  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_channel.json
}

# --- GitHub Actions OIDC ----------------------------------------------------

/**
 * The identity provider, once per account.
 *
 * This is what replaces a long-lived access key. GitHub signs a short-lived
 * token describing the repository, ref and workflow that asked for it; the
 * trust policies below decide whether to honour it. There is no credential in
 * the repository to leak, to rotate, or to forget to rotate.
 *
 * The thumbprint list is deliberately absent: AWS has verified this provider's
 * certificate chain against its own trust store since mid-2023, and a pinned
 * thumbprint is a value that silently expires and takes every deployment with
 * it on the day GitHub rotates a certificate.
 */
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = []
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    /**
     * The `sub` condition is the whole security boundary. Without it, any
     * workflow in any repository on GitHub could assume this role — the
     * provider vouches that the token came from GitHub Actions, not that it
     * came from *this* repository.
     */
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:ref:refs/heads/${var.deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  description        = "Assumed by .github/workflows/deploy.yml over OIDC"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
  # An hour is longer than any release takes, and a session that outlives the
  # job that created it is a credential nobody is watching.
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid = "EcrLogin"
    # GetAuthorizationToken is account-wide by definition: it authorises the
    # registry, not a repository within it.
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [
      aws_ecr_repository.api.arn,
      aws_ecr_repository.web.arn,
    ]
  }

  statement {
    sid = "ReadAndRegisterTaskDefinitions"
    actions = [
      "ecs:DescribeTaskDefinition",
      # RegisterTaskDefinition takes no resource: a revision does not exist
      # until it is registered, so there is nothing to name.
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid = "DeployAndMigrate"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
      "ecs:RunTask",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
    ]
    resources = ["*"]

    # Scoped to this cluster, so the role cannot restart or run tasks in another
    # environment that happens to live in the same account.
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  /**
   * Registering a task definition means naming the roles the task will run as,
   * and naming a role is a form of using it. Without the service condition this
   * statement would let the workflow pass any role it can name to any service —
   * the classic privilege-escalation path out of a deployment role.
   */
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn, aws_iam_role.task.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# --- Terraform in CI --------------------------------------------------------

/**
 * `terraform plan` on a pull request needs to read every resource it manages
 * and change none of them, so the plan role is read-only and assumable from any
 * branch of this repository. Restricting it to `main` would defeat the point:
 * the plan exists to be read before a merge.
 *
 * ReadOnlyAccess does not include reading secret *values*, which is correct —
 * Terraform tracks the secrets it created in state, and a plan role that could
 * read production credentials would be a far larger grant than a plan needs.
 */
data "aws_iam_policy_document" "github_terraform_plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.repository}:*"]
    }
  }
}

resource "aws_iam_role" "github_terraform_plan" {
  name                 = "${local.name}-github-terraform-plan"
  description          = "Assumed by .github/workflows/infra.yml to run terraform plan"
  assume_role_policy   = data.aws_iam_policy_document.github_terraform_plan_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "github_terraform_plan" {
  role       = aws_iam_role.github_terraform_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

/**
 * The state bucket is not part of ReadOnlyAccess in any useful sense: a plan
 * has to read the state object, and with S3 native locking it also writes and
 * deletes a lock file beside it. Those two objects, and nothing else.
 */
data "aws_iam_policy_document" "github_terraform_plan_state" {
  statement {
    sid       = "ReadState"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/${var.state_key}"]
  }

  statement {
    sid       = "HoldTheLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.state_bucket}/${var.state_key}.tflock"]
  }

  statement {
    sid       = "ListForVersioning"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket}"]
  }
}

resource "aws_iam_role_policy" "github_terraform_plan_state" {
  name   = "terraform-state"
  role   = aws_iam_role.github_terraform_plan.id
  policy = data.aws_iam_policy_document.github_terraform_plan_state.json
}

/**
 * There is deliberately no `terraform apply` role declared here.
 *
 * Applying this configuration means creating IAM roles and attaching policies
 * to them, which is indistinguishable from administrator access: a role that
 * can do it can grant itself anything. Declaring such a role in the very
 * configuration it applies is a loop with an account takeover in the middle of
 * it — and it would sit in this file looking exactly like the read-only role
 * above, which is how a reviewer misses it.
 *
 * The apply role is therefore provisioned out of band, by whoever owns the
 * account, and named to the workflow as the AWS_TERRAFORM_APPLY_ROLE_ARN
 * secret. `.github/workflows/infra.yml` can then apply, but only when somebody
 * dispatches the workflow with `apply: true` and the `infrastructure`
 * environment's reviewers approve the run — and because the secret resolves
 * from that environment, an unapproved run cannot read the credential at all.
 * The approval unlocks the role; it does not merely unpause the job.
 */
