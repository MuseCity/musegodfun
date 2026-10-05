// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev ABI-compatible with Doppler SDK 1.0.43 and the pinned Robinhood Bundler.
struct CreateParams {
    uint256 initialSupply;
    uint256 numTokensToSell;
    address numeraire;
    address tokenFactory;
    bytes tokenFactoryData;
    address governanceFactory;
    bytes governanceFactoryData;
    address poolInitializer;
    bytes poolInitializerData;
    address liquidityMigrator;
    bytes liquidityMigratorData;
    address integrator;
    bytes32 salt;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IDopplerBundler {
    struct VestingParams {
        bool permissionlessClaim;
        uint64 vestingDuration;
        uint64 cliffDuration;
    }

    function airlock() external view returns (address);
    function poolManager() external view returns (address);
    function bundle(
        CreateParams calldata createData,
        VestingParams calldata vestingData,
        uint128 exactAmountIn,
        address recipient
    )
        external
        payable
        returns (address asset, PoolKey memory poolKey, address governance, address timelock, uint128 amountOut);
}
