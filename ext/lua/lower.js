// ext/lua/lower.js —— 降级：**每个节点一小步**，落到 src/core 的核心方言（`.sx`）
//
// 这是第二条腿（DESIGN.md 第 9 节判据 3）。核心方言是**静态类型**的
// （`(fn f ((x real)) real …)`、`(let a real …)`），Lua 是动态的 —— 所以第一刀只收
// **静态说得清的那一片**，别的当场记账（`ACCOUNTS`），不硬凑：
//
//   收：数字（一律 real，Lua 的 number 就是 double）、字符串字面量、真假值、局部量、
//       算术/比较、`-`、括号、`if`/`while`/`repeat`/`for`（数值型）/`do`、
//       `local function` 与它的调用、`return`、`break`、`print`
//   记账：表、元表、全局名字、多返回值、闭包捕获、`..`、`and`/`or`（短路 + 真值观）、
//       `for in`、`goto`、方法调用、`...`、类型混着用
//
// 为什么这么切：这一刀的价值在**尺子**上 —— 同一段 Lua，`luajit` 跑一遍、
// `omni run` 跑一遍，输出必须逐字相同（`tests/run.js`）。收得少但两条腿对得上，
// 比收得多而对不上有用。账记在这儿，往后一条一条还。

/** 记的账。一条 = 一种"这一刀还降不了的东西"，`say` 是给人看的话。 */
export const ACCOUNTS = {
  'L-001': { say: '表（table）还没有：核心方言里要先有一格自己的对象表示' },
  'L-002': { say: '元表（metatable）还没有：`__index`/`__add` 那套分派表' },
  'L-003': { say: '全局名字还没有：Lua 里那是一次 `_ENV` 表查（只有 `print` 特例）' },
  'L-004': { say: '多返回值还没有：核心方言的 `ret` 只带一格' },
  'L-005': { say: '闭包捕获还没有：函数体里用了不属于它的局部量' },
  'L-006': { say: '`..` 还没有：字符串拼接要先有字符串运算' },
  'L-007': { say: '`and`/`or` 的两边要都是布尔：Lua 的 `a and b` 交出来的是**值**不是真假' },
  'L-008': { say: '`for … in` 还没有：它要迭代器协议（三件套）' },
  'L-009': { say: '`goto`/标签还没有：核心方言里没有任意跳转' },
  'L-010': { say: '方法调用（`o:m()`）还没有：它要表 + 隐形 self' },
  'L-011': { say: '`...` 还没有：变长参数要先有多值' },
  'L-012': { say: '类型混着用：这一格里同一个名字既是数又是别的' },
  'L-013': { say: '`nil` 还没有：核心方言里没有"空"这一格' },
  'L-014': { say: '`#`/`not` 还没有：它们的语义要真值观与表' },
  'L-015': { say: '`for` 的步长这一格还降不了' },
  'L-017': { say: '条件位置里这个值要真跑起来才知道真假（带调用的非布尔条件）' },
  'L-016': { say: '`%` 的两边不能有调用：它降下来要把两边各用两次（Lua 的 `%` 是向下取整的模）' },
};

/** 这个表达式里有没有函数调用（`%` 那一步要把操作数用两次，有副作用就不能这么降）。 */
function hasCall(n) {
  if (n === null || typeof n !== 'object') return false;
  if (n.kind === 'call' || n.kind === 'method-call') return true;
  return Object.values(n).some((v) => (Array.isArray(v)
    ? v.some(hasCall) : hasCall(v)));
}

class Refuse extends Error {
  constructor(id, at) {
    super(`${id}：${ACCOUNTS[id]?.say ?? '?'}`);
    this.name = 'Refuse';
    this.id = id;
    this.at = at;
  }
}

const no = (id, at) => { throw new Refuse(id, at); };

/** Lua 的数字一律落成 real；写成核心方言认的字面量。 */
const realOf = (text) => {
  const v = Number(text);
  if (!Number.isFinite(v)) no('L-012');
  return `(real ${Number.isInteger(v) ? `${v}.0` : String(v)})`;
};

/** 二元算符的对照表。不在表里的（`..`、`and`、`or`）各有自己的账。 */
const BIN = {
  '+': 'real', '-': 'real', '*': 'real', '/': 'real', '%': 'real', '^': 'real',
  '<': 'bool', '>': 'bool', '<=': 'bool', '>=': 'bool', '==': 'bool', '~=': 'bool',
};
const BIN_OP = { '~=': '!=', '==': '==' };

class Cx {
  constructor() {
    this.scopes = [new Map()];      // 名字 → 类型（'real'|'string'|'bool'）
    this.fns = new Map();           // 函数名 → {params:[名字], ret:类型|'void'}
    this.top = [];                  // 提到模块层的 (fn …)
    this.globals = new Map();       // 被函数体用到的**顶层** local → 提成模块级变量
    this.promote = new Set();       // 哪些顶层 local 该提（预扫一遍算出来）
    this.tmp = 0;
  }

  push() { this.scopes.push(new Map()); }

  pop() { this.scopes.pop(); }

  declare(name, type) { this.scopes[this.scopes.length - 1].set(name, type); }

  typeOf(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const t = this.scopes[i].get(name);
      if (t !== undefined) return t;
    }
    return undefined;
  }

  fresh(p) { this.tmp += 1; return `${p}${this.tmp}`; }
}

// ── 表达式：每个节点一小步，答 `{sx, type}` ──────────────────────────────────
const EXP = {
  number: (n) => ({ sx: realOf(n.value), type: 'real' }),
  string: (n) => ({ sx: `(str ${JSON.stringify(n.value)})`, type: 'string' }),
  true: () => ({ sx: '(bool true)', type: 'bool' }),
  false: () => ({ sx: '(bool false)', type: 'bool' }),
  nil: (n) => no('L-013', n),
  vararg: (n) => no('L-011', n),
  table: (n) => no('L-001', n),
  'method-call': (n) => no('L-010', n),
  index: (n) => no('L-001', n),
  'function-exp': (n) => no('L-005', n),
  lambda: (n) => no('L-005', n),
  paren: (n, cx) => exp(n.inner, cx),
  name: (n, cx) => {
    const t = cx.typeOf(n.value);
    if (t === undefined) no('L-003', n);
    return { sx: `(var ${n.value})`, type: t };
  },
  prefix: (n, cx) => {
    if (n.op !== '-') no('L-014', n);
    const a = exp(n.a, cx);
    if (a.type !== 'real') no('L-012', n);
    return { sx: `(un "-" ${a.sx})`, type: 'real' };
  },
  binop: (n, cx) => {
    if (n.op === '..') no('L-006', n);
    // `and`/`or`：两边都是布尔时就是核心方言的 `&&`/`||`（**量过短路**：右边带调用时
    // 不会跑，见 tests 里那个 boom 探针）。Lua 的 `a and b` 一般交出来的是**值**
    // （`x and 1` 给的是 1 不是真假），那种还降不了 —— 记 L-007。
    if (n.op === 'and' || n.op === 'or') {
      const la = exp(n.a, cx);
      const lb = exp(n.b, cx);
      if (la.type !== 'bool' || lb.type !== 'bool') no('L-007', n);
      return { sx: `(bin "${n.op === 'and' ? '&&' : '||'}" ${la.sx} ${lb.sx})`, type: 'bool' };
    }
    const kind = BIN[n.op];
    if (kind === undefined) no('L-012', n);
    const a = exp(n.a, cx);
    const b = exp(n.b, cx);
    if (kind === 'real' && (a.type !== 'real' || b.type !== 'real')) no('L-012', n);
    if (kind === 'bool' && a.type !== b.type) no('L-012', n);
    // 核心方言的 `^` 与 `%` **只对 int** 成立（尺子当场说的），而 Lua 的这两个是浮点的：
    //   `a ^ b` = pow(a, b)
    //   `a % b` = a - floor(a / b) * b   ← Lua 手册 §2.5.1（是**向下取整**的模，不是 fmod）
    // 后者要把两边各用两次，所以只在两边都没副作用时这么降，否则记一笔账。
    if (n.op === '^') return { sx: `(rmath "pow" ${a.sx} ${b.sx})`, type: 'real' };
    if (n.op === '%') {
      if (hasCall(n.a) || hasCall(n.b)) no('L-016', n);
      const q = `(rmath "floor" (bin "/" ${a.sx} ${b.sx}))`;
      return { sx: `(bin "-" ${a.sx} (bin "*" ${q} ${b.sx}))`, type: 'real' };
    }
    return { sx: `(bin "${BIN_OP[n.op] ?? n.op}" ${a.sx} ${b.sx})`, type: kind };
  },
  call: (n, cx) => {
    if (n.fn.kind !== 'name') no('L-005', n);
    const f = cx.fns.get(n.fn.value);
    if (f === undefined) no('L-003', n);
    if (f.params.length !== n.args.length) no('L-004', n);
    const args = n.args.map((a) => exp(a, cx));
    if (args.some((a) => a.type !== 'real')) no('L-012', n);
    if (f.ret === 'void') no('L-004', n);
    return { sx: `(call ${n.fn.value} ${args.map((a) => a.sx).join(' ')})`, type: f.ret };
  },
};

/**
 * 条件位置。Lua 的真值观是"只有 `nil` 与 `false` 假"，所以类型说得清的时候**静态就能定**：
 * 一个数、一个字符串放在条件里**永远为真** → 直接降成 `(bool true)`。
 * 只有"要跑起来才知道"的（带调用的非布尔条件）才记账。这一条是"处理好每个节点"的样子：
 * 不是把 `while`/`if`/`until` 各写一遍，而是把"条件"这一格处理对。
 */
function cond(n, cx) {
  const v = exp(n, cx);
  if (v.type === 'bool') return v.sx;
  if (hasCall(n)) no('L-017', n);
  return '(bool true)';
}

/**
 * 条件在**语句位置**上还可以再进一步：把它先算进一格临时量，再按真值观定真假。
 * 只在"这一格一轮只算一次"的地方这么干（`if`、`repeat…until`）；`while` 的条件每轮都要
 * 重算，那格仍旧记账（L-017）。答 `{pre, sx}`。
 */
function condStat(n, cx) {
  const v = exp(n, cx);
  if (v.type === 'bool') return { pre: [], sx: v.sx };
  if (!hasCall(n)) return { pre: [], sx: '(bool true)' };
  const t = cx.fresh('__c');
  return { pre: [`(let ${t} ${v.type} ${v.sx})`], sx: '(bool true)' };
}

function exp(n, cx) {
  const f = EXP[n.kind];
  if (f === undefined) no('L-012', n);
  return f(n, cx);
}

// ── 语句：每个节点一小步，答一串核心方言的语句 ───────────────────────────────
const STAT = {
  goto: (n) => no('L-009', n),
  label: (n) => no('L-009', n),
  'for-in': (n) => no('L-008', n),
  function: (n) => no('L-001', n),          // `function a.b()` 要表
  break: () => ['(brk)'],
  do: (n, cx) => [`(do ${inner(n.body, cx).join(' ')})`],
  local: (n, cx) => {
    const init = n.init ?? [];
    const asGlobal = cx.scopes.length === 1;    // 只有顶层那一层能提成模块级变量
    // 多个名字：Lua 先把右边**全部**算完再绑（`local` 的配方是 `['init','bind:names']`），
    // 而新名字右边压根看不见，所以一格一格降就够 —— 不用临时量。
    if (n.names.length > init.length) no('L-013', n);          // 少的那些是 nil
    // 右边有调用**不要紧**：名字与值一样多的时候，每一格都被截成一格（values.js 的规则 4），
    // 不牵涉展开。先前这儿一刀切成 L-004，把"单名字 + 调用"这种最常见的也拒了。
    const out = [];
    for (const [i, name2] of n.names.entries()) {
      const v = exp(init[i], cx);
      cx.declare(name2, v.type);
      if (asGlobal && cx.promote.has(name2)) {
        cx.globals.set(name2, v.type);
        out.push(`(set ${name2} ${v.sx})`);     // 声明搬到模块层，这儿只赋值
      } else {
        out.push(`(let ${name2} ${v.type} ${v.sx})`);
      }
    }
    // 多出来的右边照样要算（副作用），但值丢掉；纯的就直接不管。
    for (const e of init.slice(n.names.length)) {
      if (hasCall(e)) no('L-004', n);
      exp(e, cx);
    }
    return out;
  },
  assign: (n, cx) => {
    if (n.targets.some((t) => t.kind !== 'name')) no('L-001', n);
    if (n.targets.length !== n.values.length) no('L-004', n);
    if (n.values.some((e) => e.kind === 'call' && n.values.length > 1)) no('L-004', n);
    const ts = n.targets.map((t) => {
      const ty = cx.typeOf(t.value);
      if (ty === undefined) no('L-003', t);
      return { name: t.value, type: ty };
    });
    const vs = n.values.map((e) => exp(e, cx));
    for (const [i, v] of vs.entries()) if (v.type !== ts[i].type) no('L-012', n);
    if (ts.length === 1) return [`(set ${ts[0].name} ${vs[0].sx})`];
    // 多个目标：右边**全部先算**（`a, b = b, a` 要它），所以先落进临时量再一起写回。
    const tmps = ts.map(() => cx.fresh('__a'));
    return [
      ...vs.map((v, i) => `(let ${tmps[i]} ${ts[i].type} ${v.sx})`),
      ...ts.map((t, i) => `(set ${t.name} (var ${tmps[i]}))`),
    ];
  },
  'call-stat': (n, cx) => {
    const c = n.call;
    // `print` 是核心方言里现成的语句；别的调用用 `(expr …)` 丢掉返回值。
    if (c.kind === 'call' && c.fn.kind === 'name' && c.fn.value === 'print'
      && cx.typeOf('print') === undefined) {
      if (c.args.length !== 1) no('L-004', n);
      return [`(print ${exp(c.args[0], cx).sx})`];
    }
    if (c.kind !== 'call' || c.fn.kind !== 'name') no('L-010', n);
    const f = cx.fns.get(c.fn.value);
    if (f === undefined) no('L-003', n);
    if (f.params.length !== c.args.length) no('L-004', n);
    const args = c.args.map((a) => exp(a, cx));
    return [`(expr (call ${c.fn.value} ${args.map((a) => a.sx).join(' ')}))`];
  },
  return: (n, cx) => {
    const vs = n.values ?? [];
    if (vs.length > 1) no('L-004', n);
    if (vs.length === 0) return ['(ret)'];
    return [`(ret ${exp(vs[0], cx).sx})`];
  },
  if: (n, cx) => {
    // `elseif` 一层层套成 `if/else`（组合规则，不是新节点）
    const chain = (i) => {
      if (i >= (n.elifCond ?? []).length) {
        return n.else === undefined ? null : `(do ${inner(n.else, cx).join(' ')})`;
      }
      const c = condStat(n.elifCond[i], cx);
      const rest = chain(i + 1);
      const t = `(do ${inner(n.elifBody[i], cx).join(' ')})`;
      return `(do ${c.pre.join(' ')} (if ${c.sx} ${t}${rest === null ? '' : ` ${rest}`}))`;
    };
    const c = condStat(n.cond, cx);
    const els = chain(0);
    return [...c.pre,
      `(if ${c.sx} (do ${inner(n.then, cx).join(' ')})${els === null ? '' : ` ${els}`})`];
  },
  while: (n, cx) => {
    return [`(while ${cond(n.cond, cx)} (do ${inner(n.body, cx).join(' ')}))`];
  },
  repeat: (n, cx) => {
    // `repeat B until C` = `while true do B if C then break end end`
    // —— 这么写也顺手保住了那条例外：`C` 看得见 `B` 里的局部量（同一个 `(do)`）。
    cx.push();
    const b = block(n.body.stats, cx);
    const c = condStat(n.cond, cx);
    cx.pop();
    return [`(while (bool true) (do ${b.join(' ')} ${c.pre.join(' ')} (if ${c.sx} (do (brk)))))`];
  },
  'for-num': (n, cx) => {
    const from = exp(n.from, cx);
    const to = exp(n.to, cx);
    if (from.type !== 'real' || to.type !== 'real') no('L-012', n);
    // 步长的**正负决定比较方向**。字面量步长静态就知道方向；不是字面量的就把方向也算进
    // 循环条件里（`(st>0 and i<=lim) or (st<0 and i>=lim)`）—— 这一格现在两种都收，
    // 因为 `and`/`or` 那一刀落了，L-015 也就还上了。
    let stepSx = '(real 1.0)';
    let down = false;
    let dyn = false;
    if (n.step !== undefined) {
      const lit = n.step.kind === 'number' ? Number(n.step.value)
        : (n.step.kind === 'prefix' && n.step.op === '-' && n.step.a.kind === 'number'
          ? -Number(n.step.a.value) : null);
      if (lit === null) {
        const st2 = exp(n.step, cx);
        if (st2.type !== 'real') no('L-012', n);
        stepSx = st2.sx;
        dyn = true;
      } else {
        down = lit < 0;
        stepSx = realOf(String(lit));
      }
    }
    const lim = cx.fresh('__to');
    const st = cx.fresh('__st');
    const v = n.names[0];
    cx.push();
    cx.declare(v, 'real');
    const b = block(n.body.stats, cx);
    cx.pop();
    const up = `(bin "<=" (var ${v}) (var ${lim}))`;
    const dn = `(bin ">=" (var ${v}) (var ${lim}))`;
    const test = dyn
      ? `(bin "||" (bin "&&" (bin ">" (var ${st}) (real 0.0)) ${up})`
        + ` (bin "&&" (bin "<" (var ${st}) (real 0.0)) ${dn}))`
      : (down ? dn : up);
    return [
      `(let ${lim} real ${to.sx})`,
      `(let ${st} real ${stepSx})`,
      `(let ${v} real ${from.sx})`,
      `(while ${test} (do ${b.join(' ')} (set ${v} (bin "+" (var ${v}) (var ${st})))))`,
    ];
  },
  'local-function': (n, cx) => {
    const name = n.names[0];
    const params = (n.body.names ?? []);
    if (params.includes('...')) no('L-011', n);
    // 函数**先绑名字**（递归要它，与 scope.js 的配方一致），再看体。
    cx.fns.set(name, { params, ret: 'real' });
    const inner2 = new Cx();
    inner2.fns = cx.fns;
    inner2.top = cx.top;
    inner2.globals = cx.globals;
    inner2.promote = cx.promote;
    // 提上去的那些在函数里照样是 `(var name)`（模块级变量跨函数共享，量过：见 g.sx 那个探针）
    for (const [g, t] of cx.globals) inner2.declare(g, t);
    for (const p of params) inner2.declare(p, 'real');
    const body = block(n.body.body.stats, inner2);
    const ret = retTypeOf(n.body.body.stats, cx, params);
    cx.fns.set(name, { params, ret });
    const ps = params.map((p) => `(${p} real)`).join(' ');
    cx.top.push(`(fn ${name} (${ps}) ${ret}\n    ${body.join('\n    ')}${ret === 'void' ? '' : ''})`);
    return [];
  },
};

/** 函数返回什么类型：看它的 `return`（第一格说话；混着来就是一笔账）。 */
function retTypeOf(stats, cx, params) {
  const probe = new Cx();
  probe.fns = cx.fns;
  probe.globals = cx.globals;
  for (const [g, t] of cx.globals) probe.declare(g, t);
  for (const p of params) probe.declare(p, 'real');
  let t = null;
  const walk = (xs) => {
    for (const s of xs ?? []) {
      if (s === null || typeof s !== 'object') continue;
      if (s.kind === 'return') {
        const cur = (s.values ?? []).length === 0 ? 'void' : exp(s.values[0], probe).type;
        if (t !== null && t !== cur) no('L-012', s);
        t = cur;
        continue;
      }
      if (s.kind === 'local') STAT.local(s, probe);
      for (const k of ['body', 'then', 'else']) if (s[k]?.stats !== undefined) walk(s[k].stats);
      for (const b of s.elifBody ?? []) walk(b.stats);
    }
  };
  walk(stats);
  return t === null ? 'void' : t;
}

/**
 * 预扫一遍：**哪些顶层 local 被函数体用到了**。用到了就把它提成模块级变量
 * （核心方言的 `(global NAME TYPE)`），于是"函数看得见外面那一格"这件事不必等真闭包。
 *
 * 一条要紧的规矩：只算**声明在函数之前**的那些。Lua 里
 * `local function f() return x end local x = 1` 的 `x` 是全局（`_ENV.x`），不是后面那个 local
 * —— 顺序不看，就把语义悄悄改了。
 */
function capturedTops(stats) {
  const declaredAt = new Map();                 // 顶层 local 名 → 它在第几条语句
  for (const [i, st] of (stats ?? []).entries()) {
    for (const nm2 of st.kind === 'local' || st.kind === 'local-function' ? (st.names ?? []) : []) {
      if (!declaredAt.has(nm2)) declaredAt.set(nm2, i);
    }
  }
  const cap = new Set();
  const namesIn = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const x of node) namesIn(x, out); return out; }
    if (node.kind === 'name') out.push(node.value);
    for (const v of Object.values(node)) namesIn(v, out);
    return out;
  };
  const fnsIn = (node, out = []) => {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const x of node) fnsIn(x, out); return out; }
    if (node.kind === 'funcbody' || node.kind === 'lambda') out.push(node);
    for (const v of Object.values(node)) fnsIn(v, out);
    return out;
  };
  for (const [i, st] of (stats ?? []).entries()) {
    for (const fn of fnsIn(st)) {
      for (const nm2 of namesIn(fn)) {
        const at = declaredAt.get(nm2);
        if (at !== undefined && at < i) cap.add(nm2);
      }
    }
  }
  return cap;
}

/** 一个 block 洞：开一层作用域再降（作用域规矩与 scope.js 的配方同源）。 */
function inner(b, cx) {
  cx.push();
  const out = block(b.stats, cx);
  cx.pop();
  return out;
}

function block(stats, cx) {
  const out = [];
  for (const s of stats ?? []) {
    const f = STAT[s.kind];
    if (f === undefined) no('L-012', s);
    out.push(...f(s, cx));
  }
  return out;
}

/**
 * 把一段 Lua 降成核心方言的文本。答 `{text}`；降不了就抛 `Refuse`（带账号）。
 * 形状：`local function` 提到模块层的 `(fn …)`，其余语句进 `(main …)`。
 */
export function lower(ast, lang) {
  const cx = new Cx();
  cx.promote = capturedTops(ast.stats);
  const body = block(ast.stats, cx);
  const decls = [...cx.globals].map(([n, t]) => `(global ${n} ${t})`);
  const head = [...decls, ...cx.top].map((x) => `  ${x}`).join('\n');
  return {
    text: `(module\n${head}\n  (main\n${body.map((x) => `    ${x}`).join('\n')}))\n`,
  };
}

export { Refuse };
