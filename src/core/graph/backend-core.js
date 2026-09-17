// src/core/graph/backend-core.js —— **图 -> 我们自己那门核心方言（sx）-> OIR**（第一百五十二片）
//
// ## 这一格与别的后端不同在哪
//
// wat / c / js 那三条腿都是"图直接落成那门语言的文本"。这一条落的是**我们自己的中间语言**
// （`sexpr/lower.js` 那份核心方言），于是往下**整条既有的路白得**：OIR -> js / c / wasm /
// llvm 四条腿、摇树、profile、REPL、错误模型。ADR-0037 §5.1 那两条路里的 **B 路**就是它 ——
// 「不新开一条路，就不会有两条路走散」（ADR-0034 那句话的同一条理由）。
//
// ## 这一刀接哪几档：**27 格全接**（节点级缺口 0）
//
// 图上**没有类型**（`nodes.js` 文件头第一条：type 不是节点），而核心方言是**有类型的**。
// 这中间那一格差是这条腿的全部难处 —— 所以这一份里最多的代码是**把类型算出来**：
//
//   标量    字面量按值推（整 `int`、带小数点 `real`、串 `string`、真假 `bool`）
//   记录    按"字段名单 + 字段类型"登记成一格 `(struct rN …)`，同形的共用一格
//   列表    按第一格元素推成 `(arr T)`；切片走消去规则（新建 + 一圈 apush）
//   字典    按键值推成 `(dict K V)`；空字典从**同层第一处 map-set** 上取（lua / awk 那一档）
//   多值    落成一格合成结构体 `(struct mN (v0 …) (v1 …))` —— 方言的函数只交一格回来，
//           而结构体是值语义的，那正好就是 `return a, b` 的语义
//   形参    从**调用点**收（图上没有类型）：函数体走两趟，第一趟只收实参类型，第二趟出文本
//   隐式返回 末尾那一格是**一个值**（`isValueish`：region 往里问一层、两支躺着语句的
//           branch 不算、print 不算）时，**在图上**把它换成一格 `ret`（`retWrap`）——
//           换在图上而不是文本上，defer / 物化 / 块作用域那几趟才照常生效
//   defer   方言里没有出口钩子，所以走一趟变换：注册处落动作、这一层末尾逆序放一份、
//           每条 ret 前放**全部**层、`brk`/`cont` 前放**到那个循环为止**那几层
//           （带值的 ret 先把值算进临时量 —— go 的次序）。一层套一层的 region 各管自己那层
//   转换    `conv` 落 `toreal`/`toint`/`tostr`；两元运算自己**把矮的那边抬上去**
//           （方言里 int 与 real 不隐式混算）
//
// 形参与返回**默认 int**，推不出来就当场报（不猜）。
//
// **聚合只能从字段 / 下标 / 键那三条路走**：一格记录 / 列表 / 字典整格当值用（当实参、被
// print、被 return）一律报缺口 —— 这一刀的函数形参与返回都是 int，跑出去就说不清类型了。
// 同一条纪律在 `backend-c` 那边是 `recPlan` 的三个条件，这儿靠"谁来拼文本"落实
// （`objText` 一处把门）。剩下的账全是**形状上的**（见 `CORE_SHAPES`，各带一份证物）。

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
  /* 映射四格：方言第一百五十三片给了 `(dict K V)` 与 `dnew/dget/dset/dhas`，所以这一族
     也不必动 OIR（那几格就是主语言 `dict<K,V>` 走的 NewContainer / IndexGet / …）。 */
  'map-new', 'map-get', 'map-set', 'map-has',
  /* 多值（go 的 `return a, b`）：方言的函数只交一格回来，所以这一族落成**一格合成的结构体**
     （值语义，方言里返回结构体本来就是复制）—— `values` 是构造、`pick` 是取第 k 个字段。 */
  'values', 'pick',
  /* 切片：方言里没有，走 `nodes.js` 写着的消去规则（新建 + 一圈 apush，见 `bindSlice`）。 */
  'slice',
  /* defer：方言里没有出口钩子，所以走一趟**变换**（在这一层的末尾与每条 ret 前各放一份，
     逆序）—— 见 `stmtList`。 */
  'scope-exit',
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
  if (x.op === 'map-get') {
    const d = dictOf(typeOf(x.ins.obj, env, ctx));
    return d === null ? 'int' : d.val;
  }
  if (x.op === 'map-has') return 'bool';
  if (x.op === 'values') return multiShape(argList(x, 'args'), env, ctx).tag;
  if (x.op === 'pick') {
    const shape = ctx.shapes.get(typeOf(x.ins.from, env, ctx));
    if (shape === undefined) return 'int';
    return shape.types.get(`v${Number(x.attrs.index ?? 0)}`) ?? 'int';
  }
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

/** `(dict K V)` 的键与值。不是字典回 null。 */
function dictOf(t) {
  if (typeof t !== 'string' || !t.startsWith('(dict ')) return null;
  const two = t.slice(6, -1).split(' ');
  if (two.length !== 2) return null;
  return { key: two[0], val: two[1] };
}

/** 这一格类型是不是方言的标量（记录 / 列表 / 字典的元素只收这四格）。 */
const isScalar = (t) => t === 'int' || t === 'real' || t === 'bool' || t === 'string';

/**
 * 一格形状（记录或多值）在登记处里的那一份。同形的两格共用一格 `(struct …)`，
 * 标签按登记顺序发（记录 `rN`、多值 `mN`）—— 所以同一张图落两遍逐字节相同。
 */
function shapeOf(names, types, multi, ctx) {
  const key = `${multi ? 'm' : 'r'}|${names.map((n, i) => `${n}:${types[i]}`).join('|')}`;
  let shape = ctx.byKey.get(key);
  if (shape !== undefined) return shape;
  shape = {
    tag: `${multi ? 'm' : 'r'}${ctx.byKey.size + 1}`,
    names: names,
    types: new Map(),
    multi: multi,
  };
  for (let i = 0; i < names.length; i++) shape.types.set(names[i], types[i]);
  ctx.byKey.set(key, shape);
  ctx.shapes.set(shape.tag, shape);
  ctx.decls.push(`  (struct ${shape.tag} ${names.map((n, i) => `(${n} ${types[i]})`).join(' ')})`);
  return shape;
}

/**
 * 一格 `values`（`return a, b`）落成的那格结构体：字段就叫 `v0` / `v1` …
 *
 * 为什么是结构体而不是别的：方言的函数**只交一格回来**，而结构体是**值语义**的
 * （赋值/传参/返回都复制，见 tests/sexpr/cases/06-structs.sx）—— 那正好就是多值的语义。
 * 用全局变量当第二个出口是错的：中间再调一次同一个函数就串味了。
 */
function multiShape(vals, env, ctx) {
  const types = vals.map((v) => typeOf(v, env, ctx));
  for (const t of types) if (!isScalar(t)) gap(`多值里有一格不是标量（量到的是 ${t}）`);
  return shapeOf(types.map((_, i) => `v${i}`), types, true, ctx);
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
      if (dictOf(t) !== null) gap(`把字典 '${x.attrs.name}' 整格当值用（这一刀只接按键读写与 len）`);
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
    case 'pick': {
      const t = typeOf(x.ins.from, env, ctx);
      const shape = ctx.shapes.get(t);
      if (shape === undefined || shape.multi !== true) gap('pick 的来源不是一格多值');
      const i = Number(x.attrs.index ?? 0);
      if (i < 0 || i >= shape.names.length) gap(`pick 的第 ${i} 格超出了这格多值的宽度`);
      return `(fld ${objText(x.ins.from, env, ctx)} v${i})`;
    }
    case 'values': {
      /* 表达式位置上的多值（`print(values …)` 那种）：物化成一格临时结构体。
       * **只接纯的那几格实参**：这一处的物化是"一次使用一份"，实参有副作用时同一格 values
       * 被用两回就会算两遍 —— 那是静默的错答案，所以宁可报。 */
      if (ctx.pre === null || ctx.pre === undefined) gap('values 出现在没法摆物化那几句的位置上');
      const vals = argList(x, 'args');
      for (const a of vals) {
        if (!isPure(a)) gap('表达式位置上的多值里有一格带副作用的实参（这一刀只接纯值）');
      }
      const b = buildValues(x, env, ctx);
      for (const line of b.out) ctx.pre.push(line);
      return `(var ${b.name})`;
    }
    case 'map-get': {
      const dt = typeOf(x.ins.obj, env, ctx);
      const d = dictOf(dt);
      if (d === null) gap('map-get 的宿主不是字典');
      return `(dget ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)})`;
    }
    case 'map-has': {
      const dt = typeOf(x.ins.obj, env, ctx);
      const d = dictOf(dt);
      if (d === null) gap('map-has 的宿主不是字典');
      return `(dhas ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)})`;
    }
    case 'slice': gap('切片出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
    case 'map-new': gap('映射出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
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
    case 'branch': {
      /* 方言里 `if` 是语句，所以表达式位置上的 branch **物化**成一格临时量 + 两支各赋值
       * （wat 那条腿也是这么做的：`backend-wat.js` 的"值位置的 if"）。两支各带自己的筐 ——
       * 把 `(set …)` 之外的东西提到 `if` 前面是错的：那两支里可能有副作用（chez 的
       * `sum-go` 两支各是一次递归调用，提出去就无限递归了）。 */
      if (ctx.pre === null || ctx.pre === undefined) gap('branch 出现在表达式位置上，而这一处没地方摆物化的那两句');
      const els = x.ins.else;
      if (els === undefined || els === null) gap('表达式位置上的 branch 少了 else 那一支');
      const t = typeOf(x.ins.then, env, ctx);
      const t2 = typeOf(els, env, ctx);
      if (t !== t2) gap(`表达式位置上的 branch 两支不同型（${t} 与 ${t2}）`);
      /* 标量或**一格形状**（sbcl 的 `(if c (values …) (values …))` 就是后者）都接得住 */
      if (!isScalar(t) && !ctx.shapes.has(t)) gap(`表达式位置上的 branch 交出来的不是标量（${t}）`);
      ctx.tmp = ctx.tmp + 1;
      const nm = `if_tmp${ctx.tmp}`;
      const arm = (e) => {
        const outer = ctx.pre;
        const p = [];
        ctx.pre = p;
        let v;
        try {
          v = expr(e, env, ctx);
        } finally {
          ctx.pre = outer;
        }
        return `(do ${[...p, `(set ${nm} ${v})`].join(' ')})`;
      };
      const cond = condText(x.ins.cond, env, ctx);
      const a = arm(x.ins.then);
      const b = arm(els);
      ctx.pre.push(`(let ${nm} ${t} ${ctx.shapes.has(t) ? `(new ${t})` : zeroText(t)})`);
      ctx.pre.push(`(if ${cond} ${a} ${b})`);
      return `(var ${nm})`;
    }
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

/**
 * 循环 / 分支的**条件**。方言里条件必须是 `bool`，而图上那一格可能是 `const 1`
 * （cpp 的 `while (1)`、awk 的 `while (n)`）—— **真值观是语言那一侧的事**
 * （`nodes.js` 文件头那条：语言之间答案不同的东西由那门语言的映射给）。
 *
 * 所以这儿不替谁做主：不是 bool 就**报**，不擅自补 `!= 0`。补了在 C 家族里对、在 lua 里
 * 错（那门语言 0 是真），而这一份翻译看不见自己在给哪门语言干活 —— 那正是会给出静默错
 * 答案的形状。
 */
function condText(c, env, ctx) {
  const t = typeOf(c, env, ctx);
  if (t !== 'bool') {
    gap(`条件不是 bool（量到的是 ${t}）—— 方言的条件必须是 bool，而"几算真"是语言`
      + '那一侧的事（该由那门语言的映射补成一格比较，不该由这份翻译替它猜）');
  }
  return expr(c, env, ctx);
}

/** `len`：串问 `slen`、列表问 `alen`、字典问 `dlen`（图上是同一格内建，方言里是三个）。 */
function lenText(a, env, ctx) {
  if (isNode(a) && a.op === 'ref') {
    const t = env.get(a.attrs.name);
    if (elemType(t) !== null) return `(alen (var ${a.attrs.name}))`;
    if (dictOf(t) !== null) return `(dlen (var ${a.attrs.name}))`;
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
  if (!ctx.shapes.has(t) && elemType(t) === null && dictOf(t) === null) {
    gap(`'${obj.attrs.name}' 说不清形状（这一刀只认 \`bind\` 一格记录 / 列表 / 字典绑出来的名字）`);
  }
  return `(var ${obj.attrs.name})`;
}


/** `(call 名 实参…)` 的文本（"当值用"那道检查在 `expr` 里，语句位置上不查）。 */
function callText(x, env, ctx) {
  const f = x.ins.fn;
  if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
  const args = argList(x, 'args').map((a, i) => argText(f.attrs.name, i, a, env, ctx));
  return `(call ${f.attrs.name}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
}

/**
 * 一格实参。两件事：
 *   一、**把类型记进 `ctx.args`** —— 形参就是靠这一格定型的（图上没有类型，只有调用点知道）；
 *   二、聚合在实参位置上**是允许的**（方言的结构体是值语义、数组与字典是句柄，三样都能当
 *       形参）—— 所以这儿绕过 `expr` 那道"整格当值用"的门，自己拼名字。
 */
function argText(fname, i, a, env, ctx) {
  const t = typeOf(a, env, ctx);
  const key = `${fname}#${i}`;
  const had = ctx.args.get(key);
  /* **收类型那两遍不算冲突**：那时被调者的形参还按 int（默认值），所以"一处 int、一处
   * 记录"说明的是"这一格还没收全"，不是两处真的不一样 —— 取具体的那一个。真冲突留给
   * 第三遍（出文本那一遍）报。 */
  if (ctx.collect === true) {
    if (had === undefined || (had === 'int' && t !== 'int')) ctx.args.set(key, t);
    if (isNode(a) && a.op === 'ref' && isAggregate(t, ctx)) return `(var ${a.attrs.name})`;
    return expr(a, env, ctx);
  }
  if (had !== undefined && had !== t) {
    gap(`'${fname}' 第 ${i + 1} 格实参在两处的类型不一样（${had} 与 ${t}）—— 方言的形参是单态的`);
  }
  ctx.args.set(key, t);
  if (isNode(a) && a.op === 'ref' && isAggregate(t, ctx)) return `(var ${a.attrs.name})`;
  return expr(a, env, ctx);
}

/** 这一格类型是不是聚合（记录 / 列表 / 字典 / 多值）。 */
const isAggregate = (t, ctx) => ctx.shapes.has(t) || elemType(t) !== null || dictOf(t) !== null;

/** 一格标量的零值（物化那一格要它 —— `(let tmp T 零值)` 之后两支各赋值）。 */
function zeroText(t) {
  if (t === 'real') return '(real 0.0)';
  if (t === 'bool') return '(bool false)';
  if (t === 'string') return '(str "")';
  return '(int 0)';
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

/**
 * **一层的语句序** -> 方言的文本。`defer`（`scope-exit`）那一格的变换住在这儿。
 *
 * 方言里没有"作用域出口钩子"，所以照三条语义各放一份文本（三条都写在
 * `ext/go/examples/defer.go` 上）：
 *   一、注册那一刻记下动作 —— 所以动作的文本**在这一格 scope-exit 那儿就落**
 *       （它只引用得到那之前绑的名字，正是 go 的"实参在注册时算掉"）；
 *   二、这一层出口时**逆序**跑 —— `frame` 用 unshift 攒，末尾放一份；
 *   三、**早退也跑** —— `ret` 那一格自己去 `ctx.defers` 里取（见 `stmt` 的 ret 支）。
 *
 * 明着不接的两格：注册在里层（分支 / 循环体里）、以及**注册之前就有 ret**
 * （那时"这条 ret 该跑哪几格"要按位置算，这一刀不做）。
 */
function stmtList(list, env, ctx) {
  const arr = list === null || list === undefined ? [] : (Array.isArray(list) ? list : [list]);
  /* 这一层的语句序摆在 ctx 上：空字典要往后找第一处 `map-set` 才知道类型（见 `mapHint`）。 */
  const outerScope = ctx.scope;
  ctx.scope = arr;
  const out = stmtListIn(arr, env, ctx);
  ctx.scope = outerScope;
  return out;
}

function stmtListIn(arr, env, ctx) {
  const isExit = (s) => isNode(s) && s.op === 'scope-exit';
  /* 里层的 `region` **自己管自己那一层的出口动作**（它也走这一趟），所以这儿不必往里查 ——
   * 落到别处（分支 / 循环体的语句序上）的那几格由 `stmtIn` 的 `case 'scope-exit'` 兜住。
   * sbcl 的 unwind-protect 与 lua 的元表就是"一层套一层的 region"那种形状。 */
  if (!arr.some(isExit)) return arr.flatMap((s) => stmt(s, env, ctx));
  let last = -1;
  for (let i = 0; i < arr.length; i++) if (isExit(arr[i])) last = i;
  for (let i = 0; i < last; i++) {
    if (!isExit(arr[i]) && hasRet(arr[i])) {
      gap('scope-exit 注册之前就有 ret（这一刀要"注册都在前头"，不然得按位置算跑哪几格）');
    }
  }
  const frame = [];
  ctx.defers.push(frame);
  const out = [];
  for (const s of arr) {
    if (isExit(s)) {
      /* 逆序：后注册的先跑。动作里的 `bind` 走一格自己的类型表 —— 那几个名字是动作私有的。 */
      frame.unshift(...stmt(s.ins.action, new Map(env), ctx));
      continue;
    }
    out.push(...stmt(s, env, ctx));
  }
  ctx.defers.pop();
  /* 末尾已经是 ret 的话那一格自己放过了，别再放一份（死代码）。 */
  if (!endsWithRet(arr)) out.push(...frame);
  return out;
}

/** 这一层往里还有没有 `scope-exit`（有就报缺口 —— 别悄悄漏掉一格出口动作）。 */
function hasScopeExit(x) {
  if (Array.isArray(x)) return x.some(hasScopeExit);
  if (!isNode(x)) return false;
  if (x.op === 'scope-exit') return true;
  if (x.op === 'func') return false;                 // 里层函数的出口是它自己的事
  return Object.values(x.ins).some(hasScopeExit);
}

/** 这块子图里有没有 `ret`（`scope-exit` 那一格要按它判"注册是不是都在前头"）。 */
function hasRet(x) {
  if (Array.isArray(x)) return x.some(hasRet);
  if (!isNode(x)) return false;
  if (x.op === 'ret') return true;
  if (x.op === 'func') return false;
  return Object.values(x.ins).some(hasRet);
}

/** 这一处 `ret` 要先跑哪几句：从里层往外层，每层都逆序（`frame` 攒的时候就是逆序）。 */
function pendingDefers(ctx) {
  const out = [];
  for (let i = ctx.defers.length - 1; i >= 0; i--) out.push(...ctx.defers[i]);
  return out;
}

/**
 * 一格**语句** -> 方言的文本（可能是好几句，所以回数组）。
 *
 * 这一层还管**物化**：表达式位置上的 `branch` 要一格临时量 + 两支各赋值才落得下去
 * （方言的 `if` 是语句），那两句得摆在这条语句**前面** —— `ctx.pre` 就是那个筐。
 * 每条语句一只自己的筐（进来换、出去还），所以嵌在里层的物化不会漏到外层去。
 */
function stmt(x, env, ctx) {
  const outer = ctx.pre;
  const pre = [];
  ctx.pre = pre;
  let out;
  try {
    out = stmtIn(x, env, ctx);
  } finally {
    ctx.pre = outer;
  }
  return pre.length === 0 ? out : [...pre, ...out];
}

function stmtIn(x, env, ctx) {
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
      if (isNode(init) && init.op === 'slice') return bindSlice(nm, init, env, ctx);
      if (isNode(init) && init.op === 'map-new') return bindMap(nm, init, env, ctx);
      /* **awk 的"没赋过值的变量"**：映射把它落成 `bind n = null`（`ext/awk/tograph.js`
       * 的 bodyOf）。方言是有类型的，所以这一格照**第一次赋值**定型，值给那个类型的零值 ——
       * 与 awk 的语义对得上（那门语言里没赋过值的变量当数是 0、当串是 ""，正好都是零值）。 */
      if (isLitNull(init)) {
        const t = nullHint(nm, ctx, env);
        env.set(nm, t);
        return [`(let ${nm} ${t} ${zeroText(t)})`];
      }
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
    case 'map-set': {
      if (dictOf(typeOf(x.ins.obj, env, ctx)) === null) {
        gap('往一格说不清形状的东西里按键写（这一刀只接 map-new 绑出来的那格）');
      }
      return [`(dset ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)} ${expr(x.ins.value, env, ctx)})`];
    }
    case 'region': {
      /* **一格 region 就是一层作用域** —— 方言里那是 `(do …)`。摊平过一版，`nim+blockscope`
       * 当场红：两层各有一格 `x`，摊平之后就是"'x' 在这一层已经声明过了"。
       * 类型表也跟着分层（`new Map(env)`），不然里层那格的类型会漏到外层。 */
      const inner = new Map(env);
      return [`(do ${stmtList(x.ins.body, inner, ctx).join(' ')})`];
    }
    case 'scope-exit':
      return gap('这处 scope-exit 不在一层语句序上（这一刀只接函数体与 `(do …)` 那两处）');
    case 'loop': {
      /* 步进那一格（`post`）在方言里没有对应物：缀在体末尾就够 —— 但**`continue` 会跳过它**。
       * 所以进体之前先把这一层的步进文本摆在 `ctx.post` 上，`loop-exit continue` 那一格
       * 自己在 `(cont)` 前面补一份（C 的 for 就是这个语义）。嵌套时逐层保存/还原：
       * 里层的 continue 是里层的事。 */
      const post = x.ins.post === undefined ? [] : stmt(x.ins.post, env, ctx);
      const outerPost = ctx.post;
      ctx.post = post;
      /* **break / continue 也要跑出口动作** —— 跑的是"从这儿到这个循环之间"那几层
       * （`hand+break-exit` 当场量到过：漏掉的话 1/2/3 印成 1/3，那是静默的错答案）。
       * 所以进体之前把"这个循环那一层的 defer 栈深"记下来，`loop-exit` 照它往上收。 */
      ctx.loopBase.push(ctx.defers.length);
      const body = stmt(x.ins.body, env, ctx);
      ctx.loopBase.pop();
      ctx.post = outerPost;
      /* 条件里要是有一格得物化的东西（表达式位置的 branch），提到循环外面就**不是每轮算**
       * 了 —— 那是静默的错答案，所以报。 */
      const nPre = ctx.pre.length;
      const cond = condText(x.ins.cond, env, ctx);
      if (ctx.pre.length !== nPre) {
        gap('循环的条件里有一格要物化的表达式（提到循环外就不是每轮算了）');
      }
      return [`(while ${cond} (do ${[...body, ...post].join(' ')}))`];
    }
    case 'loop-exit': {
      /* 离开这个循环要跑的出口动作：栈顶往下收到这个循环那一层为止（每层各自已是逆序）。
       * `continue` 再补一份步进 —— 次序是"出口动作、步进、跳"（C 家族就是这个次序）。 */
      const base = ctx.loopBase.length === 0 ? 0 : ctx.loopBase[ctx.loopBase.length - 1];
      const acts = [];
      for (let i = ctx.defers.length - 1; i >= base; i--) acts.push(...ctx.defers[i]);
      if (x.attrs.kind === 'continue') return [...acts, ...ctx.post, '(cont)'];
      return [...acts, '(brk)'];
    }
    case 'branch': {
      const then = stmt(x.ins.then, env, ctx);
      const els = x.ins.else === undefined ? [] : stmt(x.ins.else, env, ctx);
      const head = `(if ${condText(x.ins.cond, env, ctx)} (do ${then.join(' ')})`;
      return [els.length === 0 ? `${head})` : `${head} (do ${els.join(' ')}))`];
    }
    case 'ret': {
      const v = x.ins.value;
      const pend = pendingDefers(ctx);
      /* 多值：先把那格合成结构体拼出来（零值 + 逐个 fldset），再交回去。 */
      if (isNode(v) && v.op === 'values') {
        const b = buildValues(v, env, ctx);
        return [...b.out, ...pend, `(ret (var ${b.name})`.concat(')')];
      }
      if (pend.length === 0) {
        return [v === undefined || v === null ? '(ret)' : `(ret ${expr(v, env, ctx)})`];
      }
      if (v === undefined || v === null) return [...pend, '(ret)'];
      /* **先把要交回去的值算掉，再跑出口动作** —— go 的语义就是这个次序（出口动作改了
       * 那个变量也改不了已经算出来的返回值）。所以物化一格临时量，不是直接 `(ret …)`。 */
      ctx.tmp = ctx.tmp + 1;
      const nm = `ret_tmp${ctx.tmp}`;
      return [`(let ${nm} ${typeOf(v, env, ctx)} ${expr(v, env, ctx)})`, ...pend, `(ret (var ${nm}))`];
    }
    case 'prim': {
      if (x.attrs.name !== 'print') return [`(expr ${expr(x, env, ctx)})`];
      const args = argList(x, 'args');
      if (args.length !== 1) gap(`print 收了 ${args.length} 格实参（方言的 print 只收一格）`);
      /* **一格多值直接印**（go 的 `fmt.Println(minmax(1, 2))` 印 "1 2"）：图上那条 arity 契约
       * 是"列表里最后一格展开"，落到方言这边就是把那几格拼成一句（空格分隔）。 */
      const shape = ctx.shapes.get(typeOf(args[0], env, ctx));
      if (shape !== undefined && shape.multi === true) return printMulti(args[0], shape, env, ctx);
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
  const shape = shapeOf(names, types, false, ctx);
  const out = [`(let ${nm} ${shape.tag} (new ${shape.tag}))`];
  for (let i = 0; i < names.length; i++) {
    out.push(`(fldset (var ${nm}) ${names[i]} ${expr(vals[i], env, ctx)})`);
  }
  env.set(nm, shape.tag);
  return out;
}

/**
 * `let m = {"a": 1}` —— 方言里是 `(dnew (dict K V))` 再逐格 `(dset …)`。
 *
 * 键与值的类型从**字面量**推（图上没有类型）。麻头是**空字典**：lua 的 `local m = {}`、
 * awk 的隐式数组落出来的 `map-new` 一格键值都没有，类型只能等第一次写才知道 ——
 * 所以这儿往这一层的语句序里找第一处 `map-set`（`ctx.scope`，由 `stmtList` 摆好）。
 * 找不着就报缺口：一格永远不写的空字典说不清它是什么。
 */
function bindMap(nm, mp, env, ctx) {
  const keys = argList(mp, 'keys');
  const vals = argList(mp, 'vals');
  if (keys.length !== vals.length) {
    gap(`映射的键给了 ${keys.length} 格、值给了 ${vals.length} 格`);
  }
  let kt = keys.length > 0 ? typeOf(keys[0], env, ctx) : null;
  let vt = vals.length > 0 ? typeOf(vals[0], env, ctx) : null;
  if (kt === null) {
    const hint = mapHint(nm, ctx, env);
    kt = hint.key;
    vt = hint.val;
  }
  if (kt !== 'int' && kt !== 'string') gap(`字典的键只能是 int 或 string（量到的是 ${kt}）`);
  if (!isScalar(vt)) gap(`字典的值只能是标量（量到的是 ${vt}）`);
  for (let i = 0; i < keys.length; i++) {
    if (typeOf(keys[i], env, ctx) !== kt) gap('字典字面量里的键类型不一样 —— 方言的字典是单态的');
    if (typeOf(vals[i], env, ctx) !== vt) gap('字典字面量里的值类型不一样 —— 方言的字典是单态的');
  }
  const dt = `(dict ${kt} ${vt})`;
  const out = [`(let ${nm} ${dt} (dnew ${dt}))`];
  for (let i = 0; i < keys.length; i++) {
    out.push(`(dset (var ${nm}) ${expr(keys[i], env, ctx)} ${expr(vals[i], env, ctx)})`);
  }
  env.set(nm, dt);
  return out;
}

/** 一格 `null` 字面量（awk 的"没赋过值"）。 */
function isLitNull(x) {
  if (isLit(x)) return x.lit === null;
  return isNode(x) && x.op === 'const' && x.attrs.value === null;
}

/** `null` 那一格的类型从**第一处赋值**上取。找不着就报缺口，不猜。 */
function nullHint(nm, ctx, env) {
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) { const r = seek(y); if (r !== null) return r; }
      return null;
    }
    if (!isNode(x)) return null;
    if (x.op === 'set' && x.attrs.name === nm && !isLitNull(x.ins.value)) {
      return typeOf(x.ins.value, env, ctx);
    }
    for (const k of Object.values(x.ins)) { const r = seek(k); if (r !== null) return r; }
    return null;
  };
  const t = seek(ctx.scope);
  if (t === null || !isScalar(t)) {
    gap(`'${nm}' 是一格 null（没赋过值），而这一层里找不到一处给它赋标量的地方 ——`
      + '方言是有类型的，说不清类型就落不下去');
  }
  return t;
}

/** 空字典的类型从**第一处写**上取（lua / awk 那一档）。找不着就报缺口，不猜。 */
function mapHint(nm, ctx, env) {
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) { const r = seek(y); if (r !== null) return r; }
      return null;
    }
    if (!isNode(x)) return null;
    if (x.op === 'map-set' && isNode(x.ins.obj) && x.ins.obj.op === 'ref'
      && x.ins.obj.attrs.name === nm) {
      return { key: typeOf(x.ins.key, env, ctx), val: typeOf(x.ins.value, env, ctx) };
    }
    for (const k of Object.values(x.ins)) { const r = seek(k); if (r !== null) return r; }
    return null;
  };
  const got = seek(ctx.scope);
  if (got === null) {
    gap(`空字典 '${nm}' 的键值类型推不出来（这一层里没有一处 map-set —— 图上没有类型）`);
  }
  return got;
}

/**
 * `let ys = xs[1:3]` —— 方言里**没有列表切片**，所以这一格走 `nodes.js` 上写着的那条
 * **消去规则**（"`list-new` -> 一格存储 + 一串写"的同一条）：新建一格空数组，再拿一圈
 * `while` 把 `[from, to)` 逐格 `apush` 过去。
 *
 * 图上的规矩这儿照抄：**上界不含、下标 0 起**（nim 那个含上界的差由 nim 自己的映射 +1）。
 * 计数器的名字带一格序号（`slice_iN`），所以嵌两层切片也不会撞名。
 */
function bindSlice(nm, sl, env, ctx) {
  const obj = sl.ins.obj;
  const at = typeOf(obj, env, ctx);
  const et = elemType(at);
  if (et === null) gap('在一格说不清形状的东西上切片（这一刀只接 list-new 绑出来的那格）');
  const src = objText(obj, env, ctx);
  const from = sl.ins.from === undefined || sl.ins.from === null ? '(int 0)' : expr(sl.ins.from, env, ctx);
  const to = sl.ins.to === undefined || sl.ins.to === null ? `(alen ${src})` : expr(sl.ins.to, env, ctx);
  ctx.tmp = ctx.tmp + 1;
  const i = `slice_i${ctx.tmp}`;
  env.set(nm, at);
  return [
    `(let ${nm} ${at} (anew ${at} (int 0)))`,
    `(do (let ${i} int ${from})`
      + ` (while (bin "<" (var ${i}) ${to})`
      + ` (do (apush (var ${nm}) (aget ${src} (var ${i}))) (set ${i} (bin "+" (var ${i}) (int 1))))))`,
  ];
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


/**
 * 把一格 `values` 拼成那格合成结构体：零值 + 逐个 `fldset`。回"那几句 + 临时量的名字"。
 */
function buildValues(v, env, ctx) {
  const vals = argList(v, 'args');
  const shape = multiShape(vals, env, ctx);
  ctx.tmp = ctx.tmp + 1;
  const name = `mv_tmp${ctx.tmp}`;
  const out = [`(let ${name} ${shape.tag} (new ${shape.tag}))`];
  for (let i = 0; i < vals.length; i++) {
    out.push(`(fldset (var ${name}) v${i} ${expr(vals[i], env, ctx)})`);
  }
  return { shape: shape, name: name, out: out };
}

/** 纯不纯（够这一刀用的那一档：字面量、常量、名字、纯内建）。 */
function isPure(x) {
  if (isLit(x)) return true;
  if (!isNode(x)) return false;
  if (x.op === 'const' || x.op === 'ref') return true;
  if (x.op === 'prim') {
    return x.attrs.name !== 'print' && argList(x, 'args').every(isPure);
  }
  return false;
}

/**
 * 一格多值印成一句：`(tostr v0) + " " + (tostr v1) …`。
 *
 * 为什么敢拿 `tostr` 顶 `print`：这门方言里两处印的是同一份字符串（量过 int / real /
 * bool 三格都一样，`(print (tostr (real 1.5)))` 与 `(print (real 1.5))` 都是 `1.5`）。
 */
function printMulti(a, shape, env, ctx) {
  ctx.tmp = ctx.tmp + 1;
  const nm = `pv_tmp${ctx.tmp}`;
  let s = `(tostr (fld (var ${nm}) ${shape.names[0]}))`;
  for (const n of shape.names.slice(1)) {
    s = `(bin "+" ${s} (bin "+" (str " ") (tostr (fld (var ${nm}) ${n}))))`;
  }
  return [`(let ${nm} ${shape.tag} ${expr(a, env, ctx)})`, `(print ${s})`];
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
 * 图 -> 方言文本（`(module (struct …)… (fn …)… (main …))`）。
 *
 * 顶层分两拨：`bind` 一格 `func` 的落成 `(fn …)`，别的落进 `(main …)`。
 *
 * **先落 main、后落函数**（次序是刻意的，不是随手）：形参的类型只有**调用点**知道
 * （图上没有类型），而调用点绝大多数在 main 里。所以先走一遍 main 把每处调用的实参类型
 * 记进 `ctx.args`，再落函数体时形参就有类型了 —— 记录、字典、串都能当形参。
 * 只被别的函数调的那些仍旧按 int（那时账还没记上）—— 那一格照旧报缺口，不猜。
 */
export function emitCore(g) {
  const items = Array.isArray(g) ? g : (g.kind === 'graph' ? g.body : [g]);
  const list = Array.isArray(items) ? items : [items];
  const env = new Map();
  /* 整份产物共用的登记处：`byKey` 按"字段名单 + 类型"去重、`shapes` 按标签查、
     `decls` 是要印在模块头上的那几句 `(struct …)`、`args` 是调用点记下的实参类型。 */
  const ctx = {
    byKey: new Map(), shapes: new Map(), decls: [], tmp: 0,
    defers: [], scope: [], post: [], args: new Map(), pre: null, loopBase: [], collect: false,
  };
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
      let rt = retTypeOf(f.ins.body, env, ctx);
      /* **体末尾是不是一个值**（chez / sbcl 的隐式返回）。是就把它当返回值 —— 那不是
       * "补零值"（补零值给错答案，之前量到过两次），那就是那两门语言的语义本身。
       * 判据是 `isValueish`（sort 那一栏 + print 与"两支躺着语句"那两格例外）。
       *
       * **体里有显式 ret 也要问这一句**：sbcl 的 `max2` 是
       * `(if (> a b) (return-from max2 a)) b` —— 前面一格显式 ret、末尾那个值也是返回值。
       * 原先只在"一格 ret 都没有"时问，于是那一格落到"体末尾不是 ret"上报了缺口。 */
      let impl = implicitRet(f.ins.body);
      if (impl !== null) {
        const penv = new Map(env);
        for (const p of params) penv.set(p, 'int');
        const t = typeOf(impl, penv, ctx);
        /* 标量或**一格形状**（chez 的 `(values 3 7)` 当函数体就是后者）都算 */
        if (t === 'void' || !(isScalar(t) || ctx.shapes.has(t))) impl = null;
        else if (rt === null) rt = t;
        else if (rt === 'void') impl = null;      // void 函数末尾那个值不是返回值
        else if (rt !== t) {
          gap(`函数 '${it.attrs.name}' 的显式 ret 交的是 ${rt}，体末尾那个值是 ${t}`
            + '（这一刀不做合一）');
        }
      }
      fns[fns.length - 1].impl = rt === null ? null : impl;
      env.set(`fn:${it.attrs.name}`, rt ?? 'void');
      continue;
    }
    rest.push(it);
  }
  /* **函数体看得见的只有函数名**（外加它自己的形参）：`env` 走一趟 main 之后会带上 main
   * 的局部（那是这一刀"先落 main"的副作用），而方言的函数看不见调用方的局部 —— 所以先
   * 留一份只有 `fn:` 那几格的干净底子。少了这一格，闭那种借外面名字的函数就会一路落到
   * 方言那儿才报"未声明的变量"（硬错，不是有名有姓的缺口）—— `chez+index` 当场量到过。 */
  const fnEnv = new Map(env);
  const mainStmts = stmtList(rest, env, ctx);
  /* **函数体走两趟**。第一趟只为收实参类型：一个函数体里的调用点也会给别的函数的形参定型
   * （cpp 的析构器 `__destruct_Say(this)` 就是从另一个函数体里调的，而它在图上排在前面），
   * 而那时 `ctx.args` 还没记上。所以先空跑一趟（缺口忽略 —— 这一趟不出文本），把登记处
   * 再落第二趟出真文本。
   *
   * **登记处不回滚**：第一趟登记的形状（`(struct rN …)`）第二趟还要按同一个标签用 ——
   * 第二趟里被调的那个函数可能排在调用者**前面**（cpp 的析构器就是），那时它的形参类型
   * 已经从 `ctx.args` 上拿到了，可那格形状要等调用者落到才登记。回滚过一版，症状正是
   * "在一格说不清形状的东西上取字段"。代价是第一趟可能多登记一格用不上的 struct —— 
   * 那是一句声明，不影响答案。 */
  ctx.collect = true;
  /* 走两遍：第一遍里被调者的形参还按 int，于是**调用者自己的形参**也只能按 int 记；
   * 第二遍那几格已经有具体类型了，往下传一层就对了（`go+method` 的 `scaled` -> `total`
   * 正是这种两层）。两遍够不够：够不够都不出错 —— 记不上的那一格照旧按 int，然后报缺口。 */
  for (let round = 0; round < 2; round++) {
    for (const f of fns) {
      try {
        emitFn(f, fnEnv, env, ctx);
      } catch (err) {
        if (!(err instanceof Gap)) throw err;
      }
    }
  }
  ctx.collect = false;
  const body = fns.map((f) => emitFn(f, fnEnv, env, ctx));
  /* **落完再核一遍**：函数体里的调用点也会往 `ctx.args` 上记类型，而那时被调的那个函数
   * 可能已经落过了（形参按当时知道的类型发的）。对不上就报缺口 —— 交出去等着方言报
   * "实参类型不对"是最坏的一种（那是一格硬错，不是有名有姓的缺口）。 */
  for (const f of fns) {
    for (let i = 0; i < f.params.length; i++) {
      const want = ctx.args.get(`${f.name}#${i}`);
      const had = ctx.args.get(`emitted:${f.name}#${i}`);
      if (want !== undefined && had !== undefined && want !== had) {
        gap(`'${f.name}' 第 ${i + 1} 格形参落成了 ${had}，可后面有一处调用给的是 ${want}`
          + '（那处调用在另一个函数体里 —— 形参的类型这一刀只从 main 里的调用点收）');
      }
    }
  }
  body.push(`  (main ${mainStmts.join(' ')}))`);
  /* `(struct …)` 要印在**用到它的东西前头**，而形状是落语句的时候才登记上的 ——
     所以这几句最后拼（次序：模块头、struct 那几句、函数、main）。 */
  return `${['(module', ...ctx.decls, ...body].join('\n')}\n`;
}

/** 一格 `(fn …)` 的文本。走两趟（见 `emitCore` 里那段），所以单独拎出来。 */
function emitFn(f, fnEnv, env, ctx) {
  const fenv = new Map(fnEnv);
  const pts = f.params.map((p, i) => ctx.args.get(`${f.name}#${i}`) ?? 'int');
  for (let i = 0; i < f.params.length; i++) fenv.set(f.params[i], pts[i]);
  const ps = f.params.map((p, i) => `(${p} ${pts[i]})`).join(' ');
  const ret = env.get(`fn:${f.name}`) ?? 'int';
  /* 隐式返回那一档：末尾那个值改写成 `(ret …)`（分支就把 ret 沉到两支里去 ——
     方言的 `if` 是语句，这样就不必有块表达式）。 */
  const arr = Array.isArray(f.body) ? f.body : (f.body === undefined || f.body === null ? [] : [f.body]);
  /* 隐式返回那一档：**在图上**把末尾那个值换成一格 `ret`，再照常落。
   * 为什么不在文本上特判：换成图之后 defer、物化、`(do …)` 那几趟全都照常生效 ——
   * 在文本上特判过一版（那时叫 `retify`）走不进 `stmtList`，region 里的出口动作就漏了。 */
  const fbody = f.impl === null || f.impl === undefined
    ? stmtList(f.body, fenv, ctx)
    : stmtList([...arr.slice(0, -1), retWrap(arr[arr.length - 1])], fenv, ctx);
  /* **掉到函数尾**这件事不许糊：方言要求非 void 的函数每条路都有 `ret`，而图上"体末尾那个
   * 值就是返回值"（chez / sbcl 那两门）是合法的。补一格 `(ret 0)` 交上去 = 悄悄给错答案
   * —— 矩阵上量到过两次（chez+intmath 印 0/0、sbcl+blockret 末行印 0）。
   * 所以这儿只认"末尾就是 ret"那一种，别的当场报缺口。 */
  if (!endsWithRet(f.body) && ret !== 'void' && (f.impl === null || f.impl === undefined)) {
    gap(`函数 '${f.name}' 的体末尾不是 ret（隐式返回那一档 —— 补零值会给错答案）`);
  }
  for (let i = 0; i < f.params.length; i++) ctx.args.set(`emitted:${f.name}#${i}`, pts[i]);
  return `  (fn ${f.name} (${ps}) ${ret} ${fbody.join(' ')})`;
}

/**
 * **隐式返回**：体里一格 `ret` 都没有，而末尾那一格是**一个值**（chez / sbcl 的函数体
 * 末尾那个表达式就是返回值）。是就把它交回来，不是就回 null（那时这个函数是 void ——
 * go / V 的 `main` 就是那种）。
 *
 * 判据是 `nodes.js` 上的 sort 那一栏（expr 才算值），外加一格例外：`print` 在图上是
 * 一格 prim（expr），可它在源语言里是一句话 —— 拿它当返回值就错了。
 */
function implicitRet(body) {
  const last = Array.isArray(body) ? body[body.length - 1] : body;
  return isValueish(last) ? last : null;
}

/**
 * 这一格**能不能当一个值**。sort 那一栏是 expr 只是第一问，还有两格例外：
 *   * `print` 在图上是一格 prim（expr），可它在源语言里是一句话；
 *   * `branch` 是 expr，可**两支里躺的可能是语句**（cpp 的析构器就是：`(if c (region …) (region …))`
 *     —— 那是一个 void 函数，不是"末尾那个值"）。所以分支要两支都递归问一遍。
 */
function isValueish(x) {
  if (!isNode(x)) return false;
  /* **一格 region 的值就是它末尾那一格的值**（sbcl 的 `(defun sumto (n) (let …) acc)`
   * 落出来是 region -> region -> … -> `(ref acc)`）。所以往里问一层。 */
  if (x.op === 'region') {
    const arr = asArr(x.ins.body);
    return arr.length > 0 && isValueish(arr[arr.length - 1]);
  }
  if (declOf(x.op).sort !== 'expr') return false;
  if (x.op === 'prim' && x.attrs.name === 'print') return false;
  if (x.op === 'branch') {
    return isValueish(x.ins.then) && x.ins.else !== undefined && x.ins.else !== null
      && isValueish(x.ins.else);
  }
  return true;
}

/**
 * 把"末尾那个值"改写成一格 `ret` 节点（**图上**的改写，不是文本上的）。
 *
 * 末尾是一格 `region` 时往里走一层：region 的值就是它末尾那一格的值，所以换的是**里面**
 * 那一格 —— 这样 region 自己那层的出口动作、块作用域、物化都照常走 `stmtList` 那一趟。
 */
function retWrap(x) {
  if (isNode(x) && x.op === 'region') {
    const arr = asArr(x.ins.body);
    const body = [...arr.slice(0, -1), retWrap(arr[arr.length - 1])];
    return { ...x, ins: { ...x.ins, body: body } };
  }
  return { op: 'ret', ins: { value: x }, attrs: {}, id: -1 };
}

/** 一格 `body` 端口收成数组（一格与一串两种写法都有）。 */
function asArr(x) {
  if (Array.isArray(x)) return x;
  return x === undefined || x === null ? [] : [x];
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
function retTypeOf(body, env, ctx) {
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
      /* 多值：交回去的是那格合成结构体（登记在这儿 —— 调用点要靠它定型）。 */
      if (isNode(v) && v.op === 'values') return multiShape(argList(v, 'args'), env, ctx).tag;
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
 * `can` 那一问：这格节点接不接得住（接不住给一句人话 —— 那句话就是账）。
 *
 * **27 格全接上了**（第一百五十三片之后）：节点级缺口 0。剩下的账都是**形状上的**
 * （同一格节点的某种用法接不住）—— 那几条在 `CORE_SHAPES` 里，各带一份证物。
 * 原先这儿挂着一张 `WHY` 表（逐格说"欠在方言里还是欠在这份翻译上"），现在一格不欠，
 * 留着就是过期的账 —— 所以删了，不留。
 */
export function coreCan(op) {
  if (OPS.has(op)) return true;
  if (declOf(op) === undefined) return `core 后端不认识这格节点：${op}`;
  return `core 这条腿还没接：${op}（27 格里没有它 —— 这一格是新加的节点，`
    + '要么补进 backend-core.js，要么在这儿说清为什么不接）';
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
    what: '循环的条件里有一格要物化的表达式',
    why: '表达式位置上的 branch 落成"一格临时量 + 两支各赋值"，那两句得摆在这条语句前面 ——'
      + '而循环的条件**每轮都要算**，提到循环外面就是一处静默的错答案，所以宁可报',
    witness: () => program([node('loop', {
      cond: node('branch', { cond: litNode(true), then: litNode(true), else: litNode(false) }),
      body: [node('prim', { args: [litNode(1)] }, { name: 'print' })],
    })]),
  },
  {
    what: '不是 bool 的条件',
    why: 'cpp 的 `while (1)` / awk 的 `while (n)` 那种。方言的条件必须是 bool，而**几算真**'
      + '是语言那一侧的事（C 家族里 0 假、lua 里 0 真）—— 这份翻译看不见自己在给哪门语言'
      + '干活，替它补 `!= 0` 就是一处静默的错答案，所以宁可报',
    witness: () => program([node('loop', {
      cond: litNode(1),
      body: [node('prim', { args: [litNode(1)] }, { name: 'print' })],
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
    what: '记录 / 列表 / 字典整格当值用',
    why: '这一刀的函数形参与返回都是 int，聚合一跑出去（当实参、被 print、被 return）'
      + '就说不清类型了 —— 只接字段 / 下标 / 键那三条路（`objText` 一处把门）',
    witness: () => program([
      node('bind', { init: node('record-new', { fields: [litNode(1)] }, { names: ['x'] }) }, { name: 'p' }),
      node('prim', { args: [node('ref', {}, { name: 'p' })] }, { name: 'print' }),
    ]),
  },
  {
    what: '表达式位置上的多值里有带副作用的实参',
    why: '那一处的物化是"一次使用一份"，实参有副作用时同一格 values 被用两回就会算两遍 ——'
      + '静默的错答案。要接得先给物化过的那几格记一张备忘（按节点 id），那是另一刀',
    witness: () => program([
      node('bind', {
        init: node('func', { body: [node('ret', { value: litNode(1) })] }, { params: [] }),
      }, { name: 'f' }),
      node('prim', {
        args: [node('values', {
          args: [node('call', { fn: node('ref', {}, { name: 'f' }), args: [] }), litNode(2)],
        })],
      }, { name: 'print' }),
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



