import * as React from 'react';

/**
 * Turns a render crash into a message rather than a black screen.
 *
 * Without this, one unexpected null anywhere in the tree unmounts everything
 * and the page goes silently blank — the same failure mode as a swallowed
 * database error, and just as hard to diagnose from outside. The error text is
 * shown on purpose: this dashboard is behind a token and read by the team that
 * can act on it.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[dashboard] render failed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
        <h1 className="text-lg font-semibold">The dashboard hit an error while drawing</h1>
        <p className="text-sm text-subtle">
          The data loaded; something in the page could not render it. That usually means the Worker
          and this app are on different versions.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-card p-4 text-xs text-bad">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="self-start rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Reload
        </button>
      </main>
    );
  }
}
