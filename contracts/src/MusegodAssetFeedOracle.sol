// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMusegodAggregatorV3, IMusegodOraclePaused, MusegodFullMath} from "./MusegodBuybackOracle.sol";

interface IFeedDescription { function description() external view returns (string memory); }

/// @notice Only feed addresses can change, after a public seven-day delay.
/// @dev Governance controls reference pricing, never recipients, asset classes or withdrawals.
contract MusegodAssetFeedOracle {
    uint256 public constant FEED_CHANGE_DELAY = 7 days;
    uint32 public constant MAX_FEED_AGE = 86400;
    address public immutable governor;
    address public immutable weth;
    struct AssetFeedConfig { address token; address feed; uint32 maxAge; bool checkOraclePaused; }
    struct AssetFeed { address feed; uint32 maxAge; uint8 tokenDecimals; uint8 feedDecimals; bool checkOraclePaused; }
    struct Proposal { address feed; uint64 executableAt; bytes32 codeHash; }
    mapping(address => AssetFeed) public assetFeeds;
    mapping(address => bytes32) public descriptionHash;
    mapping(address => Proposal) public proposals;
    error InvalidConfiguration();
    error OnlyGovernor();
    error UnsupportedAsset();
    error InvalidFeed();
    error StaleFeed();
    error OraclePaused();
    error Timelocked();
    error ZeroQuote();
    event FeedProposed(address indexed token, address indexed feed, uint256 executableAt, bytes32 codeHash);
    event FeedCancelled(address indexed token);
    event FeedActivated(address indexed token, address indexed previous, address indexed feed);

    constructor(address governor_, address weth_, address ethFeed_, uint32 ethMaxAge_, AssetFeedConfig[] memory configs) {
        if (governor_ == address(0) || governor_ == address(0xdead) || weth_.code.length == 0 || IERC20Metadata(weth_).decimals() != 18)
            revert InvalidConfiguration();
        governor = governor_;
        weth = weth_;
        _configure(AssetFeedConfig(weth_, ethFeed_, ethMaxAge_, false));
        for (uint256 i; i < configs.length; ++i) _configure(configs[i]);
    }

    function _configure(AssetFeedConfig memory c) private {
        if (c.token.code.length == 0 || c.feed.code.length == 0 || c.maxAge == 0 || c.maxAge > MAX_FEED_AGE || assetFeeds[c.token].feed != address(0))
            revert InvalidConfiguration();
        uint8 tokenDecimals = IERC20Metadata(c.token).decimals();
        uint8 feedDecimals = IMusegodAggregatorV3(c.feed).decimals();
        if (tokenDecimals > 18 || feedDecimals > 18) revert InvalidConfiguration();
        bytes memory description = bytes(IFeedDescription(c.feed).description());
        if (description.length == 0) revert InvalidConfiguration();
        if (c.checkOraclePaused) IMusegodOraclePaused(c.token).oraclePaused();
        assetFeeds[c.token] = AssetFeed(c.feed, c.maxAge, tokenDecimals, feedDecimals, c.checkOraclePaused);
        descriptionHash[c.token] = keccak256(description);
    }

    modifier onlyGovernor() { if (msg.sender != governor) revert OnlyGovernor(); _; }

    function proposeFeed(address token, address feed) external onlyGovernor {
        AssetFeed memory c = assetFeeds[token];
        if (c.feed == address(0)) revert UnsupportedAsset();
        if (feed == c.feed) revert InvalidFeed();
        _validateMetadata(token, feed, c.feedDecimals);
        uint64 executableAt = uint64(block.timestamp + FEED_CHANGE_DELAY);
        proposals[token] = Proposal(feed, executableAt, feed.codehash);
        emit FeedProposed(token, feed, executableAt, feed.codehash);
    }

    function cancelFeed(address token) external onlyGovernor {
        delete proposals[token];
        emit FeedCancelled(token);
    }

    /// @notice Anybody may execute the exact matured proposal; replacing it resets the full delay.
    function activateFeed(address token) external {
        Proposal memory p = proposals[token];
        if (p.feed == address(0) || block.timestamp < p.executableAt) revert Timelocked();
        AssetFeed storage c = assetFeeds[token];
        if (p.feed.codehash != p.codeHash) revert InvalidFeed();
        _validateMetadata(token, p.feed, c.feedDecimals);
        _price(p.feed, c.feedDecimals, c.maxAge);
        address previous = c.feed;
        c.feed = p.feed;
        delete proposals[token];
        emit FeedActivated(token, previous, p.feed);
    }

    function _validateMetadata(address token, address feed, uint8 decimals) private view {
        if (feed.code.length == 0 || IMusegodAggregatorV3(feed).decimals() != decimals ||
            keccak256(bytes(IFeedDescription(feed).description())) != descriptionHash[token]) revert InvalidFeed();
    }

    function quoteToWeth(address token, uint256 amount) external view returns (uint256 quote) {
        if (amount == 0) revert ZeroQuote();
        if (token == weth) return amount;
        AssetFeed memory c = assetFeeds[token];
        if (c.feed == address(0)) revert UnsupportedAsset();
        if (c.checkOraclePaused && IMusegodOraclePaused(token).oraclePaused()) revert OraclePaused();
        AssetFeed memory eth = assetFeeds[weth];
        uint256 usd = MusegodFullMath.mulDiv(amount, _price(c.feed, c.feedDecimals, c.maxAge), 10 ** c.tokenDecimals);
        quote = MusegodFullMath.mulDiv(usd, 1e18, _price(eth.feed, eth.feedDecimals, eth.maxAge));
        if (quote == 0) revert ZeroQuote();
    }

    function _price(address feed, uint8 decimals, uint32 maxAge) private view returns (uint256) {
        (uint80 round, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = IMusegodAggregatorV3(feed).latestRoundData();
        if (round == 0 || answer <= 0 || answeredInRound < round || startedAt == 0 || startedAt > updatedAt || updatedAt == 0 ||
            updatedAt > block.timestamp || IMusegodAggregatorV3(feed).decimals() != decimals) revert InvalidFeed();
        if (block.timestamp - updatedAt > maxAge) revert StaleFeed();
        return uint256(answer) * (10 ** (18 - decimals));
    }
}
