import { type TestContext } from "node:test";
import type { RuntimeConfig } from "../src/lib/config";
import { NftLaunchStep } from "../src/components/NftLaunchStep";
import { NftPicker } from "../src/components/NftPicker";
import { launchDraftKey } from "../src/lib/launch-draft";
import { MUSES, type NftStatus } from "../src/lib/nft-mode";
import { hookRuntime, importFresh, settle } from "./hook-runtime";

// The create page and its NFT step, rendered together in the hook runtime with the real draft, prefill and pair code. Only the wallet,
// the APIs, the NFT status read and image conversion are replaced, and nothing can reach a network.

export function find(node: any, match: (element: any) => boolean): any {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, match); if (found) return found; } return null; }
  if (match(node)) return node;
  return find(node.props?.children, match);
}
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : [];
export const textOf = (node: any): string => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : String(node ?? "");

export const holder = "0x5555555555555555555555555555555555555555";
export const hood = "0x7777777777777777777777777777777777777777";
export const config: RuntimeConfig = { mode: "robinhood", chainId: 4663, deploymentChainId: 4663, treasury: null, writesEnabled: true, blockReason: null, fomoInvite: "musegod",
  nftMode: { enabled: true, vaultFactory: null, launchFeeUsd: 10, freeCollections: [], verifiedCollections: [] } };
const wallet = { account: holder, chainId: 4663, connecting: false, restoring: false, revision: 0, error: "",
  connect: async () => {}, switchChain: async () => {}, balance: async () => 0n, balanceNative: async () => 0n };
/** The live check's answers: Muses by their on-chain names, other NFTs by token id. */
export const museNames: Record<string, string> = { "1": "Bard", "2": "Cadenza", "3": "Moonlet" };
export const pinned = (source: string) => `https://pin.test/${source}`;
export const store = new Map<string, string>();

/** Browser globals the page reads; call from `test.before`, and clear `store` before each test. */
export function installGlobals() {
  for (const [name, value] of Object.entries({
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); } },
    location: { origin: "https://musegod.fun", pathname: "/create", search: "", hash: "" }, history: { state: null, replaceState() {} }, window: new EventTarget(),
    document: Object.assign(new EventTarget(), { getElementById: () => null, activeElement: null, body: null, visibilityState: "visible" }),
    requestAnimationFrame: (): number => 0,
    // Nothing here may reach a network: every API the page uses is replaced below.
    fetch: async () => { throw new Error("No network in tests"); },
    __BUILD_IDENTITY__: { schemaVersion: 1, repository: "https://github.com/test/test", commit: "a".repeat(40), source: "local", dirty: true, buildId: null, runUrl: null, releaseUrl: null } }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** The create page with its NFT step. `saved`: a draft stored before the page opened. `refuse`: token ids whose live check says no.
 * `hold`: token ids whose status read waits until the test releases it with `answer`. `names`: Muse names that differ from `museNames`. */
export async function launchForm(t: TestContext, options: { saved?: Record<string, unknown>; refuse?: string[]; hold?: string[]; names?: Record<string, string> } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  if (options.saved) store.set(launchDraftKey(config), JSON.stringify(options.saved));
  const held = new Map<string, () => void>();
  const status = async (_config: unknown, nft: { contract: string; tokenId: string }): Promise<NftStatus> => {
    if (options.hold?.includes(nft.tokenId)) await new Promise<void>((resolve) => held.set(nft.tokenId, resolve));
    const free = nft.contract.toLowerCase() === MUSES.contract.toLowerCase();
    return { erc721: true, controls: !options.refuse?.includes(nft.tokenId), alreadyLaunched: false, free,
      ...(free && (options.names ?? museNames)[nft.tokenId] ? { name: (options.names ?? museNames)[nft.tokenId] } : {}) } as NftStatus;
  };
  let Create: any;
  const parent = hookRuntime(() => Create({ stocks: null, stockError: "", config, refresh() {} }));
  ({ CreatePage: Create } = await importFresh("src/App.tsx", {
    react: { file: import.meta.resolve("react"), bindings: parent.hooks },
    "./lib/wallet": { file: import.meta.resolve("../src/lib/wallet.tsx"), bindings: { useWallet: () => wallet } },
    "./lib/resource": { file: import.meta.resolve("../src/lib/resource.ts"), bindings: { useResource: () => ({ data: null, error: "", loading: false }) } },
    "./lib/api": { file: import.meta.resolve("../src/lib/api.ts"), bindings: {
      chainApi: async (_chain: number, path: string, body: { image: string }) => {
        if (path === "/token-images") return { image: pinned(body.image) };
        throw new Error(`Unexpected API call ${path}`);
      } } },
    "./lib/image-upload": { file: import.meta.resolve("../src/lib/image-upload.ts"), bindings: { prepareTokenImageFromUrl: async (url: string) => url } },
  }, ["CreatePage"]));
  // The step mounts, remounts (a new `key`) and unmounts with the page's element, as React does.
  const stepElement = () => find(parent.output(), (element) => element.type === NftLaunchStep);
  let step: ReturnType<typeof hookRuntime> | null = null, stepKey: string | null = null;
  async function syncStep() {
    const element = stepElement(), key = element ? String(element.key) : null;
    if (key !== stepKey) {
      step?.unmount(); step = null; stepKey = key;
      if (element) {
        let View: any;
        const runtime = hookRuntime(() => View(stepElement().props));
        ({ NftLaunchStep: View } = await importFresh("src/components/NftLaunchStep.tsx", {
          react: { file: import.meta.resolve("react"), bindings: runtime.hooks },
          "../lib/nft-client": { file: import.meta.resolve("../src/lib/nft-client.ts"), bindings: { readNftStatus: status } },
          "../lib/use-launch-fee": { file: import.meta.resolve("../src/lib/use-launch-fee.ts"), bindings: { useLaunchFee: () => ({ state: "none", record: null }) } },
        }));
        step = runtime;
      }
    }
    step?.render();
  }
  /** React re-renders the step with the page; here both render until nothing changes. */
  const flush = async () => { for (let i = 0; i < 8; i++) { await settle(); parent.render(); await syncStep(); } };
  const input = (name: string) => find(parent.output(), (element) => element.type === "input" && element.props.name === name);
  const form = {
    /** The identity fields as the Identity step shows them. */
    fields: () => ({ name: input("name").props.value, symbol: input("symbol").props.value, image: input("image").props.value }),
    /** Whether the Identity step says the image is the NFT's. */
    nftImageNotice: () => !!find(parent.output(), (element) => element.props?.id === "token-image-nft"),
    type: async (name: string, value: string) => { input(name).props.onChange({ target: { value } }); await flush(); },
    /** Picks an NFT from the wallet list, opening the list first when an NFT is already chosen. */
    async pick(contract: string, tokenId: string, name?: string) {
      const change = find(step!.output(), (element) => element.type === "button" && textOf(element) === "Change");
      if (change) { change.props.onClick(); await flush(); }
      find(step!.output(), (element) => element.type === NftPicker).props.onPick({ contract, tokenId, name, image: `https://img.test/${tokenId}` });
      await flush();
    },
    /** Lets the step's live check (400 ms after the last change) run and answer. */
    async check() { t.mock.timers.tick(400); await flush(); },
    /** Releases a held status read. */
    async answer(tokenId: string) { held.get(tokenId)!(); await flush(); },
    async nftMode(next: boolean) {
      find(parent.output(), (element) => typeof element.props?.onChange === "function" && "nftMode" in element.props).props.onChange(next);
      await flush();
    },
    /** The pair buttons the Economics step shows: address, whether selected, whether it can be chosen. */
    pairs: () => nodes(parent.output()).filter((element) => element.type === "button" && String(element.props.className).startsWith("stock-option"))
      .map((element) => ({ address: String(element.key), selected: element.props["aria-pressed"] === true, enabled: !element.props.disabled,
        choose: async () => { element.props.onClick(); await flush(); } })),
    /** The hint and notices the Economics step shows next to the pair. */
    text: () => textOf(parent.output()),
    /** The NFT step's own text, including its live check status. */
    stepText: () => textOf(step?.output()),
    /** The draft as the autosave (250 ms after the last change) stores it. */
    async saved() { t.mock.timers.tick(250); await flush(); return JSON.parse(store.get(launchDraftKey(config)) ?? "null"); },
  };
  t.after(() => { step?.unmount(); parent.unmount(); });
  parent.render(); await flush();
  return form;
}
/** A draft saved with Muse #1's prefilled name and symbol; `nftPrefill` is the ownership record (absent before 2026-10-15). */
export const bardDraft = (extra: Record<string, unknown> = {}) => ({ name: "Bard", symbol: "BARD", description: "", image: "", website: "", twitter: "",
  telegram: "", quoteAddress: "0x0379E228F6887c6F18bf394042ECAF81B308cb2e", tradingFeeBps: 100, nft: { chainId: 4663, contract: MUSES.contract, tokenId: "1" },
  nftMode: true, step: 1, ...extra });
export const muse = (tokenId: string) => [MUSES.contract, tokenId] as const;

