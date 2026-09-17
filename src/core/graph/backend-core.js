// src/core/graph/backend-core.js —— **图 -> 我们自己那门核心方言（sx）-> OIR**（第一百五十二片）
//
// ## 这一格与别的后端不同在哪
//
// wat / c / js 那三条腿都是"图直接落成那门语言的文本"。这一条落的是**我们自己的中间语言**
// （`sexpr/lower.js` 那份核心方言），于是往下**整条既有的路白得**：OIR -> js / c / wasm /
// llvm 四条腿、摇树、profile、REPL、错误模型。ADR-0037 §5.1 那两条路里的 **B 路**就是它 ——
// 「不新开一条路，就不会有两条路走散」（ADR-0034 那句话的同一条理由）。
//
// ## 这一刀接哪几档：**标量 + 记录 + 列表**
//
// 图上**没有类型**（`nodes.js` 文件头第一条：type 不是节点），而核心方言是**有类型的**。
// 这中间那一格差是这条腿的全部难处，所以边界画得很清：
//
//   接：`const`（整/实/串/真假）· `ref` · `bind` · `set` · `prim`（算术 / 比较 / not /
//       len / concat / print 单实参）· `branch` · `loop` · `loop-exit` · `region` · `ret` ·
//       `func`（顶层的）· `call` · **记录三格**（`record-new` / `field-get` / `field-set`）·
//       **列表三格**（`list-new` / `index-get` / `index-set`）
//   不接（**有名有姓**，`can()` 逐格答带上"欠在方言里还是欠在这份翻译上"，`Gap` 当场报）：
//       映射四格（**方言里没有字典**）· 多值 · 表示转换 · 切片 · scope-exit ·
//       闭包（非顶层的 `func`）· 多实参 print
//
// 类型是**推**出来的：字面量按值推（整数 `int`、带小数点 `real`、串 `string`、真假 `bool`）、
// 记录按"字段名单 + 字段类型"登记成一格 `(struct rN …)`、列表按第一格元素推成 `(arr T)`；
// 形参与返回**默认 int**，推不出来就当场报（不猜）。
//
// **聚合只能从字段与下标那两条路走**：一格记录 / 列表整格当值用（当实参、被 print、被 return）
// 一律报缺口 —— 这一刀的函数形参与返回都是 int，跑出去就说不清类型了。同一条纪律在
// `backend-c` 那边是 `recPlan` 的三个条件，这儿靠"谁来拼文本"落实（`objText` 一处）。

import { Gap } from './backend-wat.js';
import { declOf } from './nodes.js';
/* 证物那五份是**手搭的小图** —— 所以要 `node()` / `lit()` / `program()`（`node` 顺带查五栏）。 */
import { node, lit as litNode, program } from './graph.js';
import { sxTextToMod } from '../lang/sx.js';
import { interpret } from '../interp/eval.js';
import { setOutSink } from '../interp/builtin.js';

/** 这一刀接得住的节点。别的一律有名有姓地报缺口（`can` 那一问）。 */
const OPS = new Set(['const', 'ref', 'bind', 'set', 'prim', 'branch', 'loop', 'loop-exit',
  'region', 'ret', 'func', 'call',
  /* 记录与列表两族（第二刀）：方言里本来就有 `(struct …)`/`(fld …)` 与 `(arr T)`/`(aget …)`，
     所以这两族不必动方言，只是**把类型算出来**（图上没有类型，见文件头）。 */
  'record-new', 'field-get', 'field-set', 'list-new', 'index-get', 'index-set',
  /* 表示转换：方言里是 `(toreal …)`/`(toint …)`/`(tostr …)` 三格 —— 图上那一格的 `to`
     说了要哪一侧，源那一侧得我们自己算（`typeOf`）。 */
  'conv']);

/** 这一刀接得住的内建（`prims.js` 里 16 格中的 15 格；只有多实参 print 还欠着）。 */
const PRIMS_OK = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '=', '!=',
  'not', 'len', 'print', 'concat']);

/** 方言里那几个算符的名字与图上的**一一对应**（`=` / `!=` 是两边唯一不同的两格）。 */
const BINOP = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '^': '^',
  '<': '<', '>': '>', '<=': '<=', '>=': '>=', '=': '==', '!=': '!=',
};

const isNode = (x) => x !== null && x !== undefined && x.op !== undefined;
const isLit = (x) => x !== null && x !== undefined && x.lit !== undefined;

/** 一格字面量的方言类型。推不出来回 null（调用方报缺口）。 */
function litType(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'real';
  return null;
}

/** 一格串字面量在方言里的写法（转义按 s-expr 的读法：只有这两个要转）。 */
const strLit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * 一格**表达式**的类型（够这一刀用的那一档：字面量、名字、算子的结果、字段与元素）。
 * 名字的类型从 `env`（名字 -> 类型）里查；查不到当 `int` —— 形参默认 int 就是这一条。
 *
 * `ctx` 是**整份产物共用的一格登记处**（记录的形状表 + 要印在模块头上的 `(struct …)`）——
 * 它不能住在 `env` 里：`env` 逢作用域就 `new Map(env)` 复制一份，而 struct 声明是模块级的。
 */
function typeOf(x, env, ctx) {
  if (isLit(x)) return litType(x.lit) ?? 'int';
  if (!isNode(x)) return 'int';
  if (x.op === 'const') return litType(x.attrs.value) ?? 'int';
  if (x.op === 'ref') return env.get(x.attrs.name) ?? 'int';
  if (x.op === 'prim') {
    const nm = x.attrs.name;
    if (nm === '<' || nm === '>' || nm === '<=' || nm === '>=' || nm === '=' || nm === '!=' || nm === 'not') return 'bool';
    if (nm === 'len') return 'int';
    if (nm === 'concat') return 'string';
    /* 算术：串在一起是 `string`、任一边是 real 就 real（方言里 int 与 real 不隐式混算 ——
       混着写它当场报，那正是我们要的：与 ADR-0031 §1 那一格"位宽写在类型上"同一条纪律）。 */
    const ts = argList(x, 'args').map((a) => typeOf(a, env, ctx));
    if (ts.some((t) => t === 'string')) return 'string';
    if (ts.some((t) => t === 'real')) return 'real';
    return 'int';
  }
  if (x.op === 'call') {
    const f = x.ins.fn;
    const nm = isNode(f) && f.op === 'ref' ? f.attrs.name : null;
    return (nm !== null ? env.get(`fn:${nm}`) : null) ?? 'int';
  }
  if (x.op === 'branch') return typeOf(x.ins.then, env, ctx);
  if (x.op === 'field-get') return fieldType(x, env, ctx);
  if (x.op === 'index-get') return elemType(typeOf(x.ins.obj, env, ctx)) ?? 'int';
  if (x.op === 'conv') return convTo(x);
  return 'int';
}

/** 一格 `conv` 的目标在方言里是哪个类型。不认的那一格当场报。 */
function convTo(x) {
  const to = x.attrs.to;
  if (to === 'int') return 'int';
  if (to === 'float') return 'real';
  if (to === 'str') return 'string';
  return gap(`这格表示转换还没接：to=${to}`);
}

/** `(arr T)` 的元素类型。不是数组回 null。 */
function elemType(t) {
  if (typeof t !== 'string' || !t.startsWith('(arr ')) return null;
  return t.slice(5, -1);
}

/** 一格 `field-get` 交出来的类型：宿主的形状表里查那个字段。查不到当场报。 */
function fieldType(x, env, ctx) {
  const t = typeOf(x.ins.obj, env, ctx);
  const shape = ctx.shapes.get(t);
  if (shape === undefined) gap(`在一格说不清形状的东西上取字段 '${x.attrs.field}'`);
  const ft = shape.types.get(x.attrs.field);
  if (ft === undefined) gap(`记录 ${t} 上没有字段 '${x.attrs.field}'`);
  return ft;
}

/** 一格 `rest` 端口收成数组（图上一格与一串两种写法都有）。 */
function argList(n, port) {
  const x = n.ins[port];
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

const gap = (why) => { throw new Gap(`core 这条腿还没接：${why}`); };

/** 一格**表达式** -> 方言的文本。 */
function expr(x, env, ctx) {
  if (isLit(x)) return lit(x.lit);
  if (!isNode(x)) gap(`空的表达式（${JSON.stringify(x)}）`);
  if (!OPS.has(x.op)) gap(x.op);
  switch (x.op) {
    case 'const': return lit(x.attrs.value);
    case 'ref': {
      /* 聚合（记录 / 列表）**只能从字段与下标那两条路走**：这一刀的函数形参与返回一律 int，
       * 所以一格记录一旦跑到别处（当实参、被 print、被 return）就说不清类型了。
       * 那两条路自己拼文本（不经过这儿），于是这儿一律报缺口 —— 与 backend-c 的
       * `recPlan` 那三条同一个道理，只是我们靠"谁来拼"而不是靠一趟预扫描。 */
      const t = env.get(x.attrs.name);
      if (ctx.shapes.has(t)) gap(`把记录 '${x.attrs.name}' 整格当值用（这一刀只接字段读写）`);
      if (elemType(t) !== null) gap(`把列表 '${x.attrs.name}' 整格当值用（这一刀只接下标读写与 len）`);
      return `(var ${x.attrs.name})`;
    }
    case 'prim': {
      const nm = x.attrs.name;
      if (!PRIMS_OK.has(nm)) gap(`内建 ${nm}`);
      const args = argList(x, 'args');
      if (nm === 'not') return `(not ${expr(args[0], env, ctx)})`;
      if (nm === 'len') return lenText(args[0], env, ctx);
      if (nm === 'print') gap('print 出现在表达式位置上');
      if (nm === 'concat') return concatText(args, env, ctx);
      /* 一格实参的 `-` 是**取负**（方言里那是另一个形状：`(un "-" …)`）。 */
      if (nm === '-' && args.length === 1) return `(un "-" ${expr(args[0], env, ctx)})`;
      if (args.length < 2) gap(`${nm} 收了 ${args.length} 格实参（这一刀只接两格）`);
      /* `+` / `*` 收好几格是**结合律那一族**（sbcl 的 `(+ a b c)`）—— 往左折。
         别的算符收不齐两格才报。 */
      if (args.length > 2 && nm !== '+' && nm !== '*') {
        gap(`${nm} 收了 ${args.length} 格实参（这一刀只接两格）`);
      }
      return binText(nm, args, env, ctx);
    }
    case 'call': {
      const f = x.ins.fn;
      if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
      /* 被调的那格没有返回值（体里一格 ret 都没有）却出现在**值**的位置上 ——
       * 那正是"隐式返回"（chez / sbcl 体末尾那个值）。有名有姓地报，不糊。 */
      if (env.get(`fn:${f.attrs.name}`) === 'void') {
        gap(`把 '${f.attrs.name}' 当值用，可它体里一格 ret 都没有（隐式返回那一档）`);
      }
      return callText(x, env, ctx);
    }
    case 'field-get': return `(fld ${objText(x.ins.obj, env, ctx)} ${x.attrs.field})`;
    case 'index-get': {
      const t = typeOf(x.ins.obj, env, ctx);
      if (elemType(t) === null) gap('在一格说不清形状的东西上取下标（这一刀只接 list-new 绑出来的那格）');
      return `(aget ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.index, env, ctx)})`;
    }
    case 'record-new': gap('记录出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
    case 'list-new': gap('列表出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
    case 'conv': {
      /* **已经在那一侧的什么都不做** —— 与 wat 那条腿同一句话（`backend-wat.js` 的 conv）。
       * 方言里 int 与 real 不隐式混算，所以这一格必须落准：多补一格 `(toreal …)` 会
       * 把整数除法变成实数除法。 */
      const to = convTo(x);
      const from = typeOf(x.ins.value, env, ctx);
      const v = expr(x.ins.value, env, ctx);
      if (to === from) return v;
      if (to === 'string') return `(tostr ${v})`;
      if (from === 'string') gap(`串上的表示转换还没接（方言里没有"串 -> ${to}"）`);
      if (to === 'real') return `(toreal ${v})`;
      if (from === 'real') return `(toint ${v})`;
      return gap(`这格表示转换还没接：${from} -> ${to}`);
    }
    case 'branch':
      /* 方言里 `if` 是语句 —— 表达式位置上的 branch 这一刀不接（要块表达式，ADR-0031 §5）。 */
      return gap('branch 出现在表达式位置上（方言的块表达式还欠着）');
    default: return gap(`${x.op} 出现在表达式位置上`);
  }
}

/**
 * 一格两元（或结合律那一族）运算 -> 方言的 `(bin …)`。
 *
 * **两边要同型**是方言的规矩（`int` 与 `real` 不隐式混算），而图上没有类型 ——
 * 所以这一格得自己**把矮的那边抬上去**：一边 real 一边 int 就给 int 那边补 `(toreal …)`。
 * 这是 `go+conv` 那一族当场量出来的：`float64(7) / 2` 落出来是 `(bin "/" (toreal …) (int 2))`，
 * 方言直接报"两边要同型"。抬不上去（真假与数混算那种）就报缺口，不猜。
 */
function binText(nm, args, env, ctx) {
  const ts = args.map((a) => typeOf(a, env, ctx));
  let want = 'int';
  if (ts.some((t) => t === 'string')) want = 'string';
  else if (ts.some((t) => t === 'real')) want = 'real';
  else if (ts.every((t) => t === 'bool')) want = 'bool';
  const one = (a, t) => {
    const v = expr(a, env, ctx);
    if (t === want) return v;
    if (want === 'string') return `(tostr ${v})`;
    if (want === 'real' && t === 'int') return `(toreal ${v})`;
    return gap(`'${nm}' 的两边说不到一起（${t} 与 ${want}）`);
  };
  return args.slice(1).reduce((acc, a, i) => `(bin "${BINOP[nm]}" ${acc} ${one(a, ts[i + 1])})`,
    one(args[0], ts[0]));
}

/**
 * `concat` —— 方言里没有这一格，它是**串的 `+`**。不是串的那几格先过 `(tostr …)`
 * （图上 `concat` 的实参可以是任何东西：lua 的 `..` 就是这样用的）。
 */
function concatText(args, env, ctx) {
  if (args.length === 0) return '(str "")';
  const one = (a) => (typeOf(a, env, ctx) === 'string' ? expr(a, env, ctx) : `(tostr ${expr(a, env, ctx)})`);
  return args.slice(1).reduce((acc, a) => `(bin "+" ${acc} ${one(a)})`, one(args[0]));
}

/** `len`：串问 `slen`、列表问 `alen`（图上是同一格内建，方言里是两个）。 */function lenText(a, env, ctx) {
  if (isNode(a) && a.op === 'ref' && elemType(env.get(a.attrs.name)) !== null) {
    return `(alen (var ${a.attrs.name}))`;
  }
  return `(slen ${expr(a, env, ctx)})`;
}

/**
 * 字段 / 下标那一格**宿主**的文本。只认一个名字（`(var p)`）——
 * 嵌套（`p.q.x`、`xs[0][1]`）要类型再往里推一层，这一刀不接。
 */
function objText(obj, env, ctx) {
  if (!isNode(obj) || obj.op !== 'ref') gap('字段 / 下标的宿主不是一个名字（嵌套那一档还没接）');
  const t = env.get(obj.attrs.name);
  if (!ctx.shapes.has(t) && elemType(t) === null) {
    gap(`'${obj.attrs.name}' 说不清形状（这一刀只认 \`bind\` 一格记录 / 列表绑出来的名字）`);
  }
  return `(var ${obj.attrs.name})`;
}


/** `(call 名 实参…)` 的文本（"当值用"那道检查在 `expr` 里，语句位置上不查）。 */
function callText(x, env, ctx) {
  const f = x.ins.fn;
  if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
  const args = argList(x, 'args').map((a) => expr(a, env, ctx));
  return `(call ${f.attrs.name}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
}

/** 一格字面量的方言写法。 */
function lit(v) {
  const t = litType(v);
  if (t === null) gap(`一格说不清类型的字面量：${JSON.stringify(v)}`);
  if (t === 'string') return `(str ${strLit(v)})`;
  if (t === 'bool') return `(bool ${v ? 'true' : 'false'})`;
  if (t === 'real') return `(real ${v})`;
  return `(int ${v})`;
}

/** 一格**语句** -> 方言的文本（可能是好几句，所以回数组）。 */
function stmt(x, env, ctx) {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x.flatMap((y) => stmt(y, env, ctx));
  if (!isNode(x)) return [`(expr ${expr(x, env, ctx)})`];
  if (!OPS.has(x.op)) gap(x.op);
  switch (x.op) {
    case 'bind': {
      const nm = x.attrs.name;
      const init = x.ins.init;
      if (isNode(init) && init.op === 'func') gap('函数值（非顶层的 func）');
      if (isNode(init) && init.op === 'record-new') return bindRecord(nm, init, env, ctx);
      if (isNode(init) && init.op === 'list-new') return bindList(nm, init, env, ctx);
      const t = typeOf(init, env, ctx);
      env.set(nm, t);
      return [`(let ${nm} ${t} ${expr(init, env, ctx)})`];
    }
    case 'set': return [`(set ${x.attrs.name} ${expr(x.ins.value, env, ctx)})`];
    case 'field-set':
      return [`(fldset ${objText(x.ins.obj, env, ctx)} ${x.attrs.field} ${expr(x.ins.value, env, ctx)})`];
    case 'index-set': {
      if (elemType(typeOf(x.ins.obj, env, ctx)) === null) {
        gap('往一格说不清形状的东西里按下标写（这一刀只接 list-new 绑出来的那格）');
      }
      return [`(aset ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.index, env, ctx)} ${expr(x.ins.value, env, ctx)})`];
    }
    case 'region': {
      /* **一格 region 就是一层作用域** —— 方言里那是 `(do …)`。摊平过一版，`nim+blockscope`
       * 当场红：两层各有一格 `x`，摊平之后就是"'x' 在这一层已经声明过了"。
       * 类型表也跟着分层（`new Map(env)`），不然里层那格的类型会漏到外层。 */
      const inner = new Map(env);
      return [`(do ${stmt(x.ins.body, inner, ctx).join(' ')})`];
    }
    case 'loop': {
      const body = stmt(x.ins.body, env, ctx);
      /* 步进那一格（`post`）在方言里没有对应物 —— 缀在体末尾就够（这一刀不接 `continue`
       * 与 `post` 同时出现的那种：那时缀在末尾会把步进跳掉，见 nodes.js 上那段）。 */
      const post = x.ins.post === undefined ? [] : stmt(x.ins.post, env, ctx);
      if (post.length > 0 && hasContinue(x.ins.body)) {
        gap('循环里同时有 continue 与步进（方言里得把步进抬出来，还没接）');
      }
      return [`(while ${expr(x.ins.cond, env, ctx)} (do ${[...body, ...post].join(' ')}))`];
    }
    case 'loop-exit': return [x.attrs.kind === 'continue' ? '(cont)' : '(brk)'];
    case 'branch': {
      const then = stmt(x.ins.then, env, ctx);
      const els = x.ins.else === undefined ? [] : stmt(x.ins.else, env, ctx);
      const head = `(if ${expr(x.ins.cond, env, ctx)} (do ${then.join(' ')})`;
      return [els.length === 0 ? `${head})` : `${head} (do ${els.join(' ')}))`];
    }
    case 'ret': {
      const v = x.ins.value;
      return [v === undefined || v === null ? '(ret)' : `(ret ${expr(v, env, ctx)})`];
    }
    case 'prim': {
      if (x.attrs.name !== 'print') return [`(expr ${expr(x, env, ctx)})`];
      const args = argList(x, 'args');
      if (args.length !== 1) gap(`print 收了 ${args.length} 格实参（方言的 print 只收一格）`);
      return [`(print ${expr(args[0], env, ctx)})`];
    }
    case 'call':
      /* **语句位置**上调一格没有返回值的函数是对的（go / V 那格 `(call main)` 就是）——
       * 所以这儿不走 `expr` 的那道"当值用"检查，自己拼。 */
      return [`(expr ${callText(x, env, ctx)})`];
    default: return [`(expr ${expr(x, env, ctx)})`];
  }
}

/**
 * `let p = R{…}` —— 方言里是**两步**：`(new 形状)` 拿零值，再逐个字段 `(fldset …)`。
 *
 * 形状按**字段名单 + 字段类型**去重（同形的两格记录共用一格 `(struct …)`），名字是
 * `r1` / `r2` … 按登记顺序发 —— 所以同一张图落两遍逐字节相同。字段类型从**初值**推
 * （图上没有类型），推不出标量就当场报。
 */
function bindRecord(nm, rec, env, ctx) {
  const names = rec.attrs.names;
  if (!Array.isArray(names) || names.length === 0) gap('一格没有字段名单的记录');
  const vals = argList(rec, 'fields');
  if (vals.length !== names.length) {
    gap(`记录的字段名单是 ${names.length} 格，值给了 ${vals.length} 格`);
  }
  const types = names.map((_, i) => {
    const t = typeOf(vals[i], env, ctx);
    if (t !== 'int' && t !== 'real' && t !== 'bool' && t !== 'string') {
      gap(`记录的字段 '${names[i]}' 不是标量（方言的字段这一刀只收标量）`);
    }
    return t;
  });
  const key = names.map((n, i) => `${n}:${types[i]}`).join('|');
  let shape = ctx.byKey.get(key);
  if (shape === undefined) {
    shape = { tag: `r${ctx.byKey.size + 1}`, names: names, types: new Map() };
    for (let i = 0; i < names.length; i++) shape.types.set(names[i], types[i]);
    ctx.byKey.set(key, shape);
    ctx.shapes.set(shape.tag, shape);
    ctx.decls.push(`  (struct ${shape.tag} ${names.map((n, i) => `(${n} ${types[i]})`).join(' ')})`);
  }
  const out = [`(let ${nm} ${shape.tag} (new ${shape.tag}))`];
  for (let i = 0; i < names.length; i++) {
    out.push(`(fldset (var ${nm}) ${names[i]} ${expr(vals[i], env, ctx)})`);
  }
  env.set(nm, shape.tag);
  return out;
}

/**
 * `let xs = [1,2,3]` —— 方言里是 `(anew (arr T) 长度)` 再逐格 `(aset …)`。
 * 元素类型从第一格元素推，剩下的必须一致（不一致当场报 —— 方言的数组是单态的）。
 */
function bindList(nm, lst, env, ctx) {
  const items = argList(lst, 'items');
  if (items.length === 0) gap('一格空列表（元素类型推不出来）');
  const ts = items.map((it) => typeOf(it, env, ctx));
  const et = ts[0];
  if (et !== 'int' && et !== 'real' && et !== 'bool' && et !== 'string') {
    gap(`列表的元素不是标量（这一刀只接标量元素，量到的是 ${et}）`);
  }
  if (ts.some((t) => t !== et)) gap(`列表里的元素类型不一样（${ts.join(' / ')}）—— 方言的数组是单态的`);
  const at = `(arr ${et})`;
  const out = [`(let ${nm} ${at} (anew ${at} (int ${items.length})))`];
  for (let i = 0; i < items.length; i++) {
    out.push(`(aset (var ${nm}) (int ${i}) ${expr(items[i], env, ctx)})`);
  }
  env.set(nm, at);
  return out;
}


/** 这块子图里有没有 `continue`（步进那一格要它才报缺口）。 */
function hasContinue(x) {
  if (Array.isArray(x)) return x.some(hasContinue);
  if (!isNode(x)) return false;
  if (x.op === 'loop-exit') return x.attrs.kind === 'continue';
  if (x.op === 'loop') return false;              // 里层循环的 continue 是它自己的事
  return Object.values(x.ins).some(hasContinue);
}

/**
 * 图 -> 方言文本（`(module (fn …)… (main …))`）。
 *
 * 顶层分两拨：`bind` 一格 `func` 的落成 `(fn …)`，别的落进 `(main …)`。
 * 函数的**形参与返回都按 int**（这一刀的边界，见文件头）—— 体里 `ret` 一格串或真假时
 * 按那个类型收，收不齐就当场报（不猜）。
 */
export function emitCore(g) {
  const items = Array.isArray(g) ? g : (g.kind === 'graph' ? g.body : [g]);
  const list = Array.isArray(items) ? items : [items];
  const env = new Map();
  /* 整份产物共用的登记处：`byKey` 按"字段名单 + 类型"去重、`shapes` 按标签查、
     `decls` 是要印在模块头上的那几句 `(struct …)`。 */
  const ctx = { byKey: new Map(), shapes: new Map(), decls: [] };
  /* 先把顶层函数的名字与返回类型都登记上 —— 互相递归（`fact` 调自己）要它。 */
  const fns = [];
  const rest = [];
  for (const it of list) {
    if (isNode(it) && it.op === 'bind' && isNode(it.ins.init) && it.ins.init.op === 'func') {
      const f = it.ins.init;
      const params = (f.attrs.params ?? []).map((p) => String(p));
      fns.push({ name: it.attrs.name, params: params, body: f.ins.body });
      /* 体里一格 `ret` 都没有：那可能是**一格 void 函数**（go / V 的 `main` 就是），
       * 也可能是**隐式返回**（chez / sbcl 那两门体末尾那个值就是返回值）。两者在图上同形，
       * 分不开 —— 所以这儿一律记成 `void`，等**调用点**说话：它被当值用了才报缺口
       * （见 `expr` 的 call 那一支）。糊一格 `(ret 0)` 上去是最坏的：矩阵上量到过
       * chez+intmath 印 0 / 0、sbcl+blockret 末行印 0 —— 悄悄给错答案。 */
      const rt = retTypeOf(f.ins.body) ?? 'void';
      env.set(`fn:${it.attrs.name}`, rt);
      continue;
    }
    rest.push(it);
  }
  const body = [];
  for (const f of fns) {
    const fenv = new Map(env);
    for (const p of f.params) fenv.set(p, 'int');
    const ps = f.params.map((p) => `(${p} int)`).join(' ');
    const ret = env.get(`fn:${f.name}`) ?? 'int';
    const fbody = stmt(f.body, fenv, ctx);
    /* **掉到函数尾**这件事不许糊：方言要求非 void 的函数每条路都有 `ret`，而图上"体末尾那个
     * 值就是返回值"（chez / sbcl 那两门）是合法的。补一格 `(ret 0)` 交上去 = 悄悄给错答案
     * —— 矩阵上量到过两次（chez+intmath 印 0/0、sbcl+blockret 末行印 0）。
     * 所以这儿只认"末尾就是 ret"那一种，别的当场报缺口。 */
    if (!endsWithRet(f.body) && ret !== 'void') {
      gap(`函数 '${f.name}' 的体末尾不是 ret（隐式返回那一档 —— 补零值会给错答案）`);
    }
    body.push(`  (fn ${f.name} (${ps}) ${ret} ${fbody.join(' ')})`);
  }
  const mainStmts = rest.flatMap((it) => stmt(it, env, ctx));
  body.push(`  (main ${mainStmts.join(' ')}))`);
  /* `(struct …)` 要印在**用到它的东西前头**，而形状是落语句的时候才登记上的 ——
     所以这几句最后拼（次序：模块头、struct 那几句、函数、main）。 */
  return `${['(module', ...ctx.decls, ...body].join('\n')}\n`;
}

/**
 * 函数体的**末尾**是不是一格 `ret`。
 *
 * 只看最后那一格（`region` 往里看它的末尾、`branch` 要两支都是）—— 保守：看不出来就当"不是"，
 * 于是报缺口而不是补零值。这一条与"每条路都有 ret"不是同一件事，但**够挡住给错答案**。
 */
function endsWithRet(body) {
  const last = Array.isArray(body) ? body[body.length - 1] : body;
  if (!isNode(last)) return false;
  if (last.op === 'ret') return true;
  if (last.op === 'region') return endsWithRet(last.ins.body);
  if (last.op === 'branch') {
    return last.ins.else !== undefined && endsWithRet(last.ins.then) && endsWithRet(last.ins.else);
  }
  return false;
}

/** 一格函数体里 `ret` 交出来的类型（只看第一处 —— 这一刀不做合一）。一格都没有回 null。 */
function retTypeOf(body) {
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) { const t = seek(y); if (t !== null) return t; }
      return null;
    }
    if (!isNode(x)) return null;
    if (x.op === 'ret') {
      const v = x.ins.value;
      if (v === undefined || v === null) return 'void';
      if (isLit(v)) return litType(v.lit);
      if (isNode(v) && v.op === 'const') return litType(v.attrs.value);
      if (isNode(v) && v.op === 'prim') {
        const nm = v.attrs.name;
        return (nm === '<' || nm === '>' || nm === '<=' || nm === '>=' || nm === '=' || nm === '!=' || nm === 'not')
          ? 'bool' : 'int';
      }
      return 'int';
    }
    for (const k of Object.values(x.ins)) { const t = seek(k); if (t !== null) return t; }
    return null;
  };
  return seek(body);
}

/**
 * 还没接的那几格**各自欠在哪儿**：欠在方言里（要先给 `sexpr/lower.js` 加词汇）还是欠在
 * 这一份翻译上（方言里有对应物，只是没写）。这两类的还债成本差一个数量级，混成一句
 * "还没接"就看不出来了。
 */
const WHY = {
  'map-new': '方言里**没有字典**这一格（`sexpr/lower.js` 的词汇表里只有 struct / arr）——'
    + '要先给方言加，不是这一份翻译的事',
  'map-get': '同 map-new：方言里没有字典',
  'map-set': '同 map-new：方言里没有字典',
  'map-has': '同 map-new：方言里没有字典',
  values: '多值（go 的 `a, b := f()`）—— 方言的函数只交一格回来，要先有元组或出参',
  pick: '多值的第几格 —— 跟 values 同一笔账',
  conv: '表示转换（`int(x)` / `str(x)`）—— 方言里有 `toreal`/`tostr`/`toint` 那几格，'
    + '欠的是"图上这一格该落到哪一个"那张表（图上没有类型，得先把源类型算出来）',
  slice: '切片 —— 方言的 `ssub` 只切串，列表的切片还没有',
  'scope-exit': 'go 的 `defer` —— 方言里没有作用域退出钩子，要先有它（或者在这儿做一趟'
    + '"把 defer 摊成末尾语句 + 每条 ret 前复制一份"的变换，那是另一刀）',
};

/** `can` 那一问：这格节点接不接得住（接不住给一句人话 —— 那句话就是账）。 */
export function coreCan(op) {
  if (OPS.has(op)) return true;
  if (declOf(op) === undefined) return `core 后端不认识这格节点：${op}`;
  const why = WHY[op];
  if (why !== undefined) return `core 这条腿还没接：${op} —— ${why}`;
  return `core 这条腿还没接：${op}（这一刀接的是标量 + 记录 + 列表那三档，见 backend-core.js 的头）`;
}

/**
 * 形状上的账（`gaps()` 答不出来的那些 —— 同一格节点的某种用法接不住）。
 *
 * **每条都带一份证物**（`witness`：一份当场触发它的手搭小图）——那是 `tests/graph/run.js`
 * 立的规矩：账留着不花钱、过期也不花钱，所以过期的账要能被抓出来（证物不再抛 = 这条已经
 * 不欠了，得改清单）。
 */
export const CORE_SHAPES = [
  {
    what: '函数值 / 闭包',
    why: '非顶层的 `func` 还没接（方言里那是 `(cfn …)`）',
    witness: () => program([node('bind', {
      init: node('func', { body: [node('bind', { init: node('func', { body: [] }, { params: [] }) }, { name: 'inner' })] }, { params: [] }),
    }, { name: 'outer' })]),
  },
  {
    what: 'print 多实参',
    why: '方言的 `print` 只收一格（图上那格按空格拼）',
    witness: () => program([node('prim', { args: [litNode(1), litNode(2)] }, { name: 'print' })]),
  },
  {
    what: '表达式位置上的 branch',
    why: '方言的块表达式还欠着（ADR-0031 §5）',
    witness: () => program([node('bind', {
      init: node('branch', { cond: litNode(true), then: litNode(1), else: litNode(2) }),
    }, { name: 'x' })]),
  },
  {
    what: 'continue + 步进同时出现',
    why: '缀在体末尾会把步进跳掉；抬出来那一刀还没做',
    witness: () => program([node('loop', {
      cond: litNode(true),
      body: [node('loop-exit', {}, { kind: 'continue' })],
      post: [node('set', { value: litNode(1) }, { name: 'i' })],
    })]),
  },
  {
    what: '隐式返回（体里一格 ret 都没有，却被当值用）',
    why: 'chez / sbcl 那两门的函数体末尾那个值就是返回值 —— 补 `(ret 0)` 会悄悄给错答案，'
      + '所以宁可报缺口（矩阵上量到过：chez+intmath 印 0 / 0）。'
      + '**只在被当值用时报**：体里没有 ret 也可能就是一格 void 函数（go / V 的 main）',
    witness: () => program([
      node('bind', {
        init: node('func', { body: [node('prim', { args: [litNode(1)] }, { name: 'print' })] }, { params: [] }),
      }, { name: 'f' }),
      node('bind', {
        init: node('call', { fn: node('ref', {}, { name: 'f' }), args: [] }),
      }, { name: 'x' }),
    ]),
  },
  {
    what: '记录 / 列表整格当值用',
    why: '这一刀的函数形参与返回都是 int，聚合一跑出去（当实参、被 print、被 return）'
      + '就说不清类型了 —— 只接字段与下标那两条路（`objText` 一处把门）',
    witness: () => program([
      node('bind', { init: node('record-new', { fields: [litNode(1)] }, { names: ['x'] }) }, { name: 'p' }),
      node('prim', { args: [node('ref', {}, { name: 'p' })] }, { name: 'print' }),
    ]),
  },
  {
    what: '表达式位置上的记录 / 列表',
    why: '方言里建一格记录是**两步**（`(new …)` 再逐个 `(fldset …)`），塞不进表达式 ——'
      + '所以只接 `bind` 的初值那一格（要接得先有临时量那一刀）',
    witness: () => program([node('prim', {
      args: [node('record-new', { fields: [litNode(1)] }, { names: ['x'] })],
    }, { name: 'print' })]),
  },
];

/**
 * 落出来的那份方言文本**真的跑一遍**：`sxTextToMod` -> OIR -> 解释器。
 * 与 wat / c 两条腿同一条判据形状：正确性由**一条既有的实现**来证，这儿那条实现
 * 就是我们自己那门语言的整条路。
 */
export function runCore(text) {
  const out = [];
  let buf = '';
  /* `setOutSink` 回的是**上一格 sink**（不是一格"撤销"函数）——照 backend-c 那一处的写法。 */
  const prev = setOutSink((s) => { buf += String(s); });
  try {
    const mod = sxTextToMod('graph-core', text, 'omni_main');
    interpret(mod);
  } finally {
    setOutSink(prev);
  }
  for (const line of buf.split('\n')) if (line !== '') out.push(line);
  return { value: null, out };
}



