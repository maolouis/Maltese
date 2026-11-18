export type LocaleCode = "zh-CN" | "en";

export type DuoScene = {
  /** 每组 = { 小鸡毛主动句, 小白回应句, 主狗自说句 }。 */
  pairs: { active: string; shy: string; main: string }[];
};

export type Translations = {
  /** Native language name shown in the locale picker. */
  localeLabel: string;
  /** BCP-47 tag handed to Intl for dates and numbers. */
  localeTag: string;

  common: {
    close: string;
    retry: string;
    refresh: string;
    clear: string;
    saved: string;
    connecting: string;
    noMessages: string;
  };
  chat: {
    title: string;
    hint: string;
    empty: string;
    emptyHint: string;
    placeholder: string;
    send: string;
    clear: string;
    thinking: string;
    desktopOnly: string;
    modelSettings: string;
    modelBackend: string;
    modelDsh: string;
    modelDshHint: string;
    modelLocal: string;
    modelLocalHint: string;
    modelBaseUrl: string;
    modelBaseUrlHint: string;
    modelName: string;
    modelNamePlaceholder: string;
    modelApiKey: string;
    modelApiKeyHint: string;
    modelPresetOllama: string;
    modelPresetLmStudio: string;
    modelPresetStrata: string;
    modelStartStrata: string;
    modelStartingStrata: string;
    modelStrataStarted: string;
    modelStrataHint: string;
    modelGenerationTitle: string;
    modelMaxTokens: string;
    modelTemperature: string;
    modelTopP: string;
    modelThinking: string;
    modelStream: string;
    modelVision: string;
    modelTest: string;
    modelTesting: string;
    modelTestOk: (count: number) => string;
    modelTestEmpty: string;
    modelClose: string;
    modelNotConfigured: string;
    modelBaseUrlMissing: string;
    modelBadgeLocal: (model: string) => string;
    imageAttach: string;
    imageRemove: string;
    imageAttached: (count: number) => string;
  imageLimit: (max: number) => string;
  imageReadFailed: string;
    multimodalLocalOnly: string;
  };
  messages: {
    title: string;
    sources: string;
    wechat: string;
    mail: string;
    qqMail: string;
    qqNotifications: string;
    wechatReminders: string;
    newReminder: string;
    newMessage: string;
    newNotification: string;
    newMail: string;
    wechatPreview: string;
    openNewMail: string;
    newMailLabel: string;
    sourceLabels: {
      qq: string;
      wechat: string;
      qqMail: string;
    };
    collapsedTask: (title: string) => string;
    expand: (label: string) => string;
    openPreview: (text: string, source: string) => string;
    badge: (count: number, wechat: boolean) => string;
    label: (text: string) => string;
    qqPreview: (title: string, body: string) => string;
  };
  qq: {
    desktopOnly: string;
    receive: string;
    title: string;
    pause: string;
    resume: string;
    allow: string;
    allowLabel: string;
    grant: string;
    settings: string;
    retry: string;
    retryLabel: string;
    recent: string;
    open: string;
    refresh: string;
    clear: string;
    list: string;
    status: {
      disabled: string;
      waiting: string;
      listening: string;
      permissionDenied: string;
      permissionRequired: string;
      error: string;
    };
    openNotification: (title: string) => string;
    summary: (count: number) => string;
    itemLabel: string;
    itemHint: string;
  };
  wechat: {
    desktopOnly: string;
    receive: string;
    pause: string;
    open: string;
    noReminders: string;
    privacyNote: string;
    status: {
      disabled: string;
      waiting: string;
      listening: string;
      error: string;
    };
  };
  mail: {
    savePreferencesFailed: string;
    desktopConnect: string;
    desktopRead: string;
    changed: string;
    openLinkFailed: string;
    openFailed: string;
    helpFailed: string;
    reader: string;
    back: string;
    webHint: string;
    openWeb: string;
    body: string;
    loading: string;
    emptyHtml: string;
    emptyText: string;
    notice: string;
    remoteImages: string;
    remoteImagesOn: string;
    remoteImagesOff: string;
    loadRemoteImages: string;
    remoteImagesBlocked: (count: number) => string;
    receive: string;
    pause: string;
    resume: string;
    help: string;
    helpLabel: string;
    open: string;
    openLabel: string;
    refresh: string;
    refreshLabel: string;
    disconnect: string;
    disconnectLabel: string;
    email: string;
    emailPlaceholder: string;
    authorizationCode: string;
    authorizationPlaceholder: string;
    connect: string;
    inbox: string;
    syncing: string;
    empty: string;
    status: {
      disconnected: string;
      connecting: string;
      connected: string;
      paused: string;
      authRequired: string;
      error: string;
    };
    lastSynced: (time: string) => string;
    readMessage: (subject: string, unread: boolean) => string;
  };
  translator: {
    label: string;
    title: string;
    subtitle: string;
    settings: string;
    closeLabel: string;
    credentialHint: string;
    secret: string;
    replaceSecret: string;
    enterSecret: string;
    saveSecret: string;
    deleteSecret: string;
    shortcut: string;
    pressShortcut: string;
    shortcutHint: string;
    direction: string;
    auto: string;
    zhEn: string;
    enZh: string;
    chinese: string;
    english: string;
    bilingual: string;
    source: string;
    limit: string;
    placeholder: string;
    paste: string;
    result: string;
    copy: string;
    copied: string;
    clearSource: string;
    loading: string;
    emptyResult: string;
    configureSecret: string;
    enterHint: string;
    translate: string;
    emptyClipboard: string;
    emptySource: string;
    tooLong: string;
    clipboard: (text: string) => string;
  };

  island: {
    appName: string;
    focusing: (taskTitle: string) => string;
    pendingTodos: (count: number) => string;
    openMusic: string;
    collapse: string;
    collapseIsland: string;
    minimizeToTray: string;
    resetPosition: string;
    resetPositionLabel: string;
    editor: string;
    todoList: string;
    music: string;
    clipboardHistory: string;
    layoutEditor: string;
    chat: string;
    video: string;
    plugins: string;
  };

  agent: {
    running: (provider: string) => string;
    failed: (provider: string) => string;
    stale: (provider: string) => string;
    idleOrDone: string;
    phase: {
      running: string;
      completed: string;
      failed: string;
      stale: string;
      idle: string;
    };
  };

  notebook: {
    sectionLabel: string;
    backToToday: string;
    saveToday: string;
    saveTodayMarkdown: string;
    reviewSaved: string;
    tasksTab: string;
    dailyTab: string;
    reviewTab: string;
    openDailyNote: string;
    backToTasks: string;
    notebookCards: string;
    twoColumnTimeline: string;
    openCount: (count: number) => string;
    addTaskFor: (date: string) => string;
    reviewTodos: string;
    addTaskHint: string;
    add: string;
    dailyPlaceholder: string;
    dailyNoteLabel: string;
  };

  archive: {
    noSavedLists: string;
    eyebrow: string;
    noTasks: string;
  };

  assistant: {
    clearAll: string;
    clearAllConfirm: string;
    clearAllHint: (count: number) => string;
    clearAllDone: (count: number) => string;
    panelHotkey: string;
    panelHotkeyHint: string;
    panelHotkeyRecording: string;
    panelHotkeyEmpty: string;
    panelHotkeySet: (shortcut: string) => string;
    panelHotkeyCleared: string;
    panelHotkeyModifierRequired: string;
  };

  petGifs: {
    title: string;
    subtitle: string;
    expression: string;
    count: (count: number) => string;
    add: string;
    addHint: string;
    empty: string;
    reorderHint: string;
    reorderFailed: string;
    delete: string;
    deleted: (count: number) => string;
    selectAll: string;
    selectAllHint: string;
    allSelected: string;
    pathLabel: string;
    reset: string;
    builtin: string;
    custom: string;
    addFailed: string;
    notGif: string;
    tooLarge: string;
    deleteFailed: string;
    order: (index: number) => string;
    expandWithCount: (count: number) => string;
    collapseWithCount: (count: number) => string;
    characterLabel: (name: string) => string;
    confirmTitle: string;
    confirmDeleteBuiltin: string;
    confirmDeleteFile: string;
    confirmCancel: string;
    confirmDelete: string;
    undo: string;
    restoreFailed: string;
    restoreNoCopy: string;
    restored: (name: string) => string;
    trashEntry: (count: number) => string;
    trashHint: string;
    trashRestore: string;
    trashMeta: (character: string, state: string) => string;
    states: Record<string, string>;
    /** 素材库总览（设置页）：只保留数字口径，详细说明在 docs/pet-characters.md。 */
    libraryTitle: string;
    libraryTotal: (count: number) => string;
    libraryGroup: (name: string, count: number) => string;
    librarySampled: (visible: number, pool: number) => string;
    /** 同框素材只在 duo 形象下可选（一行短注）。 */
    librarySharedOnly: string;
  };

  petLink: {
    label: string;
    hint: string;
    companionLines: string[];
    previewButton: string;
    previewHint: string;
    /** 随从气泡的可访问名（D7：UIA/读屏用，`台词：<文本>`）。 */
    bubbleAria: (line: string) => string;
    /** 双狗互动剧本（小鸡毛先说、小白回应，一问一答成对）。 */
    scenes: {
      pet: DuoScene;
      eating: DuoScene;
      cheerful: DuoScene;
      bongo: DuoScene;
      standup: DuoScene;
      night: DuoScene;
      welcome: DuoScene;
    };
  };

  /** 多屏放置：小狗 / Bongo 落在哪块显示器。 */
  screenPlacement: {
    title: string;
    hint: string;
    island: string;
    bongo: string;
    followLast: string;
    followIsland: string;
    primary: string;
    onlyOne: string;
    missing: string;
    resolution: (width: number, height: number, scale: number) => string;
    /** 「固定在桌面的标签页」会跟随小狗所在屏幕。 */
    pinnedFollows: string;
  };

/** 桌宠自我状态（体力/情绪/亲密/专注）：只影响待机轮播权重。 */
  petVitals: {
    title: string;
    hint: string;
    toggle: string;
    energy: string;
    mood: string;
    bond: string;
    focus: string;
    levels: {
      great: string;
      good: string;
      ok: string;
      low: string;
      tired: string;
      lonely: string;
      focused: string;
    };
    details: string;
    detailsHint: string;
    refresh: string;
    lastUpdate: (time: string) => string;
    pet: string;
    feed: string;
    off: string;
    privacy: string;
    focusing: string;
    thinking: string;
  };

  updateNotice: {
    available: (version: string) => string;
    body: string;
    install: string;
    later: string;
    downloading: (percent: number | null) => string;
    downloadingUnknown: string;
    installing: string;
    done: string;
    error: string;
    retry: string;
    errorDetail: (detail: string) => string;
    bubbleTitle: (version: string) => string;
    bubbleBody: string;
  };

  plugins: {
    title: string;
    subtitle: string;
    builtin: string;
    open: string;
    installPlaceholder: string;
    install: string;
    openDirectory: string;
    refresh: string;
    empty: string;
    emptyHint: string;
    actions: string;
    noActions: string;
    helpHover: string;
    run: string;
    running: string;
    remove: string;
    removeConfirm: string;
    enable: string;
    disable: string;
    disabled: string;
    installed: (name: string) => string;
    installFailed: string;
    loadFailed: string;
    security: string;
    openVideo: string;
    version: string;
    by: string;
  };

  music: {
    playerLabel: string;
    controlFailed: string;
    noMedia: string;
    unknownArtist: string;
    previous: string;
    previousTrack: string;
    play: string;
    pause: string;
    next: string;
    nextTrack: string;
    shuffle: string;
    repeatOne: string;
    repeatAll: string;
    repeatOff: string;
    seek: string;
    settingsTitle: string;
    settingsHint: string;
    openSettings: string;
    closeSettings: string;
    reorderSource: string;
    removeSource: string;
    noSources: string;
  };

  todo: {
    empty: string;
    emptyReview: string;
    complete: string;
    markIncomplete: string;
    /** Screen-reader label pairing an action with the task it targets. */
    actionOnTask: (action: string, taskTitle: string) => string;
    editTitle: string;
    start: string;
    stop: string;
    delete: string;
    deleteTask: (taskTitle: string) => string;
    reorder: string;
    reorderTask: (taskTitle: string) => string;
    elapsed: (elapsed: string) => string;
    reminderStartedTitle: string;
    reminderStartedBody: (taskTitle: string, minutes: number) => string;
    reminderTitle: string;
    reminderBody: (taskTitle: string, elapsed: string) => string;
  };

  diary: {
    title: string;
    empty: string;
    started: (taskTitle: string) => string;
    paused: (taskTitle: string, elapsed: string) => string;
    completed: (taskTitle: string, elapsed: string) => string;
    reopened: (taskTitle: string) => string;
    pet: (actionLabel: string) => string;
    petActions: {
      pet: string;
      eating: string;
      pickup: string;
      scared: string;
      sleeping: string;
      celebrate: string;
      chin: string;
      spin: string;
      play: string;
      hide: string;
      chase: string;
      peek: string;
      happy: string;
      relax: string;
      angry: string;
      cry: string;
      love: string;
      ride: string;
      bath: string;
      costume: string;
    };
  };

  clipboard: {
    title: string;
    favoriteCount: (count: number) => string;
    clear: string;
    confirmClear: string;
    clearHistory: string;
    segments: string;
    all: string;
    favorites: string;
    searchPlaceholder: string;
    searchLabel: string;
    clearSearch: string;
    emptyAll: string;
    emptyFavorites: string;
    emptySearch: string;
    copyBack: string;
    copy: string;
    copied: string;
    favorite: string;
    unfavorite: string;
    favoriteItem: string;
    unfavoriteItem: string;
    delete: string;
    confirmDelete: string;
    deleteItem: string;
    notePlaceholder: string;
    noteInputLabel: string;
    saveNote: string;
    cancelEdit: string;
    cancelEditNote: string;
    editNote: (note: string) => string;
    editNoteLabel: string;
    addNote: string;
    addNoteLabel: string;
    noteFallback: string;
  };

  settings: {
    messageReception: string;
    title: string;
    reset: string;

    project: {
      title: string;
      star: string;
      starHint: string;
      latestRelease: string;
      latestReleaseHint: string;
      openFailed: string;
      update: {
        title: string;
        hint: string;
        versionLabel: (version: string) => string;
        check: string;
        checking: string;
        upToDate: (version: string) => string;
        available: (version: string) => string;
        download: string;
        downloading: (percent: number) => string;
        downloadingUnknown: string;
        installing: string;
        done: string;
        error: string;
        errorDetail: (reason: string) => string;
        unavailable: string;
      };
    };

    language: {
      title: string;
      label: string;
    };

    appearance: {
      font: string;
      fontLabel: string;
      systemFont: string;
      pixelFont: string;
      title: string;
      classic: string;
      liquidGlass: string;
      glassStrength: string;
    };

    layout: {
      collapsedScale: string;
      expandedScale: string;
      showCollapsedText: string;
      showIdleTodoCount: string;
      title: string;
      opacity: string;
      marginY: string;
      tuckedVisibleHeight: string;
      launchAtStartup: string;
      showTitle: string;
      autoTuck: string;
      autoTuckSeconds: string;
      fullscreenAvoid: string;
      fullscreenAvoidTuck: string;
      fullscreenAvoidHide: string;
      fullscreenAvoidOff: string;
    };

    todo: {
      title: string;
      rotateTodos: string;
      rotationSeconds: string;
      reminderMinutes: string;
    };

    agent: {
      title: string;
      install: string;
      installing: string;
      installed: string;
      currentStatus: string;
      clearStatusFor: (provider: string) => string;
      clearing: string;
      clearStatus: string;
      scriptsDir: string;
    };

    clipboard: {
      title: string;
      enabled: string;
      captureImages: string;
      maxItems: string;
    };

    colors: {
      title: string;
      taskText: string;
      pulse: string;
      islandBackground: string;
      todoPaper: string;
      pulseBrightness: string;
    };

    presets: {
      title: string;
      saveCurrent: string;
      empty: string;
      nameLabel: string;
      defaultName: (index: number) => string;
      rename: string;
      defaultPreset: string;
      apply: string;
      delete: string;
      deleteNamed: (name: string) => string;
    };

    save: {
      title: string;
      folder: string;
      folderLabel: string;
      folderPlaceholder: string;
      saved: string;
      save: string;
    };
  };
  messagePreview: {
    label: string;
    hint: string;
  };
};
