import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useTranslation } from "./i18n";
import { loadWakeShortcut, saveWakeShortcut } from "./wakeShortcut";
import { loadCollapseShortcut, saveCollapseShortcut } from "./collapseShortcut";
import { describeProactivePlan, proactivePlan, saveProactiveLevel } from "./proactiveChat";
import { isLocaleCode, LOCALE_CODES, LOCALE_STORAGE_KEY, loadLocale, saveLocale } from "./i18n";
import { PetGifRotationSettings } from "./PetGifRotationSettings";
import { LocalChatSettings } from "./LocalChatSettings";
import {
  loadShortcutAutoDetect,
  loadShortcutScanDir,
  saveShortcutAutoDetect,
  saveShortcutScanDir,
} from "./shortcutScanDir";
import { UpdatePanel } from "./UpdatePanel";
import { PET_CHARACTERS, savePetCharacter, usePetCharacter, type PetCharacterId } from "./petCharacters";
import { TuckGifControl } from "./TuckGifControl";
import { CustomSoundControl } from "./CustomSoundControl";
import { dropLegacyWechatReadContent } from "./messagePrivacy";
import { previewPetLinkage } from "./petLinkPreview";
import { readPetVitals, type PetVitalsSnapshot } from "./petVitals";
import { CHAT_BUSY_KEY } from "./chatGuard";
import PetVitalsCard from "./PetVitalsCard";
import ScreenPlacementCard from "./ScreenPlacementCard";
import { GeometrySelfCheck } from "./GeometrySelfCheck";
import "./SettingsWindow.css";

const CHARACTER_ITEMS: ReadonlyArray<readonly [PetCharacterId, string]> = PET_CHARACTERS.map(
  (character) => [character.id, character.zh] as const,
);

const STORAGE_KEY = "focusd-island-settings";

type AnimFrequency = "high" | "medium" | "low";
type Corner = "" | "tl" | "tr" | "bl" | "br";
type FullscreenAvoid = "tuck" | "hide" | "off";

type PetSettings = {
  petOpacity: number;
  petCount: number;
  bongoEnabled: boolean;
  bongoSize: number;
  bongoOpacity: number;
  bongoMirror: boolean;
  bongoClickThrough: boolean;
  bongoPosition: "bottomCenter" | "bottomLeft" | "bottomRight" | "topCenter";
  followMouse: boolean;
  cursorPetSize: number;
  collapsedScale: number;
  expandedScale: number;
  chatPanelHeight: number;
  animFrequency: AnimFrequency;
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
  fullscreenHideExtras: boolean;
  fullscreenHideBongo: boolean;
  autoTuck: boolean;
  autoTuckSeconds: number;
  observeApps: boolean;
  senseTime: boolean;
  nightCompanion: boolean;
  musicChat: boolean;
  autoRotateExpressions: boolean;
  proactiveBubbles: boolean;
  proactiveChat: boolean;
  proactiveChatMinutes: number;
  proactiveChatMode: "interval" | "state";
  /** 主动程度 0–100 */
  proactiveLevel: number;
  clipboardBubble: boolean;
  roam: boolean;
  sleepAfterSeconds: number;
  tuckedVisibleHeight: number;
  /** 多实例联动：主狗动作传染给陪玩狗 / Bongo 呼应，默认开。 */
  petLinkage: boolean;
  /** 消息只提醒、不显示文字；开关只控制「来源 + 有新消息」这类通用提示，默认关。 */
  messagePreview: boolean;
  /** 桌宠自我状态（体力/情绪/亲密/专注）：只影响待机轮播权重，默认开。 */
  petVitalsEnabled: boolean;
  /** 多屏：小狗所在屏 / Bongo 所在屏（`last`/`follow`/`primary`/指纹 key）。 */
  islandScreen: string;
  bongoScreen: string;
};

const DEFAULTS: PetSettings = {
  petOpacity: 100,
  petCount: 1,
  bongoEnabled: false,
  bongoSize: 440,
  bongoOpacity: 100,
  bongoMirror: true,
  bongoClickThrough: false,
  bongoPosition: "bottomCenter",
  followMouse: false,
  cursorPetSize: 75,
  collapsedScale: 0.89,
  expandedScale: 0.91,
  chatPanelHeight: 520,
  animFrequency: "medium",
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
  fullscreenHideExtras: true,
  fullscreenHideBongo: true,
  autoTuck: false,
  autoTuckSeconds: 30,
  observeApps: true,
  senseTime: true,
  nightCompanion: true,
  musicChat: true,
  autoRotateExpressions: true,
  proactiveBubbles: true,
  proactiveChat: false,
  proactiveChatMinutes: 30,
  proactiveChatMode: "interval",
  proactiveLevel: 50,
  clipboardBubble: true,
  roam: false,
  sleepAfterSeconds: 150,
  tuckedVisibleHeight: 80,
  petLinkage: true,
  messagePreview: false,
  petVitalsEnabled: true,
  islandScreen: "last",
  bongoScreen: "follow",
};

function load(): PetSettings {
  // 隐私：旧版「读取消息内容」开关一律按关闭处理并删掉（不复活 OCR）。
  dropLegacyWechatReadContent(window.localStorage);
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
  const t = useTranslation();
  const [settings, setSettings] = useState<PetSettings>(load);
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [shortcut, setShortcut] = useState(loadWakeShortcut);
  const [shortcutError, setShortcutError] = useState("");
  const [collapseShortcut, setCollapseShortcut] = useState(loadCollapseShortcut);
  const [collapseShortcutError, setCollapseShortcutError] = useState("");
  const [locale, setLocale] = useState(loadLocale);
  const [shortcutScanDir, setShortcutScanDir] = useState(loadShortcutScanDir);
  const [shortcutAutoDetect, setShortcutAutoDetect] = useState(loadShortcutAutoDetect);
  const petCharacter = usePetCharacter();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [desktopIconsVisible, setDesktopIconsVisible] = useState<boolean | null>(null);
  const saveTimer = useRef<number | null>(null);
  // 只读快照：设置窗口不写指标（主窗口是唯一写入方），每 10s 重新读一次。
  const [vitalsSnapshot, setVitalsSnapshot] = useState<PetVitalsSnapshot>(() => readPetVitals());
  const [chatThinking, setChatThinking] = useState(false);
  useEffect(() => {
    const read = () => {
      setVitalsSnapshot(readPetVitals());
      try {
        const busyAt = Number(window.localStorage.getItem(CHAT_BUSY_KEY) || 0);
        setChatThinking(Number.isFinite(busyAt) && Date.now() - busyAt < 10 * 60_000);
      } catch {
        setChatThinking(false);
      }
    };
    read();
    const timer = window.setInterval(read, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch(() => undefined);
    void invoke<boolean>("get_desktop_icons_visible")
      .then(setDesktopIconsVisible)
      .catch(() => setDesktopIconsVisible(null));
  }, []);

  const toggleDesktopIcons = async (visible: boolean) => {
    try {
      const next = await invoke<boolean>("set_desktop_icons_visible", { visible });
      setDesktopIconsVisible(next);
    } catch {
      setDesktopIconsVisible(null);
    }
  };

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
    const candidate = [...modifiers, key].join("+");
    if (candidate === collapseShortcut) {
      setShortcutError("和「收起面板」用了同一个组合键，换一个");
      return;
    }
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

  const recordCollapseShortcut = async (event: React.KeyboardEvent<HTMLInputElement>) => {
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
      setCollapseShortcutError("至少按住 Ctrl / Alt / Shift / Win 之一");
      return;
    }
    const key = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    const candidate = [...modifiers, key].join("+");
    if (candidate === shortcut) {
      setCollapseShortcutError("和「显示 / 隐藏桌宠」用了同一个组合键，换一个");
      return;
    }
    try {
      const registered = await invoke<string>("set_collapse_shortcut", {
        shortcut: [...modifiers, key].join("+"),
      });
      setCollapseShortcut(registered);
      saveCollapseShortcut(registered);
      setCollapseShortcutError("");
    } catch (error) {
      setCollapseShortcutError(String(error));
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
        <Slider label="收起大小" value={settings.collapsedScale} min={0.5} max={1.8} step={0.01} suffix="×" onChange={(value) => update("collapsedScale", value)} />
        <Slider label="聊天框高度" value={settings.chatPanelHeight} min={360} max={900} step={10} suffix="px" onChange={(value) => update("chatPanelHeight", value)} />
        <Segments
          label="动画切换频率"
          value={settings.animFrequency}
          items={[["high", "高频"], ["medium", "中频"], ["low", "低频"]]}
          onChange={(value) => update("animFrequency", value)}
        />
        <Switch label="点击时 Q 弹" checked={settings.clickSquash} onChange={(value) => update("clickSquash", value)} />
      </section>

      <section className="sw-card">
        <h2>桌宠形态</h2>
        <Segments
          label="小狗形象"
          value={petCharacter}
          items={CHARACTER_ITEMS}
          onChange={(value) => savePetCharacter(value)}
        />
        <p className="sw-hint sw-hint--block">
          小白和小鸡毛各自有一套动作素材；选「小白和小鸡毛」时只播两只同框的动画。
        </p>
        <Slider label="小狗数量（含主狗）" value={settings.petCount} min={1} max={5} step={1} suffix="只" onChange={(value) => update("petCount", value)} />
        <Switch label="Bongo 模式" hint="小狗趴在键盘上，跟着按键动" checked={settings.bongoEnabled} onChange={(value) => update("bongoEnabled", value)} />
        {(settings.petCount > 1 || settings.bongoEnabled) && (
          <Switch
            label="实例联动"
            hint="主狗被摸头/喂食/开心时，陪玩狗会跟着动一下；Bongo 会敲鼓呼应"
            checked={settings.petLinkage}
            onChange={(value) => update("petLinkage", value)}
          />
        )}
        <p className="sw-hint sw-hint--block">
          还没看到效果？「试一下联动」会临时拉一只随从、让两只狗各说一句台词（动作 + 位移 + 气泡），
          3 秒后自动复原；不会改动你的小狗数量 / Bongo 设置（只在本地记一条台词去重历史）。
        </p>
        <button
          type="button"
          className="sw-secondary"
          disabled={!settings.petLinkage}
          onClick={() => {
            void previewPetLinkage({ scenes: t.petLink.scenes });
          }}
        >
          试一下联动
        </button>
        {settings.bongoEnabled && (
          <>
            <Slider label="Bongo 大小" value={settings.bongoSize} min={220} max={700} step={10} suffix="px" onChange={(value) => update("bongoSize", value)} />
            <Slider label="Bongo 不透明度" value={settings.bongoOpacity} min={30} max={100} step={1} suffix="%" onChange={(value) => update("bongoOpacity", value)} />
            <Switch label="水平镜像" checked={settings.bongoMirror} onChange={(value) => update("bongoMirror", value)} />
            <Switch label="鼠标穿透 Bongo" checked={settings.bongoClickThrough} onChange={(value) => update("bongoClickThrough", value)} />
            <Segments
              label="Bongo 默认位置"
              value={settings.bongoPosition}
              items={[
                ["bottomCenter", "底部居中"],
                ["bottomLeft", "左下"],
                ["bottomRight", "右下"],
                ["topCenter", "顶部居中"],
              ]}
              onChange={(value) => update("bongoPosition", value)}
            />
          </>
        )}
        <Switch label="跟随鼠标" hint="在光标旁显示一只小尺寸小狗" checked={settings.followMouse} onChange={(value) => update("followMouse", value)} />
        {settings.followMouse && (
          <Slider label="跟随宠大小" value={settings.cursorPetSize} min={30} max={180} step={1} suffix="px" onChange={(value) => update("cursorPetSize", value)} />
        )}
        <ScreenPlacementCard
          islandScreen={settings.islandScreen}
          bongoScreen={settings.bongoScreen}
          onChange={({ islandScreen, bongoScreen }) => {
            update("islandScreen", islandScreen);
            update("bongoScreen", bongoScreen);
          }}
        />
      </section>

      <section className="sw-card">
        <h2>诊断</h2>
        <GeometrySelfCheck />
      </section>

      <section className="sw-card">
        <h2>小狗的状态</h2>
        <PetVitalsCard
          enabled={settings.petVitalsEnabled}
          onToggleEnabled={(value) => update("petVitalsEnabled", value)}
          vitals={vitalsSnapshot}
          focusActive={false}
          thinking={chatThinking}
          // 设置窗口不写指标：发事件给主窗口，由主窗口的 triggerPetAction 计数。
          onPet={() => void emit("maltese-pet-action", { action: "pet" }).catch(() => undefined)}
          onFeed={() => void emit("maltese-pet-action", { action: "eating" }).catch(() => undefined)}
        />
      </section>

      <PetGifRotationSettings />

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
        
        <Switch label="开启音效" checked={settings.soundOn} onChange={(value) => update("soundOn", value)} />
        <CustomSoundControl />
        <Switch label="整点轻轻叫一声" checked={settings.hourlyChime} onChange={(value) => update("hourlyChime", value)} />
      </section>

      <section className="sw-card">
        <h2>语言</h2>
        <div className="sw-row">
          <span className="sw-copy">
            <span className="sw-label">界面语言</span>
            <span className="sw-hint">切换后主窗口立即生效，设置窗口下次打开时跟随</span>
          </span>
          <select
            className="sw-input"
            value={locale}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isLocaleCode(next)) {
                setLocale(next);
                saveLocale(next);
                try {
                  window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
                } catch {
                  // 忽略写入失败
                }
              }
            }}
          >
            {LOCALE_CODES.map((code) => (
              <option key={code} value={code}>
                {code === "zh-CN" ? "简体中文" : "English"}
              </option>
            ))}
          </select>
        </div>
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
        <div className="sw-row">
          <span className="sw-label">收起面板</span>
          <input
            className="sw-input"
            readOnly
            value={collapseShortcut}
            onKeyDown={(event) => void recordCollapseShortcut(event)}
            title="点击后按下新的组合键；展开面板时按它直接收起"
          />
        </div>
        {collapseShortcutError && <p className="sw-error">{collapseShortcutError}</p>}
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
        <Switch
          label="全屏时 Bongo 也收起来"
          hint="关闭后，全屏玩游戏 / 看视频时 Bongo 仍然留在桌面上；与上面“全屏时小狗”互不影响"
          checked={settings.fullscreenHideBongo}
          onChange={(value) => update("fullscreenHideBongo", value)}
        />
        {settings.fullscreenAvoid !== "off" && (
          <Switch
            label="全屏时连陪伴狗 / 跟随小狗一起隐藏"
            hint="陪伴狗 / 跟随鼠标的小狗随主狗一起收起来（不含 Bongo）"
            checked={settings.fullscreenHideExtras}
            onChange={(value) => update("fullscreenHideExtras", value)}
          />
        )}
      </section>

      <section className="sw-card">
        <h2>陪伴与感知</h2>
        <Switch label="偷偷观察你" hint="按前台程序说一句关心的话（纯本地）" checked={settings.observeApps} onChange={(value) => update("observeApps", value)} />
        <Switch label="时间感知" hint="早上 / 中午 / 晚上的问候" checked={settings.senseTime} onChange={(value) => update("senseTime", value)} />
        <Switch label="夜间陪伴" hint="23 点后提醒早点休息" checked={settings.nightCompanion} onChange={(value) => update("nightCompanion", value)} />
        <Switch label="听歌互动" hint="切歌时说一句正在听的歌" checked={settings.musicChat} onChange={(value) => update("musicChat", value)} />
        <Switch label="自动切换表情" hint="关闭后小狗保持在当前那一张 GIF" checked={settings.autoRotateExpressions} onChange={(value) => update("autoRotateExpressions", value)} />
        <Switch label="根据行为弹出气泡" hint="前台程序 / 时间 / 音乐 / 剪贴板 / 整点问候" checked={settings.proactiveBubbles} onChange={(value) => update("proactiveBubbles", value)} />
        <Switch label="让模型主动找你聊天" hint="按间隔读取本机状态，主动说一句话并写进聊天记录" checked={settings.proactiveChat} onChange={(value) => update("proactiveChat", value)} />
        {settings.proactiveChat && (
          <>
            <Segments
              label="主动聊天方式"
              value={settings.proactiveChatMode}
              items={[["interval", "定时"], ["state", "跟随状态"]]}
              onChange={(value) => update("proactiveChatMode", value === "state" ? "state" : "interval")}
            />
            <Slider
              label="主动程度"
              value={settings.proactiveLevel}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(value) => {
              saveProactiveLevel(value);
              update("proactiveLevel", value);
            }}
            />
            <p className="sw-hint">
              {settings.proactiveLevel === 0
                ? "0% —— 小狗不会主动开口。"
                : `${settings.proactiveLevel}% —— ${describeProactivePlan(proactivePlan(settings.proactiveLevel))}`}
            </p>
          </>
        )}
        <Slider label="多久没动静就趴下睡" value={settings.sleepAfterSeconds} min={30} max={900} step={15} suffix="s" onChange={(value) => update("sleepAfterSeconds", value)} />
        <TuckGifControl />
        <Slider label="缩边睡觉时露出高度" value={settings.tuckedVisibleHeight} min={24} max={140} step={1} suffix="px" onChange={(value) => update("tuckedVisibleHeight", value)} />
      </section>

      <section className="sw-card">
        <h2>消息提醒</h2>
        <div className="sw-row">
          <span className="sw-copy">
            <span className="sw-label">QQ 消息提醒</span>
            <span className="sw-hint">需要 Windows「通知访问」权限，并且 QQ 本身要开启系统通知；只提醒有新通知，不读取消息内容</span>
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
            <span className="sw-hint">通过任务栏闪烁判断新消息；只提醒有新消息，不读取会话内容</span>
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
        <Switch
          label="显示消息预览"
          hint="默认关闭。本版本不读取聊天内容（OCR 已移除），打开后也只显示「来源 + 有新消息」这类通用提示"
          checked={settings.messagePreview}
          onChange={(value) => update("messagePreview", value)}
        />
      </section>

      <section className="sw-card">
        <h2>其他</h2>
        <Switch
          label="显示桌面图标"
          hint={desktopIconsVisible === null ? "当前系统状态读取失败，点一下即可切换" : "一键隐藏 / 恢复桌面上的图标"}
          checked={desktopIconsVisible ?? true}
          onChange={(value) => void toggleDesktopIcons(value)}
        />
        <Switch label="随机闲逛" hint="空闲时小狗在桌面慢慢挪一小步" checked={settings.roam} onChange={(value) => update("roam", value)} />
        <Switch
          label="自动识别快捷方式"
          hint="关闭后不再扫描桌面或指定目录，只保留自定义入口"
          checked={shortcutAutoDetect}
          onChange={(value) => {
            setShortcutAutoDetect(value);
            saveShortcutAutoDetect(value);
          }}
        />
        <div className="sw-row sw-row--stack">
          <span className="sw-copy">
            <span className="sw-label">快捷方式扫描目录</span>
            <span className="sw-hint">留空只扫描桌面；填目录后只识别该目录，不再扫描开始菜单/Program Files</span>
          </span>
          <input
            className="sw-input sw-input--wide"
            value={shortcutScanDir}
            placeholder="例如 D:\\我的快捷方式"
            spellCheck={false}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setShortcutScanDir(next);
              saveShortcutScanDir(next);
            }}
          />
        </div>
      </section>

      <section className="sw-card">
        <h2>聊天模型</h2>
        <LocalChatSettings embedded />
      </section>

      <section className="sw-card">
        <h2>关于与更新</h2>
        <UpdatePanel />
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