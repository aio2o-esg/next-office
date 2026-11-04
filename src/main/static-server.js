// 편집기와 앱 화면을 내주는 로컬 HTTP 서버.
// rhwp 편집기와 SDK는 HTTP(S) 출처끼리만 연결되므로(file:은 거절), 127.0.0.1에서만 연다.
// 문서 내용은 이 서버를 거치지 않는다(앱 화면과 편집기 사이의 postMessage로 오간다).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

/** 요청 경로를 마운트된 폴더 안의 파일 경로로 바꾼다. 폴더 밖이면 null. */
export function resolveRequestPath(mounts, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  } catch {
    return null;
  }
  for (const [prefix, dir] of Object.entries(mounts)) {
    if (!pathname.startsWith(prefix)) continue;
    let rest = pathname.slice(prefix.length);
    if (rest === "" || rest.endsWith("/")) rest += "index.html";
    const full = normalize(join(dir, rest));
    const base = normalize(dir.endsWith(sep) ? dir : dir + sep);
    if (!full.startsWith(base)) return null;
    return full;
  }
  return null;
}

/** 서버를 열고 { origin, close }를 돌려준다. */
export function startStaticServer(mounts) {
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const file = resolveRequestPath(mounts, req.url ?? "/");
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") {
        res.writeHead(404).end();
        return;
      }
      console.error("[static-server]", error);
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
