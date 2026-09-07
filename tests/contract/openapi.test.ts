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
  it("documents every exchange route, the stream path item, and the signed security scheme", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    const documented = Object.entries(res.body.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
    const exchangeRoutes = ROUTE_REGISTRY.filter((r) => r.path.startsWith("/v1/exchange"));
    expect(exchangeRoutes.length).toBeGreaterThan(0);
    for (const r of exchangeRoutes) {
      expect(documented).toContain(`${r.method.toUpperCase()} ${r.path}`);
    }
    // The stream carries no defineRoute entry (it never goes through mountRoutes), so it
    // never reaches ROUTE_REGISTRY; docs.ts merges its hand written path item in by hand
    // instead, and this is the only assertion in the suite that proves it actually lands.
    expect(res.body.paths["/v1/exchange/stream"]).toBeDefined();
    expect(res.body.paths["/v1/exchange/stream"].get).toBeDefined();
    expect(res.body.paths["/v1/exchange/stream"].get.tags).toContain("Exchange");
    const placeOrder = res.body.paths["/v1/exchange/orders"].post;
    expect(placeOrder.security).toEqual([{ signed: [] }]);
    expect(placeOrder.responses["401"]).toBeDefined();
    expect(res.body.components.securitySchemes.signed.type).toBe("apiKey");
    expect(res.body.tags.map((t: { name: string }) => t.name)).toContain("Exchange");
  });
  it("renders the reference page", async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get("/docs");
    expect(res.status).toBe(200);
    expect(res.text).toContain("openapi.json");
  });
});
