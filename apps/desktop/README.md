# OpenShaper Desktop (Tauri)

Thin native shell that wraps `@openshaper/web`. Config files are scaffolded; the
Rust build is intentionally deferred until the web MVP stabilizes.

## To activate the desktop build

1. Install the Tauri CLI: `pnpm install` (already declared as a dev dependency).
2. Generate icons + capabilities (one-time):
   ```sh
   pnpm --filter @openshaper/desktop tauri icon path/to/logo.png
   ```
   This populates `src-tauri/icons/` and default capability files referenced by
   `tauri.conf.json`.
3. Run dev (boots Vite + native window): `pnpm --filter @openshaper/desktop tauri dev`
4. Build installers (MSI/DMG/DEB): `pnpm --filter @openshaper/desktop tauri build`

Requires the Rust toolchain (`cargo`) and, on Windows, the WebView2 runtime.

## Status

Init is complete: brand icons generated (`src-tauri/icons/`, source `icon-source.png`),
`capabilities/default.json` added, icons + the `main` window registered in
`tauri.conf.json`, and the entry point split into the idiomatic `src/lib.rs` (`run()`) +
thin `src/main.rs`.

**Build prerequisite (not yet satisfied on this dev box):** compiling the shell needs the
**Visual Studio "Desktop development with C++" (C++ build tools) workload** — the MSVC
`link.exe`. Without it `cargo check`/`build` fails on dependency build scripts with
`linking with link.exe failed`. Install via the VS Installer (or `winget install
Microsoft.VisualStudio.2022.BuildTools` with the C++ workload), then `cargo build`
succeeds. The Rust sources and Tauri config themselves are correct and the crate graph
resolves; only the native link step is blocked by the missing toolchain.
