import { describe, it, expect } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/app.js";
import { ROUTE_REGISTRY } from "../../src/platform/route.js";

describe("openapi.json", () => {
  it("is a 3.1 document that names every public route and no internal one", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info.title).toBe("Plutus");
    const documented = Object.entries(res.body.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
    for (const r of ROUTE_REGISTRY) {
      const line = `${r.method.toUpperCase()} ${r.path}`;
      if (r.path.startsWith("/internal")) expect(documented).not.toContain(line);
      else expect(documented).toContain(line);
    }
    const transfer = res.body.paths["/v1/ledgers/{id}/transfers"].post;
    expect(transfer.requestBody.content["application/json"].schema.properties.legs.items.properties.amount.type).toBe("string");
    expect(transfer.responses["409"]).toBeDefined();
    expect(transfer.security).toEqual([{ bearer: [] }]);
    expect(res.body.components.securitySchemes.bearer.scheme).toBe("bearer");
  });
  it("renders the reference page", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi.json");
  });
});
