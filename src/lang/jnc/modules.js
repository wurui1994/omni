// src/lang/jnc/modules.js —— 导入这一族：`import "x.jnc"` 到底把哪些名字带进来
//
// jancy 的 import **不是"取一个模块对象"**，是"把这份文件也算进这个模块"
// （jnc_ct_Module 一次编译一个模块，import 来的文件与主文件平级）。两条规矩由此而来：
//   1. 按**文件名**在搜索路径里找（不是相对路径）—— `jnc_ct_Module` 的 `m_filePathList`；
//   2. 名字是**传递**的：A import B、B import C，那么 C 的顶层名字在 A 里也看得见。
//
// 所以这一份答的是"这份文件的模块里，顶层有哪些名字" —— 那正好是查名那一层的**前奏**
// （`bind(ast, lang, { prelude })`）。**核心一行都不用改**：导入在外面解完，名字从前奏进来。
//
// 打不开的那一族记明账：`.jncx` 是个 zip（里头封着 .jnc 与共享库），这一层不解压。

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { normalize } from './normalize.js';
import { jncSemLang } from './scope.js';
import { bind } from '../../core/frontend-engine/bind.js';

/** 搜索路径：名字 -> 那几份文件（同名多份时按给进来的次序取头一份，与 `-I` 的次序同理）。 */
export function moduleIndex(roots) {
  const index = new Map();
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const e of names) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.jnc')) {
        if (!index.has(e)) index.set(e, []);
        index.get(e).push(p);
      }
    }
  };
  for (const r of roots) walk(r);
  return index;
}

/**
 * 归档（`.jncx`）那一族：**打不开就按约定找源码**。
 * `io_base.jncx` 是从 `src/jnc_ext/jnc_io_base/jnc/*.jnc` 打成的 zip（CMake 那一步），
 * 所以约定是"`X.jncx` ↔ 目录 `jnc_X/jnc`"。约定对不上的（`io_websocket.jncx` 那种目录
 * 换了名字的）就留在账上 —— 不猜。
 */
export function archiveIndex(roots) {
  const index = new Map();
  const walk = (dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const e of names) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (e.startsWith('jnc_')) {
        const inner = join(p, 'jnc');
        let files = [];
        try { files = readdirSync(inner).filter((x) => x.endsWith('.jnc')).map((x) => join(inner, x)); } catch { files = []; }
        if (files.length > 0) index.set(`${e.slice(4)}.jncx`, files);
      }
      walk(p);
    }
  };
  for (const r of roots) walk(r);
  return index;
}

/** 这棵（规整过的）树里的 import 路径。 */
export function importsOf(stats) {
  const out = [];
  const visit = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (typeof v !== 'object') return;
    if (v.kind === 'import' || v.kind === 'import-as') {
      const p = v.path;
      if (p !== null && p !== undefined && typeof p.value === 'string') out.push(p.value);
    }
    for (const k of Object.keys(v)) {
      if (k === 'kind' || k === 'line' || k === 'value') continue;
      visit(v[k]);
    }
  };
  visit(stats);
  return out;
}

/**
 * 一份文件的**模块名字**：自己 + 传递地 import 进来的那些文件的顶层名字。
 * `parse(path)` 由调用方给（这一层不认识前端怎么起的），答 GLR 的树。
 * 顺带把两笔账带出来：打不开的归档、找不着的名字。
 */
export function moduleNames(entry, { index, parse, cache = new Map(), archiveIdx = new Map() }) {
  const names = new Set();
  const archives = [];
  const missing = [];
  const seen = new Set();

  const one = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    let rec = cache.get(path);
    if (rec === undefined) {
      let stats = null;
      try { stats = normalize(parse(path)); } catch { stats = null; }
      if (stats === null) { cache.set(path, { top: [], imports: [] }); return; }
      const out = bind({ stats }, jncSemLang);
      const rootId = out.scopes[0].id;
      rec = {
        top: out.decls.filter((d) => d.scope === rootId).map((d) => d.name),
        imports: importsOf(stats),
      };
      cache.set(path, rec);
    }
    for (const n of rec.top) names.add(n);
    for (const spec of rec.imports) {
      const b = basename(spec);
      if (b.endsWith('.jncx')) {
        /* 归档：按约定找它的源码目录（`archiveIndex`）。找着了就当一串普通文件收；
           约定对不上的留在账上。 */
        const files = archiveIdx.get(b);
        if (files === undefined) { archives.push(b); continue; }
        for (const p of files) one(p);
        continue;
      }
      const hit = index.get(b);
      if (hit === undefined || hit.length === 0) { missing.push(b); continue; }
      one(hit[0]);                                  // 同名多份：取搜索路径里头一份
    }
  };

  one(entry);
  return { names: [...names], archives, missing };
}

/** 读文件（给 `parse` 用的小工具，省得每个尺子自己写一遍）。 */
export const readSrc = (p) => readFileSync(p, 'utf8');

/**
 * 扩展库对**每个模块**都隐式 import 的那几份声明：
 * `JNC_LIB_IMPORT("std_globals.jnc")` / `("std_Error.jnc")`（jnc_std_StdLib.cpp:930-931）、
 * `JNC_LIB_IMPORT("sys_globals.jnc")`（jnc_sys_SysLib.cpp:218）。
 *
 * 判据只有一条：**那个名字的文件在搜索路径里找得着吗** —— 找着了就当一份普通 import 收
 * （所以 `libimp/` 里摆的那两份替身照样算），找不着就当没有（库没挂上）。
 * jancy 那边它们是"模块一开张就在"的，所以名字不用写 import 也看得见。
 */
export const LIB_IMPORTS = ['std_globals.jnc', 'std_Error.jnc', 'sys_globals.jnc'];

/**
 * **整个模块的语句拼成一串**（入口 + 传递地 import 进来的那些文件）。
 * 为什么要它：jancy 一次编译一个模块，类与基类可能在不同文件里 —— 只有一起绑，
 * 基类那一层才真的存在，`inherit:` 才接得上，继承来的成员（`m_pluginHost` 那一族）才查得着。
 * 拿名字当前奏只能补"顶层有哪些名字"，补不了"那个类里有哪些成员"。
 */
export function moduleStats(entry, { index, parse, archiveIdx = new Map(), cache = new Map() }) {
  const seen = new Set();
  const out = [];
  const archives = [];
  const one = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    let stats = cache.get(path);
    if (stats === undefined) {
      try { stats = normalize(parse(path)); } catch { stats = null; }
      cache.set(path, stats);
    }
    if (stats === null) return;
    for (const spec of importsOf(stats)) {
      const b = basename(spec);
      if (b.endsWith('.jncx')) {
        const files = archiveIdx.get(b);
        if (files === undefined) { archives.push(b); continue; }
        for (const p of files) one(p);
        continue;
      }
      const hit = index.get(b);
      if (hit !== undefined && hit.length > 0) one(hit[0]);
    }
    out.push(...(Array.isArray(stats) ? stats : [stats]));   // 被 import 的先进去
  };
  one(entry);
  return { stats: out, files: [...seen], archives };
}
