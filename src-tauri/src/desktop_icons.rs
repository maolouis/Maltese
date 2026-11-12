//! 桌面图标台球：读取桌面图标的屏幕位置，供「和小狗打台球」使用。
//!
//! 参考开源项目 desktop-icon-billiards（作者 GitHub@liuxiaogang-com，MIT）：
//! 它把桌面图标当成台球，在桌面上瞄准、蓄力、击球并让图标滚动入袋，退出后恢复。
//!
//! 这里刻意只做「读取」不做「搬运」：真实移动桌面图标需要跨进程写 explorer 的
//! ListView 位置，一旦进程异常退出就可能把用户桌面搞乱。所以 Maltese 的版本是
//! 一层透明覆盖窗口，按图标真实位置画球、做物理与入袋，桌面本身保持原样。
use std::mem::size_of;
use windows::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM, POINT},
    System::{
        Memory::{
            VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
        },
        Diagnostics::Debug::ReadProcessMemory,
        Threading::{OpenProcess, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE},
    },
    UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetClassNameW, GetWindowThreadProcessId, IsWindowVisible,
        SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETTEXT,
    },
};

// ListView 消息
const LVM_FIRST: u32 = 0x1000;
const LVM_GETITEMCOUNT: u32 = LVM_FIRST + 4;
const LVM_GETITEMPOSITION: u32 = LVM_FIRST + 16;
const LVM_GETITEMSPACING: u32 = LVM_FIRST + 51;

/// 图标在屏幕坐标里的可点击格子（用于台球的碰撞体）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconCell {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconLayout {
    /// 桌面图标是否可见（隐藏图标时游戏没意义）
    pub visible: bool,
    /// 桌面列表视图的屏幕矩形
    pub area_x: i32,
    pub area_y: i32,
    pub area_w: i32,
    pub area_h: i32,
    /// 每个图标的格子
    pub cells: Vec<DesktopIconCell>,
    pub error: Option<String>,
}

fn find_desktop_listview() -> Option<HWND> {
    unsafe {
        // 背景壁纸线程可能是 WorkerW，也可能是旧式 Progman。
        let progman = FindWindowW(windows::core::w!("Progman"), None).ok()?;
        for parent in [progman] {
            if let Ok(view) = FindWindowExW(Some(parent), None, windows::core::w!("SHELLDLL_DefView"), None) {
                if let Ok(list) = FindWindowExW(Some(view), None, windows::core::w!("SysListView32"), None) {
                    if IsWindowVisible(list).as_bool() {
                        return Some(list);
                    }
                }
            }
        }
        // WorkerW 兜底：EnumWindows 里逐个找 SHELLDLL_DefView 的父窗口。
        let mut found: Option<HWND> = None;
        let worker = FindWindowW(windows::core::w!("WorkerW"), None).ok();
        let mut current = worker;
        while let Some(hwnd) = current {
            if let Ok(view) = FindWindowExW(Some(hwnd), None, windows::core::w!("SHELLDLL_DefView"), None) {
                if let Ok(list) = FindWindowExW(Some(view), None, windows::core::w!("SysListView32"), None) {
                    if IsWindowVisible(list).as_bool() {
                        found = Some(list);
                        break;
                    }
                }
            }
            current = FindWindowExW(None, Some(hwnd), windows::core::w!("WorkerW"), None).ok();
        }
        found
    }
}

fn process_id_of(window: HWND) -> Option<u32> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 { None } else { Some(pid) }
    }
}

/// 读取桌面图标布局。失败时返回 visible=false + error，前端据此提示。
#[tauri::command]
pub fn desktop_icon_layout() -> DesktopIconLayout {
    let empty = |error: &str| DesktopIconLayout {
        visible: false,
        area_x: 0,
        area_y: 0,
        area_w: 0,
        area_h: 0,
        cells: Vec::new(),
        error: Some(error.to_string()),
    };

    let Some(list) = find_desktop_listview() else {
        return empty("没有找到桌面图标列表（图标可能被隐藏了）");
    };
    let Some(pid) = process_id_of(list) else {
        return empty("无法定位桌面进程");
    };
    let Ok(explorer) = (unsafe {
        OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
            false,
            pid,
        )
    }) else {
        return empty("没有权限读取桌面图标（可能需要以管理员身份运行）");
    };

    let mut area = windows::Win32::Foundation::RECT::default();
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(list, &mut area);
    }
    let area_w = area.right - area.left;
    let area_h = area.bottom - area.top;

    unsafe {
        // LVM_GETITEMPOSITION 要求缓冲区在目标进程里，这里分配一块并读回。
        let remote = VirtualAllocEx(
            explorer,
            None,
            size_of::<POINT>() * 2,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            let _ = CloseHandle(explorer);
            return empty("无法在桌面进程里分配内存");
        }

        let result = (|| -> DesktopIconLayout {
            // 注意：SendMessageTimeoutW 的返回值只是「成功与否」，
            // 真正的结果要写在最后一个 out 参数里，之前误把返回值当数量了。
            let mut count_value: usize = 0;
            let count_ok = SendMessageTimeoutW(
                list,
                LVM_GETITEMCOUNT,
                windows::Win32::Foundation::WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                2000,
                Some(&mut count_value),
            );
            if count_ok.0 == 0 {
                return empty("读取桌面图标数量超时（资源管理器可能正忙）");
            }
            if count_value == 0 {
                return empty("桌面上没有图标");
            }
            let total = (count_value as i32).min(300);

            // 图标格子的间距（比图标本身大一点，正好是点击判定区）。
            let mut spacing_value: usize = 0;
            let _ = SendMessageTimeoutW(
                list,
                LVM_GETITEMSPACING,
                windows::Win32::Foundation::WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                2000,
                Some(&mut spacing_value),
            );
            let spacing = spacing_value as i32;
            let spacing_x = (spacing & 0xFFFF).max(32);
            let spacing_y = ((spacing >> 16) & 0xFFFF).max(32);

            let mut cells = Vec::new();
            for index in 0..total {
                let mut position_ok: usize = 0;
                let ok = SendMessageTimeoutW(
                    list,
                    LVM_GETITEMPOSITION,
                    windows::Win32::Foundation::WPARAM(index as usize),
                    LPARAM(remote as isize),
                    SMTO_ABORTIFHUNG,
                    1000,
                    Some(&mut position_ok),
                );
                if ok.0 == 0 || position_ok == 0 {
                    continue;
                }
                let mut point = POINT::default();
                let mut read = 0usize;
                let read_ok = ReadProcessMemory(
                    explorer,
                    remote,
                    &mut point as *mut POINT as *mut _,
                    size_of::<POINT>(),
                    Some(&mut read),
                );
                if read_ok.is_err() {
                    continue;
                }
                // 图标位置是列表视图的客户区坐标，换算成屏幕坐标。
                let mut screen = point;
                let _ = windows::Win32::Graphics::Gdi::ClientToScreen(list, &mut screen);
                cells.push(DesktopIconCell {
                    x: screen.x,
                    y: screen.y,
                    w: spacing_x,
                    h: spacing_y,
                });
            }

            let _ = VirtualFreeEx(explorer, remote, 0, MEM_RELEASE);
            DesktopIconLayout {
                visible: true,
                area_x: area.left,
                area_y: area.top,
                area_w,
                area_h,
                cells,
                error: None,
            }
        })();

        let _ = CloseHandle(explorer);
        result
    }
}

/// 桌面图标是否可见（隐藏图标时不给入口）。
#[tauri::command]
pub fn desktop_icons_available() -> bool {
    find_desktop_listview().is_some()
}

/// 取窗口标题（用于调试台球窗口挂到哪块屏）。
#[allow(dead_code)]
fn window_title(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 256];
        let _ = SendMessageTimeoutW(
            window,
            WM_GETTEXT,
            windows::Win32::Foundation::WPARAM(buffer.len()),
            LPARAM(buffer.as_mut_ptr() as isize),
            SMTO_ABORTIFHUNG,
            300,
            None,
        );
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(0);
        String::from_utf16_lossy(&buffer[..end])
    }
}

/// 取窗口类名（用于调试）。
#[allow(dead_code)]
fn window_class(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 256];
        let length = GetClassNameW(window, &mut buffer);
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }
}