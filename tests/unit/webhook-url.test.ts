import { describe, it, expect } from "vitest";
import { isPublicAddress, assertPublicWebhookUrl } from "../../src/platform/webhook-url.js";

describe("isPublicAddress", () => {
  it("refuses private, loopback and link local ranges in both families", () => {
    const privateAddresses = ["10.0.0.1", "192.168.1.1", "169.254.169.254", "127.0.0.1", "::1", "fc00::1"];
    for (const ip of privateAddresses) expect(isPublicAddress(ip)).toBe(false);
  });
  it("accepts routable public addresses in both families", () => {
    const publicAddresses = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111", "2620:119:35::35"];
    for (const ip of publicAddresses) expect(isPublicAddress(ip)).toBe(true);
  });
  it("refuses a hostname that is not an IP literal at all", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("assertPublicWebhookUrl", () => {
  it("accepts a plain public https url", () => {
    expect(() => assertPublicWebhookUrl("https://example.com/x")).not.toThrow();
  });
  it("refuses non https, credentials, localhost, private and reserved hosts", () => {
    const bad = [
      "http://example.com/x",
      "https://user:pw@example.com/x",
      "https://localhost/x",
      "https://foo.localhost/x",
      "https://foo.internal/x",
      "https://169.254.169.254/x",
      "https://10.0.0.1/x",
      "https://[::1]/x",
      "https://noTLD/x",
    ];
    for (const url of bad) expect(() => assertPublicWebhookUrl(url)).toThrow();
  });
});
