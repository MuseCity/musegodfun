import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseAudit } from "../server/base-audit";
import { baseOperatorAuditStore } from "../scripts/base-audit-store";
import { verifyBaseCollectorForOperator } from "../scripts/verify-base";
import { BASE_COLLECTOR_MANIFEST } from "../server/base-collector";

const id = `internal_native_modules:0x${"6e".repeat(32)}`;
const hash = (number: bigint) => `0x${number.toString(16).padStart(64, "0")}` as const;
const client = () => ({ getChainId: async () => 8453, getBlock: async (input: any) => {
  const number = input.blockNumber ?? 4990n; return { number, hash: hash(number) };
} });

test("the real operator entry wraps Base only and leaves the supplied Robinhood peer plain", async () => {
  let sourceRequestReads = 0, destinationTransportReads = 0, networkReads = 0;
  const source = { transport: { url: "https://base.invalid" }, get request() {
    sourceRequestReads++; return async () => { networkReads++; throw new Error("Unexpected RPC request"); };
  } };
  const destination = { get transport() {
    destinationTransportReads++; throw new Error("Robinhood peer must not be wrapped for local replay");
  } };
  const manifest = structuredClone(BASE_COLLECTOR_MANIFEST); manifest.status = "not_deployed";
  const auditStore = { getBuybackBatch: () => null, compareAndSetBuybackAudit: () => false };
  await assert.rejects(() => verifyBaseCollectorForOperator(source as any, "0x0000000000000000000000000000000000000001",
    { requireActivation: false, manifest, robinhoodClient: destination as any }, { auditStore }), /native Base Collector deployment has not been verified/);
  assert.equal(sourceRequestReads, 1, "The Base source retains its local replay wrapper");
  assert.equal(destinationTransportReads, 0, "Operator verification passes the destination peer through without a replay wrapper");
  assert.equal(networkReads, 0);
});

test("both operator audit callers finish old Automation history through durable complete prefixes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "base-operator-prefix-"));
  try {
    let calls = 0;
    const pages: bigint[] = [], current = client(), store = baseOperatorAuditStore(directory);
    const verifyGraph = async (rpc: any, _address: any, options: any) => {
      calls++; let ticks = 0;
      const rows = await readBaseAudit({ client: rpc, store: options.auditStore, id, from: 1n, to: 5000n,
        now: () => ticks, maxDurationMs: 3,
        validate: (value): value is { blockNumber: string } => typeof (value as any)?.blockNumber === "string",
        page: async (from, to) => { pages.push(from); ticks++; return [{ blockNumber: String(to) }]; } });
      return { rows } as any;
    };
    await assert.rejects(() => verifyGraph(current, null, {}), /coverage is incomplete/,
      "the previous one-shot tool call cannot finish old native history without operator persistence and retry");
    calls = 0; pages.length = 0;
    const verified = await verifyBaseCollectorForOperator(current as any, "0x0000000000000000000000000000000000000001", {},
      { verifyGraph: verifyGraph as any, auditStore: store });
    assert.equal(calls, 9); assert.equal(pages.length, 25); assert.equal((verified as any).rows.length, 25);
    assert.equal((await store.getBuybackBatch(id))?.through, "5000");
    calls = 0; pages.length = 0;
    await verifyBaseCollectorForOperator(client() as any, "0x0000000000000000000000000000000000000001", { requireActivation: false },
      { verifyGraph: verifyGraph as any, auditStore: baseOperatorAuditStore(directory) });
    assert.equal(calls, 1); assert.equal(pages.length, 0, "cold process resumes the anchored operator file, including import-proof audits");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("operator RPC error leaves complete pages resumable without hiding the error or changing financial records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "base-operator-rpc-"));
  try {
    let fail = true, calls = 0;
    const pages: bigint[] = [], current = client(), store = baseOperatorAuditStore(directory);
    const verifyGraph = async (rpc: any, _address: any, options: any) => {
      calls++;
      await readBaseAudit({ client: rpc, store: options.auditStore, id, from: 1n, to: 5000n,
        validate: (value): value is { blockNumber: string } => typeof (value as any)?.blockNumber === "string",
        page: async (from, to) => { pages.push(from); if (fail && from === 401n) throw new Error("RPC 429"); return [{ blockNumber: String(to) }]; } });
      return {} as any;
    };
    await assert.rejects(() => verifyBaseCollectorForOperator(current as any, "0x0000000000000000000000000000000000000001", {},
      { verifyGraph: verifyGraph as any, auditStore: store }), /RPC 429/);
    assert.equal(calls, 1); assert.equal((await store.getBuybackBatch(id))?.through, "400");
    fail = false; pages.length = 0;
    await verifyBaseCollectorForOperator(client() as any, "0x0000000000000000000000000000000000000001", {},
      { verifyGraph: verifyGraph as any, auditStore: baseOperatorAuditStore(directory) });
    assert.equal(pages[0], 401n); assert.equal((await store.getBuybackBatch(id))?.through, "5000");
    const original = await store.getBuybackBatch(id);
    await assert.rejects(() => verifyBaseCollectorForOperator(client() as any, "0x0000000000000000000000000000000000000001", {},
      { verifyGraph: verifyGraph as any, auditStore: store, maxDurationMs: 0 }), /budget reached/);
    assert.deepEqual(await store.getBuybackBatch(id), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
