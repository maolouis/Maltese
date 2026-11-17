// 「小狗自主刷视频」插件面板。
//
// 小狗用独立浏览器看推荐流，按兴趣整理小结，再通过聊天/气泡回传；
// 面板只负责启停、配置、通道诊断与小结展示，不代用户评论或发布。

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./VideoAutomationPlugin.css";
import "../../App.css";
import { useVideoPluginState } from "./useVideoPluginState";
import { VideoChannelCard } from "./VideoChannelCard";
import { VideoDigestList } from "./VideoDigestList";
import { errorMessageForCode, type AgentAccountStatus, type Platform } from "./types";
import { formatDigestMessage } from "../../videoDelivery";

type Props = {
  onNotice: (notice: string) => void;
};

function codeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// 账号状态在界面上一律显示中文：下拉框和右侧状态徽标共用同一份文案，
// 避免中文界面里冒出 draft / awaitingLogin / ready 这些 Rust 枚举值（QA D3）。
const ACCOUNT_STATUS_LABEL: Record<AgentAccountStatus, string> = {
  draft: "草稿",
  awaitingLogin: "等待登录",
  ready: "已就绪",
  paused: "已暂停",
};

export function accountStatusLabel(status: string): string {
  return ACCOUNT_STATUS_LABEL[status as AgentAccountStatus] ?? status;
}

function phaseText(running: boolean, phase: string, waiting: boolean): string {
  if (!running) {
    if (phase === "digesting") return "正在整理小结";
    if (phase === "ended") return "这一轮看完了";
    return "已暂停";
  }
  if (phase === "preparing") return "正在准备小狗浏览器";
  if (phase === "awaitingLogin") return "等待你登录一次";
  if (phase === "userTakeover") return "你接管了，先让你看";
  return waiting ? "等待视频页" : "小狗正在看";
}

export function VideoAutomationPanel({ onNotice }: Props) {
  const video = useVideoPluginState();
  const [provider, setProvider] = useState<Platform>("bilibili");
  const [pageInterval, setPageInterval] = useState(45);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [sampleInterval, setSampleInterval] = useState(2);
  const [dailyDeliveries, setDailyDeliveries] = useState(2);
  const [error, setError] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountName, setAccountName] = useState("小狗运营号");
  const [accountHandle, setAccountHandle] = useState("");
  const [accountPersona, setAccountPersona] = useState("温柔记录每天看到的内容，偶尔分享一条小狗视角的观察。");
  const [accountGoals, setAccountGoals] = useState("每天观看并整理内容，形成运营日志草稿。");

  useEffect(() => {
    const snapshot = video.snapshot;
    if (!snapshot) return;
    setProvider(snapshot.provider);
    setPageInterval(snapshot.intervalSeconds);
    setMaxMinutes(snapshot.maxMinutes);
  }, [video.snapshot]);

  useEffect(() => {
    const selected = video.accounts.find((item) => item.id === selectedAccountId);
    if (selected && selected.platform !== provider) setSelectedAccountId("");
  }, [provider, selectedAccountId, video.accounts]);

  const start = useCallback(async () => {
    setError("");
    try {
      await video.start(provider, selectedAccountId || undefined);
      onNotice(provider === "bilibili" ? "小狗开始看 B 站了" : "小狗开始看抖音了");
    } catch (reason) {
      const message = errorMessageForCode(codeOf(reason), String(reason));
      setError(message);
      onNotice(`启动失败：${message}`);
    }
  }, [onNotice, provider, selectedAccountId, video]);

  const stop = useCallback(async () => {
    setError("");
    try {
      await video.stop();
      onNotice("小狗已停止观看");
    } catch (reason) {
      setError(errorMessageForCode(codeOf(reason), String(reason)));
    }
  }, [onNotice, video]);

  const openLogin = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const account = video.accounts.find((item) => item.id === selectedAccountId);
      if (account) {
        await video.openAccountLogin(account);
        onNotice(`已打开「${account.displayName}」的专用浏览器，请完成注册或登录`);
      } else {
        await invoke("video_open_login_window", { provider });
        onNotice("已打开小狗专用浏览器，请登录一次");
      }
    } catch (reason) {
      setError(errorMessageForCode(codeOf(reason), String(reason)));
    }
  }, [onNotice, provider, selectedAccountId, video]);

  const createAccount = useCallback(async () => {
    setError("");
    try {
      const account = await video.createAccount({
        platform: provider,
        displayName: accountName,
        handle: accountHandle,
        persona: accountPersona,
        goals: accountGoals,
      });
      setSelectedAccountId(account.id);
      onNotice(`已创建「${account.displayName}」账号档案`);
    } catch (reason) {
      setError(String(reason));
    }
  }, [accountGoals, accountHandle, accountName, accountPersona, onNotice, provider, video]);

  const selectedAccount = video.accounts.find((item) => item.id === selectedAccountId) ?? null;

  const saveConfig = useCallback(async () => {
    setError("");
    try {
      await video.updateConfig({
        provider,
        pageIntervalSeconds: Math.max(15, Math.round(pageInterval)),
        maxMinutes: Math.max(1, Math.round(maxMinutes)),
        sampleIntervalSeconds: Math.min(5, Math.max(1, Math.round(sampleInterval))),
        dailyDeliveries: Math.min(5, Math.max(1, Math.round(dailyDeliveries))),
      });
      onNotice("小狗的观看配置已保存");
    } catch (reason) {
      setError("配置超出允许范围，请检查输入。");
      onNotice(errorMessageForCode(codeOf(reason), "配置保存失败"));
    }
  }, [dailyDeliveries, maxMinutes, onNotice, pageInterval, provider, sampleInterval, video]);

  const openOfficial = useCallback(async (target: "publish" | "live") => {
    const url =
      target === "publish"
        ? provider === "bilibili"
          ? "https://member.bilibili.com/platform/upload/video/frame"
          : "https://creator.douyin.com/creator-micro/content/upload"
        : provider === "bilibili"
          ? "https://link.bilibili.com/p/center/index#/user-center/my-info/live-data"
          : "https://creator.douyin.com/creator-micro/content/manage?enter_from=live";
    try {
      await invoke("video_open_external_url", { url });
      onNotice("已用系统浏览器打开官方页面；发布与开播仍需你本人确认。");
    } catch (reason) {
      onNotice(errorMessageForCode(codeOf(reason), "打开官方页面失败"));
    }
  }, [onNotice, provider]);

  const draft = video.preview ? formatDigestMessage(video.preview) : "";

  const copyDraft = useCallback(async () => {
    if (!draft) return;
    try {
      await invoke("set_clipboard_text", { text: draft });
      onNotice("观后感草稿已复制，不会替你发表评论");
    } catch {
      onNotice("复制失败");
    }
  }, [draft, onNotice]);

  const snapshot = video.snapshot;
  const running = snapshot?.running ?? false;

  // 「在视频下评论」：只有点发送才会执行，小狗不会自动评论。
  const [commentDraft, setCommentDraft] = useState("");
  const [commentStatus, setCommentStatus] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);

  const postComment = async () => {
    const text = commentDraft.trim();
    if (!text || commentBusy) return;
    setCommentBusy(true);
    setCommentStatus("正在把评论输入到视频页面…");
    try {
      const report = await invoke<{
        ok: boolean;
        reason: string;
        message: string;
        platform: string;
      }>("video_post_comment", { text });
      if (report.ok) {
        setCommentStatus("评论已提交，去页面里确认一下是否显示");
        setCommentDraft("");
      } else {
        setCommentStatus(report.message || `没发出去（${report.reason}）`);
      }
    } catch (error) {
      setCommentStatus(`发送失败：${String(error)}`);
    } finally {
      setCommentBusy(false);
    }
  };
  return (
    <section className="video-automation" aria-label="小狗刷视频">
      <div className="video-automation__head">
        <div>
          <span className="assistant-panel__label">小狗自主观看</span>
          <strong>
            {phaseText(running, snapshot?.phase ?? "idle", snapshot?.waitingForBrowser ?? false)}
          </strong>
        </div>
        <span className="video-automation__steps">
          条目 {snapshot?.itemCount ?? 0} · 强兴趣 {snapshot?.strongCount ?? 0}
        </span>
      </div>

      <div className="video-automation__controls">
        <select
          value={provider}
          disabled={running}
          onChange={(event) => setProvider(event.currentTarget.value as Platform)}
        >
          <option value="bilibili">B站推荐流</option>
          <option value="douyin">抖音推荐流（实验）</option>
        </select>
        <label>
          每次翻页 <input type="number" min={15} max={600} value={pageInterval} onChange={(event) => setPageInterval(Number(event.currentTarget.value) || 45)} /> 秒
        </label>
        <label>
          上限 <input type="number" min={1} max={240} value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.currentTarget.value) || 30)} /> 分钟
        </label>
        <label>
          采集间隔 <input type="number" min={1} max={5} value={sampleInterval} onChange={(event) => setSampleInterval(Number(event.currentTarget.value) || 2)} /> 秒
        </label>
        <label>
          每天投递 <input type="number" min={1} max={5} value={dailyDeliveries} onChange={(event) => setDailyDeliveries(Number(event.currentTarget.value) || 2)} /> 次
        </label>
        {running ? (
          <button type="button" onClick={() => void stop()}>停下</button>
        ) : (
          <button type="button" onClick={() => void start()}>开始看</button>
        )}
        <button type="button" onClick={() => void saveConfig()}>保存配置</button>
        <button type="button" onClick={() => void openLogin()}>打开登录窗</button>
        <button type="button" onClick={() => void video.loadSessions()}>刷新历史</button>
      </div>

      <div className="video-automation__account">
        <div className="video-automation__comment-head">
          <span className="assistant-panel__label">小狗自媒体账号</span>
          <span className="video-automation__hint">每个账号使用独立浏览器 profile</span>
        </div>
        <div className="video-automation__account-row">
          <select
            value={selectedAccountId}
            onChange={(event) => {
              const id = event.currentTarget.value;
              setSelectedAccountId(id);
              if (id) void video.setActiveAccount(id);
            }}
          >
            <option value="">临时观看，不绑定账号</option>
            {video.accounts.filter((item) => item.platform === provider).map((item) => (
              <option key={item.id} value={item.id}>{item.displayName} · {accountStatusLabel(item.status)}</option>
            ))}
          </select>
          {selectedAccount && (
            <span className="video-automation__account-status">
              {accountStatusLabel(selectedAccount.status)}
            </span>
          )}
          <button type="button" onClick={() => void openLogin()}>打开账号登录窗</button>
          {selectedAccount?.status === "awaitingLogin" && (
            <button type="button" onClick={() => void video.markAccountReady(selectedAccount.id)}>我已登录</button>
          )}
        </div>
        <div className="video-automation__account-form">
          <input value={accountName} maxLength={32} placeholder="账号名称" onChange={(event) => setAccountName(event.currentTarget.value)} />
          <input value={accountHandle} maxLength={64} placeholder="平台昵称或账号（可选）" onChange={(event) => setAccountHandle(event.currentTarget.value)} />
          <input value={accountPersona} maxLength={500} placeholder="小狗人设" onChange={(event) => setAccountPersona(event.currentTarget.value)} />
          <input value={accountGoals} maxLength={500} placeholder="运营目标" onChange={(event) => setAccountGoals(event.currentTarget.value)} />
          <button type="button" onClick={() => void createAccount()}>创建小狗账号档案</button>
        </div>
        <p className="video-automation__hint">
          创建档案不会替你绕过手机号、邮箱或验证码。打开官方登录窗完成注册后点「我已登录」，小狗才会使用这个账号刷视频和生成运营草稿。
        </p>
      </div>

      <p className="video-automation__hint">
        小狗会用自己的浏览器实例看推荐流，不需要你盯着屏幕；窗口不会被提到前台。
        首次使用请点「打开登录窗」登录一次。抖音适配仍是实验特性。
      </p>
      {snapshot?.currentUrl && (
        <p className="video-automation__hint">当前页：{snapshot.currentUrl}</p>
      )}
      {snapshot?.degraded && (
        <p className="video-automation__hint video-automation__hint--warn">
          当前使用较低能力通道，时长与互动可能不完整。
        </p>
      )}
      {error && (
        <p className="video-automation__hint video-automation__hint--warn">{error}</p>
      )}

      <VideoChannelCard
        channel={video.channel}
        diagnostics={video.diagnostics}
        onProbe={() => void video.probeChannels()}
      />

      <VideoDigestList
        pendingCount={snapshot?.pendingCount ?? 0}
        preview={video.preview}
        sessions={video.sessions}
        onTake={() => void video.takePending()}
        onLoadSessions={() => void video.loadSessions()}
        onClear={(includeProfile) => void video.clearData(includeProfile)}
      />

      <div className="video-automation__section">
        <div className="video-automation__comment-head">
          <span className="assistant-panel__label">在视频下评论</span>
          <span className="video-automation__hint">只有你点发送时才会发出去</span>
        </div>
        <textarea
          rows={3}
          maxLength={200}
          value={commentDraft}
          placeholder="写一条评论（1–200 字），发到当前打开的视频下面"
          onChange={(event) => setCommentDraft(event.currentTarget.value)}
        />
        <div className="video-automation__comment-actions">
          <button
            type="button"
            disabled={commentBusy || !commentDraft.trim()}
            onClick={() => void postComment()}
          >
            {commentBusy ? "发送中…" : "发送评论"}
          </button>
          <span className="video-automation__hint">
            {commentDraft.length > 0 ? `${commentDraft.length}/200` : ""}
          </span>
        </div>
        {commentStatus && (
          <p className="video-automation__hint" role="status">{commentStatus}</p>
        )}
      </div>
      <div className="video-automation__section">
        <div className="video-automation__comment-head">
          <span className="assistant-panel__label">观后感草稿</span>
          <button type="button" disabled={!draft} onClick={() => void copyDraft()}>复制草稿</button>
        </div>
        <textarea readOnly rows={3} value={draft} placeholder="小狗看完后会在这里整理一份只给你看的草稿" />
        <p className="video-automation__hint">
          草稿只用于预览和复制，小狗不会把它输入任何评论框，也不会代你点赞、关注或发布。
        </p>
        <div className="video-automation__comment-actions">
          <button type="button" onClick={() => void openOfficial("publish")}>打开投稿页</button>
          <button type="button" onClick={() => void openOfficial("live")}>打开直播中心</button>
        </div>
      </div>
    </section>
  );
}
