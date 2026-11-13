// 插件窗口：每个插件在这里有自己的一页，不再挤在设置里的插件列表。
//
// 内置插件用宿主的 React 界面渲染；第三方插件如果清单里声明了 ui，
// 就直接把插件目录里的 html 装进 iframe，插件作者可以完全用自己的技术栈。
import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { VideoAutomationPanel } from "./video/VideoAutomationPlugin";
import { RelationshipPlugin } from "./relationship/RelationshipPlugin";
import "./PluginWindow.css";

type PluginPayload = {
  id: string;
  name: string;
  builtin: boolean;
  ui: string | null;
};

type PluginInfo = {
  id: string;
  name: string;
  builtin: boolean;
  ui: string | null;
};

function renderBuiltin(id: string, onNotice: (notice: string) => void) {
  if (id === "video-automation") {
    return <VideoAutomationPanel onNotice={onNotice} />;
  }
  if (id === "relationship") {
    return <RelationshipPlugin />;
  }
  return <p className="plugin-window__empty">这个内置插件还没有界面。</p>;
}

export function PluginWindow() {
  const [plugin, setPlugin] = useState<PluginPayload | null>(null);
  const [notice, setNotice] = useState("");

  const resolvePlugin = useCallback(async (id: string) => {
    try {
      const list = await invoke<{ plugins: PluginInfo[] }>("list_plugins");
      const found = list.plugins.find((item) => item.id === id);
      if (found) {
        setPlugin({
          id: found.id,
          name: found.name,
          builtin: found.builtin,
          ui: found.ui ?? null,
        });
      }
    } catch {
      // 列表读不到就保持当前内容，不让窗口变空。
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisten = listen<PluginPayload>("maltese-plugin-open", (event) => {
      if (disposed) return;
      setNotice("");
      setPlugin(event.payload);
    });
    // 窗口可能比 emit 晚一步创建，主动问一次当前该显示哪个插件。
    void invoke<string | null>("get_active_plugin")
      .then((id) => {
        if (id && !disposed) void resolvePlugin(id);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, [resolvePlugin]);

  const hide = () => {
    if (!isTauri()) return;
    void getCurrentWindow().hide();
  };

  return (
    <div className="plugin-window">
      <header className="plugin-window__head">
        <div className="plugin-window__title">
          <strong>{plugin?.name ?? "插件"}</strong>
          <span className="plugin-window__badge">{plugin?.builtin ? "内置" : "第三方"}</span>
        </div>
        <button type="button" className="plugin-window__close" onClick={hide}>
          收起
        </button>
      </header>
      <main className="plugin-window__body">
        {plugin ? (
          plugin.builtin ? (
            renderBuiltin(plugin.id, setNotice)
          ) : plugin.ui ? (
            <iframe
              className="plugin-window__frame"
              title={plugin.name}
              src={convertFileSrc(plugin.ui)}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            />
          ) : (
            <p className="plugin-window__empty">
              这个插件没有自带界面。可以在插件中心里运行它声明的动作。
            </p>
          )
        ) : (
          <p className="plugin-window__empty">正在加载插件…</p>
        )}
      </main>
      {notice && (
        <footer className="plugin-window__notice" role="status">
          {notice}
        </footer>
      )}
    </div>
  );
}
