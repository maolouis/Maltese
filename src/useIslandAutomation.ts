import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type FullscreenAvoidMode = "tuck" | "hide" | "off";

// 全屏避让：前台出现全屏窗口（游戏/视频）时，把小狗缩到屏幕边缘或临时隐藏，
// 全屏结束后恢复原状。只处理收缩态，展开面板时不打扰。
export function useFullscreenAvoid(
  behavior: FullscreenAvoidMode,
  active: boolean,
  isTucked: boolean,
  isTauri: boolean,
  onTuck: () => void,
  onReveal: () => void,
  hideExtras = true,
) {
  // Bongo / 陪伴狗 / 跟随小狗也要跟着全屏避让，否则主狗藏起来了它们还在桌上。
  const hideExtraPets = (hidden: boolean) => {
    if (!isTauri) return;
    void invoke("set_extra_pets_hidden", { hidden }).catch(() => undefined);
  };
  const appliedRef = useRef<FullscreenAvoidMode | null>(null);
  const wasTuckedRef = useRef(false);
  // 用 ref 跟踪最新的 isTucked，避免 isTucked 变化导致 effect 反复重建、
  // 清理函数误把全屏避让的缩边状态还原（会产生缩边/展开抖动）。
  const isTuckedRef = useRef(isTucked);
  isTuckedRef.current = isTucked;

  useEffect(() => {
    if (!isTauri || behavior === "off" || !active) {
      return;
    }
    let disposed = false;

    const restore = async (applied: FullscreenAvoidMode) => {
      if (applied === "hide") {
        await invoke("show_island_no_focus").catch(() => undefined);
      } else if (!wasTuckedRef.current) {
        onReveal();
      }
    };

    const check = async () => {
      let fullscreen = false;
      try {
        fullscreen = await invoke<boolean>("is_foreground_fullscreen");
      } catch {
        return;
      }
      if (disposed) {
        return;
      }
      if (fullscreen && appliedRef.current === null) {
        appliedRef.current = behavior;
        wasTuckedRef.current = isTuckedRef.current;
        if (behavior === "hide") {
          await invoke("minimize_island").catch(() => undefined);
        } else if (!isTuckedRef.current) {
          onTuck();
        }
        if (hideExtras) {
          hideExtraPets(true);
        }
      } else if (!fullscreen && appliedRef.current !== null) {
        const applied = appliedRef.current;
        appliedRef.current = null;
        if (hideExtras) {
          hideExtraPets(false);
        }
        await restore(applied);
      }
    };

    const timer = window.setInterval(() => {
      void check();
    }, 2500);
    void check();

    return () => {
      disposed = true;
      window.clearInterval(timer);
      const applied = appliedRef.current;
      appliedRef.current = null;
      if (applied !== null) {
        void restore(applied);
      }
    };
  }, [active, behavior, isTauri, onReveal, onTuck]);
}

export function useTodoRotation(
  todoIds: string[],
  activeTodoId: string | null,
  enabled: boolean,
  seconds: number,
  paused: boolean,
) {
  const [rotatingId, setRotatingId] = useState<string | null>(activeTodoId);
  const displayedId = rotatingId && todoIds.includes(rotatingId)
    ? rotatingId
    : activeTodoId && todoIds.includes(activeTodoId)
      ? activeTodoId
      : todoIds[0] ?? null;

  useEffect(() => {
    setRotatingId(activeTodoId);
  }, [activeTodoId, enabled]);

  useEffect(() => {
    if (!enabled || paused || todoIds.length < 2) return;
    const timer = window.setTimeout(() => {
      const index = displayedId ? todoIds.indexOf(displayedId) : -1;
      setRotatingId(todoIds[(index + 1) % todoIds.length]);
    }, seconds * 1_000);
    return () => window.clearTimeout(timer);
  }, [displayedId, enabled, paused, seconds, todoIds]);

  return enabled ? displayedId : activeTodoId;
}

export function useIdleTuck(
  enabled: boolean,
  seconds: number,
  isTucked: boolean,
  view: string,
  onTuck: () => void,
) {
  useEffect(() => {
    if (!enabled || isTucked) return;
    let timer: number | undefined;
    let pointerDown = false;
    let composing = false;
    const reset = () => {
      window.clearTimeout(timer);
      if (!pointerDown && !composing && !document.hidden) {
        timer = window.setTimeout(onTuck, seconds * 1_000);
      }
    };
    const startPointer = () => { pointerDown = true; reset(); };
    const endPointer = () => { pointerDown = false; reset(); };
    const startComposition = () => { composing = true; reset(); };
    const endComposition = () => { composing = false; reset(); };
    const blur = () => { pointerDown = false; composing = false; reset(); };
    const events = ["pointermove", "keydown", "wheel", "input", "focusin", "focus", "visibilitychange"];
    events.forEach((event) => window.addEventListener(event, reset, true));
    window.addEventListener("pointerdown", startPointer, true);
    window.addEventListener("pointerup", endPointer, true);
    window.addEventListener("pointercancel", endPointer, true);
    window.addEventListener("compositionstart", startComposition, true);
    window.addEventListener("compositionend", endComposition, true);
    window.addEventListener("blur", blur);
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset, true));
      window.removeEventListener("pointerdown", startPointer, true);
      window.removeEventListener("pointerup", endPointer, true);
      window.removeEventListener("pointercancel", endPointer, true);
      window.removeEventListener("compositionstart", startComposition, true);
      window.removeEventListener("compositionend", endComposition, true);
      window.removeEventListener("blur", blur);
    };
  }, [enabled, isTucked, onTuck, seconds, view]);
}
