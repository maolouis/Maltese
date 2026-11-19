//! 窗口懒创建：`tauri.conf.json` 只保留 `main`，其余窗口在第一次需要时
//! 用 `WebviewWindowBuilder` 现场创建。
//!
//! 背景：以前 13 个窗口全部写死在 `tauri.conf.json`，Tauri 启动时会同时创建
//! 13 个 WebView2 并各自加载前端 bundle，冷启动时主窗口的首帧 / GIF 解码 /
//! 同步 IPC 都要和其它隐藏窗口抢 CPU 和 IO，握手失败概率被放大。
//!
//! 这里集中维护每个窗口的创建参数（与之前 `tauri.conf.json` 里的配置一一对应），
//! 所有打开窗口的命令都先走 [`ensure`]：已存在就复用，不存在才创建。
//! 窗口 label 必须仍然写在 `capabilities/default.json` 的 `windows` 里，
//! 否则懒创建出来的窗口拿不到 IPC 权限（事件监听 / window API 会被拒绝）。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 窗口的创建参数，字段与 `tauri.conf.json` 的 window 配置逐项对应。
struct WindowSpec {
    label: &'static str,
    title: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    decorations: bool,
    transparent: bool,
    resizable: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    focusable: bool,
    shadow: bool,
    center: bool,
    /// 是否让 Tauri/wry 接管拖放（原生文件拖放处理器）。
    ///
    /// 默认 `true` 时 wry 会在窗口 HWND 上 `RevokeDragDrop` + `RegisterDragDrop`
    /// 自己的 IDropTarget，只处理 `CF_HDROP` 文件拖入，**网页里的 HTML5 拖放事件
    /// （dragstart/dragover/drop）在 Windows 上收不到**。设置窗口里的表情方格墙
    /// 用 Pointer Events 排序，不依赖 HTML5 DnD，这里保持和主窗口一致关掉它，
    /// 免得将来给设置页加网页内拖放时又踩一次。
    drag_drop_enabled: bool,
}

/// 默认值与 `tauri.conf.json` 的默认窗口配置一致（有边框 / 不透明 / 可缩放）。
fn base(
    label: &'static str,
    title: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
) -> WindowSpec {
    WindowSpec {
        label,
        title,
        url,
        width,
        height,
        min_width: None,
        min_height: None,
        decorations: true,
        transparent: false,
        resizable: true,
        always_on_top: false,
        skip_taskbar: false,
        focusable: true,
        shadow: true,
        center: false,
        drag_drop_enabled: true,
    }
}

/// 桌宠浮层窗口的公共配置：无边框、透明、置顶、不进任务栏、不抢焦点。
fn overlay(
    label: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
) -> WindowSpec {
    let mut window_spec = base(label, "", url, width, height);
    window_spec.decorations = false;
    window_spec.transparent = true;
    window_spec.always_on_top = true;
    window_spec.skip_taskbar = true;
    window_spec.focusable = false;
    window_spec.shadow = false;
    window_spec
}

fn translation() -> WindowSpec {
    let mut window_spec = base(
        "translation",
        "Maltese 有道翻译",
        "index.html?window=translation",
        480.0,
        640.0,
    );
    window_spec.min_width = Some(480.0);
    window_spec.min_height = Some(380.0);
    window_spec.decorations = false;
    window_spec.always_on_top = true;
    window_spec.skip_taskbar = true;
    window_spec.shadow = false;
    window_spec
}

fn bubble() -> WindowSpec {
    overlay("bubble", "index.html?window=bubble", 340.0, 520.0)
}

fn settings() -> WindowSpec {
    let mut window_spec = base(
        "settings",
        "Maltese · 桌宠设置",
        "index.html?window=settings",
        560.0,
        780.0,
    );
    window_spec.min_width = Some(460.0);
    window_spec.min_height = Some(560.0);
    window_spec.center = true;
    // 设置窗口里嵌着表情轮播方格墙（拖动排序），拖放必须留给网页自己处理。
    window_spec.drag_drop_enabled = false;
    window_spec
}

fn companion(index: u32) -> WindowSpec {
    // 陪伴狗 URL 必须带序号，前端据此选择第几条狗。
    let url = match index {
        1 => "index.html?window=companion&id=1",
        2 => "index.html?window=companion&id=2",
        3 => "index.html?window=companion&id=3",
        _ => "index.html?window=companion&id=4",
    };
    let label = match index {
        1 => "companion-1",
        2 => "companion-2",
        3 => "companion-3",
        _ => "companion-4",
    };
    let mut window_spec = overlay(label, url, 200.0, 180.0);
    window_spec.resizable = false;
    window_spec
}

fn bongo_pet() -> WindowSpec {
    let mut window_spec = overlay("bongo-pet", "index.html?window=bongo", 440.0, 358.0);
    window_spec.resizable = false;
    window_spec
}

fn cursor_pet() -> WindowSpec {
    let mut window_spec = overlay("cursor-pet", "index.html?window=cursor", 120.0, 120.0);
    window_spec.resizable = false;
    window_spec
}

fn plugin() -> WindowSpec {
    let mut window_spec = base(
        "plugin",
        "Maltese · 插件",
        "index.html?window=plugin",
        720.0,
        640.0,
    );
    window_spec.min_width = Some(520.0);
    window_spec.min_height = Some(420.0);
    window_spec
}

fn billiards() -> WindowSpec {
    let mut window_spec = base(
        "billiards",
        "和小狗打台球",
        "index.html?window=billiards",
        1280.0,
        800.0,
    );
    window_spec.decorations = false;
    window_spec.transparent = true;
    window_spec.always_on_top = true;
    window_spec.skip_taskbar = true;
    window_spec.shadow = false;
    window_spec.resizable = false;
    window_spec
}

fn pinned() -> WindowSpec {
    let mut window_spec = base(
        "pinned",
        "固定在桌面的标签页",
        "index.html?window=pinned",
        420.0,
        560.0,
    );
    window_spec.min_width = Some(320.0);
    window_spec.min_height = Some(360.0);
    window_spec.decorations = false;
    window_spec.transparent = true;
    window_spec.always_on_top = true;
    window_spec.shadow = false;
    // 「固定在桌面」= 悬浮小窗，不该进任务栏：否则无边框透明窗口会在任务栏渲染成一个
    // 没有标题/图标的灰框（用户反馈 P1）。skip_taskbar 会让 Windows 打上
    // WS_EX_TOOLWINDOW，同时从 Alt+Tab 列表里移除。
    window_spec.skip_taskbar = true;
    window_spec
}

fn spec_for(label: &str) -> Option<WindowSpec> {
    match label {
        "translation" => Some(translation()),
        "bubble" => Some(bubble()),
        "settings" => Some(settings()),
        "companion-1" => Some(companion(1)),
        "companion-2" => Some(companion(2)),
        "companion-3" => Some(companion(3)),
        "companion-4" => Some(companion(4)),
        "bongo-pet" => Some(bongo_pet()),
        "cursor-pet" => Some(cursor_pet()),
        "plugin" => Some(plugin()),
        "billiards" => Some(billiards()),
        "pinned" => Some(pinned()),
        _ => None,
    }
}

const LAZY_WINDOW_LABELS: [&str; 12] = [
    "translation",
    "bubble",
    "settings",
    "companion-1",
    "companion-2",
    "companion-3",
    "companion-4",
    "bongo-pet",
    "cursor-pet",
    "plugin",
    "billiards",
    "pinned",
];

/// 已存在就直接返回；不存在就按 [`spec_for`] 现场创建（创建时保持隐藏）。
///
/// **线程要求：绝对不要在主线程上调用。** Windows 下 wry 创建 WebView2 需要
/// 嵌套消息泵，如果从主线程（同步命令 / 事件回调 / 托盘菜单）里一路同步建下来，
/// 窗口 HWND 会建出来但 WebView2 控制器初始化不完：`IsWindowVisible=False`、
/// 子窗口 `Chrome_WidgetWin_0` 是 0×0，表现为「窗口打不开」。
/// 正确做法：`#[tauri::command] async fn`（异步运行时线程）或 `spawn_blocking`
/// / 普通后台线程，让创建消息排进事件循环。Tauri 文档 `WebviewWindowBuilder`
/// 的 Known issues（wry#583）也是这个结论。
pub fn ensure(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }
    build(app, label)
}

/// 只在该窗口配置了懒创建参数时创建；创建失败只记日志并返回 `None`，
/// 让调用方按「没有这只额外的狗」继续，不阻断主流程。
pub fn ensure_if_known(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    match ensure(app, label) {
        Ok(window) => Some(window),
        Err(error) => {
            eprintln!("failed to create window {label}: {error}");
            None
        }
    }
}

fn build(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let Some(window_spec) = spec_for(label) else {
        return Err(format!(
            "window {label} is not configured for lazy creation"
        ));
    };

    let mut builder = WebviewWindowBuilder::new(
        app,
        window_spec.label,
        WebviewUrl::App(window_spec.url.into()),
    )
    .title(window_spec.title)
    .inner_size(window_spec.width, window_spec.height)
    .decorations(window_spec.decorations)
    .transparent(window_spec.transparent)
    .resizable(window_spec.resizable)
    .always_on_top(window_spec.always_on_top)
    .skip_taskbar(window_spec.skip_taskbar)
    .focusable(window_spec.focusable)
    .shadow(window_spec.shadow)
    .visible(false);

    if let (Some(min_width), Some(min_height)) = (window_spec.min_width, window_spec.min_height) {
        builder = builder.min_inner_size(min_width, min_height);
    }
    if window_spec.center {
        builder = builder.center();
    }
    if !window_spec.drag_drop_enabled {
        // 见 `WindowSpec::drag_drop_enabled`：关掉原生拖放处理器，网页才收得到拖放。
        builder = builder.disable_drag_drop_handler();
    }

    let window = builder
        .build()
        .map_err(|error| format!("failed to create window {label}: {error}"))?;

    // 设置窗口点 X 只隐藏不销毁，懒创建时也要挂上同样的关闭拦截。
    if label == "settings" {
        crate::attach_settings_close(&window);
    }
    Ok(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    // P0 防回归：设置窗口与 Bongo 都靠懒创建，配置/参数丢了会出现「设置打不开、Bongo 不出现」。
    #[test]
    fn settings_and_bongo_specs_stay_registered() {
        let settings = spec_for("settings").expect("settings spec");
        assert_eq!(settings.label, "settings");
        assert_eq!(settings.title, "Maltese · 桌宠设置");
        assert_eq!(settings.url, "index.html?window=settings");
        assert!(settings.width >= 460.0 && settings.height >= 560.0);
        assert!(settings.center);

        let bongo = spec_for("bongo-pet").expect("bongo spec");
        assert_eq!(bongo.label, "bongo-pet");
        assert!(bongo.transparent && bongo.always_on_top && !bongo.decorations);
    }

    #[test]
    fn every_spec_has_matching_label_and_url() {
        for label in LAZY_WINDOW_LABELS {
            let window_spec = spec_for(label).expect(label);
            assert_eq!(window_spec.label, label);
            assert!(window_spec.url.starts_with("index.html?window="));
            assert!(window_spec.width > 0.0 && window_spec.height > 0.0);
        }
    }

    #[test]
    fn companion_urls_carry_their_index() {
        for index in 1..=4 {
            let label = format!("companion-{index}");
            let window_spec = spec_for(&label).expect(&label);
            assert_eq!(
                window_spec.url,
                format!("index.html?window=companion&id={index}")
            );
        }
    }

    #[test]
    fn transparent_overlays_do_not_steal_focus() {
        for label in ["bubble", "bongo-pet", "cursor-pet", "companion-1"] {
            let window_spec = spec_for(label).expect(label);
            assert!(window_spec.transparent, "{label}");
            assert!(!window_spec.focusable, "{label}");
            assert!(window_spec.always_on_top, "{label}");
        }
    }

    #[test]
    fn main_is_not_lazily_created() {
        assert!(spec_for("main").is_none());
        assert!(spec_for("nope").is_none());
    }

    /// 设置窗口（和 tauri.conf.json 里的 main）必须关掉原生拖放处理器，否则
    /// Windows 上网页收不到拖动事件，表情方格墙「拖不动」。
    #[test]
    fn settings_disables_native_drag_drop_handler() {
        assert!(!spec_for("settings").expect("settings").drag_drop_enabled);
        // 其它窗口没有网页内拖放需求，保持 Tauri 默认（原生文件拖入行为不变）。
        for label in ["translation", "bubble", "plugin", "billiards", "pinned"] {
            assert!(spec_for(label).expect(label).drag_drop_enabled, "{label}");
        }
    }
}
