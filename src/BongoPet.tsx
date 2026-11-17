import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  acceptLinkMessage,
  createLinkReceiverState,
  getPetLinkBus,
  readPetLinkageEnabled,
} from "./petLinkBus";
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
/** 主狗开心/庆祝时 Bongo 的敲击反馈时长（设计文档 L2：约 600ms）。 */
const HIT_MS = 600;

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
// 外加 L2 呼应：主狗开心/庆祝 → Bongo 敲一下；Bongo 敲空格 → 主狗摇尾巴。
export default function BongoPet() {
  const label = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "bongo-pet";
    }
  }, []);
  const [look, setLook] = useState<BongoLook>(readLook);
  const [frameMap, setFrameMap] = useState<BongoMap | null>(null);
  const [pressed, setPressed] = useState<string[]>([]);
  const [hit, setHit] = useState(false);
  const lookRef = useRef(look);
  lookRef.current = look;
  const receiverRef = useRef(createLinkReceiverState());
  const hitTimer = useRef<number | null>(null);
  const prevSpaceRef = useRef(false);

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

  // L2 正向：主狗 happy/celebrate → 敲一下（只在本窗口可见且联动开着时）。
  useEffect(() => {
    const bus = getPetLinkBus(label);
    return bus.subscribe((message) => {
      if (message.kind !== "action") return;
      if (message.action !== "happy" && message.action !== "celebrate") return;
      if (!lookRef.current.enabled) return;
      const result = acceptLinkMessage(message, receiverRef.current, {
        self: label,
        now: Date.now(),
        enabled: readPetLinkageEnabled(),
      });
      if (!result.accept) return;
      window.setTimeout(() => {
        setHit(true);
        if (hitTimer.current !== null) window.clearTimeout(hitTimer.current);
        hitTimer.current = window.setTimeout(() => {
          hitTimer.current = null;
          setHit(false);
        }, HIT_MS);
      }, result.delayMs);
    });
  }, [label]);

  // L2 反向：空格按下沿（50ms 轮询会重复，所以做边沿检测）→ 通知主狗摇尾巴。
  useEffect(() => {
    const down = pressed.includes("space");
    if (down && !prevSpaceRef.current && look.enabled && readPetLinkageEnabled()) {
      getPetLinkBus(label).emitBongoHit();
    }
    prevSpaceRef.current = down;
  }, [label, look.enabled, pressed]);

  useEffect(
    () => () => {
      if (hitTimer.current !== null) window.clearTimeout(hitTimer.current);
    },
    [],
  );

  const keyToFrame = useMemo(() => {
    const map = new Map<string, string>();
    for (const [file, keys] of Object.entries(frameMap?.frames ?? {})) {
      for (const key of keys) map.set(key, file);
    }
    return map;
  }, [frameMap]);

  const frame = useMemo(() => {
    if (!frameMap) return "idle.png";
    if (hit) return keyToFrame.get("space") ?? frameMap.idle;
    if (pressed.includes("space")) {
      return keyToFrame.get("space") ?? frameMap.idle;
    }
    for (const key of pressed) {
      const file = keyToFrame.get(key);
      if (file) return file;
    }
    return frameMap.idle;
  }, [frameMap, hit, keyToFrame, pressed]);

  return (
    <div
      className={`bongo-pet${hit ? " bongo-pet--hit" : ""}`}
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