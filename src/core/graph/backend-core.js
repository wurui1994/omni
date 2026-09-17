// src/core/graph/backend-core.js —— **图 -> 我们自己那门核心方言（sx）-> OIR**（第一百五十二片）
//
// ## 这一格与别的后端不同在哪
//
// wat / c / js 那三条腿都是"图直接落成那门语言的文本"。这一条落的是**我们自己的中间语言**
// （`sexpr/lower.js` 那份核心方言），于是往下**整条既有的路白得**：OIR -> js / c / wasm /
// llvm 四条腿、摇树、profile、REPL、错误模型。ADR-0037 §5.1 那两条路里的 **B 路**就是它 ——
// 「不新开一条路，就不会有两条路走散」（ADR-0034 那句话的同一条理由）。
//
// ## 这一刀故意只接一档：**整数、串、真假那三格标量**
//
// 图上**没有类型**（`nodes.js` 文件头第一条：type 不是节点），而核心方言是**有类型的**。
// 这中间那一格差不是"写多点代码"能糊过去的，所以这一刀的边界画得很清：
//
//   接：`const`（整/实/串/真假）· `ref` · `bind` · `set` · `prim`（算术 / 比较 / not /
//       len / print 单实参）· `branch` · `loop` · `loop-exit` · `region` · `ret` ·
//       `func`（顶层的）· `call`
//   不接（**有名有姓**，`can()` 逐格答、`Gap` 当场报）：记录 · 列表 · 映射 · 多值 ·
//       表示转换 · 切片 · scope-exit · 闭包（非顶层的 `func`）· 多实参 print
//
// 类型是**从字面量推**的（`typeOf`）：整数字面量给 `int`、带小数点给 `real`、串给 `string`、
// 真假给 `bool`；形参与返回**默认 int**，推不出来就当场报（不猜）。这一格是 ADR-0031
// 那张"方言的承载力"表要补的地方 —— 补齐之前，这一刀的覆盖就是这一档。

import { Gap } from './backend-wat.js';
import { declOf } from './nodes.js';
/* 证物那五份是**手搭的小图** —— 所以要 `node()` / `lit()` / `program()`（`node` 顺带查五栏）。 */
import { node, lit as litNode, program } from './graph.js';
import { sxTextToMod } from '../lang/sx.js';
import { interpret } from '../interp/eval.js';
import { setOutSink } from '../interp/builtin.js';

/** 这一刀接得住的节点。别的一律有名有姓地报缺口（`can` 那一问）。 */
const OPS = new Set(['const', 'ref', 'bind', 'set', 'prim', 'branch', 'loop', 'loop-exit',
  'region', 'ret', 'func', 'call']);

/** 这一刀接得住的内建（`prims.js` 里 16 格中的 14 格；`concat` 与多实参 print 还欠着）。 */
const PRIMS_OK = new Set(['+', '-', '*', '/', '%', '^', '<', '>', '<=', '>=', '=', '!=',
  'not', 'len', 'print']);

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
 * 一格**表达式**的类型（够这一刀用的那一档：字面量、名字、算子的结果）。
 * 名字的类型从 `env`（名字 -> 类型）里查；查不到当 `int` —— 形参默认 int 就是这一条。
 */
function typeOf(x, env) {
  if (isLit(x)) return litType(x.lit) ?? 'int';
  if (!isNode(x)) return 'int';
  if (x.op === 'const') return litType(x.attrs.value) ?? 'int';
  if (x.op === 'ref') return env.get(x.attrs.name) ?? 'int';
  if (x.op === 'prim') {
    const nm = x.attrs.name;
    if (nm === '<' || nm === '>' || nm === '<=' || nm === '>=' || nm === '=' || nm === '!=' || nm === 'not') return 'bool';
    if (nm === 'len') return 'int';
    /* 算术：任一边是 real 就 real（方言里 int 与 real 不隐式混算 —— 混着写它当场报，
       那正是我们要的：与 ADR-0031 §1 那一格"位宽写在类型上"同一条纪律）。 */
    const args = argList(x, 'args');
    return args.some((a) => typeOf(a, env) === 'real') ? 'real' : 'int';
  }
  if (x.op === 'call') {
    const f = x.ins.fn;
    const nm = isNode(f) && f.op === 'ref' ? f.attrs.name : null;
    return (nm !== null ? env.get(`fn:${nm}`) : null) ?? 'int';
  }
  if (x.op === 'branch') return typeOf(x.ins.then, env);
  return 'int';
}

/** 一格 `rest` 端口收成数组（图上一格与一串两种写法都有）。 */
function argList(n, port) {
  const x = n.ins[port];
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

const gap = (why) => { throw new Gap(`core 这条腿还没接：${why}`); };

/** 一格**表达式** -> 方言的文本。 */
function expr(x, env) {
  if (isLit(x)) return lit(x.lit);
  if (!isNode(x)) gap(`空的表达式（${JSON.stringify(x)}）`);
  if (!OPS.has(x.op)) gap(x.op);
  switch (x.op) {
    case 'const': return lit(x.attrs.value);
    case 'ref': return `(var ${x.attrs.name})`;
    case 'prim': {
      const nm = x.attrs.name;
      if (!PRIMS_OK.has(nm)) gap(`内建 ${nm}`);
      const args = argList(x, 'args');
      if (nm === 'not') return `(not ${expr(args[0], env)})`;
      if (nm === 'len') return `(slen ${expr(args[0], env)})`;
      if (nm === 'print') gap('print 出现在表达式位置上');
      if (args.length !== 2) gap(`${nm} 收了 ${args.length} 格实参（这一刀只接两格）`);
      return `(bin "${BINOP[nm]}" ${expr(args[0], env)} ${expr(args[1], env)})`;
    }
    case 'call': {
      const f = x.ins.fn;
      if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
      /* 被调的那格没有返回值（体里一格 ret 都没有）却出现在**值**的位置上 ——
       * 那正是"隐式返回"（chez / sbcl 体末尾那个值）。有名有姓地报，不糊。 */
      if (env.get(`fn:${f.attrs.name}`) === 'void') {
        gap(`把 '${f.attrs.name}' 当值用，可它体里一格 ret 都没有（隐式返回那一档）`);
      }
      return callText(x, env);
    }
    case 'branch':
      /* 方言里 `if` 是语句 —— 表达式位置上的 branch 这一刀不接（要块表达式，ADR-0031 §5）。 */
      return gap('branch 出现在表达式位置上（方言的块表达式还欠着）');
    default: return gap(`${x.op} 出现在表达式位置上`);
  }
}

/** `(call 名 实参…)` 的文本（"当值用"那道检查在 `expr` 里，语句位置上不查）。 */
function callText(x, env) {
  const f = x.ins.fn;
  if (!isNode(f) || f.op !== 'ref') gap('调一格不是名字的东西（函数值那一档）');
  const args = argList(x, 'args').map((a) => expr(a, env));
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
function stmt(x, env) {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x.flatMap((y) => stmt(y, env));
  if (!isNode(x)) return [`(expr ${expr(x, env)})`];
  if (!OPS.has(x.op)) gap(x.op);
  switch (x.op) {
    case 'bind': {
      const nm = x.attrs.name;
      const init = x.ins.init;
      if (isNode(init) && init.op === 'func') gap('函数值（非顶层的 func）');
      const t = typeOf(init, env);
      env.set(nm, t);
      return [`(let ${nm} ${t} ${expr(init, env)})`];
    }
    case 'set': return [`(set ${x.attrs.name} ${expr(x.ins.value, env)})`];
    case 'region': {
      /* **一格 region 就是一层作用域** —— 方言里那是 `(do …)`。摊平过一版，`nim+blockscope`
       * 当场红：两层各有一格 `x`，摊平之后就是"'x' 在这一层已经声明过了"。
       * 类型表也跟着分层（`new Map(env)`），不然里层那格的类型会漏到外层。 */
      const inner = new Map(env);
      return [`(do ${stmt(x.ins.body, inner).join(' ')})`];
    }
    case 'loop': {
      const body = stmt(x.ins.body, env);
      /* 步进那一格（`post`）在方言里没有对应物 —— 缀在体末尾就够（这一刀不接 `continue`
       * 与 `post` 同时出现的那种：那时缀在末尾会把步进跳掉，见 nodes.js 上那段）。 */
      const post = x.ins.post === undefined ? [] : stmt(x.ins.post, env);
      if (post.length > 0 && hasContinue(x.ins.body)) {
        gap('循环里同时有 continue 与步进（方言里得把步进抬出来，还没接）');
      }
      return [`(while ${expr(x.ins.cond, env)} (do ${[...body, ...post].join(' ')}))`];
    }
    case 'loop-exit': return [x.attrs.kind === 'continue' ? '(cont)' : '(brk)'];
    case 'branch': {
      const then = stmt(x.ins.then, env);
      const els = x.ins.else === undefined ? [] : stmt(x.ins.else, env);
      const head = `(if ${expr(x.ins.cond, env)} (do ${then.join(' ')})`;
      return [els.length === 0 ? `${head})` : `${head} (do ${els.join(' ')}))`];
    }
    case 'ret': {
      const v = x.ins.value;
      return [v === undefined || v === null ? '(ret)' : `(ret ${expr(v, env)})`];
    }
    case 'prim': {
      if (x.attrs.name !== 'print') return [`(expr ${expr(x, env)})`];
      const args = argList(x, 'args');
      if (args.length !== 1) gap(`print 收了 ${args.length} 格实参（方言的 print 只收一格）`);
      return [`(print ${expr(args[0], env)})`];
    }
    case 'call':
      /* **语句位置**上调一格没有返回值的函数是对的（go / V 那格 `(call main)` 就是）——
       * 所以这儿不走 `expr` 的那道"当值用"检查，自己拼。 */
      return [`(expr ${callText(x, env)})`];
    default: return [`(expr ${expr(x, env)})`];
  }
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
  const out = ['(module'];
  for (const f of fns) {
    const fenv = new Map(env);
    for (const p of f.params) fenv.set(p, 'int');
    const ps = f.params.map((p) => `(${p} int)`).join(' ');
    const ret = env.get(`fn:${f.name}`) ?? 'int';
    const body = stmt(f.body, fenv);
    /* **掉到函数尾**这件事不许糊：方言要求非 void 的函数每条路都有 `ret`，而图上"体末尾那个
     * 值就是返回值"（chez / sbcl 那两门）是合法的。补一格 `(ret 0)` 交上去 = 悄悄给错答案
     * —— 矩阵上量到过两次（chez+intmath 印 0/0、sbcl+blockret 末行印 0）。
     * 所以这儿只认"末尾就是 ret"那一种，别的当场报缺口。 */
    if (!endsWithRet(f.body) && ret !== 'void') {
      gap(`函数 '${f.name}' 的体末尾不是 ret（隐式返回那一档 —— 补零值会给错答案）`);
    }
    out.push(`  (fn ${f.name} (${ps}) ${ret} ${body.join(' ')})`);
  }
  const mainStmts = rest.flatMap((it) => stmt(it, env));
  out.push(`  (main ${mainStmts.join(' ')}))`);
  return `${out.join('\n')}\n`;
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

/** `can` 那一问：这格节点接不接得住（接不住给一句人话 —— 那句话就是账）。 */
export function coreCan(op) {
  if (OPS.has(op)) return true;
  if (declOf(op) === undefined) return `core 后端不认识这格节点：${op}`;
  return `core 这条腿还没接：${op}（这一刀只接整数 / 串 / 真假那一档标量，见 backend-core.js 的头）`;
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



