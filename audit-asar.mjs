#!/usr/bin/env node
/**
 * audit-asar —— 不依赖运行中服务的 DSH 插件失效审计（升级后专用）。
 *
 * 与同目录 audit.mjs 的区别：audit.mjs 从**运行中的 DSH** 抓 bundle（需要
 * dsh-mobile-access 网关开启）；本脚本直接读桌面端的 app.asar —— 那正是内核
 * 发给浏览器的同一份客户端 bundle（`window.__ModuleLoader__.load({id, factory})`
 * 格式），因此离线可用、结果等价。
 *
 * 它检查的失效类型：插件硬编码了 DSH 客户端 CSS Module 的哈希类名
 * （形如 ZTP-Xa_frame / nUhMVa_act）。DSH 每次重建 Web 资源都会整批更换前缀，
 * 这类插件会被正常加载、控制台无报错，但 UI 整块不渲染。
 *
 * 用法：
 *   node audit-asar.mjs --dump [名字]        # 导出当前 DSH 的真实类名快照
 *   node audit-asar.mjs --diff <旧快照>      # 对比快照：哪些类名消失、旧前缀映射到哪个新前缀
 *   node audit-asar.mjs --check <文件>       # 校验单个文件引用的类名是否仍存在
 *   node audit-asar.mjs                      # 审计所有 profile 的插件（需至少一份快照）
 *
 * 判据（--check / 审计）：插件引用的类名若「在旧快照里存在、在当前 DSH 里不存在、
 * 且不是插件自身内联定义的」→ 确定失效。插件自带的 CSS Module 类名会被自动排除，
 * 因此自带样式、自己内联 CSS Module 的插件不会误报。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = path.join(HERE, "snapshots");
/**
 * 桌面端 app.asar 的位置：`DSH_ASAR` 环境变量或 `--asar <路径>` 显式指定，
 * 其次自动探测 macOS 的默认安装位置。Windows 安装位置因发行方式而异，不做猜测，
 * 拿不到时给出可操作的指引。
 */
let asarCache;
function requireAsar() {
  if (asarCache) return asarCache;
  const candidates = [
    process.env.DSH_ASAR,
    flagVal("--asar"),
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) { asarCache = p; return p; } } catch { /* 试下一个 */ }
  }
  console.error("找不到桌面端的 app.asar。用 DSH_ASAR 环境变量或 --asar <路径> 指定它，");
  console.error("路径就是桌面端安装目录下的 resources/app.asar。");
  console.error("若 DSH 是 npm 全局安装、没有 Electron 桌面端，请改用 audit.mjs（运行中模式）。");
  process.exit(1);
}
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const args = process.argv.slice(2);
const flagVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

// ---------- asar 读取 ----------
function openAsar(archive) {
  const fd = fs.openSync(archive, "r");
  const probe = Buffer.alloc(256);
  fs.readSync(fd, probe, 0, 256, 0);
  const declared = probe.readUInt32LE(4); // pickle: [payloadSize][headerLen]
  let jsonStart = -1;
  for (let i = 4; i < 64; i++) if (probe[i] === 0x7b && probe[i + 1] === 0x22) { jsonStart = i; break; }
  if (jsonStart < 0) throw new Error("asar header 起点未找到");
  const jsonLen = declared - 8; // 实测 header JSON 比声明长度少 8（前面还有 8 字节 pickle 尾巴）
  const hb = Buffer.alloc(jsonLen);
  fs.readSync(fd, hb, 0, jsonLen, jsonStart);
  const header = JSON.parse(hb.toString("utf8"));
  const dataBase = 8 + declared;
  const files = [];
  (function walk(node, dir) {
    for (const [name, val] of Object.entries(node.files || {})) {
      const p = dir ? dir + "/" + name : name;
      if (val.files) walk(val, p);
      else if (!val.link) files.push({ p, size: val.size, offset: Number(val.offset) });
    }
  })(header, "");
  return {
    files,
    read(f) { const b = Buffer.alloc(f.size); fs.readSync(fd, b, 0, f.size, dataBase + f.offset); return b.toString("utf8"); },
    close() { fs.closeSync(fd); },
  };
}
const deEscape = (s) => s.replace(/\\{1,2}([0-9a-fA-F]{1,6})[ \t]?/g, (m, h) => { const cp = parseInt(h, 16); return cp >= 32 && cp < 127 ? String.fromCharCode(cp) : m; });
const normModule = (k) => k.replace(/\\/g, "/").replace(/^.*?(packages|extensions)\//, "");
const sufOf = (n) => n.slice(n.lastIndexOf("_") + 1);

/** DSH 的 CSS Module 类名判据。哈希前缀是 base62 混合串，所以要么前缀含大写
 *  （`ZTP-Xa_frame`、`nUhMVa_act`），要么整个类名带数字（`_markdown_kcgor_5`），
 *  要么后缀是驼峰（`glcmna_visuallyHidden`）。
 *  排除 `__内部标记`、`PURE_UPPER_CONST`、以及 `node_modules` / `file_path`
 *  这类「全小写前缀 + 全小写后缀」的普通标识符。 */
const looksLikeDshClass = (n) => {
  if (n.startsWith("__")) return false;
  const cut = n.lastIndexOf("_");
  const pre = n.slice(0, cut);
  const suf = n.slice(cut + 1);
  if (!pre) return false;
  const bare = pre.replace(/^_+/, "");
  if (!/[a-z]/.test(bare)) return false; // REQUIRED / DSH / MNEMON 这类全大写常量
  if (!/[A-Za-z]/.test(bare)) return false;
  return /[A-Z]/.test(bare) || /\d/.test(n) || /[A-Z]/.test(suf);
};

/** 当前 DSH 的真实「CSS Module 源文件 → 类名」映射 */
function currentClassmap() {
  const a = openAsar(requireAsar());
  const targets = a.files.filter((f) =>
    /@deepseek-ai\/dsh-client-[^/]+\/lib\/client\.js$/.test(f.p) || /dsh-web-frontend\/dist\/assets\/index-[^/]+\.(js|css)$/.test(f.p));
  const out = {};
  for (const f of targets) {
    const text = deEscape(a.read(f));
    const marks = [...text.matchAll(/\/\/#region \\0dsh-css:([^\n]+)/g)];
    if (!marks.length) {
      if (f.p.endsWith(".css")) {
        const s = new Set();
        for (const m of text.matchAll(/\.([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)(?=[{,:> \n+\[])/g)) s.add(m[1]);
        if (s.size) out["web-shell/assets/index.css"] = [...s].sort();
      }
      continue;
    }
    for (let k = 0; k < marks.length; k++) {
      const body = text.slice(marks[k].index, k + 1 < marks.length ? marks[k + 1].index : text.length);
      const s = new Set();
      for (const m of body.matchAll(/\.([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)(?=[{,:> \n+\[])/g)) s.add(m[1]);
      for (const m of body.matchAll(/"([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)"\s*[,:}\]]/g)) s.add(m[1]);
      for (const m of body.matchAll(/=\s*"([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)"/g)) s.add(m[1]);
      if (s.size) { const key = normModule(marks[k][1].trim()); out[key] = [...new Set([...(out[key] || []), ...s])].sort(); }
    }
  }
  a.close();
  return out;
}
const flatten = (map) => { const s = new Set(); for (const v of Object.values(map)) for (const n of v) s.add(n); return s; };

// ---------- 快照 ----------
function latestSnapshot() {
  if (!fs.existsSync(SNAP_DIR)) return null;
  const list = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith(".json")).sort();
  return list.length ? path.join(SNAP_DIR, list[list.length - 1]) : null;
}
const loadSnap = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------- 子命令 ----------
function cmdDump() {
  const name = args[args.indexOf("--dump") + 1] && !args[args.indexOf("--dump") + 1].startsWith("--")
    ? args[args.indexOf("--dump") + 1] : `dsh-${new Date().toISOString().slice(0, 10)}`;
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const map = currentClassmap();
  const file = path.join(SNAP_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(map, null, 1));
  console.log(`快照：${file}`);
  console.log(`  ${Object.keys(map).length} 个模块，${flatten(map).size} 个类名`);
}

function cmdDiff(oldPath) {
  const oldMap = loadSnap(oldPath);
  const newMap = currentClassmap();
  const o = flatten(oldMap), n = flatten(newMap);
  const gone = [...o].filter((x) => !n.has(x)).sort();
  const added = [...n].filter((x) => !o.has(x)).sort();
  console.log(`旧 ${o.size} → 新 ${n.size}：消失 ${gone.size}，新增 ${added.size}\n`);

  // 按「旧模块内同后缀」推断前缀映射
  const oldBySuffix = new Map();
  for (const [mod, names] of Object.entries(oldMap)) for (const x of names) oldBySuffix.set(`${normModule(mod)}|${sufOf(x)}`, x);
  const newBySuffix = new Map();
  for (const [mod, names] of Object.entries(newMap)) for (const x of names) {
    const k = `${normModule(mod)}|${sufOf(x)}`;
    if (!newBySuffix.has(k)) newBySuffix.set(k, x);
  }
  const prefixPairs = new Map();
  for (const [k, oldName] of oldBySuffix) {
    const newName = newBySuffix.get(k);
    if (!newName || newName === oldName) continue;
    const op = oldName.slice(0, oldName.lastIndexOf("_"));
    const np = newName.slice(0, newName.lastIndexOf("_"));
    if (!prefixPairs.has(op)) prefixPairs.set(op, new Map());
    prefixPairs.get(op).set(np, (prefixPairs.get(op).get(np) || 0) + 1);
  }
  console.log("前缀映射（旧前缀 → 新前缀，按命中数）:");
  for (const [op, cands] of [...prefixPairs].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    const top = [...cands].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, c]) => `${p}(${c})`).join(", ");
    console.log(`  ${op.padEnd(12)} → ${top}`);
  }
  console.log("\n提示：修插件时按此表替换类名常量，再用 --check 验证。");
}

function cmdCheck(file) {
  const cur = flatten(currentClassmap());
  const src = fs.readFileSync(file, "utf8");
  const refs = new Set();
  for (const m of src.matchAll(/['"`]([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)['"`]/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\[class[~*^$]?=["']([A-Za-z0-9_-]+_[A-Za-z][A-Za-z0-9_-]*)["']\]/g)) refs.add(m[1]);
  const missing = [...refs].filter((r) => !cur.has(r) && looksLikeDshClass(r)).sort();
  console.log(`${file}\n  引用 ${refs.size} 个类名，当前 DSH 中不存在 ${missing.length} 个`);
  for (const m of missing) console.log(`  !! ${m}`);
  process.exit(missing.length ? 1 : 0);
}

function cmdAudit(basePath) {
  const snap = basePath || latestSnapshot();
  if (!snap || !fs.existsSync(snap)) { console.error("没有快照。先跑一次 `node audit-asar.mjs --dump`（最好在升级前），或用 --audit <快照文件> 指定基线。"); process.exit(1); }
  const oldSet = flatten(loadSnap(snap));
  const newSet = flatten(currentClassmap());
  console.log(`基线快照 ${path.basename(snap)}（${oldSet.size} 个类名）→ 当前 DSH ${newSet.size} 个\n`);

  const WORD = /[A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*/g;
  const CSSDEF = /\.([A-Za-z0-9_-]+_[A-Za-z][A-Za-z0-9_-]*)(?=\s*[{,:>+[])/g;
  const JSDEF = /"([A-Za-z0-9_-]+_[A-Za-z][A-Za-z0-9_-]*)"\s*[,:}\]]/g;
  const walk = (dir, out = []) => {
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of es) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|mjs|cjs|jsx|ts|tsx|css|vue)$/.test(e.name) && !/\.min\./.test(e.name)) out.push(p);
    }
    return out;
  };

  const profileDirs = fs.readdirSync(path.join(DSH_HOME, "profiles"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .filter((p) => fs.existsSync(path.join(DSH_HOME, "profiles", p, "node_modules")));
  let any = false;
  for (const prof of profileDirs) {
    const root = path.join(DSH_HOME, "profiles", prof, "node_modules");
    const pkgs = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name.startsWith("@deepseek-ai")) continue;
      const p = path.join(root, e.name);
      if (e.name.startsWith("@")) { for (const s of fs.readdirSync(p, { withFileTypes: true })) if (s.isDirectory()) pkgs.push({ n: `${e.name}/${s.name}`, d: path.join(p, s.name) }); }
      else pkgs.push({ n: e.name, d: p });
    }
    const hits = [];
    for (const pkg of pkgs) {
      const files = walk(pkg.d);
      const texts = [];
      for (const f of files) { try { texts.push([path.relative(pkg.d, f), fs.readFileSync(f, "utf8")]); } catch {} }
      const selfDef = new Set();
      for (const [, t] of texts) {
        for (const m of t.matchAll(CSSDEF)) selfDef.add(m[1]);
        for (const m of t.matchAll(JSDEF)) selfDef.add(m[1]);
      }
      const stale = new Map();
      for (const [rel, t] of texts) for (const m of t.matchAll(WORD)) {
        const x = m[0];
        if (!oldSet.has(x) || newSet.has(x) || selfDef.has(x) || !looksLikeDshClass(x)) continue;
        if (!stale.has(x)) stale.set(x, new Set());
        stale.get(x).add(rel);
      }
      if (stale.size) {
        const byPre = new Map();
        for (const [x, fr] of stale) {
          const pre = x.slice(0, x.lastIndexOf("_"));
          if (!byPre.has(pre)) byPre.set(pre, { names: [], files: new Set() });
          byPre.get(pre).names.push(x);
          for (const f of fr) byPre.get(pre).files.add(f);
        }
        hits.push({ pkg: pkg.n, total: stale.size, groups: [...byPre].map(([p, v]) => ({ p, n: v.names.length, files: [...v.files], names: v.names.sort() })).sort((a, b) => b.n - a.n) });
      }
    }
    hits.sort((a, b) => b.total - a.total);
    console.log(`profile: ${prof} —— 中招插件 ${hits.length} 个`);
    for (const h of hits) {
      any = true;
      console.log(`  [${h.pkg}] ${h.total} 个类名失效`);
      for (const g of h.groups) console.log(`      ${g.p} (${g.n})  ${g.names.slice(0, 4).join(", ")}${g.names.length > 4 ? " …" : ""}   文件: ${g.files.slice(0, 2).join(", ")}`);
    }
    console.log();
  }
  if (!any) console.log("没有发现「硬编码 DSH 类名且已失效」的插件。");
  console.log("修复思路：用 --diff <旧快照> 得到前缀映射，替换插件里的类名常量，再 --check 验证。");
}

// ---------- 入口 ----------
if (args.includes("--dump")) cmdDump();
else if (args.includes("--diff")) cmdDiff(flagVal("--diff") || latestSnapshot());
else if (args.includes("--check")) cmdCheck(flagVal("--check"));
else if (args.includes("--audit")) cmdAudit(flagVal("--audit"));
else cmdAudit();
