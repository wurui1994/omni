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
 * **把一目录模块产物链接成两段脚本**：一段是**库**（常驻），一段是**这个程序**（每趟）。
 *
 * 为什么要这一步：`node` 自己能跑那张 ESM 图，可**那得再起一个进程** —— 量出来
 * 光 `node -e 0` 在这台机器上就要 110ms，而整趟 asy（01-arith）是 227ms。别的语言
 * 都在当前进程里 `eval` 一趟就完（30ms 一档）。驱动这一条是**同步**的，拿不到
 * 异步的 `import()`（见 host/native.js 那段），所以"在本进程里跑"只剩这一条路：
 * 自己把那张图摊平成脚本，交给 `evalJs`。
 *
 * 为什么要**分成两段**：一段短程序每趟重新塞进 2.4MB 的库是纯浪费 —— 量到的账是
 * V8 编那份库 35ms、第一趟 `init()` 里的惰性编译 78ms，而**第二趟 `init()` 只要
 * 0.3ms**（库的"真活儿"就这么点，剩下全是编译）。所以库那一段只在**进程里装一次**，
 * 往后每趟只 eval 这个程序自己那一小段（十几 KB）。常驻靠的是一条语言事实：
 * 间接 `eval` 里 `var` 与函数声明进的是**全局对象**（下一趟 eval 看得见），
 * 而 `const` / `let` 只活在那一趟自己的词法环境里 —— 所以库那一段的顶层
 * `const` / `let` 在这儿改写成 `var`（只有顶层那一层，函数体里的一个字不动）。
 *
 * 跨趟的干净由**各家自己的 `init()`** 保证：那本来就是"把这一份的全局清零 + 重设"
 * （`launcherText` 每趟按次序全跑一遍），所以常驻的是**编译结果**，不是上一趟的状态。
 *
 * 这**不是**"把模块合回单体"：每一份产物照旧各自降级、各自缓存、各自按内容做键 ——
 * 变的只有"谁来装载"。两段都是派生品（`lib-…js` / `prog-…js`），与 `main-<入口>.js`
 * 同生共死：那一份重写了，这两份就跟着重写。
 *
 * 同名声明**去重且校验文字**：按模块发射时，同一个蹦床／函数指针盒会在好几份里各发一遍
 * （量到 143 个多行函数 + 286 行单行声明重名，全部逐字节相同）。同名而文字不同就**当场报**
 * —— 那说明两份产物对同一个名字的理解不一样，静默地挑一份是"答案静默地错"。
 * 这一格顺带保住了正确性：程序那一段里重名的声明被**丢掉**（而不是自己新造一格盒子），
 * 不然库读的是一格、程序写的是另一格 —— 那才是真的答案静默地错。
 */
export function linkBundle(dir, mainName, perRun) {
  /* 入口那一份（`main-<入口>.js` -> `<入口>.js`）、启动器自己、外加点名要**每趟重来**的
     那几份（运行时就是一份：它有二十来格顶层可变状态 —— arena、`$fnOnes` 那张按名字
     记的表、输出缓冲…… 常驻的话上一个程序的东西会漏给下一个。撞过一次：`$fnOne` 按
     **裸名字**记（入口单元的名字没有前缀，两个程序都有 `f`），于是第二个程序拿到的是
     第一个程序的闭包 —— 答案静默地错。运行时那一份末尾本来就有
     `Object.assign(globalThis, …)`，所以它每趟重来、库那一段照旧看得见。 */
  const entryFile = `${mainName.slice('main-'.length)}`;
  const fresh = new Set(perRun === undefined || perRun === null ? [] : perRun);
  const seen = new Set();
  const libParts = [];
  const progParts = [];
  const libNames = [];
  const decls = new Map();
  const take = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const isLib = name !== mainName && name !== entryFile && !fresh.has(name);
    const lines = readText(join(dir, name)).split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      /* `import './x.js';` / `import { … } from './x.js';` —— 先把被引的那一份摊进来。 */
      if (raw.startsWith('import ')) {
        const a = raw.indexOf("'./");
        const b = a < 0 ? -1 : raw.indexOf("'", a + 3);
        if (a >= 0 && b > a) take(raw.slice(a + 3, b));
        i++;
        continue;
      }
      const line = raw.startsWith('export ') ? raw.slice(7) : raw;
      const nm = declName(line);
      if (nm === null) { out.push(line); i++; continue; }
      /* 一句到底在哪儿收尾：单行的自己就收（`;` 或 `}` 结尾），多行的收到**顶格的 `}`**
         —— 那是发射层的排版（函数体永远以顶格 `}` 收尾）。 */
      const body = [line];
      if (!(line.endsWith(';') || line.endsWith('}'))) {
        i++;
        while (i < lines.length) {
          body.push(lines[i]);
          if (lines[i] === '}') break;
          i++;
        }
      }
      i++;
      const raw2 = body.join('\n');
      /* 重名要校验的是**产物里那句原文**（下面那一格会把库里的 `const` 改成 `var`，
         拿改写后的去比会把"同一样东西"误判成"两样东西"）。 */
      const had = decls.get(nm);
      if (had !== undefined) {
        if (had !== raw2) {
          throw new Error(`链接：\`${nm}\` 在两份产物里不是同一样东西`
            + ` —— 不许静默挑一份\n旧：${had.slice(0, 120)}\n新：${raw2.slice(0, 120)}`);
        }
        continue;
      }
      decls.set(nm, raw2);
      let txt = raw2;
      /* 库那一段要**常驻**：顶层 `const` / `let` 改成 `var`（间接 eval 里 `var` 与函数
         声明进全局对象，下一趟 eval 才看得见）。只动这一行的开头，函数体不碰。 */
      if (isLib) {
        if (txt.startsWith('const ')) txt = `var ${txt.slice('const '.length)}`;
        else if (txt.startsWith('let ')) txt = `var ${txt.slice('let '.length)}`;
      }
      out.push(txt);
    }
    if (isLib) { libParts.push(out.join('\n')); libNames.push(name); } else progParts.push(out.join('\n'));
  };
  take(mainName);
  return {
    /* 库那一段的身份 = 它由哪几份产物拼起来的（产物名本身就是内容地址）。 */
    libKey: libNames.join(','),
    lib: `${libParts.join('\n')}\n`,
    prog: `${progParts.join('\n')}\n`,
  };
}
