import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CircleHelp } from "lucide-react";
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
  path: string | null;
  actions: PluginAction[];
};

type PluginList = {
  directory: string;
  plugins: PluginInfo[];
  errors: string[];
};

const DISABLED_PLUGINS_KEY = "maltese-disabled-plugins";

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

type PluginsPanelProps = {
  onOpenBuiltin?: (id: string) => void;
};

export function PluginsPanel({ onOpenBuiltin }: PluginsPanelProps) {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<PluginList | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [removeArmed, setRemoveArmed] = useState("");
  const [disabled, setDisabled] = useState<string[]>(loadDisabledPlugins);
  const [notice, setNotice] = useState("");
  const [help, setHelp] = useState<{ plugin: PluginInfo; left: number; top: number } | null>(null);
  const [billiardsNotice, setBilliardsNotice] = useState("");
  const [iconsAvailable, setIconsAvailable] = useState<boolean | null>(null);

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

  // 台球要读桌面图标位置：图标被隐藏时先提示，别让用户点了没反应。
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("desktop_icons_available")
      .then(setIconsAvailable)
      .catch(() => setIconsAvailable(null));
  }, []);

  const openBilliards = async () => {
    setBilliardsNotice("");
    try {
      await invoke("open_billiards_window");
    } catch (error) {
      setBilliardsNotice("打开台球失败：" + String(error));
    }
  };

  useEffect(() => {
    if (!removeArmed) return;
    const timer = window.setTimeout(() => setRemoveArmed(""), 4000);
    return () => window.clearTimeout(timer);
  }, [removeArmed]);

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

  const plugins = snapshot?.plugins ?? [];
  const external = plugins.filter((plugin) => !plugin.builtin);

  return (
    <section className="plugins-panel" aria-label={t.plugins.title}>
      <div className="plugins-panel__head">
        <div>
          <span className="assistant-panel__label">{t.plugins.title}</span>
          <small>{t.plugins.subtitle}</small>
        </div>
        <div className="plugins-panel__head-actions">
          <button type="button" onClick={() => void invoke("open_plugins_directory").catch((error) => setNotice(String(error)))}>
            {t.plugins.openDirectory}
          </button>
          <button type="button" onClick={() => void refresh()}>
            {t.plugins.refresh}
          </button>
        </div>
      </div>

      <article className="plugin-card plugin-card--builtin plugin-billiards">
        <div className="plugin-card__head">
          <div className="plugin-card__title">
            <strong>桌面图标台球</strong>
            <span className="plugin-card__badge">{t.plugins.builtin}</span>
          </div>
          <div className="plugin-card__head-actions">
            <button type="button" onClick={() => void openBilliards()}>
              和小狗开一局
            </button>
          </div>
        </div>
        <p className="plugin-billiards__desc">
          把桌面图标当成台球：按住左键拉杆蓄力，松手击球，小狗会在旁边帮你加油。桌面图标保持原样，退出即恢复。
        </p>
        <p className="plugin-billiards__credit">
          玩法参考开源项目{" "}
          <a href="https://github.com/liuxiaogang-com/desktop-icon-billiards" target="_blank" rel="noreferrer">
            desktop-icon-billiards
          </a>{" "}
          · 作者 GitHub@liuxiaogang-com（MIT）
        </p>
        {iconsAvailable === false && (
          <p className="plugin-billiards__warn">桌面图标当前是隐藏的，先在设置里把它们显示出来再玩。</p>
        )}
        {billiardsNotice && <p className="plugin-billiards__warn">{billiardsNotice}</p>}
      </article>

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

      {snapshot?.directory && (
        <p className="plugins-panel__directory" title={snapshot.directory}>
          {snapshot.directory}
        </p>
      )}
      {notice && <p className="plugins-panel__notice" role="status">{notice}</p>}
      {snapshot?.errors.map((error) => (
        <p className="plugins-panel__notice plugins-panel__notice--warn" key={error}>{error}</p>
      ))}

      <div className="plugins-panel__list">
        {plugins.map((plugin) => {
          const isDisabled = !plugin.builtin && disabled.includes(plugin.id);
          return (
            <article
              className={`plugin-card${plugin.builtin ? " plugin-card--builtin" : ""}${isDisabled ? " plugin-card--disabled" : ""}`}
              key={plugin.id}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const width = 282;
                const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
                const top = Math.min(rect.bottom + 7, window.innerHeight - 250);
                setHelp({ plugin, left, top });
              }}
              onMouseLeave={() => setHelp(null)}
            >
              <div className="plugin-card__head">
                <div className="plugin-card__title">
                  <strong>{plugin.name}</strong>
                  <span className="plugin-card__badge">
                    {plugin.builtin ? t.plugins.builtin : `v${plugin.version || "0.0.0"}`}
                  </span>
                  {isDisabled && <span className="plugin-card__badge plugin-card__badge--muted">{t.plugins.disabled}</span>}
                </div>
                <div className="plugin-card__head-actions">
                  {plugin.builtin ? (
                    <button type="button" onClick={() => onOpenBuiltin?.(plugin.id)}>
                      {t.plugins.openVideo}
                    </button>
                  ) : (
                    <>
                      <button type="button" onClick={() => toggle(plugin)}>
                        {isDisabled ? t.plugins.enable : t.plugins.disable}
                      </button>
                      <button
                        type="button"
                        className={removeArmed === plugin.id ? "plugin-card__danger plugin-card__danger--armed" : "plugin-card__danger"}
                        onClick={() => void remove(plugin)}
                      >
                        {removeArmed === plugin.id ? t.plugins.removeConfirm : t.plugins.remove}
                      </button>
                    </>
                  )}
                </div>
              </div>
              {plugin.actions.length > 0 ? (
                <div className="plugin-card__actions" aria-label={t.plugins.actions}>
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
                </div>
              ) : (
                !plugin.builtin && <span className="plugin-card__hint">{t.plugins.noActions}</span>
              )}
              <span className="plugin-card__help-hint">
                <CircleHelp size={11} aria-hidden="true" />
                {t.plugins.helpHover}
              </span>
            </article>
          );
        })}
        {external.length === 0 && (
          <div className="plugins-panel__empty">
            <strong>{t.plugins.empty}</strong>
            <small>{t.plugins.emptyHint}</small>
          </div>
        )}
      </div>
      <p className="plugins-panel__security">⚠ {t.plugins.security}</p>
      {help && createPortal(
        <aside
          className="plugin-help-window"
          style={{ left: help.left, top: help.top }}
          role="tooltip"
        >
          <header className="plugin-help-window__head">
            <strong>{help.plugin.name}</strong>
            <span>{help.plugin.builtin ? t.plugins.builtin : `v${help.plugin.version || "0.0.0"}`}</span>
          </header>
          <p className="plugin-help-window__description">
            {help.plugin.description || t.plugins.noActions}
          </p>
          {help.plugin.actions.length > 0 && (
            <div className="plugin-help-window__actions">
              {help.plugin.actions.map((action) => (
                <div key={action.id}>
                  <strong>{action.label}</strong>
                  {action.description && <p>{action.description}</p>}
                  {action.command && <code>{action.command}</code>}
                </div>
              ))}
            </div>
          )}
          <footer className="plugin-help-window__meta">
            {help.plugin.author && <span>{t.plugins.by} {help.plugin.author}</span>}
            {help.plugin.path && <span title={help.plugin.path}>{help.plugin.path}</span>}
          </footer>
        </aside>,
        document.body,
      )}
    </section>
  );
}