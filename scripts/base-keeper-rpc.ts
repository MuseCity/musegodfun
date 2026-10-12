import { createTransport, http, type EIP1193RequestFn, type Transport } from "viem";
import { mainnetRpcUrl, redact, type DeploymentChainId, type RuntimeEnvironment } from "../server/config";

const FRESH_MS = 15_000, MAX_GUARDS = 32;
const stateBlockPosition: Record<string, number> = {
  eth_call: 1, eth_getCode: 1, eth_getBalance: 1, eth_getTransactionCount: 1,
  eth_getStorageAt: 2, eth_getProof: 2,
};
type Request = { method: string; params?: readonly unknown[] };
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const quantity = (value: unknown): bigint | undefined => typeof value === "string" && /^0x[\da-f]+$/i.test(value) ? BigInt(value) : undefined;
function pending(reason: string, cause?: unknown, detail?: string) {
  // Never retain a provider error cause, which includes URLs and request bodies.
  let status: number | undefined, code: number | undefined, error = cause as any;
  const seen = new Set<unknown>();
  for (let depth = 0; error && depth < 8 && !seen.has(error); depth++, error = error.cause) {
    seen.add(error);
    const candidate = error.status ?? error.statusCode;
    if (Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) status ??= candidate;
    if (Number.isInteger(error.code) && (code === undefined || code === -1)) code = error.code;
  }
  return new Error(`Host RPC pending: ${reason}${status ? ` (HTTP ${status})` : ""}${code !== undefined ? ` (RPC ${code})` : ""}${detail ? `: ${detail}` : ""}`);
}
function endpoint(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw pending("invalid HTTPS endpoint"); }
}
function header(value: unknown) {
  const block = value as { number?: unknown; hash?: unknown } | null, number = quantity(block?.number);
  if (number === undefined || !hash(block?.hash)) throw pending("canonical header unavailable");
  return { number, hash: block.hash.toLowerCase() };
}

/** Maintenance-only transport: state stays on the existing archive provider.
 * Metadata uses public RPC (Base logs retain archive), without fallback or retry.
 * Fixed historical state is bound to the same chain and block at both providers. */
export function baseKeeperRpcTransport(chainId: DeploymentChainId, environment: RuntimeEnvironment, archiveRpcUrl: string): Transport {
  if (chainId !== 8453 && chainId !== 4663) throw pending("unsupported chain");
  const publicUrl = endpoint(mainnetRpcUrl(chainId, { ...environment, ALCHEMY_API_KEY: undefined }));
  const archiveUrl = endpoint(archiveRpcUrl), sameProvider = publicUrl === archiveUrl;
  return parameters => {
    if (parameters.chain && parameters.chain.id !== chainId) throw pending("client chain mismatch");
    const options = { ...parameters, timeout: 15_000, retryCount: 0 };
    const publicRpc = http(publicUrl, { batch: { batchSize: 20, wait: 0 }, retryCount: 0 })(options);
    const archiveRpc = sameProvider ? publicRpc : http(archiveUrl, { batch: { batchSize: 20, wait: 0 }, retryCount: 0 })(options);
    type Provider = typeof publicRpc;
    const networks = new Map<Provider, { expires: number; work?: Promise<void> }>();
    const guards = new Map<string, { expires: number; pending: boolean; work: Promise<void> }>();
    let publicSlot = Promise.resolve(), lastPublicRequest = -Infinity;
    function safeDetail(cause: unknown) {
      let detail = "", error = cause as any;
      const seen = new Set<unknown>();
      for (let depth = 0; error && depth < 8 && !seen.has(error); depth++, error = error.cause) {
        seen.add(error);
        // viem's formatted message contains Request body and metaMessages.
        // Its standard details (or the leaf provider message) do not add those.
        if (typeof error.details === "string") detail = error.details;
        else if (!error.cause && typeof error.message === "string") detail = error.message;
      }
      for (const url of [publicUrl, archiveUrl]) detail = detail.split(url).join("[upstream]");
      return redact(detail.replace(/^(?:Request body|Request params|Params):.*$/gim, ""), environment).replace(/\s+/g, " ").trim();
    }
    const raw = async (provider: Provider, request: Request): Promise<unknown> => {
      if (chainId === 8453 && provider === publicRpc) {
        // The existing Base public endpoint permits 25 RPCs/second. Reserve
        // slots for all metadata/guard requests, leaving room for other reads.
        const slot=publicSlot.then(async()=>{
          const wait=Math.max(0,60-(performance.now()-lastPublicRequest));
          if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
          lastPublicRequest=performance.now();
        });
        publicSlot=slot;await slot;
      }
      try { return await provider.request(request as any); }
      catch (error) {
        const method = /^[a-z][a-z\d_]{0,79}$/i.test(request.method) ? request.method : "unsupported_method";
        throw pending(`${provider === publicRpc ? "public" : "archive"} ${method} request unavailable`, error, safeDetail(error));
      }
    };
    function network(value: unknown) {
      if (quantity(value) !== BigInt(chainId)) throw pending("provider chain mismatch");
    }
    async function ensureNetwork(provider: Provider) {
      const retained = networks.get(provider);
      if (retained && (retained.work || retained.expires > Date.now())) return retained.work;
      const entry = { expires: 0, work: undefined as Promise<void> | undefined };
      networks.set(provider, entry);
      entry.work = raw(provider, { method: "eth_chainId" }).then(value => { network(value); entry.expires = Date.now() + FRESH_MS; })
        .catch(error => { if (networks.get(provider) === entry) networks.delete(provider); throw error; })
        .finally(() => { entry.work = undefined; });
      return entry.work;
    }
    async function boundBlock(selector: unknown) {
      const object = selector && typeof selector === "object" ? selector as { blockNumber?: unknown; blockHash?: unknown; requireCanonical?: unknown } : undefined;
      const number = quantity(selector) ?? quantity(object?.blockNumber) ?? (selector === "earliest" ? 0n : undefined);
      const blockHash = object?.blockHash;
      if (number === undefined && !hash(blockHash) || number !== undefined && blockHash !== undefined) throw pending("unsupported historical block selector");
      const key = number !== undefined ? `number:${number}` : `hash:${String(blockHash).toLowerCase()}:${object?.requireCanonical === true}`;
      const retained = guards.get(key);
      if (retained && (retained.pending || retained.expires > Date.now())) return retained.work;
      for (const [id, entry] of guards) if (!entry.pending && entry.expires <= Date.now()) guards.delete(id);
      if (guards.size >= MAX_GUARDS) guards.delete(guards.keys().next().value!);
      const entry = { expires: 0, pending: true, work: Promise.resolve() };
      entry.work = (async () => {
        await Promise.all([ensureNetwork(publicRpc), ensureNetwork(archiveRpc)]);
        const request: Request = number !== undefined ? { method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, false] }
          : { method: "eth_getBlockByHash", params: [blockHash, false] };
        const [first, second] = (await Promise.all([raw(publicRpc, request), raw(archiveRpc, request)])).map(header);
        if (first.number !== second.number || first.hash !== second.hash || number !== undefined && first.number !== number ||
          number === undefined && first.hash !== String(blockHash).toLowerCase()) throw pending("provider block mismatch");
        if (object?.requireCanonical === true) {
          const canonical: Request = { method: "eth_getBlockByNumber", params: [`0x${first.number.toString(16)}`, false] };
          const current = (await Promise.all([raw(publicRpc, canonical), raw(archiveRpc, canonical)])).map(header);
          if (current.some(block => block.number !== first.number || block.hash !== first.hash)) throw pending("noncanonical block hash");
        }
        entry.expires = Date.now() + FRESH_MS;
      })().catch(error => { if (guards.get(key) === entry) guards.delete(key); throw error; }).finally(() => { entry.pending = false; });
      guards.set(key, entry);
      return entry.work;
    }
    return createTransport({ key: "base-keeper-rpc", name: "Host public/archive RPC", type: "custom", timeout: 15_000, retryCount: 0,
      request: (async (input: Request) => {
        const index = stateBlockPosition[input.method];
        const provider = index !== undefined || input.method === "eth_getLogs" && chainId === 8453 ? archiveRpc : publicRpc;
        if (input.method === "eth_chainId") {
          const value = await raw(publicRpc, input); network(value); networks.set(publicRpc, { expires: Date.now() + FRESH_MS }); return value;
        }
        if (!sameProvider && index !== undefined && input.params?.[index] !== undefined &&
          !["latest", "pending", "safe", "finalized"].includes(String(input.params[index]))) await boundBlock(input.params[index]);
        await ensureNetwork(provider);
        return raw(provider, input);
      }) as EIP1193RequestFn,
    });
  };
}
