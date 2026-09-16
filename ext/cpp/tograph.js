// ext/cpp/tograph.js —— **C++ 的树 -> 节点图**（第十门语言，最贵的那一门）
//
// 这一份的意义不在"又多一门"，在于它是**唯一一门语法本身会两解**的语言：
// `printf(...)` 与 `int x = 3;` 在 GLR 下都曾经两支都归约得成。三类歧义量下来
// 两类是"语法写松了"（至多一格 type-spec、函数定义不进语句 —— 都改在 cpp.grammar 里），
// 只有 `T * x;` 那一类是真要"回问这名字登记成类型了吗"（task #15 剩下的那一笔）。
//
// 这一批明说的约定（不猜）：
//   * **类型全丢**（与 go / V 同一条：type 是端口的 sort，不是图上的格子）；
//   * **`printf` 的格式串不是节点**：只认 `"%d\n"` 与 `"%s\n"` 两种，把它当"打印一格值"
//     收 —— 格式化本身要等一格 `format` 内建。别的格式串当场报错。
//   * 入口是 `main`：映射末尾显式补一格 `call main`（与 go / V 同一条约定）。

import {
  node, lit, program, bin, un,
} from '../../src/core/graph/graph.js';
import {
  isList, tag, kids, leaf, part,
  ops, binOf, retOf, branchOf, loopExit,
} from '../../src/core/graph/fromtree.js';

const OPS = ops();

const many = (xs) => xs.map(toNode).flat();

/** 一格名字：`(n x)` 或光秃秃的叶子。 */
const nameOf = (x) => (tag(x) === 'n' || tag(x) === 'name' ? leaf(kids(x)[0]) : leaf(x));

/**
 * 声明符里那个名字。修饰可以套好几层（`const char* t` 是 `(d (ptr * (n t)) …)`，
 * `int a[3]` 是 `(d (arr (n a) …))`），所以**往下找**，但有两处不进：
 *   * `init` —— `int x = y;` 里的 `y` 不是被声明的那个名字；
 *   * `specs` —— 用户定义的类型名也是名字（`myint n` 的 specs 里有 `(n myint)`），
 *     进去就会把类型名当成被声明的名字（量出来过：形参 `myint n` 一度绑成了 `myint`）。
 * 指针 / 引用 / 数组的修饰本身丢掉（类型全丢）。
 */
function findName(y) {
  if (!isList(y)) return null;
  if (tag(y) === 'n' || tag(y) === 'name') return nameOf(y);
  if (tag(y) === 'init' || tag(y) === 'specs') return null;
  for (const k of kids(y)) { const r = findName(k); if (r !== null) return r; }
  return null;
}
function declName(d) {
  const found = findName(d);
  if (found === null) throw new Error('cpp->graph: 这格声明符里找不到名字');
  return found;
}

/**
 * 一格串字面的**值**。cpp 的 STRING 是 `(token …)` 收的，记号里带着原样的
 * 前缀 / 引号 / 转义（量出来的：`"%d\n"` 的 leaf 是六个字符 `"`,`%`,`d`,`\`,`n`,`"`），
 * 与 go / V 那几门用 `(string …)` 收、词法就把这些去干净了的不一样。
 *
 * 去哪一层？**归这一层**：前缀（`u8` `L` `R`…）、转义表、相邻字面拼接（`"a" "b"` 是一格串）
 * 都是 C++ 的写法，图上只该有"一格串的值"。词法不动 —— 它要按原样收，生串才收得住。
 */
const ESC = {
  n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'",
  a: '\x07', b: '\b', f: '\f', v: '\v',
};
function oneStr(raw) {
  const s = String(raw);
  const q = s.indexOf('"');
  if (q < 0) throw new Error('cpp->graph: 这格串字面里找不到引号');
  const prefix = s.slice(0, q);
  if (prefix.includes('R')) {                       // 生串：`R"(…)"`，里头不解释转义
    return s.slice(q + 2, -2);
  }
  const body = s.slice(q + 1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const e = body[i + 1];
    if (!(e in ESC)) throw new Error(`cpp->graph: 还没接这个转义：\\${e}`);
    out += ESC[e]; i += 1;
  }
  return out;
}
/** `(str STRING…)` —— 相邻的几格字面接成一格。 */
const strVal = (x) => kids(x).map((k) => oneStr(leaf(k))).join('');

/** `printf` 的格式串：只认这几种，别的报错（格式化不是节点 —— 见文件头）。 */
const FORMATS = new Set(['%d\n', '%s\n', '%ld\n', '%f\n']);

function toNode(x) {
  switch (tag(x)) {
    // ---- 叶子与名字 --------------------------------------------------------
    case 'num': return node('const', {}, { value: Number(leaf(kids(x)[0])) });
    case 'str': return node('const', {}, { value: strVal(x) });
    case 'n': case 'name': return node('ref', {}, { name: nameOf(x) });
    case 'paren': return toNode(kids(x)[0]);
    case 'expr': return toNode(kids(x)[0]);
    case 'pp': return [];                       // `#include` 丢掉（这一批不做预处理）
    case 'unit': return many(kids(x));
    case 'block': return node('region', { body: many(kids(x)) });
    case 'body': return many(kids(x));

    // ---- 算子 --------------------------------------------------------------
    case 'bin': {
      const [op, a, b] = kids(x);
      return binOf(leaf(op), toNode(a), toNode(b), OPS, { lang: 'cpp' });
    }
    case 'un': {
      const [op, a] = kids(x);
      return un(leaf(op) === '!' ? 'not' : leaf(op), toNode(a));
    }
    // `i++` / `++i`：图上就是"加一再赋回去"（不给它开节点 —— 与另外八门同一条）
    case 'post': case 'pre': {
      const [op, t] = kids(x);
      return node('set', {
        value: bin(leaf(op) === '++' ? '+' : '-', toNode(t), lit(1)),
      }, { name: nameOf(t) });
    }
    case 'assign': {
      const [op, t, v] = kids(x);
      const o = leaf(op) === '=' ? null : OPS.get(String(leaf(op)).replace('=', ''));
      if (leaf(op) !== '=' && o === undefined) {
        throw new Error(`cpp->graph: 这个复合赋值还没接：${leaf(op)}`);
      }
      const name = nameOf(t);
      const value = o === null ? toNode(v) : bin(o, node('ref', {}, { name }), toNode(v));
      return node('set', { value }, { name });
    }

    // ---- 声明与函数 --------------------------------------------------------
    // `int x = 3, y;` -> 一串 bind（**decl 就是 bind**，没有 decl 节点）
    case 'decl': {
      const specs = part(x, 'specs');
      // `typedef int myint;` —— **图上没有它**。类型是端口的 sort，不是格子（与 go / V 同一条）。
      // 它在语法那侧却很要紧：那一格是驱动器"这名字登记成类型了吗"的登记处。
      if (specs !== undefined && kids(specs).some((s) => !isList(s) && leaf(s) === 'typedef')) return [];
      const initPart = part(x, 'init');
      if (initPart === undefined) return [];    // `struct Foo;` 这种纯声明：图上没有它
      return kids(initPart).filter((d) => tag(d) === 'd').map((d) => {
        const v = part(d, 'init');
        return node('bind', {
          init: v === undefined ? lit(null) : toNode(kids(v)[0]),
        }, { name: declName(d) });
      });
    }
    case 'func': {
      const fn = part(x, 'fn');
      const name = nameOf(kids(fn).find((y) => tag(y) === 'n' || tag(y) === 'name'));
      const ps = part(fn, 'params');
      const params = ps === undefined ? [] : kids(ps).filter((p) => tag(p) === 'p').map(declName);
      const body = part(x, 'body');
      return node('bind', {
        init: node('func', { body: body === undefined ? [] : many(kids(body)) }, { params, name }),
      }, { name });
    }

    // ---- 控制流 ------------------------------------------------------------
    case 'return': return retOf(kids(x).length === 0 ? [] : [toNode(kids(x)[0])]);
    case 'break': return loopExit('break');
    case 'continue': return loopExit('continue');
    case 'empty': return [];
    case 'if': {
      const [c, then, els] = kids(x);
      return branchOf(toNode(c), toNode(then), els === undefined ? undefined : toNode(kids(els)[0]));
    }
    case 'while': {
      const [c, body] = kids(x);
      return node('loop', { cond: toNode(c), body: body === undefined ? [] : [toNode(body)] });
    }
    // `for (init; cond; post) body` -> region + loop（**步进单列一格端口**，continue 也要跑）
    case 'for': {
      const [init, cond, post, body] = kids(x);
      return node('region', {
        body: [
          ...(init === undefined ? [] : many([init])),
          node('loop', {
            cond: cond === undefined ? lit(true) : toNode(cond),
            body: body === undefined ? [] : [toNode(body)],
            post: post === undefined ? [] : many([post]),
          }),
        ],
      });
    }

    // ---- 调用与打印 --------------------------------------------------------
    case 'call': {
      const [fn, args] = kids(x);
      const argKids = args === undefined ? [] : kids(args);
      const callee = isList(fn) && (tag(fn) === 'n' || tag(fn) === 'name') ? nameOf(fn) : null;
      // `printf("%d\n", x)` -> prim print。**格式串不是节点**：只认那几种，别的报错
      if (callee === 'printf' || callee === 'puts') {
        if (callee === 'puts') return node('prim', { args: many(argKids) }, { name: 'print' });
        const fmt = argKids[0];
        if (fmt === undefined || tag(fmt) !== 'str' || !FORMATS.has(strVal(fmt))) {
          throw new Error('cpp->graph: printf 这一批只认 "%d\\n" / "%s\\n" 那几种格式串');
        }
        return node('prim', { args: many(argKids.slice(1)) }, { name: 'print' });
      }
      return node('call', { fn: toNode(fn), args: many(argKids) });
    }
    default:
      throw new Error(`cpp->graph: 这一格还没接：${tag(x) ?? JSON.stringify(x).slice(0, 40)}`);
  }
}

/** 一棵 cpp 的 GLR 树（`(unit 项…)`）-> 一张图。入口是 `main`（末尾补一格调用）。 */
export function cppToGraph(tree) {
  if (tag(tree) !== 'unit') throw new Error('cpp->graph: 这不是 (unit …)');
  const body = many(kids(tree));
  return program([...body, node('call', { fn: node('ref', {}, { name: 'main' }), args: [] })]);
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. 类型全丢；指针 / 引用 / 数组的修饰只从声明符里取名字（`const char* t` 的 `*` 丢掉）。
//   2. `T * x;` 那种"声明还是表达式"仍靠 `prefer` 偏表达式（真解要回问符号表，task #15）。
//   3. class / 模板 / 命名空间 / 运算符重载 / lambda / 异常都不在这一批 ——
//      它们各要一台机器（方法调用、实例化、作用域、闭包、切段）。
