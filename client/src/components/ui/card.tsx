import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Sanctioned side-accent stripe (audit P2-14): the ONE way to give a Card a
 * colored left border. Replaces the copy-pasted `border-l-*` accents.
 * Colors are tokens only — `primary` for brand emphasis, status tones per
 * the `--status-*` usage rule in index.css (red only for actionable-now).
 */
export type CardAccent = "primary" | "ok" | "warn" | "critical" | "info"

const cardAccentClasses: Record<CardAccent, string> = {
  primary: "border-l-primary",
  ok: "border-l-status-ok",
  warn: "border-l-status-warn",
  critical: "border-l-status-critical",
  info: "border-l-status-info",
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Side-accent stripe; see `CardAccent`. */
  accent?: CardAccent
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, accent, ...props }, ref) => (
    <div
      ref={ref}
      data-accent={accent}
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow",
        accent && "border-l-[3px]",
        accent && cardAccentClasses[accent],
        className
      )}
      {...props}
    />
  )
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
