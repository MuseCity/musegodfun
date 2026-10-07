// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {MusegodAssetFeedOracle} from "../src/MusegodAssetFeedOracle.sol";
import {OracleAssetMock, OracleFeedMock} from "./MusegodBuybackOracle.t.sol";
interface AssetOracleVm { function warp(uint256) external; function prank(address) external; function expectRevert() external; function expectRevert(bytes4) external; }
contract DescribedFeed is OracleFeedMock {
    string public description;
    constructor(int256 price, string memory label) OracleFeedMock(price) { description = label; }
}
contract MusegodAssetFeedOracleTest {
    AssetOracleVm constant vm = AssetOracleVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    MusegodAssetFeedOracle oracle;
    OracleAssetMock weth; OracleAssetMock token;
    DescribedFeed ethFeed; DescribedFeed stockFeed;
    function setUp() public {
        vm.warp(1000000);
        weth = new OracleAssetMock(18); token = new OracleAssetMock(18);
        ethFeed = new DescribedFeed(2000e8, "ETH / USD"); stockFeed = new DescribedFeed(100e8, "Robinhood AAPL / USD");
        MusegodAssetFeedOracle.AssetFeedConfig[] memory configs = new MusegodAssetFeedOracle.AssetFeedConfig[](1);
        configs[0] = MusegodAssetFeedOracle.AssetFeedConfig(address(token), address(stockFeed), 86400, true);
        oracle = new MusegodAssetFeedOracle(address(this), address(weth), address(ethFeed), 86400, configs);
    }
    function _fresh(DescribedFeed feed) private { feed.configure(2, feed.answer(), block.timestamp, block.timestamp, 2); }
    function testQuoteAndNoDoubleMultiplier() public view { require(oracle.quoteToWeth(address(token), 1e18) == 0.05 ether); }
    function testOnlyGovernorCanProposeOrCancel() public {
        DescribedFeed next = new DescribedFeed(110e8, "Robinhood AAPL / USD");
        vm.prank(address(7)); vm.expectRevert(MusegodAssetFeedOracle.OnlyGovernor.selector); oracle.proposeFeed(address(token), address(next));
        oracle.proposeFeed(address(token), address(next));
        vm.prank(address(7)); vm.expectRevert(MusegodAssetFeedOracle.OnlyGovernor.selector); oracle.cancelFeed(address(token));
        oracle.cancelFeed(address(token));
        vm.warp(block.timestamp + 7 days); vm.expectRevert(MusegodAssetFeedOracle.Timelocked.selector); oracle.activateFeed(address(token));
    }
    function testExactSevenDaysAndPermissionlessActivation() public {
        DescribedFeed next = new DescribedFeed(110e8, "Robinhood AAPL / USD");
        oracle.proposeFeed(address(token), address(next));
        vm.warp(block.timestamp + 7 days - 1); _fresh(next);
        vm.expectRevert(MusegodAssetFeedOracle.Timelocked.selector); oracle.activateFeed(address(token));
        vm.warp(block.timestamp + 1); _fresh(ethFeed);
        vm.prank(address(7)); oracle.activateFeed(address(token));
        require(oracle.quoteToWeth(address(token), 1e18) == 0.055 ether);
        (, uint32 age,, uint8 decimals, bool paused) = oracle.assetFeeds(address(token));
        require(age == 86400 && decimals == 8 && paused);
    }
    function testReplacementResetsDelayAndCannotAddClassOrChangeMetadata() public {
        DescribedFeed a = new DescribedFeed(110e8, "Robinhood AAPL / USD");
        DescribedFeed b = new DescribedFeed(120e8, "Robinhood AAPL / USD");
        oracle.proposeFeed(address(token), address(a)); vm.warp(block.timestamp + 6 days);
        oracle.proposeFeed(address(token), address(b)); vm.warp(block.timestamp + 1 days);
        vm.expectRevert(MusegodAssetFeedOracle.Timelocked.selector); oracle.activateFeed(address(token));
        vm.expectRevert(MusegodAssetFeedOracle.UnsupportedAsset.selector); oracle.proposeFeed(address(99), address(a));
        vm.expectRevert(MusegodAssetFeedOracle.InvalidFeed.selector); oracle.proposeFeed(address(token), address(0));
        vm.expectRevert(MusegodAssetFeedOracle.InvalidFeed.selector); oracle.proposeFeed(address(token), address(ethFeed));
        a.setDecimals(18); vm.expectRevert(MusegodAssetFeedOracle.InvalidFeed.selector); oracle.proposeFeed(address(token), address(a));
    }
    function testRetiredFeedCanRecoverWithoutRelaxingStalenessOrPause() public {
        DescribedFeed next = new DescribedFeed(110e8, "Robinhood AAPL / USD");
        oracle.proposeFeed(address(token), address(next)); vm.warp(block.timestamp + 30 days);
        vm.expectRevert(MusegodAssetFeedOracle.StaleFeed.selector); oracle.activateFeed(address(token));
        _fresh(next); _fresh(ethFeed); oracle.activateFeed(address(token));
        token.setPaused(true); vm.expectRevert(MusegodAssetFeedOracle.OraclePaused.selector); oracle.quoteToWeth(address(token), 1e18);
        token.setPaused(false); require(oracle.quoteToWeth(address(token), 1e18) > 0);
        vm.warp(block.timestamp + 86401); vm.expectRevert(MusegodAssetFeedOracle.StaleFeed.selector); oracle.quoteToWeth(address(token), 1e18);
    }
    function testEthFeedUsesSameDelayedGovernance() public {
        DescribedFeed next = new DescribedFeed(2500e8, "ETH / USD");
        oracle.proposeFeed(address(weth), address(next)); vm.warp(block.timestamp + 7 days);
        _fresh(next); _fresh(stockFeed); oracle.activateFeed(address(weth));
        require(oracle.quoteToWeth(address(token), 1e18) == 0.04 ether);
    }
}
