import { parseAbi } from "viem";

// Exact official CreateParams order, shared with the immutable Solidity wrapper.
export const launchGuardAbi = parseAbi([
  "struct CreateParams { uint256 initialSupply; uint256 numTokensToSell; address numeraire; address tokenFactory; bytes tokenFactoryData; address governanceFactory; bytes governanceFactoryData; address poolInitializer; bytes poolInitializerData; address liquidityMigrator; bytes liquidityMigratorData; address integrator; bytes32 salt; }",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function bundler() view returns (address)",
  "function createAndBuy(CreateParams createData, uint128 amountIn, uint128 minAmountOut, uint256 deadline) returns (address asset, PoolKey poolKey, address governance, address timelock, uint128 amountOut)",
  "function createAndBuyLocked(CreateParams createData, uint128 amountIn, uint128 minAmountOut, uint256 deadline, uint16 lockDays) returns (address asset, PoolKey poolKey, address governance, address timelock, uint128 amountOut)",
  "event GuardedLaunch(address indexed creator,address indexed asset,address indexed numeraire,uint128 amountIn,uint128 amountOut,uint128 minAmountOut,uint256 deadline,bytes32 poolId)",
]);
