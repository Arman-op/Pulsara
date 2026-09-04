import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * The boundary around the routed content.
 *
 * It is scoped to the content area rather than the whole app on purpose: a
 * screen that throws should leave the navigation standing, so somebody can go
 * somewhere else instead of reloading and hoping. Without one, a single render
 * error blanks the page — the failure that produces "the dashboard is broken"
 * with nothing else to go on.
 */

/**
 * Throws until the test says otherwise.
 *
 * Deliberately not self-clearing: React re-renders a subtree once after a
 * boundary catches, and a component that stops throwing on its own succeeds on
 * that retry — so the boundary concludes nothing was wrong and renders the
 * children. The flag has to be owned by the test.
 */
let shouldThrow = true;

function Thrower() {
  if (shouldThrow) throw new Error('the chart could not render');
  return <p>Recovered content</p>;
}

beforeEach(() => {
  shouldThrow = true;
  /**
   * React logs a component stack for every caught throw. It is expected here,
   * and left unmocked it buries the rest of the run's output.
   */
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing goes wrong', () => {
    render(
      <ErrorBoundary>
        <p>Ordinary content</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('Ordinary content')).toBeInTheDocument();
  });

  it('catches a render error rather than taking the page down', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('Recovered content')).not.toBeInTheDocument();
  });

  it('says what failed, and that the rest of the app has not', () => {
    // "Something went wrong" alone tells a user nothing they can act on or
    // report.
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText('the chart could not render')).toBeInTheDocument();
    expect(screen.getByText(/rest of the application is still running/)).toBeInTheDocument();
  });

  it('records the failure where an error reporter can see it', () => {
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(console.error).toHaveBeenCalledWith(
      'Unhandled render error',
      expect.any(Error),
      expect.anything(),
    );
  });

  it('offers a retry that works when the cause has passed', async () => {
    // A dead end is what makes people reload the whole application.
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Whatever caused it has passed.
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });
});
