# Board Studio Desktop (Tauri)

Thin native shell that wraps `@board-studio/web`. Config files are scaffolded; the
Rust build is intentionally deferred until the web MVP stabilizes.

## To activate the desktop build

1. Install the Tauri CLI: `pnpm install` (already declared as a dev dependency).
2. Generate icons + capabilities (one-time):
   ```sh
   pnpm --filter @board-studio/desktop tauri icon path/to/logo.png
   ```
   This populates `src-tauri/icons/` and default capability files referenced by
   `tauri.conf.json`.
3. Run dev (boots Vite + native window): `pnpm --filter @board-studio/desktop tauri dev`
4. Build installers (MSI/DMG/DEB): `pnpm --filter @board-studio/desktop tauri build`

Requires the Rust toolchain (`cargo`) and, on Windows, the WebView2 runtime.
