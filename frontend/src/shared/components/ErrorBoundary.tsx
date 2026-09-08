import * as React from 'react';

/**
 * Catches render-time exceptions.
 *
 * Without one, a single component throwing unmounts the entire React tree and
 * leaves a blank white page — the failure mode that produces "the dashboard is
 * broken" with nothing else to go on. This keeps the shell alive and shows
 * something a user can act on.
 *
 * It must be a class: `componentDidCatch` and `getDerivedStateFromError` have
 * no hook equivalent.
 */

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Kept as console.error deliberately: this is the last chance to record the
    // failure, and it is where a browser error reporter hooks in.
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-xl border border-danger/30 bg-danger/5 p-6 space-y-3">
          <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
          <p className="text-sm text-muted">
            This screen failed to render. The rest of the application is still running.
          </p>
          <pre className="text-xs text-danger/90 whitespace-pre-wrap break-words bg-surface/60 rounded-md p-3 border border-border">
            {error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-sm px-3 py-1.5 rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
