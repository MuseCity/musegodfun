import { assetCategory } from "../lib/asset-categories";
import type { RuntimeConfig, Stock } from "../lib/config";
import { ownershipDisclaimer } from "../lib/token-detail";

export default function TokenTradeNotes({ stock, symbol, payingEth, nativeWeth, config, doppler, fork }: {
  stock: Stock; symbol: string; payingEth: boolean; nativeWeth?: boolean; config: Pick<RuntimeConfig, "writesEnabled"> | null; doppler?: string; fork?: boolean;
}) {
  const disclaimer = ownershipDisclaimer(symbol, stock);
  const disabled = config?.writesEnabled === false;
  const automatic = stock.chainId === 4663;
  return <>
    {(disabled || disclaimer || doppler) && <p className="trade-note">
      {disabled && <>Transactions are disabled; quotes are previews. </>}
      {disclaimer}{disclaimer && doppler ? " " : ""}
      {doppler && <a className="text-button" href={doppler} target="_blank" rel="noreferrer">Trade on Doppler ↗</a>}
    </p>}
    <details className="disclosure boxed">
      <summary>Trading details</summary>
      <p className="hint">{nativeWeth ? "ETH is wrapped to WETH and swapped in one transaction with no approval. Network gas is extra." : payingEth ? "Paying with ETH goes through LI.FI; its fee is included in the quote and network gas is extra." : "Router approval is limited to this amount and valid for 5 minutes."}</p>
      <p className="hint">Execution depends on slippage and liquidity{assetCategory(stock) === "OTHERS" ? "." : " and follows the stock token’s transfer rules."}</p>
      {!fork && <p className="hint">{!doppler && "Doppler trading is pending: the link opens after listing and quote verification. "}{config?.writesEnabled === true ? <>{automatic ? "Enter an amount for an automatic quote, then confirm the trade in your wallet" : "Get a quote here and confirm the trade in your wallet"}{doppler ? ", or use the verified Doppler link." : "."}</> : automatic ? "Enter an amount for an automatic price preview." : "Get a quote here for a price preview."}</p>}
    </details>
  </>;
}
