import dns from "node:dns";
import { withTx } from "../db/pool.js";
import { claimDelivery, recordAttempt, bumpFailures } from "../db/webhooks.js";
import { getEventsByIds } from "../db/events.js";
import { signPayload } from "./webhook-sign.js";
import { isPublicAddress } from "./webhook-url.js";
import type { AppDeps } from "../deps.js";

export const RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 3600, 10800, 21600, 43200];
export const MAX_ATTEMPTS = 8;
const LOOKUP_TIMEOUT_MS = 3_000;

/** Thrown internally to short circuit an attempt whose destination resolves to a non
 * public address; caught right below to produce a specific, honest excerpt instead of
 * the generic "request failed" one a network error gets. */
class PrivateAddressError extends Error {}

/** Thrown when the resolver itself errors or does not answer within LOOKUP_TIMEOUT_MS.
 * A slow or hanging resolver must not be able to hold the delivery's row lock, and so a
 * pooled connection, indefinitely: the attempt is refused instead of waited out. */
class LookupFailedError extends Error {}

/** Resolves hostname and refuses the destination (throwing PrivateAddressError) if any
 * answer is not a public address. Races the lookup against a fixed timeout so a slow or
 * unresponsive resolver cannot hold the caller's transaction open; a timeout or any
 * lookup error becomes LookupFailedError, deliberately not distinguished from each
 * other, since both mean "could not confirm this destination is safe to call". */
async function assertPublicDestination(hostname: string, lookup: typeof dns.promises.lookup): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lookup timed out")), LOOKUP_TIMEOUT_MS); }),
    ]);
    if (resolved.some((r) => !isPublicAddress(r.address))) throw new PrivateAddressError("destination resolves to a private address");
  } catch (err) {
    if (err instanceof PrivateAddressError) throw err;
    throw new LookupFailedError("destination lookup failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most maxBytes of a fetch Response body, cancelling the stream once that many
 * bytes have arrived instead of buffering the whole thing: a customer endpoint controls
 * this response and must not be able to make delivery hold gigabytes in memory to save
 * an excerpt nobody reads past the first kilobyte of. The cap is bytes, not characters. */
async function readExcerpt(res: Response, maxBytes = 1024): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  return new TextDecoder().decode(bytes);
}

/**
 * One attempt, locked so a concurrent caller for the same delivery id does nothing
 * instead of racing this one. Everything, the HTTP call included, runs inside a single
 * transaction: the `for update ... skip locked` read holds the delivery for the whole
 * attempt, and a second deliverOnce for the same id (a manual retry racing a scheduled
 * one, or a QStash redelivery) finds no row and returns without touching the network.
 * Records the outcome, then, once the transaction has committed, schedules the next
 * attempt or leaves the delivery dead.
 *
 * options.lookup overrides the resolver the private destination check uses (default
 * dns.promises.lookup) and makes that check run even under NODE_ENV === "test", so
 * tests can exercise it with a fake resolver; without options.lookup the check keeps
 * skipping in tests, since the test receiver deliberately lives on 127.0.0.1. The
 * attempt's total time is bounded by LOOKUP_TIMEOUT_MS for the lookup plus 10 seconds
 * for the request, one after the other, not overlapping.
 */
export async function deliverOnce(deps: AppDeps, deliveryId: string, options?: { lookup?: typeof dns.promises.lookup }): Promise<void> {
  const outcome = await withTx(deps.pool, async (c) => {
    const d = await claimDelivery(c, deliveryId);
    if (!d) return null; // another worker holds it, or it does not exist
    if (d.status === "succeeded" || d.status === "dead") return null;
    const [event] = await getEventsByIds(c, [d.event_id]);
    if (!event) return null;
    const body = JSON.stringify({ id: event.id, type: event.type, ledger_id: event.ledger_id, entity_id: event.entity_id, data: event.payload, created_at: event.created_at.toISOString() });
    const t = Math.trunc(Date.now() / 1000);
    const attempt = d.attempt + 1;
    let status: number | null = null;
    let excerpt: string | null = null;
    if (d.endpoint.status === "disabled") {
      excerpt = "endpoint disabled";
    } else {
      try {
        // Registration time already refused a URL that is not a public https host
        // (assertPublicWebhookUrl), but a hostname can resolve to a different, private
        // address later (DNS rebinding). Re-resolve right before connecting and refuse
        // the attempt, with no HTTP call, if any answer is not public.
        if (deps.config.NODE_ENV !== "test" || options?.lookup) {
          const hostname = new URL(d.endpoint.url).hostname;
          await assertPublicDestination(hostname, options?.lookup ?? dns.promises.lookup);
        }
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 10_000);
        try {
          const res = await fetch(d.endpoint.url, {
            method: "POST", signal: ac.signal, redirect: "manual",
            headers: { "content-type": "application/json", "user-agent": "plutus-webhooks/1", "plutus-event-id": event.id, "plutus-signature": `t=${t},v1=${signPayload(d.endpoint.secret, t, body)}` },
            body,
          });
          status = res.status;
          excerpt = await readExcerpt(res);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        excerpt = err instanceof PrivateAddressError || err instanceof LookupFailedError ? err.message : `request failed: ${(err as Error).name}`;
      }
    }
    const ok = status !== null && status >= 200 && status < 300;
    const nextDelay = RETRY_DELAYS_SECONDS[attempt - 1];
    const dead = !ok && (attempt >= MAX_ATTEMPTS || nextDelay === undefined);
    await recordAttempt(c, d.id, {
      attempt, status: ok ? "succeeded" : dead ? "dead" : "pending", responseStatus: status, excerpt,
      nextAttemptAt: ok || dead ? null : new Date(Date.now() + (nextDelay ?? 0) * 1000),
    });
    await bumpFailures(c, d.endpoint_id, ok);
    return { ok, dead, nextDelay, deliveryId: d.id };
  });
  if (outcome && !outcome.ok && !outcome.dead && outcome.nextDelay !== undefined) {
    await deps.scheduler.schedule(outcome.deliveryId, outcome.nextDelay);
  }
}
