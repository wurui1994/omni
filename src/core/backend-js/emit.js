// Omni stage0 — JS 后端：OIR -> ES2020
//
// 语义映射（这是永久兼容层，不能"差不多"，见 ADR-0005 / ADR-0006）：
//   int    = i64 -> **规范化的 number|BigInt**：|v| <= 2^53-1 用 number，否则 BigInt
//            （两个值域不重叠，所以规范形唯一，=== 与 Map 的键都还对；见 prelude 的文件头）
//            + - * 走 $iadd/$isub/$imul：两个 number 时一句浮点加 + 一次范围查，不碰 BigInt
//   real   = f64 -> number
//   string = UTF-8 字节序列 -> JS 字符串 + 字节视图（length/byteAt/substr 按字节）
//   struct = 值类型 -> 赋值/传参/返回都深拷贝
//   class  = 引用类型 -> 普通对象；字段访问带 null 检查（C 侧同样检查，避免段错误 vs 异常的分叉）
//   list/dict/set -> Array / Map / Set（Map 天然保持插入序）
//   dynamic -> JS 原生值（null/boolean/BigInt/number/string/Array/Map）；这一格里的 int
//              **一律 BigInt**（$dynTag 靠 typeof 分 int 与 real），装箱那条边界上转

import { JS_PRELUDE, JS_PROF_RT } from './prelude.js';
import { cffiGlue } from './cffi.js';
import { typeKey, loopLabelNeeds } from '../hir/types.js';
import { JS_ABI, JS_ALL, JS_MEMBERS } from '../hir/js_abi.js';
import { C_ABI } from '../hir/c_abi.js';

/** int 字面量：落在 2^53-1 之内的发普通数，越界的发 BigInt —— 与运行期的规范形同一条界。 */
const I_SAFE = 9007199254740991n;
function jsIntLit(v) {
  const b = BigInt(v);
  return (b <= I_SAFE && b >= -I_SAFE) ? b.toString() : `${b}n`;
}

/** 数组的元素存进去要不要先拷一份（$anew/$aset/$apush 的末位实参）。只有向量要 ——
 *  它是值语义，而 C 与 LLVM 两条腿存的是副本。类与**数组**元素是引用语义，拷了就分叉
 *  （多维数组那一刀量出来的：`a.push(row)` 拷一份之后，"两处是同一条"在五条腿上不一致）。 */
const jsElemCopy = (t) => (t.elem.k === 'vec' ? 'true' : 'false');

/**
 * **产物按这份程序用到的那几族裁**（与 C 腿同一个办法 —— `graph/backend-c.js` 的
 * `trimPrelude`。用户那句话的原文是「优化方法是统一的，我们做统一支持」）。
 *
 * 量到的账（`bench/fib.js`，823 字节源码）：
 *   序言          265308 字节 / 7459 行     —— 无条件全带
 *   两格派发器    `$js_call_op` 把 JS_ABI 里**每一格 op** 的名字都提到，
 *                 `$m_*` 那一族把每个成员方法都提到 —— 所以从前一格都摇不掉
 *   整份产物      371770 字节 = 源码的 **451x**
 * 而 fib.js 用到的只有算术、比较、`process.stdout.write` 那几格。
 *
 * 三条与 C 腿逐条对应的规矩：
 *   1. 文本切成一格格顶层定义。JS 这边**不数花括号**（序言里有正则与模板串，数不准）：
 *      判据是「第 0 列上以 function / const / let / class 起头的一行开一格新定义」——
 *      我们自己写的文本，顶层从第 0 列起、里头一律缩进。注释与空行跟着**下面**那格走。
 *   2. 名字认得出来的（`function $x(` / `const $x =`）才可能被裁；**认不出名字的一律留**
 *      （顶层那几句有副作用的语句：`$js_pm_set(...)`、`process.on(...)`）。
 *   3. 根是**程序自己那一段**里出现的 `$xxx`，然后按每格定义里引用到的名字传递地留。
 *
 * **什么时候一格都不敢裁**：`$js_src_eval` / `$js_src_fn` / `$js_call_op` 这三扇门后面，
 * 名字是**运行期**才到的（eval 进来的那段文本、按串查的那格 op）—— 静态看不见。
 * 程序里一旦提到它们仨，这一格整份让过（宁可胖，不许悄悄少一个名字）。
 */
export function trimJsRuntime(text, rootText) {
  /* 三扇运行期的门：提到任一格就不裁（理由见上面那段）。 */
  for (const door of ['$js_src_eval', '$js_src_fn', '$js_call_op']) {
    if (rootText.includes(door)) return text;
  }
  const isDefStart = (ln) => /^(function|const|let|class)\s/.test(ln);
  /**
   * 这一行把括号收平了吗（`{}` `[]` `()` 三种一起数）。用来判「这一格是不是一行写完的」——
   * **只看行末有没有分号是不够的**：序言里有一批函数是
   * `function $js_eq(strict, a, b) {  const ta = …;` 这种写法（头一句就跟在同一行上），
   * 行末真有分号，可花括号还开着。量到过漏这一步的后果：那格函数被从中间切开，
   * 产物 `SyntaxError: Unexpected end of input`（9 格中招）。
   */
  const delta = (ln) => {
    let d = 0;
    for (const ch of ln) {
      if (ch === '{' || ch === '[' || ch === '(') d += 1;
      else if (ch === '}' || ch === ']' || ch === ')') d -= 1;
    }
    return d;
  };
  const oneLiner = (ln) => /;\s*$/.test(ln) && delta(ln) === 0;
  const chunks = [];
  let cur = [];
  let inDef = false;
  /* `cur` 里有没有**代码**（不算注释与空行）—— 决定新定义起头时要不要先收上一格。 */
  let curCode = false;
  const close = () => {
    if (cur.length > 0) { chunks.push(cur.join('\n')); cur = []; }
    inDef = false;
    curCode = false;
  };
  for (const ln of text.split('\n')) {
    const col0 = ln.length > 0 && !/^[ \t]/.test(ln);
    const comment = /^\s*(\/\/|\/\*|\*)/.test(ln) || ln.trim() === '';
    if (col0 && isDefStart(ln)) {
      /**
       * **先收上一格**：判据是「攒着的东西里有代码」，不是「上一格是不是定义」。
       * 量到过按后者判的后果：`$js_pm_set([…\n]);` 那一大批裸语句（原型成员表）收不了尾
       * （`]);` 那一行括号不平），于是整批被并进**下一格**函数里 —— 那格函数一被裁，
       * 表就跟着消失。fib.js 上当场量到「表 false / 定义 false」。
       */
      if (curCode) close();
      inDef = true;
      cur.push(ln);
      curCode = true;
      /* 一行写完的（`const $x = …;`）当场收 —— 不然它会把后面的裸语句吞进来。 */
      if (oneLiner(ln)) close();
      continue;
    }
    cur.push(ln);
    if (!comment) curCode = true;
    if (!col0) continue;
    /* 顶层收尾那一行：`}` / `};` / `});` / `]);` —— 这一格定义到此结束。 */
    if (inDef && /^[)}\];]/.test(ln)) { close(); continue; }
    /**
     * **顶层的裸语句**（`$js_pm_set('String', 'replace', $js_str_replace, 2);` 那一大批：
     * `pmRowsText()` 生成的原型成员表）。它们必须**自己成一格**：粘在别格里的话，
     * 那格被裁掉时这一批跟着消失 —— 量到过，`tests/js-exec/cases/44-proto-member-values.js`
     * 当场变成一片 `undefined` 加一句 `cannot read property 'call' of undefined`。
     *
     * 收尾认两种：一行写完的（分号 + 括号平），以及**跨行调用的收尾行**（`]);` / `});`）。
     */
    if (!inDef && (oneLiner(ln) || /^[)}\]]+\s*;\s*$/.test(ln))) close();
  }
  if (cur.length > 0) chunks.push(cur.join('\n'));

  const ids = (s) => {
    const out = new Set();
    const m = s.match(/\$[A-Za-z_][A-Za-z0-9_]*/g);
    if (m !== null) for (const x of m) out.add(x);
    return out;
  };
  const defs = chunks.map((c) => {
    const m = c.match(/^(?:function|const|let|class)\s+(\$[A-Za-z0-9_]+)/m);
    const name = m === null ? null : m[1];
    /* 自己的名字不算依赖（不然每格都自证留下来）。 */
    const deps = ids(c);
    if (name !== null) deps.delete(name);
    return { text: c, name, deps };
  });
  const keep = new Set(ids(rootText));
  /**
   * **认不出名字的那几格也是根**：它们一律留（顶层有副作用的语句），所以它们**用到的**
   * 名字同样得留。量到过漏这一步的后果：`$js_pm_set([…])` 那一大批留下来了，可
   * `$js_pm_set` 自己被裁了 —— 一跑就是 `ReferenceError: $js_pm_set is not defined`。
   */
  for (const d of defs) {
    if (d.name !== null) continue;
    for (const x of d.deps) keep.add(x);
  }
  /* 传递闭包：留下来的定义里引用到的名字也要留。只加不减，最多转 defs.length 轮。 */
  for (let round = 0; round < defs.length + 1; round++) {
    let grew = false;
    for (const d of defs) {
      if (d.name === null || !keep.has(d.name)) continue;
      for (const dep of d.deps) {
        if (!keep.has(dep)) { keep.add(dep); grew = true; }
      }
    }
    if (!grew) break;
  }
  /* 认不出名字的那几格（顶层有副作用的语句）一律留 —— 与 C 腿的 `#include` 同一条。 */
  return defs.filter((d) => d.name === null || keep.has(d.name)).map((d) => d.text).join('\n');
}

// 指针（ADR-0016）。fat 是三元组 [addr, base, end]，thin 是一个数 —— 所以"拿地址"
// 与"查范围"这两件事在两种指针上各是一行，读写那一半共用。
const jsPtrAddr = (code, t) => (t.k === 'tptr' ? code : `${code}[0]`);
const jsPtrChk = (self, p, size) => (p.type.k === 'tptr'
  ? `$tchk(${self.expr(p)})` : `$pchk(${self.expr(p)}, ${size})`);
// 目标类型是**指针自己**时，读写的是三个字（fat）或一个字（thin）——
// 见 prelude 的 $pload_p / $pload_t（ADR-0016 第十六刀）。
// `arr` 那一格是**句柄**（ADR-0024）：arena 里存一格 id，对象在 $H 那张表上。
// `string` 那一格（ADR-0026）是 16 字节里放"句柄 id + 字节长度"，与 arr 差一格：id 0 是
// **空串**、不是错（string 的零值就是空串）。
// 这两条链的**最后一格是 bool**，所以每加一种"能落进内存"的类型都得在这儿加一支 ——
// 忘了就会被默默当 bool 读写，那是个静默的错答案。
// 函数值（ADR-0028）**直接复用 arr 那一对**：两者在这条腿上是同一件事 —— 一个字的句柄 id、
// 对象挂在 $H 上、id 0 是错（函数值没有零值那一格）。所以不用另开 `$pload_f`。
const jsPtrLoad = (t) => (t.k === 'int' ? '$pload_i' : (t.k === 'real' ? '$pload_r'
  : (t.k === 'ptr' ? '$pload_p' : (t.k === 'tptr' ? '$pload_t'
    : (t.k === 'arr' || t.k === 'fn' ? '$pload_h' : (t.k === 'string' ? '$pload_s' : '$pload_b'))))));
const jsPtrStore = (t) => (t.k === 'int' ? '$pstore_i' : (t.k === 'real' ? '$pstore_r'
  : (t.k === 'ptr' ? '$pstore_p' : (t.k === 'tptr' ? '$pstore_t'
    : (t.k === 'arr' || t.k === 'fn' ? '$pstore_h' : (t.k === 'string' ? '$pstore_s' : '$pstore_b'))))));


class JsEmitter {
  constructor(mod) {
    this.mod = mod;
    this.out = [];
    this.indent = 0;
    this.tmp = 0;
    // 循环标签栈（第四十刀）：每进一层循环压一个名字（不需要标签时压 null）。
    // `(brk N)` 往里数第 N 个就是目标。
    this.loops = [];
    // REPL（--engine js）里被提成模块级 var 的那几条 Local，按语句对象的身份记；
    // 不在 REPL 模式下一直是 null（见 hoistTop）
    this.hoisted = null;
    // `case 'CCall'` 里有没有人真走了 `cCall` —— 有的话在 prelude 后面拼 cffiGlue
    this.cffiUsed = false;
  }

  /** 进循环前：要标签就发一行 `L:`，并把名字压栈；回一个 null 表示这层没标签 */
  pushLoop(s) {
    const need = loopLabelNeeds(s);
    // 自增写在三目里就落在**惰性位置**上（那半边要抬一格临时才算得出来），自举那条路上
    // 明说不收，所以分成两句写。
    let label = null;
    if (need.brk || need.cont) {
      label = `$L${this.tmp}`;
      this.tmp++;
    }
    if (label !== null) this.line(`${label}:`);
    this.loops.push(label);
    return label;
  }

  /** `break;` / `break $L3;` —— JS 的标签一个就够，break 与 continue 共用 */
  jump(s, word) {
    const lv = s.level === undefined || s.level === null ? 1 : s.level;
    if (lv === 1) return `${word};`;
    const label = this.loops[this.loops.length - lv];
    if (label === undefined || label === null) throw new Error(`js.${word}: 第 ${lv} 层循环没有标签`);
    return `${word} ${label};`;
  }

  line(s) {
    this.out.push('  '.repeat(this.indent) + s);
  }

  /**
   * ESM 模式下每个定义前面的 `export `（第七十五刀）。一个库文件一份 `.js`，
   * 它定义的东西全部导出、它用到的别人家的东西靠 `import` 进来 —— 于是"复用"这件事
   * 是**宿主的模块图**在做，不是我们把一堆文本拼成一份大 JS。
   */
  ex() {
    return this.esm === true ? 'export ' : '';
  }

  /**
   * ESM 模式下**全局要装箱**：`export const g_x = {v: …}`，读写都走 `.v`。
   * 原因是 ESM 的 import 绑定在引用方是只读的，而 asy 里跨文件赋值是真事
   * （`currentpicture = …`、`defaultpen = …`）—— 不装箱那一句在 JS 里直接抛
   * "Assignment to constant variable"。装箱之后写的是**同一个对象的字段**，
   * 六条腿上"全局是一格存储"这条语义没变。
   */
  globalRef(name) {
    return this.esm === true ? `g_${name}.v` : `g_${name}`;
  }

  /** 别人家的符号 -> 一条 `import`。名字按种类拼，与各自的发射处一一对应。 */
  importLines() {
    // 运行时那一份只为**副作用**引一次（它把 $print / $W 那些挂到 globalThis 上）。
    // 顺序上也靠它：ESM 是深度优先求值依赖，写在最前面就一定先跑。
    this.line("import './omni_rt.js';");
    const byFrom = new Map();
    for (const im of this.mod.imports ?? []) {
      let names = byFrom.get(im.from);
      if (names === undefined) { names = []; byFrom.set(im.from, names); }
      if (im.kind === 'fn') names.push(`s_${im.name}`);
      else if (im.kind === 'global') names.push(`g_${im.name}`);
      else if (im.kind === 'class') names.push(`$new_C${im.name}`);
      else if (im.kind === 'struct') { names.push(`$new_S${im.name}`); names.push(`$cp_S${im.name}`); }
      else if (im.kind === 'cfn') names.push(`omni_mk_${im.name}`);
    }
    for (const [from, names] of byFrom) {
      this.line(`import { ${names.join(', ')} } from './${from}.js';`);
    }
  }

  emit() {
    // 一份**产物片段**（chunk）：不带 prelude、不带派发器、末尾不调入口（第七十五刀）。
    // 一个库文件编出一份自己的 JS 就是这个形态 —— 几份拼到一份 prelude 后面就是整个程序。
    // 这条路在 JS 后端成立的原因见 emitJsFunc 的注释：函数体引用外部世界只靠**名字**。
    const chunk = this.chunk === true;
    /* 运行时那一段（序言 + 两格派发器）**先攒着别拼进去**：它要按程序段用到的名字裁
     * （`trimJsRuntime`），而"程序段用到什么"只有程序发完才知道。攒法是把 `this.out`
     * 临时借走 —— `memberDispatch` / `callOpDispatch` 是往 `this.line` 上写的。 */
    let head = '';
    if (!chunk) {
      const outer = this.out;
      this.out = [];
      this.out.push(JS_PRELUDE.trim());
      /* `--profile stub`：那几十行收集器只有量的时候才推进来（见 prelude.js 的 JS_PROF_RT）。 */
      if (this.prof === true) this.out.push(JS_PROF_RT.trim());
      this.memberDispatch();
      this.callOpDispatch();
      head = this.out.join('\n');
      this.out = outer;
    }
    if (this.esm === true) this.importLines();
    for (const s of this.mod.structs) this.struct(s);
    for (const e of this.mod.enums ?? []) this.enumDecl(e);
    for (const c of this.mod.classes ?? []) this.classDecl(c);
    for (const c of this.mod.closures ?? []) this.closureMake(c);
    // JS 前端的模块级变量（ADR-0011）：顶层函数要能互相看见，所以是真全局，
    // 不是 omni_main 的局部量。C 侧对应一批 static omni_dyn。
    // REPL 里是 `var`：一批一份片段、装进同一个全局作用域，而 `var g_x;`（不带初值）
    // 在那里的语义正好是"没有就建、已经有就保留原值"—— 第 2 批不该把第 1 批的 x 清掉。
    // `let` 在间接 eval 里只活在那一段片段里，下一批根本看不见。
    for (const g of this.mod.jsGlobals ?? []) {
      this.line(this.repl === true ? `var g_${g.name};` : `let g_${g.name} = undefined;`);
    }
    // 核心方言的模块级变量（第二十四刀）：有类型，初值由 omni_main 最前面那几句赋 ——
    // 所以这里只要把存储声明出来。ESM 模式下那一格是装箱的（见 globalRef）。
    for (const g of this.mod.globals ?? []) {
      if (this.repl === true) { this.line(`var g_${g.name};`); continue; }
      this.line(this.esm === true
        ? `export const g_${g.name} = { v: undefined };`
        : `let g_${g.name} = undefined;`);
    }
    for (const f of this.mod.funcs) this.func(f);
    if (chunk) return this.out.join('\n') + '\n';
    // 线性内存（ADR-0017 第二刀）：建内存、拷 data 段，都在调入口**之前**（wasm 的
    // instantiate 同序）。data 段的字节发成一个数组字面量 —— 它们是编译期算好的。
    if (this.mod.mem !== undefined && this.mod.mem !== null) {
      this.line(`$lin_init(${this.mod.mem.min}, ${this.mod.mem.max});`);
      for (const d of this.mod.mem.data) {
        this.line(`$lin_data(${d.off}, [${d.bytes.join(', ')}]);`);
      }
    }
    this.line(`${this.mod.entry}();`);
    // 没人接的错误：和 C 侧的 main 一样，在入口返回之后查一次（ADR-0007 决定 1）
    this.line('$js_check_uncaught();');
    this.line('$flush();');
    const prog = this.out.join('\n');
    /* FFI 前段（ADR-0038）：有 cCall 才拼，没有的时候一个字都不留。
       必须在 prelude 之后、程序段之前 —— 它引用 `$mem`/`$rt_error`（prelude 的），
       而程序段里的 `$cffi.xxx` 引用它声明的那几个名字。
       **裁运行时的时候要把它算进"用到的名字"**：`$mem` 有可能只有这一段提到。 */
    const ffi = this.cffiUsed ? cffiGlue() : '';
    /* 运行时那一段按这份程序用到的名字裁（`trimJsRuntime`）。`trim: false` 是逃生门：
     * 出了事要能一句话切回"整份都带"，好把"是不是摇树摇掉了什么"当场分清。 */
    const rt = this.trim === false ? head : trimJsRuntime(head, ffi + prog);
    return `${rt}\n${ffi}${prog}\n`;
  }

  /**
   * 成员派发器（ADR-0011 第 9 节）。表在 hir/js_abi.js，这里只按表生成：
   * 接收者的标签决定叫哪个 op，表外的成员名当场报错。C 后端有一份逐行对应的生成。
   */
  memberDispatch() {
    for (const d of Object.values(JS_MEMBERS)) {
      const m = d.member;
      const ps = ['r'];
      for (let i = 0; i < m.argc; i++) ps.push(`a${i}`);
      const lits = Object.values(m.lit ?? {}).map((v) => JSON.stringify(v));
      this.line(`function ${d.js}(${ps.join(', ')}) {`);
      this.indent++;
      this.line('switch ($dynTag(r)) {');
      this.indent++;
      for (const [tag, op] of Object.entries(m.on)) {
        const abi = JS_ABI[op];
        // arity 只数 dynamic 实参（含接收者），lit 是额外排在前面的编译期常量
        const args = [...lits, ...ps.slice(0, abi.arity)];
        this.line(`case ${JSON.stringify(tag)}: return ${abi.js}(${args.join(', ')});`);
      }
      // 表外的接收者：属性就是普通属性，方法就是"取属性再当函数调"（ADR-0011 决策 12）
      const get = `$js_obj_get(r, ${JSON.stringify(m.name)})`;
      if (m.kind === 'prop') {
        this.line(`default: return ${get};`);
      } else {
        // 接收者要传下去（ADR-0020 P1）：`o.m()` 落到兜底上时 this 就是 o
        const call = `$js_call_n_this(${get}, r, [${ps.slice(1).join(', ')}])`;
        this.line(`default: return ${d.ret === 'bool' ? `$js_truthy(${call})` : call};`);
      }
      this.indent--;
      this.line('}');
      this.indent--;
      this.line('}');
    }
  }

  /**
   * 按名字调 op 的分派器（`js_call_op`，ADR-0013）。解释器是唯一的用户：它手里的 op 名字
   * 是运行期的值，而两个后端里 op 调用都是编译期展开的，所以需要这一层。
   * 表驱动 —— 往 JS_ABI 加一条 op 就自动进解释器。lit 排在 args 前面，由调用方铺平。
   */
  callOpDispatch() {
    this.line('function $js_call_op(name, args) {');
    this.indent++;
    this.line('switch (name) {');
    this.indent++;
    for (const [name, abi] of Object.entries(JS_ABI)) {
      if (name === 'js_call_op' || abi.raw === true) continue;  // 不自递归；raw 的签名不统一
      const n = (abi.lit ?? []).length + abi.arity;
      const as = [];
      for (let i = 0; i < n; i++) as.push(`args[${i}]`);
      const call = `${abi.js}(${as.join(', ')})`;
      this.line(abi.ret === 'void'
        ? `case ${JSON.stringify(name)}: ${call}; return undefined;`
        : `case ${JSON.stringify(name)}: return ${call};`);
    }
    this.line('default: $rt_error("no such op: " + name); return undefined;');
    this.indent--;
    this.line('}');
    this.indent--;
    this.line('}');
  }

  /**
   * 闭包记录的构造函数。捕获**在这里**被拷进记录 —— 不靠 JS 的词法作用域，
   * 因为 JS 的闭包是按引用捕获的，而 Omni 规定按值（ADR-0010）；靠宿主的话
   * `for` 循环里创建的闭包在 JS 与 C 上会给出不同答案。
   */
  closureMake(c) {
    const ps = c.captures.map((f) => `c_${f.name}`);
    const fields = c.captures.map((f) => `c_${f.name}: c_${f.name}`);
    /* fn.name / fn.length（ADR-0020）：函数在这个值域里还不是真对象，这两格就存在闭包
       记录里，由 Function.prototype 上的两个访问器读（prelude 的 $js_fn_name）。
       只有 JS 前端会填 fnName —— 别的前端的记录照旧只有 fp 与捕获。 */
    if (c.fnName !== undefined) {
      fields.unshift(`$nm: ${JSON.stringify(c.fnName)}`, `$ln: ${c.fnLen ?? 0}`);
    }
    // 带 `single` 的那一格（`(fnref f)` 的薄适配器）发**单件**：同一个具名函数取出来的值
    // 必须是同一个东西，不然 `f == g` 这种按身份比的式子永远为假 —— graph.asy:1922 的
    // `if(T == identity)` 正是这一格（走错分支的话 Log 轴的取样从"对数均匀"变成"线性均匀"）。
    // 量过 asy：具名函数 `f == f` 真，而同一个 lambda 求值两次（`mk() == mk()`，捕获空的
    // 也算）是假 —— 所以只有这一格缓存，lambda 那一族照旧一次一条。
    // 缓存不挂在造它的那个小函数身上、而是进运行时那张全局表（`$fnOne`）：一个程序由
    // **多份产物**拼起来，而这个适配器是"谁取地址谁发一份"—— 挂在自己身上的话 graph 那份
    // 与例子那份各有一个缓存，跨产物比还是假。
    if (c.single === true && ps.length === 0) {
      const extra = fields.length ? `, ${fields.join(', ')}` : '';
      this.line(`${this.ex()}function ${c.make}() { return $fnOne(${JSON.stringify(c.make)}, () => ({ fp: ${c.mangled}${extra} })); }`);
      return;
    }
    this.line(`${this.ex()}function ${c.make}(${ps.join(', ')}) { return { fp: ${c.mangled}${fields.length ? `, ${fields.join(', ')}` : ''} }; }`);
  }

  struct(s) {
    const init = s.fields.map((f) => `${f.name}: ${this.zero(f.type)}`).join(', ');
    this.line(`${this.ex()}function $new_S${s.name}() { return { ${init} }; }`);
    const copy = s.fields
      .map((f) => `${f.name}: ${this.copyOf(f.type, `v.${f.name}`)}`)
      .join(', ');
    this.line(`${this.ex()}function $cp_S${s.name}(v) { return { ${copy} }; }`);
  }

  /**
   * tagged union（ADR-0012）。表示是一个扁平对象：`$t` 是标签（一个普通数），
   * 载荷字段直接摊在同一层 —— 同一时刻只有一个变体活着，
   * 所以两个变体的同名字段在运行期不会同时存在。
   */
  enumDecl(e) {
    const v0 = e.variants[0];
    const init = ['$t: 0', ...v0.fields.map((f) => `${f.name}: ${this.zero(f.type)}`)].join(', ');
    this.line(`${this.ex()}function $new_E${e.name}() { return { ${init} }; }`);
    // 值语义的拷贝：先看标签才知道有哪些载荷字段要拷
    this.line(`${this.ex()}function $cp_E${e.name}(v) {`);
    this.indent++;
    this.line('switch (v.$t) {');
    this.indent++;
    for (const [i, v] of e.variants.entries()) {
      const fs = ['$t: v.$t', ...v.fields.map((f) => `${f.name}: ${this.copyOf(f.type, `v.${f.name}`)}`)];
      this.line(`case ${i}: return { ${fs.join(', ')} };`);
    }
    this.indent--;
    this.line('}');
    this.line('return v;');
    this.indent--;
    this.line('}');
  }

  /** 值语义字段的拷贝表达式；只有 struct / enum / vec 需要真的拷 */
  copyOf(t, src) {
    if (t.k === 'struct') return `$cp_S${t.name}(${src})`;
    if (t.k === 'enum') return `$cp_E${t.name}(${src})`;
    // 向量字段：宿主表示是普通数组，不切一刀两个结构体就共用同一条道
    // （C 与 LLVM 那边拷的是 16 字节的副本，那才是这一层要对齐的语义）
    if (t.k === 'vec') return `$vcopy(${src})`;
    return src;
  }

  /** 深装箱（ADR-0008）在这条腿上只剩一件事：把容器里的 int 换成 dynamic 那一格的
   *  表示（BigInt）。里面没有 int 时整条是恒等，什么都不发。 */
  boxDeepJs(t, src) {
    const lane = this.boxLane(t.k === 'list' ? t.elem : t.val);
    if (lane === null) return src;
    return t.k === 'list' ? `${src}.map(${lane})` : `$mapVals(${src}, ${lane})`;
  }

  /** 一个元素的装箱函数；null = 恒等 */
  boxLane(t) {
    if (t.k === 'int') return '$B';
    if (t.k === 'list' || t.k === 'dict') {
      const inner = this.boxDeepJs(t, 'x');
      return inner === 'x' ? null : `(x) => ${inner}`;
    }
    return null;
  }

  classDecl(c) {
    const init = c.fields.map((f) => `${f.name}: ${this.zero(f.type)}`).join(', ');
    this.line(`${this.ex()}function $new_C${c.name}() { return { ${init} }; }`);
  }

  zero(t) {
    switch (t.k) {
      case 'int': return '0';
      case 'real': return '0';
      case 'bool': return 'false';
      case 'string': return '""';
      case 'struct': return `$new_S${t.name}()`;
      case 'enum': return `$new_E${t.name}()`;
      case 'class': case 'dynamic': case 'null': case 'fn': return 'null';
      case 'list': return '[]';
      case 'dict': return 'new Map()';
      case 'set': return 'new Set()';
      // 向量（第十五刀：结构体的向量字段）。`$vsplat` 就是 VecSplat 那条路发的东西，
      // 所以"字段的零"与"裸的零向量"在这条腿上是同一个表示。
      case 'vec': return `$vsplat(${this.zero(t.elem)}, ${t.lanes})`;
      // 数组（第十六刀：结构体的数组字段）。空数组，不是 null —— `$anew` 就是
      // ArrNew 那条路发的东西，元素零值当实参传进去。
      case 'arr': return `$anew(0, ${this.zero(t.elem)}, ${jsElemCopy(t)})`;
      // 指针（ADR-0016）：零值是空指针。fat 的空是 [0,0,0]（三个字都在，只是都为 0），
      // thin 的空就是 0 —— 与 PtrNull 那条路发的东西一模一样。
      case 'ptr': return '[0, 0, 0]';
      case 'tptr': return '0';
      // 定长内存的字段（第二十二刀）。这一格**观察不到** —— 结构体整块读写方言不给
      // （见 sexpr/lower.js 的 pload/pstore 两条），而 `(fld …)` / `(fldset …)` 在
      // blk 字段上也是当场拒的。内嵌那 N 格只能经 `(pfield …)` 在 arena 里碰，
      // 而 arena 是字节 + 偏移，跟这个对象表示无关。留一格 N 个元素零值的数组，
      // 是为了让"逐字段铺零"这条路对每种字段都有东西可写。
      case 'blk': return `new Array(${t.n}).fill(${this.zero(t.el)})`;
      /* 匿名 union 的字段（ADR-0027）：与上面 blk 那一格同一个道理 —— **观察不到**。
         成员只能经 `(pfield …)` 在 arena 里碰（那边是字节 + 偏移，几格成员共用同一段），
         而 `(fld …)` / `(fldset …)` 在成员名上本来就查不着（布局那张平表才有它们）。
         留一格 0 是为了让"逐字段铺零"这条路对每种字段都有东西可写。 */
      case 'union': return '0n';
      default: throw new Error(`zero: ${t.k}`);
    }
  }

  /**
   * REPL 的会话顶层变量（`--engine js`）。
   *
   * 一批输入编出来的 delta 里，会话的顶层变量是**入口函数最外层的局部量** ——
   * 解释器那条腿靠"入口函数跑在常驻的顶层 Env 里"让它跨批活着（interp/eval.js 的
   * InterpSession.runEntry）。JS 这条腿上函数体就是函数作用域，`let v_x` 只活到这一批
   * 结束，于是第 2 批的 `print(x * x)` 撞上 `v_x is not defined`。
   *
   * 所以最外层那几个提成模块级的 `var v_x;`：在间接 eval 里那就是全局，而不带初值的
   * `var` 语义正好是"没有就建、已经有就保留原值"，重复装同一个名字不会清掉上一批的值。
   * 只提**最外层**（transparent 的块是降级器塞多条语句用的，不开作用域，所以算最外层）——
   * `for` 体里的同名局部量仍然是 `let`，它在解释器那边也是子 Env。
   * 按语句对象的身份记，不是按名字：内层块里同名的那个不受影响。
   */
  hoistTop(stmts) {
    for (const s of stmts) {
      if (s.kind === 'Local') {
        this.hoisted.add(s);
        this.line(`var v_${s.name};`);
      } else if (s.kind === 'Block' && s.transparent === true) {
        this.hoistTop(s.stmts);
      }
    }
  }

  func(f) {
    if (this.repl === true && f.mangled === this.mod.entry) {
      this.hoisted = new Set();
      this.hoistTop(f.body.stmts);
    }
    // 闭包体的第一个形参是闭包记录本身：捕获从它上面读（C 侧同一套约定）
    const params = [...(f.closureId === undefined ? [] : ['self']), ...f.params.map((p) => `v_${p.name}`)];
    this.line(`${this.ex()}function ${f.mangled}(${params.join(', ')}) {`);
    this.indent++;
    // 结构体 / enum 形参按值传递：入口处深拷贝，等价于 C 的值语义
    for (const p of f.params) {
      if (p.type.k === 'struct' || p.type.k === 'enum') {
        this.line(`v_${p.name} = ${this.copyOf(p.type, `v_${p.name}`)};`);
      }
    }
    /* `--profile stub`：这一对就是 C 那条腿 `__cyg_profile_func_enter/exit` 的孪生。
     * 用 `try/finally` 而不是「体末尾再叫一次」：JS 里 `return` 与 `throw` 都要还栈，
     * 而 finally 是唯一一处两条路都过的地方 —— 少了它，一个 throw 就把影子栈弄歪。 */
    const prof = this.prof === true;
    if (prof) {
      this.line(`const __pf = $prof_enter(${JSON.stringify(f.mangled)});`);
      this.line('try {');
      this.indent++;
    }
    for (const s of f.body.stmts) this.stmt(s);
    if (prof) {
      this.indent--;
      this.line('} finally { $prof_exit(__pf); }');
    }
    this.indent--;
    this.line('}');
    this.hoisted = null;
  }

  body(stmts) {
    this.indent++;
    for (const x of stmts) this.stmt(x);
    this.indent--;
  }

  stmt(s) {
    switch (s.kind) {
      case 'Block':
        if (s.transparent) { for (const x of s.stmts) this.stmt(x); break; }
        this.line('{');
        this.body(s.stmts);
        this.line('}');
        break;
      case 'Local':
        // REPL 的会话顶层变量已经提成模块级的 var 了（见 hoistTop），这里只剩赋值
        this.line(this.hoisted !== null && this.hoisted.has(s)
          ? `v_${s.name} = ${this.rvalue(s.init, s.type)};`
          : `let v_${s.name} = ${this.rvalue(s.init, s.type)};`);
        break;
      case 'ExprStmt':
        this.line(`${this.expr(s.expr)};`);
        break;
      case 'If':
        this.line(`if (${this.expr(s.cond)}) {`);
        this.body(s.then.stmts);
        if (s.otherwise) {
          this.line('} else {');
          this.body(s.otherwise.stmts);
        }
        this.line('}');
        break;
      case 'While':
        this.pushLoop(s);
        this.line(`while (${this.expr(s.cond)}) {`);
        this.body(s.body.stmts);
        this.line('}');
        this.loops.pop();
        break;
      case 'For':
        // init 可能声明多个变量，放在外层块里；step 仍在 for 头部，保证 continue 语义
        this.line('{');
        this.indent++;
        if (s.init) this.stmt(s.init);
        this.pushLoop(s);
        this.line(`for (; ${s.cond ? this.expr(s.cond) : ''}; ${s.step ? this.expr(s.step) : ''}) {`);
        this.body(s.body.stmts);
        this.line('}');
        this.loops.pop();
        this.indent--;
        this.line('}');
        break;
      case 'ForIn': {
        const t = s.iterable.type;
        const src = t.k === 'dict' ? `${this.expr(s.iterable)}.keys()` : this.expr(s.iterable);
        const it = `$it${this.tmp++}`;
        this.pushLoop(s);
        this.line(`for (const ${it} of ${src}) {`);
        this.indent++;
        this.line(`let v_${s.varName} = ${this.convert(it, s.elemType, s.varType)};`);
        this.indent--;
        this.body(s.body.stmts);
        this.line('}');
        this.loops.pop();
        break;
      }
      case 'Return':
        this.line(s.value ? `return ${this.rvalue(s.value, s.value.type)};` : 'return;');
        break;
      case 'Break': this.line(this.jump(s, 'break')); break;
      case 'Continue': this.line(this.jump(s, 'continue')); break;
      default: throw new Error(`js.stmt: ${s.kind}`);
    }
  }

  /** 迭代变量类型与元素类型不同时的转换（目前只有 int -> real 与装箱） */
  convert(code, from, to) {
    if (from.k === 'int' && to.k === 'real') return `Number(${code})`;
    return code;
  }

  /** 需要值语义的位置（初始化/赋值/传参/返回）：结构体、enum 与向量的左值要拷贝。
   *  `GlobalRef`：这条腿的全局是一个 JS 绑定，结构体躺在里面就是个对象 —— 少了拷贝
   *  `let v_p = g_origin;` 是别名。种类列表与 from_oir 的 rvalue 逐条相同。 */
  rvalue(e, type) {
    const src = this.expr(e);
    const lval = e.kind === 'VarRef' || e.kind === 'Field' || e.kind === 'EnumPayload'
      || e.kind === 'GlobalRef';
    if (type && lval && type.k === 'vec') return `$vcopy(${src})`;
    if (type && lval && (type.k === 'struct' || type.k === 'enum')) return this.copyOf(type, src);
    return src;
  }
  expr(e) {
    switch (e.kind) {
      case 'Const':
        if (e.type.k === 'int') return jsIntLit(e.value);
        if (e.type.k === 'real') return fmtRealLit(e.value);
        if (e.type.k === 'bool') return String(e.value);
        return JSON.stringify(e.value);
      case 'ZeroStruct': return `$new_S${e.type.name}()`;
      case 'ZeroEnum': return `$new_E${e.type.name}()`;
      case 'MakeEnum': {
        const v = e.type.variants[e.tag];
        const fs = [`$t: ${e.tag}`, ...e.args.map((a, i) => `${v.fields[i].name}: ${this.rvalue(a, a.type)}`)];
        return `{ ${fs.join(', ')} }`;
      }
      case 'EnumTag': return `${this.expr(e.object)}.$t`;
      case 'EnumPayload': return `${this.expr(e.object)}.${e.name}`;
      case 'NullLit': case 'NullRef': case 'DynNull': case 'NullFn': return 'null';
      case 'NewObject': return `$new_C${e.type.name}()`;
      case 'MakeClosure': return `${e.make}(${e.args.map((x) => this.rvalue(x, x.type)).join(', ')})`;
      case 'CaptureRef': return `self.c_${e.name}`;
      case 'CallFn':
        return `$callFn(${[this.expr(e.callee), ...e.args.map((a) => this.rvalue(a, a.type))].join(', ')})`;
      case 'NewContainer': return this.zero(e.type);
      case 'ListLit': return `[${e.items.map((x) => this.rvalue(x, x.type)).join(', ')}]`;
      case 'SetLit': return `new Set([${e.items.map((x) => this.expr(x)).join(', ')}])`;
      case 'DictLit':
        return `new Map([${e.entries.map((en) => `[${this.expr(en.key)}, ${this.rvalue(en.value, en.value.type)}]`).join(', ')}])`;
      case 'VarRef': return `v_${e.name}`;
      // 向量四条（ADR-0014 门槛 6 第一阶段）。表示 = 数组，取道就是取下标；
      // 下标是降级期就定死的字面量，所以这里没有边界检查那条路。
      case 'VecSplat': return `$vsplat(${this.expr(e.value)}, ${e.type.lanes})`;
      case 'VecLit': return `[${e.lanes.map((x) => this.expr(x)).join(', ')}]`;
      case 'VecLane': return `${this.expr(e.vec)}[${e.lane}]`;
      case 'VecHsum': return `$vhsum(${this.expr(e.vec)}, ${this.laneOp('+', e.type)})`;
      // 缓冲四条（门槛 7 第一阶段）：表示是数组，引用语义 —— 所以 rvalue 不拷它
      case 'BufNew': return `$bnew(${this.expr(e.count)})`;
      case 'BufLen': return `${this.expr(e.buf)}.length`;
      case 'BufGet': return `$bget(${this.expr(e.buf)}, ${this.expr(e.index)})`;
      case 'BufSet': return `$bset(${this.expr(e.buf)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      // 指针（ADR-0016）：这条腿是 arena 模拟。fat 是三元组 [addr, base, end]，thin 是一个数。
      // 检查与读写分开写（`$pload_i($pchk(p, 8))`）：thin 那一档只换掉检查那一半，
      // 读写那一半两种指针共用同一份，于是"两种指针读到的是同一件事"不靠对齐两份代码。
      case 'PtrNull': return e.type.k === 'tptr' ? '0' : '[0, 0, 0]';
      case 'PtrNew': return `$pnew(${this.expr(e.count)}, ${e.size})`;
      case 'PtrIsNull': return `(${jsPtrAddr(this.expr(e.ptr), e.ptr.type)} === 0)`;
      case 'PtrThin': return `${this.expr(e.ptr)}[0]`;
      // `(pelem p)`（第十八刀）：只换类型，值一个字不动 —— 三元组照原样交出去。
      // 共用同一个数组没问题：fat 指针在这条腿上从不原地改（$padd 等都回新数组）。
      case 'PtrElem': return this.expr(e.ptr);
      // `(pcast p (ptr U))`（第二百五十九刀）：同上 —— 三元组里没有元素类型（跨几个字节在
      // `$padd` 的实参上、读写宽度在 `jsPtrLoad` 那一步），所以换类型不发一个字。
      case 'PtrCast': return this.expr(e.ptr);
      case 'PtrLoad': return `${jsPtrLoad(e.type)}(${jsPtrChk(this, e.ptr, e.size)})`;
      case 'PtrStore':
        return `${jsPtrStore(e.type)}(${jsPtrChk(this, e.ptr, e.size)}, ${this.expr(e.value)})`;
      // 线性内存（ADR-0017 第二刀）。一个访问一个函数（`$lin_ld_i32u(a, off)`），不是一个
      // 带 kind 参数的通用函数：宽度与符号是编译期常量，发成名字之后每个调用点都是单态的，
      // 函数体里只剩一次 DataView 调用。名字带 `lin` 前缀是因为 prelude 里 `$mgrow` 已经
      // 是 arena 的增长了（ADR-0016），两块内存两套名字，别混。
      case 'MemSize': return '$lin_size()';
      case 'MemGrow': return `$lin_grow(${this.expr(e.pages)})`;
      case 'MemLoad': return `$lin_ld_${e.mkind}(${this.expr(e.addr)}, ${e.off})`;
      case 'MemStore':
        return `$lin_st_${e.mkind}(${this.expr(e.addr)}, ${e.off}, ${this.expr(e.value)})`;
      // padd / pfield 造**新**的三元组，base/end 照抄：范围是"这块内存"的属性，
      // 走到哪儿都不变（jancy 的 validator 也是跟着块走的，不跟着指针走）。
      case 'PtrAdd': return e.ptr.type.k === 'tptr'
        ? `(${this.expr(e.ptr)} + Number(${this.expr(e.delta)}) * ${e.size})`
        : `$padd(${this.expr(e.ptr)}, ${this.expr(e.delta)}, ${e.size})`;
      case 'PtrField': return e.ptr.type.k === 'tptr'
        ? `(${this.expr(e.ptr)} + ${e.off})`
        : `$padd(${this.expr(e.ptr)}, ${e.off}, 1)`;
      case 'PtrSub': return e.a.type.k === 'tptr'
        ? `((${this.expr(e.a)} - ${this.expr(e.b)}) / ${e.size})`
        : `$psub(${this.expr(e.a)}, ${this.expr(e.b)}, ${e.size})`;
      // 只比**地址那一个字**。fat 是个三元数组，`===` 比的是引用（两个指向同一格的
      // 指针各是一份拷贝，引用永远不等），所以必须显式取 [0]。跨块也有定义：不等。
      case 'PtrEq': return e.a.type.k === 'tptr'
        ? `(${this.expr(e.a)} === ${this.expr(e.b)})`
        : `((${this.expr(e.a)})[0] === (${this.expr(e.b)})[0])`;
      // 数组六条（门槛 2 第四刀）：也是 JS 数组，也是引用语义。零值当参数传 ——
      // BufNew 那条传的是"是不是 int"的布尔，那是只有两种元素时的省事写法，数组有四种。
      // 末尾那个布尔是"元素是值语义、存进去要拷一份"（只有向量），按**静态类型**给：
      // 多维数组那一刀之后 `Array.isArray` 分不开向量与行（见 prelude 的 $acopy）。
      case 'ArrNew': return `$anew(${this.expr(e.count)}, ${this.expr(e.zero)}, ${jsElemCopy(e.type)})`;
      case 'ArrLen': return `$alen(${this.expr(e.arr)})`;
      case 'ArrGet': return `$aget(${this.expr(e.arr)}, ${this.expr(e.index)})`;
      case 'ArrSet': return `$aset(${this.expr(e.arr)}, ${this.expr(e.index)}, ${this.expr(e.value)}, ${jsElemCopy(e.arr.type)})`;
      case 'ArrPush': return `$apush(${this.expr(e.arr)}, ${this.expr(e.value)}, ${jsElemCopy(e.arr.type)})`;

      case 'ArrPop': return `$apop(${this.expr(e.arr)})`;
      case 'Field': {
        const obj = this.expr(e.object);
        // class 是引用类型，可能为 null；两个后端都显式检查，错误消息一致
        return e.object.type.k === 'class' ? `$nullCheck(${obj}).${e.name}` : `${obj}.${e.name}`;
      }
      case 'Cast':
        // uns = 位当无符号 64 位读（第六十一刀）：`Number(-1n)` 是 -1，
        // `Number($U(-1n))` 是 18446744073709551615
        if (e.from.k === 'int' && e.type.k === 'real') {
          return e.uns === true ? `Number($U(${this.expr(e.expr)}))` : `Number(${this.expr(e.expr)})`;
        }
        throw new Error(`js.cast: ${e.from.k}->${e.type.k}`);
      // 装箱：dynamic 就是原生值（ADR-0006 第 2 节），只有 int 要换一种表示 ——
      // 静态的 int 是规范化的 number|BigInt，而 dynamic 里的 int **一律 BigInt**
      // （$dynTag 靠 typeof 分 int 与 real，1 与 1.0 在 number 上分不开）。
      case 'Box': return e.from.k === 'int' ? `$B(${this.expr(e.expr)})` : this.expr(e.expr);
      case 'Logic': return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case 'Un':
        // 一元负号也会溢出：-INT64_MIN == INT64_MIN，必须回绕（C 侧走 omni_neg）
        if (e.op === '-' && e.type.k === 'int') return `$ineg(${this.expr(e.operand)})`;
        // 按位取反：宿主的 ~ 在 number 上先截成 int32（~3037000500 给 1257966795，
        // 不是 -3037000501），所以 int 这一档必须走 BigInt 那条
        if (e.op === '~' && e.type.k === 'int') return `$inot(${this.expr(e.operand)})`;
        return `(${e.op}${this.expr(e.operand)})`;
      case 'Cmp': {
        if (e.opType.k === 'dynamic') {
          const eq = `$dynEq(${this.expr(e.left)}, ${this.expr(e.right)})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        const op = e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op;
        // 无符号那四个比较（第六十一刀）：两边的位当无符号 64 位读，比法照旧
        if (op.startsWith('u')) {
          return `($U(${this.expr(e.left)}) ${op.slice(1)} $U(${this.expr(e.right)}))`;
        }
        return `(${this.expr(e.left)} ${op} ${this.expr(e.right)})`;
      }
      case 'Bin': return this.bin(e);
      // JS 前端的模块级变量（ADR-0011）：一个真全局，可读可写
      case 'JsGlobal': return `g_${e.name}`;
      // 核心方言的模块级变量（第二十四刀）：同一个形状，只是有类型
      case 'GlobalRef': return this.globalRef(e.name);
      case 'Ternary': return `(${this.expr(e.cond)} ? ${this.expr(e.then)} : ${this.expr(e.otherwise)})`;
      case 'Assign': return `(${this.expr(e.target)} = ${this.rvalue(e.value, e.type)})`;
      case 'IndexGet': {
        if (e.recvType.k === 'list') return `$listGet(${this.expr(e.obj)}, ${this.expr(e.index)})`;
        return `$dictGet(${this.expr(e.obj)}, ${this.expr(e.index)}, ${JSON.stringify(e.recvType.key.k)})`;
      }
      case 'IndexSet': {
        const fn = e.recvType.k === 'list' ? '$listSet' : '$dictSet';
        return `${fn}(${this.expr(e.obj)}, ${this.expr(e.index)}, ${this.rvalue(e.value, e.type)})`;
      }
      case 'Call':
        return `${e.func}(${e.args.map((a) => this.rvalue(a, a.type)).join(', ')})`;
      case 'Builtin': return this.builtin(e);
      /* 外部 C 符号。**声明在源码里的那些（`raw`，ADR-0022 的 J4b）落成一次真的 C 调用**
         —— 桥是我们自己发的那份 N-API 扩展（ADR-0038）。封闭表那一族（`hir/c_abi.js`
         的 8 条 libc，实参是 dynamic 装箱值）照旧发一条当场报错的：它的语义是
         `C_IN`/`C_OUT` 那对 marshaler，与这条路的"机器值直通"不是同一件事。
         报错那一支仍然把实参发出来 —— 它们可能有副作用，而且那样这份 JS 依然可读。 */
      case 'CCall': {
        if (e.raw === true && e.sig !== undefined && e.sig !== null) return this.cCall(e);
        const args = e.args.map((a) => this.rvalue(a, a.type)).join(', ');
        /* 名字：构建期封闭表里的那些用表上的**真符号名**（`c_strlen` -> `strlen`），
           源码里声明的那些（`(cabi …)`，ADR-0022 的 J4b）名字本身就是符号名 ——
           从前这儿一律查表，撞上后一种就是 `C_ABI[…].sym` 读到 undefined 上，
           一个 TypeError 代替了本该有的那句诊断。 */
        const known = C_ABI[e.entry];
        const sym = known === undefined ? e.entry : known.sym;
        return `$js_cabi_unavailable(${JSON.stringify(sym)}${args ? `, ${args}` : ''})`;
      }
      default: throw new Error(`js.expr: ${e.kind}`);
    }
  }

  /**
   * `(ccall …)` -> `$cffi.<符号>(…)`（ADR-0038）。
   *
   * 三件事在这儿定：**定参按声明的那一格 C 类型摆**、**地址在这一侧算**（偏移加基址，
   * 见 prelude 那侧的 `$fp`/`$ft`/`$fs`/`$fa`）、**变参按 C 的默认实参提升**（整数类
   * 一律 BigInt、浮点一律 number，并把那个形状拼成一格 kinds 串递过去）。
   *
   * 回值：`i64`/`ptr` 从 C 回来是 BigInt，进方言之前过一次 `$CN`（方言的 `int` 是
   * "能用 number 就 number"那种规范形）。别的几格本来就是 JS 的原生值。
   */
  cCall(e) {
    this.cffiUsed = true;
    const ps = e.sig.params;
    const kinds = [];
    const as = [];
    for (let i = 0; i < e.args.length; i++) {
      const a = e.args[i];
      const code = this.rvalue(a, a.type);
      const k = a.type === null || a.type === undefined ? '?' : a.type.k;
      /* 地址那一族（`ptr` 形参，或者变参那一段里的串与指针）：JS 这一侧换算成机器地址。
         `int` 当地址用是 `long win = glfwCreateWindow(…)` 那一格 —— 它本来就是地址。 */
      const addr = k === 'string' ? `$fs(${code})`
        : k === 'ptr' ? `$fp(${code})`
          : k === 'tptr' ? `$ft(${code})` : null;
      if (i < ps.length) {
        const w = ps[i];
        if (w === 'ptr') { as.push(addr === null ? `$fa(${code})` : addr); continue; }
        if (w === 'i32') { as.push(`Number(${code}) | 0`); continue; }
        if (w === 'i64') { as.push(`BigInt(${code})`); continue; }
        as.push(code);            // f64 / f32 / bool 本来就是 JS 的原生值
        continue;
      }
      /* 变参那一段（`...` 之后）：`(cabi …)` 那一侧已经把可以摆的几种挡过一遍
         （整数、real、串、指针），所以这儿只分"整数类还是浮点"。 */
      if (addr !== null) { kinds.push('i'); as.push(addr); continue; }
      if (k === 'real') { kinds.push('d'); as.push(code); continue; }
      kinds.push('i');
      as.push(`BigInt(${code})`);
    }
    if (e.sig.variadic === true) as.unshift(JSON.stringify(kinds.join('')));
    const call = `$cffi.${e.entry}(${as.join(', ')})`;
    const rw = e.sig.ret;
    return (rw === 'i64' || rw === 'ptr') ? `$CN(${call})` : call;
  }

  bin(e) {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    // 向量：逐道走同一条标量表达式。lane 函数由 binCode 拼出来，所以道上的
    // 回绕/除零消息和标量那份是**同一份发射代码**（ADR-0014 决策 6）。
    if (e.opType.k === 'vec') return `$vbin(${a}, ${b}, ${this.laneOp(e.op, e.opType.elem)})`;
    return this.binCode(e.op, e.opType, a, b);
  }

  /** 一道上的标量运算，包成 `(x, y) => …` —— $vbin / $vhsum 的实参 */
  laneOp(op, elem) {
    return `(x, y) => ${this.binCode(op, elem, 'x', 'y')}`;
  }

  /** 二元运算的代码拼装。操作数已经是代码串：标量路径与向量的逐道路径共用它 */
  binCode(op, opType, a, b) {
    if (opType.k === 'int') {
      switch (op) {
        // int 是规范化的 number|BigInt（见 prelude 的文件头）：两个 number 时
        // $iadd/$isub/$imul 走一句浮点加 + 一次范围查，不碰 BigInt。
        case '+': return `$iadd(${a}, ${b})`;
        case '-': return `$isub(${a}, ${b})`;
        case '*': return `$imul(${a}, ${b})`;
        case '/': return `$div(${a}, ${b})`;
        case '%': return `$mod(${a}, ${b})`;
        case '<<': return `$ishl(${a}, ${b})`;
        case '>>': return `$ishr(${a}, ${b})`;
        // 无符号那三个（第六十一刀）：位当无符号 64 位读，算完回规范形。
        // `u>>` 的移位数照旧只取低 6 位 —— 与 `>>` 同一条规矩。
        case 'u/': return `$udiv(${a}, ${b})`;
        case 'u%': return `$umod(${a}, ${b})`;
        case 'u>>': return `$iushr(${a}, ${b})`;
        case '&': return `$iand(${a}, ${b})`;
        case '|': return `$ior(${a}, ${b})`;
        case '^': return `$ixor(${a}, ${b})`;
        default: throw new Error(`js.bin int: ${op}`);
      }
    }
    if (opType.k === 'real') {
      if (op === '%') return `$fmod(${a}, ${b})`;
      return `(${a} ${op} ${b})`;
    }
    if (opType.k === 'string' && op === '+') return `(${a} + ${b})`;
    throw new Error(`js.bin: ${op} on ${opType.k}`);
  }

  builtin(e) {
    const a = e.args.map((x) => this.expr(x));
    const recv = e.recvType;
    // real 上的数学函数：名字里的后缀就是 prelude 里那个 helper（`rmath_sqrt` -> `$r_sqrt`，
    // 转手 Math.*）。名单由核心方言把关（sexpr/lower.js 的 RMATH），这里不再抄一遍。
    if (e.name.startsWith('rmath_')) return `$r_${e.name.slice(6)}(${a.join(', ')})`;
    switch (e.name) {
      case 'print': return `$print($str_${e.argType.k}(${a[0]}))`;
      // `(write E)` —— 不补换行（ADR-0016 第四刀）。$print_raw 与 $print 共用一个缓冲区。
      case 'write': return `$print_raw(${a[0]})`;
      // `(srep S N)`（ADR-0016 第五刀）。n <= 0 回空串 —— String.repeat 在负数上抛异常。
      case 'str_repeat': return `$str_repeat(${a[0]}, ${a[1]})`;
      // `(sbase E 进制)` / `(supper S)`（ADR-0016 第七刀，jancy 的 `%x` / `%X` / `%o` 要）
      case 'str_base': return `$str_base(${a[0]}, ${a[1]})`;
      // `(trunc N E)` / `(zext N E)` / `(sext N E)`（ADR-0031 §8.2）：截到 N 位，64 位是恒等
      case 'int_trunc': return `$int_trunc(${a[0]}, ${a[1]})`;
      case 'int_sext': return `$int_sext(${a[0]}, ${a[1]})`;
      case 'str_upper': return `$str_upper(${a[0]})`;
      // `(sfix E N)`（ADR-0016 第八刀）—— C 的 %.Nf，就近取偶
      case 'str_fixed': return `$str_fixed(${a[0]}, ${a[1]})`;
      // `(ssci E N)`（第三十刀）—— C 的 %.Ne，同一条舍入
      case 'str_sci': return `$str_sci(${a[0]}, ${a[1]})`;
      // `(sgen E N)` / `(sgenk E N)`（第三十一刀）—— C 的 %.Ng / %#.Ng
      case 'str_gen': return `$str_gen(${a[0]}, ${a[1]})`;
      case 'str_genk': return `$str_genk(${a[0]}, ${a[1]})`;
      case 'to_string': return `$str_${e.argType.k}(${a[0]})`;
      case 'to_string_g': return `$str_real_g(${a[0]}, ${a[1]})`;
      case 'trunc': return `$trunc(${a[0]})`;
      // 位重解释（ADR-0019 路 1）：位不动，只换一种读法。
      case 'realbits': return `$realbits(${a[0]})`;
      case 'bitsreal': return `$bitsreal(${a[0]})`;
      // 引用的身份整数：这条腿上是一张 WeakMap 发的号（prelude 的 $refid）
      case 'refid': return `$refid(${a[0]})`;
      case 'chr': return `$chr(${a[0]})`;
      case 'fail': return `$rt_error(${a[0]})`;
      case 'repr': return `$repr_real(${a[0]})`;
      case 'int_of_string': return `$int_of_string(${a[0]})`;
      case 'real_of_string': return `$real_of_string(${a[0]})`;
      case 'read_text': return `$read_text(${a[0]})`;
      case 'get_env': return `$get_env(${a[0]})`;
      case 'write_text': return `$write_text(${a[0]}, ${a[1]})`;
      case 'run_proc': return `$run_proc(${a[0]})`;
      case 'r3_render': return `$r3_render(${a[0]}, ${a[1]})`;
      // JS 有 GC，arena 那一套是空操作
      case 'arena_mark': return '-1';
      case 'arena_release': return `((${a[0]}), 0)`;
      case 'len':
        if (recv.k === 'string') return `$slen(${a[0]})`;
        return recv.k === 'list' ? `${a[0]}.length` : `${a[0]}.size`;
      case 'push': return `${a[0]}.push(${a[1]})`;
      case 'add': return `${a[0]}.add(${a[1]})`;
      case 'pop': return `$listPop(${a[0]})`;
      case 'clear': return `(${a[0]}.length = 0)`;
      case 'contains':
        if (recv.k === 'list') return `${a[0]}.includes(${a[1]})`;
        return `${a[0]}.has(${a[1]})`;
      case 'dictGet': return `$dictGet(${a[0]}, ${a[1]}, ${JSON.stringify(recv.key.k)})`;
      case 'dictSet': return `$dictSet(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'remove': return `${a[0]}.delete(${a[1]})`;
      case 'keys': return `[...${a[0]}.keys()]`;
      case 'items': return `[...${a[0]}]`;
      case 'byteAt': return `$byteAt(${a[0]}, ${a[1]})`;
      case 'substr': return `$substr(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'indexOf': return `$indexOf(${a[0]}, ${a[1]})`;
      case 'join': return `${a[0]}.join(${a[1]})`;
      case 'tag': return `$dynTag(${a[0]})`;
      case 'asInt': return `$CN($dynAs(${a[0]}, "int"))`;
      case 'asReal': return `$dynAs(${a[0]}, "real")`;
      case 'asBool': return `$dynAs(${a[0]}, "bool")`;
      case 'asString': return `$dynAs(${a[0]}, "string")`;
      // 拆回一格函数值：这一侧的函数值就是宿主的函数，查过标签直接交回去
      case 'asFn': return `$dynAs(${a[0]}, "function")`;
      case 'asList': return `$dynAs(${a[0]}, "list")`;
      case 'asDict': return `$dynAs(${a[0]}, "dict")`;
      case 'dynGet': return `$dynGet(${a[0]}, ${a[1]})`;
      case 'dynSet': return `$dynSet(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'dynLen': return `$dynLen(${a[0]})`;
      case 'dynIter': return `$dynIter(${a[0]})`;
      case 'dynPush': return `$dynPush(${a[0]}, ${a[1]})`;
      case 'dynHas': return `$dynHas(${a[0]}, ${a[1]})`;
      case 'dynKeys': return `$dynKeys(${a[0]})`;
      // 深装箱（ADR-0008）：容器在这条腿上就是宿主的 Array / Map，dynamic 又是无标签的，
      // 所以只剩"把里面的 int 换成 BigInt"这一件事（见 Box 那条）。元素里没有 int 时
      // 整条就是恒等，一个字都不发。
      case 'boxDeep': return this.boxDeepJs(e.argType, a[0]);
      case 'dynAdd': return `$dynAdd(${a[0]}, ${a[1]})`;
      case 'dynSub': return `$dynSub(${a[0]}, ${a[1]})`;
      case 'dynMul': return `$dynMul(${a[0]}, ${a[1]})`;
      case 'dynDiv': return `$dynDiv(${a[0]}, ${a[1]})`;
      case 'dynMod': return `$dynMod(${a[0]}, ${a[1]})`;
      case 'dynNeg': return `$dynNeg(${a[0]})`;
      // JS 前端的运算语义与宿主库（ADR-0011）。这些 op 只由 frontend-js/lower.js 产生，
      // Omni 源码里造不出来 —— truthiness 与 `+` 的双重含义不属于 Omni 语言。
      // 这两个不是函数调用，单列；其余一律走 JS_ABI 表，加 op 不用改这里。
      case 'js_undef': return 'undefined';
      case 'js_ofFn': return a[0];
      default: {
        const abi = JS_ALL[e.name];
        if (!abi) throw new Error(`js.builtin: ${e.name}`);
        const lits = (abi.lit ?? []).map((k) => {
          const v = e[k];
          return typeof v === 'string' ? JSON.stringify(v) : String(v === true);
        });
        return `${abi.js}(${[...lits, ...a].join(', ')})`;
      }
    }
  }
}

function fmtRealLit(v) {
  // 负零：`${-0}` 是 `"0"`，符号在这儿会掉。它看得见（`(sfix … (int 2))` 印 `-0.00`），
  // 五条腿要一致，所以这一支单列（C 后端的 cReal 与 LLVM 的 llFloat 各有同一句）。
  if (v === 0 && 1 / v < 0) return '-0.0';
  if (Number.isFinite(v)) return Number.isInteger(v) && Math.abs(v) < 1e21 ? `${v}.0` : String(v);
  return v > 0 ? 'Infinity' : Number.isNaN(v) ? 'NaN' : '-Infinity';
}

/** @param {any} mod OIR 模块 @param {{chunk?: boolean, esm?: boolean, repl?: boolean, trim?: boolean}} [opts] */
export function emitJs(mod, opts) {
  const e = new JsEmitter(mod);
  if (opts !== undefined && opts.chunk === true) e.chunk = true;
  /* `trim: false`：不裁运行时那一段（逃生门 —— 见 `trimJsRuntime` 头上那段账）。 */
  if (opts !== undefined && opts.trim === false) e.trim = false;
  /* `--profile stub`（第一百四十七片第四格）：**发射期插桩**那一档在 js 这条腿上的开关。
   * 与 C 那条腿同一个名字、同一套账 —— 「我们自己插的那一对」两个后端都得有，
   * 不然 `--profile stub --backend js` 就是收下开关然后一声不响（那比报错坏）。 */
  if (opts !== undefined && opts.profile === true) e.prof = true;
  // REPL 的一批：也是片段，区别在模块级变量用 `var`（见 emit() 里那段注释）
  if (opts !== undefined && opts.repl === true) { e.repl = true; e.chunk = true; }
  // ESM 模式一定是片段：它自己就是一个模块文件，入口由**引它的那一份**去调
  if (opts !== undefined && opts.esm === true) { e.esm = true; e.chunk = true; }
  return e.emit();
}

/**
 * 运行时那一份模块（`omni_rt.js`）：prelude 加两张派发表，一整份程序里只有它一个。
 *
 * 末尾把自己的顶层名字全挂到 `globalThis` 上，**不导出**：各个库产物里
 * `$print(…)`、`$W(…)` 是**裸名字**，要让它们在自己那个模块作用域里查得到，
 * 只有两条路 —— 每份产物都写一长串 `import { $print, … }`，或者运行时自己挂上去。
 * 挂上去这条不用维护那张名单（名单一改就是几百个文件全部重发），所以走这条。
 */
export function emitJsRuntimeModule() {
  const e = new JsEmitter({ structs: [], funcs: [], globals: [], entry: '' });
  e.out.push(JS_PRELUDE.trim());
  e.memberDispatch();
  e.callOpDispatch();
  const text = e.out.join('\n');
  const names = [];
  const seen = new Set();
  for (const ln of text.split('\n')) {
    const m = /^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(ln);
    if (m === null || seen.has(m[1])) continue;
    seen.add(m[1]);
    names.push(m[1]);
  }
  const asg = names.map((n) => `${JSON.stringify(n)}: ${n}`).join(', ');
  return `${text}\nObject.assign(globalThis, { ${asg} });\n`;
}

/**
 * **一个函数**的产物文本。增量编译（ADR-0014 决策 5）的缓存条目就是它。
 *
 * 这条路在 JS 后端成立、在 C 后端**不成立**，原因值得记下：C 后端有一个模块级的
 * 字符串字面量池（`emit.js` 的 `constIndex`），函数体里出现的是 `omni_s16_7` 这样的
 * **下标**，于是同一个函数在两个模块里会得到不同的文本 —— 缓存条目就不再是内容寻址的。
 * JS 后端里字面量直接内联，函数体引用外部世界只靠**名字**，所以它可以整段搬走。
 *
 * 这正是决策 5 说「缓存条目 = 目标码 buffer + 重定位信息」的原因：重定位是把
 * 「按下标引用」换成「按符号引用」的那一步，缺了它任何一层都会退化成全量。
 */
export function emitJsFunc(mod, f) {
  const e = new JsEmitter(mod);
  e.func(f);
  return e.out.join('\n') + '\n';
}
