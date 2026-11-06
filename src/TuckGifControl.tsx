import { useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { ImagePlus, RotateCcw } from "lucide-react";
import { characterFramesForState, PET_CHARACTER_LABELS, usePetCharacter } from "./petCharacters";
import { saveTuckGifPath, useTuckGifPath } from "./tuckGif";
import "./TuckGifControl.css";

const MAX_GIF_BYTES = 8 * 1024 * 1024;

type CustomPetGif = { id: string; name: string; path: string };

/** 缩边 / 睡觉动画：默认跟随当前小狗形象，也可以换成自己的 GIF。 */
export function TuckGifControl() {
  const character = usePetCharacter();
  const tuckPath = useTuckGifPath();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fallback = characterFramesForState(character, "sleeping")[0] ?? "/assets/pets/rest.gif";
  let preview = fallback;
  if (tuckPath) {
    try {
      preview = convertFileSrc(tuckPath);
    } catch {
      preview = fallback;
    }
  }

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError("");
    if (!/\.gif$/i.test(file.name) && file.type !== "image/gif") {
      setError("只能选 GIF 文件。");
      return;
    }
    if (file.size > MAX_GIF_BYTES) {
      setError("GIF 不能超过 8 MB。");
      return;
    }
    if (!isTauri()) {
      setError("需要在桌面应用里选择文件。");
      return;
    }
    setBusy(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const asset = await invoke<CustomPetGif>("add_pet_gif", {
        state: "tuck",
        name: file.name,
        bytes,
      });
      saveTuckGifPath(asset.path);
    } catch (reason) {
      setError(`保存失败：${String(reason)}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="tuck-gif">
      <img className="tuck-gif__preview" src={preview} alt="" draggable={false} />
      <div className="tuck-gif__copy">
        <strong>趴下睡觉的 GIF</strong>
        <span>
          {tuckPath ? "自定义 GIF" : `跟随当前形象（${PET_CHARACTER_LABELS[character]}）`}
        </span>
        <small className="tuck-gif__hint">
          多久没动静自动趴下、缩到屏幕边缘、点「让小狗睡觉」都会用这张。
        </small>
      </div>
      <div className="tuck-gif__actions">
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
          <ImagePlus size={13} strokeWidth={1.8} />
          {busy ? "保存中…" : "选择 GIF"}
        </button>
        {tuckPath && (
          <button type="button" onClick={() => saveTuckGifPath("")}>
            <RotateCcw size={13} strokeWidth={1.8} />
            恢复默认
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/gif,.gif"
        hidden
        onChange={(event) => void pick(event.currentTarget.files)}
      />
      {error && <p className="tuck-gif__error">{error}</p>}
    </div>
  );
}
