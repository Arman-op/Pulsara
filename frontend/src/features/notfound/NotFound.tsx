import { Link } from 'react-router-dom';

/**
 * Terminal route.
 *
 * The router previously had no catch-all, so a mistyped URL rendered the
 * authenticated layout with an empty content area — indistinguishable from a
 * page that had failed to load.
 */
export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 text-center">
      <p className="text-5xl font-bold text-accent tabular-nums-metric">404</p>
      <h1 className="text-lg font-semibold text-white">This page does not exist</h1>
      <p className="text-sm text-muted max-w-sm">
        The address may be mistyped, or the page may have been removed.
      </p>
      <Link
        to="/"
        className="mt-2 text-sm px-4 py-2 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
      >
        Back to the dashboard
      </Link>
    </div>
  );
}
