// 「小狗自主刷视频」插件面板。
//
// 小狗用独立浏览器看推荐流，按兴趣整理小结，再通过聊天/气泡回传；
// 面板只负责启停、登录、小结与少量高级设置，不代用户评论或发布。
//
// 信息架构按 QA `docs/qa-video-plugin-2026-11-17.md` §1 精简：
// 一行状态条 + 平台/登录 + 小结 +「高级设置」折叠 +「评论」折叠；
// 首屏不放参数、账号档案、自检、诊断、观后感草稿。

import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import "./VideoAutomationPlugin.css";
import "../../App.css";
import { useVideoPluginState } from "./useVideoPluginState";
import { VideoChannelCard } from "./VideoChannelCard";
import { VideoDigestList } from "./VideoDigestList";
import { accountStatusLabel } from "./videoPanelLogic";
import {
  browserStatusText,
  describeVideoError,
  phaseText,
  resolvePanelError,
  type VideoErrorInfo,
} from "./videoPanelLogic";
import type { Platform } from "./types";

type Props = {
  onNotice: (notice: string) => void;
};

export function VideoAutomationPanel({ onNotice }: Props) {
  const video = useVideoPluginState();
  const [provider, setProvider] = useState<Platform>("bilibili");
  const [pageInterval, setPageInterval] = useState(45);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [sampleInterval, setSampleInterval] = useState(2);
  const [dailyDeliveries, setDailyDeliveries] = useState(2);
  const [localError, setLocalError] = useState<VideoErrorInfo | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [accountName, setAccountName] = useState("小狗运营号");
  const [accountHandle, setAccountHandle] = useState("");
  const [accountPersona, setAccountPersona] = useState("温柔记录每天看到的内容，偶尔分享一条小狗视角的观察。");
  const [accountGoals, setAccountGoals] = useState("每天观看并整理内容，形成运营日志草稿。");
  const [confirmClear, setConfirmClear] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentStatus, setCommentStatus] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);

  const snapshot = video.snapshot;
  const running = snapshot?.running ?? false;

  useEffect(() => {
    if (!snapshot) return;
    setProvider(snapshot.provider);
    setPageInterval(snapshot.intervalSeconds);
    setMaxMinutes(snapshot.maxMinutes);
  }, [snapshot]);

  useEffect(() => {
    const selected = video.accounts.find((item) => item.id === selectedAccountId);
    if (selected && selected.platform !== provider) setSelectedAccountId("");
  }, [provider, selectedAccountId, video.accounts]);

  // U3：错误优先用组件里的即时错误，其次一定回落读取 Rust snapshot 的持久错误，
  // 这样浮层被抢焦点收起、面板重挂载后仍然能看到上次失败原因。
  const panelError = resolvePanelError({
    localError,
    snapshotErrorCode: snapshot?.errorCode,
    snapshotError: snapshot?.error,
    interruptedPhase: snapshot?.phase === "interrupted",
  });

  const start = useCallback(async () => {
    setLocalError(null);
    try {
      await video.start(provider, selectedAccountId || undefined);
      onNotice(provider === "bilibili" ? "小狗开始看 B 站了" : "小狗开始看抖音了");
    } catch (reason) {
      const info = describeVideoError(reason, "启动失败，请稍后再试。");
      setLocalError(info);
      onNotice(`启动失败：${info.message}`);
    }
  }, [onNotice, provider, selectedAccountId, video]);

  const stop = useCallback(async () => {
    setLocalError(null);
    try {
      await video.stop();
      await video.loadBrowserStatus();
      onNotice("小狗已停止观看，专用浏览器已关闭");
    } catch (reason) {
      setLocalError(describeVideoError(reason, "停止失败。"));
    }
  }, [onNotice, video]);

  const openLogin = useCallback(async () => {
    if (!isTauri() || loginBusy) return;
    setLocalError(null);
    setLoginBusy(true);
    try {
      const account = video.accounts.find((item) => item.id === selectedAccountId);
      if (account) {
        await video.openAccountLogin(account);
        onNotice(`已打开「${account.displayName}」的专用浏览器，登录完点「我已登录」`);
      } else {
        // U2：后端会校验「真的出现了可见登录窗」才返回成功。
        await invoke("video_open_login_window", { provider });
        onNotice("已打开小狗专用浏览器，请登录一次");
      }
      await video.loadBrowserStatus();
    } catch (reason) {
      const info = describeVideoError(reason, "打开登录窗失败，请稍后再试。");
      setLocalError(info);
      onNotice(`打开登录窗失败：${info.message}`);
    } finally {
      setLoginBusy(false);
    }
  }, [loginBusy, onNotice, provider, selectedAccountId, video]);

  const createAccount = useCallback(async () => {
    setLocalError(null);
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
      setLocalError(describeVideoError(reason, "创建账号档案失败。"));
    }
  }, [accountGoals, accountHandle, accountName, accountPersona, onNotice, provider, video]);

  const saveConfig = useCallback(async () => {
    setLocalError(null);
    try {
      await video.updateConfig({
        provider,
        pageIntervalSeconds: Math.max(15, Math.round(pageInterval)),
        maxMinutes: Math.max(1, Math.round(maxMinutes)),
        sampleIntervalSeconds: Math.min(5, Math.max(1, Math.round(sampleInterval))),
        dailyDeliveries: Math.min(5, Math.max(1, Math.round(dailyDeliveries))),
      });
      onNotice("本轮观看参数已生效（重开面板会回到已保存值）");
      await video.refresh();
    } catch (reason) {
      setLocalError(describeVideoError(reason, "配置超出允许范围，请检查输入。"));
    }
  }, [dailyDeliveries, maxMinutes, onNotice, pageInterval, provider, sampleInterval, video]);

  const closeBrowser = useCallback(async () => {
    setLocalError(null);
    try {
      await video.closeBrowser();
      onNotice("已关闭专用浏览器");
    } catch (reason) {
      setLocalError(describeVideoError(reason, "关闭专用浏览器失败。"));
    }
  }, [onNotice, video]);

  const clearData = useCallback(async () => {
    setConfirmClear(false);
    setLocalError(null);
    try {
      await video.clearData(false);
      onNotice("已清空观看数据（登录 profile 保留）");
    } catch (reason) {
      setLocalError(describeVideoError(reason, "清空失败。"));
    }
  }, [onNotice, video]);

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
    } catch (reason) {
      setCommentStatus(`发送失败：${describeVideoError(reason, "请稍后再试。").message}`);
    } finally {
      setCommentBusy(false);
    }
  };

  const selectedAccount = video.accounts.find((item) => item.id === selectedAccountId) ?? null;
  const loginLabel = selectedAccount
    ? `${selectedAccount.displayName} · ${accountStatusLabel(selectedAccount.status)}`
    : "未登录（临时观看）";
  const statusLabel = !running && panelError
    ? "本轮失败"
    : phaseText(running, snapshot?.phase ?? "idle", snapshot?.waitingForBrowser ?? false, snapshot?.errorCode);

  return (
    <section className="video-automation" aria-label="小狗刷视频">
      {/* 一行状态条 + 唯一主按钮 */}
      <div className="video-automation__statusbar">
        <div className="video-automation__status">
          <span className="assistant-panel__label">小狗刷视频</span>
          <strong className={`video-automation__phase${running ? " is-running" : ""}`}>{statusLabel}</strong>
          <span className="video-automation__steps">
            条目 {snapshot?.itemCount ?? 0} · 强兴趣 {snapshot?.strongCount ?? 0}
          </span>
        </div>
        <button
          type="button"
          className={`video-automation__primary${running ? " is-stop" : ""}`}
          onClick={() => void (running ? stop() : start())}
        >
          {running ? "停下" : "开始看"}
        </button>
      </div>

      {panelError && (
        <div className="video-automation__error" role="alert">
          <span>{panelError.message}</span>
          {panelError.code && (
            <code className="video-automation__error-code" title="诊断码（排障用）">
              {panelError.code}
            </code>
          )}
        </div>
      )}
      {snapshot?.degraded && (
        <p className="video-automation__muted">当前使用较低能力通道，时长与互动可能不完整。</p>
      )}

      {/* 平台 + 登录：一行 */}
      <div className="video-automation__row">
        <label className="video-automation__provider">
          <span>平台</span>
          <select
            value={provider}
            disabled={running}
            onChange={(event) => setProvider(event.currentTarget.value as Platform)}
          >
            <option value="bilibili">B站推荐流</option>
            <option value="douyin">抖音推荐流（实验）</option>
          </select>
        </label>
        <span className="video-automation__login" title={selectedAccount ? "使用独立浏览器 profile" : "临时观看，不绑定账号档案"}>
          登录：{loginLabel}
        </span>
        <button
          type="button"
          className="video-automation__secondary"
          disabled={loginBusy}
          onClick={() => void openLogin()}
        >
          {loginBusy ? "等待登录…" : "打开登录窗"}
        </button>
        {selectedAccount?.status === "awaitingLogin" && (
          <button
            type="button"
            className="video-automation__secondary"
            onClick={() => void video.markAccountReady(selectedAccount.id)}
          >
            我已登录
          </button>
        )}
      </div>

      <VideoDigestList
        pendingCount={snapshot?.pendingCount ?? 0}
        preview={video.preview}
        sessions={video.sessions}
        onTake={() => void video.takePending()}
        onLoadSessions={() => void video.loadSessions()}
      />

      {/* 高级设置：参数 / 账号档案 / 自检与诊断 / 清空数据 */}
      <details className="video-automation__advanced">
        <summary>高级设置</summary>
        <div className="video-automation__advanced-body">
          <p className="video-automation__muted">
            观看参数仅本次运行有效：重开面板或重启后会回到已保存值（平台、时长上限会跟随上次启动）。
          </p>
          <div className="video-automation__params">
            <label>
              每次翻页
              <input type="number" min={15} max={600} value={pageInterval} onChange={(event) => setPageInterval(Number(event.currentTarget.value) || 45)} /> 秒
            </label>
            <label>
              上限
              <input type="number" min={1} max={240} value={maxMinutes} onChange={(event) => setMaxMinutes(Number(event.currentTarget.value) || 30)} /> 分钟
            </label>
            <label>
              采集间隔
              <input type="number" min={1} max={5} value={sampleInterval} onChange={(event) => setSampleInterval(Number(event.currentTarget.value) || 2)} /> 秒
            </label>
            <label>
              每天投递
              <input type="number" min={1} max={5} value={dailyDeliveries} onChange={(event) => setDailyDeliveries(Number(event.currentTarget.value) || 2)} /> 次
            </label>
            <button type="button" className="video-automation__secondary" onClick={() => void saveConfig()}>
              保存参数
            </button>
          </div>

          <div className="video-automation__row video-automation__browser">
            <span className="video-automation__muted">专用浏览器：{browserStatusText(video.browserStatus)}</span>
            <button type="button" className="video-automation__link" onClick={() => void video.loadBrowserStatus()}>
              刷新
            </button>
            <button type="button" className="video-automation__secondary" onClick={() => void closeBrowser()}>
              关闭专用浏览器
            </button>
          </div>

          <details className="video-automation__account">
            <summary>账号档案（可选）</summary>
            <div className="video-automation__row">
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
            </div>
            <div className="video-automation__account-form">
              <input value={accountName} maxLength={32} placeholder="账号名称" onChange={(event) => setAccountName(event.currentTarget.value)} />
              <input value={accountHandle} maxLength={64} placeholder="平台昵称或账号（可选）" onChange={(event) => setAccountHandle(event.currentTarget.value)} />
              <input value={accountPersona} maxLength={500} placeholder="小狗人设" onChange={(event) => setAccountPersona(event.currentTarget.value)} />
              <input value={accountGoals} maxLength={500} placeholder="运营目标" onChange={(event) => setAccountGoals(event.currentTarget.value)} />
              <button type="button" className="video-automation__secondary" onClick={() => void createAccount()}>
                创建小狗账号档案
              </button>
            </div>
            <p className="video-automation__muted">
              创建档案不会替你绕过手机号、邮箱或验证码；请在专用浏览器里完成登录后点「我已登录」。
            </p>
          </details>

          <VideoChannelCard
            channel={video.channel}
            diagnostics={video.diagnostics}
            onProbe={() => void video.probeChannels()}
          />

          <div className="video-automation__danger-zone">
            {confirmClear ? (
              <>
                <span className="video-automation__muted">确认清空观看历史、画像与待投递小结？登录 profile 会保留。</span>
                <button type="button" className="video-automation__danger" onClick={() => void clearData()}>
                  确认清空
                </button>
                <button type="button" className="video-automation__secondary" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button type="button" className="video-automation__danger" onClick={() => setConfirmClear(true)}>
                清空观看数据（保留登录）
              </button>
            )}
          </div>
        </div>
      </details>

      {/* 评论（可选） */}
      <details className="video-automation__comment">
        <summary>评论（可选，只有你点发送才会发出去）</summary>
        <textarea
          rows={3}
          maxLength={200}
          value={commentDraft}
          placeholder="写一条评论（1–200 字），发到当前打开的视频下面"
          onChange={(event) => setCommentDraft(event.currentTarget.value)}
        />
        <div className="video-automation__row">
          <button
            type="button"
            className="video-automation__secondary"
            disabled={commentBusy || !commentDraft.trim()}
            onClick={() => void postComment()}
          >
            {commentBusy ? "发送中…" : "发送评论"}
          </button>
          <span className="video-automation__muted">{commentDraft.length > 0 ? `${commentDraft.length}/200` : ""}</span>
        </div>
        {commentStatus && <p className="video-automation__muted" role="status">{commentStatus}</p>}
      </details>
    </section>
  );
}

/** 账号状态徽标文案（下拉与「登录：」共用；QA D3 已统一成中文）。 */
export { accountStatusLabel };