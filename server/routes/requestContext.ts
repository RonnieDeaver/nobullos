/**
 * Typed request contexts for high-risk mutating routes (Task #4155 / F9).
 *
 * The repo's Express convention is `(req: any, ...)` (~2.9k sites — an
 * accepted convention per audit R-05). These contexts do NOT change that
 * convention: they are opt-in types applied to a bounded, documented set of
 * high-risk mutating handlers (see audits/f9-typed-request-contexts-2026-08-10.md
 * for the selected-handler list and the criteria).
 *
 * Design constraints (from the F9 spec):
 *  - Reuse existing repo/platform types: express's own `Request<P, ResBody,
 *    ReqBody>` generics, the `@types/passport` (`req.user`) and
 *    `@types/multer` (`req.file`) global augmentations, and the
 *    `rawBody: unknown` `http.IncomingMessage` augmentation declared in
 *    server/boot/httpApp.ts.
 *  - No new framework, no handler wrappers, no conditional types — one plain
 *    generic per context.
 *  - Zero runtime footprint: this module is type-only and imports nothing at
 *    runtime, so it can never participate in an import cycle.
 *
 * WHEN EACH CONTEXT APPLIES
 *  - AuthenticatedRequest<P, TBody>: any handler behind `isAuthenticated`
 *    (usually plus a role gate from server/routes/middleware.ts). `req.user`
 *    carries the OIDC session user; actor ids come from
 *    `req.user?.claims?.sub` — never from the request body.
 *  - ValidatedBodyRequest<TBody, P>: authenticated handlers whose body is
 *    consumed only after a zod gate (`schema.parse/safeParse(req.body)`).
 *    `TBody` is the schema's `z.infer` type: the type documents the contract,
 *    zod enforces it at runtime. For handlers WITHOUT a zod gate, keep the
 *    default `unknown` body and narrow with an explicit field-typed cast at
 *    the single read site, preserving the existing runtime guards — adding
 *    new validation (new 400s) is out of F9 scope.
 *  - TenantScopedRequest<P, TBody>: authenticated handlers whose material
 *    params/body identify a tenant (client) or client-owned resource
 *    (`clientId`, `:id` of a client row, `locationId`, ...). Marker context:
 *    the values from the request are identifiers only — ownership and
 *    existence are still verified by server-side lookups, and audit/ownership
 *    columns are populated from trusted server context.
 *  - RawBodyWebhookRequest<TBody>: unauthenticated signed-webhook receivers
 *    (Front, Zoom). `rawBody` is inherited from the httpApp.ts augmentation
 *    as `unknown`; the boot-time `express.json` verify hook stores the exact
 *    request bytes as a `Buffer`. Consume it via a documented
 *    `as Buffer | undefined` narrow at the signature-verification call ONLY —
 *    never re-serialize `req.body` where raw bytes are available, and never
 *    change how an existing receiver obtains its signing input.
 *
 * Machine-token routes (`requireCeoToolsAuth`) and public token flows (ATS
 * candidate portal) have no session user: type those handlers with express's
 * plain `Request<P, unknown, TBody>` — a named context would only counterfeit
 * an authentication that is not there.
 */
import type { Request } from "express";
import type { ParamsDictionary } from "express-serve-static-core";

/**
 * OIDC claims replitAuth stores in the session. Source of truth:
 * `updateUserSession` in server/replit_integrations/auth/replitAuth.ts
 * (claims copied verbatim from the OIDC token). All fields optional — code
 * must tolerate partially-populated sessions.
 */
export interface SessionClaims {
  sub?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  profile_image_url?: string;
  exp?: number;
  /** Read by legacy call sites (e.g. work-queue actor labels). */
  metadata?: { username?: string };
}

/**
 * Session user shape produced by Replit OIDC auth (replitAuth.ts).
 * `id`/`username` are legacy fallbacks some handlers read
 * (`req.user?.claims?.sub ?? req.user?.id ?? "system"`); replitAuth does not
 * write them today — typed here so those fallbacks stay compile-checked.
 */
export interface SessionUser {
  claims?: SessionClaims;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  id?: string;
  username?: string;
}

/**
 * Session-authenticated request (behind `isAuthenticated`, usually plus a
 * role middleware). Body defaults to `unknown`: zod-validate or explicitly
 * narrow before use. `user` stays optional because middleware guarantees are
 * runtime-only; use optional chaining (or a targeted non-null assertion where
 * the original code already relied on presence).
 */
export interface AuthenticatedRequest<
  P extends ParamsDictionary = ParamsDictionary,
  TBody = unknown,
> extends Request<P, unknown, TBody> {
  user?: SessionUser;
}

/**
 * Authenticated request whose body is consumed only through a zod gate;
 * `TBody` = `z.infer<typeof schema>`. See module header for the
 * unvalidated-body convention.
 */
export type ValidatedBodyRequest<
  TBody,
  P extends ParamsDictionary = ParamsDictionary,
> = AuthenticatedRequest<P, TBody>;

/**
 * Authenticated request whose material params/body identify a tenant
 * (client) or client-owned resource. Identifiers only — ownership is
 * enforced server-side.
 */
export type TenantScopedRequest<
  P extends ParamsDictionary = ParamsDictionary,
  TBody = unknown,
> = AuthenticatedRequest<P, TBody>;

/**
 * Unauthenticated signed-webhook request (Front, Zoom). Signature
 * verification is the auth; `rawBody` (from the httpApp.ts verify hook) is
 * `unknown` globally and is narrowed `as Buffer | undefined` at the
 * verification call only. Byte-path rules in the module header.
 */
export interface RawBodyWebhookRequest<TBody = unknown>
  extends Request<ParamsDictionary, unknown, TBody> {}
