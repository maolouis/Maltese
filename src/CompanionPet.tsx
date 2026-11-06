import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import {
  rotationFramesForState,
  usePetGifRotationConfig,
  usePetGifRotationStates,
} from "./petGifRotation";
import { usePetGifRotation } from "./usePetGifRotation";
import { usePetCharacter } from "./petCharacters";
import "./DesktopExtras.css";

type PetLook = {
  scale: number;
  opacity: number;
};

const SETTINGS_KEY = "focusd-island-settings";

function readLook(): PetLook {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const scale = Number(parsed.collapsedScale);
    const opacity = Number(parsed.petOpacity);
    return {
      scale: Number.isFinite(scale) ? Math.min(1.8, Math.max(0.5, scale)) : 0.89,
      opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(30, opacity)) / 100 : 1,
    };
  } catch {
    return { scale: 0.89, opacity: 1 };
  }
}

// 陪玩狗：独立透明窗口里的一只小狗，可拖动、可摸头。
export default function CompanionPet() {
  const [look, setLook] = useState<PetLook>(readLook);
  const character = usePetCharacter();
  const gifRotationConfig = usePetGifRotationConfig(character);
  const gifRotationStates = usePetGifRotationStates();
  const gifSrc = usePetGifRotation(
    rotationFramesForState(gifRotationConfig, "idle", gifRotationStates, character),
    { intervalMs: 11_000 },
  );
  const [squash, setSquash] = useState(false);
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  useEffect(() => {
    const update = () => setLook(readLook());
    window.addEventListener("storage", update);
    let unlisten: (() => void) | null = null;
    if (isTauri()) {
      void listen("maltese-settings-updated", update).then((cleanup) => {
        unlisten = cleanup;
      });
    }
    return () => {
      window.removeEventListener("storage", update);
      unlisten?.();
    };
  }, []);

  const pet = useCallback(() => {
    setSquash(true);
    window.setTimeout(() => setSquash(false), 240);
    void emit("maltese-pet-action", { action: "pet" });
  }, []);

  return (
    <div
      className={`companion-pet${squash ? " companion-pet--squash" : ""}`}
      role="button"
      tabIndex={0}
      aria-label="陪玩小狗"
      title="摸摸头；拖动可以换位置"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pressRef.current = { x: event.clientX, y: event.clientY, dragging: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const press = pressRef.current;
        if (!press || press.dragging) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6) return;
        press.dragging = true;
        void getCurrentWindow().startDragging().catch(() => undefined);
      }}
      onPointerUp={() => {
        const press = pressRef.current;
        pressRef.current = null;
        if (press && !press.dragging) pet();
      }}
      onPointerCancel={() => {
        pressRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pet();
        }
      }}
    >
      <img
        src={gifSrc}
        alt=""
        draggable={false}
        style={{
          width: `${112 * look.scale}px`,
          height: `${112 * look.scale}px`,
          opacity: look.opacity,
        }}
      />
    </div>
  );
}