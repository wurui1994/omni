// Omni stage0 — asy 前端的**表达式**这一族
//
// 从 lower.js 里搬出来的第五摊，拆法与 calls.js / stmts.js 同一条：第一个形参 `L`
// 就是那个降级器。理由见 calls.js 的文件头。
//
// 这一摊管"一个表达式怎么落地"，三段：
//  1. 通用那一段：分派（asyExpr）、字面量、名字解析（asyNameOf，含重载集与 static）、
//     匿名函数与捕获（asyAnonFn / asyCapOf / asyAssignsAfter）、隐式转换（asyPromote /
//     asyToPair / asyCoerce）、下标与切片、点后面那一层（asyDotQual / asyField / asyMember）。
//  2. 内建面那一段：pair / triple 的字面量与函数、字符串函数、数组（new / 字面量 / 方法）。
//  3. 算符那一段：asyBinary（asy 与核心方言不一致的 `/` `#` `%` `^` 全在这里换掉）、
//     pair/triple 的算术、比较、`?:`、`&& ||`、一元、强制转换。
//
// 依赖方向是 exprs -> stmts -> calls -> types/runtime，一条链，**没有环** ——
// 自举那条路的模块加载器是**禁止环**的（link.js 报 "import cycle through"），
// 所以反向那几条边（calls.js 要 asyExpr、stmts.js 要 asyCoerce…）不走 import，
// 走 lower.js 上留的一层薄转接方法（`expr(n) { return asyExpr(this, n); }`）。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';
import {
  ASY_NOPE, DOT_BAD, CAP_BAD, ASY_ARRELEM_TEXT, ASY_CYCLE, ASY_RESTPFX, asyOpText,
  asyIsArr, asyElem, asyIsFn, ASY_PAIR_TY, ASY_TRIPLE_TY, asyCore, ASY_NULL, asyRefTy,
} from './types.js';
import { ZERO, ASY_PAIRFN, ASY_STRFN, ASY_STR_DEPS, strLit } from './runtime.js';
import { asyArgs, asyCall, asyVisible, asyJoinExp, asyOpUser, asyOpBuiltinSig, asyIdxOpCall } from './calls.js';
import { asyFmtStr, asyBody, asyExprStmt } from './stmts.js';

/* ---------------------------------------------------------------- 表达式 */

/** 出 `{code, type}`；失败回 null（诊断已记） */
export function asyExpr(L, n) {
  if (n === undefined || n === null) return L.err(null, '少了一个表达式');
  // 字面量：LIT 是裸原子（`3` / `3.5` / `true`），STRING 是字符串节点
  if (isStr(n)) return { code: `(str ${strLit(n.value)})`, type: 'string' };
  if (isAtom(n)) return asyLit(L, n);
  if (!isList(n)) return L.err(n, '认不出的表达式');
  return asyExprList(L, n, head(n));
}

export function asyLit(L, n) {
  const t = n.value;
  if (t === 'true' || t === 'false') return { code: `(bool ${t})`, type: 'bool' };
  if (/^[0-9]/.test(t) || t.startsWith('.')) {
    const real = t.includes('.') || t.includes('e') || t.includes('E');
    return real ? { code: `(real ${t})`, type: 'real' } : { code: `(int ${t})`, type: 'int' };
  }
  // `cycle` 在词法上是 LIT（camp.l 里它走 yylval.e，不是关键字），但在语义上它是
   // 一个**值** —— 绘图层里那个"闭合记号"。所以这里把它解析成一个名字：
  // `cyclepath`（不能就叫 cycle —— 那是 LIT，asy 源码里声明不出这个名字）。
  // 于是 `a--cycle` 是普通的 `operator --(path, path)`，前端不必知道 path 是什么。
  // 没引绘图层时报的是「未声明的变量 'cyclepath'」—— 那句话指得有点偏，所以这里
  // 自己给一句。
  if (t === 'cycle') {
    if (!L.globals.has(ASY_CYCLE) && L.lookup(ASY_CYCLE) === null) {
      return L.nope(n, "'cycle'（它是绘图层的闭合记号，要 `import plain;`）");
    }
    return asyNameOf(L, n, ASY_CYCLE);
  }
  // `null`（第三十三刀）：词法上它跟 `true` 一样是 LIT，语义上是**空引用**。
  // 它自己没有类型，所以这里只出一个记号（见 ASY_NULL），落地在 coerce / promote / fit。
  if (t === 'null') return { code: null, type: ASY_NULL };
  return L.nope(n, `字面量 '${t}'`);
}

/** 一个裸名字当表达式：局部 -> this 的字段 -> 文件级。name-exp 与 `cycle` 共用这一份。 */
export function asyNameOf(L, n, nm) {
  const t = L.lookup(nm);
  if (t !== null) {
    // 同名的**函数**也要带上（第六十二刀）：asy 的名字是按签名查的 —— 一个 `real min`
    // 与几个 `real min(real,real)` 在同一个作用域里共存，是哪一个由**目标类型**定案。
    // 原型是 plain_picture.asy:428 的
    // `void userBoxX3(real min, real max, binop m=min, binop M=max)`：形参 `real min`
    // 在默认值那段里可见，可它不是 `real(real,real)`，asy 查到的是函数 min。
    // 这一层自底向上定型，所以先把候选挂在值上（shadowFns），落地在 coerce ——
    // 目标类型不是函数类型、或挑不出同型的一份时，这个值还是这个变量，报原来那句。
    const v = { code: `(var ${nm})`, type: t };
    if (L.funcs.has(nm)) {
      const fns = asyVisible(L, nm);
      if (fns.length > 0) v.shadowFns = fns;
    }
    return v;
  }
  // 匿名函数体里：外层函数的局部量要**捕获**进来。顺序照 asy —— 闭包自己的局部（上面
  // 那一档）、外层函数的局部（这一档）、文件级（下面那几档）。
  if (L.cap !== null) {
    const c = asyCapOf(L, n, nm);
    if (c === CAP_BAD) return null;
    if (c !== null) return c;
  }
  const f = L.selfField(nm);
  if (f !== null) return { code: `(fld (var this) ${nm})`, type: f.type };
  // struct 体里把**自己的方法**取出来当值（第四十三刀）：`addPath=addPathToEmptyArray;`
  // （plain_bounds.asy:247）。接收者是隐含的 this。位置照 selfField：成员那一档里，
  // 字段之后、文件级之前。static 的体里没有接收者，所以那边不问这一条。
  if (L.self !== null && L.self !== undefined && L.self.stat !== true) {
    const ms = L.visibleMethods(L.self.rec, nm);
    if (ms.length === 1) return L.methodVal(n, L.self.rec, ms[0], '(var this)');
    if (ms.length > 1) {
      return L.nope(n, `把**重载**的方法 '${L.self.rec.name}.${nm}' 当值取出来`
        + `（有 ${ms.length} 个候选，是哪一个要靠目标类型定案）`);
    }
  }
  // 方法体里裸的 static 名字（量过 `int get() {return x + n;}` 里的 n 就是那一格）。
  // 位置照 selfField：成员那一档里，字段之后、文件级之前。
  if (L.self !== null && L.self !== undefined) {
    const s = L.statOf(L.self.rec.name, nm);
    if (s !== null) return { code: `(var ${s.sym})`, type: s.type };
  }
  const g = L.gvarHere(nm);
  if (g !== null && g.ok) return { code: `(var ${g.sym})`, type: g.type };
  if (g !== null) {
    return L.nope(n, `函数里引用文件级变量 '${nm}'（模块级变量收 int/real/bool/string、`
      + 'pair/triple、struct，与它们的一维数组 —— 这一条不在里面）');
  }
  // 文件级的同名变量声明在**后面**（顺序解析挡住它）时，还要问一句"同名的**函数**呢"：
  // asy 里变量与函数在同一档里按签名分，顺序只挡住那个变量，挡不住早就声明了的函数。
  // plain_arrows.asy:337 的 `arrowbar EndArrow(…)=Arrow;` 就是这一格 —— 那个 `Arrow`
  // 是 :325 的**函数** Arrow，而同名的变量在 :443 才出现（`Arrow=Arrow()`）。
  // 少了这一句，报的是"'Arrow' 在这里还不是一个变量"，理由指错了地方。
  if (L.globals.has(nm) && asyVisible(L, nm).length === 0) return L.gvarLate(n, nm);
  // 裸的**函数名**当值用（`findroot(f, a, b)` 的那个 f）。只有一个候选时才收 ——
  // 有多个重载时"是哪一个"要靠期望类型定案，而这一层是自底向上定型的，没有期望类型可问。
  // **实参位置**上那一条早就补了（见 overArg / fit：callArgs 先不定案，等 fit 拿槽的类型
  // 挑同型的一份）；第三十五刀把同一条路子铺到别的位置：这里也回一个**不定案的记号**
  // （`over` 那几个候选），由 coerce 拿目标类型落地。目标类型有的地方就通了 ——
  // 变量的初值（`real g(real,real) = both;`，真 asy 收，量过印 10）、赋值、return、
  // 以及 `collections/iter.asy:42` 的 `autounravel Iterable_T operator cast(…) = Iterable_T;`。
  // 记号的 `code` 留空：漏到没有目标类型的位置上是一处硬错，不会变成一个错答案。
  const cands = asyVisible(L, nm);
  if (cands.length === 1) {
    const c = cands[0];
    // 拼法只有一份（asyCandFnType）：这里原来是抄的一遍，可变形参那一格加进来之后
    // 抄的那份就落后了 —— `int total(... int[] xs)` 当值用时印成了 `int(int[])`，
    // 于是 `using vfn=int(... int[]); vfn f=total;` 报"类型不对"。
    // 带默认值的候选**也**能当值用（第六十刀）：类型是"全部形参"那一份，默认值那一格
    // 在类型里忽略（见 asyAnonFn 的注释）。省了实参的调用在 fnValCall 里报 nope。
    return { code: `(fnref ${c.sym})`, type: asyCandFnType(L, c) };
  }
  if (cands.length > 1) {
    return { code: null, type: `<${nm} 的重载集>`, over: cands };
  }
  // static 的方法体里提到了实例成员：asy 自己也拒（"static use of dynamic variable"），
  // 所以这一句要在那句泛泛的"未声明的变量"之前问 —— 拒的理由不能说错（第三十八刀）。
  if (L.selfInstMember(nm)) return L.selfStatBad(n, nm);
  return L.err(n, `未声明的变量 '${nm}'`);
}

/** 重载集按期望类型落成 `(fnref …)`（挑不出来给 null）。fit 已经挑过一遍，这里是落地 */
export function asyOverPick(L, r, want) {
  for (const c of r.v.over) if (asyCandFnType(L, c) === want) return `(fnref ${c.sym})`;
  return null;
}

/** 一个候选当**函数值**时的类型文本（与 nameOf 里那份拼法必须一致） */
export function asyCandFnType(L, c) {
  let ps = '';
  for (let i = 0; i < c.params.length; i++) {
    // 可变那一格印成 `... T[]`，与函数类型那边的拼法对齐（见 types.js 的 ASY_RESTPFX）——
    // 不然 `guide(... guide[])` 这种类型永远接不住一个真的可变函数。
    const p = c.ps === undefined || c.ps[i] === undefined ? null : c.ps[i];
    const t = p !== null && p.rest === true ? `${ASY_RESTPFX}${c.params[i]}` : c.params[i];
    ps = ps === '' ? t : `${ps},${t}`;
  }
  return `${c.ret}(${ps})`;
}

/**
 * 实参位置上的一个**裸名字**，而它是个有多个重载的函数名 —— 这里**先不定案**，
 * 回那一串候选，让 fit 按"这个槽要什么类型"挑（asy 就是这么定的：函数名当值用时
 * 由期望类型选重载）。挑不出来就是没有能匹配的签名，与别的实参一视同仁。
 *
 * 量出来的理由：内建面一加 `add(frame,frame)`，用户自己的 `add(int,int)` 就与它同一个
 * 重载集，`fold3(add,1,2,3)` 那句在真 asy 那边是通的，在我们这里报"当值用"。
 *
 * 顺序照 nameOf：局部量、`this` 的字段、文件级变量都遮住函数名（那三档里有就不是这条路）。
 * 带默认值的候选一律不算 —— 函数值没有默认值（nameOf 里同一条）。
 */
export function asyOverArg(L, node) {
  if (!isList(node) || head(node) !== 'name-exp') return null;
  const nm = L.plainName(node.items[1]);
  if (nm === null) return null;
  if (L.lookup(nm) !== null) return null;
  // 匿名函数体里：外层函数的局部量也遮住函数名（与 nameOf 那一档同一条次序）。
  // 这里只**问**在不在，不走 capOf —— capOf 会记一条捕获、还可能发诊断，而这一层只是
  // 在判"这条路走不走"。少了这一句，`fillrule` 这种"外层形参与文件级函数同名"的写法
  // 在闭包里会被当成重载集：plain_picture.asy:1319 的
  // `latticeshade(f,t*g,stroke,fillrule,p,t,false)` 报的就是
  // "没有能匹配 latticeshade(…, <fillrule 的重载集>, …)"。
  if (L.cap !== null) {
    for (const s of L.cap.outer) if (s.has(nm)) return null;
  }
  if (L.selfField(nm) !== null) return null;
  if (L.gvarHere(nm) !== null || L.globals.has(nm)) return null;
  const cands = asyVisible(L, nm);
  if (cands.length < 2) return null;
  // 带默认值的候选也算（第六十刀）：当值用时它的类型就是"全部形参"那一份
  return { nm: nm, cands: cands };
}

/**
 * `new int(int x) { return x + k; }`：**匿名函数**（ADR-0010 那套闭包）。降成一个顶层的
 * `(cfn 名 (捕获) (形参) 返回类型 语句…)`，用的地方是 `(mkclo 名 捕获值…)`。
 *
 * 捕获**边降边收**：作用域换成只有形参的一层，外层那几层留在 `L.cap.outer` 里；
 * 体里引用到外层局部量时 nameOf 落到 capOf，回 `(cap 名)` 并记一条。头是体降完之后才拼的，
 * 所以不必先扫一遍 AST 找自由变量。
 *
 * **与 asy 的差别在这里收窄**：asy 的捕获是按引用的（量过 `int k=1; int f()=new
 * int(){return k;}; k=2; write(f());` 印 2），而 `(mkclo …)` 是按值抓一次。所以外层的
 * 名字如果在那个函数里被赋值过，这一刀**不收**（capOf 里报）—— 收了就是悄悄给旧值。
 * 文件级的名字不受这一条限制：它是 `(var 符号)`，本来就是活读的，与 asy 一样。
 */
export function asyAnonFn(L, n) {
  const ret = L.type(n.items[1], 'new 的返回类型');
  if (ret === null) return null;
  const ps = L.formals(n.items[2]);
  if (ps === null) return null;
  // 形参默认值（第六十刀）：类型文本里**不带**它 —— asy 的函数类型里带（那边印
  // `void(picture pic=<default>, frame f, path g)`），但两个方向的赋值 asy 都收（量过：
  // 没有默认值的函数赋给带默认值的类型、带默认值的函数赋给不带的类型，都通），
  // 所以在"接得住谁"这件事上那一格是可以忽略的。这一层于是照 `void(picture,frame,path)`
  // 记，plain_markers.asy:62 的匿名函数与 markroutine 那个 typedef 就对上了。
  // 差别写在明处：默认值的**表达式**在这里被丢掉了（asy 那边它留在被调方，由
  // push_default 触发），所以通过这个值调的时候一个实参都省不了 —— 那一格在
  // fnValCall 里是一句 nope，不是悄悄给零值。默认值表达式本身也就没有被查过型。
  // 套一层的匿名函数：里层要抓的可能是外层的**捕获**，而捕获不是局部量 —— 另一刀
  if (L.cap !== null) return L.nope(n, '匿名函数里再套一个匿名函数');
  return asyCloFrom(L, n, ret, ps, n.items[3]);
}

/**
 * 造一个闭包：`(cfn 名 (捕获) (形参) 返回类型 语句…)` 进 wraps，回 `(mkclo 名 捕获值…)`。
 * 匿名函数（asyAnonFn）与"函数体里抓了外层局部量的**具名**函数"（lower.js 的 localFunClo，
 * 第六十六刀）共用这一份 —— 两者的区别只在"名字绑在哪儿"，捕获这件事一模一样。
 */
export function asyCloFrom(L, n, ret, ps, bodyNode) {
  const name = `asy__anon${L.anonN++}`;
  const saveScopes = L.scopes;
  const saveUpd = L.updates;
  const saveSelf = L.self;
  L.cap = {
    outer: saveScopes,
    body: L.fnBody,
    // 这个闭包在源文件里的起点：capOf 用它分"改在闭包之前"与"改在之后"
    pos: n.span === undefined || n.span === null ? null : n.span.start,
    list: [],
    seen: new Map(),
  };

  L.scopes = [new Map()];
  L.updates = [];
  L.self = null;   // 闭包体里没有接收者（捕获 this 这一刀不收，见 capOf）
  let bad = false;
  for (const p of ps) if (L.declare(n, p.name, p.type) === null) bad = true;
  const body = bad ? null : asyBody(L, bodyNode, ret);
  const caps = L.cap.list;
  L.cap = null;
  L.scopes = saveScopes;
  L.updates = saveUpd;
  L.self = saveSelf;
  if (body === null) return null;
  // 掉出尾巴补一条零值 ret（与 funBody 同一条：核心方言的检查在编译期）
  const last = body.length === 0 ? '' : body[body.length - 1];
  if (ret !== 'void' && !last.startsWith('(ret ')) {
    let zero = null;
    if (asyIsArr(ret)) zero = `(anew ${asyCore(ret)} (int 0))`;
    else if (L.isRec(ret)) zero = L.recInit(n, ret);
    else zero = ZERO.get(ret);
    if (zero === null || zero === undefined) {
      return L.nope(n, `返回 ${ret} 的闭包（这一刀给不出它的零值）`);
    }
    body.push(`(ret ${zero})`);
  }
  const cs = [];
  const vals = [];
  for (const c of caps) {
    cs.push(`(${c.name} ${asyCore(c.type)})`);
    vals.push(`(var ${c.name})`);
  }
  const params = [];
  const pts = [];
  for (const p of ps) {
    params.push(`(${p.name} ${asyCore(p.type)})`);
    pts.push(p.type);
  }
  const text = [`  (cfn ${name} (${cs.join(' ')}) (${params.join(' ')}) ${asyCore(ret)}`];
  for (const s of body) text.push(`    ${s}`);
  L.wraps.push(`${text.join('\n')})`);
  const sp = vals.length === 0 ? '' : ' ';
  return { code: `(mkclo ${name}${sp}${vals.join(' ')})`, type: `${ret}(${pts.join(',')})` };
}

/**
 * 匿名函数体里的一个名字：它是不是**外层函数的局部量**？
 * 是且抓得动就回 `(cap 名)`（并记一条捕获）；是但抓不动回 CAP_BAD（诊断已发）；
 * 不是就回 null —— 那时 nameOf 接着往下问文件级那一档。
 */
export function asyCapOf(L, node, nm) {
  let t = null;
  for (const s of L.cap.outer) if (s.has(nm)) t = s.get(nm);
  if (t === null) return null;
  const had = L.cap.seen.get(nm);
  if (had !== undefined) return { code: `(cap ${nm})`, type: had };
  if (nm === 'this') {
    L.nope(node, '匿名函数里用外层的 this（捕获接收者是另一刀）');
    return CAP_BAD;
  }
  // 按值 vs asy 的按引用：只有那个名字在**这个闭包之后**还会被改时才是两种语义
  // （闭包之前赋的值，按值抓的时候已经是最新的那一份了）。base 里
  // plain_picture.asy:1294 的 `if(copy) g=copy(g); pic.add(new void(…){ … g … });`
  // 就是"改在前、抓在后"，两种语义同一个结果。
  if (L.cap.body === null || asyAssignsAfter(L, L.cap.body, nm, L.cap.pos, false)) {
    L.nope(node, `捕获会被改的外层变量 '${nm}'（asy 的捕获是按引用的，`
      + '而 (mkclo …) 是按值抓一次 —— 收了就会给旧值)');
    return CAP_BAD;
  }
  L.cap.seen.set(nm, t);
  L.cap.list.push({ name: nm, type: t });
  return { code: `(cap ${nm})`, type: t };
}

/** 这棵子树的位置区间包不包住 pos */
function asySpanHas(node, pos) {
  if (node === null || node === undefined || node.span === undefined || node.span === null) return false;
  return node.span.start <= pos && pos <= node.span.end;
}

/**
 * `nm` 在 `pos`（那个匿名函数字面量的起点）**之后**还被赋值过吗？
 * 保守：认名字不认作用域；`pos` 是 null（拿不到体的 AST）时一律算"会被改"。
 * 循环里那一条要小心：赋值**写在**闭包前面，但循环会让它在闭包之后再跑一遍 ——
 * 所以只要那个循环把 pos 包在里面，循环里对这个名字的赋值都算"之后"。
 */
export function asyAssignsAfter(L, node, nm, pos, inLoop) {
  if (!isList(node)) return false;
  const h = head(node);
  const loop = h === 'while' || h === 'do' || h === 'for' || h === 'for-each';
  const within = inLoop || (loop && asySpanHas(node, pos));
  let lhs = null;
  if (h === 'assign') lhs = node.items[1];
  else if (h === 'self' || h === 'prefix' || h === 'postfix') lhs = node.items[2];
  if (lhs !== null && isList(lhs) && head(lhs) === 'name-exp'
      && L.plainName(lhs.items[1]) === nm) {
    if (pos === null || within) return true;
    if (node.span === undefined || node.span === null || node.span.start >= pos) return true;
  }
  for (const it of node.items) if (asyAssignsAfter(L, it, nm, pos, within)) return true;
  return false;
}


/** 数值提升：asy 允许 `3 == 3.0`（量过），核心方言两边必须同型，于是这里显式插 toreal。
 *  pair 也在这条链上：`2+(1,2)` 是 (3,2)、`(1,2)==3` 是 false —— int/real 会被
 *  提成 `(v,0)`（量过，见 asy__pdiv 的注释：连 `/` 都是先转 pair 再算的）。 */
export function asyPromote(L, a, b) {
  // `null` 的类型从**另一边**来（`x == null`）。这一条要在"两边同型"那句**之前** ——
  // 两边都是 null 时它们的记号确实相等，但那定不下类型，asy 那边也报歧义
  // （量过：`call of function 'operator ==(null, null)' is ambiguous`），所以回 null，
  // 让调用方那句"两边要同型"去报。
  if (a.type === ASY_NULL || b.type === ASY_NULL) {
    if (a.type === b.type) return null;
    const nv = a.type === ASY_NULL ? a : b;
    const ov = a.type === ASY_NULL ? b : a;
    if (!asyRefTy(L, ov.type)) return null;
    nv.code = `(null ${asyCore(ov.type)})`;
    nv.type = ov.type;
    return ov.type;
  }
  if (a.type === b.type) return a.type;
  if (a.type === 'pair' && (b.type === 'int' || b.type === 'real')) {
    const v = asyToPair(L, b);
    b.code = v.code; b.type = 'pair';
    return 'pair';
  }
  if (b.type === 'pair' && (a.type === 'int' || a.type === 'real')) {
    const v = asyToPair(L, a);
    a.code = v.code; a.type = 'pair';
    return 'pair';
  }
  if (a.type === 'int' && b.type === 'real') { a.code = `(toreal ${a.code})`; a.type = 'real'; return 'real'; }
  if (a.type === 'real' && b.type === 'int') { b.code = `(toreal ${b.code})`; b.type = 'real'; return 'real'; }
  return null;
}

/** int/real -> pair，就是 `(v, 0)`。asy 那边这是一条隐式转换，不是重载。 */
export function asyToPair(L, v) {
  const x = v.type === 'int' ? `(toreal ${v.code})` : v.code;
  return { code: `(vlit ${ASY_PAIR_TY} ${x} (real 0.0))`, type: 'pair' };
}

/** 往目标类型靠：int -> real、int/real -> pair，其余不匹配就是错 */
export function asyCoerce(L, v, want, node, what) {
  if (v === null) return null;
  // `null`：类型就是目标类型。目标不是引用类型时这是一处**真错误**（不带 ASY_NOPE）——
  // asy 那边报 "cannot cast 'null' to 'int'"，同一个判断，不是我们还没做。
  if (v.type === ASY_NULL) {
    if (!asyRefTy(L, want)) {
      return L.err(node, `${what}：不能把 null 当成 ${want}`
        + `（asy 那边报 "cannot cast 'null' to '${want}'" —— 只有 struct、`
        + '函数类型与数组有空引用）');
    }
    return { code: `(null ${asyCore(want)})`, type: want };
  }
  if (v.type === want) return v;
  // 不定案的重载集（第三十五刀）：目标类型就是定案的依据。挑不出同型的一份是**错**，
  // 不是"还没做" —— asy 那边报的也是 "no matching variable of name" 那一族。
  if (v.over !== undefined) {
    const pick = asyOverPick(L, { v: v }, want);
    if (pick === null) {
      let list = '';
      for (const c of v.over) {
        const t = asyCandFnType(L, c);
        list = list === '' ? t : `${list}、${t}`;
      }
      return L.err(node, `${what}：要 ${want}，而那个名字的重载里没有同型的一份（有 ${list}）`);
    }
    return { code: pick, type: want };
  }
  if (v.type === 'int' && want === 'real') return { code: `(toreal ${v.code})`, type: 'real' };
  if (want === 'pair' && (v.type === 'int' || v.type === 'real')) return asyToPair(L, v);
  // 同名的**变量遮住了函数名**，而这个位置要的是一个函数类型（第六十二刀）。
  // 候选是 nameOf 挂上来的（见那边的 shadowFns）：这里按目标类型挑同型的一份。
  // 只在类型**一模一样**时改判，且排在用户自定义转换之前（asy 那边精确匹配得分更高）。
  if (asyIsFn(want) && v.shadowFns !== undefined) {
    for (const c of v.shadowFns) {
      if (asyCandFnType(L, c) === want) return { code: `(fnref ${c.sym})`, type: want };
    }
  }
  // 用户定义的转换（第二十七刀）：内建那几条不成才轮到它，源类型要一模一样（不串）
  const uc = L.castFor(want, v.type, false);
  if (uc !== null) return { code: `(call ${uc.sym} ${v.code})`, type: want };
  return L.err(node, `${what}：要 ${want}，这里是 ${v.type}`);
}

export function asyExprList(L, n, h) {
  if (h === 'name-exp') {
    const nm = L.plainName(n.items[1]);
    if (nm === null) {
      // `a.length` / `z.x`：词法上"点"是名字的一部分（`name -> name "." ID`），所以
      // 数组和 pair 的字段都不是 `(field …)` 而是一个**带点的名字**。
      const q = asyDotQual(L, n.items[1]);
      if (q === DOT_BAD) return null;
      if (q !== null) return asyMember(L, n, q.recv, q.field);
      // `Box.n`：类型名限定的 static（见 statQual —— 同名的变量在点号左边赢，所以放这里）
      const sq = L.statQual(n.items[1]);
      if (sq !== null) return { code: `(var ${sq.sym})`, type: sq.type };
      // `m.x`：模块限定的名字（第二十五刀）。变量先查（dotQual 在上面），
      // 所以同名的局部量遮住模块别名。
      const mq = L.modAlias(n.items[1]);
      if (mq !== null) return L.modVar(n, mq);
      return L.nope(n, '带点的名字或算符名');
    }
    // 局部 -> this 的字段 -> 文件级，三档都在 nameOf 里（`cycle` 那个字面量共用它）。
    // 顺序解析：后面才声明的那份文件级变量在这里不算（量过 asy 报
    // "no matching variable of name 'g'"）；struct 的成员遮住同名的文件级名字。
    return asyNameOf(L, n, nm);
  }
  if (h === 'binary') return asyBinary(L, n);
  // `this`（第二十刀）：方法体里就是那个接收者形参。asy 那边 `this` 只在 struct 的
  // 方法里有意义（量过：文件级写 `this` 报 "static use of dynamic variable"）。
  if (h === 'this') {
    if (L.self === null) return L.err(n, "'this' 只能在 struct 的方法里用");
    return { code: '(var this)', type: L.self.rec.name };
  }
  if (h === 'equality') return asyCompare(L, n, n.items[1].value);
  if (h === 'and-exp' || h === 'or-exp') return asyLogic(L, n, h === 'and-exp' ? '&&' : '||');
  if (h === 'unary') return asyUnary(L, n);
  if (h === 'cast') return asyCast(L, n);
  if (h === 'call') return asyCall(L, n);
  if (h === 'cond') return asyCond(L, n);
  if (h === 'assign' || h === 'self' || h === 'prefix') {
    // asy 那边赋值**是表达式**，值就是赋进去的那一个：`x=y=z=0`（plain_picture.asy:185）、
    // `while((i=find(s,d,last)) >= 0)`（plain_strings.asy:102）都靠这条。
    // 这一层的做法：把它当**语句**摊进 this.pre，再把左边读一遍当值 ——
    // 所以只在"左边重读一遍没有副作用"时收（名字、名字的字段、名字下标的常量格）。
    if (!Array.isArray(L.pre)) return L.nope(n, `这个位置的赋值当表达式（'${h}' 要摊成语句，这里放不下）`);
    const tgt = h === 'assign' ? n.items[1] : n.items[2];
    if (!asyRereadable(tgt)) return L.nope(n, `赋值当表达式：左边不是能再读一遍的东西（'${h}'）`);
    const lines = asyExprStmt(L, n);
    if (lines === null) return null;
    for (const s of lines) L.pre.push(s);
    return asyExpr(L, tgt);
  }
  if (h === 'postfix') {
    return L.err(n, 'asy 自己就不收后缀 ++/--（postfix expressions are not allowed）：写成 ++x');
  }

  if (h === 'tuple-exp') return asyPairLit(L, n);
  if (h === 'subscript') return asyIndex(L, n);
  if (h === 'slice-exp') return asySlice(L, n);
  if (h === 'field') return asyField(L, n);
  if (h === 'new-array') return asyNewArray(L, n);
  // `new A`：asy 的 struct 是引用语义的，所以降到核心方言的 `(cnew A)`（或者带默认值时
  // 走生成的构造函数，见 recNew）。`new-function` 要函数值，那是另一刀。
  if (h === 'new-record') {
    const t = L.type(n.items[1], 'new 的类型');
    if (t === null) return null;
    if (!L.isRec(t)) return L.nope(n, `new ${t}`);
    const code = L.recNew(n, t);
    return code === null ? null : { code: code, type: t };
  }
  if (h === 'new-function') return asyAnonFn(L, n);
  if (h === 'arrayinit' || h === 'arrayinit-add' || h === 'arrayinit-rest') {
    // `{1,2,3}` 自己没有类型，类型来自左边的声明 —— 所以只在知道目标类型的地方处理
    return L.nope(n, '花括号数组初值出现在推不出元素类型的位置（只支持 `T[] a = {…}` 与 `new T[] {…}`）');
  }
  if (h === 'scale') return asyScale(L, n);
  if (h === 'join-exp') return asyJoinExp(L, n);
  if (h === 'join-dir' || h === 'spec' || h === 'spec-curl') return L.nope(n, '路径连接');
  return L.nope(n, `表达式 '${h}'`);
}

/* ------------------------------------------------------------------ 数组 */

/** `a[i]` 的**读**侧。写侧在 assign 里，因为写要先扩长（asy 的下标写会长）。 */
export function asyIndex(L, n) {
  const a = asyExpr(L, n.items[1]);
  if (a === null) return null;
  // 记录上的下标：那是 `operator []` 那个方法（第三十二刀，collections/map.asy:26）
  if (L.isRec(a.type)) return asyIdxOpCall(L, n, a, 'operator []', [n.items[2]]);
  if (!asyIsArr(a.type)) return L.err(n, `下标只能用在数组上，这里是 ${a.type}`);
  // `a[ix]`（ix 是 int[]）：挑出来的一份新数组（runarray.in 的 arrayIntArray）。
  // 放在 coerce 之前：int[] -> int 没有这条转换，先问过它才不会把这一种当成错。
  const ixv = asyExpr(L, n.items[2]);
  if (ixv === null) return null;
  if (ixv.type === 'int[]') {
    return { code: `(call ${L.arrHelper('pick', asyElem(a.type))} ${a.code} ${ixv.code})`, type: a.type };
  }
  const i = asyCoerce(L, ixv, 'int', n, '下标');
  if (i === null) return null;
  return { code: `(aget ${a.code} ${i.code})`, type: asyElem(a.type) };
}

/**
 * `a[i:j]` / `a[i:]` / `a[:j]` / `a[:]`。**是复制不是视图**（量过），半开区间，
 * 右边界超长截到末尾。四种形状都落到那两条 helper 上，接收者只印一遍。
 *
 * 形状要按**项数**分，不能只看头：语法里 `[:]` 与 `[i:j]` 的头都是 `slice`
 * （`(-> (":") (slice))` 和 `(-> (exp ":" exp) (slice $1 $3))`）。
 */
export function asySlice(L, n) {
  const a = asyExpr(L, n.items[1]);
  if (a === null) return null;
  if (!asyIsArr(a.type)) return L.err(n, `切片只能用在数组上，这里是 ${a.type}`);
  const s = n.items[2];
  if (!isList(s)) return L.err(n, '认不出的切片');
  const hs = head(s);
  const el = asyElem(a.type);
  const both = hs === 'slice' && s.items.length === 3;
  if (!both && hs !== 'slice' && hs !== 'slice-from' && hs !== 'slice-to') {
    return L.nope(n, `切片的形状 '${hs}'`);
  }
  const loNode = both ? s.items[1] : (hs === 'slice-from' ? s.items[1] : null);
  const hiNode = both ? s.items[2] : (hs === 'slice-to' ? s.items[1] : null);
  const lo = loNode === null
    ? { code: '(int 0)', type: 'int' }
    : asyCoerce(L, asyExpr(L, loNode), 'int', n, '切片的起点');
  if (lo === null) return null;
  const sliceFn = L.arrHelper('slice', el);
  if (hiNode !== null) {
    const hi = asyCoerce(L, asyExpr(L, hiNode), 'int', n, '切片的终点');
    if (hi === null) return null;
    return { code: `(call ${sliceFn} ${a.code} ${lo.code} ${hi.code})`, type: a.type };
  }
  // `a[i:]` 与 `a[:]`：末端是长度
  return { code: `(call ${L.arrHelper('slicefrom', el)} ${a.code} ${lo.code})`, type: a.type };
}

/** `(qualified (name a) F)` 且 a 是**变量**时回 `{recv, field}`，否则回 null；
 *  接收者已经报过错的那种回 DOT_BAD（调用方就不再补一句"认不出的带点名字"）。
 *  只认变量与「变量再点几层」：`模块.名字` 也是这个形状，那要模块系统，这一刀没有。 */
export function asyDotQual(L, node) {
  if (!isList(node) || head(node) !== 'qualified') return null;
  const f = isAtom(node.items[2]) ? node.items[2].value : null;
  if (f === null) return null;
  const base = L.plainName(node.items[1]);
  if (base !== null) {
    const t = L.lookup(base);
    if (t !== null) return { recv: { code: `(var ${base})`, type: t }, field: f };
    // 匿名函数体里：点号左边那个名字也可能是**外层函数的局部量**，那就得捕获进来。
    // 位置照 nameOf 那一档的次序：闭包自己的局部（上面那一句）、外层的局部（这一句）、
    // this 的字段、文件级。少了这一句，`s.f(x)` 这种形状会漏到最后报"调用一个不是普通
    // 名字的东西"—— 话说得偏，真正缺的是捕获。量过 asy：
    // `fn mk(S s){ return new real(real x){ return s.f(x); }; }` 之后 `mk(s)(3)` 印 6；
    // base 里 plain_arrows.asy:364 的 `arrowhead.arcsize(p)` 与 plain_picture.asy:1022 的
    // `srcCopy.fit(…)` 都是这一格。
    if (L.cap !== null) {
      const c = asyCapOf(L, node, base);
      if (c === CAP_BAD) return DOT_BAD;
      if (c !== null) return { recv: c, field: f };
    }
    // 方法体里的裸字段名当接收者（第二十刀）：`inner.get()` 里的 inner 是 this 的字段
    const sf = L.selfField(base);
    if (sf !== null) return { recv: { code: `(fld (var this) ${base})`, type: sf.type }, field: f };
    // 文件级变量当接收者（第三十刀）：`currentpicture.nodes` 这一族。次序与 name-exp
    // 那边一致 —— 局部、this 的字段、文件级，三档。
    const g = L.gvarHere(base);
    if (g !== null && g.ok) return { recv: { code: `(var ${g.sym})`, type: g.type }, field: f };
    return null;
  }
  // `a.p.x`：接收者自己又是一个带点的名字（第十五刀的 pair 字段逼出来的 ——
  // struct 的 pair 字段一进来，`s.p.x` 就成了三层）。递归先把它降成一个值。
  // 这里不怕重复求值：能走到这条路的接收者只有变量读与字段读，两者都没有副作用。
  const inner = asyDotQual(L, node.items[1]);
  if (inner === null) return null;
  if (inner === DOT_BAD) return DOT_BAD;
  const recv = asyMember(L, node.items[1], inner.recv, inner.field);
  return recv === null ? DOT_BAD : { recv, field: f };
}

/** `(field 值 ID)`：`a[0].x` 这种（点后面跟的不是名字而是别的表达式时走这条） */
export function asyField(L, n) {
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  const a = asyExpr(L, n.items[1]);
  if (a === null) return null;
  return asyMember(L, n, a, nm);
}

/** 取字段。数组只有 `.length`，pair 只有 `.x`/`.y`，记录按声明的字段来；别的都还没做。 */
export function asyMember(L, n, recv, nm) {
  if (asyIsArr(recv.type)) {
    if (nm === 'length') return { code: `(alen ${recv.code})`, type: 'int' };
    return L.nope(n, `数组的 '.${nm}'（这一刀只有 .length / .push / .pop）`);
  }
  if (L.isRec(recv.type)) {
    // `a.n`：`n` 可能是 **static**（那不是这个对象的槽，是一个文件级变量 —— 量过
    // `a.n = 7` 之后 `b.n` 也是 7）。放在字段前面问：static 与字段同名在 staticDec 里拦掉了。
    const s = L.statOf(recv.type, nm);
    if (s !== null) return { code: `(var ${s.sym})`, type: s.type };
    // `a.get`（不是 `a.get()`）：名字是个**方法**，取出来是绑住接收者的闭包（第四十三刀）。
    // 字段之后问 —— 取值这一边一直是字段先赢。回 undefined 就是"不是方法"。
    const mv = L.methodValAt(n, recv, nm);
    if (mv !== undefined) return mv;
    const f = L.recField(n, recv.type, nm);
    return f === null ? null : { code: `(fld ${recv.code} ${nm})`, type: f.type };
  }
  if (recv.type === 'pair') {
    if (nm === 'x') return { code: `(lane ${recv.code} 0)`, type: 'real' };
    if (nm === 'y') return { code: `(lane ${recv.code} 1)`, type: 'real' };
    return L.nope(n, `pair 的 '.${nm}'（这一刀只有 .x / .y）`);
  }
  if (recv.type === 'triple') {
    if (nm === 'x') return { code: `(lane ${recv.code} 0)`, type: 'real' };
    if (nm === 'y') return { code: `(lane ${recv.code} 1)`, type: 'real' };
    if (nm === 'z') return { code: `(lane ${recv.code} 2)`, type: 'real' };
    return L.nope(n, `triple 的 '.${nm}'（这一刀只有 .x / .y / .z）`);
  }
  return L.nope(n, `取字段 '.${nm}'`);
}

/* -------------------------------------------------------------------- pair */

/** `(x,y)` 是 pair、`(x,y,z)` 是 triple。分量按 int -> real 提升。 */
export function asyPairLit(L, n) {
  const parts = L.flat(n.items[1], 'args');
  if (parts.length === 3) return asyTripleLit(L, n, parts);
  if (parts.length !== 2) return L.nope(n, `${parts.length} 个分量的字面量`);
  const x = asyCoerce(L, asyExpr(L, parts[0]), 'real', parts[0], 'pair 的 x');
  const y = asyCoerce(L, asyExpr(L, parts[1]), 'real', parts[1], 'pair 的 y');
  if (x === null || y === null) return null;
  return { code: `(vlit ${ASY_PAIR_TY} ${x.code} ${y.code})`, type: 'pair' };
}

/** `(x,y,z)`。第 3 道垫 0（见 ASY_TRIPLE_TY 上方那段：MIR 的宽度是对数编码）。 */
export function asyTripleLit(L, n, parts) {
  const x = asyCoerce(L, asyExpr(L, parts[0]), 'real', parts[0], 'triple 的 x');
  const y = asyCoerce(L, asyExpr(L, parts[1]), 'real', parts[1], 'triple 的 y');
  const z = asyCoerce(L, asyExpr(L, parts[2]), 'real', parts[2], 'triple 的 z');
  if (x === null || y === null || z === null) return null;
  return { code: `(vlit ${ASY_TRIPLE_TY} ${x.code} ${y.code} ${z.code} (real 0.0))`, type: 'triple' };
}

/** pair / triple 上的内建函数（名单见 ASY_PAIRFN）。实参是 int/real 时先隐式转成 pair。 */
export function asyPairCall(L, n, nm) {
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  // dot / cross / realmult：pair 与 triple 各一个重载，两组都量过
  // （dot((1,2),(3,4))=11、cross(pair,pair) 给**实数** -2、realmult 逐分量；
  //  triple 那三条给 32 / (-3,6,-3) / (4,10,18)）
  if (nm === 'dot' || nm === 'cross' || nm === 'realmult') return asyVecPairFn(L, n, nm, args);
  // dir/expi：一个实参是 pair 那一族（度 / 弧度），**两个**实参是 triple 那一族
  // （量过 dir(30,45) 与 expi(0.5,1.0) 都给 triple）；dir(pair) 是 unit 的别名
  if (nm === 'dir' || nm === 'expi') {
    if (args.length === 2) return asyTripleDir(L, n, nm, args);
    if (args.length !== 1) return L.err(n, `'${nm}' 要 1 或 2 个实参，给了 ${args.length} 个`);
    const v0 = asyExpr(L, args[0]);
    if (v0 === null) return null;
    if (nm === 'dir' && v0.type === 'pair') return asyUnitOf(L, v0);
    const r = asyCoerce(L, v0, 'real', args[0], `'${nm}' 的实参`);
    if (r === null) return null;
    L.used.add('asy__pexpi');
    if (nm === 'expi') return { code: `(call asy__pexpi ${r.code})`, type: 'pair' };
    L.used.add('asy__pdir');
    return { code: `(call asy__pdir ${r.code})`, type: 'pair' };
  }
  // angle(z) / angle(z, warn)：第二个实参量过是 bool，默认 true
  if (nm === 'angle') {
    if (args.length < 1 || args.length > 2) {
      return L.err(n, `'angle' 要 1 或 2 个实参，给了 ${args.length} 个`);
    }
    const z = asyCoerce(L, asyExpr(L, args[0]), 'pair', args[0], "'angle' 的实参");
    if (z === null) return null;
    let warn = '(bool true)';
    if (args.length === 2) {
      const w = asyCoerce(L, asyExpr(L, args[1]), 'bool', args[1], "'angle' 的 warn");
      if (w === null) return null;
      warn = w.code;
    }
    L.used.add('asy__pangle');
    return { code: `(call asy__pangle ${z.code} ${warn})`, type: 'real' };
  }
  if (args.length !== 1) return L.err(n, `'${nm}' 要 1 个实参，给了 ${args.length} 个`);
  const v0 = asyExpr(L, args[0]);
  if (v0 === null) return null;
  // triple 那一族。conj/angle 在 triple 上 asy 自己就没有（量过 "no matching function
  // 'conj(triple)'" / "'angle(triple)'"），所以是**错**而不是"还没做"。
  if (v0.type === 'triple') {
    if (nm === 'xpart') return { code: `(lane ${v0.code} 0)`, type: 'real' };
    if (nm === 'ypart') return { code: `(lane ${v0.code} 1)`, type: 'real' };
    if (nm === 'zpart') return { code: `(lane ${v0.code} 2)`, type: 'real' };
    if (nm === 'unit') return asyTunitOf(L, v0);
    return L.err(n, `'${nm}(triple)' asy 那边没有这个重载`);
  }
  // zpart 只有 triple 那一个重载（量过 zpart((1,2)) 是 "cannot call 'real zpart(triple v)'"）
  if (nm === 'zpart') return L.err(n, `'zpart' 只收 triple，这里是 ${v0.type}`);
  const v = asyCoerce(L, v0, 'pair', args[0], `'${nm}' 的实参`);
  if (v === null) return null;
  if (nm === 'xpart') return { code: `(lane ${v.code} 0)`, type: 'real' };
  if (nm === 'ypart') return { code: `(lane ${v.code} 1)`, type: 'real' };
  if (nm === 'unit') return asyUnitOf(L, v);
  L.used.add('asy__pconj');
  return { code: `(call asy__pconj ${v.code})`, type: 'pair' };
}

/** `dot` / `cross` / `realmult`：两个实参，pair 与 triple 各一个重载。 */
export function asyVecPairFn(L, n, nm, args) {
  if (args.length !== 2) return L.err(n, `'${nm}' 要 2 个实参，给了 ${args.length} 个`);
  const a = asyExpr(L, args[0]);
  const b = asyExpr(L, args[1]);
  if (a === null || b === null) return null;
  if (a.type === 'triple' || b.type === 'triple') {
    if (a.type !== 'triple' || b.type !== 'triple') {
      return L.err(n, `'${nm}' 的两个实参要同型：左是 ${a.type}，右是 ${b.type}（asy 那边没有到 triple 的转换）`);
    }
    const h = nm === 'dot' ? 'asy__tdot' : (nm === 'cross' ? 'asy__tcross' : 'asy__trealmult');
    L.used.add(h);
    return { code: `(call ${h} ${a.code} ${b.code})`, type: nm === 'dot' ? 'real' : 'triple' };
  }
  const av = asyCoerce(L, a, 'pair', args[0], `'${nm}' 的左实参`);
  const bv = asyCoerce(L, b, 'pair', args[1], `'${nm}' 的右实参`);
  if (av === null || bv === null) return null;
  const h = nm === 'dot' ? 'asy__pdot' : (nm === 'cross' ? 'asy__pcross' : 'asy__prealmult');
  L.used.add(h);
  // cross(pair,pair) 回的是**实数**（量过 -2），不是 pair
  return { code: `(call ${h} ${av.code} ${bv.code})`, type: nm === 'realmult' ? 'pair' : 'real' };
}

/** `dir(θ,φ)` / `expi(θ,φ)`：两个实参那一族回 triple（dir 收度、expi 收弧度）。 */
export function asyTripleDir(L, n, nm, args) {
  const t = asyCoerce(L, asyExpr(L, args[0]), 'real', args[0], `'${nm}' 的第一个实参`);
  const p = asyCoerce(L, asyExpr(L, args[1]), 'real', args[1], `'${nm}' 的第二个实参`);
  if (t === null || p === null) return null;
  L.used.add('asy__texpi');
  if (nm === 'expi') return { code: `(call asy__texpi ${t.code} ${p.code})`, type: 'triple' };
  L.used.add('asy__tdir');
  return { code: `(call asy__tdir ${t.code} ${p.code})`, type: 'triple' };
}

/** unit(triple) */
export function asyTunitOf(L, v) {
  L.used.add('asy__tabs');
  L.used.add('asy__tsdiv');
  L.used.add('asy__tunit');
  return { code: `(call asy__tunit ${v.code})`, type: 'triple' };
}

/** unit(z)：`dir(pair)` 也走它（量过两者同值） */
export function asyUnitOf(L, v) {
  L.used.add('asy__pabs');
  L.used.add('asy__punit');
  return { code: `(call asy__punit ${v.code})`, type: 'pair' };
}

/* ----------------------------------------------------------------- 字符串 */

/**
 * `length(…)`：asy 只有 string 和 pair 两个重载 —— 量过 `length(int[])` 是
 * "no matching function 'length(int[])'"（数组用 `a.length`），所以这里也拒，
 * 而且拒得不带 ASY_NOPE：这不是"还没做"，是 asy 自己就没有。
 */
export function asyLengthCall(L, n) {
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  if (args.length !== 1) return L.err(n, `'length' 要 1 个实参，给了 ${args.length} 个`);
  const v = asyExpr(L, args[0]);
  if (v === null) return null;
  return asyLengthOf(L, v, args[0]);
}

/** length 的后半段：实参**已经降好**。按值分出来是给"同名的模块函数一个都不合用"那条
 *  回退路用的（见 callName / builtinRaw）—— 实参不能求两次。 */
export function asyLengthOf(L, v, at) {
  if (v.type === 'string') return { code: `(slen ${v.code})`, type: 'int' };
  if (v.type === 'pair' || v.type === 'int' || v.type === 'real') {
    const p = asyCoerce(L, v, 'pair', at, "'length' 的实参");
    if (p === null) return null;
    L.used.add('asy__pabs');
    return { code: `(call asy__pabs ${p.code})`, type: 'real' };
  }
  if (v.type === 'triple') {
    L.used.add('asy__tabs');
    return { code: `(call asy__tabs ${v.code})`, type: 'real' };
  }
  return L.err(at, `length(${v.type}) 在 asy 那边就是 no matching function（数组的长度写 a.length）`);
}

/** 字符串上的内建函数（名单与形参类型见 ASY_STRFN）。 */
export function asyStrCall(L, n, nm) {
  const spec = ASY_STRFN.get(nm);
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  const max = spec.params.length;
  if (args.length < spec.min || args.length > max) {
    const want = spec.min === max ? `${max}` : `${spec.min} 或 ${max}`;
    return L.err(n, `'${nm}' 要 ${want} 个实参，给了 ${args.length} 个`);
  }
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const v = asyCoerce(L, asyExpr(L, args[i]), spec.params[i], args[i], `'${nm}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    parts.push(v.code);
  }
  let fn = spec.fn;
  if (nm === 'substr' && args.length === 2) fn = spec.short;
  else if (nm === 'find' && args.length === 2) parts.push('(int 0)');
  L.used.add(fn);
  for (const d of ASY_STR_DEPS.get(fn) ?? []) L.used.add(d);
  return { code: `(call ${fn} ${parts.join(' ')})`, type: spec.ret };
}

/**
 * `string(x)` —— asy 只有两条重载（量过 `asy -noV`，别的都是 no matching function）：
 *   `string(Int)`                          -> 整数的十进制
 *   `string(real x, Int digits=DBL_DIG)`   -> DBL_DIG 就是 15；`string(3,4)` 走这一条
 * bool / pair / string 都**不收**（量过：`string(true)`、`string((1,2))`、`string("a")`
 * 那边全是 no matching function），所以这里也不收 —— 多收就是比 asy 多接受一门语言。
 * 印出来的形状与 `write` 是同一份，所以借 fmtStr（real 那一档正好是 %.15g）。
 * 绘图层（stage0/lib/asy/）要拼 PostScript 文本，它缺的就是这一个。
 */
export function asyStrConvCall(L, n) {
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  if (args.length === 1) {
    const v = asyExpr(L, args[0]);
    if (v === null) return null;
    if (v.type !== 'int' && v.type !== 'real') {
      return L.err(n, `string(${v.type}) 在 asy 那边就是 no matching function`
        + '（string 只有 string(int) 与 string(real, int)）');
    }
    return { code: asyFmtStr(L, v.type, v.code), type: 'string' };
  }
  if (args.length === 2) {
    const v = asyCoerce(L, asyExpr(L, args[0]), 'real', args[0], "'string' 的第 1 个实参");
    const d = asyCoerce(L, asyExpr(L, args[1]), 'int', args[1], "'string' 的第 2 个实参（有效位数）");
    if (v === null || d === null) return null;
    return { code: `(tostr ${v.code} ${d.code})`, type: 'string' };
  }
  return L.err(n, `'string' 要 1 或 2 个实参，给了 ${args.length} 个`);
}

/**
 * `new T[n]` / `new T[]` / `new T[] {…}`，以及多维的 `new T[n][m]` / `new T[n][]`。
 *
 * `new T[n]` 的 n 个格子在 asy 那边是**未初始化**的，读会当场报错
 * （量过：`int[] b = new int[2]; write(b[0]);` -> "read uninitialized value from array
 * at index 0"）；我们填零值。差别写在文件头 —— 这类程序本来就是有 bug 的，
 * 但"我们给 0 而 asy 报错"必须写在明处，不能等着被发现。
 *
 * 多维的三种写法量过 asy 的行为，我们逐条对上：
 *   `new real[2][3]` 两层都铺满（我们生一个构造器函数，逐行 aset 一条新的）；
 *   `new real[2][]`  外层铺 2 格、**每格是空引用**（`a[0][0]` 报 dereference of null array，
 *                    我们的 `anew` 铺的正是空引用，读它是同一句运行期错误）；
 *   `new real[][]`   长度 0。
 */
export function asyNewArray(L, n) {
  const el = L.type(n.items[1], 'new 的元素类型');
  if (el === null) return null;
  if (el === 'void') return L.err(n, 'new void[] 不是一个类型');
  if (!L.arrElemOk(el)) return L.nope(n, `${el}[] （${ASY_ARRELEM_TEXT}）`);
  const dimexps = n.items[2];
  const hasCount = isList(dimexps) && (head(dimexps) === 'dimexps' || head(dimexps) === 'dimexps-add');
  const tail = n.items[3];
  const init = n.items[hasCount ? 3 : 4];
  // 尾巴上那串空 `[]`（`new real[2][]` 的第二层）。有初值时 items[3] 就是它。
  let empty = 0;
  if (tail !== undefined && isList(tail) && (head(tail) === 'dims' || head(tail) === 'dims+')) {
    const d = L.dimsDepth(tail);
    if (d === null) return L.err(n, 'new 里认不出的数组维数形状');
    empty = d;
  }
  // 元素类型 = celltype 再套上那串空 `[]`；`new real[2][]` 的元素就是 `real[]`。
  // 没给长度时（`new real[]`）那串空 `[]` **就是**数组本身的维数，不是额外的一层。
  const counts = hasCount ? L.flat(dimexps, 'dimexps') : [];
  const under = hasCount ? empty : empty - 1;
  const over = hasCount ? counts.length : 1;
  let base = el;
  let i = 0;
  while (i < under) { base = `${base}[]`; i++; }
  let t = base;
  i = 0;
  while (i < over) { t = `${t}[]`; i++; }
  if (init !== undefined && isList(init) && head(init).startsWith('arrayinit')) {
    if (hasCount) return L.nope(n, '既给长度又给花括号初值');
    return asyArrLit(L, init, t);
  }
  if (!hasCount) return { code: `(anew ${asyCore(t)} (int 0))`, type: t };
  const vals = [];
  for (const c of counts) {
    const v = asyCoerce(L, asyExpr(L, c), 'int', c, 'new T[n] 的长度');
    if (v === null) return null;
    vals.push(v.code);
  }
  if (counts.length === 1) return { code: `(anew ${asyCore(t)} ${vals[0]})`, type: t };
  let as = '';
  for (const v of vals) as = `${as} ${v}`;
  return { code: `(call ${L.arrNewHelper(base, counts.length)}${as})`, type: t };
}

/**
 * 花括号数组初值。核心方言里没有"数组字面量"这一条，所以摊成一串语句：
 * 先 anew 一个空的，再逐个 apush，最后把临时量当值用。这跟 `? :` 用的是同一套
 * `L.pre` 机制 —— 摊出来的语句落在**当前语句之前**，求值顺序不变。
 *
 * 元素本身是数组时（`new real[][] {{1,2},{3,4,5}}`）里面那一层花括号**递归**走这里 ——
 * 走 asyExpr(L, x) 是不行的：那一层看不见"我该是 real[]"，只会报"推不出元素类型"。
 * 每一项各摊一个临时量，所以两行不会共用同一条（asy 那边也是两条独立的行）。
 */
export function asyArrLit(L, n, t) {
  if (L.pre === null) return L.nope(n, '这个位置的花括号数组初值（它要摊成语句，这里放不下）');
  const el = asyElem(t);
  const items = [];
  if (head(n) === 'arrayinit-rest') return L.nope(n, '`{…, ...rest}` 这种初值');
  for (const x of L.flat(n, 'arrayinit')) items.push(x);
  const nm = `asy__a${L.tmp++}`;
  L.pre.push(`(let ${nm} ${asyCore(t)} (anew ${asyCore(t)} (int 0)))`);
  for (const x of items) {
    const nested = asyIsArr(el) && isList(x) && head(x).startsWith('arrayinit');
    const v = nested ? asyArrLit(L, x, el)
      : asyCoerce(L, asyExpr(L, x), el, x, `${t} 初值里的一项`);
    if (v === null) return null;
    L.pre.push(`(apush (var ${nm}) ${v.code})`);
  }
  return { code: `(var ${nm})`, type: t };
}

/** `a.push(v)` / `a.pop()`。asy 里 push 返回压进去的那个值（量过 `int x = c.push(9);`）。 */
export function asyArrMethod(L, n, recv, nm) {
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  const el = asyElem(recv.type);
  if (nm === 'pop') {
    if (args.length !== 0) return L.err(n, `'pop' 不要实参，给了 ${args.length} 个`);
    return { code: `(apop ${recv.code})`, type: el };
  }
  if (nm === 'delete') {
    // `a.delete()` 清空、`a.delete(i)` 删一格、`a.delete(i, j)` 删**闭区间**（量过）。
    // 三条都回 void，所以照原样当一个表达式发出去，语句层会套 `(expr …)`。
    if (args.length === 0) {
      return { code: `(call ${L.arrHelper('clear', el)} ${recv.code})`, type: 'void' };
    }
    if (args.length > 2) return L.err(n, `'delete' 要 0 到 2 个实参，给了 ${args.length} 个`);
    const i = asyCoerce(L, asyExpr(L, args[0]), 'int', args[0], "'delete' 的下标");
    if (i === null) return null;
    if (args.length === 1) {
      return { code: `(call ${L.arrHelper('del', el)} ${recv.code} ${i.code} ${i.code})`, type: 'void' };
    }
    const j = asyCoerce(L, asyExpr(L, args[1]), 'int', args[1], "'delete' 的右端");
    if (j === null) return null;
    return { code: `(call ${L.arrHelper('del', el)} ${recv.code} ${i.code} ${j.code})`, type: 'void' };
  }
  if (nm === 'insert') {
    // `a.insert(i, x, y, …)`：asy 的 insert 是可变实参的，量过 `s.insert(1,'q','r')` 出来是
    // x q r y —— 也就是连着的几次"在 i、i+1、… 处插一格"。一格时不必摊语句。
    if (args.length < 2) return L.err(n, `'insert' 要至少 2 个实参，给了 ${args.length} 个`);
    const i = asyCoerce(L, asyExpr(L, args[0]), 'int', args[0], "'insert' 的下标");
    if (i === null) return null;
    const ins = L.arrHelper('ins', el);
    if (args.length === 2) {
      const v = asyCoerce(L, asyExpr(L, args[1]), el, args[1], "'insert' 的实参");
      if (v === null) return null;
      return { code: `(call ${ins} ${recv.code} ${i.code} ${v.code})`, type: 'void' };
    }
    // 多个值：接收者与下标都只能求一次，所以先绑临时量
    if (L.pre === null) return L.nope(n, '这个位置的多值 `.insert(…)`（它要摊成语句，这里放不下）');
    const av = `asy__ia${L.tmp++}`;
    const iv = `asy__ii${L.tmp++}`;
    L.pre.push(`(let ${av} ${asyCore(recv.type)} ${recv.code})`);
    L.pre.push(`(let ${iv} int ${i.code})`);
    for (let k = 1; k < args.length; k++) {
      const v = asyCoerce(L, asyExpr(L, args[k]), el, args[k], "'insert' 的实参");
      if (v === null) return null;
      const at = k === 1 ? `(var ${iv})` : `(bin "+" (var ${iv}) (int ${k - 1}))`;
      L.pre.push(`(expr (call ${ins} (var ${av}) ${at} ${v.code}))`);
    }
    return { code: '(int 0)', type: 'void' };
  }
  if (nm === 'append') {
    // `a.append(b)`：把 b 的元素接到 a 后面（runarray.in 的 appendArray），回 void。
    if (args.length !== 1) return L.err(n, `'append' 要 1 个实参，给了 ${args.length} 个`);
    const b = asyCoerce(L, asyExpr(L, args[0]), recv.type, args[0], "'append' 的实参");
    if (b === null) return null;
    return { code: `(call ${L.arrHelper('append', el)} ${recv.code} ${b.code})`, type: 'void' };
  }
  if (nm !== 'push') return L.nope(n, `数组的 '.${nm}(…)'（这一刀只有 .push / .pop / .delete / .insert / .append）`);

  if (args.length !== 1) return L.err(n, `'push' 要 1 个实参，给了 ${args.length} 个`);
  const v = asyCoerce(L, asyExpr(L, args[0]), el, args[0], "'push' 的实参");
  if (v === null) return null;
  // apush 在核心方言里是**语句**（它的"值"没人用），而 asy 的 push 是表达式且返回那个值。
  // 摊成 pre：先把值绑到临时量（只算一次），push 它，再把临时量当结果。
  if (L.pre === null) return L.nope(n, '这个位置的 `.push(…)`（它要摊成语句，这里放不下）');
  const tmp = `asy__p${L.tmp++}`;
  L.pre.push(`(let ${tmp} ${asyCore(el)} ${v.code})`);
  L.pre.push(`(apush ${recv.code} (var ${tmp}))`);
  return { code: `(var ${tmp})`, type: el };
}

/** 算术。asy 与核心方言不一致的四个算符（`/` `#` `%` `^`）全在这里换掉。 */
export function asyBinary(L, n) {
  const op = asyOpText(n.items[1]) ?? '?';
  const a = asyExpr(L, n.items[2]);
  const b = asyExpr(L, n.items[3]);
  if (a === null || b === null) return null;
  return asyArith(L, n, op, a, b);
}

/**
 * 隐式缩放 `3cm`。asy 那边这**就是** `operator *(3, cm)`，一点别的都没有 —— 量过：
 *   `real cm=2.5; write(3cm)` -> 7.5、`int k=4; write(3k)` -> 12（还是 int）、
 *   `write(2.5cm)` -> 6.25、`pair p=(1,2); write(2p)` -> (2,4)、`write(2(1,2))` -> (2,4)、
 *   `write(-3cm)` -> -7.5、`write(3cm*2)` -> 15（缩放比 `*` 紧），
 *   而 `string s="ab"; write(2s)` 报的是 "no matching function 'operator *(int, string)'"。
 * 所以这里不另立类型规则，直接走 `*` 那一条（用户定义的 `operator *` 也就跟着能用）。
 */
export function asyScale(L, n) {
  const a = asyExpr(L, n.items[1]);
  const b = asyExpr(L, n.items[2]);
  if (a === null || b === null) return null;
  return asyArith(L, n, '*', a, b);
}

/** `a op b`：两边都已经降好了。缩放（`3cm`）也从这里进来。 */
export function asyArith(L, n, op, a, b) {
  // 提升前的右操作数留一份：`opBuiltinSig` 里的 `promote` 会**就地**把 int 提成 pair，
  // 而 asy 的 `^` 在 pair 上是**两个重载**、按指数的静态类型分路（见下面 op === '^'）。
  const b0 = { code: b.code, type: b.type };
  // 用户定义的算符先问一遍（第二十三刀）：它跟内建在同一张候选表里，见 opUser
  const u = asyOpUser(L, n, op, [a, b], asyOpBuiltinSig(L, [a, b]));
  if (u !== null) return u;
  if (op === '<' || op === '<=' || op === '>' || op === '>=') return asyCmpCode(L, n, op, a, b);
  if (op === '#') {
    if (a.type !== 'int' || b.type !== 'int') return L.err(n, `'#' 两边要是 int，这里是 ${a.type} 和 ${b.type}`);
    L.used.add('asy__quot');
    return { code: `(call asy__quot ${a.code} ${b.code})`, type: 'int' };
  }
  if (op === '%') {
    // pair 上 asy 自己就没有 `%`（量过："no matching function 'operator %(pair, int)'"），
    // 所以这条是**错**，不是"还没做"。
    if (a.type === 'pair' || b.type === 'pair') return L.err(n, `pair 上没有 '%'（asy 那边也没有这个算符）`);
    if (a.type === 'triple' || b.type === 'triple') return L.err(n, `triple 上没有 '%'（asy 那边也没有这个算符）`);
    if (a.type === 'int' && b.type === 'int') {
      L.used.add('asy__mod');
      return { code: `(call asy__mod ${a.code} ${b.code})`, type: 'int' };
    }
    // real 上那一格（第六十九刀）：mathop.h:244 的 mod<T> 走 mod.h:21 的 portableMod ——
    // fmod 之后"符号不跟着除数就加一个除数"。plain_pens.asy:291 的 `(h % 360)/60` 在等它。
    if (a.type !== 'real' || b.type !== 'real') {
      return L.err(n, `'%' 两边要是 int 或 real，这里是 ${a.type} 和 ${b.type}`);
    }
    L.used.add('asy__rmod');
    return { code: `(call asy__rmod ${a.code} ${b.code})`, type: 'real' };
  }
  if (op === '^') {
    // triple 上 asy 自己就没有 `^`（量过："no matching function 'operator ^(triple, int)'"）
    if (a.type === 'triple' || b.type === 'triple') return L.err(n, `triple 上没有 '^'（asy 那边也没有这个算符）`);
    // pair 上的 `^` 是**复数幂**，而且 asy 是**两个重载**，判据是指数的**静态类型**、
    // 不是值：`int k=30; (1,2)^k` 给精确的 (-6890111163,29729597084)，而 `real e=30;`
    // 与 `pair w=(30,0);` 都给 (-6890111162.99996,…)（三条都量过）。所以这里按 b 的
    // 类型分路，不是"看看指数是不是整数"。
    if (a.type === 'pair' || b.type === 'pair') {
      const av = asyCoerce(L, a, 'pair', n, "'^' 的左边");
      if (av === null) return null;
      L.used.add('asy__pmul');
      if (b0.type === 'int') {
        L.used.add('asy__pdiv');
        L.used.add('asy__ppowi');
        return { code: `(call asy__ppowi ${av.code} ${b0.code})`, type: 'pair' };
      }
      const bv = asyCoerce(L, b, 'pair', n, "'^' 的右边");
      if (bv === null) return null;
      L.used.add('asy__pabs');
      L.used.add('asy__ppowz');
      return { code: `(call asy__ppowz ${av.code} ${bv.code})`, type: 'pair' };
    }
    if (a.type === 'int' && b.type === 'int') {
      L.used.add('asy__ipow');
      return { code: `(call asy__ipow ${a.code} ${b.code})`, type: 'int' };
    }
    // 有一边是 real 就走 pow（量过：`2.0^3` 是 8、`2^0.5` 是 1.4142135623731）
    const av = asyCoerce(L, a, 'real', n, "'^' 的左边");
    const bv = asyCoerce(L, b, 'real', n, "'^' 的右边");
    if (av === null || bv === null) return null;
    return { code: `(rmath "pow" ${av.code} ${bv.code})`, type: 'real' };
  }
  if (op === '/') {
    // pair 上的 `/` 是复数除法（两边都先转成 pair —— 量过，见 asy__pdiv）
    if (a.type === 'pair' || b.type === 'pair') return asyPairArith(L, n, op, a, b);
    if (a.type === 'triple' || b.type === 'triple') return asyTripleArith(L, n, op, a, b);
    // asy 的 `/` 永远是实数除法：`1/3` 是 0.333…，整数商要写 `#`（量过）
    const av = asyCoerce(L, a, 'real', n, "'/' 的左边");
    const bv = asyCoerce(L, b, 'real', n, "'/' 的右边");
    if (av === null || bv === null) return null;
    return { code: `(bin "/" ${av.code} ${bv.code})`, type: 'real' };
  }
  if (op !== '+' && op !== '-' && op !== '*') return L.nope(n, `算符 '${op}'`);
  if (a.type === 'pair' || b.type === 'pair') return asyPairArith(L, n, op, a, b);
  if (a.type === 'triple' || b.type === 'triple') return asyTripleArith(L, n, op, a, b);
  const t = asyPromote(L, a, b);
  if (t === null) return L.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
  if (t === 'string' && op !== '+') return L.err(n, `字符串上只有 '+'，这里是 '${op}'`);
  if (t === 'bool') return L.err(n, `'${op}' 不接受 bool`);
  // 记录与函数类型上 asy 自己就没有 `+ - *`（量过：`A a; a+a` 报 "no matching function
  // 'operator +(A, A)'"、`F f; f+f` 报 "'operator +(int(), int())'"）—— 用户自己定义一个
  // 是通的，那一条在上面 opUser 里先问过了。所以到这里就是**错**，不是"还没做"。
  // 这个洞是量 `a + null` 时撞出来的：原先它一路落到 `(bin "+" …)`，在 JS 后端上
  // 崩成 `js.bin: + on class`（一处内部错，不是诊断）。数组是另一回事 ——
  // asy 那边 `int[]+int[]` 是**逐元素**的（量过给 4 6），那是还没做。
  if (asyIsArr(t)) return L.nope(n, `数组上的 '${op}'（asy 那边它是逐元素的）`);
  if (L.isRec(t) || asyIsFn(t)) {
    return L.err(n, `${t} 上没有 '${op}'（asy 那边报 "no matching function `
      + `'operator ${op}(${t}, ${t})'" —— 自己定义一个 \`operator ${op}\` 就有了）`);
  }
  return { code: `(bin "${op}" ${a.code} ${b.code})`, type: t };
}

/** pair 上的 `+ - * /`。`+ -` 是逐分量的（向量的 `+ -` 正好就是），`* /` 是复数乘除。 */
export function asyPairArith(L, n, op, a, b) {
  const av = asyCoerce(L, a, 'pair', n, `'${op}' 的左边`);
  const bv = asyCoerce(L, b, 'pair', n, `'${op}' 的右边`);
  if (av === null || bv === null) return null;
  if (op === '+' || op === '-') return { code: `(bin "${op}" ${av.code} ${bv.code})`, type: 'pair' };
  const helper = op === '*' ? 'asy__pmul' : 'asy__pdiv';
  L.used.add(helper);
  return { code: `(call ${helper} ${av.code} ${bv.code})`, type: 'pair' };
}

/**
 * triple 上的 `+ - * /`。跟 pair **不一样**，这一族没有复数那回事，量出来的是：
 *   `+ -` 逐分量（triple 两边同型；`(1,2,3)+1` 在 asy 是
 *         "no matching function 'operator +(triple, int)'" —— 没有 real->triple 这条转换）
 *   `*`   triple 与 **real** 逐分量相乘，两个次序都有（`t*2.5` 与 `2.5*t` 都给 (2.5,5,7.5)）；
 *         `triple*triple` asy 自己就没有（"no matching function 'operator *(triple, triple)'"），
 *         逐分量乘要写 `realmult`
 *   `/`   只有 triple/real（`2/t` 在 asy 也是 no matching function）
 */
export function asyTripleArith(L, n, op, a, b) {
  const num = (v) => v.type === 'int' || v.type === 'real';
  if (op === '+' || op === '-') {
    if (a.type !== 'triple' || b.type !== 'triple') {
      return L.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}（asy 那边没有 int/real 到 triple 的转换）`);
    }
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'triple' };
  }
  if (op === '*') {
    const t = a.type === 'triple' ? a : b;
    const s = a.type === 'triple' ? b : a;
    if (t.type === s.type) return L.err(n, `triple 上没有 'triple * triple'（asy 那边逐分量乘要写 realmult）`);
    if (!num(s)) return L.err(n, `'*' 的另一边要是 int 或 real，这里是 ${s.type}`);
    const sv = asyCoerce(L, s, 'real', n, "'*' 的实数那边");
    if (sv === null) return null;
    L.used.add('asy__tsmul');
    return { code: `(call asy__tsmul ${t.code} ${sv.code})`, type: 'triple' };
  }
  if (a.type !== 'triple' || !num(b)) {
    return L.err(n, `'/' 只有 triple / real 这一个重载：左是 ${a.type}，右是 ${b.type}`);
  }
  const sv = asyCoerce(L, b, 'real', n, "'/' 的右边");
  if (sv === null) return null;
  L.used.add('asy__tsdiv');
  return { code: `(call asy__tsdiv ${a.code} ${sv.code})`, type: 'triple' };
}

export function asyCmpCode(L, n, op, a, b) {
  const t = asyPromote(L, a, b);
  if (t === null) return L.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
  // pair 上没有大小 —— asy 那边也没有（没有 `operator <(pair,pair)`）
  if (t === 'pair') return L.err(n, `pair 上没有 '${op}'（asy 那边也没有这个算符）`);
  // triple 同理（量过："no matching function 'operator <(triple, triple)'"）
  if (t === 'triple') return L.err(n, `triple 上没有 '${op}'（asy 那边也没有这个算符）`);
  // 记录与数组上也没有：量过 `mk(2) <= mk(2)` 在 asy 那边报
  // "no matching function 'operator <=(V, V)'"，`==`/`!=` 才是内建的（比身份）。
  // 自己定义一个 `operator <=` 是通的 —— 那一条在 opUser 里先问过了。
  if (L.isRec(t) || asyIsArr(t)) {
    if (op !== '==' && op !== '!=') {
      return L.err(n, `${t} 上没有 '${op}'（asy 那边报 "no matching function `
        + `'operator ${op}(${t}, ${t})'" —— 自己定义一个 \`operator ${op}\` 就有了）`);
    }
  }
  return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
}

export function asyCompare(L, n, op) {
  const a = asyExpr(L, n.items[2]);
  const b = asyExpr(L, n.items[3]);
  if (a === null || b === null) return null;
  // 用户的 `operator ==`（第二十三刀）。量过 `!=` **不会**借用它 ——
  // 只定义了 `==` 时 `a != b` 走的还是内建的身份比较，所以这里是逐个算符问的。
  const u = asyOpUser(L, n, op, [a, b], asyOpBuiltinSig(L, [a, b]));
  if (u !== null) return u;
  const t = asyPromote(L, a, b);
  if (t === 'pair') {
    L.used.add('asy__peq');
    const eq = `(call asy__peq ${a.code} ${b.code})`;
    return { code: op === '==' ? eq : `(un "!" ${eq})`, type: 'bool' };
  }
  if (t === 'triple') {
    // 只比前三道 —— 第 4 道是垫出来的（见 ASY_TRIPLE_TY）
    L.used.add('asy__teq');
    const eq = `(call asy__teq ${a.code} ${b.code})`;
    return { code: op === '==' ? eq : `(un "!" ${eq})`, type: 'bool' };
  }
  return asyCmpCode(L, n, op, a, b);
}

/**
 * `c ? a : b`。核心方言里 `? :` 不是表达式，于是摊成一个临时量加一条 if/else：
 *     (let t T <零值>) (if c (do (set t a)) (do (set t b)))
 * 两支各自的前置语句放进**各自那一支**里 —— 这样嵌套的 `? :` 也不会被提到 if 外面，
 * 短路语义（只算中选的那一支）跟着编码保住了。条件自己的前置语句留在外层：它总要算。
 */
export function asyCond(L, n) {
  if (L.pre === null) return L.nope(n, '这个位置的 `? :`（它要摊成语句，这里放不下）');
  const c = asyCoerce(L, asyExpr(L, n.items[1]), 'bool', n, '`? :` 的条件');
  const outer = L.pre;
  L.pre = [];
  const a = asyExpr(L, n.items[2]);
  const aPre = L.pre;
  L.pre = [];
  const b = asyExpr(L, n.items[3]);
  const bPre = L.pre;
  L.pre = outer;
  if (c === null || a === null || b === null) return null;
  const t = asyPromote(L, a, b);
  if (t === null) return L.err(n, `\`? :\` 两支要同型：真支是 ${a.type}，假支是 ${b.type}`);
  if (t === 'void') return L.err(n, '`? :` 的两支不能是 void');
  const av = asyCoerce(L, a, t, n, '`? :` 的真支');
  const bv = asyCoerce(L, b, t, n, '`? :` 的假支');
  if (av === null || bv === null) return null;
  const nm = `asy__c${L.tmp++}`;
  const yes = aPre.concat([`(set ${nm} ${av.code})`]).join(' ');
  const no = bPre.concat([`(set ${nm} ${bv.code})`]).join(' ');
  // 临时量要先有个初值（核心方言的 `(let …)` 要一个表达式），而它马上就被两支之一覆盖。
  // 引用类型给**空引用**：第三十三刀补上 `(null TYPE)` 之前这里写不出 null，记录只能发
  // `(cnew T)`（一次白分配），函数类型更是连零值都没有 —— 那时 `? :` 出函数值会把
  // JS 的 undefined 拼进方言文本里（量到过：graph.asy 的 `k == 0 ? thrice : quad` 那种形状）。
  // 数组照旧给空数组：那是数组真正的零值（`alen`/`apush` 在它上面都能用）。
  const init = L.isRec(t) || asyIsFn(t) ? `(null ${asyCore(t)})`
    : (asyIsArr(t) ? `(anew ${asyCore(t)} (int 0))` : ZERO.get(t));
  if (init === undefined) return L.nope(n, `\`? :\` 出 ${t}（这一刀给不出它的零值）`);
  L.pre.push(`(let ${nm} ${asyCore(t)} ${init})`);
  L.pre.push(`(if ${c.code} (do ${yes}) (do ${no}))`);
  return { code: `(var ${nm})`, type: t };
}

/**
 * 这个赋值目标能不能**再读一遍**（读第二遍不会有副作用、也不会多求一次调用）。
 * 赋值当表达式那一档靠它：语句摊出去之后要把左边读回来当值。
 * 收：名字、`this`、名字/this 的字段、名字下标（下标本身也要能重读）。
 */
export function asyRereadable(t) {
  if (isAtom(t)) return true;              // 字面量与词法给的名字：读第二遍不花代价
  if (!isList(t)) return false;
  const h = head(t);
  if (h === 'name-exp' || h === 'this') return true;
  if (h === 'field') return asyRereadable(t.items[1]);
  if (h === 'subscript') return asyRereadable(t.items[1]) && asyRereadable(t.items[2]);
  if (h === 'int-lit' || h === 'real-lit' || h === 'string-lit' || h === 'bool-lit') return true;
  return false;
}

export function asyLogic(L, n, op) {
  const a = asyCoerce(L, asyExpr(L, n.items[1]), 'bool', n, `'${op}' 的左边`);
  const b = asyCoerce(L, asyExpr(L, n.items[2]), 'bool', n, `'${op}' 的右边`);
  if (a === null || b === null) return null;
  return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
}

export function asyUnary(L, n) {
  const op = asyOpText(n.items[1]) ?? '?';
  const v = asyExpr(L, n.items[2]);
  if (v === null) return null;
  // 一元的用户算符（第二十三刀）：一元与二元同名（`operator -`）也没关系 ——
  // 候选表里两份的元数不同，fit 按元数就分开了
  const u = asyOpUser(L, n, op, [v], asyOpBuiltinSig(L, [v]));
  if (u !== null) return u;
  if (op === '!') {
    if (v.type !== 'bool') return L.err(n, `'!' 要 bool，这里是 ${v.type}`);
    return { code: `(un "!" ${v.code})`, type: 'bool' };
  }
  if (op === '+') return v;
  if (op === '-') {
    if (v.type === 'pair') {
      L.used.add('asy__pneg');
      return { code: `(call asy__pneg ${v.code})`, type: 'pair' };
    }
    if (v.type === 'triple') {
      L.used.add('asy__tneg');
      return { code: `(call asy__tneg ${v.code})`, type: 'triple' };
    }
    if (v.type !== 'int' && v.type !== 'real') return L.err(n, `一元 '-' 要 int/real/pair/triple，这里是 ${v.type}`);
    return { code: `(un "-" ${v.code})`, type: v.type };
  }
  return L.nope(n, `一元算符 '${op}'`);
}

/** `(int) e` / `(real) e` / `(pair) e`。别的目标类型这一刀不做。 */
export function asyCast(L, n) {
  const t = L.type(n.items[1], '强制转换');
  if (t === null) return null;
  const v = asyExpr(L, n.items[2]);
  if (v === null) return null;
  if (t === v.type) return v;
  if (t === 'real' && v.type === 'int') return { code: `(toreal ${v.code})`, type: 'real' };
  if (t === 'int' && v.type === 'real') return { code: `(toint ${v.code})`, type: 'int' };
  if (t === 'pair' && (v.type === 'int' || v.type === 'real')) return asyToPair(L, v);
  // `(string) x`：asy 那边 int/real -> string 是**显式**的那一条（`string(x)` 同一份格式）。
  // base 里 `(string) default` / `(string) (width/pt)` 就是这么写的（plain_strings.asy:36）。
  // pair / triple 也在这一条里（builtin.cc:367-372 四条 stringCast 都在）：量过
  // `(string)((1/3,2/7))` 是 `(0.333333333333333,0.285714285714286)` —— 与 write 那份
  // 格式一模一样（castop.h:41 的 precision(DBL_DIG) 就是 write 用的那份），所以共用 fmtStr。
  if (t === 'string' && (v.type === 'int' || v.type === 'real'
      || v.type === 'pair' || v.type === 'triple')) {
    return { code: asyFmtStr(L, v.type, v.code), type: 'string' };
  }
  // `(T) x` 是唯一收 `operator ecast` 的位置（第二十七刀）；内建那几条在上面 —— 量过
  // `(real) 3` 还是提升，用户那份是兜底。
  const uc = L.castFor(t, v.type, true);
  if (uc !== null) return { code: `(call ${uc.sym} ${v.code})`, type: t };
  return L.nope(n, `把 ${v.type} 转成 ${t}`);
}
