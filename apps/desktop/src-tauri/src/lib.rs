/// OpenShaper desktop shell entry point.
///
/// Tauri 2 keeps the run logic in a library (so mobile targets can call it too)
/// and `main.rs` is a thin wrapper. `tauri::generate_context!()` reads
/// `tauri.conf.json` (window config, bundle icons) and the `capabilities/` dir.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OpenShaper");
}
