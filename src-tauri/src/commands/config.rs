//! Config load/save over `tauri-plugin-store`, plus the config-facing commands
//! (spec §8, §13). The same `config.json` store is shared with the JS side.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "config.json";
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+`";

/// Floor for a stored panel size, mirroring `minWidth`/`minHeight` in
/// `tauri.conf.json`. The window manager refuses to go below those, so a
/// smaller stored number would only ever replay as a size the window never
/// actually had — clamp on the way in and the two stay honest.
pub const MIN_LAUNCHER_W: f64 = 460.0;
pub const MIN_LAUNCHER_H: f64 = 320.0;

/// Last size the user dragged the launcher window to (logical pixels).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub hotkey: String,
    pub launch_on_startup: bool,
    /// Module ids the user toggled off: hidden from the grid, and any
    /// background service they own is stopped.
    #[serde(default)]
    pub disabled_modules: Vec<String>,
    /// Module ids the user pinned, in pin order. Pinned modules sort to the
    /// front of the launcher grid and get their own tray entries.
    #[serde(default)]
    pub pinned_modules: Vec<String>,
    /// Per-module global hotkeys: module id → accelerator chord.
    #[serde(default)]
    pub module_hotkeys: Map<String, Value>,
    /// Eco mode: every background service paused, module toggles untouched.
    #[serde(default)]
    pub eco_mode: bool,
    /// Persisted size for the *panel* views (a module, or settings); None until
    /// the user first resizes one. The module grid is excluded on purpose — it
    /// fits itself to its content, which changes with the pin count.
    #[serde(default)]
    pub launcher_size: Option<WindowSize>,
    pub tools: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            launch_on_startup: false,
            disabled_modules: Vec::new(),
            pinned_modules: Vec::new(),
            module_hotkeys: Map::new(),
            eco_mode: false,
            launcher_size: None,
            tools: Map::new(),
        }
    }
}

/// Read the persisted config, filling any missing key with its default.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Config {
    let Ok(store) = app.store(STORE_FILE) else {
        return Config::default();
    };
    let mut cfg = Config::default();
    if let Some(Value::String(hotkey)) = store.get("hotkey") {
        cfg.hotkey = hotkey;
    }
    if let Some(Value::Bool(startup)) = store.get("launchOnStartup") {
        cfg.launch_on_startup = startup;
    }
    if let Some(Value::Array(disabled)) = store.get("disabledModules") {
        cfg.disabled_modules = disabled
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect();
    }
    if let Some(Value::Array(pinned)) = store.get("pinnedModules") {
        cfg.pinned_modules = pinned
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect();
    }
    if let Some(Value::Object(hotkeys)) = store.get("moduleHotkeys") {
        cfg.module_hotkeys = hotkeys;
    }
    if let Some(Value::Bool(eco)) = store.get("ecoMode") {
        cfg.eco_mode = eco;
    }
    if let Some(size) = store.get("launcherSize") {
        cfg.launcher_size = serde_json::from_value(size).ok();
    }
    if let Some(Value::Object(tools)) = store.get("tools") {
        cfg.tools = tools;
    }
    rename_module(&mut cfg, "pulse", "runtime");
    cfg
}

/// Carry a renamed module's saved state across the rename, in place (pure;
/// unit-tested). A config written before `pulse` became `runtime` still keys
/// its toggle, pin, hotkey and settings bag under the old id; without this the
/// user silently loses all four. Anything already stored under the new id wins,
/// so this is idempotent and safe to run on every load.
pub fn rename_module(cfg: &mut Config, from: &str, to: &str) {
    for list in [&mut cfg.disabled_modules, &mut cfg.pinned_modules] {
        if list.iter().any(|m| m == to) {
            list.retain(|m| m != from);
        } else if let Some(slot) = list.iter_mut().find(|m| *m == from) {
            *slot = to.to_string();
        }
    }
    for bag in [&mut cfg.module_hotkeys, &mut cfg.tools] {
        if let Some(value) = bag.remove(from) {
            bag.entry(to.to_string()).or_insert(value);
        }
    }
}

/// The valid (string-valued) module hotkey bindings, as (id, chord) pairs.
pub fn module_hotkeys(cfg: &Config) -> Vec<(String, String)> {
    cfg.module_hotkeys
        .iter()
        .filter_map(|(id, v)| v.as_str().map(|chord| (id.clone(), chord.to_string())))
        .collect()
}

/// Persist the whole config to the store file.
pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &Config) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("hotkey", json!(cfg.hotkey));
    store.set("launchOnStartup", json!(cfg.launch_on_startup));
    store.set("disabledModules", json!(cfg.disabled_modules));
    store.set("pinnedModules", json!(cfg.pinned_modules));
    store.set("moduleHotkeys", Value::Object(cfg.module_hotkeys.clone()));
    store.set("ecoMode", json!(cfg.eco_mode));
    store.set("launcherSize", json!(cfg.launcher_size));
    store.set("tools", Value::Object(cfg.tools.clone()));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_config<R: Runtime>(app: AppHandle<R>) -> Config {
    load(&app)
}

#[tauri::command]
pub fn set_config<R: Runtime>(app: AppHandle<R>, config: Config) -> Result<Config, String> {
    save(&app, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn set_hotkey<R: Runtime>(app: AppHandle<R>, chord: String) -> Result<(), String> {
    let mut cfg = load(&app);
    cfg.hotkey = chord;
    // Re-register first so an invalid/conflicting chord fails before we persist it.
    crate::hotkey::register_all(&app, &cfg)?;
    save(&app, &cfg)
}

/// Bind (or clear, with `chord: None`) a per-module launch hotkey.
#[tauri::command]
pub fn set_module_hotkey<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    chord: Option<String>,
) -> Result<Config, String> {
    let mut cfg = load(&app);
    match &chord {
        Some(c) => {
            cfg.module_hotkeys.insert(id, json!(c));
        }
        None => {
            cfg.module_hotkeys.remove(&id);
        }
    }
    // Register before persisting; on failure roll the bindings back to the
    // stored config so a bad chord never leaves the hotkeys half-applied.
    if let Err(e) = crate::hotkey::register_all(&app, &cfg) {
        let _ = crate::hotkey::register_all(&app, &load(&app));
        return Err(e);
    }
    save(&app, &cfg)?;
    Ok(cfg)
}

/// Eco mode: pause/resume every background service without touching the
/// per-module enabled toggles.
#[tauri::command]
pub fn set_eco_mode<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<Config, String> {
    let mut cfg = load(&app);
    cfg.eco_mode = enabled;
    save(&app, &cfg)?;
    if enabled {
        super::stop_all_services(&app);
    } else {
        super::start_enabled_services(&app, &cfg);
    }
    Ok(cfg)
}

/// Persist the size the user dragged a *panel* to (logical pixels, debounced
/// JS-side). The module grid does not go through here: it sizes itself to its
/// own content, so there is nothing about it worth remembering.
#[tauri::command]
pub fn set_launcher_size<R: Runtime>(
    app: AppHandle<R>,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite()) {
        return Err("invalid window size".into());
    }
    let mut cfg = load(&app);
    cfg.launcher_size = Some(WindowSize {
        width: width.clamp(MIN_LAUNCHER_W, 4096.0),
        height: height.clamp(MIN_LAUNCHER_H, 4096.0),
    });
    save(&app, &cfg)
}

/// Toggle a module on/off: persists the choice and starts/stops any
/// background service the module owns. Returns the updated config.
#[tauri::command]
pub fn set_module_enabled<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    enabled: bool,
) -> Result<Config, String> {
    let mut cfg = load(&app);
    cfg.disabled_modules.retain(|m| m != &id);
    if !enabled {
        cfg.disabled_modules.push(id.clone());
    }
    save(&app, &cfg)?;
    // Under eco mode services stay paused; the toggle only takes effect once
    // eco is switched off again.
    super::apply_module_service(&app, &id, enabled && !cfg.eco_mode);
    // A disabled module's launch hotkey is freed; re-enabling restores it.
    if let Err(e) = crate::hotkey::register_all(&app, &cfg) {
        eprintln!("[brucekit] hotkey re-registration failed: {e}");
    }
    // The tray lists pinned modules that are actually usable, so a toggle can
    // add or remove an entry there too.
    if let Err(e) = crate::tray::refresh(&app, &cfg) {
        eprintln!("[brucekit] tray rebuild failed: {e}");
    }
    Ok(cfg)
}

/// Pin/unpin a module: pinned ids sort to the front of the grid and get their
/// own tray entries, so the tray menu is rebuilt as part of the same call.
#[tauri::command]
pub fn set_module_pinned<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    pinned: bool,
) -> Result<Config, String> {
    let mut cfg = load(&app);
    cfg.pinned_modules.retain(|m| m != &id);
    if pinned {
        cfg.pinned_modules.push(id);
    }
    save(&app, &cfg)?;
    if let Err(e) = crate::tray::refresh(&app, &cfg) {
        eprintln!("[brucekit] tray rebuild failed: {e}");
    }
    Ok(cfg)
}

#[tauri::command]
pub fn set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        // A debug build lives at `target/debug` and loads its UI from the Vite
        // dev server, so registering it means Windows boots a binary that finds
        // nothing to render at login. Record the preference and let the
        // installed build claim the OS entry on its next launch.
        if cfg!(debug_assertions) {
            eprintln!("[brucekit] autostart: preference saved; a debug build never claims the OS entry");
        } else {
            manager.enable().map_err(|e| e.to_string())?;
        }
    } else {
        // Clearing is always safe, and from a debug build it is the only way to
        // drop an entry an earlier dev run left pointing at `target/debug`.
        manager.disable().map_err(|e| e.to_string())?;
    }
    let mut cfg = load(&app);
    cfg.launch_on_startup = enabled;
    save(&app, &cfg)
}

/// Re-point the OS autostart entry at the executable that is actually running.
///
/// The entry stores an absolute path, captured whenever the toggle was last
/// flipped — so it goes stale the moment the binary behind it moves. Flipping
/// it during a `tauri dev` session registers `target/debug/brucekit.exe`, which
/// at login has no Vite server to load from and comes up blank; installing the
/// app afterwards leaves that dev path in place, silently, forever. Reinstalling
/// to a different prefix strands it the same way.
///
/// So on every launch we simply re-register, unconditionally. That is not
/// laziness dressed up as idempotence: `is_enabled` cannot be used to detect
/// this, because on Windows it only asks whether a value under that *name*
/// exists and never compares the path inside it (auto-launch 0.5, windows.rs).
/// A stale entry therefore reads as perfectly enabled. `enable` writes the
/// value outright, so re-running it pins the entry to whichever executable is
/// running now — which, at startup, is exactly the one we want booted.
pub fn reconcile_autostart<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_autostart::ManagerExt;
    let cfg = load(app);
    let manager = app.autolaunch();
    if cfg.launch_on_startup {
        // A debug build must never claim the entry — see `set_autostart`.
        if cfg!(debug_assertions) {
            eprintln!("[brucekit] autostart: OS entry left alone (debug build)");
        } else if let Err(e) = manager.enable() {
            eprintln!("[brucekit] autostart re-register failed: {e}");
        }
    } else {
        // Wanted off. `disable` deletes the value and errors when there is
        // nothing to delete, so only reach for it when one is actually there —
        // and for that question `is_enabled` is exactly right.
        if matches!(manager.is_enabled(), Ok(true)) {
            if let Err(e) = manager.disable() {
                eprintln!("[brucekit] autostart cleanup failed: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_through_json() {
        let mut tools = Map::new();
        tools.insert(
            "color-picker".to_string(),
            json!({ "format": "hsl" }),
        );
        let mut hotkeys = Map::new();
        hotkeys.insert("dcheck".to_string(), json!("CommandOrControl+Shift+D"));
        let cfg = Config {
            hotkey: "CommandOrControl+Alt+K".to_string(),
            launch_on_startup: true,
            disabled_modules: vec!["dcheck".to_string()],
            pinned_modules: vec!["clipstack".to_string()],
            module_hotkeys: hotkeys,
            eco_mode: true,
            launcher_size: Some(WindowSize { width: 800.0, height: 520.0 }),
            tools,
        };

        let text = serde_json::to_string(&cfg).unwrap();
        // JS-facing camelCase keys are present in the serialized form.
        assert!(text.contains("launchOnStartup"));
        assert!(text.contains("disabledModules"));
        assert!(text.contains("pinnedModules"));
        assert!(text.contains("moduleHotkeys"));
        assert!(text.contains("ecoMode"));
        assert!(text.contains("launcherSize"));

        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(cfg, back);
        assert_eq!(back.tools["color-picker"]["format"], json!("hsl"));
    }

    #[test]
    fn config_without_disabled_modules_deserializes_empty() {
        // Configs written before the module-toggle feature lack the key.
        let back: Config =
            serde_json::from_str(r#"{"hotkey":"F1","launchOnStartup":false,"tools":{}}"#).unwrap();
        assert!(back.disabled_modules.is_empty());
    }

    #[test]
    fn rename_carries_toggle_pin_hotkey_and_settings_across() {
        let mut cfg = Config {
            disabled_modules: vec!["dcheck".into(), "pulse".into()],
            pinned_modules: vec!["pulse".into(), "clipstack".into()],
            ..Config::default()
        };
        cfg.module_hotkeys.insert("pulse".into(), json!("Alt+P"));
        cfg.tools.insert("pulse".into(), json!({ "intervalSec": 5 }));

        rename_module(&mut cfg, "pulse", "runtime");

        assert_eq!(cfg.disabled_modules, vec!["dcheck", "runtime"]);
        // Pin order is meaningful — the renamed module keeps its slot.
        assert_eq!(cfg.pinned_modules, vec!["runtime", "clipstack"]);
        assert!(!cfg.module_hotkeys.contains_key("pulse"));
        assert_eq!(cfg.module_hotkeys["runtime"], json!("Alt+P"));
        assert_eq!(cfg.tools["runtime"]["intervalSec"], json!(5));
    }

    #[test]
    fn rename_is_idempotent_and_keeps_existing_new_id_state() {
        let mut cfg = Config {
            pinned_modules: vec!["runtime".into(), "pulse".into()],
            ..Config::default()
        };
        cfg.tools.insert("pulse".into(), json!({ "intervalSec": 5 }));
        cfg.tools.insert("runtime".into(), json!({ "intervalSec": 9 }));

        rename_module(&mut cfg, "pulse", "runtime");
        // The stale duplicate is dropped rather than pinning the same tool twice.
        assert_eq!(cfg.pinned_modules, vec!["runtime"]);
        // State already written under the new id is authoritative.
        assert_eq!(cfg.tools["runtime"]["intervalSec"], json!(9));
        assert!(!cfg.tools.contains_key("pulse"));

        let before = cfg.clone();
        rename_module(&mut cfg, "pulse", "runtime");
        assert_eq!(cfg, before);
    }

    #[test]
    fn module_hotkeys_skips_non_string_values() {
        let mut cfg = Config::default();
        cfg.module_hotkeys.insert("pulse".into(), json!("Alt+P"));
        cfg.module_hotkeys.insert("bogus".into(), json!(42));
        assert_eq!(module_hotkeys(&cfg), vec![("pulse".to_string(), "Alt+P".to_string())]);
    }

    #[test]
    fn default_hotkey_is_the_documented_chord() {
        assert_eq!(Config::default().hotkey, "CommandOrControl+Shift+`");
    }
}
