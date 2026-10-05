import { encodeAbiParameters, keccak256, parseUnits, type Address, type Hex } from "viem";
export const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31" as Address;
export const RELAY_APPROVAL_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be" as Address;

export type BuybackStepKind = "approval" | "deposit" | "burn";
export type BuybackStep = {
  batchId: string;
  kind: BuybackStepKind;
  chainId: 8453 | 4663;
  from: Address;
  to: Address;
  data: Hex;
  value: string;
  expiresAt: number;
  amount: string;
  stockAddress: Address;
  nonce?: number;
};
export type BuybackBatch = {
  id: string;
  quote: BuybackQuote;
  status: "prepared" | "approval_pending" | "deposit_pending" | "bridging" |
    "received" | "burn_pending" | "burned" | "failed" | "refunded" | "reorg" | "expired";
  nextStep: BuybackStepKind | null;
  createdAt: number;
  updatedAt: number;
  receivedAmount: string;
  burnedAmount: string;
  hashes: Partial<Record<BuybackStepKind, Hex>>;
  destinationHash?: Hex;
  error?: string;
  fundingSource: "treasury_allocation";
  claimHashes: Hex[];
  cancellations?: { kind: BuybackStepKind; hash: Hex; blockHash: Hex; blockNumber: string;
    status: "success" | "reverted"; nonce: number; verifiedCanonical: boolean }[];
};

// Amounts without a Formatted suffix are integer smallest-unit strings.
// A preview contains no executable transaction or wallet-signing request.
export type BuybackQuoteInput = { stockAddress: string; amount: string };
export type BuybackPrepareInput = BuybackQuoteInput & { claimHashes?: Hex[] };
export type BuybackAuthorization = { nonce: Hex; expiresAt: number; signature: Hex };

// This authorizes only a bounded batch record. Each on-chain step still requires
// a separate wallet confirmation; connection itself never requests a signature.
export function buybackAuthorizationTypedData(input: BuybackPrepareInput, treasury: Address, nonce: Hex, expiresAt: number) {
  return {
    domain: { name: "MuseGod Buyback", version: "1", chainId: 8453 },
    primaryType: "PrepareBuyback" as const,
    types: { PrepareBuyback: [
      { name: "intent", type: "string" }, { name: "app", type: "string" },
      { name: "treasury", type: "address" }, { name: "stock", type: "address" },
      { name: "amountIn", type: "uint256" }, { name: "claimHashesHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" }, { name: "expiresAt", type: "uint256" },
    ] },
    message: {
      intent: "Prepare a manual MUSEGOD buyback batch", app: "musegod.fun",
      treasury, stock: input.stockAddress as Address, amountIn: parseUnits(input.amount, 8),
      claimHashesHash: keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [input.claimHashes ?? []])),
      nonce, expiresAt: BigInt(expiresAt),
    },
  } as const;
}

export type BuybackQuote = {
  source: "Relay";
  requestId: string;
  quotedAt: number;
  expiresAt: number;
  originChainId: 8453;
  destinationChainId: 4663;
  treasury: Address;
  destinationRecipient: Address;
  burnAddress: Address;
  refundTo: Address;
  stockAddress: Address;
  stockSymbol: string;
  stockDecimals: 8;
  amountIn: string;
  amountInFormatted: string;
  tokenAddress: Address;
  tokenDecimals: 18;
  expectedOut: string;
  minimumOut: string;
  expectedOutFormatted: string;
  minimumOutFormatted: string;
  slippageBps: 100;
  totalImpactPercent: string | null;
  relayerFeeUsd: string | null;
  gasFeeUsd: string | null;
  refundCurrencies: { chainId: number; address: Address; minimumAmount: string; deadline: number }[];
  executionAvailable: false;
  requiresSeparateBurn: true;
};

export type MUSEGODStats = {
  source: "Robinhood Chain RPC";
  chainId: 4663;
  tokenAddress: Address;
  burnAddress: Address;
  symbol: "MUSEGOD";
  decimals: 18;
  totalSupply: string;
  deadBalance: string;
  blockNumber: string;
  checkedAt: number;
  scope: "global";
};
