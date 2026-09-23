// ext/go/adapter/expr.js —— **go 的树 → 标准 IR 的表达式**（ADR-0044 第四片）
//
// go 与 V 的树几乎同形（`file` / `fn` / `define` / `for` / `if` / `return` / `call` / `sel`），
// 三处不一样，三处都在这一份里：
//   1. **形参是"类型在前、名字在后"**（`(p (tname int) (name n))`）—— V 反过来；
//   2. **印那一族走 `fmt.` 那一格选择子**（`fmt.Println`），而且 `Println` 收几格值时
//      **中间是一个空格**；一格多值的调用摊开也是（`fmt.Println(minmax(1,2))` -> `1 2`）；
//   3. **`&^` 是 and-not**、`x[a:b]` 在串上是取子串（`slice3`）。
//
// 别的（struct 落 `(class …)`、方法压成 `Type__名字`、多值合成一格记录、`defer` 逆序）
// 与 V 那一门同一条路子 —— 那几条在 `ext/vlang/adapter/` 里已经说过，这儿不重复。

import { tag, kids, leaf, part, unquote } from '../../../src/core/lower/cst.js';
import {
  INT, REAL, STR, BOOL, arrOf, dictOf, named, typeOf,
} from '../../../src/core/lower/ty-of.js';
import { foldIntConst, intLit } from '../../../src/core/lower/cfam.js';
import { cUnescape, fmtToIR } from '../../../src/core/lower/fmt.js';
import { mathConst, mathCall, hostCall } from './stdlib.js';

const OPS = new Map([
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'],
  ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='],
  ['&&', '&&'], ['||', '||'], ['&', '&'], ['|', '|'], ['^', '^'], ['<<', '<<'], ['>>', '>>'],
]);

/**
 * **无符号的那一格整数**：位宽与 int 同一格（方言里只有一种整数），差的是**七个算子**
 * （`>>` `/` `%` 与四个大小比较 —— 见 `10-unsigned.go` 文件头那段话）。
 * 所以类型上多带一位 `unsigned`，`mkBin` 按它选 `u>>` / `u/` 那一族。
 */
const UINT = { kind: 'int', unsigned: true };

const SCALARS = new Map([
  ['int', INT], ['int8', INT], ['int16', INT], ['int32', INT], ['int64', INT],
  ['uint', UINT], ['uint8', UINT], ['uint16', UINT], ['uint32', UINT], ['uint64', UINT],
  ['uintptr', UINT], ['byte', UINT], ['rune', INT],
  ['float32', REAL], ['float64', REAL], ['string', STR], ['bool', BOOL],
  ['error', INT], ['any', INT],
]);

export const PRINTS = new Set(['Println', 'Print', 'Printf']);
export const tyArg = (type) => ({ kind: 'type', type });
/**
 * 一格**接口**的类型描述（形状见 `iface.js`）。`iface: true` 那一位管两件事：
 * 零值是**空引用**（不是新造一格记录），以及"这一格已经是接口了，别再装箱"。
 */
export const ifaceType = (n) => ({ kind: 'named', name: n, ref: true, iface: true });
export const nameOf = (x) => {
  if (x === undefined || x === null) return '';
  const t = tag(x);
  if (t === 'name' || t === 'tname') return kids(x).map(leaf).join('.');
  return String(leaf(x));
};

/** 一格类型标注 → 标准 IR 的类型。`*T` 落 T（struct 一律引用语义）。 */
export function typeOfTok(tok, C) {
  if (tok === undefined || tok === null) return { kind: 'void' };
  switch (tag(tok)) {
    case 'none': return { kind: 'void' };
    case 'paren': return typeOfTok(kids(tok)[0], C);
    /* `*T` 落 T（struct 一律引用语义），可**"这一格是指针"要记着** —— 零值那儿
       指针是 nil、值语义的记录要真的造出来（`zeroval.go` 与自引用的树各判一头）。 */
    case 'ptr': {
      const inner = typeOfTok(kids(tok)[0], C);
      return inner.kind === 'named' ? { ...inner, ptr: true } : inner;
    }
    case 'tname': {
      const n = nameOf(tok);
      const short = n.includes('.') ? n.split('.').pop() : n;
      if (SCALARS.has(n)) return SCALARS.get(n);
      if (C.ifaces.has(short)) return ifaceType(short);
      if (C.records.has(short)) return named(C.ref(short), true);
      if (C.aliases.has(short)) return C.aliases.get(short);
      throw new Error(`go->IR: 这个类型还没接：${n}`);
    }
    /**
     * **写在类型位置上的 `interface{…}`**。`interface{}`（= `any`）一格方法都没有 ——
     * 那一格装什么都行，方言里没有对应的形状，所以当场报（不猜）。
     * 有方法的匿名接口按"一格具名接口"登记（名字按方法名单生成，同一形状只有一份）。
     */
    case 'interface': return C.anonIface(tok);
    /* **通道是一格句柄**（方言里就是 int）；元素类型记在 `chan` 那一位上（见 `conc.js`）。
       `chan T` / `chan<- T` / `<-chan T` 三种写法这一层不分方向。 */
    case 'chan': case 'chan-send': case 'chan-recv':
      return { kind: 'int', chan: typeOfTok(kids(tok)[0], C) };
    case 'slice': case 'array': {
      /* `[3]int` 的元素在第二格、`[]int` 的在第一格。**定长数组的长度要记着** ——
         `var arr [3]int` 的零值是"三格"，不是空数组（`vardecl.go` 判的是这一条）。 */
      const ks = kids(tok);
      const t = arrOf(typeOfTok(ks[ks.length - 1], C));
      /* **定长数组的长度可以是一格编译期常量**（`vec [rngLen]int64` —— `math/rand` 那份桩）：
         按常量算一遍，算不出来就不记（那时零值是空数组，症状是"下标越界 0（长度 0）"）。 */
      if (tag(tok) === 'array') {
        const n = constIntOf(ks[0], C);
        if (n !== null) t.len = n;
      }
      return t;
    }
    /* `[...]T{…}` —— 长度由字面量里那几格定（`arrLit` 按 items 算）。 */
    case 'array-auto': return arrOf(typeOfTok(kids(tok)[0], C));
    case 'map': return dictOf(typeOfTok(kids(tok)[1], C), typeOfTok(kids(tok)[0], C));
    case 'struct': return C.anonRecord(tok);
    case 'fntype': {
      const sig = part(tok, 'sig');
      const inTok = sig === undefined ? undefined : part(sig, 'in');
      const params = paramsOf(inTok, C).map((p) => p.type);
      const outTok = sig === undefined ? undefined : part(sig, 'out');
      return { kind: 'fn-type', params, ret: retTypeOf(outTok, C) };
    }
    default:
      throw new Error(`go->IR: 这一格类型标注还没接：${tag(tok)}`);
  }
}

/**
 * `(in …)` / `(out …)` 里那一串 → `[{ name, type, variadic }]`。
 *
 * **成组的声明**（`func f(x, y float64)`）在树上是"前几格只有类型、类型落在最后那一格上"：
 * `(in (p (tname x)) (p (tname float64) (name y)))` —— 前面那格 `(tname x)` 其实是**名字**。
 * go 自己的规矩是"要么全带名字、要么全不带"，所以：这一串里只要有一格带 `(name …)`，
 * 光秃秃的那几格就当名字；一格都没有就全是类型（`func(int, string)`）。
 */
export function paramsOf(listTok, C) {
  const items = listTok === undefined || listTok === null ? [] : kids(listTok);
  const anyNamed = items.some((p) => tag(p) === 'p' && part(p, 'name') !== undefined);
  const out = [];
  let pending = [];
  for (const p of items) {
    /* `(out (tname int))` —— 返回那一串常常没裹 `(p …)`。 */
    if (tag(p) !== 'p') { out.push({ name: null, type: typeOfTok(p, C), variadic: false }); continue; }
    const nTok = part(p, 'name');
    const tyTok = kids(p).find((y) => tag(y) !== 'name' && tag(y) !== null);
    const variadic = kids(p).some((y) => leaf(y) === 'variadic');
    if (nTok === undefined && anyNamed) { pending.push(tyTok); continue; }
    const type = typeOfTok(tyTok, C);
    for (const q of pending) out.push({ name: nameOf(q), type, variadic: false });
    pending = [];
    out.push({ name: nTok === undefined ? null : nameOf(nTok), type, variadic });
  }
  if (pending.length > 0) throw new Error('go->IR: 成组的形参里最后那一格没写类型');
  return out;
}

/** `(out …)` → 返回那一格的类型（**多格就合成一格记录**）。 */
export function retTypeOf(outTok, C) {
  return retOf(paramsOf(outTok, C), C);
}

/** 几格返回值 → 一格类型。 */
export function retOf(results, C) {
  if (results.length === 0) return { kind: 'void' };
  return results.length === 1 ? results[0].type : C.mvType(results.map((r) => r.type));
}

/** 一格类型的零值（go 里"声明就有零值"，这一门到处要它）。 */
export function zeroExpr(type, C) {
  /* **接口与指针的零值是空引用**（go 的 nil）—— 不是新造一格记录。 */
  if (type.iface === true || (type.kind === 'named' && type.ptr === true)) {
    return { kind: 'null', type };
  }
  switch (type.kind) {
    case 'real': return { kind: 'real', value: 0 };
    case 'string': return { kind: 'string', value: '' };
    case 'bool': return { kind: 'bool', value: false };
    case 'arr': return {
      kind: 'builtin',
      name: 'anew',
      args: [tyArg(type), { kind: 'int', value: type.len ?? 0 }],
    };
    case 'map': return { kind: 'builtin', name: 'dnew', args: [tyArg(type)] };
    case 'fn-type': return { kind: 'null', type };
    case 'named': return { kind: 'new-record', type, ref: type.ref === true, fields: C.zeroFields(type) };
    default: return { kind: 'int', value: 0 };
  }
}

/**
 * **go 的无类型常量跟着目标类型走**：`Vec{1, 2}` 里那两个 1、2 落在 float64 的字段上
 * 是 1.0、2.0（方言那侧是强类型的，写错了当场报"Vec.X 是 real，写进去的是 int"）。
 * `nil` 落在具名类型上是**空引用**，不是 0。
 */
export function coerce(value, target, C) {
  if (value === null || value === undefined || target === null || target === undefined) return value;
  if (target.kind === 'real') {
    if (value.kind === 'int') return { kind: 'real', value: value.exact ?? value.value };
    const t = typeOf(value, C.tyCtx());
    if (t.kind === 'int') {
      return { kind: 'builtin', name: t.unsigned === true ? 'torealu' : 'toreal', args: [value] };
    }
  }
  if (value.fromNil === true) {
    if (target.kind === 'named' || target.iface === true) return { kind: 'null', type: target };
    /* **nil 的切片与字典**：go 里它们 `len` 是 0、能读不能写 —— 落成空的那一格就够
       （`(null (arr T))` 上 `alen` 是说不通的）。`42-nil-assign.go` 判的正是 `len` 为 0。 */
    if (['arr', 'map', 'fn-type'].includes(target.kind)) return zeroExpr(target, C);
  }
  /**
   * **装箱**：具体类型的值落在接口那一格上时包一次 `__box_T__I`（ADR-0040）。
   * 这一格摆在 `coerce` 里不是巧合 —— "要装箱"与"无类型常量要升格"是同一件事：
   * *目标类型已知*。于是字段、元素、实参、返回、赋值那五处一次全有了。
   */
  if (target.iface === true) {
    const t = typeOf(value, C.tyCtx());
    if (t.kind === 'named' && t.iface !== true) return C.box(value, target.name, t.name);
  }
  return value;
}

/**
 * 一格**带着目标类型**的表达式。两件事只在这儿做：
 *   * **省掉类型的字面量**（`[][]int{{1,2}}` 里那个 `{1,2}`）—— 类型从外头来；
 *   * 无类型常量按目标类型升格（`coerce`）。
 * 凡是"这一格要装进某个已知类型里"的位置（字段、元素、实参、返回、赋值）都走它。
 */
export function valueOf(tok, type, C) {
  if (tok === undefined || tok === null) return null;
  if (tag(tok) === 'paren') return valueOf(kids(tok)[0], type, C);
  if (tag(tok) === 'elit') return litWithType(type ?? INT, kids(tok), C);
  return coerce(exprOf(tok, C), type, C);
}

/** 数值升实数。 */
function mkBin(op, a, b, C) {
  /* **无类型常量的算术按任意精度折**（go 的规矩）：`1 << 63` 当 real 用时是
     9223372036854775808.0，当 int 用时才是最小的 int64。两个都记着（`exact` 那一位），
     `coerce` 到 real 时用前者 —— `float64(x) / (1 << 63)` 的符号靠它（量出来的）。 */
  const folded = foldIntConst(op, a, b);
  if (folded !== null) return folded;
  const ta = typeOf(a, C.tyCtx());
  const tb = typeOf(b, C.tyCtx());
  let l = a;
  let r = b;
  if (ta.kind === 'real' && tb.kind === 'int') r = coerce(b, REAL, C);
  if (ta.kind === 'int' && tb.kind === 'real') l = coerce(a, REAL, C);
  /* `p == nil` —— 一边是具名类型时，另一边那格 `nil` 要变成空引用。 */
  if (op === '==' || op === '!=') {
    if (ta.kind === 'named') r = coerce(b, ta, C);
    if (tb.kind === 'named') l = coerce(a, tb, C);
    /**
     * **两格结构体值之间的 `==` 是逐字段比**（go 的规矩），而方言的 `==` 对记录是句柄比较 ——
     * 照原样发出去 `Vector{0,0,0} == zero` 答 false（答案静默地错）。
     * **指针与接口那两档不动**：`*Node` 之间 go 比的正是地址；接口值之间比的是
     * "动态类型相同且数据指针相同"，装箱记忆之后句柄比较就是它（见 `iface.js`）。
     */
    const sameRec = ta.kind === 'named' && tb.kind === 'named' && ta.name === tb.name;
    const plain = ta.ptr !== true && tb.ptr !== true && ta.iface !== true && tb.iface !== true;
    if (sameRec && plain && !/^mv\d+$/.test(ta.name)) {
      const one = { kind: 'call', fn: nameRef(C.eqFn(ta)), args: [l, r] };
      return op === '==' ? one : { kind: 'unop', op: '!', operand: one };
    }
  }
  /* **无符号那几格算子**（方言里有 `u>>` / `u/` / `u%` / `u>` 那一族）：
     go 的 uint64 与 int64 在同一格机器字上，差的是**这几个算子**。 */
  if ((ta.unsigned === true || tb.unsigned === true) && UOPS.has(op)) {
    return { kind: 'binop', op: UOPS.get(op), left: l, right: r };
  }
  return { kind: 'binop', op, left: l, right: r };
}

/** 有符号 → 无符号的那几格算子（别的（加减乘、相等）两边一样）。 */
const UOPS = new Map([
  ['>>', 'u>>'], ['/', 'u/'], ['%', 'u%'],
  ['<', 'u<'], ['>', 'u>'], ['<=', 'u<='], ['>=', 'u>='],
]);

const nameRef = (n) => ({ kind: 'name', name: n });
const plus1 = (e) => ({ kind: 'binop', op: '+', left: e, right: { kind: 'int', value: 1 } });

/**
 * 编译期**整数**的值（`[128]uint32` 或 `[rngLen]int64` 那种）。
 * 字面量与 `const` 两种都认；认不出回 null。
 */
function constIntOf(tok, C) {
  if (tok === undefined || tok === null) return null;
  if (tag(tok) === 'num') return Number(leaf(kids(tok)[0]));
  if (tag(tok) === 'name' || tag(tok) === 'tname') {
    const k = C.consts.get(C.ref(nameOf(tok)));
    if (k !== undefined && k.kind === 'int') return Number(k.value);
  }
  return null;
}

/**
 * 一格数字字面量。**大整数不许过双精度** —— `6364136223846793005` 经 `Number` 之后
 * 少最后三位（那是一格静默的错答案，`10-unsigned.go` 里那个乘数量出来的）。
 * 方言的 `(int …)` 收 BigInt，所以超出安全范围的就留着 BigInt。
 */
function numOf(raw) {
  const t = raw.replace(/_/g, '');
  const based = /^0[xXbBoO]/.test(t);
  if (!based && (t.includes('.') || /[eE]/.test(t))) return { kind: 'real', value: Number(t) };
  return intLit(t);
}

/** 这一格值"照搬着用两遍"要不要先物化（有语句要跑的、或者算两趟不便宜的）。 */
const simple = (e) => ['name', 'int', 'real', 'string', 'bool', 'field'].includes(e.kind);

/**
 * **缺键的读**：go 的 `m[k]` 在键不在时给零值，而方言的 `dget` 缺键是运行期错误。
 * 值是标量的那一档落成 `(if (dhas m k) (dget m k) 零值)`；
 * 值是记录 / 指针那一档**刻意不这么落** —— go 的零值是 nil，糊一格新记录进去是静默的错答案。
 */
export function dgetOr(obj, key, t, C) {
  const get = (o, k) => ({ kind: 'builtin', name: 'dget', args: [o, k] });
  const v = t.kind === 'map' ? t.value : INT;
  /* 零值说得清的那几档才补（标量、接口、指针）—— 值语义的记录不补：go 的零值是 nil，
     糊一格新的零值记录进去是静默的错答案，那一档照旧运行期报。 */
  const zeroable = ['int', 'real', 'string', 'bool'].includes(v.kind)
    || v.iface === true || (v.kind === 'named' && v.ptr === true);
  if (!zeroable) return get(obj, key);
  /* 两处都要读到同一格宿主与同一格键 —— 不是名字的就先落进临时量（不然语句跑两趟）。 */
  const stmts = [];
  const hold = (e, p) => {
    if (simple(e)) return e;
    const tmp = C.fresh(p);
    const ty = typeOf(e, C.tyCtx());
    C.bind(tmp, ty);
    stmts.push({ kind: 'let', name: tmp, type: ty, init: e });
    return nameRef(tmp);
  };
  const o = hold(obj, 'dsrc');
  const k = hold(key, 'dkey');
  const one = {
    kind: 'if-expr',
    type: v,
    cond: { kind: 'builtin', name: 'dhas', args: [o, k] },
    then: get(o, k),
    else_: zeroExpr(v, C),
  };
  return stmts.length === 0 ? one : { kind: 'block-expr', stmts, value: one };
}

/** 一格表达式。 */
export function exprOf(x, C) {
  switch (tag(x)) {
    case 'num': return numOf(String(leaf(kids(x)[0])));
    case 'str': return { kind: 'string', value: unquote(leaf(kids(x)[0])) };
    case 'char': return { kind: 'int', value: String(unquote(leaf(kids(x)[0]))).charCodeAt(0) };
    case 'paren': return exprOf(kids(x)[0], C);
    /* `&x` 与 `*p`：struct 一律引用语义，所以这两格都是**同一个值**。 */
    case 'addr': case 'deref': return exprOf(kids(x)[0], C);
    case 'name': {
      const n = nameOf(x);
      if (n === 'true') return { kind: 'bool', value: true };
      if (n === 'false') return { kind: 'bool', value: false };
      /* **`nil` 记一格印子**：它落成什么由目标类型定（`coerce` 那儿）——
         具名类型上是空引用，别处是 0。 */
      if (n === 'nil') return { kind: 'int', value: 0, fromNil: true };
      const k = C.consts.get(C.ref(n));
      if (k !== undefined) return k;
      return { kind: 'name', name: C.ref(n) };
    }
    /* `p.x`（取字段）与 `fmt.Println`（模块限定）在树上同形 —— 按"那个名字是什么"分。 */
    case 'sel': {
      const objTok = kids(x)[0];
      const fname = String(leaf(kids(x)[1]));
      if (tag(objTok) === 'name' && C.imports.has(nameOf(objTok))) {
        const pkg = nameOf(objTok);
        /* `math.Pi` 那一族是内建的常量；别的包的常量来自 `--pkgs` 读进来的那几份桩
           （名字是**平的** —— 见 `stdlib.js` 文件头）。 */
        if (pkg === 'math') {
          const k = mathConst(fname);
          if (k !== null) return k;
        }
        const flat = C.consts.get(C.ref(fname));
        if (flat !== undefined) return flat;
        throw new Error(`go->IR: \`${pkg}.${fname}\` 这一格库里的东西还没接`);
      }
      const obj = exprOf(objTok, C);
      return { kind: 'field', obj, name: fname };
    }
    case 'index': {
      const obj = exprOf(kids(x)[0], C);
      const key = exprOf(kids(x)[1], C);
      const t = typeOf(obj, C.tyCtx());
      if (t.kind === 'map') return dgetOr(obj, coerce(key, t.key, C), t, C);
      if (t.kind === 'string') {
        /* **`(ssub s 起点 长度)`** —— 第三格是**长度**，不是终点（量出来的：
           "substring out of range: start 168, length 171"）。 */
        return { kind: 'builtin', name: 'ssub', args: [obj, key, { kind: 'int', value: 1 }] };
      }
      return { kind: 'index', obj, index: key };
    }
    /* `s[a:b]` —— 串上是取子串、数组上是切一段（上界不含）。 */
    case 'slice3': return sliceOf(x, C);
    case 'bin': {
      const [opTok, aTok, bTok] = kids(x);
      const o = String(leaf(opTok));
      /* **`&^` 是 and-not**（go 独一格）：`a & ~b`，而 `~` 方言里没有 -> `b ^ -1`。 */
      if (o === '&^') {
        return {
          kind: 'binop',
          op: '&',
          left: exprOf(aTok, C),
          right: { kind: 'binop', op: '^', left: exprOf(bTok, C), right: { kind: 'int', value: -1 } },
        };
      }
      const mapped = OPS.get(o);
      if (mapped === undefined) throw new Error(`go->IR: 这个算子还没接：${o}`);
      return mkBin(mapped, exprOf(aTok, C), exprOf(bTok, C), C);
    }
    case 'un': {
      const o = String(leaf(kids(x)[0]));
      const a = kids(x)[1];
      if (o === '!') return { kind: 'unop', op: '!', operand: condOf(a, C) };
      if (o === '^') {
        return {
          kind: 'binop', op: '^', left: exprOf(a, C), right: { kind: 'int', value: -1 },
        };
      }
      return { kind: 'unop', op: o, operand: exprOf(a, C) };
    }
    case 'lit': return litOf(x, C);
    /* `<-ch` —— 通道那一族的体在 `libomnigo`（见 `conc.js`）。 */
    case 'recv': return C.chanRecv(kids(x)[0]);
    case 'call': return callOf(x, C);
    case 'fnlit': return { kind: 'fn-ref', name: C.lift(x, null) };
    default:
      throw new Error(`go->IR: 这一格表达式还没接：${tag(x)}`);
  }
}

/** 条件位置上的那一格。 */
export function condOf(x, C) {
  const e = exprOf(x, C);
  const t = typeOf(e, C.tyCtx());
  if (t.kind === 'bool' || e.kind === 'bool') return e;
  if (t.kind === 'int') return { kind: 'binop', op: '!=', left: e, right: { kind: 'int', value: 0 } };
  throw new Error(`go->IR: 这一格当条件用还没接（装的是 ${t.kind}）`);
}

/** `[]int{…}` / `[3]int{…}` / `map[K]V{…}` / `T{…}` —— 同一条产生式，第一格是类型。 */
function litOf(x, C) {
  const tyTok = kids(x)[0];
  const items = kids(x).slice(1);
  if (tag(tyTok) === 'struct') return recLit(C.anonRecord(tyTok), items, C);
  return litWithType(typeOfTok(tyTok, C), items, C);
}

/** 一格 `{…}`（类型已知：写出来的那格，或者从外头传进来的那格）。 */
function litWithType(type, items, C) {
  if (type.kind === 'map') return mapLit(type, items, C);
  if (type.kind === 'arr') return arrLit(type, items, C);
  if (type.kind === 'named') return recLit(type, items, C);
  throw new Error(`go->IR: \`{…}\` 落在 ${type.kind} 上 —— 这一层不猜`);
}

function mapLit(t, items, C) {
  const tmp = C.fresh('dict');
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let', name: tmp, type: t, init: { kind: 'builtin', name: 'dnew', args: [tyArg(t)] },
  }];
  for (const kv of items) {
    stmts.push({
      kind: 'builtin-stmt',
      name: 'dset',
      args: [nameRef(tmp), valueOf(kids(kv)[0], t.key, C), valueOf(kids(kv)[1], t.value, C)],
    });
  }
  return { kind: 'block-expr', stmts, value: nameRef(tmp) };
}

function arrLit(t, items, C) {
  /* `[3]int{…}` 的长度以声明为准（没给全的那几格是零值）。 */
  const n = Math.max(t.len ?? 0, items.length);
  const tmp = C.fresh('arr');
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let',
    name: tmp,
    type: t,
    init: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: n }] },
  }];
  items.forEach((k, i) => stmts.push({
    kind: 'assign',
    target: { kind: 'index', obj: nameRef(tmp), index: { kind: 'int', value: i } },
    value: valueOf(k, t.elem, C),
  }));
  return { kind: 'block-expr', stmts, value: nameRef(tmp) };
}

/** `T{…}`：具名字段（`(kv (name x) v)`）或按声明顺序的位置型；没给的那几格是零值。 */
function recLit(type, items, C) {
  const fs = C.tyCtx().fields.get(type.name) ?? [];
  const given = new Map();
  let pos = 0;
  for (const f of items) {
    if (tag(f) === 'kv') {
      const fname = nameOf(kids(f)[0]);
      const fd = fs.find((y) => y.name === fname);
      given.set(fname, valueOf(kids(f)[1], fd === undefined ? null : fd.type, C));
      continue;
    }
    const fd = fs[pos];
    pos += 1;
    if (fd === undefined) throw new Error(`go->IR: ${type.name}{…} 给的值比声明的字段还多`);
    given.set(fd.name, valueOf(f, fd.type, C));
  }
  return {
    kind: 'new-record',
    type,
    ref: type.ref === true,
    fields: fs.map((f) => ({
      name: f.name,
      value: given.get(f.name) ?? C.zeroOf(f.type),
    })),
  };
}

/** `s[a:b]` —— 串上取子串、数组上切一段（上界**不含**）。 */
function sliceOf(x, C) {
  const [srcTok, fromTok, toTok] = kids(x);
  const src = exprOf(srcTok, C);
  const st = typeOf(src, C.tyCtx());
  const from = fromTok === undefined || tag(fromTok) === 'none'
    ? { kind: 'int', value: 0 } : exprOf(fromTok, C);
  if (st.kind === 'string') {
    const to = toTok === undefined || tag(toTok) === 'none'
      ? { kind: 'builtin', name: 'slen', args: [src] } : exprOf(toTok, C);
    /* 第三格是**长度**（终点减起点）。 */
    return {
      kind: 'builtin',
      name: 'ssub',
      args: [src, from, { kind: 'binop', op: '-', left: to, right: from }],
    };
  }
  const elem = st.kind === 'arr' ? st.elem : INT;
  const to = toTok === undefined || tag(toTok) === 'none'
    ? { kind: 'builtin', name: 'alen', args: [src] } : exprOf(toTok, C);
  const out = C.fresh('slice');
  const i = C.fresh('slice_i');
  C.bind(out, arrOf(elem));
  C.bind(i, INT);
  return {
    kind: 'block-expr',
    stmts: [
      {
        kind: 'let', name: out, type: arrOf(elem),
        init: { kind: 'builtin', name: 'anew', args: [tyArg(arrOf(elem)), { kind: 'int', value: 0 }] },
      },
      { kind: 'let', name: i, type: INT, init: from },
      {
        kind: 'while',
        cond: { kind: 'binop', op: '<', left: nameRef(i), right: to },
        body: [
          {
            kind: 'builtin-stmt', name: 'apush',
            args: [nameRef(out), { kind: 'index', obj: src, index: nameRef(i) }],
          },
          { kind: 'assign', target: nameRef(i), value: plus1(nameRef(i)) },
        ],
      },
    ],
    value: nameRef(out),
  };
}

/**
 * 一格调用。五件事同一条产生式：
 *   `make([]int, n)` / `len(x)` / `append(xs, v)`   -> 内建
 *   `int(x)` / `float64(x)` / `string(x)`           -> 转换
 *   `p.total()`                                    -> 方法（接收者是第一格实参）
 *   `Point.total(p)`                               -> **方法表达式**（接收者写在实参里）
 *   `f(v)`（f 装着函数）/ `func(){…}()`             -> `(callfn …)`
 */
/**
 * `fmt.Sprintf(格式, 实参…)` → 一格串。格式那一层走**公共层**那一份
 * （`src/core/lower/fmt.js` 的 `fmtToIR`）—— 与 jancy 的 `printf` 和 cpp 的 `printf`
 * 共用同一个 `readSpec` 与同一张转换表。
 *
 * 格式串必须是**字面量**：格式那一层是编译期的事，串是运行期算出来的就没法在这一层摊开。
 */
export function sprintfOf(rawArgs, C) {
  const fmtTok = rawArgs[0];
  if (fmtTok === undefined || tag(fmtTok) !== 'str') {
    throw new Error('go->IR: `Sprintf` 的格式串不是字面量 —— 那要运行期的格式化（还没接）');
  }
  const fmt = cUnescape(unquote(leaf(kids(fmtTok)[0])));
  const args = rawArgs.slice(1).map((a) => exprOf(a, C));
  return fmtToIR(fmt, args, C.tyCtx(), 'go->IR');
}

/**
 * `fmt.Printf` = `Sprintf` 再印一趟。方言的 `print` **自带换行**，所以格式串必须
 * 正好以一个换行收尾 —— 不是那样的当场报（"不换行地写一段"公共 IR 这一层还没有）。
 */
export function printfOf(rawArgs, C) {
  const fmtTok = rawArgs[0];
  if (fmtTok === undefined || tag(fmtTok) !== 'str') {
    throw new Error('go->IR: `Printf` 的格式串不是字面量 —— 那要运行期的格式化（还没接）');
  }
  const raw = cUnescape(unquote(leaf(kids(fmtTok)[0])));
  if (!raw.endsWith('\n')) {
    throw new Error(`go->IR: 这个格式串不以换行收尾：${JSON.stringify(raw)}`
      + '（方言的 print 自带换行，"不换行地写一段"这一层还没有）');
  }
  const args = rawArgs.slice(1).map((a) => exprOf(a, C));
  return fmtToIR(raw.slice(0, -1), args, C.tyCtx(), 'go->IR');
}

function callOf(x, C) {  const fnTok = kids(x)[0];
  const argsTok = part(x, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);

  /* 立即调用的函数字面量（`func(a, b int) int { … }(4, 5)`）。 */
  if (tag(fnTok) === 'fnlit') {
    const name = C.lift(fnTok, null);
    return { kind: 'call', fn: nameRef(name), args: argsFor(C.fns.get(name), rawArgs, C) };
  }

  if (tag(fnTok) === 'sel') {
    const objTok = kids(fnTok)[0];
    const m = String(leaf(kids(fnTok)[1]));
    /* `fmt.Println(…)` 那一族在语句那一侧接（它们不交值）。 */
    if (tag(objTok) === 'name' && C.imports.has(nameOf(objTok))) {
      /* **`math` 是内建的**（没有桩）：方言里本来就有 `(rmath …)`。 */
      if (nameOf(objTok) === 'math') {
        const one = mathCall(m, rawArgs, C);
        if (one !== null) return one;
      }
      /**
       * **`fmt.Sprintf` 走公共层那份格式串**（`src/core/lower/fmt.js` 的 `fmtToIR` ——
       * 与 jancy 的 `printf`、cpp 的 `printf` 同一张转换表）。它不要桩：格式那一层是
       * **编译期**的事，落到的全是现成的串内建。
       */
      if (nameOf(objTok) === 'fmt' && m === 'Sprintf') {
        return sprintfOf(rawArgs, C);
      }
      /**
       * **`--pkgs` 把桩真的编进来之后，包限定的调用就是一格普通调用**：名字是**平的**
       * （`strings.Index` -> `Index`）—— 与图那条路同一条口径，也是"类型名会撞"那笔账的由来。
       * 名单上没给那个包（或者桩里没有这一格）就当场报，不猜。
       */
      const flat = C.ref(m);
      if (C.bodiless.has(flat)) {
        const one = hostCall(m, rawArgs.map((a) => exprOf(a, C)), C);
        if (one !== null) return one;
        throw new Error(`go->IR: \`${nameOf(objTok)}.${m}\` 没有体，而它也不在宿主入口那张表上`);
      }
      if (C.fns.has(flat)) {
        return { kind: 'call', fn: nameRef(flat), args: argsFor(C.fns.get(flat), rawArgs, C) };
      }
      /* `time.Duration(x)` —— 包限定的**类型转换**（桩里那格具名标量）。 */
      if (C.aliases.has(m) && rawArgs.length === 1) {
        return convertTo(C.aliases.get(m), exprOf(rawArgs[0], C), C);
      }
      throw new Error(`go->IR: \`${nameOf(objTok)}.${m}(…)\` 这一格库函数还没接`
        + '（`--pkgs` 上给那个包的目录，桩里有这一格才认）');
    }
    /* **方法表达式**：`Point.total(p)` —— 名字是个类型，接收者写在实参第一格。 */
    if (tag(objTok) === 'name' && C.records.has(nameOf(objTok))) {
      const owner = C.ref(nameOf(objTok));
      const sig = C.methods.get(`${owner}.${m}`);
      if (sig === undefined) throw new Error(`go->IR: ${owner} 上没有登记过的方法 ${m}`);
      return { kind: 'call', fn: nameRef(sig.name), args: argsFor(sig, rawArgs, C) };
    }
    const recv = exprOf(objTok, C);
    const t = typeOf(recv, C.tyCtx());
    /* **接口上的方法**：那一格是记录里的一格方法闭包（ADR-0040）—— 通过值调。 */
    if (t.iface === true) {
      const sig = (C.ifaces.get(t.name) ?? []).find((s) => s.name === m);
      if (sig === undefined) {
        throw new Error(`go->IR: 接口 ${t.name} 上没有方法 ${m}`);
      }
      return {
        kind: 'call-value',
        fn: { kind: 'field', obj: recv, name: m },
        args: sig.params.map((p, i) => valueOf(rawArgs[i], p.type, C)),
      };
    }
    if (t.kind === 'named') {
      const sig = C.methods.get(`${t.name}.${m}`);
      if (sig === undefined) {
        throw new Error(`go->IR: ${t.name} 上没有登记过的方法 ${m} —— 这一层不猜`);
      }
      return { kind: 'call', fn: nameRef(sig.name), args: [recv, ...argsFor(sig, rawArgs, C, 1)] };
    }
    /* **具名标量上的方法**（`type Duration int64` 的 `d.Seconds()`）—— 按那格名字查。 */
    if (t.named !== undefined) {
      const sig = C.methods.get(`${t.named}.${m}`);
      if (sig !== undefined) {
        return { kind: 'call', fn: nameRef(sig.name), args: [recv, ...argsFor(sig, rawArgs, C, 1)] };
      }
    }
    throw new Error(`go->IR: \`.${m}()\` 这一格方法还没接（接收者装的是 ${t.kind}）`);
  }

  const nm = nameOf(fnTok);
  /* ---- 内建那几格 ---------------------------------------------------------- */
  if (nm === 'make') {
    const t = typeOfTok(rawArgs[0], C);
    /* `make(chan T, n)` —— 通道那一格（体在 `libomnigo`）。 */
    if (t.chan !== undefined) return C.chanMake(rawArgs[1]);
    if (t.kind === 'map') return { kind: 'builtin', name: 'dnew', args: [tyArg(t)] };
    const n = rawArgs.length > 1 ? exprOf(rawArgs[1], C) : { kind: 'int', value: 0 };
    return { kind: 'builtin', name: 'anew', args: [tyArg(t), n] };
  }
  if (nm === 'close' && rawArgs.length === 1) return C.chanClose(exprOf(rawArgs[0], C));
  if (nm === 'new') {
    const t = typeOfTok(rawArgs[0], C);
    return zeroExpr(t, C);
  }
  if (nm === 'len' && rawArgs.length === 1) {
    const v = exprOf(rawArgs[0], C);
    const t = typeOf(v, C.tyCtx());
    /* **通道上的 `len` 问的是"环里现在有几个"**，不是切片的长度。 */
    if (t.chan !== undefined) return C.chanLen(v);
    const name = t.kind === 'map' ? 'dlen' : (t.kind === 'string' ? 'slen' : 'alen');
    return { kind: 'builtin', name, args: [v] };
  }
  if (nm === 'append') return appendOf(rawArgs, C);
  if (nm === 'copy') {
    /* `copy(dst, src)` —— 抄 min(len(dst), len(src)) 格，交出抄了几格。 */
    return copyOf(exprOf(rawArgs[0], C), exprOf(rawArgs[1], C), C);
  }
  if (nm === 'panic') throw new Error('go->IR: `panic` 在表达式位置上 —— 它只在语句里接');
  if (SCALARS.has(nm) && rawArgs.length === 1) {
    return convertTo(SCALARS.get(nm), exprOf(rawArgs[0], C), C);
  }
  /* `Duration(x)` —— 具名的标量类型（`type Duration int64`）也是一格转换。 */
  if (C.aliases.has(nm) && rawArgs.length === 1) {
    return convertTo(C.aliases.get(nm), exprOf(rawArgs[0], C), C);
  }
  /* 形参/局部量里装着函数 -> 通过值调。 */
  const local = C.tyCtx().env.get(C.ref(nm));
  if (local !== undefined && local.kind === 'fn-type') {
    return {
      kind: 'call-value',
      fn: nameRef(C.ref(nm)),
      args: rawArgs.map((a, i) => valueOf(a, local.params[i], C)),
    };
  }
  if (!C.fns.has(C.ref(nm))) {
    throw new Error(`go->IR: ${nm} 没有登记过 —— 这一层不猜（标准库那一族要"真的编 stdlib"那一层）`);
  }
  return { kind: 'call', fn: nameRef(C.ref(nm)), args: argsFor(C.fns.get(C.ref(nm)), rawArgs, C) };
}

/**
 * 一格转换（`int64(x)` / `float64(x)` / `Duration(x)`）。
 * **只换标签的那一档**（`uint64(i)` / `int64(u)` / `Duration(n)`）位一格不动，可后面那七个
 * 无符号算子与"这一格身上有哪些方法"要按新标签认 —— 所以把类型挂在一格 `cast` 上
 * （降级的时候它是透明的）。
 */
function convertTo(to, v, C) {
  const t = typeOf(v, C.tyCtx());
  let out = v;
  if (to.kind === 'int' && t.kind !== 'int') out = { kind: 'builtin', name: 'toint', args: [v] };
  else if (to.kind === 'real' && t.kind !== 'real') {
    out = { kind: 'builtin', name: t.unsigned === true ? 'torealu' : 'toreal', args: [v] };
  } else if (to.kind === 'string' && t.kind !== 'string') {
    out = { kind: 'builtin', name: 'tostr', args: [v] };
  }
  if ((to.unsigned === true) !== (t.unsigned === true) || to.named !== t.named) {
    return { kind: 'cast', type: to, expr: out };
  }
  return out;
}

/** 一串实参按**形参的类型**落（无类型常量在这儿升格、省类型的字面量在这儿补类型）。 */
export function argsFor(sig, rawArgs, C, skip = 0) {
  const ps = sig === undefined ? [] : sig.params;
  /* **变参**（`func f(xs ...int)`）：末尾那些合成一格数组。 */
  const last = ps[ps.length - 1];
  if (last !== undefined && last.variadic === true) {
    const fixed = ps.slice(0, -1).slice(skip);
    const head = fixed.map((p, i) => valueOf(rawArgs[i], p.type, C));
    const restToks = rawArgs.slice(fixed.length);
    /* `f(xs...)` —— 直接把那格切片交过去。 */
    if (restToks.length > 0 && tag(restToks[restToks.length - 1]) === 'spread') {
      return [...head, exprOf(restToks[restToks.length - 2], C)];
    }
    return [...head, arrLitFrom(last.type, restToks, C)];
  }
  return rawArgs.map((a, i) => valueOf(a, ps[i + skip] === undefined ? null : ps[i + skip].type, C));
}

/** 几格表达式 → 一格数组（变参那一格用它）。 */
function arrLitFrom(t, toks, C) {
  const tmp = C.fresh('va');
  C.bind(tmp, t);
  const stmts = [{
    kind: 'let',
    name: tmp,
    type: t,
    init: { kind: 'builtin', name: 'anew', args: [tyArg(t), { kind: 'int', value: toks.length }] },
  }];
  toks.forEach((k, i) => stmts.push({
    kind: 'assign',
    target: { kind: 'index', obj: nameRef(tmp), index: { kind: 'int', value: i } },
    value: valueOf(k, t.elem, C),
  }));
  return { kind: 'block-expr', stmts, value: nameRef(tmp) };
}

/**
 * `append(xs, a, b)` / `append(xs, ys...)`。
 * 方言里 `apush` 是**语句**，所以落"先推、再交回那格数组"。
 * 摊开那一档是一趟**数着的**循环：长度**先取一份** —— `a = append(a, a...)` 的语义是
 * "把原来那些接上去"，条件里每趟重算 `len(a)` 会一直长下去（那是一次挂起）。
 */
function appendOf(rawArgs, C) {
  const spread = rawArgs.length > 0 && tag(rawArgs[rawArgs.length - 1]) === 'spread';
  const real = spread ? rawArgs.slice(0, -1) : rawArgs;
  let box = exprOf(real[0], C);
  const bt = typeOf(box, C.tyCtx());
  const elem = bt.kind === 'arr' ? bt.elem : INT;
  if (!spread) {
    const stmts = real.slice(1).map((a) => ({
      kind: 'builtin-stmt', name: 'apush', args: [box, valueOf(a, elem, C)],
    }));
    return { kind: 'block-expr', stmts, value: box };
  }
  const stmts = [];
  if (!simple(box)) {
    const held = C.fresh('apx');
    C.bind(held, bt);
    stmts.push({ kind: 'let', name: held, type: bt, init: box });
    box = nameRef(held);
  }
  const src = exprOf(real[real.length - 1], C);
  const st = typeOf(src, C.tyCtx());
  const s = C.fresh('apsrc');
  const n = C.fresh('apn');
  const i = C.fresh('api');
  C.bind(s, st);
  C.bind(n, INT);
  C.bind(i, INT);
  stmts.push({ kind: 'let', name: s, type: st, init: src });
  stmts.push({ kind: 'let', name: n, type: INT, init: { kind: 'builtin', name: 'alen', args: [nameRef(s)] } });
  stmts.push({
    kind: 'for',
    init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
    cond: { kind: 'binop', op: '<', left: nameRef(i), right: nameRef(n) },
    post: { kind: 'assign', target: nameRef(i), value: plus1(nameRef(i)) },
    body: [{
      kind: 'builtin-stmt',
      name: 'apush',
      args: [box, { kind: 'index', obj: nameRef(s), index: nameRef(i) }],
    }],
  });
  return { kind: 'block-expr', stmts, value: box };
}

/** `copy(dst, src)` —— 抄 min(len) 格，交出抄了几格（go 的返回值）。 */
function copyOf(dst, src, C) {
  const dt = typeOf(dst, C.tyCtx());
  const st = typeOf(src, C.tyCtx());
  const d = C.fresh('cpd');
  const s = C.fresh('cps');
  const n = C.fresh('cpn');
  const i = C.fresh('cpi');
  C.bind(d, dt);
  C.bind(s, st);
  C.bind(n, INT);
  C.bind(i, INT);
  const alen = (v) => ({ kind: 'builtin', name: 'alen', args: [v] });
  return {
    kind: 'block-expr',
    stmts: [
      { kind: 'let', name: d, type: dt, init: dst },
      { kind: 'let', name: s, type: st, init: src },
      {
        kind: 'let',
        name: n,
        type: INT,
        init: {
          kind: 'if-expr',
          type: INT,
          cond: { kind: 'binop', op: '<', left: alen(nameRef(d)), right: alen(nameRef(s)) },
          then: alen(nameRef(d)),
          else_: alen(nameRef(s)),
        },
      },
      {
        kind: 'for',
        init: { kind: 'let', name: i, type: INT, init: { kind: 'int', value: 0 } },
        cond: { kind: 'binop', op: '<', left: nameRef(i), right: nameRef(n) },
        post: { kind: 'assign', target: nameRef(i), value: plus1(nameRef(i)) },
        body: [{
          kind: 'assign',
          target: { kind: 'index', obj: nameRef(d), index: nameRef(i) },
          value: { kind: 'index', obj: nameRef(s), index: nameRef(i) },
        }],
      },
    ],
    value: nameRef(n),
  };
}

// ---- 这一批明说的不足（不猜）----------------------------------------------------
//   1. struct 一律落方言的 `(class …)`（引用语义）：go 的 struct 是值语义，
//      `q := p` 之后改 q 不该动 p —— `pointer.go` 那几行要的正是引用语义（`&Node{…}`），
//      值语义的整格拷贝这一批**没有判据**，明说记着。
//   2. `interface{}`（any）当场报：那一格装什么都行，方言里没有对应的形状。
//   3. 库里的东西分两路：`math` 是内建的（`(rmath …)`，见 `stdlib.js`），别的要
//      `--pkgs` 把桩真的编进来；名单上没给那个包就当场报。
//   4. 值语义的 struct 之间 `==` 走 `__eq_T` 逐字段比；**接口之间**比的是句柄
//      （装箱记忆之后就是 go 的"动态类型 + 数据指针"，见 `iface.js`）。

