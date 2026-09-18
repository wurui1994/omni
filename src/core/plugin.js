import { OmniError } from './source/diag.js';

/* ---- 迟装：**声明**了但还没装进来的那些（ADR-0023 的 S7）----
 *
 * 从前内建那几门语言是在开机时**全部**登记的，代价是"跑任何一条腿都等于装整个编译器"：
 * 每条测试轴的依赖并集因此是同一份 112 个模块，改一门语言的前端会让所有轴重跑
 * （量出来一趟 8 分钟，而其中绝大多数轴的输出一个字节没动）。
 *
 * 现在多一层：一格提供方可以只**声明**它能答什么（认哪些后缀、叫什么名字、有哪几格 cap），
 * 真被问到时才 `load()`。load 里走的还是下面那几个 `register*` —— 内建、迟装、插件三条路
 * 在注册表这一层看不出区别，只差登记的时刻。
 *
 * **声明与登记要对得上**：装完之后如果它并没有登记声称的那一格，当场响错（下面
 * `resolvePending` 的最后一句）。所以"后缀在两处各写一遍"不会悄悄走散 —— 走散就红。
 */
const PENDING = [];

/**
 * 声明一格还没装进来的提供方。
 * @param claim `{ name, exts?, runnerExts?, targets?, caps?, from? }`
 * @param load 真要用时叫一次（里头调 register*）
 */
export function declareProvider(claim, load) {
  PENDING.push({ claim, load, done: false });
}

/** 声明里"能答这一问"的那格提供方，装进来；装了就回 true（调用方重查一遍）。 */
function resolvePending(kind, key) {
  for (const p of PENDING) {
    if (p.done) continue;
    const list = p.claim[kind];
    if (list === undefined || list === null) continue;
    const hit = kind === 'exts' || kind === 'runnerExts'
      ? list.some((e) => key.endsWith(e)) : list.includes(key);
    if (!hit) continue;
    p.done = true;                    // 先记上：装一次就够，装完还没有就是它自己说错了
    p.load();
    return true;
  }
  return false;
}

/** 装完还是答不上 —— 那是声明与登记走散了，当场说清是哪一格。 */
function pendingMismatch(kind, key) {
  return new OmniError(`迟装那一格对不上：声明里说 ${kind} 有 '${key}'，`
    + '装进来之后注册表里却没有它（lang/builtin.js 的声明表与那门语言自己的 register* 走散了）');
}


/* ---- 目标（后端）：谁装了谁自己登记 ----
 *
 * 从前这儿是一张写死的表，四个后端都 import 进来 —— 那就是四条静态依赖，
 * "可选加载"无从谈起（链接期全被拽进来）。现在与语言那半张表同一形状：
 * 内建的由核心调一次 register，外挂的由 `dlopen` 之后 `omni_plugin_init` 调同一个。
 *
 * 每一项：`ir` 说它吃哪一层（oir / mir），`emit(ir, opts)` 交一段文本。
 */
const TARGETS = new Map();

/** @param name 目标名 @param ir 'oir' | 'mir' @param emit (ir, opts) -> 文本 */
export function registerTarget(name, ir, emit) {
  TARGETS.set(name, { ir: ir, emit: emit });
}

export function target(name) {
  const t = TARGETS.get(name);
  if (t !== undefined) return t;
  if (resolvePending('targets', name)) {
    const t2 = TARGETS.get(name);
    if (t2 === undefined) throw pendingMismatch('targets', name);
    return t2;
  }
  throw new OmniError(`目标 '${name}' 没装：装着的是 ${targetNames().join(' / ')}`);
}

/** 装着的目标都有哪些（`--help` 与诊断用同一份，不许各写一遍）。
 *  **声明了还没装**的也算 —— 装没装是这一层的实现细节，用户看见的是"有没有这门目标"。 */
export function targetNames() {
  const out = [];
  for (const [n] of TARGETS) out.push(n);
  for (const p of PENDING) {
    if (p.done || p.claim.targets === undefined) continue;
    for (const n of p.claim.targets) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/* ---- 语言（前端）：按扩展名认，谁装了谁**自己登记** ----
 *
 * 与目标那半张表的差别：前端的实现住在 cli.js 里（它们要用 cli 的一整套读盘 / 诊断 /
 * 缓存），所以这一层不 import 它们（会成环），改成"加载完自己来登记"。
 * 这正好是插件要的形状：`dlopen` 出来的那一格在 `omni_plugin_init` 里调 registerLang，
 * 与内建项走同一条路 —— 内建与外挂在这一层看不出区别，只是登记的时刻不同。
 */
const LANG_PROVIDERS = new Map();

/** @param exts 扩展名（带点）@param name 语言名 @param compile (path, argv) -> { mod, ... } */
export function registerLang(exts, name, compile) {
  for (const e of exts) LANG_PROVIDERS.set(e, { name, compile });
}

/* 目录里躺着、但**这条腿装不动**的那些（ADR-0021 的 S4）：名字先记下来，等真用到那门语言
   才响。一开机就抛的话，一格插件能把整个编译器噎住 —— 自举链的 `C2 = C1 emit-js` 当场
   抓到过：dist/plugins 里放一格插件，omni.mjs 一启动就抛，而它跟那门语言半点关系没有。 */
const UNLOADABLE = [];

/** @param name 语言名（从 `omni-lang-<名字>.<平台后缀>` 的文件名里取） */
export function noteUnloadable(name) {
  if (!UNLOADABLE.includes(name)) UNLOADABLE.push(name);
}

/** 这个路径的扩展名对上某个装不动的插件了吗；对上就交那门语言的名字，否则 null。
 *  约定：`omni-lang-asy` 认 `.asy` —— 扩展名就是语言名。 */
export function unloadableFor(path) {
  for (const n of UNLOADABLE) {
    if (path.endsWith(`.${n}`)) return n;
  }
  return null;
}

/** 这个路径归哪种语言；不归任何登记过的语言就交 null（调用方落到核心方言那一支） */
export function lang(path) {
  for (const [ext, l] of LANG_PROVIDERS) {
    if (path.endsWith(ext)) return l;
  }
  /* 声明了还没装的那些（迟装）：装进来再问一遍。这一步刻意在 UNLOADABLE 之前 ——
     内建的那门语言在就该用它，"装不动插件"是另一回事。 */
  if (resolvePending('exts', path)) {
    for (const [ext, l] of LANG_PROVIDERS) {
      if (path.endsWith(ext)) return l;
    }
    throw pendingMismatch('exts', path);
  }
  /* 没登记，但目录里躺着一格装不动的同名插件：**这时候**才响，而且说清是哪条腿的事。
     悄悄落到核心方言那一支去解析一份 .asy，只会报一堆语法错，真相却是"这条腿装不动插件"。 */
  const un = unloadableFor(path);
  if (un !== null) {
    throw new OmniError(`${un} 这门语言装着插件，但**这条腿**装不动它`
      + `（node / JS 腿没有 dlopen）—— 用 C 那条腿编出来的 omni 跑同一条命令`);
  }
  return null;
}

/**
 * 这个**名字**归哪门语言（ADR-0037 的 `#lang` 与 `--lang`）——`lang()` 是按扩展名问的，
 * 这一格是按语言名问的。两处同一张表，只是钥匙不同。
 *
 * 迟装那一格照顾到：声明里的 `name` 对上就装进来（不必在声明表上另加一栏 —— 加一栏就
 * 多一处会走散的地方，`resolvePending` 那段注释说的就是这件事）。
 * 装完还是没有就交 null，让调用方去印"装着的是哪些"。
 */
export function langByName(name) {
  for (const [, l] of LANG_PROVIDERS) {
    if (l.name === name) return l;
  }
  for (const p of PENDING) {
    if (p.done || p.claim.name !== name) continue;
    p.done = true;
    p.load();
    for (const [, l] of LANG_PROVIDERS) {
      if (l.name === name) return l;
    }
    throw new OmniError(`迟装那一格对不上：声明里说有 '${name}' 这门语言，`
      + '装进来之后注册表里却没有它（lang/builtin.js 的声明与那门语言的 registerLang 走散了）');
  }
  return null;
}

/* ---- 跑法（runner）：有些语言的"执行"根本不产 OIR ----
 *
 * `.frag` / `.glsl` 的"跑"是**渲一帧、写一张 PNG**（ADR-0019 决策九），它没有 OIR 这一层。
 * 所以注册表上另开一格：语言那半张表答"怎么变成 OIR"，这半张答"怎么跑"。
 * 混在一张表里就得在 compile 的返回值上编个"其实没有 mod"的特例，那是把两件事拧在一起。
 */
const RUNNERS = new Map();

/** @param exts 扩展名（带点）@param name 语言名 @param run (path, argv) -> 退出码 */
export function registerRunner(exts, name, run) {
  for (const e of exts) RUNNERS.set(e, { name, run });
}

/** 这个路径有没有自己的跑法；没有就交 null（调用方走"编出来再跑"那条常规路） */
export function runner(path) {
  for (const [ext, r] of RUNNERS) {
    if (path.endsWith(ext)) return r;
  }
  if (resolvePending('runnerExts', path)) {
    for (const [ext, r] of RUNNERS) {
      if (path.endsWith(ext)) return r;
    }
    throw pendingMismatch('runnerExts', path);
  }
  return null;
}

/* ---- 能力（cap）：驱动要用某门语言的一格本事，按名字要，不许直接 import ----
 *
 * 量出来的（ADR-0021）：`--builtins min` 换掉 builtin.js 只省了 96 KB —— 因为驱动仍然
 * `import { cMir } from './lang/c.js'`、`import { asyText } from './lang/asy.js'`，
 * 摇树照样把那几门整条拽进来。只要还有一条直连，"核心不带这门语言"就是空话。
 *
 * 所以驱动那边全部改成按名字要：`cap('c.toMir')`。没装就**响着拒**（那门语言没装），
 * 而不是 undefined is not a function。
 */
const CAPS = new Map();

/** @param name 形如 `c.toMir` / `asy.toSx` @param fn 那一格本事 */
export function registerCap(name, fn) {
  CAPS.set(name, fn);
}

/** 有没有装这一格（驱动要先问再走另一条路时用，比如"没装 asy 就别去找 asy 的缓存"） */
export function hasCap(name) {
  if (CAPS.has(name)) return true;
  /* 声明里有就算"有" —— 但**不装**：这一问的用处正是"要不要走那条路"，为了答一句
     "有"就把整门语言装进来，迟装就白做了。真去用它时 cap() 会装。 */
  return PENDING.some((p) => !p.done && p.claim.caps !== undefined
    && p.claim.caps.includes(name));
}

/** 要这一格；没装就响着拒 —— 名字前半段就是那门语言/目标 */
export function cap(name) {
  const f = CAPS.get(name);
  if (f !== undefined) return f;
  if (resolvePending('caps', name)) {
    const f2 = CAPS.get(name);
    if (f2 === undefined) throw pendingMismatch('caps', name);
    return f2;
  }
  const dot = name.indexOf('.');
  const who = dot > 0 ? name.slice(0, dot) : name;
  throw new OmniError(`${who} 没装：这份 omni 里没有 '${name}' 这一格`
    + `（装一格 omni-lang-${who} 插件，或用带它的那份 omni）`);
}

/** 装着的语言都有哪些（声明了还没装的也算 —— 与 targetNames 同一条理由） */
export function langNames() {
  const out = [];
  for (const [, l] of LANG_PROVIDERS) if (!out.includes(l.name)) out.push(l.name);
  for (const p of PENDING) {
    if (p.done) continue;
    const isLang = p.claim.exts !== undefined || p.claim.runnerExts !== undefined;
    if (isLang && !out.includes(p.claim.name)) out.push(p.claim.name);
  }
  return out;
}
