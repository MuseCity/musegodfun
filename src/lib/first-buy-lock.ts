import { parseAbi } from "viem";
export const bundlerAbi = parseAbi(["function claim(address asset)"]);
