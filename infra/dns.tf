/**
 * The certificate and the record that points at the load balancer.
 *
 * The hosted zone is an input rather than something created here. A zone is
 * only useful once the registrar delegates to its name servers, and that is a
 * manual step at whoever sells the domain — creating the zone in Terraform
 * would produce a resource that looks finished and resolves nowhere.
 */

resource "aws_acm_certificate" "this" {
  domain_name = var.domain_name
  # DNS validation rather than email: it renews without anybody clicking a link
  # in a mailbox that may no longer be read.
  validation_method = "DNS"

  lifecycle {
    # A certificate cannot be modified in place, and it cannot be deleted while
    # a listener references it. Without this, any change deadlocks the apply.
    create_before_destroy = true
  }

  tags = { Name = var.domain_name }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.this.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60

  # The validation record is owned by ACM's requirements, not by history: if a
  # certificate is reissued and the record changes, overwrite rather than fail.
  allow_overwrite = true
}

/**
 * Not a resource so much as a wait. It blocks until ACM has seen the records
 * above and issued the certificate, which is what stops the HTTPS listener
 * being created against a certificate still in PENDING_VALIDATION.
 */
resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

/**
 * Alias records, not CNAMEs. An alias resolves to the load balancer's addresses
 * at query time with no extra lookup and no charge, and — unlike a CNAME — it
 * is legal at a zone apex, so this works whether the application is at
 * `pulsara.example.com` or at `example.com` itself.
 */
resource "aws_route53_record" "ipv4" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "ipv6" {
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
