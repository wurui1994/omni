// src/core/build/modules.js —— **一份源码树 -> 一目录模块**，这一份不认识任何一门语言
//
// 有 import 关系的语言天然是一张图（隐式图）。这一层答四件事，谁都可以问：
//
//   1. 产物落在哪儿             `moduleDir(root, kind, configKey)` —— 一种配置一格
//   2. 一份产物还新不新         `UnitIndex`（一份 `index.log` + 一份 `ids.log`）
//   3. 一份产物的**接口**       `declWrite` / `declRead`（一个模块一份 `<名字>.d.sx`）
//   4. 入口那份启动器长什么样   `launcherText`
//
// 为什么在这儿而不是在某门语言的驱动里：「编到 JS」不是 asy 的事。这些格子里没有一个
// 与 asy 有关 —— 前端只负责交出"单元清单"，剩下的次序、复用、接口、启动器都在这一层。
//
// 从前那一摊（每份产物旁边 `.stamp` + `.dep` + `.wk` + `.sec` + `.aif` + `.sx`，再加一份
// 按入口的清单）现在只剩四种文件：`.js` / `.d.sx` / `index.log` / `ids.log`。少一种文件
// 就少一处会抄错的判据 —— 那几个 bug 的症状都是**静默复用旧产物**。

import { exists, readText, writeText } from '../host/native.js';
import { join } from '../host/path.js';
import {
  ContentIds, Index, decodeRow, encodeRow, rowKey, rowFresh, modCacheDir,
} from './modcache.js';

/** 产物目录：`<root>/<kind>/<配置>`。影响"名字解析到哪个文件"的东西进配置，不进文件名。 */
export function moduleDir(root, kind, configKey) {
  return modCacheDir(root, kind, configKey);
}

/**
 * 一目录产物的索引：`index.log`（一行一个单元，行里自足）+ `ids.log`（内容身份的预检表）。
 *
 * 「还新不新」只有一处判（`fresh`）：把行里记的那些输入重新哈一遍，对比行里记的键。
 * 快路与慢路都问它 —— 从前两条路各抄一份判据，漏一处的症状是静默复用旧产物。
 */
export class UnitIndex {
  constructor(dir) {
    this.dir = dir;
    this.ix = Index.load(join(dir, 'index.log'));
    this.ids = ContentIds.load(join(dir, 'ids.log'));
    this.dirty = false;
  }

  /** 读一行（没有回 null）。 */
  row(name) {
    return decodeRow(this.ix.keys.get(name));
  }

  /** 记一行：键当场按 `tool` 算出来。**不立刻落盘**（一趟改完统一 `save` 一次）。 */
  set(name, r, tool) {
    const row = { ...r, key: rowKey(this.ids, tool, r) };
    this.ix.set(name, encodeRow(row));
    this.dirty = true;
    return row.key;
  }

  /** 这一份还能用吗 —— 回那一行，不能用回 null。 */
  fresh(name, tool) {
    const r = this.row(name);
    if (r === null) return null;
    return rowFresh(this.ids, tool, r) ? r : null;
  }

  /** 这一行算出来的键（不写索引）—— "要不要重编"就是拿它跟盘上那一行比。 */
  keyOf(r, tool) {
    return rowKey(this.ids, tool, r);
  }

  /** 落盘（只在真改过时写）。半路崩了就是索引少几格，下一趟把那几份重编。 */
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    this.ix.save(join(this.dir, 'index.log'));
    this.ids.save(join(this.dir, 'ids.log'));
  }
}

/**
 * 一份产物的**声明文件**：`<名字>.d.sx`，一个模块**一份接口**（TypeScript 的 `.d.ts`
 * 是同一件事）。
 *
 * 从前是两份：一份给链接层（它定义了哪些名字、签名长什么样），一份给模块层（名字表与
 * 默认值表达式）。同一件事分两份文件、各一套"在不在"的判断，"接口一致"就变成两处都得对。
 *
 * 一行一格、制表符分隔（与 `index.log` / `ids.log` 同族）：
 *   `decl \t <一条签名>`   链接层：别人引它要发的那条 `(sig …)`
 *   `iface \t <JSON>`      模块层：名字、签名、默认值表达式（存不下来就没有这一行）
 */
export function declPath(dir, name) {
  return join(dir, `${name}.d.sx`);
}

export function declWrite(dir, name, sigs, iface) {
  const lines = ['# omni unit interface v1'];
  for (const x of sigs) lines.push(`decl\t${x}`);
  if (iface !== undefined && iface !== null) lines.push(`iface\t${JSON.stringify(iface)}`);
  lines.push('');
  writeText(declPath(dir, name), lines.join('\n'));
}

/** 回 `{sigs, iface}`；没这份文件回 null。`iface` 那一段没有就是 null。 */
export function declRead(dir, name) {
  const p = declPath(dir, name);
  if (!exists(p)) return null;
  const sigs = [];
  let iface = null;
  for (const ln of readText(p).split('\n')) {
    if (ln === '' || ln.startsWith('#')) continue;
    const at = ln.indexOf('\t');
    if (at <= 0) continue;
    const kind = ln.slice(0, at);
    const body = ln.slice(at + 1);
    if (kind === 'decl') sigs.push(body);
    else if (kind === 'iface') iface = JSON.parse(body);
  }
  return { sigs, iface };
}

/**
 * 入口那份启动器：把每份产物的初始化按名字引进来、按次序跑一遍，最后跑入口自己。
 *
 * `initOf(name)` 回这份产物那个初始化函数的名字（那是发射层的约定，所以从外面递进来）。
 * 次序上唯一的规矩：**入口最后**。别人家的全局由各自的初始化清零，入口的初始化里才是
 * 真正的程序 —— 顺序反了的症状是"别人家的全局是 undefined"。
 */
export function launcherText(entry, names, initOf, prelude, tail) {
  const lines = [];
  for (const x of prelude === undefined ? [] : prelude) lines.push(x);
  for (const n of names) lines.push(`import { ${initOf(n)} } from './${n}.js';`);
  lines.push(`import { ${initOf(entry)} } from './${entry}.js';`);
  for (const n of names) lines.push(`${initOf(n)}();`);
  lines.push(`${initOf(entry)}();`);
  for (const x of tail === undefined ? [] : tail) lines.push(x);
  lines.push('');
  return lines.join('\n');
}
