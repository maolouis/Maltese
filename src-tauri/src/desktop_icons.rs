//! 桌面图标台球：把真实的桌面快捷方式图标当成台球来打。
//!
//! 玩法参照开源项目 desktop-icon-billiards（作者 GitHub@liuxiaogang-com，MIT）：
//! 图标就是球——真实图标在桌面上滚动、碰撞、入袋，退出后恢复原样。
//!
//! 实现要点：
//! * 用 `LVM_GETITEMPOSITION` 读出每个图标的原始位置，先把它们摆成三角球阵；
//! * 游戏过程中按物理结果批量 `LVM_SETITEMPOSITION` 搬动真实图标；
//! * 开始前把原始位置写进 `%APPDATA%\maltese\billiards-backup.json`，
//!   退出、关窗、甚至程序上次异常退出后再次启动，都会据此恢复桌面。
//! * 桌面如果开着「自动排列 / 对齐到网格」，会临时关掉并在退出时还原，否则搬不动。
use std::{
    mem::size_of,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use windows::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT},
    System::{
        Diagnostics::Debug::ReadProcessMemory,
        Memory::{VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE},
        Threading::{OpenProcess, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE},
    },
    UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GetClassNameW, GetWindowLongW, GetWindowRect,
        GetWindowThreadProcessId, IsWindowVisible, SendMessageTimeoutW, SetWindowLongW,
        SMTO_ABORTIFHUNG, GWL_STYLE,
    },
};

// ListView 消息
const LVM_FIRST: u32 = 0x1000;
const LVM_GETITEMCOUNT: u32 = LVM_FIRST + 4;
const LVM_SETITEMPOSITION: u32 = LVM_FIRST + 15;
const LVM_GETITEMPOSITION: u32 = LVM_FIRST + 16;
const LVM_GETITEMSPACING: u32 = LVM_FIRST + 51;
const LVM_SETEXTENDEDLISTVIEWSTYLE: u32 = LVM_FIRST + 54;
const LVM_GETEXTENDEDLISTVIEWSTYLE: u32 = LVM_FIRST + 55;

// 样式位
const LVS_AUTOARRANGE: i32 = 0x0100;
const LVS_EX_SNAPTOGRID: u32 = 0x0008_0000;
const LVS_EX_DOUBLEBUFFER: u32 = 0x0001_0000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconCell {
    /// 在 ListView 里的行号，移动图标时要用
    pub index: i32,
    /// 屏幕坐标（图标左上角）
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIconLayout {
    pub visible: bool,
    pub area_x: i32,
    pub area_y: i32,
    pub area_w: i32,
    pub area_h: i32,
    pub cells: Vec<DesktopIconCell>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct BackupEntry {
    index: i32,
    x: i32,
    y: i32,
}

// 退出时要还原的东西：图标原始位置 + 被我们临时改掉的桌面样式。
static BACKUP: Mutex<Option<Vec<BackupEntry>>> = Mutex::new(None);
/// 只有用户显式开了一局台球才为 true。
/// 任何搬动图标的入口都以它为前提，杜绝「应用一启动就重排桌面」（issue #1）。
static GAME_ACTIVE: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Copy)]
struct StyleBackup {
    auto_arrange: bool,
    snap_to_grid: bool,
}
static STYLE_BACKUP: Mutex<Option<StyleBackup>> = Mutex::new(None);

fn backup_path() -> Option<PathBuf> {
    let base = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(base).join("maltese").join("billiards-backup.json"))
}

fn write_backup_file(entries: &[BackupEntry]) {
    let Some(path) = backup_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(entries) {
        let _ = std::fs::write(path, text);
    }
}

fn read_backup_file() -> Option<Vec<BackupEntry>> {
    let path = backup_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn clear_backup_file() {
    if let Some(path) = backup_path() {
        let _ = std::fs::remove_file(path);
    }
}

fn find_desktop_listview() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(windows::core::w!("Progman"), None).ok()?;
        let view = FindWindowExW(Some(progman), None, windows::core::w!("SHELLDLL_DefView"), None).ok();
        if let Some(view) = view {
            if let Ok(list) = FindWindowExW(Some(view), None, windows::core::w!("SysListView32"), None) {
                if IsWindowVisible(list).as_bool() {
                    return Some(list);
                }
            }
        }
        // WorkerW 场景
        let mut current = FindWindowW(windows::core::w!("WorkerW"), None).ok();
        while let Some(hwnd) = current {
            if let Ok(view) = FindWindowExW(Some(hwnd), None, windows::core::w!("SHELLDLL_DefView"), None) {
                if let Ok(list) = FindWindowExW(Some(view), None, windows::core::w!("SysListView32"), None) {
                    if IsWindowVisible(list).as_bool() {
                        return Some(list);
                    }
                }
            }
            current = FindWindowExW(None, Some(hwnd), windows::core::w!("WorkerW"), None).ok();
        }
        None
    }
}

fn process_id_of(window: HWND) -> Option<u32> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 { None } else { Some(pid) }
    }
}

fn list_view_count(list: HWND) -> Option<i32> {
    let mut value: usize = 0;
    let ok = unsafe {
        SendMessageTimeoutW(
            list,
            LVM_GETITEMCOUNT,
            windows::Win32::Foundation::WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000,
            Some(&mut value),
        )
    };
    if ok.0 == 0 { None } else { Some(value as i32) }
}

fn list_view_spacing(list: HWND) -> (i32, i32) {
    let mut value: usize = 0;
    let _ = unsafe {
        SendMessageTimeoutW(
            list,
            LVM_GETITEMSPACING,
            windows::Win32::Foundation::WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            2000,
            Some(&mut value),
        )
    };
    let spacing = value as i32;
    let cx = (spacing & 0xFFFF).max(48);
    let cy = ((spacing >> 16) & 0xFFFF).max(48);
    (cx, cy)
}

/// 读取所有图标的原始位置（客户端坐标）。
fn read_positions(list: HWND, count: i32) -> Vec<BackupEntry> {
    let Some(pid) = process_id_of(list) else { return Vec::new() };
    let Ok(explorer) = (unsafe {
        OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
            false,
            pid,
        )
    }) else {
        return Vec::new();
    };
    unsafe {
        let remote = VirtualAllocEx(
            explorer,
            None,
            size_of::<POINT>() * 2,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            let _ = CloseHandle(explorer);
            return Vec::new();
        }
        let mut entries = Vec::with_capacity(count as usize);
        for index in 0..count {
            let mut ok_value: usize = 0;
            let ok = SendMessageTimeoutW(
                list,
                LVM_GETITEMPOSITION,
                windows::Win32::Foundation::WPARAM(index as usize),
                LPARAM(remote as isize),
                SMTO_ABORTIFHUNG,
                800,
                Some(&mut ok_value),
            );
            if ok.0 == 0 || ok_value == 0 {
                continue;
            }
            let mut point = POINT::default();
            let mut read = 0usize;
            if ReadProcessMemory(
                explorer,
                remote,
                &mut point as *mut POINT as *mut _,
                size_of::<POINT>(),
                Some(&mut read),
            )
            .is_err()
            {
                continue;
            }
            entries.push(BackupEntry {
                index,
                x: point.x,
                y: point.y,
            });
        }
        let _ = VirtualFreeEx(explorer, remote, 0, MEM_RELEASE);
        let _ = CloseHandle(explorer);
        entries
    }
}

/// 批量设置图标位置（客户端坐标）。
fn move_icons(list: HWND, moves: &[(i32, i32, i32)]) {
    for (index, x, y) in moves {
        let packed = ((*y as u32 & 0xFFFF) << 16) | (*x as u32 & 0xFFFF);
        let mut ok_value: usize = 0;
        let _ = unsafe {
            SendMessageTimeoutW(
                list,
                LVM_SETITEMPOSITION,
                windows::Win32::Foundation::WPARAM(*index as usize),
                LPARAM(packed as isize),
                SMTO_ABORTIFHUNG,
                400,
                Some(&mut ok_value),
            )
        };
    }
}

/// 关掉「自动排列 / 对齐到网格」，否则图标会被立刻吸回去。
fn relax_styles(list: HWND) {
    unsafe {
        let style = GetWindowLongW(list, GWL_STYLE);
        let mut backup = StyleBackup {
            auto_arrange: false,
            snap_to_grid: false,
        };
        if style & LVS_AUTOARRANGE != 0 {
            SetWindowLongW(list, GWL_STYLE, style & !LVS_AUTOARRANGE);
            backup.auto_arrange = true;
        }
        let mut extended: usize = 0;
        let _ = SendMessageTimeoutW(
            list,
            LVM_GETEXTENDEDLISTVIEWSTYLE,
            windows::Win32::Foundation::WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            500,
            Some(&mut extended),
        );
        let extended = extended as u32;
        if extended & LVS_EX_SNAPTOGRID != 0 {
            let next = (extended & !LVS_EX_SNAPTOGRID) | LVS_EX_DOUBLEBUFFER;
            let _ = SendMessageTimeoutW(
                list,
                LVM_SETEXTENDEDLISTVIEWSTYLE,
                windows::Win32::Foundation::WPARAM(next as usize),
                LPARAM(next as isize),
                SMTO_ABORTIFHUNG,
                500,
                None,
            );
            backup.snap_to_grid = true;
        }
        if let Ok(mut slot) = STYLE_BACKUP.lock() {
            *slot = Some(backup);
        }
    }
}

fn restore_styles(list: HWND) {
    let backup = STYLE_BACKUP.lock().ok().and_then(|mut slot| slot.take());
    let Some(backup) = backup else { return };
    unsafe {
        if backup.auto_arrange {
            let style = GetWindowLongW(list, GWL_STYLE);
            SetWindowLongW(list, GWL_STYLE, style | LVS_AUTOARRANGE);
        }
        if backup.snap_to_grid {
            let mut extended: usize = 0;
            let _ = SendMessageTimeoutW(
                list,
                LVM_GETEXTENDEDLISTVIEWSTYLE,
                windows::Win32::Foundation::WPARAM(0),
                LPARAM(0),
                SMTO_ABORTIFHUNG,
                500,
                Some(&mut extended),
            );
            let next = (extended as u32) | LVS_EX_SNAPTOGRID;
            let _ = SendMessageTimeoutW(
                list,
                LVM_SETEXTENDEDLISTVIEWSTYLE,
                windows::Win32::Foundation::WPARAM(next as usize),
                LPARAM(next as isize),
                SMTO_ABORTIFHUNG,
                500,
                None,
            );
        }
    }
}

fn empty_layout(error: &str) -> DesktopIconLayout {
    DesktopIconLayout {
        visible: false,
        area_x: 0,
        area_y: 0,
        area_w: 0,
        area_h: 0,
        cells: Vec::new(),
        error: Some(error.to_string()),
    }
}

/// 开一局：读图标、记录原始位置（内存 + 文件双保险）、关掉吸铁石样式。
#[tauri::command]
pub fn desktop_icons_begin_game() -> DesktopIconLayout {
    let Some(list) = find_desktop_listview() else {
        return empty_layout("没有找到桌面图标列表（图标可能被隐藏了）");
    };
    let Some(count) = list_view_count(list) else {
        return empty_layout("读取桌面图标数量超时（资源管理器可能正忙）");
    };
    if count == 0 {
        return empty_layout("桌面上没有图标");
    }
    let positions = read_positions(list, count);
    if positions.is_empty() {
        return empty_layout("读不到图标位置（可能需要以管理员身份运行）");
    }

    // 先把原始状态存好，再动桌面。
    write_backup_file(&positions);
    if let Ok(mut slot) = BACKUP.lock() {
        *slot = Some(positions.clone());
    }
    GAME_ACTIVE.store(true, Ordering::SeqCst);
    relax_styles(list);

    let (spacing_x, spacing_y) = list_view_spacing(list);
    let mut area = RECT::default();
    unsafe {
        let _ = GetWindowRect(list, &mut area);
    }

    // 屏幕坐标换算：ListView 客户区左上角
    let mut origin = POINT { x: 0, y: 0 };
    unsafe {
        let _ = windows::Win32::Graphics::Gdi::ClientToScreen(list, &mut origin);
    }

    let cells = positions
        .iter()
        .map(|entry| DesktopIconCell {
            index: entry.index,
            x: entry.x + origin.x,
            y: entry.y + origin.y,
            w: spacing_x,
            h: spacing_y,
        })
        .collect();

    DesktopIconLayout {
        visible: true,
        area_x: area.left,
        area_y: area.top,
        area_w: area.right - area.left,
        area_h: area.bottom - area.top,
        cells,
        error: None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconMove {
    pub index: i32,
    /// 屏幕坐标
    pub x: i32,
    pub y: i32,
}

/// 批量搬动真实图标（屏幕坐标 → 客户端坐标）。
#[tauri::command]
pub fn desktop_icons_move(moves: Vec<IconMove>) -> Result<(), String> {
    // 没开局就谁也不许动图标（前端窗口可能在后台被挂载/卸载）。
    if !GAME_ACTIVE.load(Ordering::SeqCst) {
        return Ok(());
    }
    let Some(list) = find_desktop_listview() else {
        return Err("桌面图标列表不可用".to_string());
    };
    let mut origin = POINT { x: 0, y: 0 };
    unsafe {
        let _ = windows::Win32::Graphics::Gdi::ClientToScreen(list, &mut origin);
    }
    let payload: Vec<(i32, i32, i32)> = moves
        .into_iter()
        .filter(|item| item.index >= 0)
        .map(|item| (item.index, item.x - origin.x, item.y - origin.y))
        .collect();
    move_icons(list, &payload);
    Ok(())
}

/// 恢复桌面：只在「这一局真的开过」时动图标。
/// 以前这里会退回读取备份文件，导致应用启动、窗口挂载/卸载时也可能搬动图标。
#[tauri::command]
pub fn desktop_icons_restore() -> Result<(), String> {
    if !GAME_ACTIVE.swap(false, Ordering::SeqCst) {
        return Ok(());
    }
    let entries = BACKUP.lock().ok().and_then(|mut slot| slot.take());
    let Some(entries) = entries else {
        clear_backup_file();
        return Ok(());
    };
    let Some(list) = find_desktop_listview() else {
        clear_backup_file();
        return Ok(());
    };
    move_icons(
        list,
        &entries
            .iter()
            .map(|entry| (entry.index, entry.x, entry.y))
            .collect::<Vec<_>>(),
    );
    restore_styles(list);
    clear_backup_file();
    Ok(())
}

/// 启动时兜底还原：上次台球没正常退出时，把桌面图标位置改回来。
pub fn restore_desktop_on_startup() {
    let Some(entries) = read_backup_file() else { return };
    let Some(list) = find_desktop_listview() else { return };
    move_icons(
        list,
        &entries
            .iter()
            .map(|entry| (entry.index, entry.x, entry.y))
            .collect::<Vec<_>>(),
    );
    clear_backup_file();
}

/// 桌面图标是否可见（隐藏图标时不给入口）。
#[tauri::command]
pub fn desktop_icons_available() -> bool {
    find_desktop_listview().is_some()
}

/// 读窗口类名（调试用）。
#[allow(dead_code)]
fn window_class(window: HWND) -> String {
    unsafe {
        let mut buffer = [0u16; 256];
        let length = GetClassNameW(window, &mut buffer);
        String::from_utf16_lossy(&buffer[..length.max(0) as usize])
    }
}