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
  asyIsArr, asyElem, asyIsFn, asyFnSplit, asyFldSym, asyCore, ASY_NULL, asyRefTy,
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
    // `C.make(3)`：**类型名**限定的 static 方法（第三十八刀）。位置与 statQual 同一档、
    // 排在它前面：static 的方法与 static 的字段不会同名（一个 struct 里那是两个成员槽）。
    const qn2 = isAtom(callee.items[1].items[2]) ? callee.items[1].items[2].value : null;
    if (qn2 !== null) {
      const sm = L.statMethods(callee.items[1], qn2);
      if (sm.length > 0) return asyUserCall(L, n, `${L.plainName(callee.items[1].items[1])}.${qn2}`, sm, null);
    }
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
  // `h(3)(4)`：被调的是**上一次调用回来的那个值**（第四十二刀，返回类型自己是函数类型
  // 那一族）。与下标那一条同一条路子 —— 只在语法上就认得出的位置上问，认出来就当
  // 函数值调。量过 asy：`typedef real realfn(real); using G=realfn(real); G h=adder;`
  // 之后 `h(3)(4)` 印 7。
  if (isList(callee) && head(callee) === 'call') {
    const fv = L.expr(callee);
    if (fv === null) return null;
    if (!asyIsFn(fv.type)) {
      return L.err(n, `那一次调用回来的是 ${fv.type}，不是函数，调不了`);
    }
    return asyFnValCall(L, n, '上一次调用回来的那个值', fv.type, fv.code);
  }
  // `operator init(a, b);`：struct 体里**换一份构造再跑一遍**（plain_prethree.asy:195/201
  // 的 light 就是这么写的）。asy 那边它不是"再造一个对象"—— 量过 `void operator init(int a)`
  // 里调 `operator init(a, a+1)` 之后那个对象的两个字段是 3 与 4，改的是**同一格**。
  // 所以落法是调那份构造的正文 `<sym>_body`（带 `this`、回 void），不是外面那层 `<sym>`。
  if (isList(callee) && head(callee) === 'name-exp' && L.self !== null) {
    const nd = callee.items[1];
    const rawnm = isList(nd) && head(nd) === 'name' && isAtom(nd.items[1]) ? nd.items[1].value : null;
    if (rawnm === 'operator init') {
      if (L.self.stat === true) {
        return L.err(n, "static 的方法体里没有接收者，'operator init(…)' 调不了");
      }
      const cs = L.visibleMethods(L.self.rec, 'operator init');
      if (cs.length === 0) {
        return L.err(n, `struct ${L.self.rec.name} 里没有 'void operator init(…)'`);
      }
      const ras = asyCallArgs(L, n);
      if (ras === null) return null;
      return asyApplyCall(L, n, 'operator init', cs, ras,
        { code: '(var this)', type: L.self.rec.name }, true);
    }
  }
  // `operator tension(1,true)` / `operator ..(t)`：算符名就是**普通名字**（第四十四刀那一条
  // 的另一半），所以直呼也通。plainName 对 `operator …` 回 null（它不是标识符），于是这一档
  // 自己认：先问一格同名的局部/形参（`bool operator <= (coord,coord)` 那种形参），再问文件级
  // 的重载表。量过 asy：`TS operator tension(real,bool)` 之后 `operator tension(2,false)`
  // 就是那次调用（plain_paths.asy:16/129/130 全靠这个）。
  if (nm === null && isList(callee) && head(callee) === 'name-exp') {
    const nd = callee.items[1];
    const on = isList(nd) && head(nd) === 'name' && isAtom(nd.items[1]) ? nd.items[1].value : null;
    if (on !== null && on.startsWith('operator ')) {
      const osym = asyFldSym(on);
      const olv = L.lookup(osym);
      if (olv !== null && asyIsFn(olv)) return asyFnValCall(L, n, on, olv, `(var ${osym})`);
      const cs = asyVisible(L, on);
      if (cs.length > 0) return asyUserCall(L, n, on, cs, null);
      // 一格模块级变量（`interpolate operator ::=…` 之后 `operator ::(a,b)` 就是间接调）
      const ogv = L.gvarHere(on);
      if (ogv !== null && ogv !== L.gvarAt(on) && ogv.ok && asyIsFn(ogv.type)) {
        return asyFnValCall(L, n, on, ogv.type, `(var ${ogv.sym})`);
      }
      return L.err(n, `'${on}' 在这里还看不见 —— 没有这个名字的函数`);
    }
  }
  // 调用一个**任意表达式**：`(above ? add : prepend)(dest,src)`（plain_filldraw.asy:247）、
  // `((F) map.operator init)()`（collections/map.asy:102）、`pic.add(…)` 里存下来的那一格。
  // 先把被调那一侧当普通表达式降下来，是函数类型就走间接调用那一条（与函数值同一条路）。
  // 降不出来（或不是函数类型）就回滚，照旧报"还没做"—— 那句话对别的形状还是对的。
  if (nm === null && Array.isArray(L.pre)) {
    const mark = L.diags.mark();
    const savePre = L.pre;
    L.pre = [];
    const cv = L.expr(callee);
    const mine = L.pre;
    L.pre = savePre;
    if (cv !== null && cv.type !== undefined && asyIsFn(cv.type)) {
      for (const s of mine) L.pre.push(s);
      // 被调的那一侧可能是一串语句攒出来的临时量，`(callfn …)` 要的是个值 ——
      // 不是单个变量时先绑一格，免得它在实参之后才求（次序是照 asy 的：被调先求）。
      let code = cv.code;
      if (!/^\(var [A-Za-z0-9_]+\)$/.test(code)) {
        const tv = `asy__cal${L.tmp++}`;
        L.pre.push(`(let ${tv} ${asyCore(cv.type)} ${code})`);
        code = `(var ${tv})`;
      }
      return asyFnValCall(L, n, '那一次调用', cv.type, code);
    }
    // 被调那一侧是**还没定案的 `? :`**（两支的公共签名多于一个）：拿实参个数先筛一遍，
    // 再一个一个试着重降 —— 第一个成的算。asy 那边也是用这次调用去定那一句的类型。
    if (cv !== null && cv.code === null && cv.cond !== undefined) {
      L.diags.rollback(mark);
      for (const t of cv.cond.hit) {
        if (asyArityBad(L, n, t, '那一次调用')) continue;
        const m2 = L.diags.mark();
        const sp = L.pre;
        L.pre = [];
        const r = L.condAt(cv.cond, t);
        let out = null;
        if (r !== null) out = asyFnValCall(L, n, '那一次调用', t, r.code);
        const mine2 = L.pre;
        L.pre = sp;
        if (out !== null) { for (const s of mine2) L.pre.push(s); return out; }
        L.diags.rollback(m2);
      }
      return L.err(n, `\`? :\` 出来的那一格调不动：两支的公共签名是 ${cv.cond.hit.join(' / ')}`);
    }
    L.diags.rollback(mark);
  }
  if (nm === null) return L.nope(n, '调用一个不是普通名字的东西（函数值、方法、算符名）');
  if (nm === 'write') return L.err(n, `${ASY_NOPE}：write 出现在表达式位置（它是语句）`);
  let lateMem = null;   // 成员那一层"声明在后面"—— 外层也接不住时才拿它当诊断
  // 方法体里的裸方法名（第二十刀）：量过 struct 的成员**遮住**同名的文件级函数
  // （文件里有 `int who()`、struct 里也有 `who()`，方法体里调到的是后者），
  // 所以这一问放在文件级候选与内建名单**前面**。
  if (L.self !== null) {
    const ms = L.visibleMethods(L.self.rec, nm);
    if (ms.length > 0) {
      // 成员并**不整片遮住**外层的同名函数：asy 的 venv 是按签名逐层找的，
      // 成员那一层没有能接住这次实参的签名时还往外走。量过 plain_picture.asy:686 ——
      // struct picture 里有 `pair min(transform)`，体里照样调得到文件级的 `min(real,real)`。
      // 所以这里先试成员那一层，试不上就回滚（诊断与前置语句都回滚）再往下走。
      const probe = Array.isArray(L.pre);
      if (!probe) return asyUserCall(L, n, nm, ms, { code: '(var this)', type: L.self.rec.name });
      const mark = L.diags.mark();
      const savePre = L.pre;
      L.pre = [];
      const mv = asyUserCall(L, n, nm, ms, { code: '(var this)', type: L.self.rec.name });
      const mpre = L.pre;
      L.pre = savePre;
      if (mv !== null) {
        for (const s of mpre) L.pre.push(s);
        return mv;
      }
      L.diags.rollback(mark);
    }
    // 无体的方法声明（`int size();`）其实是**函数类型的字段**，所以方法体里的 `size()`
    // 是"读这一格再间接调"。与上面那一档同一个道理放在文件级候选前面：它也是个成员。
    //
    // 同名的可能有**好几格**（第七十一刀：重载的方法各摊一格）——逐格试，
    // 接不住的那格回滚（第六十六刀）。量出来的形状是 three_surface.asy:347 的
    // `point(external,0)` —— patch 里 `point` 是一格 `triple(real,real)` 的字段
    // （:262 被赋过值，所以摊成了字段），而这一句要的是文件级的 `triple point(path3, real)`。
    for (const sf of L.selfFieldsFn(nm)) {
      const fcode = `(fld (var this) ${asyFldSym(sf.name)})`;
      const fprobe = Array.isArray(L.pre);
      if (!fprobe) {
        const fv0 = asyFnValCall(L, n, nm, sf.type, fcode);
        if (fv0 !== null) return fv0;
        continue;
      }
      const fmark = L.diags.mark();
      const fsave = L.pre;
      L.pre = [];
      const fv = asyFnValCall(L, n, nm, sf.type, fcode);
      const fpre = L.pre;
      L.pre = fsave;
      if (fv !== null) {
        for (const s of fpre) L.pre.push(s);
        return fv;
      }
      L.diags.rollback(fmark);
    }
    // 同一件事，只是那一格是 **static** 的：`static frame fitter(string,picture,…);`
    // （plain_picture.asy:876 —— 无体的 static 方法声明就是一格 static 的函数类型字段，
    // 量过 `fitter == null` 是 true、`P.fitter = new …` 之后 `fitter(…)` 就通了）。
    // 位置照上面那一档：字段之后、文件级候选之前。static 的体里也看得见它。
    const ss = L.statOf(L.self.rec.name, nm);
    if (ss !== null && asyIsFn(ss.type)) {
      return asyFnValCall(L, n, nm, ss.type, `(var ${ss.sym})`);
    }
    // static 的方法体里调了实例方法：asy 自己也拒（"static use of dynamic variable"）。
    // 这一句要排在"声明在后面"那条**前面** —— 实例方法明明写在前面，只是这儿够不着它。
    if (L.selfInstMember(nm)) return L.selfStatBad(n, nm);
    // 声明在**后面**的成员（第三十五刀，字段默认值那一档把它显出来了）：
    // `struct S { int y = f(); int f() {…} }` asy 报 "no matching variable 'f'" 并退 1 ——
    // 它自己也拒。不专门问一句就会漏到下面的内建名单，报出带 ASY_NOPE 的"内建函数 'f'"，
    // 那是把"程序本来就不对"说成"我们还没做"。
    //
    // 但这条**不能当场报**：成员那一层看不见它，外层还看得见同名的东西。量过
    // plain_bounds.asy:226 —— struct freezableBounds 里 `pair min()` 声明在后面，
    // 那一行的 `min(a,b)` 在 asy 那边接的是外层（内建）的 min。所以这里只记下来，
    // 走到最后**什么都没接住**时才拿它当诊断。
    const all = L.units[L.self.rec.unit].funcs.get(`${L.self.rec.name}.${nm}`);
    let lateFld = false;
    for (const f of L.self.rec.fields) if (L.fldIs(f, nm)) lateFld = true;
    if (ms.length === 0 && ((all !== undefined && all.length > 0) || lateFld)) {
      lateMem = `'${nm}' 在这里还看不见 —— struct ${L.self.rec.name} 里它声明在后面，`
        + `而成员也是顺序解析的（asy 那边报 "no matching variable '${nm}'"）`;
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
  if (lv !== null && asyIsFn(lv)) {
    // `unravel x;` 摊出来的名字：调的是 x 那个字段里的函数值
    const al = L.aliasOf(nm);
    if (al !== null) return asyFnValCall(L, n, nm, lv, `(fld ${al.recv} ${asyFldSym(al.field)})`);
    // 装了箱的那一格（见 declareBox / localFunClo 的递归那一支）：读要穿到箱子里去
    const bx = L.boxOf(nm);
    const readCode = bx === null ? `(var ${L.symOf(nm)})` : `(aget (var ${bx.sym}) (int 0))`;
    // 但这一格并**不整片遮住**同名的函数：asy 的 venv 是按**签名**逐层找的，一个
    // `real opacity(real[])` 的形参与文件级的 `pen opacity(real, string)` 是两条不同的
    // 签名，能共存。原型是 plain_pens.asy:354 的
    // `pen mean(pen[] p, real opacity(real[])=min)`，体里那句
    // `opacity(opacity(t))` —— 里面那个是形参、外面那个是文件级的函数。
    // 所以跟上面成员那一档同一个办法：先试这一格，接不住就回滚再往下走。
    // 同一层里被**重新声明**遮住的那一格（declareShadow 记的 ov）也要试（第七十五刀）：
    // asy 的局部函数也是按**签名**分的 —— contour3.asy:229 与 :245 的两个 `setupweighted`
    // 就在同一层里，一个 6 个形参、一个 2 个（examples/cheese.asy 与 magnetic.asy 停在这里）。
    const ovs = L.outerOf(nm);
    const ovFn = ovs !== null && asyIsFn(ovs.type) ? ovs : null;
    const probe = Array.isArray(L.pre) && (asyVisible(L, nm).length > 0 || ovFn !== null);
    if (!probe) return asyFnValCall(L, n, nm, lv, readCode);
    const mark = L.diags.mark();
    const savePre = L.pre;
    L.pre = [];
    const fv = asyFnValCall(L, n, nm, lv, readCode);
    const fpre = L.pre;
    L.pre = savePre;
    if (fv !== null) {
      for (const s of fpre) L.pre.push(s);
      return fv;
    }
    L.diags.rollback(mark);
    if (ovFn !== null) {
      const m2 = L.diags.mark();
      const sp2 = L.pre;
      L.pre = [];
      const ovv = asyFnValCall(L, n, nm, ovFn.type, ovFn.code);
      const opre = L.pre;
      L.pre = sp2;
      if (ovv !== null) {
        for (const s of opre) L.pre.push(s);
        return ovv;
      }
      L.diags.rollback(m2);
    }
    // 文件级同名候选一个都没有：把这一格的诊断照原样发出来 —— 再往下走的话最后落在
    // "内建函数 '…'（这一刀只有 write 和你自己定义的函数）"上，那句指错了地方
    // （量出来的样子是 smoothcontour3.asy:193，真正接不住的是第 4 个实参）。
    if (asyVisible(L, nm).length === 0) return asyFnValCall(L, n, nm, lv, readCode);
  }
  // 匿名函数体里调**外层的**函数值形参/局部量（第四十七刀）：base 里 plain_picture.asy:488
  // 的 `add(new void(frame f, transform t, …) { d(f,t*T); })` —— `d` 是外层方法的形参，
  // 类型是 drawer（一个函数类型）。位置在本层局部量之后、文件级候选之前：asy 的名字解析
  // 是由内向外的，外层的局部量遮住同名的文件级函数。
  if (L.cap !== null && L.cap !== undefined) {
    let ot = null;
    let oov = null;
    for (const s of L.cap.outer) {
      if (s.has(nm)) {
        ot = s.get(nm);
        const o = s.get(`\u0000ov:${nm}`);
        oov = o === undefined ? null : o;
      }
    }
    // 外层同一层里被**重新声明**遮住的那一格（第七十五刀）：同名的局部函数在 asy 那边
    // 按签名分得开。挑法是拿实参类型给两格各打一次分（asyValFitCost）—— 形参个数一样、
    // 只有类型分得开的也在里面（smoothcontour3.asy:95/:109 的两个 `addtocoeff`）。
    // （asyArityBad 在"没有同名的文件级候选"时直接放行，它防的是另一件事，这里指望不上它。）
    // contour3.asy:229 那个六形参的 `setupweighted` 也是这么找回来的（:245 遮住了它），
    // 调用在里层 checkpyr 的体里（examples/cheese、magnetic、genustwo、genusthree）。
    if (oov !== null && asyIsFn(oov.type)) {
      const nodes = asyPlainArgNodes(L, n);
      if (nodes !== null) {
        const ats = [];
        for (const a of nodes) ats.push(L.probeType(a));
        const co = asyValFitCost(L, oov.type, ats);
        const ct = ot === null || !asyIsFn(ot) ? -1 : asyValFitCost(L, ot, ats);
        if (co >= 0 && (ct < 0 || co < ct)) {
          const ov2 = L.capSlot(nm, oov);
          if (ov2 !== null) return asyFnValCall(L, n, nm, ov2.type, ov2.code);
        }
      }
    }
    // 这一格也不整片遮住同名的函数（同 lookup 那一档的道理）。捕获是有副作用的
    // （capOf 会往闭包上添一格），所以这里不"试了再回滚"，而是先按**给了几个**筛一遍：
    // 原型是 plain.asy:125 那个 `exitfcn atupdate=atupdate();`，130 行的
    // `atupdate(atupdate)` 里外面那个是内建的 `void atupdate(exitfcn)`。
    if (ot !== null && asyIsFn(ot) && !asyArityBad(L, n, ot, nm)) {
      const cv = L.capOf(n, nm);
      if (cv === null) return null;
      if (cv.code === undefined) return null;   // CAP_BAD：诊断已发
      return asyFnValCall(L, n, nm, cv.type, cv.code);
    }
  }

  // 函数值的**文件级**变量（第三十七刀）：`typedef int F(int); F h; … h(5)`。
  // 位置照 nameOf 那一档的顺序 —— 局部、成员之后，候选表之前（那一档里有就不是函数名）。
  //
  // `gvarAt` 那一份要**排除**掉：正在声明的那个变量在自己的初值里还不可见。量出来的理由是
  // graph.asy 里三处 `ticklabel LogFormat=LogFormat(10);`（:267/:268 与 :1124 的
  // `axis Bottom=Bottom()`）—— 右边那个 `LogFormat` 是**函数**，不是刚声明的这个变量。
  // 不排除就会把它当成间接调用，然后报"要 string(real)，这里是 string"（真的量到了，
  // graph 一度从 183 涨到 186）。
  const gv = L.gvarHere(nm);
  if (gv !== null && gv !== L.gvarAt(nm) && gv.ok && asyIsFn(gv.type)
      && !asyArityBad(L, n, gv.type, nm) && !asyGvarLoses(L, n, nm, gv.type)) {
    // 这一格**真的接得住**才算：元数对得上但实参类型接不住时，同名的函数候选还得再试
    // 一次。量出来的形状是 plain_Label.asy:1 的 `real angle(transform)` —— 它本来不该
    // 有"那一格"，是 plain_arrows.asy:98 的 `angle=min(angle*…,45)`（改的是**形参**）
    // 让 fnSlots 误判了；`angle(z)`（z 是 pair）于是被当成间接调用，报"要 transform"。
    const mark = L.diags.mark();
    const savePre = Array.isArray(L.pre) ? L.pre : null;
    if (savePre !== null) L.pre = [];
    const fv = asyFnValCall(L, n, nm, gv.type, `(var ${gv.sym})`);
    const mine = L.pre;
    if (savePre !== null) L.pre = savePre;
    if (fv !== null) {
      if (savePre !== null) for (const s of mine) L.pre.push(s);
      return fv;
    }
    L.diags.rollback(mark);
    if (!L.funcs.has(nm)) return asyFnValCall(L, n, nm, gv.type, `(var ${gv.sym})`);
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
    if (best !== null && (bc === null || best <= bc)) {
      // 挑中的那份**真降下去**可能还是接不住：asyFit 的打分与 coerce 不是同一条尺 ——
      // 量过 math.asy:25 的 `angle(z)`（z 是 pair）：fit 给 plain_Label 的
      // `real angle(transform)` 打了分，coerce 那边 pair -> transform 没有这一条。
      // 这时回滚，让"自己求实参"的内建那一族（angle/dir/… 见 namedBuiltin）再试一次。
      const mark = L.diags.mark();
      const savePre = Array.isArray(L.pre) ? L.pre : null;
      if (savePre !== null) L.pre = [];
      const v = asyApplyCall(L, n, nm, vis, raw, null);
      const mine = L.pre;
      if (savePre !== null) L.pre = savePre;
      if (v !== null) {
        if (savePre !== null) for (const s of mine) L.pre.push(s);
        return v;
      }
      L.diags.rollback(mark);
      const alt = asyNamedBuiltin(L, n, nm);
      if (alt !== undefined) return alt;
      return asyApplyCall(L, n, nm, vis, raw, null);
    }
    // 内建赢；或者两边都没有能匹配的、而这个名字**本来就是内建那一族的** ——
    // 后一种要让内建那份去报诊断（`length(int[])` 那条话说得清楚得多，
    // 比"有的是 int(path)"有用）。两条都走 builtinRaw：它回 null 时诊断已经发过了。
    if (bc !== null || (best === null && asyBuiltinOwns(L, nm, raw))) return asyBuiltinRaw(L, n, nm, raw);
    // 两边都没有能匹配的：内建里还有**自己求实参**的那几族（pair/triple 的
    // dir/expi/dot/…、string(…)、字符串那一族、数学那一族）。它们不走 builtinRaw，
    // 所以在这里回滚了再试一次。量过的理由：prelude 里加了 `dir(path,real)` 之后
    // `dir(30,45)`（triple 那一族）一度报"没有能匹配 dir(int, int)"。
    if (best === null) {
      // 这个名字既是**记录名**又是文件级函数名（第六十六刀）：asy 那边"struct 的
      // `operator init`"与同名函数在**同一个重载集**里，而上面那一档只量了函数那一族。
      // 量出来的样子是 geometry.asy:5720 —— 文件级有 `triangle triangle(line,line,line)`，
      // struct triangle 里有 `void operator init(point,point,point)`，`triangle(P1,P2,P3)`
      // 于是报"没有能匹配的签名 —— 有的是 triangle(line, line, line)"。
      // 次序是"函数那一族先、构造后"：函数那族接得住时不走这里（上面已经返回了）。
      const crec0 = L.recOf(nm);
      if (crec0 !== null && L.visibleMethods(crec0, 'operator init').length > 0) {
        const cmark = L.diags.mark();
        const cSave = Array.isArray(L.pre) ? L.pre : null;
        if (cSave !== null) L.pre = [];
        const cv = asyCtorCall(L, n, crec0, nm);
        const cMine = L.pre;
        if (cSave !== null) L.pre = cSave;
        if (cv !== null) {
          if (cSave !== null) for (const s of cMine) L.pre.push(s);
          return cv;
        }
        L.diags.rollback(cmark);
      }
      const alt = asyNamedBuiltin(L, n, nm);
      if (alt !== undefined) return alt;
      // 数学那一族（sqrt/log/sin/…）也在这里回一次（第五十一刀）：内建面里加了
      // `real[] sqrt(real[])`（builtin.cc:225 一次注册标量与数组两格）之后，
      // `sqrt(realEpsilon)` 那句的候选表里只剩数组那份、接不住 —— 标量那份是写死在
      // 这个前端里的，得在这里让它再试一次（plain_prethree.asy:143 量出来的）。
      if (L.math.has(nm)) return asyMathCall(L, n, nm);
      // 刻意没做的那几个（`reverse`）：实参真是 string 时报那条专门的话 —— 落到
      // "没有能匹配 'reverse(string)'"上看不出是"这一刀没做"还是"asy 也没有"。
      if (ASY_STR_NOPE.has(nm)) {
        for (const r of raw) if (r.v.type === 'string') return L.nope(n, ASY_STR_NOPE.get(nm));
      }
    }

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
  // alias 也在"自己求实参"这一档（它不像 length 那样与模块里的名字撞过，所以只在这里问一次）
  if (nm === 'alias') {
    const raw = asyCallArgs(L, n);
    if (raw === null) return null;
    if (asyBuiltinOwns(L, nm, raw)) return asyBuiltinRaw(L, n, nm, raw);
    const ts = raw.map((a) => (a.v.type === ASY_NULL ? 'null' : a.v.type)).join(', ');
    return L.err(n, `alias(${ts})：asy 只给**记录与数组**现生 alias，而且两边要同型`
      + '（那边报 "no matching function"）');
  }
  // 泛型的那三个数组内建（copy / sequence / array）：模块里没有同名的候选时也要能调到 ——
  // 上面那一档只在 `vis.length > 0` 时才问 builtinOwns。
  if (nm === 'copy' || nm === 'sequence' || nm === 'array') {
    const raw = asyCallArgs(L, n);
    if (raw === null) return null;
    if (asyBuiltinOwns(L, nm, raw)) return asyBuiltinRaw(L, n, nm, raw);
    const ts = raw.map((a) => (a.v.type === ASY_NULL ? 'null' : a.v.type)).join(', ');
    return L.nope(n, `内建函数 '${nm}(${ts})'（这一刀的 copy 要一个数组、`
      + 'sequence 要 `T(int)` 加 int、array 要 int 加一个值）');
  }
  if (lateMem !== null) return L.err(n, lateMem);
  if (L.funcs.has(nm)) {
    return L.err(n, `'${nm}' 在这里还看不见 —— 它声明在后面，而 asy 的名字解析是顺序的（那边报 "no matching variable"）`);
  }
  return L.nope(n, `内建函数 '${nm}'（这一刀只有 write 和你自己定义的函数）`);
}

/**
 * 这一格函数值**明显接不住**这次调用（只数个数，不求实参），而且外面还有同名的函数
 * 可以接。用在捕获与文件级那两档 —— 它们都有副作用或先后次序，不好"试了再回滚"。
 * 形状里带名字实参或带展开时回 false：那种情形照旧交给 fnValCall 自己去报。
 */
/**
 * 这次调用的**普通**实参节点（没有 `...` 展开、也没有名字的那些）。认不出回 null。
 */
function asyPlainArgNodes(L, n) {
  const alist = n.items[2];
  if (isList(alist) && head(alist) === 'args-rest') return null;
  const list = alist === undefined || alist === null ? [] : L.flat(alist, 'args');
  const out = [];
  for (const a of list) {
    if (!isList(a) || head(a) !== 'arg') return null;
    out.push(a.items[1]);
  }
  return out;
}

/**
 * 这个函数类型接这次调用的**代价**（-1 是接不住）：形参个数要对上，每一格按
 * 「同型 0、内建提升 1+、用户 cast 3」记。用在"同名的两格局部函数里挑一格"这一档 ——
 * smoothcontour3.asy:95 与 :109 的两个 `addtocoeff` 形参个数一样（都是 4 个），
 * 只有类型分得开（一格收 triple、一格收 real）。
 */
function asyValFitCost(L, ty, ats) {
  const sp = asyFnSplit(ty);
  if (sp === null || sp.params.length !== ats.length) return -1;
  let cost = 0;
  for (let i = 0; i < ats.length; i++) {
    const at = ats[i];
    if (at === null) return -1;
    if (at === sp.params[i]) continue;
    const c = asyConvCost(at, sp.params[i]);
    if (c >= 0) { cost += 1 + c; continue; }
    if (L.castFor(sp.params[i], at, false) !== null) { cost += 3; continue; }
    return -1;
  }
  return cost;
}

function asyArityBad(L, n, ty, nm) {
  if (asyVisible(L, nm).length === 0) return false;
  const s = asyFnSplit(ty);
  if (s === null) return false;
  let alist = n.items[2];
  if (isList(alist) && head(alist) === 'args-rest') return false;
  const list = alist === undefined || alist === null ? [] : L.flat(alist, 'args');
  for (const a of list) if (!isList(a) || head(a) !== 'arg') return false;
  // 这个函数**类型**上记了默认值（asyFnTypeOf 的 fnDefs）：少给几格不算元数不对 ——
  // 前置声明那一族就是这样写的（`void draw(frame f, path3 g, material p=currentpen,
  // light light=nolight, string name="", render render=defaultrender,
  // projection P=currentprojection);`，three.asy:2112，真正的那份在 :2234 赋进去）。
  const info = L.fnDefs === undefined ? undefined : L.fnDefs.get(ty);
  if (info !== undefined && list.length <= s.params.length) {
    let need = 0;
    for (let i = 0; i < s.params.length; i++) {
      const p = info.ps[i];
      if (p === undefined || p.def === null || p.def === undefined) need++;
    }
    if (list.length >= need) return false;
  }
  return list.length !== s.params.length;
}

/**
 * 同名的**函数**里有一份与实参**完全同型**，而这一格变量（函数类型）要转换才接得住 ——
 * 那就该走函数那一档。asy 的重载解析里内建提升也是要记代价的，两边一起打分时同型的赢。
 *
 * 量出来的形状是 graph.asy:268 的 `ticklabel DefaultLogFormat=DefaultLogFormat(10);` ——
 * 这一句之后 `DefaultLogFormat(base)`（base 是 int）有两个候选：函数 `ticklabel
 * DefaultLogFormat(int)`（同型）与刚声明的那格变量 `string(real)`（int -> real）。
 * 挑错了就回 `string`，graph.asy:695/794 的 `? :` 两支于是不同型。
 */
function asyGvarLoses(L, n, nm, ty) {
  if (!L.funcs.has(nm) || !Array.isArray(L.pre)) return false;
  const s = asyFnSplit(ty);
  if (s === null) return false;
  let alist = n.items[2];
  if (isList(alist) && head(alist) === 'args-rest') return false;
  const list = alist === undefined || alist === null ? [] : L.flat(alist, 'args');
  for (const a of list) if (!isList(a) || head(a) !== 'arg' || a.items.length > 2) return false;
  const mark = L.diags.mark();
  const savePre = L.pre;
  L.pre = [];
  const ats = [];
  for (const a of list) {
    const v = L.expr(a.items[1]);
    ats.push(v === null || v.type === undefined ? null : v.type);
  }
  L.pre = savePre;
  L.diags.rollback(mark);
  for (const t of ats) if (t === null) return false;
  const same = (ps) => ps.length === ats.length && ps.every((p, i) => p === ats[i]);
  if (same(s.params)) return false;
  for (const c of asyVisible(L, nm)) {
    const cs = asyFnSplit(L.candFnType(c));
    if (cs !== null && same(cs.params)) return true;
  }
  return false;
}

/**
 * 内建里**自己求实参**的那几族，按名字再试一次（诊断与前置语句都能回滚）。
 * 不是这几族的名字回 `undefined`（与"试了但接不住"分得开）。
 */function asyNamedBuiltin(L, n, nm) {
  const fam = nm === 'length' || nm === 'string' || ASY_STRFN.has(nm)
    || ASY_PAIRFN.has(nm) || L.math.has(nm);
  if (!fam || !Array.isArray(L.pre)) return undefined;
  const mark = L.diags.mark();
  const savePre = L.pre;
  L.pre = [];
  let v = null;
  if (nm === 'length') v = L.lengthCall(n);
  else if (nm === 'string') v = L.strConvCall(n);
  else if (ASY_STRFN.has(nm)) v = L.strCall(n, nm);
  else if (ASY_PAIRFN.has(nm)) v = L.pairCall(n, nm);
  else v = asyMathCall(L, n, nm);
  const mine = L.pre;
  L.pre = savePre;
  if (v !== null) {
    for (const s of mine) L.pre.push(s);
    return v;
  }
  L.diags.rollback(mark);
  return undefined;
}

/**
 * 内建那一族的**按值**入口：实参已经降好（`raw`），谁都没求两次。
 * 前提是 `builtinOwns` 为真；实参类型这一族接不住时它自己发诊断并回 null。
 */
export function asyBuiltinRaw(L, n, nm, raw) {
  // 实参的前置语句按**给的顺序**发出去（callArgs 把它们攒在各自的 lines 里）
  for (const a of raw) if (a.lines !== null) for (const s of a.lines) L.pre.push(s);
  if (nm === 'length') return L.lengthOf(raw[0].v, raw[0].node);
  if (nm === 'copy') {
    const at = raw[0].v.type;
    const h = L.arrCopyHelper(asyElem(at));
    return { code: `(call ${h} ${raw[0].v.code})`, type: at };
  }
  if (nm === 'sequence') {
    const s = asyFnSplit(raw[0].v.type);
    const h = L.seqHelper(s.ret);
    return { code: `(call ${h} ${raw[0].v.code} ${raw[1].v.code})`, type: `${s.ret}[]` };
  }
  if (nm === 'array') {
    const el = raw[1].v.type;
    const h = L.arrFillHelper(el);
    return { code: `(call ${h} ${raw[0].v.code} ${raw[1].v.code})`, type: `${el}[]` };
  }
  if (nm === 'alias') return asyAliasRaw(L, raw);
  if (nm === 'search') {
    const h = L.searchHelper(asyElem(raw[0].v.type));
    return { code: `(call ${h} ${raw[0].v.code} ${raw[1].v.code} ${raw[2].v.code})`, type: 'int' };
  }
  return asyStrRaw(L, n, nm, raw);
}

/**
 * `alias(a, b)`：比**身份**。asy 那边它不是一个函数，而是 builtin.cc 给每个记录类型
 * （:673 `addOp(run::boolMemEq, …, SYM(alias), formal(r,…), formal(r,…))`）与每个数组类型
 * （:604-614 那一段）现生的一条 `bool(T,T)`；这个前端没有泛型，所以照那个办法在这里现生。
 * 落地就是记录/数组上的 `==` —— 与 asyCmpCode 同一条 `(bin "==" …)`（都是身份比较）。
 * 量过：`A a; A b=a; alias(a,b)` 是 true、`alias(a,new A)` 与 `alias(a,null)` 是 false，
 * 而函数类型上**没有** alias（`alias(g,f)` 报 no matching function），所以下面只认记录与数组。
 */
function asyAliasRaw(L, raw) {
  const fix = (v, other) => (v.type === ASY_NULL ? `(null ${asyCore(other)})` : v.code);
  const a = raw[0].v;
  const b = raw[1].v;
  const t = a.type === ASY_NULL ? b.type : a.type;
  return { code: `(bin "==" ${fix(a, t)} ${fix(b, t)})`, type: 'bool' };
}

/** alias 认的类型：记录与数组（函数类型不认 —— 量过 asy 那边也没有） */
function asyAliasTy(L, t) {
  return t === ASY_NULL || L.isRec(t) || asyIsArr(t);
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
 * 内建里**有形参名**的那一格（第七十九刀）。C++ 那边的内建是带 `formal(…, "n")` 的，所以
 * `array(n=6,value=1)`（SierpinskiSponge.asy:42）在 asy 那边照样落格。这一层的内建没有
 * 形参名那一份表，所以只把量出来要的那一个记在这里：`array(Int n, T value)`（builtin.cc:624）。
 * 名字都对得上、位置也不冲突时**就地**把 raw 排成位置序，剩下的路与不带名字那一档一模一样。
 */
const ASY_BLT_NAMES = new Map([['array', ['n', 'value']]]);
function asyBuiltinKeyed(nm, raw) {
  const ps = ASY_BLT_NAMES.get(nm);
  if (ps === undefined) return;
  let keyed = false;
  for (const a of raw) if (a.key !== null) keyed = true;
  if (!keyed || raw.length > ps.length) return;
  const use = new Array(ps.length).fill(null);
  let next = 0;
  for (const a of raw) {
    if (a.key === null) {
      while (next < ps.length && use[next] !== null) next++;
      if (next >= ps.length) return;
      use[next++] = a;
      continue;
    }
    const k = ps.indexOf(a.key);
    if (k < 0 || use[k] !== null) return;
    use[k] = a;
  }
  for (let i = 0; i < raw.length; i++) if (use[i] === null) return;
  for (let i = 0; i < raw.length; i++) {
    raw[i] = { key: null, node: use[i].node, spread: use[i].spread, v: use[i].v, lines: use[i].lines };
  }
}

/**
 * 这个名字加这个实参形状**是不是内建那一族的**（不看实参类型，只看名字与给了几个）。
 * 两族：`length`（与 asy_builtins.asy 的 `length(path)` 撞名）与字符串那一族
 * （`erase` 与 `asy_builtins.asy` 的 `erase(frame)` 撞名 —— 元数不同，所以按
 * "给了几个"就分得开）。带名字的实参一律不算内建那一族的 —— 只有 `array` 例外，见下。
 */
export function asyBuiltinOwns(L, nm, raw) {
  asyBuiltinKeyed(nm, raw);
  for (const a of raw) if (a.key !== null) return false;
  // 展开实参只能落在可变形参那一格上，而内建这一族一个可变形参都没有
  for (const a of raw) if (a.spread === true) return false;
  if (nm === 'length') return raw.length === 1;
  // 泛型的那两个数组内建：C++ 那边 copy/sequence 是对 T 泛型的（runarray.in:687/954），
  // 这个前端没有泛型，所以按实参的元素类型现生一份 helper（arrCopyHelper / seqHelper）。
  if (nm === 'copy') return raw.length === 1 && asyIsArr(raw[0].v.type);
  if (nm === 'sequence') {
    if (raw.length !== 2 || raw[1].v.type !== 'int') return false;
    const s = asyFnSplit(raw[0].v.type);
    return s !== null && s.params.length === 1 && s.params[0] === 'int' && s.ret !== 'void';
  }
  // `array(int n, T value)`（builtin.cc:624）：元素类型照第二个实参现生。第三个形参
  // （depth）这一刀不认 —— 给了三个就走"内建函数 'array'"那句 nope。
  if (nm === 'array') {
    if (raw.length !== 2 || raw[0].v.type !== 'int') return false;
    const el = raw[1].v.type;
    return el !== 'void' && el !== ASY_NULL;
  }
  // `search(T[] a, T key, bool less(T,T))`（runarray.in 的 searchArray）：同样是泛型的，
  // 按元素类型现生一份（searchHelper）。二元的那份在 prelude 里（`int search(real[], real)`）。
  if (nm === 'search') {
    if (raw.length !== 3 || !asyIsArr(raw[0].v.type)) return false;
    const el = asyElem(raw[0].v.type);
    if (raw[1].v.type !== el) return false;
    return raw[2].v.type === `bool(${el},${el})`;
  }
  // alias：两边都要是记录或数组（或 null），而且**同型** —— 两边都是 null 时 asy 报歧义
  // （量过 `operator ==(null, null)` 那条），所以不认。
  if (nm === 'alias') {
    if (raw.length !== 2) return false;
    const a = raw[0].v.type;
    const b = raw[1].v.type;
    if (!asyAliasTy(L, a) || !asyAliasTy(L, b)) return false;
    if (a === ASY_NULL && b === ASY_NULL) return false;
    return a === b || a === ASY_NULL || b === ASY_NULL;
  }
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
  if (nm === 'copy' || nm === 'sequence') return 0;   // 元素类型是照实参现生的，逐个同型
  if (nm === 'array') return 0;                       // 同上：第二个实参那个类型就是元素类型
  if (nm === 'alias') return 0;                       // 形参就是实参那个类型，逐个同型
  if (nm === 'search') return 0;                      // 同上：形参就是实参那几个类型
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
  for (const c of L.funcs.get(nm)) {
    if (c.at > L.at) continue;
    // struct 体里声明的算符重载（第四十刀）：只在**那个 struct 的体里**看得见。
    // 量过体外是 "no matching function 'operator *(int, V)'" 并退 1（strict/ 钉着）。
    // 体内还按成员顺序裁 —— 与 visibleMethods 那条 `c.mat <= self.mat` 同一条。
    if (c.inRec !== undefined) {
      if (L.self === null || L.self.rec.name !== c.inRec) continue;
      if (c.mat > L.self.mat) continue;
    }
    out.push(c);
  }
  return asyBiWeak(L, out);
}

/**
 * 内建面（asy_builtins.asy）里的候选是**弱**的：真库里出现同签名的一份时它退场。
 *
 * 理由是这一层的分工。asy 的内建表（builtin.cc）与 `base/plain.asy` 是两拨东西，
 * 而我们把"内建"写成了一份 asy 源码，里面难免混进了本该由 plain 提供的那几个 ——
 * `int[] sequence(int,int)` 就是（asy 那边只有 plain.asy:151 一份）。两份同签名的
 * 都可见时我们判"有多个同样合适的重载"，而 asy 那边压根只有一份。
 * 量过：math.asy:160/177 的 `sequence(1,b.length)` 就是这么报 ambiguous 的。
 */
function asyBiWeak(L, out) {
  if (L.biId === undefined || out.length < 2) return out;
  let hasBi = false;
  let hasReal = false;
  for (const c of out) {
    if (c.unit === L.biId) hasBi = true;
    else hasReal = true;
  }
  if (!hasBi || !hasReal) return out;
  const real = new Set();
  for (const c of out) if (c.unit !== L.biId) real.add(L.candFnType(c));
  return out.filter((c) => c.unit !== L.biId || !real.has(L.candFnType(c)));
}

/**
 * `接收者.方法(…)`（第二十刀）。接收者已经求好了，方法名去 `记录名.方法名` 那张候选表里
 * 找；找不到就把话说清 —— 同名的**字段**意味着"调一个函数值"（那要闭包，门外），
 * 什么都没有就把有哪些方法列出来。
 */
export function asyMethodCall(L, n, recv, mname) {
  const rec = L.records.get(recv.type);
  const ms = L.visibleMethods(rec, mname);
  // **接收者已经在手的 `operator init`**（第六十九刀）：collections/map.asy:110/112 的
  // `map.operator init(nullValue)`。构造函数那份候选长得像"回记录、没接收者的函数"，
  // 所以这里要换成"对象已经有了、只跑一遍正文"那一档 —— 目标是 `…_body`、回 void，
  // 带默认值时那份包装也另生一份（见 asyDefWrapper 里的 ri）。不换的样子是
  // `asy__ctor_… 要 2 个实参，给了 3 个`。
  const ri = mname === 'operator init';
  if (ms.length > 0) {
    // 方法那一档接得住就用它；接不住时**回滚**再看后面那几档 —— asy 的成员查找是按签名
    // 逐档找的。量过：struct 里 `void note(int)` / `void note(string)` 与**无体声明**的
    // `void note(int,string)`（那其实是函数类型的字段）并存时，`note(2,"b")` 接的是字段
    // 那一格。plain_picture.asy 的 `pic.addPath(g,p)` 正是这个形状 —— 借来的 addPath 在
    // struct bounds 里就是"两条方法加一条无体声明"。
    const probe = Array.isArray(L.pre);
    if (!probe) return asyUserCall(L, n, mname, ms, recv, ri);
    const mark = L.diags.mark();
    const savePre = L.pre;
    L.pre = [];
    const mv = asyUserCall(L, n, mname, ms, recv, ri);
    const mpre = L.pre;
    L.pre = savePre;
    if (mv !== null) {
      for (const s of mpre) L.pre.push(s);
      return mv;
    }
    L.diags.rollback(mark);
    const alt = asyMethodAlt(L, n, recv, rec, mname);
    if (alt !== undefined) return alt;
    // 后面那几档一个都不适用：让方法那一档把诊断再发一遍（它那句话最贴题）
    return asyUserCall(L, n, mname, ms, recv, ri);
  }
  const alt = asyMethodAlt(L, n, recv, rec, mname);
  if (alt !== undefined) return alt;
  for (const f of rec.fields) {
    if (L.fldIs(f, mname)) {
      return L.nope(n, `调用一个字段（${recv.type}.${mname} 是 ${f.type}，不是方法）`);
    }
  }
  const names = [];
  for (const key of L.units[rec.unit].funcs.keys()) {
    if (key.startsWith(`${rec.name}.`)) names.push(key.slice(rec.name.length + 1));
  }
  return L.err(n, `struct ${recv.type} 没有方法 '${mname}'`
    + `${names.length === 0 ? '（它一个方法都没有）' : ` —— 有的是 ${names.join(' / ')}`}`);
}

/**
 * 方法之外那几档：同名的**函数字段**、**static/autounravel 的函数值字段**、
 * 以及 `from 字段 unravel …` **借来**的名字。次序是"自己的成员在前、借来的在后"。
 * 一档都不适用时回 `undefined`（一句诊断都不发 —— 上面那层要靠这个分"要不要回滚"）。
 */
function asyMethodAlt(L, n, recv, rec, mname) {
  // 同名的字段有两格时（第四十九刀，见 recordDec）：**调用**形态挑函数类型那份 ——
  // three_arrows.asy 里 `a.size(p)` 要的是 `real size(pen)`，而 `a.size` 取值那一路
  // 在 recField 里另挑不是函数类型那份。发正文用 `f.name`（换过的槽名），不是源码那个名字。
  //
  // **函数类型那份可能有好几格**（第七十一刀：重载的方法各摊一格）——逐格试，
  // 谁接得住算谁。量出来的形状是 plain_picture.asy:1266 的 `b.addPath(g,p)`：
  // struct bounds 里 `addPath` 有 `void addPath(path)`（有体、被赋过值 -> 摊成一格字段）
  // 与无体声明的 `void addPath(path,pen)`（本来就是一格字段），只认第一格时前者赢，
  // 于是那一行报"要 1 个实参，给了 2 个"。都接不住时回 undefined，让上一层去发
  // 方法那一档的诊断（那句话更贴题）。
  const flds = [];
  let fld = null;
  for (const f of rec.fields) {
    if (!L.fldIs(f, mname)) continue;
    if (asyIsFn(f.type)) flds.push(f);
    else if (fld === null) fld = f;
  }
  if (flds.length === 1) {
    // 只有一格：照旧直呼，那句诊断（要几个实参、哪一格类型不对）留着
    return asyFnValCall(L, n, `${recv.type}.${mname}`, flds[0].type,
      `(fld ${recv.code} ${asyFldSym(flds[0].name)})`);
  }
  if (flds.length > 1) {
    const probe = Array.isArray(L.pre);
    for (const f of flds) {
      const code = `(fld ${recv.code} ${asyFldSym(f.name)})`;
      if (!probe) {
        const v = asyFnValCall(L, n, `${recv.type}.${mname}`, f.type, code);
        if (v !== null) return v;
        continue;
      }
      const mark = L.diags.mark();
      const save = L.pre;
      L.pre = [];
      const v = asyFnValCall(L, n, `${recv.type}.${mname}`, f.type, code);
      const mine = L.pre;
      L.pre = save;
      if (v !== null) { for (const s of mine) L.pre.push(s); return v; }
      L.diags.rollback(mark);
    }
    return undefined;
  }
  if (fld !== null) {
    // 同名的只有不是函数类型那一格：这不是"能调的东西"，让上一层去说
    return undefined;
  }
  // `q.af(5)` 与 `Box.af(5)` 取的是同一格（第三十八刀，量过 asy 两条都通）
  const st = L.statOf(rec.name, mname);
  if (st !== null && asyIsFn(st.type)) {
    return asyFnValCall(L, n, `${recv.type}.${mname}`, st.type, `(var ${st.sym})`);
  }
  // `from 字段 unravel 名字;` / `from 字段 unravel *;` 借来的成员（第五十八刀）：
  // 接收者往那个字段上走一层再问一遍 —— 方法、函数字段、static 三档都还是那三档，
  // 所以这里不自己挑重载。具名的那一档在通配前面。
  // 与 asy 的差别写在明处：asy 是把借来的名字**并进同一个重载集**，所以"本 struct 的
  // 一条与借来的一条都能接"时那边报歧义，而我们是本 struct 的先赢。plain 树里没有
  // 这种撞名，所以这一刀先按"自己的在前"落地。
  const al = rec.memAlias !== undefined && rec.memAlias.has(mname)
    ? rec.memAlias.get(mname) : rec.memAliasAll;
  if (al === undefined) return undefined;
  return asyMethodCall(L, n, { code: `(fld ${recv.code} ${asyFldSym(al.field)})`, type: al.type }, mname);
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
export function asyUserCall(L, n, nm, list, recv, reinit) {
  const raw = asyCallArgs(L, n);
  if (raw === null) return null;
  return asyApplyCall(L, n, nm, list, raw, recv, reinit);
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
    // struct 里**没有体**的那种成员声明（`V operator [] (K key);`，collections/map.asy:43/85）：
    // asy 那边它不是方法，是一格**函数类型的字段**。量过：
    // `struct S { int operator [] (int k); } S s; s.operator [] = new int(int k){return k*2;};`
    // 之后 `s[3]` 印 6。所以方法找不着时再问一遍字段。
    let ft = null;
    let fslot = mname;
    if (rec !== undefined) {
      for (const f of rec.fields) {
        if (L.fldIs(f, mname) && asyIsFn(f.type)) { ft = f.type; fslot = f.name; }
      }
    }
    if (ft !== null) return asyIdxFldCall(L, n, recv, fslot, ft, argNodes);
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

/** 下标算符落在一格**函数类型的字段**上（见 asyIdxOpCall 里那一档）：直接间接调 */
function asyIdxFldCall(L, n, recv, mname, ft, argNodes) {
  const s = asyFnSplit(ft);
  if (s === null) return L.nope(n, `认不出的函数类型 '${ft}'`);
  if (s.params.length !== argNodes.length) {
    return L.err(n, `'${mname}' 是 ${ft}，要 ${s.params.length} 个实参，给了 ${argNodes.length} 个`);
  }
  let code = `(callfn (fld ${recv.code} ${asyFldSym(mname)})`;
  for (let i = 0; i < argNodes.length; i++) {
    const v = L.coerce(L.expr(argNodes[i]), s.params[i], argNodes[i],
      `'${mname}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    code = `${code} ${v.code}`;
  }
  return { code: `${code})`, type: s.ret };
}

/**
 * userCall 的后半段：实参已经求好（`raw`），剩下的是挑候选、转换、发调用。
 * 分出来是给算符重载用的（第二十三刀）—— 那边的"实参"是已经降好的两个操作数，
 * 没有 callArgs 那一步，别的规则一条不差。
 */
export function asyApplyCall(L, n, nm, list, raw, recv, reinit) {
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
    // 再比"有几个实参是靠被遮住的那一格接上的"（见 fit 里的 shadow）：里层那一层
    // 先赢，所以这一档也在 cost 之前，档不同时**不算**打平。
    const bs = best.f.shadow;
    const is = fits[i].f.shadow;
    if (is < bs) { best = fits[i]; tie = false; continue; }
    if (is > bs) continue;
    if (fits[i].f.cost < best.f.cost) { best = fits[i]; tie = false; continue; }
    if (fits[i].f.cost === best.f.cost) {
      // 内建面那份是**弱**的（理由见 asyBiWeak）：与真库那份打平时让真库赢。
      // asyBiWeak 只筛掉**签名完全相同**的那一种；默认实参那一串不一样时两份都留下来，
      // 落到这里。量到的样子是引了真 base 之后 `'draw(path, pen)' 有多个同样合适的重载`
      // —— 而 asy 那边 `draw` 只有 plain 那一份。
      const bBi = best.c.unit === L.biId;
      const iBi = fits[i].c.unit === L.biId;
      if (bBi && !iBi) { best = fits[i]; tie = false; continue; }
      if (!bBi && iBi) continue;
      tie = true;
    }
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
      if (r.spread === true) {
        // `... a`：整份接进去，类型不一样时走一遍 coerce —— **数组级**的 `operator cast`
        // 就在那条路上（`path[] operator cast(pair[])`，于是 `operator --(... pair[])`
        // 接得住，bsp.asy:138）。少了这一句就只把类型改了名、码原样发出去，核心方言那边
        // 才炸（`arr<path> 的初值是 arr<vec<real,2>>`）—— 量出来就是这样。
        const sv = L.coerce(r.v, d.ps[f.restAt].type, r.node,
          `'${nm}' 的展开实参 ${d.ps[f.restAt].name}`);
        if (sv === null) return null;
        packed.push({ code: sv.code, spread: true });
        continue;
      }
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
  // static 的方法没有接收者（第三十八刀）：三条调用路径（`C.f(…)`、方法体里裸名、
  // 实例上 `a.f(…)`）都走这里，所以"丢掉接收者"这件事只在这一句里做一次。
  if (recv !== null && recv !== undefined && d.stat !== true) parts.push(recv.code);
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
  const ri = reinit === true;
  const target = f.missing.length === 0
    ? (ri ? `${d.sym}_body` : d.sym)
    : asyDefWrapper(L, n, nm, d, f, ri);
  if (target === null) return null;
  const sp = parts.length === 0 ? '' : ' ';
  return { code: `(call ${target}${sp}${parts.join(' ')})`, type: ri ? 'void' : d.ret };
}

/**
 * 通过一格 `T(… , ... E[])` 的**函数值**调用，实参是**已经降好**的那几个值。
 * 路径连接那一族用它（第四十六刀）：`::` 与 `---` 在 base 里是一格变量
 * （plain_paths.asy:129/130，类型 `guide(... guide[])`），而那一串实参是攒出来的
 * ——`asyFnValCall` 是从语法树上读实参的，接不上。
 */
export function asyRestValCall(L, n, nm, ft, callee, vals, nodes) {
  const s = asyFnSplit(ft);
  if (s === null) return L.nope(n, `认不出的函数类型 '${ft}'`);
  const rAt = s.params.length - 1;
  if (rAt < 0 || !asyIsRestP(s.params[rAt])) {
    return L.nope(n, `'${nm}' 不是带可变形参的函数类型（${ft}）`);
  }
  const restTy = asyRestBase(s.params[rAt]);
  const el = asyElem(restTy);
  if (vals.length < rAt) {
    return L.err(n, `'${nm}' 是 ${ft}，要至少 ${rAt} 个实参，给了 ${vals.length} 个`);
  }
  const codes = [];
  for (let i = 0; i < rAt; i++) {
    const cv = L.coerce(vals[i], s.params[i], nodes[i], `'${nm}' 的第 ${i + 1} 个实参`);
    if (cv === null) return null;
    codes.push(cv.code);
  }
  const tmp = `asy__jv${L.tmp++}`;
  L.pre.push(`(let ${tmp} ${asyCore(restTy)} (anew ${asyCore(restTy)} (int 0)))`);
  for (let i = rAt; i < vals.length; i++) {
    const ev = L.coerce(vals[i], el, nodes[i], `'${nm}' 的可变实参`);
    if (ev === null) return null;
    L.pre.push(`(apush (var ${tmp}) ${ev.code})`);
  }
  codes.push(`(var ${tmp})`);
  return { code: `(callfn ${callee} ${codes.join(' ')})`, type: s.ret };
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
  // 算符名也可以是**一格局部量/形参**：`bool operator <= (coord,coord)` 那种形参
  // （plain_scaling.asy:41 的 maxcoords）。它遮住文件级同名的算符 —— 少了这一句，
  // `maxcoords(coords, operator >=)` 编得过，体里的 `a <= b` 却还是去调文件级那份
  // `operator <=`，于是 m 与 M 都算成同一个（一个不报错的错答案）。
  const lsym = asyFldSym(`operator ${op}`);
  const lv = L.lookup(lsym);
  if (lv !== null && asyIsFn(lv)) {
    const s = asyFnSplit(lv);
    if (s !== null && s.params.length === vals.length) {
      const cs = [];
      for (let i = 0; i < vals.length; i++) {
        const cv = L.coerce(vals[i], s.params[i], n, `'operator ${op}' 的第 ${i + 1} 个操作数`);
        if (cv === null) return null;
        cs.push(cv.code);
      }
      return { code: `(callfn (var ${lsym}) ${cs.join(' ')})`, type: s.ret };
    }
  }
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
    // 走**可变那一格**接下来的候选不算"同型"（第四十七刀）。asyFit 里那条注释说过：
    // 任何非可变的候选都比可变的合适 —— 内建那一档也是非可变的，所以它也压得住可变那份。
    // 量出来的理由：plain_strings.asy:125 是 `string operator +(...string[] a)`，体里
    // 那句 `S += s` 在 asy 那边走的是**内建的**字符串接（asy 自己不会栈溢出）；漏了这一条，
    // `S + s` 会把两格打包再调回自己 —— 10 个例子（log / spiral / advection …）就是这么
    // 崩在 `Maximum call stack size exceeded` 上的。
    // 靠**被遮住的那一格**才接上的候选也不算"同型"（第七十三刀）：`real[] t1=…;`
    // 之后又 `real t1=t1[0];`（three.asy:2067）时，`t1 >= t2` 两边都是 real，而
    // `bool[] operator >=(real[], real)` 与 `bool[] operator >=(real, real[])` 各靠
    // 一格被遮住的 real[] 接上、代价都是 0 —— 少了这一条就在这两份之间报 ambiguous，
    // 而 asy 那边走的是内建的 `real >= real`（量过：印 lt）。
    if (f.cost === 0 && f.varargs !== true && f.shadow === 0) exact = true;
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
    // 给**少**了：asy 那边这不一定是错 —— 函数值上的默认值是**被调方**填的
    // （application.h:76 的 defaultArg 发一个 inst::push_default，runtime.in:276 的
    // pushDefault 在被调方把它换成真值），而我们的默认值是**调用处**用包装填的
    // （asyDefWrapper），通过一个值调的时候拿不到那份包装。所以这一格是"还没做"，
    // 不是"程序不对"。给多了才是真错。
    if (!isVar && args.length < s.params.length) {
      // 类型上带默认值那一档（`using envelope=path(frame dest, frame src=dest, …)`，
      // plain_boxes.asy:75；`path[] texpath(string s, pen p, bool tex=…, bool bbox=false);`，
      // plain_Label.asy:215）：现造一个包装 —— 形参是"给了的那几格"，体里在**声明处**
      // 求默认值，然后拿全套实参间接调。asy 那边默认值是被调方填的，落到这一层就是
      // "多一层包装"，求值次序（先被调、再实参、最后默认值）与那边一致。
      const use = asyFnValFit(L, ft, s, args);
      const w = use === null ? null : asyFnValDefWrap(L, n, nm, ft, s, use);
      if (w !== null) return asyWrapValCall(L, n, nm, w, s, args, callee, use);
      return L.nope(n, `通过函数值调 '${nm}' 时省了实参（它是 ${ft}，要 ${s.params.length} 个，`
        + `给了 ${args.length} 个 —— asy 的默认值是被调方填的，这一刀的默认值是调用处填的）`);
    }
    const want = isVar ? `至少 ${rAt}` : `${s.params.length}`;
    return L.err(n, `'${nm}' 是 ${ft}，要 ${want} 个实参，给了 ${args.length} 个`);
  }
  // 命名实参走**函数类型上的形参名**（第七十六刀）：asy 的函数类型是带形参名的
  // （`typedef void ticks3(…, bool opposite=false, bool primary=true, projection P);`，
  // graph3.asy:69），所以通过一个值调也能写 `opposite=true` —— grid3.asy:205 那一句
  // （elevation / projectelevation / smoothelevation 三个例子停在这里）。落法是先按名字
  // 排一遍（asyFnValFit 那一份，一格都不缺时才算），排不出来照旧报"函数值没有形参名"。
  let hasKey = false;
  for (const a of args) if (a.key !== null && a.key !== undefined) hasKey = true;
  if (hasKey && !isVar) {
    const use = asyFnValFit(L, ft, s, args);
    let full = use !== null;
    if (use !== null) for (let k = 0; k < s.params.length; k++) if (use[k] < 0) full = false;
    if (full) {
      const sorted = [];
      for (let k = 0; k < s.params.length; k++) {
        const a = args[use[k]];
        sorted.push({ key: null, node: a.node, spread: a.spread, v: a.v, lines: a.lines });
      }
      // 就地换（`args` 是个 const 绑定，而这一档里给了几个正好等于形参个数）
      for (let k = 0; k < sorted.length; k++) args[k] = sorted[k];
    }
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
        // `... a`：整份数组接到包后面。类型不一样时走一遍 coerce —— **数组级**的
        // `operator cast` 就在那条路上（`join(...z[segment[i]])`，graph.asy:2063 里
        // z 是 pair[]，而 interpolate 那一格要的是 path[]）。元素级的提升不在这里做：
        // asy 那边也是靠 arrayToArray 那一族的 cast，没有那一份就是不匹配。
        const sv = L.coerce(args[i].v, restTy, args[i].node, `'${nm}' 的展开实参`);
        if (sv === null) return null;
        packed.push({ code: sv.code, spread: true });
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
  // 有几个实参是**靠被遮住的那一格**接上的（shadowVar / shadowFns / shadowName）。
  // asy 的名字解析先看最里那一层，被遮住的那一格只是退路，所以这一档要在 cost
  // **之前**比（第六十四刀）：`path[] p` 形参被局部 `path p` 遮住时，`size(p)` 的
  // `int size(path)`（自己的类型，shadow 0）要赢 `int size(path[])`（走 shadowVar，
  // shadow 1）—— 两边 cost 都是 0，不分档就报歧义（bezulate.asy:64 量出来的）。
  let shadow = 0;
  // tryAt 最后那一次是不是走了遮挡那条路（下面接受 uc 时读它）
  let shAt = false;
  // 可变形参（`... T[] xs`）：最后那一格收所有多出来的位置实参。量过两条 ——
  // 任何**非**可变的候选都比可变的合适（`f(real)` 与 `f(... int[])` 撞上 `f(3)` 走前者，
  // 尽管那边还要一次 int->real 提升），所以贵不贵不能靠 cost，要另开一档在 applyCall
  // 里先比（varargs）。
  const rAt = cand.ps.length - 1;
  const isVar = cand.ps.length > 0 && cand.ps[rAt].rest === true;
  const elem = isVar ? asyElem(cand.ps[rAt].type) : null;
  const pack = [];
  // `cycle` 的第二条身份（第五十刀；coerce 那边有同名的一段）：这一层的 `cycle` 就是一格
  // path，而 asy 那边它的类型是 `cycleToken`。槽按 path 接不住时，按 cycleToken 再问一次
  // 用户转换 —— 代价跟别的转换一样是 1。
  const cycCost = (r, want) => (
    r.v.cyc === true && L.castFor(want, 'cycleToken', false) !== null ? 1 : -1
  );
  // 进可变那一格的包要花多少（回 -1 = 这个候选接不住）。`... a` 是**整份**接进去，所以拿
  // 那一格的**数组类型**去问用户的 `operator cast`（asy 那边是 arrayToArray 那一族：
  // `operator cast(A)->B` 有，`B[] operator cast(A[])` 就跟着有）。量过：
  // `operator --(... pair[])` 接得住（pair->guide 有 cast，bsp.asy:138）。
  // 从前这里写的是"类型得一模一样"，那一句把 bsp.asy:138 拦了。
  // **只问 cast、不问内建提升**：`int[] -> real[]` 那种元素级提升 asy 收（量过
  // `total(... int[])` 落在 `real total(... real[])` 上是 6），但这一层的 coerce 还不会
  // 逐格提升一个数组 —— 认下来只会在核心方言那边炸（`arr<real> 的初值是 arr<int>`）。
  // 所以那一档照旧不接，等哪一刀把数组的元素级提升做进 coerce。
  // 散着写的降到元素型，一次转换算 1。
  const packCost = (r) => {
    if (r.v.over !== undefined) return -1;   // 重载集当可变实参：另一刀
    if (r.spread === true) {
      const at = cand.ps[rAt].type;
      if (r.v.type === at) return 0;
      return L.castFor(at, r.v.type, false) !== null ? 1 : -1;
    }
    const ec = asyConvCost(r.v.type, elem);
    if (ec >= 0) return ec;
    if (L.castFor(elem, r.v.type, false) !== null) return 1;
    return cycCost(r, elem);
  };
  // 一格一格试：接得住回代价（0 或 1），接不住回 null。
  // "接不住能不能跳过这一格"由外面那个循环定（asy 的 matchArgument）。
  const tryAt = (r, at) => {
    shAt = false;
    // 走了遮挡那条路、**而且**接的不是这个值自己的类型 —— 只有这一种才算"用了被遮住的
    // 那一格"。shadowName 是 nameOf 给**每一个**文件级变量都挂的（同名的可能有好几格），
    // 同型时它指的就是这个值自己，不能算。量过：`dot(a,b)` 两个 triple 都是文件级变量，
    // 少了这一条时内建那份 shadow=2、`void dot(…, triple, light, …)` shadow=1，
    // 代价 1 的那份反而赢了（graph3.asy:84）。
    const shHit = () => { if (cand.ps[at].type !== r.v.type) shAt = true; return 0; };
    // `T keyword x` 的槽**只能按名字给**（量过：`void f(int keyword a); f(3)` 那边报
    // "cannot call 'void f(int keyword a)' with parameter 'int'"）。
    if (r.key === null && cand.ps[at].kw === true) return null;
    // 重载集当值用（callArgs 先不定案的那种）：按**这个槽要的类型**挑一份。
    // 挑到就是同型（cost 不加），挑不到这个槽就接不住。
    if (r.v.over !== undefined) {
      for (const c of r.v.over) if (L.candFnType(c) === cand.ps[at].type) return 0;
      return null;
    }
    // 同名的**变量遮住了函数名**，而这个槽要的是函数类型（第六十三刀）：候选是 nameOf
    // 挂上来的（shadowFns），落地是 coerce 那边同一条。挑到就算精确匹配（不加代价）；
    // 挑不到不算接不住 —— 这个实参还是那个变量，往下按它的类型算。
    if (r.v.shadowFns !== undefined && asyIsFn(cand.ps[at].type)) {
      for (const c of r.v.shadowFns) if (L.candFnType(c) === cand.ps[at].type) return shHit();
    }
    // 同名的**模块级那一格**（shadowVar，见 nameOf）：同型就算精确匹配
    if (r.v.shadowVar !== undefined && r.v.shadowVar.type === cand.ps[at].type) return shHit();
    // 同一个名字的文件级变量有**好几格**（shadowName，见 nameOf）：按这个槽的类型
    // 问一句 gvarFor，挑到就算精确匹配（`Hermite(Spline)`，graph.asy:1917）
    if (r.v.shadowName !== undefined && L.gvarFor(r.v.shadowName, cand.ps[at].type) !== null) return shHit();
    // `null` 当实参：类型来自**这个槽**（asy 就是这么定的）。槽不是引用类型就接不住。
    if (r.v.type === ASY_NULL) return asyRefTy(L, cand.ps[at].type) ? 0 : null;
    // `explicit` 的槽只收类型一模一样的实参（第二十六刀，量过：连 int->real 都挡）
    if (cand.ps[at].exp === true && r.v.type !== cand.ps[at].type) return null;
    const c = asyConvCost(r.v.type, cand.ps[at].type);
    // 用户的 `operator cast`（第二十七刀）：代价**跟内建提升一样**是 1 —— 量过打平时
    // asy 报 "is ambiguous"，所以这里不能给它一个更贵的分数偷偷分出胜负。
    const uc = c < 0 && L.castFor(cand.ps[at].type, r.v.type, false) !== null ? 1 : c;
    if (uc >= 0) return uc;
    const cy = cycCost(r, cand.ps[at].type);
    return cy < 0 ? null : cy;
  };
  for (const r of raw) {
    let at = -1;
    if (r.key === null) {
      while (filled.has(pos)) pos++;
      at = pos;
    } else {
      for (let k = 0; k < cand.ps.length; k++) if (cand.ps[k].name === r.key) at = k;
      // 可变那一格不能用名字给（asy 那边 `xs=` 也不认它，量过报 no matching function）
      if (isVar && at === rAt) return null;
    }
    // 位置实参落到可变那一格上（或更后面）：进那个包，不占槽。
    // `... a` 无论写在第几个都是给可变那一格的（量过 `int f(int a=1, int b=2 ... int[] xs)`
    // 上 `f(... new int[]{5,6})` 印 131 —— a、b 走默认值；`f(... a, 7)` 那边是**语法错**
    // "unnamed argument after rest argument"，所以 spread 之后不会再有位置实参）。
    if (isVar && r.key === null && (at >= rAt || r.spread === true)) {
      const pc = packCost(r);
      if (pc < 0) return null;
      cost += pc;
      pack.push(slot.length);
      slot.push(-1);
      pos = at >= rAt ? at + 1 : rAt;
      continue;
    }
    if (r.spread === true) return null;   // `... x` 只能落在可变那一格上
    if (at < 0 || at >= cand.ps.length || filled.has(at)) return null;
    let uc = tryAt(r, at);
    // asy 的 matchArgument（application.cc:205 + matchDefault :154）：这一格接不住、
    // 而它**有默认值**时，就把默认值填上、换下一格再试 —— 所以中间那些带默认值的形参
    // 可以整格跳过去。量过 `int f(int a, int b=7, string c, string d)` 收得下
    // `f(1,"xy","z")`（印 11）；base 里 plain_picture.asy:725 的
    // `fit(t,min(t),max(t))` 走的正是这一条（`transform T0=T` 那一格被跳过）。
    if (r.key === null) {
      let intoPack = false;
      while (uc === null && cand.ps[at].def !== null) {
        filled.set(at, 'def');
        at++;
        while (filled.has(at)) at++;
        if (at >= cand.ps.length) break;
        // 跳过来正好落在可变那一格上：进包。量过 `int g(int a=1, string s="z" ... int[] xs)`
        // 上 `g(9,8)` 印 17（a=9、s 走默认值、8 进包）；plain_prethree.asy:201 的
        // `operator init(diffuse,specular,background,(x,y,z))` 走的正是这一条。
        if (isVar && at >= rAt) {
          const pc = packCost(r);
          if (pc < 0) return null;
          cost += pc;
          pack.push(slot.length);
          slot.push(-1);
          intoPack = true;
          break;
        }
        uc = tryAt(r, at);
      }
      pos = at + 1;
      if (intoPack) continue;
    }
    if (uc === null) return null;
    cost += uc;
    if (shAt) shadow++;
    filled.set(at, true);
    slot.push(at);
    if (at < last) reordered = true;
    last = at;
  }
  const missing = [];
  for (let k = 0; k < cand.ps.length; k++) {
    if (filled.get(k) === true) continue;
    // 可变那一格永远算给了：没给就是一个空数组（量过 `total()` 印 0）
    if (isVar && k === rAt) continue;
    if (cand.ps[k].def === null) return null;
    missing.push(k);
  }
  return { cost, shadow, slot, missing, reordered, varargs: isVar, pack, restAt: isVar ? rAt : -1 };
}

/**
 * 为"缺了哪几个实参"这一种形状生成包装函数，回它的名字（同形状只生一份）。
 * 包装的形参就是给了的那几个（按形参顺序），体里逐个 `(let 缺的 T 默认值)` ——
 * 默认值因此在**被调方的作用域**里求：能看见前面的形参，也只在没给时才求。
 */
export function asyDefWrapper(L, n, nm, d, f, reinit) {
  const ri = reinit === true;
  const key = `${d.sym}|${f.missing.join(',')}${ri ? '|re' : ''}`;
  const had = L.wrapNames.get(key);
  if (had !== undefined) return had;
  // 名字里只留标识符能用的那几个字符：`operator init` 这种带空格的名字也从这里过
  let safe = '';
  for (let i = 0; i < nm.length; i++) {
    const c = nm.charAt(i);
    safe += (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
      || (c >= '0' && c <= '9') || c === '_' ? c : '_';
  }
  const wname = `asy__def${L.wrapNames.size}_${safe}`;
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
  const isCtor = d.ctor === true && !ri;
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
    // 形参的默认值也能是**花括号数组初值**（graph.asy:2146 的 `real[] dmx={}`、
    // `bool[] cond={}`）。`{…}` 自己没有类型，所以跟 `T[] a = {…}` 一样按形参那一格的
    // 类型降 —— 不走这一条时 asyExpr 只会说"推不出元素类型"。
    const lit = asyIsArr(p.type) && isList(p.def) && head(p.def).startsWith('arrayinit')
      ? L.arrLit(p.def, p.type) : null;
    const v = lit !== null ? lit
      : L.coerce(L.expr(p.def), p.type, p.def, `'${nm}' 的形参 '${p.name}' 的默认值`);
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
  } else if (ri) {
    // struct 体里那句 `operator init(…)`：对象已经在手，`this` 是形参，调正文、回 void
    lines.push(`(expr (call ${d.sym}_body ${args.join(' ')}))`);
  } else {
    lines.push(d.ret === 'void'
      ? `(expr (call ${d.sym} ${args.join(' ')}))`
      : `(ret (call ${d.sym} ${args.join(' ')}))`);
  }
  const params = [];
  if (rec !== null && !isCtor) params.push(`(this ${asyCore(rec.name)})`);
  for (const i of gave) params.push(`(${d.ps[i].name} ${asyCore(d.ps[i].type)})`);
  const text = [`  (fn ${wname} (${params.join(' ')}) ${asyCore(ri ? 'void' : d.ret)}`];
  for (const s of lines) text.push(`    ${s}`);
  L.pre = savePre;
  L.updates = saveUpd;
  L.scopes = saveScopes;
  L.at = saveAt;
  L.self = saveSelf;
  L.recAlias = saveAl;
  if (saveUnit !== null) L.unitOut(saveUnit);
  // 造不出来时**把名字撤回**：wrapNames 是在造之前就登记的，留着的话后面同一份 key 会
  // 命中缓存、拿到一个从没发出去的名字。量到的样子是 graph 里
  // `未声明的函数 'asy__def37_errorbars'` —— 第一次是在一次会回滚的试降里失败的。
  if (bad) { L.wrapNames.delete(key); return null; }
  L.wraps.push(`${text.join('\n')})`);
  return wname;
}

/**
 * 函数**类型**上带默认值时的那份包装（见 asyFnTypeOf 的 fnDefs）。回包装的名字，
 * 造不出来（没有记默认值、后面那几格里有一格没有默认值、默认值降不下来）就回 null。
 *
 * 包装的形参是「那个函数值」加「给了的那几格」；体里按**声明处**的位置与单元求默认值，
 * 名字用声明里那几个 —— `frame src=dest` 这种"默认值引用前面那一格"于是照样通。
 *
 * **与 asy 的差别写在明处**：asy 补的是**被调那个函数自己**那一份默认值（调用处压一个
 * "用默认值"的记号，被调方 pushDefault 换成真值），我们补的是**类型**上那一份。量过：
 *   `using env=int(int a, int b=a+1, int c=10); int use(env e){return e(3);}`
 *   `int f(int a, int b=0, int c=0){return a*100+b*10+c;}` -> asy 印 300，我们印 350。
 * base 里这两份是一致的（`using envelope=path(frame dest, frame src=dest, …)` 与
 * plain_boxes 里那几个 `path box(frame dest, frame src=dest, …)` 抄的是同一串），
 * 所以这一刀先按类型那一份补；要一样得给带默认值的函数另开一个"认记号"的入口。
 */
function asyFnValDefWrap(L, n, nm, ft, s, use) {
  const info = L.fnDefs.get(ft);
  if (info === undefined) return null;
  const key = `fv|${ft}|${use.join(',')}`;
  const had = L.wrapNames.get(key);
  if (had !== undefined) return had;
  const wname = `asy__fvd${L.wrapNames.size}`;
  L.wrapNames.set(key, wname);
  const names = [];
  for (let i = 0; i < s.params.length; i++) {
    const p = info.ps[i];
    names.push(p !== undefined && p.name !== null ? p.name : `asy__fp${i}`);
  }
  const savePre = L.pre;
  const saveUpd = L.updates;
  const saveScopes = L.scopes;
  const saveAt = L.at;
  const saveSelf = L.self;
  const saveAl = L.recAlias;
  const saveUnit = info.unit === L.unit.id ? null : L.unitIn(L.units[info.unit]);
  L.at = info.at;
  L.scopes = [new Map()];
  L.self = null;
  L.recAlias = null;
  L.updates = [];
  const lines = [];
  L.pre = lines;
  let bad = false;
  // 给了的那几格是包装的形参（默认值里引用得到它们）；省了的那几格按**槽的顺序**求，
  // 于是 `frame src=dest` 这种"引用前面那一格"照样通。
  for (let i = 0; i < s.params.length; i++) {
    if (use[i] >= 0) L.declare(n, names[i], s.params[i]);
  }
  for (let i = 0; i < s.params.length; i++) {
    if (use[i] >= 0) continue;
    const d = info.ps[i].def;
    const v = L.coerce(L.expr(d), s.params[i], d, `'${nm}' 的第 ${i + 1} 格的默认值`);
    if (v === null) { bad = true; break; }
    lines.push(`(let ${names[i]} ${asyCore(s.params[i])} ${v.code})`);
    L.declare(n, names[i], s.params[i]);
  }
  const call = ['(callfn (var asy__fvf)'];
  for (const x of names) call.push(`(var ${x})`);
  const inner = `${call.join(' ')})`;
  lines.push(s.ret === 'void' ? `(expr ${inner})` : `(ret ${inner})`);
  const params = [`(asy__fvf ${asyCore(ft)})`];
  for (let i = 0; i < s.params.length; i++) {
    if (use[i] >= 0) params.push(`(${names[i]} ${asyCore(s.params[i])})`);
  }
  const text = [`  (fn ${wname} (${params.join(' ')}) ${asyCore(s.ret)}`];
  for (const x of lines) text.push(`    ${x}`);
  L.pre = savePre;
  L.updates = saveUpd;
  L.scopes = saveScopes;
  L.at = saveAt;
  L.self = saveSelf;
  L.recAlias = saveAl;
  if (saveUnit !== null) L.unitOut(saveUnit);
  if (bad) { L.wrapNames.delete(key); return null; }
  L.wraps.push(`${text.join('\n')})`);
  return wname;
}

/**
 * 少给了实参时**哪几格用默认值**：从左往右走，实参的类型接得住这一格就占它，接不住
 * 而这一格有默认值就跳过（`e(F.f,xmargin,…)`，plain_boxes.asy:88 —— 中间那格
 * `frame src=dest` 是这么跳掉的）。实参没用完就是接不上，回 null。
 */
function asyFnValFit(L, ft, s, args) {
  const info = L.fnDefs.get(ft);
  if (info === undefined) return null;
  const use = [];
  for (let i = 0; i < s.params.length; i++) use.push(-1);
  // 命名实参（第七十三刀）：函数**类型**上记了形参名（fnDefs 的 ps[i].name），所以
  // `arrowhead.head(g,L,q,size,angle,filltype,forwards=true,P)`（three_arrows.asy:397）
  // 这种写法照 asy 那样按名字落格。名字过一遍 asyFldSym（表里存的就是这一形）。
  const keyed = [];
  for (let ai = 0; ai < args.length; ai++) {
    const k = args[ai].key;
    if (k === null || k === undefined) continue;
    const want = asyFldSym(k);
    let at = -1;
    for (let i = 0; i < s.params.length; i++) {
      const p = info.ps[i];
      if (p !== undefined && p.name === want) at = i;
    }
    if (at < 0 || use[at] >= 0) return null;
    use[at] = ai;
    keyed.push(ai);
  }
  let ai = 0;
  const nextPos = () => {
    while (ai < args.length && (args[ai].key !== null && args[ai].key !== undefined)) ai++;
    return ai;
  };
  let filled = keyed.length;
  for (let i = 0; i < s.params.length; i++) {
    if (use[i] >= 0) continue;
    const p = info.ps[i];
    const hasDef = p !== undefined && p.def !== null && p.name !== null;
    if (nextPos() >= args.length) {
      if (!hasDef) return null;
      continue;
    }
    const av = args[ai].v;
    let ok = false;
    if (av !== undefined && av.type !== undefined) {
      if (av.over !== undefined || av.mover !== undefined) ok = asyIsFn(s.params[i]);
      // 用户的 `operator cast` 也算接得住（第七十三刀）：少了这一条，`draw(f,g,currentpen)`
      // 里的 `pen -> material` 不算，那一格于是被当成"省了、用默认值"，后面的实参
      // 顺着往下挪一格（量出来的样子是最后一格拿到了第二个实参）。
      else {
        ok = asyConvCost(av.type, s.params[i]) >= 0
          || L.castFor(s.params[i], av.type, false) !== null
          || (av.cyc === true && L.castFor(s.params[i], 'cycleToken', false) !== null);
      }
    }
    if (ok || !hasDef) { use[i] = ai; ai++; filled++; continue; }
  }
  nextPos();
  return filled === args.length && ai >= args.length ? use : null;
}

/** 上面那份包装的调用：被调那个值当第一个实参，给了的那几格照签名 coerce */
function asyWrapValCall(L, n, nm, wname, s, args, callee, use) {
  let code = `(call ${wname} ${callee}`;
  for (let i = 0; i < s.params.length; i++) {
    if (use[i] < 0) continue;
    const a = args[use[i]];
    if (a.spread === true) return L.nope(a.node, '带默认值的函数值上的展开实参');
    if (a.lines !== null) for (const l of a.lines) L.pre.push(l);
    const v = L.coerce(a.v, s.params[i], a.node, `'${nm}' 的第 ${i + 1} 个实参`);
    if (v === null) return null;
    code = `${code} ${v.code}`;
  }
  return { code: `${code})`, type: s.ret };
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
