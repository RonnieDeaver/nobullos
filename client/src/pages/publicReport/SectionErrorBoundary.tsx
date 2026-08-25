/**
 * SectionErrorBoundary — shared pieces of the public client report.
 * Extracted VERBATIM from client/src/pages/PublicReport.tsx (lines 25–63 @ d31d7c0c7, Task #4271).
 * Zero visual/behavioral change intended — do not edit alongside a move.
 */

import { ReactNode, Component, ErrorInfo } from "react";
import { AlertCircle } from "lucide-react";

export class SectionErrorBoundary extends Component<
  { children: ReactNode; sectionName: string; resetKey?: string },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode; sectionName: string; resetKey?: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[SectionErrorBoundary] Error in "${this.props.sectionName}":`, error, errorInfo);
  }

  componentDidUpdate(prevProps: { resetKey?: string }) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid={`section-error-${this.props.sectionName}`}
          className="bg-report-critical/10 border border-report-critical/30 rounded-xl p-8 text-center my-4"
        >
          <AlertCircle className="w-8 h-8 text-report-crimson-bright mx-auto mb-4" />
          {/* h2, not h3: the fallback stands in for an entire slide (whose
              title is an h2), keeping the outline monotonic (Task #4286). */}
          {/* Task #4287 — never surface raw Error.message to clients: runtime
              error text is internal vocabulary (componentDidCatch already
              logs the real error for operators). */}
          <h2 className="text-lg font-semibold text-report-critical mb-1">Section unavailable</h2>
          <p className="text-sm text-report-critical">This section couldn't be displayed. The rest of the report is unaffected.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
