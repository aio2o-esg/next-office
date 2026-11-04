// 저장하기 전에 내보낸 바이트를 엔진으로 다시 읽어 본다. 읽지 못하는 파일은 쓰지 않는다.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import init, { HwpDocument } from "@rhwp/core";

let ready = null;

function ensureEngine() {
  if (!ready) {
    const require = createRequire(import.meta.url);
    const coreDir = dirname(require.resolve("@rhwp/core/package.json"));
    // 엔진은 조판 때 글자 폭을 묻는다. 여기서는 읽히는지만 보므로 대략값이면 된다.
    globalThis.measureTextWidth ??= (font, text) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      return text.length * size * 0.5;
    };
    ready = init({ module_or_path: readFileSync(join(coreDir, "rhwp_bg.wasm")) });
  }
  return ready;
}

/** 바이트가 한글 문서로 다시 읽히는지 확인하고 쪽 수를 돌려준다. 읽지 못하면 예외를 던진다. */
export async function verifyReadable(bytes) {
  await ensureEngine();
  let doc;
  try {
    doc = new HwpDocument(new Uint8Array(bytes));
  } catch (error) {
    throw new Error(`저장할 내용을 다시 읽지 못했습니다: ${error?.message ?? error}`);
  }
  try {
    return { pageCount: doc.pageCount() };
  } finally {
    doc.free();
  }
}
