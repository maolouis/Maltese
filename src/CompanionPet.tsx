import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useTranslation } from "./i18n";
import {
  acceptLinkMessage,
  createLinkReceiverState,
  getPetLinkBus,
  linkStateForAction,
  PET_LINK_ACTION_MS,
  PET_LINK_BUBBLE_MS,
  PET_LINK_SHIFT_MAX_PX,
  PET_LINK_SHIFT_MIN_PX,
  readPetLinkageEnabled,
} from "./petLinkBus";
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
// 收到主狗的联动事件（L1 情绪传染）时临时播对应动作 + 偶尔冒一句小气泡。
export default function CompanionPet() {
  const t = useTranslation();
  const label = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "companion-1";
    }
  }, []);
  const [look, setLook] = useState<PetLook>(readLook);
  const character = usePetCharacter();
  const gifRotationConfig = usePetGifRotationConfig(character);
  const gifRotationStates = usePetGifRotationStates();
  const idleFrames = useMemo(
    () => rotationFramesForState(gifRotationConfig, "idle", gifRotationStates, character),
    [character, gifRotationConfig, gifRotationStates],
  );
  const [reactionState, setReactionState] = useState<string | null>(null);
  const idleSrc = usePetGifRotation(idleFrames, { intervalMs: 11_000, enabled: !reactionState });
  const reactionFrames = useMemo(
    () =>
      reactionState
        ? rotationFramesForState(gifRotationConfig, reactionState, gifRotationStates, character)
        : [],
    [character, gifRotationConfig, gifRotationStates, reactionState],
  );
  const reactionSrc = usePetGifRotation(reactionFrames, {
    intervalMs: 900,
    enabled: Boolean(reactionState),
  });
  const [bubble, setBubble] = useState("");
  /** 联动位移：朝主狗方向挪 8–16px 后回位。 */
  const [shift, setShift] = useState<{ x: number; y: number } | null>(null);
  const [squash, setSquash] = useState(false);
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const selfPosRef = useRef<{ x: number; y: number } | null>(null);
  const reactionTimer = useRef<number | null>(null);
  const shiftTimer = useRef<number | null>(null);
  const bubbleTimer = useRef<number | null>(null);
  const receiverRef = useRef(createLinkReceiverState());
  const lines = t.petLink.companionLines;

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

  // 联动接收：只播动作、不转发（回声环由 petLinkBus 的 source/seq 拦住）。
  // 先记住自己的屏幕位置，用于「朝主狗方向」的位移；2s 刷新一次。
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const read = () => {
      void getCurrentWindow()
        .outerPosition()
        .then((pos) => {
          if (!cancelled) selfPosRef.current = { x: pos.x, y: pos.y };
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  /** 主狗相对自己的方向 → 8–16px 位移（无位置信息时朝上，保证看得见）。 */
  const shiftToward = (origin?: { x: number; y: number }): { x: number; y: number } => {
    const self = selfPosRef.current;
    if (!origin) return { x: 0, y: -PET_LINK_SHIFT_MIN_PX };
    const dx = origin.x - (self?.x ?? 0);
    const dy = origin.y - (self?.y ?? 0);
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 1) return { x: 0, y: -PET_LINK_SHIFT_MIN_PX };
    const distance = Math.max(PET_LINK_SHIFT_MIN_PX, Math.min(PET_LINK_SHIFT_MAX_PX, 12));
    return {
      x: Math.round((dx / length) * distance),
      y: Math.round((dy / length) * distance),
    };
  };

  useEffect(() => {
    const bus = getPetLinkBus(label);
    return bus.subscribe((message) => {
      const result = acceptLinkMessage(message, receiverRef.current, {
        self: label,
        now: Date.now(),
        enabled: readPetLinkageEnabled(),
      });
      if (!result.accept || message.kind !== "action") return;
      window.setTimeout(() => {
        setReactionState(linkStateForAction(message.action));
        // 位移反馈：朝主狗方向挪 8–16px，CSS transition 回位。
        setShift(shiftToward(message.origin));
        if (shiftTimer.current !== null) window.clearTimeout(shiftTimer.current);
        shiftTimer.current = window.setTimeout(() => {
          shiftTimer.current = null;
          setShift(null);
        }, PET_LINK_ACTION_MS);
        if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
        reactionTimer.current = window.setTimeout(() => {
          reactionTimer.current = null;
          setReactionState(null);
        }, PET_LINK_ACTION_MS);
        if (result.bubble && lines.length > 0) {
          setBubble(lines[Math.floor(Math.random() * lines.length)] ?? lines[0]);
          if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
          bubbleTimer.current = window.setTimeout(() => {
            bubbleTimer.current = null;
            setBubble("");
          }, PET_LINK_BUBBLE_MS);
        }
      }, result.delayMs);
    });
  }, [label, lines]);

  useEffect(
    () => () => {
      if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current);
    },
    [],
  );

  const pet = useCallback(() => {
    setSquash(true);
    window.setTimeout(() => setSquash(false), 240);
    // 陪玩狗被摸：照旧通知主狗播摸摸；这不是联动事件，不会被再转发。
    void emit("maltese-pet-action", { action: "pet" });
  }, []);

  const gifSrc = reactionState ? reactionSrc : idleSrc;

  return (
    <div
      className={`companion-pet${squash ? " companion-pet--squash" : ""}${reactionState ? " companion-pet--reacting" : ""}${shift ? " companion-pet--shifted" : ""}`}
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
      {bubble && (
        <div className="companion-pet__bubble" role="status" aria-live="polite">
          {bubble}
        </div>
      )}
      <img
        src={gifSrc}
        alt=""
        draggable={false}
        style={{
          width: `${112 * look.scale}px`,
          height: `${112 * look.scale}px`,
          opacity: look.opacity,
          // 联动位移：朝主狗方向挪一下再回位（CSS transition 负责平滑）。
          transform: shift ? `translate(${shift.x}px, ${shift.y}px)` : undefined,
          transition: "transform 260ms cubic-bezier(0.22, 1.2, 0.36, 1)",
        }}
      />
    </div>
  );
}