import { STOCKS, type TokenRecord } from "../src/lib/config";

// Synthetic records are unit-test input only. They are not deployed assets,
// verified listings, live market pools, or fixtures for the mainnet database.
export function syntheticToken(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    address: "0x1111111111111111111111111111111111111111",
    name: "Synthetic Meme",
    symbol: "SYNTH",
    description: "Synthetic stock-paired unit-test fixture; never deployed",
    image: "",
    quoteAddress: STOCKS[0].address,
    creator: "0x2222222222222222222222222222222222222222",
    poolId: `0x${"a".repeat(64)}`,
    transactionHash: `0x${"b".repeat(64)}`,
    blockNumber: "1",
    createdAt: 1_800_000_000_000,
    openingCap: "100",
    mode: "base",
    ...overrides,
  };
}
