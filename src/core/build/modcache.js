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

  /**
   * 把预检那张表**存下来**：`路径 \t 改动时间 \t 字节数 \t 内容哈希`。
   *
   * 为什么必须存：`memo` 是**一个进程一份**，所以每趟的第一次 `of(p)` 都要真读、真哈希。
   * asy 那棵库一趟下来是 1.5 MB 上下 —— 那就是在一条"什么都不用编"的快路上白花十几毫秒。
   * 存下来之后常态只 stat（mtime 与大小都没动就信这格哈希），语义还是内容哈希。
   */
  text() {
    const out = ['# omni content ids v1'];
    for (const [p, v] of this.memo) out.push(`${p}\t${v.mtime}\t${v.len}\t${v.hash}`);
    return `${out.join('\n')}\n`;
  }

  save(path) { writeText(path, this.text()); }

  static parse(text) {
    const ids = new ContentIds();
    if (text === undefined || text === null) return ids;
    for (const line of text.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (f.length !== 4) continue;
      ids.memo.set(f[0], { mtime: Number(f[1]), len: Number(f[2]), hash: f[3] });
    }
    return ids;
  }

  static load(path) {
    if (!exists(path)) return new ContentIds();
    return ContentIds.parse(readText(path));
  }
}

/**
 * 索引里一行的**内容**（名字那一格由 `Index` 管）：一个编译单元要重算键时，
 * 光有键是不够的 —— 跳过那一刻它的源文件、include、依赖都得在手上，**行要自足**。
 *
 *   键 \t 自己的源文件 \t include… \t 依赖的源文件… \t 还要带上的单元名… \t 附加标记…
 *
 * 后四格都是逗号分隔（空串 = 没有）。`附加标记` 是与源文件无关但进键的东西
 * （入口名、模式、"内容由整个程序生成"的那种单元的文本哈希）。
 */
export function encodeRow(r) {
  const j = (a) => (a === undefined || a === null ? '' : a.join(','));
  return [r.key, r.self, j(r.incs), j(r.deps), j(r.needs), j(r.extras)].join('\t');
}

export function decodeRow(text) {
  if (text === undefined || text === null) return null;
  const f = text.split('\t');
  if (f.length < 6) return null;
  const s = (x) => (x === '' ? [] : x.split(','));
  return { key: f[0], self: f[1], incs: s(f[2]), deps: s(f[3]), needs: s(f[4]), extras: s(f[5]) };
}

/** 一行自己算出来的键（`include` 与依赖的源文件是同一类输入：都是"读进来的文件"）。 */
export function rowKey(ids, tool, r) {
  return unitKey(ids, { tool, self: r.self, deps: [...r.deps, ...r.incs], extra: r.extras });
}

/** 这一行还成立吗 —— **只有这一处判**（快路与慢路问的是同一个函数）。 */
export function rowFresh(ids, tool, r) {
  return r !== null && rowKey(ids, tool, r) === r.key;
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
 * 一格缓存：**目录按它是什么起名**，"还算不算数"看目录里那份 `stamp`。
 *
 * 从前是把配置哈希当目录名（`rt/efc6a12c…`、`gl/21aa6c09…`、`modules/js-e6c8dc75…`）。
 * 那个名字买不到东西：实际上每种活**只存在一格**（一台机器一个 cc、一棵源码），
 * 于是目录里永远只有一份，而名字变成了一串没人看得懂的十六进制；配置真变了的时候
 * 旧那一格还留在盘上没人清。
 *
 * 现在：名字是 `rt/cc-arm64-osx` 这种**看得懂**的，身份写在 `stamp` 里。对不上就
 * **原地重建**（旧的那几份被盖掉，不再攒世代）。
 *
 * 回 `{dir, fresh}`：`fresh` 为假时调用方自己重建，建完调 `slotDone` 写下 stamp。
 */
export function cacheSlot(root, kind, name, stamp) {
  const dir = join(root, kind, name);
  const p = join(dir, 'stamp');
  const fresh = exists(p) && readText(p) === `${stamp}\n`;
  return { dir, stamp, fresh };
}

/** 这一格建好了：把身份写下来（下一趟靠它认）。 */
export function slotDone(slot) {
  writeText(join(slot.dir, 'stamp'), `${slot.stamp}\n`);
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
