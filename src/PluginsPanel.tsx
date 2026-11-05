import { useCallback, useEffect, useState } from "react";
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
              <p className="plugin-card__description">{plugin.description || t.plugins.noActions}</p>
              <div className="plugin-card__meta">
                {plugin.author && <span>{t.plugins.by} {plugin.author}</span>}
                {plugin.path && <span title={plugin.path}>{plugin.path}</span>}
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
                !plugin.builtin && <p className="plugin-card__hint">{t.plugins.noActions}</p>
              )}
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
    </section>
  );
}