import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, hashMessage, keccak256, parseAbi, parseEventLogs, recoverMessageAddress, toBytes, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pending from "../contracts/artifacts/buyback-v2-deployment.json";
import { buybackGraphFingerprint, governorControlMessage, nativeAcceptanceMessage, verifyBuybackActivation, type BuybackActivation, type GovernorControlProof, type NativeAcceptanceProof } from "../server/buyback-activation";
import type { BuybackDeployment } from "../server/buyback-engine";
import governorJson from "./fixtures/governor-control-manifest.json";

// A JSON import infers strings, even for validated address/hex values. Keep the
// serialized manifest boundary distinct from the validated activation proof.
const jsonGovernance: Pick<BuybackDeployment, "governance"> = governorJson;
test("governor control proof can be retained in a JSON deployment manifest", async () => {
  assert.deepEqual(jsonGovernance.governance?.controlProof, governorJson.governance.controlProof);
  const proof = governorJson.governance.controlProof as GovernorControlProof;
  assert.equal(await recoverMessageAddress({ message: governorControlMessage(proof), signature: proof.signature }), getAddress(proof.signer));
});

test("JSON-compatible governor input still rejects malformed proof fields", async () => {
  const f = await fixture();
  const manifest: BuybackDeployment = { ...f.manifest, governance: { controlProof: { ...f.control, chainId: "4663" } } };
  await assert.rejects(() => verifyBuybackActivation(f.client, manifest, 200n), /another graph/);
});

const governor = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const hash = (value: string) => keccak256(toBytes(value));
const address = (value: number) => getAddress(`0x${value.toString(16).padStart(40, "0")}`);
const oldForwarder = getAddress("0x3B6d01e627Fe6e06C831E0f9f57aC976a88309Ff");
test("recorded actual fork fee receipts use the initializer and hook as direct token senders", () => {
  const saved = JSON.parse(readFileSync(new URL("../docs/evidence/buyback-v2-fee-custody.json", import.meta.url), "utf8")) as {
    actualFeeCustodyCaptured: boolean; mainnetTransactionSubmitted: boolean; snapshotRestored: boolean; blockedUpstreamWrites: number;
    feeCustody: { label: string; engine: Address; transactionHash: Hex; rawReceipt: TransactionReceipt }[];
  };
  assert.equal(saved.actualFeeCustodyCaptured, true); assert.equal(saved.mainnetTransactionSubmitted, false);
  assert.equal(saved.snapshotRestored, true); assert.equal(saved.blockedUpstreamWrites, 0);
  assert.deepEqual(saved.feeCustody.map((row) => row.label), ["claimFees", "claimAndForward"]);
  const managers = [getAddress(pending.constants.initializer), getAddress(pending.constants.rehype)];
  for (const row of saved.feeCustody) {
    assert.equal(row.rawReceipt.transactionHash, row.transactionHash); assert.equal(row.rawReceipt.status, "success");
    const logs = row.rawReceipt.logs, engine = row.engine.toLowerCase();
    const claims = parseEventLogs({ abi: parseAbi(["event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)"]), logs: logs.filter((log) => log.address.toLowerCase() === engine), strict: true });
    const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs, strict: true });
    const releases = parseEventLogs({ abi: parseAbi(["event UnpricedForwarded(address indexed token,uint256 amount,address indexed automation)"]), logs: logs.filter((log) => log.address.toLowerCase() === engine), strict: true });
    assert(claims.some((claim) => claim.args.amount > 0n));
    for (const token of new Set(claims.map((claim) => claim.args.token.toLowerCase()))) {
      const release = releases.find((entry) => entry.args.token.toLowerCase() === token), cutoff = release?.logIndex ?? Number.MAX_SAFE_INTEGER;
      for (const manager of managers) {
        const claimed = claims.filter((entry) => entry.args.token.toLowerCase() === token && entry.args.manager === manager && entry.logIndex < cutoff).reduce((sum, entry) => sum + entry.args.amount, 0n);
        const net = transfers.filter((entry) => entry.address.toLowerCase() === token && entry.logIndex < cutoff).reduce((sum, entry) => sum + (entry.args.from === manager && entry.args.to.toLowerCase() === engine ? entry.args.value : 0n) - (entry.args.to === manager && entry.args.from.toLowerCase() === engine ? entry.args.value : 0n), 0n);
        assert.equal(net, claimed, `${row.label}: actual ${manager} fee custody for ${token}`);
      }
      if (release) assert(claims.filter((entry) => entry.args.token.toLowerCase() === token && entry.logIndex < cutoff).reduce((sum, entry) => sum + entry.args.amount, 0n) >= release.args.amount);
    }
    if (row.label === "claimAndForward") assert.equal(releases.length, 1);
  }
});
function event(text: string, target: Address, args: Record<string, unknown>) {
  const abi = parseAbi([text]) as Abi, item = abi[0] as unknown as { name: string; inputs: { indexed?: boolean; name: string; type: string }[] };
  return { address: target, topics: encodeEventTopics({ abi, eventName: item.name, args }), data: encodeAbiParameters(item.inputs.filter((v) => !v.indexed), item.inputs.filter((v) => !v.indexed).map((v) => args[v.name])) };
}
async function fixture(contractGovernor = false) {
  const names = ["oracle", "swapper", "executor", "assetOracle", "vault", "engine", "forwarder"] as const;
  const nodes = Object.fromEntries(names.map((name, index) => [name, address(100 + index)])) as Record<typeof names[number], Address>;
  const manifest: BuybackDeployment = { ...pending, status: "deployed_verified", constants: { ...pending.constants, treasury: contractGovernor ? address(999) : governor.address },
    contracts: Object.fromEntries(names.map((name) => [name, { address: nodes[name], runtimeHash: hash(name) }])) as BuybackDeployment["contracts"] };
  const fingerprint = buybackGraphFingerprint(manifest), source = getAddress(manifest.constants.automationTreasury!), automation = getAddress(manifest.constants.automation!), weth = getAddress(manifest.constants.weth), muse = getAddress(manifest.constants.muse), dead = getAddress(manifest.constants.beneficiary), asset = address(500);
  const ref = (name: string) => ({ chainId: 4663, graphFingerprint: fingerprint, transactionHash: hash(name) });
  const control: GovernorControlProof = { chainId: 4663, graphFingerprint: fingerprint, blockNumber: "100", blockHash: hash("block100"), signer: contractGovernor ? address(999) : governor.address, signature: "0x" };
  control.signature = contractGovernor ? "0x123456" : await governor.signMessage({ message: governorControlMessage(control) });
  const native: NativeAcceptanceProof = { chainId: 4663, graphFingerprint: fingerprint, ruleId: "native-rule-id", schedulerRunId: "native-scheduled-run-id", evidenceUri: "https://example.test/native-scheduled-run.json", evidenceSha256: hash("reviewed external native scheduler evidence"),
    unpricedToken: asset, inputAmount: "100", wethAmount: "100000000000000", feeCollectionTransactionHash: hash("collection"), feeTransactionHash: hash("fee"), conversionTransactionHash: hash("conversion"), sweepTransactionHash: hash("sweep"), forwardTransactionHash: hash("forward"), settlementTransactionHash: hash("settlement"), signer: control.signer, signature: "0x" };
  native.signature = contractGovernor ? "0x123456" : await governor.signMessage({ message: nativeAcceptanceMessage(native) });
  const proof: BuybackActivation = { schemaVersion: 1, chainId: 4663, graphFingerprint: fingerprint,
    oldForwarderRevocation: { ...ref("revoke"), source, token: weth, spender: oldForwarder, amount: "0" },
    newFiniteAllowance: { ...ref("approve"), source, token: weth, spender: nodes.forwarder, amount: "200000000000000" }, nativeAutomationAcceptance: native,
    legacySwapperCutover: { blockNumber: "22", blockHash: hash("block22"), wethBalance: "0" } };
  manifest.activation = proof; manifest.governance = { controlProof: control };
  const transfer = (token: Address, from: Address, to: Address, value: bigint) => event("event Transfer(address indexed from,address indexed to,uint256 value)", token, { from, to, value });
  const approval = (spender: Address, value: bigint) => event("event Approval(address indexed owner,address indexed spender,uint256 value)", weth, { owner: source, spender, value });
  const amount = BigInt(native.wethAmount), burned = 1000n;
  const data: Record<string, { block: number; logs: ReturnType<typeof event>[] }> = {
    revoke: { block: 20, logs: [approval(oldForwarder, 0n)] }, approve: { block: 21, logs: [approval(nodes.forwarder, 200000000000000n)] },
    collection: { block: 22, logs: [transfer(asset, getAddress(manifest.constants.initializer), nodes.engine, 100n), event("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)", nodes.engine, { poolId: hash("pool"), manager: getAddress(manifest.constants.initializer), token: asset, amount: 100n })] },
    fee: { block: 23, logs: [transfer(asset, nodes.engine, automation, 100n), event("event UnpricedForwarded(address indexed token,uint256 amount,address indexed automation)", nodes.engine, { token: asset, amount: 100n, automation })] },
    conversion: { block: 24, logs: [transfer(asset, automation, address(501), 100n), transfer(weth, address(501), automation, amount)] },
    sweep: { block: 25, logs: [transfer(weth, automation, source, amount)] },
    forward: { block: 26, logs: [event("event Forwarded(address indexed caller,uint256 amount)", nodes.forwarder, { caller: stranger.address, amount }), transfer(weth, source, nodes.vault, amount)] },
    settlement: { block: 27, logs: [event("event Executed(address indexed caller,uint256 wethAmount,uint256 museToDead,uint256 profit)", nodes.vault, { caller: stranger.address, wethAmount: amount, museToDead: burned, profit: 1n }),
      event("event Flash(address indexed beneficiary,address indexed trader,((address base,address quote) quotePair,uint128 baseAmount,bytes data)[] quoteParams,address tokenToBeneficiary,uint256[] amountsToBeneficiary,uint256 excessToBeneficiary)", nodes.swapper, { beneficiary: dead, trader: nodes.executor, quoteParams: [{ quotePair: { base: weth, quote: muse }, baseAmount: amount, data: "0x" }], tokenToBeneficiary: muse, amountsToBeneficiary: [burned], excessToBeneficiary: 0n }),
      transfer(weth, nodes.vault, nodes.swapper, amount), transfer(weth, nodes.swapper, nodes.executor, amount), transfer(muse, nodes.executor, dead, burned)] },
  };
  const receipts = new Map(Object.entries(data).map(([key, value]) => [hash(key), { transactionHash: hash(key), transactionIndex: 0, status: "success", blockNumber: BigInt(value.block), blockHash: hash(`block${value.block}`), logs: value.logs.map((log, logIndex) => ({ ...log, logIndex })) } as TransactionReceipt]));
  let reserve = 0n, valid1271 = true, canonical = true, forwardedCounter = 100n;
  const client = { getChainId: async () => 4663, getCode: async () => contractGovernor ? "0x6000" : "0x", getTransactionReceipt: async ({ hash }: { hash: Hex }) => { assert(receipts.has(hash)); return receipts.get(hash)!; },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: canonical ? hash(`block${blockNumber}`) : hash("orphan") }),
    readContract: async ({ functionName, args, blockNumber }: { functionName: string; args: unknown[]; blockNumber: bigint }) => {
      if (functionName === "isValidSignature") { assert([hashMessage(governorControlMessage(control)), hashMessage(nativeAcceptanceMessage(native))].includes(args[0] as Hex)); return valid1271 ? "0x1626ba7e" : "0xffffffff"; }
      if (functionName === "totalAutomationForwarded") return blockNumber < 23n ? 0n : forwardedCounter;
      assert.equal(functionName, "balanceOf", "Activation does not demand a fresh positive source allowance after it is exhausted"); return reserve;
    } } as unknown as Parameters<typeof verifyBuybackActivation>[0];
  return { manifest, proof, control, native, nodes, client, receipts, setReserve: (value: bigint) => { reserve = value; }, set1271: (value: boolean) => { valid1271 = value; }, setCanonical: (value: boolean) => { canonical = value; }, setForwardedCounter: (value: bigint) => { forwardedCounter = value; } };
}

test("source/runtime verification and passed strings never substitute for activation receipts", async () => {
  const f = await fixture();
  for (const activation of [undefined, { status: "passed" }, { ...f.proof, nativeAutomationAcceptance: "passed" }])
    await assert.rejects(() => verifyBuybackActivation(f.client, { ...f.manifest, activation } as BuybackDeployment, 200n));
  await assert.rejects(() => verifyBuybackActivation(f.client, { ...f.manifest, governance: { controlProof: "passed" } }, 200n));
});
test("an exact signed graph activates from canonical receipts without requiring an unexhausted allowance", async () => {
  const f = await fixture(), result = await verifyBuybackActivation(f.client, f.manifest, 200n);
  assert.equal(result.fingerprint, f.proof.graphFingerprint); assert.equal(result.activatedAtBlock, "27");
  assert.match(result.nativeSchedulerEvidence, /external_attestation/);
  await assert.rejects(() => verifyBuybackActivation({ ...f.client, getChainId: async () => 31337 }, f.manifest, 200n), /chain 4663/);
});
test("activation rejects MAX, MAX minus one and approvals above the fixed daily ceiling", async () => {
  for (const amount of [2n ** 256n - 1n, 2n ** 256n - 2n, 288n * 10n ** 16n + 1n]) {
    const f = await fixture(); f.proof.newFiniteAllowance.amount = String(amount);
    await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /finite raw amount|2.88 WETH ceiling/);
  }
});
test("activation accepts the exact 2.88 WETH approval ceiling with an unchanged small canary", async () => {
  const f = await fixture(), cap = 288n * 10n ** 16n;
  f.proof.newFiniteAllowance.amount = String(cap);
  const receipt = f.receipts.get(hash("approve"))!;
  receipt.logs = [event("event Approval(address indexed owner,address indexed spender,uint256 value)", getAddress(f.manifest.constants.weth), {
    owner: getAddress(f.manifest.constants.automationTreasury!), spender: f.nodes.forwarder, value: cap,
  })].map((log, logIndex) => ({ ...log, logIndex })) as typeof receipt.logs;
  assert.equal((await verifyBuybackActivation(f.client, f.manifest, 200n)).activatedAtBlock, "27");
  assert.equal(f.native.wethAmount, "100000000000000", "allowance is not a larger canary budget");
});
test("synced donations never replace actual fixed-manager fee collection", async () => {
  const f = await fixture(), asset = f.native.unpricedToken, collection = f.receipts.get(hash("collection"))!;
  collection.logs = [event("event Transfer(address indexed from,address indexed to,uint256 value)", asset, { from: stranger.address, to: f.nodes.engine, value: 100n }),
    event("event BalanceSynced(address indexed token,uint256 amount)", f.nodes.engine, { token: asset, amount: 100n })].map((log, logIndex) => ({ ...log, logIndex })) as typeof collection.logs;
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /actual FeesClaimed/);
});
test("an old fee receipt already released cannot be reused after a fresh donation", async () => {
  const f = await fixture(); f.setForwardedCounter(200n);
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /already been spent/);
  f.setForwardedCounter(99n);
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /does not cover/);
});
test("fee collection needs matching manager, asset, sufficient claimed amount and net incoming transfers", async () => {
  const cases = ["manager", "asset", "amount", "missing-transfer", "net-transfer"] as const;
  for (const variant of cases) {
    const f = await fixture(), collection = f.receipts.get(hash("collection"))!, manager = getAddress(f.manifest.constants.initializer);
    if (["manager", "asset", "amount"].includes(variant)) collection.logs[1] = { ...event("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)", f.nodes.engine,
      { poolId: hash("pool"), manager: variant === "manager" ? stranger.address : manager, token: variant === "asset" ? address(599) : f.native.unpricedToken, amount: variant === "amount" ? 99n : 100n }), logIndex: 1 } as typeof collection.logs[number];
    if (variant === "missing-transfer") collection.logs.shift();
    if (variant === "net-transfer") collection.logs.push({ ...event("event Transfer(address indexed from,address indexed to,uint256 value)", f.native.unpricedToken, { from: f.nodes.engine, to: manager, value: 1n }), logIndex: 2 } as typeof collection.logs[number]);
    await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /FeesClaimed|net token transfers/, variant);
  }
});
test("initializer and hook fee receipts accumulate without counting other incoming tokens", async () => {
  const f = await fixture(), collection = f.receipts.get(hash("collection"))!;
  collection.logs = [f.manifest.constants.initializer, f.manifest.constants.rehype].flatMap((manager, i) => [
    event("event Transfer(address indexed from,address indexed to,uint256 value)", f.native.unpricedToken, { from: manager, to: f.nodes.engine, value: i === 0 ? 60n : 90n }),
    event("event FeesClaimed(bytes32 indexed poolId,address indexed manager,address indexed token,uint256 amount)", f.nodes.engine, { poolId: hash("pool"), manager, token: f.native.unpricedToken, amount: i === 0 ? 60n : 90n }),
  ]).map((log, logIndex) => ({ ...log, logIndex })) as typeof collection.logs;
  await verifyBuybackActivation(f.client, f.manifest, 200n);
});
test("atomic claim and release requires FeesClaimed before UnpricedForwarded by canonical log index", async () => {
  const f = await fixture(), fee = f.receipts.get(hash("fee"))!, claimLogs = f.receipts.get(hash("collection"))!.logs, releaseLogs = [...fee.logs];
  fee.logs = [...claimLogs, ...releaseLogs].map((log, logIndex) => ({ ...log, logIndex }));
  f.native.feeCollectionTransactionHash = f.native.feeTransactionHash;
  f.native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(f.native) });
  await verifyBuybackActivation(f.client, f.manifest, 200n);
  fee.logs = [...releaseLogs, ...claimLogs].map((log, logIndex) => ({ ...log, logIndex }));
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /actual FeesClaimed before/);
});
test("collection must precede release and its receipt hash is bound by the native signature", async () => {
  const f = await fixture(), collection = f.receipts.get(hash("collection"))!;
  const changedHash = hash("alternate-collection");
  f.receipts.set(changedHash, { ...collection, transactionHash: changedHash });
  f.native.feeCollectionTransactionHash = changedHash;
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /immutable governor/);
  f.native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(f.native) });
  const altered = f.receipts.get(changedHash)!; altered.blockNumber = 24n; altered.blockHash = hash("block24");
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /funding and settlement order/);
});
test("atomic native conversion to source is accepted only with the exact signed receipt link", async () => {
  const f = await fixture(), source = getAddress(f.manifest.constants.automationTreasury!), weth = getAddress(f.manifest.constants.weth);
  const conversion = f.receipts.get(hash("conversion"))!;
  conversion.logs.splice(1, 1, event("event Transfer(address indexed from,address indexed to,uint256 value)", weth, { from: address(501), to: source, value: BigInt(f.native.wethAmount) }) as typeof conversion.logs[number]);
  f.native.sweepTransactionHash = f.native.conversionTransactionHash;
  f.native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(f.native) });
  await verifyBuybackActivation(f.client, f.manifest, 200n);
  conversion.logs.pop(); await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /deliver/);
});
test("one signed transaction cannot stand in for reverse-ordered native activation phases", async () => {
  const f = await fixture(), combined = f.receipts.get(hash("settlement"))!;
  combined.logs = ["settlement", "forward", "sweep", "conversion", "fee"].flatMap((key) => f.receipts.get(hash(key))!.logs);
  for (const key of ["feeTransactionHash", "conversionTransactionHash", "sweepTransactionHash", "forwardTransactionHash", "settlementTransactionHash"] as const) f.native[key] = combined.transactionHash;
  f.native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(f.native) });
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /distinct receipts/);
});
test("every non-atomic phase rejects a reused receipt even when the acceptance is signed again", async () => {
  const keys = ["feeTransactionHash", "conversionTransactionHash", "sweepTransactionHash", "forwardTransactionHash", "settlementTransactionHash"] as const;
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    if (keys[i] === "conversionTransactionHash" && keys[j] === "sweepTransactionHash") continue;
    const f = await fixture(); f.native[keys[j]] = f.native[keys[i]];
    f.native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(f.native) });
    await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /distinct receipts/, `${keys[i]} must differ from ${keys[j]}`);
  }
});
test("the recorded finite approval must be a transaction before the source forwarding canary", async () => {
  const f = await fixture(), forwarded = f.receipts.get(hash("forward"))!;
  forwarded.logs.push(...f.receipts.get(hash("approve"))!.logs);
  f.proof.newFiniteAllowance.transactionHash = forwarded.transactionHash;
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /funding and settlement order/);
});
test("different graph, signer, edited scheduler claim and unmatched approval amounts fail closed", async () => {
  const f = await fixture();
  await assert.rejects(() => verifyBuybackActivation(f.client, { ...f.manifest, contracts: { ...f.manifest.contracts, vault: { address: address(777), runtimeHash: hash("vault") } } }, 200n), /another graph/);
  const original = f.control.signature;
  f.control.signature = await stranger.signMessage({ message: governorControlMessage(f.control) });
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /immutable governor/); f.control.signature = original;
  f.proof.newFiniteAllowance.amount = "1"; await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /Approval receipt/); f.proof.newFiniteAllowance.amount = "200000000000000";
  f.native.schedulerRunId = "edited-run"; await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /immutable governor/);
});
test("native acceptance needs linked input, sweep, forward and DEAD transfers rather than manual WETH funding", async () => {
  for (const key of ["collection", "fee", "conversion", "sweep", "forward", "settlement"]) {
    const f = await fixture(); f.receipts.get(hash(key))!.logs = [];
    await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n));
  }
});
test("reorgs, reverted or insufficiently confirmed receipts and legacy reserves block first activation", async () => {
  const f = await fixture(); f.setCanonical(false); await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /canonical/); f.setCanonical(true);
  f.receipts.get(hash("settlement"))!.status = "reverted"; await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /canonical/); f.receipts.get(hash("settlement"))!.status = "success";
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 120n), /confirmed/);
  f.setReserve(1n); await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /reserve/);
});
test("the zero reserve is measured before forwarding, and same-block funding order is checked", async () => {
  const f = await fixture();
  f.proof.legacySwapperCutover = { blockNumber: "26", blockHash: hash("block26"), wethBalance: "0" };
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /funding and settlement order/);
  f.proof.legacySwapperCutover = { blockNumber: "22", blockHash: hash("block22"), wethBalance: "0" };
  const conversion = f.receipts.get(hash("conversion"))!, sweep = f.receipts.get(hash("sweep"))!;
  conversion.blockNumber = sweep.blockNumber; conversion.blockHash = sweep.blockHash; conversion.transactionIndex = 2; sweep.transactionIndex = 1;
  await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /funding and settlement order/);
});
test("contract treasury proofs use EIP-1271 without trying to EOA-recover a multisig signature", async () => {
  const f = await fixture(true); await verifyBuybackActivation(f.client, f.manifest, 200n);
  f.set1271(false); await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /Governor contract rejected/);
});
