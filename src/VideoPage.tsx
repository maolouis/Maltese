import { useState } from "react";
import { useTranslation } from "./i18n";
import { PluginsPanel } from "./PluginsPanel";
import { VideoAutomationPanel } from "./plugins/video/VideoAutomationPlugin";
import "./App.css";
export function VideoPage() {
  const [notice, setNotice] = useState("");
  const t = useTranslation();

  return (
    <section className="plugins-page" aria-label={t.plugins.title}>
      <div id="video-automation-plugin" className="plugin-video-card">
        <div className="plugin-video-card__head">
          <div>
            <span className="assistant-panel__label">{t.plugins.builtin}</span>
            <strong>自动刷视频</strong>
          </div>
        </div>
        <VideoAutomationPanel onNotice={setNotice} />
        {notice && <p className="video-page__notice" role="status">{notice}</p>}
      </div>
      <PluginsPanel />
    </section>
  );
}
