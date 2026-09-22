// ext/cpp/adapter/expr.js —— **C++ 的树 → 标准 IR 的表达式**（ADR-0044）
//
// 这一门的类型是**写着的**（`int` / `double` / `Point` / `std::map<std::string,int>`），
// 所以类型那半笔账是照抄；`auto` 那一格从初值取。C++ 自己的几处在这一份里：
//   * `printf("%d\n", x)` / `puts(s)` —— 落成方言的 `print`（一格值一行，见 `printArgs`）；
//   * `(int)e` 与 `static_cast<double>(e)` 是转换（`toint` / `toreal`）；
//   * `m["a"]` 既可能是数组下标也可能是字典的键 —— 按**声明的类型**分；
//   * `m.count(k)` 是"在不在"、`std::make_pair(a,b)` 是一格两格值的记录（字段叫
//     `first` / `second`，那是 C++ 自己的名字）。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';

const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['&&', '&&'], ['||', '||'], ['&', '&'], ['|', '|'], ['<<', '<<'], ['>>', '>>'], ['^', '^'],
]);

/** 基本类型名 → 标准 IR 的类型。 */
const BTYPES = new Map([
  ['int', INT], ['long', INT], ['short', INT], ['unsigned', INT], ['size_t', INT],
  ['char', INT], ['bool', BOOL], ['double', REAL], ['float', REAL], ['void', { kind: 'void' }],
]);

export const nameOf = (x) => (tag(x) === 'n' ? String(leaf(kids(x)[0])) : String(leaf(x)));
export const tyArg = (type) => ({ kind: 'type', type });

/**
 * `(specs …)` → 标准 IR 的类型。认得的形状：
 *   `(btype int)` · `(n myint)`（别名或记录）· `(auto)` · `(qual (n std) …)` ·
 *   `(qual (n std) (tid (n map) (targs …)))`（字典）· `const` / `typedef` 那些修饰跳过。
 */
export function typeOfSpecs(specs, C, declTok) {
  if (specs === undefined) return INT;
  const parts = kids(specs).filter((y) => {
    const t = tag(y);
    if (t === null) return String(leaf(y)) !== 'const' && String(leaf(y)) !== 'static'
      && String(leaf(y)) !== 'typedef';
    return true;
  });
  /* `char *` / `const char *` → 串（C 里串就是 `char*`）。 */
  const isPtr = declTok !== undefined && tag(declTok) === 'ptr';
  for (const p of parts) {
    if (tag(p) === 'btype') {
      const n = String(leaf(kids(p)[0]));
      if (n === 'char' && isPtr) return STR;
      const t = BTYPES.get(n);
      if (t !== undefined) return t;
      throw new Error(`cpp->IR: 这个基本类型还没接：${n}`);
    }
    if (tag(p) === 'auto') return null;            // 从初值取
    if (tag(p) === 'n') {
      const n = nameOf(p);
      if (C.aliases.has(n)) return C.aliases.get(n);
      if (C.records.has(n)) return named(C.ref(n), true);
      throw new Error(`cpp->IR: 这个类型名还没接：${n}`);
    }
    if (tag(p) === 'qual') return qualType(p, C);
    if (tag(p) === 'class' || tag(p) === 'elaborated') {
      const nm = kids(p).find((y) => tag(y) === 'n');
      if (nm !== undefined && C.records.has(nameOf(nm))) return named(C.ref(nameOf(nm)), true);
      return null;
    }
  }
  return INT;
}

/** `std::map<std::string, int>` / `std::string` / `std::vector<int>`。 */
function qualType(q, C) {
  const last = kids(q)[kids(q).length - 1];
  if (tag(last) === 'n') {
    const n = nameOf(last);
    if (n === 'string') return STR;
    throw new Error(`cpp->IR: 这个 std:: 类型还没接：${n}`);
  }
  if (tag(last) === 'tid') {
    const base = nameOf(kids(last)[0]);
    const targs = part(last, 'targs');
    const args = targs === undefined ? [] : kids(targs)
      .map((a) => typeOfSpecs(part(a, 'specs') ?? kids(a)[0], C));
    if (base === 'map' || base === 'unordered_map') return dictOf(args[1] ?? INT);
    if (base === 'vector') return arrOf(args[0] ?? INT);
    if (base === 'pair') return C.mvType([args[0] ?? INT, args[1] ?? INT], ['first', 'second']);
    throw new Error(`cpp->IR: 这个模板类型还没接：${base}`);
  }
  throw new Error('cpp->IR: 这一格 qual 类型还没接');
}

/** 一格二元：数值那一格要自己补转换。 */
function mkBin(op, a, b, C) {
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = { kind: 'builtin', name: 'toreal', args: [b] };
  if (ta.kind === 'int' && tb.kind === 'real') l = { kind: 'builtin', name: 'toreal', args: [a] };
  return { kind: 'binop', op, left: l, right: r };
}

/** 一格表达式。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': {
      const t = String(leaf(kids(x)[0]));
      const v = Number(t);
      return (t.includes('.') || /[eE]/.test(t))
        ? { kind: 'real', value: v } : { kind: 'int', value: v };
    }
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    case 'n': {
      const n = nameOf(x);
      if (n === 'true') return { kind: 'bool', value: true };
      if (n === 'false') return { kind: 'bool', value: false };
      return { kind: 'name', name: C.ref(n) };
    }
    case 'paren': case 'expr': return exprOf(kids(x)[0], C);
    case 'this': return { kind: 'name', name: 'this' };
    /* `p.x` 与 `this->tag` —— 同一格字段。 */
    case 'dot': case 'arrow':
      return { kind: 'field', obj: exprOf(kids(x)[0], C), name: nameOf(kids(x)[1]) };
    case 'bin': {
      const [op, a, b] = kids(x);
      const o = OPS.get(String(leaf(op)));
      if (o === undefined) throw new Error(`cpp->IR: 这个算子还没接：${leaf(op)}`);
      return mkBin(o, exprOf(a, C), exprOf(b, C), C);
    }
    case 'un': {
      const [op, a] = kids(x);
      const o = String(leaf(op));
      if (o === '!') return { kind: 'unop', op: '!', operand: condOf(a, C) };
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    /* `xs[0]` / `m["a"]` —— 按声明的类型分（数组的下标 vs 字典的键）。 */
    case 'index': {
      const obj = exprOf(kids(x)[0], C);
      const key = exprOf(kids(x)[1], C);
      const t = typeOf(obj, C.tyCtx());
      if (t.kind === 'map') return { kind: 'builtin', name: 'dget', args: [obj, key] };
      return { kind: 'index', obj, index: key };
    }
    /* `(int)e` 与 `static_cast<double>(e)`。 */
    case 'cast': case 'named-cast': {
      const tyTok = kids(x).find((y) => tag(y) === 'type');
      const target = typeOfSpecs(part(tyTok, 'specs') ?? kids(tyTok)[0], C);
      const v = exprOf(kids(x)[kids(x).length - 1], C);
      const t = typeOf(v, C.tyCtx());
      if (target !== null && target.kind === 'int') {
        return t.kind === 'int' ? v : { kind: 'builtin', name: 'toint', args: [v] };
      }
      if (target !== null && target.kind === 'real') {
        return t.kind === 'real' ? v : { kind: 'builtin', name: 'toreal', args: [v] };
      }
      return v;
    }
    case 'call': return callOf(x, C);
    case 'qual': {
      /* `std::something` 当值用（这一批只有 `std::make_pair` 那一处，在 callOf 里）。 */
      throw new Error(`cpp->IR: \`${kids(x).map((k) => (tag(k) === 'n' ? nameOf(k) : '?')).join('::')}\` 当值用还没接`);
    }
    default:
      throw new Error(`cpp->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** 一格调用。 */
function callOf(x, C) {
  const fn = kids(x)[0];
  const argsTok = part(x, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);
  /* `m.count(k)` —— 字典里有没有这个键。 */
  if (tag(fn) === 'dot' || tag(fn) === 'arrow') {
    const obj = exprOf(kids(fn)[0], C);
    const m = nameOf(kids(fn)[1]);
    const t = typeOf(obj, C.tyCtx());
    if (m === 'count' && t.kind === 'map') {
      return { kind: 'builtin', name: 'dhas', args: [obj, exprOf(rawArgs[0], C)] };
    }
    if (m === 'size') {
      return { kind: 'builtin', name: t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen'), args: [obj] };
    }
    if (m === 'push_back' && t.kind === 'arr') {
      return { kind: 'builtin', name: 'apush', args: [obj, exprOf(rawArgs[0], C)] };
    }
    throw new Error(`cpp->IR: \`.${m}()\` 这一格方法还没接`);
  }
  /* `std::make_pair(a, b)` —— 一格两格值的记录（字段叫 first / second）。 */
  if (tag(fn) === 'qual') {
    const nm = nameOf(kids(fn)[kids(fn).length - 1]);
    const args = rawArgs.map((a) => exprOf(a, C));
    if (nm === 'make_pair') {
      const ty = C.mvType(args.map((a) => typeOf(a, C.tyCtx())), ['first', 'second']);
      return {
        kind: 'new-record',
        type: ty,
        ref: false,
        fields: [{ name: 'first', value: args[0] }, { name: 'second', value: args[1] }],
      };
    }
    throw new Error(`cpp->IR: \`std::${nm}()\` 还没接`);
  }
  const name = nameOf(fn);
  const args = rawArgs.map((a) => exprOf(a, C));
  if (name === 'printf' || name === 'puts') {
    throw new Error(`cpp->IR: \`${name}\` 在表达式位置上（它不交值）`);
  }
  return { kind: 'call', fn: { kind: 'name', name: C.ref(name) }, args };
}

/**
 * `printf(格式, 实参…)` / `puts(串)` → 一串 `print`。
 *
 * **只接"一格转换 + 末尾换行"那一档**（`"%d\n"` / `"%g\n"` / `"%s\n"`）与纯文本 ——
 * 与从前那条路同一个范围。别的格式（宽度、几格转换挤一行）当场报，不糊弄：
 * 那要把 `fmt.js` 那套格式化接进来，是另一件事。
 */
export function printArgs(name, rawArgs, C) {
  if (name === 'puts') {
    return [{ kind: 'print', values: [exprOf(rawArgs[0], C)] }];
  }
  const fmtTok = rawArgs[0];
  if (fmtTok === undefined || tag(fmtTok) !== 'str') {
    throw new Error('cpp->IR: printf 的格式串不是字面量 —— 那要运行期的格式化（还没接）');
  }
  const fmt = String(unquote(leaf(kids(fmtTok)[0])));
  const specs = fmt.match(/%[-+ #0]*[0-9]*(?:\.[0-9]+)?[a-zA-Z]/g) ?? [];
  if (specs.length === 0) {
    const text = fmt.replace(/\\n$/, '');
    return [{ kind: 'print', values: [{ kind: 'string', value: text }] }];
  }
  if (specs.length !== 1 || !/\\n$/.test(fmt) || fmt.replace(/%[a-zA-Z]|\\n/g, '') !== '') {
    throw new Error(`cpp->IR: 这个格式串还没接：${fmt}（这一批只接"一格转换 + 换行"）`);
  }
  return [{ kind: 'print', values: [exprOf(rawArgs[1], C)] }];
}

/** 条件位置上的那一格（C++ 里"非零为真"）。 */
export function condOf(x, C) {
  /* 字面量在这儿就定下来（`while (1)`）。 */
  if (tag(x) === 'num') return { kind: 'bool', value: Number(leaf(kids(x)[0])) !== 0 };
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  throw new Error(`cpp->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}
