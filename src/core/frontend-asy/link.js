/**
 * 一份程序拆成**每个源文件一份产物**（第七十五刀）。
 *
 * 输入是 lower.js 攒好的分段（`AsyLower.sections`）：每个单元自己的类/全局/函数/包装，
 * 加一桶"谁都可能生、名字只由内容决定"的生成物（HELPERS、数组工厂、cyclic 登记处、
 * 内建数学包装、隐式构造）。这里把它们拼成**一份份独立的核心方言模块**：
 *
 *   - 每个单元一份：自己的定义照原样发，用到的别人家的名字发成 `(sig "出处" (…))`。
 *   - 每一项生成物**也是一份**（名字由内容定，见 genMod）：谁引它就发它的签名。
 *   - 入口那一份带 `(main …)`。
 *
 * 「谁定义了这个名字」是从**发出去的文本自己**读出来的，不是另记一张表：每一条顶层项的
 * 第一行就是它的签名（`  (fn NAME (形参) 返回类型` / `  (global NAME 类型)` / `  (class …)`），
 * 所以签名不可能与定义不一致 —— 那是这一层唯一会悄悄出错的地方，用同一份文本就没这问题。
 */

import { hash16 } from '../host/hash.js';

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

/**
 * 一项生成物的**单元名**。
 *
 * 生成物是"谁都可能生、名字只由内容决定"的那些项（HELPERS、数组工厂、cyclic 登记处、
 * `Map_K_V` 那一族实例）。从前它们全挤在一份 `omni_weak` 里 —— 那是**一份共用的可变文件**
 * （名字固定、内容按整个程序生成），于是换个入口跑就把它整片刷掉，别人的产物跟着作废。
 * 为了绕开它又长出三样东西：每份产物旁边一份 `.wk`（把它引到的项的正文抄一份）、
 * "只有入口才引的项跟着入口走"那一段、以及"这一项归谁"的推断规则。三样都是在给一份
 * 本不该存在的文件打补丁。
 *
 * **一项一份**之后：名字由内容定 -> 文件内容与程序无关 -> 谁都能复用、谁也盖不了谁，
 * 上面三样一起消失，引它的那份发的还是普通的 `(sig "<单元>" …)`。
 *
 * 名字里带一段原名的哈希：项名里有 `$` 这类字符，换成 `_` 之后两个不同的项可能撞名。
 */
function genMod(name) {
  return `g_${name.replace(/[^A-Za-z0-9_]/g, '_')}_${hash16(name).slice(0, 6)}`;
}

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
  // 复用一份产物时，**它引到的那几份也得跟着进来**（索引行里的 needs）——
  // 它们可能压根没被这一趟的前端加载过：`plain_scaling.asy:204` 那句
  // `from simplex2 access problem;` 在**函数体里**，而 plain_bounds 的正文这一趟不降，
  // 于是 simplex2 这个单元根本不存在。cli.js 顺着索引把这些"只剩产物"的模块
  // 也一并交进来（sections.extra），这里只管把它们的签名登记上。
  for (const x of sections.extra ?? []) {
    if (own.has(x.name)) continue;   // 本趟自己就有这一份
    for (const line of x.sigs) {
      for (const f of formsOf(line)) {
        const where = f.head === 'class' || f.head === 'struct' ? tdef : vdef;
        where.set(f.name, { mod: x.name, sig: f.sig });
      }
    }
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
  for (const id of sections.ids) {
    const mod = modOf.get(id);
    // 一个单元哪怕一条顶层项都没有（入口文件常常这样 —— 它的代码全在 `(main …)` 里）
    // 也要有自己那一份产物：启动器引的就是它。
    if (!items.has(mod)) items.set(mod, []);
    const s = sections.secs.get(id);
    for (const x of s.cls) put(mod, x);
    for (const x of s.glb) put(mod, x);
    for (const x of s.fns) put(mod, x);
    for (const x of s.wraps) put(mod, x);
  }
  // ---- 一·五、生成物：**一项一份**（见 genMod 那一段账） ----
  // 单元在前、生成物在后：要先知道入口定义了哪些名字，才判得出"这一项提到了入口"。
  //
  // 按名字去重：同一个内容决定名字的项，盘上拿回来的那份与这一趟生的那份是同一段代码，
  // 留先来的那一份就行。
  const genSeen = new Set();
  const kindOf = (f) => `${f.head === 'class' || f.head === 'struct' ? 't' : 'v'}|${f.name}`;
  const entryGen = [];
  for (const t of sections.weak) {
    const fs = formsOf(t);
    let all = fs.length > 0;
    for (const f of fs) if (!genSeen.has(kindOf(f))) all = false;
    if (all) continue;   // 每一条都已经有了：整段是重复的
    for (const f of fs) genSeen.add(kindOf(f));
    // **提到了入口的那几项归入口**：它们的内容跟着入口变（默认实参的包装就是这一类），
    // 不是"名字由内容定"的那种，所以不能自己成一份 —— 那样换个入口就互相盖。
    let toEntry = false;
    for (const r of refsOf(t, new Set())) {
      for (const d of [tdef.get(r), vdef.get(r)]) if (d !== undefined && d.mod === entryMod) toEntry = true;
    }
    if (toEntry) { entryGen.push(t); put(entryMod, t); continue; }
    put(genMod(fs[0].name), t);
  }
  // 归了入口的那几项放**最前面**：它们里头有类，入口自己的项可能在初始化时就用到
  if (entryGen.length > 0) {
    const el = items.get(entryMod);
    const cut = el.length - entryGen.length;
    items.set(entryMod, [...el.slice(cut), ...el.slice(0, cut)]);
  }
  // ---- 二、每一份的正文 + 它要引的签名 ----
  // 一份产物被复用时还得跟着进来的那几份：它自己引的那些（入口与自己除外）。
  const needOf = (deps, mod) => {
    const need = new Set(deps);
    need.delete(entryMod);   // 入口那一份没人复用（下面那条"入口的名字只有入口自己能引"）
    need.delete(mod);
    return [...need].sort();
  };
  const out = [];
  const keyOf = new Map();     // 产物名 -> 它那个源文件（weak 那份没有源文件）
  const ifaceOf = new Map();   // 产物名 -> 它的接口索引（`.aif`，见 iface.js）
  const impsOf = new Map();    // 产物名 -> 它 import 的那几个源文件（指纹用，ADR-0015）
  const incOf = new Map();     // 产物名 -> 它 `include` 摊进来的那几个文件（印记用，这一刀）
  for (const id of sections.ids) {
    const k = sections.keys.get(id);
    if (k !== undefined) keyOf.set(modOf.get(id), k.file);
    if (k !== undefined && k.imps !== undefined) impsOf.set(modOf.get(id), k.imps);
    if (k !== undefined && k.inc !== undefined) incOf.set(modOf.get(id), k.inc);
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
    // 生成物那几份里 autoscaleT / Map_K_V 的字段类型全认不出，接着刷几百条
    // "类 X 没有字段 Y"（字段填不进去，那一格类就是空的）。
    const sigs = [];
    const deps = new Set();
    const done = new Set();
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
          // **入口那一份的名字只有入口自己能引**：入口单元的前缀是空串，它的顶层
          // 名字是裸的（`cardioid.asy` 里的 `real f(real t)` 就叫 `f`），而 refsOf 是**往多了
          // 算**的（一个库里随便一个叫 f 的局部量都会被算成"引了它"）。库那一份要是因此
          // 发出 `(sig "cardioid" (fn f …))`，那份产物就跟着入口变了 —— 换个入口跑，
          // 它 import 的东西根本不在。真要引到而被拦掉的话，报的是"未声明"，看得见。
          if (d.mod === entryMod && mod !== entryMod) continue;
          sigs.push(`  (sig "${d.mod}" ${d.sig})`);
          deps.add(d.mod);
          refsOf(d.sig, { add: push });
        }
      }
      wave = next;
    }
    sigs.sort();
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
      // 它那个源文件（生成物那几份是 ''：它们的内容由自己的名字决定，没有对应的源文件）
      key: keyOf.get(mod) === undefined ? '' : keyOf.get(mod),
      // 它 `include` 摊进来的那几个文件：印记要它们（少一格就会复用旧代码，这一刀）
      inc: incOf.get(mod) === undefined ? [] : incOf.get(mod),
      deps: [...deps].sort(),
      // 这一份定义了哪些名字（接口：下一趟不降它正文时，别人引它靠这张清单）
      sec: formsOf(list.join('\n')).map((f) => `  ${f.sig}`),
      // 下一趟复用它时**还得把哪几份也带上**：它自己引的那些 —— 里头有 simplex2
      // 那一类"只在别人正文里才会被加载"的模块。
      need: needOf(deps, mod),
      // 这一份的**接口索引**（`.aif`）：下一个例子引到它时，靠这张表认名字与签名，
      // 源码与树都不碰（见 iface.js）
      iface: ifaceOf.get(mod) === undefined ? null : ifaceOf.get(mod),
      // 它 import 的那几个源文件（**源侧**依赖图，指纹按它算 —— ADR-0015 决策 1）
      imps: impsOf.get(mod) === undefined ? [] : impsOf.get(mod),
    });
  }
  return { units: out, reused: reused, entry: modOf.get(0) };
}
