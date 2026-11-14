import { useCallback, useEffect, useState } from "react";
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

const DISABLED_PLUGINS_KEY = "maltese-disabled-plugins";
const BILLIARDS_PLUGIN_ID = "billiards";

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

export function PluginsPanel() {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<PluginList | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [removeArmed, setRemoveArmed] = useState("");
  const [disabled, setDisabled] = useState<string[]>(loadDisabledPlugins);
  const [notice, setNotice] = useState("");
  const [help, setHelp] = useState<{ plugin: PluginInfo; left: number; top: number } | null>(null);

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

  const showHelp = (plugin: PluginInfo, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const width = 320;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = Math.min(rect.bottom + 8, window.innerHeight - 240);
    setHelp({ plugin, left, top });
  };

  const plugins = snapshot?.plugins ?? [];
  const external = plugins.filter((plugin) => !plugin.builtin);

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
          return (
            <article
              className={`plugin-card${isDisabled ? " plugin-card--disabled" : ""}`}
              key={plugin.id}
              onMouseEnter={(event) => showHelp(plugin, event.currentTarget)}
              onMouseLeave={() => setHelp(null)}
            >
              <div className="plugin-card__main">
                <strong className="plugin-card__name">{plugin.name}</strong>
                <span className="plugin-card__badge">
                  {plugin.builtin ? t.plugins.builtin : plugin.locked ? "预置" : `v${plugin.version || "0.0.0"}`}
                </span>
                {isDisabled && <span className="plugin-card__badge plugin-card__badge--muted">{t.plugins.disabled}</span>}
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

      {help && createPortal(
        <aside className="plugin-help-window" style={{ left: help.left, top: help.top }} role="tooltip">
          <header className="plugin-help-window__head">
            <strong>{help.plugin.name}</strong>
            <span>{help.plugin.builtin ? t.plugins.builtin : `v${help.plugin.version || "0.0.0"}`}</span>
          </header>
          <p className="plugin-help-window__description">{help.plugin.description}</p>
          {help.plugin.actions.length > 0 && (
            <div className="plugin-help-window__actions">
              {help.plugin.actions.map((action) => (
                <div key={action.id}>
                  <strong>{action.label}</strong>
                  {action.description && <p>{action.description}</p>}
                </div>
              ))}
            </div>
          )}
          <footer className="plugin-help-window__meta">
            {help.plugin.author && <span>{t.plugins.by} {help.plugin.author}</span>}
            {help.plugin.path && <span className="plugin-help-window__path">{help.plugin.path}</span>}
          </footer>
          <p className="plugin-help-window__security">⚠ {t.plugins.security}</p>
        </aside>,
        document.body,
      )}
    </section>
  );
}
