import { STOCKS } from "../src/lib/config";
const from = process.argv[3] ? STOCKS.findIndex(s=>s.ticker===process.argv[3]) : 0;
if(from<0)throw new Error("Unknown starting stock");
for (const stock of STOCKS.slice(from)) {
  process.env.TEST_STOCK = stock.ticker;
  await import(`./test-fork.ts?stock=${stock.ticker}`);
}
