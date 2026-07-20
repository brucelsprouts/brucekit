//! Config load/save over `tauri-plugin-store`, plus the config-facing commands
//! (spec §8, §13). The same `config.json` store is shared with the JS side.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "config.json";
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+`";

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
    /// Persisted launcher size; None until the user first resizes.
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

/// Persist the launcher size the user dragged to (logical pixels, debounced JS-side).
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
        width: width.clamp(560.0, 4096.0),
        height: height.clamp(400.0, 4096.0),
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
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    let mut cfg = load(&app);
    cfg.launch_on_startup = enabled;
    save(&app, &cfg)
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
