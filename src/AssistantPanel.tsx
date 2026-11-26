import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "./i18n";
import { AssistantShortcutGrid } from "./AssistantShortcutGrid";
import { checkShortcutPath, missingPathMessage } from "./shortcutPath";
import {
  formatShortcutFromEvent,
  loadShortcutPanelHotkey,
  saveShortcutPanelHotkey,
} from "./shortcutPanelHotkey";
import {
  loadShortcutAutoDetect,
  loadShortcutScanDir,
  saveShortcutAutoDetect,
  saveShortcutScanDir,
  SHORTCUT_AUTO_DETECT_EVENT,
  SHORTCUT_SCAN_DIR_EVENT,
} from "./shortcutScanDir";
import { loadWakeShortcut, saveWakeShortcut } from "./wakeShortcut";
import {
  CUSTOM_SHORTCUTS_KEY,
  HIDDEN_SHORTCUT_ACTIONS_KEY,
  HIDDEN_SHORTCUTS_KEY,
  SHORTCUT_ORDER_KEY,
  CustomShortcut,
  loadCustomShortcuts,
  loadHiddenShortcutActions,
  loadHiddenShortcuts,
  loadShortcutOrder,
  shortcutFileKey,
  shortcutPathKey,
  shortcutToolKey,
} from "./assistantSupport";
export function AssistantPanel({ onOpenSettingsWindow }: { onOpenSettingsWindow?: () => Promise<void> }) {
  const t = useTranslation();
  const panelRef = useRef<HTMLElement | null>(null);
  const appSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState("选择一个入口，线条小狗会陪你完成下一步");
  const [discoveredShortcuts, setDiscoveredShortcuts] = useState<Array<{ label: string; path: string; kind: string; category: string }>>([]);
  const [customShortcuts, setCustomShortcuts] = useState<CustomShortcut[]>(loadCustomShortcuts);
  const [hiddenShortcuts, setHiddenShortcuts] = useState<string[]>(loadHiddenShortcuts);
  const [hiddenShortcutActions, setHiddenShortcutActions] = useState<string[]>(loadHiddenShortcutActions);
  const [autoDetectShortcuts, setAutoDetectShortcuts] = useState(loadShortcutAutoDetect);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPath, setDraftPath] = useState("");
  // 路径格式错误时直接显示在输入框下面，而不是只在角落闪一句提示。
  const [draftPathError, setDraftPathError] = useState("");
  const [clearAllArmed, setClearAllArmed] = useState(false);
  const [panelHotkey, setPanelHotkey] = useState(loadShortcutPanelHotkey);
  const [recordingPanelHotkey, setRecordingPanelHotkey] = useState(false);
  const [panelHotkeyError, setPanelHotkeyError] = useState("");
  const [scanDir, setScanDir] = useState(loadShortcutScanDir);
  const [scanDraft, setScanDraft] = useState(loadShortcutScanDir);
  const [scanError, setScanError] = useState("");
  const [appQuery, setAppQuery] = useState("");
  const [appResults, setAppResults] = useState<Array<{ label: string; path: string; kind: string; category: string }>>([]);
  const [appSearching, setAppSearching] = useState(false);
  const [appActiveIndex, setAppActiveIndex] = useState(-1);
  // 卡片顺序（拖动排序的结果），持久化在 localStorage 里。
  const [shortcutOrder, setShortcutOrder] = useState<string[]>(loadShortcutOrder);
  const shortcutOrderRef = useRef(shortcutOrder);
  shortcutOrderRef.current = shortcutOrder;
  const [draggingShortcutKey, setDraggingShortcutKey] = useState<string | null>(null);
  const shortcutDragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const suppressShortcutClickRef = useRef(false);
  const shortcutCardsRef = useRef<Array<{ key: string }>>([]);

  // 结果刷新后重置选中项，避免上下键停在一个已经不存在的位置。
  useEffect(() => {
    setAppActiveIndex(-1);
  }, [appResults]);

  useEffect(() => {
    // 面板可能是热键打开的：窗口刚显示时 DOM 还没拿到焦点，单次 focus 会被吞掉。
    // 这里补几次重试，并在窗口重新获得焦点时再抢一次，保证能直接打字。
    const focusSearch = () => appSearchInputRef.current?.focus();
    const timers = [0, 60, 180, 400].map((ms) => window.setTimeout(focusSearch, ms));
    const handleWindowFocus = () => focusSearch();
    window.addEventListener("focus", handleWindowFocus);
    void getCurrentWindow().setFocus().catch(() => undefined);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, []);

  // 热键重复按（面板已展开时）也要把焦点拉回搜索框。
  useEffect(() => {
    const focusSearch = () => appSearchInputRef.current?.focus();
    window.addEventListener("maltese-focus-app-search", focusSearch);
    return () => window.removeEventListener("maltese-focus-app-search", focusSearch);
  }, []);

  useEffect(() => {
    if (!clearAllArmed) {
      return;
    }
    const timer = window.setTimeout(() => setClearAllArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [clearAllArmed]);

  useEffect(() => {
    void invoke<string>("set_wake_shortcut", { shortcut: loadWakeShortcut() })
      .then((registered) => saveWakeShortcut(registered))
      .catch(() => undefined);
  }, []);
  // 快捷方式列表默认只扫描桌面；设置扫描目录后只扫描该目录。
  useEffect(() => {
    setScanError("");
    if (!autoDetectShortcuts) {
      setDiscoveredShortcuts([]);
      return;
    }
    void invoke<Array<{ label: string; path: string; kind: string; category: string }>>(
      "discover_shortcuts",
      { scanDir: scanDir || null },
    )
      .then(setDiscoveredShortcuts)
      .catch((error) => {
        setDiscoveredShortcuts([]);
        setScanError(String(error));
      });
  }, [autoDetectShortcuts, scanDir]);

  useEffect(() => {
    const sync = () => {
      const next = loadShortcutScanDir();
      setScanDir(next);
      setScanDraft(next);
      setAutoDetectShortcuts(loadShortcutAutoDetect());
    };
    const syncAuto = () => setAutoDetectShortcuts(loadShortcutAutoDetect());
    window.addEventListener("storage", sync);
    window.addEventListener(SHORTCUT_SCAN_DIR_EVENT, sync);
    window.addEventListener(SHORTCUT_AUTO_DETECT_EVENT, syncAuto);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(SHORTCUT_SCAN_DIR_EVENT, sync);
      window.removeEventListener(SHORTCUT_AUTO_DETECT_EVENT, syncAuto);
    };
  }, []);

  useEffect(() => {
    const query = appQuery.trim();
    if (!query) {
      setAppResults([]);
      setAppSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAppSearching(true);
      void (async () => {
        // 文件型快捷方式（桌面/开始菜单的 .lnk、.exe）+ Windows 登记的应用（含商店应用）。
        const [fileResults, startApps] = await Promise.all([
          invoke<Array<{ label: string; path: string; kind: string; category: string }>>(
            "discover_installed_apps",
            { query },
          ).catch(() => []),
          invoke<Array<{ label: string; appId: string }>>("discover_start_apps", {
            query,
          }).catch(() => []),
        ]);
        const known = new Set(fileResults.map((item) => item.label.toLowerCase()));
        const storeResults = startApps
          .filter((app) => !known.has(app.label.toLowerCase()))
          .map((app) => ({
            label: app.label,
            // shell:AppsFolder 的启动方式需要单独命令，这里用前缀标记。
            path: `app:${app.appId}`,
            kind: "appx",
            category: "store",
          }));
        return [...fileResults, ...storeResults];
      })()
        .then((results) => {
          if (!cancelled) setAppResults(results);
        })
        .finally(() => {
          if (!cancelled) setAppSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [appQuery]);
  // 读取快捷方式图标（.lnk / exe / 脚本）
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    const paths = [...new Set([
      ...discoveredShortcuts.map((shortcut) => shortcut.path),
      ...customShortcuts.map((shortcut) => shortcut.path),
    ])].filter((path) => !path.startsWith("app:")).slice(0, 30);
    void Promise.all(paths.map(async (path) => {
      try {
        const icon = await invoke<string | null>("get_shortcut_icon", { path });
        return [path, icon] as const;
      } catch {
        return [path, null] as const;
      }
    })).then((entries) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, string> = {};
      for (const [path, icon] of entries) {
        if (icon) {
          next[path] = icon;
        }
      }
      setIcons(next);
    });
    return () => {
      cancelled = true;
    };
  }, [customShortcuts, discoveredShortcuts]);

  const persistCustomShortcuts = (next: CustomShortcut[]) => {
    setCustomShortcuts(next);
    try {
      window.localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(next));
    } catch {
      // 忽略写入失败
    }
  };

  const persistHiddenShortcuts = (next: string[]) => {
    const unique = [...new Set(next.map(shortcutPathKey))].slice(0, 200);
    setHiddenShortcuts(unique);
    try {
      window.localStorage.setItem(HIDDEN_SHORTCUTS_KEY, JSON.stringify(unique));
    } catch {
      // 忽略写入失败
    }
  };

  const persistHiddenShortcutActions = (next: string[]) => {
    const unique = [...new Set(next)].slice(0, 100);
    setHiddenShortcutActions(unique);
    try {
      window.localStorage.setItem(HIDDEN_SHORTCUT_ACTIONS_KEY, JSON.stringify(unique));
    } catch {
      // 忽略写入失败
    }
  };

  const hideShortcut = (label: string, path: string) => {
    persistHiddenShortcuts([...hiddenShortcuts, path]);
    setNotice(`${label} 已从列表移除（不会删除桌面文件）`);
  };

  const hideShortcutAction = (id: string, label: string) => {
    persistHiddenShortcutActions([...hiddenShortcutActions, id]);
    setNotice(`${label} 已从快捷入口移除`);
  };

  const restoreHiddenShortcuts = () => {
    persistHiddenShortcuts([]);
    persistHiddenShortcutActions([]);
    setNotice("已恢复被隐藏的快捷方式");
  };

  const addCustomShortcut = async () => {
    // 先校验路径格式：错在哪、该写成什么样，都直接显示在输入框下面。
    const check = checkShortcutPath(draftPath);
    if (!check.ok) {
      setDraftPathError(check.message);
      return;
    }
    const path = check.normalized;
    if (customShortcuts.some((shortcut) => shortcutPathKey(shortcut.path) === shortcutPathKey(path))) {
      setDraftPathError("这个路径已经在快捷入口里了。");
      return;
    }
    // 再确认文件真的在：格式对但路径写错是最常见的情况。
    try {
      const result = await invoke<{
        exists: boolean;
        isFile: boolean;
        isDir: boolean;
        error: string | null;
      }>("check_local_path", { path });
      if (!result.exists) {
        setDraftPathError(missingPathMessage(path));
        return;
      }
      if (result.isDir) {
        setDraftPathError("这是一个文件夹，请填到具体的程序文件（例如 .exe / .lnk / .bat）。");
        return;
      }
    } catch {
      // 检查命令不可用时放行，避免挡住用户
    }
    const fallbackLabel = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    persistCustomShortcuts([...customShortcuts, { label: draftLabel.trim() || fallbackLabel, path }].slice(0, 24));
    setDraftLabel("");
    setDraftPath("");
    setDraftPathError("");
    setAdding(false);
    setNotice("已添加快捷方式");
  };

  const addSystemApp = (app: { label: string; path: string }) => {
    if (customShortcuts.some((shortcut) => shortcut.path === app.path)) {
      setNotice(`${app.label} 已经在快捷入口里`);
      return;
    }
    if (discoveredShortcuts.some((shortcut) => shortcutPathKey(shortcut.path) === shortcutPathKey(app.path))) {
      persistHiddenShortcuts([...hiddenShortcuts, app.path]);
    }
    persistCustomShortcuts([
      ...customShortcuts,
      { label: app.label, path: app.path },
    ].slice(0, 60));
    setAppQuery("");
    setAppResults([]);
    setNotice(`已添加 ${app.label}`);
  };

  const applyScanDir = () => {
    const next = saveShortcutScanDir(scanDraft);
    setScanDraft(next);
    setScanDir(next);
  };

  // 点击后立即在卡片上转圈：Rust 只负责把进程交给 shell，这里再把“从点击到
  // 系统接受启动”的耗时写进提示，至少让用户看到反馈，而不是干等。
  const runLaunch = (key: string, label: string, task: () => Promise<unknown>) => {
    setLaunchingKey(key);
    const started = performance.now();
    void task()
      .then(() => {
        const elapsed = Math.round(performance.now() - started);
        setNotice(`${label} 已打开（${elapsed} ms）`);
      })
      .catch((error) => setNotice(`${label} 打开失败：${String(error)}`))
      .finally(() => {
        const elapsed = performance.now() - started;
        // 太快返回时也保持一小段转圈，避免只闪一下看不出反馈。
        window.setTimeout(() => setLaunchingKey(null), Math.max(0, 450 - elapsed));
      });
  };

  const launchPath = (label: string, path: string) => {
    if (path.startsWith("app:")) {
      // 商店应用：交给 shell:AppsFolder 启动。
      runLaunch(path, label, () => invoke("launch_start_app", { appId: path.slice(4) }));
      return;
    }
    const isCustom = customShortcuts.some((shortcut) => shortcut.path === path);
    const command = isCustom ? "launch_custom_shortcut" : "launch_discovered_shortcut";
    runLaunch(path, label, () =>
      invoke(command, isCustom ? { path } : { path, scanDir: scanDir || null }),
    );
  };

  const handleAppSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 快捷键打开面板后不用动鼠标：直接输入，↑↓ 选，回车打开。
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (appResults.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setAppActiveIndex((current) => {
        const next = current + step;
        return (next + appResults.length) % appResults.length;
      });
      return;
    }
    if (event.key === "Escape") {
      if (appQuery) {
        event.preventDefault();
        setAppQuery("");
        setAppActiveIndex(-1);
      }
      return;
    }
    if (event.key === "Enter") {
      const target = appActiveIndex >= 0 ? appResults[appActiveIndex] : appResults[0];
      if (target) {
        event.preventDefault();
        launchPath(target.label, target.path);
      }
    }
  };

  const actions = [
    { id: "netease", label: "网易云音乐", detail: "打开本机网易云客户端", tool: "netease" },
    { id: "doubao", label: "豆包", detail: "打开本机豆包客户端", tool: "doubao" },
    { id: "youdaodict", label: "有道词典", detail: "打开本地词典客户端", tool: "youdaodict" },
    { id: "calculator", label: "计算器", detail: "快速算一笔", tool: "calculator" },
  ];
  const hiddenShortcutSet = new Set(hiddenShortcuts);
  const hiddenActionSet = new Set(hiddenShortcutActions);
  const visibleActions = actions.filter((action) => !hiddenActionSet.has(action.id));
  const discoveredActions = discoveredShortcuts
    .filter((shortcut) => !hiddenShortcutSet.has(shortcutPathKey(shortcut.path)));
  const removableShortcutCount =
    visibleActions.length +
    discoveredShortcuts.filter((shortcut) => !hiddenShortcutSet.has(shortcutPathKey(shortcut.path))).length +
    customShortcuts.length;

  // 三批卡片合成一条列表：顺序 = 用户拖动后记下的顺序，新出现的条目排在末尾。
  const shortcutCards = (() => {
    const cards: Array<{
      key: string;
      kind: "tool" | "discovered" | "custom";
      label: string;
      detail: string;
      detailTitle?: string;
      path?: string;
      actionId?: string;
      tool?: string;
    }> = [];
    for (const action of visibleActions) {
      cards.push({
        key: shortcutToolKey(action.id),
        kind: "tool",
        label: action.label,
        detail: action.detail,
        actionId: action.id,
        tool: action.tool,
      });
    }
    for (const shortcut of discoveredActions) {
      cards.push({
        key: shortcutFileKey(shortcut.path),
        kind: "discovered",
        label: shortcut.label,
        detail: shortcut.kind === "lnk" ? "桌面快捷方式" : `自动发现 · .${shortcut.kind}`,
        detailTitle: shortcut.path,
        path: shortcut.path,
      });
    }
    for (const shortcut of customShortcuts) {
      cards.push({
        key: shortcutFileKey(shortcut.path),
        kind: "custom",
        label: shortcut.label,
        detail: "自定义快捷方式",
        detailTitle: shortcut.path,
        path: shortcut.path,
      });
    }
    const rank = new Map(shortcutOrder.map((key, index) => [key, index] as const));
    const tail = Number.MAX_SAFE_INTEGER;
    return cards
      .map((card, index) => ({ card, index, rank: rank.get(card.key) ?? tail }))
      .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
      .map((entry) => entry.card);
  })();
  shortcutCardsRef.current = shortcutCards;

  const persistShortcutOrder = (next: string[]) => {
    const unique = [...new Set(next)].slice(0, 200);
    setShortcutOrder(unique);
    shortcutOrderRef.current = unique;
    try {
      window.localStorage.setItem(SHORTCUT_ORDER_KEY, JSON.stringify(unique));
    } catch {
      // 忽略写入失败
    }
  };

  // 拖动时把卡片移到目标卡片的左/右半侧，只改顺序、不改内容。
  const moveShortcutCard = (draggedKey: string, targetKey: string, after: boolean) => {
    setShortcutOrder((current) => {
      const base = shortcutCardsRef.current.map((card) => card.key);
      const merged = [
        ...current.filter((key) => base.includes(key)),
        ...base.filter((key) => !current.includes(key)),
      ];
      const withoutDragged = merged.filter((key) => key !== draggedKey);
      const targetIndex = withoutDragged.indexOf(targetKey);
      if (targetIndex < 0) {
        return current;
      }
      const next = [...withoutDragged];
      next.splice(after ? targetIndex + 1 : targetIndex, 0, draggedKey);
      shortcutOrderRef.current = next;
      return next;
    });
  };

  const beginShortcutDrag = (event: React.PointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(".assistant-card__remove")) {
      return;
    }
    shortcutDragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const drag = shortcutDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      if (!drag.active) {
        // 小位移仍然算点击，避免“想点一下却变成拖动”。
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) {
          return;
        }
        drag.active = true;
        setDraggingShortcutKey(drag.key);
        // 第一次拖动时把当前可见顺序固化下来，之后的插入都基于它。
        persistShortcutOrder(shortcutCardsRef.current.map((card) => card.key));
      }
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>("[data-shortcut-key]"),
      );
      for (const element of cards) {
        const key = element.dataset.shortcutKey;
        if (!key || key === drag.key) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (
          event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom
        ) {
          moveShortcutCard(drag.key, key, event.clientX > rect.left + rect.width / 2);
          break;
        }
      }
    };
    const finish = () => {
      const drag = shortcutDragRef.current;
      shortcutDragRef.current = null;
      if (!drag?.active) {
        return;
      }
      setDraggingShortcutKey(null);
      persistShortcutOrder(shortcutOrderRef.current);
      // 拖动结束后的那次 click 不应该触发启动。
      suppressShortcutClickRef.current = true;
      window.setTimeout(() => {
        suppressShortcutClickRef.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, []);

  useEffect(() => {
    if (!recordingPanelHotkey) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingPanelHotkey(false);
        return;
      }
      if (event.repeat) return;
      const combo = formatShortcutFromEvent(event);
      if (!combo) {
        setPanelHotkeyError(t.assistant.panelHotkeyModifierRequired);
        return;
      }
      setRecordingPanelHotkey(false);
      void invoke<string>("set_shortcut_panel_hotkey", { shortcut: combo })
        .then((registered) => {
          setPanelHotkey(registered);
          saveShortcutPanelHotkey(registered);
          setPanelHotkeyError("");
          setNotice(t.assistant.panelHotkeySet(registered));
        })
        .catch((error) => setPanelHotkeyError(String(error)));
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingPanelHotkey, t.assistant.panelHotkeyModifierRequired, t.assistant.panelHotkeySet]);

  const clearPanelHotkey = () => {
    if (!panelHotkey) return;
    void invoke("set_shortcut_panel_hotkey", { shortcut: "" })
      .then(() => {
        setPanelHotkey("");
        saveShortcutPanelHotkey("");
        setPanelHotkeyError("");
        setNotice(t.assistant.panelHotkeyCleared);
      })
      .catch((error) => setPanelHotkeyError(String(error)));
  };

  const clearAllShortcuts = () => {
    if (!removableShortcutCount) {
      return;
    }
    if (!clearAllArmed) {
      setClearAllArmed(true);
      setNotice(t.assistant.clearAllHint(removableShortcutCount));
      return;
    }
    // 自动发现项只写隐藏列表，自定义项清空 localStorage；两者都不碰真实文件。
    persistHiddenShortcuts([
      ...hiddenShortcuts,
      ...discoveredShortcuts.map((shortcut) => shortcut.path),
    ]);
    persistHiddenShortcutActions([
      ...hiddenShortcutActions,
      ...actions.map((action) => action.id),
    ]);
    persistCustomShortcuts([]);
    setClearAllArmed(false);
    setAdding(false);
    setNotice(t.assistant.clearAllDone(removableShortcutCount));
  };

  const handleAction = (tool: string, label: string) => {
    runLaunch(`tool:${tool}`, label, () => invoke("launch_tool", { tool }));
  };

  // 只有拿到真实程序图标时才占一个图标位；没有图标就让文字铺满卡片，
  // 不再显示“哔/抖/链”这类占地方的单字占位块。
  const renderIcon = (path: string) =>
    icons[path]
      ? <span className="assistant-card__emoji" aria-hidden="true"><img src={icons[path]} alt="" draggable={false} /></span>
      : null;

  return (
    <section ref={panelRef} className="assistant-panel" aria-label="Maltese 快捷面板">
      <div className="assistant-panel__head">
        <span className="assistant-panel__notice">{notice}</span>
        <div className="assistant-panel__head-actions">
          <button
            type="button"
            className="assistant-panel__settings"
            onClick={() => {
              // QA D5：独立设置窗口会抢焦点，先收起浮层再开（App 传入的回调里做），
              // 不再让「展开的岛 + 设置窗口」同时出现。
              const open = onOpenSettingsWindow ?? (() => invoke("open_settings_window", { source: "assistant-panel" }));
              void open().catch(() => setNotice("设置窗口打开失败，请从托盘菜单「配置桌宠」再试一次"));
            }}
          >
            设置
          </button>
        </div>
      </div>
      <div className="assistant-panel__app-search">
        <span className="assistant-panel__label">搜索应用直接打开</span>
        <input
          ref={appSearchInputRef}
          value={appQuery}
          onChange={(event) => setAppQuery(event.currentTarget.value)}
          onKeyDown={handleAppSearchKeyDown}
          placeholder="输入应用名，↑↓ 选择，回车打开"
          spellCheck={false}
        />
        {appQuery.trim() && (
          <div className="assistant-panel__app-results">
            {appSearching ? (
              <small>正在搜索系统应用…</small>
            ) : appResults.length > 0 ? (
              appResults.slice(0, 12).map((app, index) => (
                <button
                  key={app.path}
                  type="button"
                  className={index === appActiveIndex ? "assistant-panel__app-result--active" : undefined}
                  onMouseEnter={() => setAppActiveIndex(index)}
                  onClick={() => addSystemApp(app)}
                  title={app.path}
                >
                  <span>{app.label}</span>
                  <small>
                    {app.kind === "lnk"
                      ? "开始菜单"
                      : app.kind === "appx"
                        ? "商店应用"
                        : `.${app.kind}`}
                  </small>
                  <strong>＋</strong>
                </button>
              ))
            ) : (
              <small>没有找到匹配的系统应用</small>
            )}
          </div>
        )}
      </div>
      <div className="assistant-panel__section-head">
        <span>快捷方式</span>
        <div className="assistant-panel__section-meta">
          {hiddenShortcuts.length + hiddenShortcutActions.length > 0 && (
            <button
              type="button"
              className="assistant-panel__restore"
              onClick={restoreHiddenShortcuts}
            >
              恢复隐藏（{hiddenShortcuts.length + hiddenShortcutActions.length}）
            </button>
          )}
          {removableShortcutCount > 0 && (
            <button
              type="button"
              className={`assistant-panel__clear-all${clearAllArmed ? " assistant-panel__clear-all--armed" : ""}`}
              title={t.assistant.clearAllHint(removableShortcutCount)}
              onClick={clearAllShortcuts}
            >
              {clearAllArmed ? t.assistant.clearAllConfirm : t.assistant.clearAll}
            </button>
          )}
        </div>
      </div>
      <AssistantShortcutGrid
        shortcutCards={shortcutCards}
        suppressShortcutClickRef={suppressShortcutClickRef}
        draggingShortcutKey={draggingShortcutKey}
        launchingKey={launchingKey}
        beginShortcutDrag={beginShortcutDrag}
        handleAction={handleAction}
        launchPath={launchPath}
        renderIcon={renderIcon}
        hideShortcutAction={hideShortcutAction}
        hideShortcut={hideShortcut}
        persistCustomShortcuts={persistCustomShortcuts}
        customShortcuts={customShortcuts}
      />      <div className="assistant-panel__manage">
        <div className="assistant-panel__section-head">
          <span>添加与设置</span>
          <div className="assistant-panel__section-meta">
            <button
              type="button"
              className="assistant-panel__add"
              onClick={() => setAdding((value) => !value)}
            >
              {adding ? "取消" : "＋ 新增快捷方式"}
            </button>
          </div>
        </div>
        {adding && (
          <div className="assistant-panel__add-form">
            <input
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.currentTarget.value)}
              placeholder="名称（可选）"
            />
            <input
              value={draftPath}
              className={draftPathError ? "assistant-panel__add-input is-error" : "assistant-panel__add-input"}
              aria-invalid={Boolean(draftPathError)}
              aria-describedby={draftPathError ? "shortcut-path-error" : undefined}
              onChange={(event) => {
                setDraftPath(event.currentTarget.value);
                if (draftPathError) setDraftPathError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addCustomShortcut();
              }}
              placeholder="程序或脚本路径，例如 C:\\Tools\\tool.exe"
            />
            <button type="button" onClick={() => void addCustomShortcut()}>添加</button>
            {draftPathError && (
              <p className="assistant-panel__add-error" id="shortcut-path-error" role="alert">
                {draftPathError}
              </p>
            )}
          </div>
        )}
        <div className="assistant-panel__panel-hotkey">
          <span className="assistant-panel__label">{t.assistant.panelHotkey}</span>
          <button
            type="button"
            className={`assistant-panel__hotkey-button${recordingPanelHotkey ? " assistant-panel__hotkey-button--recording" : ""}${panelHotkeyError ? " assistant-panel__hotkey-button--error" : ""}`}
            title={panelHotkeyError || t.assistant.panelHotkeyHint}
            aria-label={t.assistant.panelHotkeyHint}
            onClick={() => {
              setPanelHotkeyError("");
              setRecordingPanelHotkey(true);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              clearPanelHotkey();
            }}
          >
            {recordingPanelHotkey
              ? t.assistant.panelHotkeyRecording
              : panelHotkey || t.assistant.panelHotkeyEmpty}
          </button>
          <small role={panelHotkeyError ? "alert" : undefined}>
            {panelHotkeyError || t.assistant.panelHotkeyHint}
          </small>
        </div>
        <div className="assistant-panel__scan-dir">
          <label className="assistant-panel__scan-toggle">
            <input
              type="checkbox"
              checked={autoDetectShortcuts}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setAutoDetectShortcuts(next);
                saveShortcutAutoDetect(next);
              }}
            />
            <span>自动识别快捷方式</span>
          </label>
          <span className="assistant-panel__label">自动扫描目录</span>
          <div className="assistant-panel__scan-row">
            <input
              value={scanDraft}
              disabled={!autoDetectShortcuts}
              onChange={(event) => setScanDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyScanDir();
              }}
              placeholder="留空只扫描桌面，或填一个快捷方式目录"
              spellCheck={false}
            />
            <button type="button" disabled={!autoDetectShortcuts} onClick={applyScanDir}>扫描</button>
          </div>
          <small className={scanError ? "assistant-panel__scan-error" : undefined}>
            {!autoDetectShortcuts
              ? "自动识别已关闭；只保留自定义快捷方式。"
              : scanError || (scanDir ? `只扫描：${scanDir}` : "读取桌面和系统开始菜单，不扫描 Program Files。")}
          </small>
        </div>
      </div>
    </section>
  );
}
