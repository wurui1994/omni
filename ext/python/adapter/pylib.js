// ext/python/adapter/pylib.js —— **库函数当真函数编**（一格样品 + 那张名字表）
//
// 路线在 `ext/python/SPEC.md` §一之二，一句话：**运行时整份借 CPython 的 C**
// （主路线是编到 C，JS 腿从同一份 C 出），所以**库函数不一格一格自己写** ——
// 既不在 adapter 里用 JS 铺 IR，也不在 `lib/*.py` 里用 python 写一遍。
//
// 那这一份留着干什么：它是那条路上**机制的一格样品**，两件事以后接借来的运行时还要用：
//   1. **库函数是"真函数"，不是编译期铺开的**：一处库调用落成一次真调用，
//      交什么类型问那格函数自己（不在 JS 里另抄一张返回类型表）。
//   2. **没人用的一格不发**：单态化按调用点收实例，一格实例都没有的函数不进产物 ——
//      "带着一份库"不等于"每个程序都胖一圈"。
// 另外它证了一条：`lib/*.py` 用**同一张语法表**就能解析（python 的起始规则是 `module`），
// 摆进 `C.fnNodes` 之后与用户写的函数走同一趟（推断 / 单态化 / 发射 / 三条腿）。
//
// **现在收着的只有 str 的补宽度那四格，不再长**（见 SPEC §二 那一刀）。
// 下一刀是把对象层借进来、adapter 改发"往借来的运行时里调一格"。

// **宿主 IO 走封闭 ABI**（`host/native.js`），路径计算走 `host/path.js` —— 这是 SDK 面的
// 规矩（docs/EXTENSIONS.md 第三节：「别直接碰 `node:fs`」）。上一刀这儿写的是
// `node:fs` + `node:url` + `node:path` 三条，于是 `npm run check:self` 整条红：
//   ext/python/adapter/pylib.js:18: 'node:fs' is not importable（ADR-0011 decision 2）
// `import.meta.url` 也一样不行 —— 它不在这门语言的子集里。
//
// **"树根在哪儿"由核心递进来**（`drive.js` → `toIR(tree, { root })` → `C.root`），扩展这一侧
// 不自己去找：往上数几层在源码腿与产物腿上不一样，那笔账核心那份 `treeRoot()` 已经算过了。
// 顺带解掉一个 import 环：从 `lower/langs.js` 取 `treeRoot` 会绕回这一份（langs → adapter → 这儿）。
import { readText } from '../../../src/core/host/native.js';
import { join } from '../../../src/core/host/path.js';
import {
  tag, kids, part, leaf,
} from '../../../src/core/lower/cst.js';

/** 顶层那几句（`(line …)` 那一层剥掉）—— 这儿只关心 `def`。 */
const topOf = (items) => items.flatMap((s) => (tag(s) === 'line' ? topOf(kids(s)) : [s]));

/** 库源码，按文件。次序无所谓（这一层只收 `def`，不跑模块级语句）。 */
const LIB_FILES = ['str.py', 'ucase.py'];

/**
 * **方法名 → 库函数名**，按接收者装的东西分。
 *
 * 键是 `<接收者的类型词>.<方法名>`（`string.zfill`）。这张表是**唯一**一处映射 ——
 * 发射那一侧（`methodOf`）、问类型那一侧（`methodType`）、收单态化实例那一侧
 * （`collectInsts`）都查它，所以不会再有"两处名单各写一遍"那种账。
 */
export const LIB_METHODS = new Map([
  ['string.ljust', '_str_ljust'],
  ['string.rjust', '_str_rjust'],
  ['string.zfill', '_str_zfill'],
  ['string.center', '_str_center'],
  /* **大小写那一族**（`lib/ucase.py`，表在 `rt/ucase.tab`）：从前非 ASCII 是"当场报还没接"
     （方言的 `supper` / `slower` 只动 A-Z），现在走查表那一份 —— 三条腿同一份 python 源码。 */
  ['string.upper', '_str_upper'],
  ['string.lower', '_str_lower'],
  ['string.casefold', '_str_casefold'],
]);

/** 接收者装的东西 + 方法名 → 库函数名（没有就答 null）。 */
export function libMethodFor(recvTy, name) {
  if (recvTy === null || recvTy === undefined) return null;
  return LIB_METHODS.get(`${recvTy.kind}.${name}`) ?? null;
}

/** 那格库函数的形参节点（`(p (n s) …)` 一串）—— 接收者算第一格。 */
export function libParams(fnName, C) {
  const f = C.fnNodes.get(fnName);
  if (f === undefined) return null;
  return kids(part(f, 'params') ?? { kind: 'list', items: [] }).filter((p) => tag(p) === 'p');
}

/**
 * 调用点少给的那几格**默认值的原文树**（`s.ljust(4)` 里那个 `fill=" "`）。
 *
 * 与用户函数那一侧（`kwOrder`）同一条办法：默认值是调用点展开的。这儿不走 `kwOrder`
 * 是因为它按"这份源码里的函数"认签名，而库函数的调用点在 CST 里长的是**方法**的样子。
 */
export function libFillToks(fnName, nGiven, C) {
  const ps = libParams(fnName, C);
  if (ps === null) return null;
  const out = [];
  for (let i = nGiven; i < ps.length; i += 1) {
    const d = part(ps[i], 'default');
    if (d === undefined) return null;                 // 少了一格必给的 —— 交给下游报
    out.push(kids(d)[0]);
  }
  return out;
}

/**
 * 把 `ext/python/lib/*.py` 读进来，里头的 `def` 摆进 `C.fnNodes`。
 *
 * 用的是 `drive.js` 递进来的 `parseExpr`（"同一张表再解析一遍"那条口子，f-string 也走它）
 * —— python 的起始规则就是 `module`，所以整份文件直接解析得下来。
 */
export function loadPyLib(C) {
  if (C.parseExpr === null) {
    throw new Error('python->IR: 库那一份没法解析（`drive.js` 的 `parseExpr` 没递进来）');
  }
  const dir = join(C.root ?? '.', 'ext', 'python', 'lib');
  for (const file of LIB_FILES) {
    const src = readText(join(dir, file));
    const tree = C.parseExpr(src);
    if (tree === null) throw new Error(`python->IR: 库 \`lib/${file}\` 解析不动`);
    for (const nd of topOf(kids(tree))) {
      if (tag(nd) !== 'def') continue;
      /* `def` 的名字那一格一定是 `(n 名字)`（上一行的 `find` 就按它挑的），所以直接取叶子 ——
         不走 `expr.js` 的 `nameOf`：那会与 `expr.js` 结一个 import 环（它 import 这一份）。 */
      const nm = String(leaf(kids(kids(nd).find((y) => tag(y) === 'n'))[0]));
      if (C.fnNodes.has(nm)) {
        throw new Error(`python->IR: 库 \`lib/${file}\` 里的 \`${nm}\` 与这份源码里的同名`);
      }
      C.fnNodes.set(nm, nd);
      C.libFns.add(nm);
    }
  }
}
