import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const SAFE = /^[A-Za-z0-9._-]{8,128}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const given = req.header("x-request-id");
  const id = given && SAFE.test(given) ? given : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
};
