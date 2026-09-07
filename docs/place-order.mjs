// Places one signed limit buy order against the live Plutus exchange, from outside the
// repository. It reimplements the signing scheme in src/platform/signing.ts (spec 10.8)
// using only node:crypto, with no import from this project, so a copy of this one file is
// everything another machine needs.
//
// Reads two variables from the environment and never prints either:
//   PLUTUS_KEY_ID   the key_... id
//   PLUTUS_SECRET   the pl_test_... or pl_live_... secret that belongs to it
// and one optional one:
//   PLUTUS_HOST     defaults to the live deployment
//
// Usage:
//   PLUTUS_KEY_ID=key_xxx PLUTUS_SECRET=pl_test_xxx node place-order.mjs
//
// It reads the public order book for BTC-USDT, prices a limit buy ten percent below the
// current best ask, rounds that price down to the market's own tick, and places an order
// for 0.001 BTC, the smallest lot this market accepts. It prints the order id and status
// and nothing else.

import { createHash, createHmac, randomUUID } from "node:crypto";

const HOST = process.env.PLUTUS_HOST ?? "https://plutus-ten-eta.vercel.app";
const KEY_ID = process.env.PLUTUS_KEY_ID;
const SECRET = process.env.PLUTUS_SECRET;

const MARKET = "BTC-USDT";
// 0.001 BTC in base minor units. BTC carries 8 decimal places, so one whole BTC is
// 100000000; a thousandth of that is 100000, which is also this market's lot size, so
// this is the smallest order the book will accept.
const QUANTITY = "100000";
const DISCOUNT_BPS = 1000n; // ten percent, in basis points of 10000

if (!KEY_ID || !SECRET) {
  process.stdout.write("Set PLUTUS_KEY_ID and PLUTUS_SECRET in the environment before running this script.\n");
  process.exit(1);
}

function signatureMessage(timestamp, method, path, body) {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
}

// The server never stores the raw secret, only the SHA-256 digest of it (hashSecret in
// src/platform/auth.ts), so the HMAC on both sides is keyed by that digest, not by the
// secret itself.
function hashSecret(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

function signRequest({ keyId, secret, method, path, body, timestamp, recvWindow }) {
  const key = hashSecret(secret);
  const message = signatureMessage(timestamp, method, path, body);
  const signature = createHmac("sha256", key).update(message, "utf8").digest("hex");
  return {
    "X-Plutus-Key-Id": keyId,
    "X-Plutus-Timestamp": String(timestamp),
    "X-Plutus-Recv-Window": String(recvWindow),
    "X-Plutus-Signature": signature,
  };
}

async function getJson(path) {
  const res = await fetch(`${HOST}${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function placeOrder(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const recvWindow = 5000;
  const headers = {
    "Content-Type": "application/json",
    ...signRequest({ keyId: KEY_ID, secret: SECRET, method: "POST", path, body, timestamp, recvWindow }),
  };
  const res = await fetch(`${HOST}${path}`, { method: "POST", headers, body });
  const out = await res.json();
  if (!res.ok) throw new Error(`POST ${path} returned ${res.status}: ${JSON.stringify(out)}`);
  return out;
}

// Rounds a price down to the nearest tick in plain integer arithmetic, the same rule
// place_order itself enforces (spec 10.3's price_not_tick), so this never proposes a price
// the book would reject for a reason unrelated to the discount it was asked for.
function roundDownToTick(price, tick) {
  return (price / tick) * tick;
}

async function main() {
  const markets = await getJson("/v1/exchange/markets");
  const market = markets.data.find((m) => m.symbol === MARKET);
  if (!market) throw new Error(`${MARKET} is not a listed market`);
  const tick = BigInt(market.tick_size);

  const book = await getJson(`/v1/exchange/markets/${MARKET}/book?depth=1`);
  const bestAsk = book.asks[0];
  if (!bestAsk) throw new Error("the book has no asks to price against right now");
  const askPrice = BigInt(bestAsk.price);

  const discounted = (askPrice * (10000n - DISCOUNT_BPS)) / 10000n;
  const price = roundDownToTick(discounted, tick);

  const order = await placeOrder("/v1/exchange/orders", {
    market: MARKET,
    side: "buy",
    type: "limit",
    price: price.toString(),
    quantity: QUANTITY,
    client_order_id: `outside-${randomUUID()}`,
  });

  process.stdout.write(`${order.id} ${order.status}\n`);
}

main().catch((err) => {
  process.stdout.write(`failed: ${err.message}\n`);
  process.exit(1);
});
