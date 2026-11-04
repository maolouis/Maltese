import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { loadWakeShortcut, saveWakeShortcut } from "./wakeShortcut";
import "./SettingsWindow.css";

const STORAGE_KEY = "focusd-island-settings";

type FpsMode = "smooth" | "balanced" | "normal" | "saver";
type Corner = "" | "tl" | "tr" | "bl" | "br";
type FullscreenAvoid = "tuck" | "hide" | "off";

type PetSettings = {
  petOpacity: number;
  collapsedScale: number;
  expandedScale: number;
  fpsMode: FpsMode;
  clickSquash: boolean;
  petFlipY: boolean;
  bubbleOn: boolean;
  bubbleDurationMs: number;
  bubbleTextColor: string;
  soundOn: boolean;
  hourlyChime: boolean;
  mouseInteractions: boolean;
  lockCorner: Corner;
  fullscreenAvoid: FullscreenAvoid;
  autoTuck: boolean;
  autoTuckSeconds: number;
  observeApps: boolean;
  senseTime: boolean;
  nightCompanion: boolean;
  musicChat: boolean;
  clipboardBubble: boolean;
  roam: boolean;
  lyricsBubble: boolean;
  sleepAfterSeconds: number;
  tuckedVisibleHeight: number;
};

const DEFAULTS: PetSettings = {
  petOpacity: 100,
  collapsedScale: 0.89,
  expandedScale: 0.91,
  fpsMode: "balanced",
  clickSquash: true,
  petFlipY: false,
  bubbleOn: true,
  bubbleDurationMs: 6000,
  bubbleTextColor: "#2b2f3a",
  soundOn: true,
  hourlyChime: false,
  mouseInteractions: true,
  lockCorner: "",
  fullscreenAvoid: "tuck",
  autoTuck: false,
  autoTuckSeconds: 30,
  observeApps: true,
  senseTime: true,
  nightCompanion: true,
  musicChat: true,
  clipboardBubble: true,
  roam: false,
  lyricsBubble: true,
  sleepAfterSeconds: 150,
  tuckedVisibleHeight: 80,
};

function load(): PetSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULTS;
    }
    const parsed = JSON.parse(raw) as Partial<PetSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="sw-row">
      <span className="sw-copy">
        <span className="sw-label">{label}</span>
        {hint && <span className="sw-hint">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`sw-switch${checked ? " sw-switch--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="sw-knob" />
      </button>
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="sw-row sw-row--slider">
      <span className="sw-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className="sw-value">
        {step < 1 ? value.toFixed(2) : Math.round(value)}
        {suffix}
      </span>
    </label>
  );
}

function Segments<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="sw-row sw-row--segments">
      <span className="sw-label">{label}</span>
      <div className="sw-segments" role="group" aria-label={label}>
        {items.map(([key, text]) => (
          <button
            key={key || "none"}
            type="button"
            aria-pressed={value === key}
            className={value === key ? "sw-segment sw-segment--on" : "sw-segment"}
            onClick={() => onChange(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsWindow() {
  const [settings, setSettings] = useState<PetSettings>(load);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [shortcut, setShortcut] = useState(loadWakeShortcut);
  const [shortcutError, setShortcutError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch(() => undefined);
  }, []);

  // 改动即时写回 localStorage，并通知主窗口重新加载设置。
  const update = useCallback(<K extends keyof PetSettings>(key: K, value: PetSettings[K]) => {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
      saveTimer.current = window.setTimeout(() => {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          const base = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, ...next }));
          void emit("maltese-settings-updated", next);
          setSavedAt(Date.now());
        } catch {
          // 忽略写入失败
        }
      }, 120);
      return next;
    });
  }, []);

  const recordShortcut = async (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
      return;
    }
    const modifiers = [
      event.ctrlKey && "Ctrl",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
      event.metaKey && "Win",
    ].filter(Boolean) as string[];
    if (!modifiers.length) {
      setShortcutError("至少按住 Ctrl / Alt / Shift / Win 之一");
      return;
    }
    const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    try {
      const registered = await invoke<string>("set_wake_shortcut", {
        shortcut: [...modifiers, key].join("+"),
      });
      setShortcut(registered);
      saveWakeShortcut(registered);
      setShortcutError("");
    } catch (error) {
      setShortcutError(String(error));
    }
  };

  const toggleStartup = async (enabled: boolean) => {
    try {
      await invoke("set_launch_at_startup", { enabled });
      setLaunchAtStartup(enabled);
    } catch {
      setLaunchAtStartup(false);
    }
  };

  return (
    <div className="settings-window">
      <header className="settings-window__head">
        <div>
          <h1>桌宠设置</h1>
          <p>调整小狗的显示、互动和陪伴方式，改完自动保存。</p>
        </div>
        <span className="settings-window__saved">{savedAt ? "已保存" : ""}</span>
      </header>

      <section className="sw-card">
        <h2>显示</h2>
        <Slider label="小狗不透明度" value={settings.petOpacity} min={30} max={100} step={1} suffix="%" onChange={(value) => update("petOpacity", value)} />
        <Slider label="收起大小" value={settings.collapsedScale} min={0.75} max={1.4} step={0.01} suffix="×" onChange={(value) => update("collapsedScale", value)} />
        <Segments
          label="动画流畅度"
          value={settings.fpsMode}
          items={[["smooth", "流畅"], ["balanced", "均衡"], ["normal", "普通"], ["saver", "省电"]]}
          onChange={(value) => update("fpsMode", value)}
        />
        <Switch label="点击时 Q 弹" checked={settings.clickSquash} onChange={(value) => update("clickSquash", value)} />
      </section>

      <section className="sw-card">
        <h2>气泡与声音</h2>
        <Switch label="显示云朵气泡" checked={settings.bubbleOn} onChange={(value) => update("bubbleOn", value)} />
        <Slider label="气泡停留" value={settings.bubbleDurationMs} min={1500} max={30000} step={500} suffix="ms" onChange={(value) => update("bubbleDurationMs", value)} />
        <div className="sw-row">
          <span className="sw-label">气泡文字颜色</span>
          <input
            type="color"
            className="sw-color"
            value={settings.bubbleTextColor}
            onChange={(event) => update("bubbleTextColor", event.currentTarget.value)}
          />
        </div>
        <Switch label="歌词实时显示在气泡上" hint="需要播放器向系统提供播放进度" checked={settings.lyricsBubble} onChange={(value) => update("lyricsBubble", value)} />
        <Switch label="开启音效" checked={settings.soundOn} onChange={(value) => update("soundOn", value)} />
        <Switch label="整点轻轻叫一声" checked={settings.hourlyChime} onChange={(value) => update("hourlyChime", value)} />
      </section>

      <section className="sw-card">
        <h2>互动</h2>
        <Switch label="鼠标交互" hint="点击摸头、双击庆祝、右键打开聊天" checked={settings.mouseInteractions} onChange={(value) => update("mouseInteractions", value)} />
        <Switch label="剪贴板气泡" hint="复制内容时用云朵气泡显示" checked={settings.clipboardBubble} onChange={(value) => update("clipboardBubble", value)} />
        <div className="sw-row">
          <span className="sw-label">显示 / 隐藏桌宠</span>
          <input
            className="sw-input"
            readOnly
            value={shortcut}
            onKeyDown={(event) => void recordShortcut(event)}
            title="点击后按下新的组合键"
          />
        </div>
        {shortcutError && <p className="sw-error">{shortcutError}</p>}
        <Switch label="开机自启动" checked={launchAtStartup} onChange={(value) => void toggleStartup(value)} />
        <Segments
          label="复位位置"
          value={settings.lockCorner}
          items={[["", "底部居中"], ["tl", "左上"], ["tr", "右上"], ["bl", "左下"], ["br", "右下"]]}
          onChange={(value) => update("lockCorner", value)}
        />
        <Segments
          label="全屏时"
          value={settings.fullscreenAvoid}
          items={[["tuck", "缩边"], ["hide", "隐藏"], ["off", "不处理"]]}
          onChange={(value) => update("fullscreenAvoid", value)}
        />
      </section>

      <section className="sw-card">
        <h2>陪伴与感知</h2>
        <Switch label="偷偷观察你" hint="按前台程序说一句关心的话（纯本地）" checked={settings.observeApps} onChange={(value) => update("observeApps", value)} />
        <Switch label="时间感知" hint="早上 / 中午 / 晚上的问候" checked={settings.senseTime} onChange={(value) => update("senseTime", value)} />
        <Switch label="夜间陪伴" hint="23 点后提醒早点休息" checked={settings.nightCompanion} onChange={(value) => update("nightCompanion", value)} />
        <Switch label="听歌互动" hint="切歌时说一句正在听的歌" checked={settings.musicChat} onChange={(value) => update("musicChat", value)} />
        <Slider label="多久没动静就趴下睡" value={settings.sleepAfterSeconds} min={30} max={900} step={15} suffix="s" onChange={(value) => update("sleepAfterSeconds", value)} />
        <Slider label="缩边睡觉时露出高度" value={settings.tuckedVisibleHeight} min={24} max={140} step={1} suffix="px" onChange={(value) => update("tuckedVisibleHeight", value)} />
      </section>

      <section className="sw-card">
        <h2>消息提醒</h2>
        <div className="sw-row">
          <span className="sw-copy">
            <span className="sw-label">QQ 消息读取</span>
            <span className="sw-hint">需要 Windows“通知访问”权限，并且 QQ 本身要开启系统通知；缺一就收不到内容</span>
          </span>
          <button
            type="button"
            className="sw-secondary"
            onClick={() => {
              void invoke("open_qq_notification_settings", { access: true }).catch(() => undefined);
            }}
          >
            打开权限设置
          </button>
        </div>
        <div className="sw-row">
          <span className="sw-copy">
            <span className="sw-label">微信提醒</span>
            <span className="sw-hint">通过任务栏闪烁判断新消息；窗口未最小化时本地识别会话首条预览，最小化时只显示通用提醒</span>
          </span>
          <button
            type="button"
            className="sw-secondary"
            onClick={() => {
              void invoke("set_wechat_reminders_enabled", { enabled: true }).catch(() => undefined);
            }}
          >
            开启
          </button>
        </div>
      </section>

      <section className="sw-card">
        <h2>其他</h2>
        <Switch label="随机闲逛" hint="空闲时小狗在桌面慢慢挪一小步" checked={settings.roam} onChange={(value) => update("roam", value)} />
      </section>

      <footer className="settings-window__foot">
        <span>感知与消息预览都在本地完成，不落盘、不上传。</span>
        <button
          type="button"
          className="sw-secondary"
          onClick={() => {
            setSettings(DEFAULTS);
            try {
              const raw = window.localStorage.getItem(STORAGE_KEY);
              const base = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
              window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...base, ...DEFAULTS }));
              void emit("maltese-settings-updated", DEFAULTS);
              setSavedAt(Date.now());
            } catch {
              // 忽略
            }
          }}
        >
          恢复默认
        </button>
      </footer>
    </div>
  );
}