//! 互斥量探针（冷启动卡死专项）：定位「主线程停在哪把锁、被谁持有」。
//!
//! 背景：`docs/diagnostics/cold-start-hang-rootcause.md` 的 dump 证明主线程永久阻塞在
//! Rust `std::sync::Mutex` 的 futex 等待上，但 PDB 只有公有符号，栈里拿不到锁的名字。
//! 本模块给几何相关的锁统一套一层薄壳，输出
//!
//! ```text
//! MUTEX_TRACE lock=<名> thread=<系统 tid> phase=before|after|skip [holder=.. waited_ms=..]
//! ```
//!
//! 设计原则：**不改变任何业务语义**。
//! - 默认（`MALTESE_MUTEX_TRACE` 未设置 / 设为 `1`）：只在 `try_lock` 失败、真的要阻塞时打日志；
//! - `MALTESE_MUTEX_TRACE=all`：每次加锁都打（排查时段用，日志量大）；
//! - `MALTESE_MUTEX_TRACE=0|off|none`：完全关闭。
//!
//! 每把锁额外登记「当前持有者 tid」（原子量，加锁成功写入、guard drop 时清零），
//! 这样阻塞方一条日志就能说出「谁持着」，不必再靠全量 dump 反推。

use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};
use std::time::Instant;

use windows::Win32::System::Threading::GetCurrentThreadId;

/// 锁编号：新增锁时同时补 `LOCK_NAMES` / `LOCK_COUNT`。
pub const WINDOW_STATE: usize = 0;
pub const LAST_SETTLED_ISLAND_RECT: usize = 1;
pub const PRE_MINIMIZE_ISLAND_RECT: usize = 2;
pub const LAST_PERSISTED_RECT: usize = 3;
pub const PINNED_LAST_SET: usize = 4;
pub const PINNED_MANUAL_POSITION: usize = 5;
pub const USER_ISLAND_SIZE: usize = 6;
pub const LOCK_COUNT: usize = 7;

const LOCK_NAMES: [&str; LOCK_COUNT] = [
    "WINDOW_STATE",
    "LAST_SETTLED_ISLAND_RECT",
    "PRE_MINIMIZE_ISLAND_RECT",
    "LAST_PERSISTED_RECT",
    "PINNED_LAST_SET",
    "PINNED_MANUAL_POSITION",
    "USER_ISLAND_SIZE",
];

/// 0 = 没人持锁；否则是持锁线程的系统 tid。
static HOLDERS: [AtomicU32; LOCK_COUNT] = [
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
    AtomicU32::new(0),
];

/// 持锁超过这个时长就记一条日志：`hold_slow` 说明有人「持锁调窗口 API」或干了重活。
const SLOW_LOCK_MS: u128 = 50;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TraceMode {
    /// 不打日志（探针关闭）。
    Off,
    /// 只在真的会阻塞时打（默认）。
    Contended,
    /// 每次加锁都打。
    All,
}

fn trace_mode() -> TraceMode {
    static MODE: OnceLock<TraceMode> = OnceLock::new();
    *MODE.get_or_init(|| match std::env::var("MALTESE_MUTEX_TRACE").ok().as_deref() {
        Some("0") | Some("off") | Some("none") => TraceMode::Off,
        Some("all") => TraceMode::All,
        _ => TraceMode::Contended,
    })
}

fn thread_id() -> u32 {
    unsafe { GetCurrentThreadId() }
}

pub fn name(index: usize) -> &'static str {
    LOCK_NAMES.get(index).copied().unwrap_or("UNKNOWN")
}

/// 该锁当前持有者的系统 tid（0 = 空闲）。
pub fn holder(index: usize) -> u32 {
    HOLDERS
        .get(index)
        .map(|slot| slot.load(Ordering::Acquire))
        .unwrap_or(0)
}

fn trace(index: usize, tid: u32, phase: &str, extra: &str) {
    eprintln!(
        "MUTEX_TRACE lock={} thread={} phase={} {}",
        name(index),
        tid,
        phase,
        extra
    );
}

/// 包了一层日志与持有者登记的 `MutexGuard`。
pub struct TraceGuard<'a, T> {
    inner: Option<MutexGuard<'a, T>>,
    index: usize,
}

impl<T> Deref for TraceGuard<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.inner
            .as_deref()
            .expect("MUTEX_TRACE guard used after drop")
    }
}

impl<T> DerefMut for TraceGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.inner
            .as_deref_mut()
            .expect("MUTEX_TRACE guard used after drop")
    }
}

impl<T> Drop for TraceGuard<'_, T> {
    fn drop(&mut self) {
        // 先清持有者再真正解锁：否则「我们清空」可能抹掉刚抢到锁的下一任持有者。
        HOLDERS[self.index].store(0, Ordering::Release);
        drop(self.inner.take());
    }
}

/// 阻塞式加锁（语义与 `Mutex::lock` 相同，仅多日志/持有者登记）。
pub fn lock<'a, T>(index: usize, mutex: &'a Mutex<T>) -> TraceGuard<'a, T> {
    let tid = thread_id();
    let mode = trace_mode();
    if mode == TraceMode::All {
        trace(index, tid, "before", "");
    }
    let started = Instant::now();
    match mutex.try_lock() {
        Ok(inner) => {
            HOLDERS[index].store(tid, Ordering::Release);
            let waited = started.elapsed().as_millis();
            if mode == TraceMode::All {
                trace(index, tid, "after", &format!("waited_ms={waited}"));
            } else if waited >= SLOW_LOCK_MS {
                trace(index, tid, "after", &format!("waited_ms={waited} slow=true"));
            }
            TraceGuard {
                inner: Some(inner),
                index,
            }
        }
        Err(TryLockError::WouldBlock) => {
            let previous = holder(index);
            trace(
                index,
                tid,
                "before",
                &format!("contended=true holder={previous}"),
            );
            let inner = match mutex.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    trace(index, tid, "poisoned", "");
                    poisoned.into_inner()
                }
            };
            HOLDERS[index].store(tid, Ordering::Release);
            trace(
                index,
                tid,
                "after",
                &format!(
                    "waited_ms={} prev_holder={previous}",
                    started.elapsed().as_millis()
                ),
            );
            TraceGuard {
                inner: Some(inner),
                index,
            }
        }
        Err(TryLockError::Poisoned(poisoned)) => {
            trace(index, tid, "poisoned", "");
            let inner = poisoned.into_inner();
            HOLDERS[index].store(tid, Ordering::Release);
            TraceGuard {
                inner: Some(inner),
                index,
            }
        }
    }
}

/// 非阻塞加锁：拿不到就返回 `None`（缓存类状态用它，主线程永不被永久阻塞）。
pub fn try_lock<'a, T>(index: usize, mutex: &'a Mutex<T>) -> Option<TraceGuard<'a, T>> {
    let tid = thread_id();
    match mutex.try_lock() {
        Ok(inner) => {
            HOLDERS[index].store(tid, Ordering::Release);
            if trace_mode() == TraceMode::All {
                trace(index, tid, "after", "try=true");
            }
            Some(TraceGuard {
                inner: Some(inner),
                index,
            })
        }
        Err(TryLockError::WouldBlock) => {
            let previous = holder(index);
            if trace_mode() != TraceMode::Off {
                trace(
                    index,
                    tid,
                    "skip",
                    &format!("would_block=true holder={previous}"),
                );
            }
            None
        }
        Err(TryLockError::Poisoned(poisoned)) => {
            trace(index, tid, "poisoned", "try=true");
            let inner = poisoned.into_inner();
            HOLDERS[index].store(tid, Ordering::Release);
            Some(TraceGuard {
                inner: Some(inner),
                index,
            })
        }
    }
}