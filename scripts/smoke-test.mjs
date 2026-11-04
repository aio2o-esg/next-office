// Next Office 기본 기능 자동 확인.
// 앱을 개발용 자동 시험 창구(NEXT_OFFICE_AUTOMATION=1)와 디버거를 켠 채 띄우고,
// 열기 → 편집 → Ctrl+S 저장 → HWPX 저장 → 미리보기 → PDF → 글꼴 → HWPX 열기 → 새 문서를 차례로 확인한다.
// 사용: npm run smoke [-- <작업 폴더> <HWP 샘플> <HWPX 샘플>]
// 샘플을 주지 않으면 npm run setup:studio가 받아 둔 rhwp 샘플을 쓴다.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samplesDir = join(appDir, ".cache", "rhwp", "samples");
const [
  workDir = mkdtempSync(join(tmpdir(), "next-office-smoke-")),
  hwpSample = join(samplesDir, "21868765_별표2_보건소_분장사무.hwp"),
  hwpxSample = join(samplesDir, "2025년 기부·답례품 실적 지자체 보고서_양식.hwpx"),
] = process.argv.slice(2);
for (const sample of [hwpSample, hwpxSample]) {
  if (!existsSync(sample)) {
    console.error(`샘플 문서가 없습니다: ${sample}\n먼저 npm run setup:studio를 실행하거나 샘플 경로를 넘기세요.`);
    process.exit(1);
  }
}
const require = createRequire(join(appDir, "package.json"));
const electronPath = require("electron");
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "통과" : "실패"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression, userGesture = false) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function findTarget(port, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find(predicate);
      if (target) return target;
    } catch {
      // 아직 디버거가 열리지 않았다. 잠시 뒤 다시 본다.
    }
    await sleep(300);
  }
  throw new Error(`port ${port}에서 대상을 찾지 못했습니다`);
}

async function waitFor(fn, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(400);
  }
  throw new Error(`기다림 시간 초과: ${label}`);
}

mkdirSync(workDir, { recursive: true });
const hwpPath = join(workDir, "시험문서.hwp");
copyFileSync(hwpSample, hwpPath);
const hwpxPath = join(workDir, "양식문서.hwpx");
copyFileSync(hwpxSample, hwpxPath);
const originalHwp = readFileSync(hwpPath);
const logPath = join(workDir, "electron.log");
const log = [];

const child = spawn(electronPath, [".", "--inspect=9230", "--remote-debugging-port=9231", hwpPath], {
  cwd: appDir,
  env: { ...process.env, NEXT_OFFICE_AUTOMATION: "1" },
});
child.stdout.on("data", (d) => log.push(d.toString()));
child.stderr.on("data", (d) => log.push(d.toString()));

let main;
let page;
try {
  const mainTarget = await findTarget(9230, (t) => t.type === "node");
  main = new Cdp(mainTarget.webSocketDebuggerUrl);
  await main.open();
  const auto = (call) => main.evaluate(`globalThis.nextOfficeAutomation.${call}`);

  // 1. 시작과 열기
  const opened = await waitFor(async () => {
    const s = await auto("state()");
    return s.rendererReady && !s.busy && s.doc.path ? s : null;
  }, "문서 열기", 90000);
  record("명령줄로 넘긴 HWP 문서를 연다", opened.doc.path === hwpPath, `${opened.title}`);
  record("메뉴가 만들어진다", opened.menus.length >= 3, opened.menus.map((m) => `${m.label}(${m.items.length})`).join(", "));
  await sleep(1500);
  await auto(`capture(${JSON.stringify(join(workDir, "01-opened.png"))})`);

  // 2. 편집
  const pageTarget = await findTarget(9231, (t) => t.type === "page" && t.url.includes("/app/index.html"));
  page = new Cdp(pageTarget.webSocketDebuggerUrl);
  await page.open();
  const rect = await page.evaluate(`(() => { const r = document.querySelector('#editor iframe').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const clickX = Math.round(rect.x + rect.w / 2);
  const clickY = Math.round(rect.y + rect.h * 0.45);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: clickX, y: clickY, button: "left", clickCount: 1 });
  }
  await sleep(500);
  const marker = "넥스트오피스시험입력";
  await page.send("Input.insertText", { text: marker });
  const dirtyState = await waitFor(async () => {
    const s = await auto("state()");
    return s.dirty ? s : null;
  }, "수정 표시", 10000).catch(() => null);
  record("글자를 입력하면 제목에 수정 표시(*)가 붙는다", Boolean(dirtyState), dirtyState?.title ?? "수정 표시 없음");
  await auto(`capture(${JSON.stringify(join(workDir, "02-edited.png"))})`);

  // 3. Ctrl+S 저장 (단축키)
  const beforeMtime = statSync(hwpPath).mtimeMs;
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 });
  }
  const savedByKey = await waitFor(async () => (statSync(hwpPath).mtimeMs !== beforeMtime ? true : null), "Ctrl+S 저장", 20000).catch(() => false);
  record("Ctrl+S로 같은 파일에 저장한다", savedByKey);
  if (!savedByKey) await auto("save()");
  await waitFor(async () => !(await auto("state()")).busy, "저장 끝", 30000);
  const bak = `${hwpPath}.bak`;
  record("처음 덮어쓸 때 원본을 .bak으로 남긴다", existsSync(bak) && readFileSync(bak).equals(originalHwp));
  const afterSave = await auto("state()");
  record("저장 뒤 수정 표시가 사라진다", !afterSave.dirty, afterSave.title);

  // 4. 저장한 파일을 엔진으로 다시 읽어 입력한 글자 확인
  const coreDir = join(appDir, "node_modules", "@rhwp", "core");
  const core = await import(new URL(`file:///${join(coreDir, "rhwp.js").replace(/\\/g, "/")}`).href);
  globalThis.measureTextWidth ??= (font, text) => text.length * 8;
  await core.default({ module_or_path: readFileSync(join(coreDir, "rhwp_bg.wasm")) });
  const savedDoc = new core.HwpDocument(new Uint8Array(readFileSync(hwpPath)));
  const check = { pages: savedDoc.pageCount(), hasMarker: savedDoc.getTextFileText().includes(marker) };
  savedDoc.free();
  record("저장한 HWP를 다시 읽으면 입력한 글자가 있다", check.hasMarker, `${check.pages}쪽`);

  // 5. HWPX로 다른 이름 저장
  const hwpxOut = join(workDir, "다른이름.hwpx");
  await auto(`saveTo(${JSON.stringify(hwpxOut)})`);
  const hwpxBytes = existsSync(hwpxOut) ? readFileSync(hwpxOut) : Buffer.alloc(0);
  record("HWPX 형식으로 다른 이름 저장한다", hwpxBytes[0] === 0x50 && hwpxBytes[1] === 0x4b, `${hwpxBytes.length}바이트`);

  // 6. 인쇄 미리보기
  await auto("preview()");
  const withPreview = await waitFor(async () => {
    const s = await auto("state()");
    return s.windows.length >= 2 && !s.busy ? s : null;
  }, "미리보기 창", 60000).catch(() => null);
  record("인쇄 미리보기 창이 열린다", Boolean(withPreview), withPreview?.windows.join(" | ") ?? "");
  if (withPreview) {
    await sleep(1500);
    await auto(`capture(${JSON.stringify(join(workDir, "03-preview.png"))}, 1)`);
  }

  // 7. PDF
  const pdfOut = join(workDir, "내보내기.pdf");
  await auto(`pdf(${JSON.stringify(pdfOut)})`);
  const pdfBytes = existsSync(pdfOut) ? readFileSync(pdfOut) : Buffer.alloc(0);
  const pdfPages = (pdfBytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  record("PDF로 내보낸다", pdfBytes.subarray(0, 4).toString() === "%PDF", `${pdfBytes.length}바이트, ${pdfPages}쪽, 문서 ${check.pages}쪽`);

  // 8. 글꼴: 도구 모음과 글자 모양 대화상자(글자를 고른 뒤)
  const bars = await page.evaluate(`(() => { const d = document.querySelector('#editor iframe').contentDocument; const g = (s) => { const el = d.querySelector(s); return el ? getComputedStyle(el).display : 'missing'; }; return { menuBar: g('#menu-bar'), iconToolbar: g('#icon-toolbar'), styleBar: g('#style-bar') }; })()`);
  record("편집기 도구 모음(글꼴·크기)이 보이고 편집기 메뉴 줄은 숨는다", bars.iconToolbar !== "none" && bars.styleBar !== "none" && bars.menuBar === "none", JSON.stringify(bars));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: clickX, y: clickY, button: "left", clickCount: 1 });
  }
  await sleep(300);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, modifiers: 8, key: "Home", code: "Home", windowsVirtualKeyCode: 36 });
  }
  await sleep(300);
  // 대화상자가 닫힐 때까지 끝나지 않는 호출이라 기다리지 않는다.
  main.evaluate(`globalThis.nextOfficeAutomation.command("format:char-shape")`)
    .catch((error) => console.error("[글자 모양 명령]", error.message));
  await sleep(2000);
  const dialogOpen = await page.evaluate(`Boolean(document.querySelector('#editor iframe').contentDocument.querySelector('.modal-overlay'))`);
  record("글자를 고르고 서식 › 글자 모양을 누르면 대화상자가 열린다", dialogOpen);
  await auto(`capture(${JSON.stringify(join(workDir, "04-char-shape.png"))})`);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }
  await sleep(800);

  // 9. PC 글꼴 사용 권한
  const fonts = await page.evaluate(`(async () => {
    const frame = document.querySelector('#editor iframe').contentWindow;
    if (typeof frame.queryLocalFonts !== 'function') return { supported: false };
    try { const list = await frame.queryLocalFonts(); return { supported: true, count: list.length, sample: list.slice(0, 3).map(f => f.fullName) }; }
    catch (e) { return { supported: true, error: String(e) }; }
  })()`, true);
  record("PC 글꼴 목록을 읽을 수 있다", Boolean(fonts.count), JSON.stringify(fonts));

  // 10. HWPX 열기, 새 문서
  await auto(`open(${JSON.stringify(hwpxPath)})`);
  const hwpxOpened = await waitFor(async () => {
    const s = await auto("state()");
    return s.doc.path === hwpxPath && !s.busy ? s : null;
  }, "HWPX 열기", 60000).catch(() => null);
  record("HWPX 문서를 연다", Boolean(hwpxOpened), hwpxOpened?.title ?? "");
  await sleep(1200);
  await auto(`capture(${JSON.stringify(join(workDir, "05-hwpx.png"))})`);
  await auto("newDocument()");
  const fresh = await auto("state()");
  record("새 문서를 만든다", fresh.doc.path === null && fresh.doc.name.startsWith("제목 없음"), fresh.title);
} catch (error) {
  record("시험 진행", false, error.message);
} finally {
  page?.close();
  if (main) {
    // 앱이 바로 끝나면서 디버거 연결이 끊겨 이 호출은 오류로 끝나는 것이 정상이다.
    await main.evaluate("process.exit(0)").catch((error) => console.log(`[앱 종료] ${error.message}`));
    main.close();
  }
  await sleep(1000);
  if (!child.killed) child.kill();
  writeFileSync(logPath, log.join(""));
  writeFileSync(join(workDir, "results.json"), JSON.stringify(results, null, 2));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n전체 ${results.length}개 중 통과 ${pass}개, 실패 ${results.length - pass}개`);
  console.log(`화면·로그: ${workDir}`);
  process.exitCode = pass === results.length ? 0 : 1;
}
