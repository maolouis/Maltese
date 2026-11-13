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
