// 새 문서의 출발점인 빈 한글 문서(assets/blank.hwp)를 rhwp 엔진으로 만든다.
// rhwp를 올려 엔진의 빈 문서가 달라지면 이 스크립트를 다시 돌린다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import init, { HwpDocument } from "@rhwp/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "node_modules", "@rhwp", "core", "rhwp_bg.wasm");
const outPath = join(root, "assets", "blank.hwp");

// 엔진은 조판 때 글자 폭을 묻는다. 빈 문서에는 글자가 없어 대략값이면 된다.
globalThis.measureTextWidth = (font, text) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
  return text.length * size * 0.5;
};

await init({ module_or_path: readFileSync(wasmPath) });
const doc = HwpDocument.createEmpty();
doc.createBlankDocument();
const bytes = doc.exportHwp();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);
console.log(`빈 문서 ${bytes.length}바이트, ${doc.pageCount()}쪽: ${outPath}`);
