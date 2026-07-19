//! Config load/save over `tauri-plugin-store`, plus the config-facing commands
//! (spec §8, §13). The same `config.json` store is shared with the JS side.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

pub const STORE_FILE: &str = "config.json";
pub const DEFAULT_HOTKEY: &str = "CommandOrControl+Shift+`";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub hotkey: String,
    pub launch_on_startup: bool,
    pub tools: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.to_string(),
            launch_on_startup: false,
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
    if let Some(Value::Object(tools)) = store.get("tools") {
        cfg.tools = tools;
    }
    cfg
}

/// Persist the whole config to the store file.
pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &Config) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set("hotkey", json!(cfg.hotkey));
    store.set("launchOnStartup", json!(cfg.launch_on_startup));
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
    // Re-register first so an invalid chord fails before we persist it.
    crate::hotkey::register(&app, &chord)?;
    let mut cfg = load(&app);
    cfg.hotkey = chord;
    save(&app, &cfg)
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
        let cfg = Config {
            hotkey: "CommandOrControl+Alt+K".to_string(),
            launch_on_startup: true,
            tools,
        };

        let text = serde_json::to_string(&cfg).unwrap();
        // JS-facing camelCase key is present in the serialized form.
        assert!(text.contains("launchOnStartup"));

        let back: Config = serde_json::from_str(&text).unwrap();
        assert_eq!(cfg, back);
        assert_eq!(back.tools["color-picker"]["format"], json!("hsl"));
    }

    #[test]
    fn default_hotkey_is_the_documented_chord() {
        assert_eq!(Config::default().hotkey, "CommandOrControl+Shift+`");
    }
}
