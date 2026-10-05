import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { ROBINHOOD_STOCKS, STOCKS, sameAddress } from "../src/lib/config";
import manifestData from "../src/lib/asset-logos.json";

type Logo = { path: string; sourceUrl: string; sourceCatalog: string; assetAddress: string; sha256: string; background?: string };
const manifest = manifestData as Record<string, Logo>;
const referenceCatalog = "https://pair.fund/api/official-paired-markets?chainId=4663";
const cryptoSources = {
  WETH: { sourceUrl: "https://pair.fund/token-logos/weth.svg", sourceCatalog: referenceCatalog },
  USDG: { sourceUrl: "https://424565.fs1.hubspotusercontent-na1.net/hubfs/424565/GDN_USDG_Token_32x32.png", sourceCatalog: "https://globaldollar.com/brand" },
  cbBTC: { sourceUrl: "https://static-assets.coinbase.com/marketing/wrapped-assets/cbbtc.svg", sourceCatalog: "https://www.coinbase.com/cbbtc/proof-of-reserves" },
  MUSEGOD: {
    sourceUrl: "https://peach-quiet-cat-229.mypinata.cloud/ipfs/bafkreiexg36mudbth2ete6lyz5pqfejop3k3fgbtlpt6izcka3yraykb6e",
    sourceCatalog: "https://pools.fun/token/0x0379e228f6887c6f18bf394042ecaf81b308cb2e",
  },
};
const issuerPlaceholderHash = "3acff25ee4e8f842d245c315002965c712c7f42f00fff4377e1ad8ce88d78ab1";
const replacedReferenceTickerBadges = new Set((
  "AAOI ABCL AEHR ALAB APLD AUR AXTI CIEN CLOV CLS CLSK CRDO CVNA DJT ELF FLNC FLY FUTU GLD GLXY IBRX INFQ INOD JOBY KTOS LITE LUNR NBIS NNE NVTS OKLO P POET POWL PR PWR QBTS QQQ QUBT RGTI RUN SIMO SLS SMR SOUN SPMO TE TER TSEM VICR WULF XNDU"
).split(" "));
const issuerCorrections: Record<string, { sourceUrl: string; sourceCatalog: string }> = {
  FLY: { sourceUrl: "https://fireflyspace.com/wp-content/uploads/2021/12/firefly-logo-small.svg", sourceCatalog: "https://fireflyspace.com/" },
  DJT: { sourceUrl: "https://tmtgcorp.com/assets/images/seo/apple-touch-icon.png", sourceCatalog: "https://tmtgcorp.com/" },
  OKLO: { sourceUrl: "https://oklo.com/oklo-logo.svg", sourceCatalog: "https://oklo.com/" },
  TSEM: { sourceUrl: "https://towersemi.com/wp-content/uploads/2020/02/logo-tower-semiconductor-RGB.png", sourceCatalog: "https://towersemi.com/news-events/tower-semiconductor-branding/" },
};
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let n = i;
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngDimensions(data: Buffer) {
  assert(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "PNG signature required");
  let offset = 8, width = 0, height = 0, depth = 0, color = 0, ended = false;
  const compressed: Buffer[] = [];
  while (offset < data.length) {
    assert(offset + 12 <= data.length, "Truncated PNG chunk");
    const length = data.readUInt32BE(offset), name = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    assert(end <= data.length, "Truncated PNG payload");
    assert.equal(crc32(data.subarray(offset + 4, end - 4)), data.readUInt32BE(end - 4), `Invalid ${name} CRC`);
    if (offset === 8) assert.equal(name, "IHDR");
    if (name === "IHDR") {
      assert.equal(length, 13);
      width = data.readUInt32BE(offset + 8); height = data.readUInt32BE(offset + 12);
      depth = data[offset + 16]; color = data[offset + 17];
      assert.equal(data[offset + 18], 0, "PNG compression method");
      assert.equal(data[offset + 19], 0, "PNG filter method");
      assert.equal(data[offset + 20], 0, "Logo PNGs are non-interlaced");
      assert(width >= 16 && width <= 2048 && height >= 16 && height <= 2048, "Bounded image dimensions required");
      assert([1, 2, 4, 8, 16].includes(depth));
    }
    if (name === "IDAT") compressed.push(data.subarray(offset + 8, end - 4));
    offset = end;
    if (name === "IEND") { assert.equal(length, 0); ended = true; break; }
  }
  assert(ended && offset === data.length && compressed.length > 0, "Complete PNG with no appended payload required");
  const channels = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(color);
  assert(channels, "Supported PNG color type required");
  const rowBytes = Math.ceil(width * channels * depth / 8), expectedSize = (rowBytes + 1) * height;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedSize });
  assert.equal(pixels.length, expectedSize, "Decoded PNG rows must match dimensions");
  for (let row = 0; row < height; row++) assert(pixels[row * (rowBytes + 1)] <= 4, "Valid PNG row filter required");
  return { width, height, bitDepth: depth, format: "png" };
}
function svgDimensions(data: Buffer) {
  const svg = data.toString("utf8");
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
  assert(!/<!|<\?|\bon[a-z]+\s*=|\b(?:href|src|style)\s*=|url\s*\(|javascript:|https?:\/\//i.test(withoutNamespace),
    "SVGs must have no executable content or external dependencies");
  const tags = [...svg.matchAll(/<\/?([\w:-]+)\b/g)].map((match) => match[1]);
  assert(tags.length > 0 && tags.every((tag) => ["svg", "path", "circle", "title"].includes(tag)),
    "Only static shape SVG elements are allowed");
  const viewBox = svg.match(/viewBox="([\d. -]+)"/);
  const dimensions = viewBox ? viewBox[1].split(/\s+/).slice(2).map(Number)
    : [Number(svg.match(/\bwidth="(\d+)"/)?.[1]), Number(svg.match(/\bheight="(\d+)"/)?.[1])];
  assert(dimensions.length === 2 && dimensions.every((n) => Number.isFinite(n) && n >= 16 && n <= 1024));
  return { width: dimensions[0], height: dimensions[1], format: "svg" };
}

assert.equal(Object.keys(manifest).length, ROBINHOOD_STOCKS.length);
assert(!manifest.U && !manifest.PAIR, "Excluded assets must have no logos or picker entries");
const paths = new Set<string>(), groups = new Map<string, string[]>(), images = [];
let totalBytes = 0;
for (const asset of ROBINHOOD_STOCKS) {
  const row = manifest[asset.ticker];
  assert(row, `${asset.ticker} must have a local logo`);
  assert(/^\/asset-logos\/[A-Za-z0-9._-]+\.(png|svg)$/.test(row.path), "Local image path required");
  assert(sameAddress(row.assetAddress, asset.address), `${asset.ticker} logo provenance must bind the active asset`);
  const crypto = cryptoSources[asset.ticker as keyof typeof cryptoSources];
  const issuer = issuerCorrections[asset.ticker];
  const replaced = replacedReferenceTickerBadges.has(asset.ticker);
  assert.equal(row.sourceUrl, crypto?.sourceUrl ?? issuer?.sourceUrl ?? (replaced
    ? `https://financialmodelingprep.com/image-stock/${asset.ticker}.png`
    : `https://pair.fund/stock-logos/${asset.ticker}.png`));
  assert.equal(row.sourceCatalog, crypto?.sourceCatalog ?? issuer?.sourceCatalog ?? (replaced
    ? "https://site.financialmodelingprep.com/developer/docs/company-image-api" : referenceCatalog));
  assert(row.background === undefined || row.background === "#1f2937", "Only the reviewed dark contrast backdrop is allowed");
  assert.equal(new URL(row.sourceUrl).protocol, "https:");
  const data = await readFile(`public${row.path}`);
  assert(data.length > 100 && data.length <= 2_000_000);
  const digest = createHash("sha256").update(data).digest("hex");
  assert.equal(digest, row.sha256, `${asset.ticker} image checksum must match the reviewed source`);
  assert.notEqual(digest, issuerPlaceholderHash, "Generic Robinhood issuer feather is not an asset logo");
  const dimensions = row.path.endsWith(".png") ? pngDimensions(data) : svgDimensions(data);
  assert(!paths.has(row.path), "Each manifest entry must address its own local image file");
  paths.add(row.path); totalBytes += data.length;
  groups.set(digest, [...(groups.get(digest) ?? []), asset.ticker]);
  images.push({ ticker: asset.ticker, path: row.path, sourceUrl: row.sourceUrl,
    sourceCatalog: row.sourceCatalog, background: row.background ?? null,
    sha256: digest, bytes: data.length, ...dimensions });
}
const duplicates = [...groups.values()].filter((tickers) => tickers.length > 1);
assert.deepEqual(duplicates.map((tickers) => [...tickers].sort()).sort(),
  [["BND", "VTI"], ["EWY", "EWT", "INDA", "SHY", "SOXX"]].map((tickers) => tickers.sort()).sort(),
  "Only visually checked Vanguard and iShares fund-family marks may be shared");
const files = await readdir("public/asset-logos");
assert.equal(files.length, paths.size, "Unused image files must be removed");
assert(files.every((name) => paths.has(`/asset-logos/${name}`)));
assert(STOCKS.every((asset) => manifest[asset.ticker]), "The same underlying company logos cover the Base stock list");
await mkdir(".cache", { recursive: true });
await writeFile(".cache/asset-logos-proof.json", JSON.stringify({
  observedAt: new Date().toISOString(), scope: "Offline image coverage, integrity, format and pinned provenance; no chain calls or signing",
  activeAssets: ROBINHOOD_STOCKS.length, coveredAssets: images.length,
  companyAndFundLogos: ROBINHOOD_STOCKS.filter((asset) => asset.category !== "OTHERS").length,
  cryptoAssets: Object.keys(cryptoSources), legacyBaseTickersCovered: STOCKS.length,
  missing: [], totalBytes, distinctImages: groups.size,
  sharedBrandMarks: [{ issuer: "Vanguard", tickers: ["BND", "VTI"] },
    { issuer: "iShares", tickers: ["EWY", "EWT", "INDA", "SHY", "SOXX"] }],
  sourceCounts: { pairCompanyAndFundMarks: 142, financialModelingPrepCompanyAndFundMarks: 48,
    correctedPrimaryIssuerMarks: 4, cryptoAssetMarks: 4 },
  rejectedReferenceTickerBadges: [...replacedReferenceTickerBadges],
  correctedIssuerIdentities: { FLY: "Firefly Aerospace, not Fly Leasing", DJT: "Trump Media, not DWAC",
    OKLO: "Oklo, not the former ALTC SPAC", TSEM: "Tower Semiconductor logo, not a facility photo" },
  contrastBackdrops: images.filter((image) => image.background).map((image) => image.ticker),
  visualReview: "All assets reviewed in two contact sheets; official primary marks cross-checked for renamed issuers and corrected images",
  genericIssuerPlaceholdersRejected: true, svgStaticShapesOnly: true,
  runtimeThirdPartyImageRequestsRequired: false, images,
}, null, 2) + "\n");
console.log(JSON.stringify({ covered: images.length, missing: 0, distinctImages: groups.size,
  totalBytes, legacyBaseTickersCovered: STOCKS.length, proof: ".cache/asset-logos-proof.json" }, null, 2));
