locals {
  /**
   * Ports the two images actually listen on.
   *
   * The API's is its own default (`PORT`, 4000). The client's is 8080 because
   * its image is `nginx-unprivileged`, which runs as UID 101 and therefore
   * cannot bind a privileged port — that is what makes "do not run as root"
   * work without rewriting nginx's pid and temp paths by hand.
   */
  api_port = 4000
  web_port = 8080

  application_url = "https://${var.domain_name}"

  /**
   * The client and the API are served from one hostname, with the load balancer
   * splitting them by path. That is not only tidier than two hostnames — it
   * makes every request same-origin, so the refresh cookie needs no cross-site
   * relaxation and CORS never enters the picture in production.
   *
   * `CORS_ORIGINS` is still set, because the API validates it at startup and
   * because the Socket.IO handshake checks the origin regardless of whether the
   * browser would have enforced it.
   */
  cors_origins = local.application_url

  # Paths that belong to the API rather than to the single-page client. Both are
  # needed: /socket.io is where the realtime stream lives, and it is not under
  # the /api prefix because it is not a JSON endpoint.
  api_path_patterns = ["/api", "/api/*", "/socket.io", "/socket.io/*"]
}
