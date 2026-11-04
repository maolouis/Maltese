// 网易云音乐歌词获取：按"歌名 + 歌手"搜索歌曲 ID，再拉取 LRC 歌词。
// 使用公开接口，无需登录；失败时返回可读错误由前端降级显示。
use serde::Serialize;
use std::time::Duration;

const SEARCH_URL: &str = "https://music.163.com/api/search/get/web";
const LYRIC_URL: &str = "https://music.163.com/api/song/lyric";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

#[derive(Serialize)]
pub struct LyricsResult {
    pub lrc: String,
    pub song_title: String,
}

#[tauri::command]
pub async fn fetch_lyrics(title: String, artist: Option<String>) -> Result<LyricsResult, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("没有正在播放的歌曲".to_string());
    }
    let artist = artist.unwrap_or_default().trim().to_string();
    let query = if artist.is_empty() {
        title.clone()
    } else {
        format!("{title} {artist}")
    };

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))?;

    let search: serde_json::Value = client
        .get(SEARCH_URL)
        .query(&[("s", query.as_str()), ("type", "1"), ("limit", "1")])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|error| format!("搜索歌曲失败：{error}"))?
        .json()
        .await
        .map_err(|error| format!("搜索响应解析失败：{error}"))?;

    let song = &search["result"]["songs"][0];
    let song_id = song["id"]
        .as_i64()
        .ok_or_else(|| "没有找到这首歌的歌词".to_string())?;
    let song_title = song["name"].as_str().unwrap_or(&title).to_string();

    let lyric: serde_json::Value = client
        .get(LYRIC_URL)
        .query(&[
            ("id", song_id.to_string()),
            ("lv", "1".to_string()),
            ("kv", "1".to_string()),
            ("tv", "-1".to_string()),
        ])
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|error| format!("获取歌词失败：{error}"))?
        .json()
        .await
        .map_err(|error| format!("歌词响应解析失败：{error}"))?;

    let lrc = lyric["lrc"]["lyric"].as_str().unwrap_or_default().to_string();
    if lrc.trim().is_empty() {
        return Err("这首歌暂时没有歌词".to_string());
    }
    Ok(LyricsResult { lrc, song_title })
}