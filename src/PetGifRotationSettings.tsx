import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { CheckCheck, ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "./i18n";
import {
  defaultPetGifItems,
  petGifFileName,
  petGifItemSrc,
  savePetGifRotationConfig,
  usePetGifRotationConfig,
  type PetGifRotationItem,
} from "./petGifRotation";
import {
  movePetGifItem,
  petGifDropTargetIndex,
  type PetGifBounds,
  type PetGifTileRect,
} from "./utils/gifRotationOrder";
import { characterAllFrames, PET_CHARACTER_LABELS, usePetCharacter } from "./petCharacters";
import "./PetGifRotationSettings.css";

type CustomPetGif = {
  id: string;
  name: string;
  path: string;
};

const MAX_GIF_BYTES = 8 * 1024 * 1024;
/** 删除等操作的状态提示保留时长。 */
const NOTICE_MS = 2400;
/** 指针按下后移动多少像素才算「开始拖」，避免单击也被当成拖动。 */
const DRAG_THRESHOLD_PX = 4;
/** 拖到网格上下边缘这么多像素内自动滚动（触屏没有滚轮，靠它拖到远处）。 */
const SCROLL_EDGE_PX = 26;
/** 边缘自动滚动每帧的步长。 */
const SCROLL_STEP_PX = 12;

/**
 * 一次按下→移动→松开的排序会话。
 *
 * 这里用 Pointer Events 而不是 HTML5 拖放：Windows 的 WebView2 里 Tauri 默认把
 * 拖放交给原生文件拖放处理器（`dragDropEnabled: true`），网页里的
 * `dragstart/dragover/drop` 根本收不到，方格「拖不动」就是它导致的（见
 * `docs/pet-characters.md` 与 `docs/qa-feature-test-2026-11-17.md` §9.1）。
 * 指针事件不依赖浏览器拖放实现，鼠标 / 触摸 / 笔都能用；落点换算在
 * `petGifDropTargetIndex()` 里，可单测。
 */
type DragSession = {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  /** 超过阈值后才置 true：按下但没移动时不显示半透明/插入线。 */
  active: boolean;
  /** 当前落点格子下标；null 表示落在网格外或压在自身格子上，松手不排序。 */
  target: number | null;
  rects: PetGifTileRect[];
  bounds: PetGifBounds;
};

export function PetGifRotationSettings() {
  const t = useTranslation();
  const character = usePetCharacter();
  const config = usePetGifRotationConfig(character);
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
  // 拖拽排序：draggingIndex 是被拖的格子，dropIndex 是当前悬停的目标格子。
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragSession = useRef<DragSession | null>(null);
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

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // 切换表情/折叠时清掉上一列的拖拽残留，避免高亮/序号错位。
  useEffect(() => {
    dragSession.current = null;
    setDraggingIndex(null);
    setDropIndex(null);
  }, [state, expanded]);

  const flashNotice = (message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), NOTICE_MS);
  };

  const resetDrag = () => {
    dragSession.current = null;
    setDraggingIndex(null);
    setDropIndex(null);
  };

  const saveItems = (nextItems: PetGifRotationItem[]) => {
    savePetGifRotationConfig({ ...config, [state]: nextItems }, character);
  };

  const selectAll = () => {
    if (missingItems.length === 0) return;
    saveItems([...items, ...missingItems]);
  };

  // 拖动排序：把 from 处的格子取出，放到 to 处（to 为落点格子的当前位置）。
  // 复用 saveItems → savePetGifRotationConfig 写回配置，主窗口会通过 storage 事件同步。
  // 具体下标换算在 movePetGifItem 里，向上/向下拖的结果与插入线方向一致。
  const reorder = (from: number, to: number) => {
    const next = movePetGifItem(items, from, to);
    if (next === items) return;
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

  /** 读一次所有格子和网格的视口矩形；拖动中滚动后要重新读。 */
  const measureTiles = (): { rects: PetGifTileRect[]; bounds: PetGifBounds } | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const box = grid.getBoundingClientRect();
    const rects: PetGifTileRect[] = [];
    for (const node of grid.querySelectorAll<HTMLElement>("[data-gif-index]")) {
      const index = Number(node.dataset.gifIndex);
      if (!Number.isInteger(index) || index < 0) continue;
      const tile = node.getBoundingClientRect();
      rects.push({ index, left: tile.left, top: tile.top, right: tile.right, bottom: tile.bottom });
    }
    if (rects.length === 0) return null;
    return { rects, bounds: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } };
  };

  const beginPointerDrag = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    // 右键留给「右键删除」；删除小按钮上的按下也不算拖动。
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest(".pet-gif-tile__delete")) return;
    const measured = measureTiles();
    if (!measured) return;
    dragSession.current = {
      pointerId: event.pointerId,
      from: index,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target: null,
      rects: measured.rects,
      bounds: measured.bounds,
    };
    // 捕获指针：手指/鼠标移出格子后仍然能收到 move / up，拖到窗口边缘也不会丢。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 环境不支持指针捕获时退化成「在格子内拖动」，不阻断功能。
    }
    // 阻止原生图片拖拽和文本选择抢走手势。
    event.preventDefault();
  };

  const movePointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.active) {
      const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (moved < DRAG_THRESHOLD_PX) return;
      session.active = true;
      setDraggingIndex(session.from);
    }

    // 拖到网格上下边缘时自动滚动，滚完重新测量格子位置。
    const grid = gridRef.current;
    if (grid) {
      let scrolled = false;
      if (event.clientY < session.bounds.top + SCROLL_EDGE_PX && grid.scrollTop > 0) {
        grid.scrollTop = Math.max(0, grid.scrollTop - SCROLL_STEP_PX);
        scrolled = true;
      } else if (
        event.clientY > session.bounds.bottom - SCROLL_EDGE_PX &&
        grid.scrollTop + grid.clientHeight < grid.scrollHeight - 1
      ) {
        grid.scrollTop = Math.min(grid.scrollHeight, grid.scrollTop + SCROLL_STEP_PX);
        scrolled = true;
      }
      if (scrolled) {
        const measured = measureTiles();
        if (measured) {
          session.rects = measured.rects;
          session.bounds = measured.bounds;
        }
      }
    }

    const target = petGifDropTargetIndex(
      session.rects,
      { x: event.clientX, y: event.clientY },
      { bounds: session.bounds, draggingIndex: session.from },
    );
    if (target === session.target) return;
    session.target = target;
    setDropIndex(target);
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    dragSession.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { active, from, target } = session;
    setDraggingIndex(null);
    setDropIndex(null);
    // 只是点了一下（没超过拖动阈值）或落在网格外：什么都不做。
    if (!active || target === null) return;
    reorder(from, target);
  };

  const cancelPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resetDrag();
  };

  return (
    <section className="sw-card pet-gif-settings">
      <div className="pet-gif-settings__head">
        <div>
          <h2>{t.petGifs.title}</h2>
          <p className="pet-gif-settings__subtitle">
            {t.petGifs.subtitle} · {t.petGifs.characterLabel(PET_CHARACTER_LABELS[character])}
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
            {expanded ? t.petGifs.collapseWithCount(items.length) : t.petGifs.expandWithCount(items.length)}
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

          {error && <p className="pet-gif-settings__error">{error}</p>}
          {notice && (
            <p className="pet-gif-settings__notice" role="status" aria-live="polite">
              {notice}
            </p>
          )}

          {items.length === 0 ? (
            <p className="pet-gif-settings__empty">{t.petGifs.empty}</p>
          ) : (
            <div ref={gridRef} className="pet-gif-settings__grid" role="list" aria-label={t.petGifs.title}>
              {items.map((item, index) => {
                const dragging = draggingIndex === index;
                const dropTarget = dropIndex === index && draggingIndex !== null && draggingIndex !== index;
                // 向下拖时松手是「插到目标格之后」，插入线要画在右边才和结果一致。
                const dropAfter = dropTarget && draggingIndex !== null && index > draggingIndex;
                return (
                  <figure
                    key={item.id}
                    role="listitem"
                    className={`pet-gif-tile${dragging ? " is-dragging" : ""}${dropTarget ? " is-drop-target" : ""}${dropAfter ? " is-drop-target--after" : ""}`}
                    data-gif-index={index}
                    tabIndex={0}
                    aria-label={`${t.petGifs.order(index + 1)} · ${item.name}`}
                    title={`${t.petGifs.order(index + 1)} · ${item.name} · ${item.path ?? item.src ?? ""}`}
                    draggable={false}
                    onPointerDown={(event) => beginPointerDrag(event, index)}
                    onPointerMove={movePointerDrag}
                    onPointerUp={finishPointerDrag}
                    onPointerCancel={cancelPointerDrag}
                    onLostPointerCapture={cancelPointerDrag}
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