import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, RefreshCcw, Sparkles, X } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  checkForUpdate,
  getUpdateState,
  installUpdate,
  subscribeToUpdate,
} from "./updaterController";
import "./UpdateBanner.css";

/**
 * 主面板顶部的更新提示。只在发现新版本、下载中、安装中或安装失败时出现；
 * 平时不占位置。自动检查由 App 启动时调用 startAutoUpdateCheck() 触发。
 */
export function UpdateBanner() {
  const t = useTranslation();
  const { stage, nextVersion, downloaded, total, detail } = useSyncExternalStore(
    subscribeToUpdate,
    getUpdateState,
  );
  const [hiddenVersion, setHiddenVersion] = useState("");

  useEffect(() => {
    setHiddenVersion("");
  }, [nextVersion]);

  if (stage === "idle" || stage === "checking" || stage === "latest" || stage === "disabled") {
    return null;
  }
  if (stage === "available" && hiddenVersion === nextVersion) return null;
  if (stage === "error" && !nextVersion) return null;

  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;

  return (
    <section
      className={`island-update-banner island-update-banner--${stage}`}
      role="status"
      aria-live="polite"
    >
      <div className="island-update-banner__copy">
        <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
        <div>
          <strong>
            {stage === "available"
              ? t.updateNotice.available(nextVersion)
              : stage === "downloading"
                ? t.updateNotice.downloading(percent)
                : stage === "installing"
                  ? t.updateNotice.installing
                  : stage === "done"
                    ? t.updateNotice.done
                    : t.updateNotice.error}
          </strong>
          {stage === "available" && <span>{t.updateNotice.body}</span>}
          {stage === "error" && detail && <span>{t.updateNotice.errorDetail(detail)}</span>}
        </div>
      </div>

      {stage === "available" && (
        <div className="island-update-banner__actions">
          <button
            type="button"
            className="island-update-banner__install"
            onClick={() => void installUpdate()}
          >
            <Download size={13} aria-hidden="true" />
            {t.updateNotice.install}
          </button>
          <button
            type="button"
            className="island-update-banner__later"
            onClick={() => setHiddenVersion(nextVersion)}
          >
            <X size={13} aria-hidden="true" />
            {t.updateNotice.later}
          </button>
        </div>
      )}

      {stage === "error" && (
        <div className="island-update-banner__actions">
          <button
            type="button"
            className="island-update-banner__install"
            onClick={() => void checkForUpdate()}
          >
            <RefreshCcw size={13} aria-hidden="true" />
            {t.updateNotice.retry}
          </button>
        </div>
      )}

      {(stage === "downloading" || stage === "installing") && (
        <div className="island-update-banner__progress">
          <div
            className="island-update-banner__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <span
              className="island-update-banner__fill"
              style={{ width: percent === null ? "28%" : `${percent}%` }}
            />
          </div>
          <span>{percent === null ? t.updateNotice.downloadingUnknown : `${percent}%`}</span>
        </div>
      )}
    </section>
  );
}