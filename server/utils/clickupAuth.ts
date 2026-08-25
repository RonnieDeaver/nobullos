/**
 * Tiny, zero-dependency helper for extracting the ClickUp user id from a
 * Replit Auth (passport OIDC) request.
 *
 * Replit Auth stores the user at req.user.claims.sub — NOT req.user.id.
 * Every ClickUp route must use this helper so the session shape is handled
 * in exactly one place.
 */
export function getClickUpUserId(req: any): string | undefined {
  return req.user?.claims?.sub;
}
