// src/core/graph/backend-core.js —— **图 -> 我们自己那门核心方言（sx）-> OIR**（第一百五十二片）
//
// ## 这一格与别的后端不同在哪
//
// wat / c / js 那三条腿都是"图直接落成那门语言的文本"。这一条落的是**我们自己的中间语言**
// （`sexpr/lower.js` 那份核心方言），于是往下**整条既有的路白得**：OIR -> js / c / wasm /
// llvm 四条腿、摇树、profile、REPL、错误模型。ADR-0037 §5.1 那两条路里的 **B 路**就是它 ——
// 「不新开一条路，就不会有两条路走散」（ADR-0034 那句话的同一条理由）。
//
// ## 这一刀接哪几档：**28 格全接**（节点级缺口 0）
//
// 图上**没有类型**（`nodes.js` 文件头第一条：type 不是节点），而核心方言是**有类型的**。
// 这中间那一格差是这条腿的全部难处 —— 那套推断现在**住在 `types.js`**（类型覆盖层，#40），
// 这条腿是它第一个用户；下面这张表说的是**推出来的东西怎么落成方言**：
//
//   标量    字面量按值推（整 `int`、带小数点 `real`、串 `string`、真假 `bool`）
//   记录    按"字段名单 + 字段类型"登记成一格 `(struct rN …)`，同形的共用一格
//   列表    按第一格元素推成 `(arr T)`；切片走消去规则（新建 + 一圈 apush）
//   字典    按键值推成 `(dict K V)`；空字典从**同层第一处 map-set** 上取（lua / awk 那一档）
//   多值    落成一格合成结构体 `(struct mN (v0 …) (v1 …))` —— 方言的函数只交一格回来，
//           而结构体是值语义的，那正好就是 `return a, b` 的语义
//   形参    从**调用点**收（图上没有类型）：函数体走两趟，第一趟只收实参类型，第二趟出文本
//   内层函数 **提到顶层**（lambda 提升，`liftBody`）：借来的那几格变成多出来的形参，
//           每处调用补上实参。只当被调者用时提升与闭包同义 —— 跑出调用点那一格另有账
//   模块级   函数体里的自由名字落成 `(global 名 类型)` + main 里一句 `(set …)`（`bindLine`）
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
/* **类型是覆盖层的事**（#40 第一步）：这一份原来自己写了一套 `typeOf`/`elemType`/…，
   现在整套住在 `types.js` 里 —— 这条腿只是**第一个用户**。搬那一步的验收标准是
   "产出逐字节相同"，所以那一份里一行新逻辑都没有（连"查不到当 int"都照旧）。
   这儿仍旧留着的两样是**后端自己的事**：`shapeOf`（要往产物头上印 `(struct rN …)`）
   与 `gap`（措辞里带着"哪条腿"）—— 它们经 `ctx` 交给覆盖层。 */
import {
  isNode, isLit, argList, litType, primFixedType, elemType, dictOf, isScalar,
  convTo, typeOf, multiShape, fieldType, litLeaningType, retTypeOf,
  shapeType, shapeAt, isRecType,
} from './types.js';
/* 证物那五份是**手搭的小图** —— 所以要 `node()` / `lit()` / `program()`（`node` 顺带查五栏）。 */
import { node, lit as litNode, program } from './graph.js';
/* **lambda 提升那一份两条腿共用**（`src/core/graph/lift.js`）—— c 那条腿也要它。
   `gap` 传进去：措辞里带着"哪条腿"，而算法一份。 */
import { liftBody as liftOne, capsOf, mapNodes } from './lift.js';
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
  'conv',
  /* **列表追加**（第三十批的 `prim push`）不在这张表里 —— 那是**内建**不是节点，
     账记在 `PRIMS_OK` 上（方言里现成的一句 `(apush 数组 值)`）。 */
  /* **断言**（第二十九批）：方言里**有**"停下来"那一句话 —— `(fail 串)`
     （六条腿都是"印 omni: runtime error: 消息、退 70"，`sexpr/lower.js:1474`）。
     那一刀落地时我写的是"方言里没有 panic / abort / exit" —— **那句话是错的**：
     只 grep 了那三个词，漏了 `fail`。所以这一格不是欠账，是**照口径拼出来**：
       (if (un "!" 条件) (do (print "assert failed…") (fail "assert failed")))
     `print` 那一句让**可观察的那一行**与别的腿逐字节相同（图上只有这一个输出通道），
     `fail` 那一句给"停下来"。 */
  'assert',
]);

/** 这一刀接得住的内建（`prims.js` 里 16 格中的 15 格；只有多实参 print 还欠着）。 */
const PRIMS_OK = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '=', '!=',
  'not', 'len', 'print', 'concat', 'push', 'contains',
  /* 位运算那六格（`bnot` 拼成 `bxor -1` —— 方言的 `bin` 是二元的）。 */
  'band', 'bor', 'bxor', 'bnot', 'shl', 'shr']);

/** 方言里那几个算符的名字与图上的**一一对应**（`=` / `!=` 是两边唯一不同的两格）。 */
const BINOP = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%', '^': '^',
  '<': '<', '>': '>', '<=': '<=', '>=': '>=', '=': '==', '!=': '!=',
  /* 位运算那五格：**方言里早就有**（`(bin "&" …)` / `(bin "<<" …)`，按 64 位整数算）——
     图上那六个名字用词是因为 `^` 在图上是幂，方言那侧没有这个撞名，所以直接映回符号。 */
  band: '&', bor: '|', bxor: '^', shl: '<<', shr: '>>',
};

/** 一格串字面量在方言里的写法（转义按 s-expr 的读法：只有这两个要转）。 */
const strLit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

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
 * 一格绑定落成什么。
 *
 * **函数体也看得见的那几格落成模块级变量**：方言里那是 `(global 名 类型)` + 一句 `(set …)`
 * （`tests/sexpr/cases/12-globals.sx` 钉着这一格）。为什么要有这一档：chez 的
 * `(define xs (vector 10 20 30))` 是**模块级**的，而它下面那个 `sum` 函数要用它 ——
 * 方言的函数看不见 main 的局部，看得见 global。哪几格要落成 global 由 `freeInFns` 算
 * （函数体里的自由名字），别的照旧是 `(let …)`。
 */
function bindLine(nm, t, initText, env, ctx) {
  env.set(nm, t);
  if (!ctx.globals.has(nm)) return `(let ${nm} ${t} ${initText})`;
  ctx.decls.push(`  (global ${nm} ${t})`);
  ctx.fnEnv.set(nm, t);
  return `(set ${nm} ${initText})`;
}

/**
 * 函数体里的**自由名字**：既不是形参、也不是体里绑出来的、也不是一格函数名。
 * 那几格只可能是模块级变量（chez 的 `xs`）—— 或者是真闭包（那一格另有账）。
 */
function freeInFns(fns, env) {
  const out = new Set();
  for (const f of fns) {
    const bound = new Set(f.params);
    walkCore(f.body, (n) => {
      if (n.op === 'bind') bound.add(n.attrs.name);
      if (n.op === 'func') for (const p of n.attrs.params ?? []) bound.add(String(p));
    });
    walkCore(f.body, (n) => {
      /* 写也算（同 `capsOf` 那条）：只 `set` 不读的那一格也得落成 `(global …)`。 */
      const nm = n.op === 'set' ? n.attrs.name : (n.op === 'ref' ? n.attrs.name : null);
      if (nm === null) return;
      if (!bound.has(nm) && !env.has(`fn:${nm}`)) out.add(nm);
    });
  }
  return out;
}

/** 一棵子图上每一格节点走一遍（只读）。 */
function walkCore(x, f) {
  if (Array.isArray(x)) {
    for (const y of x) walkCore(y, f);
    return;
  }
  if (!isNode(x) || x.op === undefined) return;
  f(x);
  for (const k of Object.values(x.ins ?? {})) walkCore(k, f);
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
      /* **一格函数名当值用** —— 方言里那是 `(fnref 名)`（`tests/sexpr/cases/15-fnvalues.sx`）。
         `t === undefined` 那一条是关键：同名的局部变量优先（函数名只在没被遮住时才是函数）。 */
      if (t === undefined && env.get(`fn:${x.attrs.name}`) !== undefined) {
        return `(fnref ${x.attrs.name})`;
      }
      if (isRecType(t, ctx)) gap(`把记录 '${x.attrs.name}' 整格当值用（这一刀只接字段读写）`);
      if (elemType(t) !== null) gap(`把列表 '${x.attrs.name}' 整格当值用（这一刀只接下标读写与 len）`);
      if (dictOf(t) !== null) gap(`把字典 '${x.attrs.name}' 整格当值用（这一刀只接按键读写与 len）`);
      return `(var ${x.attrs.name})`;
    }
    case 'prim': {
      const nm = x.attrs.name;
      if (!PRIMS_OK.has(nm)) gap(`内建 ${nm}`);
      const args = argList(x, 'args');
      /* 方言里的逻辑非是 **`(un "!" …)`**，不是 `(not …)`（`sexpr/lower.js:2894`）——
         原来这儿发的那个词方言不认，而例子里正好没有 `not`，所以从没露出来。
         `tests/graph/deadcase.js` 把 lua / awk 那两格一元算子接上之后才撞出来。
         方言的 `!` 要求实参是 bool；推不出 bool 就报缺口，不硬发一句编不过的话。 */
      if (nm === 'not') {
        const at = typeOf(args[0], env, ctx);
        if (at !== null && at !== 'bool') gap(`\`not\` 的实参推成了 ${at}（方言的 ! 要 bool）`);
        return `(un "!" ${expr(args[0], env, ctx)})`;
      }
      if (nm === 'len') return lenText(args[0], env, ctx);
      if (nm === 'print') gap('print 出现在表达式位置上');
      if (nm === 'push') gap('push 出现在表达式位置上（方言里 apush 是一条语句）');
      if (nm === 'concat') return concatText(args, env, ctx);
      /* **contains（线性找元素）**：方言里没有 `ahas`，所以发一格**内联的辅助函数**
         到模块头上（`g_contains_T`，T 是元素类型），每种元素类型发一份。
         调用点落成 `(call g_contains_T arr val)` —— 一格普通的函数调用。 */
      if (nm === 'contains') {
        if (args.length !== 2) gap(`contains 收了 ${args.length} 格实参（要两格）`);
        const at = typeOf(args[0], env, ctx);
        const et = elemType(at);
        if (et === null) gap('contains 的第一格实参不是列表');
        const fname = `g_contains_${et}`;
        if (!ctx.containsFns) ctx.containsFns = new Set();
        if (!ctx.containsFns.has(et)) {
          ctx.containsFns.add(et);
          /* 一格 `(fn g_contains_T ((a (arr T)) (v T)) bool
                (do (let i int (int 0))
                    (while (bin "<" (var i) (alen (var a)))
                      (do (if (bin "==" (aget (var a) (var i)) (var v)) (ret (bool true)))
                          (set i (bin "+" (var i) (int 1)))))
                    (ret (bool false))))` */
          /* **`if` 的体必须是一格块**（`(do …)`）：方言那一侧 `scope(b)` 读的是 `b.stmts` ——
             直接给一句 `(ret …)` 会在**走进那一支的时候**炸（`b.stmts is not iterable`）。
             这一处头一版就是那么写的，而第一次试的时候数组里恰好没有要找的元素、
             那一支没走进去，所以"跑过了" —— **测试过了不等于对**。 */
          ctx.decls.push(`  (fn ${fname} ((a ${at}) (v ${et})) bool`
            + ' (do (let i int (int 0))'
            + ' (while (bin "<" (var i) (alen (var a)))'
            + ' (do (if (bin "==" (aget (var a) (var i)) (var v)) (do (ret (bool true))))'
            + ' (set i (bin "+" (var i) (int 1)))))'
            + ' (ret (bool false))))');
        }
        return `(call ${fname} ${objText(args[0], env, ctx)} ${expr(args[1], env, ctx)})`;
      }
      /* **bnot 是一元的**：方言里没有一元的 `~`，用 `(bin "^" x (int -1))` 拼
         （二补数的按位取反 = 与 -1 做 xor）。 */
      if (nm === 'bnot' && args.length === 1) {
        return `(bin "^" ${expr(args[0], env, ctx)} (int -1))`;
      }
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
    case 'field-get': return fldText(x.ins.obj, x.attrs.field, env, ctx);
    case 'index-get': {
      const t = typeOf(x.ins.obj, env, ctx);
      if (elemType(t) === null) gap('在一格说不清形状的东西上取下标（这一刀只接 list-new 绑出来的那格）');
      return `(aget ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.index, env, ctx)})`;
    }
    case 'record-new': gap('记录出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
    case 'list-new': gap('列表出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
    case 'pick': {
      const t = typeOf(x.ins.from, env, ctx);
      const shape = shapeAt(t, ctx);
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
      const to = convTo(x, ctx);
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
      /* **`c and X or Y`** 先折成一格普通的三目（见 `luaTernary`）—— 折得动就照折出来的走。 */
      {
        const folded = luaTernary(x, env, ctx);
        if (folded !== null) return expr(folded, env, ctx);
      }
      const els = x.ins.else;
      if (els === undefined || els === null) gap('表达式位置上的 branch 少了 else 那一支');
      const t = typeOf(x.ins.then, env, ctx);
      const t2 = typeOf(els, env, ctx);
      if (t !== t2) gap(`表达式位置上的 branch 两支不同型（${t} 与 ${t2}）`);
      /* 标量或**一格形状**（sbcl 的 `(if c (values …) (values …))` 就是后者）都接得住 */
      if (!isScalar(t) && shapeAt(t, ctx) === undefined) gap(`表达式位置上的 branch 交出来的不是标量（${t}）`);
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
      ctx.pre.push(`(let ${nm} ${t} ${newOfType(t, ctx)})`);
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
 *
 * **lua 的 `and`/`or` 是一处例外**（`keepValue: true`）：交出来的不是真假，是值。
 * 覆盖层对 branch 的答案是 `then` 支的类型（值类型），可当条件用的时候"决定真假"的是
 * cond 链最里层那一格。所以**一层 branch 的条件那一侧还是一格 branch 时，递归看它的
 * cond**——直到不是 branch 为止。这不是猜：lua 的 `(a > b) and a or b` 在图上就是
 * `branch(cond: branch(cond: (> a b), …), …)`，决定真假的正是 `(> a b)` 那格 bool。
 */
function condText(c, env, ctx) {
  const t = typeOf(c, env, ctx);
  if (t !== 'bool') {
    gap(`条件不是 bool（量到的是 ${t}）—— 方言的条件必须是 bool，而"几算真"是语言`
      + '那一侧的事（该由那门语言的映射补成一格比较，不该由这份翻译替它猜）');
  }
  return expr(c, env, ctx);
}

/**
 * **`c and X or Y`（lua 的三目写法）折成一格普通的三目。**
 *
 * 图上那两格长这样（`fromtree.js` 的 `lazyAnd` / `lazyOr`，`keepValue: true` ——
 * lua 的 and / or 交出来的是**值**不是真假，`ext/lua/SPEC.md` L-007）：
 *
 *     OR  = branch{cond: N, then: N,  else: Y}     // cond 与 then 是**同一格节点**
 *     N   = branch{cond: C, then: X,  else: C}     // cond 与 else 是**同一格节点**
 *
 * 两格合起来的值按定义是：`C` 真且 `X` 真 ⇒ `X`；否则 `Y`。
 * `X` 是一格**纯的、非 bool 的标量**时"`X` 真"**恒成立** —— 那是图自己的真值观
 * （`eval.js` 的 `valTruthy`：只有 `false` / `nil` 为假，所以任何数、任何串都真）。
 * 于是整格就是 `branch{cond: C, then: X, else: Y}` —— **推出来的，不是猜**。
 *
 * 不折的话 core 走不下去：`N` 站在值的位置上时两支是 int（`X`）与 bool（`C`），
 * 方言当场骂"'if_tmp8' 是 int，赋的值是 bool"。而那一支**在那个位置上根本到不了**
 * （OR 的 cond 已经把"N 为真"筛过了）—— 这一刀就是把那件事写在结构上。
 *
 * 认不出这个形状就回 null（照旧走原来的路）。
 */
function luaTernary(x, env, ctx) {
  const N = x.ins.cond;
  const Y = x.ins.else;
  if (!isNode(N) || N.op !== 'branch' || N !== x.ins.then) return null;
  if (Y === undefined || Y === null) return null;
  const C = N.ins.cond;
  const X = N.ins.then;
  if (C === undefined || C === null || N.ins.else !== C) return null;
  /* `C` 得是一格真假（不然条件那一格照旧说不清 —— 交给 `condText` 报）。 */
  if (typeOf(C, env, ctx) !== 'bool') return null;
  /* `X` 恒真的那一条：纯 + 非 bool 的标量。`X` 是 bool 时 `false and X or Y` 的答案
     是 `Y` 而不是 `X`，折了就错 —— 所以那一档不接。 */
  const tx = typeOf(X, env, ctx);
  if (tx === 'bool' || !isScalar(tx) || !isPure(X)) return null;
  return node('branch', { cond: C, then: X, else: Y });
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
 * 字段 / 下标那一格**宿主**的文本。认一个名字（`(var p)`），也认**里头那格记录**
 * （`q.a.y` -> `(fld (fld (var q) a) y)`）—— 后者要里层自己说得清形状。
 * 别的（`xs[0].f`、`f().f`）这一刀不接。
 */
function objText(obj, env, ctx) {
  /* 嵌套的宿主：里层是一格 `field-get` 且它交出来的就是一格形状。为什么读这一路是准的：
     记录在方言里是**指针**（`types.js` 的 `shapeType`），所以往里套的是 `pfield` ——
     `(pload (pfield (pload (pfield (var q) a)) y))`：一层层就地读，不复制。 */
  if (isNode(obj) && obj.op === 'field-get') {
    const inner = typeOf(obj, env, ctx);
    if (shapeAt(inner, ctx) !== undefined || elemType(inner) !== null || dictOf(inner) !== null) {
      return fldText(obj.ins.obj, obj.attrs.field, env, ctx);
    }
  }
  if (!isNode(obj) || obj.op !== 'ref') gap('字段 / 下标的宿主不是一个名字（嵌套那一档还没接）');
  const t = env.get(obj.attrs.name);
  if (shapeAt(t, ctx) === undefined && elemType(t) === null && dictOf(t) === null) {
    gap(`'${obj.attrs.name}' 说不清形状（这一刀只认 \`bind\` 一格记录 / 列表 / 字典绑出来的名字）`);
  }
  return `(var ${obj.attrs.name})`;
}


/** `(call 名 实参…)` 的文本（"当值用"那道检查在 `expr` 里，语句位置上不查）。 */
function callText(x, env, ctx) {
  const f = x.ins.fn;
  if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
  /* **被调的是一格函数值**（形参 / 局部，类型是 `(fnty …)`）—— 方言里那是 `(callfn …)`。
     实参的类型不往 `ctx.args` 上记：那张表是按**函数名**记的，而这儿被调的是一格值。 */
  const vt = env.get(f.attrs.name);
  if (typeof vt === 'string' && vt.startsWith('(fnty ')) {
    const vargs = argList(x, 'args').map((a) => expr(a, env, ctx));
    return `(callfn (var ${f.attrs.name})${vargs.length === 0 ? '' : ` ${vargs.join(' ')}`})`;
  }
  const args = argList(x, 'args').map((a, i) => argText(f.attrs.name, i, a, env, ctx));
  return `(call ${f.attrs.name}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
}

/**
 * 一格实参。两件事：
 *   一、**把类型记进 `ctx.args`** —— 形参就是靠这一格定型的（图上没有类型，只有调用点知道）；
 *   二、聚合在实参位置上**是允许的**，而且三样都是**引用**（记录是 `(ptr rN)`、数组与字典
 *       是句柄）—— 与图上一样，所以这儿绕过 `expr` 那道"整格当值用"的门，自己拼名字。
 *       `bump(p)` 里头改了外头看得见，靠的就是这一条。
 */
function argText(fname, i, a, env, ctx) {
  /* **一格聚合字面量当实参**：记录（V 的"命名实参"就是那格参数结构体的字面量 ——
     `total(x: 2, y: 3)` 等于 `total(Point{x: 2, y: 3})`）、列表（go 的 `firstOf([]int{9,1})`）、
     字典。这三格在表达式位置上落不下去，所以先物化成一格临时名再递 `(var …)` 进去 ——
     三样递进去的都是**同一格**（记录是指针、数组与字典是句柄）—— 与图上一样。
     摆不下物化那几句（没有 `ctx.pre`）就报，不硬拼。 */
  /* **一格函数名当实参**（go 的 `apply(inc, 4)`、提上来的匿名 func 也走这儿）：
     类型是 `(fnty …)`、文本是 `(fnref 名)`。 */
  {
    const ft = fnTypeOf(a, env, ctx);
    if (ft !== null) {
      const fkey = `${fname}#${i}`;
      const fhad = ctx.args.get(fkey);
      if (ctx.collect !== true && fhad !== undefined && fhad !== ft) {
        gap(`'${fname}' 第 ${i + 1} 格实参在两处的类型不一样（${fhad} 与 ${ft}）—— 方言的形参是单态的`);
      }
      if (ctx.collect !== true || fhad === undefined || fhad === 'int') ctx.args.set(fkey, ft);
      return `(fnref ${a.attrs.name})`;
    }
  }
  const mk = isNode(a) ? MATERIALIZE[a.op] : undefined;
  if (mk !== undefined) {
    if (ctx.pre === null || ctx.pre === undefined) {
      gap(`一格${a.op === 'record-new' ? '记录' : (a.op === 'list-new' ? '列表' : '字典')}当实参，`
        + '可这一处摆不下物化那几句');
    }
    ctx.tmp = ctx.tmp + 1;
    const tn = `arg_tmp${ctx.tmp}`;
    for (const line of mk(tn, a, env, ctx)) ctx.pre.push(line);
    const at = env.get(tn);
    const akey = `${fname}#${i}`;
    const ahad = ctx.args.get(akey);
    if (ctx.collect !== true && ahad !== undefined && ahad !== at) {
      gap(`'${fname}' 第 ${i + 1} 格实参在两处的类型不一样（${ahad} 与 ${at}）—— 方言的形参是单态的`);
    }
    if (ctx.collect !== true || ahad === undefined || ahad === 'int') ctx.args.set(akey, at);
    return `(var ${tn})`;
  }
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

/**
 * 一格**函数名**当值用时的类型：`(fnty (形参类型…) 返回类型)`。
 * 不是函数名（或者被同名的局部遮住了）回 null。
 */
function fnTypeOf(a, env, ctx) {
  if (!isNode(a) || a.op !== 'ref') return null;
  const nm = a.attrs.name;
  if (env.get(nm) !== undefined) return null;
  const rt = env.get(`fn:${nm}`);
  if (rt === undefined) return null;
  const f = (ctx.fnParams ?? new Map()).get(nm);
  if (f === undefined) return null;
  const pts = f.map((_, i) => ctx.args.get(`${nm}#${i}`) ?? 'int');
  return `(fnty (${pts.join(' ')}) ${rt === 'void' ? 'void' : rt})`;
}

/** 这一格类型是不是聚合（记录 / 列表 / 字典 / 多值）。 */
const isAggregate = (t, ctx) => isRecType(t, ctx) || elemType(t) !== null || dictOf(t) !== null;

/**
 * 取一格字段的文本。**记录是指针**（`types.js` 的 `shapeType`），所以那一档走
 * `(pload (pfield …))`；多值（`mN`）是真结构体，照旧 `(fld …)`。
 */
function fldText(obj, field, env, ctx) {
  const host = objText(obj, env, ctx);
  if (isRecType(typeOf(obj, env, ctx), ctx)) return `(pload (pfield ${host} ${field}))`;
  return `(fld ${host} ${field})`;
}

/** 一格形状 / 标量的"新建"文本：记录 `pnew` 一格、多值 `new`、标量给零值。 */
function newOfType(t, ctx) {
  const sh = shapeAt(t, ctx);
  if (sh === undefined) return zeroText(t);
  if (sh.multi === true) return `(new ${sh.tag})`;
  return `(pnew (ptr ${sh.tag}) (int 1))`;
}

/**
 * 哪几格节点能**物化**成一格临时名（绑定那一侧现成的三个落法）。
 * 实参位置上要它：那三格在表达式位置上落不下去，可当实参是对的。
 */
const MATERIALIZE = {
  'record-new': (nm, x, env, ctx) => bindRecord(nm, x, env, ctx),
  'list-new': (nm, x, env, ctx) => bindList(nm, x, env, ctx),
  'map-new': (nm, x, env, ctx) => bindMap(nm, x, env, ctx),
};

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
  /* **null 落 `(int 0)` 而不是报缺口**：V 那一门把 Option 的空值（`none`）落成 null，
     而 `if v == nil { … }` / `f() or { … }` 那一族拿它当"没有值"在比较 ——
     那些比较在方言里就是 `(bin "==" (var v) (int 0))`（nil = 数值的零，见 `initFor`）。
     core 跑起来之后 `v` 会被赋成一个有类型的值（函数的返回值），那一格比较正好就是
     `v == 0`——对 int 类型来说"空值"就是零值，与 V 自己的语义一致。
     原来这儿当场报（3 份 skip），而那 3 份的 null 全在"Option 那条路上的比较" —— 报了就
     整条路走不通。报的理由是"方言是有类型的、null 说不清类型"——但方言里 null 的用法
     就是零值，而零值在每个类型上有明确的写法。所以 null -> `(int 0)` 是**对的**，不是猜。
     如果以后碰到真的需要 null 当不同类型的零值用的情况，那是类型覆盖层的活儿。 */
  if (t === null) return '(int 0)';
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
      /* `xs := fill(n, 零值)`（第 25 格内建）—— 与 `slice` 那一格**同一条消去规则**：
         方言里没有"按长度造"，所以落成"新建一格空数组 + 一圈 apush"。
         只接**绑定位置**（`bind`）：表达式位置上摆不进一圈循环，那时照旧报缺口。 */
      if (isNode(init) && init.op === 'prim' && init.attrs.name === 'fill') {
        return bindFill(nm, init, env, ctx);
      }
      if (isNode(init) && init.op === 'map-new') return bindMap(nm, init, env, ctx);
      /* **awk 的"没赋过值的变量"**：映射把它落成 `bind n = null`（`ext/awk/tograph.js`
       * 的 bodyOf）。方言是有类型的，所以这一格照**第一次赋值**定型，值给那个类型的零值 ——
       * 与 awk 的语义对得上（那门语言里没赋过值的变量当数是 0、当串是 ""，正好都是零值）。 */
      if (isLitNull(init)) {
        const t0 = nullHint(nm, ctx, env);
        return [bindLine(nm, t0, zeroText(t0), env, ctx)];
      }
      const t = typeOf(init, env, ctx);
      /* **把一格聚合绑到另一个名字上**（`q := p`、`__in := xs`）—— 图上那三样都是**引用**
       * （两个名字指同一格），方言里也都是：数组与字典是句柄，**记录是 `(ptr rN)`**
       * （`types.js` 的 `shapeType`：结构体值语义顶不了引用，指针才对得上）。
       * 于是这一格直接拼名字（`(let q (ptr r1) (var p))`），不走 `expr` 那道"整格当值用"的门。 */
      if (isNode(init) && init.op === 'ref' && isAggregate(t, ctx)) {
        return [bindLine(nm, t, `(var ${init.attrs.name})`, env, ctx)];
      }
      const initText = expr(init, env, ctx);
      return [bindLine(nm, t, initText, env, ctx)];
    }
    case 'set': return [`(set ${x.attrs.name} ${expr(x.ins.value, env, ctx)})`];
    case 'field-set': {
      const host = objText(x.ins.obj, env, ctx);
      const v = expr(x.ins.value, env, ctx);
      /* 记录是指针（见 `fldText`）—— 写一格字段是 `(pstore (pfield …) …)`。 */
      if (isRecType(typeOf(x.ins.obj, env, ctx), ctx)) {
        return [`(pstore (pfield ${host} ${x.attrs.field}) ${v})`];
      }
      return [`(fldset ${host} ${x.attrs.field} ${v})`];
    }
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
      /* **这个函数是 void**（返回值在整张图上一处都没当值用过 —— 见 `emitCore` 里
         `valueCalled` 那一段）：早退那一格 `ret x` 落成光秃秃的 `(ret)`，值丢掉。
         "值是纯的"那一条在 `emitCore` 里已经检过，这儿只管落。 */
      if (ctx.voidFn === true) return [...pend, '(ret)'];
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
    /**
     * **断言**：方言里没有 assert 这一格，但有"停下来"（`(fail 串)`）—— 所以照口径拼：
     *   条件不成立 -> 先 `print` 那一行（**可观察的那一行要与别的腿逐字节相同**），
     *   再 `fail` 停下来。条件那一格走 `condText`（不是 bool 就报，不擅自补 `!= 0`）。
     */
    case 'assert': {
      const cond = condText(x.ins.cond, env, ctx);
      const line = x.ins.msg === undefined || x.ins.msg === null
        ? '(str "assert failed")'
        : concatText([litNode('assert failed: '), x.ins.msg], env, ctx);
      return [`(if (un "!" ${cond}) (do (print ${line}) (fail (str "assert failed"))))`];
    }
    case 'prim': {
      /* **列表追加**：方言里现成的一句 `(apush 数组 值)`（`bindSlice` 用的就是它）。
         它在方言里是**语句**，所以只在语句位置上给 —— 表达式位置上那一格报缺口
         （V 的 `arr << x` 本来也是语句）。 */
      if (x.attrs.name === 'push') {
        const ps = argList(x, 'args');
        if (ps.length !== 2) gap(`push 收了 ${ps.length} 格实参（要两格）`);
        if (elemType(typeOf(ps[0], env, ctx)) === null) {
          gap('push 的第一格推不出是列表（方言的数组是单态的，元素类型得知道）');
        }
        return [`(apush ${objText(ps[0], env, ctx)} ${expr(ps[1], env, ctx)})`];
      }
      if (x.attrs.name !== 'print') return [`(expr ${expr(x, env, ctx)})`];
      const args = argList(x, 'args');
      if (args.length !== 1) gap(`print 收了 ${args.length} 格实参（方言的 print 只收一格）`);
      /* **一格多值直接印**（go 的 `fmt.Println(minmax(1, 2))` 印 "1 2"）：图上那条 arity 契约
       * 是"列表里最后一格展开"，落到方言这边就是把那几格拼成一句（空格分隔）。 */
      const shape = shapeAt(typeOf(args[0], env, ctx), ctx);
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
 * `let p = R{…}` —— 方言里是**两步**：`pnew` 出一格（零初始化的）指针，再逐个字段 `pstore`。
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
  /* **字段里又是一格记录**（go 的 `var q Pair`，Pair 里装着 Point）：方言收得住
     （structDec 那一刀的 `(ptr T)` 字段），可 `(pstore …)` 那一格要的是一个**值**，
     而 record-new 在表达式位置上落不下去。所以先把里头那格物化成一格临时名，再把那格
     **指针**存进字段 —— 里外指同一格，与图上"记录是引用"一致。
     递归是这儿展开的（`rec_tmpN` 逐层各一格），套几层都一样。
     列表 / 字典当字段**仍旧不接**：那两样在方言里是句柄（引用语义），"里头改了外头看得见"
     这件事得先有判据再说。 */
  const pre = [];
  const fieldText = [];
  const types = names.map((_, i) => {
    const v = vals[i];
    if (isNode(v) && v.op === 'record-new') {
      ctx.tmp = ctx.tmp + 1;
      const tn = `rec_tmp${ctx.tmp}`;
      pre.push(...bindRecord(tn, v, env, ctx));
      fieldText.push(`(var ${tn})`);
      return env.get(tn);
    }
    const t = typeOf(v, env, ctx);
    if (t !== 'int' && t !== 'real' && t !== 'bool' && t !== 'string') {
      gap(`记录的字段 '${names[i]}' 不是标量（方言的字段这一刀只收标量与另一格记录）`);
    }
    fieldText.push(null);
    return t;
  });
  const shape = shapeOf(names, types, false, ctx);
  /* 记录落**一格指针**（`types.js` 的 `shapeType`）：`pnew` 出一格零初始化的，再逐个
     `(pstore (pfield …) …)`。指针复制 = 两个名字指同一格 —— 那正是图上记录的语义。 */
  const out = [...pre, bindLine(nm, shapeType(shape), `(pnew (ptr ${shape.tag}) (int 1))`, env, ctx)];
  for (let i = 0; i < names.length; i++) {
    out.push(`(pstore (pfield (var ${nm}) ${names[i]}) ${fieldText[i] ?? expr(vals[i], env, ctx)})`);
  }
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
  const out = [bindLine(nm, dt, `(dnew ${dt})`, env, ctx)];
  for (let i = 0; i < keys.length; i++) {
    out.push(`(dset (var ${nm}) ${expr(keys[i], env, ctx)} ${expr(vals[i], env, ctx)})`);
  }
  return out;
}

/** 一格 `null` 字面量（awk 的"没赋过值"）。 */
function isLitNull(x) {
  if (isLit(x)) return x.lit === null;
  return isNode(x) && x.op === 'const' && x.attrs.value === null;
}

/** `null` 那一格的类型从**第一处赋值**上取。找不着就**再看 `==` 的另一边** ——
 * V 的 `y := ?int(none)` 接着 `if y == none` 是只比了一下就再也不碰的那一族，
 * 整格函数体里 `y` 没有一处 `set`，可比较的另一边（`none` -> null）说明这一格是 int。
 * 再找不着就报缺口，不猜。 */
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
    /* **比较的另一边**：`(prim "=" [ref y, null])` —— y 与 null 在比，
       说明 y 的用法是"有没有值"，类型是 int（null -> `(int 0)`，比较是 `== 0`）。 */
    if (x.op === 'prim' && (x.attrs.name === '=' || x.attrs.name === '!=')) {
      const args = argList(x, 'args');
      if (args.length === 2) {
        if (isNode(args[0]) && args[0].op === 'ref' && args[0].attrs.name === nm && isLitNull(args[1])) return 'int';
        if (isNode(args[1]) && args[1].op === 'ref' && args[1].attrs.name === nm && isLitNull(args[0])) return 'int';
      }
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
  return [
    bindLine(nm, at, `(anew ${at} (int 0))`, env, ctx),
    `(do (let ${i} int ${from})`
      + ` (while (bin "<" (var ${i}) ${to})`
      + ` (do (apush (var ${nm}) (aget ${src} (var ${i}))) (set ${i} (bin "+" (var ${i}) (int 1))))))`,
  ];
}

/**
 * `let xs = fill(n, 零值)` —— **按长度造一格列表**（第 25 格内建）。
 *
 * 方言里没有它，所以走与 `slice` **同一条消去规则**：新建一格空数组 + 一圈 `apush`。
 * 元素类型从那格初值推（只接标量 —— `prims.js` 里 `fill` 本来就不许拿聚合当初值：
 * 那样 n 格会指向同一格）。长度可以是任意表达式（`(alen …)` / 变量都行）。
 *
 * 只接**绑定位置**：表达式位置上摆不进一圈循环 —— 那时 `expr` 那边照旧报缺口
 * （`PRIMS_OK` 里没有 `fill`，所以那一格是有名有姓的）。
 */
function bindFill(nm, pr, env, ctx) {
  const args = argList(pr, 'args');
  if (args.length !== 2) gap(`内建 fill 收了 ${args.length} 格实参（要两格）`);
  const et = typeOf(args[1], env, ctx);
  if (!isScalar(et)) gap(`fill 的初值不是标量（量到的是 ${et}）—— 聚合初值会让 n 格指向同一格`);
  const at = `(arr ${et})`;
  const n = expr(args[0], env, ctx);
  const v = expr(args[1], env, ctx);
  ctx.tmp = ctx.tmp + 1;
  const i = `fill_i${ctx.tmp}`;
  const cnt = `fill_n${ctx.tmp}`;
  return [
    bindLine(nm, at, `(anew ${at} (int 0))`, env, ctx),
    /* 长度**只算一次**（`n` 可能是一格调用）—— 与 `for-in` 那一格同一条纪律。 */
    `(do (let ${cnt} int ${n}) (let ${i} int (int 0))`
      + ` (while (bin "<" (var ${i}) (var ${cnt}))`
      + ` (do (apush (var ${nm}) ${v}) (set ${i} (bin "+" (var ${i}) (int 1))))))`,
  ];
}

/**
 * `let xs = [1,2,3]` —— 方言里是 `(anew (arr T) 长度)` 再逐格 `(aset …)`。
 * 元素类型从第一格元素推，剩下的必须一致（不一致当场报 —— 方言的数组是单态的）。
 */function bindList(nm, lst, env, ctx) {
  const items = argList(lst, 'items');
  if (items.length === 0) gap('一格空列表（元素类型推不出来）');
  const ts = items.map((it) => typeOf(it, env, ctx));
  const et = ts[0];
  if (et !== 'int' && et !== 'real' && et !== 'bool' && et !== 'string') {
    gap(`列表的元素不是标量（这一刀只接标量元素，量到的是 ${et}）`);
  }
  if (ts.some((t) => t !== et)) gap(`列表里的元素类型不一样（${ts.join(' / ')}）—— 方言的数组是单态的`);
  const at = `(arr ${et})`;
  const out = [bindLine(nm, at, `(anew ${at} (int ${items.length}))`, env, ctx)];
  for (let i = 0; i < items.length; i++) {
    out.push(`(aset (var ${nm}) (int ${i}) ${expr(items[i], env, ctx)})`);
  }
  return out;
}


/**
 * **函数值那一族**：`func` 站在**值**的位置上（当实参、当场就调那种）。
 *
 * 方言里有这一格 —— `(fnty (T…) R)` 的类型、`(fnref 名)` 把一个普通函数当值、
 * `(callfn E a…)` 间接调（`tests/sexpr/cases/15-fnvalues.sx` 钉着这一族）。所以这一刀
 * 只做一件事：把那几格匿名 `func` **提到顶层**，原地换成一格 `ref` ——
 * 后面 `expr` 的 `ref` 那一支看见"这名字是个顶层函数"就发 `(fnref …)`，
 * `callText` 看见"被调的是一格 fnty 的名字"就发 `(callfn …)`。
 *
 * **只提捕获为空的那种**：借了外层名字的要真闭包（`(cfn …)` + `(mkclo …)`），那是另一刀 ——
 * 这儿原样留着，后面照旧报一格有名有姓的缺口。
 *
 * `bind` 位置上的那种不走这儿：那一格 `liftBody` 早就接了（提升 = 闭包，见它的注）。
 */
function liftFnVals(fns, rest, known, taken) {
  const extra = [];
  /* **没有 `func` 就一个字都不动。**`mapNodes` 是**重建**式的改写，而重建会把图上
     **共享的那一格**拆成两格（`lazyAnd`/`lazyOr` 的 `cond` 与 `then` 本来是同一格节点，
     `luaTernary` 认的正是那个恒等）—— 白跑一趟的代价量过：`gsl-shell` 与
     `hand+lua-ternary` 当场从 ok 变 skip。 */
  const hasFunc = (body) => {
    let found = false;
    walkCore(body, (n) => { if (n.op === 'func') found = true; });
    return found;
  };
  const doOne = (body) => (hasFunc(body) ? mapNodes(body, (n) => {
    if (n.op !== 'func') return undefined;
    const ps = (n.attrs.params ?? []).map((q) => String(q));
    if (capsOf(n.ins.body, new Set(ps), known).length > 0) return undefined;
    let nm = n.attrs.name === undefined || n.attrs.name === null
      ? `__fnval${extra.length}` : String(n.attrs.name);
    while (taken.has(nm)) nm = `${nm}$`;
    taken.add(nm);
    known.add(nm);
    extra.push({ name: nm, params: ps, body: n.ins.body });
    return { op: 'ref', ins: {}, attrs: { name: nm }, id: -1 };
  }) : body);
  for (const f of fns) f.body = doOne(f.body);
  const out = doOne(rest);
  /* 提上来的那几格体里可能还套着一层 —— 转到不动为止（上限是防手抖，不是语义）。 */
  for (let i = 0; i < 8; i++) {
    const before = extra.length;
    for (const g of extra.slice()) g.body = doOne(g.body);
    if (extra.length === before) break;
  }
  for (const g of extra) fns.push(g);
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
 * 哪几个函数名**被当值用过**（有一处调用站在值的位置上）。
 *
 * 位置是**端口的求值语义**说的（`nodes.js` 的 `SEM`）：`body` 那几格里躺着语句，别的
 * （`value` / `lazy`）里躺着值。所以 `(call main)` 摆在 region 的 body 里 = 语句位置，
 * 而 `(print (call f))` 里那格 = 值位置。
 */
function valueCalled(root) {
  const out = new Set();
  const walk = (x, isValue) => {
    if (Array.isArray(x)) { for (const y of x) walk(y, isValue); return; }
    if (!isNode(x)) return;
    if (isValue && x.op === 'call') {
      const f = x.ins.fn;
      if (isNode(f) && f.op === 'ref') out.add(f.attrs.name);
    }
    for (const p of declOf(x.op).ins ?? []) {
      const kid = x.ins[p.name];
      if (kid === undefined || kid === null) continue;
      walk(kid, p.sem !== 'body');
    }
  };
  walk(root, false);
  return out;
}

/** 这格函数体里每一处 `ret` 交出去的值都是纯的吗（里层函数不算 —— 那是它自己的事）。 */
function retsPure(body) {
  const seek = (x) => {
    if (Array.isArray(x)) return x.every(seek);
    if (!isNode(x)) return true;
    if (x.op === 'func') return true;
    if (x.op === 'ret') {
      const v = x.ins.value;
      return v === undefined || v === null || isPure(v);
    }
    return Object.values(x.ins).every(seek);
  };
  return seek(body);
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
    globals: new Set(), fnEnv: null, fnParams: new Map(),
  };
  /* 覆盖层（`types.js`）要问的那两件**后端自己的事**（见文件头那段 import 的注）：
     登记一格形状（顺带往模块头上印 `(struct rN …)`）、报一格有名有姓的缺口。 */
  ctx.shapeOf = (names, types, multi) => shapeOf(names, types, multi, ctx);
  ctx.gap = gap;
  /* 一、分两拨，并把**内层函数提到顶层**（lambda 提升，见 `liftBody`）。 */
  const raw = [];
  const rest0 = [];
  for (const it of list) {
    if (isNode(it) && it.op === 'bind' && isNode(it.ins.init) && it.ins.init.op === 'func') {
      const f = it.ins.init;
      raw.push({
        name: it.attrs.name,
        params: (f.attrs.params ?? []).map((p) => String(p)),
        body: f.ins.body,
      });
      continue;
    }
    rest0.push(it);
  }
  const taken = new Set(raw.map((f) => f.name));
  const modNames = new Set();
  for (const it of rest0) if (isNode(it) && it.op === 'bind') modNames.add(it.attrs.name);
  /* 不算捕获的那些：顶层函数名 + 顶层绑定的名字（后者落 `(global …)`，见 `bindLine`）。 */
  const known = new Set([...taken, ...modNames]);
  const fns = [];
  for (const f of raw) {
    const r = liftOne(f.body, f.name, known, taken, gap);
    for (const g of r.lifted) fns.push(g);
    fns.push({ name: f.name, params: f.params, body: r.body });
  }
  const topLift = liftOne(rest0, 'main', known, taken, gap);
  for (const g of topLift.lifted) fns.push(g);
  /* **函数值那一趟**：值位置上的匿名 `func` 提到顶层，原地换成一格 `ref`（见 `liftFnVals`）。 */
  const rest = liftFnVals(fns, topLift.body, known, taken);
  /* 二、每格函数的返回类型与隐式返回 —— 互相递归（`fact` 调自己）要先登记上。 */
  /* 哪几个函数的返回值**被当值用过** —— 下面那格"没人要就是 void"要它（一次数清，
     两拨都要看：函数体里的调用点与顶层那几句）。 */
  const valueUsed = valueCalled([...fns.map((f) => f.body), rest]);
  /* 函数名 -> 形参名单（`fnTypeOf` 拿它拼 `(fnty …)`）。 */
  for (const f of fns) ctx.fnParams.set(f.name, f.params);
  for (const it of fns) {
    {
      const f = { ins: { body: it.body }, attrs: { params: it.params } };
      const params = it.params;
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
        if (t === 'void' || !(isScalar(t) || shapeAt(t, ctx) !== undefined)) impl = null;
        else if (rt === null) rt = t;
        else if (rt === 'void') impl = null;      // void 函数末尾那个值不是返回值
        else if (rt !== t) {
          gap(`函数 '${it.name}' 的显式 ret 交的是 ${rt}，体末尾那个值是 ${t}`
            + '（这一刀不做合一）');
        }
      }
      it.impl = rt === null ? null : impl;
      /* **掉到函数尾、而返回值一处都没当值用过 ⇒ 这个函数在方言里就是 void。**
       *
       * V 的 `fn main()` 里 `c := get(4)!` 落出来一格早退的 `ret c`，于是 `retTypeOf` 把
       * main 说成返回 int —— 可 V 的 main 本来不返回东西（图上 `(call main)` 站在**语句**
       * 位置）。那时 `emitFn` 会报"体末尾不是 ret"，因为方言要求非 void 的每条路都有 ret。
       *
       * 这一格是**读出来的**，不是猜：`valueCalled` 按端口的求值语义数"哪几个函数被当值
       * 用过"（`nodes.js` 的 SEM），没人要那格值就丢得掉。三道闸门一个都不少：
       *   * 只治**现在会报缺口的那一种**（末尾不是 ret、也不是隐式返回那一格值）——
       *     别的照旧，产物一个字节不动；
       *   * 返回值在整张图上一处都没当值用过；
       *   * 每一处 `ret` 交出去的值都是**纯的**（有副作用就得算出来，那要另一刀）。 */
      if (rt !== null && rt !== 'void' && impl === null
        && !endsWithRet(it.body) && !valueUsed.has(it.name) && retsPure(it.body)) {
        rt = 'void';
        it.void = true;
      }
      env.set(`fn:${it.name}`, rt ?? 'void');
    }
  }
  /* **函数体看得见的只有函数名**（外加它自己的形参）：`env` 走一趟 main 之后会带上 main
   * 的局部（那是这一刀"先落 main"的副作用），而方言的函数看不见调用方的局部 —— 所以先
   * 留一份只有 `fn:` 那几格的干净底子。少了这一格，闭那种借外面名字的函数就会一路落到
   * 方言那儿才报"未声明的变量"（硬错，不是有名有姓的缺口）—— `chez+index` 当场量到过。 */
  const fnEnv = new Map(env);
  ctx.fnEnv = fnEnv;
  /* 哪几格顶层绑定要落成**模块级变量**：函数体里的自由名字（见 `freeInFns` / `bindLine`）。 */
  ctx.globals = freeInFns(fns, env);
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
  /* **返回值没人要的那个函数**（`f.void`，见 `emitCore` 里 `valueCalled` 那一段）：
     体里那几格 `ret x` 落成光秃秃的 `(ret)`。这一格进体之前挂上、出来还原。 */
  const outerVoid = ctx.voidFn;
  ctx.voidFn = f.void === true;
  let fbody;
  try {
    fbody = f.impl === null || f.impl === undefined
      ? stmtList(f.body, fenv, ctx)
      : stmtList([...arr.slice(0, -1), retWrap(arr[arr.length - 1])], fenv, ctx);
  } finally {
    ctx.voidFn = outerVoid;
  }
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

/**
 * `can` 那一问：这格节点接不接得住（接不住给一句人话 —— 那句话就是账）。
 *
 * **28 格全接上了**（第二十九批那格 `assert` 照口径拼出来 —— 方言的 `(fail 串)` 给"停下来"、
 * 一句 `print` 给那行可观察的话）：节点级缺口 0。剩下的账都是**形状上的**
 * （同一格节点的某种用法接不住）—— 那几条在 `CORE_SHAPES` 里，各带一份证物。
 * 原先这儿挂着一张 `WHY` 表（逐格说"欠在方言里还是欠在这份翻译上"），现在一格不欠，
 * 留着就是过期的账 —— 所以删了，不留。
 */
export function coreCan(op) {
  if (OPS.has(op)) return true;
  if (declOf(op) === undefined) return `core 后端不认识这格节点：${op}`;
  return `core 这条腿还没接：${op}（清单里没有它 —— 这一格是新加的节点，`
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
    what: '内层函数跑出调用点（真函数值）',
    why: '内层函数**只当被调者用**时提升就够（`liftBody`）；一旦它当实参 / 当返回值跑出去，'
      + '那就是一格真函数值 —— 方言里要 `(cfn …)`/`(mkclo …)`/`(fnty …)`，这一刀还没接',
    witness: () => program([node('bind', {
      init: node('func', {
        body: [
          node('bind', { init: node('func', { body: [] }, { params: [] }) }, { name: 'inner' }),
          node('prim', { args: [node('ref', {}, { name: 'inner' })] }, { name: 'print' }),
        ],
      }, { params: [] }),
    }, { name: 'outer' })]),
  },
  {
    what: '内层函数改了它借来的那格',
    why: '提升是把借来的那几格**按值**当形参传进去的 —— 里层改了改不回外面，语义不同。'
      + '要接得给那一格装个盒子（方言里是 `(cfn …)` 的捕获，或者一格 `(arr T)` 当盒子）',
    /* 证物要**嵌一层**：顶层那格 `k` 会落成 `(global …)`（那时里层改它是对的），
       所以借来的那格必须是外层函数自己的局部。 */
    witness: () => program([node('bind', {
      init: node('func', {
        body: [
          node('bind', { init: litNode(0) }, { name: 'k' }),
          node('bind', {
            init: node('func', {
              body: [node('set', { value: litNode(1) }, { name: 'k' })],
            }, { params: [] }),
          }, { name: 'inner' }),
          node('call', { fn: node('ref', {}, { name: 'inner' }), args: [] }),
        ],
      }, { params: [] }),
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
    why: '方言里建一格记录是**两步**（`pnew` 再逐个 `pstore`），塞不进表达式 ——'
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



