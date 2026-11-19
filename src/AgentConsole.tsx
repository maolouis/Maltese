// Agent 控制台：以「桌面 Agent 状态」为主，CLI 适配器降级为高级区。
//
// - 桌面 Agent：只读监控正在运行的 AI 助手应用（Rust `desktop_agents.rs`），只做「聚焦」，
//   不做键盘/鼠标注入。
// - 内部模块：聊天 / 主动 / 视频采集 / 日报投递 / 翻译，用现有可得数据汇总。
// - 高级：原本的 codex / claude CLI 串行流水线，默认收起。
//
// 页面只在岛内可见时挂载，轮询随卸载停止；所有 Tauri 命令都是 async + spawn_blocking。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "./i18n";
import "./AgentConsole.css";

type AgentInfo = {
  id: string;
  displayName: string;
  kind: string;
  enabled: boolean;
  available: boolean;
  command: string;
  resolvedCommand: string | null;
  unavailableReason: string | null;
  note: string | null;
  status: "idle" | "queued" | "running";
  queueLength: number;
  lastError: string | null;
  promptPreview: string | null;
};

type PipelineStepSpec = { agentId: string; promptTemplate: string };

type PipelineSpec = {
  id: string;
  title: string;
  description: string;
  steps: PipelineStepSpec[];
};

type RegistrySnapshot = {
  agents: AgentInfo[];
  pipelines: PipelineSpec[];
  configPath: string;
  logDir: string;
  probedAt: number;
};

type DesktopAgentStatus = {
  id: string;
  displayName: string;
  running: boolean;
  processCount: number;
  pids: number[];
  windowTitle: string | null;
  matchedProcess: string | null;
  isForeground: boolean;
  foregroundSeconds: number;
  lastActiveAgoSeconds: number | null;
};

type DesktopForeground = {
  pid: number;
  processName: string;
  title: string;
  agentId: string | null;
};

type DesktopAgentsSnapshot = {
  agents: DesktopAgentStatus[];
  foreground: DesktopForeground | null;
  enumeratedAt: number;
  enumerationMs: number;
  cached: boolean;
};

type DesktopFocusResult = {
  id: string;
  displayName: string;
  windowTitle: string | null;
  pid: number;
  foreground: boolean;
};

type RunningAgentInfo = {
  streamId: string;
  agentId: string;
  agentName: string;
  pid: number | null;
  startedAt: number;
  promptPreview: string;
};

type AgentHubStatus = {
  running: RunningAgentInfo[];
  queue: Record<string, number>;
  recentErrors: { at: number; agentId: string; message: string }[];
};

type AgentUsageSummary = {
  date: string;
  runs: number;
  failures: number;
  avgDurationMs: number;
  avgFirstLineMs: number | null;
  logPath: string;
};

type AgentRunResult = {
  streamId: string;
  agentId: string;
  ok: boolean;
  output: string;
  error: string | null;
  exitCode: number | null;
  durationMs: number;
  firstLineMs: number | null;
  timedOut: boolean;
  cancelled: boolean;
  logPath: string;
};

type PipelineStepResult = {
  index: number;
  agentId: string;
  agentName: string;
  streamId: string;
  ok: boolean;
  output: string;
  error: string | null;
  durationMs: number;
};

type PipelineResult = {
  ok: boolean;
  runId: string;
  steps: PipelineStepResult[];
  error: string | null;
};

type VideoSnapshotLite = {
  phase: string;
  running: boolean;
  maxMinutes: number;
  startedAt: number | null;
  itemCount: number;
  pendingCount: number;
};

type StreamEvent = { streamId: string; agentId: string; line: string };
type PipelineStepEvent = { runId: string; pipelineId: string; index: number; agentId: string; streamId: string };

const TODOS_KEY = "focusd-island-todos";
const ACTIVE_TODO_KEY = "focusd-island-active-todo";
const PROACTIVE_LEVEL_KEY = "maltese-proactive-level";
const MAX_LINES = 400;

type StoredTodo = {
  id: string;
  title: string;
  completed: boolean;
  activeSince?: number | null;
  elapsedMs?: number;
};

function readActiveTodo(): { title: string; elapsedMs: number } | null {
  try {
    const raw = window.localStorage.getItem(TODOS_KEY);
    const todos = raw ? (JSON.parse(raw) as StoredTodo[]) : [];
    const activeId = window.localStorage.getItem(ACTIVE_TODO_KEY);
    const active = activeId ? todos.find((todo) => todo.id === activeId) : todos.find((todo) => todo.activeSince);
    if (!active) return null;
    const elapsed = (active.elapsedMs ?? 0) + (active.activeSince ? Date.now() - active.activeSince : 0);
    return { title: active.title, elapsedMs: Math.max(0, elapsed) };
  } catch {
    return null;
  }
}

function readProactiveLevel(): number {
  try {
    const raw = window.localStorage.getItem(PROACTIVE_LEVEL_KEY);
    const level = raw ? Number(raw) : 50;
    return Number.isFinite(level) ? Math.min(100, Math.max(0, Math.round(level))) : 50;
  } catch {
    return 50;
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60}分`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

const tauri = isTauri();

export function AgentConsole() {
  const t = useTranslation();
  const [registry, setRegistry] = useState<RegistrySnapshot | null>(null);
  const [status, setStatus] = useState<AgentHubStatus | null>(null);
  const [usage, setUsage] = useState<AgentUsageSummary | null>(null);
  const [video, setVideo] = useState<VideoSnapshotLite | null>(null);
  const [desktop, setDesktop] = useState<DesktopAgentsSnapshot | null>(null);
  const [activeTodo, setActiveTodo] = useState<{ title: string; elapsedMs: number } | null>(null);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(0);
  const [lines, setLines] = useState<Record<string, string[]>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [focusNotices, setFocusNotices] = useState<Record<string, string>>({});
  const [composerAgent, setComposerAgent] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [busyAgents, setBusyAgents] = useState<Record<string, boolean>>({});
  const [lastRuns, setLastRuns] = useState<Record<string, AgentRunResult>>({});
  const [pipelineId, setPipelineId] = useState("");
  const [pipelineInput, setPipelineInput] = useState("");
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [pipelineError, setPipelineError] = useState("");
  const [pipelineRunId, setPipelineRunId] = useState("");
  const [activeStep, setActiveStep] = useState(0);
  const runIdRef = useRef("");
  const refreshAtRef = useRef(0);

  const appendLine = useCallback((streamId: string, line: string) => {
    setLines((current) => {
      const previous = current[streamId] ?? [];
      if (previous.length >= MAX_LINES) return current;
      return { ...current, [streamId]: [...previous, line] };
    });
  }, []);

  const load = useCallback(async (withRegistry: boolean) => {
    if (!tauri) return;
    try {
      if (withRegistry) {
        const next = await invoke<RegistrySnapshot>("get_agent_registry", { refresh: false });
        setRegistry(next);
      }
      const [desktopResult, statusResult, usageResult, videoResult] = await Promise.allSettled([
        invoke<DesktopAgentsSnapshot>("desktop_agents_status", { refresh: false }),
        invoke<AgentHubStatus>("agent_hub_status"),
        invoke<AgentUsageSummary>("agent_hub_usage"),
        invoke<VideoSnapshotLite>("video_get_snapshot"),
      ]);
      if (desktopResult.status === "fulfilled") setDesktop(desktopResult.value);
      if (statusResult.status === "fulfilled") setStatus(statusResult.value);
      if (usageResult.status === "fulfilled") setUsage(usageResult.value);
      if (videoResult.status === "fulfilled") setVideo(videoResult.value);
      setActiveTodo(readActiveTodo());
      setLastUpdated(Date.now());
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    if (!tauri) return;
    let disposed = false;
    void load(true);
    const timer = window.setInterval(() => {
      if (disposed) return;
      void load(false);
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!tauri) return;
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;
    const attach = async () => {
      const streamUnlisten = await listen<StreamEvent>("agent-stream", (event) => {
        appendLine(event.payload.streamId, event.payload.line);
      });
      if (disposed) {
        streamUnlisten();
        return;
      }
      unlisteners.push(streamUnlisten);
      unlisteners.push(
        await listen<StreamEvent>("agent-stderr", (event) => {
          appendLine(event.payload.streamId, `[stderr] ${event.payload.line}`);
        }),
      );
      unlisteners.push(
        await listen<PipelineStepEvent>("agent-pipeline-step", (event) => {
          if (event.payload.runId !== runIdRef.current) return;
          setActiveStep(event.payload.index);
        }),
      );
    };
    void attach();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [appendLine]);

  const selectedPipeline = useMemo(() => {
    if (!registry || registry.pipelines.length === 0) return null;
    return registry.pipelines.find((pipeline) => pipeline.id === pipelineId) ?? registry.pipelines[0];
  }, [pipelineId, registry]);

  useEffect(() => {
    if (registry && registry.pipelines.length > 0 && !pipelineId) {
      setPipelineId(registry.pipelines[0].id);
    }
  }, [pipelineId, registry]);

  const runningByAgent = useMemo(() => {
    const map: Record<string, RunningAgentInfo> = {};
    for (const entry of status?.running ?? []) map[entry.agentId] = entry;
    return map;
  }, [status]);

  const queueFor = useCallback(
    (agent: AgentInfo) => status?.queue?.[agent.id] ?? agent.queueLength ?? 0,
    [status],
  );

  const refreshDesktop = useCallback(async () => {
    try {
      const snapshot = await invoke<DesktopAgentsSnapshot>("desktop_agents_status", { refresh: true });
      setDesktop(snapshot);
      setLastUpdated(Date.now());
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const manualRefresh = useCallback(() => {
    const now = Date.now();
    if (now - refreshAtRef.current < 3000) return;
    refreshAtRef.current = now;
    void Promise.allSettled([load(true), refreshDesktop()]);
  }, [load, refreshDesktop]);

  const focusDesktopAgent = useCallback(
    async (agent: DesktopAgentStatus) => {
      if (!agent.running) {
        setFocusNotices((current) => ({ ...current, [agent.id]: t.agentHub.desktopNotRunning }));
        return;
      }
      try {
        await invoke<DesktopFocusResult>("desktop_agent_focus", { id: agent.id });
        setFocusNotices((current) => ({ ...current, [agent.id]: t.agentHub.desktopFocused(agent.displayName) }));
        void refreshDesktop();
      } catch (cause) {
        setFocusNotices((current) => ({ ...current, [agent.id]: String(cause) }));
      }
    },
    [refreshDesktop, t.agentHub],
  );

  const runAgent = useCallback(
    async (agent: AgentInfo) => {
      const prompt = (prompts[agent.id] ?? "").trim();
      if (!agent.available) {
        setNotices((current) => ({
          ...current,
          [agent.id]: agent.unavailableReason ?? t.agentHub.desktopNotRunning,
        }));
        return;
      }
      if (!prompt) {
        setNotices((current) => ({ ...current, [agent.id]: "先说点要它做的事。" }));
        return;
      }
      const streamId = `ui-${agent.id}-${Date.now()}`;
      setBusyAgents((current) => ({ ...current, [agent.id]: true }));
      setNotices((current) => ({ ...current, [agent.id]: "" }));
      setLines((current) => ({ ...current, [streamId]: [] }));
      try {
        const result = await invoke<AgentRunResult>("agent_run", {
          agentId: agent.id,
          prompt,
          streamId,
        });
        setLastRuns((current) => ({ ...current, [agent.id]: result }));
        if (!result.ok && result.error) {
          setNotices((current) => ({ ...current, [agent.id]: result.error ?? "" }));
        }
      } catch (cause) {
        setNotices((current) => ({ ...current, [agent.id]: String(cause) }));
      } finally {
        setBusyAgents((current) => ({ ...current, [agent.id]: false }));
        void load(true);
      }
    },
    [load, prompts, t.agentHub.desktopNotRunning],
  );

  const cancelAgent = useCallback(
    async (agent: AgentInfo) => {
      const running = runningByAgent[agent.id];
      if (!running) {
        setNotices((current) => ({ ...current, [agent.id]: "这个 agent 现在没有在跑。" }));
        return;
      }
      try {
        await invoke<boolean>("agent_cancel", { streamId: running.streamId });
        setNotices((current) => ({ ...current, [agent.id]: "已发送取消，进程树会被结束。" }));
      } catch (cause) {
        setNotices((current) => ({ ...current, [agent.id]: String(cause) }));
      } finally {
        void load(true);
      }
    },
    [load, runningByAgent],
  );

  const runPipeline = useCallback(async () => {
    if (!selectedPipeline) return;
    const input = pipelineInput.trim();
    if (!input) {
      setPipelineError("请先填一下这次流水线的输入。");
      return;
    }
    const runId = `ui-pipe-${Date.now()}`;
    runIdRef.current = runId;
    setPipelineRunId(runId);
    setPipelineBusy(true);
    setPipelineResult(null);
    setPipelineError("");
    setActiveStep(0);
    setLines((current) => {
      const next = { ...current };
      for (let index = 0; index < selectedPipeline.steps.length; index += 1) {
        next[`${runId}-s${index + 1}`] = [];
      }
      return next;
    });
    try {
      const result = await invoke<PipelineResult>("agent_pipeline_run", {
        pipelineId: selectedPipeline.id,
        input,
        runId,
      });
      setPipelineResult(result);
      if (!result.ok && result.error) setPipelineError(result.error);
    } catch (cause) {
      setPipelineError(String(cause));
    } finally {
      setPipelineBusy(false);
      void load(true);
    }
  }, [load, pipelineInput, selectedPipeline]);

  if (!tauri) {
    return (
      <section className="agent-console agent-console--empty" aria-label={t.agentHub.title}>
        <p>{t.agentHub.desktopOnly}</p>
      </section>
    );
  }

  const agents = registry?.agents ?? [];
  const running = runningByAgent;
  const firstLine = usage?.avgFirstLineMs ?? null;
  const videoPercent = (() => {
    if (!video || !video.running || !video.startedAt || video.maxMinutes <= 0) return null;
    const elapsedMinutes = (Date.now() - video.startedAt) / 60_000;
    return Math.min(100, Math.max(0, Math.round((elapsedMinutes / video.maxMinutes) * 100)));
  })();

  const desktopAgents = desktop?.agents ?? [];
  const proactiveLevel = readProactiveLevel();
  const internalRows = [
    { id: "chat", label: t.agentHub.internalChat, status: t.agentHub.internalReady, detail: t.agentHub.internalIdle },
    { id: "proactive", label: t.agentHub.internalProactive(proactiveLevel), status: t.agentHub.internalReady, detail: "" },
    {
      id: "video",
      label: t.agentHub.internalVideo,
      status: video?.running ? t.agentHub.videoItems(video.itemCount) : t.agentHub.internalIdle,
      detail: video?.running ? t.agentHub.videoPending(video.pendingCount) : "",
    },
    {
      id: "digest",
      label: "日报投递",
      status: video ? t.agentHub.internalDigest(video.pendingCount) : t.agentHub.internalIdle,
      detail: "",
    },
    { id: "translate", label: t.agentHub.internalTranslate, status: t.agentHub.internalReady, detail: "" },
  ];

  const pipelineSteps: PipelineStepResult[] =
    pipelineResult?.steps && pipelineResult.steps.length > 0
      ? pipelineResult.steps
      : (selectedPipeline?.steps ?? []).map((step, index) => ({
          index,
          agentId: step.agentId,
          agentName: registry?.agents.find((agent) => agent.id === step.agentId)?.displayName ?? step.agentId,
          streamId: pipelineRunId ? `${pipelineRunId}-s${index + 1}` : "",
          ok: true,
          output: "",
          error: null,
          durationMs: 0,
        }));

  return (
    <section className="agent-console" aria-label={t.agentHub.title}>
      <header className="agent-console__header">
        <div>
          <strong>{t.agentHub.title}</strong>
          <p className="agent-console__hint">{t.agentHub.hint}</p>
        </div>
        <button type="button" className="agent-console__refresh" onClick={manualRefresh}>
          {t.agentHub.refresh}
        </button>
      </header>

      {error && (
        <p className="agent-console__error" role="alert">
          {t.agentHub.loadFailed(error)}
        </p>
      )}

      <div className="agent-console__cards">
        {/* ① 模型用量 */}
        <article className="agent-console-card" aria-label={t.agentHub.usageTitle}>
          <div className="agent-console-card__head">
            <strong>{t.agentHub.usageTitle}</strong>
            <span className="agent-console-card__tag">{t.agentHub.pendingIntegration}</span>
          </div>
          <p className="agent-console-card__hint">{t.agentHub.usageHint}</p>
          <dl className="agent-console-stats">
            <div>
              <dt>{t.agentHub.usageRuns}</dt>
              <dd>{usage ? formatCount(usage.runs) : "—"}</dd>
            </div>
            <div>
              <dt>{t.agentHub.usageFailures}</dt>
              <dd>{usage ? formatCount(usage.failures) : "—"}</dd>
            </div>
            <div>
              <dt>{t.agentHub.usageAvgFirstLine}</dt>
              <dd>{formatDuration(firstLine)}</dd>
            </div>
            <div>
              <dt>{t.agentHub.usageAvgDuration}</dt>
              <dd>{formatDuration(usage?.avgDurationMs)}</dd>
            </div>
            <div>
              <dt>{t.agentHub.usageTokens}</dt>
              <dd>—</dd>
            </div>
          </dl>
          {usage && usage.runs === 0 && <p className="agent-console-card__empty">{t.agentHub.noUsage}</p>}
        </article>

        {/* ② 任务进度 */}
        <article className="agent-console-card" aria-label={t.agentHub.tasksTitle}>
          <div className="agent-console-card__head">
            <strong>{t.agentHub.tasksTitle}</strong>
          </div>
          <div className="agent-console-task">
            <span className="agent-console-task__label">视频采集</span>
            {video?.running && videoPercent !== null ? (
              <>
                <div className="agent-console-progress" role="progressbar" aria-valuenow={videoPercent} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${videoPercent}%` }} />
                </div>
                <span className="agent-console-task__meta">
                  {t.agentHub.videoProgress(videoPercent)} · {t.agentHub.videoItems(video.itemCount)} ·{" "}
                  {t.agentHub.videoPending(video.pendingCount)}
                </span>
              </>
            ) : (
              <span className="agent-console-task__meta">{t.agentHub.videoIdle}</span>
            )}
          </div>
          <div className="agent-console-task">
            <span className="agent-console-task__label">待办</span>
            {activeTodo ? (
              <span className="agent-console-task__meta">
                {t.agentHub.todoRunning(activeTodo.title)} · {formatDuration(activeTodo.elapsedMs)}
              </span>
            ) : (
              <span className="agent-console-task__meta">{t.agentHub.todoNone}</span>
            )}
          </div>
          {!video?.running && !activeTodo && <p className="agent-console-card__empty">{t.agentHub.noTasks}</p>}
        </article>

        {/* ③ 工作分配：桌面 Agent + 内部模块 */}
        <article className="agent-console-card agent-console-card--wide" aria-label={t.agentHub.agentsTitle}>
          <div className="agent-console-card__head">
            <strong>{t.agentHub.agentsTitle}</strong>
            {desktop && (
              <span className="agent-console-card__tag">
                {desktop.enumerationMs}ms{desktop.cached ? " · 缓存" : ""}
              </span>
            )}
          </div>

          <div className="agent-console-group">
            <div className="agent-console-group__head">
              <strong>{t.agentHub.desktopTitle}</strong>
              <span className="agent-console-group__hint">{t.agentHub.desktopHint}</span>
            </div>
            {desktopAgents.length === 0 && <p className="agent-console-card__empty">{t.agentHub.desktopEmpty}</p>}
            <div className="agent-console-agents">
              {desktopAgents.map((agent) => (
                <div
                  key={agent.id}
                  className={`agent-console-agent agent-console-agent--${agent.running ? (agent.isForeground ? "running" : "idle") : "offline"}`}
                >
                  <div className="agent-console-agent__head">
                    <strong>{agent.displayName}</strong>
                    <span className={`agent-console-badge agent-console-badge--${agent.running ? (agent.isForeground ? "running" : "queued") : "off"}`}>
                      {agent.running ? (agent.isForeground ? t.agentHub.statusRunning : t.agentHub.statusIdle) : t.agentHub.desktopNotRunning}
                    </span>
                    {agent.running && <span className="agent-console-agent__kind">{t.agentHub.desktopPids(agent.processCount)}</span>}
                  </div>
                  {agent.running && agent.windowTitle && (
                    <p className="agent-console-agent__note">{t.agentHub.desktopWindow(agent.windowTitle)}</p>
                  )}
                  {agent.running && (
                    <div className="agent-console-agent__meta">
                      {agent.isForeground && <span>{t.agentHub.desktopForeground(agent.foregroundSeconds)}</span>}
                      <span>{t.agentHub.desktopLastActive(agent.lastActiveAgoSeconds)}</span>
                    </div>
                  )}
                  <div className="agent-console-agent__actions">
                    <button type="button" className="agent-console-agent__run" onClick={() => void focusDesktopAgent(agent)}>
                      {t.agentHub.desktopFocus}
                    </button>
                  </div>
                  {focusNotices[agent.id] && <p className="agent-console-agent__notice">{focusNotices[agent.id]}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="agent-console-group">
            <div className="agent-console-group__head">
              <strong>{t.agentHub.internalTitle}</strong>
            </div>
            <ul className="agent-console-internal">
              {internalRows.map((row) => (
                <li key={row.id}>
                  <strong>{row.label}</strong>
                  <span>{row.status}</span>
                  {row.detail && <em>{row.detail}</em>}
                </li>
              ))}
            </ul>
          </div>
        </article>
      </div>

      {/* 高级：CLI 适配器（默认收起） */}
      <details className="agent-console-advanced">
        <summary>
          <strong>{t.agentHub.advancedTitle}</strong>
          <span>{t.agentHub.advancedHint}</span>
        </summary>

        {registry === null && <p className="agent-console-card__empty">{t.agentHub.loading}</p>}
        {registry !== null && agents.length === 0 && <p className="agent-console-card__empty">{t.agentHub.noAgents}</p>}
        {agents.length > 0 && (
          <div className="agent-console-agents">
            {agents.map((agent) => {
              const live = running[agent.id];
              const queueLength = queueFor(agent);
              const busy = busyAgents[agent.id];
              const run = lastRuns[agent.id];
              const agentLines = run?.streamId ? lines[run.streamId] ?? [] : [];
              return (
                <div
                  key={agent.id}
                  className={`agent-console-agent agent-console-agent--${agent.available ? (live ? "running" : "idle") : "offline"}`}
                >
                  <div className="agent-console-agent__head">
                    <strong>{agent.displayName}</strong>
                    <span className={`agent-console-badge agent-console-badge--${agent.enabled ? (live ? "running" : queueLength > 0 ? "queued" : "idle") : "off"}`}>
                      {!agent.enabled
                        ? t.agentHub.disabled
                        : !agent.available
                          ? t.agentHub.notInstalled
                          : live
                            ? t.agentHub.statusRunning
                            : queueLength > 0
                              ? t.agentHub.statusQueued
                              : t.agentHub.statusIdle}
                    </span>
                    <span className="agent-console-agent__kind">{agent.kind}</span>
                  </div>
                  {!agent.available && agent.enabled && agent.unavailableReason && (
                    <p className="agent-console-agent__reason">{agent.unavailableReason}</p>
                  )}
                  {agent.note && <p className="agent-console-agent__note">{agent.note}</p>}
                  {live?.promptPreview && (
                    <p className="agent-console-agent__running">{t.agentHub.runningWhat(live.promptPreview)}</p>
                  )}
                  <div className="agent-console-agent__meta">
                    {queueLength > 0 && <span>{t.agentHub.queueLabel(queueLength)}</span>}
                    {agent.lastError && (
                      <span className="agent-console-agent__last-error">
                        {t.agentHub.lastError}：{agent.lastError}
                      </span>
                    )}
                    {notices[agent.id] && <span className="agent-console-agent__notice">{notices[agent.id]}</span>}
                  </div>
                  <div className="agent-console-agent__actions">
                    <button
                      type="button"
                      className="agent-console-agent__run"
                      disabled={busy || Boolean(live)}
                      onClick={() => {
                        setComposerAgent(composerAgent === agent.id ? null : agent.id);
                        setNotices((current) => ({ ...current, [agent.id]: "" }));
                      }}
                    >
                      {busy ? "启动中…" : t.agentHub.run}
                    </button>
                    <button
                      type="button"
                      className="agent-console-agent__cancel"
                      disabled={!live}
                      onClick={() => void cancelAgent(agent)}
                    >
                      {t.agentHub.cancel}
                    </button>
                  </div>
                  {composerAgent === agent.id && (
                    <div className="agent-console-agent__composer">
                      <textarea
                        value={prompts[agent.id] ?? ""}
                        placeholder={t.agentHub.promptPlaceholder}
                        rows={2}
                        onChange={(event) =>
                          setPrompts((current) => ({ ...current, [agent.id]: event.target.value }))
                        }
                      />
                      <button type="button" onClick={() => void runAgent(agent)} disabled={busy || Boolean(live)}>
                        {busy ? "运行中…" : t.agentHub.send}
                      </button>
                    </div>
                  )}
                  {agentLines.length > 0 && (
                    <pre className="agent-console-agent__log" aria-label={`${agent.displayName} output`}>
                      {agentLines.slice(-120).join("\n")}
                    </pre>
                  )}
                  {run && !run.ok && run.error && (
                    <p className="agent-console-agent__error">{run.error}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 多 Agent 运行 */}
        <article className="agent-console-runner" aria-label={t.agentHub.pipelineTitle}>
          <div className="agent-console-runner__head">
            <strong>{t.agentHub.pipelineTitle}</strong>
            <p className="agent-console-runner__hint">{t.agentHub.pipelineHint}</p>
          </div>
          <div className="agent-console-runner__controls">
            <label>
              <span>{t.agentHub.pipelineSelect}</span>
              <select
                value={selectedPipeline?.id ?? ""}
                onChange={(event) => {
                  setPipelineId(event.target.value);
                  setPipelineResult(null);
                  setPipelineError("");
                }}
                disabled={pipelineBusy}
              >
                {(registry?.pipelines ?? []).map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="agent-console-runner__input">
              <span>{t.agentHub.pipelineInputLabel}</span>
              <textarea
                value={pipelineInput}
                rows={2}
                placeholder={t.agentHub.pipelineInputPlaceholder}
                onChange={(event) => setPipelineInput(event.target.value)}
                disabled={pipelineBusy}
              />
            </label>
            <button
              type="button"
              className="agent-console-runner__go"
              onClick={() => void runPipeline()}
              disabled={pipelineBusy || !selectedPipeline}
            >
              {pipelineBusy ? t.agentHub.pipelineRunning : t.agentHub.pipelineRun}
            </button>
          </div>
          {selectedPipeline && <p className="agent-console-runner__desc">{selectedPipeline.description}</p>}
          {pipelineError && (
            <p className="agent-console-runner__error" role="alert">
              {pipelineResult ? `${t.agentHub.pipelineFailed}：` : ""}
              {pipelineError}
            </p>
          )}
          {pipelineResult?.ok && <p className="agent-console-runner__done">{t.agentHub.pipelineDone}</p>}
          {(pipelineResult?.steps?.length ?? 0) > 0 || selectedPipeline ? (
            <div className="agent-console-steps">
              {pipelineSteps.map((step) => {
                const streamLines = step.streamId ? lines[step.streamId] ?? [] : [];
                const open = !pipelineBusy || step.index === activeStep;
                return (
                  <details key={`${step.streamId || step.index}-${step.agentId}`} open={open}>
                    <summary>
                      {t.agentHub.pipelineStepTitle(step.index + 1, step.agentName)}
                      {step.ok && step.output ? ` · ${formatDuration(step.durationMs)}` : ""}
                      {!step.ok && step.error ? ` · ${step.error}` : ""}
                    </summary>
                    {(step.output || streamLines.length > 0) && <pre>{step.output || streamLines.join("\n")}</pre>}
                  </details>
                );
              })}
            </div>
          ) : null}
        </article>
      </details>

      <footer className="agent-console__footer">
        <span>
          {t.agentHub.dataSource(lastUpdated ? formatClock(lastUpdated) : "—")}
          {registry ? ` · ${t.agentHub.logHint(registry.logDir)}` : ""}
        </span>
      </footer>
    </section>
  );
}

export default AgentConsole;