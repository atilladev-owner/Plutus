import type { RequestHandler } from "express";

/**
 * CORS is a locked spec decision (docs/superpowers/specs/2026-09-04-plutus-design.md
 * section 7): open for all origins, no credentials. Keys are secrets and do not belong in
 * browsers, so there is nothing here worth gating behind an allowlist or a cookie. Every
 * response carries Access-Control-Allow-Origin: *, and Access-Control-Allow-Credentials is
 * never set: the two together are what a browser would refuse to honour anyway, and never
 * setting the credentials header keeps that refusal from ever becoming a decision this
 * code has to get right per origin.
 *
 * Depends on nothing but express's own types, so it can sit directly after helmet in
 * src/app.ts with no risk of it or its dependents mattering to load order.
 */
export const cors: RequestHandler = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Plutus-Warning, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};
