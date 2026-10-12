import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, hashMessage, keccak256, multicall3Abi, parseAbi, parseEventLogs, recoverMessageAddress, toBytes, toHex, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import pending from "../contracts/artifacts/buyback-v2-deployment.json";
import { buybackGraphFingerprint, governorControlMessage, nativeAcceptanceMessage, verifyBuybackActivation, verifyRecordedBuybackActivation, recordFinalizedBuybackActivation, buybackActivationRecordBinding, type FinalizedBuybackActivation, type BuybackActivation, type GovernorControlProof, type NativeAcceptanceProof } from "../server/buyback-activation";
import type { BuybackDeployment } from "../server/buyback-engine";
import governorJson from "./fixtures/governor-control-manifest.json";
import { LaunchpadService } from "../server/service";
import { feeEngineAbi } from "../src/lib/buyback-engine";

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
  const manifest: BuybackDeployment = { ...pending, activationVerification: undefined, status: "deployed_verified", constants: { ...pending.constants, treasury: contractGovernor ? address(999) : governor.address },
    contracts: Object.fromEntries(names.map((name) => [name, { address: nodes[name], runtimeHash: hash(name) }])) as BuybackDeployment["contracts"] };
  const fingerprint = buybackGraphFingerprint(manifest), source = getAddress(manifest.constants.automationTreasury!), automation = getAddress(manifest.constants.automation!), weth = getAddress(manifest.constants.weth), muse = getAddress(manifest.constants.muse), dead = getAddress(manifest.constants.beneficiary), asset = address(500);
  const ref = (name: string) => ({ chainId: 4663, graphFingerprint: fingerprint, transactionHash: hash(name) });
  const control: GovernorControlProof = { chainId: 4663, graphFingerprint: fingerprint, blockNumber: "100", blockHash: hash("block100"), signer: contractGovernor ? address(999) : governor.address, signature: "0x" };
  control.signature = await governor.signMessage({ message: governorControlMessage(control) });
  const native: NativeAcceptanceProof = { chainId: 4663, graphFingerprint: fingerprint, ruleId: "native-rule-id", schedulerRunId: "native-scheduled-run-id", evidenceUri: "https://example.test/native-scheduled-run.json", evidenceSha256: hash("reviewed external native scheduler evidence"),
    unpricedToken: asset, inputAmount: "100", wethAmount: "100000000000000", feeCollectionTransactionHash: hash("collection"), feeTransactionHash: hash("fee"), conversionTransactionHash: hash("conversion"), sweepTransactionHash: hash("sweep"), forwardTransactionHash: hash("forward"), settlementTransactionHash: hash("settlement"), signer: control.signer, signature: "0x" };
  native.signature = await governor.signMessage({ message: nativeAcceptanceMessage(native) });
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
    getBlock: async (parameters: { blockNumber: bigint } | { blockTag: "finalized" }) => {
      const number = "blockNumber" in parameters ? parameters.blockNumber : 200n;
      return { number, hash: canonical ? hash(`block${number}`) : hash("orphan") };
    },
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
  f.proof.newFiniteAllowance.amount = "200000000000001"; await assert.rejects(() => verifyBuybackActivation(f.client, f.manifest, 200n), /Approval receipt/); f.proof.newFiniteAllowance.amount = "200000000000000";
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

type ActivationClient = Parameters<typeof verifyBuybackActivation>[0];
type ActivationFixture = Awaited<ReturnType<typeof fixture>>;
const jsonManifest = (manifest: BuybackDeployment): BuybackDeployment => JSON.parse(JSON.stringify(manifest));
function coldRecordClient(f: ActivationFixture) {
  const reads = { receipts: 0, logs: 0, historicalBalances: 0, authority: 0, headers: [] as bigint[] };
  const client = { ...f.client,
    getTransactionReceipt: async () => { reads.receipts++; throw new Error("Historical receipt access is deliberately unavailable"); },
    getLogs: async () => { reads.logs++; throw new Error("Historical logs are deliberately unavailable"); },
    readContract: async (parameters: Parameters<typeof f.client.readContract>[0]) => {
      if (parameters.functionName !== "isValidSignature") { reads.historicalBalances++; throw new Error("Historical token balances/counters are deliberately unavailable"); }
      reads.authority++; return f.client.readContract(parameters);
    },
    getBlock: async (parameters: Parameters<typeof f.client.getBlock>[0]) => {
      assert("blockNumber" in parameters, "Runtime does not request a new finalized tag or historical replay");
      reads.headers.push(parameters.blockNumber); return f.client.getBlock(parameters);
    },
  } as unknown as ActivationClient;
  return { client, reads };
}
function noHistoricalReads(reads: ReturnType<typeof coldRecordClient>["reads"]) {
  assert.deepEqual({ receipts: reads.receipts, logs: reads.logs, historicalBalances: reads.historicalBalances }, { receipts: 0, logs: 0, historicalBalances: 0 });
}
async function persistedFixture(contractGovernor = false) {
  const f = await fixture(contractGovernor);
  // The fixture signs both messages with a real local key. Contract authority
  // and complete receipt execution remain simulations, never mainnet evidence.
  const record = await recordFinalizedBuybackActivation(f.client, f.manifest, 200n);
  f.manifest.activationVerification = record;
  return { ...f, record };
}

test("one-time producer captures every financial/control anchor and finalized canonical header before returning", async () => {
  const f = await fixture(), prior = structuredClone(f.manifest);
  const record = await recordFinalizedBuybackActivation(f.client, f.manifest, 200n);
  assert.deepEqual(f.manifest, prior, "The producer returns metadata; its caller decides when to atomically publish it");
  assert.equal(record.status, "verified"); assert.equal(record.version, 1); assert.equal(record.chainId, 4663);
  assert.equal(record.binding, buybackActivationRecordBinding(f.manifest)); assert.equal(record.fingerprint, f.proof.graphFingerprint);
  assert.equal(record.activatedAtBlock, "27"); assert(record.verifiedAt > 0);
  assert.deepEqual(record.anchors, [20, 21, 22, 23, 24, 25, 26, 27, 100].map(number => ({ number: String(number), hash: hash(`block${number}`) })));
  assert.deepEqual(record.finalized, { number: "200", hash: hash("block200") });
});

test("a JSON-saved record survives a new client with receipt/log/historical-balance access disabled", async () => {
  const f = await persistedFixture(), saved = jsonManifest(f.manifest), cold = coldRecordClient(f);
  assert.equal((await verifyRecordedBuybackActivation(cold.client, saved, 240n)).activatedAtBlock, "27");
  assert.deepEqual(cold.reads.headers, [200n]); noHistoricalReads(cold.reads);
  assert.deepEqual(saved, jsonManifest(f.manifest), "Ordinary verification does not replace the published record");
});

test("cold recorded verification preserves live EIP-1271 revocation checks with real local signature bytes", async () => {
  const f = await persistedFixture(true), cold = coldRecordClient(f), saved = jsonManifest(f.manifest);
  await verifyRecordedBuybackActivation(cold.client, saved, 240n); assert.equal(cold.reads.authority, 2);
  f.set1271(false);
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, saved, 240n), /Governor contract rejected/);
  noHistoricalReads(cold.reads);
});

for (const [name, old] of [
  ["missing", undefined],
  ["legacy passed-only", { status: "verified", fingerprint: hash("unbound"), activatedAtBlock: "27" }],
  ["legacy cached annotation", { status: "verified", finalized: { number: "200", hash: hash("block200") }, cached: true }],
] as const) test(`${name} record cannot trigger an automatic historical acceptance replay`, async () => {
  const f = await fixture(), cold = coldRecordClient(f);
  f.manifest.activationVerification = old;
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, f.manifest, 200n), /activation record/);
  noHistoricalReads(cold.reads); assert.equal(cold.reads.headers.length, 0);
});

const financialMutations: [string, (manifest: BuybackDeployment) => void][] = [
  ["fixed custody recipient", m => { m.constants.automationTreasury = address(707); }],
  ["canonical WETH asset", m => { m.constants.weth = address(708); }],
  ["contract runtime", m => { m.contracts.forwarder.runtimeHash = hash("changed runtime"); }],
  ["native Automation output", m => { m.automation!.outputToken = address(709); }],
  ["asset pricing description", m => { Object.values(m.assetFeedDescriptions!)[0].descriptionHash = hash("changed feed description"); }],
  ["finite approval amount", m => { (m.activation as BuybackActivation).newFiniteAllowance.amount = "200000000000001"; }],
  ["fee input amount", m => { (m.activation as BuybackActivation).nativeAutomationAcceptance.inputAmount = "101"; }],
  ["fee receipt reference", m => { (m.activation as BuybackActivation).nativeAutomationAcceptance.feeTransactionHash = hash("other fee"); }],
  ["native scheduling signature input", m => { (m.activation as BuybackActivation).nativeAutomationAcceptance.schedulerRunId = "different run"; }],
  ["governor control block", m => { (m.governance!.controlProof as GovernorControlProof).blockHash = hash("changed governor block"); }],
  ["governor signature", m => { (m.governance!.controlProof as GovernorControlProof).signature = "0x1234"; }],
];
for (const [name, mutate] of financialMutations) test(`persisted activation rejects a changed ${name} without historical fallback`, async () => {
  const f = await persistedFixture(), saved = jsonManifest(f.manifest), cold = coldRecordClient(f);
  const binding = buybackActivationRecordBinding(saved); mutate(saved);
  assert.notEqual(buybackActivationRecordBinding(saved), binding);
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, saved, 240n), /activation record/);
  noHistoricalReads(cold.reads);
});

const recordMutations: [string, (record: FinalizedBuybackActivation) => void][] = [
  ["legacy version", r => { (r as { version: number }).version = 0; }],
  ["wrong chain", r => { (r as { chainId: number }).chainId = 8453; }],
  ["binding", r => { r.binding = hash("wrong binding"); }],
  ["fingerprint", r => { r.fingerprint = hash("wrong graph"); }],
  ["missing anchors", r => { r.anchors = []; }],
  ["duplicate anchors", r => { r.anchors.push({ ...r.anchors[0] }); }],
  ["missing control anchor", r => { r.anchors = r.anchors.filter(a => a.number !== "100"); }],
  ["missing cutover anchor", r => { r.anchors = r.anchors.filter(a => a.number !== "22"); }],
  ["missing settlement anchor", r => { r.anchors = r.anchors.filter(a => a.number !== "27"); }],
  ["anchor beyond finalized", r => { r.anchors.push({ number: "201", hash: hash("block201") }); }],
  ["malformed block number", r => { r.finalized.number = "0200"; }],
  ["finalized hash", r => { r.finalized.hash = hash("wrong finalized header"); }],
  ["invalid timestamp", r => { r.verifiedAt = 0; }],
];
for (const [name, mutate] of recordMutations) test(`invalid recorded ${name} is withheld without receipt/log/balance reads`, async () => {
  const f = await persistedFixture(), saved = jsonManifest(f.manifest), cold = coldRecordClient(f);
  mutate(saved.activationVerification as FinalizedBuybackActivation);
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, saved, 240n), /activation record/);
  noHistoricalReads(cold.reads);
});

test("recorded finalized-header reorg, lagging head, insufficient depth and wrong RPC chain all withhold activation", async () => {
  const f = await persistedFixture(), cold = coldRecordClient(f), saved = jsonManifest(f.manifest);
  f.setCanonical(false); await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, saved, 240n), /activation record/); f.setCanonical(true);
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, saved, 199n), /activation record/);
  const shallow = jsonManifest(saved), record = shallow.activationVerification as FinalizedBuybackActivation;
  record.finalized = { number: "160", hash: hash("block160") };
  await assert.rejects(() => verifyRecordedBuybackActivation(cold.client, shallow, 163n), /activation record/);
  await assert.rejects(() => verifyRecordedBuybackActivation({ ...cold.client, getChainId: async () => 8453 }, saved, 240n), /Robinhood chain/);
  noHistoricalReads(cold.reads);
});

test("a valid repeated producer returns the same durable record with no historical replay", async () => {
  const f = await persistedFixture(true), cold = coldRecordClient(f), saved = jsonManifest(f.manifest);
  assert.deepEqual(await recordFinalizedBuybackActivation(cold.client, saved, 240n), f.record);
  assert.deepEqual(cold.reads.headers, [200n]); assert.equal(cold.reads.authority, 2); noHistoricalReads(cold.reads);
});

for (const failure of ["finalized unsupported", "not finalized", "finalized ahead", "wrong finalized hash", "receipt RPC failure", "anchor changed on recheck", "sampled head changed", "contract authority revoked after replay", "head changes during final authority"] as const)
  test(`producer ${failure} leaves prior manifest metadata untouched`, async () => {
    const f = await fixture(failure === "contract authority revoked after replay");
    const old = { status: "verified", legacyEvidence: "retained historical metadata" };
    f.manifest.activationVerification = old;
    const prior = jsonManifest(f.manifest); let controlReads = 0, headReads = 0, authorityReads = 0;
    const client = { ...f.client,
      getCode: async (parameters: Parameters<typeof f.client.getCode>[0]) => {
        if (++authorityReads === 2 && failure === "head changes during final authority") f.setCanonical(false);
        return f.client.getCode(parameters);
      },
      getTransactionReceipt: async (parameters: Parameters<typeof f.client.getTransactionReceipt>[0]) => {
        if (failure === "receipt RPC failure") throw new Error("temporary archive RPC failure");
        return f.client.getTransactionReceipt(parameters);
      },
      getBlock: async (parameters: Parameters<typeof f.client.getBlock>[0]) => {
        if ("blockTag" in parameters) {
          if (failure === "finalized unsupported") throw new Error("finalized temporarily unsupported");
          if (failure === "not finalized") return { number: 99n, hash: hash("block99") };
          if (failure === "finalized ahead") return { number: 201n, hash: hash("block201") };
          if (failure === "wrong finalized hash") return { number: 200n, hash: hash("wrong checkpoint") };
          if (failure === "contract authority revoked after replay") f.set1271(false);
        } else {
          if (parameters.blockNumber === 100n && ++controlReads > 1 && failure === "anchor changed on recheck") return { number: 100n, hash: hash("reorganized control") };
          if (parameters.blockNumber === 200n && ++headReads > 1 && failure === "sampled head changed") return { number: 200n, hash: hash("reorganized head") };
        }
        return f.client.getBlock(parameters);
      },
    } as ActivationClient;
    await assert.rejects(() => recordFinalizedBuybackActivation(client, f.manifest, 200n));
    assert.deepEqual(f.manifest, prior); assert.equal(f.manifest.activationVerification, old);
  });

test("explicit full tools keep rereading history and retain their negative checks after a record exists", async () => {
  const f = await persistedFixture(), savedRecord = structuredClone(f.record); let receipts = 0;
  const client = { ...f.client, getTransactionReceipt: async (parameters: Parameters<typeof f.client.getTransactionReceipt>[0]) => {
    receipts++; return f.client.getTransactionReceipt(parameters);
  } } as ActivationClient;
  await verifyBuybackActivation(client, f.manifest, 200n);
  await verifyBuybackActivation(client, f.manifest, 200n);
  assert.equal(receipts, 16, "An explicit full tool has no cross-call finalized evidence cache");
  f.setReserve(1n); await assert.rejects(() => verifyBuybackActivation(client, f.manifest, 200n), /reserve/); f.setReserve(0n);
  f.receipts.get(hash("settlement"))!.status = "reverted";
  await assert.rejects(() => verifyBuybackActivation(client, f.manifest, 200n), /canonical/);
  await assert.rejects(() => verifyBuybackActivation({ ...client, getTransactionReceipt: async () => { throw new Error("temporary archive RPC failure"); } }, f.manifest, 200n), /temporary archive RPC failure/);
  assert.deepEqual(f.manifest.activationVerification, savedRecord);
});

test("one-time complete activation proof batches RPC while a cold persisted record reads only authority and one header", async (context) => {
  // Synthetic RPC receipts exercise the actual viem HTTP transport and all
  // activation checks. They are not mainnet execution evidence.
  const f = await fixture();
  const runtime = {
    config: { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: false, blockReason: null },
    rpcUrl: "https://rpc.fixture.test", dataDir: ".unused-test-store", dataScope: "robinhood",
    launchGuardCandidate: null, firstBuyGuardCandidate: null, lifi: { integrator: "musegodfun" },
    supabase: { url: "https://fixture.supabase.co", secretKey: "fixture-only" },
  } as ConstructorParameters<typeof LaunchpadService>[0];
  const service = new LaunchpadService(runtime);
  let fetches = 0;
  const warmMethods: string[] = [];
  let warm = false;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    fetches++;
    const requests = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as { id: number; method: string; params: unknown[] }[];
    assert(Array.isArray(requests)); assert(requests.length <= 20);
    const responses = requests.map((item) => {
      if (warm) warmMethods.push(item.method);
      let result: unknown;
      if (item.method === "eth_chainId") result = "0x1237";
      else if (item.method === "eth_getCode") result = "0x";
      else if (item.method === "eth_getBlockByNumber") {
        const number = item.params[0] === "finalized" ? 200n : BigInt(String(item.params[0]));
        result = { number: toHex(number), hash: hash(`block${number}`), transactions: [], timestamp: "0x0" };
      } else if (item.method === "eth_getTransactionReceipt") {
        const r = f.receipts.get(item.params[0] as Hex)!;
        assert(r);
        result = { ...r, from: governor.address, to: f.nodes.engine, type: "0x2", status: r.status === "success" ? "0x1" : "0x0",
          blockNumber: toHex(r.blockNumber), transactionIndex: toHex(r.transactionIndex), cumulativeGasUsed: "0x0", gasUsed: "0x0", effectiveGasPrice: "0x0",
          logs: r.logs.map((log) => ({ ...log, transactionHash: r.transactionHash, blockHash: r.blockHash, blockNumber: toHex(r.blockNumber), transactionIndex: toHex(r.transactionIndex), logIndex: toHex(log.logIndex), removed: false })) };
      } else {
        assert.equal(item.method, "eth_call");
        const data = (item.params[0] as { data: Hex }).data;
        const read = (calldata: Hex) => {
          const decoded = decodeFunctionData({ abi: [...erc20Abi, ...feeEngineAbi], data: calldata });
          assert(["balanceOf", "totalAutomationForwarded"].includes(decoded.functionName));
          const amount = decoded.functionName === "balanceOf" || BigInt(String(item.params[1])) < 23n ? 0n : 100n;
          return encodeAbiParameters([{ type: "uint256" }], [amount]);
        };
        if (data.startsWith("0x82ad56cb")) {
          const aggregate = decodeFunctionData({ abi: multicall3Abi, data });
          assert.equal(aggregate.functionName, "aggregate3");
          result = encodeAbiParameters([{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
            [aggregate.args![0].map((call) => ({ success: true, returnData: read(call.callData) }))]);
        } else result = read(data);
      }
      return { jsonrpc: "2.0", id: item.id, result };
    });
    return Response.json(responses.reverse());
  });
  const record = await recordFinalizedBuybackActivation(service.client, f.manifest, 200n);
  assert.equal(record.activatedAtBlock, "27");
  assert(fetches <= 12, `One-time producer uses bounded HTTP batches (${fetches} fetches)`);
  f.manifest.activationVerification = record;
  const cold = fetches;
  warm = true;
  const coldService = new LaunchpadService(runtime);
  assert.equal((await verifyRecordedBuybackActivation(coldService.client, JSON.parse(JSON.stringify(f.manifest)), 240n)).activatedAtBlock, "27");
  assert(fetches - cold <= 2);
  assert.deepEqual(warmMethods.sort(), ["eth_chainId", "eth_getBlockByNumber", "eth_getCode"], "A new process reads only live governor authority and the recorded finalized header");
});
