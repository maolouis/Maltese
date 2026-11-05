import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, LoaderCircle, Server, X } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  loadLocalChatConfig,
  saveLocalChatConfig,
  LOCAL_CHAT_UPDATED_EVENT,
  type LocalChatConfig,
} from "./localChat";
import "./LocalChatSettings.css";

export function LocalChatSettings({
  onClose,
  embedded = false,
}: {
  onClose?: () => void;
  embedded?: boolean;
}) {
  const t = useTranslation();
  const listId = useId();
  const [config, setConfig] = useState<LocalChatConfig>(loadLocalChatConfig);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const sync = () => setConfig(loadLocalChatConfig());
    window.addEventListener("storage", sync);
    window.addEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(LOCAL_CHAT_UPDATED_EVENT, sync);
    };
  }, []);

  const update = (patch: Partial<LocalChatConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveLocalChatConfig(next);
    setTestStatus(null);
  };

  const test = async () => {
    setTesting(true);
    setTestStatus(null);
    try {
      const found = await invoke<string[]>("local_chat_models", {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey.trim() || null,
      });
      setModels(found);
      setTestStatus({
        ok: true,
        text: found.length > 0 ? t.chat.modelTestOk(found.length) : t.chat.modelTestEmpty,
      });
    } catch (error) {
      setTestStatus({ ok: false, text: String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section
      className={`local-chat-settings${embedded ? " local-chat-settings--embedded" : ""}`}
      aria-label={t.chat.modelSettings}
    >
      <div className="local-chat-settings__head">
        <span className="local-chat-settings__title">
          <Server size={14} strokeWidth={1.9} aria-hidden="true" />
          {t.chat.modelBackend}
        </span>
        {onClose && (
          <button
            type="button"
            className="local-chat-settings__close"
            onClick={onClose}
            aria-label={t.chat.modelClose}
            title={t.chat.modelClose}
          >
            <X size={14} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="local-chat-settings__backends" role="group" aria-label={t.chat.modelBackend}>
        <button
          type="button"
          className={config.backend === "dsh" ? "is-active" : ""}
          aria-pressed={config.backend === "dsh"}
          onClick={() => update({ backend: "dsh" })}
        >
          {t.chat.modelDsh}
        </button>
        <button
          type="button"
          className={config.backend === "local" ? "is-active" : ""}
          aria-pressed={config.backend === "local"}
          onClick={() => update({ backend: "local" })}
        >
          {t.chat.modelLocal}
        </button>
      </div>

      {config.backend === "local" ? (
        <>
          <p className="local-chat-settings__hint">{t.chat.modelLocalHint}</p>
          <div className="local-chat-settings__presets">
            <button
              type="button"
              onClick={() => update({ baseUrl: "http://127.0.0.1:11434/v1" })}
            >
              {t.chat.modelPresetOllama}
            </button>
            <button
              type="button"
              onClick={() => update({ baseUrl: "http://127.0.0.1:1234/v1" })}
            >
              {t.chat.modelPresetLmStudio}
            </button>
          </div>
          <label className="local-chat-settings__field">
            <span>{t.chat.modelBaseUrl}</span>
            <input
              type="url"
              value={config.baseUrl}
              placeholder="http://127.0.0.1:11434/v1"
              spellCheck={false}
              onChange={(event) => update({ baseUrl: event.currentTarget.value })}
            />
          </label>
          <p className="local-chat-settings__hint">{t.chat.modelBaseUrlHint}</p>
          <label className="local-chat-settings__field">
            <span>{t.chat.modelName}</span>
            <input
              type="text"
              list={listId}
              value={config.model}
              placeholder={t.chat.modelNamePlaceholder}
              spellCheck={false}
              onChange={(event) => update({ model: event.currentTarget.value })}
            />
            <datalist id={listId}>
              {models.map((model) => <option key={model} value={model} />)}
            </datalist>
          </label>
          <label className="local-chat-settings__field">
            <span>{t.chat.modelApiKey}</span>
            <input
              type="password"
              value={config.apiKey}
              placeholder="sk-…"
              autoComplete="off"
              onChange={(event) => update({ apiKey: event.currentTarget.value })}
            />
          </label>
          <p className="local-chat-settings__hint">{t.chat.modelApiKeyHint}</p>
          <div className="local-chat-settings__actions">
            <button
              type="button"
              className="local-chat-settings__test"
              disabled={testing || !config.baseUrl.trim()}
              onClick={() => void test()}
            >
              {testing ? <LoaderCircle size={13} className="local-chat-settings__spin" /> : <Server size={13} />}
              {testing ? t.chat.modelTesting : t.chat.modelTest}
            </button>
            {testStatus && (
              <span
                className={`local-chat-settings__status${testStatus.ok ? " is-ok" : " is-error"}`}
                role={testStatus.ok ? "status" : "alert"}
              >
                {testStatus.ok && <Check size={12} aria-hidden="true" />}
                {testStatus.text}
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="local-chat-settings__hint">{t.chat.modelDshHint}</p>
      )}

      {onClose && (
        <div className="local-chat-settings__footer">
          <button type="button" className="local-chat-settings__done" onClick={onClose}>
            {t.chat.modelClose}
          </button>
        </div>
      )}
    </section>
  );
}
