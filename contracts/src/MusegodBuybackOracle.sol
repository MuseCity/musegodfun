// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev ABI-compatible with 0xSplits LibQuotes (GPL-3.0-or-later).
struct MusegodQuotePair {
    address base;
    address quote;
}

struct MusegodQuoteParams {
    MusegodQuotePair quotePair;
    uint128 baseAmount;
    bytes data;
}

interface IMusegodAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IMusegodOraclePaused {
    function oraclePaused() external view returns (bool);
}

interface IMusegodV3OraclePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
}

interface IMusegodV3OracleFactory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice Fixed USD-feed conversion prices and a thirty-minute WETH/MUSEGOD TWAP.
/// @dev No owner or mutable configuration. Equity feed answers already include the issuer multiplier.
contract MusegodBuybackOracle {
    struct AssetFeedConfig {
        address token;
        address feed;
        uint32 maxAge;
        bool checkOraclePaused;
    }

    struct AssetFeed {
        address feed;
        uint32 maxAge;
        uint8 tokenDecimals;
        uint8 feedDecimals;
        bool checkOraclePaused;
    }

    uint32 public constant TWAP_SECONDS = 1800;
    uint32 public constant MAX_FEED_AGE = 86400;
    address public immutable weth;
    address public immutable musegod;
    IMusegodV3OraclePool public immutable museWethPool;
    IMusegodAggregatorV3 public immutable ethUsdFeed;
    uint32 public immutable ethMaxAge;
    uint8 public immutable ethFeedDecimals;
    mapping(address => AssetFeed) public assetFeeds;

    error InvalidConfiguration();
    error UnsupportedAsset(address token);
    error InvalidFeed(address feed);
    error StaleFeed(address feed);
    error OraclePaused(address token);
    error InvalidQuote();
    error InvalidTwap();
    error ZeroQuote();

    constructor(
        address weth_,
        address musegod_,
        address museWethPool_,
        address ethUsdFeed_,
        uint32 ethMaxAge_,
        AssetFeedConfig[] memory configs
    ) {
        if (
            weth_ == musegod_ || weth_.code.length == 0 || musegod_.code.length == 0 || museWethPool_.code.length == 0
                || ethUsdFeed_.code.length == 0 || ethMaxAge_ == 0 || ethMaxAge_ > MAX_FEED_AGE
                || IERC20Metadata(weth_).decimals() != 18 || IERC20Metadata(musegod_).decimals() != 18
        ) revert InvalidConfiguration();
        IMusegodV3OraclePool pool = IMusegodV3OraclePool(museWethPool_);
        address token0 = weth_ < musegod_ ? weth_ : musegod_;
        address token1 = weth_ < musegod_ ? musegod_ : weth_;
        address factory = pool.factory();
        if (
            pool.token0() != token0 || pool.token1() != token1 || pool.fee() != 10000 || factory.code.length == 0
                || IMusegodV3OracleFactory(factory).getPool(weth_, musegod_, 10000) != museWethPool_
        ) {
            revert InvalidConfiguration();
        }
        uint8 ethDecimals = IMusegodAggregatorV3(ethUsdFeed_).decimals();
        if (ethDecimals > 18) revert InvalidConfiguration();
        weth = weth_;
        musegod = musegod_;
        museWethPool = pool;
        ethUsdFeed = IMusegodAggregatorV3(ethUsdFeed_);
        ethMaxAge = ethMaxAge_;
        ethFeedDecimals = ethDecimals;
        for (uint256 i; i < configs.length; ++i) {
            AssetFeedConfig memory c = configs[i];
            if (
                c.token == weth_ || c.token == musegod_ || c.token.code.length == 0 || c.feed.code.length == 0
                    || c.maxAge == 0 || c.maxAge > MAX_FEED_AGE || assetFeeds[c.token].feed != address(0)
            ) revert InvalidConfiguration();
            uint8 tokenDecimals = IERC20Metadata(c.token).decimals();
            uint8 feedDecimals = IMusegodAggregatorV3(c.feed).decimals();
            if (tokenDecimals > 18 || feedDecimals > 18) revert InvalidConfiguration();
            if (c.checkOraclePaused) IMusegodOraclePaused(c.token).oraclePaused();
            assetFeeds[c.token] = AssetFeed(c.feed, c.maxAge, tokenDecimals, feedDecimals, c.checkOraclePaused);
        }
    }

    function quoteToWeth(address token, uint256 amount) external view returns (uint256 quote) {
        if (amount == 0) revert ZeroQuote();
        if (token == weth) return amount;
        AssetFeed memory c = assetFeeds[token];
        if (c.feed == address(0)) revert UnsupportedAsset(token);
        if (c.checkOraclePaused && IMusegodOraclePaused(token).oraclePaused()) revert OraclePaused(token);
        uint256 tokenUsd = _price(IMusegodAggregatorV3(c.feed), c.feedDecimals, c.maxAge);
        uint256 ethUsd = _price(ethUsdFeed, ethFeedDecimals, ethMaxAge);
        uint256 usdValue = MusegodFullMath.mulDiv(amount, tokenUsd, 10 ** c.tokenDecimals);
        quote = MusegodFullMath.mulDiv(usdValue, 1e18, ethUsd);
        if (quote == 0) revert ZeroQuote();
    }

    function quoteWethToMuse(uint256 amount) public view returns (uint256 quote) {
        if (amount == 0 || amount > type(uint128).max) revert InvalidQuote();
        if (museWethPool.liquidity() == 0) revert InvalidTwap();
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_SECONDS;
        (int56[] memory ticks, uint160[] memory secondsPerLiquidity) = museWethPool.observe(secondsAgos);
        if (ticks.length != 2 || secondsPerLiquidity.length != 2) revert InvalidTwap();
        // Uniswap cumulative counters intentionally wrap at their respective widths.
        int56 delta;
        uint160 liquidityDelta;
        unchecked {
            delta = ticks[1] - ticks[0];
            liquidityDelta = secondsPerLiquidity[1] - secondsPerLiquidity[0];
        }
        if (liquidityDelta == 0) revert InvalidTwap();
        int56 mean = delta / int56(uint56(TWAP_SECONDS));
        if (delta < 0 && delta % int56(uint56(TWAP_SECONDS)) != 0) --mean;
        if (mean < -887272 || mean > 887272) revert InvalidTwap();
        uint160 sqrtRatio = MusegodTickMath.getSqrtRatioAtTick(int24(mean));
        if (sqrtRatio <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatio) * sqrtRatio;
            quote = weth < musegod
                ? MusegodFullMath.mulDiv(ratioX192, amount, 1 << 192)
                : MusegodFullMath.mulDiv(1 << 192, amount, ratioX192);
        } else {
            uint256 ratioX128 = MusegodFullMath.mulDiv(sqrtRatio, sqrtRatio, 1 << 64);
            quote = weth < musegod
                ? MusegodFullMath.mulDiv(ratioX128, amount, 1 << 128)
                : MusegodFullMath.mulDiv(1 << 128, amount, ratioX128);
        }
        // Splits applies 985000 / 1e6 with floor rounding. Avoid zero-cost dust flashes.
        if (quote < 2) revert ZeroQuote();
    }

    function getQuoteAmounts(MusegodQuoteParams[] calldata params) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](params.length);
        for (uint256 i; i < params.length; ++i) {
            if (params[i].quotePair.base != weth || params[i].quotePair.quote != musegod || params[i].data.length != 0)
            {
                revert InvalidQuote();
            }
            amounts[i] = quoteWethToMuse(params[i].baseAmount);
        }
    }

    function _price(IMusegodAggregatorV3 feed, uint8 expectedDecimals, uint32 maxAge) private view returns (uint256) {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        if (
            roundId == 0 || answer <= 0 || answeredInRound < roundId || startedAt == 0 || startedAt > updatedAt
                || updatedAt == 0 || updatedAt > block.timestamp || feed.decimals() != expectedDecimals
        ) revert InvalidFeed(address(feed));
        if (block.timestamp - updatedAt > maxAge) revert StaleFeed(address(feed));
        return uint256(answer) * (10 ** (18 - expectedDecimals));
    }
}

/// @dev Uniswap v3-core FullMath mulDiv, MIT, adapted to Solidity 0.8 checked arithmetic.
/// Source: https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/FullMath.sol
library MusegodFullMath {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / denominator;
            require(denominator > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = (0 - denominator) & denominator;
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }
}

/// @dev Uniswap v3-core TickMath forward calculation, GPL-2.0-or-later.
/// Source: https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol
library MusegodTickMath {
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "tick out of range");
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}
