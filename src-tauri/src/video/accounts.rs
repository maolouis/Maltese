//! 小狗自媒体账号档案。
//!
//! 账号注册仍由用户在平台官方页面完成。这里负责保存小狗的人设、运营目标和
//! 对应的独立浏览器 profile，避免把主人的登录态和小狗的运营身份混在一起。

use super::model::{now_seconds, Platform};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountStatus {
    Draft,
    AwaitingLogin,
    Ready,
    Paused,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub id: String,
    pub platform: Platform,
    pub display_name: String,
    pub handle: String,
    pub persona: String,
    pub goals: String,
    pub status: AccountStatus,
    pub profile_dir: String,
    pub created_at: u64,
    pub last_login_at: Option<u64>,
    pub last_run_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountFile {
    accounts: Vec<AgentAccount>,
    active_account_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AccountStore {
    path: PathBuf,
    file: AccountFile,
}

impl AccountStore {
    pub fn load(root: &Path) -> Self {
        let path = root.join("accounts.json");
        let file = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AccountFile>(&raw).ok())
            .unwrap_or_default();
        Self { path, file }
    }

    pub fn list(&self) -> Vec<AgentAccount> {
        self.file.accounts.clone()
    }

    pub fn active(&self) -> Option<AgentAccount> {
        let id = self.file.active_account_id.as_deref()?;
        self.file.accounts.iter().find(|item| item.id == id).cloned()
    }

    pub fn create(
        &mut self,
        platform: Platform,
        display_name: String,
        handle: String,
        persona: String,
        goals: String,
        profile_dir: PathBuf,
    ) -> Result<AgentAccount, String> {
        let display_name = display_name.trim().to_string();
        if display_name.is_empty() || display_name.chars().count() > 32 {
            return Err("小狗账号名称需要填写，且不超过 32 个字符。".to_string());
        }
        if self.file.accounts.iter().any(|item| item.platform == platform && item.display_name == display_name) {
            return Err("这个平台已经有同名的小狗账号。".to_string());
        }
        let id = format!("dog-{}-{}", now_seconds(), self.file.accounts.len() + 1);
        let account = AgentAccount {
            id: id.clone(),
            platform,
            display_name,
            handle: handle.trim().chars().take(64).collect(),
            persona: persona.trim().chars().take(500).collect(),
            goals: goals.trim().chars().take(500).collect(),
            status: AccountStatus::Draft,
            profile_dir: profile_dir.to_string_lossy().to_string(),
            created_at: now_seconds(),
            last_login_at: None,
            last_run_at: None,
        };
        self.file.accounts.push(account.clone());
        if self.file.active_account_id.is_none() {
            self.file.active_account_id = Some(id);
        }
        self.save()?;
        Ok(account)
    }

    pub fn set_active(&mut self, id: &str) -> Result<AgentAccount, String> {
        if !self.file.accounts.iter().any(|item| item.id == id) {
            return Err("找不到这个小狗账号。".to_string());
        }
        self.file.active_account_id = Some(id.to_string());
        self.save()?;
        self.active().ok_or_else(|| "小狗账号保存失败。".to_string())
    }

    pub fn mark_login_started(&mut self, id: &str) -> Result<AgentAccount, String> {
        let account = self.file.accounts.iter_mut().find(|item| item.id == id)
            .ok_or_else(|| "找不到这个小狗账号。".to_string())?;
        account.status = AccountStatus::AwaitingLogin;
        self.file.active_account_id = Some(id.to_string());
        let result = account.clone();
        self.save()?;
        Ok(result)
    }

    pub fn mark_ready(&mut self, id: &str) -> Result<AgentAccount, String> {
        let account = self.file.accounts.iter_mut().find(|item| item.id == id)
            .ok_or_else(|| "找不到这个小狗账号。".to_string())?;
        account.status = AccountStatus::Ready;
        account.last_login_at = Some(now_seconds());
        self.file.active_account_id = Some(id.to_string());
        let result = account.clone();
        self.save()?;
        Ok(result)
    }

    pub fn mark_run(&mut self, id: &str) -> Result<(), String> {
        let account = self.file.accounts.iter_mut().find(|item| item.id == id)
            .ok_or_else(|| "找不到这个小狗账号。".to_string())?;
        account.last_run_at = Some(now_seconds());
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_vec_pretty(&self.file).map_err(|error| error.to_string())?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, raw).map_err(|error| error.to_string())?;
        fs::rename(&temp, &self.path).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_marks_account_without_credentials() {
        let root = std::env::temp_dir().join(format!("maltese-video-account-test-{}", now_seconds()));
        let mut store = AccountStore::load(&root);
        let account = store.create(
            Platform::Bilibili,
            "小狗运营号".to_string(),
            "dog".to_string(),
            "温柔记录每天看到的内容".to_string(),
            "每天看视频并整理一条运营日志".to_string(),
            root.join("profiles/dog-1"),
        ).expect("account");
        assert_eq!(account.status, AccountStatus::Draft);
        assert_eq!(store.mark_login_started(&account.id).unwrap().status, AccountStatus::AwaitingLogin);
        assert_eq!(store.mark_ready(&account.id).unwrap().status, AccountStatus::Ready);
        let _ = fs::remove_dir_all(root);
    }
}
