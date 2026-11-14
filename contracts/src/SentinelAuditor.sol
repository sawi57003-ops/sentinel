// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SentinelAuditor
/// @notice On-chain registry of the Sentinel agent's audit verdicts for B20 tokens.
/// @dev The agent (owner) publishes one verdict per token per audit cycle.
///      A token is approved for purchase only if its latest verdict passed
///      (score >= 70) and is at most 7 days old. A failed token can never be
///      bought by SentinelStrategy until a fresh passing verdict exists.
contract SentinelAuditor is Ownable {
    uint8 public constant PASS_SCORE = 70;
    uint256 public constant VERDICT_TTL = 7 days;

    struct Verdict {
        uint8 score; // 0-100
        bool passed; // score >= 70
        uint256 timestamp;
        bytes32 reportHash; // keccak256 of the off-chain audit report (IPFS/GitHub)
    }

    mapping(address => Verdict) public verdicts;

    event VerdictPublished(
        address indexed token, uint8 score, bool passed, uint256 timestamp, bytes32 reportHash
    );

    constructor(address agent) Ownable(agent) {}

    function publishVerdict(address token, uint8 score, bool passed, bytes32 reportHash)
        public
        onlyOwner
    {
        require(token != address(0), "zero token");
        require(score <= 100, "score>100");
        require(passed == (score >= PASS_SCORE), "passed!=score>=70");
        verdicts[token] =
            Verdict({score: score, passed: passed, timestamp: block.timestamp, reportHash: reportHash});
        emit VerdictPublished(token, score, passed, block.timestamp, reportHash);
    }

    function publishVerdictBatch(
        address[] calldata tokens,
        uint8[] calldata scores,
        bool[] calldata passed,
        bytes32[] calldata reportHashes
    ) external onlyOwner {
        require(
            tokens.length == scores.length && tokens.length == passed.length
                && tokens.length == reportHashes.length,
            "length"
        );
        for (uint256 i; i < tokens.length; i++) {
            publishVerdict(tokens[i], scores[i], passed[i], reportHashes[i]);
        }
    }

    function getVerdict(address token) external view returns (Verdict memory) {
        return verdicts[token];
    }

    /// @notice True only for a fresh passing verdict. Read by SentinelStrategy.
    function isApproved(address token) external view returns (bool) {
        Verdict memory v = verdicts[token];
        if (!v.passed) return false;
        if (block.timestamp - v.timestamp > VERDICT_TTL) return false;
        return true;
    }
}
