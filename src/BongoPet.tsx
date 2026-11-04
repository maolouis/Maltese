import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./DesktopExtras.css";

type BongoMap = {
  idle: string;
  frames: Record<string, string[]>;
};

type BongoLook = {
  enabled: boolean;
  opacity: number;
  mirror: boolean;
  clickThrough: boolean;
};

const SETTINGS_KEY = "focusd-island-settings";

function readLook(): BongoLook {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const opacity = Number(parsed.bongoOpacity);
    return {
      enabled: parsed.bongoEnabled === true,
      opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(30, opacity)) / 100 : 1,
      mirror: parsed.bongoMirror !== false,
      clickThrough: parsed.bongoClickThrough === true,
    };
  } catch {
    return { enabled: false, opacity: 1, mirror: true, clickThrough: false };
  }
}

// Bongo 模式：小狗趴在键盘上，按下的键会切到对应“爪子落点”的帧。
export default function BongoPet() {
  const [look, setLook] = useState<BongoLook>(readLook);
  const [frameMap, setFrameMap] = useState<BongoMap | null>(null);
  const [pressed, setPressed] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/assets/bongo/bongo_frames.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: BongoMap | null) => {
        if (!cancelled && data && data.idle && data.frames) setFrameMap(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const update = () => setLook(readLook());
    window.addEventListener("storage", update);
    const timer = window.setInterval(update, 800);
    let unlisten: (() => void) | null = null;
    if (isTauri()) {
      void listen("maltese-settings-updated", update).then((cleanup) => {
        unlisten = cleanup;
      });
    }
    return () => {
      window.removeEventListener("storage", update);
      window.clearInterval(timer);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !look.enabled) return;
    let disposed = false;
    let busy = false;
    const tick = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        const keys = await invoke<string[]>("get_pressed_keys");
        if (!disposed) setPressed(keys);
      } catch {
        // 忽略轮询失败
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 50);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [look.enabled]);

  const keyToFrame = useMemo(() => {
    const map = new Map<string, string>();
    for (const [file, keys] of Object.entries(frameMap?.frames ?? {})) {
      for (const key of keys) map.set(key, file);
    }
    return map;
  }, [frameMap]);

  const frame = useMemo(() => {
    if (!frameMap) return "idle.png";
    if (pressed.includes("space")) {
      return keyToFrame.get("space") ?? frameMap.idle;
    }
    for (const key of pressed) {
      const file = keyToFrame.get(key);
      if (file) return file;
    }
    return frameMap.idle;
  }, [frameMap, keyToFrame, pressed]);

  return (
    <div
      className="bongo-pet"
      title={look.clickThrough ? "" : "拖动可以换位置"}
      onPointerDown={(event) => {
        if (look.clickThrough || event.button !== 0) return;
        void getCurrentWindow().startDragging().catch(() => undefined);
      }}
    >
      <img
        src={`/assets/bongo/${frame}`}
        alt=""
        draggable={false}
        style={{
          opacity: look.opacity,
          transform: look.mirror ? "scaleX(-1)" : undefined,
        }}
      />
    </div>
  );
}