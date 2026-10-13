import test from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, encodeAbiParameters, getContractAddress, type Address, type Hex } from "viem";
import { MUSES, isMuse, nftKey, treasuryFor, vaultFor, ERC6551_REGISTRY, TOKENBOUND_V3_PROXY } from "../src/lib/nft-mode";
import { nftRefSchema, launchSchema, launchFeeSchema } from "../src/lib/validation";
import { ROBINHOOD_STOCKS } from "../src/lib/config";

const muse1 = { chainId: 4663 as const, contract: MUSES.contract, tokenId: "1" };

test("nftKey is canonical and isMuse matches only the Muses contract on Robinhood", () => {
  assert.equal(nftKey(muse1), `4663:${MUSES.contract.toLowerCase()}:1`);
  assert.equal(isMuse(muse1), true);
  assert.equal(isMuse({ ...muse1, chainId: 8453 }), false);
  assert.equal(isMuse({ ...muse1, contract: "0x1111111111111111111111111111111111111111" as Address }), false);
});

test("token ids must be canonical decimal strings below 2^256", () => {
  for (const tokenId of ["007", "0x7", " 7", "7 ", "-1", "1.0", "", (2n ** 256n).toString()])
    assert.equal(nftRefSchema.safeParse({ ...muse1, tokenId }).success, false, tokenId);
  for (const tokenId of ["0", "1", (2n ** 256n - 1n).toString()])
    assert.equal(nftRefSchema.safeParse({ ...muse1, tokenId }).success, true, tokenId);
  assert.equal(nftRefSchema.parse({ ...muse1, contract: MUSES.contract.toLowerCase() }).contract, MUSES.contract);
  assert.equal(nftRefSchema.safeParse({ ...muse1, chainId: 1 }).success, false);
});

test("treasuryFor reproduces the ERC-6551 v0.3.1 registry formula", () => {
  const salt = `0x${"00".repeat(32)}` as Hex;
  const bytecode = `0x3d60ad80600a3d3981f3363d3d373d3d3d363d73${TOKENBOUND_V3_PROXY.slice(2)}5af43d82803e903d91602b57fd5bf3${
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [salt, 4663n, MUSES.contract, 1n]).slice(2)}` as Hex;
  assert.equal(treasuryFor(muse1), getContractAddress({ opcode: "CREATE2", from: ERC6551_REGISTRY, salt, bytecode }));
});

test("vaultFor is the factory CREATE2 address and differs per token", () => {
  const factory = "0x9999999999999999999999999999999999999999" as Address, hash = keccak256("0x01");
  const salt = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [4663n, MUSES.contract, 1n]));
  assert.equal(vaultFor(muse1, factory, hash), getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: hash }));
  assert.notEqual(vaultFor(muse1, factory, hash), vaultFor({ ...muse1, tokenId: "2" }, factory, hash));
});

test("launchSchema accepts optional nft and launchFee and stays strict", () => {
  const weth = ROBINHOOD_STOCKS.find((asset) => asset.symbol === "WETH")!;
  const base = { name: "Bard", symbol: "BARD", description: "", image: "", quoteAddress: weth.address };
  assert.equal(launchSchema.safeParse(base).success, true);
  assert.equal(launchSchema.safeParse({ ...base, nft: muse1 }).success, true);
  assert.equal(launchSchema.safeParse({ ...base, nft: { ...muse1, extra: 1 } }).success, false);
  const fee = { txHash: `0x${"AB".repeat(32)}`, asset: "stable" };
  assert.equal(launchFeeSchema.parse(fee).txHash, `0x${"ab".repeat(32)}`);
  assert.equal(launchFeeSchema.safeParse({ ...fee, asset: "native" }).success, false);
  assert.equal(launchFeeSchema.safeParse({ txHash: fee.txHash, asset: "native", wei: "1", expiresAt: 1, mac: `0x${"cd".repeat(32)}` }).success, true);
  assert.equal(launchSchema.safeParse({ ...base, unknown: true }).success, false);
});

test("the build manifest init-code hash is what vaultFor uses by default", async () => {
  const { NFT_VAULT_MANIFEST } = await import("../src/lib/nft-mode");
  const build = (await import("../contracts/artifacts/nft-vault-build.json", { with: { type: "json" } })).default;
  assert.equal(NFT_VAULT_MANIFEST.vaultInitCodeHash, build.vaultInitCodeHash);
  assert.equal(getAddress(vaultFor(muse1, "0x9999999999999999999999999999999999999999")),
    vaultFor(muse1, "0x9999999999999999999999999999999999999999", build.vaultInitCodeHash as Hex));
});
