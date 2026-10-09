import {
  getAddress,
  isAddress,
  type Address,
  type EIP1193Provider,
} from "viem";
export type Provider = EIP1193Provider & {
  on?: (event: string, fn: (v: unknown) => void) => void;
  removeListener?: (event: string, fn: (v: unknown) => void) => void;
};
export type WalletOption = {
  id: string;
  name: string;
  rdns: string;
  provider: Provider;
};
export type ConnectionState = {
  account: Address | null;
  chainId: number | null;
  connecting: boolean;
  error: string;
  revision: number;
};
export class WalletConnection {
  state: ConnectionState = {
    account: null,
    chainId: null,
    connecting: false,
    error: "",
    revision: 0,
  };
  selected: WalletOption | null = null;
  private epoch = 0;
  private cleanup = () => {};
  private pending = new WeakSet<Provider>();
  constructor(
    private changed: (state: ConnectionState) => void,
    private remember: (rdns: string | null) => void = () => {},
  ) {}
  private update(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.changed(this.state);
  }
  private account(value: unknown) {
    const first = Array.isArray(value) ? value[0] : null;
    return typeof first === "string" && isAddress(first, { strict: false })
      ? getAddress(first)
      : null;
  }
  private chain(value: unknown) {
    const chain =
      typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)
        ? Number(value)
        : NaN;
    if (!Number.isSafeInteger(chain) || chain <= 0)
      throw new Error("Invalid wallet network information");
    return chain;
  }
  async select(option: WalletOption, restore = false) {
    if (this.pending.has(option.provider)) {
      this.update({ error: "This wallet already has a connection request. Resolve it in your wallet first." });
      return;
    }
    this.cleanup();
    const epoch = ++this.epoch,
      p = option.provider;
    this.selected = option;
    this.update({ account: null, chainId: null, error: "", connecting: true });
    const accounts = (v: unknown) => {
      const current = ++this.epoch,
        account = this.account(v);
      this.update({ account, connecting: false });
      if (account) this.remember(option.rdns);
      void p
        .request({ method: "eth_chainId" })
        .then((value) => {
          if (current === this.epoch && this.selected?.provider === p)
            this.update({ chainId: this.chain(value) });
        })
        .catch(() => {});
    };
    const chain = (v: unknown) => {
      const current = ++this.epoch;
      try {
        this.update({ chainId: this.chain(v), connecting: false });
        void p
          .request({ method: "eth_accounts" })
          .then((value) => {
            if (current === this.epoch && this.selected?.provider === p) {
              const account = this.account(value);
              this.update({ account });
              if (account) this.remember(option.rdns);
            }
          })
          .catch(() => {});
      } catch {
        this.update({
          chainId: null,
          connecting: false,
          error: "Invalid wallet network information",
        });
      }
    };
    const disconnected = () => {
      this.disconnect();
    };
    p.on?.("accountsChanged", accounts);
    p.on?.("chainChanged", chain);
    p.on?.("disconnect", disconnected);
    this.cleanup = () => {
      p.removeListener?.("accountsChanged", accounts);
      p.removeListener?.("chainChanged", chain);
      p.removeListener?.("disconnect", disconnected);
    };
    // dispose() replaces the set, so a late request only releases the guard it registered in.
    const pending = this.pending;
    pending.add(p);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = Promise.all([
        p.request({ method: restore ? "eth_accounts" : "eth_requestAccounts" }),
        p.request({ method: "eth_chainId" }),
      ]);
      void request.finally(() => pending.delete(p)).catch(() => {});
      const [addresses, chainId] = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The wallet response timed out. Check the connection request in your wallet.")),
            30000,
          );
        }),
      ]);
      if (epoch !== this.epoch) return;
      const account = this.account(addresses);
      if (!account && !restore)
        throw new Error("The wallet is locked or has no authorized account. Unlock it and try again.");
      this.remember(option.rdns);
      this.update({ account, chainId: this.chain(chainId), connecting: false });
    } catch (e) {
      if (epoch !== this.epoch) return;
      const code = (e as { code?: number }).code;
      this.update({
        connecting: false,
        error:
          code === 4001
            ? "Wallet connection cancelled."
            : code === -32002
              ? "The wallet has a pending connection request. Open your wallet to resolve it."
              : e instanceof Error
                ? e.message
                : "Wallet connection failed",
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (epoch === this.epoch && this.state.connecting)
        this.update({ connecting: false });
    }
  }
  disconnect() {
    this.epoch++;
    this.cleanup();
    this.selected = null;
    this.remember(null);
    this.update({ account: null, chainId: null, connecting: false, error: "" });
  }
  dispose() {
    this.epoch++;
    this.cleanup();
    this.selected = null;
    // The epoch discards in-flight results, so their prompts must not block the next owner's restore.
    this.pending = new WeakSet();
  }
  async validate(
    expected: Address,
    chainId: number,
    expectedProvider: Provider,
  ) {
    const epoch = this.epoch,
      p = this.selected?.provider;
    if (!p || p !== expectedProvider || this.state.account !== expected)
      throw new Error("The wallet has changed. Preview again.");
    const [accounts, chain] = await Promise.all([
      p.request({ method: "eth_accounts" }),
      p.request({ method: "eth_chainId" }),
    ]);
    if (
      epoch !== this.epoch ||
      this.selected?.provider !== p ||
      this.account(accounts) !== expected
    )
      throw new Error("The wallet has changed. Preview again.");
    if (this.chain(chain) !== chainId)
      throw new Error("The wallet network does not match. Switch networks and preview again.");
    return p;
  }
}
export function walletAnnouncement(value: unknown): WalletOption | null {
  if (!value || typeof value !== "object") return null;
  const { info, provider } = value as {
    info?: { uuid?: unknown; name?: unknown; rdns?: unknown };
    provider?: Provider;
  };
  if (
    !provider ||
    typeof provider.request !== "function" ||
    !info ||
    typeof info.uuid !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(info.uuid) ||
    typeof info.name !== "string" ||
    typeof info.rdns !== "string"
  )
    return null;
  return {
    id: info.uuid,
    name: info.name.slice(0, 80),
    rdns: info.rdns.slice(0, 128),
    provider,
  };
}
