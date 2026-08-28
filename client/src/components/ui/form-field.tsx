/**
 * Task #4346 — FormField: the standard wrapper for a labeled form control
 * with INLINE validation (audit P1-8, §8.3).
 *
 * The standard it codifies (from the ClientAdd / ReportForm pattern):
 *   - Field validation renders INLINE, under the control, in destructive
 *     token color — never as a toast.
 *   - Toasts are reserved for async side-effect results (save failed,
 *     background job finished). The global query-client handler owns that
 *     copy (client/src/lib/queryErrorCopy.ts).
 *
 * Usage doc: client/src/components/ui/form-field.md
 */
import * as React from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FormFieldRenderContext {
  /** id the control must carry (mirrors `htmlFor`). */
  fieldId?: string;
  /** id of the rendered error element, when an error is showing. */
  errorId?: string;
  /** id of the rendered helper element, when helper text is present. */
  helperId?: string;
  /** True while an error is showing — mirror into aria-invalid. */
  invalid: boolean;
  /** Space-joined ids for aria-describedby (helper + error). */
  describedBy?: string;
}

export interface FormFieldProps {
  /** Visible label text. */
  label: React.ReactNode;
  /** id of the control; also derives error/helper element ids. */
  htmlFor?: string;
  /** Renders a destructive-colored asterisk after the label. */
  required?: boolean;
  /**
   * Inline validation error. Falsy = valid (nothing rendered). Set this from
   * submit-time or change-time validation — never toast field validation.
   */
  error?: React.ReactNode;
  /** Muted helper text rendered between control and error. */
  helper?: React.ReactNode;
  className?: string;
  labelClassName?: string;
  /** data-testid for the error element; defaults to `error-${htmlFor}`. */
  errorTestId?: string;
  /**
   * The control. A single React element gets id / aria-invalid /
   * aria-describedby wired automatically; pass a render function to wire
   * composite controls (e.g. Radix Select) yourself.
   */
  children: React.ReactNode | ((ctx: FormFieldRenderContext) => React.ReactNode);
}

function mergeDescribedBy(existing: unknown, added?: string): string | undefined {
  const parts = [typeof existing === "string" ? existing : undefined, added].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function FormField({
  label,
  htmlFor,
  required,
  error,
  helper,
  className,
  labelClassName,
  errorTestId,
  children,
}: FormFieldProps) {
  const showError = Boolean(error);
  const errorId = htmlFor && showError ? `${htmlFor}-error` : undefined;
  const helperId = htmlFor && helper ? `${htmlFor}-helper` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  const ctx: FormFieldRenderContext = {
    fieldId: htmlFor,
    errorId,
    helperId,
    invalid: showError,
    describedBy,
  };

  let control: React.ReactNode;
  if (typeof children === "function") {
    control = children(ctx);
  } else if (React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>;
    control = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      id: (childProps.id as string | undefined) ?? htmlFor,
      "aria-invalid": showError ? true : (childProps["aria-invalid"] as boolean | undefined),
      "aria-describedby": mergeDescribedBy(childProps["aria-describedby"], describedBy),
    });
  } else {
    control = children;
  }

  return (
    <div className={cn("relative space-y-1.5", className)}>
      {/* `relative` gives an absolutely-positioned label (labelClassName=
          "sr-only") a containing block scoped to this field. Without it,
          the label's static position is computed against the nearest
          positioned ancestor — which can be many DOM levels up inside a
          wide, horizontally-scrollable table — pushing it hundreds of
          pixels past the viewport edge and inflating the page's real
          scrollWidth even though the label itself is invisible. */}
      <Label htmlFor={htmlFor} className={labelClassName}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            {" "}
            *
          </span>
        ) : null}
      </Label>
      {control}
      {helper ? (
        <p id={helperId} className="text-caption text-muted-foreground">
          {helper}
        </p>
      ) : null}
      {showError ? (
        <p
          id={errorId}
          role="alert"
          className="text-caption font-medium text-destructive"
          data-testid={errorTestId ?? (htmlFor ? `error-${htmlFor}` : undefined)}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
