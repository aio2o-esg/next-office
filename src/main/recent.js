// 최근 파일 목록. 앱 데이터 폴더의 JSON 파일 하나에 둔다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RECENT_LIMIT = 10;

export function loadRecent(storePath) {
  if (!existsSync(storePath)) return [];
  const parsed = JSON.parse(readFileSync(storePath, "utf8"));
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
}

export function saveRecent(storePath, list) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(list, null, 2), "utf8");
}

/** 맨 앞에 넣고, 같은 경로는 하나만 남기고, 개수를 제한한다. */
export function addRecent(list, filePath) {
  const key = filePath.toLowerCase();
  const rest = list.filter((item) => item.toLowerCase() !== key);
  return [filePath, ...rest].slice(0, RECENT_LIMIT);
}

export function removeRecent(list, filePath) {
  const key = filePath.toLowerCase();
  return list.filter((item) => item.toLowerCase() !== key);
}
