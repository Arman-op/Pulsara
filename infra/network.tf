/**
 * The VPC, and the reason everything else can be private.
 *
 * Public subnets hold exactly one thing: the load balancer. Every task, the
 * database and the cache sit in private subnets with no route from the
 * internet, so the only reachable surface is the two ports on the ALB.
 */

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  /**
   * Public subnets are /24s carved out of the first /20; private subnets are
   * whole /20s after it. The asymmetry is deliberate — a public subnet holds
   * load-balancer and NAT interfaces and will never need more than a handful of
   * addresses, while every Fargate task takes an address in a private one, and
   * running out of them during a scale-out is a failure that looks like a
   * scheduling bug.
   */
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 1)]

  nat_gateway_count = var.single_nat_gateway ? 1 : var.az_count
}

resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr

  # Both are required for the RDS and ElastiCache endpoint names to resolve
  # inside the VPC, which is how the API reaches them.
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = local.name }
}

# --- Subnets ----------------------------------------------------------------

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = local.public_subnet_cidrs[count.index]

  # The ALB needs a public address; nothing else is placed here.
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.name}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = local.private_subnet_cidrs[count.index]

  tags = {
    Name = "${local.name}-private-${local.azs[count.index]}"
    Tier = "private"
  }
}

# --- Egress -----------------------------------------------------------------

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  tags = { Name = "${local.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  # Without this the gateway can be created before the VPC has a route out,
  # which fails in a way that reads like a quota problem.
  depends_on = [aws_internet_gateway.this]

  tags = { Name = "${local.name}-${count.index}" }
}

# --- Routing ----------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

/**
 * One route table per private subnet even when they share a NAT gateway. It
 * costs nothing, and it means switching `single_nat_gateway` to false is a
 * change of one route target per table rather than a re-association of every
 * subnet — the difference between a rolling change and a brief loss of egress.
 */
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
  }

  tags = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

/**
 * Secrets Manager over a VPC endpoint rather than through the NAT gateway.
 *
 * Every task start reads the database URL and the signing keys, and routing
 * that through a NAT gateway means the credentials traverse a public-subnet
 * hop and are billed per gigabyte. An interface endpoint keeps the call inside
 * the VPC. The same applies to ECR and to the CloudWatch Logs endpoint, which
 * together account for nearly all of a Fargate task's outbound traffic.
 */
locals {
  interface_endpoints = toset([
    "secretsmanager",
    "ecr.api",
    "ecr.dkr",
    "logs",
  ])
}

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.name}-vpc-endpoints"
  description = "Accepts HTTPS from inside the VPC for interface endpoints"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${local.name}-vpc-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "vpc_endpoints_https" {
  security_group_id = aws_security_group.vpc_endpoints.id
  description       = "HTTPS from anything inside the VPC"

  cidr_ipv4   = aws_vpc.this.cidr_block
  from_port   = 443
  to_port     = 443
  ip_protocol = "tcp"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${local.name}-${each.value}" }
}

/**
 * ECR stores layers in S3, so pulling an image needs S3 as well as the two ECR
 * endpoints above. A gateway endpoint is free, unlike an interface one, and is
 * attached to route tables rather than to subnets.
 */
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = { Name = "${local.name}-s3" }
}
