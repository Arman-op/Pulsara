# Infrastructure

Terraform for the AWS account Pulsara runs in: a VPC across two availability
zones, an ECS Fargate cluster with the API and the client on it, an Application
Load Balancer terminating HTTPS, RDS PostgreSQL and ElastiCache Redis in private
subnets, ECR repositories for both images, and the Secrets Manager entries the
tasks read at start-up.

> **Not verified.** None of this has ever been applied. It formats, initialises
> and validates — those run in CI on every pull request that touches this
> directory — but no `terraform apply` has run against a real account, because
> this repository has none. Read it as a reviewable design, not as a description
> of something running.

---

## The shape of it

```
                        Route 53  ─────►  ALB  (:443, ACM certificate)
                                            │
                            ┌───────────────┴───────────────┐
                  /api/*, /socket.io/*                  everything else
                            │                               │
                    ┌───────▼────────┐             ┌────────▼───────┐
                    │  api service   │             │  web service   │
                    │  Fargate, :4000│             │ Fargate, :8080 │
                    └───┬────────┬───┘             └────────────────┘
                        │        │                    private subnets
              ┌─────────▼──┐  ┌──▼─────────────┐
              │ RDS Postgres│ │ ElastiCache    │
              │  private    │ │ Redis, private │
              └─────────────┘ └────────────────┘
```

Public subnets hold exactly one thing: the load balancer. Every task, the
database and the cache sit in private subnets with no inbound route from the
internet, so the reachable surface of the whole deployment is two ports on the
ALB. There is no bastion — the one thing that ever needs to run SQL from
outside a request, `prisma migrate deploy`, runs as a one-off ECS task on the
API's own security group, and a shell in a running task is ECS Exec rather than
SSH.

Both halves are served from **one hostname**, split by path. That is what
removes cross-site cookies and CORS from production: the refresh cookie is
first-party, so it needs no `SameSite=None`, and browsers tightening
third-party cookie behaviour get no say in whether sessions survive.

| File | What it holds |
| :--- | :--- |
| `network.tf` | VPC, subnets, NAT, route tables, VPC endpoints |
| `security-groups.tf` | Every rule, written against security groups rather than CIDRs |
| `alb.tf` | Load balancer, target groups, listeners, the `/api` and `/socket.io` rule |
| `dns.tf` | ACM certificate, DNS validation, alias records |
| `ecs.tf` | Cluster and the two service instantiations |
| `modules/ecs-service` | Log group, task definition, service, autoscaling — once, used twice |
| `database.tf` | RDS PostgreSQL |
| `cache.tf` | ElastiCache Redis |
| `ecr.tf` | Both repositories and their lifecycle policies |
| `secrets.tf` | Secrets Manager entries and the injection list |
| `iam.tf` | Task roles, the GitHub OIDC provider, and the deploy and plan roles |
| `outputs.tf` | Everything the release workflow needs, in the shape it needs it |

---

## Standing it up

### 1. A bucket for the state

The backend block is a partial configuration on purpose: naming a bucket in
tracked code hard-codes one account's infrastructure into a public repository.
Create the bucket first, by hand, with versioning and encryption on:

```bash
aws s3api create-bucket --bucket pulsara-tfstate-<account-id> --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1
aws s3api put-bucket-versioning --bucket pulsara-tfstate-<account-id> \
  --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket pulsara-tfstate-<account-id> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

The state is sensitive: it holds the generated database password and both JWT
signing keys in clear text. That is a property of Terraform rather than of this
configuration, and the answer is to treat read access to the bucket as
equivalent to `secretsmanager:GetSecretValue` on production.

### 2. A hosted zone that resolves

`route53_zone_id` must already be delegated by whoever sells the domain.
Terraform adds the certificate-validation and alias records to it; it does not
create the zone, and it cannot make a registrar point at one.

### 3. Apply

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill in the four values
terraform init \
  -backend-config="bucket=pulsara-tfstate-<account-id>" \
  -backend-config="key=production/terraform.tfstate" \
  -backend-config="region=eu-west-1" \
  -backend-config="use_lockfile=true"
terraform apply
```

The first apply takes a while — RDS and ElastiCache are most of it — and the
two ECS services will not reach steady state, because the image tags they name
do not exist yet. That is expected: the first release creates them.

### 4. Put the third-party secrets in

Terraform creates two secrets **empty** and does not manage their values:

```bash
aws secretsmanager put-secret-value --secret-id pulsara-production/firebase \
  --secret-string file://firebase.json     # project_id, client_email, private_key

aws secretsmanager put-secret-value --secret-id pulsara-production/github-app \
  --secret-string file://github-app.json   # app_id, private_key, webhook_secret
```

They are empty because a value that passes through Terraform is a value in the
state file and in every plan that ever touched it — and these are issued by
somebody else and identify this deployment to a third party. Once a value is
in, set `enable_firebase_auth` / `enable_github_integration` to `true` and apply
again; until then the task definition does not reference them, because a task
referencing an empty secret fails to start with an error about the secret
rather than about the deployment.

### 5. Hand the release workflow its names

`.github/workflows/deploy.yml` addresses this infrastructure by name — cluster,
service, task family, container, subnets, security groups — and every one of
those names is decided here. They are an output rather than something to copy
by hand:

```bash
terraform output -json github_actions_variables |
  jq -r 'to_entries[] | "gh variable set \(.key) --body \"\(.value)\""'
```

and the two role ARNs it declares:

```bash
terraform output -raw github_deploy_role_arn          # -> AWS_DEPLOY_ROLE_ARN secret
terraform output -raw github_terraform_plan_role_arn  # -> AWS_TERRAFORM_PLAN_ROLE_ARN secret
```

The third — `AWS_TERRAFORM_APPLY_ROLE_ARN`, on the `infrastructure` environment
— is not among them, deliberately. See below.

---

## What CI does with this directory

`.github/workflows/infra.yml` runs on pull requests that touch `infra/`:

| Job | What it does |
| :--- | :--- |
| Format and validate | `terraform fmt -check`, `init -backend=false`, `validate` — no credentials, so a fork's pull request still gets checked |
| Plan | Assumes a read-only role over OIDC and writes the plan to the job summary |
| Apply | Only on a manual dispatch with `apply: true`, and only after the `infrastructure` environment's reviewers approve |

**Nothing applies on its own.** No push, no merge and no schedule reaches the
apply job: it needs a person to dispatch the workflow asking for it, and then a
reviewer to approve the run. Because the role ARN is a secret on that
environment, an unapproved run cannot even read the credential — the approval
unlocks the role rather than merely unpausing the job.

That role is **not** declared in `iam.tf`. Applying this configuration creates
IAM roles and attaches policies to them, which is indistinguishable from
administrator access, and declaring the role inside the configuration it
applies is a loop with an account takeover in the middle of it. Provision it out
of band, and name it to the workflow as `AWS_TERRAFORM_APPLY_ROLE_ARN`.

The plan is not saved with `-out`, and the apply job re-plans rather than
replaying a saved one. A plan file contains the resource attributes the state
does, including the generated database password; the rendered text redacts them
because Terraform marks them sensitive, and the binary file does not. Uploading
one as an artifact would make production credentials downloadable by anybody who
can read the run, while looking like an ordinary convenience.

---

## Decisions with a price attached

Rough monthly figures for `eu-west-1`, at the defaults. They are order-of-
magnitude, not a quote.

| Choice | Default | The tradeoff |
| :--- | :--- | :--- |
| `single_nat_gateway` | `true` | One gateway instead of one per zone saves about **$33/month per zone**. The cost is that a zone failure removes outbound internet access for every private subnet — image pulls, Secrets Manager, the GitHub API. In-VPC traffic is unaffected, so the database and cache stay reachable. |
| `db_multi_az` | `false` | Multi-AZ roughly **doubles the instance bill** and buys automatic failover in one to two minutes with no data loss. Single-AZ still has automated backups and point-in-time recovery — the loss is not the data, it is the tens of minutes it takes to restore a snapshot into a new instance. |
| `redis_replica_count` | `1` | A replica in the second zone enables automatic failover and roughly **doubles the cache bill**. Nothing in Redis is a record of anything: losing it costs a cold cache and a missed probe sweep. Zero is defensible. |
| Fargate, not FARGATE_SPOT | — | Spot is about **70% cheaper** and can be reclaimed on two minutes' notice. Fine for the stateless client; wrong for an API holding WebSocket sessions, since a reclaim drops every connected dashboard. |
| `X86_64`, not ARM64 | — | Graviton is about **20% cheaper** for the same task size. It needs a cross-compiled image, so it is a change to the build rather than a value to flip here. |
| Interface VPC endpoints | on | Four endpoints at roughly **$7/month each**, against NAT data-processing charges on every image pull, log shipment and secret read. Roughly break-even at low volume and clearly worth it above; the security argument — credentials never traversing a public-subnet hop — is the reason regardless. |

The defaults are chosen for a portfolio deployment: cheap, honest about it, and
one variable away from the answer a system with a pager rota would need.

---

## Two things Terraform deliberately does not own

`aws_ecs_service` ignores changes to `task_definition` and `desired_count`.

The release workflow registers a new task-definition revision per commit, and
the autoscaling policy sets the running count. Without those two lines, the next
`terraform apply` — triggered by something entirely unrelated — would roll
production back to whatever image tag `api_image_tag` happens to name, and reset
a scaled-out fleet to its minimum. Declaring who owns a field is what stops two
systems fighting over it.
