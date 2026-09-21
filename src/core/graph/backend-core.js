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
//   字典    按键值推成 `(dict K V)`；空字典从**这一层里所有的写**上取（lua / awk 那一档）。
//           值混着（这个键是数、那个键是函数、另一个键是表）时值类型是 **dyn** ——
//           `(dict string dyn)` + `(dyn E)` 装箱、`(asint …)`/`(asfn T …)`/`(asdict T …)`
//           按键拆箱（真动态那一段；lua 的元表就是这个形状）
//   多值    落成一格合成结构体 `(struct mN (v0 …) (v1 …))` —— 方言的函数只交一格回来，
//           而结构体是值语义的，那正好就是 `return a, b` 的语义
//   形参    从**调用点**收（图上没有类型）：main 与函数体各先空跑一趟只收类型，再出文本。
//           从字典里取出来的函数没有名字，那时**按键**记到"这个键上装着的那几格函数"头上
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
// **聚合走的是"引用"那一条**：一格记录 / 列表 / 字典当实参、当 `ret` 的值、装进一格 dyn
// 都行（三处都拼名字：`(var …)` / `(ptr rN)` —— 与图上一样是同一格），而**当值印出来、
// 当值算术**那种一律报缺口：那时说不清类型。同一条纪律在 `backend-c` 那边是 `recPlan` 的
// 三个条件，这儿靠"谁来拼文本"落实（`objText` 与 `refOrExpr` 两处把门）。
// 剩下的账全是**形状上的**（见 `CORE_SHAPES`，各带一份证物）。

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
  shapeType, shapeAt, isRecType, isPtrRec,
} from './types.js';
/* 证物那五份是**手搭的小图** —— 所以要 `node()` / `lit()` / `program()`（`node` 顺带查五栏）。 */
import { node, lit as litNode, program } from './graph.js';
/* **lambda 提升那一份两条腿共用**（`src/core/graph/lift.js`）—— c 那条腿也要它。
   `gap` 传进去：措辞里带着"哪条腿"，而算法一份。 */
import { liftBody as liftOne, capsOf, mapNodes, setsNameIn } from './lift.js';
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
  /* `map-keys`（第三十批）：方言新加的 `(dkeys …)` —— 主语言 `dict.keys()` 那一格内建，
     OIR 一个新节点都没加。遍历那一圈由映射用现成的 counted 走，这一层只出键。 */
  'map-keys',
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

/**
 * **无符号那一半**（`nodes.js` 上 `prim` 的 `uns`，ADR-0016 第六十一刀）。
 * 只有这七个要分开 —— 补码下 `+ - * & | ^ << == !=` 两种读法算出来的位一模一样。
 */
const UBINOP = {
  '/': 'u/', '%': 'u%', shr: 'u>>',
  '<': 'u<', '>': 'u>', '<=': 'u<=', '>=': 'u>=',
};

/** 一格串字面量在方言里的写法（转义按 s-expr 的读法：只有这两个要转）。 */
const strLit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * 一格形状（记录或多值）在登记处里的那一份。同形的两格共用一格 `(struct …)`，
 * 标签按登记顺序发（记录 `rN`、多值 `mN`）—— 所以同一张图落两遍逐字节相同。
 */
/** 形状的去重键（`shapeOf` 与自引用那一格的"补登记"共用一份 —— 两处算法必须相同）。 */
const shapeKey = (names, types, multi, byval) => `${multi ? 'm' : (byval === true ? 'v' : 'r')}`
  + `|${names.map((n, i) => `${n}:${types[i]}`).join('|')}`;

function shapeOf(names, types, multi, ctx, byval) {
  /* **byval 进键**：同样的字段名与类型，值语义与引用语义是**两格**不同的形状
     （前者发 `(struct rN …)` + `(new rN)`、后者发 `(class rN …)` + `(cnew rN)`），
     不能共用一格。 */
  const key = shapeKey(names, types, multi, byval);
  let shape = ctx.byKey.get(key);
  if (shape !== undefined) return shape;
  shape = {
    tag: `${multi ? 'm' : 'r'}${ctx.byKey.size + 1}`,
    names: names,
    types: new Map(),
    multi: multi,
    byval: byval === true,
  };
  for (let i = 0; i < names.length; i++) shape.types.set(names[i], types[i]);
  ctx.byKey.set(key, shape);
  ctx.shapes.set(shape.tag, shape);
  /* **引用语义发 `class`、值语义（与多值）发 `struct`**（见 `types.js` 的 `shapeType`）：
     方言里类正是"两个名字指同一格"，而它**本来就能当数组元素与字段**。 */
  const kw = (multi || byval === true) ? 'struct' : 'class';
  ctx.decls.push(`  (${kw} ${shape.tag} ${names.map((n, i) => `(${n} ${types[i]})`).join(' ')})`);
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
  /* **一格 global 只声明一次**：main 要走两趟（空跑那一趟收模块级变量的类型与
     `ctx.rets`，见 `emitCore`），而 `(global …)` 是印在模块头上的一句声明 ——
     两趟各推一句就是"模块级变量重复定义"。记下它落在 `decls` 的**第几格**，
     第二趟原地改写：两趟推断出来的类型可能不同（第二趟才知道函数交回来的是个字典）。 */
  const at = ctx.declared.get(nm);
  if (at === undefined) {
    ctx.declared.set(nm, ctx.decls.length);
    ctx.decls.push(`  (global ${nm} ${t})`);
  } else {
    ctx.decls[at] = `  (global ${nm} ${t})`;
  }
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

const gap = (why) => {
  const g = new Gap(`core 这条腿还没接：${why}`);
  /* 缺口的**措辞**常常查不到源头：同一句话能从三四处发出来（`retTypeOf` 早跑那一趟发的
     和主趟发的长得一模一样）。pt 整包卡在 'V1' 上那一次就是这样找到的 ——
     真正的发话人是 `retTypeOf → multiShape`，不是主趟。 */
  if (process.env.OMNI_GAP_TRACE === '1') process.stderr.write(`${g.stack}\n`);
  throw g;
};

/** 一格**表达式** -> 方言的文本。 */
function expr(x, env, ctx) {
  if (isLit(x)) return lit(x.lit);
  if (!isNode(x)) gap(`空的表达式（${JSON.stringify(x)}）`);
  if (!OPS.has(x.op)) gap(x.op);
  switch (x.op) {
    /* `exact`（`nodes.js` 上 `const` 那段注）：整数字面量过不了 double 时前端带上了
       源码里那串数字。方言这条腿的 int 是**真 64 位**，所以照它发 —— 别的腿的 int 是
       一格 double，那一格它们看不看都一样。 */
    case 'const':
      return typeof x.attrs.exact === 'string' ? `(int ${x.attrs.exact})` : lit(x.attrs.value);
    case 'ref': {
      /* **这个名字是这格 `cfn` 借来的**（`ctx.caps`，见 `liftFnVals` 那段账）：
         方言里读一格捕获是 `(cap 名)`，不是 `(var 名)`。 */
      if (ctx.caps !== null && ctx.caps !== undefined && ctx.caps.has(x.attrs.name)) {
        return `(cap ${x.attrs.name})`;
      }
      /* 聚合（记录 / 列表）**只能从字段与下标那两条路走**：这一刀的函数形参与返回一律 int，
       * 所以一格记录一旦跑到别处（当实参、被 print、被 return）就说不清类型了。
       * 那两条路自己拼文本（不经过这儿），于是这儿一律报缺口 —— 与 backend-c 的
       * `recPlan` 那三条同一个道理，只是我们靠"谁来拼"而不是靠一趟预扫描。 */
      const t = env.get(x.attrs.name);
      /* **一格函数名当值用** —— 方言里那是 `(fnref 名)`（`tests/sexpr/cases/15-fnvalues.sx`）。
         `t === undefined` 那一条是关键：同名的局部变量优先（函数名只在没被遮住时才是函数）。 */
      if (t === undefined && env.get(`fn:${x.attrs.name}`) !== undefined) {
        return fnValText(x.attrs.name, env, ctx);
      }
      /* **在谁的体里**：这三句只说"整格当值用"时，几千行里找那一处只能人肉扫。 */
      const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
      if (isRecType(t, ctx)) gap(`把记录 '${x.attrs.name}' 整格当值用（这一刀只接字段读写）${wh}`);
      if (elemType(t) !== null) gap(`把列表 '${x.attrs.name}' 整格当值用（这一刀只接下标读写与 len）${wh}`);
      if (dictOf(t) !== null) gap(`把字典 '${x.attrs.name}' 整格当值用（这一刀只接按键读写与 len）${wh}`);
      return `(var ${x.attrs.name})`;
    }
    case 'prim': {
      const nm = x.attrs.name;
      /**
       * **`fill(n, 零值)` 在表达式位置上也能落**（`make([]T, n)` 就是这一种）：
       * 初值正好是那格类型的零值时它就是方言里一句 `(anew (arr T) n)` ——
       * 而 `anew` 的语义本来就是"长度 N 的零数组"，N 份零值**互不共享**
       * （`arrNew` 按元素的拷贝器逐格拷，见 `tests/sexpr/cases/50-arrstruct.sx`）。
       *
       * 为什么非要这一格：go 的 `spheres = make([]Sphere, 9)` 是**赋值**不是绑定，
       * 走不到 `bindFill` 那条（那条要发一圈 `apush`，摆不进表达式位置）。
       * 初值不是零值的那一档照旧只在绑定位置上接。
       */
      if (nm === 'fill') {
        const fa = argList(x, 'args');
        if (fa.length === 2 && isZeroValueNode(fa[1])) {
          const et = elemTypeOfNode(fa[1], env, ctx);
          const rec = et !== null && isRecType(et, ctx) && !isPtrRec(et, ctx);
          if (rec || et === 'int' || et === 'real' || et === 'bool' || et === 'string') {
            return `(anew (arr ${et}) ${expr(fa[0], env, ctx)})`;
          }
        }
      }
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
      return binText(nm, args, env, ctx, x.attrs.uns === true);
    }
    case 'call': {
      const f = x.ins.fn;
      /* 被调的不是一格名字：**从字典里取出来的函数**那一档由 `callText` 接（按键查签名 +
         `(callfn (asfn …) …)`），别的（真函数值）还是报缺口。 */
      if (!isNode(f) || f.op !== 'ref') return callText(x, env, ctx);
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
      if (elemType(t) === null) {
        /* **是哪一格**：只说"说不清形状"时，34 份文件里找那一处只能人肉扫 ——
           名字（宿主是一格 `ref` 时）与当前函数名这一层手上都有。 */
        const who = isNode(x.ins.obj) && x.ins.obj.op === 'ref' ? `（变量 ${x.ins.obj.attrs.name} 推出来是 ${t}）` : '';
        const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
        gap(`在一格说不清形状的东西上取下标（这一刀只接 list-new 绑出来的那格）${who}${wh}`);
      }
      return `(aget ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.index, env, ctx)})`;
    }
    /* **表达式位置上的记录**：与 `map-new` 那一格**同一条路数** —— 先物化成一格临时名，
     * 再把那个名字交出去。记录在方言里是**一格指针**（`types.js` 的 `shapeType`），
     * 所以"值"就是那个名字，语义与图上"记录是引用"一致。
     * go 的 `return Vec{a.X+b.X, …}` 与 `f(Vec{…})` 都落在这儿。
     *
     * 这一刀**试过一次、撤过一次**：那时 `Vec{1,2,3}` 与 `var v Vec` 算出两个形状，
     * 物化之后把冲突往后推了一格，judge 从 808 掉到 807。形状那一格治好之后
     * （前端按声明的字段类型转值，见 `ext/go/tograph.js` 的 `fieldValue`）才重新上。
     * 摆不下物化那几句（没有 `ctx.pre`）才报缺口，不硬拼。 */
    case 'record-new': {
      if (ctx.pre === null || ctx.pre === undefined) {
        gap('记录出现在一处摆不下物化那几句的表达式位置上');
      }
      ctx.tmp = ctx.tmp + 1;
      const rn = `rec_tmp${ctx.tmp}`;
      for (const line of bindRecord(rn, x, env, ctx)) ctx.pre.push(line);
      return `(var ${rn})`;
    }
    /* 列表在表达式位置上：与上头的 record-new 同一招 —— 物化成一格临时变量。
       go 的 `f([]int{1,2,3})` / `Mesh{Triangles: []*Triangle{…}}` 那一族撞出来的。 */
    case 'list-new': {
      if (ctx.pre === null || ctx.pre === undefined) {
        gap('列表出现在一处摆不下物化那几句的表达式位置上');
      }
      ctx.tmp = ctx.tmp + 1;
      const ln = `lst_tmp${ctx.tmp}`;
      for (const line of bindList(ln, x, env, ctx)) ctx.pre.push(line);
      return `(var ${ln})`;
    }
    case 'pick': {
      const t = typeOf(x.ins.from, env, ctx);
      const shape = shapeAt(t, ctx);
      if (shape === undefined || shape.multi !== true) {
        /* **是哪一格**：`a, b := f(…)` 里 `f` 没被认成多返回时报这一句，而只说
           "pick 的来源不是一格多值"在 4000 行里找不着。来源是一格调用时把**被调的名字**
           印出来 —— 那个名字通常就是欠的那格桩（`strconv.ParseFloat` 那一族）。 */
        const from = x.ins.from;
        const callee = isNode(from) && from.op === 'call' && isNode(from.ins.fn)
          && from.ins.fn.op === 'ref' ? from.ins.fn.attrs.name : null;
        const who = callee === null ? `（来源推出来是 ${t}）` : `（来源是调 '${callee}'，`
          + '它这一层没被认成多返回 —— 多半是那格桩还没写）';
        const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
        gap(`pick 的来源不是一格多值${who}${wh}`);
      }
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
      const d = hostDict(x.ins.obj, env, ctx);
      if (d === null) gap(`map-get 的宿主不是字典（量到的是 ${typeOf(x.ins.obj, env, ctx)}）`);
      /* 异质字典：取出来是 dyn。**这一层不拆**——用它的地方（算术 / 被调者 / 宿主）各管各的。 */
      return `(dget ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)})`;
    }
    case 'map-has': {
      const d = hostDict(x.ins.obj, env, ctx);
      if (d === null) gap(`map-has 的宿主不是字典（量到的是 ${typeOf(x.ins.obj, env, ctx)}）`);
      return `(dhas ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)})`;
    }
    /* `map-keys`（第三十批）：**方言里没有能装下"一格 map 的键"的东西**，所以这一格欠着。
       查过一遍才敢这么写：方言只有一种序列类型 `(arr T)`，而它的 `list`（主语言那一格）
       **一个操作都没有** —— `aget`/`alen`/`apush` 三格都只认 `arr`，`let` 的类型表里
       也没有 `(list T)`。于是 `dict.keys()` 那一格内建的结果在方言里是个**用不了的值**
       （试过：加一句 `(dkeys E)` 进去，量到的就是"变量是 arr<string>、初值是 list<string>"）。
       `list` 与 `arr` 在六条腿上是两种真表示（C 里 `omni_list_*` vs `omni_arr_*`、
       JS 里 `[]` vs `$anew`），拿一个当另一个用是类型上的谎。

       补法两条，**都是一次语言决定**，所以不在这一刀里做：
         · 给方言加 `(list T)` 与它那几格操作 —— 代价是"两种序列类型"这个概念重复；
         · 或者加一格"按位置取第 i 个键"（那样连列表都不用造，直接在 counted 里走）。 */
    case 'map-keys':
      gap('按键遍历：方言里没有能装下那格键列表的类型（只有 `(arr T)`，而 `keys` 出的是 '
        + '`list<K>`，它在方言里一个操作都没有）—— 要先给方言加一格，是一次语言决定');
      return '';
    case 'slice': {
      /* **串上的切片是一格表达式**（方言里就有 `(ssub …)`）—— 只有列表那一档
         要走"新建 + 一圈 apush"的消去规则，那条摆不进表达式位置。 */
      const st = strSliceText(x, env, ctx);
      if (st !== null) return st;
      gap('切片出现在表达式位置上（这一刀只接 `bind` 的初值那一格）');
      return '';
    }
    /* **表达式位置上的映射**：先物化成一格临时名，再把那个名字交出去。
     * 与实参位置上那三格聚合走的是**同一张表**（`MATERIALIZE`）与同一条理由：方言里
     * `(dnew …)` 是一句语句、字典是一格句柄，所以"值"就是那个名字。
     * lua 的 `setmetatable({}, { __close = … })` 里层那格表字面量就是这个形状 ——
     * 它落成 `map-set` 的值，不是实参，所以从前走不到 argText 那条路上。
     * 摆不下物化那几句（没有 `ctx.pre`）才报缺口，不硬拼。 */
    case 'map-new': {
      if (ctx.pre === null || ctx.pre === undefined) {
        gap('映射出现在一处摆不下物化那几句的表达式位置上');
      }
      ctx.tmp = ctx.tmp + 1;
      const mn = `map_tmp${ctx.tmp}`;
      for (const line of bindMap(mn, x, env, ctx)) ctx.pre.push(line);
      return `(var ${mn})`;
    }
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
      const t0 = typeOf(x.ins.then, env, ctx);
      const t2 = typeOf(els, env, ctx);
      /* **有一支是 `nil`**（go 的 `m[k]` 缺键给引用类型的零值就是这个形状：
         `branch (map-has m k) (map-get m k) nil`）：空引用自己说不出类型（`typeOf` 答
         UNKNOWN=int），照**另一支**的类型算，那一支落 `(null rN)`。 */
      const refOf = (ty) => (isPtrRec(ty, ctx) || elemType(ty) !== null);
      const nilThen = isLitNull(x.ins.then) && refOf(t2);
      const nilEls = isLitNull(els) && refOf(t0);
      const t = nilThen ? t2 : t0;
      if (!nilThen && !nilEls && t !== t2) {
        gap(`表达式位置上的 branch 两支不同型（${t} 与 ${t2}）`);
      }
      /* 标量或**一格形状**（sbcl 的 `(if c (values …) (values …))` 就是后者）都接得住；
         **dyn 也接得住**（lua 的 `p:total()` 里"自己有没有这个键"那一格三目交的就是它 ——
         临时量装着箱子，到用它的地方再拆）。 */
      if (!isScalar(t) && t !== 'dyn' && shapeAt(t, ctx) === undefined) gap(`表达式位置上的 branch 交出来的不是标量（${t}）`);
      ctx.tmp = ctx.tmp + 1;
      const nm = `if_tmp${ctx.tmp}`;
      const arm = (e) => {
        const outer = ctx.pre;
        const p = [];
        ctx.pre = p;
        let v;
        try {
          v = (isLitNull(e) && refOf(t)) ? `(null ${t})` : expr(e, env, ctx);
        } finally {
          ctx.pre = outer;
        }
        return `(do ${[...p, `(set ${nm} ${v})`].join(' ')})`;
      };
      const cond = condText(x.ins.cond, env, ctx);
      const a = arm(x.ins.then);
      const b = arm(els);
      /* 引用语义那一档的初值用**空引用**（不是 `(cnew …)`）：两支都会覆盖它，白造一格对象
         在 pt 那种热路径上是白花的分配。 */
      ctx.pre.push(`(let ${nm} ${t} ${refOf(t) ? `(null ${t})` : newOfType(t, ctx)})`);
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
function binText(nm, args, env, ctx, uns) {
  /* **与 nil 比**（go 的 `hit.Shape != nil`）：一边是空引用字面量、另一边是引用语义的
     记录（方言的类）或数组 —— 落 `(bin "==" X (null rN))`（`sexpr/lower.js` 的 `null`
     那一格收类 / 函数 / 数组，判据在 tests/sexpr 的 51-if-onestmt-null）。
     `expr` 对"把记录整格当值用"一律报缺口（那条规矩对），所以这一格走 `aggValText`。

     **前提是那一边真的可能是空引用**：接口字段与接口的零值现在落 `(null rN)`
     （`record-new` 的 `fzero`，见 nodes.js）。`var p *T` 还落着 T 的零值记录 ——
     那一格的 `p == nil` 仍旧恒为假，所以**没接**（任务 #88 的第二步），
     它落不到这儿：`zeroOf` 给的是记录，不是 `lit(null)`。 */
  if ((nm === '=' || nm === '!=') && args.length === 2) {
    const li = isLitNull(args[0]) ? 0 : (isLitNull(args[1]) ? 1 : -1);
    if (li >= 0) {
      const other = args[1 - li];
      const ot = typeOf(other, env, ctx);
      if (isPtrRec(ot, ctx) || elemType(ot) !== null) {
        return `(bin "${BINOP[nm]}" ${aggValText(other, env, ctx)} (null ${ot}))`;
      }
    }
  }
  /* **dyn 在这儿拆箱**（拆在用它的地方，见 dyn 那一段）：`seenType` 按键查出箱子里装的是
     什么，`one` 落文本时套一层 `(asint …)` 那一族。查不出来就报缺口（`unboxTo` 那一句）。 */
  const ts = args.map((a) => seenType(a, env, ctx));
  let want = 'int';
  if (ts.some((t) => t === 'string')) want = 'string';
  else if (ts.some((t) => t === 'real')) want = 'real';
  else if (ts.every((t) => t === 'bool')) want = 'bool';
  const one = (a, t) => {
    const v = typeOf(a, env, ctx) === 'dyn' ? unboxTo(expr(a, env, ctx), t) : expr(a, env, ctx);
    if (t === want) return v;
    if (want === 'string') return `(tostr ${v})`;
    if (want === 'real' && t === 'int') return `(toreal ${v})`;
    /* **在谁的体里**：只说"两边说不到一起"时，几千行里找那一处只能人肉扫
       （与 `bindList` / `argText` 那几句用的是同一格 `ctx.fnName`）。 */
    const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
    return gap(`'${nm}' 的两边说不到一起（${t} 与 ${want}）${wh}`);
  };
  /* 无符号那一格（`uns`）：只有那七个算符有另一半，别的原样发。 */
  const opTxt = (uns === true && UBINOP[nm] !== undefined) ? UBINOP[nm] : BINOP[nm];
  return args.slice(1).reduce((acc, a, i) => `(bin "${opTxt}" ${acc} ${one(a, ts[i + 1])})`,
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
  /* **不只认光名字**：`len(m.Triangles)`（数组当结构体字段那一族）在图上是一格
     `field-get`，问类型就够了 —— 原来这儿一律落 `slen`，方言当场骂"第一个参数要是 string"。 */
  if (isNode(a) && a.op !== 'ref') {
    let t = null;
    try { t = typeOf(a, env, ctx); } catch { t = null; }
    if (elemType(t) !== null) return `(alen ${expr(a, env, ctx)})`;
    if (dictOf(t) !== null) return `(dlen ${expr(a, env, ctx)})`;
  }
  return `(slen ${expr(a, env, ctx)})`;
}

/**
 * 字段 / 下标那一格**宿主**的文本。认一个名字（`(var p)`），也认**里头那格记录**
 * （`q.a.y` -> `(fld (fld (var q) a) y)`）—— 后者要里层自己说得清形状。
 * 别的（`xs[0].f`、`f().f`）这一刀不接。
 */
function objText(obj, env, ctx) {
  /* 嵌套的宿主：里层是一格 `field-get` 且它交出来的就是一格形状 —— 一层层 `(fld …)` 套
     下去（`(fld (fld (var q) a) y)`）。引用语义那一档是**类**，值语义那一档是结构体，
     两边在方言里同形，而且**都是左值链**（判据见 `types.js` 的 `shapeType`）。 */
  if (isNode(obj) && obj.op === 'field-get') {
    const inner = typeOf(obj, env, ctx);
    if (shapeAt(inner, ctx) !== undefined || elemType(inner) !== null || dictOf(inner) !== null) {
      return fldText(obj.ins.obj, obj.attrs.field, env, ctx);
    }
  }
  if (!isNode(obj) || obj.op !== 'ref') {
    /* **宿主是一格下标**（`xs[i].Area()` —— go 的 `[]Shape` 那一族，ADR-0040）：
       `(aget …)` 交出来的那一格就能当宿主用 —— 值语义的记录走 `(fld …)`、引用语义的
       是个指针走 `(pload (pfield …))`，两档由 `fldText` / `placeText` 自己分。 */
    if (isNode(obj) && obj.op === 'index-get') {
      const it = typeOf(obj, env, ctx);
      if (shapeAt(it, ctx) !== undefined || elemType(it) !== null || dictOf(it) !== null) {
        return `(aget ${objText(obj.ins.obj, env, ctx)} ${expr(obj.ins.index, env, ctx)})`;
      }
    }
    /* **宿主是一次调用**（`m.Tex.Pow(3).Sample(…)` —— 链式那一族）：交出来的是一格记录，
       先物化成一格临时名再当宿主用。摆不下物化那几句（没有 `ctx.pre`）就照旧往下报。
       **数组 / 字典也走这一条**（`&Mesh{polys(2)}` 那一格字段的值）：交出来的是一个句柄，
       物化一格名字与记录同理。从前只放记录过，于是那一格报"字段 / 下标的宿主不是一个名字"。 */
    if (isNode(obj) && obj.op === 'call' && ctx.pre !== null && ctx.pre !== undefined) {
      const ct = typeOf(obj, env, ctx);
      if (isRecType(ct, ctx) || elemType(ct) !== null || dictOf(ct) !== null) {
        ctx.tmp = ctx.tmp + 1;
        const tn = `obj_tmp${ctx.tmp}`;
        ctx.pre.push(bindLine(tn, ct, expr(obj, env, ctx), env, ctx));
        return `(var ${tn})`;
      }
    }
    /* **嵌套的宿主**：lua 的 `a.__meta.__close` 头一跳交出来的是一格 dyn，按键查出它装着
       `(dict string dyn)` 就拆出来当宿主用（拆在用它的地方，见 dyn 那一段）。 */
    const et = typeOf(obj, env, ctx);
    if (et === 'dyn') {
      const inner = dynTypeOf(obj, env, ctx);
      if (inner !== null && dictOf(inner) !== null) return unboxTo(expr(obj, env, ctx), inner);
    }
    gap('字段 / 下标的宿主不是一个名字（嵌套那一档还没接）');
  }
  const t = env.get(obj.attrs.name);
  if (shapeAt(t, ctx) === undefined && elemType(t) === null && dictOf(t) === null) {
    /* **是哪一格**：`'c' 说不清形状` 在 4159 行里只能人肉扫。推出来是什么、在谁的体里 ——
       两样这一层手上都有（与上面 index-get 那一格同一条规矩）。 */
    const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
    gap(`'${obj.attrs.name}' 说不清形状（推出来是 ${t}；这一刀只认 \`bind\` 一格记录 / `
      + `列表 / 字典绑出来的名字）${wh}`);
  }
  /* **这格宿主是当前 `cfn` 借来的**（接口装箱的 `__self` 就是它，ADR-0040）。 */
  return varOrCap(obj.attrs.name, ctx);
}


/** `(call 名 实参…)` 的文本（"当值用"那道检查在 `expr` 里，语句位置上不查）。 */
/**
 * **运行时那几个 C 符号**（并发那一档，任务 #78）。
 *
 * 为什么是这条路而不是给图加 `chan` 那一族节点：channel 与 `go f()` 底下那台机器
 * （G/M/P 调度器）**本来就在 C 里**（`src/runtime-sched/`，照 go 的 proc.go/chan.go 写的），
 * 而方言已经有一条正经的"调外部 C 符号"的路（`(lib …)` + `(cabi …)` + `(ccall …)`，
 * ADR-0022 的 J4b）。于是图上还是"调一个名字"、OIR 一个新节点都不加 —— 前端发
 * `call __goChanSend(ch, v)`，这一层认出名字就落成 `(ccall omni_go_chan_send …)`。
 *
 * 键是**前端发的那个名字**（`ext/go/go-rt.js` 里的同名函数就是 js 那条腿的那一份）。
 * `ps` 里的 `fn` 是"这一格要递一个**函数值**"（`(fnref 名字)`，cabi 上仍是 `ptr`）——
 * `go f(i)` 与 `func main()` 都靠它把一格方言的函数交给运行时去跑。
 * `ret` 是 `(cabi …)` 那一句里写的词（**那一端的 C 是怎么声明的**），`dty` 是**这一端**
 * 看到的类型（`inferType` 查 `fn:名字` 要它）。两格必须分开：`omni_go_chan_new` 回的是
 * 地址（`ptr`，方言这侧是 int），而 `omni_go_chan_recv` 回的是**一格值**（`i64`）——
 * 合成一格的那一版把后者也写成了 `ptr`，那是在调用点白套一次指针到整数的转换。
 */
const C_RT = new Map([
  ['__goRun', { sym: 'omni_go_run', ret: 'void', dty: 'void', ps: ['fn'] }],
  ['__goSpawn', { sym: 'omni_go_spawn', ret: 'void', dty: 'void', ps: ['fn', 'i64'] }],
  ['__goSpawn0', { sym: 'omni_go_spawn0', ret: 'void', dty: 'void', ps: ['fn'] }],
  ['__goSpawn2', { sym: 'omni_go_spawn2', ret: 'void', dty: 'void', ps: ['fn', 'i64', 'i64'] }],
  ['__goSpawn3', { sym: 'omni_go_spawn3', ret: 'void', dty: 'void', ps: ['fn', 'i64', 'i64', 'i64'] }],
  ['__goChanMake', { sym: 'omni_go_chan_new', ret: 'ptr', dty: 'int', ps: ['i64'] }],
  ['__goChanSend', { sym: 'omni_go_chan_send', ret: 'void', dty: 'void', ps: ['ptr', 'i64'] }],
  ['__goChanRecv', { sym: 'omni_go_chan_recv', ret: 'i64', dty: 'int', ps: ['ptr'] }],
  ['__goChanRecv2', { sym: 'omni_go_chan_recv2', ret: 'i64', dty: 'int', ps: ['ptr'] }],
  ['__goChanOK', { sym: 'omni_go_chan_ok', ret: 'i64', dty: 'int', ps: [] }],
  ['__goChanClose', { sym: 'omni_go_chan_close', ret: 'void', dty: 'void', ps: ['ptr'] }],
  ['__goChanLen', { sym: 'omni_go_chan_len', ret: 'i64', dty: 'int', ps: ['ptr'] }],
  ['__goSelBegin', { sym: 'omni_go_sel_begin', ret: 'void', dty: 'void', ps: [] }],
  ['__goSelRecv', { sym: 'omni_go_sel_recv', ret: 'void', dty: 'void', ps: ['ptr'] }],
  ['__goSelSend', { sym: 'omni_go_sel_send', ret: 'void', dty: 'void', ps: ['ptr', 'i64'] }],
  ['__goSelDefault', { sym: 'omni_go_sel_default', ret: 'void', dty: 'void', ps: [] }],
  ['__goSelGo', { sym: 'omni_go_sel_go', ret: 'i64', dty: 'int', ps: [] }],
  ['__goSelVal', { sym: 'omni_go_sel_val', ret: 'i64', dty: 'int', ps: [] }],
  ['__goSelOK', { sym: 'omni_go_sel_ok', ret: 'i64', dty: 'int', ps: [] }],
  /* **宿主那几格**（时钟 / 核数 / 文件，见 `src/runtime-sched/omni_go.h` 末尾那段注）。
     前端那侧的名字由 `ext/go/tograph.js` 的 `GO_HOST_FNS` 说（`omnihost.Nanotime()`
     那一族）—— 这张表只管"这个名字落哪个 C 符号、签名是什么"。 */
  ['__goNanotime', { sym: 'omni_go_nanotime', ret: 'i64', dty: 'int', ps: [] }],
  ['__goNumCPU', { sym: 'omni_go_numcpu', ret: 'i64', dty: 'int', ps: [] }],
  ['__goPathReset', { sym: 'omni_go_path_reset', ret: 'void', dty: 'void', ps: [] }],
  ['__goPathPush', { sym: 'omni_go_path_push', ret: 'void', dty: 'void', ps: ['i64'] }],
  ['__goOpen', { sym: 'omni_go_open', ret: 'i64', dty: 'int', ps: ['i64'] }],
  ['__goWrite', { sym: 'omni_go_write', ret: 'void', dty: 'void', ps: ['i64', 'i64'] }],
  ['__goRead', { sym: 'omni_go_read', ret: 'i64', dty: 'int', ps: ['i64'] }],
  ['__goClose', { sym: 'omni_go_close', ret: 'void', dty: 'void', ps: ['i64'] }],
  ['__goOut', { sym: 'omni_go_out', ret: 'void', dty: 'void', ps: ['i64'] }],
]);

/**
 * **go 的 `math.F(…)` -> 方言的 `(rmath "f" …)`**（前端发 `call __goMath_f(…)`）。
 *
 * 为什么走这条路而不是给图加一族 `prim`：方言这侧 `(rmath …)` 本来就有、六条腿都认
 * （`sexpr/lower.js` 的 `RMATH`，C99 math.h ∩ ECMA-262 Math），而给图加 prim 要动
 * `prims.js` 的清单 + 六个后端 + 提供者表。与 `C_RT` 那张表同一条路数：图上仍旧只是
 * "调一个名字"。
 *
 * 键是**方言里 rmath 的名字**（也就是 C 的名字），值是实参个数。go 那侧的名字
 * （`Sqrt` / `Abs` / …）由 `ext/go/tograph.js` 映到这儿 —— 那是那门语言的事。
 *
 * **不在这张表里的**（go 有、rmath 没有）由前端自己拼：`math.Max`/`math.Min` 落成
 * 一格生成的 go 级辅助函数（一次求值，别用 branch 复制实参）、`math.Pi` 是常量桩。
 */
const GO_RMATH = new Map([
  ['sqrt', 1], ['fabs', 1], ['floor', 1], ['ceil', 1], ['round', 1],
  ['pow', 2], ['fmod', 2], ['hypot', 2], ['atan2', 2],
  ['sin', 1], ['cos', 1], ['tan', 1], ['asin', 1], ['acos', 1], ['atan', 1],
  ['sinh', 1], ['cosh', 1], ['tanh', 1], ['asinh', 1], ['acosh', 1], ['atanh', 1],
  ['exp', 1], ['expm1', 1], ['log', 1], ['log10', 1], ['log1p', 1], ['cbrt', 1],
]);
/** 前端发的那个名字（`__goMath_sqrt`）-> rmath 的名字。 */
const goRmathOf = (nm) => (typeof nm === 'string' && nm.startsWith('__goMath_')
  && GO_RMATH.has(nm.slice(9)) ? nm.slice(9) : null);

/** `C_RT` 那张表里 `ps` 的一格 -> `(cabi …)` 里写的那个词。 */const CRT_CABI = { fn: 'ptr', ptr: 'ptr', i64: 'i64' };
/** 并发那一档的体在哪个库里（逻辑名，cli.js 的 `resolveLib` 认它）。 */
const C_RT_LIB = 'libomnigo';

/**
 * 落一格 `(ccall …)`，并把它要的那两句（`(lib …)` / `(cabi …)`）记到模块头上。
 *
 * 头上那几句**按用到的顺序发、去重**：一份图落两遍要逐字节相同（整条链的老规矩）。
 */
function crtCall(d, x, env, ctx) {
  if (!ctx.cused.has(d.sym)) {
    if (ctx.cused.size === 0) ctx.cdecls.push(`  (lib "${C_RT_LIB}")`);
    ctx.cused.add(d.sym);
    const ps = d.ps.map((p) => CRT_CABI[p]).join(' ');
    ctx.cdecls.push(`  (cabi ${d.sym} ${d.ret} (${ps}))`);
  }
  const as = argList(x, 'args');
  if (as.length !== d.ps.length) {
    gap(`'${d.sym}' 要 ${d.ps.length} 个实参，图上给的是 ${as.length} 个`);
  }
  const args = as.map((a, i) => {
    if (d.ps[i] !== 'fn') return expr(a, env, ctx);
    /* 函数值那一格：图上必须是一格**指向函数的 ref**（匿名的那些由 `liftFnVals` 提到顶层
       之后就是一格 ref）。`fnValText` 分两档 —— 普通函数 `(fnref …)`、闭包 `(mkclo …)`。 */
    if (!isNode(a) || a.op !== 'ref' || env.get(`fn:${a.attrs.name}`) === undefined) {
      gap(`'${d.sym}' 的第 ${i + 1} 格要一个函数（提不上顶层的那些还没接）`);
    }
    return fnValText(a.attrs.name, env, ctx);
  });
  return `(ccall ${d.sym}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
}

function callText(x, env, ctx) {
  const f = x.ins.fn;
  /* **运行时那几个 C 符号**（并发那一档，见 `C_RT`）：落成 `(ccall …)` 而不是 `(call …)`。
     这一格要排在所有别的判据前头 —— 图上它们就是"调一个名字"，而那个名字在这份产物里
     没有函数体（体在 `libomnigo` 里）。 */
  if (isNode(f) && f.op === 'ref' && C_RT.has(f.attrs.name)) {
    return crtCall(C_RT.get(f.attrs.name), x, env, ctx);
  }
  /* **go 的 `math.F(…)`**（见 `GO_RMATH`）：落成 `(rmath "f" …)`。实参一律抬成 real ——
     方言的 rmath 收的是 real，而 go 那侧 `math.Sqrt(2)` 的实参可能是个整数字面量。 */
  {
    const rm = isNode(f) && f.op === 'ref' ? goRmathOf(f.attrs.name) : null;
    if (rm !== null) {
      const as = argList(x, 'args');
      const want = GO_RMATH.get(rm);
      if (as.length !== want) {
        gap(`'math.${rm}' 要 ${want} 个实参，图上给的是 ${as.length} 个`);
      }
      const vs = as.map((a) => {
        const v = expr(a, env, ctx);
        return typeOf(a, env, ctx) === 'real' ? v : `(toreal ${v})`;
      });
      return `(rmath "${rm}" ${vs.join(' ')})`;
    }
  }
  /* **被调的是一格从字典里取出来的函数**（lua 的 `p:total()`、`a.__meta.__close(a)`）：
     先按键查出签名、拆箱成 `(fnty …)`，再走 `(callfn …)`。
     那几格函数的**形参类型**也在这儿记 —— 调用点是唯一知道实参类型的地方，而这一处调用
     没有名字，所以按键记到"这个键上装着的那几格函数"头上（`dynFnNames`）。 */
  if (!isNode(f) || f.op !== 'ref') {
    /* **被调的是一格记录字段里装着的函数值**（go 的接口分派，ADR-0040）：
       字段的类型就是 `(fnty …)`，所以取出来直接 `(callfn …)` —— 不经按键拆箱那一套
       （那是 lua 的字典路，键是运行期的串；这儿的字段名编译期就定了）。 */
    if (isNode(f) && f.op === 'field-get') {
      const ft1 = typeOf(f, env, ctx);
      if (typeof ft1 === 'string' && ft1.startsWith('(fnty ')) {
        const vargs = argList(x, 'args').map((a) => aggValText(a, env, ctx));
        return `(callfn ${expr(f, env, ctx)}${vargs.length === 0 ? '' : ` ${vargs.join(' ')}`})`;
      }
    }
    const ft0 = dynTypeOf(f, env, ctx);
    if (ft0 === null || !ft0.startsWith('(fnty ')) {
      /* **是哪一格**：只说"不是名字"时几千行里找不着。被调的那一格**长什么样**（op、
         取的是哪个字段）与"在谁的体里"两样这一层手上都有。 */
      const what = !isNode(f) ? JSON.stringify(f)
        : (f.op === 'field-get' ? `取字段 '${f.attrs.field}'（那一格推出来是 ${typeOf(f, env, ctx)}）`
          : `一格 ${f.op}`);
      const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
      gap(`调一格不是名字的东西（函数值那一档）—— 被调的是 ${what}${wh}`);
    }
    const names = dynFnNames(f, env, ctx);
    const vargs = argList(x, 'args').map((a, i) => {
      const t = seenType(a, env, ctx);
      for (const n of names) noteArgType(n, i, t, ctx);
      return refOrExpr(a, env, ctx);
    });
    /* **记完实参类型再问一遍签名**：签名里的形参正是这几格，而上面那一问发生在记之前
       （`(asfn (fnty (int) int) …)` 那种错签名就是这么来的 —— 量到过）。 */
    const ft = dynTypeOf(f, env, ctx) ?? ft0;
    const callee = unboxTo(expr(f, env, ctx), ft);
    return `(callfn ${callee}${vargs.length === 0 ? '' : ` ${vargs.join(' ')}`})`;
  }
  /* **被调的是一格函数值**（形参 / 局部，类型是 `(fnty …)`）—— 方言里那是 `(callfn …)`。
     实参的类型不往 `ctx.args` 上记：那张表是按**函数名**记的，而这儿被调的是一格值。 */
  const vt = env.get(f.attrs.name);
  if (typeof vt === 'string' && vt.startsWith('(fnty ')) {
    const vargs = argList(x, 'args').map((a) => expr(a, env, ctx));
    return `(callfn (var ${f.attrs.name})${vargs.length === 0 ? '' : ` ${vargs.join(' ')}`})`;
  }
  /* **这层里压根没有这格函数**（go 的 `__goSprintf` 那一族 —— 体在 js 那条腿的运行时里）：
     报一格**有名有姓的缺口**，而不是发一句 `(call 不存在的名字 …)` 让方言去骂
     「未声明的函数」。两者的差别是判据上"跳过"与"红"的差别，而这一格确实是还没接的东西。
     空跑那两趟不查（那时 `fn:` 还没收全）。 */
  if (ctx.collect !== true && env.get(`fn:${f.attrs.name}`) === undefined) {
    gap(`调一格这一层里没有的函数 '${f.attrs.name}'`);
  }
  const args = argList(x, 'args').map((a, i) => argText(f.attrs.name, i, a, env, ctx));
  return `(call ${f.attrs.name}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
}

/** 这格被调表达式里按键能取出哪几格**函数**（按键拆箱那一套，见 dyn 那一段）。 */
function dynFnNames(f, env, ctx) {
  const out = new Set();
  walkCore(f, (n) => {
    if (n.op !== 'map-get') return;
    const k = keyLitOf(n.ins.key);
    if (k === null) return;
    for (const v of ctx.dynSites.get(k) ?? []) {
      if (isNode(v) && v.op === 'ref' && fnTypeOf(v, env, ctx) !== null) out.add(v.attrs.name);
    }
  });
  return [...out];
}

/**
 * 往 `ctx.args` 上记一格形参类型（**不查冲突**）。
 *
 * 与 `argText` 那几句的区别：这儿是"按键记到那几格函数头上"，同一个键上装着两格签名
 * 不同的函数时**不在这里报** —— 那时 `dynKeyType` 本来就答不出一致的类型，缺口报在
 * 拆箱那一处（措辞说得清是"按键查不到一致的类型"）。
 */
function noteArgType(fname, i, t, ctx) {
  const key = `${fname}#${i}`;
  const had = ctx.args.get(key);
  if (had === undefined || (had === 'int' && t !== 'int')) ctx.args.set(key, t);
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
  /* **一格 `null` 当实参**：它对"这格形参是什么类型"什么都没说 —— null 在方言里对记录、
     列表、字典都成立，而 `typeOf` 对它只能答 `int`。既记进 `ctx.args` 又拿它去比的代价是
     把"一处 null、一处记录"报成"两处的类型不一样"（量出来的：go 的 `f(nil)` 与 `f(s)`
     两个调用点，`'nilKind' 第 1 格实参…（r2 与 int）`）。
     类型从**声明**（`pzero`，与 `resolveParamTypes` 第一条同一份）来；是引用类型就落
     `(null rN)`，不然照常（`(int 0)`）—— 后者那一格方言本来就把 null 当 0。 */
  if (isLitNull(a)) {
    const pz = (ctx.fnPzero ?? new Map()).get(fname);
    const z = Array.isArray(pz) ? pz[i] : undefined;
    let pt = (z === null || z === undefined) ? null : declTypeOfNode(z, env, ctx);
    if (pt === null || pt === 'int') pt = ctx.args.get(`${fname}#${i}`) ?? null;
    if (pt !== null && (isPtrRec(pt, ctx) || elemType(pt) !== null)) return `(null ${pt})`;
    return expr(a, env, ctx);
  }
  const t = typeOf(a, env, ctx);
  const key = `${fname}#${i}`;
  const had = ctx.args.get(key);
  /* **收类型那两遍不算冲突**：那时被调者的形参还按 int（默认值），所以"一处 int、一处
   * 记录"说明的是"这一格还没收全"，不是两处真的不一样 —— 取具体的那一个。真冲突留给
   * 第三遍（出文本那一遍）报。 */
  if (ctx.collect === true) {
    if (had === undefined || (had === 'int' && t !== 'int')) ctx.args.set(key, t);
    if (isNode(a) && a.op === 'ref' && isAggregate(t, ctx)) return varOrCap(a.attrs.name, ctx);
    return expr(a, env, ctx);
  }
  if (had !== undefined && had !== t) {
    /* **哪个调用点**：只说"两处不一样"时，34 份文件里找那一处只能人肉扫 —— 而这一层
       手上就有当前函数名（`ctx.fnName`，与 `bindList` 那句用的是同一格）。 */
    const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
    gap(`'${fname}' 第 ${i + 1} 格实参在两处的类型不一样（${had}${shapeNote(had, ctx)} 与 `
      + `${t}${shapeNote(t, ctx)}）—— 方言的形参是单态的${wh}`);
  }
  ctx.args.set(key, t);
  if (isNode(a) && a.op === 'ref' && isAggregate(t, ctx)) return varOrCap(a.attrs.name, ctx);
  return expr(a, env, ctx);
}

/**
 * 一格类型后面跟着的**字段清单** —— 光看 "(arr r3) 与 (arr r1)" 没法判断差在哪儿。
 *
 * 为什么值得留在产品代码里：这条缺口（同一个接口算出两格形状）查起来第一步总是
 * "那两格记录到底哪儿不一样"，而那一步从前要临时加打印。记录之外（int / 列表）回空串。
 */
function shapeNote(t, ctx) {
  const m = /^\(arr (.+)\)$/.exec(String(t));
  const nm = m === null ? String(t) : m[1];
  const sh = shapeAt(nm, ctx);
  if (sh === undefined || sh === null || sh.types === undefined) return '';
  const fs = [];
  for (const [k, v] of sh.types) fs.push(`${k}: ${v}`);
  return ` ${nm}{${fs.join('、')}}`;
}

/**
 * 读一格名字：当前 `cfn` **借来的**发 `(cap 名)`，别的发 `(var 名)`。
 *
 * 为什么要单拎一格：聚合（记录 / 列表）不走 `expr` 的 `ref` 那一支（那儿会报"把记录整格
 * 当值用"），而是各处自己拼 `(var …)` —— 于是"借来的聚合"在每一处都得再判一遍。
 * 接口装箱的 `__self` 正是这一格（ADR-0040）：漏了它方言报"未声明的变量 '__self'"。
 */
function varOrCap(name, ctx) {
  if (ctx.caps !== null && ctx.caps !== undefined && ctx.caps.has(name)) return `(cap ${name})`;
  return `(var ${name})`;
}

/**
 * **一格值摆进容器里**（`(aset …)` / `(dset …)` 的值那一格）。
 *
 * `expr` 的 ref 那一支对聚合一律报缺口，那条规矩是对的（这一刀的形参与返回一律 int，
 * 一格记录跑到别处就说不清类型）。可容器的值那一格**是有类型的**（数组的元素类型、
 * 字典的值类型都登记着），所以这儿与 `argText` 同一招：光名字发 `(var …)` / `(cap …)`。
 * 别的（字面量、算式）照旧交给 `expr` —— 物化的临时名由它自己起，产物一个字节不动。
 */
function aggValText(v, env, ctx) {
  if (isNode(v) && v.op === 'ref' && isAggregate(typeOf(v, env, ctx), ctx)) {
    return varOrCap(v.attrs.name, ctx);
  }
  return expr(v, env, ctx);
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
  /* 形参类型走与 `emitFn` **同一份**（`resolveParamTypes`）—— 见那儿的注释。 */
  const pts = resolveParamTypes(nm, f, (ctx.fnPzero ?? new Map()).get(nm), env, ctx);
  return `(fnty (${pts.join(' ')}) ${rt === 'void' ? 'void' : rt})`;
}

/** 这一格类型是不是聚合（记录 / 列表 / 字典 / 多值）。 */
const isAggregate = (t, ctx) => isRecType(t, ctx) || elemType(t) !== null || dictOf(t) !== null;
/** 这一格类型是**多值那格合成结构体**吗（`isRecType` 刻意把它排在外头）。 */
const isMultiShape = (t, ctx) => {
  const sh = shapeAt(t, ctx);
  return sh !== undefined && sh.multi === true;
};

/**
 * 取一格字段的文本。**记录一律是 `(fld 宿主 字段名)`**（引用语义那一档是类、值语义那一档
 * 是结构体，两边的字段访问在方言里同形）——`pfield` / `pload` 那一套 2026-09-20 撤了，
 * 理由在 `types.js` 的 `shapeType` 上：内嵌的值语义结构体在类上是**现成的左值链**
 * （`(fldset (fld o v) x …)`），不用再自己串地址。
 */
function fldText(obj, field, env, ctx) {
  return `(fld ${objText(obj, env, ctx)} ${field})`;
}

/**
 * 一格形状 / 标量的"新建"文本：引用语义的记录 `cnew`、值语义与多值 `new`、标量给零值。 */
function newOfType(t, ctx) {
  const sh = shapeAt(t, ctx);
  if (sh === undefined) return zeroText(t);
  if (sh.multi === true || sh.byval === true) return `(new ${sh.tag})`;
  return `(cnew ${sh.tag})`;
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
  /* **dyn 的零值是"箱子里先装个 0"**：值位置上的 branch 要一格先声明后赋值的临时量
     （见 `expr` 的 branch 那一支），而 dyn 也会走到那儿 —— lua 的 `p:total()` 里
     "自己有没有这个键"那一格三目交出来的就是一格 dyn。 */
  if (t === 'dyn') return '(dyn (int 0))';
  return '(int 0)';
}

/* ---------------------------------------------------------------- 真动态（dyn）
 *
 * **异质字典**：图上一格 map 的值可以"这个键是数、那个键是函数、另一个键是另一格表"
 * —— lua 的元表就是这个形状，而方言的字典是**单态**的。对得上的那一格是
 * `(dict string dyn)`：值是带标签的联合值，装箱 `(dyn E)`、拆箱 `(asint …)` /
 * `(asfn T …)` / `(asdict T …)`（`tests/sexpr/cases/48-dyn.sx` 与 `49-dyn-fn.sx`
 * 钉着这一族，后者的判据 4 与 5 就是照这两个例子的形状写的）。
 *
 * 拆箱得知道"箱子里装的是什么"，而图上没有类型。这一刀的答案是**按键查整张图**：
 * 凡是往这个键上写过的那几处值，类型一致就是它（`dynKeyType`），不一致、或者一处都
 * 没写过，就报缺口 —— 不猜。
 *
 * 为什么这是**事实**而不是猜：键在两边都是字面量（`map-set(Point, "total", …)` 与
 * `map-get(p, "total")`），所以"这个键上装的是什么"整张图上就写着。同一个键上真装两种
 * 东西时这一格答 null，落出来是一句有名有姓的缺口，而不是一个静默的错答案。
 *
 * 拆在**用它的地方**（算术的两边 · 被调者 · 字典的宿主），不是拆在 `dget` 那一刻：
 * 值位置上的 branch 要一格临时量，而 `(fnty …)` 那种类型没有零值可以初始化 ——
 * 让临时量装着 dyn、到用的时候再拆，两边都落得下去。
 */

/** 装进 dyn 的字典只有这一种（方言的 `boxable` 只认它 —— 别的值类型要按元素深装箱）。 */
const DYN_DICT = '(dict string dyn)';

/** 这一格类型能不能装进 dyn（四格标量 + 函数 + `(dict string dyn)`）。 */
const isBoxable = (t) => isScalar(t) || t === DYN_DICT
  || (typeof t === 'string' && t.startsWith('(fnty '));

/** 一格键字面量的文本（不是字面量回 null —— 那时按键查不了，报缺口）。 */
function keyLitOf(k) {
  if (isLit(k) && typeof k.lit === 'string') return k.lit;
  if (isNode(k) && k.op === 'const' && typeof k.attrs.value === 'string') return k.attrs.value;
  return null;
}

/** 一格值**装进 dyn 之后**箱子里那格的类型（函数看签名、字典一律 `(dict string dyn)`）。 */
function boxedTypeOf(v, env, ctx) {
  const ft = fnTypeOf(v, env, ctx);
  if (ft !== null) return ft;
  if (isNode(v) && v.op === 'map-new') return DYN_DICT;
  const t = typeOf(v, env, ctx);
  return dictOf(t) !== null ? DYN_DICT : t;
}

/** 这个键上装的是什么（整张图上凡是往它写过的那几处都问一遍）。说不清回 null。 */
function dynKeyType(k, env, ctx) {
  const sites = ctx.dynSites.get(k);
  if (sites === undefined || sites.length === 0) return null;
  let out = null;
  for (const v of sites) {
    const t = boxedTypeOf(v, env, ctx);
    if (!isBoxable(t)) return null;
    if (out === null) out = t;
    else if (out !== t) return null;
  }
  return out;
}

/** 一格 dyn 表达式里装的是什么：`map-get` 按键查，branch 两支同型才算。 */
function dynTypeOf(x, env, ctx) {
  if (!isNode(x)) return null;
  if (x.op === 'branch') {
    const a = dynTypeOf(x.ins.then, env, ctx);
    const b = dynTypeOf(x.ins.else, env, ctx);
    return a !== null && a === b ? a : null;
  }
  if (x.op !== 'map-get') return null;
  const k = keyLitOf(x.ins.key);
  return k === null ? null : dynKeyType(k, env, ctx);
}

/** 一格表达式"看得见的类型"：dyn 的按键查出装的是什么（查不出还是 dyn）。 */
function seenType(a, env, ctx) {
  const t = typeOf(a, env, ctx);
  if (t !== 'dyn') return t;
  return dynTypeOf(a, env, ctx) ?? 'dyn';
}

/** 拆箱：`(asint …)` 那一族。`want` 还是 dyn 说明按键查不出来 —— 报缺口，不猜。 */
function unboxTo(text, want) {
  if (want === 'int') return `(asint ${text})`;
  if (want === 'real') return `(asreal ${text})`;
  if (want === 'bool') return `(asbool ${text})`;
  if (want === 'string') return `(asstr ${text})`;
  if (dictOf(want) !== null) return `(asdict ${want} ${text})`;
  if (typeof want === 'string' && want.startsWith('(fnty ')) return `(asfn ${want} ${text})`;
  return gap('说不清这格 dyn 里装的是什么（按键查不到一致的类型）—— 拆箱得知道拆成什么');
}

/**
 * 一格值当**引用**用时的文本（函数名 `(fnref …)`、聚合 `(var …)`、别的照 `expr`）。
 * 三处要它：装箱进 dyn、`ret` 交一格聚合回去、实参那一格（`argText` 自己那份等价的）。
 */
function refOrExpr(a, env, ctx) {
  const ft = fnTypeOf(a, env, ctx);
  if (ft !== null) return `(fnref ${a.attrs.name})`;
  const t = typeOf(a, env, ctx);
  /* **借来的那一格也走 `varOrCap`**：闭包体里那个名字要发 `(cap 名)`，发 `(var 名)` 的话
     方言当场报"未声明的变量 '__self'"（量出来的：ADR-0040 那格降回去的闭包
     `__box_Sphere__Shape____as_Sphere` 体里就一句 `ret __self`）。 */
  if (isNode(a) && a.op === 'ref' && isAggregate(t, ctx)) return varOrCap(a.attrs.name, ctx);
  return expr(a, env, ctx);
}

/**
 * `ret` 交回去那一格的文本：与 `refOrExpr` 同一条，外加**空引用按声明的返回类型落**。
 *
 * `return nil` 里那个 null 自己说不出类型，而 `expr` 对它答 `(int 0)` —— 于是
 * `(fn f () r1 (ret (int 0)))`，方言当场报"要返回 r1，给的是 int"（量出来的：ADR-0040 那格
 * 降回去的方法，别的类型那一份就是 `return nil`）。声明的返回类型在 `env` 的 `fn:名字` 上。
 */
function retValText(v, env, ctx) {
  if (isLitNull(v) && ctx.fnName !== null && ctx.fnName !== undefined) {
    const rt = env.get(`fn:${ctx.fnName}`);
    if (rt !== undefined && (isPtrRec(rt, ctx) || elemType(rt) !== null)) return `(null ${rt})`;
  }
  return refOrExpr(v, env, ctx);
}

/** 装箱：`(dyn E)`。装不进去的当场报（哪一格装不进也说清）。 */
function boxText(v, env, ctx) {
  const t = boxedTypeOf(v, env, ctx);
  if (!isBoxable(t)) {
    gap(`这一格装不进 dyn（量到的是 ${t}）—— 方言只收四格标量、函数与 ${DYN_DICT}`);
  }
  const inner = refOrExpr(v, env, ctx);
  /* 物化过的那一格（`(var map_tmp1)`）真实类型在 env 上 —— 字典字面量装箱要查这一句：
     `(dict string int)` 装不进 dyn（方言的 boxable 只认 `(dict string dyn)`）。 */
  const m = /^\(var ([A-Za-z_][\w$]*)\)$/.exec(inner);
  const at = m !== null ? (env.get(m[1]) ?? t) : t;
  if (dictOf(at) !== null && at !== DYN_DICT) {
    gap(`装进 dyn 的字典只收 ${DYN_DICT}（量到的是 ${at}）`);
  }
  return `(dyn ${inner})`;
}

/** 整张图上"往哪个键写过什么"（键 -> 那几处值节点）。按键拆箱靠它。 */
function collectDynSites(list) {
  const out = new Map();
  const add = (k, v) => {
    if (k === null || v === undefined || v === null) return;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(v);
  };
  walkCore(list, (n) => {
    if (n.op === 'map-set') add(keyLitOf(n.ins.key), n.ins.value);
    if (n.op === 'map-new') {
      const ks = argList(n, 'keys');
      const vs = argList(n, 'vals');
      for (let i = 0; i < ks.length && i < vs.length; i++) add(keyLitOf(ks[i]), vs[i]);
    }
  });
  return out;
}

/** 一格字典的值类型：全是同一格标量就是它，别的（混着、函数、字典）一律 dyn。 */
function mapValType(vals, env, ctx) {
  if (vals.length === 0) return null;
  const ts = vals.map((v) => boxedTypeOf(v, env, ctx));
  return ts.every((t) => t === ts[0] && isScalar(t)) ? ts[0] : 'dyn';
}

/**
 * 宿主那一格的字典类型（`{key, val}`）。**dyn 的先按键看穿一层** ——
 * lua 的 `a.__meta.__close` 头一跳取出来是一格箱子，里头装着另一格表。不是字典回 null。
 */
function hostDict(obj, env, ctx) {
  const t = typeOf(obj, env, ctx);
  const d = dictOf(t);
  if (d !== null) return d;
  if (t !== 'dyn') return null;
  const inner = dynTypeOf(obj, env, ctx);
  return inner === null ? null : dictOf(inner);
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

function stmtListIn(arr0, env, ctx) {
  /* **先把嵌套的数组摊平**：一格数组在语句位置上是**分组**，不是一层作用域
     （作用域在图上是显式的 `region`）。lua 的 `local a <close> = …` 落的就是一格
     `[bind, scope-exit]` 两件一组 —— 不摊平的话那格 scope-exit 掉进 `stmtIn` 的
     数组分支里，绕过下面这一整套出口动作的账，报"不在一层语句序上"。
     摊平之后它与外层的 bind 并排，出口动作也就落在**外层**那一层的末尾 ——
     那正是 lua 的语义（出了这个块才关，不是这一组结束就关）。 */
  const arr = arr0.flatMap((s) => (Array.isArray(s) ? s : [s]));
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
        /* **声明写着引用类型**（go 的 `var p *T` / `var s Shape`）：值是一格空引用，
           类型从 `tzero`（声明的零值）来 —— 见 nodes.js 上 `bind` 的那段账。
           这一支要在 `nullHint` 之前：那一格是"从第一处赋值猜"，声明摆在眼前时不该猜。 */
        const tz = x.attrs.tzero;
        if (tz !== undefined && tz !== null) {
          const tt = declTypeOfNode(tz, env, ctx);
          if (tt !== null && (isPtrRec(tt, ctx) || elemType(tt) !== null)) {
            return [bindLine(nm, tt, `(null ${tt})`, env, ctx)];
          }
        }
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
    /* **右边是一格聚合**（`n, f = n.Min(f), n.Max(f)` 落出来的 `n = __asn10_0`）：
     * 走 `aggValText` 而不是 `expr` —— 后者对"把记录整格当值用"一律报缺口，而那条规矩
     * 在**赋值**这一处是过严的：方言的 `(set x (var y))` 在两档上都已经是 go 要的语义，
     * 四条腿全量过（`tests/sexpr/cases/60-setagg.sx`）：
     *   - 值语义的结构体：**整格拷**（赋完再改源值，目标那一格不跟着变）—— go 的值赋值；
     *   - 引用语义的类：**拷句柄**（别名）—— go 的 `p = q`（`*T`）。
     * 所以这儿不必物化、不必逐字段抄，一句 `set` 就对。 */
    case 'set': return [`(set ${x.attrs.name} ${aggValText(x.ins.value, env, ctx)})`];
    case 'field-set': {
      const host = objText(x.ins.obj, env, ctx);
      /* **写进去的是一格聚合字面量**（`m.Triangles = make([]Tri, 2)` / `m.In = &Inner{…}`）：
         那几格在**表达式位置**上落不下去（记录要 `cnew` + 逐字段、数组要 `anew` + 一圈
         `apush`），所以先物化成一格临时名，再一句 `fldset` 把它交进去。 */
      const mk = isNode(x.ins.value) ? MATERIALIZE[x.ins.value.op] : undefined;
      const isFill = isNode(x.ins.value) && x.ins.value.op === 'prim'
        && x.ins.value.attrs.name === 'fill';
      if (mk !== undefined || isFill) {
        ctx.tmp = ctx.tmp + 1;
        const tn = `set_tmp${ctx.tmp}`;
        const pre = isFill ? bindFill(tn, x.ins.value, env, ctx)
          : mk(tn, x.ins.value, env, ctx);
        return [...pre, `(fldset ${host} ${x.attrs.field} (var ${tn}))`];
      }
      /* 别的一律一句 `fldset` —— 记录（类与结构体两档）、数组、字典、标量同形，
         **整格写**在方言里现成（判据：`(fldset (var t) v (var w))` 在类上成立）。 */
      return [`(fldset ${host} ${x.attrs.field} ${aggValText(x.ins.value, env, ctx)})`];
    }
    case 'index-set': {
      if (elemType(typeOf(x.ins.obj, env, ctx)) === null) {
        gap('往一格说不清形状的东西里按下标写（这一刀只接 list-new 绑出来的那格）');
      }
      return [`(aset ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.index, env, ctx)} ${aggValText(x.ins.value, env, ctx)})`];
    }
    case 'map-set': {
      const d = hostDict(x.ins.obj, env, ctx);
      if (d === null) {
        gap('往一格说不清形状的东西里按键写（这一刀只接 map-new 绑出来的那格）');
      }
      /* 异质字典（`(dict string dyn)`）：写进去的值**逐格装箱**。 */
      const v = d.val === 'dyn' ? boxText(x.ins.value, env, ctx) : aggValText(x.ins.value, env, ctx);
      return [`(dset ${objText(x.ins.obj, env, ctx)} ${expr(x.ins.key, env, ctx)} ${v})`];
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
      /* **交回去的是一格聚合 / dyn 就记一笔**（`ctx.rets`，给 `emitCore` 那一句用）：
         `retTypeOf` 跑得早，`ret (var p)` 那种它只能当 int —— 而这儿 env 上有 p 的真类型。 */
      if (ctx.fnName !== null && ctx.fnName !== undefined && v !== undefined && v !== null) {
        const rt0 = seenType(v, env, ctx);
        /* **多值那一格也要记**（`isAggregate` 把 `mN` 排在外头）：`retTypeOf` 跑在形参有
           类型之前，`return tmin, tmax` 两格局部量都被量成 int，于是函数**声明**成
           `m6=(int,int)` 而体里交出来的是 `m15=(real,real)` —— 方言当场骂
           "要返回 m6，给的是 m15"（pt 的 `Box.Intersect` 撞出来的）。这儿 env 上有真类型。 */
        if (isAggregate(rt0, ctx) || rt0 === 'dyn' || isMultiShape(rt0, ctx)) {
          ctx.rets.set(ctx.fnName, rt0);
        }
      }
      /* 多值：先把那格合成结构体拼出来（零值 + 逐个 fldset），再交回去。 */
      if (isNode(v) && v.op === 'values') {
        const b = buildValues(v, env, ctx);
        return [...b.out, ...pend, `(ret (var ${b.name})`.concat(')')];
      }
      if (pend.length === 0) {
        /* **交一格聚合回去**（lua 的 `Point.new` 返回它刚建的那格表）：与实参那一格同一条
           规矩 —— 图上是引用，方言里也是（字典/数组是句柄、记录是 `(ptr rN)`），所以走
           `refOrExpr` 绕过 `expr` 那道"整格当值用"的门。 */
        return [v === undefined || v === null ? '(ret)' : `(ret ${retValText(v, env, ctx)})`];
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
        return [`(apush ${objText(ps[0], env, ctx)} ${aggValText(ps[1], env, ctx)})`];
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
     （类字段与结构体字段两档都收），可 `record-new` 在表达式位置上落不下去，所以先把里头
     那格物化成一格临时名，再一句 `fldset` 交进去。
     递归是这儿展开的（`rec_tmpN` 逐层各一格），套几层都一样。
     **数组 / 字典当字段也是这一档**（go 的 `Mesh.Triangles []*Triangle`、`Buffer.Pixels`）：
     方言里它们是**句柄**（一个字），`(struct rN (f (arr T)))` 收得住（判据：`(class Box
     (items (arr int)) (ps (arr P)))` 在五条腿上都跑得动）。从前这一族**不报缺口、却给了
     错类型**：`typeOf(list-new)` 回 UNKNOWN=`int`，静静通过了"是不是标量"那道闸，于是
     `for _, t := range m.Triangles` 里的 `t` 成了 int（pt 整包的墙就是它）。 */
  const pre = [];
  const fieldText = [];
  const fzero = rec.attrs.fzero;
  const types = names.map((_, i) => {
    const v = vals[i];
    /* **字段写着 nil**（`Material{…, nil}` / `Hit{0, nil}`）：值是一格**空引用**，
       类型从 `fzero`（声明的零值）来 —— 见 nodes.js 上 `record-new` 的那段账。
       落 `(null rN)` 而不是那格"全是桩的零值记录"：后者让 `!= nil` 恒为真。 */
    const fz = Array.isArray(fzero) ? fzero[i] : undefined;
    if (isLitNull(v) && fz !== undefined && fz !== null) {
      const ft0 = declTypeOfNode(fz, env, ctx);
      if (ft0 !== null) {
        fieldText.push(`(null ${ft0})`);
        return ft0;
      }
    }
    if (isNode(v) && v.op === 'record-new') {
      ctx.tmp = ctx.tmp + 1;
      const tn = `rec_tmp${ctx.tmp}`;
      pre.push(...bindRecord(tn, v, env, ctx));
      fieldText.push(`(var ${tn})`);
      return env.get(tn);
    }
    /* **字段里是一格数组 / 字典字面量**：与上面那一支同一条 —— 先物化，再把句柄存进字段。
       类型走 `declTypeOfNode`（`typeOf` 对 `list-new` / `map-new` 答不出来）。 */
    if (isNode(v) && (v.op === 'list-new' || v.op === 'map-new')) {
      const at0 = declTypeOfNode(v, env, ctx);
      if (at0 === null) {
        gap(`记录的字段 '${names[i]}' 是一格${v.op === 'list-new' ? '列表' : '字典'}，可它的类型推不出来`);
      }
      ctx.tmp = ctx.tmp + 1;
      const tn = `agg_tmp${ctx.tmp}`;
      pre.push(...MATERIALIZE[v.op](tn, v, env, ctx));
      fieldText.push(`(var ${tn})`);
      return env.get(tn) ?? at0;
    }
    /* **字段里是 `make([]T, n)`**（图上是 `prim fill`）：与上面那一支同一条 —— 先物化
       （`bindFill`），再把句柄存进字段。`typeOf` 对 `prim fill` 走的是算术那一档、答 int，
       于是 `&T{make([]N, 0), 7}` 里 `Nodes` 落成 int，`t.Nodes[0].Axis` 报
       "在一格说不清形状的东西上取字段 'Axis'（一格 index-get 推出来是 int）"（量到过）。 */
    if (isNode(v) && v.op === 'prim' && v.attrs.name === 'fill') {
      ctx.tmp = ctx.tmp + 1;
      const tn = `agg_tmp${ctx.tmp}`;
      pre.push(...bindFill(tn, v, env, ctx));
      fieldText.push(`(var ${tn})`);
      return env.get(tn);
    }
    /* **字段里装着一格函数值**（go 的接口分派，ADR-0040；asy 的 `fill2 fill2;` 也是它）：
       类型是 `(fnty …)`，值是 `(fnref …)` / `(mkclo …)`。`typeOf` 对"函数名当值用"答不出来
       （env 上函数记在 `fn:` 那一格），所以要先问 `fnTypeOf`。 */
    {
      const ftv = fnTypeOf(v, env, ctx);
      if (ftv !== null) {
        fieldText.push(fnValText(v.attrs.name, env, ctx));
        return ftv;
      }
    }
    const t = typeOf(v, env, ctx);
    /* **字段值是一格"已经躺在某个名字里的记录"**（go 的 `Outer{&in, 3}` / `Outer{in, 3}`）：
       与上面那一支同一件事，只是不用先物化 —— 直接把那一格交进去（`objText` 是"记录当
       宿主用"的那条路，`expr` 在这儿会报"把记录整格当值用"）。一句 `fldset` 就够：
       引用语义的交一格句柄、值语义的整格抄，两档在方言里同形。
       量出来的必要性：pt 的 `Triangle{Material: &material, …}` 与任何
       `type Outer struct{ In *Inner }` 都落在这一支上，从前报"字段不是标量"。 */
    if (isRecType(t, ctx)) {
      fieldText.push(objText(v, env, ctx));
      return t;
    }
    /* **字段值是一格已经躺在某个名字里的数组 / 字典**：与记录那一支同一条（句柄一个字）。 */
    if (elemType(t) !== null || dictOf(t) !== null) {
      fieldText.push(objText(v, env, ctx));
      return t;
    }
    if (t !== 'int' && t !== 'real' && t !== 'bool' && t !== 'string') {
      gap(`记录的字段 '${names[i]}' 不是标量（方言的字段这一刀只收标量与另一格记录）`);
    }
    fieldText.push(null);
    return t;
  });
  const byval = rec.attrs.byval === true;
  const shape = shapeOf(names, types, false, ctx, byval);
  /* **两档**（`nodes.js` 的 `byval` 那一格）：
     - 引用语义（lua/js 的表、go 里有指针接收者的那些）：方言的**类** —— `(cnew rN)`。
       类的复制 = 两个名字指同一格，那正是图上记录的语义；
     - **值语义**（go 的 struct）：方言的**真结构体** —— `(new rN)`，**不进堆**。
       量出来的理由：go 的 `Vec{…}` 走引用那一档是每格一次 malloc，60M 次迭代
       13.9s vs go 原生 0.11s（×126），全花在分配上。
     两档的**字段写法同形**（`(fldset …)`）—— `pnew`/`pfield`/`pstore` 那一套撤了，
     见 `types.js` 的 `shapeType`。 */
  const out = [...pre, bindLine(nm, shape.tag,
    byval ? `(new ${shape.tag})` : `(cnew ${shape.tag})`, env, ctx)];
  for (let i = 0; i < names.length; i++) {
    out.push(`(fldset (var ${nm}) ${names[i]} ${fieldText[i] ?? expr(vals[i], env, ctx)})`);
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
  let vt = keys.length > 0 ? mapValType(vals, env, ctx) : null;
  /* **声明的键值类型优先**（`kzero` / `vzero`，有类型覆盖层 #40）：空字典的类型从
     字面量推不出来，而"往这一层里找第一处 map-set"找不到模块级那些（写在别的函数体里）。
     go 的 `var reg = map[string]*Node{}` 撞出来的。 */
  if (kt === null) {
    const kz = mp.attrs === undefined ? undefined : mp.attrs.kzero;
    const vz = mp.attrs === undefined ? undefined : mp.attrs.vzero;
    if (kz !== undefined && kz !== null && vz !== undefined && vz !== null) {
      kt = declTypeOfNode(kz, env, ctx);
      vt = declTypeOfNode(vz, env, ctx);
    }
  }
  if (kt === null) {
    const hint = mapHint(nm, ctx, env);
    kt = hint.key;
    vt = hint.val;
  }
  if (kt !== 'int' && kt !== 'string') gap(`字典的键只能是 int 或 string（量到的是 ${kt}）`);
  /* 值可以是标量、`dyn`，也可以是一格**引用语义的记录**（方言的类 —— 格子里躺一个句柄，
     与 `(arr 类名)` 那一格同一档）。go 的 `map[string]*Mesh` 那一族靠这一条。
     **值语义的结构体不收**：那要格子里就地躺一整块，而三条腿现在对不上（run-c 是拷贝、
     interp 与 js 是别名）—— 任务 #83。 */
  const clsVal = isPtrRec(vt, ctx);
  if (!clsVal && !isScalar(vt) && vt !== 'dyn') {
    gap(`字典的值只能是标量、dyn 或引用语义的记录（量到的是 ${vt}）`);
  }
  for (let i = 0; i < keys.length; i++) {
    if (typeOf(keys[i], env, ctx) !== kt) gap('字典字面量里的键类型不一样 —— 方言的字典是单态的');
    /* **值只在不是 dyn 时查同型**：dyn 那一档本来就是"这个键装数、那个键装函数"
       （异质字典，见上面 dyn 那一段）—— 逐格装箱，不必同型。 */
    if (vt !== 'dyn' && typeOf(vals[i], env, ctx) !== vt) {
      gap('字典字面量里的值类型不一样 —— 方言的字典是单态的');
    }
  }
  const dt = `(dict ${kt} ${vt})`;
  const out = [bindLine(nm, dt, `(dnew ${dt})`, env, ctx)];
  for (let i = 0; i < keys.length; i++) {
    const v = vt === 'dyn' ? boxText(vals[i], env, ctx) : expr(vals[i], env, ctx);
    out.push(`(dset (var ${nm}) ${expr(keys[i], env, ctx)} ${v})`);
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

/**
 * 空字典的类型从**这一层里所有的写**上取（lua / awk 那一档）。找不着就报缺口，不猜。
 *
 * **要看全部、不能只看第一处**：lua 的 `Point = {}` 接着 `Point.__index = Point` /
 * `function Point:total() …` —— 第一处写进去的是一格字典、后面几处是函数。只看第一处
 * 就会把这格字典说成 `(dict string (dict string dyn))`，然后在第二处写的地方硬错。
 * 全看一遍，混着就是 `dyn`（异质字典，见 dyn 那一段）。
 */
function mapHint(nm, ctx, env) {
  const keys = [];
  const vals = [];
  const seek = (x) => {
    if (Array.isArray(x)) {
      for (const y of x) seek(y);
      return;
    }
    if (!isNode(x)) return;
    if (x.op === 'map-set' && isNode(x.ins.obj) && x.ins.obj.op === 'ref'
      && x.ins.obj.attrs.name === nm) {
      keys.push(x.ins.key);
      vals.push(x.ins.value);
    }
    for (const k of Object.values(x.ins)) seek(k);
  };
  seek(ctx.scope);
  if (keys.length === 0) {
    gap(`空字典 '${nm}' 的键值类型推不出来（这一层里没有一处 map-set —— 图上没有类型）`);
  }
  const kt = typeOf(keys[0], env, ctx);
  for (const k of keys) {
    if (typeOf(k, env, ctx) !== kt) {
      gap(`空字典 '${nm}' 上几处写的键类型不一样 —— 方言的字典键是单态的`);
    }
  }
  return { key: kt, val: mapValType(vals, env, ctx) };
}

/**
 * `s[i:j]` —— **串上的切片在方言里本来就有**（`(ssub S 起点 长度)`），所以它是一格
 * 表达式，不走下面 `bindSlice` 那条"新建 + 一圈 apush"的消去规则。
 *
 * 不是串就回 null（列表那一档照旧走消去规则）。上界省掉时要用 `(slen …)` 补，
 * 那会把源那一格**发两遍** —— 所以只在源是一格名字时允许省（别的形状当场报，
 * 不静默地多跑一次调用）。
 */
function strSliceText(sl, env, ctx) {
  const obj = sl.ins.obj;
  if (typeOf(obj, env, ctx) !== 'string') return null;
  const noTo = sl.ins.to === undefined || sl.ins.to === null;
  if (noTo && !(isNode(obj) && obj.op === 'ref')) {
    gap('串上的切片省了上界，可源不是一格名字（补 `(slen …)` 会把它发两遍）');
  }
  const src = expr(obj, env, ctx);
  const from = sl.ins.from === undefined || sl.ins.from === null ? '(int 0)' : expr(sl.ins.from, env, ctx);
  const to = noTo ? `(slen ${src})` : expr(sl.ins.to, env, ctx);
  return `(ssub ${src} ${from} (bin "-" ${to} ${from}))`;
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
  /* **串上的切片**（`path[i:i+1]`）：一句就够，见 `strSliceText`。 */
  {
    const st = strSliceText(sl, env, ctx);
    if (st !== null) return [bindLine(nm, 'string', st, env, ctx)];
  }
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
 * **数组元素那一格的类型**（`fill` 与 `list-new` 两处共用）。
 *
 * ⚠️ `typeOf` **认不出一格 `record-new`**（`graph/types.js` 的 `inferType` 里没有它那一支），
 * 回的是 UNKNOWN = `int`。于是 `make([]V, n)` 从前静静地落成 `(arr int)`，
 * 后面 `s := vs[0]` 就成了 int —— 报「在一格说不清形状的东西上取字段 'X'」。
 * 记录的类型要问 `recordTypeOfNode`（它算形状但不发文本，算不出来回 null）。
 */
function elemTypeOfNode(x, env, ctx) {
  if (isNode(x) && x.op === 'record-new') return recordTypeOfNode(x, env, ctx);
  /* **元素自己是一格列表**（`[][]int{…}`）：`typeOf` 答不出 `list-new` 的类型（回
     UNKNOWN=int），于是 `(arr (arr int))` 会静静落成 `(arr int)` —— **元素类型错而
     不报**。照 `declTypeOfNode` 的同一条规矩往里问一层：有元素看第一格，空表看
     声明的 `elem`。 */
  if (isNode(x) && x.op === 'list-new') {
    const items = argList(x, 'items');
    const el = items.length > 0 ? items[0] : (x.attrs === undefined ? null : x.attrs.elem);
    if (el === null || el === undefined) {
      gap('一格空列表当另一格列表的元素（元素类型推不出来、也没有声明的元素类型）');
    }
    return `(arr ${elemTypeOfNode(el, env, ctx)})`;
  }
  return typeOf(x, env, ctx);
}

/**
 * **这一格是"某个类型的零值"吗**（`fill` 的快路与 `bindFill` 都问它）。
 *
 * 只认结构上摆明的零：零字面量、套在 `conv` 里的零、字段全是零的记录、空列表。
 * 认不出来一律回 false —— 那时照旧走"一圈 apush"那条慢路，不会答错。
 */
function isZeroValueNode(x) {
  if (x === undefined || x === null) return false;
  /* 字面量是 `{ lit: 值 }`（`graph.js` 的 `lit`），不是一格节点 —— 先认它。 */
  if (!isNode(x)) {
    if (typeof x !== 'object' || !('lit' in x)) return false;
    const v = x.lit;
    return v === 0 || v === 0n || v === false || v === '';
  }
  if (x.op === 'const') {
    const v = x.attrs.value;
    return v === 0 || v === 0n || v === false || v === '';
  }
  if (x.op === 'conv') return isZeroValueNode(x.ins.value);
  if (x.op === 'record-new') return argList(x, 'fields').every(isZeroValueNode);
  if (x.op === 'list-new') return argList(x, 'items').length === 0;
  return false;
}

/**
 * `let xs = fill(n, 零值)` —— **按长度造一格列表**（第 25 格内建）。
 *
 * **初值正好是那格类型的零值**时一句 `(anew T N)` 就够 —— 方言的 `anew` 本来就是
 * "新建长度 N 的零数组"。go 的 `make([]float64, n)` 就是这一种，pt 里所有的像素缓冲
 * 也都是。为什么要单挑这一档（量出来的）：4M 格走 `apush` 是 4M 次调用加十几趟扩容
 * 拷贝，而 `anew` 是一次分配。
 *
 * 初值**不是**零值时才走与 `slice` 同一条消去规则：新建一格空数组 + 一圈 `apush`。
 * 元素类型从那格初值推（只接标量 —— `prims.js` 里 `fill` 本来就不许拿聚合当初值：
 * 那样 n 格会指向同一格）。长度可以是任意表达式（`(alen …)` / 变量都行）。
 *
 * 只接**绑定位置**：表达式位置上摆不进一圈循环 —— 那时 `expr` 那边照旧报缺口
 * （`PRIMS_OK` 里没有 `fill`，所以那一格是有名有姓的）。
 */
/**
 * **这格类型当数组元素，方言收得住吗**。
 *
 * 方言的 `(arr 元素)` 收 int / real / bool / string / `(vec T N)` / **类名** / 结构体名 /
 * `(arr …)` / `(fnty …)`（`sexpr/lower.js` 的 `ty` 那一格）—— 引用语义的记录现在发成
 * **类**（见 `types.js` 的 `shapeType`），所以 `[]*Triangle` 那一族就是 `(arr rN)`，收得住。
 * 留着这一格是为了：万一哪天又冒出一种别的表示，报的是一句有名有姓的话而不是坏 sx。
 */
function arrElemOk(et, ctx) {
  if (typeof et === 'string' && et.startsWith('(ptr ')) {
    gap(`数组的元素是 ${et} —— 方言的 \`(arr 元素)\` 不收 \`(ptr …)\``);
  }
}

function bindFill(nm, pr, env, ctx) {
  const args = argList(pr, 'args');
  if (args.length !== 2) gap(`内建 fill 收了 ${args.length} 格实参（要两格）`);
  const et = elemTypeOfNode(args[1], env, ctx);
  /* 元素是记录 —— **值语义与引用语义都收**：前者 `(anew (arr rN) N)` 就地铺 N 格零结构体、
     后者铺 N 格空指针，两样都正是 go 的 `make([]T, n)` / `make([]*T, n)`。 */
  const recElem = et !== null && isRecType(et, ctx);
  /* **零值的聚合初值现在收了**：`(anew T N)` 的 N 份零值互不共享（`arrNew` 按元素的
     拷贝器逐格拷，`tests/sexpr/cases/50-arrstruct.sx` 钉着）—— 从前那句"聚合初值会让
     n 格指向同一格"正是拷贝器那一刀解掉的。非零的聚合初值照旧不收：那要真发一圈拷贝。 */
  if (recElem) {
    arrElemOk(et, ctx);
    /* **元素是引用语义的记录（类）时不问初值**：`(anew (arr rN) n)` 铺的是 n 格**空引用**
       （见 `sexpr/lower.js` 的 arrExpr —— 行的零值是空引用，空引用没法共享），而 go 的
       `make([]*T, n)` / `make([]Shape, n)` 给的正是 n 格 nil。值语义那一档才要问初值：
       那时格子里就地躺一整块，`(anew T n)` 按元素的拷贝器逐格拷，非零的初值要真发一圈拷贝。
       量出来的：pt 的 `make([]Shape, len(m.Triangles))` —— 接口的零值是"全是桩的记录"，
       结构上不是零，可它在 `(arr 类名)` 上根本用不着。 */
    if (!isPtrRec(et, ctx) && !isZeroValueNode(args[1])) {
      gap(`fill 的初值是一格**非零**的记录（这一刀只接零值的聚合初值）`);
    }
    return [bindLine(nm, `(arr ${et})`, `(anew (arr ${et}) ${expr(args[0], env, ctx)})`, env, ctx)];
  }
  if (!isScalar(et)) gap(`fill 的初值不是标量、也不是值语义的记录（量到的是 ${et}）`);
  const at = `(arr ${et})`;
  const n = expr(args[0], env, ctx);
  const v = expr(args[1], env, ctx);
  if (isZeroText(et, v)) return [bindLine(nm, at, `(anew ${at} ${n})`, env, ctx)];
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
 * **这句方言文本是不是那格类型的零值**（`bindFill` 的快路判据）。
 *
 * 除了 `zeroText` 给的那一句，还认**转一层的零**：go 的 `make([]float64, n)` 里
 * 那格零值在图上是 `conv('float', 0)`，落出来是 `(toreal (int 0))`。
 */
function isZeroText(t, v) {
  if (v === zeroText(t)) return true;
  return t === 'real' && (v === '(toreal (int 0))' || v === '(real 0)');
}

/**
 * `let xs = [1,2,3]` —— 方言里是 `(anew (arr T) 长度)` 再逐格 `(aset …)`。
 * 元素类型从第一格元素推，剩下的必须一致（不一致当场报 —— 方言的数组是单态的）。
 *
 * **空列表**（`var xs []T`）的元素类型只能从 `elem` 那一格来（声明的类型，
 * 见 nodes.js 上 `list-new` 的那段话）；没有 `elem` 就照旧报缺口。
 *
 * 元素可以是**标量**，也可以是**值语义的记录**（byval，落成 `(arr rN)`）——
 * go 的 `[]Sphere` / pt 的 `[]Shape`、`Buffer.Pixels` 全是后者。引用语义的记录
 * （`(ptr rN)`）不收：方言里没有 `(arr (ptr rN))` 这一形。
 */function bindList(nm, lst, env, ctx) {
  const items = argList(lst, 'items');
  const decl = lst.attrs === undefined ? undefined : lst.attrs.elem;
  if (items.length === 0 && (decl === undefined || decl === null)) {
    const wh = (ctx.fnName === null || ctx.fnName === undefined) ? '' : `，在 '${ctx.fnName}' 的体里`;
    gap(`一格空列表（元素类型推不出来、也没有声明的元素类型）—— 绑给 '${nm}'${wh}`);
  }
  const ts = items.map((it) => elemTypeOfNode(it, env, ctx));
  let et = items.length === 0 ? elemTypeOfNode(decl, env, ctx) : ts[0];
  /**
   * **无类型整数常量在 real 的上下文里就是 real**（go 语言规范的无类型常量规则；
   * 与下面 `numWant` 给 `bin` 做的"把矮的那边抬上去"是同一条）。两处来源：
   *   - **声明的元素类型**：`[128]float64{0, 1.7290404664e-09, …}` 第一格写成 `0`；
   *   - **别的元素**：没有声明时，只要有一格是 real，整张表就是 real。
   *
   * 为什么非补这一条不可（量出来的）：真 go 标准库的 `math/rand` 里 `normal.go` / `exp.go`
   * 那几张 128/256 格的表全是这个写法，于是 `--pkgs $GOROOT/src/math/rand` 编到这儿一律
   * `列表里的元素类型不一样（int / real / real / …）—— 方言的数组是单态的`。
   */
  if (items.length > 0 && decl !== undefined && decl !== null) {
    if (elemTypeOfNode(decl, env, ctx) === 'real') et = 'real';
  }
  if (et === 'int' && ts.some((t) => t === 'real')) et = 'real';
  /** 这一格是"抬上去"的那一格吗（int 的值进 real 的表）。 */
  const lift = (i) => et === 'real' && ts[i] === 'int';
  /* 元素可以是标量、**值语义的记录**（`(arr rN)`，一格一整块），也可以是**引用语义的
     记录**（`(arr (ptr rN))`，一格一个指针 —— go 的 `[]Shape` 与 `[]*Mesh` 那一族）。 */
  const recElem = isRecType(et, ctx);
  if (recElem) arrElemOk(et, ctx);
  /* 元素也可以**再是一格数组**（`[][]int` / `[][]float64`）—— 方言的 `(arr (arr int))`
     现成（判据：`(aget (aget …) …)` 与 `(alen (aget …))` 都成立）。 */
  const arrElem = typeof et === 'string' && et.startsWith('(arr ');
  if (!recElem && !arrElem && et !== 'int' && et !== 'real' && et !== 'bool' && et !== 'string') {
    gap(`列表的元素不是标量、也不是记录或数组（量到的是 ${et}）`);
  }
  if (ts.some((t, i) => t !== et && !lift(i))) {
    gap(`列表里的元素类型不一样（${ts.join(' / ')}）—— 方言的数组是单态的`);
  }
  const at = `(arr ${et})`;
  const out = [bindLine(nm, at, `(anew ${at} (int ${items.length}))`, env, ctx)];
  for (let i = 0; i < items.length; i++) {
    /* **一格记录变量当元素**（go 的 `[]Hit{h1, h2}` / `[]Vector{a, b}`）：走 `aggValText`
       而不是 `expr` —— 后者对"把记录整格当值用"一律报缺口，而那条规矩在这儿不适用：
       元素类型就在 `(arr rN)` 上写着（与 `index-set` 那一处同一条账，见 `aggValText`）。 */
    const v = aggValText(items[i], env, ctx);
    out.push(`(aset (var ${nm}) (int ${i}) ${lift(i) ? `(toreal ${v})` : v})`);
  }
  return out;
}


/**
 * **一格函数名当值用**：普通函数是 `(fnref 名)`，**闭包**是 `(mkclo 名 借来的那几格…)`。
 *
 * 借来的那几格的**类型**只有这儿知道（它们是外层那个函数的局部量），而 `(cfn …)` 的
 * 声明落在别处（`emitFn`）—— 所以顺手记到 `ctx.capTypes` 上。两趟空跑（`ctx.collect`）
 * 排在真落之前，于是 `emitFn` 那时查得着；查不着就退回 int（与形参那一格同一条规矩）。
 */
function fnValText(nm, env, ctx) {
  const caps = ctx.clos.get(nm);
  if (caps === undefined) return `(fnref ${nm})`;
  const as = caps.map((c, i) => {
    const t = env.get(c);
    if (t === undefined) {
      gap(`闭包 '${nm}' 借的 '${c}' 在这一层看不见（借的是另一层的局部量）`);
    }
    if (isRecType(t, ctx) || elemType(t) !== null || dictOf(t) !== null) {
      /* 聚合按值抄一份在方言里就是抄那一格**句柄/指针**（`(ptr rN)` / `(arr T)` 都是
         一个字），所以"里头改了外头看得见"仍旧成立 —— go 的切片与指针正是这个语义。
         真正对不上的是**值语义的结构体**（byval）：那时抄的是一整格值。 */
      if (isRecType(t, ctx) && !isPtrRec(t, ctx) && !ctx.byCopy.has(nm)) {
        gap(`闭包 '${nm}' 借了一格值语义的结构体 '${c}'（按值抄一份与 go 的按引用捕获对不上）`);
      }
    }
    ctx.capTypes.set(`${nm}#${i}`, t);
    return `(var ${c})`;
  });
  return `(mkclo ${nm}${as.length === 0 ? '' : ` ${as.join(' ')}`})`;
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
 * **借了外层名字的也提**（第二刀）：那几格落成方言的**闭包** ——
 * `(cfn 名 (借来的…) (形参…) 返回类型 体)` 加用处那一格 `(mkclo 名 值…)`，体里读一格
 * 借来的东西是 `(cap 名)`。借的那几格**按值抄一份**：切片 / 指针 / 记录在方言里都是
 * 一个句柄，所以"里头改了外头看得见"仍旧成立（go 的切片与 `*T` 正是这个语义）；
 * 值语义的结构体与"外层后来又改了那格标量"两种对不上 go 的按引用捕获，
 * 前者当场报（`fnValText`），后者是**明写的不精确**（与 go 1.22 把循环变量改成每轮一格
 * 是同一类取舍）。
 *
 * `bind` 位置上的那种不走这儿：那一格 `liftBody` 早就接了（提升 = 闭包，见它的注）。
 */
function liftFnVals(fns, rest, known, taken, ctx) {
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
    const caps = capsOf(n.ins.body, new Set(ps), known);
    /* **写一格借来的东西**：按值抄一份的捕获写不回去，落下去就是静默的错答案。 */
    for (const c of caps) {
      if (setsNameIn(n.ins.body, c)) {
        gap(`内层函数往借来的 '${c}' 上写（按值抄一份的捕获写不回去）`);
      }
    }
    let nm = n.attrs.name === undefined || n.attrs.name === null
      ? `__fnval${extra.length}` : String(n.attrs.name);
    while (taken.has(nm)) nm = `${nm}$`;
    taken.add(nm);
    known.add(nm);
    /* `pzero` / `rzero` 跟着提上来（有类型覆盖层，见 `nodes.js` 的 func 那一格）：
       提上顶层之后这格函数就**没有调用点了**（它只当值用），形参与返回全靠声明。
       接口装箱那一族（ADR-0040）缺了它就报"要返回 int，给的是 real"。 */
    extra.push({ name: nm, params: ps, body: n.ins.body,
      ...(Array.isArray(n.attrs.pzero) ? { pzero: n.attrs.pzero } : {}),
      ...(n.attrs.rzero !== undefined ? { rzero: n.attrs.rzero } : {}),
      ...(n.attrs.noret === true ? { noret: true } : {}),
      ...(caps.length > 0 ? { caps } : {}) });
    if (caps.length > 0) ctx.clos.set(nm, caps);
    /* `bycopy`（有类型覆盖层那一族的附属，见 `nodes.js` 上 `func` 那格）：前端明说
       "这一格闭包**就是要按值抄一份**"。go 的接口装箱（ADR-0040）正是这个语义 ——
       `var s Shape = Sq{2}` 在 go 里把 Sq 抄进接口值。 */
    if (n.attrs.bycopy === true) ctx.byCopy.add(nm);
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
    globals: new Set(), fnEnv: null, fnParams: new Map(), fnPzero: new Map(), dynSites: new Map(), rets: new Map(),
    declared: new Map(),
    /* 并发那一档要往模块头上加的那几句（`(lib …)` / `(cabi …)`，见 `crtCall`）。
       与 `decls` 分开是因为次序：这几句要排在 `(struct …)` **前面**（读起来是"先说外面
       有什么，再说自己有什么"），而 `decls` 是落语句的时候一句一句长出来的。 */
    cdecls: [], cused: new Set(),
    /* 闭包那一族（`liftFnVals` 的第二刀）：`clos` 是"这个提上来的名字借了哪几格"，
       `capTypes` 是那几格的类型（只有 `mkclo` 那一处知道，见 `fnValText`），
       `caps` 是"现在正在落哪一格 cfn 的体"（体里读借来的东西要发 `(cap 名)`）。 */
    clos: new Map(), capTypes: new Map(), caps: null, byCopy: new Set(), recPend: new Map(),
    selfTok: new Map(), recFix: [], tokOf: new Map(), tokUsed: new Set(),
  };
  /* **运行时那几个 C 符号的返回类型**先摆进 env：调用点的 `inferType` 查的是 `fn:名字`，
     而它们在这份产物里没有函数体（体在 `libomnigo` 里），不走 `ctx.rets` 那一趟。 */
  for (const [nm, d] of C_RT) env.set(`fn:${nm}`, d.dty);
  /* go 的 `math.F(…)`（`GO_RMATH`）交出来的一律是 real。 */
  for (const nm of GO_RMATH.keys()) env.set(`fn:__goMath_${nm}`, 'real');
  /* 覆盖层（`types.js`）要问的那两件**后端自己的事**（见文件头那段 import 的注）：
     登记一格形状（顺带往模块头上印 `(struct rN …)`）、报一格有名有姓的缺口。 */
  ctx.shapeOf = (names, types, multi) => shapeOf(names, types, multi, ctx);
  /* **一格值的类型，`record-new` 也认**（`types.js` 的 `inferType` 里没有它那一支，
     回的是 UNKNOWN=int）。`multiShape` 要靠它才看得见 `return P{…}, true` 里
     第一格是个记录 —— 不然多值那格结构体的字段就成了 int，后面 `p.X` 报
     「在一格说不清形状的东西上取字段 'X'」。挂在 ctx 上是因为 `recordTypeOfNode`
     住在后端这一层（它要 `shapeOf` 去登记形状），而 `types.js` 不许反过来 import 它。 */
  ctx.valueTypeOf = (x, env) => elemTypeOfNode(x, env, ctx);
  ctx.gap = gap;
  /* 覆盖层问不了的第三件事（dyn 那一刀加的）：**一格 dyn 里装的是什么**。
     那是"按键查整张图"的事（后端自己的索引），覆盖层拿它答两处：`call` 的返回类型
     （被调的不是名字时）与 `map-get` 的宿主是一格箱子时。 */
  ctx.dynInside = (f, e) => dynTypeOf(f, e, ctx);
  /* 一、分两拨，并把**内层函数提到顶层**（lambda 提升，见 `liftBody`）。 */
  const raw = [];
  const rest0 = [];
  for (const it of list) {
    if (isNode(it) && it.op === 'bind' && isNode(it.ins.init) && it.ins.init.op === 'func') {
      const f = it.ins.init;
      raw.push({
        name: it.attrs.name,
        params: (f.attrs.params ?? []).map((p) => String(p)),
        /* `pzero` 要跟着一路带下来（有类型覆盖层，见 `nodes.js` 的 func 那一格）——
           `emitFn` 拿到的是这份记录，不是图上那个节点。 */
        ...(Array.isArray(f.attrs.pzero) ? { pzero: f.attrs.pzero } : {}),
        ...(f.attrs.rzero !== undefined ? { rzero: f.attrs.rzero } : {}),
        ...(f.attrs.noret === true ? { noret: true } : {}),
        body: f.ins.body,
      });
      continue;
    }
    rest0.push(it);
  }
  const taken = new Set(raw.map((f) => f.name));
  const modNames = new Set();
  for (const it of rest0) if (isNode(it) && it.op === 'bind') modNames.add(it.attrs.name);
  /* 不算捕获的那些：顶层函数名 + 顶层绑定的名字（后者落 `(global …)`，见 `bindLine`）
     + **运行时那几个 C 符号**（`C_RT`）。少了最后一批，一格 `go func(){ ch <- k }(i)`
     的体里那句 `ref __goChanSend` 会被当成"借了外层的名字"，于是 lambda 提升不动它，
     后面报"要一个具名函数" —— 量出来的（`/tmp/goclo.go` 那一份）。 */
  const known = new Set([...taken, ...modNames, ...C_RT.keys(),
    ...[...GO_RMATH.keys()].map((n) => `__goMath_${n}`)]);
  const fns = [];
  for (const f of raw) {
    const r = liftOne(f.body, f.name, known, taken, gap);
    for (const g of r.lifted) fns.push(g);
    fns.push({ name: f.name, params: f.params, ...(f.pzero ? { pzero: f.pzero } : {}),
      ...(f.rzero !== undefined ? { rzero: f.rzero } : {}),
      ...(f.noret === true ? { noret: true } : {}), body: r.body });
  }
  const topLift = liftOne(rest0, 'main', known, taken, gap);
  for (const g of topLift.lifted) fns.push(g);
  /* **函数值那一趟**：值位置上的匿名 `func` 提到顶层，原地换成一格 `ref`（见 `liftFnVals`）。 */
  const rest = liftFnVals(fns, topLift.body, known, taken, ctx);
  /* **按键装箱那张表**（见 dyn 那一段）：提升完了才收 —— 提升会把值位置上的 `func`
     换成一格 `ref`，而"这个键上装的是哪几格函数"要的正是换完之后那个名字。 */
  ctx.dynSites = collectDynSites([...fns.map((f) => f.body), rest]);
  /* 二、每格函数的返回类型与隐式返回 —— 互相递归（`fact` 调自己）要先登记上。 */
  /* 哪几个函数的返回值**被当值用过** —— 下面那格"没人要就是 void"要它（一次数清，
     两拨都要看：函数体里的调用点与顶层那几句）。 */
  const valueUsed = valueCalled([...fns.map((f) => f.body), rest]);
  /* 函数名 -> 形参名单（`fnTypeOf` 拿它拼 `(fnty …)`）。 */
  for (const f of fns) ctx.fnParams.set(f.name, f.params);
  for (const f of fns) if (Array.isArray(f.pzero)) ctx.fnPzero.set(f.name, f.pzero);
  for (const it of fns) {
      /* 前端声明的返回类型（`rzero` 是"那个类型的零值"，与 `pzero` 同一套路数）。
         算不出来 / 算出来是 `int`（= 说不清）就当没有。 */
      let declRet = null;
      if (it.rzero !== undefined && it.rzero !== null) {
        const dt = declTypeOfNode(it.rzero, env, ctx);
        if (dt !== null && dt !== 'int') declRet = dt;
      }

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
      /* **前端说了"一个返回值都没有"就别猜**（`noret`）：图上"体里没有 ret"与"隐式返回"
       * 同形，分不开 —— 所以只有**没人说**的时候才去问 `implicitRet`。
       * 量出来的：go 的 `func (r *Rand) Seed(seed int64) { r.src.Seed(seed) }` 被当成
       * "末尾那个值是返回值"，而那是一格 void 调用 ⇒ `要返回 int，给的是 void`。 */
      let impl = it.noret === true ? null : implicitRet(f.ins.body);
      if (impl !== null) {
        const penv = new Map(env);
        for (const p of params) penv.set(p, 'int');
        /* **探针不许报缺口**：`penv` 把每个形参都当 int（这一趟还不知道真类型），
           于是体末尾是 `t.V1` 那种时 `typeOf` 会骂"int 上没有字段" —— 那不是缺口，
           是探针自己问错了。问不出来就当"末尾那格不是返回值"。 */
        let t;
        try { t = typeOf(impl, penv, ctx); } catch { t = 'void'; }
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
        && !endsWithRet(it.body) && !valueUsed.has(it.name) && retsPure(it.body)
        && declRet === null) {
        rt = 'void';
        it.void = true;
      }
      /* **声明的返回类型最后说话**（`rzero`，见 `nodes.js` 的 func 那一格）。
       * 量出来的症状：`func (t *Triangle) SumX() float64` 的体里返回的是几个字段相加，
       * 而 `retTypeOf` 只看字面量、给出 `int` —— 方言当场报"要返回 int，给的是 real"。
       * 与形参那一格同一条纪律：**声明的优先、推出来的兜底**（算出来是 `int` 就让位，
       * 因为 `int` 既可能是真 int 也可能是"说不清"）。 */
      env.set(`fn:${it.name}`, declRet ?? rt ?? 'void');
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
  /* **main 也先空跑一趟**（缺口忽略、文本丢掉）。两件事只有跑过一趟才知道：
   *   一、模块级变量的类型进 `ctx.fnEnv`（`bindLine` 那一句）—— 函数体里要用；
   *   二、`ctx.rets`：**一格函数交回来的是不是聚合**。`retTypeOf` 只看得懂字面量与固定
   *       那几格（它跑得早，问不了 env），`ret (var p)` 那种一律当 int —— 而 lua 的
   *       `Point.new` 交回来的是它刚建的那格表。谁调它谁就得知道那是个字典，而调用点
   *       多半在 main 里，所以这一趟得排在 main 出真文本之前。
   * 临时量的编号在这一趟之后**归零** —— 那样出来的文本与没有这一趟时逐字节相同。 */
  ctx.collect = true;
  try {
    stmtList(rest, new Map(env), ctx);
  } catch (err) {
    if (!(err instanceof Gap)) throw err;
  }
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
  /* 走两遍：第一遍里被调者的形参还按 int，于是**调用者自己的形参**也只能按 int 记；
   * 第二遍那几格已经有具体类型了，往下传一层就对了（`go+method` 的 `scaled` -> `total`
   * 正是这种两层）。两遍够不够：够不够都不出错 —— 记不上的那一格照旧按 int，然后报缺口。 */
  /* 走到**不动点**：每一遍里被调者的形参可能刚有了具体类型，于是调用者往下传一层才对
   * （`go+method` 的 `scaled` -> `total` 是两层）。从前写死两遍，而层数是**程序决定的** ——
   * `sort.Float64s` -> `quick` -> `insertion` 是三层，第三层的形参于是一直按 int，
   * 报"在一格说不清形状的东西上取下标"。
   *
   * 判据是 `ctx.args`（形参类型那张表）**不再变**：不变就说明再走一遍什么也收不到。
   * 上界 4 遍：链再长也够（`sort.Float64s` -> `quick` -> `insertion` 是三层），而每一遍
   * 都是**整份程序走一趟**，放宽到 8 遍量出来是"编一份 `math/rand` 要好几分钟"。
   * 到了上界就停 —— 收不齐的那一格照旧按 int，然后报缺口，与从前逐字相同。
   *
   * 为什么这样改仍旧逐字节相同：两遍就稳的程序里第三遍**收不到新东西**，登记处按形状
   * 去重，所以那一遍一格新声明都不发。 */
  const argsSig = () => {
    const ks = [...ctx.args.keys()].sort();
    return ks.map((k) => `${k}=${ctx.args.get(k)}`).join('\n');
  };
  let sig = argsSig();
  for (let round = 0; round < 4; round++) {
    for (const f of fns) {
      try {
        emitFn(f, fnEnv, env, ctx);
      } catch (err) {
        if (!(err instanceof Gap)) throw err;
      }
    }
    const next = argsSig();
    if (round >= 1 && next === sig) break;
    sig = next;
  }
  ctx.collect = false;
  /* 空跑那几趟量出来的返回类型**应到 `fn:` 上** —— 调用点靠它定型（`inferType` 的 call）。
     只应聚合与 dyn 那几档：标量那几格 `retTypeOf` 早就答对了，覆盖不覆盖都一样。 */
  for (const f of fns) {
    const t = ctx.rets.get(f.name);
    if (t === undefined || t === 'void') continue;
    if (!(isAggregate(t, ctx) || t === 'dyn' || isMultiShape(t, ctx))) continue;
    env.set(`fn:${f.name}`, t);
    fnEnv.set(`fn:${f.name}`, t);
  }
  ctx.tmp = 0;
  const mainStmts = stmtList(rest, env, ctx);
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
  return `${['(module', ...ctx.cdecls, ...ctx.decls, ...body].join('\n')}\n`;
}

/**
 * **自引用那一格的占位串**（go 的 `type Texture interface{ Pow(float64) Texture }`）。
 *
 * 一格记录的字段类型里提到**它自己**时，那格形状的标签得先有名字才说得出字段类型 ——
 * 典型的不动点。这儿的办法是：里层再进来时先回这个占位串，等外层把标签定下来
 * （`shapeOf`），再把字段类型与产物里那句 `(struct …)` 上的占位串换成真标签。
 * 只在**真的自引用**时走这一步（占位串不出现就一个字都不动），所以对别的语言是中性的。
 */
const SELF_TY = '__selfrec__';

/**
 * 一格 `record-new` 的**类型**（只算类型、不出文本）—— `paramTypes` 用它把前端声明的
 * 形参类型算出来。字段的判据与 `bindRecord` 那份一样（标量或另一格记录），
 * 差别是这儿**不报缺口**：算不出来就回 null，让调用方退回"从调用点推"。
 */
function recordTypeOfNode(rec, env, ctx) {
  const names = rec.attrs.names;
  if (!Array.isArray(names) || names.length === 0) return null;
  const vals = argList(rec, 'fields');
  if (vals.length !== names.length) return null;
  const byval = rec.attrs.byval === true;
  /* **自引用**（见 `SELF_TY`）：按"字段名单 + 值/引用"认 —— 同一格接口的零值记录处处同形，
     而里层那一格的字段值压根不用看（这儿就回了）。 */
  const nkey = `${byval ? 'v' : 'r'}|${names.join('|')}`;
  const pend = ctx.recPend.get(nkey);
  if (pend !== undefined) { ctx.tokUsed.add(nkey); return pend; }
  /* **一格占位串按"字段名单"起名**（不按遇到的次序编号）：
     一、互相引用（pt 的 `Hit.Shape Shape` 与 `Shape.Intersect(Ray) Hit`）时环上有**两格**
         记录，共用一个占位串会把里层那一格换成外层的标签 —— 量出来的是
         `(struct r1 (Shape r1) (T int))`：Hit 的 Shape 字段落成了 Hit 自己；
     二、名字**跟着字段名单走**所以处处相同 —— 带占位串的那把键于是也处处相同，
         `shapeOf` 一查就命中。按次序编号的话同一对环每遇到一次就多出一对形状
         （量出来：同一个 Hit/Shape 出了七对 r1/r2 … r20/r21）。 */
  const tok = `${SELF_TY}${nkey}__`;
  ctx.recPend.set(nkey, tok);
  let types = [];
  try {
    types = fieldTypesOfNode(names, vals, env, ctx, rec.attrs.fzero);
  } finally {
    ctx.recPend.delete(nkey);
  }
  if (types === null) return null;
  /* **环上的标签先卷回占位串再当键**（`canonRolled`）：不这么做的话同一对环从哪一格进去
     算出来的键就不一样（从 Hit 进：`Shape:r2`；从 Shape 进：`Shape:占位串`），于是同一对
     环每换一个入口就多出一对形状 —— 量出来是 r1/r2、r4/r5、r7/r8 三对，随后
     `要返回 r5，给的是 r8`。卷回去之后两个入口的键逐字相同。 */
  const ctypes = canonRolled(types, ctx);
  /* 先按（可能还带着占位串的）字段类型登记一格形状，要的只是它的标签；随后把**自己**那个
     占位串定下来，再把环上所有还带着占位串的形状换一遍。 */
  const at = ctx.decls.length;
  const shape = shapeOf(names, ctypes, false, ctx, byval);
  const self = shapeType(shape);
  ctx.selfTok.set(tok, self);
  const onCycle = ctypes.some((t) => typeof t === 'string' && t.includes(SELF_TY));
  /* **我也在环上**（要么我的占位串被借走过、要么我的字段里有别人的占位串）：把
     「标签 -> 占位串」记一笔，下一个入口进来时好把键卷成同一份。 */
  if (onCycle || ctx.tokUsed.has(nkey)) ctx.tokOf.set(self, tok);
  if (onCycle) ctx.recFix.push({ shape, names, at, byval });
  if (ctx.recFix.length > 0) fixSelfToks(ctx);
  return self;
}

/**
 * 把字段类型里**环上那几格的标签**换回它们的占位串（见 `recordTypeOfNode` 里那段账）。
 * 一趟过（一格合起来的正则 + 回调），所以换出来的占位串不会再被换第二遍。
 */
function canonRolled(types, ctx) {
  if (ctx.tokOf.size === 0) return types;
  const tags = [...ctx.tokOf.keys()].filter((t) => /^[rm][0-9]+$/.test(t));
  if (tags.length === 0) return types;
  const re = new RegExp(`\\b(?:${tags.join('|')})\\b`, 'g');
  return types.map((t) => (typeof t === 'string' && t.length > 0
    ? t.replace(re, (m) => ctx.tokOf.get(m)) : t));
}

/**
 * 把**已经定下来**的占位串在所有还带着占位串的形状上换掉：`shape.types`（下游查字段类型
 * 靠它）、`ctx.decls` 里那句 `(struct …)`，再按换过之后的键**补登记一份**
 * （别处算出来的字段类型里已经是真标签了 —— 不补这一笔，同一个接口在图上会多出一格内容
 * 完全相同的形状，量出来是 r1 与 r3，随后就是"形参在两处的类型不一样"）。
 *
 * 环上每解开一格就跑一趟：互相引用那一族里，里层（接口那格）先落完、而它的字段类型里写着
 * 外层（结构体那格）的占位串 —— 要等外层定下来才换得完。
 */
function fixSelfToks(ctx) {
  const subst = (t) => {
    let s = String(t);
    for (const [k, v] of ctx.selfTok) if (s.includes(k)) s = s.split(k).join(v);
    return s;
  };
  const left = [];
  for (const e of ctx.recFix) {
    const fixed = e.names.map((n) => subst(e.shape.types.get(n)));
    for (let i = 0; i < e.names.length; i++) e.shape.types.set(e.names[i], fixed[i]);
    const kw = e.byval ? 'struct' : 'class';
    const line = `  (${kw} ${e.shape.tag} ${e.names.map((n, i) => `(${n} ${fixed[i]})`).join(' ')})`;
    if (ctx.decls[e.at] !== undefined) ctx.decls[e.at] = line;
    ctx.byKey.set(shapeKey(e.names, fixed, false, e.byval), e.shape);
    if (fixed.some((t) => t.includes(SELF_TY))) left.push(e);
  }
  ctx.recFix = left;
}

/** `recordTypeOfNode` 的字段那一趟（拆出来是为了让自引用那一格的 try/finally 读得清）。 */
function fieldTypesOfNode(names, vals, env, ctx, fzero) {
  const types = [];
  for (let i = 0; i < names.length; i++) {
    const v = vals[i];
    /* **字段写着 nil**（`Material{…, nil}`）：空引用自己说不出类型，类型从**声明**来
       —— `record-new` 的 `fzero` 那一格（见 nodes.js 上那段账）。要摆在最前头：
       `typeOf(lit null)` 答的是 UNKNOWN=int，而那会让同一个结构体算出两格形状。 */
    const fz = Array.isArray(fzero) ? fzero[i] : undefined;
    if (isLitNull(v) && fz !== undefined && fz !== null) {
      const ft0 = declTypeOfNode(fz, env, ctx);
      if (ft0 !== null) {
        types.push(ft0);
        continue;
      }
    }
    if (isNode(v) && v.op === 'record-new') {
      const t = recordTypeOfNode(v, env, ctx);
      if (t === null) return null;
      types.push(t);
      continue;
    }
    let t = null;
    /* **字段里是一格数组 / 字典**（`Mesh.Triangles []*Triangle`）：句柄一个字，`(arr T)`
       这格类型 `typeOf` 答不出来（`list-new` 回 UNKNOWN=int），走 `declTypeOfNode`。 */
    /* `prim fill` 也算（`make([]T, n)` 当字段的初值 —— `&T{make([]N, 0), 7}`）：
       `typeOf` 对它走的是算术那一档，答 int。 */
    if (isNode(v) && (v.op === 'list-new' || v.op === 'map-new'
      || (v.op === 'prim' && v.attrs.name === 'fill'))) {
      const at = declTypeOfNode(v, env, ctx);
      if (at === null) return null;
      types.push(at);
      continue;
    }
    /* **字段里装着一格函数值**（接口的零值记录，ADR-0040）：`pzero` 这一路**没经过
       `liftFnVals`**，所以这儿看到的还是一格 `func` 节点 —— 签名从它自己的
       `pzero` / `rzero` 上算（与 `resolveParamTypes` 同一份规矩）。 */
    if (isNode(v) && v.op === 'func') {
      const ft = fnTypeOfFuncNode(v, env, ctx);
      if (ft === null) return null;
      types.push(ft);
      continue;
    }
    /* **字段里装着一格已经提上顶层的函数**（`ref 名字`）：`liftFnVals` 把接口零值记录里
       那几格桩提了上去，留在字段上的是一格 `ref` —— 而 `typeOf` 对"函数名当值用"答的是
       UNKNOWN=int。少了这一格，同一个接口就会算出两格形状：装箱那一份（没提上去，走上面
       那一支）是 `r1{Area: (fnty () int)}`，零值那一份是 `r3{Area: int}`，
       于是 `make([]Shape, n)` 与 `[]Shape{…}` 递给同一个函数就报"两处的类型不一样"。 */
    const fr = fnTypeOf(v, env, ctx);
    if (fr !== null) {
      types.push(fr);
      continue;
    }
    try { t = typeOf(v, env, ctx); } catch { return null; }
    if (t !== 'int' && t !== 'real' && t !== 'bool' && t !== 'string') return null;
    types.push(t);
  }
  return types;
}

/**
 * 一格**没提上顶层的 `func` 节点**的 `(fnty …)`：形参类型从 `pzero`、返回类型从 `rzero`。
 *
 * 只有"类型层"那一路会看到没提上去的 `func`（`pzero` / `rzero` 是**属性**，`liftFnVals`
 * 不走属性）。算不出来回 null —— 那时上一层退回"说不清"，不猜。
 */
function fnTypeOfFuncNode(n, env, ctx) {
  const pz = Array.isArray(n.attrs.pzero) ? n.attrs.pzero : [];
  const ps = (n.attrs.params ?? []).map((_, i) => {
    const z = pz[i];
    if (z === undefined || z === null) return null;
    return declTypeOfNode(z, env, ctx);
  });
  if (ps.some((p) => p === null)) return null;
  const rz = n.attrs.rzero;
  let rt = 'void';
  if (rz !== undefined && rz !== null) {
    rt = declTypeOfNode(rz, env, ctx);
    if (rt === null) return null;
  }
  return `(fnty (${ps.join(' ')}) ${rt})`;
}

/**
 * 一格函数的形参类型。
 *
 * **声明的优先，推出来的兜底**（有类型覆盖层，#40 的第一格真货）：
 *   1. `f.pzero[i]` —— 前端递过来的"这一格形参的零值"（只有 go 这条腿在发，见
 *      `ext/go/tograph.js` 的 `funcOf`）。记录走 `recordTypeOfNode`（顺带把
 *      `(struct rN …)` 登记进 `ctx`），别的走 `typeOf`。
 *   2. `ctx.args` —— 从**调用点**推（图上没有类型，这一直是这条腿唯一的来源）。
 *   3. 都没有：`int`（这条腿今天的口径）。
 *
 * 为什么 1 只在"算出来不是 int"时才作数：Go 的 `*T` 形参零值是 `null`，推出来就是
 * `int`（= 说不清），而那时调用点那儿是个真记录，第 2 条更准。反过来，方法只经接口分派
 * 调用时压根没有调用点，第 1 条是唯一的来源 —— pt 整包就卡在这一格上
 * （"在一格说不清形状的东西上取字段 'V1'（变量 t 推出来是 int）"，t 是 `*Triangle` 接收者）。
 */
function paramTypes(f, env, ctx) {
  return resolveParamTypes(f.name, f.params, f.pzero, env, ctx);
}

/** `paramTypes` 的本体。`fnTypeOf`（函数名当值用时的 `(fnty …)`）也走这一份 ——
 *  两处必须给出**同一个**答案，不然 `__goRegMethod` 那种"同一个形参收好几个函数值"的
 *  调用点就会报"两处的类型不一样"（量出来的：一处 `(fnty (int) int)`、
 *  另一处 `(fnty ((ptr r3)) int)`，差的正是这一份有没有看 `pzero`）。 */
/**
 * **一格 `pzero` / `rzero` 节点说的是什么类型**（算不出来回 null）。
 *
 * 三档：记录走 `recordTypeOfNode`（顺带登记形状）、列表走"元素的类型再包一层 `(arr …)`"
 * （`typeOf` 对 `list-new` 答不出来 —— `[]Shape` 那一族的形参就卡在这儿）、
 * 别的走 `typeOf`。
 */
function declTypeOfNode(z, env, ctx) {
  if (z === null || z === undefined) return null;
  if (isNode(z) && z.op === 'record-new') {
    try { return recordTypeOfNode(z, env, ctx); } catch { return null; }
  }
  if (isNode(z) && z.op === 'list-new') {
    const items = argList(z, 'items');
    const el = items.length > 0 ? items[0] : (z.attrs === undefined ? null : z.attrs.elem);
    const et = declTypeOfNode(el, env, ctx);
    return et === null ? null : `(arr ${et})`;
  }
  /* **`make([]T, n)`**（图上是 `prim fill(n, T 的零值)`）：类型是 `(arr T)`。
     少这一条的代价量到过：`&T{make([]N, 0), 7}` 里 `Nodes` 落成 **int**（`typeOf` 对
     `prim fill` 走的是算术那一档），于是 `t.Nodes[0].Axis` 报"在一格说不清形状的东西上
     取字段"、或者同一个 go 结构体算出两格形状。 */
  if (isNode(z) && z.op === 'prim' && z.attrs.name === 'fill') {
    const fa = argList(z, 'args');
    if (fa.length === 2) {
      try {
        const et = declTypeOfNode(fa[1], env, ctx);
        if (et !== null) return `(arr ${et})`;
      } catch { /* 说不清就往下走 */ }
    }
  }
  if (isNode(z) && z.op === 'func') return fnTypeOfFuncNode(z, env, ctx);
  try { return typeOf(z, env, ctx); } catch { return null; }
}

function resolveParamTypes(name, params, pzero, env, ctx) {
  const pz = Array.isArray(pzero) ? pzero : null;
  return params.map((p, i) => {
    const z = pz === null ? null : pz[i];
    if (z !== null && z !== undefined) {
      const t = declTypeOfNode(z, env, ctx);
      if (t !== null && t !== 'int') return t;
    }
    return ctx.args.get(`${name}#${i}`) ?? 'int';
  });
}

/** 一格 `(fn …)` 的文本。走两趟（见 `emitCore` 里那段），所以单独拎出来。 */
function emitFn(f, fnEnv, env, ctx) {
  const fenv = new Map(fnEnv);
  const pts = paramTypes(f, env, ctx);
  for (let i = 0; i < f.params.length; i++) fenv.set(f.params[i], pts[i]);
  const ps = f.params.map((p, i) => `(${p} ${pts[i]})`).join(' ');
  /* **借来的那几格**（闭包，见 `liftFnVals` 的第二刀）：类型从 `ctx.capTypes` 拿
     （`mkclo` 那一处记的），查不着退回 int —— 与形参那一格同一条规矩。
     体里读它们要发 `(cap 名)`，所以进体之前把名单挂到 `ctx.caps` 上。 */
  const caps = Array.isArray(f.caps) ? f.caps : null;
  const cts = caps === null ? [] : caps.map((_, i) => ctx.capTypes.get(`${f.name}#${i}`) ?? 'int');
  if (caps !== null) for (let i = 0; i < caps.length; i++) fenv.set(caps[i], cts[i]);
  const ret = env.get(`fn:${f.name}`) ?? 'int';  /* 隐式返回那一档：末尾那个值改写成 `(ret …)`（分支就把 ret 沉到两支里去 ——
     方言的 `if` 是语句，这样就不必有块表达式）。 */
  const arr = Array.isArray(f.body) ? f.body : (f.body === undefined || f.body === null ? [] : [f.body]);
  /* 隐式返回那一档：**在图上**把末尾那个值换成一格 `ret`，再照常落。
   * 为什么不在文本上特判：换成图之后 defer、物化、`(do …)` 那几趟全都照常生效 ——
   * 在文本上特判过一版（那时叫 `retify`）走不进 `stmtList`，region 里的出口动作就漏了。 */
  /* **返回值没人要的那个函数**（`f.void`，见 `emitCore` 里 `valueCalled` 那一段）：
     体里那几格 `ret x` 落成光秃秃的 `(ret)`。这一格进体之前挂上、出来还原。 */
  const outerVoid = ctx.voidFn;
  const outerName = ctx.fnName;
  const outerCaps = ctx.caps;
  ctx.voidFn = f.void === true;
  ctx.caps = caps === null ? null : new Set(caps);
  /* 现在落的是谁的体（`ret` 那一格要往 `ctx.rets` 上记一笔 —— 见那儿的注）。 */
  ctx.fnName = f.name;
  let fbody;
  try {
    fbody = f.impl === null || f.impl === undefined
      ? stmtList(f.body, fenv, ctx)
      : stmtList([...arr.slice(0, -1), retWrap(arr[arr.length - 1])], fenv, ctx);
  } finally {
    ctx.voidFn = outerVoid;
    ctx.fnName = outerName;
    ctx.caps = outerCaps;
  }
  /* **掉到函数尾**这件事不许糊：方言要求非 void 的函数每条路都有 `ret`，而图上"体末尾那个
   * 值就是返回值"（chez / sbcl 那两门）是合法的。补一格 `(ret 0)` 交上去 = 悄悄给错答案
   * —— 矩阵上量到过两次（chez+intmath 印 0/0、sbcl+blockret 末行印 0）。
   * 所以这儿只认"末尾就是 ret"那一种，别的当场报缺口。 */
  if (!endsWithRet(f.body) && ret !== 'void' && (f.impl === null || f.impl === undefined)) {
    gap(`函数 '${f.name}' 的体末尾不是 ret（隐式返回那一档 —— 补零值会给错答案）`);
  }
  for (let i = 0; i < f.params.length; i++) ctx.args.set(`emitted:${f.name}#${i}`, pts[i]);
  if (caps !== null) {
    const cs = caps.map((c, i) => `(${c} ${cts[i]})`).join(' ');
    return `  (cfn ${f.name} (${cs}) (${ps}) ${ret} ${fbody.join(' ')})`;
  }
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
    why: '聚合走的是"引用"那一条：当实参、当 `ret` 的值、装进一格 dyn 都行（三处都拼名字），'
      + '而**被 print、当值算术**那种说不清类型 —— 那时既没有目标类型也没有键可以查'
      + '（`objText` 与 `refOrExpr` 两处把门）',
    witness: () => program([
      node('bind', { init: node('record-new', { fields: [litNode(1)] }, { names: ['x'] }) }, { name: 'p' }),
      node('prim', { args: [node('ref', {}, { name: 'p' })] }, { name: 'print' }),
    ]),
  },
  {
    what: '同一个键上装着两种东西（按键拆箱查不到一致的类型）',
    why: '异质字典拆箱靠"按键查整张图"（见 dyn 那一段）—— 同一个键一处装数、一处装串时'
      + '这一问答不出来。**报缺口而不是挑一个**：挑一个就是把另一处静静地算错。'
      + '要接得在图上带着"这一格装的是什么"（那是映射那一侧的事，不是这份翻译的）',
    witness: () => {
      const dict = (v) => node('map-new', {
        keys: [litNode('k'), litNode('j')], vals: [v, node('func', { body: [] }, { params: [] })],
      });
      return program([
        /* 两格异质字典（值混着 -> `(dict string dyn)`），同一个键 `k` 一处装数、一处装串 */
        node('bind', { init: dict(litNode(1)) }, { name: 'm' }),
        node('bind', { init: dict(litNode('s')) }, { name: 'n' }),
        node('prim', {
          args: [node('prim', {
            args: [node('map-get', { obj: node('ref', {}, { name: 'm' }), key: litNode('k') }),
              litNode(1)],
          }, { name: '+' })],
        }, { name: 'print' }),
      ]);
    },
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



