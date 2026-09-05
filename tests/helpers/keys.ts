import type { Express } from "express";
import request from "supertest";

export async function mintKey(app: Express): Promise<{ id: string; secret: string }> {
  const res = await request(app).post("/v1/keys").send();
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, secret: res.body.secret };
}
export const bearer = (secret: string): Record<string, string> => ({ Authorization: `Bearer ${secret}` });
