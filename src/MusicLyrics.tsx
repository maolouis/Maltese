import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
export function parseLrc(lrc: string) {
  const lines: Array<{ time: number; text: string }> = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const match = raw.match(/^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!match) continue;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    const fraction = match[3] ? Number(match[3].padEnd(3, "0")) : 0;
    const text = match[4].trim();
    if (!text) continue;
    lines.push({ time: minutes * 60_000 + seconds * 1000 + fraction, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 歌词：按当前播放进度高亮并自动滚动到中间行。
type LyricLine = { time: number; text: string };
export type LyricsState = {
  lines: LyricLine[];
  status: "idle" | "loading" | "error" | "empty";
  activeIndex: number;
  activeText: string | null;
};

// 只在能拿到播放进度（系统媒体会话）时取歌词，避免出现「无法调用」的歌词面板。
export function useLyrics(
  title: string | null,
  artist: string | null,
  positionMs: number,
  enabled: boolean,
): LyricsState {
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "empty">("idle");

  useEffect(() => {
    if (!enabled || !title || !isTauri()) {
      setLines([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    void invoke<{ lrc: string; songTitle: string }>("fetch_lyrics", { title, artist })
      .then((result) => {
        if (cancelled) return;
        const parsed = parseLrc(result.lrc).map((line) => ({ time: line.time, text: line.text }));
        setLines(parsed);
        setStatus(parsed.length ? "idle" : "empty");
      })
      .catch(() => {
        if (cancelled) return;
        setLines([]);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [artist, enabled, title]);

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].time <= positionMs) index = i;
      else break;
    }
    return index;
  }, [lines, positionMs]);

  return {
    lines,
    status,
    activeIndex,
    activeText: activeIndex >= 0 ? lines[activeIndex]?.text ?? null : null,
  };
}

export function MusicLyrics({ lyrics }: { lyrics: LyricsState }) {
  const activeRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [lyrics.activeIndex]);

  if (lyrics.lines.length === 0) {
    return null;
  }

  return (
    <div className="music-lyrics" aria-label="歌词">
      {lyrics.lines.map((line, index) => (
        <p
          key={`${line.time}-${index}`}
          ref={index === lyrics.activeIndex ? activeRef : undefined}
          className={`music-lyrics__line${index === lyrics.activeIndex ? " music-lyrics__line--active" : ""}`}
        >
          {line.text}
        </p>
      ))}
    </div>
  );
}




