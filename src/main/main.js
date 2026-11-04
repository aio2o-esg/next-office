// Next Office 메인 프로세스: 창 하나, 메뉴, 파일 열기·저장, 인쇄, 닫기 전 확인.
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProtection, detectFormat, formatFromPath, writeDocumentSafely } from "./file-io.js";
import { buildPrintHtml, exportPdf, openPrintPreview } from "./print.js";
import { addRecent, loadRecent, removeRecent, saveRecent } from "./recent.js";
import { startStaticServer } from "./static-server.js";
import { verifyReadable } from "./verify.js";

const APP_NAME = "Next Office";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUDIO_DIR = join(ROOT, "vendor", "studio");
const BLANK_PATH = join(ROOT, "assets", "blank.hwp");
const UNTITLED = "제목 없음";
const HWP_FILTER = { name: "한글 문서 (*.hwp)", extensions: ["hwp"] };
const HWPX_FILTER = { name: "한글 문서 (*.hwpx)", extensions: ["hwpx"] };
const PROTECTION_TEXT = {
  password: "암호가 걸린 문서",
  distribution: "배포용 문서",
};

let mainWindow = null;
let server = null;
let recentStore = "";
let recentFiles = [];
let studioMenus = [];
let rendererReady = false;
let pendingOpenPath = null;
let forceClose = false;
let busy = false;
let dirty = false;
let doc = makeUntitledDoc();
const backedUpPaths = new Set();
const pendingRequests = new Map();
let nextRequestId = 1;

function makeUntitledDoc() {
  return { path: null, name: `${UNTITLED}.hwp`, format: "hwp", protectedReason: null, mustSaveAs: false };
}

// ─── 화면에 묻기 ─────────────────────────────

/** 렌더러(편집기 화면)에 일을 시키고 답을 기다린다. timeoutMs가 0이면 기다림 제한이 없다. */
function requestRenderer(type, payload = {}, timeoutMs = 120000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      rejectPromise(new Error("편집기 창이 없습니다."));
      return;
    }
    const id = nextRequestId++;
    const timer = timeoutMs
      ? setTimeout(() => {
          pendingRequests.delete(id);
          rejectPromise(new Error(`편집기가 응답하지 않습니다(${type}).`));
        }, timeoutMs)
      : null;
    pendingRequests.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    mainWindow.webContents.send("main:request", { id, type, payload });
  });
}

ipcMain.on("renderer:response", (event, { id, ok, result, error }) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const pending = pendingRequests.get(id);
  if (!pending) return;
  pendingRequests.delete(id);
  if (pending.timer) clearTimeout(pending.timer);
  if (ok) pending.resolve(result);
  else pending.reject(new Error(error ?? "알 수 없는 오류"));
});

// ─── 알림 ─────────────────────────────────

async function showError(message, detail = "") {
  console.error(`[${APP_NAME}] ${message}`, detail);
  await dialog.showMessageBox(mainWindow, { type: "error", title: APP_NAME, message, detail: String(detail) });
}

async function showInfo(message, detail = "") {
  await dialog.showMessageBox(mainWindow, { type: "info", title: APP_NAME, message, detail: String(detail) });
}

function showNotice(text) {
  requestRenderer("notice", { text }, 10000).catch((error) => console.error("[notice]", error));
}

function updateTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const mark = dirty ? "*" : "";
  const lock = doc.protectedReason ? ` [${PROTECTION_TEXT[doc.protectedReason]} · 저장 안 됨]` : "";
  mainWindow.setTitle(`${mark}${doc.name}${lock} - ${APP_NAME}`);
}

// ─── 일 하나씩만 ─────────────────────────────

async function runExclusive(task) {
  if (busy) return false;
  busy = true;
  try {
    return await task();
  } catch (error) {
    await showError("작업을 마치지 못했습니다", error.message);
    return false;
  } finally {
    busy = false;
  }
}

// ─── 최근 파일 ───────────────────────────────

function rememberRecent(filePath) {
  recentFiles = addRecent(recentFiles, filePath);
  persistRecent();
}

function forgetRecent(filePath) {
  recentFiles = removeRecent(recentFiles, filePath);
  persistRecent();
}

function persistRecent() {
  try {
    saveRecent(recentStore, recentFiles);
  } catch (error) {
    console.error("[recent] 최근 파일 목록을 저장하지 못했습니다", error);
  }
  buildMenu();
}

// ─── 문서 수명 ───────────────────────────────

/** 바뀐 내용이 있으면 저장할지 묻는다. 계속해도 되면 true. */
async function confirmDiscardOrSave() {
  let isDirty = dirty;
  try {
    isDirty = await requestRenderer("isDirty", {}, 10000);
  } catch (error) {
    console.error("[dirty] 편집기에 수정 여부를 묻지 못해 마지막으로 받은 값을 씁니다", error);
  }
  if (!isDirty) return true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: APP_NAME,
    message: `'${doc.name}'의 바뀐 내용을 저장할까요?`,
    detail: "저장하지 않으면 바뀐 내용을 잃습니다.",
    buttons: ["저장", "저장 안 함", "취소"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 2) return false;
  if (response === 1) return true;
  return saveDocument();
}

async function loadIntoEditor(bytes, name, interactive) {
  // 대화형으로 열면 편집기가 글꼴 감지 같은 안내창을 띄우고 사람의 답을 기다린다.
  return requestRenderer("load", { bytes, name, interactive }, interactive ? 0 : 120000);
}

async function newDocument() {
  if (!(await confirmDiscardOrSave())) return false;
  await loadIntoEditor(readFileSync(BLANK_PATH), `${UNTITLED}.hwp`, false);
  doc = makeUntitledDoc();
  dirty = false;
  updateTitle();
  return true;
}

async function openDocument(filePath) {
  let target = filePath;
  if (!target) {
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: "열기",
      defaultPath: doc.path ? dirname(doc.path) : app.getPath("documents"),
      filters: [{ name: "한글 문서", extensions: ["hwp", "hwpx"] }],
      properties: ["openFile"],
    });
    if (choice.canceled || choice.filePaths.length === 0) return false;
    target = choice.filePaths[0];
  }
  if (!(await confirmDiscardOrSave())) return false;

  let bytes;
  try {
    bytes = readFileSync(target);
  } catch (error) {
    if (error.code === "ENOENT") forgetRecent(target);
    await showError("파일을 열 수 없습니다", `${target}\n${error.message}`);
    return false;
  }
  const format = detectFormat(bytes);
  if (!format) {
    await showError("한글 문서가 아닙니다", `${target}\nHWP·HWPX 파일만 열 수 있습니다.`);
    return false;
  }
  let protection;
  try {
    protection = checkProtection(bytes, format);
  } catch (error) {
    await showError("문서 머리를 읽지 못했습니다", `${target}\n${error.message}`);
    return false;
  }

  const result = await loadIntoEditor(bytes, basename(target), true);
  doc = {
    path: target,
    name: basename(target),
    format,
    protectedReason: protection.protected ? protection.reason : null,
    mustSaveAs: format === "hwp3" || formatFromPath(target) !== format,
  };
  dirty = false;
  updateTitle();
  rememberRecent(target);
  showNotice(`${result?.pageCount ?? "?"}쪽 문서를 열었습니다.`);
  if (doc.protectedReason) {
    await showInfo(
      `${PROTECTION_TEXT[doc.protectedReason]}입니다`,
      "보고 고칠 수는 있지만 저장하지 않습니다. 그대로 저장하면 문서의 보호가 말없이 풀리기 때문입니다.",
    );
  } else if (format === "hwp3") {
    await showInfo("한글 3.x 문서입니다", "같은 형식으로는 저장할 수 없어, 저장할 때 다른 이름의 HWP(5.0) 파일로 저장합니다. 원본은 그대로 둡니다.");
  } else if (doc.mustSaveAs) {
    await showInfo("확장자와 실제 형식이 다릅니다", `실제 형식은 ${format.toUpperCase()}입니다. 저장할 때 다른 이름으로 저장합니다.`);
  }
  return true;
}

/** 지금 문서를 target 경로에 format 형식으로 쓴다. */
async function writeCurrentDocument(target, format) {
  if (doc.protectedReason) {
    await showError(
      `${PROTECTION_TEXT[doc.protectedReason]}는 저장하지 않습니다`,
      "그대로 저장하면 문서의 보호가 말없이 풀립니다. 원본 프로그램에서 보호를 푼 뒤 여세요.",
    );
    return false;
  }
  const exported = await requestRenderer("export", { format }, 180000);
  const bytes = Buffer.from(exported.bytes);
  if (exported.verify && exported.verify.recovered === false) {
    await showError(
      "저장 전 확인에서 멈췄습니다",
      `내보낸 문서를 다시 읽었더니 쪽수가 다릅니다(${exported.verify.pageCountBefore}쪽 → ${exported.verify.pageCountAfter}쪽). 파일을 건드리지 않았습니다.`,
    );
    return false;
  }
  await verifyReadable(bytes);
  const { backupPath } = writeDocumentSafely(target, bytes, backedUpPaths);
  try {
    await requestRenderer("saved", { name: basename(target) }, 30000);
  } catch (error) {
    // 파일은 이미 저장됐다. 편집기의 "수정됨" 표시만 남을 수 있으므로 기록하고 넘어간다.
    console.error("[saved] 편집기에 저장 완료를 알리지 못했습니다", error);
  }
  doc = { ...doc, path: target, name: basename(target), format, mustSaveAs: false };
  dirty = false;
  updateTitle();
  rememberRecent(target);
  showNotice(backupPath ? `저장했습니다. 원본은 ${basename(backupPath)}로 보관했습니다.` : "저장했습니다.");
  return true;
}

async function saveDocument() {
  if (!doc.path || doc.mustSaveAs) return saveDocumentAs();
  return writeCurrentDocument(doc.path, doc.format);
}

async function saveDocumentAs() {
  const saveFormat = doc.format === "hwpx" ? "hwpx" : "hwp";
  const baseName = doc.name.replace(/\.(hwpx?|bak)$/i, "");
  const defaultDir = doc.path ? dirname(doc.path) : app.getPath("documents");
  const suffix = doc.format === "hwp3" ? "-변환" : "";
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: "다른 이름으로 저장",
    defaultPath: join(defaultDir, `${baseName}${suffix}.${saveFormat}`),
    filters: saveFormat === "hwpx" ? [HWPX_FILTER, HWP_FILTER] : [HWP_FILTER, HWPX_FILTER],
  });
  if (choice.canceled || !choice.filePath) return false;
  let target = choice.filePath;
  let format = formatFromPath(target);
  if (!format) {
    target = `${target}.${saveFormat}`;
    format = saveFormat;
  }
  if (doc.format === "hwp3" && doc.path && resolve(target).toLowerCase() === resolve(doc.path).toLowerCase()) {
    await showError("원본 3.x 파일은 덮어쓰지 않습니다", "다른 이름을 고르세요.");
    return false;
  }
  return writeCurrentDocument(target, format);
}

// ─── 인쇄 ─────────────────────────────────

async function collectPrintHtml() {
  const pages = await requestRenderer("pages", {}, 600000);
  if (!pages || pages.length === 0) throw new Error("인쇄할 쪽이 없습니다.");
  return buildPrintHtml({ title: doc.name, pages });
}

function defaultPdfPath() {
  const base = doc.name.replace(/\.(hwpx?)$/i, "");
  return join(doc.path ? dirname(doc.path) : app.getPath("documents"), `${base}.pdf`);
}

async function showPrintPreview(autoPrint) {
  showNotice("쪽을 모으는 중입니다…");
  const html = await collectPrintHtml();
  openPrintPreview({
    parent: mainWindow,
    html,
    title: doc.name,
    defaultPdfPath: defaultPdfPath(),
    preloadPath: join(ROOT, "src", "preview-preload.cjs"),
    autoPrint,
    onError: (message, detail) => showError(message, detail),
  });
  return true;
}

/** PDF로 내보낸다. targetPath가 없으면 저장 위치를 묻는다. */
async function exportCurrentPdf(targetPath) {
  let target = targetPath;
  if (!target) {
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: "PDF로 내보내기",
      defaultPath: defaultPdfPath(),
      filters: [{ name: "PDF 문서", extensions: ["pdf"] }],
    });
    if (choice.canceled || !choice.filePath) return false;
    target = choice.filePath;
  }
  showNotice("PDF를 만드는 중입니다…");
  const html = await collectPrintHtml();
  await exportPdf({ html, targetPath: target });
  showNotice(`PDF로 내보냈습니다: ${basename(target)}`);
  if (!targetPath) shell.showItemInFolder(target);
  return true;
}

// ─── 편집기 명령 ─────────────────────────────

async function runStudioCommand(commandId) {
  const result = await requestRenderer("command", { id: commandId }, 0);
  if (result && result.ok === false && result.reason !== "disabled") {
    showNotice(`이 명령을 지금 쓸 수 없습니다(${result.reason}).`);
  }
  return result;
}

// ─── 메뉴 ─────────────────────────────────

const ACTIONS = {
  new: () => runExclusive(newDocument),
  open: () => runExclusive(() => openDocument(null)),
  save: () => runExclusive(saveDocument),
  saveAs: () => runExclusive(saveDocumentAs),
  preview: () => runExclusive(() => showPrintPreview(false)),
  print: () => runExclusive(() => showPrintPreview(true)),
  pdf: () => runExclusive(() => exportCurrentPdf(null)),
};

const SIMPLE_ACCELERATOR = /^((Ctrl|Alt|Shift)\+)+([A-Z0-9]|F\d{1,2}|Delete|Insert|Home|End|PageUp|PageDown|Enter|Tab|Space|Backspace|Esc|Up|Down|Left|Right)$/i;

function toMenuItem(node) {
  if (!node.label || node.label === "-" || node.separator) return { type: "separator" };
  if (node.submenu?.length) {
    return { label: node.label, submenu: node.submenu.map(toMenuItem) };
  }
  if (!node.commandId) return { label: node.label, enabled: false };
  const item = {
    id: `studio:${node.commandId}`,
    label: node.label,
    enabled: node.enabled !== false,
    click: () => runStudioCommand(node.commandId).catch((error) => showError("명령을 실행하지 못했습니다", error.message)),
  };
  if (node.shortcutLabel && SIMPLE_ACCELERATOR.test(node.shortcutLabel)) {
    item.accelerator = node.shortcutLabel;
    item.registerAccelerator = false;
  }
  return item;
}

function buildMenu() {
  const recentItems = recentFiles.length
    ? [
        ...recentFiles.map((filePath) => ({ label: filePath, click: () => runExclusive(() => openDocument(filePath)) })),
        { type: "separator" },
        { label: "목록 지우기", click: () => { recentFiles = []; persistRecent(); } },
      ]
    : [{ label: "(없음)", enabled: false }];
  const studioFile = studioMenus.find((menu) => menu.menuId === "file");
  const studioFileItems = (studioFile?.items ?? []).map(toMenuItem);
  const template = [
    {
      label: "파일(&F)",
      submenu: [
        { label: "새 문서", accelerator: "Alt+N", registerAccelerator: false, click: ACTIONS.new },
        { label: "열기…", accelerator: "Ctrl+O", registerAccelerator: false, click: ACTIONS.open },
        { label: "최근 파일", submenu: recentItems },
        { type: "separator" },
        { label: "저장", accelerator: "Ctrl+S", registerAccelerator: false, click: ACTIONS.save },
        { label: "다른 이름으로 저장…", accelerator: "Ctrl+Shift+S", registerAccelerator: false, click: ACTIONS.saveAs },
        { type: "separator" },
        { label: "인쇄 미리보기", click: ACTIONS.preview },
        { label: "인쇄…", accelerator: "Ctrl+P", registerAccelerator: false, click: ACTIONS.print },
        { label: "PDF로 내보내기…", click: ACTIONS.pdf },
        ...(studioFileItems.length ? [{ type: "separator" }, ...studioFileItems] : []),
        { type: "separator" },
        { label: "끝내기", role: "quit" },
      ],
    },
    ...studioMenus.filter((menu) => menu.menuId !== "file").map((menu) => ({
      label: menu.label,
      submenu: menu.items.map(toMenuItem),
    })),
    {
      label: "도움말(&H)",
      submenu: [
        { label: `${APP_NAME} 정보`, click: () => showAbout() },
        { type: "separator" },
        { label: "개발자 도구", accelerator: "Ctrl+Shift+I", click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateMenuState(states) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const [commandId, enabled] of Object.entries(states)) {
    const item = menu.getMenuItemById(`studio:${commandId}`);
    if (item) item.enabled = enabled;
  }
}

async function showAbout() {
  await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: `${APP_NAME} 정보`,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      "한컴오피스 없이 HWP·HWPX 문서를 열고 고친 뒤 연 형식 그대로 저장합니다.",
      "",
      "한글 편집 화면과 엔진: rhwp 0.8.7 (MIT, Edward Kim) — https://github.com/edwardkim/rhwp",
      `Electron ${process.versions.electron}`,
      "",
      "본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.",
    ].join("\n"),
  });
}

// ─── 창 ───────────────────────────────────

function findDocumentArg(argv) {
  return argv.slice(1).find((arg) => formatFromPath(arg) && existsSync(arg)) ?? null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: APP_NAME,
    show: false,
    webPreferences: {
      preload: join(ROOT, "src", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  updateTitle();

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${server.origin}/app/`)) event.preventDefault();
  });
  contents.on("render-process-gone", (_event, details) => {
    showError("편집기 화면이 멈췄습니다", `이유: ${details.reason}. 저장하지 않은 내용은 잃었을 수 있습니다.`);
  });

  mainWindow.on("close", (event) => {
    if (forceClose) return;
    event.preventDefault();
    runExclusive(async () => {
      if (await confirmDiscardOrSave()) {
        forceClose = true;
        mainWindow.close();
      }
      return true;
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${server.origin}/app/index.html`);
}

ipcMain.on("renderer:ready", async (event, info) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  rendererReady = true;
  studioMenus = info?.menus ?? [];
  buildMenu();
  const startPath = pendingOpenPath;
  pendingOpenPath = null;
  if (startPath) await runExclusive(() => openDocument(startPath));
  else await runExclusive(newDocument);
});

ipcMain.on("renderer:dirty", (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  dirty = Boolean(value);
  updateTitle();
});

ipcMain.on("renderer:menu-state", (event, states) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  updateMenuState(states);
});

ipcMain.on("renderer:action", (event, action) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (Object.hasOwn(ACTIONS, action)) ACTIONS[action]();
});

ipcMain.on("renderer:open-paths", (event, paths) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const first = (paths ?? []).find((p) => typeof p === "string" && formatFromPath(p));
  if (first) runExclusive(() => openDocument(first));
});

ipcMain.on("renderer:error", (event, message) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  showError("편집기에서 문제가 생겼습니다", message);
});

// ─── 개발용 자동 시험 창구 ───────────────────────
// NEXT_OFFICE_AUTOMATION=1로 켤 때만 생긴다. 시험 스크립트가 --inspect로 붙어 대화상자 없이 기능을 부른다.

function readMenuLabels() {
  const menu = Menu.getApplicationMenu();
  return (menu?.items ?? []).map((item) => ({
    label: item.label,
    items: (item.submenu?.items ?? []).filter((sub) => sub.type !== "separator").map((sub) => sub.label),
  }));
}

if (process.env.NEXT_OFFICE_AUTOMATION === "1") {
  globalThis.nextOfficeAutomation = {
    state: () => ({
      doc: { ...doc },
      dirty,
      busy,
      rendererReady,
      title: mainWindow?.getTitle() ?? null,
      menus: readMenuLabels(),
      windows: BrowserWindow.getAllWindows().map((win) => win.getTitle()),
    }),
    open: (filePath) => runExclusive(() => openDocument(filePath)),
    newDocument: () => runExclusive(newDocument),
    save: () => runExclusive(saveDocument),
    saveTo: (filePath) => runExclusive(() => writeCurrentDocument(filePath, formatFromPath(filePath))),
    preview: () => runExclusive(() => showPrintPreview(false)),
    pdf: (filePath) => runExclusive(() => exportCurrentPdf(filePath)),
    command: (commandId) => runStudioCommand(commandId),
    capture: async (filePath, windowIndex = 0) => {
      const win = windowIndex === 0 ? mainWindow : BrowserWindow.getAllWindows().find((w) => w !== mainWindow);
      const image = await win.webContents.capturePage();
      writeFileSync(filePath, image.toPNG());
      return filePath;
    },
  };
}

// ─── 앱 시작 ─────────────────────────────────

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 편집기가 PC에 설치된 글꼴을 읽을 수 있게 한다(우리 로컬 서버 출처만). 다른 권한은 모두 거절한다. */
function allowLocalFonts(origin) {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === "local-fonts" && originOf(details?.requestingUrl ?? "") === origin);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permission === "local-fonts" && originOf(requestingOrigin) === origin,
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingOpenPath = findDocumentArg(process.argv);

  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const filePath = findDocumentArg(argv);
    if (filePath && rendererReady) runExclusive(() => openDocument(filePath));
  });

  app.whenReady().then(async () => {
    if (!existsSync(join(STUDIO_DIR, "index.html"))) {
      dialog.showErrorBox(APP_NAME, "편집기 빌드가 없습니다. 먼저 `npm run setup:studio`를 실행하세요.");
      app.quit();
      return;
    }
    recentStore = join(app.getPath("userData"), "recent-files.json");
    try {
      recentFiles = loadRecent(recentStore);
    } catch (error) {
      console.error("[recent] 최근 파일 목록을 읽지 못해 빈 목록으로 시작합니다", error);
      recentFiles = [];
    }
    server = await startStaticServer({
      "/app/": join(ROOT, "src", "renderer"),
      "/studio/": STUDIO_DIR,
      "/sdk/": join(ROOT, "node_modules", "@rhwp", "editor"),
    });
    allowLocalFonts(server.origin);
    buildMenu();
    createWindow();
  });

  app.on("window-all-closed", async () => {
    await server?.close();
    app.quit();
  });
}
