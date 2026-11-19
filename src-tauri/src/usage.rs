//! Token 用量记录（MVP）：按天 JSONL 落盘到数据目录 `usage/usage-YYYY-MM-DD.jsonl`。
//!
//! 每条记录：{at, source, backend, model, promptTokens, completionTokens, cachedTokens,
//! totalTokens, precision, durationMs, ok}。命令：usage_record / usage_summary / usage_clear。

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
};

pub const USAGE_DIR: &str = "usage";

pub fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}
pub const SOURCES: [&str; 6] = [
    "chat",
    "proactive",
    "decision",
    "video-comment",
    "agent",
    "memory",
];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub at: u64,
    pub source: String,
    pub backend: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub precision: String,
    pub duration_ms: u64,
    pub ok: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub day: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub requests: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub days: u32,
    pub total: UsageStats,
    pub by_source: std::collections::BTreeMap<String, UsageStats>,
    pub exact_requests: u64,
    pub estimated_requests: u64,
    pub failed_requests: u64,
    pub avg_duration_ms: u64,
    pub by_model: std::collections::BTreeMap<String, UsageStats>,
    pub latest: Option<UsageRecord>,
}

fn usage_dir() -> PathBuf {
    crate::paths::data_root().join(USAGE_DIR)
}

fn today_key(now: u64) -> String {
    let seconds = now / 86_400;
    // 以 1970-01-01 起的天数换 UTC 日期（避免引入 chrono）。
    let days = seconds as i64;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn file_for(day: &str) -> PathBuf {
    usage_dir().join(format!("usage-{day}.jsonl"))
}

/// 估算 token：中文 1.6 字/token、其余 4 字符/token（与前端 petMemory 口径一致）。
/// 来源归一化：未知/缺失一律归入 chat。
pub fn normalize_source(source: Option<&str>) -> String {
    let value = source.unwrap_or("chat").trim();
    if SOURCES.contains(&value) {
        value.to_string()
    } else {
        "chat".to_string()
    }
}

pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let mut cjk = 0u64;
    let mut other = 0u64;
    for ch in text.chars() {
        if ('\u{3400}'..='\u{9fff}').contains(&ch)
            || ('\u{3000}'..='\u{303f}').contains(&ch)
            || ('\u{ff00}'..='\u{ffef}').contains(&ch)
        {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    ((cjk as f64 / 1.6) + (other as f64 / 4.0)).ceil() as u64
}

/// 从 OpenAI 兼容响应里读 `usage`。
pub fn usage_from_value(value: &serde_json::Value) -> Option<(u64, u64, u64)> {
    let usage = value.get("usage")?;
    let prompt = usage.get("prompt_tokens")?.as_u64()?;
    let completion = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let cached = usage
        .get("prompt_tokens_details")
        .and_then(|details| details.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Some((prompt, completion, cached))
}

/// 记录一条用量（失败只 eprintln，不抛错）。
pub fn record(entry: UsageRecord) {
    let day = today_key(entry.at);
    if fs::create_dir_all(usage_dir()).is_err() {
        eprintln!("[usage] 无法创建 usage 目录");
        return;
    }
    match serde_json::to_string(&entry) {
        Ok(line) => {
            let path = file_for(&day);
            let result = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut file| writeln!(file, "{line}"));
            if let Err(error) = result {
                eprintln!("[usage] 写入失败 {}: {error}", path.display());
            }
        }
        Err(error) => eprintln!("[usage] 序列化失败: {error}"),
    }
}

fn read_day(day: &str) -> Vec<UsageRecord> {
    let path = file_for(day);
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<UsageRecord>(&line).ok())
        .collect()
}

pub fn summary(days: u32, now: u64) -> UsageSummary {
    let days = days.clamp(1, 31);
    let mut summary = UsageSummary {
        days,
        ..Default::default()
    };
    let today = today_key(now);
    // 近 N 天：用 UTC 天数倒推，避免 chrono。
    let today_index = now / 86_400;
    let mut day_keys = Vec::new();
    for offset in 0..days as u64 {
        day_keys.push(today_key((today_index.saturating_sub(offset)) * 86_400));
    }
    let mut duration_total = 0u64;
    let mut duration_count = 0u64;
    let mut all_records: Vec<UsageRecord> = Vec::new();
    for day in &day_keys {
        for record in read_day(day) {
            if !SOURCES.contains(&record.source.as_str()) {
                continue;
            }
            let stats = summary.by_source.entry(record.source.clone()).or_default();
            stats.prompt_tokens += record.prompt_tokens;
            stats.completion_tokens += record.completion_tokens;
            stats.cached_tokens += record.cached_tokens;
            stats.total_tokens += record.total_tokens;
            stats.requests += 1;
            summary.total.prompt_tokens += record.prompt_tokens;
            summary.total.completion_tokens += record.completion_tokens;
            summary.total.cached_tokens += record.cached_tokens;
            summary.total.total_tokens += record.total_tokens;
            summary.total.requests += 1;
            duration_total += record.duration_ms;
            duration_count += 1;
            if !record.ok {
                summary.failed_requests += 1;
            }
            let model_key = format!("{}:{}", record.backend, record.model);
            let model_stats = summary.by_model.entry(model_key).or_default();
            model_stats.total_tokens += record.total_tokens;
            model_stats.requests += 1;
            all_records.push(record.clone());
            if record.precision == "exact" {
                summary.exact_requests += 1;
            } else {
                summary.estimated_requests += 1;
            }
        }
    }
    summary.total.day = today;
    summary.avg_duration_ms = if duration_count > 0 { duration_total / duration_count } else { 0 };
    all_records.sort_by_key(|record| record.at);
    summary.latest = all_records.last().cloned();
    summary
}

pub fn clear() -> std::io::Result<()> {
    let dir = usage_dir();
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with("usage-") {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn usage_record(entry: UsageRecord) -> Result<(), String> {
    record(entry);
    Ok(())
}

#[tauri::command]
pub fn usage_summary(days: Option<u32>) -> UsageSummary {
    summary(days.unwrap_or(1), now_seconds())
}

#[tauri::command]
pub fn usage_clear() -> Result<(), String> {
    clear().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_cjk_and_ascii() {
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("你好小狗") >= 2);
        assert!(estimate_tokens("hello world") >= 2);
    }

    #[test]
    fn parse_openai_usage() {
        let value = serde_json::json!({
            "usage": { "prompt_tokens": 120, "completion_tokens": 45, "prompt_tokens_details": { "cached_tokens": 30 } }
        });
        assert_eq!(usage_from_value(&value), Some((120, 45, 30)));
        let missing = serde_json::json!({ "choices": [] });
        assert_eq!(usage_from_value(&missing), None);
    }
}