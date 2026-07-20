//! Tray icon + menu (spec §9).
//!
//! The menu is rebuilt, not mutated: pinned modules appear as their own top
//! entries so a pinned tool is one tray click away, and the set changes
//! whenever the user pins, unpins, or disables something. `refresh` rebuilds
//! the whole menu from config, which keeps one code path honest instead of
//! two that can drift.

use std::error::Error;

use tauri::{
    menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

use crate::commands::config::Config;

/// Menu-id prefix for a pinned module's entry: `pin:<module-id>`.
const PIN_PREFIX: &str = "pin:";

/// The pinned modules worth showing: pinned, still installed-and-enabled, in
/// pin order (pure; unit-tested). A pinned module the user later toggled off
/// would open to nothing, so it drops out of the tray until it's back on.
pub fn tray_modules(cfg: &Config) -> Vec<String> {
    cfg.pinned_modules
        .iter()
        .filter(|id| !cfg.disabled_modules.iter().any(|d| d == *id))
        .cloned()
        .collect()
}

/// `color-picker` → `Color picker`. The tray has no access to the JS registry's
/// display names, and an id is close enough once it's cased like a label.
pub fn menu_label(id: &str) -> String {
    let spaced = id.replace(['-', '_'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, cfg: &Config) -> Result<Menu<R>, Box<dyn Error>> {
    let open = MenuItemBuilder::with_id("open", "Open brucekit").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let startup = CheckMenuItemBuilder::with_id("startup", "Launch on startup")
        .checked(cfg.launch_on_startup)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let mut menu = MenuBuilder::new(app).item(&open);

    let pinned = tray_modules(cfg);
    if !pinned.is_empty() {
        menu = menu.separator();
        for id in &pinned {
            let item = MenuItemBuilder::with_id(format!("{PIN_PREFIX}{id}"), menu_label(id))
                .build(app)?;
            menu = menu.item(&item);
        }
    }

    Ok(menu
        .separator()
        .items(&[&settings, &startup])
        .separator()
        .item(&quit)
        .build()?)
}

/// Rebuild the tray menu from config (pin/unpin, module toggle, startup flip).
/// A missing tray is not an error: on startup `build` runs after config load,
/// and nothing else can observe a tray that doesn't exist yet.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, cfg: &Config) -> Result<(), Box<dyn Error>> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };
    tray.set_menu(Some(build_menu(app, cfg)?))?;
    Ok(())
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn Error>> {
    let cfg = crate::commands::config::load(app);
    let menu = build_menu(app, &cfg)?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("missing default window icon")?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("brucekit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(module) = id.strip_prefix(PIN_PREFIX) {
                crate::window::open_tool(app, module);
                return;
            }
            match id {
                "open" => crate::window::toggle_launcher(app),
                "settings" => crate::window::open_settings(app),
                "startup" => {
                    let enabled = !crate::commands::config::load(app).launch_on_startup;
                    let _ = crate::commands::config::set_autostart(app.clone(), enabled);
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::window::toggle_launcher(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_lists_pinned_modules_in_pin_order() {
        let cfg = Config {
            pinned_modules: vec!["runtime".into(), "clipstack".into()],
            ..Config::default()
        };
        assert_eq!(tray_modules(&cfg), vec!["runtime", "clipstack"]);
    }

    #[test]
    fn disabled_modules_drop_out_of_the_tray() {
        let cfg = Config {
            pinned_modules: vec!["runtime".into(), "clipstack".into()],
            disabled_modules: vec!["runtime".into()],
            ..Config::default()
        };
        assert_eq!(tray_modules(&cfg), vec!["clipstack"]);
    }

    #[test]
    fn no_pins_means_no_extra_entries() {
        assert!(tray_modules(&Config::default()).is_empty());
    }

    #[test]
    fn ids_become_readable_labels() {
        assert_eq!(menu_label("color-picker"), "Color picker");
        assert_eq!(menu_label("ocr-grab"), "Ocr grab");
        assert_eq!(menu_label("runtime"), "Runtime");
    }
}
