import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useTranslation } from "./i18n";
import "./PluginsPanel.css";

type PluginAction = {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
};

type PluginInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  builtin: boolean;
  locked: boolean;
  path: string | null;
  ui: string | null;
  actions: PluginAction[];
};

type PluginList = {
  directory: string;
  plugins: PluginInfo[];
  errors: string[];
};

/**
 * 说明浮层的状态。
 *
 * `anchor` 是打开它的那张卡片：点击卡片外部时据此判断「是不是还在卡片里」，
 * 所以点「说明」按钮或卡片主体都算内部，不会先关再开。
 */
type HelpState = {
  plugin: PluginInfo;
  anchor: HTMLElement;
  left: number;
  top: number;
  width: number;
  placement: "below" | "above";
  maxHeight: number;
};

const DISABLED_PLUGINS_KEY = "maltese-disabled-plugins";
const BILLIARDS_PLUGIN_ID = "billiards";

const HELP_WIDTH = 320;
const HELP_MARGIN = 8;
const HELP_GAP = 8;
const HELP_MAX_HEIGHT = 320;
const HELP_MIN_HEIGHT = 96;

function loadDisabledPlugins(): string[] {
  try {
    const raw = window.localStorage.getItem(DISABLED_PLUGINS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function saveDisabledPlugins(ids: string[]) {
  try {
    window.localStorage.setItem(DISABLED_PLUGINS_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // 忽略 localStorage 写入失败
  }
}

/**
 * 计算说明浮层的位置。
 *
 * 策略：水平锚定卡片左侧并夹取到视口内；垂直方向优先放到卡片**下方**，
 * 这样不会盖住卡片右侧的「打开 / 安装 / 删除」按钮。下方空间不足时改到卡片
 * 上方；两侧都很窄时选空间大的一侧，并压缩浮层高度（内部可滚动）。
 */
function layoutHelp(anchor: HTMLElement): Omit<HelpState, "plugin" | "anchor"> {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(
    180,
    Math.min(HELP_WIDTH, viewportWidth - HELP_MARGIN * 2),
  );
  const left = Math.max(
    HELP_MARGIN,
    Math.min(rect.left, viewportWidth - width - HELP_MARGIN),
  );

  const spaceBelow = viewportHeight - rect.bottom - HELP_GAP - HELP_MARGIN;
  const spaceAbove = rect.top - HELP_GAP - HELP_MARGIN;
  // 下方至少能放下 180px 才优先下方，否则比较两侧空间。
  const placement: "below" | "above" =
    spaceBelow >= 180 || spaceBelow >= spaceAbove ? "below" : "above";
  const available = Math.max(
    HELP_MIN_HEIGHT,
    placement === "below" ? spaceBelow : spaceAbove,
  );
  const maxHeight = Math.min(HELP_MAX_HEIGHT, available);
  // 下方从卡片底边开始、上方从卡片顶边往上，两个方向都不会压到卡片本身。
  const top =
    placement === "below"
      ? rect.bottom + HELP_GAP
      : Math.max(HELP_MARGIN, rect.top - HELP_GAP - maxHeight);

  return { left, top, width, placement, maxHeight };
}

export function PluginsPanel() {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<PluginList | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [removeArmed, setRemoveArmed] = useState("");
  const [disabled, setDisabled] = useState<string[]>(loadDisabledPlugins);
  const [notice, setNotice] = useState("");
  const [help, setHelp] = useState<HelpState | null>(null);
  const helpRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const next = await invoke<PluginList>("list_plugins");
      setSnapshot(next);
    } catch (error) {
      setNotice(t.plugins.loadFailed + String(error));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!removeArmed) return;
    const timer = window.setTimeout(() => setRemoveArmed(""), 4000);
    return () => window.clearTimeout(timer);
  }, [removeArmed]);

  // 打开说明后：点击浮层和卡片以外的任何地方、按 Esc、滚动或缩放窗口都会收起。
  useEffect(() => {
    if (!help) return;
    const anchor = help.anchor;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (helpRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      setHelp(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHelp(null);
    };
    const handleScroll = (event: Event) => {
      // 浮层自己滚动时不收起，只处理外部的滚动。
      const target = event.target as Node | null;
      if (target && helpRef.current?.contains(target)) return;
      setHelp(null);
    };
    const handleResize = () => setHelp(null);

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [help]);

  const openPlugin = async (plugin: PluginInfo) => {
    setNotice("");
    try {
      // 台球是覆盖整个桌面的独立窗口，不走普通插件窗口。
      if (plugin.id === BILLIARDS_PLUGIN_ID) {
        await invoke("open_billiards_window");
        return;
      }
      await invoke("open_plugin_window", { id: plugin.id });
    } catch (error) {
      setNotice(`打开失败：${String(error)}`);
    }
  };

  const install = async () => {
    const source = installPath.trim();
    if (!source || installing) return;
    setInstalling(true);
    setNotice("");
    try {
      const plugin = await invoke<PluginInfo>("install_plugin", { source });
      setInstallPath("");
      setNotice(t.plugins.installed(plugin.name));
      await refresh();
    } catch (error) {
      setNotice(t.plugins.installFailed + String(error));
    } finally {
      setInstalling(false);
    }
  };

  const remove = async (plugin: PluginInfo) => {
    if (plugin.builtin) return;
    if (removeArmed !== plugin.id) {
      setRemoveArmed(plugin.id);
      return;
    }
    setRemoveArmed("");
    try {
      await invoke("remove_plugin", { id: plugin.id });
      setDisabled((current) => {
        const next = current.filter((id) => id !== plugin.id);
        saveDisabledPlugins(next);
        return next;
      });
      setNotice(`${plugin.name} 已卸载`);
      await refresh();
    } catch (error) {
      setNotice(String(error));
    }
  };

  const toggle = (plugin: PluginInfo) => {
    if (plugin.builtin) return;
    setDisabled((current) => {
      const next = current.includes(plugin.id)
        ? current.filter((id) => id !== plugin.id)
        : [...current, plugin.id];
      saveDisabledPlugins(next);
      return next;
    });
  };

  const run = async (plugin: PluginInfo, action: PluginAction) => {
    const key = `${plugin.id}:${action.id}`;
    if (busyAction) return;
    setBusyAction(key);
    setNotice("");
    try {
      await invoke("run_plugin_action", { id: plugin.id, actionId: action.id });
      setNotice(`${plugin.name} · ${action.label} 已启动`);
    } catch (error) {
      setNotice(`${plugin.name} · ${action.label} 启动失败：${String(error)}`);
    } finally {
      setBusyAction("");
    }
  };

  // 点击同一张卡片（主体或「?」按钮）打开，再次点击关闭。
  const toggleHelp = useCallback((plugin: PluginInfo, anchor: HTMLElement) => {
    setHelp((current) =>
      current?.plugin.id === plugin.id
        ? null
        : { plugin, anchor, ...layoutHelp(anchor) },
    );
  }, []);

  const handleCardClick = (
    plugin: PluginInfo,
    event: ReactMouseEvent<HTMLElement>,
  ) => {
    // 卡片里的按钮自己处理点击；点「?」以外的按钮时顺手收起说明。
    const target = event.target;
    const button = target instanceof Element ? target.closest("button") : null;
    if (button) {
      if (!button.classList.contains("plugin-card__help-toggle")) setHelp(null);
      return;
    }
    toggleHelp(plugin, event.currentTarget);
  };

  const handleCardKeyDown = (
    plugin: PluginInfo,
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    // 只有卡片本身获得焦点时响应；卡片内按钮的 Enter/Space 交给按钮自己。
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    event.preventDefault();
    toggleHelp(plugin, event.currentTarget);
  };

  const plugins = snapshot?.plugins ?? [];
  const external = plugins.filter((plugin) => !plugin.builtin);
  const helpPlugin = help
    ? plugins.find((plugin) => plugin.id === help.plugin.id) ?? help.plugin
    : null;

  return (
    <section className="plugins-panel" aria-label={t.plugins.title}>
      <div className="plugins-panel__head">
        <h2 className="plugins-panel__title">{t.plugins.title}</h2>
        <div className="plugins-panel__head-actions">
          <button type="button" onClick={() => void invoke("open_plugins_directory").catch((error) => setNotice(String(error)))}>
            {t.plugins.openDirectory}
          </button>
          <button type="button" onClick={() => void refresh()}>
            {t.plugins.refresh}
          </button>
        </div>
      </div>

      <div className="plugins-panel__install">
        <input
          value={installPath}
          onChange={(event) => setInstallPath(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void install();
          }}
          placeholder={t.plugins.installPlaceholder}
          spellCheck={false}
        />
        <button type="button" disabled={installing || !installPath.trim()} onClick={() => void install()}>
          {installing ? t.plugins.running : t.plugins.install}
        </button>
      </div>

      {notice && <p className="plugins-panel__notice" role="status">{notice}</p>}
      {snapshot?.errors.map((error) => (
        <p className="plugins-panel__notice plugins-panel__notice--warn" key={error}>{error}</p>
      ))}

      <div className="plugins-panel__list">
        {plugins.map((plugin) => {
          const isDisabled = !plugin.builtin && disabled.includes(plugin.id);
          const canManage = !plugin.builtin && !plugin.locked;
          const helpOpen = help?.plugin.id === plugin.id;
          return (
            <article
              className={`plugin-card${isDisabled ? " plugin-card--disabled" : ""}${helpOpen ? " plugin-card--help-open" : ""}`}
              key={plugin.id}
              tabIndex={0}
              role="group"
              aria-expanded={helpOpen}
              aria-label={`${plugin.name}：按 Enter 或空格查看说明`}
              onClick={(event) => handleCardClick(plugin, event)}
              onKeyDown={(event) => handleCardKeyDown(plugin, event)}
            >
              <div className="plugin-card__main">
                <strong className="plugin-card__name">{plugin.name}</strong>
                <span className="plugin-card__badge">
                  {plugin.builtin ? t.plugins.builtin : plugin.locked ? "预置" : `v${plugin.version || "0.0.0"}`}
                </span>
                {isDisabled && <span className="plugin-card__badge plugin-card__badge--muted">{t.plugins.disabled}</span>}
                <button
                  type="button"
                  className="plugin-card__help-toggle"
                  aria-expanded={helpOpen}
                  aria-controls={`plugin-help-${plugin.id}`}
                  aria-label={helpOpen ? "收起说明" : "查看说明"}
                  title={helpOpen ? "收起说明" : "查看说明"}
                  onClick={(event) => {
                    const card = event.currentTarget.closest(".plugin-card");
                    if (card instanceof HTMLElement) toggleHelp(plugin, card);
                  }}
                >
                  ?
                </button>
              </div>
              <div className="plugin-card__actions">
                <button type="button" className="plugin-card__primary" onClick={() => void openPlugin(plugin)}>
                  {t.plugins.open}
                </button>
                {plugin.actions.map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    title={action.description || action.command}
                    disabled={isDisabled || Boolean(busyAction)}
                    onClick={() => void run(plugin, action)}
                  >
                    {busyAction === `${plugin.id}:${action.id}` ? t.plugins.running : action.label}
                  </button>
                ))}
                {canManage && (
                  <button type="button" onClick={() => toggle(plugin)}>
                    {isDisabled ? t.plugins.enable : t.plugins.disable}
                  </button>
                )}
                {canManage && (
                  <button
                    type="button"
                    className={removeArmed === plugin.id ? "plugin-card__danger plugin-card__danger--armed" : "plugin-card__danger"}
                    onClick={() => void remove(plugin)}
                  >
                    {removeArmed === plugin.id ? t.plugins.removeConfirm : t.plugins.remove}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {external.length === 0 && (
          <div className="plugins-panel__empty">
            <strong>{t.plugins.empty}</strong>
          </div>
        )}
      </div>

      {help && helpPlugin && createPortal(
        <aside
          id={`plugin-help-${help.plugin.id}`}
          ref={helpRef}
          className={`plugin-help-window plugin-help-window--${help.placement}`}
          style={{
            left: help.left,
            top: help.top,
            width: help.width,
            maxHeight: help.maxHeight,
          }}
          role="dialog"
          aria-label={`${helpPlugin.name} 说明`}
        >
          <header className="plugin-help-window__head">
            <strong>{helpPlugin.name}</strong>
            <span>{helpPlugin.builtin ? t.plugins.builtin : `v${helpPlugin.version || "0.0.0"}`}</span>
            <button
              type="button"
              className="plugin-help-window__close"
              aria-label="收起说明"
              title="收起说明"
              onClick={() => setHelp(null)}
            >
              ×
            </button>
          </header>
          <p className="plugin-help-window__description">{helpPlugin.description}</p>
          {helpPlugin.actions.length > 0 && (
            <div className="plugin-help-window__actions">
              {helpPlugin.actions.map((action) => (
                <div key={action.id}>
                  <strong>{action.label}</strong>
                  {action.description && <p>{action.description}</p>}
                </div>
              ))}
            </div>
          )}
          <footer className="plugin-help-window__meta">
            {helpPlugin.author && <span>{t.plugins.by} {helpPlugin.author}</span>}
            {helpPlugin.path && <span className="plugin-help-window__path">{helpPlugin.path}</span>}
          </footer>
          <p className="plugin-help-window__security">⚠ {t.plugins.security}</p>
        </aside>,
        document.body,
      )}
    </section>
  );
}
