/**
 * The last line of defence. React unmounts the entire tree when a render throws
 * and nothing catches it, so one bad timestamp in one chip label used to leave
 * the operator staring at a white page with no way back. Everything the design
 * system renders a *caller's* code inside — table cells, chip labels, widgets,
 * demo sections — sits behind one of these instead.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './controls';
import { ErrorState } from './feedback';
import { Icons } from './icons';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Full control over what replaces the subtree. `reset` re-mounts it. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Heading of the default fallback. */
  title?: ReactNode;
  /** Body of the default fallback. Say what the operator can still do. */
  message?: ReactNode;
  /** Label on the default fallback's recovery button. */
  retryLabel?: string;
  /** Runs before the subtree re-mounts — clear the state that caused it. */
  onReset?: () => void;
  /** Every caught error, for logging. Called during the commit phase. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * Any change clears the error and re-mounts the subtree. Pass the state the
   * failure depended on — a filter stack, a row id — so navigating away from a
   * bad view recovers on its own without the operator pressing anything.
   */
  resetKeys?: readonly unknown[];
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on every reset so the subtree remounts rather than re-throwing. */
  generation: number;
}

const changed = (a: readonly unknown[] = [], b: readonly unknown[] = []): boolean =>
  a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Keep the stack in the console even when a fallback hides the failure, so
    // the bug is still findable in a bug report or a session recording.
    console.error('[ain] a component tree failed to render', error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && changed(previous.resetKeys, this.props.resetKeys)) this.reset();
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  override render(): ReactNode {
    const { error } = this.state;
    // A keyed Fragment re-mounts the subtree on reset without putting a wrapper
    // element inside a <table> or a flex row.
    if (!error) return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <ErrorState
        className={this.props.className}
        title={this.props.title ?? 'This section stopped rendering'}
        message={this.props.message ?? 'Nothing was lost — the rest of the page is still live. Try again, and if it keeps failing, quote the message below.'}
        code={error.message || error.name}
        action={
          <Button variant="secondary" iconLeft={<Icons.refresh size={14} />} onClick={this.reset}>
            {this.props.retryLabel ?? 'Try again'}
          </Button>
        }
      />
    );
  }
}
