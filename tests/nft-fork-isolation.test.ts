import assert from "node:assert/strict";
import test from "node:test";
import { assertForkExecutionChainId } from "../scripts/robinhood-fork";

test("NFT forks retain their own deployment chain or the isolated 31337 chain", () => {
  for (const [deploymentChainId, executionChainId] of [[4663, 4663], [8453, 8453], [4663, 31337], [8453, 31337]]) {
    assert.doesNotThrow(() => assertForkExecutionChainId(deploymentChainId, executionChainId), `${deploymentChainId} -> ${executionChainId}`);
  }
});

test("forks reject crossed execution identities", () => {
  for (const [deploymentChainId, executionChainId] of [[4663, 8453], [8453, 4663], [4663, 1], [8453, 1]]) {
    assert.throws(() => assertForkExecutionChainId(deploymentChainId, executionChainId), /execution chain must be/,
      `${deploymentChainId} -> ${executionChainId}`);
  }
});

test("forks reject unsupported deployment chains even when the execution chain matches", () => {
  for (const [deploymentChainId, executionChainId] of [[1, 1], [1, 31337], [31337, 31337]]) {
    assert.throws(() => assertForkExecutionChainId(deploymentChainId, executionChainId), /Unsupported fork deployment chain/,
      `${deploymentChainId} -> ${executionChainId}`);
  }
});
