// rhwp-studio(한글 편집 화면)를 고정된 rhwp 태그에서 빌드해 vendor/studio에 둔다.
// Rust 없이 npm의 사전 빌드 엔진(@rhwp/core)으로 편집기가 찾는 ../pkg 자리를 채운다.
// 빌드 결과는 저장소에 넣지 않는다(.gitignore). 처음 한 번 네트워크가 필요하다.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RHWP_REPO = "https://github.com/edwardkim/rhwp.git";
const RHWP_TAG = "v0.8.7";
const RHWP_COMMIT = "1a76570e833917d15817415a53c09ad61ab3203f";
const CORE_FILES = ["rhwp.js", "rhwp.d.ts", "rhwp_bg.wasm", "rhwp_bg.wasm.d.ts"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, ".cache", "rhwp");
const studioSource = join(source, "rhwp-studio");
const output = join(root, "vendor", "studio");
const isWindows = process.platform === "win32";

function runCommand(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", shell: isWindows, ...options });
}

function readCommit(dir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function fetchSource() {
  if (!existsSync(join(source, ".git"))) {
    mkdirSync(dirname(source), { recursive: true });
    runCommand("git", ["clone", "--depth", "1", "--branch", RHWP_TAG, RHWP_REPO, source]);
  }
  const commit = readCommit(source);
  if (commit !== RHWP_COMMIT) {
    throw new Error(`rhwp ${RHWP_TAG} 커밋이 다르다: 기대 ${RHWP_COMMIT}, 실제 ${commit}`);
  }
}

function placeCore() {
  const coreDir = join(root, "node_modules", "@rhwp", "core");
  if (!existsSync(join(coreDir, "rhwp_bg.wasm"))) {
    throw new Error("node_modules/@rhwp/core가 없다. 먼저 npm install을 실행한다.");
  }
  const pkgDir = join(source, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  for (const name of CORE_FILES) {
    cpSync(join(coreDir, name), join(pkgDir, name));
  }
}

function buildStudio() {
  if (!existsSync(join(studioSource, "node_modules"))) {
    runCommand("npm", ["ci", "--no-audit", "--no-fund"], { cwd: studioSource });
  }
  rmSync(output, { recursive: true, force: true });
  runCommand("npx", ["vite", "build", "--base=./", "--outDir", output, "--emptyOutDir"], {
    cwd: studioSource,
    env: {
      ...process.env,
      RHWP_DISABLE_EXTERNAL_WEBFONTS: "1",
      RHWP_WITHOUT_HWPCTRL: "1",
    },
  });
  if (!existsSync(join(output, "index.html"))) {
    throw new Error("편집기 빌드 결과에 index.html이 없다.");
  }
}

fetchSource();
placeCore();
buildStudio();
console.log(`편집기 빌드 완료: ${output}`);
