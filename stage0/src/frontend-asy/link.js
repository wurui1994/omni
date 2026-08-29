/**
 * 一份程序拆成**每个源文件一份产物**（第七十五刀）。
 *
 * 输入是 lower.js 攒好的分段（`AsyLower.sections`）：每个单元自己的类/全局/函数/包装，
 * 加一桶"谁都可能生、名字只由内容决定"的 weak（HELPERS、数组工厂、cyclic 登记处、
 * 内建数学包装、隐式构造）。这里把它们拼成**一份份独立的核心方言模块**：
 *
 *   - 每个单元一份：自己的定义照原样发，用到的别人家的名字发成 `(sig "出处" (…))`。
 *   - weak 一份（`omni_weak`）：按程序生成，库那几份从它这里引。
 *   - 入口那一份带 `(main …)`。
 *
 * 「谁定义了这个名字」是从**发出去的文本自己**读出来的，不是另记一张表：每一条顶层项的
 * 第一行就是它的签名（`  (fn NAME (形参) 返回类型` / `  (global NAME 类型)` / `  (class …)`），
 * 所以签名不可能与定义不一致 —— 那是这一层唯一会悄悄出错的地方，用同一份文本就没这问题。
 */

/**
 * 一段项文本里的**每一条顶层形式**：`{head, name, sig}`。
 *
 * 为什么不是"一段一条"：有些地方一次攒的是**两条**（构造函数那一族是
 * `(fn X_body …)` 加 `(fn X …)` 一起进 wraps 的）。只认第一条的话后面那条就没人登记，
 * 引它的那份产物于是发不出签名 —— 量出来的样子是 `未声明的函数 'asy__ctor_scaleT'`。
 *
 * 一条形式的**签名**是它自己的第一行，缺几个右括号补几个（按那一行的括号深度算）。
 * 签名与定义用的是同一份文本，所以两者不可能不一致。
 */
function formsOf(text) {
  const out = [];
  const lines = text.split('\n');
  let d = 0;
  for (const ln of lines) {
    if (d === 0) {
      const m = /^\s*\((fn|cfn|class|struct|global|kernel)\s+([A-Za-z_$][\w$]*)/.exec(ln);
      if (m !== null) {
        let k = 0;
        for (const c of ln) {
          if (c === '(') k++;
          else if (c === ')') k--;
        }
        out.push({
          head: m[1], name: m[2],
          sig: k <= 0 ? ln.trim() : ln.trim() + ')'.repeat(k),
        });
      }
    }
    for (const c of ln) {
      if (c === '(') d++;
      else if (c === ')') d--;
    }
  }
  return out;
}

/** 文本里出现的所有标识符。多算几个没关系（多发一条签名而已），少算就会漏定义。 */
function refsOf(text, out) {
  const re = /[A-Za-z_$][\w$]*/g;
  let m = re.exec(text);
  while (m !== null) {
    out.add(m[0]);
    m = re.exec(text);
  }
  return out;
}

const WEAK = 'omni_weak';

/**
 * @param {{ids: number[], secs: Map<number, any>, weak: string[],
 *   keys: Map<number, {key: string, init: string|null, ran: string|null}>,
 *   main: string[]}} sections lower.js 攒的分段
 * @param {(key: string) => string} nameOf 单元的 key（源文件路径）-> 产物名（不带后缀）
 * @param {string} [tail] 入口 `(main …)` 最后要补的那一句（跑退出钩子）
 * @returns {{units: {id: number, key: string, name: string, text: string, deps: string[]}[]}}
 */
export function asyUnitModules(sections, nameOf, tail) {
  // ---- 一、谁定义了什么 ----
  // **两个名字空间**：类型（class/struct）与值（fn/cfn/global/kernel）。asy 里两边**同名是常事**
  // —— 一个 struct 的构造函数就叫 struct 自己的名字（`asy__m8a0a8a29_Iter_T` 既是类
  // 又是造它的那个函数）。合在一张表里后者会盖掉前者，那一格类于是没有字段，接着刷
  // 几百条"类 X 没有字段 Y"（量出来的）。
  const tdef = new Map();      // 类型名 -> {mod, sig}
  const vdef = new Map();      // 值名   -> {mod, sig}
  const items = new Map();     // 产物名 -> 这一份的顶层项文本
  const put = (mod, text) => {
    let list = items.get(mod);
    if (list === undefined) { list = []; items.set(mod, list); }
    list.push(text);
    for (const f of formsOf(text)) {
      const where = f.head === 'class' || f.head === 'struct' ? tdef : vdef;
      where.set(f.name, { mod: mod, sig: f.sig });
    }
  };
  // **这一趟没降正文的那几份**（产物还在盘上，见 lower.js 的 skipBody）：只把
  // 「它定义了哪些名字、签名长什么样」登记进来 —— 别人引它时要发的就是这个。
  // 它自己不进 items，所以这一趟不会重新拼它那份模块文本，那份 `.sx`/`.js` 原样留着。
  const reused = [];
  const extraWeak = [];
  const modOf = new Map();     // 单元号 -> 产物名
  for (const id of sections.ids) modOf.set(id, nameOf(sections.keys.get(id)));
  const entryMod = modOf.get(0);
  // 这一趟自己有的那些产物名（正文降了的，加上正文没降但仍是本趟单元的）
  const own = new Set(modOf.values());
  const skipName = new Map();
  for (const id of (sections.skipped ?? new Map()).keys()) {
    const nm = nameOf(sections.keys.get(id));
    skipName.set(id, nm);
    own.add(nm);
  }
  // 复用一份产物时，**它引到的那几份也得跟着进来**（`.dep` 里的 need）——
  // 它们可能压根没被这一趟的前端加载过：`plain_scaling.asy:204` 那句
  // `from simplex2 access problem;` 在**函数体里**，而 plain_bounds 的正文这一趟不降，
  // 于是 simplex2 这个单元根本不存在。cli.js 顺着 `.dep` 把这些"只剩产物"的模块
  // 也一并交进来（sections.extra），这里只管把它们的签名与 weak 项登记上。
  for (const x of sections.extra ?? []) {
    if (own.has(x.name)) continue;   // 本趟自己就有这一份
    for (const line of x.sigs) {
      for (const f of formsOf(line)) {
        const where = f.head === 'class' || f.head === 'struct' ? tdef : vdef;
        where.set(f.name, { mod: x.name, sig: f.sig });
      }
    }
    for (const t of x.weak) extraWeak.push(t);
    reused.push({ id: -1, name: x.name, key: x.key });
  }
  for (const [id, c] of sections.skipped ?? new Map()) {
    const k = sections.keys.get(id);
    const mod = skipName.get(id);
    for (const line of c.sigs) {
      for (const f of formsOf(line)) {
        const where = f.head === 'class' || f.head === 'struct' ? tdef : vdef;
        where.set(f.name, { mod: mod, sig: f.sig });
      }
    }
    reused.push({
      id: id, name: mod, key: k === undefined ? '' : k.file,
      imps: k === undefined || k.imps === undefined ? [] : k.imps,
    });
  }
  // weak 那一档按**名字**去重：同一个内容决定名字的项，盘上拿回来的那份与这一趟生的那份
  // 是同一段代码，留先来的那一份就行。
  const weakSeen = new Set();
  const weakItems = new Map();   // weak 项的名字 -> 它的正文（写 `.wk` 用）
  for (const t of [...extraWeak, ...sections.weak]) {
    const fs = formsOf(t);
    let all = fs.length > 0;
    for (const f of fs) {
      if (!weakSeen.has(`${f.head === 'class' || f.head === 'struct' ? 't' : 'v'}|${f.name}`)) all = false;
    }
    if (all) continue;   // 每一条都已经有了：整段是重复的
    for (const f of fs) {
      weakSeen.add(`${f.head === 'class' || f.head === 'struct' ? 't' : 'v'}|${f.name}`);
      weakItems.set(f.name, t);
    }
    put(WEAK, t);
  }
  for (const id of sections.ids) {
    const mod = modOf.get(id);
    // 一个单元哪怕一条顶层项都没有（入口文件常常这样 —— 它的代码全在 `(main …)` 里）
    // 也要有自己那一份产物：main.js 引的就是它。
    if (!items.has(mod)) items.set(mod, []);
    const s = sections.secs.get(id);
    for (const x of s.cls) put(mod, x);
    for (const x of s.glb) put(mod, x);
    for (const x of s.fns) put(mod, x);
    for (const x of s.wraps) put(mod, x);
  }
  // ---- 一·五、只有入口才引的那些 weak 项，跟着入口走 ----
  // `omni_weak` 是**一份共用的可变文件**（名字必须固定：库那几份 `.js` 里写死
  // `from './omni_weak.js'`）。入口自己那几条包装（默认实参的 wrapper）也进了它，于是
  // **换个入口跑就把整份刷掉** —— 别的入口的清单跟着作废，前端满编重跑一趟。
  //
  // 量出来的样子：tri.asy 与 implicit.asy 依赖完全相同、各只有几行代码，交替跑**每趟**
  // 都是 0.9s（命中清单时 0.28s），日志上写着 `新编 1 份` —— 那 1 份就是 weak。两份
  // weak 差 728 字节（176963 vs 176235），差的正是各自那几条包装。把它们放回入口自己
  // 那一份产物里，共用的那一份就只由**库的集合**决定，交替跑互不相干。
  {
    const weakList = items.get(WEAK);
    if (weakList !== undefined && entryMod !== WEAK) {
      // 库那边要的 weak 项：复用回来的那些 `.wk`（本来就是库引的），加上这一趟正文
      // 降了的非入口单元里提到的
      const libWant = new Set();
      for (const t of extraWeak) for (const f of formsOf(t)) libWant.add(f.name);
      for (const t of sections.weakLib ?? []) for (const f of formsOf(t)) libWant.add(f.name);
      for (const [mod, list] of items) {
        if (mod === entryMod || mod === WEAK) continue;
        for (const r of refsOf(list.join('\n'), new Set())) if (weakItems.has(r)) libWant.add(r);
      }
      // 闭包到不动点：库要的 weak 项自己引的那些也算库要的
      const wave = [...libWant];
      while (wave.length > 0) {
        const t = weakItems.get(wave.pop());
        if (t === undefined) continue;
        for (const r of refsOf(t, new Set())) {
          if (weakItems.has(r) && !libWant.has(r)) { libWant.add(r); wave.push(r); }
        }
      }
      const keep = [];
      const moved = [];
      for (const t of weakList) {
        let mine = true;
        for (const f of formsOf(t)) if (libWant.has(f.name)) mine = false;
        (mine ? moved : keep).push(t);
      }
      if (moved.length > 0) {
        items.set(WEAK, keep);
        // put 顺带把 tdef/vdef 那两格改指到入口（别人引它时发的 `(sig …)` 才对得上）
        for (const t of moved) put(entryMod, t);
        // 挪进来的放**最前面**：它们里头有类，入口自己的项可能在初始化时就用到
        const el = items.get(entryMod);
        const cut = el.length - moved.length;
        items.set(entryMod, [...el.slice(cut), ...el.slice(0, cut)]);
      }
    }
  }
  // ---- 一·五、每一项生成物归谁（ADR-0015 决策 3；这一步只算与暴露，还没落成产物） ----
  // 规则：一项生成物是从**某条声明**推出来的，就归那条声明所在的单元。判据只看它的正文
  // 提到了谁 —— 提到的名字都由某一份定义，而"提到谁"是这一项自己的性质，与入口无关：
  //
  //   - 只看**库**那些名字里字典序最大的一份。任何用到这一项的程序都必须有它提到的
  //     全部单元，所以随便挑一个都是对的；挑"字典序最大"只是为了确定。
  //   - **入口不作候选**：refsOf 是往多了算的（形参名 `f`、`size` 都会被算成"提到了"），
  //     而入口的顶层名字是裸的，于是"提到入口"这一条会把同一项在 tri 下判给 tri、
  //     在 cardioid 下判给 cardioid（量出来 439 项里有 2 项、cardioid 那边 37 项）。
  //     真引到入口的名字会在链接那一层报"未声明"，看得见（ADR-0014 那一条）。
  //   - 什么库都没提到（HELPERS 那一档、标量数组工厂）-> 归运行时（`''`）。
  const ownerOfItem = (text) => {
    let best = '';
    for (const r of refsOf(text, new Set())) {
      for (const d of [tdef.get(r), vdef.get(r)]) {
        if (d === undefined || d.mod === WEAK || d.mod === entryMod) continue;
        if (d.mod > best) best = d.mod;
      }
    }
    return best;
  };
  const owners = new Map();   // 生成物名 -> 归属单元名（'' = 运行时）
  for (const [nm, t] of weakItems) owners.set(nm, ownerOfItem(t));
  // ---- 二、每一份的正文 + 它要引的签名 ----
  // 一份产物被复用时还得跟着进来的那几份：它自己引的（deps），加上它那些 weak 项引的。
  const needOf = (deps, wtext, mod) => {
    const need = new Set(deps);
    for (const t of wtext) {
      for (const r of refsOf(t, new Set())) {
        for (const d of [tdef.get(r), vdef.get(r)]) {
          if (d !== undefined) need.add(d.mod);
        }
      }
    }
    need.delete(WEAK);   // weak 那一份按程序生成，不是"盘上那一份"
    need.delete(entryMod);   // 入口那一份没人复用（上面那条"只有入口与 weak 能引它"）
    need.delete(mod);
    return [...need].sort();
  };
  const out = [];
  const keyOf = new Map();     // 产物名 -> 它那个源文件（weak 那份没有源文件）
  const ifaceOf = new Map();   // 产物名 -> 它的接口索引（`.aif`，见 iface.js）
  const impsOf = new Map();    // 产物名 -> 它 import 的那几个源文件（指纹用，ADR-0015）
  for (const id of sections.ids) {
    const k = sections.keys.get(id);
    if (k !== undefined) keyOf.set(modOf.get(id), k.file);
    if (k !== undefined && k.imps !== undefined) impsOf.set(modOf.get(id), k.imps);
    if (k !== undefined && k.iface !== undefined && k.iface !== null) {
      ifaceOf.set(modOf.get(id), k.iface);
    }
  }
  for (const [mod, list] of items) {
    const refs = new Set();
    for (const t of list) refsOf(t, refs);
    const isEntry = mod === modOf.get(0);
    if (isEntry) {
      for (const s of sections.main) refsOf(s, refs);
      // main 末尾那一句"跑退出钩子"也算引用（隐式 shipout 全靠它，漏了就报
      // `未声明的函数 'asy__…_asy__atexitrun'`）
      if (tail !== undefined && tail !== '') refsOf(tail, refs);
    }
    // **要闭包到不动点**：签名自己也提到别人（`(class autoscaleT (scale scaleT) …)` 里
    // 那个 scaleT 又是一个类），所以补进来的签名要再扫一遍。量出来的：不闭包的话
    // omni_weak 那一份里 autoscaleT / Map_K_V 的字段类型全认不出，接着刷几百条
    // "类 X 没有字段 Y"（字段填不进去，那一格类就是空的）。
    const sigs = [];
    const deps = new Set();
    const done = new Set();
    const wref = new Set();      // 这一份引到的 weak 项（写 `.wk` 用）
    let wave = [...refs];
    while (wave.length > 0) {
      const next = [];
      const push = (x) => { if (!done.has(x)) next.push(x); };
      for (const r of wave) {
        if (done.has(r)) continue;
        done.add(r);
        // 一个名字可能同时是类型与值（struct 与造它的那个函数），两边都要发
        for (const d of [tdef.get(r), vdef.get(r)]) {
          if (d === undefined || d.mod === mod) continue;
          // **入口那一份的名字只有入口自己与 weak 能引**：入口单元的前缀是空串，它的顶层
          // 名字是裸的（`cardioid.asy` 里的 `real f(real t)` 就叫 `f`），而 refsOf 是**往多了
          // 算**的（一个库里随便一个叫 f 的局部量都会被算成"引了它"）。库那一份要是因此
          // 发出 `(sig "cardioid" (fn f …))`，那份产物就跟着入口变了 —— 换个入口跑，
          // 它 import 的东西根本不在。真要引到而被拦掉的话，报的是"未声明"，看得见。
          if (d.mod === entryMod && mod !== entryMod && mod !== WEAK) continue;
          sigs.push(`  (sig "${d.mod}" ${d.sig})`);
          deps.add(d.mod);
          if (d.mod === WEAK) wref.add(r);
          refsOf(d.sig, { add: push });
        }
      }
      wave = next;
    }
    sigs.sort();
    // weak 项自己也可能引别的 weak 项（数组工厂里调 helper），所以要闭包到不动点 ——
    // `.wk` 少一条，下一趟把这一份复用起来时就是"未声明"。
    const wtext = [];
    {
      const seen = new Set();
      const stack = [...wref];
      while (stack.length > 0) {
        const nm = stack.pop();
        if (seen.has(nm)) continue;
        seen.add(nm);
        const t = weakItems.get(nm);
        if (t === undefined) continue;
        wtext.push(t);
        for (const r of refsOf(t, new Set())) if (weakItems.has(r) && !seen.has(r)) stack.push(r);
      }
      wtext.sort();
    }
    const body = [...sigs, ...list];
    if (isEntry) {
      const ms = [];
      for (const s of sections.main) ms.push(`    ${s}`);
      if (tail !== undefined && tail !== '') ms.push(`    ${tail}`);
      body.push(`  (main${ms.length === 0 ? '' : `\n${ms.join('\n')}`})`);
    } else {
      body.push('  (main)');
    }
    out.push({
      name: mod, text: `(module\n${body.join('\n')})\n`,
      // 这一份**逐条**的正文（ADR-0015 决策 1：增量的粒度是一条顶层项，不是一个文件）。
      // `text` 只是把它们拼起来，所以拼回去必须逐字节相同 —— cli.js 那边就是这么验的。
      parts: body,
      // 它那个源文件（weak 那份是 ''：它的内容由整个程序决定，没有对应的源文件）
      key: keyOf.get(mod) === undefined ? '' : keyOf.get(mod),
      deps: [...deps].sort(),
      // 这一份定义了哪些名字（`.sec`：下一趟不降它正文时，别人引它靠这张清单）
      sec: formsOf(list.join('\n')).map((f) => `  ${f.sig}`),
      // 这一份引到的 weak 项的正文（`.wk`：下一趟复用它时，这些项得有人生）
      weak: wtext,
      // 下一趟复用它时**还得把哪几份也带上**（`.dep`）：它自己引的那些，加上它那些
      // weak 项引的那些 —— 后者是 simplex2 那一类"只在别人正文里才会被加载"的模块。
      need: needOf(deps, wtext, mod),
      // 这一份的**接口索引**（`.aif`）：下一个例子引到它时，靠这张表认名字与签名，
      // 源码与树都不碰（见 iface.js）
      iface: ifaceOf.get(mod) === undefined ? null : ifaceOf.get(mod),
      // 它 import 的那几个源文件（**源侧**依赖图，指纹按它算 —— ADR-0015 决策 1）
      imps: impsOf.get(mod) === undefined ? [] : impsOf.get(mod),
    });
  }
  return {
    units: out, reused: reused, entry: modOf.get(0), weak: WEAK,
    // 每一项生成物算出来的归属（ADR-0015 决策 3 第二步：先只暴露，好验它与入口无关）
    owners: [...owners].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  };
}
