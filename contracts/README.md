# Musegod launch guard

This immutable ERC20 wrapper pins one Doppler Bundler and adds a minimum output and deadline to atomic creation plus first buy. It leaves issuance policy to the application's frozen CreateParams. There is no administrator or rescue path. Donated assets remain locked.

Build and test from this directory:

```sh
forge test -vv
```

Export the reproducible deployment artifact from the repository root:

```sh
node contracts/export-artifact.mjs
```

The exporter compiles the production source closure with Solidity 0.8.24 and requires the creation and runtime bytecode to match Forge exactly. Set `SOLC_PATH` if the compiler is outside Foundry's normal macOS/Linux SVM location. The artifact contains ABI, bytecode, immutable references, compiler input SHA256 and dependency hashes. `MusegodLaunchGuard.compiler-input.json` is the standard JSON source verification input.

OpenZeppelin Contracts 5.7.0 is vendored as its unmodified minimal import closure. Its tarball and every source hash are pinned in `lib/openzeppelin-contracts/dependency-lock.json`; keep these files intact.

The tests use an ABI-compatible mock Bundler to isolate rollback and ERC20 behaviors. They do not prove actual Doppler execution or production readiness. The application fork test supplies the separate real-contract execution evidence.
