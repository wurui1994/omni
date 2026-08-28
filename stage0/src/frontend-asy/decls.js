// Omni stage0 — asy 前端的**顶层声明**这一族：文件、函数、字段、文件级变量
//
// 从 lower.js 搬出来的第七摊，拆法同 calls.js：第一个形参 `L` 就是那个降级器。
//
// 这一摊管"一个顶层项怎么进符号表、又怎么落地"：修饰剥离（asyUnwrapMod / asyAuMod /
// asyStMod）、static 字段（asyStaticDec / asyStaticInit）、`operator init` 与
// `operator cast`（asyOinitSig / asyOinitFor / asyCastSig / asyCastFor）、形参表与函数类型
// （asyFormals / asyFnTypeOf）、签名与方法（asySig / asyMethodSig / asyMethod）、
// 文件级变量（asyGlobalNames / asyGvarHere / asyGvarAt / asyGvarLate）、函数体（asyFunc），
// 以及**两遍**那个骨架：asyDeclPass 先把这一批的名字全收进表，asyBodyPass 再降正文 ——
// asy 的名字解析是顺序的，但同一个文件里后面的函数能被前面的调用，所以必须两遍。

import { isList, isAtom, head } from '../sexpr/read.js';
import {
  ASY_NOPE, SCALARS, ASY_MODSTM, ASY_ARRELEM_TEXT, ASY_OPSYM, ASY_OPBAD, ASY_RESTPFX,
  asyIsArr, asyElem, asyIsFn, asyCore,
} from './types.js';
import { ZERO } from './runtime.js';
import { asyStmt, asyBody } from './stmts.js';
import { asyExpr, asyCoerce, asyCandFnType } from './exprs.js';
import { asyModLoad, asyModMerge, asyModStmt } from './modules.js';

/* ------------------------------------------------------------ 文件与函数 */

/** `static real f(...)` 这类修饰在文件层是无所谓的，剥掉 */
export function asyUnwrapMod(L, n) {
  let cur = n;
  while (isList(cur) && head(cur) === 'modified') cur = cur.items[2];
  return cur;
}

/**
 * 这一句带 `autounravel` 吗（第二十八刀）。树形是 `(modified (mods "autounravel"…) DEC)`。
 * struct 体里它的意思是"这个成员其实是**文件级**的声明"：量过 `asy -noV`
 *   - `autounravel real operator cast(R r)` 之后 `real x = a;` 通（不带 autounravel 的
 *     那份 asy 收声明但**不用**它 —— 报 "cannot cast 'R' to 'real'"）；
 *   - `autounravel int twice(R r)` 之后 `twice(z)` 是**裸名字**调用，不是方法；
 *   - 可见位置是**这个 struct 的位置**：写在 struct 前面的地方看不见（"no matching
 *     variable 'k'"）。
 * 所以降级就是把它交给文件级那条路（sig），`at` 用 struct 的下标。
 */
export function asyAuMod(L, n) {
  let cur = n;
  while (isList(cur) && head(cur) === 'modified') {
    for (const m of L.flat(cur.items[1], 'mods')) {
      if (isAtom(m) && m.value === 'autounravel') return true;
    }
    cur = cur.items[2];
  }
  return false;
}

/**
 * struct 体里的 `static T n = …`：登记一个**文件级变量**（符号名带上记录名），并记进
 * `rec.statics`。它不占成员槽 —— 语义见 stMod 的注释（量出来的）。
 * 初值不在这里发：由 bodyPass 走到那个 recorddec 时交给 staticInit，位置就是 struct 的位置。
 *
 * `au` 为真时这一句是 `autounravel T n = …`（第三十四刀）。量过它与 static **只差一条**：
 * 那个名字在 struct 之后的**文件级**也裸着可见。`autounravel int k = 7;` 之后
 * `write(k)` 印 7、`S s; write(s.k)` 也印 7、`k = 9;` 之后 `write(k)` 印 9 ——
 * 同一格。所以实现就是 static 那一份再往 `L.globals` 里挂一个同一个 `g`。
 * `collections/iter.asy:42/44` 靠这条。
 */
export function asyStaticDec(L, rec, r, at, au) {
  const what = au === true ? 'autounravel' : 'static';
  const base = L.type(r.items[1], `struct ${rec.name} 的 ${what} 字段`);
  if (base === null) return null;
  if (rec.statics === undefined) rec.statics = new Map();
  for (const d of L.flat(r.items[2], 'decids')) {
    if (!isList(d) || head(d) !== 'decid') return L.err(d, `认不出的 ${what} 字段声明`);
    const start = d.items[1];
    // `static int sf(int) = twice;`：形参表跟在**名字**后面 —— 那是一个**函数值**的
    // 静态字段（第三十八刀）。量过 asy 收：`Box.sf(3)`、裸的 `af(4)`、`q.af(5)` 三条都通。
    // 与文件级那一档同一条路（globalNames 里那半边），所以类型也走同一个 fnTypeOf。
    let t = base;
    if (isList(start) && head(start) === 'fundecidstart') {
      t = L.fnTypeOf(base, start.items[2], start);
      if (t === null) return null;
    } else if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) {
      return L.nope(start, `带维度的 ${what} 字段名`);
    }
    if (!asyIsFn(t) && !SCALARS.has(t) && t !== 'pair' && t !== 'triple' && !L.isRec(t)
        && !(asyIsArr(t) && L.arrElemOk(asyElem(t)))) {
      return L.nope(r, `struct ${rec.name} 的 ${what} ${t} 字段（这一刀的全局量只收 `
        + 'int/real/bool/string/pair/triple、struct、函数类型，与它们的一维数组）');
    }
    const nm = isAtom(start.items[1]) ? start.items[1].value : null;
    if (nm === null) return L.err(start, `${what} 字段少了名字`);
    for (const f of rec.fields) {
      if (f.name === nm) return L.err(start, `'${nm}' 在 struct ${rec.name} 里已经是字段了`);
    }
    if (rec.statics.has(nm)) return L.err(start, `${what} 字段 '${nm}' 重复声明`);
    const g = { sym: `asy__sf${L.gdecls.length}_${rec.name}_${nm}`, type: t, at, ok: true };
    L.gdecls.push(g);
    rec.statics.set(nm, g);
    // autounravel：同一格再往文件级挂一个名字。位置是 struct 的位置，所以写在 struct
    // 前面的地方看不见它（与 autounravel 的函数同一条规则，量过）。
    if (au === true) {
      const list = L.globals.has(nm) ? L.globals.get(nm) : [];
      list.push(g);
      L.globals.set(nm, list);
    }
  }
  return true;
}

/**
 * 一个 recorddec 里那些 static 声明的**初值**（bodyPass 用）。它们是文件级变量，
 * 所以发的是 `(set 符号 值)` —— 与 vardec 里文件级那一档同一句。位置是 struct 的位置。
 * 标量零初始化，所以没写初值的什么都不发；聚合不行（记录要 new、数组要 anew）。
 */
export function asyStaticInit(L, n, at) {
  // `(recorddec ID block)` —— 名字是个**原子**，不是 `(name …)`
  const rnm = isAtom(n.items[1]) ? n.items[1].value : null;
  const rec = rnm === null ? undefined : L.records.get(rnm);
  if (rec === undefined || rec.statics === undefined) return [];
  const out = [];
  L.at = at;
  for (const item of L.flat(n.items[2], 'block')) {
    const r = asyUnwrapMod(L, item);
    if (!isList(r) || head(r) !== 'vardec') continue;
    // `static` 与 `autounravel` 的 vardec 都登记在 rec.statics 里，初值也都从这里发
    if (!asyStMod(L, item) && !asyAuMod(L, item)) continue;
    for (const d of L.flat(r.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') continue;
      const start = d.items[1];
      if (!isList(start) || !isAtom(start.items[1])) continue;
      const g = rec.statics.get(start.items[1].value);
      if (g === undefined) continue;
      let init = null;
      if (d.items[2] !== undefined) {
        const v = asyCoerce(L, asyExpr(L, d.items[2]), g.type, d.items[2],
          `static ${rec.name}.${start.items[1].value} 的初值`);
        if (v === null) continue;
        init = v.code;
      } else if (L.isRec(g.type)) {
        init = L.recInit(start, g.type);
      } else if (asyIsArr(g.type)) {
        init = `(anew ${asyCore(g.type)} (int 0))`;
      }
      if (init !== null) out.push(`(set ${g.sym} ${init})`);
    }
  }
  return out;
}

/**
 * 这一句带 `static` 吗。struct 体里它的意思与 `autounravel` 是同一个形状：
 * **这不是字段，是一个名字挂在 struct 上的文件级变量**。量过（`asy -noV`，
 * struct 叫 Box —— 别用 `S`，base 里那是南那个方向常量）：
 *   static int n = 1; ... 之后 `Box.n` 是 1；`a.n = 7` 之后 `Box.n` 与 `b.n` 都是 7
 *   （同一格）；实例方法里裸的 `n` 就是它。
 * 文件层的 `static` 无所谓（unwrapMod 照旧剥掉），所以这个只在 struct 体里问。
 */
export function asyStMod(L, n) {
  let cur = n;
  while (isList(cur) && head(cur) === 'modified') {
    for (const m of L.flat(cur.items[1], 'mods')) {
      if (isAtom(m) && m.value === 'static') return true;
    }
    cur = cur.items[2];
  }
  return false;
}

/**
 * 文件级的 `T operator init()`（第二十二刀）：asy 用它换掉 `T t;` 的隐式构造。
 * 四条都量过（`asy -noV`）：
 *   - `A operator init() { A r = new A; r.x = 5; return r; } A a;` 之后 `a.x` 是 5，
 *     而 `A b = new A;` 绕开它（`b.x` 是 0）；
 *   - 每次构造求一次（计数器加两次就是 2）；
 *   - **顺序解析**：写在 `A a;` 后面的那份不算，两份都写就是"各管后面那一段"；
 *   - **内嵌记录字段也走它**，但按**那个 struct 声明处**的可见性定：
 *     `struct B { A a; }` 写在 oi 前面时 `b.a.x` 是 0，写在后面才是 5。
 * 形参不为空的那种不收：量过 `A operator init(int)` 之后 `A a = 7;` 报
 * "cannot cast 'int' to 'A'" —— 它不是隐式转换，能拿它干什么没量出来，所以不猜。
 */
export function asyOinitSig(L, n, at) {
  const ret = L.type(n.items[1], 'operator init 的返回类型');
  if (ret === null) return;
  if (!L.isRec(ret)) {
    L.nope(n, `回 ${ret} 的文件级 'operator init'（这一刀只有 struct 的那份）`);
    return;
  }
  // 别的模块里的 struct（第二十五刀）：`T t;` 造什么是在**声明它的那个模块**里定的
  // （见 recInit），所以这边再写一份的话我们会静静地不用它 —— 那不如拒得明白。
  if (L.records.get(ret).unit !== L.unit.id) {
    L.nope(n, `给另一个模块的 struct '${ret}' 定义文件级 'operator init'`);
    return;
  }
  const ps = asyFormals(L, n.items[3]);
  if (ps === null) return;
  if (ps.length !== 0) {
    L.nope(n, `带形参的文件级 'operator init'（asy 那边它也不是隐式转换 ——`
      + ` \`${ret} a = 7;\` 报 "cannot cast"）`);
    return;
  }
  const list = L.oinits.has(ret) ? L.oinits.get(ret) : [];
  // 同名的第 2 份及以后要改个名字：核心方言里模块层的名字是全局唯一的
  const sym = list.length === 0 ? `asy__oi_${ret}` : `asy__oi${list.length}_${ret}`;
  const cand = { ret, params: [], ps: [], node: n, at, sym };
  list.push(cand);
  L.oinits.set(ret, list);
  L.oiByNode.set(n, list);
}

/** 记录 `t` 在**当前位置**该用哪份文件级 operator init（没有就回 null） */
export function asyOinitFor(L, t) {
  const list = L.oinits.get(t);
  if (list === undefined) return null;
  let cur = null;
  for (const c of list) if (c.at <= L.at) cur = c;
  return cur;
}

/**
 * `T operator cast(S)` / `T operator ecast(S)`（第二十七刀）：用户定义的转换。
 * 六条都量过（`asy -noV`）：
 *   - `cast` 在**隐式位置**都管用：实参、初始化、return、数组元素赋值、数组字面量、
 *     字段默认值；`ecast` 只给 `(T) x` —— 只写 ecast 时 `V b = 5;` 报
 *     "cannot cast 'int' to 'V'"，而 `(V) 5` 通；
 *   - 代价**跟内建提升一样**：`void p(real); void p(V);` 加 `V operator cast(int)`
 *     之后 `p(3)` 报 "call ... is ambiguous"；
 *   - **不串**：`A operator cast(int)` 加 `B operator cast(A)` 之后 `q(5)`（要 B）不通，
 *     `V operator cast(real)` 之后 `p(3)`（int）也不通 —— 所以源类型必须**一模一样**；
 *   - **顺序解析**：写在调用点后面的那份不算；
 *   - 一个源类型转到两个目标、两个重载各收一个 -> ambiguous（打平的直接后果，白捡）；
 *   - `(T) x` 优先走内建（`(real) 3` 还是提升），用户那份是**兜底**。
 */
export function asyCastSig(L, n, at, ec) {
  const nm = ec ? 'operator ecast' : 'operator cast';
  const to = L.type(n.items[1], `${nm} 的目标类型`);
  const ps = asyFormals(L, n.items[3]);
  if (to === null || ps === null) return;
  if (to === 'void') {
    L.err(n, `'void ${nm}(…)' 不是合法的转换 —— 转成 void 没有意义`);
    return;
  }
  if (ps.length !== 1) {
    L.nope(n, `${ps.length} 元的 '${nm}'（asy 的转换是一元的：一个源类型一个目标类型）`);
    return;
  }
  const safe = to.replace(/[^A-Za-z0-9_]/g, '_');
  const cand = {
    ret: to, params: [ps[0].type], ps, node: n, sym: `${L.pfx}asy__cast${L.castNo}_${safe}`,
    pfx: L.pfx, unit: L.unit.id, at, dat: at, to, src: ps[0].type, ec,
  };
  L.castNo++;
  const list = L.casts.has(to) ? L.casts.get(to) : [];
  list.push(cand);
  L.casts.set(to, list);
  L.castByNode.set(n, [cand]);
}

/**
 * 从 `from` 转到 `to` 的用户转换，按**当前位置**挑（没有就回 null）。
 * `allowEc` 只在 `(T) x` 那个位置是 true。源类型要一模一样 —— asy 不串转换（量过）。
 */
export function asyCastFor(L, to, from, allowEc) {
  const list = L.casts.get(to);
  if (list === undefined) return null;
  let cur = null;
  for (const c of list) {
    if (c.src !== from) continue;
    if (c.ec && !allowEc) continue;
    if (c.at > L.at) continue;
    cur = c;   // 同一对类型写两份：后面那份管后面（跟别的顺序解析一致）
  }
  return cur;
}

/**
 * 形参表：`(formal (implicit) TYPE (decidstart NAME))`，带默认值时多一个
 * `varinit`（`(formal EX TYPE DECIDSTART VARINIT)`，第十刀加的）。
 * 默认值这里**只存节点不降级**：它要在调用点按"缺哪几个"生成的包装函数里降，
 * 因为量过 asy 的默认值是**每次调用**求一次、而且能引用前面的形参
 * （`void q(int a, int b = a + 10)`：`q(1)` 印 11）。
 */
export function asyFormals(L, node) {
  const out = [];
  // `... T[] xs`：语法上是 `(formals-rest 形参)`（只有它）或 `(formals-rest formals 形参)`
  // （前面还有几个固定的）。摊平之后给最后那一格记上 `rest`，别处一律当普通形参看 ——
  // 体里它**就是**一个 T[] 局部量，只有 fit / applyCall 要多看一眼。
  let fixed = node;
  let restF = null;
  if (isList(node) && head(node) === 'formals-rest') {
    if (node.items.length === 2) { fixed = null; restF = node.items[1]; }
    else { fixed = node.items[1]; restF = node.items[2]; }
  }
  const list = fixed === null ? [] : L.flat(fixed, 'formals');
  if (restF !== null) list.push(restF);
  for (let fi = 0; fi < list.length; fi++) {
    const f = list[fi];
    if (!isList(f)) return L.nope(f, '认不出的形参');
    // `T keyword x`（第三十四刀）：语法上是
    // `(formal-kw explicitornot 类型 ID decidstart [varinit])` —— 中间那个 ID 就是
    // `keyword` 那个词（词法里它不是保留字，所以在这儿验一句；asy 那边验不过报
    // "expected 'keyword' here"）。验完把它抠掉，剩下的形状与普通形参一模一样，
    // 下面那一大段照原样跑，只多带一个 kw 标记出去（fit 那边只多问一句）。
    let kw = false;
    let it = f.items;
    if (head(f) === 'formal-kw') {
      const w = isAtom(f.items[3]) ? f.items[3].value : null;
      if (w !== 'keyword') {
        // 这一条我们比 asy **严**：那边报 "expected 'keyword' here" 之后**退 0**
        // （量过），也就是把这句吞了。吞掉的语义没法照抄，所以这里直接拒 ——
        // 因此它进不了 strict（那条轴的判据是"真 asy 也退非 0"）。
        return L.err(f.items[3], `形参上只能写 'keyword'，这里写的是 '${w}'`
          + `（asy 那边报 "expected 'keyword' here"）`);
      }
      kw = true;
      it = [f.items[0], f.items[1], f.items[2], f.items[4]];
      if (f.items.length === 6) it.push(f.items[5]);
    } else if (head(f) !== 'formal') {
      return L.nope(f, '可变形参');
    }
    // 无名形参（`pair zero(real) {return 0;}`，graph.asy:271；`new real(int){return 0;}`，
    // math.asy:211）：语法上是 `(formal explicit 类型)`，只有三格。这个槽在体里没法提，
    // 所以补一个**按位置定死**的名字就够了 —— 定死是要紧的：声明遍与正文遍各求一次形参表，
    // 两遍拼出来的名字必须一样（用递增计数器就会错开）。`asy__` 是保留前缀。
    if (it.length === 3) {
      const at = L.type(it[2], '形参');
      if (at === null) return null;
      const aex = isList(it[1]) && head(it[1]) === 'explicit';
      out.push({ name: `asy__anon${fi}`, type: at, exp: aex, def: null, kw: kw });
      continue;
    }
    if (it.length !== 4 && it.length !== 5) return L.nope(f, '无名形参');
    const ex = it[1];
    // `explicit T x`（第二十六刀）：这个槽**只收类型一模一样的实参**。量过四条：
    //   - `void p(explicit real r); p(3);` 在 asy 那边报 "cannot call ... with
    //     parameter 'int'" —— 连内建的 int->real 提升都挡，不只挡用户的 operator cast；
    //   - `p(3.0)` 通；
    //   - 它**不进签名身份**：先 `void p(real)` 再 `void p(explicit real)` 是**替换**
    //     （量过：之后 `p(3.0)` 走后者、`p(3)` 直接报错），反序则是前者被换掉；
    //   - 算符与数组形参上一样管用。
    // 于是降级要做的只有两件：这里记个标记，fit() 那边多问一句。
    // `keyword` 那个标记走的是同一条路（量过它也不进签名身份：先 `void p(int keyword a)`
    // 再 `void p(int a)` 是**替换** —— 之后 `p(a=5)` 与 `p(5)` 都走后者）。
    const exp = isList(ex) && head(ex) === 'explicit';
    const t = L.type(it[2], '形参');
    const start = it[3];
    if (t === null) return null;
    // `real f(real)`：形参名后面挂一个形参表 —— 这个槽的类型是**函数类型**
    // （量出来的第一拦路虎，见 asyIsFn 的注释）。
    if (isList(start) && head(start) === 'fundecidstart') {
      const ft = asyFnTypeOf(L, t, start.items[2], start);
      if (ft === null) return null;
      const fnm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (fnm === null) return L.err(start, '形参少了名字');
      out.push({ name: fnm, type: ft, exp: exp, def: it.length === 5 ? it[4] : null, kw: kw });
      continue;
    }
    if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) return L.nope(start, '带维度的形参名');
    const nm = isAtom(start.items[1]) ? start.items[1].value : null;
    if (nm === null) return L.err(start, '形参少了名字');
    out.push({ name: nm, type: t, exp: exp, def: it.length === 5 ? it[4] : null, kw: kw });
  }
  // `keyword` 的槽是**尾巴上一整段**：asy 那边普通形参排在它后面是语法错
  // （量过报 "normal parameter after keyword-only parameter"）。这一条我们同样比它严 ——
  // 那边报完**退 0**（量过），所以它也进不了 strict。
  let sawKw = false;
  for (const p of out) {
    if (p.kw === true) { sawKw = true; continue; }
    if (sawKw) {
      return L.err(node, `普通形参 '${p.name}' 排在 keyword 形参后面 ——`
        + ' asy 那边报 "normal parameter after keyword-only parameter"');
    }
  }
  // 最后那一格是 `... T[]`：验三条，然后记上标记
  if (restF !== null) {
    const p = out[out.length - 1];
    if (p === undefined) return null;
    if (!asyIsArr(p.type) || !L.arrElemOk(asyElem(p.type))) {
      return L.nope(restF, `\`... ${p.type} ${p.name}\`（可变形参只能是一维数组，`
        + `元素是 ${ASY_ARRELEM_TEXT} 里那些）`);
    }
    if (p.def !== null) return L.nope(restF, '带默认值的可变形参');
    p.rest = true;
  }
  return out;
}

/**
 * `RET` + 一个形参表节点 -> 函数类型的字符串（`real(int,string)`）。
 * 这里**只要类型**：函数类型里的形参名在 asy 那边可以没有（`real f(real)`），
 * 有也不进类型身份 —— 所以不能走 formals()（它要求有名字，也要收默认值）。
 */
export function asyFnTypeOf(L, ret, formalsNode, at) {
  const ps = [];
  // `guide(... guide[])`（plain_paths.asy:3 的 interpolate）：可变那一格在语法上与普通函数
  // 那边同一个形状 —— `(formals-rest 形参)` 是"只有它"，`(formals-rest formals 形参)` 是
  // "前面还有几个固定的"。见 asyFormals 那一段。
  let fixed = formalsNode;
  let restF = null;
  if (isList(formalsNode) && head(formalsNode) === 'formals-rest') {
    if (formalsNode.items.length === 2) { fixed = null; restF = formalsNode.items[1]; }
    else { fixed = formalsNode.items[1]; restF = formalsNode.items[2]; }
  }
  const flist = fixed === null ? [] : L.flat(fixed, 'formals');
  if (restF !== null) flist.push(restF);
  for (const f of flist) {
    if (!isList(f) || head(f) !== 'formal') return L.nope(f, '函数类型里的关键字形参');
    const t = L.type(f.items[2], '函数类型里的形参');
    if (t === null) return null;
    if (f.items.length > 3) {
      const st = f.items[3];
      if (isList(st) && head(st) === 'fundecidstart') {
        const inner = asyFnTypeOf(L, t, st.items[2], st);
        if (inner === null) return null;
        ps.push(inner);
        continue;
      }
      if (isList(st) && head(st) === 'decidstart' && st.items.length > 2) {
        const d = L.dimsDepth(st.items[2]);
        if (d === null) return L.nope(st, '函数类型的形参名后面那串东西');
        let a = t;
        let k = 0;
        while (k < d) { a = `${a}[]`; k++; }
        ps.push(a);
        continue;
      }
    }
    ps.push(t);
  }
  // 最后那一格是 `... T[]`：与普通函数那边同一条规矩（一维数组、元素在白名单里），
  // 记法是把 `... ` 留在类型文本里（见 types.js 的 ASY_RESTPFX）。
  if (restF !== null) {
    const last = ps[ps.length - 1];
    if (last === undefined) return null;
    if (!asyIsArr(last) || !L.arrElemOk(asyElem(last))) {
      return L.nope(restF, `函数类型里的 \`... ${last}\`（可变形参只能是一维数组，`
        + `元素是 ${ASY_ARRELEM_TEXT} 里那些）`);
    }
    ps[ps.length - 1] = `${ASY_RESTPFX}${last}`;
  }
  let inner = '';
  for (const p of ps) inner = inner === '' ? p : `${inner},${p}`;
  return `${ret}(${inner})`;
}

/**
 * 第一遍：登记签名。**同名可以有多个**（第十一刀的重载）——`funcs` 里存的是一张
 * 候选表。同一份签名（形参类型逐个相同）第二次出现是**替换**，不是错：量过 asy 的
 * `int s(int x)` 后面再写 `real s(int x)`，调 `s(5)` 走的是后者。
 */
export function asySig(L, n, at) {
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  if (nm === null) return;
  if (nm === 'operator init') { asyOinitSig(L, n, at); return; }
  // `operator cast` / `operator ecast`（第二十七刀）：它们不进 funcs —— 候选按**目标类型**
  // 存（见 castSig），调用点只在"转换"这一步问它，名字本身在 asy 里也调不到。
  if (nm === 'operator cast' || nm === 'operator ecast') {
    asyCastSig(L, n, at, nm === 'operator ecast');
    return;
  }
  // 算符重载（第二十三刀）：`V operator +(V,V)` 就是个名字叫 `operator +` 的函数，
  // 所以候选表按这个名字存 —— asy 里它跟普通重载在同一张表里（量过：用户的
  // `int operator +(int,int)` 会**盖掉内建的** `2 + 3`）。降级出的符号名要是个标识符。
  let sym = nm;
  if (nm.startsWith('operator ')) {
    const op = nm.slice('operator '.length);
    if (ASY_OPBAD.has(op)) {
      L.err(n, `'operator ${op}' 不是合法的 asy 声明 —— asy 的语法里就没有这个算符名，`
        + `那边直接报 "syntax error"（不带 ASY_NOPE：不是还没做）`);
      return;
    }
    if (!ASY_OPSYM.has(op)) { L.nope(n, `算符 '${op}' 的重载`); return; }
    sym = `asy__op_${ASY_OPSYM.get(op)}`;
  }
  // 用户自己的 `write`（第四十五刀）：base 里到处都是（`void write(file, T)` 那一族，
  // plain_constants.asy:82 起、plain_strings、plain_pens、plain_paths…）。它就是个普通
  // 重载，只是这一层的 `write` 是**语句**，所以符号名要另起一个（`write` 这个名字在
  // 核心方言那边归 print 那条路），调用点先问用户的候选、都不匹配才落回内建那份
  // （见 stmts.js 的 asyWriteStmt 调用处）。
  if (nm === 'write') sym = 'asy__uwrite';
  const ret = L.type(n.items[1], `函数 ${nm} 的返回类型`);
  const ps = asyFormals(L, n.items[3]);
  if (ret === null || ps === null) return;
  if (nm.startsWith('operator ') && ps.length !== 1 && ps.length !== 2) {
    L.nope(n, `${ps.length} 元的 '${nm}'（算符只有一元与二元）`);
    return;
  }
  const types = [];
  for (const p of ps) types.push(p.type);
  // `ps` 带名字与默认值节点（命名实参与默认实参要它）；`params` 只是类型，
  // 保留是因为别处的实参检查一直按下标读它。
  // `base` 是**没加单元前缀**的符号名（重载改名时要它），`unit` 是"这份声明在哪个单元里"
  // —— import 进来的候选是别的单元的，改名与默认值都归那边管（第二十五刀）。
  const cand = {
    ret, params: types, ps, node: n, sym: `${L.pfx}${sym}`, base: sym,
    pfx: L.pfx, unit: L.unit.id, at, dat: at,
  };
  const list = L.funcs.has(nm) ? L.funcs.get(nm) : [];
  const key = asySigKey({ params: types, ps });
  for (let i = 0; i < list.length; i++) {
    if (asySigKey(list[i]) !== key) continue;
    list[i] = cand;
    L.funcs.set(nm, list);
    return;
  }
  list.push(cand);
  L.funcs.set(nm, list);
}

/**
 * 签名身份（"同签名是替换"那条比的就是它）。**可变形参那一格算在里面** ——
 * `int min(... int[] a)` 与 `int min(int[] a)` 是两份，不是一份。
 * 量出来的理由：base 里 plain_constants.asy:42 就是 `int min(... int[] a) {return min(a);}`,
 * 体里那个 `min(a)` 调的正是被它"替换"掉的那份（内建的 `min(int[])`）—— 不分开的话
 * 候选表里只剩可变那一份，`min(a)`（a 是 int[]）就报没有能匹配的签名。
 * `explicit` 不进签名身份（第二十六刀量过：先 `void p(real)` 再 `void p(explicit real)`
 * 是替换），形参名与默认值也不进（第二十四刀量过）。
 */
export function asySigKey(c) {
  const out = [];
  for (let i = 0; i < c.params.length; i++) {
    const p = c.ps === undefined ? undefined : c.ps[i];
    out.push(p !== undefined && p.rest === true ? `... ${c.params[i]}` : c.params[i]);
  }
  return out.join(',');
}

/**
 * 方法的签名（第二十刀）。存在 `funcs` 里的 key 是 `记录名.方法名` —— asy 的名字里不能
 * 有点，所以这个 key 不可能撞上文件级的函数名，而重载那套（候选表、同签名替换、
 * 第 2 个及以后改名）就白捡了。
 * `at` 是**结构体在文件里的下标**：方法体里能看见的文件级函数，正好是声明在这个结构体
 * 前面的那些（asy 的名字解析是顺序的，量过）。`mat` 是成员下标，管结构体内部的可见性。
 */
export function asyMethodSig(L, rec, n, mat, at, stat) {
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  if (nm === null) return null;
  // `void operator init(…)`（第二十一刀）：**构造函数**，调用形态是 `A(…)`。
  // 三条都量过：返回类型必须是 void（写 `int operator init(int)` 之后 `A(3)` 在 asy 那边
  // 报 "no matching variable 'A'" —— 那份根本没造出构造函数）、字段默认值在体之前就铺好
  // （`int z = 8;` 加体里 `z = z + 1` 出来是 9）、而 `A a;` **不**走它（量过是 0，不是
  // 体里赋的值 —— `A a;` 只认文件级的 `A operator init()`，那一条还在门外）。
  const ctor = nm === 'operator init';
  // `static` 的方法（第三十八刀）：它是**没有接收者**的那一种成员 —— 名字挂在 struct 上，
  // 调用形态有三种，都量过：`C.make(3)`、struct 的方法体里裸写 `make(3)`、
  // 以及**实例上**也能调（`a.make(7)` 通 —— 接收者算白搭）。构造函数与下标算符不收 static：
  // 那两个名字的调用形态本身就带接收者。
  if (stat === true && ctor) {
    return L.nope(n, `static 的 'operator init'（构造函数的调用形态本来就带接收者）`);
  }
  // `operator []` 与 `operator [=]`（collections/map.asy:26/29）当**普通方法**收下：
  // 名字里带算符，但调用形态是下标（`v[i]` / `v[i] = x`，见 asyIndex 与赋值那一侧），
  // 重载解析、默认实参、`v.operator [](2)` 这种直呼全跟着白捡。
  const idxOp = nm === 'operator []' || nm === 'operator [=]';
  // struct 体里的**算符重载**（第四十刀）：`plain_bounds.asy:111` 的
  // `private static pathpen operator *(transform, pathpen)`。量过（真 asy）：
  //   - 体里认（`2 * a` 走到它），**体外不认**（"no matching function 'operator *(int, V)'"，
  //     退 1 —— strict/ 里钉着）；
  //   - static 与不带 static 的都认；不带 static 的那份体里还能读实例字段（印 16），
  //     那是"绑住接收者"，门外（见 selfStatBad 里 opNonStat 那一支）。
  // 所以它落成：候选表按**算符那个名字**存（于是二元算符那条解析路一字不改），
  // 函数**没有接收者**，可见性另加一条"只在这个 struct 的体里"（asyVisible 里的 inRec）。
  const opOv = nm.startsWith('operator ') && !ctor && !idxOp;
  let opTail = null;
  if (opOv) {
    const op = nm.slice('operator '.length);
    if (ASY_OPBAD.has(op)) {
      return L.err(n, `'operator ${op}' 不是合法的 asy 声明 —— asy 的语法里就没有这个算符名，`
        + `那边直接报 "syntax error"（不带 ASY_NOPE：不是还没做）`);
    }
    if (!ASY_OPSYM.has(op)) return L.nope(n, `算符 '${op}' 的重载`);
    opTail = ASY_OPSYM.get(op);
  }
  const ret = L.type(n.items[1], `方法 ${rec.name}.${nm} 的返回类型`);
  const ps = asyFormals(L, n.items[3]);
  if (ret === null || ps === null) return null;
  if (ctor && ret !== 'void') {
    return L.nope(n, `返回 ${ret} 的 'operator init'（asy 只把 void 的那份当构造函数，`
      + `别的形态它自己也不给 ${rec.name}(…)）`);
  }
  const types = [];
  for (const p of ps) types.push(p.type);
  for (const p of ps) if (p.name === 'this') return L.nope(n, "叫 'this' 的形参");
  // 算符重载按**算符那个名字**存（不是 `记录名.名字`）：一元/二元那条解析路问的就是这张表
  if (opOv && ps.length !== 1 && ps.length !== 2) {
    return L.nope(n, `${ps.length} 元的 '${nm}'（算符只有一元与二元）`);
  }
  const key = opOv ? nm : `${rec.name}.${nm}`;
  // 一个 struct 里 `operator []` 与 `operator [=]` 各只能有**一个**（asy 自己就拒：量过
  // 报 "multiple operator[] definitions in one struct" / "…operator[=]…"）。所以这两个
  // 名字不是普通的重载集 —— 不裁就是"比 asy 多接受一门语言"，strict/op-index-dup 钉着。
  if (idxOp) {
    const had = L.funcs.get(key);
    if (had !== undefined && had.length > 0) {
      const w = nm === 'operator []' ? 'operator[]' : 'operator[=]';
      return L.err(n, `struct ${rec.name} 里有两个 '${nm}' —— asy 一个 struct 只收一个`
        + `（那边报 "multiple ${w} definitions in one struct"）`);
    }
  }
  // 构造函数的候选**看起来像个回记录的普通函数**（`ret` 是记录名、没有接收者），
  // 重载解析与默认实参那两套因此一字不改就能用；`ctor` 标记只在发正文时用。
  // 符号名不带单元前缀（第二十五刀）：记录名本身就是全局唯一的（见 recordDec）。
  // `operator []` / `operator [=]` 那两个名字里有空格和方括号，直接拼进符号名方言那边
  // 读不出来（量到的是 `unexpected character "["`），所以这里换成 idx / idxset。
  let mtail = nm;
  if (nm === 'operator []') mtail = 'idx';
  if (nm === 'operator [=]') mtail = 'idxset';
  const msym = ctor ? `asy__ctor_${rec.name}`
    : (opOv ? `asy__so_${rec.name}_${opTail}`
      : `${stat === true ? 'asy__sm_' : 'asy__m_'}${rec.name}_${mtail}`);
  const cand = {
    ret: ctor ? rec.name : ret, params: types, ps, node: n, at: -1, dat: at, mat, rec, ctor,
    sym: msym, base: msym, pfx: '', unit: L.unit.id, stat: stat === true || opOv,
    // 算符重载（第四十刀）：候选在算符那张表里，可见性靠这一条裁 —— 只在这个 struct 的
    // 体里（见 asyVisible）。不带 static 的那份也当"没有接收者"降，`opNonStat` 只用来
    // 把"体里用了实例成员"那句诊断说对（asy 收，我们还不收）。
    inRec: opOv ? rec.name : undefined, opNonStat: opOv && stat !== true,
    // 体里的项序号：正文是第二遍才降的，那时候要靠它裁 struct 体里的 `using`（见 aliasAt）
    abi: L.recAlias === null ? 0 : L.recAlias.bi,
  };
  const list = L.funcs.has(key) ? L.funcs.get(key) : [];
  const sk = asySigKey({ params: types, ps });
  for (let i = 0; i < list.length; i++) {
    if (asySigKey(list[i]) !== sk) continue;
    list[i] = cand;
    L.funcs.set(key, list);
    return cand;
  }
  list.push(cand);
  L.funcs.set(key, list);
  L.methodDecls.push({ rec, cand, at });
  return cand;
}

/**
 * 方法体。与 func() 的差别只有三处：多一个 `this` 形参（核心方言里 `this` 就是个普通
 * 名字，量过它当形参名合法）、`L.self` 开着（裸字段名走 `(fld (var this) f)`、
 * 裸方法名走同一个记录的方法）、`L.at` 设成**结构体**的文件下标。
 *
 * 构造函数（`void operator init(…)`，第二十一刀）出**两个**函数：正文还是那个多带一个
 * `this` 的 void 方法（名字后缀 `_body`），外面套一层 `asy__ctor_<记录>` —— 造对象、
 * 调正文、回对象。分两层不是为了好看：体里的 `return;` 在 void 那份里是合法的一条
 * `(ret)`，塞进一个"要回记录"的函数里就不合法了。
 */
export function asyMethod(L, rec, cand, at) {
  // 体里的 `using` 要在 formals 之前就开着：形参与返回类型里也可能写那个别名
  // （量过 `pt shift(pt d)` —— pt 是体里 using 起的名字）。见 recAlias。
  const keepAl = L.recAlias;
  L.recAlias = { map: rec.tyAlias, bi: cand.abi };
  const ps = asyFormals(L, cand.node.items[3]);
  if (ps === null) { L.recAlias = keepAl; return null; }
  const isCtor = cand.ctor === true;
  const isStat = cand.stat === true;
  const bodyRet = isCtor ? 'void' : cand.ret;
  const bodySym = isCtor ? `${cand.sym}_body` : cand.sym;
  const keepAt = L.at;
  L.at = at;
  // static 的方法体里**没有接收者**：`self` 照样开着（同一个 struct 的 static 成员要看得见），
  // 但带上 stat 标记 —— 实例字段与实例方法在这里不可见（量过 asy 报
  // "static use of dynamic variable"，见 strict/static-method-inst）。
  L.self = { rec, mat: cand.mat, stat: isStat, opNonStat: cand.opNonStat === true };
  L.push();
  if (!isStat) L.declare(cand.node, 'this', rec.name);
  for (const p of ps) L.declare(cand.node, p.name, p.type);
  // 体的 AST 存一份：与文件级函数同一条（见 funBody）—— 里面的匿名函数要拿它问
  // "这个外层名字在闭包之后还会不会被改"。方法这一路原来漏了这一句，于是 capOf 看到
  // body 是 null 就一律拒，plain_picture.asy:488 的 `d(f,t*T)` 就是这么掉出去的。
  const saveFnBody = L.fnBody;
  L.fnBody = cand.node.items[4];
  const body = asyBody(L, cand.node.items[4], bodyRet);
  L.fnBody = saveFnBody;
  L.pop();
  L.recAlias = keepAl;
  L.self = null;
  L.at = keepAt;
  if (body === null) return null;
  const last = body.length === 0 ? '' : body[body.length - 1];
  if (bodyRet !== 'void' && !last.startsWith('(ret ')) {
    let zero = null;
    if (asyIsArr(bodyRet)) zero = `(anew ${asyCore(bodyRet)} (int 0))`;
    else if (L.isRec(bodyRet)) zero = L.recInit(cand.node, bodyRet);
    else zero = ZERO.get(bodyRet);
    if (zero === null) return null;
    body.push(`(ret ${zero})`);
  }
  // static 的那份没有 `this` 形参 —— 它就是一个名字挂在 struct 上的普通函数
  const params = isStat ? [] : [`(this ${asyCore(rec.name)})`];
  for (const p of ps) params.push(`(${p.name} ${asyCore(p.type)})`);
  const lines = [`  (fn ${bodySym} (${params.join(' ')}) ${asyCore(bodyRet)}`];
  for (const s of body) lines.push(`    ${s}`);
  const text = `${lines.join('\n')})`;
  if (!isCtor) return text;
  // 全实参那份构造函数：造对象（字段默认值在这里铺，量过它在体之前）、调正文、回对象。
  // 缺实参那份走 defWrapper 的 isCtor 分支 —— 那边默认值要看得见字段，所以不能复用这个。
  const mk = L.recNew(cand.node, rec.name);
  if (mk === null) return null;
  const args = ['(var this)'];
  const cps = [];
  for (const p of ps) { args.push(`(var ${p.name})`); cps.push(`(${p.name} ${asyCore(p.type)})`); }
  const outer = [`  (fn ${cand.sym} (${cps.join(' ')}) ${asyCore(rec.name)}`,
    `    (let this ${asyCore(rec.name)} ${mk})`,
    `    (expr (call ${bodySym} ${args.join(' ')}))`,
    '    (ret (var this))'];
  return `${text}\n${outer.join('\n')})`;
}

/**
 * 类型名 `base` 在这个单元里指的那个**真名**（不是标量也不是记录名就回 null）。
 * 这一遍（收表）与 `L.type()` 的区别只有两条：不报诊断、不查顺序 —— 顺序留给 vardec。
 */
function asyDeclTyName(L, base) {
  if (SCALARS.has(base) || base === 'pair' || base === 'triple') return base;
  if (L.recVis.has(base)) return L.recVis.get(base).rec.name;
  return L.records.has(base) ? base : null;
}

/**
 * 第一遍收文件级变量（第二十四刀）：名字、类型、**位置**。位置要记，因为 asy 的名字
 * 解析是顺序的 —— 量过函数体里引用后面才声明的文件级变量，asy 报
 * "no matching variable of name 'g'"。
 *
 * 每份声明各出一个全局符号 `asy__g<序号>_<名字>`：同一个名字在文件里可以声明多次
 * （量过 `int a = 1; write(a); int a = 7; write(a);` 印 1 再印 7 —— 那是两个变量），
 * 而核心方言的模块级名字要全局唯一。
 *
 * 类型在这里是**照着节点看**出来的，不走 L.type()：那一路会报诊断，而这一遍
 * 只是收表，真正的检查在 vardec 里（同一句报两遍是噪音）。看不出是标量的就 ok:false，
 * 留在表里让函数里那句错话说得清是哪一条。
 */
export function asyGlobalNames(L, n, at) {
  const tn = n.items[1];
  // 类型是**照着节点看**出来的（不走 L.type()，那一路会报诊断）。三种形状：
  //   `pen p;`      -> (name-ty (name pen))
  //   `pair[] a;`   -> (array-ty (name pair) (dims))     里面是 (name …)，没有 name-ty
  //   `real a[];`   -> (name-ty (name real)) + decidstart 上挂 dims
  let base = null;
  let arr = 0;
  let inner = tn;
  if (isList(inner) && head(inner) === 'array-ty') {
    const d = L.dimsDepth(inner.items[2]);
    arr = d === null ? 0 : d;
    inner = inner.items[1];
  }
  if (isList(inner) && head(inner) === 'name-ty') inner = inner.items[1];
  if (isList(inner) && head(inner) === 'name' && isAtom(inner.items[1])) base = inner.items[1].value;
  for (const d of L.flat(n.items[2], 'decids')) {
    if (!isList(d) || head(d) !== 'decid') continue;
    const start = d.items[1];
    if (!isList(start) || !isAtom(start.items[1])) continue;
    const nm = start.items[1].value;
    // 名字后面挂了维度（`real a[];`）—— 那也是数组，与 `real[] a;` 同一件事
    let dims = 0;
    if (isList(start) && start.items.length > 2) {
      const dd = L.dimsDepth(start.items[2]);
      dims = dd === null ? 0 : dd;
    }
    // 记录名要换成**真名**（第三十八刀）：`recVis` 的键是"这里叫什么"，`rec.name` 是
    // "那个类型是什么"，遮住 prelude 那份 `picture` 时两者不一样。以前这里直接拿源码里
    // 那个名字当类型文本，于是模块级变量的类型落在**被遮住的**那份上（量出来的样子是
    // `struct picture 没有字段 'x'`）。顺序在这一遍不查 —— 这一遍只收表，真正的
    // 检查在 vardec 那一遍（recHere）。
    const el = base === null ? null : asyDeclTyName(L, base);
    let ty = el;
    // 类型名是个 **typedef 别名**：上面那一步只认标量与记录名，看不出它。
    // `transform3 identity4 = ...`（plain_prethree.asy）就是这一种 —— transform3 是
    // `real[][]` 的别名，而二维数组这一格本来是收的，只是名字没解开。
    // 位置临时设成这一项的位置：别名的可见性也是顺序的。aliasAt 不报诊断（这一遍只收表）。
    if (ty === null && base !== null) {
      const keep = L.at;
      L.at = at;
      const al = L.aliasAt(base);
      L.at = keep;
      if (al !== null) ty = al.t;
    }
    let k = 0;
    while (ty !== null && k < arr + dims) { ty = `${ty}[]`; k++; }
    // 函数值类型的模块级变量（第三十七刀）。形参表跟在**名字**后面的那一种写法
    // （`real f(real) = twice;`）在这一遍就要定出类型 —— 函数体里要看得见它，
    // 而这一遍是唯一在函数体之前跑的一遍。（`typedef real F(real); F f;` 那一种
    // 走上面的别名分支。）
    if (isList(start) && head(start) === 'fundecidstart') {
      const keep = L.at;
      L.at = at;
      ty = L.fnTypeOf(base === null ? null : base, start.items[2], start);
      L.at = keep;
    }
    // `var`（第四十一刀）：类型要从初值推，而这一遍就是唯一能推的地方 —— 函数体比
    // 文件级语句先降级（bodyPass 的顺序），所以等到 vardec 那一遍再定类型，函数体里
    // 引用它的那一句已经找不到类型了。推的时候位置就是这一项的位置，于是"初值里只看得见
    // 前面声明的东西"这条顺序规矩照旧（probeTy 拿完类型把代码和诊断都丢掉）。
    if (base === 'var' && arr + dims === 0 && head(start) === 'decidstart') {
      const keep = L.at;
      L.at = at;
      const pt = L.probeTy(d.items[2]);
      L.at = keep;
      if (pt !== null && pt !== 'void') ty = pt;
    }
    const ok = ty !== null;
    const g = { sym: `asy__g${L.gdecls.length}_${nm}`, type: ty, at, ok };
    const list = L.globals.has(nm) ? L.globals.get(nm) : [];
    list.push(g);
    L.globals.set(nm, list);
    if (ok) L.gdecls.push(g);
  }
}

/**
 * 名字 `nm` 在**当前位置**看得见的那份文件级变量（没有就 null）。顺序解析：
 * 挑 `at <= L.at` 的最后一份 —— 与 visible()（函数候选）、recHere()（类型名）
 * 是同一条规矩的第四处。
 */
export function asyGvarHere(L, nm) {
  const list = L.globals.get(nm);
  if (list === undefined) return null;
  let cur = null;
  for (const g of list) if (g.at <= L.at) cur = g;
  return cur;
}

/** 正在降级的这一句（`L.at`）声明的那份文件级变量。vardec 用它拿符号名。 */
export function asyGvarAt(L, nm) {
  const list = L.globals.get(nm);
  if (list === undefined) return null;
  for (const g of list) if (g.at === L.at) return g;
  return null;
}

/** 名字对得上，但那份文件级变量声明在**后面**。asy 自己也拒，所以是 err 不是 nope。 */
export function asyGvarLate(L, node, nm) {
  return L.err(node, `'${nm}' 在这里还不是一个变量 —— 文件级的 ${nm} 声明在后面，`
    + `而 asy 的名字解析是顺序的（那边报 "no matching variable of name '${nm}'"）`);
}

/** 第二遍：函数体。核心方言要求非 void 的函数每条路径都有 ret，asy 不要求 —— 差别见下。 */
export function asyFunc(L, n) {
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  // 文件级的 `T operator init()`（第二十二刀）不在 funcs 里 —— 它的候选表按记录名存
  // （见 oinitSig），所以这里按节点问一遍那张表。除此之外它就是个普通的 0 元函数。
  const oiList = L.oiByNode.get(n);
  // `operator cast` / `operator ecast`（第二十七刀）同理：候选按目标类型存，这里按节点问。
  const csList = L.castByNode.get(n);
  const list = oiList !== undefined ? oiList
    : (csList !== undefined ? csList
      : (nm === null || !L.funcs.has(nm) ? null : L.funcs.get(nm)));
  if (list === null) return null;
  // 这份声明对应哪个候选：按**节点**认，不按签名 —— 同签名被后面那份替换掉时，
  // 前面那份就没有候选了（asy 那边它也确实调不到），于是这里不发它。
  let d = null;
  for (const c of list) if (c.node === n) d = c;
  if (d === null) return null;
  const ps = asyFormals(L, n.items[3]);
  if (ps === null) return null;
  L.push();
  for (const p of ps) L.declare(n, p.name, p.type);
  // 体的 AST 存一份：里面的匿名函数要拿它扫"这个外层名字会不会被改"（见 capOf）
  const saveFnBody = L.fnBody;
  L.fnBody = n.items[4];
  const body = asyBody(L, n.items[4], d.ret);
  L.fnBody = saveFnBody;
  L.pop();
  if (body === null) return null;
  // 掉出函数尾巴：asy 是运行期报 "function did not return a value"，我们补一条零值 ret。
  // 这是**明写的**差别，不是漏的：核心方言的检查在编译期，而这条 ret 永远走不到才对。
  const last = body.length === 0 ? '' : body[body.length - 1];
  if (d.ret !== 'void' && !last.startsWith('(ret ')) {
    let zero = null;
    if (asyIsArr(d.ret)) zero = `(anew ${asyCore(d.ret)} (int 0))`;
    else if (L.isRec(d.ret)) zero = L.recInit(n, d.ret);
    else zero = ZERO.get(d.ret);
    if (zero === null) return null;
    body.push(`(ret ${zero})`);
  }
  const params = [];
  for (const p of ps) params.push(`(${p.name} ${asyCore(p.type)})`);
  const lines = [`  (fn ${d.sym} (${params.join(' ')}) ${asyCore(d.ret)}`];
  for (const s of body) lines.push(`    ${s}`);
  return `${lines.join('\n')})`;
}

/**
 * 这个单元里被**赋值**过的裸名字（任意深度，闭包体里也算）。
 * 用处见 asyFnSlots：asy 的函数声明其实就是"一格函数类型的变量"。
 */
function asyAssignedNames(node, out) {
  if (!isList(node)) return out;
  if (head(node) === 'assign') {
    const lhs = node.items[1];
    if (isList(lhs) && head(lhs) === 'name-exp') {
      const nd = lhs.items[1];
      if (isList(nd) && head(nd) === 'name' && isAtom(nd.items[1])) out.add(nd.items[1].value);
    }
  }
  for (const it of node.items) asyAssignedNames(it, out);
  return out;
}

/**
 * 被赋值过的**函数名**：另开一格文件级变量。
 *
 * asy 里 `void restore() {…}` 声明的是一格 `void()` 类型的**变量**，初值是那个函数，
 * 所以 `restore=r;` 是合法的（plain.asy:71 声明、:106 与 :113 赋值；restoredefaults
 * 同样）。我们的函数是一个没有槽的 `(fn …)`，名字上没处可写。
 *
 * 办法：给这种名字在**函数声明那一行**registers 一格文件级变量（类型就是这个函数的类型），
 * 函数体照旧发。读、调用、赋值都会落到 gvar 那一档上 —— 那一档在 nameOf 与 call 里都排在
 * 候选表**前面**，所以不用再动别处。填这一格的 `(set …)` 由 bodyPass 在那一行发（见那边）。
 *
 * 只认**独一份**的候选：重载了的话"赋的是哪一格"要靠类型定案，那是另一刀。
 */
function asyFnSlots(L, u, rs) {
  const assigned = new Set();
  for (const r of rs) asyAssignedNames(r, assigned);
  for (const nm of assigned) {
    if (!L.funcs.has(nm)) continue;
    const list = L.funcs.get(nm);
    if (list.length !== 1) continue;
    const c = list[0];
    if (c.unit !== u.id || c.slot !== undefined || c.inRec !== undefined) continue;
    const ty = asyCandFnType(L, c);
    if (ty === null) continue;
    const g = { sym: `asy__fs${L.gdecls.length}_${nm}`, type: ty, at: c.at, ok: true };
    const gl = L.globals.has(nm) ? L.globals.get(nm) : [];
    gl.push(g);
    gl.sort((a, b) => a.at - b.at);
    L.globals.set(nm, gl);
    L.gdecls.push(g);
    c.slot = g;
  }
}

/** 这一份 fundec 声明的名字有没有那一格（bodyPass 用它发 `(set …)`） */
export function asyFnSlotOf(L, n) {
  const nm = isAtom(n.items[2]) ? n.items[2].value : null;
  if (nm === null || !L.funcs.has(nm)) return null;
  for (const c of L.funcs.get(nm)) {
    if (c.node === n && c.slot !== undefined) return c;
  }
  return null;
}

/**
 * 声明遍：一个单元里的记录、模块声明、函数签名、文件级变量名（第二十五刀把它从 run()
 * 里分出来 —— 每个单元都要走一遍这个）。
 * 记录与模块声明在**同一遍**里按下标走：`import` 进来的 struct 要能当后面那些
 * struct 的字段类型，而 asy 的类型名是顺序解析的。
 */
/**
 * asy 的 **C++ 内建面**（path / pen / guide / frame / transform 那一族类型，与
 * runpath.in / runpen.in / runpicture.in 里那些函数）在真 asy 里是运行时自带的，
 * 每个文件、每个模块里都看得见 —— 它不是 `base/plain.asy` 的一部分。
 *
 * 我们把它做成**一个模块**（`stage0/lib/asy/asy_builtins.asy`，名字从 opts.prelude 来），
 * 在每个单元的声明遍开头隐式 import 一次：
 *   - struct 只声明一份（核心方言的 class 名是全局唯一的，摊进每个单元会撞名）；
 *   - 类型名与函数通过 modMerge 进到这个单元里，可见位置是 0（比所有顶层项都早）；
 *   - 体只跑一遍（modLoad 缓存 + `ran` 那道闸）。
 * 于是 `base/*.asy` 那一堆**引真的那些**就够了 —— 我们不抄 plain.asy。
 */
export function asyBuiltinsIn(L, u, off) {
  const nm = L.opts === null || L.opts.prelude === undefined ? null : L.opts.prelude;
  if (nm === null || nm === '' || u.key === nm) return;
  // 已经并过了就不再并（REPL 的第二批起）：名字都还在这个单元的表里，而"再并一遍"现在
  // 有害 —— 第三十八刀让 recVis 变成"后来的盖住先来的"，重并会用 prelude 那份盖掉
  // 用户上一批里遮住它的那个 struct。
  if (u.bi !== null) return;
  const keep = L.at;
  L.at = off;
  const b = asyModLoad(L, null, nm);
  if (b !== null) {
    asyModMerge(L, null, b, off, null);
    // 体在**这个单元的正文最前面**跑（bodyPass 开头那一句）。不能挂 callAt[off] ——
    // 那张表是"源码里 import 那一行"的位置，而 off 就是第一条顶层项的位置，
    // 挂上去会把用户的第一句吃掉。init 自己有 `ran` 那道闸，多调一次不会重跑。
    u.bi = b.init;
  }
  L.at = keep;
}

export function asyDeclPass(L, u) {
  const rs = u.rs;
  const off = L.atOff;
  asyBuiltinsIn(L, u, off);
  for (let i = 0; i < rs.length; i++) {
    const r = asyUnwrapMod(L, rs[i]);
    if (!isList(r)) continue;
    L.at = off + i;
    if (head(r) === 'recorddec') L.recordDec(r, off + i);
    else if (head(r) === 'typedec' || head(r) === 'typedec-using') L.typeDec(r, off + i);
    else if (ASY_MODSTM.has(head(r))) asyModStmt(L, r, off + i);
  }
  for (let i = 0; i < rs.length; i++) {
    const r = asyUnwrapMod(L, rs[i]);
    if (!isList(r)) continue;
    // 这一遍也要摆好 at：签名里的记录名按**这一句的位置**判可见（recHere）。
    L.at = off + i;
    if (head(r) === 'fundec') asySig(L, r, off + i);
    else if (head(r) === 'vardec') asyGlobalNames(L, r, off + i);
  }
  asyFnSlots(L, u, rs);
  // 重载的名字在这里定：核心方言没有重载，所以第 2 个及以后的候选要改名。
  // 第一个保留原名 —— 绝大多数函数不重载，输出的文本因此跟以前一样好读。
  // 数的只有**这个单元自己的**候选：import 进来的那些名字在它们自己的单元里早定好了。
  for (const list of L.funcs.values()) {
    let k = 0;
    for (const c of list) {
      if (c.unit !== u.id) continue;
      if (k > 0) c.sym = `${c.pfx}asy__ov${k}_${c.base}`;
      k++;
    }
  }
}

/** 一个单元的正文：方法体、文件级函数体，与"剩下那些语句"（模块是初始化函数，主文件是 main） */
export function asyBodyPass(L, u, fns) {
  const off = L.atOff;
  for (const m of u.methodDecls) {
    const text = asyMethod(L, m.rec, m.cand, m.at);
    if (text !== null) fns.push(text);
  }
  // struct 体里 `autounravel` 的那些（第二十八刀）：它们就是文件级函数，只是写在体里
  for (const m of u.auFns) {
    L.at = m.at;
    const f = asyFunc(L, m.node);
    if (f !== null) fns.push(f);
  }
  for (let i = 0; i < u.rs.length; i++) {
    const r = asyUnwrapMod(L, u.rs[i]);
    if (!isList(r) || head(r) !== 'fundec') continue;
    L.at = off + i;
    const f = asyFunc(L, r);
    if (f !== null) fns.push(f);
  }
  // 文件级那一层作用域：REPL 里要**跨批留住**（第 1 批的 `real[] xs` 第 2 批还看得见）。
  // 只有会话根有这个待遇：模块单元的文件级作用域随它自己那一遍结束。
  // 标量的文件级变量走的是另一条路（`(global …)`），这一层管的是数组/pair/记录那些。
  if (L.sessionRoot && u.id === 0) {
    if (L.fileScope === null) L.fileScope = new Map();
    L.scopes.push(L.fileScope);
  } else {
    L.push();
  }
  L.fileLevel = true;
  const main = [];
  // 隐式引进来的内建面（builtinsIn）：体在这个单元的最前面跑
  if (u.bi !== undefined && u.bi !== null) main.push(`(expr (call ${u.bi}))`);
  for (let i = 0; i < u.rs.length; i++) {
    const r = asyUnwrapMod(L, u.rs[i]);
    L.at = off + i;
    // 模块声明（第二十五刀）：声明遍已经把名字并进来了，这里发的是**体在那一行跑**
    // 的那一下 —— 初始化函数的调用，位置就是源码里 import 的位置。
    const calls = u.callAt.get(off + i);
    if (calls !== undefined) {
      for (const c of calls) main.push(`(expr (call ${c}))`);
      continue;
    }
    if (!isList(r)) continue;
    if (head(r) === 'fundec') {
      // 被赋值过的函数名那一格（见 asyFnSlots）：在**函数声明那一行**把它填上。
      // 位置是照抄 asy 的 —— 那边这一行本来就是"一格变量的声明加初值"。
      const c = asyFnSlotOf(L, r);
      if (c !== null) main.push(`(set ${c.slot.sym} (fnref ${c.sym}))`);
      continue;
    }
    if (head(r) === 'recorddec') {
      // 声明遍收过了。只有 `static` 那几条要在这里发一句初值（见 staticInit）
      for (const x of asyStaticInit(L, r, off + i)) main.push(x);
      continue;
    }
    if (head(r) === 'typedec' || head(r) === 'typedec-using') continue;   // 同上（只往别名表里记一条）
    if (ASY_MODSTM.has(head(r))) {
      // 同上（没做的那几种在那边报过了）。只有 `unravel x;` 例外：它要在**这里**才判得出
      // x 是不是一格文件级记录变量，摊出来的别名也正好进这一层作用域（发不出语句）。
      if (head(r) === 'unravel') asyStmt(L, r, 'void');
      continue;
    }
    const s = asyStmt(L, r, 'void');
    if (s === null) continue;
    for (const x of s) main.push(x);
  }
  L.fileLevel = false;
  L.pop();
  return main;
}
