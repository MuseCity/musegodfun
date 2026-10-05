import { erc20Abi, keccak256 } from "viem";
import type { LaunchpadService } from "./service";
import { sameAddress, type RuntimeConfig } from "../src/lib/config";
import { minimumOutput, parseAmount } from "../src/lib/validation";
import {
  MUSEGOD, MUSEGOD_QUOTE_TTL, MUSEGOD_ROUTER_VERIFICATION, musegodNetwork,
  musegodPoolAbi, musegodFactoryAbi, musegodPeripheryAbi, musegodQuoterAbi,
  type MusegodInfo, type MusegodQuote,
} from "../src/lib/musegod";

export class MusegodReader {
  constructor(readonly client: LaunchpadService["client"], readonly config: RuntimeConfig,
    readonly assertNetwork: () => Promise<void>, readonly now = Date.now) {}

  private async identity() {
    if (!musegodNetwork(this.config)) throw new Error("MUSEGOD requires the active Robinhood Chain deployment.");
    await this.assertNetwork();
    const block = await this.client.getBlock();
    if (block.number === null || block.hash === null) throw new Error("A confirmed quote block is unavailable.");
    const blockNumber = block.number;
    const [name, symbol, decimals, totalSupply, wethSymbol, wethDecimals, token0, token1, factory, fee, liquidity, slot0,
      canonical, quoterFactory, quoterWeth, quoterCode] = await Promise.all([
      this.client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "name", blockNumber }),
      this.client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "decimals", blockNumber }),
      this.client.readContract({ address: MUSEGOD.token, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
      this.client.readContract({ address: MUSEGOD.weth, abi: erc20Abi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address: MUSEGOD.weth, abi: erc20Abi, functionName: "decimals", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "token0", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "token1", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "factory", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "fee", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "liquidity", blockNumber }),
      this.client.readContract({ address: MUSEGOD.pool, abi: musegodPoolAbi, functionName: "slot0", blockNumber }),
      this.client.readContract({ address: MUSEGOD.factory, abi: musegodFactoryAbi, functionName: "getPool",
        args: [MUSEGOD.token, MUSEGOD.weth, MUSEGOD.fee], blockNumber }),
      this.client.readContract({ address: MUSEGOD.quoter, abi: musegodPeripheryAbi, functionName: "factory", blockNumber }),
      this.client.readContract({ address: MUSEGOD.quoter, abi: musegodPeripheryAbi, functionName: "WETH9", blockNumber }),
      this.client.getCode({ address: MUSEGOD.quoter, blockNumber }),
    ]);
    if (name !== MUSEGOD.name || symbol !== MUSEGOD.symbol || decimals !== 18 || totalSupply <= 0n ||
      wethSymbol !== "WETH" || wethDecimals !== 18 ||
      !sameAddress(String(token0), MUSEGOD.token) || !sameAddress(String(token1), MUSEGOD.weth) ||
      !sameAddress(String(factory), MUSEGOD.factory) || fee !== MUSEGOD.fee ||
      typeof liquidity !== "bigint" || liquidity <= 0n || !Array.isArray(slot0) || slot0[0] <= 0n || slot0[6] !== true ||
      !sameAddress(canonical, MUSEGOD.pool) || !sameAddress(quoterFactory, MUSEGOD.factory) ||
      !sameAddress(quoterWeth, MUSEGOD.weth) || !quoterCode || quoterCode === "0x")
      throw new Error("The MUSEGOD token, SushiSwap pool or periphery identity could not be verified.");
    return { block, totalSupply };
  }
  private async routerIdentity(blockNumber: bigint) {
    const [routerFactory, routerWeth, routerCode] = await Promise.all([
      this.client.readContract({ address: MUSEGOD.router, abi: musegodPeripheryAbi, functionName: "factory", blockNumber }),
      this.client.readContract({ address: MUSEGOD.router, abi: musegodPeripheryAbi, functionName: "WETH9", blockNumber }),
      this.client.getCode({ address: MUSEGOD.router, blockNumber }),
    ]);
    if (!sameAddress(routerFactory, MUSEGOD.factory) || !sameAddress(routerWeth, MUSEGOD.weth) || !routerCode ||
      keccak256(routerCode) !== MUSEGOD_ROUTER_VERIFICATION.runtimeHash)
      throw new Error("The SushiSwap trading router identity changed.");
  }
  private async canonical(block: { number: bigint | null; hash: `0x${string}` | null }) {
    if ((await this.client.getBlock({ blockNumber: block.number! })).hash !== block.hash)
      throw new Error("The MUSEGOD quote block changed. Request a new quote.");
  }
  async info(): Promise<MusegodInfo> {
    let totalSupply: string | null = null;
    let reason: string | null = MUSEGOD_ROUTER_VERIFICATION.verified ? null : MUSEGOD_ROUTER_VERIFICATION.reason;
    try {
      const identity = await this.identity();
      if (MUSEGOD_ROUTER_VERIFICATION.verified) await this.routerIdentity(identity.block.number!);
      await this.canonical(identity.block);
      totalSupply = identity.totalSupply.toString();
      if (!this.config.writesEnabled) reason = this.config.blockReason || "Transactions are currently disabled.";
    } catch {
      reason = "On-chain MUSEGOD identity verification is unavailable. Trading is disabled; try again later.";
    }
    return { name: MUSEGOD.name, symbol: MUSEGOD.symbol, address: MUSEGOD.token, image: MUSEGOD.image,
      description: MUSEGOD.description, quoteAddress: MUSEGOD.weth, poolAddress: MUSEGOD.pool,
      decimals: 18, totalSupply, tradeEnabled: reason === null, tradeBlockReason: reason };
  }
  async quote(side: "buy" | "sell", amount: string, slippageBps: number): Promise<MusegodQuote> {
    if (!["buy", "sell"].includes(side) || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500)
      throw new Error("Invalid MUSEGOD trade direction or slippage.");
    const amountIn = parseAmount(amount, 18);
    if (amountIn >= 2n ** 256n) throw new Error("The input amount is too large.");
    const startedAt = this.now();
    const { block } = await this.identity();
    const { result } = await this.client.simulateContract({ address: MUSEGOD.quoter, abi: musegodQuoterAbi,
      functionName: "quoteExactInputSingle", args: [{
        tokenIn: side === "buy" ? MUSEGOD.weth : MUSEGOD.token,
        tokenOut: side === "buy" ? MUSEGOD.token : MUSEGOD.weth,
        amountIn, fee: MUSEGOD.fee, sqrtPriceLimitX96: 0n,
      }], blockNumber: block.number! });
    const amountOut = result[0];
    if (amountOut <= 0n) throw new Error("Insufficient pool liquidity for a valid MUSEGOD quote.");
    const minAmountOut = minimumOutput(amountOut, slippageBps);
    await this.canonical(block);
    if (this.now() >= startedAt + MUSEGOD_QUOTE_TTL) throw new Error("The quote took too long. Request a new quote.");
    return { protocol: "sushi-v3", chainId: this.config.chainId, deploymentChainId: 4663,
      token: MUSEGOD.token, poolAddress: MUSEGOD.pool, side, amountIn: amountIn.toString(), amountOut: amountOut.toString(),
      minAmountOut: minAmountOut.toString(), slippageBps, quotedAt: startedAt, expiresAt: startedAt + MUSEGOD_QUOTE_TTL,
      blockNumber: block.number!.toString(), blockHash: block.hash! };
  }
}
