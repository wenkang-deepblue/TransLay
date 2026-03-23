import type { Request, Response, NextFunction } from "express";

/**
 * I1: CORS middleware locked to production domain.
 * Portal and API are same-origin, so CORS is primarily defense-in-depth
 * against cross-origin form submissions and XHR from malicious sites.
 */
export function corsMiddleware(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    if (origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
