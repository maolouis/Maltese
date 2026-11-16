//! 外部 URL 白名单的纯逻辑（无 Tauri 依赖，可独立测试）。

pub const ALLOWED_HOSTS: &[&str] = &[
    "member.bilibili.com",
    "link.bilibili.com",
    "creator.douyin.com",
];

/// 返回主机名（小写，去掉端口）；拒绝 userinfo、空主机与非法字符。
pub fn parse_https_host(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let rest = trimmed.strip_prefix("https://")?;
    if rest.contains('@') {
        return None;
    }
    let authority = rest.split('/').next()?;
    if authority.is_empty() {
        return None;
    }
    let host = authority.split(':').next()?.trim().to_lowercase();
    if host.is_empty()
        || host.contains('\\')
        || host.contains(' ')
        || host.starts_with('.')
        || host.ends_with('.')
    {
        return None;
    }
    Some(host)
}

pub fn is_allowed_url(url: &str) -> bool {
    parse_https_host(url)
        .map(|host| ALLOWED_HOSTS.contains(&host.as_str()))
        .unwrap_or(false)
}

pub fn check_url(url: &str) -> Result<(), String> {
    if is_allowed_url(url) {
        Ok(())
    } else {
        Err("仅支持打开 B 站 / 抖音官方页面。".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_official_https_urls() {
        assert!(is_allowed_url(
            "https://member.bilibili.com/platform/upload/video/frame"
        ));
        assert!(is_allowed_url(
            "https://creator.douyin.com/creator-micro/content/upload"
        ));
        assert!(is_allowed_url("https://link.bilibili.com/p/center/index"));
    }

    #[test]
    fn rejects_http_and_unknown_hosts() {
        assert!(!is_allowed_url(
            "http://member.bilibili.com/platform/upload/video/frame"
        ));
        assert!(!is_allowed_url("https://evil.com/x"));
        assert!(!is_allowed_url("https://member.bilibili.com.evil.com/x"));
    }

    #[test]
    fn rejects_userinfo_tricks() {
        assert!(!is_allowed_url("https://evil.com@member.bilibili.com/x"));
        assert!(!is_allowed_url("https://member.bilibili.com@evil.com/x"));
    }

    #[test]
    fn host_is_case_insensitive() {
        assert!(is_allowed_url(
            "https://MEMBER.BILIBILI.COM/platform/upload/video/frame"
        ));
    }

    #[test]
    fn check_returns_message_for_rejection() {
        assert!(check_url("https://evil.com").is_err());
    }
}