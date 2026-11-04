// 한글 문서 파일을 읽고 쓰는 일. Electron 없이 node에서 돌아야 한다(테스트가 직접 부른다).
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import CFB from "cfb";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const HWP_SIGNATURE = "HWP Document File";
const HWP3_SIGNATURE = "HWP Document File V3";
const HWP_FLAG_PASSWORD = 0x02;
const HWP_FLAG_DISTRIBUTION = 0x04;

function startsWithBytes(bytes, magic) {
  if (!bytes || bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * 바이트의 컨테이너로 형식을 판정한다. 한글 문서가 아니면 null.
 * "hwp3"은 한글 3.x 파일이다. 엔진이 읽을 수는 있지만 같은 형식으로 쓸 수 없어 다른 이름(HWP 5)으로만 저장한다.
 */
export function detectFormat(bytes) {
  if (startsWithBytes(bytes, OLE_MAGIC)) return "hwp";
  if (startsWithBytes(bytes, ZIP_MAGIC)) return "hwpx";
  if (bytes && bytes.length >= HWP3_SIGNATURE.length
    && Buffer.from(bytes.subarray(0, HWP3_SIGNATURE.length)).toString("latin1") === HWP3_SIGNATURE) {
    return "hwp3";
  }
  return null;
}

/** 파일 이름의 확장자로 형식을 정한다. 한글 확장자가 아니면 null. */
export function formatFromPath(filePath) {
  const ext = extname(filePath ?? "").toLowerCase();
  if (ext === ".hwp") return "hwp";
  if (ext === ".hwpx") return "hwpx";
  return null;
}

/** HWP(OLE) 파일 머리의 속성 비트를 읽는다. */
export function readHwpFlags(bytes) {
  const container = CFB.read(Buffer.from(bytes), { type: "buffer" });
  const entry = CFB.find(container, "FileHeader");
  if (!entry || !entry.content || entry.content.length < 40) {
    throw new Error("HWP 파일 머리(FileHeader)를 찾을 수 없습니다.");
  }
  const header = Buffer.from(entry.content);
  if (header.toString("latin1", 0, HWP_SIGNATURE.length) !== HWP_SIGNATURE) {
    throw new Error("HWP 파일 서명이 맞지 않습니다.");
  }
  const properties = header.readUInt32LE(36);
  return {
    password: (properties & HWP_FLAG_PASSWORD) !== 0,
    distribution: (properties & HWP_FLAG_DISTRIBUTION) !== 0,
  };
}

/** ZIP 안의 파일 하나를 꺼낸다. 없으면 null. */
export function readZipEntry(bytes, entryName) {
  const data = Buffer.from(bytes);
  const minEnd = Math.max(0, data.length - 0xffff - 22);
  let end = -1;
  for (let i = data.length - 22; i >= minEnd; i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP 목록 끝(EOCD)을 찾을 수 없습니다.");
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 목록이 깨졌습니다.");
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === entryName) {
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = data.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`지원하지 않는 ZIP 압축 방식(${method})입니다.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** HWPX가 암호로 보호돼 있는지 본다(manifest에 암호화 정보가 있으면 보호). */
export function readHwpxEncrypted(bytes) {
  const manifest = readZipEntry(bytes, "META-INF/manifest.xml");
  if (!manifest) return false;
  return /encryption-data/i.test(manifest.toString("utf8"));
}

/** 저장하면 안 되는 문서인지 판정한다. 보호된 문서를 그대로 쓰면 보호가 말없이 풀린다. */
export function checkProtection(bytes, format) {
  if (format === "hwp") {
    const flags = readHwpFlags(bytes);
    if (flags.password) return { protected: true, reason: "password" };
    if (flags.distribution) return { protected: true, reason: "distribution" };
    return { protected: false, reason: null };
  }
  if (format === "hwpx") {
    if (readHwpxEncrypted(bytes)) return { protected: true, reason: "password" };
    return { protected: false, reason: null };
  }
  if (format === "hwp3") {
    // 3.x 파일은 원본을 덮어쓰지 않고(다른 이름으로만 저장) 보호 비트도 읽지 않는다.
    return { protected: false, reason: null };
  }
  throw new Error(`알 수 없는 형식: ${format}`);
}

/** 원본을 보관할 경로. */
export function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

/**
 * 문서를 안전하게 쓴다.
 * - 경로의 확장자와 바이트의 컨테이너가 같은 형식일 때만 쓴다.
 * - 이번 실행에서 그 파일을 처음 덮어쓰기 전에 원본을 .bak으로 남긴다. 보관이 실패하면 쓰지 않는다.
 * - 임시 파일에 다 쓴 뒤 이름을 바꿔, 쓰다 멈춰도 원본이 반쯤 덮이지 않게 한다.
 */
export function writeDocumentSafely(filePath, bytes, backedUpPaths) {
  const expected = formatFromPath(filePath);
  if (!expected) throw new Error("확장자가 .hwp 또는 .hwpx여야 합니다.");
  const actual = detectFormat(bytes);
  if (actual !== expected) {
    throw new Error(`저장할 내용(${actual ?? "알 수 없음"})이 파일 형식(${expected})과 다릅니다.`);
  }
  let backupPath = null;
  if (existsSync(filePath) && !backedUpPaths.has(filePath)) {
    backupPath = backupPathFor(filePath);
    copyFileSync(filePath, backupPath);
    backedUpPaths.add(filePath);
  }
  const tempPath = `${filePath}.saving-${process.pid}`;
  try {
    writeFileSync(tempPath, bytes);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return { backupPath };
}
