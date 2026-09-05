import { isIP } from "node:net";
import { validation } from "../domain/errors.js";

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Splits a valid (per node:net.isIP) IPv4 literal into its four octets. */
function octetsOf(ip: string): [number, number, number, number] {
  const parts = ip.split(".").map(Number) as [number, number, number, number];
  return parts;
}

function isPublicV4(ip: string): boolean {
  const [a, b] = octetsOf(ip);
  if (a === 0) return false; // 0.0.0.0/8: this network
  if (a === 10) return false; // 10.0.0.0/8: private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10: carrier grade NAT
  if (a === 127) return false; // 127.0.0.0/8: loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16: link local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12: private
  if (a === 192 && b === 168) return false; // 192.168.0.0/16: private
  if (a >= 224 && a <= 239) return false; // 224.0.0.0/4: multicast
  if (a >= 240) return false; // 240.0.0.0/4: reserved, including the broadcast address
  return true;
}

/** Expands a valid (per node:net.isIP) IPv6 literal to its eight 16 bit groups, resolving
 * "::" compression and an embedded IPv4 tail (a:b::c.d.e.f) to two groups. */
function expandV6(ip: string): number[] {
  const zoneless = ip.split("%")[0] as string;
  const halves = zoneless.split("::");
  const groupsOf = (side: string): number[] => {
    if (side === "") return [];
    return side.split(":").map((g) => {
      if (g.includes(".")) {
        const [a, b, c, d] = octetsOf(g);
        return [(a << 8) | b, (c << 8) | d];
      }
      return [parseInt(g, 16)];
    }).flat();
  };
  if (halves.length === 1) return groupsOf(halves[0] as string);
  const head = groupsOf(halves[0] as string);
  const tail = groupsOf(halves[1] as string);
  const missing = 8 - head.length - tail.length;
  return [...head, ...new Array(Math.max(missing, 0)).fill(0), ...tail];
}

function isPublicV6(ip: string): boolean {
  const g = expandV6(ip.toLowerCase());
  if (g.length !== 8) return false; // could not parse; refuse rather than risk it
  if (g.every((h) => h === 0)) return false; // ::, the unspecified address
  if (g.slice(0, 7).every((h) => h === 0) && g[7] === 1) return false; // ::1, loopback
  const first = g[0] as number;
  if (first >= 0xfc00 && first <= 0xfdff) return false; // fc00::/7, unique local
  if (first >= 0xfe80 && first <= 0xfebf) return false; // fe80::/10, link local
  // ::ffff:a.b.c.d, an IPv4 address mapped into v6: judge it by the v4 rules.
  if (g.slice(0, 5).every((h) => h === 0) && g[5] === 0xffff) {
    const v4 = [(g[6] as number) >> 8, (g[6] as number) & 0xff, (g[7] as number) >> 8, (g[7] as number) & 0xff];
    return isPublicV4(v4.join("."));
  }
  return true;
}

/** True for a routable public address; false for loopback, link local, private, carrier
 * grade NAT, multicast, reserved and unspecified ranges in both families. Not an IP
 * literal at all (a bare domain name, or garbage) also returns false. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version === 6) return isPublicV6(ip);
  return false;
}

/** Refuses a webhook URL that is not a public https destination: wrong scheme, embedded
 * credentials, localhost and its usual aliases, or an IP literal in a private, loopback,
 * link local or otherwise non routable range. A bare domain name must contain a dot (no
 * unqualified hostnames that could resolve via a local search domain); an IP literal is
 * judged by isPublicAddress instead, since it never contains a dot in the v6 case. This
 * only catches what is knowable from the URL itself: deliverOnce re-checks the address
 * the hostname actually resolves to at delivery time, which is the only defence against
 * a hostname that resolves differently later (DNS rebinding). */
export function assertPublicWebhookUrl(url: string): void {
  const fail = (): never => { throw validation("webhook url must point at a public https host"); };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail();
  }
  if (parsed.protocol !== "https:") fail();
  if (parsed.username !== "" || parsed.password !== "") fail();
  const hostname = parsed.hostname;
  if (hostname === "localhost") fail();
  if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) fail();
  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  const literal = bracketed ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) !== 0) {
    if (!isPublicAddress(literal)) fail();
    return;
  }
  if (!hostname.includes(".")) fail();
}
