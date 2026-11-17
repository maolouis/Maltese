import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CheckCheck, ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  defaultPetGifItems,
  petGifFileName,
  petGifItemSrc,
  savePetGifRotationConfig,
  savePetGifRotationStates,
  usePetGifRotationConfig,
  usePetGifRotationStates,
  type PetGifRotationItem,
} from "./petGifRotation";
import { characterAllFrames, characterFramesForState, PET_CHARACTER_LABELS, usePetCharacter } from "./petCharacters";
import "./PetGifRotationSettings.css";

type CustomPetGif = {
  id: string;
  name: string;
  path: string;
};

const MAX_GIF_BYTES = 8 * 1024 * 1024;
/** 删除等操作的状态提示保留时长。 */
const NOTICE_MS = 2400;

export function PetGifRotationSettings() {
  const t = useTranslation();
  const character = usePetCharacter();
  const config = usePetGifRotationConfig(character);
  const rotationStates = usePetGifRotationStates();
  // GIF 列表很长，默认收起；展开状态记住，下次进来保持。
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("maltese-gif-settings-expanded") === "on";
    } catch {
      return false;
    }
  });
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // 拖拽排序：dragIndex 是被拖的格子，dropIndex 是当前悬停的目标格子。
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<number | null>(null);

  const items = config[state] ?? [];
  const states = Object.keys(t.petGifs.states);
  const availableItems: PetGifRotationItem[] = characterAllFrames(character, state).map((src) => ({
    id: src,
    src,
    name: petGifFileName(src),
    custom: false,
  }));
  const selectedKeys = new Set(items.map((item) => item.path ?? item.src).filter(Boolean));
  const missingItems = availableItems.filter((item) => !selectedKeys.has(item.src));

  // 轮播范围里实际会轮到的全部 GIF（按勾选状态合并，和主窗口的合并规则一致），
  // 让用户一眼看到「点了全选之后到底轮哪些图」，而不是只看到当前表情那一列。
  const scopeFrames = useMemo(() => {
    const seen = new Set<string>();
    const merged: Array<{ src: string; state: string; name: string }> = [];
    for (const key of rotationStates) {
      const configured = (config[key] ?? []).map(petGifItemSrc).filter(Boolean);
      const list = configured.length > 0 ? configured : characterFramesForState(character, key);
      for (const src of list) {
        if (!src || seen.has(src)) continue;
        seen.add(src);
        merged.push({ src, state: key, name: petGifFileName(src) });
      }
    }
    return merged;
  }, [character, config, rotationStates]);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // 切换表情时清掉上一列的拖拽残留，避免高亮/序号错位。
  useEffect(() => {
    setDragIndex(null);
    setDropIndex(null);
  }, [state]);

  const flashNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
  };

  const resetDrag = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  const saveItems = (nextItems: PetGifRotationItem[]) => {
    savePetGifRotationConfig({ ...config, [state]: nextItems }, character);
  };

  const selectAll = () => {
    if (missingItems.length === 0) return;
    saveItems([...items, ...missingItems]);
  };

  const toggleRotationState = (key: string) => {
    const next = rotationStates.includes(key)
      ? rotationStates.filter((value) => value !== key)
      : [...rotationStates, key];
    savePetGifRotationStates(next);
  };

  // 拖动排序：把 from 处的格子取出，插到 to 处（to 为落点格子的当前位置）。
  // 复用 saveItems → savePetGifRotationConfig 写回配置，主窗口会通过 storage 事件同步。
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= items.length || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    saveItems(next);
  };

  const remove = async (item: PetGifRotationItem) => {
    setError("");
    try {
      if (item.custom && item.path && isTauri()) {
        await invoke("remove_pet_gif", { path: item.path });
      }
      saveItems(items.filter((entry) => entry.id !== item.id));
      resetDrag();
      flashNotice(t.petGifs.deleted(1));
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
          <p className="pet-gif-settings__subtitle">
            {t.petGifs.subtitle} · 当前形象：{PET_CHARACTER_LABELS[character]}
          </p>
        </div>
        <div className="pet-gif-settings__head-actions">
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
          <button
            type="button"
            className={`sw-secondary pet-gif-settings__toggle${expanded ? " is-open" : ""}`}
            aria-expanded={expanded}
            onClick={() => {
              const next = !expanded;
              setExpanded(next);
              try {
                window.localStorage.setItem("maltese-gif-settings-expanded", next ? "on" : "off");
              } catch {
                // 忽略
              }
            }}
          >
            <ChevronDown size={14} className="pet-gif-settings__chevron" />
            {expanded ? "收起" : `展开（${items.length} 张）`}
          </button>
        </div>
      </div>

      {expanded && (
        <>
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
            onClick={() => saveItems(defaultPetGifItems(state, character))}
          >
            <RotateCcw size={13} />
            {t.petGifs.reset}
          </button>
        </div>
  
        <div className="pet-gif-settings__scope">
          <div className="pet-gif-settings__scope-head">
            <span>{t.petGifs.rotationScope}</span>
            <small>{t.petGifs.scopeCount(rotationStates.length, states.length)}</small>
          </div>
          <p className="pet-gif-settings__scope-hint">{t.petGifs.rotationScopeHint}</p>
          <div className="pet-gif-settings__scope-chips">
            {states.map((key) => (
              <button
                key={key}
                type="button"
                className={rotationStates.includes(key) ? "is-active" : ""}
                aria-pressed={rotationStates.includes(key)}
                onClick={() => toggleRotationState(key)}
              >
                {t.petGifs.states[key] ?? key}
              </button>
            ))}
          </div>
          <div className="pet-gif-settings__scope-actions">
            <button
              type="button"
              className="sw-secondary"
              onClick={() => savePetGifRotationStates(states)}
            >
              {t.petGifs.selectAllStates}
            </button>
            <button
              type="button"
              className="sw-secondary"
              onClick={() => savePetGifRotationStates([state])}
            >
              {t.petGifs.currentStateOnly}
            </button>
          </div>
          <div className="pet-gif-settings__scope-preview">
            <div className="pet-gif-settings__scope-preview-head">
              <span>{t.petGifs.rotationFrames}</span>
              <small>{t.petGifs.count(scopeFrames.length)}</small>
            </div>
            {scopeFrames.length === 0 ? (
              <p className="pet-gif-settings__scope-preview-empty">{t.petGifs.rotationFramesEmpty}</p>
            ) : (
              <div className="pet-gif-settings__scope-grid">
                {scopeFrames.map((frame) => (
                  <figure
                    className="pet-gif-scope-item"
                    key={frame.src}
                    title={`${t.petGifs.states[frame.state] ?? frame.state} · ${frame.name}`}
                  >
                    <img src={frame.src} alt="" loading="lazy" draggable={false} />
                    <figcaption>{t.petGifs.states[frame.state] ?? frame.state}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>
        </div>
  
        {error && <p className="pet-gif-settings__error">{error}</p>}
        {notice && (
          <p className="pet-gif-settings__notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
  
        {items.length === 0 ? (
          <p className="pet-gif-settings__empty">{t.petGifs.empty}</p>
        ) : (
          <div className="pet-gif-settings__grid" role="list" aria-label={t.petGifs.title}>
            {items.map((item, index) => {
              const dragging = dragIndex === index;
              const dropTarget = dropIndex === index && dragIndex !== null && dragIndex !== index;
              return (
                <figure
                  key={item.id}
                  role="listitem"
                  className={`pet-gif-tile${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}`}
                  draggable
                  tabIndex={0}
                  aria-label={`${t.petGifs.order(index + 1)} · ${item.name}`}
                  title={`${t.petGifs.order(index + 1)} · ${item.name} · ${item.path ?? item.src ?? ""}`}
                  onDragStart={(event) => {
                    setDragIndex(index);
                    setDropIndex(index);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(index));
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (dropIndex !== index) setDropIndex(index);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const raw = event.dataTransfer.getData("text/plain");
                    const parsed = raw === "" ? Number.NaN : Number(raw);
                    const from =
                      Number.isInteger(parsed) && parsed >= 0 ? parsed : dragIndex;
                    resetDrag();
                    if (from === null) return;
                    reorder(from, index);
                  }}
                  onDragEnd={resetDrag}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void remove(item);
                  }}
                >
                  <img
                    className="pet-gif-tile__preview"
                    src={petGifItemSrc(item)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="pet-gif-tile__order" aria-hidden="true">
                    {index + 1}
                  </span>
                  <figcaption className="pet-gif-tile__name" title={item.name}>
                    {item.name}
                  </figcaption>
                  <button
                    type="button"
                    className="pet-gif-tile__delete"
                    aria-label={`${t.petGifs.delete} · ${item.name}`}
                    title={t.petGifs.delete}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(item);
                    }}
                    onContextMenu={(event) => {
                      // 让右键继续走格子自己的删除逻辑，不再弹系统菜单。
                      event.preventDefault();
                      event.stopPropagation();
                      void remove(item);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </figure>
              );
            })}
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
        </>
      )}
    </section>
  );
}