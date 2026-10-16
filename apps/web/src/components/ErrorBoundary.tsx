import { Component, type ReactNode } from "react";
import { copy } from "../copy";
import { ErrorState } from "./States";

interface Props {
  children: ReactNode;
  /**
   * A failure is cleared when this changes, such as the route's path and search, so moving on starts afresh. Unlike a
   * React `key`, a change does not remount the children, so a page keeps its state when only a parameter in the path
   * changes.
   */
  resetKey?: string;
}

interface State {
  failed: boolean;
  resetKey: string | undefined;
}

/**
 * Catches a render failure below it and shows the house message in its place, so the header and menu stay usable.
 * The raw error is never shown. Give it the route as `resetKey` so moving on clears a failure.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <ErrorState error={null} message={copy.common.pageFailed} onRetry={() => this.setState({ failed: false })} />;
  }
}
