// src/core/graph/run.js —— **`omni run --engine graph`**：登记处那十一格从源码到跑掉的一条路
//
// 这一份是**接线**，不是新机器：语法 -> 树（`glr/`）-> 图（`ext/<lang>/tograph.js`）->
// 后端（`contract.js` 的五问）。每一步都是已经有判据的那一步，所以这儿一格新语义都不加。
//
// ## 为什么要有 `--engine`
//
// 这棵树里已经有另一条 `omni run`（asy / jnc / C / GLSL 那条：前端 -> OIR -> 后端）。
// 图那一条是**另一台机器**（ADR-0033 的节点代数 + 契约五问），两条路对同一个文件名可能
// 都说得通。默认仍然是老那条，`--engine graph` 才切过来 —— 引擎是**用户敲的**，不猜。
//
// ## 语言怎么定：`--lang` 优先，后缀只是默认
//
// `.lua` 既可能是 lua 也可能是 gsl-shell，源码还几乎同形 —— 按后缀猜必然猜错一半。
// 所以 `--lang` 一给就盖过后缀（`langs.js` 的 `pickLang`），两样都说不出来就报一句带清单的错。
//
// ## `--backend` 现在有哪几条（图这一层的答卷，全部来自 `contract.js`）
//
//   interp  默认。**它就是 `graph.eval`** —— 调度器的读法，不是"另一个后端"（§5）
//   js      降成一份 JS 源码，在本进程里跑掉
//   wat     降成 WAT 文本，交给 `frontend-wat` 读回来、用 MIR 的解释器真跑
//           （所以这一条腿的正确性由一条互不相干的已有实现来证）
//   c       降成一份**自足的 C**（宿主面只有 libc 那七格），交给我们自己那台 C 前端
//           （`frontend-c`）读回来、还是那台 MIR 解释器跑 —— 与 wat 同一条判据，
//           而且一个外部 cc 都不借。缺口有名有姓（第一刀接第一批 + 早退）
//   sx      **只序列化**：印出图的那份文本，再读回来验一遍逐字节相同（不产生输出行）
//
// 缺口不是失败：某个后端接不住这份图的某个形状时，报的是那一句有名有姓的账（`Gap`），
// 退出码 3 —— 与"程序自己跑错了"分开。

import { loadGrammarTable } from '../glr/load.js';
import { lexText } from '../glr/lex.js';
import { glrParse } from '../glr/driver.js';
import { Diagnostics, SourceFile, OmniError } from '../source/diag.js';
import { readText, writeText, writeBinary, stdout, stderr, exists, readDir } from '../host/native.js';
import { backends, Gap } from './contract.js';
import { program } from './graph.js';
import {
  graphStat, graphStatTable, graphStatJson, graphStatDot, graphStatDiff, graphStatDiffTable,
} from './stat.js';
import { shrink } from './shrink.js';
import { layerModel, layerTable } from '../cli/layers.js';
import { watToWasm } from '../wasm/assemble.js';
import { LANGS, pickLang, treeRoot } from './langs.js';
import { hasAdapter, sxTextOf } from '../lower/drive.js';

/** 一格 `--flag VALUE`：给了就回那个值，没给回 null（不认 `--flag=VALUE`，与别处一致）。
 *  名字不叫 `argOf`：`src/lang/jnc/generic.js` 里那格叫这个名字（取泛型实参，是另一件事）。 */
function cliArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** 图这一层认得的后端名单（顺序就是印出来的顺序）。 */
export function graphBackendNames() {
  return backends().map((b) => b.name);
}

/**
 * 跑一份源码。回退出码：0 = 跑通、1 = 语法/映射说不通、3 = 后端有缺口（有名有姓）。
 *
 * @param {string} path 源文件
 * @param {string[]} argv `run` 后面那些参数（`--lang` / `--backend` 在里头）
 */
/**
 * 源码 -> 图。回 `{ lang, graph }`，或者回 `{ code }`（语法说不通，诊断已经印了）。
 * `run` 与 `build` 共用它 —— 两条命令的前两步一个字都不该差。
 */
function graphOf(path, argv) {
  const lang = pickLang(path, cliArg(argv, '--lang'));
  /* **迁完的那几门在图这一层没有了**（ADR-0044）：它们的 `tograph.js` 删掉了，
     `--engine graph` 对它们只能是一句人话，不能是 `lang.toGraph is not a function`。 */
  if (lang.toGraph === undefined) {
    throw new OmniError(`--engine graph 这一层没有 ${lang.name} 了 —— 这门语言已经迁到`
      + '公共降级器（ADR-0044：adapter → 标准 IR → lower → .sx），直接 `omni run` 就走那条路');
  }
  const grammarPath = `${treeRoot()}/${lang.grammar}`;
  const { tb, g } = loadGrammarTable(grammarPath);
  const diags = new Diagnostics();
  /** 一份源文件 -> 一棵树（语法说不通就回 null，诊断已经记在 diags 上）。 */
  const treeOf = (p) => {
    const toks = lexText(g.lex, new SourceFile(p, readText(p)), diags);
    if (toks === null || diags.hasErrors()) return null;
    return glrParse(tb, toks, diags);
  };
  const tree = treeOf(path);
  if (tree === null || diags.hasErrors()) { stderr(diags.format()); return { code: 1 }; }
  /**
   * **同目录下的同语言文件真的读进来**（第一百五十一片第二格）。
   *
   * 规则只有一条，而且刻意不搜索（与 ADR-0009 那套模块路径同一条纪律）：
   * `import x` 里那个 `x`（去掉 `./`）拼上这门语言的后缀，**就在导入方旁边**找；
   * 找着就读，找不着就照旧当"标准库那一格"交给映射（`import tables` / `import "fmt"`
   * 就是这么被丢掉的 —— 那几格由节点与内建接住）。所以这一格不会改变任何现有例子。
   *
   * 被导入的那份走 `asModule: true`：go / v 要夹掉末尾那格 `call main`，
   * 不然被导入的 `main` 也会跑一遍。环靠 `seen` 挡（读过的不再读，不报错 ——
   * nim 与 go 里 A 引 B、B 引 A 都是合法的）。
   */
  const seen = new Set([path]);
  const mods = [];
  const dirOf = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '.');
  /** `//go:build ignore` 检查（头 200 字节） */
  const buildIgnored = (full) => {
    try {
      const head = readText(full).slice(0, 200);
      return /\/\/go:build\s+ignore\b/.test(head) || /\/\/\s*\+build\s+ignore\b/.test(head);
    } catch { return false; }
  };
  /**
   * **`--pkg` 开关：把同目录下所有同语言文件一起编**（go 的包 = 一个目录）。
   * 不用 import 解析——go 的一个包就是一个目录下所有 `.go`（排除 `_test.go`）。
   * 这是跨包链接之前的第一步：先让同一个包里 16 个文件能组装到一起。
   */
  const doPkg = argv.includes('--pkg');
  /** `--pkgs DIR,DIR,...`：按拓扑序编多个包目录到一张图。
   * 每个目录按 --pkg 的规则收齐文件，按目录顺序拼到 mods **前面**（依赖在前）。 */
  const pkgsRaw = (() => { const i = argv.indexOf('--pkgs'); return i >= 0 ? argv[i + 1] : null; })();
  /** `--pkgs-root DIR`：扫主包的 import 路径，最后一段匹配 DIR 下子目录的自动当 dep。
   * go 的 `import "cmd/compile/internal/syntax"` → 最后一段 `syntax` → `DIR/syntax/`。
   * 递归：每个 dep 的 import 也扫。只走一层子目录，不搜 stdlib。 */
  const pkgsRoot = cliArg(argv, '--pkgs-root');
  const autoResolvedDirs = new Set();
  if (pkgsRoot !== null && lang.exts.includes('go')) {
    /* 从主包文件和 --pkgs 里的文件扫 import，广度优先解析。
       只解析路径的**倒数第二段**与 pkgsRoot 的 basename 相同的 import——
       `"cmd/compile/internal/syntax"` 里 `internal` 对上 pkgsRoot 的末段 `internal`
       才解析为 `pkgsRoot/syntax/`；`"go/token"` 里 `go` 不匹配就跳过。 */
    const rootBase = pkgsRoot.replace(/\/$/, '').split('/').pop();
    const pendingScan = [path];
    /* 收集 --pkg 模式下同目录所有 .go 文件 */
    if (doPkg) {
      const mainDir = (path.lastIndexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '.');
      try {
        for (const n of readDir(mainDir)) {
          if (n.endsWith('.go') && !n.endsWith('_test.go')) pendingScan.push(`${mainDir}/${n}`);
        }
      } catch { /* ignore */ }
    }
    const scannedDirs = new Set();
    while (pendingScan.length > 0) {
      const f = pendingScan.pop();
      const fDir = f.lastIndexOf('/') >= 0 ? f.slice(0, f.lastIndexOf('/')) : '.';
      if (scannedDirs.has(fDir)) continue;
      scannedDirs.add(fDir);
      /* 扫这个目录下所有 .go 文件的 import */
      let dirFiles;
      try { dirFiles = readDir(fDir); } catch { continue; }
      for (const n of dirFiles) {
        if (!n.endsWith('.go') || n.endsWith('_test.go')) continue;
        const full = `${fDir}/${n}`;
        let src;
        try { src = readText(full); } catch { continue; }
        /* 快速正则抽 import 路径最后一段 */
        for (const m of src.matchAll(/^\t"([^"]+)"/gm)) {
          const segs = m[1].split('/');
          if (segs.length < 2) continue;
          if (segs[segs.length - 2] !== rootBase) continue;
          const last = segs[segs.length - 1];
          const candDir = `${pkgsRoot}/${last}`;
          if (autoResolvedDirs.has(candDir) || scannedDirs.has(candDir)) continue;
          try { readDir(candDir); } catch { continue; } // 不存在就跳过
          autoResolvedDirs.add(candDir);
          /* 不递归：只扫主包的直接 import。传递闭包会拉入太多包，
             dep 包的顶层初始化可能引用它们自己的 dep 而失败。 */
        }
      }
    }
  }
  /* 合并手写的 --pkgs 和自动发现的 --pkgs-root 目录 */
  const allPkgDirs = [];
  if (pkgsRaw !== null) {
    for (const d of pkgsRaw.split(',').map((s) => s.trim()).filter(Boolean)) allPkgDirs.push(d);
  }
  for (const d of autoResolvedDirs) allPkgDirs.push(d);
  if (allPkgDirs.length > 0) {
    for (const d of allPkgDirs) {
      let names;
      try { names = readDir(d); } catch { stderr(`omni: --pkgs 读不了 ${d}\n`); continue; }
      for (const n of names.sort()) {
        let ok = false;
        for (const e of lang.exts) if (n.endsWith(`.${e}`) && !n.endsWith(`_test.${e}`)) ok = true;
        if (!ok) continue;
        const full = `${d}/${n}`;
        if (seen.has(full)) continue;
        /* **`//go:build ignore`**（go 的构建约束）：那份文件不属于这个包。
           mknode.go / mkbuiltin.go 之类的代码生成器用它，包声明写的是 `package main`。
           跳过它——读进来会把 `func main` 覆盖掉真正的入口。 */
        if (buildIgnored(full)) continue;
        seen.add(full);
        const sub = treeOf(full);
        if (sub !== null && !diags.hasErrors()) mods.push({ path: full, tree: sub });
      }
    }
  }
  if (doPkg) {
    const dir = dirOf(path);
    for (const e of lang.exts) {
      let names;
      try { names = readDir(dir); } catch { break; }
      for (const n of names) {
        if (!n.endsWith(`.${e}`)) continue;
        if (n.endsWith(`_test.${e}`)) continue;
        const full = `${dir}/${n}`;
        if (seen.has(full)) continue;
        /* **`//go:build ignore`**：代码生成器（mknode.go），不属于本包。 */
        if (buildIgnored(full)) continue;
        seen.add(full);
        const sub = treeOf(full);
        if (sub === null || diags.hasErrors()) {
          /* **`--pkg` 模式下某个文件解析失败不中断**：跳过这一份，继续收别的。
             go 编译器 ssa 包有 97 个文件，其中 5 个用了我们的语法还不接的写法
             （十六进制浮点 `0x1p-1022`、`[]byte(s)` 类型转换等）——跳过它们
             不影响其他 92 个文件，跳过总比整包退出好。 */
          diags.items = diags.items.filter(d => d.severity !== 'error');
          continue;
        }
        mods.push({ path: full, tree: sub });
      }
    }
  }
  const load = (p, t) => {
    if (lang.imports === undefined) return true;
    for (const spec of lang.imports(t)) {
      const rel = spec.startsWith('./') ? spec.slice(2) : spec;
      let hit = null;
      for (const e of lang.exts) {
        const cand = `${dirOf(p)}/${rel}.${e}`;
        if (exists(cand)) { hit = cand; break; }
      }
      if (hit === null || seen.has(hit)) continue;   // 标准库那一格 / 已经读过
      seen.add(hit);
      const sub = treeOf(hit);
      if (sub === null || diags.hasErrors()) return false;
      if (!load(hit, sub)) return false;            // 它自己的 import 先读（依赖在前）
      mods.push({ path: hit, tree: sub });
    }
    return true;
  };
  if (!load(path, tree)) { stderr(diags.format()); return { code: 1 }; }
  try {
    /**
     * **一起编的那几份要互相看得见声明**（`also`）。
     *
     * 每份文件的映射本来各扫各的声明（`STRUCTS` / `TYPES` / `METHODS` 那几张表每趟都清），
     * 于是 `import util` 之后 `util.Point{1, 2}` 仍旧报"声明不在这一份文件里"——
     * 读进来了却看不见，那是这一格落地时漏掉的一半。现在把**这一趟所有的树**一起交给
     * 每一次映射：那几张表先按旁边那几份填一遍，再按自己这一份填（同名时自己说了算）。
     */
    /* **`--pkg` 模式下所有文件平等**（go 包的语义）。主入口与 mods 拼在一起，
       全部走 toGraph 后合并 body。主入口不特殊——go 包里所有文件都是同一级。
       拼的顺序就是文件名排序（readDir 给的），主入口在字母序里的位置不动。 */
    const all = doPkg
      ? [{ path, tree }, ...mods]
      : [{ path, tree, isMain: true }, ...mods.map((m) => ({ ...m }))];
    const also = all.map((f) => f.tree);
    if (!doPkg && mods.length === 0) {
      const main = lang.toGraph(tree, { also });
      return { lang, graph: main };
    }
    const body = [];
    /**
     * **顶层声明按依赖排序**（go 的包级初始化顺序是**按依赖**定的，不是按文件名）。
     *
     * 一个包里 `var stopset = 1<<_Break | …`（branches.go）用的 `_Break` 是
     * tokens.go 里的 iota 常量 —— 字母序里 branches 在 tokens 前面，于是照文件序拼出来的
     * JS 里 `v_stopset` 先算，`v__Break` 还是 undefined。go 自己不会这样：它先解依赖。
     *
     * 判据（三条，都不猜）：
     *   * 一格 bind 的 init **就是 func** —— 它没有初始化期依赖（函数体后面才跑），排最前；
     *   * 别的 bind：依赖 = init 里引到的顶层 bind 名字，**再顺着那些函数的体传递地收全**（见 `fnRefs`）；
     *   * 有环就退回原序（go 里包级初始化的环是编译错，我们这儿不报，照原序摆）。
     */
    const orderTopLevel = (stmts) => {
      const isNode = (s) => s !== null && s !== undefined && !Array.isArray(s)
        && typeof s === 'object' && typeof s.op === 'string';
      /* 名字 -> 它那一格 bind 在 stmts 里的下标（同名取最后一格，与 var 的语义一致） */
      const at = new Map();
      stmts.forEach((s, i) => {
        if (isNode(s) && s.op === 'bind' && s.attrs !== undefined
          && typeof s.attrs.name === 'string') at.set(s.attrs.name, i);
      });
      /** init 里引到的名字。`deep` 为真时**连函数体一起收**（见下面 `fnRefs` 的账）。 */
      const refsOf = (x, out, deep) => {
        if (x === null || x === undefined) return out;
        if (Array.isArray(x)) { for (const y of x) refsOf(y, out, deep); return out; }
        if (typeof x !== 'object') return out;
        if (x.lit !== undefined) return out;
        if (typeof x.op !== 'string') return out;
        if (x.op === 'func' && deep !== true) return out;    // 浅那一档：函数体后面才跑
        if (x.op === 'ref' && x.attrs !== undefined
          && typeof x.attrs.name === 'string') out.add(x.attrs.name);
        if (x.ins !== undefined) for (const k of Object.keys(x.ins)) refsOf(x.ins[k], out, deep);
        return out;
      };
      /**
       * **函数名 -> 它体里引到的全部名字**（go 的初始化依赖是**穿过函数体**的）。
       *
       * go 的规矩（语言规范 Package initialization 那一节）：`x` 的初值或**函数体**里
       * 引到 `y`，`x` 就依赖 `y`，而且是**传递的**。从前这一层把函数体整个跳过了，于是
       * `var globalRand = New(NewSource(1))` 排在 `int32max` / `rngLen` 那几格常量**前面**
       * —— 跑起来 `seed % int32max` 是除以 0（`math/rand` 的包级 RNG 就是这么崩的）。
       */
      const fnRefs = new Map();
      stmts.forEach((s) => {
        if (!isNode(s) || s.op !== 'bind' || s.attrs === undefined) return;
        const init = s.ins === undefined ? undefined : s.ins.init;
        if (!isNode(init) || init.op !== 'func') return;
        fnRefs.set(s.attrs.name, refsOf(init, new Set(), true));
      });
      /** 从这一串名字出发，顺着函数体一路收全（环靠 seen 截住）。 */
      const closure = (names) => {
        const seen = new Set(names);
        const stack = [...names];
        while (stack.length > 0) {
          const n = stack.pop();
          const inner = fnRefs.get(n);
          if (inner === undefined) continue;
          for (const m of inner) if (!seen.has(m)) { seen.add(m); stack.push(m); }
        }
        return seen;
      };
      const deps = stmts.map((s) => {
        if (!isNode(s) || s.op !== 'bind') return [];
        const init = s.ins === undefined ? undefined : s.ins.init;
        if (isNode(init) && init.op === 'func') return [];  // 函数绑定：无依赖
        const names = closure(refsOf(init, new Set(), false));
        const out = [];
        for (const n of names) {
          const j = at.get(n);
          if (j !== undefined) out.push(j);
        }
        return out;
      });
      const mark = new Uint8Array(stmts.length);           // 0 未访 / 1 在栈 / 2 已出
      const out = [];
      const visit = (i) => {
        if (mark[i] !== 0) return;
        mark[i] = 1;
        for (const j of deps[i]) if (j !== i && mark[j] === 0) visit(j);
        mark[i] = 2;
        out.push(stmts[i]);
      };
      for (let i = 0; i < stmts.length; i++) visit(i);
      return out;
    };
    /* **跨包：--pkgs 里的每个目录是一个独立的 go 包**。
       两趟：第一趟把依赖包的声明 + 包 record 放进 body，第二趟放主包。
       这样 `call main`（在主包末尾）跑的时候 `v_util` 已经绑好了。 */
    const pkgDirs = allPkgDirs.length > 0 ? allPkgDirs : [];
    /* **`--pkgs` 供了真包的那几个名字**（目录名 = 包名，与 byPkg 那儿同一条规矩）。
       交给前端是为了让它**别再为这几个名字发标准库桩** —— 桩与真包那格 record 同名，
       而桩是在主文件那一趟注入的、排在依赖包后面，于是盖掉的是真的那一格
       （量出来是 `'path' 在这一层已经声明过了`）。 */
    const havePkgs = pkgDirs.map((d) => d.slice(d.lastIndexOf('/') + 1));
    const dirOfFile = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '.');
    const depFiles = all.filter((f) => pkgDirs.includes(dirOfFile(f.path)));
    const ownFiles = all.filter((f) => !pkgDirs.includes(dirOfFile(f.path)));
    /* 第一趟：依赖包，按包名分组 */
    const byPkg = new Map();
    for (const f of depFiles) {
      const g = lang.toGraph(f.tree, { also, asModule: true, havePkgs });
      const dir = dirOfFile(f.path);
      const pkgName = dir.slice(dir.lastIndexOf('/') + 1);
      if (!byPkg.has(pkgName)) byPkg.set(pkgName, []);
      byPkg.get(pkgName).push(...g.body);
    }
    for (const [pkgName, pkgBody] of byPkg) {
      const ordered = orderTopLevel(pkgBody);
      const fields = [];
      for (const stmt of ordered) {
        body.push(stmt);
        if (stmt !== null && stmt !== undefined && !Array.isArray(stmt)
          && stmt.op === 'bind' && stmt.attrs && stmt.attrs.name) {
          const n = stmt.attrs.name;
          if (n.length > 0 && n[0] >= 'A' && n[0] <= 'Z') {
            fields.push([n, { op: 'ref', ins: {}, attrs: { name: n } }]);
          }
        }
      }
      if (fields.length > 0) {
        body.push({
          op: 'bind',
          ins: {
            init: {
              op: 'record-new',
              ins: { fields: fields.map(([, v]) => v) },
              attrs: { names: fields.map(([k]) => k) },
            },
          },
          attrs: { name: pkgName },
        });
      }
    }
    /* 第二趟：主包（含 call main） */
    for (const f of ownFiles) {
      const g = lang.toGraph(f.tree, {
        also,
        asModule: doPkg ? true : (f.isMain !== true),
        havePkgs,
      });
      body.push(...g.body);
    }
    /* `--pkg` 模式下末尾不补 call main——go 包的声明只是声明，不带入口。
       主入口那一份的 goToGraph 已经补了 call main（asModule: true 时不补）。
       所以 `--pkg` 时全部 asModule: true，我们在末尾显式补一格 call main。 */
    /* `--pkg` 模式下末尾补 call main——**但只在真有 main 时补**。
       go 的库包（`package syntax`）没有 main，补了就报 `v_main is not defined`。
       判据：body 里有没有一格 `bind` 的名字是 `main`。 */
    if (doPkg) {
      const hasMain = body.some((s) => s !== null && s !== undefined && !Array.isArray(s)
        && s.op === 'bind' && s.attrs !== undefined && s.attrs.name === 'main');
      if (hasMain) {
        body.push({
          op: 'call',
          ins: { fn: { op: 'ref', ins: {}, attrs: { name: 'main' } }, args: [] },
          attrs: {},
        });
      } else {
        stderr('omni: 这个包没有 main（库包）—— 只跑顶层声明，不补入口\n');
      }
    }
    if (mods.length > 0 || doPkg) {
      stderr(`omni: ${all.length} 份同包文件一起编：`
        + `${all.map((f) => f.path).join(' ')}\n`);
    }
    return { lang, graph: program(doPkg ? orderTopLevel(body) : body) };
  } catch (err) {
    throw new OmniError(`${path}: ${lang.name} 的映射说不通 —— ${err.message}`);
  }
}

/** 挑一条腿。名字打错就报那四条（**清单是注册出来的**，不是手写的）。 */
function pickBackend(verb, argv, dflt) {
  const backName = cliArg(argv, '--backend') ?? dflt;
  const back = backends().find((b) => b.name === backName);
  if (back === undefined) {
    throw new OmniError(`${verb} --engine graph：没有 --backend ${backName} 这一条 —— `
      + `图这一层现在有 ${graphBackendNames().join(' / ')} 四条`
      + '（interp 就是 graph.eval；sx 只序列化，不出输出行）');
  }
  return back;
}

/**
 * `--stat` / `--stat-out FILE` / `--stat-diff FILE`（第一百四十七片第三格）：图的形状与结构。
 *
 * 印到 **stderr** —— stdout 上是那份程序的输出，判据逐行比对它，多一行都不行。
 * 算在 `stat.js`（纯计算，图进数出），这儿只管接线：读开关、落文件、印那几句。
 *
 * `--stat-diff` 要**再走一遍前端**（另一份源码 -> 另一张图）。那是有代价的一步，
 * 所以只在给了这个开关时才走 —— 「变换是减法」这个量尺不该让平常那一趟变慢。
 */
function statOf(graph, argv, path) {
  const out = cliArg(argv, '--stat-out');
  const other = cliArg(argv, '--stat-diff');
  if (!argv.includes('--stat') && out === null && other === null) return null;
  const s = graphStat(graph);
  stderr(graphStatTable(s));
  if (other !== null) {
    const got = graphOf(other, argv);
    if (got.code !== undefined) throw new OmniError(`--stat-diff ${other}：那份源码自己就说不通`);
    stderr(`omni: 基线 ${path} -> 变换后 ${other}\n`);
    stderr(graphStatDiffTable(graphStatDiff(s, graphStat(got.graph))));
  }
  if (out !== null) {
    const json = out.endsWith('.json');
    writeText(out, json ? graphStatJson(s) : graphStatDot(graph));
    stderr(`omni: 图的形状 -> ${out}（${json ? 'json' : 'dot：dot -Tsvg 出图'}）\n`);
  }
  return s;
}

/**
 * `--shrink`（第一个 pass）：常量折叠 + 死绑定删除。**账当场报** ——
 * `docs/design/node-graph-shrink.md` 第三条要求的原话是「每个 pass 要能报出删了几格节点」，
 * 所以这一句不是 `-v` 才印的调试话，是这个开关本身的输出（在 stderr 上）。
 * 再给了 `--stat` 就连那张按 op 的差表一起印 —— 「哪一格少了」比「少了几格」更有用。
 */
function shrinkOf(graph, argv) {
  if (!argv.includes('--shrink')) return graph;
  const s0 = graphStat(graph);
  const r = shrink(graph);
  const s1 = graphStat(r.graph);
  stderr(`omni: shrink 折 ${r.folded} 格常量、删 ${r.dropped} 格死绑定（${r.rounds} 轮）`
    + ` —— 节点 ${s0.nodes} -> ${s1.nodes} 格\n`);
  if (argv.includes('--stat')) stderr(graphStatDiffTable(graphStatDiff(s0, s1)));
  return r.graph;
}

/**
 * 各层的账（第一百四十七片第五格）：**与 omni 那台机器同一把尺子**（`cli/layers.js`）。
 *
 * 图这一层的节点表（上面 `statOf` 那张）说的是「图定义的那几格节点」；这一张说的是
 * 「源码 -> 图 -> 目标文本」每层多少、比源码大几倍。两张要分开看：一张是形状，一张是胀。
 */
function statLayersGraph(path, s, textLen, argv) {
  if (!argv.includes('--stat')) return;
  const src = readText(path);
  const layers = [{ name: '图', n: s.nodes, unit: '格', bytes: null }];
  if (textLen > 0) layers.push({ name: '目标文本', n: null, unit: '', bytes: textLen });
  stderr(layerTable(layerModel({ bytes: src.length, lines: src.split('\n').length }, layers)));
}

/**
 * 借来的那些语言的扩展名（`.go` / `.nim` / `.ss` / …），带点。
 *
 * **一张表，不是两处清单**：`cli.js` 要知道"哪些后缀该先译成核心方言"，而那份名单就是
 * `langs.js` 里登记的那些。手抄一份的后果是加一门语言要改两处，第二处一定会漏。
 * `guess: false` 的那几格不算（`.lua` 归 lua，gsl-shell 只能 `--lang` 点名）。
 */
export function borrowedExts() {
  const out = new Set();
  for (const [, d] of LANGS) {
    if (d.guess === false) continue;
    for (const e of d.exts) out.add(`.${e}`);
  }
  return [...out];
}

/**
 * 源码 -> 核心方言文本（`.sx`）。
 *
 * 这一格是给 `cli.js` 用的：`.go` 这类文件与 `.c` 一样，**就是这条链的一个前端** ——
 * 译成 `.sx` 之后走的是与 `.sx` 输入一模一样的那条路（lower -> OIR -> MIR -> 原生 /
 * js / llvm，还有 `--cc` / `OMNI_MIR_OPT` / 摇树 / profile），所以下游一行都不用再写。
 * 从前这条线只存在于 `bench/go/run.js` 里的两条命令，手敲两步才走得通。
 *
 * 回 null = 语法或映射说不通（诊断已经印过了）。缺口按 `OmniError` 抛（有名有姓）。
 */
export function coreSxText(path, argv) {
  /* **迁到公共降级器的那几门走另一条路**（ADR-0044）：adapter → 标准 IR → lower → .sx。
     这儿只是分岔，不是两套实现 —— 图那一条会随着最后一门迁完一起拆掉。 */
  const lang = pickLang(path, cliArg(argv, '--lang'));
  if (hasAdapter(lang)) return sxTextOf(path, argv);
  const got = graphOf(path, argv);
  if (got.code !== undefined) return null;
  const back = backends().find((b) => b.name === 'core');
  try {
    return back.lower(shrinkOf(got.graph, argv)).text;
  } catch (err) {
    if (err instanceof Gap) throw new OmniError(`${path}：这一格还没接住 —— ${err.message}`);
    throw err;
  }
}

export function runGraphFile(path, argv) {
  const back = pickBackend('run', argv, 'interp');
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const { lang } = got;
  const graph = shrinkOf(got.graph, argv);
  if (lang.jsRuntime) graph.jsRuntime = lang.jsRuntime;
  const st = statOf(graph, argv, path);

  // ---- 图 -> 那条腿。缺口与"跑错了"分开记
  let art = null;
  try {
    art = back.lower(graph);
  } catch (err) {
    if (err instanceof Gap) {
      stderr(`omni: ${back.name} 这条腿接不住 —— ${err.message}\n`);
      return 3;
    }
    throw err;
  }
  /* 各层的账：这条腿的目标文本大小只有降完才知道（interp 那条没有文本 —— 报 0）。 */
  if (st !== null) statLayersGraph(path, st, typeof art.text === 'string' ? art.text.length : 0, argv);
  if (back.runnable === false) {
    // sx：印那份文本，顺带把"读回来还是同一张图"验一遍（那是它在矩阵里的判据）
    stdout(`${art.text}\n`);
    if (typeof art.reread === 'function' && art.reread() !== art.text) {
      throw new OmniError('sx: 读回来再序列化与原文不一样 —— 序列化这一格坏了');
    }
    return 0;
  }
  const { out } = runOr(back, art, path, lang.name);
  for (const line of out) stdout(`${line}\n`);
  return 0;
}

/**
 * 真跑那一下。**跑错了与接不住是两件事**：接不住是 `Gap`（上面那一格，退出码 3），
 * 跑错了是这份源码自己的事（`unbound name: x`、缺键、越界…）—— 那也得是一句人话，
 * 不许把 JS 的调用栈糊到用户脸上。
 */
function runOr(back, art, path, langName) {
  try {
    return art.run();
  } catch (err) {
    if (err instanceof Gap) {
      throw new OmniError(`omni: ${back.name} 这条腿接不住 —— ${err.message}`);
    }
    throw new OmniError(`${path}（${langName} × ${back.name}）跑的时候错了 —— ${err.message}`);
  }
}

/**
 * `omni build --engine graph -o OUT`：把那条腿的**产物**落成一个文件。
 *
 * 三条腿有产物、一条没有，而"没有"这件事要说清而不是含糊过去：
 *   wat  一份自足的 `.wat` 模块（宿主面就是那四格 `print_*` 导入）—— wasm 是真后端，
 *        不是只在测试里跑一跑的那种（这正是 target.md 那一条的落点）
 *   sx   一份图的序列化（`fromSx` 读得回来 —— 那是它自己的判据）
 *   js   一份**自足的 `.mjs`**（第一百五十一片）：十四个钩子的文本版摊在最前面
 *        （`js_rt.js`），`node x.mjs` 直接跑。从前这一格是"落不了"，理由是钩子得由外面喂
 *        —— 钩子有文本版之后那句话就不成立了
 *   interp 没有产物：它就是 `graph.eval`（§5：默认解释器不是"另一个后端"）。
 */
export function buildGraphFile(path, argv) {
  const back = pickBackend('build', argv, 'wat');
  if (back.name === 'interp') {
    throw new OmniError('build --engine graph --backend interp：interp 没有产物 —— '
      + '它就是 graph.eval（要跑就 `omni run --engine graph`）');
  }
  if (back.name === 'js') {
    /* 从前这儿是一句拒绝："那份文本是一格函数表达式，要外面喂十几个运行时钩子"。
     * 钩子有文本版之后（`js_rt.js` 的 `GRAPH_JS_RT`）那句话作废 —— 落的是一份**自足的
     * ESM**，`node x.mjs` 直接跑。判据 `tests/graph/js-artifact.js`：产物跑出来的 stdout
     * 与本进程那条腿逐行相同（那条判据同时钉住"文本版的钩子不许与 eval.js 分叉"）。 */
    const got = graphOf(path, argv);
    if (got.code !== undefined) return got.code;
    const graph = shrinkOf(got.graph, argv);
    if (got.lang && got.lang.jsRuntime) graph.jsRuntime = got.lang.jsRuntime;
    statOf(graph, argv, path);
    const base = path.lastIndexOf('/') >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path;
    const stem = base.lastIndexOf('.') > 0 ? base.slice(0, base.lastIndexOf('.')) : base;
    const out = cliArg(argv, '-o') ?? `${stem}.mjs`;
    const text = back.lower(graph).module(`${path}（${got.lang.name} × 图那一层的 js 后端）`);
    writeText(out, text);
    stderr(`omni: built ${out}（${text.length} 字节，${got.lang.name} × js —— 自足，node ${out} 直接跑）\n`);
    return 0;
  }
  const got = graphOf(path, argv);
  if (got.code !== undefined) return got.code;
  const graph = shrinkOf(got.graph, argv);
  if (got.lang && got.lang.jsRuntime) graph.jsRuntime = got.lang.jsRuntime;
  statOf(graph, argv, path);  const dot = path.lastIndexOf('/') >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path;
  const stem = dot.lastIndexOf('.') > 0 ? dot.slice(0, dot.lastIndexOf('.')) : dot;
  /* js 那条腿的默认后缀是 `.mjs`（第一百五十一片）：产物离开这个仓库之后，`.js` 还要靠
   * package.json 的 `"type": "module"` 才被当模块，而 `.mjs` 在哪儿都是模块。 */
  const out = cliArg(argv, '-o') ?? `${stem}.${back.name === 'js' ? 'mjs' : back.name}`;
  let art = null;
  try {
    art = back.lower(graph);
  } catch (err) {
    if (err instanceof Gap) {
      stderr(`omni: ${back.name} 这条腿接不住 —— ${err.message}\n`);
      return 3;
    }
    throw err;
  }
  // **产物按后缀定**：`-o x.wat` 落文本，`-o x.wasm` 落**二进制**（`wasm/assemble.js` 装的）。
  // 这一格是"wasm 是真后端"最后半步：真引擎吃的是二进制，`.wat` 得先有人装。
  // 装出来的东西 V8 认（判据在 `tests/graph/wasm.js` 与 `tests/graph/cli.js`）。
  if (back.name === 'wat' && out.endsWith('.wasm')) {
    const bin = watToWasm(art.text);
    // `writeBinary` 收的是 latin1 串（宿主面就这一格），一字节一个码位
    writeBinary(out, Array.from(bin, (b) => String.fromCharCode(b)).join(''));
    stderr(`omni: built ${out}（${bin.length} 字节，${got.lang.name} × wat -> wasm 二进制）\n`);
    return 0;
  }
  writeText(out, `${art.text}\n`);
  stderr(`omni: built ${out}（${art.text.length} 字节，${got.lang.name} × ${back.name}）\n`);
  return 0;
}

/** `--engine graph --help` 那几行（`cmds.js` 里引它，免得两处各写一套）。 */export function graphEngineHelp() {
  const langs = [...LANGS.entries()].filter(([, d]) => d.guess !== false)
    .map(([n, d]) => `${n}(.${d.exts.join(' .')})`).join('  ');
  const named = [...LANGS.entries()].filter(([, d]) => d.guess === false)
    .map(([n, d]) => `${n}(.${d.exts.join(' .')} 归 ${d.extends}，只能点名)`).join('  ');
  return `--engine graph：走节点图那台机器（ADR-0033）—— ${LANGS.size} 门语言共用一份节点清单与一份契约。
  语言按 --lang 定，没给就按后缀猜（**--lang 优先**：.lua 既可能是 lua 也可能是 gsl-shell）：
    ${langs}
  只能 --lang 点名的（后缀被别人占着）：${named}
  --backend 这一层有四条：${graphBackendNames().join(' / ')}
    interp  默认，就是 graph.eval（调度器的读法）
    js      降成 JS 源码：run 在本进程里跑掉，build 落一份**自足的 .mjs**（node 直接跑）
    wat     降成 WAT，交给 frontend-wat 读回来用 MIR 解释器跑（互不相干的实现来证）
    sx      只序列化：印图的文本 + 验一遍读回来逐字节相同（不出输出行）
  退出码：0 跑通 · 1 语法或映射说不通 · 3 那条腿有缺口（有名有姓）`;
}
