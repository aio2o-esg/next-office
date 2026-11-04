// 편집기 화면: rhwp 편집기를 embed 모드로 띄우고, 메인 프로세스의 요청(열기·내보내기·쪽 그림 등)을 처리한다.
import { createStudio } from "/sdk/index.js";

const api = window.nextOffice;
const noticeElement = document.getElementById("notice");
const loadingElement = document.getElementById("loading");
const DOCUMENT_FILE = /\.(hwpx?)$/i;

let studio = null;
let lastDirty = false;
const lastMenuStates = {};
let noticeTimer = null;

function showNotice(text, durationMs = 3500) {
  noticeElement.textContent = text;
  noticeElement.classList.add("show");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeElement.classList.remove("show"), durationMs);
}

function attachShortcutLabels(nodes, shortcutById) {
  return nodes.map((node) => ({
    ...node,
    shortcutLabel: node.commandId ? shortcutById.get(node.commandId) : undefined,
    submenu: node.submenu ? attachShortcutLabels(node.submenu, shortcutById) : undefined,
  }));
}

async function readMenus() {
  const [menus, commands] = await Promise.all([studio.commands.menuModel(), studio.commands.list()]);
  const shortcutById = new Map(commands.map((command) => [command.id, command.shortcutLabel]));
  for (const command of commands) lastMenuStates[command.id] = command.enabled;
  return menus.map((menu) => ({ ...menu, items: attachShortcutLabels(menu.items, shortcutById) }));
}

const handlers = {
  async load({ bytes, name, interactive }) {
    const result = await studio.loadFile(bytes, name, { skipUnsavedGuard: true, suppressDialogs: !interactive });
    lastDirty = false;
    return { pageCount: result.pageCount };
  },
  async export({ format }) {
    if (format === "hwp") {
      const verify = await studio.exportHwpVerify();
      const bytes = await studio.exportHwp();
      return { bytes, verify };
    }
    if (format === "hwpx") {
      return { bytes: await studio.exportHwpx(), verify: null };
    }
    throw new Error(`알 수 없는 저장 형식: ${format}`);
  },
  async saved({ name }) {
    await studio.notifySaved(name);
    lastDirty = false;
    return true;
  },
  async isDirty() {
    const context = await studio.commands.context();
    return Boolean(context.isDirty);
  },
  async pages() {
    const count = await studio.pageCount();
    const pages = [];
    for (let index = 0; index < count; index += 1) {
      pages.push(await studio.getPageSvg(index));
      if (count > 3) showNotice(`쪽을 모으는 중입니다… ${index + 1}/${count}`);
    }
    return pages;
  },
  async command({ id }) {
    return studio.commands.execute(id, {}, { allowDialog: true });
  },
  async notice({ text }) {
    showNotice(text);
    return true;
  },
};

api.onRequest(async ({ id, type, payload }) => {
  const handler = handlers[type];
  if (!handler) {
    api.respond(id, false, null, `모르는 요청입니다: ${type}`);
    return;
  }
  try {
    api.respond(id, true, await handler(payload));
  } catch (error) {
    console.error(`[${type}]`, error);
    api.respond(id, false, null, error?.message ?? String(error));
  }
});

function startPolling() {
  setInterval(async () => {
    try {
      const context = await studio.commands.context();
      const isDirty = Boolean(context.isDirty);
      if (isDirty !== lastDirty) {
        lastDirty = isDirty;
        api.setDirty(isDirty);
      }
    } catch (error) {
      console.error("[수정 여부 확인]", error);
    }
  }, 1000);

  setInterval(async () => {
    try {
      const commands = await studio.commands.list();
      const changes = {};
      for (const command of commands) {
        if (lastMenuStates[command.id] !== command.enabled) {
          lastMenuStates[command.id] = command.enabled;
          changes[command.id] = command.enabled;
        }
      }
      if (Object.keys(changes).length > 0) api.updateMenuState(changes);
    } catch (error) {
      console.error("[메뉴 상태 확인]", error);
    }
  }, 1500);
}

// 파일 단축키는 앱이 맡는다. 편집기(embed 모드)는 이 키들을 삼키기만 하므로, 편집기보다 먼저(창의 capture 단계) 받는다.
const SHORTCUTS = [
  { match: (e) => e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyS", action: "save" },
  { match: (e) => e.ctrlKey && !e.altKey && e.shiftKey && e.code === "KeyS", action: "saveAs" },
  { match: (e) => e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyO", action: "open" },
  { match: (e) => e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyP", action: "print" },
  { match: (e) => e.altKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyN", action: "new" },
];

function installShortcuts(target) {
  target.addEventListener("keydown", (event) => {
    const shortcut = SHORTCUTS.find((entry) => entry.match(event));
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) api.runAction(shortcut.action);
  }, true);
}

/** 한글 문서를 끌어다 놓으면 앱이 연다. 그림 같은 다른 파일은 편집기가 그대로 받는다. */
function installDocumentDrop(target) {
  target.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  }, true);
  target.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => DOCUMENT_FILE.test(file.name));
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const paths = files.map((file) => api.getPathForFile(file)).filter(Boolean);
    if (paths.length > 0) api.openPaths(paths);
    else showNotice("끌어 놓은 파일의 위치를 알 수 없습니다. 파일 › 열기로 여세요.");
  }, true);
}

/**
 * 편집기의 메뉴 줄만 숨긴다. 같은 메뉴를 앱의 메뉴 줄에 그대로 옮겨 두었기 때문이다.
 * 편집기의 chrome.menu=false는 머리 영역 전체(도구 상자·서식 도구 모음 포함)를 숨기므로 쓰지 않는다.
 */
function hideStudioMenuBar(frameDocument) {
  const style = frameDocument.createElement("style");
  style.textContent = "#menu-bar { display: none !important; }";
  frameDocument.head.append(style);
}

async function boot() {
  const studioUrl = new URL("/studio/index.html?chrome=embed", location.origin).href;
  studio = await createStudio("#editor", {
    studioUrl,
    chrome: { menu: true, toolbar: true, statusbar: true },
  });
  hideStudioMenuBar(studio.element.contentDocument);
  installShortcuts(window);
  installShortcuts(studio.element.contentWindow);
  installDocumentDrop(window);
  installDocumentDrop(studio.element.contentWindow);
  const menus = await readMenus();
  loadingElement.hidden = true;
  startPolling();
  api.ready({ menus });
}

boot().catch((error) => {
  console.error("[편집기 시작]", error);
  loadingElement.textContent = "편집기를 띄우지 못했습니다.";
  api.reportError(`편집기를 띄우지 못했습니다: ${error?.message ?? error}`);
});
