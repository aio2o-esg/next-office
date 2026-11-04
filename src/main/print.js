// 인쇄 미리보기, 인쇄, PDF 내보내기.
// 편집기가 그린 쪽 SVG를 쪽마다 제 용지 크기로 한 HTML에 담고, 그 HTML을 창에 띄워 인쇄하거나 PDF로 만든다.
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PX_PER_MM = 96 / 25.4;
const DEFAULT_PAGE_MM = { width: 210, height: 297 };

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readLength(value) {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*(px|mm|pt|in|cm)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] ?? "px").toLowerCase();
  const mm = { px: 1 / PX_PER_MM, mm: 1, pt: 25.4 / 72, in: 25.4, cm: 10 }[unit];
  return number * mm;
}

/** SVG 뿌리 요소의 크기를 mm로 읽는다. 크기를 알 수 없으면 A4로 본다. */
export function readSvgPageSize(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const width = readLength(/\swidth\s*=\s*"([^"]+)"/i.exec(root)?.[1]);
  const height = readLength(/\sheight\s*=\s*"([^"]+)"/i.exec(root)?.[1]);
  if (width && height) return { width, height };
  const viewBox = /\sviewBox\s*=\s*"([^"]+)"/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2] / PX_PER_MM, height: viewBox[3] / PX_PER_MM };
  }
  return { ...DEFAULT_PAGE_MM };
}

/** 용지 크기를 0.01mm 단위로 맞춘다(px→mm 환산의 긴 소수를 CSS에 그대로 쓰지 않게). */
function roundPaper(mm) {
  return Math.round(mm * 100) / 100;
}

function fitSvgToBox(svg) {
  return svg.replace(/<svg\b[^>]*>/i, (tag) =>
    tag
      .replace(/\swidth\s*=\s*"[^"]*"/i, "")
      .replace(/\sheight\s*=\s*"[^"]*"/i, "")
      .replace(/^<svg/i, '<svg width="100%" height="100%"'),
  );
}

/** 쪽 SVG 목록으로 인쇄용 HTML을 만든다. 쪽마다 제 용지 크기를 쓴다. */
export function buildPrintHtml({ title, pages }) {
  const pageRules = [];
  const pageBlocks = [];
  pages.forEach((svg, index) => {
    const size = readSvgPageSize(svg);
    const width = roundPaper(size.width);
    const height = roundPaper(size.height);
    pageRules.push(`@page p${index} { size: ${width}mm ${height}mm; margin: 0; }`);
    pageBlocks.push(
      `<section class="page" style="page: p${index}; width: ${width}mm; height: ${height}mm">${fitSvgToBox(svg)}</section>`,
    );
  });
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)} - 인쇄 미리보기</title>
<style>
  :root { --zoom: 1; }
  html, body { margin: 0; background: #e5e7eb; font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; }
  .toolbar { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #1f2937; color: #f9fafb; }
  .toolbar button { font: inherit; padding: 6px 12px; border: 0; border-radius: 6px; background: #374151; color: inherit; cursor: pointer; }
  .toolbar button.primary { background: #2563eb; }
  .toolbar .grow { flex: 1; }
  .pages { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px; zoom: var(--zoom); }
  .page { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); overflow: hidden; break-after: page; }
  .page svg { display: block; }
  ${pageRules.join("\n  ")}
  @media print {
    html, body { background: #fff; }
    .toolbar { display: none; }
    .pages { display: block; padding: 0; zoom: 1; }
    .page { box-shadow: none; margin: 0; }
    .page:last-child { break-after: auto; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <button class="primary" id="print">인쇄</button>
  <button id="pdf">PDF로 저장</button>
  <button id="zoom-out">축소</button>
  <span id="zoom-label">100%</span>
  <button id="zoom-in">확대</button>
  <span class="grow"></span>
  <span>${pages.length}쪽</span>
  <button id="close">닫기</button>
</div>
<main class="pages">
${pageBlocks.join("\n")}
</main>
</body>
</html>`;
}

function writeTempHtml(html) {
  const dir = mkdtempSync(join(tmpdir(), "next-office-print-"));
  const file = join(dir, "print.html");
  writeFileSync(file, html, "utf8");
  return { dir, file };
}

async function renderPdf(webContents) {
  return webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
}

async function savePdfWithDialog(parent, webContents, defaultPdfPath) {
  const choice = await dialog.showSaveDialog(parent, {
    title: "PDF로 저장",
    defaultPath: defaultPdfPath,
    filters: [{ name: "PDF 문서", extensions: ["pdf"] }],
  });
  if (choice.canceled || !choice.filePath) return null;
  const data = await renderPdf(webContents);
  writeFileSync(choice.filePath, data);
  return choice.filePath;
}

/** 인쇄 미리보기 창을 연다. autoPrint면 열리자마자 인쇄 대화상자를 띄운다. */
export function openPrintPreview({ parent, html, title, defaultPdfPath, preloadPath, autoPrint, onError }) {
  const { dir, file } = writeTempHtml(html);
  const win = new BrowserWindow({
    parent,
    width: 980,
    height: 900,
    title: `${title} - 인쇄 미리보기`,
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const contentsId = win.webContents.id;

  const runPrint = () => {
    win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
      if (!success && reason && reason !== "cancelled") onError("인쇄하지 못했습니다", reason);
    });
  };
  const onAction = async (event, action) => {
    if (event.sender.id !== contentsId) return;
    try {
      if (action === "print") runPrint();
      if (action === "close") win.close();
      if (action === "pdf") {
        const saved = await savePdfWithDialog(win, win.webContents, defaultPdfPath);
        if (saved) shell.showItemInFolder(saved);
      }
    } catch (error) {
      onError("미리보기 작업을 하지 못했습니다", error.message);
    }
  };
  ipcMain.on("preview:action", onAction);
  win.on("closed", () => {
    ipcMain.removeListener("preview:action", onAction);
    rmSync(dir, { recursive: true, force: true });
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadURL(pathToFileURL(file).href).then(() => {
    if (autoPrint) runPrint();
  }, (error) => onError("미리보기를 열지 못했습니다", error.message));
  return win;
}

/** 창을 보이지 않고 PDF 파일을 만든다. */
export async function exportPdf({ html, targetPath }) {
  const { dir, file } = writeTempHtml(html);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false },
  });
  try {
    await win.loadURL(pathToFileURL(file).href);
    const data = await renderPdf(win.webContents);
    writeFileSync(targetPath, data);
  } finally {
    win.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}
