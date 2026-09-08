/**
 * ElastiCache for Redis, on the same pattern as the database: private subnets,
 * one security group, nothing else may connect.
 *
 * Two things use it — the probe queue, which makes the sweep singular across
 * replicas instead of multiplying probes by replica count, and the read cache
 * in front of the two endpoints that cost real work. Neither holds a record of
 * anything, which is what makes the eviction policy below safe.
 */

resource "aws_elasticache_subnet_group" "this" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = local.name }
}

resource "aws_elasticache_parameter_group" "this" {
  # A fixed name rather than a prefix: ElastiCache parameter groups do not
  # support name_prefix, and every parameter set here is one Redis applies
  # without a restart, so there is nothing a replacement would buy.
  name   = "${local.name}-redis7"
  family = "redis7"

  /**
   * Bounded and evicting. Everything stored here is a cache entry or a queued
   * job, so discarding the least recently used one is always preferable to the
   * alternative — an unbounded Redis that fills up starts refusing writes, and
   * that would take the probe queue down with it.
   */
  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }
}

/**
 * ElastiCache accepts an auth token of 16-128 printable characters and rejects
 * several punctuation marks outright, so the character set is narrowed rather
 * than left to the default.
 */
resource "random_password" "redis_auth" {
  length           = 64
  special          = true
  override_special = "!&#$^<>-"
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.name
  description          = "${local.name} probe queue and read cache"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  parameter_group_name = aws_elasticache_parameter_group.this.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.cache.id]

  # One primary plus however many replicas were asked for. Automatic failover
  # needs at least one, and AWS rejects the combination if it does not have one.
  num_cache_clusters         = var.redis_replica_count + 1
  automatic_failover_enabled = var.redis_replica_count > 0
  multi_az_enabled           = var.redis_replica_count > 0

  /**
   * Encryption in transit is what makes the auth token meaningful: without TLS
   * the token crosses the network in clear text on every connection, and an
   * attacker who can read that has the credential itself. It is also why the
   * connection string uses `rediss://` rather than `redis://` — the API's
   * environment schema accepts both, and the scheme is what tells ioredis to
   * negotiate TLS.
   */
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  # Applied on the next maintenance window rather than immediately, so a
  # parameter change does not restart the cache in the middle of a weekday.
  apply_immediately  = false
  maintenance_window = "sun:04:30-sun:05:30"

  # A cache is rebuildable by definition; a nightly snapshot of it is storage
  # billed for something nobody will ever restore.
  snapshot_retention_limit = 0

  tags = { Name = local.name }
}
