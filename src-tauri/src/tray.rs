//! Tray icon + menu (spec §9).

use std::error::Error;

use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn Error>> {
    let startup_checked = crate::commands::config::load(app).launch_on_startup;

    let open = MenuItemBuilder::with_id("open", "Open brucekit").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let startup = CheckMenuItemBuilder::with_id("startup", "Launch on startup")
        .checked(startup_checked)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&open, &settings, &startup])
        .separator()
        .item(&quit)
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("missing default window icon")?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("brucekit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::window::toggle_launcher(app),
            "settings" => crate::window::open_settings(app),
            "startup" => {
                let enabled = !crate::commands::config::load(app).launch_on_startup;
                let _ = crate::commands::config::set_autostart(app.clone(), enabled);
            }
            "quit" => app.exit(0),
            _ => {}
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
