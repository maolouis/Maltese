import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, CheckCheck, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  defaultPetGifItems,
  petGifItemSrc,
  savePetGifRotationConfig,
  usePetGifRotationConfig,
  type PetGifRotationItem,
} from "./petGifRotation";
import "./PetGifRotationSettings.css";

type CustomPetGif = {
  id: string;
  name: string;
  path: string;
};

const MAX_GIF_BYTES = 8 * 1024 * 1024;

export function PetGifRotationSettings() {
  const t = useTranslation();
  const config = usePetGifRotationConfig();
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = config[state] ?? [];
  const states = Object.keys(t.petGifs.states);
  const availableItems = defaultPetGifItems(state);
  const selectedKeys = new Set(items.map((item) => item.path ?? item.src).filter(Boolean));
  const missingItems = availableItems.filter((item) => !selectedKeys.has(item.src));

  const saveItems = (nextItems: PetGifRotationItem[]) => {
    savePetGifRotationConfig({ ...config, [state]: nextItems });
  };

  const selectAll = () => {
    if (missingItems.length === 0) return;
    saveItems([...items, ...missingItems]);
  };

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    saveItems(next);
  };

  const remove = async (item: PetGifRotationItem) => {
    setError("");
    try {
      if (item.custom && item.path && isTauri()) {
        await invoke("remove_pet_gif", { path: item.path });
      }
      saveItems(items.filter((entry) => entry.id !== item.id));
    } catch (reason) {
      setError(`${t.petGifs.deleteFailed}${String(reason)}`);
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError("");
    setBusy(true);
    const added: PetGifRotationItem[] = [];
    try {
      for (const file of Array.from(files)) {
        if (!/\.gif$/i.test(file.name) && file.type !== "image/gif") {
          setError(t.petGifs.notGif);
          continue;
        }
        if (file.size > MAX_GIF_BYTES) {
          setError(t.petGifs.tooLarge);
          continue;
        }
        if (!isTauri()) {
          setError(t.petGifs.addFailed + "Tauri");
          continue;
        }
        const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
        const asset = await invoke<CustomPetGif>("add_pet_gif", {
          state,
          name: file.name,
          bytes,
        });
        added.push({
          id: asset.id,
          path: asset.path,
          name: asset.name,
          custom: true,
        });
      }
      if (added.length > 0) {
        saveItems([...items, ...added]);
      }
    } catch (reason) {
      setError(`${t.petGifs.addFailed}${String(reason)}`);
      if (added.length > 0) {
        saveItems([...items, ...added]);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <section className="sw-card pet-gif-settings">
      <div className="pet-gif-settings__head">
        <div>
          <h2>{t.petGifs.title}</h2>
          <p className="pet-gif-settings__subtitle">{t.petGifs.subtitle}</p>
        </div>
        <label className="pet-gif-settings__expression">
          <span>{t.petGifs.expression}</span>
          <select value={state} onChange={(event) => setState(event.target.value)}>
            {states.map((value) => (
              <option key={value} value={value}>
                {t.petGifs.states[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="pet-gif-settings__toolbar">
        <span>{t.petGifs.count(items.length)}</span>
        <span className="pet-gif-settings__toolbar-hint">{t.petGifs.reorderHint}</span>
        <button
          type="button"
          className="sw-secondary"
          disabled={missingItems.length === 0}
          title={missingItems.length === 0 ? t.petGifs.allSelected : t.petGifs.selectAllHint}
          onClick={selectAll}
        >
          <CheckCheck size={13} />
          {t.petGifs.selectAll}
        </button>
        <button
          type="button"
          className="sw-secondary"
          onClick={() => saveItems(defaultPetGifItems(state))}
        >
          <RotateCcw size={13} />
          {t.petGifs.reset}
        </button>
      </div>

      {error && <p className="pet-gif-settings__error">{error}</p>}

      {items.length === 0 ? (
        <p className="pet-gif-settings__empty">{t.petGifs.empty}</p>
      ) : (
        <div className="pet-gif-settings__list">
          {items.map((item, index) => (
            <article className="pet-gif-item" key={item.id}>
              <span className="pet-gif-item__order" aria-label={t.petGifs.order(index + 1)}>
                {index + 1}
              </span>
              <img
                className="pet-gif-item__preview"
                src={petGifItemSrc(item)}
                alt=""
                loading="lazy"
                draggable={false}
              />
              <div className="pet-gif-item__copy">
                <strong title={item.name}>{item.name}</strong>
                <span>{item.custom ? t.petGifs.custom : t.petGifs.builtin}</span>
                <code
                  className="pet-gif-item__path"
                  title={item.path ?? item.src}
                  aria-label={`${t.petGifs.pathLabel}: ${item.path ?? item.src}`}
                >
                  {item.path ?? item.src}
                </code>
              </div>
              <div className="pet-gif-item__actions">
                <button
                  type="button"
                  className="pet-gif-item__button"
                  aria-label={t.petGifs.moveUp}
                  title={t.petGifs.moveUp}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="pet-gif-item__button"
                  aria-label={t.petGifs.moveDown}
                  title={t.petGifs.moveDown}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="pet-gif-item__button pet-gif-item__button--danger"
                  aria-label={t.petGifs.delete}
                  title={t.petGifs.delete}
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="pet-gif-settings__add">
        <button
          type="button"
          className="sw-secondary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <Plus size={14} />
          {t.petGifs.add}
        </button>
        <span>{t.petGifs.addHint}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/gif,.gif"
          multiple
          hidden
          onChange={(event) => void addFiles(event.target.files)}
        />
      </div>
    </section>
  );
}