import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import CFB from "cfb";
import {
  backupPathFor,
  checkProtection,
  detectFormat,
  formatFromPath,
  readZipEntry,
  writeDocumentSafely,
} from "../src/main/file-io.js";

const blankHwp = readFileSync(new URL("../assets/blank.hwp", import.meta.url));

function makeHwpWithFlags(properties) {
  const header = Buffer.alloc(256);
  header.write("HWP Document File", 0, "latin1");
  header.writeUInt32LE(0x05000000, 32);
  header.writeUInt32LE(properties, 36);
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, "FileHeader", header);
  return Buffer.from(CFB.write(container, { type: "buffer" }));
}

function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(body), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "next-office-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("컨테이너로 HWP와 HWPX를 구별하고, 한글 문서가 아니면 null이다", () => {
  assert.equal(detectFormat(blankHwp), "hwp");
  assert.equal(detectFormat(makeStoredZip({ mimetype: "application/hwp+zip" })), "hwpx");
  assert.equal(detectFormat(Buffer.from("HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05", "latin1")), "hwp3");
  assert.equal(detectFormat(Buffer.from("plain text")), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
});

test("확장자로 형식을 정하고 대소문자를 가리지 않는다", () => {
  assert.equal(formatFromPath("C:/문서/보고서.HWP"), "hwp");
  assert.equal(formatFromPath("보고서.hwpx"), "hwpx");
  assert.equal(formatFromPath("보고서.docx"), null);
});

test("빈 문서는 보호되지 않은 HWP다", () => {
  assert.deepEqual(checkProtection(blankHwp, "hwp"), { protected: false, reason: null });
});

test("암호 비트와 배포용 비트가 선 HWP는 저장하면 안 되는 문서다", () => {
  assert.deepEqual(checkProtection(makeHwpWithFlags(0x02), "hwp"), { protected: true, reason: "password" });
  assert.deepEqual(checkProtection(makeHwpWithFlags(0x04), "hwp"), { protected: true, reason: "distribution" });
  assert.deepEqual(checkProtection(makeHwpWithFlags(0x01), "hwp"), { protected: false, reason: null });
});

test("manifest에 암호화 정보가 있는 HWPX는 저장하면 안 되는 문서다", () => {
  const plain = makeStoredZip({ mimetype: "application/hwp+zip", "META-INF/manifest.xml": "<manifest/>" });
  const locked = makeStoredZip({
    mimetype: "application/hwp+zip",
    "META-INF/manifest.xml": "<manifest><encryption-data/></manifest>",
  });
  assert.deepEqual(checkProtection(plain, "hwpx"), { protected: false, reason: null });
  assert.deepEqual(checkProtection(locked, "hwpx"), { protected: true, reason: "password" });
  assert.equal(readZipEntry(plain, "mimetype").toString(), "application/hwp+zip");
  assert.equal(readZipEntry(plain, "없는 항목"), null);
});

test("처음 덮어쓸 때만 원본을 .bak으로 남기고 내용을 바꾼다", () => {
  withTempDir((dir) => {
    const target = join(dir, "보고서.hwp");
    writeFileSync(target, makeHwpWithFlags(0));
    const original = readFileSync(target);
    const backedUp = new Set();

    const first = writeDocumentSafely(target, blankHwp, backedUp);
    assert.equal(first.backupPath, backupPathFor(target));
    assert.deepEqual(readFileSync(first.backupPath), original);
    assert.deepEqual(readFileSync(target), blankHwp);

    const second = writeDocumentSafely(target, makeHwpWithFlags(0x01), backedUp);
    assert.equal(second.backupPath, null);
    assert.deepEqual(readFileSync(backupPathFor(target)), original);
  });
});

test("새 파일을 쓸 때는 .bak을 만들지 않는다", () => {
  withTempDir((dir) => {
    const target = join(dir, "새 문서.hwp");
    const result = writeDocumentSafely(target, blankHwp, new Set());
    assert.equal(result.backupPath, null);
    assert.equal(existsSync(backupPathFor(target)), false);
    assert.deepEqual(readFileSync(target), blankHwp);
  });
});

test("확장자와 내용 형식이 다르면 쓰지 않고 원본을 그대로 둔다", () => {
  withTempDir((dir) => {
    const target = join(dir, "보고서.hwpx");
    const original = makeStoredZip({ mimetype: "application/hwp+zip" });
    writeFileSync(target, original);
    assert.throws(() => writeDocumentSafely(target, blankHwp, new Set()), /파일 형식/);
    assert.deepEqual(readFileSync(target), original);
    assert.equal(existsSync(backupPathFor(target)), false);
    assert.throws(() => writeDocumentSafely(join(dir, "보고서.txt"), blankHwp, new Set()), /확장자/);
  });
});
