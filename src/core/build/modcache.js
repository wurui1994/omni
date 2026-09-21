// src/core/build/modcache.js —— **通用的模块产物缓存**：有 import 关系的语言天然是一张图
//
// 这一份不认识任何一门语言。它答三个问题，谁都可以问：
//
//   1. 一个源文件的**身份**是什么     `contentId(p)` —— 内容哈希（mtime+大小只当预检）
//   2. 一个编译单元的**键**是什么     `unitKey(...)` —— 工具指纹 + 自己 + 依赖 + 附加标记
//   3. 上一趟这个名字是什么键         `Index` —— **一份索引**，不是每格产物旁边一个 `.stamp`
//
// 为什么要通用：「编到 JS」不是 asy 的事。asy / nim / lua / go 都是"一份源码 import 另一份"，
// 那就是一张**隐式图** —— 图不用谁去写，它本来就在源码里。显式图（`build.js` / `.ninja`）
// 是另一回事，**默认不开**：只有当一件活的依赖不在源码里（生成器、打包、跑判据）时才需要它。
//
// 与从前那套（`.omni-cache/asy-mods` 的 `.stamp` + `inpSame`/`stampSame`/`inpOk`）的差别：
//   - 键是**一格哈希**，不是一串 `路径:改动时间:字节数:h哈希`，于是不需要"除了 mtime 都一样"
//     这种自定义比较器（那是手写的第二份脏判定）；
//   - 记在**一份索引**里，于是 218 个 `.stamp` 变成 1 个文件；
//   - 键里掺**工具指纹**，改一行后端该重编的会重编（学 Go 的 action ID）。

import { exists, readText, writeText, mtimeMs, fileSize } from '../host/native.js';
import { join } from '../host/path.js';
import { hash16 } from '../host/hash.js';

/**
 * 内容身份的备忘：`路径 -> {mtime, len, hash}`。
 *
 * 快慢两档：`mtime` 与大小都没动就信记着的那格哈希（一个字节都不读）；对不上才真读、
 * 真哈希 —— 而重算出来一样的话产物照旧有效（只把预检那两格刷新）。
 * 常态只 stat，语义是内容哈希：`touch` 一下、重新 checkout 一遍都不该重编。
 */
export class ContentIds {
  constructor() {
    /** @type {Map<string, {mtime:number, len:number, hash:string}>} */
    this.memo = new Map();
  }

  /** 前端手上已经有文本了：顺手告诉一声，省下面真要哈希时再读一遍。 */
  note(path, text) {
    if (!exists(path)) return;
    this.memo.set(path, { mtime: mtimeMs(path), len: fileSize(path), hash: hash16(text) });
  }

  /** 回内容哈希；文件不在回 `'-'`（"不在"本身也是一种身份，别把它当错误）。 */
  of(path) {
    if (path === undefined || path === null || path === '') return '-';
    if (!exists(path)) return '-';
    const m = mtimeMs(path);
    const n = fileSize(path);
    const had = this.memo.get(path);
    if (had !== undefined && had.mtime === m && had.len === n) return had.hash;
    const h = hash16(readText(path));
    this.memo.set(path, { mtime: m, len: n, hash: h });
    return h;
  }
}

/**
 * 一个编译单元的键：**一格哈希**。
 *
 * @param {ContentIds} ids
 * @param {{tool: string, self: string, deps?: string[], extra?: string[]}} u
 *        `tool` 工具指纹（改了后端就该重编）· `self` 这个单元的源文件 ·
 *        `deps` 它 import / include 进来的那些源文件（**次序要稳定**，调用方排好）·
 *        `extra` 与源文件无关但影响产物的东西（模式、入口名、目标…）
 *
 * 为什么是一格哈希而不是一串字段：一串字段要配一个自定义比较器（"除了 mtime 都一样就算命中"），
 * 那就是手写的第二份脏判定。一格哈希只要 `===`。
 */
export function unitKey(ids, u) {
  const parts = [`t:${u.tool}`, `s:${ids.of(u.self)}`];
  const ds = u.deps === undefined || u.deps === null ? [] : u.deps;
  for (const d of ds) parts.push(`d:${ids.of(d)}`);
  const xs = u.extra === undefined || u.extra === null ? [] : u.extra;
  for (const x of xs) parts.push(`x:${x}`);
  return hash16(parts.join('\n'));
}

/**
 * 一份索引：`名字 -> 键`，一个文件。
 *
 * 从前是每格产物旁边一个 `.stamp`（量到过 218 个）。一份索引的两个好处：读一次就够、
 * 而且"这一格是什么时候、按什么键存的"在一个地方看得全。格式与 `.omni_log` 同族：
 * 一行一格、制表符分隔、坏行跳过（索引是可重建的，不该因为它挡住构建）。
 */
export class Index {
  constructor() {
    /** @type {Map<string, string>} */
    this.keys = new Map();
  }

  static header() { return '# omni module index v1'; }

  static parse(text) {
    const ix = new Index();
    if (text === undefined || text === null) return ix;
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const at = line.indexOf('\t');
      if (at <= 0) continue;
      ix.keys.set(line.slice(0, at), line.slice(at + 1));
    }
    return ix;
  }

  /** 从一份索引文件读（不在就是空的 —— 空索引 = 全都要编，不是错误）。 */
  static load(path) {
    if (!exists(path)) return new Index();
    return Index.parse(readText(path));
  }

  text() {
    const out = [Index.header()];
    for (const [n, k] of this.keys) out.push(`${n}\t${k}`);
    return `${out.join('\n')}\n`;
  }

  save(path) { writeText(path, this.text()); }

  /** 这个名字上一趟是这个键吗。 */
  fresh(name, key) { return this.keys.get(name) === key; }

  set(name, key) { this.keys.set(name, key); }
}

/**
 * 缓存目录：**一种配置一格**。
 *
 * 从前是一个平目录，靠把配置哈希塞进文件名来分开（`01-arith__40bea4bf.js`），
 * 于是"旧世代"是散在里头的一堆文件、没人认得。一种配置一格目录之后，旧世代是一整格，
 * `omni cache gc` 认得它，人也看得懂。
 */
export function modCacheDir(root, kind, configKey) {
  return join(root, kind, configKey);
}

/**
 * 把**隐式图**（源码里的 import 关系）摊成"谁要重编"。
 *
 * 这一格刻意不碰调度：语言前端多数时候就是照拓扑序一趟走完，用不着 ready 队列。
 * 需要真调度（并行、池、关键路径）时再把同一批单元喂给 `graph.js` + `plan.js` ——
 * 那是**显式图**那条路，`build.js` / `.ninja` 才需要，**默认不开**。
 *
 * @param {{name:string, self:string, deps:string[], extra?:string[]}[]} units
 * @returns {{stale: string[], keyOf: Map<string,string>}}
 *   `stale` 是**按传进来的次序**（= 拓扑序）要重编的那些名字。
 *   上游脏 -> 下游也脏：这一格在这儿算，不用每门语言各写一遍。
 */
export function staleUnits(ids, index, tool, units) {
  const keyOf = new Map();
  const dirty = new Set();
  const stale = [];
  const nameBySelf = new Map();
  for (const u of units) nameBySelf.set(u.self, u.name);
  for (const u of units) {
    const extra = u.extra === undefined || u.extra === null ? [] : u.extra.slice();
    /* 上游的键进自己的键：于是"依赖变了"与"自己变了"同一种表示，不必分开判。 */
    for (const d of u.deps) {
      const dn = nameBySelf.get(d);
      if (dn !== undefined && keyOf.has(dn)) extra.push(`u:${keyOf.get(dn)}`);
    }
    const key = unitKey(ids, { tool, self: u.self, deps: u.deps, extra });
    keyOf.set(u.name, key);
    let bad = !index.fresh(u.name, key);
    if (!bad) {
      for (const d of u.deps) {
        const dn = nameBySelf.get(d);
        if (dn !== undefined && dirty.has(dn)) bad = true;
      }
    }
    if (bad) { dirty.add(u.name); stale.push(u.name); }
  }
  return { stale, keyOf };
}
