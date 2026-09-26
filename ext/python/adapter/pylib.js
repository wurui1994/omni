// ext/python/adapter/pylib.js —— **python 的库函数在哪儿、怎么接进来**
//
// 立场：**库函数是运行时的事，不是语法的事**。`.zfill` / `.center` 这一族只在串与整数上
// 算，把它们写成一段 JS、在编译期铺成 IR，等于把标准库塞进语法层 —— 每加一格方法就往
// `methodOf` 那条 300 多行的 `if` 链上再挂一条，而且**三条腿各自没有一份能读的实现**。
//
// 这一份接的是另一条路：库函数用 **python 自己**写在 `ext/python/lib/*.py` 里，
// 这一层把那几份源码**用同一张语法表**解析一遍，把里头的 `def` 摆进 `C.fnNodes` ——
// 从此它们与用户写的函数**走同一趟**：类型推断、单态化、发射、三条腿。
//
// 三件好处是量得出来的：
//   1. 少一层实现 —— 语义只写一遍（python），不是"JS 里铺一遍 IR"再在脑子里对 CPython；
//   2. 编译期的限制自然消失（`.center(w)` 从前要求宽度是字面量，写成函数就没这回事）；
//   3. **没人用的一格都不发** —— 单态化按调用点收实例，一格实例都没有的函数不进产物。
//
// 代价说清：库函数从"就地铺开"变成"真的一次调用"（多一层栈）。这是对的代价 ——
// 要内联是后头优化那一层的事，不该靠"在编译期抄一遍"换。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tag, kids, part } from '../../../src/core/lower/cst.js';
import { nameOf } from './expr.js';

/** 顶层那几句（`(line …)` 那一层剥掉）—— 这儿只关心 `def`。 */
const topOf = (items) => items.flatMap((s) => (tag(s) === 'line' ? topOf(kids(s)) : [s]));

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/** 库源码，按文件。次序无所谓（这一层只收 `def`，不跑模块级语句）。 */
const LIB_FILES = ['str.py'];

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
  for (const file of LIB_FILES) {
    const src = readFileSync(join(LIB_DIR, file), 'utf8');
    const tree = C.parseExpr(src);
    if (tree === null) throw new Error(`python->IR: 库 \`lib/${file}\` 解析不动`);
    for (const nd of topOf(kids(tree))) {
      if (tag(nd) !== 'def') continue;
      const nm = String(nameOf(kids(nd).find((y) => tag(y) === 'n')));
      if (C.fnNodes.has(nm)) {
        throw new Error(`python->IR: 库 \`lib/${file}\` 里的 \`${nm}\` 与这份源码里的同名`);
      }
      C.fnNodes.set(nm, nd);
      C.libFns.add(nm);
    }
  }
}
