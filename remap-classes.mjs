#!/usr/bin/env node
/**
 * remap-classes —— 把「旧 DSH 类名」机械重映射为「新 DSH 类名」，供修复硬编码类名的插件。
 *
 * 原理：DSH 每次重建客户端资源都会换掉 CSS Module 的哈希前缀，但**类名所属的
 * CSS Module 源文件不变**（bundle 里的 `//#region \0dsh-css:<源文件>` 标记给出），
 * 且语义后缀稳定（`ZTP-Xa_frame` → `BynINW_frame`）。于是按「同模块 + 同后缀」即可
 * 唯一确定新类名，不需要人工逐个对照。
 *
 * 用法：
 *   node remap-classes.mjs <旧快照> <新快照> <目标文件>            # 只列映射
 *   node remap-classes.mjs <旧快照> <新快照> <目标文件> --write 输出.js   # 顺带生成重映射后的文件
 *
 * 快照由 audit-asar.mjs --dump 生成。旧快照 = 升级前那次的 dump。
 * 输出里标 MISS 的项需要人工判定（多见于插件引用的、旧快照未覆盖的模块，
 * 例如 DSH 从 web shell 内联出来的类名）。
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const [oldPath, newPath, target, ...rest] = args;
const writeIdx = rest.indexOf("--write");
const outPath = writeIdx >= 0 ? rest[writeIdx + 1] : null;
if (!oldPath || !newPath || !target) {
  console.error("用法: node remap-classes.mjs <旧快照> <新快照> <目标文件> [--write 输出.js]");
  process.exit(1);
}

const norm = (k) => k.replace(/\\/g, "/").replace(/^.*?(packages|extensions)\//, "");
const sufOf = (n) => n.slice(n.lastIndexOf("_") + 1);
const load = (p) => {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const byModule = new Map(), all = new Set(), nameToModule = new Map();
  for (const [k, v] of Object.entries(j)) {
    byModule.set(norm(k), v);
    for (const n of v) { all.add(n); if (!nameToModule.has(n)) nameToModule.set(n, norm(k)); }
  }
  return { byModule, all, nameToModule };
};
const oldS = load(oldPath), newS = load(newPath);

const remapOne = (n) => {
  if (newS.all.has(n)) return { newName: n, how: "kept" };
  const suf = sufOf(n);
  const mod = oldS.nameToModule.get(n);
  if (mod && newS.byModule.has(mod)) {
    const c = newS.byModule.get(mod).filter((x) => sufOf(x) === suf);
    if (c.length === 1) return { newName: c[0], how: `module ${mod}` };
    if (c.length > 1) return { newName: c[0], how: `AMBIGUOUS [${c.join(", ")}]` };
    return { newName: null, how: `NOFOUND in ${mod}` };
  }
  const g = [...newS.all].filter((x) => sufOf(x) === suf);
  if (g.length === 1) return { newName: g[0], how: "global-unique" };
  return { newName: null, how: `NO-MODULE (suf=${suf}, 全局候选 ${g.length})` };
};

const src = fs.readFileSync(target, "utf8");
const refs = [...new Set([...src.matchAll(/['"`]([A-Za-z0-9_-]*_[A-Za-z][A-Za-z0-9_-]*)['"`]/g)].map((m) => m[1]))]
  .filter((n) => /^[A-Za-z0-9_-]+_[A-Za-z][A-Za-z0-9_-]*$/.test(n));

const pairs = [];
let miss = 0, amb = 0;
for (const n of refs.sort()) {
  const r = remapOne(n);
  if (r.newName && r.newName !== n) pairs.push([n, r.newName]);
  if (!r.newName) { miss++; console.log(`  MISS  ${n.padEnd(26)} ${r.how}`); }
  else if (r.how.startsWith("AMBIG")) { amb++; console.log(`  AMB   ${n.padEnd(26)} -> ${r.newName}   ${r.how}`); }
}
console.log(`\n${target}: 引用 ${refs.length} 个类名，需替换 ${pairs.length} 组（未命中 ${miss}，歧义 ${amb}）`);
for (const [o, n] of pairs) console.log(`  ${o.padEnd(26)} -> ${n}`);

if (outPath) {
  pairs.sort((a, b) => b[0].length - a[0].length); // 最长优先，避免前缀互吃
  let text = src, applied = 0;
  for (const [o, n] of pairs) { const c = text.split(o).length - 1; text = text.split(o).join(n); applied += c; }
  fs.writeFileSync(outPath, text);
  console.log(`\n已写出 ${outPath}（替换 ${applied} 处）。用 audit-asar.mjs --check 复核。`);
}
