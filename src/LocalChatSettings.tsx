import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, LoaderCircle, Server, X } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  loadLocalChatConfig,
  saveLocalChatConfig,
  LOCAL_CHAT_UPDATED_EVENT,
  type LocalChatConfig,
  THINKING_DEPTHS,
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
  const [startingStrata, setStartingStrata] = useState(false);
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

  const startStrata = async () => {
    setStartingStrata(true);
    setTestStatus(null);
    try {
      await invoke("strata_launch");
      update({
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "qwen3.6-35b-a3b-ud-q4_k_xl",
      });
      setTestStatus({ ok: true, text: t.chat.modelStrataStarted });
    } catch (error) {
      setTestStatus({ ok: false, text: String(error) });
    } finally {
      setStartingStrata(false);
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
            <button
              type="button"
              onClick={() => update({
                baseUrl: "http://127.0.0.1:8080/v1",
                model: config.model || "qwen3.6-35b-a3b-ud-q4_k_xl",
              })}
            >
              {t.chat.modelPresetStrata}
            </button>
          </div>
          <p className="local-chat-settings__hint">{t.chat.modelStrataHint}</p>
          <div className="local-chat-settings__actions">
            <button
              type="button"
              className="local-chat-settings__test"
              disabled={startingStrata}
              onClick={() => void startStrata()}
            >
              <Server size={13} />
              {startingStrata ? t.chat.modelStartingStrata : t.chat.modelStartStrata}
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
          <fieldset className="local-chat-settings__fieldset">
            <legend>{t.chat.modelGenerationTitle}</legend>
            <label className="local-chat-settings__field">
              <span>{t.chat.modelMaxTokens}</span>
              <input
                type="number"
                min={32}
                max={2048}
                step={32}
                value={config.maxTokens}
                onChange={(event) => update({ maxTokens: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="local-chat-settings__field">
              <span>{t.chat.modelTemperature}</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={config.temperature}
                onChange={(event) => update({ temperature: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="local-chat-settings__field">
              <span>{t.chat.modelTopP}</span>
              <input
                type="number"
                min={0.1}
                max={1}
                step={0.05}
                value={config.topP}
                onChange={(event) => update({ topP: Number(event.currentTarget.value) })}
              />
            </label>
            <div className="local-chat-settings__row">
              <span>{t.chat.modelThinking}</span>
              <div className="local-chat-settings__segments" role="group" aria-label={t.chat.modelThinking}>
                {THINKING_DEPTHS.map((depth) => (
                  <button
                    key={depth.value}
                    type="button"
                    className={config.thinkingDepth === depth.value ? "is-active" : ""}
                    aria-pressed={config.thinkingDepth === depth.value}
                    title={depth.hint}
                    onClick={() => {
                      update({ thinkingDepth: depth.value });
                      // 点完立刻给一句确认：以前只有按钮变色，用户看不出到底开没开。
                      setTestStatus({
                        ok: true,
                        text:
                          depth.value === "off"
                            ? "思考已关闭：不推理，回复最快。"
                            : `思考已开启（${depth.label}）：首字会慢一点，聊天里会显示等待秒数。`,
                      });
                    }}
                  >
                    {depth.label}
                  </button>
                ))}
              </div>
            </div>
              <p className="local-chat-settings__hint">
                {config.thinkingDepth === "off"
                  ? "当前：关 —— 不推理，回复最快。"
                  : `当前：${THINKING_DEPTHS.find((item) => item.value === config.thinkingDepth)?.label ?? "标准"} —— 先推理再回答；等待时聊天里显示「小狗正在思考…（Ns）」。`}
              </p>
            <label className="local-chat-settings__check">
              <input
                type="checkbox"
                checked={config.stream}
                onChange={(event) => update({ stream: event.currentTarget.checked })}
              />
              <span>{t.chat.modelStream}</span>
            </label>
            <label className="local-chat-settings__check">
              <input
                type="checkbox"
                checked={config.showThinking}
                onChange={(event) => update({ showThinking: event.currentTarget.checked })}
              />
              <span>展示思考过程（默认折叠，可点开）</span>
            </label>
            <p className="local-chat-settings__hint">{t.chat.modelVision}</p>
          </fieldset>
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
