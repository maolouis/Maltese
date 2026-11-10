import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Music4, RotateCcw, Play } from "lucide-react";
import { loadCustomSoundPath, playCustomSound, saveCustomSoundPath } from "./customSound";
import "./CustomSoundControl.css";

const MAX_SOUND_BYTES = 2 * 1024 * 1024;

type CustomSound = { name: string; path: string };

/** 自定义音效：选择本地音频替换默认的合成叫声。 */
export function CustomSoundControl() {
  const [path, setPath] = useState(loadCustomSoundPath);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const update = () => setPath(loadCustomSoundPath());
    window.addEventListener("maltese-custom-sound-updated", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("maltese-custom-sound-updated", update);
      window.removeEventListener("storage", update);
    };
  }, []);

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError("");
    if (!/\.(wav|mp3|ogg|m4a)$/i.test(file.name)) {
      setError("只支持 wav / mp3 / ogg / m4a。");
      return;
    }
    if (file.size > MAX_SOUND_BYTES) {
      setError("音效文件不能超过 2 MB。");
      return;
    }
    if (!isTauri()) {
      setError("需要在桌面应用里选择文件。");
      return;
    }
    setBusy(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const asset = await invoke<CustomSound>("add_custom_sound", {
        name: file.name,
        bytes,
      });
      saveCustomSoundPath(asset.path);
      setPath(asset.path);
      setName(asset.name);
      playCustomSound(asset.path);
    } catch (reason) {
      setError(`保存失败：${String(reason)}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="custom-sound">
      <div className="custom-sound__copy">
        <strong>自定义音效</strong>
        <span>{path ? name || "已选择自定义音频" : "默认：内置合成叫声"}</span>
      </div>
      <div className="custom-sound__actions">
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Music4 size={13} strokeWidth={1.8} />
          {busy ? "保存中…" : "选择音频"}
        </button>
        {path && (
          <>
            <button type="button" onClick={() => playCustomSound(path)}>
              <Play size={13} strokeWidth={1.8} />
              试听
            </button>
            <button
              type="button"
              onClick={() => {
                saveCustomSoundPath("");
                setPath("");
                setName("");
              }}
            >
              <RotateCcw size={13} strokeWidth={1.8} />
              恢复默认
            </button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="audio/wav,audio/mpeg,audio/ogg,audio/mp4,.wav,.mp3,.ogg,.m4a"
        hidden
        onChange={(event) => void pick(event.currentTarget.files)}
      />
      {error && <p className="custom-sound__error">{error}</p>}
    </div>
  );
}
