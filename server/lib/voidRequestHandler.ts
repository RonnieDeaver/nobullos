import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Task #3821 — adapt a Promise-returning middleware to a void-returning
 * Express `RequestHandler` (satisfies `no-misused-promises` where an Opts
 * type declares `RequestHandler`) WITHOUT dropping rejections: any rejection
 * is routed to `next`, so it reaches Express error handling instead of
 * becoming an unhandled promise rejection. Use this instead of a bare
 * `void fn(req, res, next)` adapter.
 */
export function toVoidRequestHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
