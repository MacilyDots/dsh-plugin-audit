#!/usr/bin/env node
/**
 * dsh-plugin-audit —— 检查已安装的 DSH 插件是否依赖 DSH 内部实现细节
 * （这类依赖在 DSH 升级后会「静默失效」：页面不报错，插件功能却整块消失）。
 *
 * 用法：
 *   node audit.mjs                 # 默认检查 desktop profile
 *   node audit.mjs web
 *   node audit.mjs desktop --verbose
 *
 * 检查项：
 *   1. 硬编码的 DSH CSS Module 哈希类名（形如 pI_x6G_frame / _bubble_owhem_8）
 *      —— DSH 每次重建 Web 资源都可能换前缀，写死即失效。
 *   2. 结构匹配后缀（形如 [class*="sidebarCol"]）—— 比硬编码稳，但仍依赖
 *      DSH 保留该语义类名。
 *   3. slot 名（slots.register/inject 的 name）—— DSH 改 slot 名同样静默失效。
 *   4. CSS 变量（--dsw-* / --dsh-*）—— 变量改名则样式不生效。
 *
 * 原理：从运行中的 DSH 抓全部客户端 bundle 当「权威集合」，再看插件引用了
 * 哪些不在集合里的东西。需要 dsh-mobile-access 网关在跑（或用 --port 直连）。
 *
 * 局限：纯静态比对，只覆盖「插件引用 DSH 内部标识符」这一类问题；
 * 运行时行为差异、host 侧 API 语义变化不在覆盖范围内。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);
/** 取 `--flag value` 形式的值。 */
const flagVal = (n) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : null; };
const FLAGS_WITH_VALUE = new Set(["--base", "--cookie"]);
/** 第一个非 flag 参数是 profile 名；flag 的值要跳过，否则会被误当成 profile。 */
const PROFILE = (() => {
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith("-") || a.endsWith(".mjs")) continue;
    return a;
  }
  return "desktop";
})();
const VERBOSE = ARGV.includes("--verbose");
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const CACHE = path.join(os.tmpdir(), "dsh-bundle-cache");
const REFRESH = ARGV.includes("--refresh");

// 已知的历史前缀：出现即高度可疑（DSH 0.1.5 → 0.1.7 换掉的整套）
const KNOWN_STALE = /^(pI_x6G|Md3f7G|FJxK0a|uV2eYG|wSkVaW|SVAs4q|h8S2Va|Mbwy4a|pXSMma|VOzbGW|hHd-Xa|p-xYUq|_bubble_owhem|_markdown_owhem)/;

const deEscape = (s) =>
  s.replace(/\\{1,2}([0-9a-fA-F]{1,6})[ \t]?/g, (m, h) => {
    const cp = parseInt(h, 16);
    return cp >= 32 && cp < 127 ? String.fromCharCode(cp) : m;
  });

// ---------- 抓 DSH bundle ----------
// 两种入口：显式 --base/--cookie 直连；否则回落到 dsh-mobile-access 网关的状态文件。
async function fetchBundles() {
  const baseArg = flagVal("--base");
  const cookieArg = flagVal("--cookie");
  let base, headers;
  if (baseArg) {
    base = baseArg.replace(/\/+$/, "");
    headers = cookieArg ? { cookie: cookieArg } : {};
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  } else {
    const statePath = path.join(DSH_HOME, "mobile-access", "state.json");
    if (!fs.existsSync(statePath)) {
      console.error("找不到运行中的 DSH 访问入口（$DSH_HOME/mobile-access/state.json）。两种做法：");
      console.error('  1) 显式指定：node audit.mjs desktop --base https://<host>:<port> --cookie "dshmo=<token>"');
      console.error("  2) 改用离线版 audit-asar.mjs：直接读桌面端 app.asar，不需要服务在跑（推荐）。");
      process.exit(1);
    }
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    base = `https://${st.lanIp}:${st.port}`;
    headers = { cookie: `dshmo=${st.gatewayToken}` };
  }
  const html = await (await fetch(base + "/", { headers, redirect: "manual" })).text();
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) urls.add(m[1].replace(/&amp;/g, "&"));
  for (const m of html.matchAll(/"url":"([^"]+)"/g)) urls.add(m[1].replace(/&amp;/g, "&"));
  fs.mkdirSync(CACHE, { recursive: true });
  const texts = [];
  for (const u of urls) {
    const cf = path.join(CACHE, u.replace(/[^A-Za-z0-9]/g, "_").slice(0, 120));
    if (fs.existsSync(cf) && !REFRESH) { texts.push(fs.readFileSync(cf, "utf8")); continue; }
    const r = await fetch(base + "/" + u.replace(/^\.\//, ""), { headers, redirect: "manual" });
    if (r.status !== 200) continue;
    const t = await r.text();
    fs.writeFileSync(cf, t);
    texts.push(t);
  }
  console.log(`DSH bundle: ${texts.length} 个${fs.existsSync(CACHE) && !REFRESH ? "（缓存，--refresh 可重抓）" : ""}`);
  return texts.map(deEscape).join("\n");
}

// ---------- 收集插件文件 ----------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|jsx|ts|tsx|css)$/.test(e.name) && !/\.min\./.test(e.name)) out.push(p);
  }
  return out;
}

// 哈希风格判定：整串含数字，或大小写交错 ≥2 次（排除 TOKENS_LIMIT / current_period 这类）
function looksHashed(s) {
  if (!/^[A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*$/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s)) return false;           // 全大写常量：HTTP_ERROR / ERR_PNPM_FETCH_404
  if (/^[a-z0-9_]+$/.test(s)) return false;           // 全小写字段：current_period / model_remains
  if (/\d/.test(s)) return true;
  let trans = 0;
  for (let i = 1; i < s.length; i++) {
    const a = /[a-z]/.test(s[i - 1]), b = /[a-z]/.test(s[i]);
    const c = /[A-Z]/.test(s[i - 1]), d = /[A-Z]/.test(s[i]);
    if ((a && d) || (c && b)) trans++;
  }
  return trans >= 2;
}

// DSH 里真实存在的类名集合（用于 [class*="…"] 的子串判断）
function dshClassNameSet(dshText) {
  const set = new Set();
  for (const m of dshText.matchAll(/\.([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)(?=[{,:> \n+\[])/g)) set.add(m[1]);
  for (const m of dshText.matchAll(/"([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)"\s*[,:}\]]/g)) set.add(m[1]);
  for (const m of dshText.matchAll(/=\s*"([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)"/g)) set.add(m[1]);
  return set;
}

// ---------- main ----------
const dsh = await fetchBundles();
const dshClasses = dshClassNameSet(dsh);
const pj = JSON.parse(fs.readFileSync(path.join(DSH_HOME, "profiles", PROFILE, "package.json"), "utf8"));
const skip = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);

let issues = 0;
console.log(`\nprofile: ${PROFILE}\n${"=".repeat(74)}`);
for (const dep of Object.keys(pj.dependencies || {}).sort()) {
  if (skip.has(dep)) continue;
  const dir = path.join(DSH_HOME, "profiles", PROFILE, "node_modules", ...dep.split("/"));
  if (!fs.existsSync(dir)) continue;

  const files = walk(dir);
  const declared = new Set();   // 插件自己定义/导出的类名
  const refs = new Set();       // 插件引用的类名
  const suffixes = new Set();   // [class*="xxx"] 结构匹配后缀
  const slots = new Set();
  const vars = new Set();
  for (const f of files) {
    const t = deEscape(fs.readFileSync(f, "utf8"));
    for (const m of t.matchAll(/\.([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)(?=[{,:> \n+\[])/g)) declared.add(m[1]);
    for (const m of t.matchAll(/["'`]([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)["'`]\s*[,:}\]]/g)) declared.add(m[1]);
    for (const m of t.matchAll(/["'`]([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)["'`]/g)) refs.add(m[1]);
    for (const m of t.matchAll(/\[class[~*^$|]?=\s*["'`]([^"'`]+)["'`]/g)) suffixes.add(m[1]);
    for (const m of t.matchAll(/name:\s*["'`]([a-z][\w.-]*\.[\w.-]+)["'`]/g)) slots.add(m[1]);
    for (const m of t.matchAll(/(--ds[wsh][\w-]*)/g)) vars.add(m[1]);
  }

  const findings = [];
  for (const r of refs) {
    if (declared.has(r) || dsh.includes(r) || !looksHashed(r)) continue;
    findings.push(`引用了当前 DSH 中不存在的类名: ${r}${KNOWN_STALE.test(r) ? "  <= 已知 0.1.5 旧前缀！" : ""}`);
  }
  for (const r of refs) if (KNOWN_STALE.test(r)) findings.push(`残留旧 DSH 前缀: ${r}`);
  for (const s of suffixes) {
    if (s.includes("${") || s.length < 5) continue;            // 模板字面量 / 过短通用词
    if (/^[a-z-]+$/.test(s)) continue;                          // chat / sidebar / preset 这类宽泛词
    let hit = false;
    for (const c of dshClasses) if (c.includes(s)) { hit = true; break; }
    if (!hit) findings.push(`[class*="${s}"] 在 DSH 类名里找不到匹配`);
  }
  for (const s of slots) if (!dsh.includes(s)) findings.push(`slot 名当前 DSH 中未出现: ${s}（可能是插件间可选依赖，需确认）`);
  for (const v of vars) if (!dsh.includes(v)) findings.push(`CSS 变量当前 DSH 中未定义: ${v}`);

  const uniq = [...new Set(findings)];
  if (uniq.length) {
    issues += uniq.length;
    console.log(`\n[${dep}]`);
    for (const f of uniq) console.log(`   ! ${f}`);
  } else if (VERBOSE) {
    console.log(`\n[${dep}] OK（类名 ${refs.size} / slot ${slots.size} / CSS 变量 ${vars.size}）`);
  }
}
console.log(`\n${"=".repeat(74)}`);
console.log(issues ? `共 ${issues} 条待确认项（slot / CSS 变量项可能只是插件间可选依赖）。` : "未发现可疑依赖。");
