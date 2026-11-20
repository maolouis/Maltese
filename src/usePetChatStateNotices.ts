import { useEffect, useRef, useState } from "react";
import { PET_CHARACTER_LABELS, type PetCharacterId } from "./petCharacters";
import { loadVitalsSummary } from "./petContext";
import {
  detectThresholdCross,
  shouldShowNotice,
  STATE_NOTICE_AT_KEY,
} from "./petStateBarLogic";

export function usePetChatStateNotices(character: PetCharacterId): string[] {
  const [notices, setNotices] = useState<string[]>([]);
  const previousVitalsRef = useRef(loadVitalsSummary());
  const [noticeAtInitial] = useState<number>(() => {
    try {
      const raw = Number(window.localStorage.getItem(STATE_NOTICE_AT_KEY));
      return Number.isFinite(raw) ? raw : 0;
    } catch {
      return 0;
    }
  });
  const lastNoticeAtRef = useRef(noticeAtInitial);

  useEffect(() => {
    const refresh = () => {
      const next = loadVitalsSummary();
      const cross = detectThresholdCross(
        previousVitalsRef.current,
        next,
        PET_CHARACTER_LABELS[character] ?? "小狗",
      );
      previousVitalsRef.current = next;
      if (!cross) return;
      const now = Date.now();
      if (!shouldShowNotice(lastNoticeAtRef.current, now)) return;
      lastNoticeAtRef.current = now;
      try {
        window.localStorage.setItem(STATE_NOTICE_AT_KEY, String(now));
      } catch {
        // 忽略
      }
      setNotices((current) => [...current.slice(-2), cross.text]);
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("maltese-pet-vitals-changed", refresh);
    const timer = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("maltese-pet-vitals-changed", refresh);
      window.clearInterval(timer);
    };
  }, [character]);

  return notices;
}
