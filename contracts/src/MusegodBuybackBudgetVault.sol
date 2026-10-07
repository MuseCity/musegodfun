// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MusegodFullMath, MusegodTickMath, IMusegodV3OraclePool} from "./MusegodBuybackOracle.sol";
import {IMusegodSplitsSwapper} from "./MusegodBuybackExecutor.sol";

interface IBudgetOracle {
    function weth() external view returns (address);
    function musegod() external view returns (address);
    function museWethPool() external view returns (address);
}
interface IBudgetExecutor {
    function swapper() external view returns (address);
    function weth() external view returns (address);
    function musegod() external view returns (address);
    function execute(uint256 amount, uint256 minProfit, uint256 deadline) external returns (uint256, uint256);
}
interface IBudgetPool is IMusegodV3OraclePool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @notice Holds WETH until an atomic canonical Swapper settlement, with one strict rolling budget.
/// @dev No owner, upgrade, arbitrary withdrawal, destination change or standing allowance.
contract MusegodBuybackBudgetVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant DEAD = address(0xdead);
    uint256 public constant WINDOW_SECONDS = 300;
    uint256 public constant WINDOW_CAP = 0.01 ether;
    uint256 public constant MAX_DEVIATION_BPS = 200;
    IERC20 public immutable weth;
    IERC20 public immutable musegod;
    address public immutable oracle;
    address public immutable swapper;
    IBudgetExecutor public immutable executor;
    IBudgetPool public immutable pool;
    struct Bucket { uint64 timestamp; uint192 spent; }
    Bucket[300] private buckets;
    // FIFO of occupied seconds. Normal execution touches only live/expired entries,
    // rather than every unused second in a 300-slot timestamp ring.
    uint16 private firstBucket;
    uint16 private bucketCount;
    uint64 private latestTimestamp;
    uint256 private activeSpent;
    uint256 public totalSpent;
    uint256 public totalBurned;
    error InvalidConfiguration();
    error InvalidAmount();
    error BudgetExceeded();
    error PriceUnavailable();
    error PriceDeviation();
    error BalanceMismatch();
    event Executed(address indexed caller, uint256 wethAmount, uint256 museToDead, uint256 profit);

    constructor(address weth_, address muse_, address oracle_, address swapper_, address executor_) {
        if (weth_.code.length == 0 || muse_.code.length == 0 || weth_ == muse_ || oracle_.code.length == 0 ||
            swapper_.code.length == 0 || executor_.code.length == 0) revert InvalidConfiguration();
        IBudgetOracle o = IBudgetOracle(oracle_);
        IMusegodSplitsSwapper s = IMusegodSplitsSwapper(swapper_);
        IBudgetExecutor e = IBudgetExecutor(executor_);
        if (o.weth() != weth_ || o.musegod() != muse_ || s.oracle() != oracle_ || s.owner() != address(0) || s.paused() ||
            s.beneficiary() != DEAD || s.tokenToBeneficiary() != muse_ || s.defaultScaledOfferFactor() != 985000 ||
            e.swapper() != swapper_ || e.weth() != weth_ || e.musegod() != muse_) revert InvalidConfiguration();
        weth = IERC20(weth_); musegod = IERC20(muse_); oracle = oracle_; swapper = swapper_; executor = e;
        pool = IBudgetPool(o.museWethPool());
        if (address(pool).code.length == 0 || pool.token0() != (weth_ < muse_ ? weth_ : muse_) ||
            pool.token1() != (weth_ < muse_ ? muse_ : weth_) || pool.fee() != 10000) revert InvalidConfiguration();
    }

    /// @notice Sum in (now - 300 seconds, now], merging arbitrarily many calls in the same second.
    function rollingSpent() public view returns (uint256 used) {
        if (bucketCount == 0 || block.timestamp - latestTimestamp >= WINDOW_SECONDS) return 0;
        used = activeSpent;
        for (uint256 i; i < bucketCount; ++i) {
            Bucket memory b = buckets[(uint256(firstBucket) + i) % WINDOW_SECONDS];
            if (block.timestamp - b.timestamp < WINDOW_SECONDS) break;
            used -= b.spent;
        }
    }

    function _expireBudget() private {
        if (bucketCount == 0) return;
        if (block.timestamp - latestTimestamp >= WINDOW_SECONDS) {
            firstBucket = 0; bucketCount = 0; activeSpent = 0;
            return;
        }
        uint256 used = activeSpent;
        uint16 first = firstBucket;
        uint16 count = bucketCount;
        while (count != 0) {
            Bucket memory b = buckets[first];
            if (block.timestamp - b.timestamp < WINDOW_SECONDS) break;
            used -= b.spent;
            first = uint16((uint256(first) + 1) % WINDOW_SECONDS);
            --count;
        }
        if (first != firstBucket) { firstBucket = first; bucketCount = count; activeSpent = used; }
    }

    function _spendBudget(uint256 amount) private {
        _expireBudget();
        if (amount > WINDOW_CAP - activeSpent) revert BudgetExceeded();
        uint256 index;
        if (bucketCount != 0 && latestTimestamp == block.timestamp) {
            index = (uint256(firstBucket) + bucketCount - 1) % WINDOW_SECONDS;
            buckets[index].spent += uint192(amount);
        } else {
            // At most 300 distinct live seconds fit in (now - 300, now].
            assert(bucketCount < WINDOW_SECONDS);
            index = (uint256(firstBucket) + bucketCount) % WINDOW_SECONDS;
            buckets[index] = Bucket(uint64(block.timestamp), uint192(amount));
            ++bucketCount;
            latestTimestamp = uint64(block.timestamp);
        }
        activeSpent += amount;
    }

    function available() external view returns (uint256) {
        uint256 remaining = WINDOW_CAP - rollingSpent();
        uint256 balance = weth.balanceOf(address(this));
        return balance < remaining ? balance : remaining;
    }

    function checkPrices() public view returns (uint256 spot, uint256 shortTwap, uint256 longTwap) {
        if (pool.liquidity() == 0) revert PriceUnavailable();
        (uint160 sqrtPrice,,,,,,) = pool.slot0();
        uint32[] memory ago = new uint32[](3); ago[0] = 1800; ago[1] = 300;
        (int56[] memory ticks, uint160[] memory liquidity) = pool.observe(ago);
        if (ticks.length != 3 || liquidity.length != 3) revert PriceUnavailable();
        spot = _quote(sqrtPrice);
        shortTwap = _quote(MusegodTickMath.getSqrtRatioAtTick(_mean(ticks[2], ticks[1], 300)));
        longTwap = _quote(MusegodTickMath.getSqrtRatioAtTick(_mean(ticks[2], ticks[0], 1800)));
        uint256 low = spot < shortTwap ? spot : shortTwap;
        if (longTwap < low) low = longTwap;
        uint256 high = spot > shortTwap ? spot : shortTwap;
        if (longTwap > high) high = longTwap;
        if (low == 0) revert PriceUnavailable();
        if (high - low > MusegodFullMath.mulDiv(low, MAX_DEVIATION_BPS, 10_000)) revert PriceDeviation();
    }

    function _mean(int56 recent, int56 older, int56 duration) private pure returns (int24) {
        int56 delta; unchecked { delta = recent - older; }
        int56 mean = delta / duration;
        if (delta < 0 && delta % duration != 0) --mean;
        if (mean < -887272 || mean > 887272) revert PriceUnavailable();
        return int24(mean);
    }

    function _quote(uint160 sqrtPrice) private view returns (uint256) {
        if (sqrtPrice == 0) revert PriceUnavailable();
        if (sqrtPrice <= type(uint128).max) {
            uint256 ratio = uint256(sqrtPrice) * sqrtPrice;
            return address(weth) < address(musegod) ? MusegodFullMath.mulDiv(ratio, 1e18, 1 << 192) : MusegodFullMath.mulDiv(1 << 192, 1e18, ratio);
        }
        uint256 ratio128 = MusegodFullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 64);
        return address(weth) < address(musegod) ? MusegodFullMath.mulDiv(ratio128, 1e18, 1 << 128) : MusegodFullMath.mulDiv(1 << 128, 1e18, ratio128);
    }

    function execute(uint256 amount, uint256 minProfit, uint256 deadline) external nonReentrant returns (uint256 burned, uint256 profit) {
        if (amount == 0 || amount > weth.balanceOf(address(this))) revert InvalidAmount();
        _spendBudget(amount);
        checkPrices();
        uint256 ownBefore = weth.balanceOf(address(this));
        uint256 swapperBefore = weth.balanceOf(swapper);
        uint256 museBefore = musegod.balanceOf(address(this));
        uint256 deadBefore = musegod.balanceOf(DEAD);
        weth.safeTransfer(swapper, amount);
        if (weth.balanceOf(address(this)) != ownBefore - amount || weth.balanceOf(swapper) != swapperBefore + amount) revert BalanceMismatch();
        (burned, profit) = executor.execute(amount, minProfit, deadline);
        if (burned == 0 || profit < minProfit || weth.balanceOf(address(this)) != ownBefore - amount ||
            weth.balanceOf(swapper) != swapperBefore || musegod.balanceOf(address(this)) != museBefore + profit ||
            musegod.balanceOf(DEAD) != deadBefore + burned) revert BalanceMismatch();
        if (profit != 0) {
            uint256 callerBefore = musegod.balanceOf(msg.sender);
            musegod.safeTransfer(msg.sender, profit);
            if (musegod.balanceOf(msg.sender) != callerBefore + profit) revert BalanceMismatch();
        }
        if (musegod.balanceOf(address(this)) != museBefore) revert BalanceMismatch();
        totalSpent += amount; totalBurned += burned;
        emit Executed(msg.sender, amount, burned, profit);
    }
}
