import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TranslationWindow from "./TranslationWindow";
import PetBubble from "./PetBubble";
import SettingsWindow from "./SettingsWindow";
import CompanionPet from "./CompanionPet";
import CursorPet from "./CursorPet";
import BongoPet from "./BongoPet";
import Billiards from "./Billiards";
import PinnedPanel from "./PinnedPanel";
import { PluginWindow } from "./plugins/PluginWindow";
import { I18nProvider } from "./i18n";
import { initPetAssetBase } from "./petAssetBase";

const windowKind = new URLSearchParams(window.location.search).get("window");
const RootComponent =
  windowKind === "translation"
    ? TranslationWindow
    : windowKind === "bubble"
      ? PetBubble
      : windowKind === "settings"
        ? SettingsWindow
        : windowKind === "companion"
          ? CompanionPet
          : windowKind === "cursor"
            ? CursorPet
            : windowKind === "bongo"
              ? BongoPet
              : windowKind === "billiards"
                ? Billiards
                : windowKind === "pinned"
                  ? PinnedPanel
                  : windowKind === "plugin"
                    ? PluginWindow
                    : App;

window.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.inputModality = "pointer";
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Tab") {
      document.documentElement.dataset.inputModality = "keyboard";
    }
  },
  true,
);

// 主窗口 / 设置窗口关掉了 Tauri 的原生拖放处理器（`dragDropEnabled: false`，见
// `src-tauri/tauri.conf.json` 与 `window_factory.rs`），网页里的拖放才归前端管。
// 代价是 WebView2 会把「从资源管理器把文件拖进窗口」当成浏览器默认行为：直接导航到
// file:// 地址把窗口变成白页。本项目没有文件拖入功能，这里全局拦掉默认导航；
// 表情方格墙的排序用 Pointer Events 实现，不依赖这些事件。
const preventFileDropNavigation = (event: DragEvent) => {
  event.preventDefault();
};
window.addEventListener("dragover", preventFileDropNavigation, false);
window.addEventListener("drop", preventFileDropNavigation, false);

// 素材已外置到安装目录：渲染前先拿到资源目录，避免首帧图片 404。
void initPetAssetBase().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider>
        <RootComponent />
      </I18nProvider>
    </React.StrictMode>,
  );
});
