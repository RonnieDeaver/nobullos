import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import {
  isChunkLoadError,
  canAutoReload,
  markAutoReloaded,
} from "@/lib/chunkLoadError";
import { BrandMark } from "@/components/kit/BrandMark";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  isAutoReloading: boolean;
}

export class GlobalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, isAutoReloading: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, isAutoReloading: false };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    if (isChunkLoadError(error) && canAutoReload()) {
      markAutoReloaded();
      this.setState({ isAutoReloading: true });
      window.location.reload();
      return;
    }
    console.error("[ErrorBoundary] Uncaught render error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null, isAutoReloading: false });
  };

  render() {
    if (this.state.isAutoReloading) {
      return null;
    }

    if (this.state.hasError) {
      return (
        <div
          data-testid="error-boundary-fallback"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
            fontFamily: "system-ui, -apple-system, sans-serif",
            backgroundColor: "hsl(var(--background))",
            color: "hsl(var(--foreground))",
          }}
        >
          <div style={{ textAlign: "center", maxWidth: "480px" }}>
            {/* Brand moment: black bull mark — neutral, never crimson on an
                error surface (accent rule). `width` attr sizes it even if
                stylesheets failed to load. Colors are inline styles reading
                the index.css tokens (hsl(var(--…))) so the crash surface
                follows light/dark mode — index.css is loaded even when React
                crashes, so the variables resolve. */}
            <div style={{ marginBottom: "1.25rem" }}>
              <BrandMark kind="icon" variant="black" darkVariant="white" width={56} />
            </div>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Something went wrong
            </h1>
            <p style={{ color: "hsl(var(--muted-foreground))", marginBottom: "1.5rem", lineHeight: 1.5 }}>
              An unexpected error occurred. Please try again or reload the page.
            </p>
            {this.state.error && (
              <p
                data-testid="error-boundary-message"
                style={{
                  fontSize: "0.8rem",
                  color: "hsl(var(--muted-foreground))",
                  backgroundColor: "hsl(var(--muted))",
                  padding: "0.75rem",
                  borderRadius: "6px",
                  marginBottom: "1.5rem",
                  wordBreak: "break-word",
                }}
              >
                {this.state.error.message}
              </p>
            )}
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
              <button
                data-testid="button-retry"
                onClick={this.handleRetry}
                style={{
                  padding: "0.6rem 1.5rem",
                  borderRadius: "6px",
                  border: "1px solid hsl(var(--border))",
                  backgroundColor: "hsl(var(--card))",
                  color: "hsl(var(--card-foreground))",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                }}
              >
                Try Again
              </button>
              <button
                data-testid="button-reload"
                onClick={this.handleReload}
                style={{
                  padding: "0.6rem 1.5rem",
                  borderRadius: "6px",
                  border: "none",
                  backgroundColor: "hsl(var(--primary))",
                  color: "hsl(var(--primary-foreground))",
                  cursor: "pointer",
                  fontSize: "0.9rem",
                }}
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
