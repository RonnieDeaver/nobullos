/**
 * Task #4266 — the ONE markdown renderer for roadmap initiative prose.
 *
 * Every surface that displays an initiative description renders through this
 * component (public /roadmap page, /roadmap/embed iframe, the report
 * "Product updates" block, and the admin dialog's preview) so card typography
 * stays consistent and the safety contract lives in one place:
 *
 *   - react-markdown + remark-gfm: bold / italic / strikethrough / lists /
 *     links — the exact set the admin toolbar writes;
 *   - raw HTML in the source is kept ESCAPED, never parsed (deliberately no
 *     rehype-raw — this is the XSS boundary for the unauthenticated public
 *     page and the third-party-embeddable iframe);
 *   - links open in a new tab with rel="noopener noreferrer nofollow", and
 *     react-markdown's default urlTransform neutralizes javascript: hrefs;
 *   - compact card-friendly typography: tight vertical margins with the
 *     first/last child flush, so a plain one-paragraph description occupies
 *     exactly the space the old <p> rendering did.
 *
 * Text color and size come from the caller via className (the surfaces vary:
 * slate on the public card, emerald on done cards, muted on report slides).
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function RoadmapMarkdown({
  source,
  className,
  testId,
}: {
  source: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      data-testid={testId}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="font-medium underline underline-offset-2 hover:opacity-75"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-black/[0.07] px-1 py-px font-mono text-[0.85em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-1 overflow-x-auto rounded bg-black/[0.05] p-2 [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
