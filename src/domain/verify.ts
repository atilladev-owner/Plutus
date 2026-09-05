import { canonicalJson, hashEntry, GENESIS_HASH, type JsonValue } from "./canonical.js";

export interface JournalEntryLike { seq: string; kind: string; payload: Record<string, unknown> }
export interface JournalRowLike extends JournalEntryLike { prev_hash: Buffer; hash: Buffer }
export interface VerifyReport {
  ok: boolean; entries_checked: number; first_bad_seq: string | null;
  chain_ok: boolean; sequence_ok: boolean; replay_matches: boolean;
  assets: Array<{ asset: string; sum: string }>;
}

interface Leg { from: string; to: string; asset: string; amount: string; from_hold: string | null }

export class Replay {
  readonly balances = new Map<string, { balance: bigint; held: bigint; asset: string }>();
  private acc(id: string, asset: string) {
    let a = this.balances.get(id);
    if (!a) { a = { balance: 0n, held: 0n, asset }; this.balances.set(id, a); }
    return a;
  }
  apply(e: JournalEntryLike): void {
    if (e.kind === "transfer.posted") {
      const legs = ((e.payload.transfer as { legs: Leg[] }).legs);
      for (const l of legs) {
        const amount = BigInt(l.amount);
        const from = this.acc(l.from, l.asset);
        from.balance -= amount;
        if (l.from_hold) from.held -= amount;
        this.acc(l.to, l.asset).balance += amount;
      }
    } else if (e.kind === "hold.created") {
      const h = e.payload.hold as { account: string; asset: string; amount: string };
      this.acc(h.account, h.asset).held += BigInt(h.amount);
    } else if (e.kind === "hold.released" || e.kind === "hold.expired") {
      const h = e.payload.hold as { account: string; asset: string; amount: string };
      this.acc(h.account, h.asset).held -= BigInt(h.amount);
    }
  }
  sums(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const a of this.balances.values()) out.set(a.asset, (out.get(a.asset) ?? 0n) + a.balance);
    return out;
  }
}

/** Walks entries in order, recomputing every hash and replaying every effect. Stops recording the first bad seq but keeps counting. */
export async function verifyChain(entries: AsyncIterable<JournalRowLike>, stored: Map<string, { balance: bigint; held: bigint }>): Promise<VerifyReport> {
  const replay = new Replay();
  let prev = GENESIS_HASH;
  let expected = 1n;
  let checked = 0;
  let firstBad: string | null = null;
  let chainOk = true;
  let sequenceOk = true;
  for await (const row of entries) {
    checked++;
    if (BigInt(row.seq) !== expected) { sequenceOk = false; firstBad ??= row.seq; }
    const recomputed = hashEntry(prev, canonicalJson(row.payload as JsonValue));
    if (!row.prev_hash.equals(prev) || !recomputed.equals(row.hash)) { chainOk = false; firstBad ??= row.seq; }
    replay.apply(row);
    prev = row.hash;
    expected = BigInt(row.seq) + 1n;
  }
  let replayMatches = true;
  for (const [id, s] of stored) {
    const r = replay.balances.get(id) ?? { balance: 0n, held: 0n };
    if (r.balance !== s.balance || r.held !== s.held) replayMatches = false;
  }
  const assets = [...replay.sums()].map(([asset, sum]) => ({ asset, sum: sum.toString() })).sort((a, b) => a.asset.localeCompare(b.asset));
  const zero = assets.every((a) => a.sum === "0");
  return { ok: chainOk && sequenceOk && replayMatches && zero, entries_checked: checked, first_bad_seq: firstBad, chain_ok: chainOk, sequence_ok: sequenceOk, replay_matches: replayMatches, assets };
}
