import { OmniError } from './source/diag.js';

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
  if (t === undefined) {
    throw new OmniError(`目标 '${name}' 没装：装着的是 ${targetNames().join(' / ')}`);
  }
  return t;
}

/** 装着的目标都有哪些（`--help` 与诊断用同一份，不许各写一遍） */
export function targetNames() {
  const out = [];
  for (const [n] of TARGETS) out.push(n);
  return out;
}

/* ---- 语言（前端）：按扩展名认，谁装了谁**自己登记** ----
 *
 * 与目标那半张表的差别：前端的实现住在 cli.js 里（它们要用 cli 的一整套读盘 / 诊断 /
 * 缓存），所以这一层不 import 它们（会成环），改成"加载完自己来登记"。
 * 这正好是插件要的形状：`dlopen` 出来的那一格在 `omni_plugin_init` 里调 registerLang，
 * 与内建项走同一条路 —— 内建与外挂在这一层看不出区别，只是登记的时刻不同。
 */
const LANGS = new Map();

/** @param exts 扩展名（带点）@param name 语言名 @param compile (path, argv) -> { mod, ... } */
export function registerLang(exts, name, compile) {
  for (const e of exts) LANGS.set(e, { name, compile });
}

/** 这个路径归哪种语言；不归任何登记过的语言就交 null（调用方落到核心方言那一支） */
export function lang(path) {
  for (const [ext, l] of LANGS) {
    if (path.endsWith(ext)) return l;
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
  return null;
}

/** 装着的语言都有哪些 */
export function langNames() {
  const out = [];
  for (const [, l] of LANGS) if (!out.includes(l.name)) out.push(l.name);
  return out;
}
