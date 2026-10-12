import test from "node:test";
import assert from "node:assert/strict";
import { KEEPER_TASK_RETRY_POLICY } from "../scripts/keeper-task-policy";
import { KEEPER_TASK_RETRY_POLICY as robinhoodPolicy } from "../scripts/buyback-keeper";
import { KEEPER_TASK_RETRY_POLICY as basePolicy } from "../scripts/base-buyback-keeper";

test("both keepers reference the same task gas policy without a keeper-wide lifetime ceiling",()=>{
  assert.equal(basePolicy,KEEPER_TASK_RETRY_POLICY);
  assert.equal(robinhoodPolicy,KEEPER_TASK_RETRY_POLICY);
  assert.equal(KEEPER_TASK_RETRY_POLICY.maximumAttemptGasWei,2n*10n**15n);
  assert.equal(KEEPER_TASK_RETRY_POLICY.maximumFailedGasWei,10n**15n);
  assert.equal(KEEPER_TASK_RETRY_POLICY.gasWindowMs,86_400_000);
});
