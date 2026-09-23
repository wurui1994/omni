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
  ContentIds, Index, decodeRow, encodeRow, rowKey, rowFresh,
} from './modcache.js';

/**
 * 产物目录：`<root>/modules/<语言>`。**名字里不带哈希** —— 一台机器上这一格只存在一份。
 *
 * 那"配置"（当前目录、找库的路径、内建面那一档）去哪儿了：它们要么已经在**单元名**里
 * （名字带源文件路径的哈希，换个 ASYMPTOTE_DIR 就是另一份库、另一个名字），要么该进
 * **那一行的键**（`extras`，与源文件一样是输入）。放进目录名只会攒出一堆
 * `js-e6c8dc752b614998` 这种没人看得懂、也没人清的世代。
 */
export function moduleDir(root, lang) {
  return join(root, 'modules', lang);
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

/** 一行是不是顶层声明的**开头**；是就回它的名字，不是回 null。 */
function declName(line) {
  const kws = ['function ', 'const ', 'let ', 'var '];
  for (const kw of kws) {
    if (!line.startsWith(kw)) continue;
    const rest = line.slice(kw.length);
    let end = rest.length;
    for (const ch of ['(', ' ', '=', ';']) {
      const at = rest.indexOf(ch);
      if (at >= 0 && at < end) end = at;
    }
    return end === 0 ? null : rest.slice(0, end);
  }
  return null;
}

/**
 * **一份模块产物 -> 能直接 `eval` 的正文**（`import` 行丢掉、`export ` 去掉、顶层
 * `const`/`let` 改成 `var`）。一份进一份出：这一格**只看这一份产物**，不看程序。
 *
 * 为什么要它：`node` 自己能跑那张 ESM 图，可**那得再起一个进程** —— 量出来光
 * `node -e 0` 在这台机器上就要 110ms，而整趟 asy（01-arith）227ms 里就有这 110ms。
 * 别的语言都是当前进程里 `eval` 一趟（30ms 一档）。驱动这一条是**同步**的，拿不到
 * 异步的 `import()`（见 host/native.js 那段），所以"在本进程里跑"只剩这一条：
 * 把每一份产物各自变成一段脚本，按启动器里的次序 `eval` 过去。
 *
 * 为什么 `const`/`let` 要改成 `var`：间接 `eval` 里 `var` 与函数声明进的是**全局对象**
 * （下一趟 eval 看得见），`const`/`let` 只活在那一趟自己的词法环境里。库那几份要能
 * **常驻**（一个进程里只装一次），靠的就是这一条。
 *
 * 为什么**不**先拼成一大段：拼起来那段文字由"这个程序要哪几份"决定 —— 换一个程序就是
 * 另一份 2.4MB 的派生品（量到盘上攒了 16 份 `lib-…js`，一份都不该有）。按份来之后，
 * 派生品与产物一一对应（`<名字>.load.js`），换程序只多装它自己那一份。
 *
 * 同名声明**不用去重**：库那几份里同一个蹦床／函数指针盒会各发一遍，而那些重名的声明
 * **逐字节相同**（量到 143 个多行函数 + 286 行单行声明，全都一样）。分开 eval 时重复的
 * `var`／函数声明只是"再赋一遍同一个值"，而装载全做完才跑各家的 `init()`。
 */
export function loadableText(dir, name) {
  const lines = readText(join(dir, name)).split('\n');
  const out = [];
  for (const raw of lines) {
    if (raw.startsWith('import ')) continue;
    const line = raw.startsWith('export ') ? raw.slice(7) : raw;
    if (declName(line) === null) { out.push(line); continue; }
    let head = line;
    if (head.startsWith('const ')) head = `var ${head.slice('const '.length)}`;
    else if (head.startsWith('let ')) head = `var ${head.slice('let '.length)}`;
    out.push(head);
  }
  return `${out.join('\n')}\n`;
}

/**
 * 一份可 eval 正文里**每个顶层名字的定义指纹**：`名字 -> 一个整数`。
 *
 * 为什么需要它：分开 eval 之后所有产物的顶层名字都落在**同一个全局对象**里，而产物的
 * 名字只在"一个程序这一趟链接"里唯一 —— 两个程序各有一个 `struct Box`，两份产物就都
 * 发一个 `s_asy__ctor_Box_body`，正文却不同。谁后装谁赢，于是"这一份进程里已经装过了"
 * 那条捷径会拿到**别的程序**的定义（撞出来过：28-import 跑出 23-ctor 的 Box 构造函数，
 * 症状是 `Cannot convert undefined to a BigInt`）。有了指纹就能判"被盖的是不是同一段
 * 正文"：同一段就什么都没发生，不同段就把被盖那一份标成要重装。
 *
 * 指纹算的是**从这一行起、到下一个顶层声明之前**的所有文字（顶层语句会被算进上一格 ——
 * 宁可多判几次不同：多判只是多装一遍，少判就是静默地跑错人家的函数）。
 */
export function declDigest(text) {
  const out = new Map();
  let cur = null;
  let h = 0;
  for (const line of text.split('\n')) {
    const nm = declName(line);
    if (nm !== null) {
      if (cur !== null) out.set(cur, h);
      cur = nm;
      h = 0;
    }
    if (cur === null) continue;
    for (let i = 0; i < line.length; i++) h = (h * 31 + line.charCodeAt(i)) | 0;
  }
  if (cur !== null) out.set(cur, h);
  return out;
}

/**
 * 入口那份启动器（`main-<入口>.js`）里按次序列着这个程序要哪几份产物 —— 照原样读回来。
 * 回 `{ mods, entry }`：`mods` 是 import 行上那些产物文件名（次序就是启动器里的次序，
 * 依赖在前），`entry` 是入口那一份的文件名。
 */
export function moduleOrderOf(dir, mainName) {
  const mods = [];
  for (const ln of readText(join(dir, mainName)).split('\n')) {
    if (!ln.startsWith('import ')) continue;
    const a = ln.indexOf("'./");
    const b = a < 0 ? -1 : ln.indexOf("'", a + 3);
    if (a >= 0 && b > a) mods.push(ln.slice(a + 3, b));
  }
  return { mods, entry: mainName.slice('main-'.length) };
}

