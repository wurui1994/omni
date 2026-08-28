// Omni stage0 — asy 前端的**语句**这一族
//
// 从 lower.js 里搬出来的第四摊，拆法与 calls.js 同一条：第一个形参 `L` 就是那个降级器
// （原来的 `this`）。理由见 calls.js 的文件头。
//
// 这一摊管"一条语句怎么落地"：`write`（asyWriteStmt / asyFmtStr / asyWriteArrays —— 它在 asy
// 里是语句而不是表达式，所以归这儿）、分派（asyStmt / asyStmtOne / asyBody）、
// 三种循环（asyDoWhile / asyForEach / asyForStmt / asyForPart）、
// 变量声明（asyVardec）、表达式语句（asyExprStmt），以及赋值那一整套
// （asyAssign / asyAssignFld / asyAssignIndex / asyAssignStat —— 复合赋值与自增在这里
// 走的是同一个二元算符，见 asyAssign 尾巴上那一段）。
//
// 只往 calls.js 那一摊**单向**依赖（asyArgs / asyCall / asyOpUser / asyOpBuiltinSig），
// 反过来没有 —— 那一摊一个语句函数都不调，所以两个文件之间没有环。

import { isList, isAtom, head } from '../sexpr/read.js';
import {
  ASY_NOPE, DOT_BAD, CAP_BAD, ASY_ARRELEM_TEXT, ASY_FILLER, asyOpText, asyIsArr, asyElem, asyIsFn, asyFnSplit, asyFldSym, asyCore, ASY_NULL,
} from './types.js';
import { ZERO } from './runtime.js';
import { asyArgs, asyCall, asyOpUser, asyOpBuiltinSig, asyIdxOpCall, asyVisible, asyUserCall } from './calls.js';
import { asyNeedsBox } from './exprs.js';

/**
 * `write` 的重载是量出来的，形状是 `write(string s="", T x, T[] more..., suffix=endl)`：
 * 前缀 `s` 与第一个 T 之间**没有**分隔符，T 与 T 之间是制表符，而所有 T 必须**同型**。
 * 逐条量过（`asy -noV`，od -c 看字节）：
 *   write("a",1,2)        -> `a1\tab2`  ... 即 "a" "1" TAB "2"
 *   write("a","b","c")    -> `ab\tc`    ... 第一个串当前缀，后两个才是 T=string
 *   write("s",true,false) -> `strue \tfalse `
 *   write(1,"b",2)        -> no matching function 'write(int, string, int)'
 *   write("a","b",1)      -> no matching function（前缀吃掉 "a" 之后 T 定成了 string）
 *   write(true,"x")       -> no matching function（没有前缀，T 定成了 bool）
 * T 是**数组**时是另一条格式，见 writeArrays。
 */
export function asyWriteStmt(L, n) {
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  if (args.length === 0) return L.nope(n, '不带实参的 write');
  const vals = [];
  for (const a of args) {
    const v = L.expr(a);
    if (v === null) return null;
    if (v.type === 'void') return L.err(a, 'write 的实参不能是 void');
    // `write(null)`：null 没有类型，重载解析定不下 T。asy 那边报的就是
    // "call of function 'write(null)' is ambiguous"（量过）。拦在这一层，
    // 不然 `code` 是 null 的那个记号会漏成核心方言里的一处语法错。
    if (v.type === ASY_NULL) {
      return L.err(a, "write 的实参不能是 null —— null 没有类型，asy 那边报 "
        + "call of function 'write(null)' is ambiguous");
    }
    // 不定案的重载集同理（第三十五刀）：`write(both)` 在 asy 那边是
    // "no matching function 'write(<overloaded>)'" 加 "use of variable 'both' is
    // ambiguous"（量过）—— 没有目标类型可问，所以这里就是错。
    if (v.over !== undefined) {
      return L.err(a, `write 的实参不能是一个没定案的重载集（${v.type}）—— asy 那边报 `
        + "no matching function 'write(<overloaded>)'");
    }
    // asy 给 **transform** 印字（builtin.cc:861 的 addWrite<transform>，量过
    // `write(shift(3,4)*scale(2))` 印 `(3,4,2,0,0,2)`）。它在这一层是 prelude 的一个
    // struct，所以要在下面那条"结构体不印"前面接住。先落一个临时量：格式是六个字段
    // 拼起来的，不落就把那个表达式求了六遍。
    if (v.type === 'transform' && Array.isArray(L.pre)) {
      const tv = `asy__wt${L.tmp++}`;
      L.pre.push(`(let ${tv} ${asyCore(v.type)} ${v.code})`);
      vals.push({ code: `(var ${tv})`, type: 'transform' });
      continue;
    }
    // 别的结构体 asy 自己也不印（量过：`no matching function 'write(A)'`）。拦在这一层，
    // 不然漏出去的是核心方言那句 `(tostr E) 只接受 int / real / bool`。
    // asy 那边还给 pen 与 guide 印（builtin.cc:862/863）—— 那两个我们还没做，
    // 落在这条话里时说的是"还没做"，不是"asy 也不收"。
    if (L.isRec(v.type)) {
      if (v.type === 'pen' || v.type === 'guide') {
        return L.nope(a, `write(${v.type})（asy 那边有 builtin.cc:862/863 的 addWrite，`
          + '那是一串 rgb(…)+linewidth(…) 的文字形式，这一刀还没做）');
      }
      return L.err(a, `write 的实参不能是结构体 —— asy 那边 write(${v.type}) 就是 no matching function`);
    }
    vals.push(v);
  }
  // 只有实参多于一个时第一个串才是前缀 —— 单个 write("a") 里 "a" 就是那个 T
  const prefix = vals.length > 1 && vals[0].type === 'string';
  const first = prefix ? 1 : 0;
  // T 的判定：asy 那边是重载解析。有一个实参是 pair 时 T 就是 pair，别的 int/real
  // 按隐式转换补成 `(v,0)`（量过：`write(3,(1,2))` 印的是 "(3,0)" TAB "(1,2)"）。
  let t = vals[first].type;
  for (let i = first; i < vals.length; i++) {
    if (vals[i].type === 'pair') t = 'pair';
  }
  for (let i = first; i < vals.length; i++) {
    if (t === 'pair' && (vals[i].type === 'int' || vals[i].type === 'real')) {
      vals[i] = L.toPair(vals[i]);
      continue;
    }
    if (vals[i].type === t) continue;
    const shape = vals.map((v) => v.type).join(', ');
    return L.err(args[i], `write 的实参要同型 —— asy 那边 write(${shape}) 就是 no matching function`);
  }
  // T 是数组：那是另一条格式（每行「下标 : TAB 值」），见 writeArrays
  if (asyIsArr(t)) return asyWriteArrays(L, n, vals, first);
  const parts = vals.map((v) => asyFmtStr(L, v.type, v.code));
  // 前缀与第一个值之间不加分隔符，值与值之间加制表符
  let code = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (!(i === 1 && prefix)) code = `(bin "+" ${code} (str "\\t"))`;
    code = `(bin "+" ${code} ${parts[i]})`;
  }
  return [`(print ${code})`];
}

/** 一个值印成字符串时的形状。write 的两条路（标量与数组）共用这一份。 */
export function asyFmtStr(L, t, code) {
  if (t === 'string') return code;
  // real 用 15 位有效数字 —— asy 的默认输出就是 %.15g（量过：1/3 是
  // 0.333333333333333、sqrt(2) 是 1.4142135623731、1e-5 是 1e-05、-0.0 是 -0）
  if (t === 'real') return `(tostr ${code} (int 15))`;
  if (t === 'pair') {
    L.used.add('asy__pairstr');
    return `(call asy__pairstr ${code})`;
  }
  if (t === 'triple') {
    L.used.add('asy__triplestr');
    return `(call asy__triplestr ${code})`;
  }
  // transform：六个字段照 real 的格式，夹在圆括号里、逗号分隔（量过 `(3,4,2,0,0,2)`）。
  // `code` 在这儿一定是个临时量（asyWriteStmt 先落了一格），所以重复读它没有副作用。
  if (t === 'transform') {
    const f = (fld) => `(tostr (fld ${code} ${fld}) (int 15))`;
    let out = f('x');
    for (const fld of ['y', 'xx', 'xy', 'yx', 'yy']) {
      out = `(bin "+" ${out} (bin "+" (str ",") ${f(fld)}))`;
    }
    return `(bin "+" (str "(") (bin "+" ${out} (str ")")))`;
  }
  if (t === 'bool') {
    L.used.add('asy__boolstr');
    return `(call asy__boolstr ${code})`;
  }
  return `(tostr ${code})`;
}

/**
 * `write` 一个或多个**整数组**。格式是量出来的（`asy -noV`，od -c 看字节）：
 *   int[] a={10,20}; write(a);       -> "0:\tab10\n1:\tab20\n"   即每行「下标 : TAB 值」
 *   write("P",a);                    -> "P\n" 然后才是那些行（前缀**自己占一行**）
 *   int[] b={30}; write(a,b);        -> "0:\tab10\tab30\n1:\tab20\n"
 *                                       行数按最长的那个数组，短的那个到头就不印了
 *   write(new int[0]);               -> 什么都不印
 *   write(a,5);                      -> no matching function 'write(int[], int)'
 *
 * 这一条刻意**不**发 helper 函数，直接摊成语句：数组的个数是变的（helper 要按个数各发
 * 一份），而摊成语句只用一个 while。数组都先绑临时量 —— `write(f(),g())` 里 f 和 g
 * 各只能调一次。
 */
export function asyWriteArrays(L, n, vals, first) {
  if (L.pre === null) return L.nope(n, '这个位置的 write（它要摊成语句，这里放不下）');
  const el = asyElem(vals[first].type);
  // 元素是结构体的数组一律拒。**transform 也拒** —— 量过真 asy：`write(t)` 印
  // `(3,4,2,0,0,2)`，而 `write(new transform[]{...})` 报
  // "no matching function 'write(transform[])'"。builtin.cc:861 那一行虽然把
  // transformArray() 递进去了，可数组那一支并没有落到 write 上。
  if (L.isRec(el)) {
    return L.err(n, `write 的实参不能是 ${el}[] —— asy 那边就是 `
      + `no matching function 'write(${el}[])'`);
  }
  const out = [];
  if (first === 1) out.push(`(print ${vals[0].code})`);
  const names = [];
  for (let i = first; i < vals.length; i++) {
    const nm = `asy__wa${L.tmp++}`;
    names.push(nm);
    out.push(`(let ${nm} ${asyCore(vals[first].type)} ${vals[i].code})`);
  }
  const nmax = `asy__wn${L.tmp++}`;
  out.push(`(let ${nmax} int (int 0))`);
  for (const nm of names) {
    out.push(`(if (bin "<" (var ${nmax}) (alen (var ${nm}))) (do (set ${nmax} (alen (var ${nm})))))`);
  }
  const iv = `asy__wi${L.tmp++}`;
  const sv = `asy__ws${L.tmp++}`;
  const body = [`(let ${sv} string (bin "+" (tostr (var ${iv})) (str ":")))`];
  for (const nm of names) {
    const cell = asyFmtStr(L, el, `(aget (var ${nm}) (var ${iv}))`);
    body.push(`(if (bin "<" (var ${iv}) (alen (var ${nm}))) (do (set ${sv} (bin "+" (var ${sv}) (bin "+" (str "\\t") ${cell})))))`);
  }
  body.push(`(print (var ${sv}))`);
  body.push(`(set ${iv} (bin "+" (var ${iv}) (int 1)))`);
  out.push(`(let ${iv} int (int 0))`);
  out.push(`(while (bin "<" (var ${iv}) (var ${nmax})) (do ${body.join(' ')}))`);
  return out;
}

/* ---------------------------------------------------------------- 语句 */

/**
 * 一条 asy 语句可能摊成好几条核心方言语句，所以一律回数组；失败回 null。
 *
 * 外壳负责**前置语句**：`? :` 这种"核心方言里不是表达式"的东西，降级时要先算进一个
 * 临时量，那几条就攒在 L.pre 里，由这里补在本条语句前面。每条语句一份 pre，所以
 * 嵌套语句（if 的分支、循环体）各自算各自的，不会被提到外面去。
 */
export function asyStmt(L, n, ret) {
  const outer = L.pre;
  L.pre = [];
  const lines = asyStmtOne(L, n, ret);
  const pre = L.pre;
  L.pre = outer;
  if (lines === null) return null;
  if (pre.length === 0) return lines;
  return pre.concat(lines);
}

export function asyStmtOne(L, n, ret) {
  if (!isList(n)) return L.err(n, '认不出的语句');
  const h = head(n);
  if (h === 'empty-stm') return [];
  if (h === 'modified') return asyStmt(L, n.items[2], ret);
  if (h === 'vardec') return asyVardec(L, n);
  // 语句位置的**声明**（第四十六刀）：asy 的块就是一层作用域，函数/struct/typedef 都能
  // 写在里面。这一层把它们当成"就地登记的顶层声明"：函数走 localFun（换个名字发成顶层
  // 函数），struct 与 typedef 直接进那两张表 —— 位置都是外层这一句的位置。
  // 代价写在明处：出了这个块它们**还看得见**（asy 那边看不见了）。要收窄得给那几张表
  // 加一层作用域，那是另一刀；base 里没有靠这条遮挡的写法，所以先按"多认一点"走。
  if (h === 'fundec') return L.localFun(n);
  if (h === 'recorddec') {
    const mark = L.diags.errorCount();
    L.recordDec(n, L.at);
    return L.diags.errorCount() > mark ? null : [];
  }
  if (h === 'typedec' || h === 'typedec-using') {
    const mark = L.diags.errorCount();
    L.typeDec(n, L.at);
    return L.diags.errorCount() > mark ? null : [];
  }
  if (h === 'exp-stm') return asyExprStmt(L, n.items[1]);
  if (h === 'block-stm') {
    const body = asyBody(L, n.items[1], ret);
    return body === null ? null : [`(do ${body.join(' ')})`];
  }
  if (h === 'if') {
    const c = L.coerce(L.expr(n.items[1]), 'bool', n, 'if 的条件');
    const t = asyStmt(L, n.items[2], ret);
    if (c === null || t === null) return null;
    if (n.items[3] === undefined) return [`(if ${c.code} (do ${t.join(' ')}))`];
    const e = asyStmt(L, n.items[3], ret);
    if (e === null) return null;
    return [`(if ${c.code} (do ${t.join(' ')}) (do ${e.join(' ')}))`];
  }
  if (h === 'while') {
    // 条件里摊出来的语句要单独收着：循环条件**每轮都得重算**，摊在循环外面就只算一次。
    const savePre = L.pre;
    L.pre = [];
    const c = L.coerce(L.expr(n.items[1]), 'bool', n, 'while 的条件');
    const cpre = L.pre;
    L.pre = savePre;
    L.updates.push([]);
    const b = asyStmt(L, n.items[2], ret);
    L.updates.pop();
    if (c === null || b === null) return null;
    if (cpre.length === 0) return [`(while ${c.code} (do ${b.join(' ')}))`];
    // 有摊出来的语句（`while ((i = find(s,d,last)) >= 0)`、条件里的 `?:`）：搬到循环体的
    // **开头**，判假就 break。`continue` 跳到循环顶、也会重新算一遍 —— 与 asy 一致。
    return [`(while (bool true) (do ${cpre.join(' ')} (if (un "!" ${c.code}) (do (brk))) ${b.join(' ')}))`];
  }
  if (h === 'do') return asyDoWhile(L, n, ret);
  if (h === 'for') return asyForStmt(L, n, ret);
  if (h === 'for-each') return asyForEach(L, n, ret);
  if (h === 'break') return ['(brk)'];
  if (h === 'continue') {
    // C 式 for 降成 while 之后，continue 要**先跑更新**再跳（量过 asy 的行为）
    const upd = L.updates.length === 0 ? [] : L.updates[L.updates.length - 1];
    const out = [];
    for (const u of upd) out.push(u);
    out.push('(cont)');
    return out;
  }
  if (h === 'return') {
    if (n.items[1] === undefined) return ['(ret)'];
    const v = L.coerce(L.expr(n.items[1]), ret, n, 'return 的值');
    return v === null ? null : [`(ret ${v.code})`];
  }
  if (h === 'unravel') {
    const uv = asyUnravelVar(L, n);
    if (uv !== undefined) return uv;
    return L.nope(n, '`unravel` 这一句（这一刀只摊一格记录变量的字段，摊模块还没做）');
  }
  return L.nope(n, `语句 '${h}'`);
}

/**
 * `unravel x;`：把**一格记录**的成员摊进当前作用域（collections/iter.asy:17 的
 * `unravel retv;`、plain.asy:172 同样）。asy 那边摊出来的名字是**别名** —— 读、调用、
 * 赋值都作用在 x 的那个字段上，所以 `advance = new void() {…};` 装的是 `retv.advance`。
 *
 * 落法：名字进作用域（类型查得到），另记一条"它其实是 x 的哪个字段"（declareAlias），
 * nameOf / call / assign 三处各问一句 aliasOf。发出去的语句是**空的** —— 这一句只改作用域。
 *
 * 这一刀只摊**字段**（含"没有体的方法声明"那种函数类型的字段 —— iter.asy 要的正是它）。
 * 摊有体的方法要一格绑好接收者的闭包，那是另一刀。名字不是一格记录时回 undefined，
 * 让上面那句去报"语句 'unravel'"（`unravel 模块名;` 就落在那儿）。
 */
function asyUnravelVar(L, n) {
  const nm = L.plainName(n.items[1]);
  const wild = isList(n.items[2]) && head(n.items[2]) === 'wildcard';
  if (nm === null || !wild) return undefined;
  let code = null;
  let ty = L.lookup(nm);
  if (ty !== null) {
    const bx = L.boxOf(nm);
    code = bx === null ? `(var ${L.symOf(nm)})` : `(aget (var ${bx.sym}) (int 0))`;
  } else {
    const g = L.gvarHere(nm);
    if (g === null || !g.ok) return undefined;
    ty = g.type;
    code = `(var ${g.sym})`;
  }
  const rec = L.recOf(ty);
  if (rec === null) return undefined;
  for (const f of rec.fields) {
    if (f.name === ASY_FILLER) continue;
    if (L.declareAlias(n, f.name, f.type, code, ty, f.name) === null) return null;
  }
  return [];
}

/**
 * `do S while (c)` -> `while (true) { S; if (!c) break; }`。
 * 刻意不复制 S（复制会让 S 里的 break 落在循环外面），代价是 `continue` 在这个编码里
 * 会跳过条件检查，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
 */
export function asyDoWhile(L, n, ret) {
  L.updates.push([]);
  const b = asyStmt(L, n.items[1], ret);
  L.updates.pop();
  // 条件里摊出来的语句跟着条件走（它就在体的末尾，每轮都重算）—— 与 while / for 同一条
  const savePre = L.pre;
  L.pre = [];
  const c = L.coerce(L.expr(n.items[2]), 'bool', n, 'do-while 的条件');
  const cpre = L.pre;
  L.pre = savePre;
  if (b === null || c === null) return null;
  for (const s of b) {
    if (s === '(cont)' || s.includes(' (cont)')) return L.nope(n, 'do-while 里的 continue');
  }
  const tail = cpre.length === 0 ? '' : `${cpre.join(' ')} `;
  return [`(while (bool true) (do ${b.join(' ')} ${tail}(if (un "!" ${c.code}) (do (brk)))))`];
}

/**
 * `for (T x : a) S` -> 绑一次数组**句柄**，按下标走。
 *
 * 量过的两条：循环变量是**复制**（体里 `x = 99` 不动数组），而且迭代是**活的** ——
 * 体里 push 进去的元素会被走到（`int[] a={1,2}; int n=0; for(int x:a){++n; if(n<5) a.push(9);}`
 * 走了 6 轮，末了 a.length 是 6）。所以这里绑句柄、每轮重读 `(alen …)`，
 * 而不是先拷一份快照 —— 快照会让那个程序只走 2 轮。
 */
export function asyForEach(L, n, ret) {
  // `for (var x : a)`：元素类型**从数组推**。asy 的 `var` 不是类型，是"从初值推"，
  // 这儿的"初值"就是 `a[i]`。base 里 plain_bounds.asy 那七处 `for (var link : links)`
  // 全是这一种。推之前得先求数组，所以顺序与写死类型那一路反过来。
  const isVar = L.isVarTy(n.items[1]);
  const el0 = isVar ? null : L.type(n.items[1], 'for-each 的元素类型');
  if (!isVar && el0 === null) return null;
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  if (nm === null) return L.err(n, 'for-each 少了循环变量名');
  const a = L.expr(n.items[3]);
  if (a === null) return null;
  if (!asyIsArr(a.type)) {
    // 非数组：asy 那边看 `set.operator iter()` 查不查得通（stm.cc:473），通就走那套协议
    const fe = asyForIter(L, n, ret, a, isVar, el0, nm);
    if (fe !== undefined) return fe;
    return L.err(n, `for-each 要一个数组，这里是 ${a.type}`);
  }
  const el = isVar ? asyElem(a.type) : el0;
  if (!isVar && asyElem(a.type) !== el) {
    return L.err(n, `for-each 的元素写的是 ${el}，数组是 ${a.type}`);
  }
  const av = `asy__f${L.tmp++}`;
  const iv = `asy__fi${L.tmp++}`;
  const upd = [`(set ${iv} (bin "+" (var ${iv}) (int 1)))`];
  L.push();
  if (L.declare(n, nm, el) === null) { L.pop(); return null; }
  L.updates.push(upd);
  const body = asyStmt(L, n.items[4], ret);
  L.updates.pop();
  L.pop();
  if (body === null) return null;
  const inner = [`(let ${nm} ${asyCore(el)} (aget (var ${av}) (var ${iv})))`];
  for (const s of body) inner.push(s);
  for (const s of upd) inner.push(s);
  const head3 = `(let ${av} ${asyCore(a.type)} ${a.code}) (let ${iv} int (int 0))`;
  return [`(do ${head3} (while (bin "<" (var ${iv}) (alen (var ${av}))) (do ${inner.join(' ')})))`];
}

/**
 * `recv.名字()`：那个名字可能是一格**函数类型的字段**（"没有体的方法声明"，
 * collections/iter.asy 的 `Iter_T operator iter();` 与 Iter_T 的 get/advance/valid
 * 都是这一种），也可能是有体的方法。这一刀只收前一种 —— 后一种要 applyCall，
 * 而那条路会往 `L.pre` 里绑临时量，摆在循环外面就错了（btreegeneral.asy 那几处是它，
 * 不在 plain/graph 的路上）。认不出就回 null，不发诊断。
 */
function asyZeroCall(L, recv, mname) {
  const rec = L.records.get(recv.type);
  if (rec === undefined) return null;
  for (const f of rec.fields) {
    if (f.name !== mname) continue;
    if (!asyIsFn(f.type)) return null;
    const s = asyFnSplit(f.type);
    if (s === null || s.params.length !== 0) return null;
    return { code: `(callfn (fld ${recv.code} ${asyFldSym(mname)}))`, type: s.ret };
  }
  return null;
}

/**
 * `for (T x : 一个可迭代的东西)`（这一刀）。asy 那边的判据是"`set.operator iter()`
 * 查得通吗"（stm.cc:473），通就摊成（stm.cc:512）：
 *
 *     for (var i = set.operator iter(); i.valid(); i.advance()) { T x = i.get(); body }
 *
 * `operator iter` 只求**一次**（在 init 里），`continue` 也要先走 advance —— 所以那一句
 * 进 `L.updates`，与数组那一路的 `++i` 同一个位置。四个名字（iter/get/valid/advance）
 * 缺一个就回 undefined，让调用方报原来那句"for-each 要一个数组"。
 */
function asyForIter(L, n, ret, a, isVar, el0, nm) {
  if (!L.isRec(a.type)) return undefined;
  const itv = asyZeroCall(L, a, 'operator iter');
  if (itv === null || !L.isRec(itv.type)) return undefined;
  const iv = `asy__it${L.tmp++}`;
  const rv = { code: `(var ${iv})`, type: itv.type };
  const get = asyZeroCall(L, rv, 'get');
  const valid = asyZeroCall(L, rv, 'valid');
  const adv = asyZeroCall(L, rv, 'advance');
  if (get === null || valid === null || adv === null) return undefined;
  if (valid.type !== 'bool' || adv.type !== 'void') return undefined;
  const el = isVar ? get.type : el0;
  const gv = L.coerce(get, el, n, 'for-each 的元素');
  if (gv === null) return null;
  L.push();
  if (L.declare(n, nm, el) === null) { L.pop(); return null; }
  const upd = [`(expr ${adv.code})`];
  L.updates.push(upd);
  const body = asyStmt(L, n.items[4], ret);
  L.updates.pop();
  L.pop();
  if (body === null) return null;
  const inner = [`(let ${nm} ${asyCore(el)} ${gv.code})`];
  for (const s of body) inner.push(s);
  for (const s of upd) inner.push(s);
  return [`(do (let ${iv} ${asyCore(itv.type)} ${itv.code})`
    + ` (while ${valid.code} (do ${inner.join(' ')})))`];
}

/** `for (init; test; upd) body` -> `init; while (test) { body; upd }`（continue 见上） */export function asyForStmt(L, n, ret) {
  L.push();
  const init = asyForPart(L, n.items[1], ret);
  // 条件里摊出来的语句要单独收着：循环条件**每轮都得重算**（与 while 那一档同一条）
  const savePre = L.pre;
  L.pre = [];
  const test = isList(n.items[2]) && head(n.items[2]) === 'none'
    ? { code: '(bool true)', type: 'bool' }
    : L.coerce(L.expr(n.items[2]), 'bool', n, 'for 的条件');
  const cpre = L.pre;
  L.pre = savePre;
  const upd = asyForPart(L, n.items[3], ret);
  if (init === null || test === null || upd === null) { L.pop(); return null; }
  L.updates.push(upd);
  const body = asyStmt(L, n.items[4], ret);
  L.updates.pop();
  L.pop();
  if (body === null) return null;
  const inner = [];
  for (const s of body) inner.push(s);
  for (const s of upd) inner.push(s);
  if (cpre.length === 0) {
    return [`(do ${init.join(' ')} (while ${test.code} (do ${inner.join(' ')})))`];
  }
  // 有摊出来的语句（条件里的 `? :`，graph.asy:801）：搬到循环体的**开头**，判假就 break。
  // `continue` 先跑更新再跳到循环顶，于是条件也重算一遍 —— 与 asy 一致。
  return [`(do ${init.join(' ')} (while (bool true) (do ${cpre.join(' ')}`
    + ` (if (un "!" ${test.code}) (do (brk))) ${inner.join(' ')})))`];
}

/** for 的 init / update 段：`(none)` / `(stmexps ...)` / 一条 barevardec */
export function asyForPart(L, n, ret) {
  if (!isList(n)) return [];
  const h = head(n);
  if (h === 'none') return [];
  if (h === 'vardec') return asyVardec(L, n);
  const out = [];
  for (const s of L.flat(n, 'stmexps')) {
    const one = asyStmt(L, s, ret);
    if (one === null) return null;
    for (const x of one) out.push(x);
  }
  return out;
}

/** `int a = 1, b;`：没有初值的按类型给零值 —— asy 也是这么定的 */
export function asyVardec(L, n) {
  // `var`（第四十一刀）：不是一个类型，是"从初值推"。每个名字**各推各的** ——
  // 量过 `var a=1, b=2.5;` 出来是 int 与 real；`var z;` 那边报
  // "inferred variable declaration without initializer" 并退 1。
  const isVar = L.isVarTy(n.items[1]);
  const base = isVar ? 'var' : L.type(n.items[1], '变量声明');
  if (base === null) return null;
  if (base === 'void') return L.err(n, 'void 变量');
  const out = [];
  for (const d of L.flat(n.items[2], 'decids')) {
    if (!isList(d) || head(d) !== 'decid') return L.err(d, '认不出的声明项');
    const start = d.items[1];
    // `real f(real) = twice;`：函数值类型的变量声明，形参表跟在**名字**后面。
    // 与 typedef 那个拼法（`typedef real F(real); F f = twice;`）是同一件事，只是类型
    // 在这里才成形 —— 所以走同一个 fnTypeOf，往下跟别的类型没有区别。
    // 量出来的理由：`import graph;` 那 193 条错里有 4 条是这个拼法。
    // 右边是**方法**的那一条（`int f() = a.get;`）第四十三刀通了 —— 那是绑住接收者的
    // 闭包，见 lower.js 的 methodVal，`cases/77-method-value.asy` 钉着。
    let t = base;
    if (isList(start) && head(start) === 'fundecidstart') {
      t = L.fnTypeOf(base, start.items[2], start);
      if (t === null) return null;
    } else if (!isList(start) || head(start) !== 'decidstart') {
      return L.err(start, '认不出的声明项');
    } else if (start.items.length > 2) {
      // `real a[];`：维度写在名字后面。`real a[][]` 也收（多维数组这一刀）。
      const dep = L.dimsDepth(start.items[2]);
      if (dep === null) return L.nope(start, '声明里带形参表');
      if (!L.arrElemOk(t)) return L.nope(start, `${t}[] （${ASY_ARRELEM_TEXT}）`);
      let k = 0;
      while (k < dep) { t = `${t}[]`; k++; }
    }
    const nm = isAtom(start.items[1]) ? start.items[1].value : null;
    if (nm === null) return L.err(start, '声明里少了名字');
    // `A a;`（不写 `= new A`）在 asy 那边**不是** null：它隐式跑一次 operator init，
    // 而默认的那个就是 `new A`（量过：`A c;` 之后 `c == null` 是 false，
    // 而且带默认值的字段也照求 —— `struct B { int n = bump(); } B c;` 之后计数器是 1）。
    // 这里走的**只有那个默认的**：struct 体里的 `void operator init(…)`（第二十一刀的
    // 构造调用 `A(…)`）量过不参与这一句，而换掉它的**文件级** `A operator init()`
    // 还在门外（funcSig 里拦着，`bad/ctor-toplevel` 钉着）。
    let init = null;
    if (isVar) {
      if (d.items[2] === undefined) {
        return L.err(start, '`var` 的声明没有初值 —— 那推不出类型（asy 那边报'
          + ' "inferred variable declaration without initializer"）');
      }
      const lit = L.expr(d.items[2]);
      if (lit === null) return null;
      if (lit.code === null || lit.type === 'void' || lit.type === undefined) {
        return L.nope(d, `\`var ${nm}\` 的初值（这一句推不出类型）`);
      }
      t = lit.type;
      init = lit.code;
    } else if (L.isRec(t)) {
      init = L.recInit(start, t);
      if (init === null) return null;
    } else if (asyIsFn(t)) {
      // 函数值的零值是**空引用**。这一句原先拦着不带初值的声明，理由是"那个空函数值的
      // 字面量方言里还没有" —— 第三十三刀补上了 `(null TYPE)`，所以现在直接发它。
      // 量过 asy：`F f; write(f == null)` 是 true，赋一个闭包之后是 false。
      init = `(null ${asyCore(t)})`;
    } else {
      init = asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t);
      if (init === undefined) return L.nope(start, `${t} 的变量声明（这一刀给不出它的零值）`);
    }
    if (!isVar && d.items[2] !== undefined) {
      // `T[] a = {1,2,3}`：花括号初值自己没有类型，元素类型从左边的声明来
      const raw = d.items[2];
      const lit = asyIsArr(t) && isList(raw) && head(raw).startsWith('arrayinit')
        ? L.arrLit(raw, t)
        : L.expr(raw);
      const v = L.coerce(lit, t, d, `'${nm}' 的初值`);
      if (v === null) return null;
      init = v.code;
    }
    // 文件级的那一层（第二十四刀）：这里不是局部量，是个全局。声明本身已经在
    // globalNames 里收过了（函数体要先看得见它），这里只发那句赋值。
    // 标量的全局是零初始化的，所以没有初值的声明什么都不发；**聚合不行**（第三十刀）——
    // 记录要 `new`、数组要 `anew`，零就是 null，一读就是 null reference。
    const g = L.fileLevel && L.scopes.length === 1 ? L.gvarAt(nm) : null;
    if (g !== null && g.ok) {
      // `var` 的文件级那份：类型是声明遍推出来的（globalNames 里那一段），这里把初值
      // 往那个类型上收一次 —— 两遍推出来的应该是同一个，收一次是为了万一不是时报错话
      // 而不是发一句类型不对的 `(set …)`。
      if (isVar && g.type !== t) {
        const v = L.coerce({ code: init, type: t }, g.type, d, `'${nm}' 的初值`);
        if (v === null) return null;
        init = v.code;
      }
      const need = d.items[2] !== undefined || L.isRec(t) || asyIsArr(t);
      if (need) out.push(`(set ${g.sym} ${init})`);
      continue;
    }
    // 同一层里**重新声明**同名的变量：asy 收（量过 `int x=1; int x=2; write(x);` 印 2 ——
    // 它是新开一格，把旧的那格遮住）。plain 里有三处这么写：plain_arrows.asy:70/112 的
    // `path left=rotate(-angle*factor,x)*r;` 与 plain_filldraw.asy:28 的 `real t=…`。
    // 这一层没有"同名两格"的表示（`(var 名字)` 就是那个名字），所以类型相同时**复用同一格**，
    // 把这一句降成赋值：旧那一格从这一句起再也用名字取不到，而捕获是按值抓的
    // （`(cap …)` 在 mkclo 那一刻就抄了一份），所以看不出差别。没写初值也照发 ——
    // 上面那几支已经把"新声明该有的值"算在 init 里了（零值 / `new` / `(null T)`）。
    // 类型**不同**的那一格得真的改名（第六十四刀，见 declareShadow）—— asy 那边是新开
    // 一格把旧的遮住，这一层给新那一格换个核心方言里的符号，名字照旧查得到。
    const had = L.scopes[L.scopes.length - 1].get(nm);
    if (had !== undefined) {
      if (had !== t) {
        const boxed = asyNeedsBox(L, nm);
        const sh = L.declareShadow(nm, t, boxed);
        if (boxed) {
          const bt = asyCore(`${t}[]`);
          out.push(`(let ${sh} ${bt} (anew ${bt} (int 1)))`);
          out.push(`(aset (var ${sh}) (int 0) ${init})`);
        } else {
          out.push(`(let ${sh} ${asyCore(t)} ${init})`);
        }
        continue;
      }
      const hb = L.boxOf(nm);
      if (hb !== null) out.push(`(aset (var ${hb.sym}) (int 0) ${init})`);
      else out.push(`(set ${L.symOf(nm)} ${init})`);
      continue;
    }
    // 遮住**外层**作用域里同名的那一格（第六十四刀）：形参与体在 asy 里是两层，可核心方言
    // 的函数体只有一层，同名的 `(let …)` 那边当场报"已经声明过了"。原型是
    // plain_Label.asy:349 的 `pair position=point(g,position);`（形参是 `real position`）。
    // 一律改名：块作用域那一档改了也没坏处（出块名字就查不到了，symOf 回的是外层那个符号）。
    if (L.lookup(nm) !== null) {
      const boxed = asyNeedsBox(L, nm);
      const sh = L.declareShadow(nm, t, boxed);
      if (boxed) {
        const bt = asyCore(`${t}[]`);
        out.push(`(let ${sh} ${bt} (anew ${bt} (int 1)))`);
        out.push(`(aset (var ${sh}) (int 0) ${init})`);
      } else {
        out.push(`(let ${sh} ${asyCore(t)} ${init})`);
      }
      continue;
    }
    // 会被闭包抓走、而且还会被改的那一格要**装箱**（这一刀）：一格长度 1 的数组，
    // 读写都穿过去，闭包抓走的是那个数组本身 —— 于是里外是同一格（asy 的按引用捕获）。
    if (asyNeedsBox(L, nm)) {
      const bx = L.declareBox(start, nm, t);
      if (bx === null) return null;
      const at = asyCore(`${t}[]`);
      out.push(`(let ${bx} ${at} (anew ${at} (int 1)))`);
      out.push(`(aset (var ${bx}) (int 0) ${init})`);
      continue;
    }
    if (L.declare(start, nm, t) === null) return null;
    out.push(`(let ${nm} ${asyCore(t)} ${init})`);    }
  return out;
}

/** 语句位置的表达式。赋值/自增只认这里 —— 它们在核心方言里是语句，不是表达式。 */
export function asyExprStmt(L, e) {
  if (!isList(e)) return L.err(e, '认不出的表达式语句');
  const h = head(e);
  if (h === 'assign') return asyAssign(L, e, e.items[1], e.items[2], null);
  if (h === 'self') {
    // SELFOP 是词法给的 token（原子），而 `(prefix "+" …)` 里的算符是模板里的字符串 ——
    // 两种节点都可能，所以一律用 asyOpText 取文本，不假设是哪一种
    const op = asyOpText(e.items[1]);
    if (op === null || op.length !== 2 || !'+-*/#%^'.includes(op.slice(0, 1))) return L.nope(e, `复合赋值 '${op}'`);
    return asyAssign(L, e, e.items[2], e.items[3], op.slice(0, 1));
  }
  // 后缀 `x++` / `a[0]++`：**asy 自己就不收**（量过：`int b=1; b++;` 报
  // "postfix expressions are not allowed"，`a[0]++` 也一样）。这一层照着拒 ——
  // 语法认得它（camp.y 里有那条产生式），但收下来就等于比 asy 多接受一门语言。
  if (h === 'postfix') return L.err(e, 'asy 自己就不收后缀 ++/--（postfix expressions are not allowed）：写成 ++x');
  if (h === 'prefix') {
    const op = asyOpText(e.items[1]);
    if (op !== '+' && op !== '-') return L.nope(e, `自增/自减 '${op}'`);
    return asyAssign(L, e, e.items[2], null, op);
  }
  if (h === 'call') {
    const nm = isList(e.items[1]) && head(e.items[1]) === 'name-exp' ? L.plainName(e.items[1].items[1]) : null;
    if (nm === 'write') {
      // 用户自己的 `write` 先问（第四十五刀）：base 里 `void write(file, T)` 那一族就是
      // 普通重载（plain_constants.asy:82 起）。都不匹配才落回内建那份 —— 所以这里是
      // "试一遍、不行就把诊断与前置语句都丢掉"（与 probeTy 同一条路子）。
      const wc = asyVisible(L, 'write');
      if (wc.length > 0) {
        const mark = L.diags.mark();
        const savePre = L.pre;
        L.pre = [];
        const uv = asyUserCall(L, e, 'write', wc, null);
        const upre = L.pre;
        L.pre = savePre;
        if (uv !== null) {
          for (const s of upre) L.pre.push(s);
          return [`(expr ${uv.code})`];
        }
        L.diags.rollback(mark);
      }
      return asyWriteStmt(L, e);
    }
    const v = asyCall(L, e);
    if (v === null) return null;
    return [`(expr ${v.code})`];
  }
  return L.nope(e, `语句位置的表达式 '${h}'`);
}

/**
 * 给 static 字段赋值。它是一个**文件级变量**，所以落的就是 `(set 符号 值)`。
 * 复合赋值与自增这一刀不收：那一整套（用户算符、pair/triple、`#=`/`%=`）都写在 assign 的
 * 尾巴上，而尾巴是按"名字就是符号"写的 —— 挪过来得先把它抽成一个函数，那是另一刀。
 */
export function asyAssignStat(L, node, label, g, rhs, op) {
  if (op !== null) return L.nope(node, `static 字段的复合赋值或自增（${label}）`);
  const v = L.coerce(L.expr(rhs), g.type, node, `给 '${label}' 赋的值`);
  return v === null ? null : [`(set ${g.sym} ${v.code})`];
}

/** 赋值、复合赋值、自增自减都归到这里：目标是普通变量名，或者数组下标 */
export function asyAssign(L, node, lhs, rhs, op) {
  if (isList(lhs) && head(lhs) === 'subscript') return asyAssignIndex(L, node, lhs, rhs, op);
  // 字段赋值。asy 的 struct 是引用语义的，所以不必"读出整个记录、改完再写回去"——
  // `(fldset 接收者 字段 值)` 直接改那个对象。接收者只认**普通变量**（dotQual 的限制）：
  // 复合赋值要把它求两次，而变量读没有副作用。
  if (isList(lhs) && head(lhs) === 'name-exp') {
    const q = L.dotQual(lhs.items[1]);
    if (q === DOT_BAD) return null;
    if (q !== null && L.isRec(q.recv.type)) {
      // `a.n = …`：`n` 可能是 **static** —— 那不是这个对象的槽，是一个文件级变量
      const s = L.statOf(q.recv.type, q.field);
      if (s !== null) return asyAssignStat(L, node, `${q.recv.type}.${q.field}`, s, rhs, op);
      return asyAssignFld(L, node, q, rhs, op);
    }
    // 里面那一格没有这个字段：同名的**模块级**那一格再试一次（读那一路见 memberOuter）。
    // graph.asy:1478 的 `axis.xdivisor=mx.divisor;` 就是这一格 —— 形参 `axis` 是函数
    // 类型（`void(picture,axisT)`），有 `xdivisor` 的是模块级那个 `axisT axis;`。
    if (q !== null && !L.isRec(q.recv.type) && q.base !== undefined && L.lookup(q.base) !== null) {
      const g = L.gvarHere(q.base);
      if (g !== null && g.ok && L.isRec(g.type)) {
        const rd = L.records.get(g.type);
        let has = false;
        if (rd !== undefined) for (const fd of rd.fields) if (fd.name === q.field) has = true;
        if (has) {
          const s2 = L.statOf(g.type, q.field);
          if (s2 !== null) return asyAssignStat(L, node, `${g.type}.${q.field}`, s2, rhs, op);
          return asyAssignFld(L, node,
            { recv: { code: `(var ${g.sym})`, type: g.type }, field: q.field }, rhs, op);
        }
      }
    }
    // 数组的 `.cyclic = …`（第六十五刀，见 cycHelper）：不是记录的字段，是数组对象上
    // 那一格标记。plain_pens.asy:148 的 `colorPen.cyclic=true` 就是这一句。
    if (q !== null && asyIsArr(q.recv.type) && q.field === 'cyclic') {
      if (op !== null) return L.nope(node, "数组 '.cyclic' 上的复合赋值");
      const bv = L.coerce(L.expr(rhs), 'bool', node, "给 '.cyclic' 赋的值");
      if (bv === null) return null;
      return [`(expr (call ${L.cycHelper(q.recv.type).set} ${q.recv.code} ${bv.code}))`];
    }
    // pair 的分量是**只读**的虚字段：量过 asy 对 `z.x = 5` 与 `a.p.x = 5` 都报
    // "virtual field is read-only"。这条不是"还没做"，所以不带 ASY_NOPE ——
    // `tests/asy/strict/pair-field-set` 钉着它。
    if (q !== null && (q.recv.type === 'pair' || q.recv.type === 'triple')) {
      return L.err(node, `${q.recv.type} 的 '${q.field}' 是只读的虚字段 —— asy 那边就是 "virtual field is read-only"`);
    }
    // `Box.n = …`：类型名限定的 static（读那一路在 name-exp 里，见 statQual）
    const sq = L.statQual(lhs.items[1]);
    if (sq !== null) {
      const bn = L.plainName(lhs.items[1].items[1]);
      return asyAssignStat(L, node, `${bn}.${lhs.items[1].items[2].value}`, sq, rhs, op);
    }
    // `settings.outformat = "pdf"`：模块限定的文件级变量当赋值目标（读那一路在
    // name-exp 里，见 modVar）。base 里 plain.asy:13/265/367 与 plain_picture.asy:1694
    // 都是这么改 settings 的。
    const mq = L.modAlias(lhs.items[1]);
    if (mq !== null) {
      const list = L.units[mq.unit].globals.get(mq.name);
      if (list === undefined) {
        return L.nope(node, `模块限定的名字 '${mq.mod}.${mq.name}' 当赋值目标`
          + '（这一刀的 `m.名字` 只有模块里的文件级变量与函数）');
      }
      const mg = list[list.length - 1];
      if (!mg.ok) {
        return L.nope(node, `模块限定的文件级变量 '${mq.mod}.${mq.name}' 当赋值目标`
          + '（这一刀的模块级变量只收 int/real/bool/string）');
      }
      return asyAssignStat(L, node, `${mq.mod}.${mq.name}`, mg, rhs, op);
    }
  }
  // `f(x).字段 = v`：接收者不是名字而是一个表达式。asy 收这种（struct 是引用类型，
  // 回来的是句柄，写进去就是写那个对象 —— 量过 `pick(p,true).x = 11` 之后 p.lo.x 是 11）。
  // 接收者**只求一次**：简单赋值直接用，复合赋值先绑个临时量。
  if (isList(lhs) && head(lhs) === 'field') {
    const recv = L.expr(lhs.items[1]);
    if (recv === null) return null;
    const fname = isAtom(lhs.items[2]) ? lhs.items[2].value : null;
    if (fname === null) return L.nope(node, '给"点后面不是名字"的东西赋值');
    if (!L.isRec(recv.type)) return L.nope(node, `给 ${recv.type} 的字段赋值`);
    if (op === null) return asyAssignFld(L, node, { recv, field: fname }, rhs, op);
    if (L.pre === null) return L.nope(node, '这个位置的复合字段赋值（它要绑一个临时量）');
    const tv = `asy__r${L.tmp++}`;
    L.pre.push(`(let ${tv} ${asyCore(recv.type)} ${recv.code})`);
    return asyAssignFld(L, node, { recv: { code: `(var ${tv})`, type: recv.type }, field: fname }, rhs, op);
  }
  // 切片赋值 asy **有**（量过：`int[] a={1,2,3}; a[0:2]=b;` 之后 a 是 7,8,3），
  // 而且右边长度不同时整个数组的长度会跟着变 —— 那是另一条语义，这一刀没做。
  if (isList(lhs) && head(lhs) === 'slice-exp') return L.nope(node, '给切片赋值（`a[0:2] = b`）');
  const nm = isList(lhs) && head(lhs) === 'name-exp' ? L.plainName(lhs.items[1]) : null;
  if (nm === null) return L.nope(node, '赋值给不是普通变量或数组下标的东西（字段、切片、算符名）');
  // 下面发出去的代码用 `sym`（核心方言里那个名字），错话里用 `nm`（源码里那个名字）——
  // 文件级变量的两者不同：它降成了一个全局，符号名带前缀（第二十四刀）。
  let sym = L.symOf(nm);
  let t = L.lookup(nm);
  // `unravel x;` 摊出来的名字：赋值落在 x 的那个字段上（见 declareAlias）
  if (t !== null) {
    const al = L.aliasOf(nm);
    if (al !== null) {
      return asyAssignFld(L, node,
        { recv: { code: al.recv, type: al.rty }, field: al.field }, rhs, op);
    }
    // 装了箱的局部量（见 declareBox）：写要穿到箱子里去
    const bx = L.boxOf(nm);
    if (bx !== null) {
      return asySlotAssign(L, node, nm, '变量', t, `(aget (var ${bx.sym}) (int 0))`,
        (code) => [`(aset (var ${bx.sym}) (int 0) ${code})`], rhs, op);
    }
  }
  // 闭包体里改**外层**的局部量：那一格装了箱才改得动（capOf 里那句拒绝管没装箱的）
  if (t === null && L.cap !== null) {
    const c = L.capOf(node, nm);
    if (c === CAP_BAD) return null;
    if (c !== null) {
      const bs = L.cap.bx.get(nm);
      if (bs !== undefined) {
        return asySlotAssign(L, node, nm, '变量', c.type, `(aget (cap ${bs}) (int 0))`,
          (code) => [`(aset (cap ${bs}) (int 0) ${code})`], rhs, op);
      }
      return L.nope(node, `在闭包里改外层的局部量 '${nm}'（它没装箱 —— 装箱的判据见 needsBox）`);
    }
  }
  if (t === null) {
    // 方法体里给裸字段名赋值（第二十刀）：`x += k` 就是 `L.x += k`
    const sf = L.selfField(nm);
    if (sf !== null) {
      return asyAssignFld(L, node, { recv: { code: '(var this)', type: L.self.rec.name }, field: nm }, rhs, op);
    }
    // 方法体里给裸的 static 名字赋值（读那一路在 nameOf 里）。位置照上面那一档：
    // 字段之后、文件级之前。
    const st = L.self === null || L.self === undefined
      ? null : L.statOf(L.self.rec.name, nm);
    if (st !== null) return asyAssignStat(L, node, `${L.self.rec.name}.${nm}`, st, rhs, op);
    let g = L.gvarHere(nm);
    // 同名的文件级变量有好几格时按**右边的类型**挑一格（第六十六刀，见 gvarFor）：
    // plain_Label.asy:688 的 `texpath=new path[](string s, pen p, …){…}` 赋的是 :215
    // 那一格，不是 :589 那一格。probeType 求一遍类型再回滚，右边只真求一次。
    if (g !== null && g.ok && op === null && rhs !== null && L.gvarMany(nm)) {
      const rt = L.probeType(rhs);
      const pick = rt === null ? null : L.gvarFor(nm, rt);
      if (pick !== null) g = pick;
    }
    if (g !== null && g.ok) { sym = g.sym; t = g.type; }    else if (g !== null) {        return L.nope(node, `函数里改文件级变量 '${nm}'（这一刀的模块级变量`
        + '只收 int/real/bool/string —— pair/记录/数组的身份不在 MIR 的类型码里）');
    } else if (L.globals.has(nm)) return L.gvarLate(node, nm);
    else return L.err(node, `未声明的变量 '${nm}'`);
  }
  if (op === null) {
    const v = L.coerce(L.expr(rhs), t, node, `给 '${nm}' 赋的值`);
    return v === null ? null : [`(set ${sym} ${v.code})`];
  }
  // 自增自减：右边就是 1，类型跟着变量
  const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : L.expr(rhs);
  if (one === null) return null;
  if (rhs === null && t !== 'int' && t !== 'real') return L.err(node, `'${nm}' 是 ${t}，不能自增自减`);
  // 复合赋值走的是同一个二元算符（第二十三刀）：`x op= y` 就是 `x = x op y`，
  // 量过只定义了 `V operator +(V,V)` 时 `a += b` 是通的
  const cv = { code: `(var ${sym})`, type: t };
  const uv = asyOpUser(L, node, op, [cv, one], asyOpBuiltinSig(L, [cv, one]));
  if (uv !== null) {
    const v = L.coerce(uv, t, node, `'${nm} ${op}=' 的结果`);
    return v === null ? null : [`(set ${sym} ${v.code})`];
  }
  if (t === 'pair') {
    // `z += w` 是逐分量，`z *= 2` 与 `z /= (0,1)` 走复数乘除（量过：(4,6)*=2 是
    // (8,12)、(8,12)/=(0,1) 是 (12,-8)）。`#= %= ^=` pair 上没有。
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return L.err(node, `pair 上没有 '${op}='`);
    const v = L.pairArith(node, op, { code: `(var ${sym})`, type: 'pair' }, one);
    return v === null ? null : [`(set ${sym} ${v.code})`];
  }
  if (t === 'triple') {
    // 量过：`t += (1,1,1)` 是 (2,3,4)、`t *= 2` 是 (2,4,6)、`t /= 2` 是 (0.5,1,1.5)；
    // `t *= (1,2,3)` 在 asy 那边是 no matching function（tripleArith 里那一条挡着）
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return L.err(node, `triple 上没有 '${op}='`);
    const v = L.tripleArith(node, op, { code: `(var ${sym})`, type: 'triple' }, one);
    return v === null ? null : [`(set ${sym} ${v.code})`];
  }
  if (op === '#' || op === '%') {
    if (t !== 'int' || one.type !== 'int') return L.err(node, `'${op}=' 两边要是 int`);
    const helper = op === '#' ? 'asy__quot' : 'asy__mod';
    L.used.add(helper);
    return [`(set ${sym} (call ${helper} (var ${sym}) ${one.code}))`];
  }
  if (op === '^') {
    if (t !== 'int' || one.type !== 'int') return L.nope(node, "real 上的 '^='");
    L.used.add('asy__ipow');
    return [`(set ${sym} (call asy__ipow (var ${sym}) ${one.code}))`];
  }
  if (op === '/') {
    if (t !== 'real') return L.nope(node, `int 上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
    const v = L.coerce(one, 'real', node, "'/=' 的右边");
    return v === null ? null : [`(set ${sym} (bin "/" (var ${sym}) ${v.code}))`];
  }
  const v = L.coerce(one, t, node, `'${op}=' 的右边`);
  if (v === null) return null;
  if (t === 'string' && op !== '+') return L.err(node, `字符串上只有 '+='`);
  if (t === 'bool') return L.err(node, `bool 上没有 '${op}='`);
  return [`(set ${sym} (bin "${op}" (var ${sym}) ${v.code}))`];
}

/**
 * `a.x = v` / `a.x += v` / `++a.x`。规则与变量赋值那份逐条相同（同一批测量），
 * 只是左值从 `(set 名字 …)` 换成 `(fldset 接收者 字段 …)`。
 * 接收者在复合赋值里被求两次 —— 它只可能是一个变量读（见 assign 的入口判断）。
 */
export function asyAssignFld(L, node, q, rhs, op) {
  const f = L.recField(node, q.recv.type, q.field);
  if (f === null) return null;
  const put = (code) => [`(fldset ${q.recv.code} ${asyFldSym(q.field)} ${code})`];
  const cur = `(fld ${q.recv.code} ${asyFldSym(q.field)})`;
  return asySlotAssign(L, node, q.field, '字段', f.type, cur, put, rhs, op);
}

/**
 * "读一格、算一下、写回去"这一套（简单赋值、复合赋值、自增自减），左值抽成了
 * `cur`（读出来的代码）与 `put(值)`（写回去的语句）两件事。字段赋值与**装了箱的局部量**
 * 共用这一份 —— 两者的规矩逐条相同（同一批测量），只是左值的形状不一样。
 */
export function asySlotAssign(L, node, label, kind, t, cur, put, rhs, op) {
  if (op === null) {
    const v = L.coerce(L.expr(rhs), t, node, `给 '${label}' 赋的值`);
    return v === null ? null : put(v.code);
  }
  const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : L.expr(rhs);
  if (one === null) return null;
  if (rhs === null && t !== 'int' && t !== 'real') return L.err(node, `'${label}' 是 ${t}，不能自增自减`);
  // 复合赋值走的是同一个二元算符（第二十三刀）：量过只定义了 `V operator +(V,V)` 时
  // `a.f += b` 也通 —— asy 把 `x op= y` 当 `x = x op y`
  const cf = { code: cur, type: t };
  const uf = asyOpUser(L, node, op, [cf, one], asyOpBuiltinSig(L, [cf, one]));
  if (uf !== null) {
    const v = L.coerce(uf, t, node, `'${label} ${op}=' 的结果`);
    return v === null ? null : put(v.code);
  }
  if (t === 'pair') {
    // pair 字段上的复合赋值与 pair 变量上那份是同一条规则（同一批测量）：`+= -=`
    // 逐分量，`*= /=` 走**复数**乘除 —— 量过 `p *= 2` 是 (4,5)->(8,10)，走
    // "coerce 成 (2,0) 再逐分量乘"会给出 (8,0)，所以这条不能少。
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return L.err(node, `pair 上没有 '${op}='`);
    const v = L.pairArith(node, op, { code: cur, type: 'pair' }, one);
    return v === null ? null : put(v.code);
  }
  if (t === 'triple') {
    // triple 字段上的复合赋值与 triple 变量上那份同一条规则（同一批测量）
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return L.err(node, `triple 上没有 '${op}='`);
    const v = L.tripleArith(node, op, { code: cur, type: 'triple' }, one);
    return v === null ? null : put(v.code);
  }
  if (op === '#' || op === '%') {
    if (t !== 'int' || one.type !== 'int') return L.err(node, `'${op}=' 两边要是 int`);
    const helper = op === '#' ? 'asy__quot' : 'asy__mod';
    L.used.add(helper);
    return put(`(call ${helper} ${cur} ${one.code})`);
  }
  if (op === '^') {
    if (t !== 'int' || one.type !== 'int') return L.nope(node, `real ${kind}上的 '^='`);
    L.used.add('asy__ipow');
    return put(`(call asy__ipow ${cur} ${one.code})`);
  }
  if (op === '/') {
    if (t !== 'real') return L.nope(node, `int ${kind}上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
    const v = L.coerce(one, 'real', node, "'/=' 的右边");
    return v === null ? null : put(`(bin "/" ${cur} ${v.code})`);
  }
  const v = L.coerce(one, t, node, `'${op}=' 的右边`);
  if (v === null) return null;
  if (t === 'string' && op !== '+') return L.err(node, `字符串上只有 '+='`);
  if (t === 'bool') return L.err(node, `bool 上没有 '${op}='`);
  return put(`(bin "${op}" ${cur} ${v.code})`);
}

/**
 * `a[i] = v` / `a[i] += v` / `a[i]++`。
 *
 * 两件事和变量赋值不一样：
 *
 *  1. **写下标会把数组长到 i+1**（量过：`int[] e; e[2]=5;` 之后 `e.length` 是 3）。
 *     所以先调一个 `asy__grow_元素` 把长度顶上去，再 aset。
 *  2. 数组和下标都要**只算一次**：复合赋值要读一次写一次，`a[f()] += 1` 里的 f 不能调两遍。
 *     所以两者都先绑到临时量（用 `? :` 那套 `L.pre`）。
 */
export function asyAssignIndex(L, node, lhs, rhs, op) {
  const a = L.expr(lhs.items[1]);
  if (a === null) return null;
  // 记录上的下标写：`operator [=]`（第三十二刀，collections/map.asy:29）。复合赋值那一档
  // 还没做 —— 它要先读（`operator []`）再写，两个算符各自还能重载，摊法与数组那边不一样。
  if (L.isRec(a.type)) {
    if (op !== null || rhs === null) {
      const what = rhs === null ? '++/--' : `${op}=`;
      return L.nope(node, `${a.type} 的下标上的 '${what}'`);
    }
    const c = asyIdxOpCall(L, node, a, 'operator [=]', [lhs.items[2], rhs]);
    return c === null ? null : [`(expr ${c.code})`];
  }
  if (!asyIsArr(a.type)) return L.err(node, `下标只能用在数组上，这里是 ${a.type}`);
  const idx = L.coerce(L.expr(lhs.items[2]), 'int', node, '下标');
  if (idx === null) return null;
  if (L.pre === null) return L.nope(node, '这个位置的下标赋值（它要摊成语句，这里放不下）');
  const el = asyElem(a.type);
  const av = `asy__d${L.tmp++}`;
  const iv = `asy__i${L.tmp++}`;
  L.pre.push(`(let ${av} ${asyCore(a.type)} ${a.code})`);
  L.pre.push(`(let ${iv} int ${idx.code})`);
  // 绕圈下标（第六十五刀，见 cycHelper）：`.cyclic` 置上时按长度取模。写侧与读侧同一条
  // （runarray.in:803 那一段），取模之后落在范围内，下面那句 grow 自然就是空转。
  L.pre.push(`(set ${iv} (call ${L.cycHelper(a.type).idx} (var ${av}) (var ${iv})))`);
  const grow = L.arrHelper('grow', el);
  const head2 = `(expr (call ${grow} (var ${av}) (var ${iv})))`;
  const cur = `(aget (var ${av}) (var ${iv}))`;
  const put = (code) => [head2, `(aset (var ${av}) (var ${iv}) ${code})`];
  if (op === null) {
    const v = L.coerce(L.expr(rhs), el, node, '赋给数组元素的值');
    return v === null ? null : put(v.code);
  }
  const one = rhs === null ? { code: el === 'real' ? '(real 1.0)' : '(int 1)', type: el } : L.expr(rhs);
  if (one === null) return null;
  if (rhs === null && el !== 'int' && el !== 'real') return L.err(node, `${el} 的数组元素不能自增自减`);
  // 复合赋值走同一个二元算符（第二十三刀）。`cur` 会出现两次，但下标与数组都已经绑成
  // 临时量了，所以求值次数不变
  const ce = { code: cur, type: el };
  const ue = asyOpUser(L, node, op, [ce, one], asyOpBuiltinSig(L, [ce, one]));
  if (ue !== null) {
    const v = L.coerce(ue, el, node, `数组元素 '${op}=' 的结果`);
    return v === null ? null : put(v.code);
  }
  if (op === '#' || op === '%') {
    if (el !== 'int' || one.type !== 'int') return L.err(node, `'${op}=' 两边要是 int`);
    const helper = op === '#' ? 'asy__quot' : 'asy__mod';
    L.used.add(helper);
    return put(`(call ${helper} ${cur} ${one.code})`);
  }
  if (op === '^') {
    if (el === 'int' && one.type === 'int') {
      L.used.add('asy__ipow');
      return put(`(call asy__ipow ${cur} ${one.code})`);
    }
    if (el !== 'real') return L.err(node, `'^=' 的两边要是 int 或 real`);
    const v = L.coerce(one, 'real', node, "'^=' 的右边");
    return v === null ? null : put(`(rmath "pow" ${cur} ${v.code})`);
  }
  if (op === '/') {
    if (el !== 'real') return L.nope(node, `int 数组元素上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
    const v = L.coerce(one, 'real', node, "'/=' 的右边");
    return v === null ? null : put(`(bin "/" ${cur} ${v.code})`);
  }
  const v = L.coerce(one, el, node, `'${op}=' 的右边`);
  if (v === null) return null;
  if (el === 'string' && op !== '+') return L.err(node, `字符串上只有 '+='`);
  if (el === 'bool') return L.err(node, `bool 上没有 '${op}='`);
  return put(`(bin "${op}" ${cur} ${v.code})`);
}

/** 一段花括号里的东西：`(block-stm BLOCK)` 或直接一条 BLOCK 链 */
export function asyBody(L, n, ret) {
  const inner = isList(n) && head(n) === 'block-stm' ? n.items[1] : n;
  L.push();
  const out = [];
  for (const r of L.flat(inner, 'block')) {
    const one = asyStmt(L, r, ret);
    if (one === null) { L.pop(); return null; }
    for (const s of one) out.push(s);
  }
  L.pop();
  return out;
}
