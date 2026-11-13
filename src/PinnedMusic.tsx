// 固定在桌面的「音乐」标签页：直接读系统媒体会话，不依赖主窗口状态。
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

type MediaState = {
  available: boolean;
  title: string;
  artist: string;
  album: string;
  playbackStatus: "playing" | "paused" | "none";
  positionMs: number;
  durationMs: number;
};

const EMPTY: MediaState = {
  available: false,
  title: "",
  artist: "",
  album: "",
  playbackStatus: "none",
  positionMs: 0,
  durationMs: 0,
};

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function PinnedMusic() {
  const [state, setState] = useState<MediaState>(EMPTY);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<Partial<MediaState>>("get_media_state", { target: undefined });
      setState({
        available: Boolean(next.available),
        title: next.title ?? "",
        artist: next.artist ?? "",
        album: next.album ?? "",
        playbackStatus: next.playbackStatus ?? "none",
        positionMs: next.positionMs ?? 0,
        durationMs: next.durationMs ?? 0,
      });
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const command = async (name: string) => {
    try {
      await invoke(name, { target: undefined });
      await refresh();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const playing = state.playbackStatus === "playing";
  const progress = state.durationMs > 0 ? Math.min(1, state.positionMs / state.durationMs) : 0;

  return (
    <div className="pinned-music">
      <div className="pinned-music__cover" aria-hidden="true">
        {playing ? "🎵" : "🎧"}
      </div>
      <strong className="pinned-music__title">{state.title || "没有在播放的音乐"}</strong>
      <span className="pinned-music__artist">
        {state.artist || (state.available ? "未知艺术家" : "在任意播放器里放首歌试试")}
      </span>

      <div className="pinned-music__progress" aria-hidden="true">
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <div className="pinned-music__time">
        <span>{formatTime(state.positionMs)}</span>
        <span>{state.durationMs ? formatTime(state.durationMs) : "--:--"}</span>
      </div>

      <div className="pinned-music__controls">
        <button type="button" onClick={() => void command("media_previous")} aria-label="上一首">
          <SkipBack size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pinned-music__play"
          onClick={() => void command("media_play_pause")}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => void command("media_next")} aria-label="下一首">
          <SkipForward size={17} aria-hidden="true" />
        </button>
      </div>

      {error && <p className="pinned-music__error">{error}</p>}
    </div>
  );
}