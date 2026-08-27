// Omni stage0 — asy 前端的**调用与重载解析**这一族
//
// 从 lower.js 里搬出来的第三摊，也是第一摊**带状态**的：这里每个函数的第一个形参 `L`
// 就是那个降级器（原来的 `this`）。为什么是这种拆法而不是跨文件 extends 或
// prototype mixin：这个文件在自举路径上（tests/bootstrap 要用编译器自己编译它），
// 而那两种写法在封闭子集里一个先例都没有；普通函数调用是验过的。
//
// 这一族管的是"一个调用怎么落地"：实参摊平（asyArgs / asyCallArgs）、
// 名字解析到候选表（asyVisible）、按槽打分挑候选（asyFit / asyApplyCall / asySigText）、
// 内建那一档谁管（asyBuiltinOwns / asyBuiltinCost / asyBuiltinRaw / asyStrRaw / asyMathCall）、
// 方法与构造（asyMethodCall / asyCtorCall / asyUserCall）、函数值间接调（asyFnValCall）、
// 用户算符（asyOpUser / asyOpBuiltinSig，`a -- b` 的 asyJoinExp 也走它），
// 以及缺实参时生成的那个包装（asyDefWrapper）。
//
// 名字都加了 asy 前缀：封闭 ABI 要求模块级名字全仓唯一，而 `args`/`call`/`fit`/`visible`
// 这几个原来的方法名放到模块级就太容易撞了。

import { isList, isAtom, head } from '../sexpr/read.js';
import {
  ASY_NOPE, DOT_BAD, asyConvCost, asyOpText, asyIsRestP, asyRestBase,
  asyIsArr, asyElem, asyIsFn, asyFnSplit, asyCore, ASY_NULL, asyRefTy,
} from './types.js';
import { ASY_PAIRFN, ASY_STRFN, ASY_STR_DEPS, ASY_STR_NOPE } from './runtime.js';

/** 实参表摊平。命名实参与展开都不做 —— 那要重载解析。 */
export function asyArgs(L, node) {
  const out = [];
  for (const a of L.flat(node, 'args')) {
    if (!isList(a) || head(a) !== 'arg') {
      L.nope(a, isList(a) && head(a) === 'arg-named' ? '命名实参' : '展开实参');
      return null;
    }
    out.push(a.items[1]);
  }
  return out;
}

/** 调用。`write` 是语句（void），在表达式位置见到它就报错。 */
export function asyCall(L, n) {
  // `a.push(v)` / `a.pop()`：被调的是 `(field 接收者 名字)`，不是普通名字
  const callee = n.items[1];
  if (isList(callee) && head(callee) === 'field') {
    const recv = L.expr(callee.items[1]);
    if (recv === null) return null;
    const mname = isAtom(callee.items[2]) ? callee.items[2].value : null;
    // 记录上的方法调用（第二十刀）。数组的 push/pop 仍走 arrMethod。
    if (mname !== null && L.isRec(recv.type)) return asyMethodCall(L, n, recv, mname);
    if (!asyIsArr(recv.type)) return L.nope(n, `方法调用 '.${mname}(…)'`);
    return L.arrMethod(n, recv, mname);
  }
  const nm = isList(n.items[1]) && head(n.items[1]) === 'name-exp' ? L.plainName(n.items[1].items[1]) : null;
  if (nm === null && isList(callee) && head(callee) === 'name-exp') {
    // `c.push(8)` / `a.get()`：同上，点是名字的一部分，所以方法调用也是"调一个带点的名字"
    const q = L.dotQual(callee.items[1]);
    if (q === DOT_BAD) return null;
    if (q !== null) {
      if (L.isRec(q.recv.type)) return asyMethodCall(L, n, q.recv, q.field);
      if (!asyIsArr(q.recv.type)) return L.nope(n, `${q.recv.type} 上的方法调用 '.${q.field}(…)'`);
      return L.arrMethod(n, q.recv, q.field);
    }
    // `m.f(…)`：模块限定的函数调用（第二十五刀）
    const mq = L.modAlias(callee.items[1]);
    if (mq !== null) return L.modCall(n, mq);
    // `Box.sf(3)`：**类型名**限定的 static，而它是个函数值（第三十八刀）。位置照 name-exp
    // 那边的顺序 —— dotQual 之后（同名的变量在点号左边赢），模块别名之后。
    const sq = L.statQual(callee.items[1]);
    if (sq !== null && asyIsFn(sq.type)) {
      const qn = isAtom(callee.items[1].items[2]) ? callee.items[1].items[2].value : '?';
      return asyFnValCall(L, n, qn, sq.type, `(var ${sq.sym})`);
    }
  }
  // `fs[0](5)`：被调的是**下标出来的那一格**（第三十七刀，函数值的数组那一族）。
  // 只认下标这一种形状 —— 求值有副作用（诊断、前置语句），所以不去"先试着求一遍看看
  // 是不是函数类型"，只在语法上就认得出的位置上问。
  if (isList(callee) && head(callee) === 'subscript') {
    const fv = L.expr(callee);
    if (fv === null) return null;
    if (!asyIsFn(fv.type)) {
      return L.err(n, `这一格是 ${fv.type}，不是函数，调不了`);
    }
    return asyFnValCall(L, n, '下标出来的那一格', fv.type, fv.code);
  }
  if (nm === null) return L.nope(n, '调用一个不是普通名字的东西（函数值、方法、算符名）');
  if (nm === 'write') return L.err(n, `${ASY_NOPE}：write 出现在表达式位置（它是语句）`);
  // 方法体里的裸方法名（第二十刀）：量过 struct 的成员**遮住**同名的文件级函数
  // （文件里有 `int who()`、struct 里也有 `who()`，方法体里调到的是后者），
  // 所以这一问放在文件级候选与内建名单**前面**。
  if (L.self !== null) {
    const ms = L.visibleMethods(L.self.rec, nm);
    if (ms.length > 0) {
      return asyUserCall(L, n, nm, ms, { code: '(var this)', type: L.self.rec.name });
    }
    // 无体的方法声明（`int size();`）其实是**函数类型的字段**，所以方法体里的 `size()`
    // 是"读这一格再间接调"。与上面那一档同一个道理放在文件级候选前面：它也是个成员。
    const sf = L.selfField(nm);
    if (sf !== null && asyIsFn(sf.type)) {
      return asyFnValCall(L, n, nm, sf.type, `(fld (var this) ${nm})`);
    }
    // 声明在**后面**的成员（第三十五刀，字段默认值那一档把它显出来了）：
    // `struct S { int y = f(); int f() {…} }` asy 报 "no matching variable 'f'" 并退 1 ——
    // 它自己也拒。不专门问一句就会漏到下面的内建名单，报出带 ASY_NOPE 的"内建函数 'f'"，
    // 那是把"程序本来就不对"说成"我们还没做"。
    const all = L.units[L.self.rec.unit].funcs.get(`${L.self.rec.name}.${nm}`);
    let lateFld = false;
    for (const f of L.self.rec.fields) if (f.name === nm) lateFld = true;
    if ((all !== undefined && all.length > 0) || lateFld) {
      return L.err(n, `'${nm}' 在这里还看不见 —— struct ${L.self.rec.name} 里它声明在后面，`
        + `而成员也是顺序解析的（asy 那边报 "no matching variable '${nm}'"）`);
    }
  }
  // 内建数学函数先看：asy 里 sqrt/floor/… 是运行时自带的，不是 plain.asy 里的定义，
  // 所以这一层认它们不算"偷偷补模块系统"。用户自己定义了同名函数时以用户的为准
  // （asy 那边是重载，重载表里用户那份更同型时它赢）。
  // 这里问的是 **此处可见的**候选（顺序解析，见 visible）—— 用户的 sqrt 写在后面时，
  // 前面那句 sqrt 在 asy 那边也还是内建的那个。
  // 函数类型的局部量/形参（`real f(real)` 那个槽）：`f(x)` 是**间接调用**，
  // 不是查候选表。放在候选表前面问：asy 那边这个名字在这一层就是个变量，
  // 而 findroot 那种形参正是要遮住同名的文件级函数。
  const lv = L.lookup(nm);
  if (lv !== null && asyIsFn(lv)) return asyFnValCall(L, n, nm, lv, `(var ${nm})`);
  // 函数值的**文件级**变量（第三十七刀）：`typedef int F(int); F h; … h(5)`。
  // 位置照 nameOf 那一档的顺序 —— 局部、成员之后，候选表之前（那一档里有就不是函数名）。
  //
  // `gvarAt` 那一份要**排除**掉：正在声明的那个变量在自己的初值里还不可见。量出来的理由是
  // graph.asy 里三处 `ticklabel LogFormat=LogFormat(10);`（:267/:268 与 :1124 的
  // `axis Bottom=Bottom()`）—— 右边那个 `LogFormat` 是**函数**，不是刚声明的这个变量。
  // 不排除就会把它当成间接调用，然后报"要 string(real)，这里是 string"（真的量到了，
  // graph 一度从 183 涨到 186）。
  const gv = L.gvarHere(nm);
  if (gv !== null && gv !== L.gvarAt(nm) && gv.ok && asyIsFn(gv.type)) {
    return asyFnValCall(L, n, nm, gv.type, `(var ${gv.sym})`);
  }
  const vis = asyVisible(L, nm);
  // 同名的用户/模块函数与内建那一族在这里**一起打分**：asy 那边内建与库里的定义是
  // 同一个重载集（builtin.cc 把内建也塞进那张表），而我们的内建面写死在这个前端里，
  // 所以判据既不是"有没有同名的函数"、也不是"合不合用"，而是**谁更同型**。
  // 两头都量过：
  //   - `length("ab")`：内建那份是同型（0 次转换），asy_builtins.asy 里的 `length(path)`
  //     要走一次 `pair -> path` 的 cast（1 次），所以内建赢 —— 少了这一比，
  //     `length(z)` 会去数一条单点路径的段数，印 0 而不是 sqrt(5)（量出来的错法）。
  //   - `length(g)`（g 是 path）：内建那份根本不适用，模块那份赢。
  // 实参在这条路上**只求一次**（callArgs 把它摊出来的语句攒在自己的 lines 里）；
  // 内建那一族因此走按值的入口（builtinRaw）。
  if (vis.length > 0) {
    const raw = asyCallArgs(L, n);
    if (raw === null) return null;
    let best = null;
    for (const c of vis) {
      const f = asyFit(L, c, raw);
      if (f !== null && (best === null || f.cost < best)) best = f.cost;
    }
    const bc = asyBuiltinCost(L, nm, raw);
    if (best !== null && (bc === null || best <= bc)) return asyApplyCall(L, n, nm, vis, raw, null);
    // 内建赢；或者两边都没有能匹配的、而这个名字**本来就是内建那一族的** ——
    // 后一种要让内建那份去报诊断（`length(int[])` 那条话说得清楚得多，
    // 比"有的是 int(path)"有用）。两条都走 builtinRaw：它回 null 时诊断已经发过了。
    if (bc !== null || (best === null && asyBuiltinOwns(L, nm, raw))) return asyBuiltinRaw(L, n, nm, raw);
    // 两边都没有能匹配的：让 applyCall 照原样报那条诊断
    return asyApplyCall(L, n, nm, vis, raw, null);
  }
  // `A(3)`：**构造调用**（第二十一刀）。`A` 是记录名，不是变量也不是函数名，所以这一问
  // 放在内建名单前面 —— 记录名与内建那几个（sqrt/length/…）撞不上。
  // 问的是 recOf 不是 isRec：调用处写的是**这个单元里的名字**（模板实例是 `Box_int`），
  // 而 records 那张全局表的键是记录的真名。
  const crec = L.recOf(nm);
  if (crec !== null) return asyCtorCall(L, n, crec, nm);
  if (nm === 'length') return L.lengthCall(n);
  if (nm === 'string') return L.strConvCall(n);
  if (ASY_STRFN.has(nm)) return L.strCall(n, nm);
  if (ASY_STR_NOPE.has(nm)) return L.nope(n, ASY_STR_NOPE.get(nm));
  if (ASY_PAIRFN.has(nm)) return L.pairCall(n, nm);
  if (L.math.has(nm)) return asyMathCall(L, n, nm);
  if (L.funcs.has(nm)) {
    return L.err(n, `'${nm}' 在这里还看不见 —— 它声明在后面，而 asy 的名字解析是顺序的（那边报 "no matching variable"）`);
  }
  return L.nope(n, `内建函数 '${nm}'（这一刀只有 write 和你自己定义的函数）`);
}

/**
 * 内建那一族的**按值**入口：实参已经降好（`raw`），谁都没求两次。
 * 前提是 `builtinOwns` 为真；实参类型这一族接不住时它自己发诊断并回 null。
 */
export function asyBuiltinRaw(L, n, nm, raw) {
  // 实参的前置语句按**给的顺序**发出去（callArgs 把它们攒在各自的 lines 里）
  for (const a of raw) if (a.lines !== null) for (const s of a.lines) L.pre.push(s);
  if (nm === 'length') return L.lengthOf(raw[0].v, raw[0].node);
  return asyStrRaw(L, n, nm, raw);
}

/** 字符串那一族的按值入口：与 strCall 同一份拼法，只是实参已经降好了（不再求一次） */
export function asyStrRaw(L, n, nm, raw) {
  const spec = ASY_STRFN.get(nm);
  const parts = [];
  for (let i = 0; i < raw.length; ++i) {
    const v = L.coerce(raw[i].v, spec.params[i], raw[i].node, `'${nm}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    parts.push(v.code);
  }
  let fn = spec.fn;
  if (nm === 'substr' && raw.length === 2) fn = spec.short;
  else if (nm === 'find' && raw.length === 2) parts.push('(int 0)');
  L.used.add(fn);
  for (const d of ASY_STR_DEPS.get(fn) ?? []) L.used.add(d);
  return { code: `(call ${fn} ${parts.join(' ')})`, type: spec.ret };
}

/**
 * 这个名字加这个实参形状**是不是内建那一族的**（不看实参类型，只看名字与给了几个）。
 * 两族：`length`（与 asy_builtins.asy 的 `length(path)` 撞名）与字符串那一族
 * （`erase` 与 `asy_builtins.asy` 的 `erase(frame)` 撞名 —— 元数不同，所以按
 * "给了几个"就分得开）。带名字的实参一律不算内建那一族的：内建这一层没有形参名。
 */
export function asyBuiltinOwns(L, nm, raw) {
  for (const a of raw) if (a.key !== null) return false;
  // 展开实参只能落在可变形参那一格上，而内建这一族一个可变形参都没有
  for (const a of raw) if (a.spread === true) return false;
  if (nm === 'length') return raw.length === 1;
  if (ASY_STRFN.has(nm)) {
    const s = ASY_STRFN.get(nm);
    return raw.length >= s.min && raw.length <= s.params.length;
  }
  return false;
}

/**
 * 内建那一族接这次实参要走几次转换（null = 这一族接不住）。与 `fit` 的 cost 同一个刻度：
 * 0 是逐个同型，1 是一次隐式提升。别的内建名字将来与模块撞上时**要在这里补一行**，
 * 不补的后果是"模块那份靠一次 cast 赢过同型的内建"，那是错的答案而不是报错。
 */
export function asyBuiltinCost(L, nm, raw) {
  if (!asyBuiltinOwns(L, nm, raw)) return null;
  if (nm === 'length') {
    const t = raw[0].v.type;
    if (t === 'string' || t === 'pair' || t === 'triple') return 0;
    if (t === 'int' || t === 'real') return 1;
    return null;
  }
  // 字符串那一族：逐个比 `params`。int -> real 是一次提升，别的不合就是接不住
  const s = ASY_STRFN.get(nm);
  let cost = 0;
  for (let i = 0; i < raw.length; ++i) {
    const want = s.params[i];
    const got = raw[i].v.type;
    if (got === want) continue;
    if (want === 'real' && got === 'int') { cost += 1; continue; }
    return null;
  }
  return cost;
}

/**
 * `nm` 在**当前位置**能看见的候选。asy 的名字解析是顺序的 —— 量过：
 *   `void a() { b(); } void b() {}` 报 "no matching variable 'b'"，
 *   `int rec(int)` 的体里调 `rec(int,int)` 报 "cannot call 'int rec(int n)'"。
 * `c.at <= L.at` 里的等号是故意的：一个函数看得见自己（单函数递归 asy 允许）。
 */
export function asyVisible(L, nm) {
  const out = [];
  if (!L.funcs.has(nm)) return out;
  for (const c of L.funcs.get(nm)) if (c.at <= L.at) out.push(c);
  return out;
}

/**
 * `接收者.方法(…)`（第二十刀）。接收者已经求好了，方法名去 `记录名.方法名` 那张候选表里
 * 找；找不到就把话说清 —— 同名的**字段**意味着"调一个函数值"（那要闭包，门外），
 * 什么都没有就把有哪些方法列出来。
 */
export function asyMethodCall(L, n, recv, mname) {
  const rec = L.records.get(recv.type);
  const ms = L.visibleMethods(rec, mname);
  if (ms.length === 0) {
    for (const f of rec.fields) {
      if (f.name !== mname) continue;
      // 字段本身是**函数值**：`b.fn2(4)` 就是通过它间接调（plain_filldraw.asy 里
      // `filltype.fill2(f,g,p)` 到处是）。方法找不到时才轮到这里 —— asy 那边方法与
      // 字段同名时方法赢（量过）。
      if (asyIsFn(f.type)) {
        return asyFnValCall(L, n, `${recv.type}.${mname}`, f.type,
          `(fld ${recv.code} ${mname})`);
      }
      return L.nope(n, `调用一个字段（${recv.type}.${mname} 是 ${f.type}，不是方法）`);
    }
    const names = [];
    for (const key of L.units[rec.unit].funcs.keys()) {
      if (key.startsWith(`${rec.name}.`)) names.push(key.slice(rec.name.length + 1));
    }
    // 名字是个 **static/autounravel 的函数值字段**（第三十八刀）：`q.af(5)` 与
    // `Box.af(5)` 取的是同一格（量过 asy 两条都通）。放在字段与方法之后 ——
    // static 那一档在 asy 的成员查找里就在字段后面。
    const st = L.statOf(rec.name, mname);
    if (st !== null && asyIsFn(st.type)) {
      return asyFnValCall(L, n, `${recv.type}.${mname}`, st.type, `(var ${st.sym})`);
    }
    return L.err(n, `struct ${recv.type} 没有方法 '${mname}'`
      + `${names.length === 0 ? '（它一个方法都没有）' : ` —— 有的是 ${names.join(' / ')}`}`);
  }
  return asyUserCall(L, n, mname, ms, recv);
}

/**
 * `A(3)`：构造调用（第二十一刀）。候选就是 struct 里那些 `void operator init(…)`，
 * 走的还是 userCall —— 重载解析、命名实参、默认实参一条不改，因为候选长得就像一个
 * "回记录、没有接收者的普通函数"（见 methodSig）。
 *
 * 量过的两条边界都在这里：没有 `void operator init` 的 struct 上 `A(…)` 在 asy 那边报
 * "no matching variable 'A'"（非 void 的那份不算，它不给构造函数），而 `A a;` **不**走
 * 构造函数 —— 那条只认文件级的 `A operator init()`，还在门外。
 */
export function asyCtorCall(L, n, rec, nm) {
  const cs = L.visibleMethods(rec, 'operator init');
  if (cs.length === 0) {
    // 这一条 asy 自己也拒（"no matching variable 'A'"），所以是 err 不是 nope ——
    // 不是"我们还没做"，是这个程序本来就不对。`tests/asy/strict/ctor-none` 钉着。
    return L.err(n, `struct ${nm} 里没有 'void operator init(…)'，所以 ${nm}(…) 不是`
      + `构造调用（真 asy 报 "no matching variable '${nm}'"）`);
  }
  return asyUserCall(L, n, nm, cs);
}

/**
 * 调用用户定义的函数：**重载解析**（第十一刀）+ 位置实参 + 命名实参 + 默认实参。
 *
 * 量出来的规则（`asy -noV`，不是照文档抄的）：
 *   1. 默认值是**每次调用**求一次，而且只在那个实参没给的时候求
 *      （`void d(int x = bump())`：`d(); d(); d(99);` 之后 bump 只被调了 2 次）。
 *   2. 默认值能引用**前面的形参**（`void q(int a, int b = a + 10)`：`q(1)` 印 11）——
 *      所以它必须在被调方的作用域里求，不能在调用点展开。
 *   3. 位置实参从左到右填，命名实参按名字填，两者能混、命名的顺序可以乱
 *      （`h(1, c=3, b=2)` 印 1 2 3）。
 *   4. 求值顺序：给了的实参按**源码顺序**先求，默认值最后（量过 tick 的输出是
 *      101 202 303）。
 *   5. 重载按**同型优先**：`f(int)` 与 `f(real)` 都在时 `f(1)` 走 int 那份、`f(1.0)`
 *      走 real 那份；只有 `g(real)` 时 `g(2)` 走隐式提升。两个候选各要一次转换就是
 *      **歧义**，asy 当场报错（`p(real)` 与 `p(pair)` 遇上 `p(1)`：
 *      "call of function 'p(int)' is ambiguous"）—— 我们也报。
 *   6. 同一份签名写两次是**替换**，不是错（`int s(int)` 之后 `real s(int)`，`s(5)` 给 2.5）。
 *
 * 落法：实参**先按源码顺序求一次**（连它摊出来的语句一起攒着），再拿类型去挑候选 ——
 * 求两次会把 `show(1)` 那种带输出的实参印两遍。缺实参时不在调用点补，而是按
 * "缺了哪几个"生成一个包装函数（见 defWrapper），默认值在包装里求，规则 1、2 因此自动成立。
 *
 * `recv` 不是 null 时这是一次**方法调用**（第二十刀）：接收者当第一个实参传进去，
 * 重载解析只看写出来的那几个实参 —— `this` 不参与打分（它的类型是定死的）。
 */
export function asyUserCall(L, n, nm, list, recv) {
  const raw = asyCallArgs(L, n);
  if (raw === null) return null;
  return asyApplyCall(L, n, nm, list, raw, recv);
}

/**
 * 记录上的下标：`v[i]` 与 `v[i] = x`（第三十二刀）。asy 那边它们就是
 * `v.operator [](i)` 与 `v.operator [=](i, x)` —— 量过 `v.operator [](2)` 直呼也通，
 * 所以这里不新开一条路，只是把"实参"手攒出来再交给 applyCall（重载解析、隐式转换、
 * 默认实参全跟着白捡）。`argNodes` 是语法树上的实参节点，按位置传。
 */
export function asyIdxOpCall(L, n, recv, mname, argNodes) {
  const rec = L.records.get(recv.type);
  const ms = rec === undefined ? [] : L.visibleMethods(rec, mname);
  if (ms.length === 0) {
    return L.err(n, `${recv.type} 上没有 '${mname}' —— 下标要 struct 里定义了它才能用`);
  }
  const raw = [];
  for (const a of argNodes) {
    const v = L.expr(a);
    if (v === null) return null;
    raw.push({ key: null, node: a, spread: false, v: v, lines: null });
  }
  return asyApplyCall(L, n, mname, ms, raw, recv);
}

/**
 * userCall 的后半段：实参已经求好（`raw`），剩下的是挑候选、转换、发调用。
 * 分出来是给算符重载用的（第二十三刀）—— 那边的"实参"是已经降好的两个操作数，
 * 没有 callArgs 那一步，别的规则一条不差。
 */
export function asyApplyCall(L, n, nm, list, raw, recv) {
  const fits = [];
  for (const c of list) {
    const f = asyFit(L, c, raw);
    if (f !== null) fits.push({ c, f });
  }
  if (fits.length === 0) {
    const got = [];
    for (const r of raw) got.push(r.key === null ? r.v.type : `${r.key}=${r.v.type}`);
    const sigs = [];
    for (const c of list) sigs.push(asySigText(L, c));
    return L.err(n, `没有能匹配 '${nm}(${got.join(', ')})' 的签名 —— 有的是 ${sigs.join(' / ')}`);
  }
  let best = fits[0];
  let tie = false;
  for (let i = 1; i < fits.length; i++) {
    // 先比"是不是走了可变形参"：量过任何非可变的候选都赢（见 fit 里那段注释），
    // 所以这一档在 cost 之前，而且档不同时**不算**打平。
    const bv = best.f.varargs === true ? 1 : 0;
    const iv = fits[i].f.varargs === true ? 1 : 0;
    if (iv < bv) { best = fits[i]; tie = false; continue; }
    if (iv > bv) continue;
    if (fits[i].f.cost < best.f.cost) { best = fits[i]; tie = false; continue; }
    if (fits[i].f.cost === best.f.cost) tie = true;
  }
  if (tie) {
    const got = [];
    for (const r of raw) got.push(r.key === null ? r.v.type : `${r.key}=${r.v.type}`);
    return L.err(n, `'${nm}(${got.join(', ')})' 有多个同样合适的重载 —— asy 那边这也是 ambiguous`);
  }
  const d = best.c;
  const f = best.f;
  // 命名实参可能把顺序打乱，而核心方言的 `(call f a b c)` 是按写的顺序求值的 ——
  // 乱序时先把每个实参按**源码顺序**绑到临时量，再按形参顺序引用它们。
  const reorder = f.reordered && raw.length > 1;
  if (reorder && L.pre === null) return L.nope(n, '这个位置的乱序命名实参（要摊成语句，这里放不下）');
  const codes = new Map();
  const packed = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r.lines !== null) for (const s of r.lines) L.pre.push(s);
    const at = f.slot[i];
    // 进可变那一格的包（fit 把这些槽记成 -1）。`... a` 那一种整份接进去，别的降到元素型。
    if (at < 0) {
      if (r.spread === true) { packed.push({ code: r.v.code, spread: true }); continue; }
      const ev = L.coerce(r.v, asyElem(d.ps[f.restAt].type), r.node,
        `'${nm}' 的可变实参 ${d.ps[f.restAt].name}`);
      if (ev === null) return null;
      packed.push({ code: ev.code, spread: false });
      continue;
    }
    // 重载集：fit 已经按这个槽的类型挑过一份了，这里把它落成 `(fnref …)`（不走 coerce ——
    // 那一份与槽同型，而 coerce 认不出"重载集"这个类型）
    if (r.v.over !== undefined) {
      const pick = L.overPick(r, d.ps[at].type);
      if (pick === null) return L.err(r.node, `'${nm}' 的实参 ${d.ps[at].name}：挑不出重载`);
      codes.set(at, pick);
      continue;
    }
    const v = L.coerce(r.v, d.ps[at].type, r.node, `'${nm}' 的实参 ${d.ps[at].name}`);
    if (v === null) return null;
    if (!reorder) { codes.set(at, v.code); continue; }
    const tmp = `asy__na${L.tmp++}`;
    L.pre.push(`(let ${tmp} ${asyCore(d.ps[at].type)} ${v.code})`);
    codes.set(at, `(var ${tmp})`);
  }
  const parts = [];
  if (recv !== null && recv !== undefined) parts.push(recv.code);
  // 可变那一格：现造一条新数组。**总是**造 —— 量过 `... a` 是拷进去的（回调里改 x[0]
  // 之后 a[0] 没变），所以散着写的与展开的能拼在一起，也不用为"只有一个展开"开特例。
  // 造要摊成语句，所以要有地方放；没地方就拒得明白，与乱序命名实参那条同一个理由。
  if (f.varargs === true) {
    const at = asyCore(d.ps[f.restAt].type);
    if (packed.length === 0) {
      codes.set(f.restAt, `(anew ${at} (int 0))`);
    } else {
      if (L.pre === null) return L.nope(n, '这个位置的可变实参（要摊成语句，这里放不下）');
      const tmp = `asy__va${L.tmp++}`;
      L.pre.push(`(let ${tmp} ${at} (anew ${at} (int 0)))`);
      for (const p of packed) {
        if (!p.spread) { L.pre.push(`(apush (var ${tmp}) ${p.code})`); continue; }
        // 展开：逐个搬。核心方言没有"接一条数组"的指令，而这一条循环就是它。
        const src = `asy__vs${L.tmp++}`;
        const ix = `asy__vi${L.tmp++}`;
        L.pre.push(`(let ${src} ${at} ${p.code})`);
        L.pre.push(`(do (let ${ix} int (int 0))`
          + ` (while (bin "<" (var ${ix}) (alen (var ${src})))`
          + ` (do (apush (var ${tmp}) (aget (var ${src}) (var ${ix})))`
          + ` (set ${ix} (bin "+" (var ${ix}) (int 1))))))`);
      }
      codes.set(f.restAt, `(var ${tmp})`);
    }
  }
  for (let i = 0; i < d.ps.length; i++) if (codes.has(i)) parts.push(codes.get(i));
  const target = f.missing.length === 0 ? d.sym : asyDefWrapper(L, n, nm, d, f);
  if (target === null) return null;
  const sp = parts.length === 0 ? '' : ' ';
  return { code: `(call ${target}${sp}${parts.join(' ')})`, type: d.ret };
}

/**
 * `a -- b`：语法上它不是 `binary` 而是 `(join-exp L (join "--") R)`（camp.y 里 join 是
 * 单独一档，`..`、`::`、方向标记都挂在这一档上）。内建的 `--` 不存在 —— 那是 guide 的
 * 东西，属于绘图层 —— 所以这里**只有**用户定义的 `operator --`（第二十三刀）。
 */
export function asyJoinExp(L, n) {
  const op = asyOpText(n.items[2].items[1]);
  if (op !== '--') return L.nope(n, `路径连接 '${op ?? '?'}'`);
  const a = L.expr(n.items[1]);
  const b = L.expr(n.items[3]);
  if (a === null || b === null) return null;
  // 内建的 `--` 不存在，所以"内建这一档的签名"是 null（不是 `opBuiltinSig` 的结果）
  const u = asyOpUser(L, n, op, [a, b], null);
  if (u !== null) return u;
  return L.nope(n, `'${a.type} -- ${b.type}'（内建的 '--' 是 guide 的，那是绘图层那一刀；`
    + '自己定义一个 `operator --` 是通的）');
}

/**
 * 用户定义的算符（第二十三刀）：`op` 是 '+'、'=='、'--'… `vals` 是**已经降好**的操作数。
 * 回 null 表示"没有用户算符管这一档"，调用方接着走内建那条路。
 *
 * asy 把内建算符与用户算符放在**同一张候选表**里打分，所以判"谁赢"要照那张表的规则，
 * 这三条都量过（`asy -noV`）：
 *   1. 用户那份**同型**（一次转换都不用）就赢：`int operator *(int,int)` 之后 `3 * 4`
 *      印 7，不是 12。这一条最要紧 —— 漏了它算出来的是**不同的答案**，不是"多接受"。
 *   2. 用户那份的签名正好**就是内建那一档**时，它替换掉内建（重载规则 6：同签名是替换）：
 *      只写了 `real operator +(real,real)` 时 `2 + 3` 还是内建的 int 加法（印 5），
 *      而 `2 + 1.5` 走用户那份（印 0.5，左边先提成 real）。
 *   3. 内建管不了的档（记录、数组做操作数）：任何能匹配的用户算符都赢。
 * `btys` 就是"内建这一档的签名"（`opBuiltinSig`），null 表示内建管不了。
 */
export function asyOpUser(L, n, op, vals, btys) {
  const list = asyVisible(L, `operator ${op}`);
  if (list.length === 0) return null;
  const raw = [];
  for (const v of vals) raw.push({ key: null, v, node: n, lines: null });
  let any = false;
  let exact = false;
  for (const c of list) {
    const f = asyFit(L, c, raw);
    if (f === null) continue;
    any = true;
    if (f.cost === 0) exact = true;
  }
  if (!any) return null;
  if (!exact && btys !== null) {
    const key = btys.join(',');
    let replaces = false;
    for (const c of list) if (c.params.join(',') === key) replaces = true;
    if (!replaces) return null;
  }
  return asyApplyCall(L, n, `operator ${op}`, list, raw);
}

/**
 * 内建算符在这些操作数上是哪一档签名（回 null = 内建管不了这些类型）。
 * 一元就是操作数自己那一档，二元是提升之后的同型那一档（`1 + 2.0` 是 real 那档）。
 * 记录与数组内建一概不认 —— 那些只有用户算符。
 */
export function asyOpBuiltinSig(L, vals) {
  for (const v of vals) if (L.isRec(v.type) || asyIsArr(v.type)) return null;
  if (vals.length === 1) return [vals[0].type];
  const t = L.promote(vals[0], vals[1]);
  return t === null ? null : [t, t];
}

/**
 * 按**源码顺序**把实参求出来。每个实参连它摊出来的语句（`? :`、`.push(…)` 那种）
 * 一起攒在自己的 `lines` 里，等挑定候选之后再按顺序放回 `L.pre` ——
 * 挑候选要知道实参的类型，而实参不能求两次（`show(1)` 那种会印两遍）。
 */
/**
 * 通过一个函数类型的值调用（`real f(real)` 那个形参上的 `f(x)`）。
 * 函数值没有形参名，所以命名实参与默认值在这里都不存在 —— 与 hir/check.js 的
 * callFnValue 是同一条规矩。实参照签名逐个 coerce（int -> real 那条照旧要走）。
 *
 * `callee` 是被调那个**值**的方言文本。裸名字那条传 `(var nm)`，字段那条传
 * `(fld … f)`（`filltype.fill2(f,g,p)` 那种，plain_filldraw.asy 里到处是）——
 * `nm` 只用来说话。
 */
export function asyFnValCall(L, n, nm, ft, callee) {
  const s = asyFnSplit(ft);
  if (s === null) return L.nope(n, `认不出的函数类型 '${ft}'`);
  // 类型里那一格可变形参（`guide(... guide[])`，plain_paths.asy:3 的 interpolate）：
  // 最后一格收所有多出来的位置实参。量过 asy 允许通过函数值这么调 ——
  // `using vfn=int(... int[]); vfn f=total; f(1,2,3)` 印 6。
  const rAt = s.params.length - 1;
  const isVar = s.params.length > 0 && asyIsRestP(s.params[rAt]);
  const restTy = isVar ? asyRestBase(s.params[rAt]) : null;
  const args = asyCallArgs(L, n);
  if (args === null) return null;
  if (isVar ? args.length < rAt : args.length !== s.params.length) {
    const want = isVar ? `至少 ${rAt}` : `${s.params.length}`;
    return L.err(n, `'${nm}' 是 ${ft}，要 ${want} 个实参，给了 ${args.length} 个`);
  }
  let code = `(callfn ${callee}`;
  const packed = [];
  let i = 0;
  while (i < args.length) {
    if (args[i].key !== null) {
      return L.err(n, `函数值没有形参名，这里不能写 '${args[i].key}='`);
    }
    if (args[i].lines !== null) for (const l of args[i].lines) L.pre.push(l);
    // 落到可变那一格（或更后面）：进包，不占槽
    if (isVar && i >= rAt) {
      if (args[i].v.over !== undefined) {
        return L.nope(args[i].node, '重载集当可变实参（这一刀只按槽的类型挑固定那几格）');
      }
      if (args[i].spread === true) {
        // `... a`：整份数组接到包后面。类型要一模一样 —— asy 不给这一格做元素级提升。
        if (args[i].v.type !== restTy) {
          return L.err(args[i].node, `'${nm}' 的展开实参：要 ${restTy}，这里是 ${args[i].v.type}`);
        }
        packed.push({ code: args[i].v.code, spread: true });
      } else {
        const ev = L.coerce(args[i].v, asyElem(restTy), args[i].node, `'${nm}' 的可变实参`);
        if (ev === null) return null;
        packed.push({ code: ev.code, spread: false });
      }
      i++;
      continue;
    }
    if (args[i].spread === true) {
      return isVar
        ? L.err(args[i].node, `'${nm}' 的展开实参只能落在可变那一格上（${ft}）`)
        : L.nope(args[i].node, `通过函数值调用时的展开实参（'${nm}' 是 ${ft}，`
          + '这个函数类型里没有可变形参那一格）');
    }
    // 重载集当实参（callArgs 先不定案的那种）：这里的期望类型是函数类型里那一格
    if (args[i].v.over !== undefined) {
      const pick = L.overPick(args[i], s.params[i]);
      if (pick === null) {
        return L.err(args[i].node, `'${nm}' 的第 ${i + 1} 个实参：要 ${s.params[i]}，`
          + '而这个名字的那几个重载里没有同型的一份');
      }
      code = `${code} ${pick}`;
      i++;
      continue;
    }
    const v = L.coerce(args[i].v, s.params[i], args[i].node, `'${nm}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    code = `${code} ${v.code}`;
    i++;
  }
  if (isVar) {
    // 可变那一格：现造一条新数组，与 applyCall 里那一段同一份写法（那边有为什么"总是造"
    // 的测量：`... a` 是拷进去的）。核心方言没有"接一条数组"的指令，所以展开靠一条循环。
    const at = asyCore(restTy);
    if (packed.length === 0) {
      code = `${code} (anew ${at} (int 0))`;
    } else {
      if (L.pre === null) return L.nope(n, '这个位置的可变实参（要摊成语句，这里放不下）');
      const tmp = `asy__va${L.tmp++}`;
      L.pre.push(`(let ${tmp} ${at} (anew ${at} (int 0)))`);
      for (const p of packed) {
        if (!p.spread) { L.pre.push(`(apush (var ${tmp}) ${p.code})`); continue; }
        const src = `asy__vs${L.tmp++}`;
        const ix = `asy__vi${L.tmp++}`;
        L.pre.push(`(let ${src} ${at} ${p.code})`);
        L.pre.push(`(do (let ${ix} int (int 0))`
          + ` (while (bin "<" (var ${ix}) (alen (var ${src})))`
          + ` (do (apush (var ${tmp}) (aget (var ${src}) (var ${ix})))`
          + ` (set ${ix} (bin "+" (var ${ix}) (int 1))))))`);
      }
      code = `${code} (var ${tmp})`;
    }
  }
  return { code: `${code})`, type: s.ret };
}

export function asyCallArgs(L, n) {
  const out = [];
  // `f(a, ... xs)`：`(args-rest 实参)` 是"只有它"，`(args-rest arglist 实参)` 是
  // "前面还有几个"。摊平之后最后那一格记上 spread —— 它只能落在可变形参那一格上（见 fit）。
  let alist = n.items[2];
  let sp = null;
  if (isList(alist) && head(alist) === 'args-rest') {
    if (alist.items.length === 2) { sp = alist.items[1]; alist = null; }
    else { sp = alist.items[2]; alist = alist.items[1]; }
  }
  const list = alist === null ? [] : L.flat(alist, 'args');
  if (sp !== null) list.push(sp);
  for (const a of list) {
    const isSp = sp !== null && a === sp;
    if (!isList(a)) { L.nope(a, '认不出的实参'); return null; }
    let key = null;
    let node = null;
    if (head(a) === 'arg') node = a.items[1];
    else if (head(a) === 'arg-named') {
      key = isAtom(a.items[1]) ? a.items[1].value : null;
      node = a.items[2];
    } else if (head(a) === 'args-rest') {
      // 展开实参不在最末尾时它会从这里漏出来（`f(... a, 9)` 是
      // `(args-add (args-rest …) (arg 9))`）。这一条我们比 asy **严**：那边印
      // "unnamed argument after rest argument" 但**退 0**（量过；真正的语法错才退 1），
      // 也就是它把这句吞了。吞掉的语义没法照抄，所以这里直接拒 ——
      // 因此它进不了 strict（那条轴的判据是"真 asy 也退非 0"）。
      return L.err(a, '展开实参后面不能再有位置实参 ——'
        + ' asy 那边印 "unnamed argument after rest argument" 之后把这句吞了');
    } else { L.nope(a, `认不出的实参 '${head(a)}'`); return null; }
    if (isSp && key !== null) { L.nope(a, '带名字的展开实参'); return null; }
    // 有多个重载的裸函数名：先不求，等 fit 按槽的类型挑（overArg 里写了理由）
    const ov = L.overArg(node);
    if (ov !== null) {
      out.push({ key, node, spread: isSp, v: { code: null, type: `<${ov.nm} 的重载集>`, over: ov.cands }, lines: null });
      continue;
    }
    const save = L.pre;
    const lines = save === null ? null : [];
    if (lines !== null) L.pre = lines;
    const v = L.expr(node);
    L.pre = save;
    if (v === null) return null;
    out.push({ key, node, spread: isSp, v, lines });
  }
  return out;
}

/**
 * 一个候选合不合用。回 `{cost, slot, missing, reordered}` 或 null（不合用）。
 * `cost` 是要走几次隐式转换 —— 0 就是逐个同型。挑最小的那个，并列就是歧义。
 */
/** 候选的签名文本（诊断用）。`explicit` 要印出来 —— 它决定这个候选收不收这个实参 */
export function asySigText(L, c) {
  const parts = [];
  for (let i = 0; i < c.params.length; i++) {
    const p = c.ps === undefined || c.ps[i] === undefined ? null : c.ps[i];
    // 可变那一格印成 `... T[]`：诊断里"有的是 int(... int[])"比 "int(int[])" 说得清
    if (p !== null && p.rest === true) { parts.push(`... ${c.params[i]}`); continue; }
    // keyword 那一格也要印出来 —— 它同样决定这个候选收不收这个实参（只是按名字那一半）
    if (p !== null && p.kw === true) { parts.push(`${c.params[i]} keyword`); continue; }
    parts.push(p !== null && p.exp === true ? `explicit ${c.params[i]}` : c.params[i]);
  }
  return `${c.ret}(${parts.join(', ')})`;
}

export function asyFit(L, cand, raw) {
  const filled = new Map();
  const slot = [];
  let pos = 0;
  let cost = 0;
  let reordered = false;
  let last = -1;
  // 可变形参（`... T[] xs`）：最后那一格收所有多出来的位置实参。量过两条 ——
  // 任何**非**可变的候选都比可变的合适（`f(real)` 与 `f(... int[])` 撞上 `f(3)` 走前者，
  // 尽管那边还要一次 int->real 提升），所以贵不贵不能靠 cost，要另开一档在 applyCall
  // 里先比（varargs）。
  const rAt = cand.ps.length - 1;
  const isVar = cand.ps.length > 0 && cand.ps[rAt].rest === true;
  const elem = isVar ? asyElem(cand.ps[rAt].type) : null;
  const pack = [];
  for (const r of raw) {
    let at = -1;
    if (r.key === null) {
      while (filled.has(pos)) pos++;
      at = pos;
      pos++;
    } else {
      for (let k = 0; k < cand.ps.length; k++) if (cand.ps[k].name === r.key) at = k;
      // 可变那一格不能用名字给（asy 那边 `xs=` 也不认它，量过报 no matching function）
      if (isVar && at === rAt) return null;
    }
    // 位置实参落到可变那一格上（或更后面）：进那个包，不占槽
    if (isVar && r.key === null && at >= rAt) {
      if (r.v.over !== undefined) return null;   // 重载集当可变实参：另一刀
      if (r.spread === true) {
        // `... a`：整份数组接到包后面（可以与散着写的混，量过 `total(9, ... a)` 是 18）。
        // 类型要一模一样 —— asy 不给这一格做元素级的提升。
        if (r.v.type !== cand.ps[rAt].type) return null;
      } else {
        const ec = asyConvCost(r.v.type, elem);
        const eu = ec < 0 && L.castFor(elem, r.v.type, false) !== null ? 1 : ec;
        if (eu < 0) return null;
        cost += eu;
      }
      pack.push(slot.length);
      slot.push(-1);
      continue;
    }
    if (r.spread === true) return null;   // `... x` 只能落在可变那一格上
    if (at < 0 || at >= cand.ps.length || filled.has(at)) return null;
    // `T keyword x` 的槽**只能按名字给**（量过：`void f(int keyword a); f(3)` 那边报
    // "cannot call 'void f(int keyword a)' with parameter 'int'"）。keyword 的槽在尾巴上
    // 一整段（普通形参排在它后面是语法错），所以位置实参落到这儿就是"位置实参给多了"。
    if (r.key === null && cand.ps[at].kw === true) return null;
    // 重载集当值用（callArgs 先不定案的那种）：按**这个槽要的类型**挑一份。
    // 挑到就是同型（cost 不加），挑不到这个候选就不合用 —— 与别的实参一视同仁。
    if (r.v.over !== undefined) {
      let hit = false;
      for (const c of r.v.over) if (L.candFnType(c) === cand.ps[at].type) hit = true;
      if (!hit) return null;
      filled.set(at, true);
      slot.push(at);
      if (at < last) reordered = true;
      last = at;
      continue;
    }
    // `null` 当实参：类型来自**这个槽**（asy 就是这么定的，与重载集那一格同一条路子）。
    // 槽不是引用类型这个候选就不合用；是的话算同型，cost 不加 —— 落地在 coerce 里。
    if (r.v.type === ASY_NULL) {
      if (!asyRefTy(L, cand.ps[at].type)) return null;
      filled.set(at, true);
      slot.push(at);
      if (at < last) reordered = true;
      last = at;
      continue;
    }
    // `explicit` 的槽只收类型一模一样的实参（第二十六刀，量过：连 int->real 都挡）
    if (cand.ps[at].exp === true && r.v.type !== cand.ps[at].type) return null;
    const c = asyConvCost(r.v.type, cand.ps[at].type);
    // 用户的 `operator cast`（第二十七刀）：代价**跟内建提升一样**是 1 —— 量过打平时
    // asy 报 "is ambiguous"，所以这里不能给它一个更贵的分数偷偷分出胜负。
    const uc = c < 0 && L.castFor(cand.ps[at].type, r.v.type, false) !== null ? 1 : c;
    if (uc < 0) return null;
    cost += uc;
    filled.set(at, true);
    slot.push(at);
    if (at < last) reordered = true;
    last = at;
  }
  const missing = [];
  for (let k = 0; k < cand.ps.length; k++) {
    if (filled.has(k)) continue;
    // 可变那一格永远算给了：没给就是一个空数组（量过 `total()` 印 0）
    if (isVar && k === rAt) continue;
    if (cand.ps[k].def === null) return null;
    missing.push(k);
  }
  return { cost, slot, missing, reordered, varargs: isVar, pack, restAt: isVar ? rAt : -1 };
}

/**
 * 为"缺了哪几个实参"这一种形状生成包装函数，回它的名字（同形状只生一份）。
 * 包装的形参就是给了的那几个（按形参顺序），体里逐个 `(let 缺的 T 默认值)` ——
 * 默认值因此在**被调方的作用域**里求：能看见前面的形参，也只在没给时才求。
 */
export function asyDefWrapper(L, n, nm, d, f) {
  const key = `${d.sym}|${f.missing.join(',')}`;
  const had = L.wrapNames.get(key);
  if (had !== undefined) return had;
  const wname = `asy__def${L.wrapNames.size}_${nm}`;
  L.wrapNames.set(key, wname);
  // 给了的那几个槽（按形参顺序）：包装的形参表就是它
  const gave = [];
  for (let i = 0; i < d.ps.length; i++) {
    let has = false;
    for (const m of f.missing) if (m === i) has = true;
    if (!has) gave.push(i);
  }
  // 换掉正在降级的那份状态：包装函数是另一个作用域、另一串语句。用完还回去。
  // `at` 也要换：默认值是在**被调方的声明处**求的，能看见的候选也是那时候的那些。
  // 被调方在别的模块里时（第二十五刀）连**单元**一起换：默认值那个表达式里的名字
  // 是那个文件里的名字。
  const savePre = L.pre;
  const saveUpd = L.updates;
  const saveScopes = L.scopes;
  const saveAt = L.at;
  const saveUnit = d.unit === undefined || d.unit === L.unit.id
    ? null : L.unitIn(L.units[d.unit]);
  L.at = d.dat === undefined ? d.at : d.dat;
  // 方法的包装（第二十刀）：多一个 `this` 形参，而默认值那一段要能看见字段 ——
  // 它是在**被调方**的作用域里求的，那个作用域里字段是可见的。
  // 构造函数的包装（第二十一刀）不一样：`this` 不是形参而是**本地量** —— 对象在这里造，
  // 造完默认值才求（量过 asy 收 `void operator init(int n = x)`，`x` 是字段，出来的是
  // 字段的默认值），最后回那个对象。
  const rec = d.rec === undefined ? null : d.rec;
  const isCtor = d.ctor === true;
  const saveSelf = L.self;
  const saveAl = L.recAlias;
  L.scopes = [new Map()];
  if (rec !== null) {
    L.at = rec.at === undefined ? L.at : rec.at;
    L.self = { rec, mat: d.mat };
    // 默认值那段是在被调方的作用域里求的，struct 体里的 `using` 在那儿也认（见 recAlias）
    if (rec.tyAlias !== undefined) {
      L.recAlias = { map: rec.tyAlias, bi: d.abi === undefined ? 0 : d.abi };
    }
    L.declare(n, 'this', rec.name);
  }
  L.updates = [];
  const lines = [];
  L.pre = lines;
  let bad = false;
  if (isCtor) {
    const mk = L.recNew(n, rec.name);
    if (mk === null) bad = true;
    else lines.push(`(let this ${asyCore(rec.name)} ${mk})`);
  }
  for (const i of gave) L.declare(n, d.ps[i].name, d.ps[i].type);
  for (const i of f.missing) {
    const p = d.ps[i];
    const v = L.coerce(L.expr(p.def), p.type, p.def, `'${nm}' 的形参 '${p.name}' 的默认值`);
    if (v === null) { bad = true; break; }
    lines.push(`(let ${p.name} ${asyCore(p.type)} ${v.code})`);
    L.declare(n, p.name, p.type);
  }
  const args = [];
  if (rec !== null) args.push('(var this)');
  for (const p of d.ps) args.push(`(var ${p.name})`);
  if (isCtor) {
    lines.push(`(expr (call ${d.sym}_body ${args.join(' ')}))`);
    lines.push('(ret (var this))');
  } else {
    lines.push(d.ret === 'void'
      ? `(expr (call ${d.sym} ${args.join(' ')}))`
      : `(ret (call ${d.sym} ${args.join(' ')}))`);
  }
  const params = [];
  if (rec !== null && !isCtor) params.push(`(this ${asyCore(rec.name)})`);
  for (const i of gave) params.push(`(${d.ps[i].name} ${asyCore(d.ps[i].type)})`);
  const text = [`  (fn ${wname} (${params.join(' ')}) ${asyCore(d.ret)}`];
  for (const s of lines) text.push(`    ${s}`);
  L.pre = savePre;
  L.updates = saveUpd;
  L.scopes = saveScopes;
  L.at = saveAt;
  L.self = saveSelf;
  L.recAlias = saveAl;
  if (saveUnit !== null) L.unitOut(saveUnit);
  if (bad) return null;
  L.wraps.push(`${text.join('\n')})`);
  return wname;
}

/**
 * 内建数学函数。整数上的 `abs` 走一条 helper（核心方言里没有整数取绝对值），
 * 回 int 的那三个在 `(rmath …)` 外面套一层 `(toint …)` —— 结果本来就是整数，
 * 截断是精确的。
 */
export function asyMathCall(L, n, nm) {
  const spec = L.math.get(nm);
  if (spec.kind === 'nope') {
    return L.nope(n, `内建函数 '${nm}'（绑定表 builtins.tab 里有它，`
      + `但宿主的数学库里没有对应的一个 —— 得自己实现，这一刀还没做）`);
  }
  const args = asyArgs(L, n.items[2]);
  if (args === null) return null;
  if (args.length !== spec.arity) {
    return L.err(n, `'${nm}' 要 ${spec.arity} 个实参，给了 ${args.length} 个`);
  }
  const vs = [];
  for (const a of args) {
    const v = L.expr(a);
    if (v === null) return null;
    vs.push(v);
  }
  if (nm === 'abs' && vs[0].type === 'int') {
    L.used.add('asy__iabs');
    return { code: `(call asy__iabs ${vs[0].code})`, type: 'int' };
  }
  if (nm === 'abs' && vs[0].type === 'pair') {
    // abs(pair) 是模，和 length(pair) 同一条（量过：abs((3,-4)) 与 length((3,-4)) 都是 5）
    L.used.add('asy__pabs');
    return { code: `(call asy__pabs ${vs[0].code})`, type: 'real' };
  }
  if (nm === 'abs' && vs[0].type === 'triple') {
    // abs(triple) 同样是模（量过 abs((1,2,3)) 与 length((1,2,3)) 都是 3.74165738677394）
    L.used.add('asy__tabs');
    return { code: `(call asy__tabs ${vs[0].code})`, type: 'real' };
  }
  const parts = [];
  for (let i = 0; i < vs.length; i++) {
    const v = L.coerce(vs[i], 'real', args[i], `'${nm}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    parts.push(v.code);
  }
  const code = `(rmath "${spec.fn}" ${parts.join(' ')})`;
  if (spec.ret === 'int') return { code: `(toint ${code})`, type: 'int' };
  return { code, type: 'real' };
}
