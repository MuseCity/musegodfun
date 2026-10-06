// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {
    MusegodBuybackOracle,
    MusegodQuotePair,
    MusegodQuoteParams,
    MusegodFullMath,
    MusegodTickMath
} from "../src/MusegodBuybackOracle.sol";

interface BuybackOracleVm {
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract OracleAssetMock {
    uint8 public decimals;
    bool public oraclePaused;
    uint256 public uiMultiplier = 10e18;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setPaused(bool value) external {
        oraclePaused = value;
    }
}

contract OracleFeedMock {
    uint8 public decimals = 8;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;

    constructor(int256 answer_) {
        answer = answer_;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    function configure(uint80 round, int256 price, uint256 start, uint256 update, uint80 answered) external {
        roundId = round;
        answer = price;
        startedAt = start;
        updatedAt = update;
        answeredInRound = answered;
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

contract OraclePoolMock {
    address public token0;
    address public token1;
    uint24 public fee = 10000;
    uint128 public liquidity = 1e18;
    int56 public oldTick;
    int56 public newTick;
    uint160 public oldLiquidity;
    uint160 public newLiquidity = 1800 * (uint160(1) << 64);
    bool public oldHistory;
    bool public malformed;

    constructor(address a, address b) {
        token0 = a < b ? a : b;
        token1 = a < b ? b : a;
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function getPool(address, address, uint24) external view returns (address) {
        return address(this);
    }

    function setTicks(int56 before_, int56 after_) external {
        oldTick = before_;
        newTick = after_;
    }

    function setLiquidity(uint128 value) external {
        liquidity = value;
    }

    function setCounters(uint160 before_, uint160 after_) external {
        oldLiquidity = before_;
        newLiquidity = after_;
    }

    function setFailure(bool old_, bool malformed_) external {
        oldHistory = old_;
        malformed = malformed_;
    }

    function setFee(uint24 value) external {
        fee = value;
    }

    function observe(uint32[] calldata ages)
        external
        view
        returns (int56[] memory ticks, uint160[] memory cumulatives)
    {
        require(ages.length == 2 && ages[0] == 1800 && ages[1] == 0, "wrong period");
        require(!oldHistory, "OLD");
        ticks = new int56[](malformed ? 1 : 2);
        cumulatives = new uint160[](malformed ? 1 : 2);
        ticks[0] = oldTick;
        cumulatives[0] = oldLiquidity;
        if (!malformed) {
            ticks[1] = newTick;
            cumulatives[1] = newLiquidity;
        }
    }
}

contract BuybackMathHarness {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return MusegodFullMath.mulDiv(a, b, denominator);
    }

    function sqrtAtTick(int24 tick) external pure returns (uint160) {
        return MusegodTickMath.getSqrtRatioAtTick(tick);
    }
}

contract MusegodBuybackOracleTest {
    BuybackOracleVm constant vm = BuybackOracleVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    OracleAssetMock weth;
    OracleAssetMock muse;
    OracleAssetMock stock;
    OracleAssetMock usd;
    OracleFeedMock ethFeed;
    OracleFeedMock stockFeed;
    OracleFeedMock usdFeed;
    OraclePoolMock pool;
    MusegodBuybackOracle oracle;

    function setUp() public {
        vm.warp(1_000_000);
        weth = new OracleAssetMock(18);
        muse = new OracleAssetMock(18);
        stock = new OracleAssetMock(18);
        usd = new OracleAssetMock(6);
        ethFeed = new OracleFeedMock(2000e8);
        stockFeed = new OracleFeedMock(100e8);
        usdFeed = new OracleFeedMock(1e8);
        pool = new OraclePoolMock(address(weth), address(muse));
        oracle = _deploy(_configs());
    }

    function _configs() private view returns (MusegodBuybackOracle.AssetFeedConfig[] memory configs) {
        configs = new MusegodBuybackOracle.AssetFeedConfig[](2);
        configs[0] = MusegodBuybackOracle.AssetFeedConfig(address(stock), address(stockFeed), 86400, true);
        configs[1] = MusegodBuybackOracle.AssetFeedConfig(address(usd), address(usdFeed), 86400, false);
    }

    function _deploy(MusegodBuybackOracle.AssetFeedConfig[] memory configs) private returns (MusegodBuybackOracle) {
        return new MusegodBuybackOracle(address(weth), address(muse), address(pool), address(ethFeed), 86400, configs);
    }

    function testUsdAndStockDecimalsAndNoSecondMultiplier() public view {
        require(oracle.quoteToWeth(address(usd), 1e6) == 5e14, "USDG scale");
        require(oracle.quoteToWeth(address(stock), 1e18) == 5e16, "stock scale or multiplier");
        require(oracle.quoteToWeth(address(weth), 123456789) == 123456789, "WETH identity");
    }

    function testFuzzUsdRatio(uint128 amount) public view {
        if (amount == 0) return;
        require(oracle.quoteToWeth(address(usd), amount) == uint256(amount) * 500_000_000, "USD ratio");
    }

    function testRejectUnsupportedAndZero() public {
        vm.expectRevert(abi.encodeWithSelector(MusegodBuybackOracle.UnsupportedAsset.selector, address(0x123)));
        oracle.quoteToWeth(address(0x123), 1e18);
        vm.expectRevert(MusegodBuybackOracle.ZeroQuote.selector);
        oracle.quoteToWeth(address(stock), 0);
    }

    function testRejectPausedStock() public {
        stock.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(MusegodBuybackOracle.OraclePaused.selector, address(stock)));
        oracle.quoteToWeth(address(stock), 1e18);
        require(oracle.quoteToWeth(address(usd), 1e6) == 5e14, "unrelated quote");
    }

    function testStalenessBoundaryAndStaleEth() public {
        vm.warp(1_086_400);
        require(oracle.quoteToWeth(address(stock), 1e18) == 5e16, "exact heartbeat");
        vm.warp(1_086_401);
        stockFeed.configure(1, 100e8, block.timestamp, block.timestamp, 1);
        vm.expectRevert(abi.encodeWithSelector(MusegodBuybackOracle.StaleFeed.selector, address(ethFeed)));
        oracle.quoteToWeth(address(stock), 1e18);
    }

    function testRejectStaleTokenFeed() public {
        vm.warp(1_086_401);
        ethFeed.configure(1, 2000e8, block.timestamp, block.timestamp, 1);
        vm.expectRevert(abi.encodeWithSelector(MusegodBuybackOracle.StaleFeed.selector, address(stockFeed)));
        oracle.quoteToWeth(address(stock), 1e18);
    }

    function testRejectIncompleteZeroNegativeFutureAndBadStartRounds() public {
        stockFeed.configure(2, 100e8, block.timestamp, block.timestamp, 1);
        _invalidStock();
        stockFeed.configure(0, 100e8, block.timestamp, block.timestamp, 1);
        _invalidStock();
        stockFeed.configure(1, 0, block.timestamp, block.timestamp, 1);
        _invalidStock();
        stockFeed.configure(1, -1, block.timestamp, block.timestamp, 1);
        _invalidStock();
        stockFeed.configure(1, 100e8, block.timestamp, block.timestamp + 1, 1);
        _invalidStock();
        stockFeed.configure(1, 100e8, block.timestamp + 1, block.timestamp, 1);
        _invalidStock();
        stockFeed.configure(1, 100e8, 0, block.timestamp, 1);
        _invalidStock();
    }

    function _invalidStock() private {
        vm.expectRevert(abi.encodeWithSelector(MusegodBuybackOracle.InvalidFeed.selector, address(stockFeed)));
        oracle.quoteToWeth(address(stock), 1e18);
    }

    function testFeedPrecisionCannotChangeAfterDeployment() public {
        stockFeed.setDecimals(9);
        _invalidStock();
    }

    function testRejectDuplicateUnsupportedDecimalsAndInvalidPoolFee() public {
        MusegodBuybackOracle.AssetFeedConfig[] memory configs = _configs();
        configs[1] = configs[0];
        vm.expectRevert(MusegodBuybackOracle.InvalidConfiguration.selector);
        _deploy(configs);
        stockFeed.setDecimals(19);
        vm.expectRevert(MusegodBuybackOracle.InvalidConfiguration.selector);
        _deploy(_configs());
        stockFeed.setDecimals(8);
        pool.setFee(3000);
        vm.expectRevert(MusegodBuybackOracle.InvalidConfiguration.selector);
        _deploy(_configs());
    }

    function testTwapTickZeroAndSplitsAbi() public view {
        require(oracle.quoteWethToMuse(1e18) == 1e18, "tick zero");
        MusegodQuoteParams[] memory params = new MusegodQuoteParams[](1);
        params[0] = MusegodQuoteParams(MusegodQuotePair(address(weth), address(muse)), 1e18, "");
        (bool ok, bytes memory result) = address(oracle).staticcall(
            abi.encodeWithSignature("getQuoteAmounts(((address,address),uint128,bytes)[])", params)
        );
        require(ok && abi.decode(result, (uint256[]))[0] == 1e18, "Splits ABI");
    }

    function testTwapRoundsNegativeTickDown() public {
        pool.setTicks(0, -1);
        uint256 fractional = oracle.quoteWethToMuse(1e18);
        pool.setTicks(0, -1800);
        require(fractional == oracle.quoteWethToMuse(1e18), "negative tick rounded toward zero");
        require(fractional != 1e18, "tick discarded");
    }

    function testCumulativeCounterWrap() public {
        pool.setTicks(type(int56).max - 900, type(int56).min + 899);
        pool.setCounters(type(uint160).max - 10, 9);
        uint256 wrapped = oracle.quoteWethToMuse(1e18);
        pool.setTicks(0, 1800);
        pool.setCounters(0, 20);
        require(wrapped == oracle.quoteWethToMuse(1e18), "cumulative wrap");
    }

    function testRejectOldHistoryNoLiquidityAndMalformedObservation() public {
        pool.setFailure(true, false);
        vm.expectRevert();
        oracle.quoteWethToMuse(1e18);
        pool.setFailure(false, true);
        vm.expectRevert(MusegodBuybackOracle.InvalidTwap.selector);
        oracle.quoteWethToMuse(1e18);
        pool.setFailure(false, false);
        pool.setLiquidity(0);
        vm.expectRevert(MusegodBuybackOracle.InvalidTwap.selector);
        oracle.quoteWethToMuse(1e18);
        pool.setLiquidity(1);
        pool.setCounters(1, 1);
        vm.expectRevert(MusegodBuybackOracle.InvalidTwap.selector);
        oracle.quoteWethToMuse(1e18);
    }

    function testRejectWrongPairCallbackDataAndDust() public {
        MusegodQuoteParams[] memory params = new MusegodQuoteParams[](1);
        params[0] = MusegodQuoteParams(MusegodQuotePair(address(stock), address(muse)), 1e18, "");
        vm.expectRevert(MusegodBuybackOracle.InvalidQuote.selector);
        oracle.getQuoteAmounts(params);
        params[0].quotePair.base = address(weth);
        params[0].data = hex"01";
        vm.expectRevert(MusegodBuybackOracle.InvalidQuote.selector);
        oracle.getQuoteAmounts(params);
        vm.expectRevert(MusegodBuybackOracle.ZeroQuote.selector);
        oracle.quoteWethToMuse(1);
    }

    function testMathKnownVectorsAndPhantomOverflow() public {
        BuybackMathHarness math = new BuybackMathHarness();
        require(math.sqrtAtTick(0) == 79228162514264337593543950336, "zero ratio");
        require(math.sqrtAtTick(-887272) == 4295128739, "min ratio");
        require(math.sqrtAtTick(887272) == 1461446703485210103287273052203988822378723970342, "max ratio");
        require(math.mulDiv(1 << 200, 1 << 100, 1 << 80) == 1 << 220, "512 bit mulDiv");
        require(math.mulDiv(10, 10, 3) == 33, "floor rounding");
    }
}
