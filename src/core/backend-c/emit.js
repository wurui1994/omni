// Omni stage0 — C 后端：OIR -> C99
//
// C 后端是自举的必经之路，因此它的正确性优先于一切。输出要求：
//   1) 只 #include "omni.h"，运行时是 src/runtime/ 下真正的 C 文件（不再内联进来）；
//      需要单文件时走 `emit-c --amalgamate`
//   2) 可读、可 gdb —— 生成的 C 是给人看的第一手调试材料
//   3) 无编译器扩展（computed goto 等留到 VM 阶段再作为可选开关）
//
// 发射顺序是被 C 的"用前须完整"规则逼出来的，改动前先读懂：
//   运行时 -> 容器/类的指针 typedef -> struct 定义 -> class 定义
//   -> 容器结构体 -> 容器函数 -> struct/class 的零值构造 -> 函数原型 -> 函数体
// 引用类型（容器、class）全是指针 typedef，所以互相嵌套无需任何拓扑假设；
// 只有"按值嵌套"的 struct 需要拓扑排序。

import { RUNTIME_INCLUDE, amalgamate } from '../runtime/c_runtime.js';
import { cTypeName, listType, typeKey, cArrOps, arrIsBlob, loopLabelNeeds, sizeOf } from '../hir/types.js';
import { JS_ABI, JS_ALL, JS_MEMBERS, JS_TAG_C } from '../hir/js_abi.js';
import { C_ABI, C_TYPE, C_IN, C_OUT } from '../hir/c_abi.js';
import { utf8Bytes } from '../host/utf8.js';
import { hash16 } from '../host/hash.js';
import { OmniError } from '../source/diag.js';
import { env } from '../host/native.js';

/** dict/set 的键需要 hash；list.contains 只需要 eq */
const HASH_FN = { int: 'omni_hash_int', real: 'omni_hash_real', bool: 'omni_hash_bool', string: 'omni_hash_string' };
const EQ_FN = {
  int: 'omni_eq_int', real: 'omni_eq_real', bool: 'omni_eq_bool', string: 'omni_eq_string',
  dynamic: 'omni_eq_dyn', class: 'omni_eq_ref',
};
const KSTR_FN = { int: 'omni_kstr_int', real: 'omni_kstr_real', bool: 'omni_kstr_bool', string: 'omni_kstr_string' };
const DYN_TAG = { list: 'OMNI_DYN_LIST', dict: 'OMNI_DYN_DICT' };
// int64 的下界。写成"减一"而不是 -9223372036854775808n：那个正的字面量本身超出 int64，
// 自举的时候（编译器自己被降级成 int64 的世界）读它就会报 invalid integer。
const INT64_MIN_VALUE = -9223372036854775807n - 1n;

/** 向量上第一阶段只有这四条（ADR-0014 决策 6）：算符 -> C 侧助手名的后缀 */
const C_VEC_OPS = [['+', 'add'], ['-', 'sub'], ['*', 'mul'], ['/', 'div']];

/* 切文件时那一家**内容定址**的生成物（字面量池、`list<int>` 这类内建元素的容器实例化、
 * JS 模板、派发器）。只装"与用户类型无关"的那些，所以依赖只有一个朝向：
 * 各单元 -> omni_gen -> 运行时头，它不回头 include 任何单元。 */
const GEN_UNIT = 'omni_gen';

/* 线性内存的访问描述符 -> [内存里那几个字节的 C 类型, 字节数]（ADR-0017 第二刀）。
 * 符号扩展与零扩展不用写代码：`*(int8_t*)p` 提升到 int64_t 就是符号扩展，
 * `*(uint8_t*)p` 就是零扩展 —— 与 DataView 的 getInt8/getUint8 一一对应。 */
const C_MEM_LD = {
  i8s: ['int8_t', 1], i8u: ['uint8_t', 1], i16s: ['int16_t', 2], i16u: ['uint16_t', 2],
  i32s: ['int32_t', 4], i32u: ['uint32_t', 4], i64: ['int64_t', 8],
  f32: ['float', 4], f64: ['double', 8],
};
const C_MEM_ST = {
  i8: ['uint8_t', 1], i16: ['uint16_t', 2], i32: ['uint32_t', 4], i64: ['int64_t', 8],
  f32: ['float', 4], f64: ['double', 8],
};

/** `(blk (blk int 3) 2)` -> `{el: int, n: 6}`：定长内存的字段在 C 侧摊平成一维（第二十二刀） */
function flatBlk(t) {
  let el = t.el;
  let n = t.n;
  while (el.k === 'blk') { n *= el.n; el = el.el; }
  return { el, n };
}

class CEmitter {
  constructor(mod, opts = {}) {
    this.mod = mod;
    this.out = [];
    /* 按源文件的产出分布（P1）：文件路径 -> {funcs, lines, bytes}。
     * `emit-c --stats` 与 `build --stats` 印它 —— 42 万行落在一个翻译单元里时，
     * "是谁撑起来的"这件事从前压根没有答案。P2 分文件发射用的也是这一格分组。 */
    this.stats = new Map();
    /* 分文件发射（P2）：默认关，开了之后
     *   - 生成的函数与它的原型去掉 `static`（跨 TU 要调得到）
     *   - 模块级变量在共用前段里发 extern，定义只留一份
     *   - 三个下标把输出切成"共用前段 / 只发一次的那段 / 每个函数 / 尾巴"
     * 共用前段照抄进每个 TU：没被引用的 static 一份机器码都不生成（量出来 528 字节），
     * 所以复制它只花每个 TU 约 0.46 秒的编译税。带状态的那三样不能复制 —— 见 ADR-0021。 */
    this.perMod = opts.modules === true;
    /* **自足的一份模块**（跨文件模块化那条路，§12 末节）：与 `perMod` 正交 ——
     * `perMod` 说的是"函数外部链接、每家一份 TU"，这一格再说"这一份自己齐全"：
     * 模板（零值构造那一族）发在自己的 `.c` 里、原型进 `.h`，所以**不是 static**
     * （见 `aggLink`），而且这一份**不带 main**。 */
    this.selfMod = opts.selfContained === true;
    /* **外部链接**与**切文件**是两件事（ADR-0021 的 S4）：切文件必然要外部链接，
     * 但"核心把符号导出去给插件用"不需要切文件。所以拆成两格开关。 */
    this.extern = opts.modules === true || opts.extern === true;
    /* `own`：这一份产物**只发**这些文件里的函数与全局，别的只留原型（extern）——
     * 分语言独立构建就是这一格：插件只装它自己那几个模块，其余在加载时绑到核心上。
     * 判据是 P1 的 `f.file` 与（刚补的）`g.file`。 */
    this.own = Array.isArray(opts.own) && opts.own.length > 0 ? opts.own : null;
    /* `bind`：核心那一份**实际留下**的符号集（它 `--extern` 构建时落的 `.syms`）。
     * 每一行是 `符号|源文件` —— **必须带源文件**：mangled 名里的 `__2` 那截是每个程序
     * 各自去重时编的号，跨程序独立编译时同一个名字可能落在**不同函数**上。只按名字绑
     * 量出来是 `dynamic value is (null), expected list` 与 `undefined is not a function`。
     *
     * 为什么 `own` 那套按文件名的规则不够：核心是按根剪过枝的（pruneFuncs），
     * `hir/types.js` 的 `bufType` 在薄核心里没人调，于是压根没发；插件按"不是我的文件
     * 就 extern"发了个外部引用，dlopen 当场报 `symbol not found in flat namespace
     * '_u_bufType'`。剪枝的结果只有核心自己知道，所以这一格必须是**数据**，不是规则。 */
    this.bind = opts.bind instanceof Set && opts.bind.size > 0 ? opts.bind : null;    /** 这一份实际发了哪些符号（`.syms` 就是它）：`符号|源文件`，函数、模块级变量、闭包的 make。 */
    this.syms = [];
    /* 插件（ADR-0021 S4）：不发 main，改发一格 `omni_plugin_init(api)` —— 值是那个
     * 顶层 register 函数的名字。宿主初始化不能重做（见下面发那一句的地方）。 */
    this.plugin = opts.plugin === undefined || opts.plugin === null ? null : opts.plugin;
    this.markA = -1;
    this.markB = -1;
    this.markC = -1;
    this.fnRanges = [];
    /* 认得的函数名（mangled）。stackArgs 只对这些用栈上的实参 list ——
     * 闭包的 make、外部符号那些不在表里，走老路。 */
    this.knownFuncs = new Set();
    for (const f of mod.funcs) this.knownFuncs.add(f.mangled);
    /* 这一份的函数体里叫到了哪些函数（原型那一段按它裁，见 protoLines）。 */
    this.usedFns = new Set();
    /* **按函数**记"叫到了谁"（切文件时 `.c` 的 `#include` 就是它算出来的）：
     * 一个单元引到哪几家 = 它的函数体里叫到的名字落到定义者的那几家。全局的 `usedFns`
     * 答不了这件事 —— 它把整份程序的调用并成了一团，而"include 图要严格等于依赖图"
     * 恰恰要求逐家分开。发函数体时 `curUse` 指向当前这一格。 */
    this.fnUses = new Map();
    this.curUse = null;
    /* `mod.imports` 里 kind `'cfn'` 那几条说的是"**这个闭包归别家**"（JS 腿照它 import
     * `omni_mk_…`）。按模块那一档要跳过它们的**体与 make**：每家各发一份的话链接期就是
     * `符号 '_omni_clo_ref_asy__quot' 定义了两次`（`(fnref f)` 那族薄适配器，两家都引到
     * 同一个函数就各造一份）。原型从别家的 `.h` 来。 */
    this.extClo = new Set();
    if (opts.modules === true) {
      const extFn = new Set();
      for (const im of mod.imports ?? []) {
        if (im.kind === 'fn') extFn.add(im.name);
        if (im.kind !== 'cfn') continue;
        this.extClo.add(`omni_clo_${im.name}`);
        this.extClo.add(`omni_mk_${im.name}`);
      }
      /* `(fnref f)` 的薄适配器（`omni_clo_ref_<f>` + 它的 make）：**每家引到同一个函数就
       * 各造一份**，而 JS 那侧模块作用域隔离所以不冲突、C 这侧是全局符号空间 —— 量出来是
       * `符号 '_omni_clo_ref_asy__quot' 定义了两次`。而且不能改成 static：单件语义
       * （同一个具名函数取出来的值 `f == f` 要真）跨家就假了，那是答案静默地错。
       *
       * 归属判据：**被引用的那个函数归谁，这格适配器就归谁** —— `f` 在 `imports` 里
       * （kind `fn`）就说明它归别家，这一份于是只用它的原型。名字形状是
       * `omni_clo_ref_<被引用函数>`（那是 lower 定的，见 frontend-asy 的 fnref）。 */
      const pre = 'omni_clo_ref_';
      for (const c of mod.closures ?? []) {
        const nm = typeof c.mangled === 'string' ? c.mangled : '';
        if (!nm.startsWith(pre)) continue;
        if (!extFn.has(nm.slice(pre.length))) continue;
        this.extClo.add(nm);
        if (typeof c.make === 'string') this.extClo.add(c.make);
      }
    }
    this.indent = 0;
    this.tmp = 0;
    // 函数级计时（第八十八刀，见 profTable）：`--profile` 或 `OMNI_PROFILE=1` 打开。
    // 关着时 profTable 什么都不发、func/Return 里那两句也不发 —— 生成的 C 逐字节不变。
    // 读环境走封闭 ABI 的 `env`（ADR-0011 决策 2）：`process.env` 只在 node 上有，
    // 自举那条腿发射时会当场拒。
    this.prof = opts.profile === true || env('OMNI_PROFILE') === '1';
    this.profId = -1;
    this.profRetT = 'void';
    // 循环标签栈（第四十刀）。C 里没有带标签的 break，多层跳只能是 goto，而且 break 与
    // continue 要**两个**标签：break 的落点在循环之后，continue 的落点在循环体末尾
    // （落到那儿再自然往下走，`for` 的步进就还会跑）。用不着的那个不发，免得 -Wunused-label。
    this.loops = [];
    this.opts = opts;
    // JS 字符串字面量池（见 s16Lit）。Map 保证发射顺序稳定 —— 自举要逐字节可复现。
    this.s16pool = new Map();
    /* 池子里每条**按形态**记用过没有（见 strLit 那段注释里的量）：s16 那一对（u16 数组 +
       描述符）与 UTF-8 那一对（字节串 + 描述符）各自只在用到时才发。 */
    this.s16need = new Set();
    this.strneed = new Set();
    this.s16At = -1;
    /* 字面量池**跨产物共用**（把每格插件重发一整套池子那件事收掉）。
     *
     * 量出来的：12 格插件的池子合计 2.7 MB，其中与核心重合的 60~100%（target-js 那格
     * 1810 条 1.08 MB 全都在核心里 —— 那是 JS 运行时的模板串）。字面量是**内容寻址**的：
     * 同一个串在哪一份里都是同一份数据，没有"每个程序各自编号"那种歧义（函数名有，见 bind）。
     * 所以核心把池子里每条按 `符号|@s16:<内容哈希>` 记进 `.syms`，插件按哈希查表：
     * 查得着就发一行 `extern`（约 40 字节），查不着才自己发（数组 + 描述符，几百字节）。
     *
     * 哈希用 host/hash.js 的 hash16（64 位、两条方向相反的滚动哈希）：同一个输入在 node
     * 与降级后的两代里给同一个结果，这一格是自举逐字节可复现的前提。真撞了就当场骂 ——
     * 撞了还接着绑等于把**另一个串**当成这个串，那种错查起来要人命。 */
    this.poolBindS16 = new Map();
    this.poolBindStr = new Map();
    /** 这一份要 extern 声明的池子条目：符号 -> 'omni_s16' | 'omni_str'。 */
    this.poolExt = new Map();
    /** 内容哈希 -> 串（撞了要认出来）。 */
    this.poolByHash = new Map();
    /** 串 -> 内容哈希（poolHash 的备忘录，见那儿的量）。 */
    this.hashOf = new Map();
    if (this.bind !== null) {
      for (const row of this.bind) {
        const bar = row.indexOf('|@');
        if (bar < 0) continue;
        const sym = row.slice(0, bar);
        const tag = row.slice(bar + 2);
        if (tag.startsWith('s16:')) this.poolBindS16.set(tag.slice(4), sym);
        else if (tag.startsWith('str:')) this.poolBindStr.set(tag.slice(4), sym);
      }
    }
    // 用到的向量形状（typeKey -> 类型）。和字面量池同一套路：边发射边收，最后回填。
    // 为什么不在 mod 里像 containers 那样先算好：向量没有实例化那一层（没有方法、
    // 没有装箱桥），一个形状要发的就是几个 static inline，边遇边记最省事。
    this.vecs = new Map();
    this.vecAt = -1;
    this.arrAt = -1;
    // 用到的缓冲形状（门槛 7 第一阶段）。和向量共用那个回填位：两者都是"按 (元素) 生成
    // 一小段定义"，分两个位置只会多一处要对齐的顺序。
    this.bufs = new Map();
    // 用到的**聚合元素**数组形状（门槛 2 第八刀：asy 的 pair[]）。标量元素不进这里 ——
    // 那四份在运行时里已经单态好了，这张表只管"要在这份 .c 里包一层"的那些。
    this.arrs = new Map();
    // 内建原型成员表有多少行（0 就不发表，main 里也不登记）
    this.protoMemberN = 0;
  }

  line(s = '') {
    this.out.push(s ? '  '.repeat(this.indent) + s : '');
  }

  /**
   * JS 的字符串字面量：静态 UTF-16 数据，取用时零成本。
   *
   * 以前是 `omni_js_s16(omni_str_new("kind", 4))`，每求值一次就 UTF-8 -> UTF-16 转一遍、
   * 在 arena 里分配一块（omni_js_s16_lit 更狠，还过一次 omni_str_fmt 也就是 printf）。
   * 解释器把 OIR 节点当 dict 读，`e.kind` 这种取字段全是字符串字面量，于是这条成了
   * 原生构建上最热的分配点：量过，原生解释器 90% 的时间在 obj_get/memcmp/of_utf8 上，
   * 500MB 常驻里绝大部分是这些一次性的键。字面量是编译期已知的，转换也就该在编译期做完。
   */
  s16Lit(s) {
    const shared = this.poolBindS16.get(this.poolHash(s));
    if (shared !== undefined) { this.poolExt.set(shared, 'omni_s16'); return shared; }
    const id = this.poolId(s);
    this.s16need.add(id);
    return id;
  }

  /**
   * 同一个字面量的 **UTF-8 孪生体**（`${id}_s`，一格 `omni_str`）。对象的键在字典里就是
   * UTF-8，取属性走它免掉一次转换与分配。
   *
   * 与 `s16Lit` 分开记是为了**别把两份都发出来**：量过核心那份 C —— 池子里每条都发四行
   * （u16 数组 2.46 MB + 字节串 1.02 MB + 两个描述符 0.79 MB = 4.27 MB，占整份 14.86 MB 的
   * 29%），而绝大多数字面量只按一种形态用过。哪一种用过就只发哪一种。
   */
  strLit(s) {
    const shared = this.poolBindStr.get(this.poolHash(s));
    if (shared !== undefined) { this.poolExt.set(shared, 'omni_str'); return shared; }
    const id = this.poolId(s);
    this.strneed.add(id);
    return `${id}_s`;
  }

  /** 字面量的内容哈希（跨产物共用池子的键，见构造器里那段）。 */
  poolHash(s) {
    /* 记住算过的：`s16Lit` / `strLit` 是**按每次用**叫的（一格插件里 6.7 万次），而一份池子
       只有两三千条不同的串。量出来没有这一格时 hash16 + hex8 是 0.5s，占那一趟 14.4s 的 3.5%。 */
    const memo = this.hashOf.get(s);
    if (memo !== undefined) return memo;
    const h = hash16(s);
    const was = this.poolByHash.get(h);
    if (was === undefined) this.poolByHash.set(h, s);
    else if (was !== s) {
      throw new OmniError(`internal: 字面量池的内容哈希撞了（${h}）—— 两个不同的串`
        + '算出同一个键，绑过去就等于把另一个串当成它。换 host/hash.js 的哈希再来');
    }
    this.hashOf.set(s, h);
    return h;
  }

  /** 池子里的本地编号（两种形态共用一个）。 */
  poolId(s) {
    let id = this.s16pool.get(s);
    if (id === undefined) {
      /* 插件那一份要跟核心共处一个符号空间：核心的池子叫 `k_s16_<号>`，而"号"是各自程序
         里的顺序 —— 同名不同物。所以插件自己发的那些换个前缀，免得与 extern 来的那一批
         撞名（撞了 clang 报的是 redeclaration with different linkage，不是"名字重了"）。 */
      id = this.bind === null ? `k_s16_${this.s16pool.size}` : `k_s16_p${this.s16pool.size}`;
      this.s16pool.set(s, id);
    }
    return id;
  }

  /** 用到一个向量形状就记下来，最后在 vecAt 那个位置把它的定义回填进去 */
  noteVec(t) {
    if (t !== undefined && t !== null && t.k === 'vec' && !this.vecs.has(typeKey(t))) {
      this.vecs.set(typeKey(t), t);
    }
    if (t !== undefined && t !== null && t.k === 'buf' && !this.bufs.has(typeKey(t))) {
      this.bufs.set(typeKey(t), t);
    }
    // 聚合元素的数组：形状要记，**元素也要记** —— 元素的那个 struct 只在数组里出现过
    // 的话（只有 anew/apush，没有一处裸的向量表达式），vecLines 就不会发它的定义。
    if (t !== undefined && t !== null && t.k === 'arr' && arrIsBlob(t.elem)) {
      if (!this.arrs.has(typeKey(t))) this.arrs.set(typeKey(t), t);
      this.noteVec(t.elem);
    }
    return t;
  }

  /**
   * 聚合元素的数组：句柄类型是运行时那个 `omni_arr_blob`（长度/容量/增长/越界消息都在
   * omni_arr.c 里，与标量那四份逐字同一套话），这里逐形状包一层，把"格子的地址"变成
   * 一次按元素类型的读或写。
   *
   * 为什么读写留在这一层而不是也塞进运行时：那个结构体（`omni_vec_real_2`）是逐形状
   * 生成在这份 .c 里的，预编译的运行时看不见它。反过来"整份数组实现都逐形状生成"也不行 ——
   * run-llvm 那条腿只能 call 运行时里的符号，增长逻辑就会有两份。
   */
  arrLines() {
    if (this.arrs.size === 0) return [];
    const out = ['/* 聚合元素的数组（ADR-0014 门槛 2 第八刀）：按字节的 blob 实现 + 逐形状的读写 */'];
    for (const t of this.arrs.values()) {
      const n = cArrOps(t);
      const el = cTypeName(t.elem);
      out.push(`static inline omni_arr_blob ${n}_new(int64_t n, ${el} zero) { return omni_arr_blob_new(n, (int64_t)sizeof(${el}), &zero); }`);
      // 读写那三个是**宏**，不是 `static inline`。理由与 omni.h 里的 omni_nullck 同一条：
      // 这条腿默认 -O0（cli.js:1895），而 -O0 的 clang 一个 `static inline` 都不内联、
      // tcc 从来不内联 —— 于是"wrapper 转调头里的 `_i`"这一层只是又加了一次真调用。
      // 剖 bars3（上一版）：`omni_arr_blob_at_i` 853 个栈顶样本、`_len_i` 409、
      // `omni_nullck` 1099，再加这一族 wrapper 自己（`omni_arr_arr_Cpen_len` 255、
      // `_get` 232 …），合起来是四成 CPU 的纯调用开销。宏在预处理期展开，不看优化档。
      // 外部符号（`omni_arr_blob_len/at`）照旧留着给 run-llvm 那条腿 call。
      out.push(`#define ${n}_len(a) omni_arr_blob_len_i(a)`);
      out.push(`#define ${n}_get(a, i) (*(${el} *)omni_arr_blob_at_i((a), (i)))`);
      // 值那一格收成变参：这一族的元素是**聚合**，写进去的值常常是复合字面量
      // （`(omni_vec_real_2){{0.0, 0.0}}`）—— 花括号在预处理器眼里不括逗号，
      // 三参宏会当成"实参给多了"。`__VA_ARGS__` 把逗号一起吞掉。
      // （下标那一格不会有：它是 int。）
      out.push(`#define ${n}_set(a, i, ...) (__extension__({ ${el} omni__v = (__VA_ARGS__); *(${el} *)omni_arr_blob_at_i((a), (i)) = omni__v; omni__v; }))`);
      out.push(`static inline ${el} ${n}_push(omni_arr_blob a, ${el} v) { *(${el} *)omni_arr_blob_push(a) = v; return v; }`);
      out.push(`static inline ${el} ${n}_pop(omni_arr_blob a) { return *(${el} *)omni_arr_blob_pop(a); }`);
    }
    return out;
  }

  /**
   * 每个用到的缓冲形状：`{长度, 指针}` 按值传，加上 new / get / set 三个 static inline。
   *
   * 长度跟着值走（不是"调用方另记一个 n"）：`blen` 在六条腿上都要 O(1) 答得出来，
   * 而这个形状和 GPU 上 StorageBuffer 里的 runtime array + 一个长度 uniform 是对应的。
   * 越界的消息与 list 那句逐字对齐（omni_container.h:50）—— 那句已经在三份实现里
   * 对过一次，照抄比再对一次便宜。
   */
  bufLines() {
    const out = [];
    for (const t of this.bufs.values()) {
      const n = cTypeName(t);
      const el = cTypeName(t.elem);
      const zero = t.elem.k === 'int' ? 'INT64_C(0)' : '0.0';
      const oob = `omni_errorf("buffer index out of range: %lld (length %lld)", (long long)i, (long long)b.n)`;
      out.push(`typedef struct { int64_t n; ${el} *p; } ${n};`);
      out.push(`static inline ${n} ${n}_new(int64_t n) {`);
      out.push(`  if (n < 0) omni_errorf("buffer length cannot be negative: %lld", (long long)n);`);
      out.push(`  ${n} b; b.n = n; b.p = n == 0 ? NULL : (${el} *)omni_alloc((size_t)n * sizeof(${el}));`);
      out.push(`  for (int64_t i = 0; i < n; i++) b.p[i] = ${zero};`);
      out.push('  return b;');
      out.push('}');
      out.push(`static inline ${el} ${n}_get(${n} b, int64_t i) { if (i < 0 || i >= b.n) ${oob}; return b.p[i]; }`);
      out.push(`static inline ${el} ${n}_set(${n} b, int64_t i, ${el} v) { if (i < 0 || i >= b.n) ${oob}; b.p[i] = v; return v; }`);
    }
    return out;
  }

  /**
   * 每个用到的向量形状在 C 侧的定义：一个按值传的定长数组结构体，加几个 static inline。
   *
   * C 备选路径上向量是**标量化**的（ADR-0014 决策 6 唯一许可的合法化）。刻意不用
   * `__attribute__((vector_size(...)))`：那等于把「与 LLVM 那条腿逐位相同」的责任交给
   * clang 的自动向量化，而它不承诺求值顺序 —— 门槛 6 要的恰恰是求值顺序。
   *
   * 每一道上的运算由 binCode 拼出来，和标量表达式是**同一份发射代码**：
   * int 的回绕、除零的消息文本因此不可能在"向量道"和"标量"之间分叉。
   */
  vecLines() {
    if (this.vecs.size === 0) return [''];
    const out = ['/* 定长向量（ADR-0014 决策 6）：结构体按值传 + 逐道标量化 */'];
    for (const t of this.vecs.values()) {
      const n = cTypeName(t);
      const el = cTypeName(t.elem);
      const w = t.lanes;
      out.push(`typedef struct { ${el} l[${w}]; } ${n};`);
      out.push(`static inline ${n} ${n}_splat(${el} x) { ${n} r; for (int i = 0; i < ${w}; i++) r.l[i] = x; return r; }`);
      // 取道走**宏**而不是就地 `.l[i]`：`f(x).l[2]` 是在非左值结构体的数组成员上取下标，
      // C99 里那是没定义的 —— 语句表达式里先绑到一个局部（那是左值）就没这个问题，
      // 与从前搬进函数是同一个理由，但不发调用。
      // 为什么不是 `static inline`：这条腿默认 -O0（cli.js:1895），-O0 的 clang 一个
      // `static inline` 都不内联、tcc 从来不内联。剖 elevation：`omni_vec_real_4_lane`
      // 58 个栈顶样本，函数体就一条取下标 —— pair/triple 的每一次分量读都要过它。
      out.push(`#define ${n}_lane(v, i) (__extension__({ ${n} omni__l = (v); omni__l.l[(i)]; }))`);
      for (const op of C_VEC_OPS) {
        const lane = this.binCode(op[0], t.elem, 'a.l[i]', 'b.l[i]');
        out.push(`static inline ${n} ${n}_${op[1]}(${n} a, ${n} b) { ${n} r; for (int i = 0; i < ${w}; i++) r.l[i] = ${lane}; return r; }`);
      }
      // 严格左到右：((v0+v1)+v2)+v3。浮点加法不结合，所以这个顺序就是规格（门槛 6）
      const step = this.binCode('+', t.elem, 'acc', 'v.l[i]');
      out.push(`static inline ${el} ${n}_hsum(${n} v) { ${el} acc = v.l[0]; for (int i = 1; i < ${w}; i++) acc = ${step}; return acc; }`);
    }
    return out;
  }

  /**
   * 用到的外部 C 符号的 extern 原型（ADR-0014 决策 4）。
   * 不 `#include <stdlib.h>` 之类：那会把别人的整套声明拖进来，而我们只想要这几条，
   * 且原型必须与 `C_ABI` 里写的**逐字一致** —— 声明就在这里，对不对一眼看得见。
   * libc 的那几条在 omni.h 已经 include 的头里也有声明，重复声明同一个原型是合法的。
   */
  cAbiExterns() {
    const used = this.mod.cabi ?? [];
    if (used.length === 0) return [];
    const out = ['/* 外部 C 符号（src/hir/c_abi.js） */'];
    for (let i = 0; i < used.length; i++) {
      const name = used[i];
      /* 模块自己声明的那些（ADR-0022 的 J4b，`mod.cabiSig`）：签名从**源码**来，
         符号名就是那个名字本身 —— 构建期那张封闭表里没有它。jancy 的 `opaque class`
         宿主方法走的是这一条。这些一律要发原型：标准头里不会有它们。 */
      const own = (this.mod.cabiSig ?? [])[i];
      if (own !== undefined) {
        /* 变参那一格照 C 写：`printf(int64_t, ...)`。少了 `...` 而调用点给了三个实参，
           C 编译器报的是"实参个数不对"，那句话离原因（声明少了一格）很远。
           C 里 `...` 前面至少要有一格定参，而 `(cabi …)` 那侧已经把这条挡住了。 */
        const ps = own.params.length > 0 ? own.params.map((p) => C_TYPE[p]).join(', ') : 'void';
        const all = own.variadic === true ? `${ps}, ...` : ps;
        out.push(`extern ${C_TYPE[own.ret]} ${name}(${all});`);
        continue;
      }
      const sig = C_ABI[name];
      if (sig.std) continue;   // 标准头已经声明过，见 c_abi.js 里 std 的说明
      const ps = sig.params.length > 0 ? sig.params.map((p) => C_TYPE[p]).join(', ') : 'void';
      out.push(`extern ${C_TYPE[sig.ret]} ${sig.sym}(${ps});`);
    }
    return out.length > 1 ? out : [];
  }

  s16PoolLines() {
    const out = [];
    /* 绑到别人（核心）那一份上的：只发一行声明。数据在核心的镜像里，插件不再自带一份。 */
    for (const [sym, ty] of this.poolExt) out.push(`extern const ${ty} ${sym};`);
    /* 自己发的那些。`--extern` 的产物（核心）里池子要**外部链接** —— 插件按内容哈希绑它。
       底下的 `_u` / `_b` 数组照旧 static：只有描述符会被别人引用，数组是它的初始化式。
       按模块那一档是例外：模板会抄进每个 TU，外部链接就成了重复定义（ld 报 duplicate
       symbol）。切文件那一档里池子照旧 static —— 没被引用的 static 一份数据都不生成。 */
    const link = this.extern && !this.perMod ? '' : 'static ';
    const share = link === '';
    for (const [s, id] of this.s16pool) {
      /* 只发**用过的那一种形态**（见 strLit 那段注释里的量）。两种都没用过的不可能存在：
         进池子只有 s16Lit / strLit 两条路。 */
      if (this.s16need.has(id)) {
        const units = [];
        /* 十进制、逗号后不留空格：这一格是**整份 C 里最大的一块文本**（核心里 2.46 MB）。
           `0x6c, ` 是 6 个字符，`108,` 是 4 —— 同样的数据少三分之一。生成的 C 不是给人读的
           主要面（要读的是函数体），这一格换成紧的写法很值。 */
        for (let i = 0; i < s.length; i++) units.push(`${s.charCodeAt(i)}`);
        // 空串也得有个合法的数组：C 里 {} 不是有效的初始化式
        out.push(`static const uint16_t ${id}_u[] = {${units.length > 0 ? units.join(',') : '0'}};`);
        out.push(`${link}const omni_s16 ${id} = { ${id}_u, ${s.length} };`);
        if (share) this.syms.push(`${id}|@s16:${this.poolHash(s)}`);
      }
      if (this.strneed.has(id)) {
        const bytes = utf8Bytes(s);
        out.push(`static const char ${id}_b[] = ${cString(bytes)};`);
        out.push(`${link}const omni_str ${id}_s = { ${id}_b, ${bytes.length} };`);
        if (share) this.syms.push(`${id}_s|@str:${this.poolHash(s)}`);
      }
    }
    return out;
  }

  emit() {
    const aggs = this.sortAggregates();
    const enums = this.mod.enums ?? [];
    const classes = this.mod.classes ?? [];
    const containers = this.mod.containers ?? [];
    const closures = this.mod.closures ?? [];
    const fnTypes = this.mod.fnTypes ?? [];

    this.out.push(this.opts.amalgamate ? amalgamate().trim() : RUNTIME_INCLUDE);
    this.line();
    for (const t of containers) this.line(`OMNI_REF_DECL(${cTypeName(t)})`);
    for (const c of classes) this.line(`OMNI_REF_DECL(ct_${c.name})`);
    this.line();
    // 字符串字面量池的落点：只需要 omni.h 里的 omni_s16，所以放在最前面（内容最后回填）
    this.s16At = this.out.length;
    this.line();
    for (const line of this.cAbiExterns()) this.line(line);
    // 向量的定义位（内容最后回填）：放在聚合体之前，将来 struct 里能按值嵌套向量
    this.vecAt = this.out.length;
    this.line();
    for (const a of aggs) {
      if (a.k === 'struct') this.structBody(a.t);
      else this.enumBody(a.t);
    }
    for (const c of classes) this.classBody(c);
    /* **聚合元素的数组**那一段的落点：必须在结构体/枚举的**本体**之后 ——
       `omni_arr_SP_new` 里有 `sizeof(s_P)`、`*(s_P *)…` 这些要**完整类型**的东西。
       向量那一段（`vecAt`）反过来要在聚合体之前（struct 里能按值嵌套向量），
       所以这是两个落点，不是一个。判据：`(arr 结构体名)` 那格从前发在 `vecAt` 上，
       clang 当场报 `declaration expected`（结构体还没定义）。 */
    this.arrAt = this.out.length;
    this.line();
    for (const t of containers) this.containerBody(t);
    this.line();
    for (const t of CEmitter.defineOrder(containers)) this.containerDefine(t);
    /* dyn 桥与 JS 那一族模板（含三格派发器的坑）**整段归 omni_gen**：它们要的具体类型是
     * `list<dynamic>` 与 `dict<string,dynamic>`，与用户类型无关，名字完全由内容定。
     * 状态不在模板里（三张锁表已经搬进运行时，见 omni_js_obj.h），所以每个 TU 一份 static
     * 副本是无害的 —— 没被引用的 static 一个字节都不生成。 */
    this.dynAt0 = this.out.length;
    this.dynBridge(containers);
    this.dynAt1 = this.out.length;
    // 深装箱助手（print(list<int>) 之类，ADR-0008）：先全部前置声明，再出函数体 ——
    // 嵌套容器的内外顺序不用管，交给前置声明
    const boxDeeps = this.mod.boxDeeps ?? [];
    for (const t of boxDeeps) this.line(`static omni_dyn omni_box_${cTypeName(t)}(${cTypeName(t)} a);`);
    for (const t of boxDeeps) this.boxDeepFn(t);
    this.line();
    for (const c of closures) this.closureBody(c);
    for (const t of fnTypes) this.fnCallHelper(t);
    this.line();
    /* 零值构造那一段的范围（`zeroAt0`..`zeroAt1`）：这一族在发射时会**惰性地**把彼此发出来
     * （`zeroOf` 里嵌套的那一层），所以自足模块那条路只能**按范围切**，不能用 `capture`
     * 重发一遍 —— 重发出来的样子是函数头套在自己里面
     * （`ct_knot omni_new_C_knot(void) { ct_knot omni_new_C_knot(void) {`）。 */
    this.zeroAt0 = this.out.length;
    // 零值构造按拓扑序发：enum 的零值要调它第一个变体载荷的零值构造，struct 反过来也一样
    for (const a of aggs) {
      if (a.k === 'struct') this.structNew(a.t);
      else this.enumNew(a.t);
    }
    for (const e of enums) this.enumMakers(e);
    for (const c of classes) this.classNew(c);
    this.zeroAt1 = this.out.length;
    // JS 前端的模块级变量（ADR-0011）：顶层函数要能互相看见，所以是真全局，
    // 不是 omni_main 的局部量。初值一律 undefined，赋值发生在 omni_main 里。
    /* 分文件时模块级变量是**唯一一格真共享的状态**：共用前段里只发 extern，定义在
     * "只发一次"那段（见构造器那条注释与 ADR-0021 的配方）。复制它就是复制状态。 */
    const gdefs = [];
    for (const g of this.mod.jsGlobals ?? []) {
      const def = `omni_dyn g_${g.name} = { .tag = OMNI_DYN_UNDEF };`;
      if (this.extern) {
        this.line(`extern ${def.slice(0, def.indexOf(' =') )};`);
        const mine = this.emitsSym(`g_${g.name}`, g.file);
        gdefs.push(mine ? def : null);
        if (mine) this.noteSym(`g_${g.name}`, g.file);
      } else this.line(`static ${def}`);
    }
    // 核心方言的模块级变量（第二十四刀）：有类型，所以发的是那个类型的静态量。
    // 不给初值 —— C 的静态存储本来就零，而真正的初值是 omni_main 最前面那几句赋值
    // （字符串的"零"是个池子里的空串常量，那不是常量表达式，只能在运行时赋）。
    for (const g of this.mod.globals ?? []) {
      const def = `${cTypeName(g.type)} g_${g.name};`;
      if (this.extern) {
        this.line(`extern ${def}`);
        const mine = this.emitsSym(`g_${g.name}`, g.file);
        gdefs.push(mine ? def : null);
        if (mine) this.noteSym(`g_${g.name}`, g.file);
      } else this.line(`static ${def}`);
    }
    this.profTable();
    /* 原型：**这一份用得着的那些**才发（ADR-0021 的 S4）。整份程序有 5891 个函数，而一格
       插件自己发的加自己叫到的通常只有几百个 —— 从前每格插件都重发一整套（核心里 3 万行）。
       与字面量池同一个手法：先占一行，等函数体发完、`useFn` 记全了再回填。 */
    this.protoAt = this.out.length;
    this.line('');
    /* 闭包的 make 也要跨 TU 调得到：原型进共用前段，定义留在"只发一次"那段 ——
     * 单例闭包的 `static omni_fn one` 是状态，复制它 `f === f` 会假。 */
    if (this.extern) for (const c of closures) this.line(`${this.closureProto(c)};`);
    this.line();
    this.markA = this.out.length;
    for (const d of gdefs) if (d !== null) this.line(d);
    for (const c of closures) {
      const cf = this.fileOfMangled(c.mangled);
      if (!this.emitsSym(c.make, cf)) continue;
      this.closureMake(c);
      this.noteSym(c.make, cf);
    }
    /* `fn.name`/`fn.length` 那张表（见 fnMetaTable）：切文件那一档**按单元分片发**
     * （headers 里），因为表里每条都要取一个函数的地址，而取**别的 TU** 里的函数的地址
     * 要一条我们的后端还没有的重定位（CALL 那条有）。所以这儿只留一格坑。 */
    const fnMetaN = this.perMod ? 0 : this.fnMetaTable(closures);
    /* 按源文件记一笔产出（P1）：每个函数发了多少行、多少字节。
     * `--stats` 靠它印"42 万行是哪几个源文件撑起来的" —— 单体构建里这件事从前压根看不见，
     * 而它同时也是 P2 分文件发射的分组依据（`f.file` 来自 lower.js 的 fileOfSpan）。
     * 只在这一格量：字面量池、容器实例化、成员派发器那些是**整份程序共用**的，摊给谁都不对，
     * 所以它们归到 stats 的 '(shared)' 那一行里（见 cli.js 印表那儿）。 */
    this.markB = this.out.length;
    for (const f of this.mod.funcs) {
      /* 归别家的闭包体：只在那一家发（见构造器里 extClo 那段）。 */
      if (this.extClo.has(f.mangled)) continue;
      /* 不属于这一份的：原型已经发过（extern 模式下就是外部声明），体不发 —— 加载时绑到核心那一份上 */
      if (!this.emitsSym(f.mangled, f.file) && !this.isEntry(f)) continue;
      this.noteSym(f.mangled, f.file);
      const i0 = this.out.length;
      /* 这一格函数叫到了谁：切文件时 `<单元>.c` 的 `#include` 由它算（见 headers）。 */
      const use = new Set();
      this.curUse = use;
      this.func(f);
      this.curUse = null;
      this.fnUses.set(f.mangled, use);
      let bytes = 0;
      for (let i = i0; i < this.out.length; i++) bytes += this.out[i].length + 1;
      const k = typeof f.file === 'string' && f.file !== '' ? f.file : '(unknown)';
      const s = this.stats.get(k) ?? { funcs: 0, lines: 0, bytes: 0 };
      s.funcs += 1;
      s.lines += this.out.length - i0;
      s.bytes += bytes;
      this.stats.set(k, s);
      this.fnRanges.push({ file: k, i0, i1: this.out.length, bytes });
    }
    this.markC = this.out.length;
    // 线性内存的 data 段（ADR-0017 第二刀）：字节发成 static 数组，main 里一次拷进去。
    // 与 backend-llvm 的 private constant、backend-js 的数组字面量是同一件事的三种写法。
    const mem = this.mod.mem === undefined ? null : this.mod.mem;
    if (mem !== null) {
      let di = 0;
      for (const d of mem.data) {
        this.line(`static const unsigned char omni_data_${di}[${d.bytes.length}] = { ${d.bytes.join(', ')} };`);
        di++;
      }
    }
    let memInit = '';
    if (mem !== null) {
      const parts = [`omni_lin_init(${mem.min}, ${mem.max});`];
      let di = 0;
      for (const d of mem.data) {
        parts.push(`omni_lin_data(${d.off}, omni_data_${di}, ${d.bytes.length});`);
        di++;
      }
      memInit = ` ${parts.join(' ')}`;
    }
    // argc/argv 要存下来：process.argv 与"我装在哪"（import.meta.url 的对应物）都要它。
    // 退出码走 omni_host_exit_code —— process.exitCode 是个可写的槽，不是返回值。
    // 入口过一层 omni_run_entry：那一层把活挪到一条大栈的线程上（见 omni_js_host.c）。
    const profReg = this.prof && this.mod.funcs.length > 0 ? ' atexit(omni_prof_dump);' : '';
    // fn.name / fn.length 那张表（见 fnMetaTable）：登记一次，之后 `f.name` 就按 fp 查它
    /* fn.name / fn.length 那张表的登记：单体一句登记整张；切文件那一档留一格坑，
       `headers()` 把它换成"各单元各自的那一段各登记一次"（见那儿）。 */
    const fnMetaReg = this.perMod ? '/*@fnmeta@*/'
      : (fnMetaN > 0 ? ` omni_js_fnmeta_set(omni_js_fnmeta_tbl, ${fnMetaN});` : '');
    const strHookReg = this.dynSegs === true ? ' omni_js_prim_hook_init_();' : '';
    // 内建原型上那 93 格成员的表（见 protoMembers）：登记一次，之后读成员就查它。
    // **这一句要等 fillMembers 之后才知道发不发**（表是留坑回填的），所以先留一格标记，
    // 在下面 `fillMembers()` 之后换掉 —— 见那儿的账。
    const pmReg = '/*@pm@*/';
    let mainAt = -1;    // main 那一行落在 out 的哪一格（下面回填 pmReg 用）
    if (this.plugin !== null) {
      /* 插件那一支：**不发 main**，也不做宿主初始化 —— `omni_host_init` 与那几格 hook
       * 核心早做过了，重做一遍会把共享的运行时状态（realm / 原型那两张表）重新播一遍种，
       * 已经造出来的对象身份当场就不对了。这里只做两件事：跑一遍**这一份**的模块级语句
       * （`omni_main`，那是它自己的 let / const），然后把 api 递给它的 register。
       * `once_`：同一格插件被装两遍时模块级语句也只跑一次。 */
      let reg = null;
      for (const f of this.mod.funcs) if (f.name === this.plugin) reg = f;
      if (reg === null) {
        throw new OmniError(`--plugin ${this.plugin}：这份程序里没有这个顶层函数`
          + '（插件的入口要是一个 export 出来的顶层函数，比如 registerAsyLang）');
      }
      /* 顶层函数的签名就是"一格实参 list"（闭包才多一格 self_，见 proto）。
       * 形状不对就**响着拒** —— 悄悄少传一个参数在 C 那侧是能编过去的。 */
      if (!Array.isArray(reg.params) || reg.params.length !== 1) {
        throw new OmniError(`--plugin ${this.plugin}：它得收**一格**参数（那格 api），`
          + `现在是 ${Array.isArray(reg.params) ? reg.params.length : '?'} 格`);
      }
      /* 这两个名字在这一句里被叫到，原型那一段得留着（见 protoLines）。 */
      this.useFn(this.mod.entry);
      this.useFn(reg.mangled);
      /* 计时表也要在插件这一支登记（`OMNI_PROFILE=1`）：核心那侧是 main 里 atexit，插件没有
         main，从前于是**一格插件的函数都进不了榜** —— 而语言前端与后端全在插件里，量出来
         核心榜上 `u_compileFront` 自用 8.3s 那一坨其实大半是插件的活，看不见。
         atexit 挂在装载时：dylib 一直活到进程退出，回调有效。 */
      this.line(`omni_dyn omni_plugin_init(omni_dyn api) { static bool once_ = false;`
        + ` if (!once_) { once_ = true;${profReg} ${this.mod.entry}(); }`
        + ` return ${reg.mangled}(&(struct omni_list_dynamic_s){ (omni_dyn[]){ api }, 1, 1 }); }`);
    } else {
      this.useFn(this.mod.entry);
      this.line(`int main(int argc, char **argv) { omni_host_init(argc, argv);${profReg}${fnMetaReg}${strHookReg}${pmReg}${memInit} omni_run_entry(${this.mod.entry}); omni_js_check_uncaught(); fflush(stdout); return omni_host_exit_code(); }`);
      mainAt = this.out.length - 1;
    }
    /* 那格按名字调 op 的派发器：**这份程序真用到才填**（见 `callOpAt` 头上那段账）。
     * 要在 s16 池之前 —— 填它的时候可能还会往池里加字面量。 */
    this.fillCallOp();
    this.fillMembers();
    /* main 里那句 `omni_js_pm_init_()` —— **发不发要等 fillMembers 之后才知道**：
     * 那张表是留坑回填的（task #42），`protoMemberN` 在上面攒 main 那一刻必然还是 0。
     * 从前就在那儿判，于是这句登记**一次也没发出来**，`omni_js_pm_find_g` 永远是 NULL，
     * 读一格原型上没有的成员（`a["foo"]`、`a[-1]`）就撞在 omni_js_obj.h:1766 的
     * "还没搬到 C 那条腿"上 —— 而规范的答案是 undefined（node 与解释器腿都给 undefined）。
     * 量出来的：`npm run fix:self` 在原生腿上停在 `reading '-1' off Array.prototype`。 */
    if (mainAt >= 0) {
      this.out[mainAt] = this.out[mainAt]
        .replace('/*@pm@*/', this.protoMemberN > 0 ? ' omni_js_pm_init_();' : '');
    }
    this.out[this.s16At] = this.s16PoolLines().join('\n');    this.out[this.protoAt] = this.protoLines().join('\n');
    // 三段各自 concat 一次：封闭 ABI 里 `concat` 的 arity 是 2（js_abi.js），
    // 写成 `concat(a, b)` 两个实参在自举出来的编译器上不是同一件事
    this.out[this.vecAt] = this.vecLines().concat(this.bufLines()).join('\n');
    this.out[this.arrAt] = this.arrLines().join('\n');
    return this.out.join('\n') + '\n';
  }

  /**
   * 闭包记录（ADR-0010）。第一个字段必须是 `fp`，与 `struct omni_closure_s` 布局一致 ——
   * 调用助手只认得那一个字段，捕获的部分由被调函数自己按本布局解释。
   */
  closureBody(c) {
    this.line(`struct ${c.mangled}_env {`);
    this.indent++;
    this.line('omni_fnptr fp;');
    for (const f of c.captures) this.line(`${cTypeName(f.type)} c_${f.name};`);
    this.indent--;
    this.line('};');
  }

  /**
   * fn.name / fn.length 的表（ADR-0020 P1-c）。函数在这个值域里还不是真对象，这两格是
   * Function.prototype 上的两个访问器；JS 那条腿把值存在闭包记录里（`$nm` / `$ln`），
   * 而这条腿的记录是"函数指针 + 捕获"，加两个字段就得动每一份记录的布局与每一处捕获的下标。
   *
   * 所以按**模板**走：同一个模板发出来的每一格函数，名字与形参个数都一样（bind 出来的那种
   * 这条腿上还没有），于是一张按 `fp` 索引的静态表就够 —— 造闭包那条热路上一点开销都不加。
   * 只有 JS 前端会填 fnName，别的前端这张表是空的（一个字节都不发）。
   * @returns {number} 表里有多少格（0 就不发表，main 里也不登记）
   */
  fnMetaTable(closures) {
    /* 判据是"**是个串**"而不是"不是 undefined"：计算键的方法（`{ [k]() {} }`）的名字
       只有运行期才知道，降级器那儿给的是 **null** —— 按 undefined 判会让 null 漏进来，
       utf8Bytes(null) 当场把宿主炸掉（量出来的：宿主崩是最坏的一档）。 */
    const named = closures.filter((c) => typeof c.fnName === 'string'
      /* 插件只登记**自己发的**那些：表里每条都要拿函数指针，别人的那些既不是它的事，
         又会把整套原型拖进来（那是每格插件 3 万行的来源之一）。 */
      && this.emitsSym(c.make, this.fileOfMangled(c.mangled)));
    if (named.length === 0) return 0;
    this.line(`static const omni_js_fn_meta omni_js_fnmeta_tbl[${named.length}] = {`);
    this.indent++;
    for (const c of named) {
      this.useFn(c.mangled);
      const bytes = utf8Bytes(c.fnName);
      const len = c.fnLen === undefined ? 0 : c.fnLen;
      this.line(`{ (const void *)(omni_fnptr)${c.mangled}, ${cString(bytes)}, ${bytes.length}, ${len} },`);
    }
    this.indent--;
    this.line('};');
    this.line();
    return named.length;
  }

  /**
   * 原型那一段（回填进 `protoAt`）。
   *
   * 不切分、也不 `--bind` 的那份（单体可执行文件）照旧全发：它自己就是全部，一个都不多。
   * 插件那份只发**用得着的**：自己发定义的 + 自己叫到的（`useFn` 在发函数体时记下来的）。
   * 少发一个的后果是 clang 当场骂 `use of undeclared identifier`，所以这一格漏不掉。
   */
  protoLines() {
    const all = this.bind === null;
    const out = [];
    for (const f of this.mod.funcs) {
      if (all || this.usedFns.has(f.mangled) || this.emitsSym(f.mangled, f.file) || this.isEntry(f)) {
        out.push(`${this.proto(f)};`);
      }
    }
    return out;
  }

  /**
   * 零值构造 / 变体构造 / 类的 new 的**存储类**。
   *
   * 按模块那一档不能是 `static`：`mod.imports` 里带着 `struct` / `class` 那几条 ——
   * 别家构造这个类型时调的就是它们，而 `static` 的跨 TU 调不到（症状是链接期
   * `符号 'omni_new_S_P' 没有定义`）。单体那条路照旧 `static`（一份文件里自足）。
   */
  aggLink() {
    /* 一棵合并的树切开那条路（`headers()`）：**只能是 `static`**（试过去掉，当场
     * `elf: 符号 '_omni_new_C_file' 定义了两次`）—— 那条路上模板只发在**类型的家**、
     * 住在那一家的 `.h` 里，靠 `static` 让每个 include 它的 TU 各有一份无状态的副本。
     * 去掉 `static` 就变成"每个 include 它的 TU 一份定义"。结论：**放进 `.h` 的模板永远
     * static**。
     *
     * 自足模块那条路（`moduleFiles()`，§12 末节）反过来：模板发在自己的 `.c` 里、`.h` 只
     * 带原型，所以**不能 static** —— 别家构造这个类型时调的就是它（`box` 那一格量出来的
     * 样子是 `implicit declaration of function 'omni_new_C_drawop3'` 加链接期
     * `macho: 符号 '_omni_new_C_box' 没有定义`：类的家在 asy_builtins，用它的是 gen）。
     * 这里不能指望"每家自足再发一份"：别家的类只作为**接口**进来（`imports` 里那一条只有
     * 名字，没有字段），发不出体来。
     *
     * 留着的一格风险：同一个 by-value 结构进了两家的 `mod.structs` 就是两份定义。那是
     * **链接期当场报**（不是答案静默地错），要治就给它定家（`aggHomes()` 那套）。 */
    return this.selfMod ? '' : 'static ';
  }

  /** 发函数体时记下"叫到了谁"（原型那一段按它裁；`curUse` 那一格是切文件算 include 用的）。 */
  useFn(name) {
    if (typeof name === 'string') this.usedFns.add(name);
    if (typeof name === 'string' && this.curUse !== null) this.curUse.add(name);
  }


  owns(file) {
    if (this.own === null) return true;
    const f = typeof file === 'string' ? file : '';
    for (const p of this.own) if (f.includes(p)) return true;
    return false;
  }

  /**
   * 这个符号由这一份**发定义**吗。两格规则叠着用，缺一不可：
   *   - `own` 说了是我的文件 -> 我发（便宜的先判）。
   *   - 否则查 `bind`：核心留下了**同名同源文件**的那一格就绑过去，否则自己发 ——
   *     带上源文件是必须的，理由在构造器里那段注释。
   */
  emitsSym(sym, file) {
    if (this.own !== null && this.owns(file)) return true;
    if (this.bind !== null) return !this.bind.has(`${sym}|${typeof file === 'string' ? file : ''}`);
    return this.owns(file);
  }

  /** `.syms` 的一行：符号 + 它的源文件。 */
  noteSym(sym, file) {
    this.syms.push(`${sym}|${typeof file === 'string' ? file : ''}`);
  }

  /** 按 mangled 名找它的源文件再判：闭包记录上没有 file，但同名的函数记录上有 */
  ownsFn(mangled) {
    if (this.own === null) return true;
    return this.owns(this.fileOfMangled(mangled));
  }

  /** mangled -> 源文件。闭包的 make 要判归属时用它（闭包记录上没有 file）。 */
  fileOfMangled(mangled) {
    if (this.fileOfFn === undefined) {
      this.fileOfFn = new Map();
      for (const f of this.mod.funcs) this.fileOfFn.set(f.mangled, f.file);
    }
    return this.fileOfFn.get(mangled);
  }

  closureProto(c) {
    const ps = c.captures.map((f) => `${cTypeName(f.type)} c_${f.name}`);
    return `omni_fn ${c.make}(${ps.length ? ps.join(', ') : 'void'})`;
  }

  /**
   * 聚合的**家**与拓扑位次（切文件时算 `#include` 用）。
   * 位次就是 `sortAggregates()` 的序 —— 模板实例"归依赖序里最晚的那一家"靠它比。
   */
  aggHomes() {
    if (this.homesMemo !== undefined) return this.homesMemo;
    const order = this.sortAggregates();
    const rank = new Map();
    const home = new Map();
    order.forEach((a, i) => {
      rank.set(`${a.k}:${a.t.name}`, i);
      home.set(`${a.k}:${a.t.name}`, modUnitName(a.t.file));
    });
    /* class 是引用语义（指针 typedef），不进按值嵌套那张序 —— 排在所有 struct/enum 之后：
     * 它的字段可以按值放 struct，反过来不成立。 */
    let n = order.length;
    for (const c of this.mod.classes ?? []) {
      rank.set(`class:${c.name}`, n++);
      home.set(`class:${c.name}`, modUnitName(c.file));
    }
    this.homesMemo = { order, rank, home };
    return this.homesMemo;
  }

  /** 一个类型里出现的用户聚合（递归进容器 / 数组 / 定长块 / 指针 / 向量的元素）。 */
  aggsIn(t, out = new Set()) {
    if (t === null || typeof t !== 'object') return out;
    if (t.k === 'struct' || t.k === 'enum' || t.k === 'class') out.add(`${t.k}:${t.name}`);
    for (const k of ['elem', 'el', 'key', 'val', 'ret', 'to', 'of']) {
      if (t[k] !== undefined && t[k] !== null) this.aggsIn(t[k], out);
    }
    if (Array.isArray(t.params)) for (const p of t.params) this.aggsIn(p, out);
    return out;
  }

  /** 一个聚合**自己的字段**里出现的别的聚合（跨家就是一条 `#include` 边）。 */
  aggDeps(a) {
    const out = new Set();
    const self = `${a.k}:${a.t.name}`;
    const fields = a.k === 'enum'
      ? (a.t.variants ?? []).flatMap((v) => v.fields)
      : (a.t.fields ?? []);
    for (const f of fields) this.aggsIn(f.type, out);
    out.delete(self);
    return out;
  }

  /**
   * 生成物（容器实例化、聚合元素数组、向量、装箱助手…）落在哪一家：
   * **它涉及的用户类型的家**，涉及多家就归依赖序里最晚的那一家；不涉及用户类型的归 `omni_gen`。
   * 这一条是"依赖只有一个朝向"的保证 —— `omni_gen` 因此不必回头 include 任何单元。
   */
  homeOfGen(t) {
    const { rank, home } = this.aggHomes();
    let best = -1;
    let unit = GEN_UNIT;
    for (const key of this.aggsIn(t)) {
      const r = rank.get(key);
      if (r === undefined || r <= best) continue;
      best = r;
      unit = home.get(key);
    }
    return unit;
  }

  /**
   * 把一段发射收到独立的缓冲里（`headers()` 从模型生成头时用）。
   * 只在 `emit()` 跑完之后调：那时向量 / 池子那几个集合已经稳定，重跑一遍只出文本。
   */
  capture(fn) {
    const save = this.out;
    const ind = this.indent;
    this.out = [];
    this.indent = 0;
    fn();
    const got = this.out;
    this.out = save;
    this.indent = ind;
    return got;
  }

  /**
   * **自足的一份模块**：`{h, c}` —— 跨文件模块化那条路的发射单位（§12 末节）。
   *
   *   `.h` 只装**接口**：带各自 guard 的指针 typedef、向量/缓冲那一族、它定义的聚合体、
   *        `extern` 全局、它的函数原型。
   *   `.c` 装**实现**：`#include "<自己>.h"` + `mod.imports` 里每个 `from` 一行 include
   *        + 模板（字面量池、容器实例化、arr 族、装箱、零值构造、闭包、dyn 桥 —— 全 static，
   *          由这一份**自足**发）+ 全局定义 + 函数体（+ 入口那一份的 main）。
   *
   * 与 `headers()` 的差别：那一份切的是"一棵合并过的树"，模板只能发在类型的家、还得放进
   * `.h` 让别家看得见（于是 `.h` 里混着实现）。这一份收的是**本来就独立的一段**，模板各家
   * 自足 —— `.h` 于是真的只有接口，也不需要 `omni_gen` 那份公用头。
   */
  moduleFiles(name) {
    if (!this.perMod) throw new Error('c.moduleFiles: 要按模块那一档（modules: true）');
    const gu = `OMNI_U_${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_H`;
    const aggs = this.sortAggregates();
    const classes = this.mod.classes ?? [];
    const containers = this.mod.containers ?? [];
    const closures = this.mod.closures ?? [];
    /* 每条 typedef 自带一格 guard：两家都用 `list<int>` 时两份 `.h` 里都有那一行，
       而 C99 不允许重复 typedef。标准手法，不需要公用头。 */
    const dg = (nm, line) => [`#ifndef OMNI_D_${nm}`, `#define OMNI_D_${nm}`, line, '#endif'];
    const froms = new Set();
    for (const im of this.mod.imports ?? []) froms.add(im.from);
    /* **接口也依赖接口**：这一份的原型里会出现别家的类型（`ct_spec` 那种），所以
       `.h` 里也要 include 它引到的那几家 —— 量出来的样子是
       `01-arith__….h:192: declaration expected`（`ct_spec` 没声明，解析当场错位）。 */
    const H = [`#ifndef ${gu}`, `#define ${gu}`, '', RUNTIME_INCLUDE, ''];
    for (const f of [...froms].sort()) H.push(`#include "${f}.h"`);
    if (froms.size > 0) H.push('');
    /* **指针 typedef 要发全**（不只本家定义的那些）：`.h` 之间会**互相包含**
     * （库调生成物、生成物用库的类型），include guard 让第二次包含变成空 —— 那时对方的
     * 类型还没展开完。量出来的样子是 `gen_….h:312: ';' expected (got 's_asy__new_transform')`
     * （`ct_transform` 在 asy_builtins.h 里，可那一份正卡在"include 我"这一行上）。
     * `typedef struct X_s *X;` 不需要完整定义，谁都能发，各带一格 guard 就不会重复。 */
    const refs = new Set();
    for (const t of containers) refs.add(cTypeName(t));
    for (const c of classes) refs.add(`ct_${c.name}`);
    {
      const ts = new Set();
      for (const f of this.mod.funcs) {
        this.aggsIn(f.ret, ts);
        for (const pp of f.params) this.aggsIn(pp.type, ts);
      }
      for (const g of this.mod.globals ?? []) this.aggsIn(g.type, ts);
      for (const a of aggs) for (const d of this.aggDeps(a)) ts.add(d);
      for (const c of classes) for (const f of c.fields) this.aggsIn(f.type, ts);
      for (const k of ts) if (k.startsWith('class:')) refs.add(`ct_${k.slice(6)}`);
    }
    for (const nm of [...refs].sort()) for (const l of dg(nm, `OMNI_REF_DECL(${nm})`)) H.push(l);
    /* 向量 / 缓冲那一族也各带一格 guard：两家都用 `pair` 时两份 `.h` 里都有那一行
       typedef 与它的 inline 族，而 C 里重复 typedef / 重复定义都不行。量出来的样子是
       `typedef 'omni_vec_real_2' redefined with a different type`。 */
    const dgs = (nm, lines) => {
      if (lines.length === 0) return;
      H.push(`#ifndef OMNI_D_${nm}`, `#define OMNI_D_${nm}`);
      for (const l of lines) H.push(l);
      H.push('#endif');
    };
    for (const [k, t] of this.vecs) {
      const sv = this.vecs;
      this.vecs = new Map([[k, t]]);
      const ls = this.vecLines().filter((l) => l !== '');
      this.vecs = sv;
      dgs(cTypeName(t), ls);
    }
    for (const [k, t] of this.bufs) {
      const sb = this.bufs;
      this.bufs = new Map([[k, t]]);
      const ls = this.bufLines().filter((l) => l !== '');
      this.bufs = sb;
      dgs(cTypeName(t), ls);
    }
    for (const a of aggs) {
      for (const l of this.capture(() => (a.k === 'struct' ? this.structBody(a.t) : this.enumBody(a.t)))) H.push(l);
    }
    for (const c of classes) for (const l of this.capture(() => this.classBody(c))) H.push(l);
    for (const t of containers) for (const l of this.capture(() => this.containerBody(t))) H.push(l);
    for (const g of this.mod.globals ?? []) H.push(`extern ${cTypeName(g.type)} g_${g.name};`);
    for (const g of this.mod.jsGlobals ?? []) H.push(`extern omni_dyn g_${g.name};`);
    for (const l of this.protoLines()) H.push(l);
    /* 本家发的那几格闭包 make 也进接口（别家 `(fnref f)` 到同一个函数时调它）。 */
    for (const c of closures) if (!this.extClo.has(c.make)) H.push(`${this.closureProto(c)};`);
    /* 零值构造 / 变体构造 / 类的 new 的**原型也进接口**：自足那条路上它们发在自己的 `.c`
       里且不是 static（见 aggLink 的账），别家构造这个类型时调的就是它们。原型不另写一套
       签名 —— 直接从发出来那一段的函数头上取（列 0 那几行就是头，体是缩进的）。 */
    for (const l of this.out.slice(this.zeroAt0, this.zeroAt1)) {
      if (/^[A-Za-z_][^\n]*\) \{$/.test(l)) H.push(`${l.slice(0, -2)};`);
    }
    H.push('', '#endif', '');
    /* `.c` 只要自己的 `.h`：别家的接口已经由它带进来了（上面那一段）。 */
    const C = [`#include "${name}.h"`, ''];
    for (const l of this.cAbiExterns()) C.push(l);
    for (const l of this.s16PoolLines()) C.push(l);
    for (const l of this.arrLines()) C.push(l);
    for (const t of CEmitter.defineOrder(containers)) for (const l of this.capture(() => this.containerDefine(t))) C.push(l);
    if (this.dynAt1 > this.dynAt0) for (const l of this.out.slice(this.dynAt0, this.dynAt1)) C.push(l);
    for (const t of this.mod.boxDeeps ?? []) {
      C.push(`static omni_dyn omni_box_${cTypeName(t)}(${cTypeName(t)} a);`);
      for (const l of this.capture(() => this.boxDeepFn(t))) C.push(l);
    }
    for (const t of this.mod.fnTypes ?? []) for (const l of this.capture(() => this.fnCallHelper(t))) C.push(l);
    /* 零值构造 / 变体构造 / 类的 new：**按范围切**（见 emit 里 zeroAt0 那段账）。 */
    if (this.zeroAt1 > this.zeroAt0) {
      for (const l of this.out.slice(this.zeroAt0, this.zeroAt1)) C.push(l);
    }
    for (const c of closures) {
      if (this.extClo.has(c.make)) continue;   // 归别家（见 extClo）
      for (const l of this.capture(() => this.closureBody(c))) C.push(l);
      C.push(`${this.closureProto(c)};`);
      for (const l of this.capture(() => this.closureMake(c))) C.push(l);
    }
    for (const g of this.mod.globals ?? []) C.push(`${cTypeName(g.type)} g_${g.name};`);
    for (const g of this.mod.jsGlobals ?? []) C.push(`omni_dyn g_${g.name} = { .tag = OMNI_DYN_UNDEF };`);
    for (const r of this.fnRanges) C.push(this.out.slice(r.i0, r.i1).join('\n'));
    /* **不带 main**：每一份模块降下来都是"一个程序"，emit 都会给它发一格 main ——
       搬进来就是 `符号 '_main' 定义了两次`。这条路上 `main` 由入口那一份旁边生成的
       `main-<入口>.c` 提供（它按序调各家的 `omni_init_*`，见 cli 的 asyCModsBuild）。 */
    return { h: H.join('\n'), c: `${C.join('\n')}\n` };
  }

  /**
   * 按**模块**切：一个源文件一份 `.c` + 一份同名 `.h`，跟正常的 C 工程一样，
   * **没有公用头**（docs/design/build-system.md §12 末节的定案）：
   *
   *   `<单元>.h` = guard + `#include "omni_gen.h"` + 它依赖的那几家 `.h`
   *               + 它的类型 + 它的模板实例 + 它的 `extern` 全局 + 它的函数原型
   *   `<单元>.c` = `#include "<自己>.h"` + 它引到的那几家 `.h` + 它的全局定义 + 它的函数体
   *
   * "按值嵌套要完整类型"这件事交给 `#include` + include guard：跨单元的拓扑序是头之间的
   * 依赖边，单元内照旧按 `sortAggregates()` 的相对序。于是改一个类型只让 `#include` 到它的
   * 那几家重编 —— 那是标准 C 的代价，不是我们的债。
   */
  headers() {
    if (!this.perMod) throw new Error('c.headers: 只有按模块那一档有头可发');
    if (this.prof) throw new OmniError('按模块编译：计时表还不能按模块分（--profile 先走单体那一路）');
    const { order, home } = this.aggHomes();
    const classes = this.mod.classes ?? [];
    const closures = this.mod.closures ?? [];
    const jsG = this.mod.jsGlobals ?? [];
    const units = new Map();
    /* 闭包的 make 名 -> 它的家（`useFn` 记下的名字里有它，而它不在 `knownFuncs` 里）。 */
    const makeHome = new Map();
    const unit = (nm) => {
      let u = units.get(nm);
      if (u === undefined) {
        /* 一家之内也有次序（C 的"用前须完整"）：指针 typedef -> 类型本体 -> 容器本体 ->
         * 容器实例化 -> 剩下那些要完整类型的（装箱、零值构造、闭包记录…）。
         * **三轮分开发，不是一个容器三件一起发**：`dict<string,dynamic>` 的实例化里要
         * `omni_list_string`（keys 的返回类型），那一格的 typedef 在它后头 —— 量出来是
         * `';' expected (got 'omni_dict_string_dynamic_keys')`。 */
        u = { name: nm, refs: [], types: [], cbody: [], cdef: [], post: [],
          decls: [], gdefs: [], funcs: [], bytes: 0, nfun: 0, needH: new Set(), needC: new Set() };
        units.set(nm, u);
      }
      return u;
    };
    /* 先把每一家坐下来（函数体那一段的分组就是 P1 的 `f.file`），再逐样往里填。
     * `omni_gen` 也要先坐下：底下按家发向量 / 缓冲 / 数组那几段是**遍历 units**的，
     * 它要是还没进表，那几段就会漏掉它 —— 量出来是 `omni_gen.h:21: declaration expected`
     * （`omni_call_fn_…_vec_real_4_…` 用到的 typedef 一个都没发）。 */
    unit(GEN_UNIT);
    for (const r of this.fnRanges) unit(modUnitName(r.file === '(unknown)' ? '' : r.file));
    for (const nm of home.values()) unit(nm);
    const pick = (map, nm) => {
      const m = new Map();
      for (const [k, v] of map) if (this.homeOfGen(v) === nm) m.set(k, v);
      return m;
    };
    const within = (nm, fn) => {      const sa = this.arrs; const sv = this.vecs; const sb = this.bufs;
      this.arrs = pick(sa, nm); this.vecs = pick(sv, nm); this.bufs = pick(sb, nm);
      const got = fn();
      this.arrs = sa; this.vecs = sv; this.bufs = sb;
      return got;
    };
    /* 类型那一段：向量 -> 聚合体 -> class -> 聚合元素的数组 -> 容器 -> 装箱 -> 零值构造。
     * 这个次序就是单体那条路上的次序（C 的"用前须完整"逼出来的），一家之内照样成立。 */
    for (const [nm, u] of units) {
      const vec = within(nm, () => this.vecLines().concat(this.bufLines()).filter((s) => s !== ''));
      for (const s of vec) u.types.push(s);
    }
    for (const a of order) {
      const u = unit(home.get(`${a.k}:${a.t.name}`));
      for (const s of this.capture(() => (a.k === 'struct' ? this.structBody(a.t) : this.enumBody(a.t)))) u.types.push(s);
      for (const d of this.aggDeps(a)) {
        const h = home.get(d);
        if (h !== undefined && h !== u.name) u.needH.add(h);
      }
    }
    for (const c of classes) {
      const u = unit(home.get(`class:${c.name}`));
      u.refs.push(`OMNI_REF_DECL(ct_${c.name})`);
      for (const s of this.capture(() => this.classBody(c))) u.types.push(s);
      for (const f of c.fields) {
        for (const d of this.aggsIn(f.type)) {
          const h = home.get(d);
          if (h !== undefined && h !== u.name) u.needH.add(h);
        }
      }
    }
    for (const [nm, u] of units) {
      for (const s of within(nm, () => this.arrLines())) u.types.push(s);
    }
    for (const t of this.mod.containers ?? []) {
      unit(this.homeOfGen(t)).refs.push(`OMNI_REF_DECL(${cTypeName(t)})`);
    }
    for (const t of this.mod.containers ?? []) {
      const u = unit(this.homeOfGen(t));
      for (const s of this.capture(() => this.containerBody(t))) u.cbody.push(s);
    }
    for (const t of CEmitter.defineOrder(this.mod.containers ?? [])) {
      const u = unit(this.homeOfGen(t));
      for (const s of this.capture(() => this.containerDefine(t))) u.cdef.push(s);
    }
    /* dyn 桥 + JS 那一族模板 + 三格派发器：**整段**归 omni_gen（见 emit 里那段账）。
     * 这一段是 emit 那一趟发好的原文（三格坑已经回填过），照搬 —— 它不是"按单元切出来的
     * 一块"，而是一个整体，而且它的内容只由"这份程序用到哪些模板"决定。 */
    if (this.dynAt1 > this.dynAt0) {
      for (const s of this.out.slice(this.dynAt0, this.dynAt1)) unit(GEN_UNIT).post.push(s);
    }
    /* `fn.name` / `fn.length` 那张按 fp 索引的表（只有 JS 前端会填）：它**引用各家的函数**，
     * 所以不能归 gen（gen 不回头引任何单元）—— 见下面归入口那一家的地方。 */
    for (const t of this.mod.boxDeeps ?? []) {
      const u = unit(this.homeOfGen(t));
      u.post.push(`static omni_dyn omni_box_${cTypeName(t)}(${cTypeName(t)} a);`);
      for (const s of this.capture(() => this.boxDeepFn(t))) u.post.push(s);
    }
    for (const t of this.mod.fnTypes ?? []) {
      const u = unit(this.homeOfGen(t));
      for (const s of this.capture(() => this.fnCallHelper(t))) u.post.push(s);
    }
    for (const a of order) {
      const u = unit(home.get(`${a.k}:${a.t.name}`));
      for (const s of this.capture(() => (a.k === 'struct' ? this.structNew(a.t) : this.enumNew(a.t)))) u.post.push(s);
    }
    for (const e of this.mod.enums ?? []) {
      const u = unit(home.get(`enum:${e.name}`) ?? GEN_UNIT);
      for (const s of this.capture(() => this.enumMakers(e))) u.post.push(s);
    }
    for (const c of classes) {
      const u = unit(home.get(`class:${c.name}`));
      for (const s of this.capture(() => this.classNew(c))) u.post.push(s);
    }
    /* 闭包记录与它的 make：记录（struct）与原型进这一家的 `.h`，make 的**定义**进 `.c` ——
     * 单例闭包里那个 `static omni_fn one` 是状态，复制它 `f == f` 就假了。 */
    for (const c of closures) {
      const u = unit(modUnitName(this.fileOfMangled(c.mangled)));
      makeHome.set(c.make, u.name);
      for (const s of this.capture(() => this.closureBody(c))) u.post.push(s);
      u.decls.push(`${this.closureProto(c)};`);
      for (const s of this.capture(() => this.closureMake(c))) u.funcs.push(s);
      for (const d of this.aggsIn({ params: c.captures.map((f) => f.type) })) {
        const h = home.get(d);
        if (h !== undefined && h !== u.name) u.needH.add(h);
      }
    }
    /* `fn.name`/`fn.length` 的表**按单元分片**：每一段只拿本 TU 里那几个函数的地址
     * （取别的 TU 里的函数的地址要一条我们还没有的重定位），各自一格 `reg` 函数，
     * 入口那一家的 main 里逐个调。运行时那侧的 `omni_js_fnmeta_set` 是追加（omni_js.c）。 */
    const fnMetaRegs = [];
    {
      const byUnit = new Map();
      for (const c of closures) {
        const nm = modUnitName(this.fileOfMangled(c.mangled));
        const g = byUnit.get(nm) ?? [];
        g.push(c);
        byUnit.set(nm, g);
      }
      for (const [nm, g] of byUnit) {
        let n = 0;
        const lines = this.capture(() => { n = this.fnMetaTable(g); });
        if (n === 0) continue;
        const u = unit(nm);
        for (const s of lines) u.funcs.push(s);
        const reg = `omni_js_fnmeta_reg_${nm}`;
        u.funcs.push(`void ${reg}(void) { omni_js_fnmeta_set(omni_js_fnmeta_tbl, ${n}); }`);
        u.decls.push(`void ${reg}(void);`);
        fnMetaRegs.push({ reg, unit: nm });
      }
    }
    /* 模块级变量：`.h` 里 extern，定义留在它自己那一家的 `.c`。 */
    for (const g of jsG) {
      const u = unit(modUnitName(g.file));
      u.decls.push(`extern omni_dyn g_${g.name};`);
      u.gdefs.push(`omni_dyn g_${g.name} = { .tag = OMNI_DYN_UNDEF };`);
    }
    for (const g of this.mod.globals ?? []) {
      const u = unit(modUnitName(g.file));
      u.decls.push(`extern ${cTypeName(g.type)} g_${g.name};`);
      u.gdefs.push(`${cTypeName(g.type)} g_${g.name};`);
      for (const d of this.aggsIn(g.type)) {
        const h = home.get(d);
        if (h !== undefined && h !== u.name) u.needH.add(h);
      }
    }
    /* 原型进这一家的 `.h`（签名里出现别家的类型就 include 那一家）。 */
    for (const f of this.mod.funcs) {
      if (!this.emitsSym(f.mangled, f.file) && !this.isEntry(f)) continue;
      const u = unit(modUnitName(f.file));
      u.decls.push(`${this.proto(f)};`);
      const ts = new Set();
      this.aggsIn(f.ret, ts);
      for (const p of f.params) this.aggsIn(p.type, ts);
      for (const d of ts) {
        const h = home.get(d);
        if (h !== undefined && h !== u.name) u.needH.add(h);
      }
    }
    /* 函数体与"它引到谁"（`.c` 的 include 就是它）。 */
    for (const r of this.fnRanges) {
      const u = unit(modUnitName(r.file === '(unknown)' ? '' : r.file));
      u.funcs.push(this.out.slice(r.i0, r.i1).join('\n'));
      u.bytes += r.bytes;
      u.nfun += 1;
    }
    for (const [mangled, used] of this.fnUses) {
      const u = unit(modUnitName(this.fileOfMangled(mangled)));
      for (const nm of used) {
        /* 我们发的函数看 `f.file`，闭包的 make 看 makeHome；其余（运行时的符号）跳过 —— 
           它们的声明在 omni.h 里，不是哪一家的接口。 */
        const h = this.knownFuncs.has(nm) ? modUnitName(this.fileOfMangled(nm)) : makeHome.get(nm);
        if (h !== undefined && h !== u.name) u.needC.add(h);
      }
    }
    /* `main`（或插件那格 init）与线性内存的 data 段归**入口那一家**；那格
     * `/*@fnmeta@*\/` 的坑在这儿填成"各单元各登记一次"。 */
    const entryUnit = modUnitName(this.fileOfMangled(this.mod.entry));
    const eu = unit(entryUnit);
    const regCall = fnMetaRegs.length === 0 ? ''
      : ` ${fnMetaRegs.map((r) => `${r.reg}();`).join(' ')}`;
    for (const r of fnMetaRegs) if (r.unit !== entryUnit) eu.needC.add(r.unit);
    for (const s of this.out.slice(this.markC, this.out.length)) {
      eu.funcs.push(s.indexOf('/*@fnmeta@*/') >= 0 ? s.replace('/*@fnmeta@*/', regCall) : s);
    }
    eu.needC.add(GEN_UNIT);
    /* 引到别家的**模块级变量**也是一条 include 边（`g_tag` 定义在 b 那一家，a 读它）。
     * 扫一遍正文：全局在 C 里就是 `g_<名字>`，而发射处没有一个统一的钩子能记这件事
     * （读、写、取地址散在十几处）。判前一个字符不是标识符字符，免得 `omni_g_x` 撞进来。 */
    const gUnit = new Map();
    for (const g of jsG) gUnit.set(`g_${g.name}`, modUnitName(g.file));
    for (const g of this.mod.globals ?? []) gUnit.set(`g_${g.name}`, modUnitName(g.file));
    if (gUnit.size > 0) {
      for (const [nm, u] of units) {
        const txt = u.funcs.join('\n');
        let i = txt.indexOf('g_');
        while (i >= 0) {
          let k = i;
          while (k < txt.length && /[A-Za-z0-9_]/.test(txt[k])) k++;
          const pre = i === 0 ? ' ' : txt[i - 1];
          if (!/[A-Za-z0-9_]/.test(pre)) {
            const h = gUnit.get(txt.slice(i, k));
            if (h !== undefined && h !== nm && h !== GEN_UNIT) u.needC.add(h);
          }
          i = txt.indexOf('g_', k > i ? k : i + 1);
        }
      }
    }
    /* 环：`#include` 解不了按值嵌套成环（那是 C 的语义），响着报。 */
    for (const [nm, u] of units) {
      for (const d of u.needH) {
        const other = units.get(d);
        if (other !== undefined && other.needH.has(nm)) {
          throw new OmniError(`按模块编译：模块 ${nm} 与 ${d} 的类型互相按值嵌套，`
            + '头的 include 解不了这种环（C 的语义）—— 两家的类型得先分开');
        }
      }
    }
    const gen = units.get(GEN_UNIT) ?? unit(GEN_UNIT);
    const genH = [
      `#ifndef OMNI_GEN_H`, `#define OMNI_GEN_H`, '',
      this.opts.amalgamate ? amalgamate().trim() : RUNTIME_INCLUDE, '',
      ...this.cAbiExterns(),
      ...this.s16PoolLines(),
      ...gen.refs, ...gen.types, ...gen.cbody, ...gen.cdef, ...gen.post, ...gen.decls,
      '', `#endif`, '',
    ].join('\n');
    const genC = [`#include "${GEN_UNIT}.h"`, ...gen.gdefs, ...gen.funcs, ''].join('\n');
    const out = [];
    for (const [nm, u] of units) {
      if (nm === GEN_UNIT) continue;
      const guard = `OMNI_UNIT_${nm.toUpperCase()}_H`;
      const incH = [...u.needH].filter((d) => d !== GEN_UNIT && units.has(d));
      const h = [
        `#ifndef ${guard}`, `#define ${guard}`, '',
        `#include "${GEN_UNIT}.h"`,
        ...incH.map((d) => `#include "${d}.h"`),
        '', ...u.refs, ...u.types, ...u.cbody, ...u.cdef, ...u.post, '', ...u.decls,
        '', `#endif`, '',
      ].join('\n');
      const incC = [...u.needC].filter((d) => d !== nm && d !== GEN_UNIT && units.has(d) && !u.needH.has(d));
      const c = [
        `#include "${nm}.h"`,
        ...incC.map((d) => `#include "${d}.h"`),
        '', ...u.gdefs, '', ...u.funcs, '',
      ].join('\n');
      /* `deps` 是这一份 `.c` **直接** include 的那几家（含 gen）：编译这一份的输入 =
       * 它自己的正文 + 这几家 `.h` 的正文（传递闭包由调用方算）。`.o` 的缓存键要它 ——
       * 少算一条边就是"改了签名却沿用旧的 `.o`"，那是答案静默地错。 */
      const deps = [GEN_UNIT, ...incH, ...incC];
      out.push({ file: nm, name: nm, funcs: u.nfun, bytes: u.bytes, h, c, deps });
    }
    return { gen: { name: GEN_UNIT, h: genH, c: genC, deps: [] }, units: out };
  }

  closureMake(c) {
    /* 体里要拿 `${c.mangled}` 的函数指针，所以原型那一段得留着它（见 protoLines）。 */
    this.useFn(c.mangled);
    const ps = c.captures.map((f) => `${cTypeName(f.type)} c_${f.name}`);
    this.line(`${this.extern ? '' : 'static '}omni_fn ${c.make}(${ps.length ? ps.join(', ') : 'void'}) {`);
    this.indent++;
    // 带 `single` 的那一格（`(fnref f)` 的薄适配器）发**单件**：同一个具名函数取出来的值
    // 必须是同一个东西，不然 `f == g` 这种按身份比的式子永远为假。量过 asy：具名函数
    // `f == f` 真，而同一个 lambda 求值两次（捕获空的也算）是假 —— 只有这一格缓存。
    if (c.single === true && ps.length === 0) this.line('static omni_fn one = NULL;');
    if (c.single === true && ps.length === 0) this.line('if (one != NULL) return one;');
    this.line(`struct ${c.mangled}_env *e = (struct ${c.mangled}_env *)omni_alloc(sizeof *e);`);
    this.line(`e->fp = (omni_fnptr)${c.mangled};`);
    for (const f of c.captures) this.line(`e->c_${f.name} = c_${f.name};`);
    if (c.single === true && ps.length === 0) this.line('one = (omni_fn)e;');
    this.line('return (omni_fn)e;');
    this.indent--;
    this.line('}');
  }

  /**
   * 每个函数值签名一个类型化的调用助手。为什么不在调用处直接展开强制转换：那样 `f` 会被
   * 求值两次（一次取 fp、一次当 self 传进去），`get_handler()(x)` 就会调用两次 get_handler。
   */
  fnCallHelper(t) {
    const ret = cTypeName(t.ret);
    const decl = t.params.map((p, i) => `${cTypeName(p)} a${i}`);
    const sig = `${ret} (*)(omni_fn${t.params.map((p) => `, ${cTypeName(p)}`).join('')})`;
    const call = `((${sig})omni_fn_ck(f)->fp)(f${t.params.map((_, i) => `, a${i}`).join('')})`;
    this.line(`static inline ${ret} omni_call_${typeKey(t)}(omni_fn f${decl.length ? `, ${decl.join(', ')}` : ''}) {`);
    this.indent++;
    this.line(t.ret.k === 'void' ? `${call};` : `return ${call};`);
    this.indent--;
    this.line('}');
  }

  /**
   * struct 与 enum 一起按"按值嵌套"拓扑排序：C 里按值嵌套要求被嵌套者已是完整类型，
   * 而 struct 的字段可以是 enum、enum 的载荷也可以是 struct，两者必须排在同一张序里。
   * 返回 `{k, t}` 的有序表。环在检查器里已经报过诊断（ADR-0012），这里只留一个断言。
   */
  sortAggregates() {
    const structs = new Map(this.mod.structs.map((s) => [s.name, s]));
    const enums = new Map((this.mod.enums ?? []).map((e) => [e.name, e]));
    const done = new Set();
    const order = [];
    const visit = (t, stack) => {
      if (!t || (t.k !== 'struct' && t.k !== 'enum')) return;
      const key = `${t.k}:${t.name}`;
      if (done.has(key)) return;
      if (stack.has(key)) throw new Error(`recursive aggregate by value: ${t.name}`);
      stack.add(key);
      const inner = [];
      if (t.k === 'struct') {
        for (const f of t.fields) inner.push(f.type);
      } else {
        for (const v of t.variants) for (const f of v.fields) inner.push(f.type);
      }
      for (const it of inner) {
        // 定长内存的字段（第二十二刀）：内嵌的是那 N 格，所以依赖在**元素**那一层，
        // 而且可以套几层（`int[2][3]` 的元素是 `int[3]`）。
        let ty = it;
        while (ty.k === 'blk') ty = ty.el;
        const dep = ty.k === 'struct' ? structs.get(ty.name) : ty.k === 'enum' ? enums.get(ty.name) : null;
        visit(dep, stack);
      }
      stack.delete(key);
      done.add(key);
      order.push({ k: t.k, t });
    };
    for (const s of this.mod.structs) visit(s, new Set());
    for (const e of enums.values()) visit(e, new Set());
    return order;
  }

  /**
   * tagged union（ADR-0012）：`int64_t tag` + 一个 union。tag 用 int64_t 而不是 int，
   * 因为 `EnumTag` 在 OIR 里的类型是 `int`（= i64），这样比较不需要任何转换。
   * 无载荷的变体不进 union —— C99 没有空结构体；全都无载荷时连 union 都不发。
   */
  enumBody(e) {
    const withPayload = e.variants.filter((v) => v.fields.length > 0);
    this.line(`struct e_${e.name}_s {`);
    this.indent++;
    this.line('int64_t tag;');
    if (withPayload.length) {
      this.line('union {');
      this.indent++;
      for (const v of withPayload) {
        const fs = v.fields.map((f) => `${cTypeName(f.type)} f_${f.name};`).join(' ');
        this.line(`struct { ${fs} } v_${v.name};`);
      }
      this.indent--;
      this.line('} u;');
    }
    this.indent--;
    this.line('};');
    this.line(`typedef struct e_${e.name}_s e_${e.name};`);
  }

  /** 零值 = 第一个变体 + 各载荷字段的零值（与 JS 后端的 $new_E 对齐） */
  enumNew(e) {
    this.line(`${this.aggLink()}e_${e.name} omni_new_E_${e.name}(void) {`);
    this.indent++;
    this.line(`e_${e.name} v;`);
    this.line('v.tag = INT64_C(0);');
    for (const f of e.variants[0].fields) {
      this.line(`v.u.v_${e.variants[0].name}.f_${f.name} = ${this.zeroExpr(f.type)};`);
    }
    this.line('return v;');
    this.indent--;
    this.line('}');
  }

  /**
   * 每个变体一个构造函数。不用 C99 的复合字面量 + 指定初始化：那样在
   * `-Wextra` 下会为"union 里没被初始化的成员"报一片 missing-field-initializers。
   */
  enumMakers(e) {
    for (const [i, v] of e.variants.entries()) {
      const ps = v.fields.map((f) => `${cTypeName(f.type)} f_${f.name}`);
      this.line(`${this.aggLink()}e_${e.name} omni_mk_E_${e.name}_${v.name}(${ps.length ? ps.join(', ') : 'void'}) {`);
      this.indent++;
      this.line(`e_${e.name} v;`);
      this.line(`v.tag = INT64_C(${i});`);
      for (const f of v.fields) this.line(`v.u.v_${v.name}.f_${f.name} = f_${f.name};`);
      this.line('return v;');
      this.indent--;
      this.line('}');
    }
  }

  structBody(s) {
    this.line(`struct s_${s.name}_s {`);
    this.indent++;
    // 字段类型里的向量形状也要登记 —— 一个形状只出现在字段上时（结构体里放个 pair，
    // 函数体里一条向量运算都没有），vecLines 那边没别的地方会记下它。回填的位置
    // （vecAt）在结构体本体之前，所以在这里登记来得及。
    for (const f of s.fields) this.line(this.fieldDecl(f.type, `f_${f.name}`));
    this.indent--;
    this.line(`};`);
    this.line(`typedef struct s_${s.name}_s s_${s.name};`);
  }

  /**
   * 一格字段的声明。定长内存那一种（第二十二刀）方括号跟在**名字后面**，所以不能只拼类型名。
   *
   * 多维就摊平成一维：这个 C 结构体只是那段内存的**值**表示，而 arena 那一侧是字节 +
   * 偏移（见 PtrField 那一句 `omni_padd(p, off, 1)`），根本不经过它。要紧的只有尺寸与
   * 对齐，摊平不改这两样 —— `int64_t x[2][3]` 与 `int64_t x[6]` 在 C 里同尺寸同对齐。
   */
  fieldDecl(t, name) {
    /* 匿名 union（ADR-0027）：发一格**真的** C union —— 它的尺寸与对齐正是"最大成员"，
       与这一层算的（hir/types.js 的 sizeOf/alignOf）一模一样，所以这个 C 结构体的自然布局
       与 arena 那一侧的偏移仍旧对得上。成员的名字在这儿无所谓（上面那段：arena 是字节 +
       偏移，根本不经过它）。 */
    if (t.k === 'union') {
      const ms = t.fields.map((f) => this.fieldDecl(f.type, `f_${f.name}`)).join(' ');
      return `union { ${ms} } ${name};`;
    }
    if (t.k !== 'blk') return `${cTypeName(this.noteVec(t))} ${name};`;
    const { el, n } = flatBlk(t);
    return `${cTypeName(this.noteVec(el))} ${name}[${n}];`;
  }

  classBody(c) {
    this.line(`struct ct_${c.name}_s {`);
    this.indent++;
    for (const f of c.fields) this.line(`${cTypeName(this.noteVec(f.type))} f_${f.name};`);
    this.indent--;
    this.line(`};`);
  }

  containerBody(t) {
    const n = cTypeName(t);
    if (t.k === 'list') this.line(`OMNI_LIST_BODY(${n}, ${cTypeName(t.elem)})`);
    else if (t.k === 'dict') this.line(`OMNI_DICT_BODY(${n}, ${cTypeName(t.key)}, ${cTypeName(t.val)})`);
    else this.line(`OMNI_SET_BODY(${n}, ${cTypeName(t.elem)})`);
  }

  /**
   * 容器**实例化**（DEFINE）的次序：**表先、字典与集合后**。
   *
   * 为什么：`OMNI_DICT_DEFINE(…, omni_list_string)` 的体里会调 `omni_list_string_new`
   * （keys 交的是一格表），而那个函数是 `OMNI_LIST_DEFINE` 展开出来的。两者同在一个
   * 翻译单元里，谁在前面就看谁的次序 —— 反了就是"调一个没声明的函数"。
   * tcc 只当警告（C89 的隐式声明），**clang -O2 是硬错**，于是 `--cc clang` 那一列
   * 在 pt 上整趟垮掉（量出来的：`call to undeclared function 'omni_list_string_new'`）。
   * 组内的相对序不动 —— 那一格由 `sortAggregates()` 定。
   */
  static defineOrder(containers) {
    const ls = [];
    const rest = [];
    for (const t of containers) (t.k === 'list' ? ls : rest).push(t);
    return [...ls, ...rest];
  }

  containerDefine(t) {    const n = cTypeName(t);
    if (t.k === 'list') {
      this.line(`OMNI_LIST_DEFINE(${n}, ${cTypeName(t.elem)})`);
      const eq = EQ_FN[t.elem.k];
      if (eq) this.line(`OMNI_LIST_EQ_DEFINE(${n}, ${cTypeName(t.elem)}, ${eq})`);
      return;
    }
    if (t.k === 'dict') {
      this.line(`OMNI_DICT_DEFINE(${n}, ${cTypeName(t.key)}, ${cTypeName(t.val)}, `
        + `${HASH_FN[t.key.k]}, ${EQ_FN[t.key.k]}, ${KSTR_FN[t.key.k]}, ${cTypeName(listType(t.key))})`);
      return;
    }
    this.line(`OMNI_SET_DEFINE(${n}, ${cTypeName(t.elem)}, `
      + `${HASH_FN[t.elem.k]}, ${EQ_FN[t.elem.k]}, ${cTypeName(listType(t.elem))})`);
  }

  /**
   * 深装箱（ADR-0008）：把一个静态容器按元素转成 dynamic。C 侧的容器是单态的，
   * `list<int>` 与 `list<dynamic>` 是两个类型，所以转换函数只能**按类型生成**。
   * JS 侧不需要这一步（那边 dynamic 是无标签的，boxDeep 就是恒等）。
   */
  boxDeepFn(t) {
    const n = cTypeName(t);
    this.line(`static omni_dyn omni_box_${n}(${n} a) {`);
    if (t.k === 'list') {
      this.line('  omni_list_dynamic out = omni_list_dynamic_new();');
      this.line('  omni_list_dynamic_reserve(out, a->len);');
      this.line(`  for (int64_t i = 0; i < a->len; i++) out->items[out->len++] = ${this.boxElem(t.elem, 'a->items[i]')};`);
      this.line('  return omni_dyn_of_ref((void *)out, OMNI_DYN_LIST);');
    } else {
      this.line('  omni_dict_string_dynamic out = omni_dict_string_dynamic_new();');
      this.line(`  ${cTypeName(listType(t.key))} ks = ${n}_keys(a);`);
      this.line('  for (int64_t i = 0; i < ks->len; i++) {');
      this.line(`    omni_dict_string_dynamic_set(out, ks->items[i], ${this.boxElem(t.val, `${n}_get(a, ks->items[i])`)});`);
      this.line('  }');
      this.line('  return omni_dyn_of_ref((void *)out, OMNI_DYN_DICT);');
    }
    this.line('}');
  }

  boxElem(t, expr) {
    switch (t.k) {
      case 'int': return `omni_dyn_of_int(${expr})`;
      case 'real': return `omni_dyn_of_real(${expr})`;
      case 'bool': return `omni_dyn_of_bool(${expr})`;
      case 'string': return `omni_dyn_of_string(${expr})`;
      case 'dynamic': return expr;
      default: return `omni_box_${cTypeName(t)}(${expr})`;
    }
  }

  /**
   * dynamic 的运行期分派桥。只有当 `list<dynamic>` 与 `dict<string,dynamic>` 都实例化了才发射
   * —— 检查器在生成任何 dyn* 操作时都会登记这两个类型，所以需要时一定在。
   */
  dynBridge(containers) {
    const names = new Set(containers.map((t) => cTypeName(t)));
    if (names.has('omni_list_dynamic') && names.has('omni_dict_string_dynamic')) {
      this.line('OMNI_DYN_BRIDGE(omni_list_dynamic, omni_dict_string_dynamic)');
      // JS 宿主库里碰容器的那批 op（ADR-0011）。同一个理由：要具体的容器类型，
      // 所以只能在这两个实例化之后展开。
      this.line('OMNI_JS_ARR(omni_list_dynamic, omni_dict_string_dynamic)');
      // OBJ 在 ARR 之后：Map 的条目值是个两元素 list，要用到 ARR 里的 omni_js_arr_wrap
      this.line('OMNI_JS_OBJ(omni_list_dynamic, omni_dict_string_dynamic)');
      this.line('OMNI_JS_JSON(omni_list_dynamic, omni_dict_string_dynamic)');
      // RE 也在 ARR 之后：回调走 ARR 里的 omni_js_call，match/split 的结果是 list<dynamic>
      this.line('OMNI_JS_RE(omni_list_dynamic, omni_dict_string_dynamic)');
      this.line('OMNI_JS_STR_ARR(omni_list_dynamic, omni_dict_string_dynamic)');
      this.line('OMNI_JS_HOST(omni_list_dynamic, omni_dict_string_dynamic)');
      /* "会调 toString 的转串"那一格（见 omni.h 的 omni_js_str_hook）：`String(o)` / `"" + o`
         里 o 自带 toString 时要调它，而 omni_js.c 造不出实参 list。这儿把段里那份登记进去 ——
         main 里调一次。没这一句的话那条路照旧当场报（不是 JS 那条腿时正是这样）。 */
      this.line('static void omni_js_prim_hook_init_(void) { omni_js_prim_hook_set(omni_js_prim_v); }');
      this.dynSegs = true;
      // 成员派发器：调的全是上面这些宏摊出来的 static 函数，所以只能在这之后生成
      // **留坑**（task #42）：和 callOpAt 同一个手法——先留空行，等函数体发完后扫
      // 哪些 `omni_js_m_*` / `omni_js_p_*` 真被调到了，只生成那几个。
      this.memberAt = this.out.length;
      this.out.push('');
      this.pmAt = this.out.length;
      this.out.push('');
    /**
       * **按名字调 op 那格派发器留一个坑，最后再填**（第一百四十八片第四格）。
       *
       * 量到的账（`bench/fib.js` 823 字节源码 -> 156424 字节 C，190x）：这一格自己
       * **50697 字节 = 那份产物全部函数字节的 52%**，而它的用户只有一个 —— 解释器
       * （op 名字是运行期的值）。一份普通程序里它一次都不会被调到。
       *
       * 为什么是"留坑"而不是"先判断"：判据是「这份程序里有没有 `omni_js_call_op(`」，
       * 而那要等函数体全发完才知道。这棵树里已经有三处同样的手法（`s16At` / `protoAt` /
       * `vecAt`）—— 同一个办法，不新造一种。js 腿那边是整份摇树（`trimJsRuntime`），
       * 这一格是它在 C 腿上的对应刀（用户那句话：优化方法是统一的）。
       */
      this.callOpAt = this.out.length;
      this.out.push('');
    }
  }

  /** 那个坑：这份程序真按名字调过 op 才把派发器填进去（见 `callOpAt` 那段账）。 */
  fillCallOp() {
    if (this.callOpAt === undefined || this.callOpAt === null) return;
    /* **一行行找，别先 join**：`this.out` 在自编译那一趟里是几 MB 的一大堆行，
     * `join('\n')` 出来那份大串只为了做一次 `includes` —— 量出来这一格自用 55.9ms
     * （整趟 2069ms 的 2.70%，`node --cpu-prof` 那份账里排第 9）。逐行看一遍是同一个答案。 */
    let used = false;
    for (const ln of this.out) {
      if (typeof ln === 'string' && ln.includes('omni_js_call_op(')) { used = true; break; }
    }
    if (!used) return;
    const outer = this.out;
    this.out = [];
    this.callOpDispatch();
    const lines = this.out;
    this.out = outer;
    this.out[this.callOpAt] = lines.join('\n');
  }

  /**
   * 按名字调 op 的分派器（`js_call_op`，ADR-0013）。JS 后端 backend-js/emit.js 的
   * callOpDispatch 是逐行的孪生。解释器是唯一的用户 —— 它手里的 op 名字是运行期的值。
   *
   * 比较**在 UTF-16 上直接做**，比的是字面量池里的静态数据：转码成 UTF-8 再 memcmp
   * 要在每次 op 调用上分配一块并走一遍转换，量过是原生解释器最热的分配点之一。
   * 先按长度分组（138 条顺着比一遍太贵，分完每组只剩几条），组内逐条 s16 相等。
   * lit 排在 args 前面由调用方铺平，这里按类型取出来：字符串 lit 是单个码元（`'<'`），
   * bool lit 走 truthy。
   */
  callOpDispatch() {
    const A = (i) => `omni_js_arr_get(args, omni_dyn_of_real(${i}.0))`;
    // op 名字（与 raw:'str' 那一条的实参）取 s16。STRING 标签也认：Omni 侧的 string
    // 传进来时是 UTF-8，那一路要转，但它不在热路径上。
    this.line('static omni_s16 omni_js_op_key_(omni_dyn v) {');
    this.indent++;
    this.line('if (v.tag == OMNI_DYN_STR16) return v.u.s16;');
    this.line('if (v.tag == OMNI_DYN_STRING) return omni_s16_of_utf8(v.u.s);');
    this.line('omni_error("op name must be a string");');
    this.line('return omni_s16_of_utf8(omni_str_new("", 0));');
    this.indent--;
    this.line('}');
    this.line('static omni_str omni_js_op_name_(omni_dyn v) {');
    this.indent++;
    this.line('return omni_s16_to_utf8(omni_js_op_key_(v));');
    this.indent--;
    this.line('}');
    this.line('static omni_dyn omni_js_call_op(omni_dyn name, omni_dyn args) {');
    this.indent++;
    this.line('omni_s16 nm_ = omni_js_op_key_(name);');
    this.line('switch (nm_.len) {');
    this.indent++;
    const byLen = new Map();
    for (const [name, abi] of Object.entries(JS_ABI)) {
      if (name === 'js_call_op' || abi.raw === true) continue;  // 不自递归；raw 的签名不统一
      // `noC`：C 侧还没落地的那一族（ADR-0020 P1 的真对象 / Symbol）。列在
      // hir/js_abi.js 的 P1_JS_ONLY 里 —— 派发表里带上它们就是引用一堆不存在的符号。
      if (abi.noC === true) continue;
      if (!byLen.has(name.length)) byLen.set(name.length, []);
      byLen.get(name.length).push([name, abi]);
    }
    for (const len of [...byLen.keys()].sort((a, b) => a - b)) {
      this.line(`case ${len}:`);
      this.indent++;
      for (const [name, abi] of byLen.get(len)) {
        const lits = (abi.lit ?? []).map((k, i) => {
          if (k === 'strict') return `omni_js_truthy(${A(i)})`;
          // litText：整个词按 omni_str 传（见 js_abi 的 js_sym_wk）
          if (abi.litText === true) return `omni_js_op_name_(${A(i)})`;
          return `(char)omni_js_op_key_(${A(i)}).p[0]`;
        });
        const as = [];
        for (let ai = 0; ai < abi.arity; ai++) {
          const x = A(ai + lits.length);
          // raw: 'str' 的 C 形参是 omni_str（js_s16 是唯一一条）—— 取出字符串再传
          as.push(abi.raw === 'str' && ai === 0 ? `omni_js_op_name_(${x})` : x);
        }
        const call = `${abi.c}(${[...lits, ...as].join(', ')})`;
        const ret = abi.ret === 'void' ? `${call}; return omni_dyn_undef();`
          : abi.ret === 'bool' ? `return omni_dyn_of_bool(${call});`
            : `return ${call};`;
        this.line(`if (omni_s16_eq(nm_, ${this.s16Lit(name)})) { ${ret} }`);
      }
      this.line('break;');
      this.indent--;
    }
    this.indent--;
    this.line('}');
    this.line('omni_str bad_ = omni_s16_to_utf8(nm_);');
    this.line('omni_errorf("no such op: %.*s", (int)bad_.len, bad_.p);');
    this.line('return omni_dyn_undef();');
    this.indent--;
    this.line('}');
  }

  /**
   * 成员派发器 + protoMembers 的留坑回填（task #42，与 `fillCallOp` 同一个手法）。
   *
   * 扫一遍已发出的所有行，收集**真出现的** `omni_js_m_*` / `omni_js_p_*` 函数名。
   * 只生成被引用到的那几个。`protoMembers` 的那张表和 `pm_call_impl` 也只含这些。
   *
   * 量到的账（`bench/fib.js`，58523 字节 C）：112 个派发器占 33723 字节 = **57.6%**，
   * 而 fib 一个都不直接调。留到 `protoMembers` 那边用的有 93 个（`pm_call_impl` 的
   * switch），但 fib 连 proto 取值那条路也没走到 —— 所以全部可以省。
   */
  fillMembers() {
    if (this.memberAt === undefined) return;
    let proto = false;
    const used = new Set();
    const rx = /omni_js_[mp]_[A-Za-z_0-9]+/g;
    for (const ln of this.out) {
      if (typeof ln !== 'string') continue;
      let m;
      while ((m = rx.exec(ln)) !== null) used.add(m[0]);
      /* 原型那一族什么时候要进表：**这份程序里有没有"按名字读成员"那条路**。
       * `omni_js_realm_proto(` 是显式拿原型；`omni_js_obj_getk` / `obj_get` / `getp` /
       * `idx_get` 是 `xs.at` / `xs[k]` 落下来的那几个 —— 读出来的那格值靠成员表算
       * （omni_js_obj.h 的 pm_find），而那张表只含 `used` 里的名字。
       * 从前只认 realm_proto 一条，于是 `typeof xs.at` 在 C 腿上是 undefined 而
       * node / js 腿给 function（tests/js-exec 的 44-proto-member-values）。 */
      if (!proto && (ln.includes('omni_js_realm_proto(') || ln.includes('omni_js_obj_getk(')
        || ln.includes('omni_js_obj_get(') || ln.includes('omni_js_getp(')
        || ln.includes('omni_js_idx_get('))) proto = true;
    }
    if (proto) {
      const TAG_PROTO = {
        list: 1, string: 1, real: 1, int: 1, uint: 1, bool: 1, Map: 1, Set: 1, regexp: 1,
      };
      for (const d of Object.values(JS_MEMBERS)) {
        if (d.noC === true || d.member.kind === 'prop') continue;
        if (Object.keys(d.member.on).some((t) => TAG_PROTO[t] !== undefined)) used.add(d.c);
      }
    }
    const outer = this.out;
    this.out = [];
    this.memberDispatch(used);
    outer[this.memberAt] = this.out.join('\n');
    this.out = [];
    this.protoMembers(used);
    outer[this.pmAt] = this.out.join('\n');
    this.out = outer;
  }

  /**
   * 成员派发器（ADR-0011 第 9 节）。表在 hir/js_abi.js，这里只按表生成 —— 发射器里
   * 不出现任何成员名。JS 后端 backend-js/emit.js 的 memberDispatch 是逐行的孪生。
   *
   * `used` 给了就只发那几个（task #42 的留坑回填）；不给就全发。
   */
  memberDispatch(used = null) {
    for (const d of Object.values(JS_MEMBERS)) {
      if (d.noC === true) continue;
      if (used !== null && !used.has(d.c)) continue;
      const m = d.member;
      const ps = ['r'];
      for (let i = 0; i < m.argc; i++) ps.push(`a${i}`);
      const lits = Object.values(m.lit ?? {}).map((v) => (typeof v === 'string' ? `'${v}'` : String(v)));
      const ret = d.ret === 'bool' ? 'bool' : 'omni_dyn';
      this.line(`static ${ret} ${d.c}(${ps.map((p) => `omni_dyn ${p}`).join(', ')}) {`);
      this.indent++;
      this.line('switch (r.tag) {');
      this.indent++;
      for (const [tag, op] of Object.entries(m.on)) {
        const abi = JS_ABI[op];
        // arity 只数 dynamic 实参（含接收者），lit 是额外排在前面的编译期常量
        const call = `${abi.c}(${[...lits, ...ps.slice(0, abi.arity)].join(', ')})`;
        this.line(abi.ret === 'void'
          ? `case ${JS_TAG_C[tag]}: ${call}; return omni_dyn_undef();`
          : `case ${JS_TAG_C[tag]}: return ${call};`);
      }
      // 表外的接收者：属性就是普通属性，方法就是"取属性再当函数调"（ADR-0011 决策 12）
      const get = `omni_js_obj_getk(r, ${this.strLit(m.name)})`;
      if (m.kind === 'prop') {
        this.line(`default: return ${get};`);
      } else {
        const argv = m.argc ? `${m.argc}, a_` : '0, NULL';
        // 接收者要传下去（ADR-0020 P1）：`o.m()` 落到兜底上时 this 就是 o
        const call = `omni_js_call_n_this(${get}, r, ${argv})`;
        const ret = d.ret === 'bool' ? `omni_js_truthy(${call})` : call;
        this.line(m.argc
          ? `default: { const omni_dyn a_[] = { ${ps.slice(1).join(', ')} }; return ${ret}; }`
          : `default: return ${ret};`);
      }
      this.indent--;
      this.line('}');
      this.line(d.ret === 'bool' ? 'return false;' : 'return omni_dyn_undef();');
      this.indent--;
      this.line('}');
    }
  }


  /**
   * 内建原型上的成员（`Array.prototype.map` 那一族，ADR-0020 P1-c）：**照成员表生成**。
   *
   * 降级器碰到 `[].map(f)` 时直接发 `js_m_map`，不走原型 —— 这一格要的是**把成员当值取**
   * （`Array.prototype.map.call(x, f)`、`const m = arr.map` 之类）。运行时那边（omni_js_obj.h）
   * 只留两格函数指针：按 (原型名, 成员名) 查号、按号调；实现是这儿生成的那 93 个 static
   * 函数（memberDispatch 发的），所以表只能在它们之后发、main 里登记一次。
   *
   * 只发**方法**：属性那 13 格（`length` / `size` …）不是函数值，取它们走的是另一条路。
   * 一个成员可能挂在几个原型上（`slice` 在 Array 与 String 上都有），那就是表里几行、
   * 同一个号 —— 按接收者标签分派是那个 static 函数自己的事。
   */
  protoMembers(used = null) {
    const TAG_PROTO = {
      list: 'Array', string: 'String', real: 'Number', int: 'Number', uint: 'Number',
      bool: 'Boolean', Map: 'Map', Set: 'Set', regexp: 'RegExp',
    };
    const rows = [];
    const cases = [];
    for (const d of Object.values(JS_MEMBERS)) {
      const m = d.member;
      if (m.kind === 'prop') continue;
      const protos = new Set();
      for (const tag of Object.keys(m.on)) {
        const pr = TAG_PROTO[tag];
        if (pr !== undefined) protos.add(pr);
      }
      if (protos.size === 0) continue;
      /* 只有 JS 那条腿有实现的成员（noC）也进表，号是 -2：读它照旧**当场报** ——
       * 而**根本不在表里**的名字（`a.zork`）就是 undefined，那是规范里的答案。
       * 少了这一分，"成员表缺一格"与"这个名字本来就没有"会挤成同一个答案。 */
      if (d.noC === true) {
        for (const pr of protos) rows.push({ pr, nm: m.name, argc: m.argc, ix: -2 });
        continue;
      }
      /* task #42 裁减：没被用到的成员不进 pm_call_impl 的 switch。 */
      if (used !== null && !used.has(d.c)) continue;
      const ix = cases.length;
      const args = [];
      for (let i = 0; i < m.argc; i++) args.push(`omni_js_pm_arg_(args, ${i})`);
      const call = `${d.c}(${['self', ...args].join(', ')})`;
      cases.push(`case ${ix}: return ${d.ret === 'bool' ? `omni_dyn_of_bool(${call})` : call};`);
      for (const pr of protos) rows.push({ pr, nm: m.name, argc: m.argc, ix });
    }
    if (rows.length === 0) return;
    this.line('static omni_dyn omni_js_pm_arg_(omni_list_dynamic a, int64_t i) {');
    this.line('  return a != NULL && i < a->len ? a->items[i] : omni_dyn_undef();');
    this.line('}');
    this.line('static omni_dyn omni_js_pm_call_impl_(int64_t ix, omni_list_dynamic args, omni_dyn self) {');
    this.indent++;
    this.line('switch (ix) {');
    this.indent++;
    for (const c of cases) this.line(c);
    this.line('default: break;');
    this.indent--;
    this.line('}');
    this.line('return omni_dyn_undef();');
    this.indent--;
    this.line('}');
    this.line(`static const struct { const char *pr; const char *nm; int64_t argc; int64_t ix; }`
      + ` omni_js_pm_tbl_[${rows.length}] = {`);
    this.indent++;
    for (const r of rows) {
      this.line(`{ ${JSON.stringify(r.pr)}, ${JSON.stringify(r.nm)}, ${r.argc}, ${r.ix} },`);
    }
    this.indent--;
    this.line('};');
    this.line('static int64_t omni_js_pm_find_impl_(omni_str pr, omni_str nm, int64_t *argc) {');
    this.indent++;
    this.line(`for (int64_t i = 0; i < ${rows.length}; i++) {`);
    this.indent++;
    this.line('const char *p = omni_js_pm_tbl_[i].pr;');
    this.line('const char *n = omni_js_pm_tbl_[i].nm;');
    this.line('if ((int64_t)strlen(p) != pr.len || memcmp(p, pr.p, (size_t)pr.len) != 0) continue;');
    this.line('if ((int64_t)strlen(n) != nm.len || memcmp(n, nm.p, (size_t)nm.len) != 0) continue;');
    this.line('*argc = omni_js_pm_tbl_[i].argc;');
    this.line('return omni_js_pm_tbl_[i].ix;');
    this.indent--;
    this.line('}');
    this.line('return -1;');
    this.indent--;
    this.line('}');
    this.line('static void omni_js_pm_init_(void) {');
    this.line('  omni_js_pm_set_(omni_js_pm_find_impl_, omni_js_pm_call_impl_);');
    this.line('}');
    this.protoMemberN = rows.length;
  }

  /** 零值构造：容器字段必须是**新建的空容器**，不能是 NULL —— 与 JS 后端的 $new_S 对齐 */
  structNew(s) {
    this.line(`${this.aggLink()}s_${s.name} omni_new_S_${s.name}(void) {`);
    this.indent++;
    this.line(`s_${s.name} v;`);
    for (const f of s.fields) {
      // 定长内存的字段（第二十二刀）：C 里数组不能整块赋值，所以铺零是一个循环。
      // 摊平过的一维，与 fieldDecl 那一处同一句理由。
      if (f.type.k === 'blk') {
        const { el, n } = flatBlk(f.type);
        this.line(`for (int64_t oi = 0; oi < INT64_C(${n}); oi++) v.f_${f.name}[oi] = ${this.zeroExpr(el)};`);
        continue;
      }
      /* 匿名 union（ADR-0027）：C 里它是**匿名类型**，写不出复合字面量（`= {0}` 只在初始化
         里合法，这儿是赋值）。而这一格本来就观察不到（成员只经 `(pfield …)` 在 arena 里碰），
         所以按字节铺零 —— 尺寸用这一层算的那个，与 arena 那一侧一致。 */
      if (f.type.k === 'union') {
        this.line(`memset(&v.f_${f.name}, 0, ${sizeOf(f.type)});`);
        continue;
      }
      this.line(`v.f_${f.name} = ${this.zeroExpr(f.type)};`);
    }
    this.line('return v;');
    this.indent--;
    this.line('}');
  }

  classNew(c) {
    this.line(`${this.aggLink()}ct_${c.name} omni_new_C_${c.name}(void) {`);
    this.indent++;
    this.line(`ct_${c.name} o = (ct_${c.name})omni_alloc(sizeof(struct ct_${c.name}_s));`);
    for (const f of c.fields) this.line(`o->f_${f.name} = ${this.zeroExpr(f.type)};`);
    this.line('return o;');
    this.indent--;
    this.line('}');
  }

  zeroExpr(t) {
    switch (t.k) {
      case 'int': return 'INT64_C(0)';
      case 'real': return '0.0';
      case 'bool': return 'false';
      case 'string': return 'omni_str_new("", 0)';
      case 'struct': return `omni_new_S_${t.name}()`;
      case 'enum': return `omni_new_E_${t.name}()`;
      case 'class': case 'fn': return 'NULL';
      // 指针字段的零（第十七刀）：与裸的 PtrNull 同一条 —— fat 是 omni_pnull()（三个字都零），
      // thin 是一个空的 char*。链表那一族要它：`(struct Node (next (ptr Node)))`。
      case 'ptr': return 'omni_pnull()';
      case 'tptr': return '((char *)0)';
      case 'dynamic': return 'omni_dyn_null()';
      case 'list': case 'dict': case 'set': return `${cTypeName(t)}_new()`;
      // 向量（第十五刀：结构体的向量字段）。走逐形状生成的 `_splat` —— 与裸的
      // VecSplat 表达式同一个函数，"字段的零"不另开一条路。noteVec 是必需的：
      // 一个形状只作为字段类型出现过时，vecLines 那边没别的地方会记下它。
      case 'vec': return `${cTypeName(this.noteVec(t))}_splat(${this.zeroExpr(t.elem)})`;
      // 数组（第十六刀：结构体的数组字段）。长度 0 的空数组，不是 NULL —— 与
      // ArrNew 走同一组符号（标量元素是运行时那四份，向量元素多一层 static inline）。
      case 'arr': return `${cArrOps(this.noteVec(t))}_new(INT64_C(0), ${this.zeroExpr(t.elem)})`;
      default: throw new Error(`c.zero: ${t.k}`);
    }
  }
  /**
   * `OMNI_PROFILE=1` 时发一小段**自带的**函数级计时（第八十八刀）。全部发在生成的 C 里，
   * 不动运行时、也不要操作系统的 profiler 权限（macOS 上 `sample` attach 不到我们
   * 那个 `.omni-cache/work/run-<哈希>` 目录里的 `a.out`）。关着时这一段一个字节都不发。
   *
   * 记的是**含子调用**的时间 + 调用次数：递归靠 depth 只给最外层那一次计时，
   * 不然一层套一层会把同一段时间数好几遍。自用时间要维护影子栈，第一刀不做 ——
   * "谁热"这个问题含子时间就够答了。
   * 出口在 atexit：按 ns 降序印到 **stderr**（与 `OMNI_R3_DEBUG` 那几个量口同一条路，
   * 不会混进 stdout 的图）。
   */
  profTable() {
    if (!this.prof) return;
    const n = this.mod.funcs.length;
    if (n === 0) return;
    this.line('#include <time.h>');
    this.line(`#define OMNI_PROF_N ${n}`);
    this.line('static unsigned long long omni_prof_ns[OMNI_PROF_N];');
    this.line('static unsigned long long omni_prof_self[OMNI_PROF_N];');
    this.line('static unsigned long long omni_prof_calls[OMNI_PROF_N];');
    this.line('static unsigned long long omni_prof_beg[OMNI_PROF_N];');
    this.line('static int omni_prof_depth[OMNI_PROF_N];');
    // 影子栈：算**自用时间**（减掉子调用）。只按"含子时间"排会被"调用极密但单次极便宜"
    // 的那些带跑 —— 踩过：`asy__rm`（两行的 min/max）含子 7.9s 排到第五，
    // 手工摊开之后 pdb 只降 0.3s/趟，因为那 7.9s 绝大部分是**插桩自己**的两次
    // clock_gettime（3.2 亿次调用）。自用时间也含插桩，但至少不再把子树的开销记到父亲头上。
    this.line('#define OMNI_PROF_STK 65536');
    this.line('static int omni_prof_sp = 0;');
    this.line('static int omni_prof_ovf = 0;');
    this.line('static int omni_prof_stkf[OMNI_PROF_STK];');
    this.line('static unsigned long long omni_prof_stkt[OMNI_PROF_STK];');
    this.line('static unsigned long long omni_prof_stkc[OMNI_PROF_STK];');
    this.line('static const char *omni_prof_name[OMNI_PROF_N] = {');
    this.indent++;
    for (const f of this.mod.funcs) this.line(`${JSON.stringify(f.mangled)},`);
    this.indent--;
    this.line('};');
    this.line('static unsigned long long omni_prof_now(void) {');
    this.line('  struct timespec ts;');
    this.line('  clock_gettime(CLOCK_MONOTONIC, &ts);');
    this.line('  return (unsigned long long) ts.tv_sec * 1000000000ull + (unsigned long long) ts.tv_nsec;');
    this.line('}');
    /* 每份产物各有一张自己的表（都是 static），所以印的时候要说清是**谁**的 ——
       核心 + 12 格插件一起跑时，不带标签的 13 张表混在 stderr 上分不出谁是谁。
       摆在这儿（而不是 dump 前面）是因为底下那格折叠栈也要用它。 */
    this.line(`static const char *omni_prof_tag = ${JSON.stringify(this.plugin === null ? 'core' : this.plugin)};`);
    /**
     * **按调用栈归属的那张表**（第一百五十片）：stub 这一档一样能出 backtrace。
     *
     * 用户那句话是对的，而且这是最不该欠的一格：**这份 C 是我们自己发的**，
     * enter/exit 那一对就在我们手里，影子栈（`omni_prof_stkf`）本来就在算自用时间时用着 ——
     * 「不能改源码」在 self 这一侧根本不成立。所以这儿加一张按路径归属的表：
     * 每次返回把这次的**自用纳秒**记到「根;…;它自己」那条路上，落盘就是折叠栈，
     * CLI 那五张表（热路径 / 调用边 / 调用树）一个字都不用改。
     *
     * 两个上限都是量出来的取舍：路径深度 16（每次返回都要哈一遍，深度直接乘在开销上），
     * 路径条数 4096（满了就丢，`omni_prof_plost` 记着，报告里明说 —— 宁可少记也不乱记）。
     */
    this.line('#define OMNI_PROF_PSLOTS 4096');
    this.line('#define OMNI_PROF_PDEPTH 16');
    this.line('static int omni_prof_pfr[OMNI_PROF_PSLOTS][OMNI_PROF_PDEPTH];');
    this.line('static int omni_prof_pn[OMNI_PROF_PSLOTS];');
    this.line('static unsigned long long omni_prof_pw[OMNI_PROF_PSLOTS];');
    this.line('static int omni_prof_pused = 0;');
    this.line('static int omni_prof_plost = 0;');
    this.line('static int omni_prof_pdeep = 0;');
    this.line('static void omni_prof_path(int sp, unsigned long long w) {');
    this.line('  int fr[OMNI_PROF_PDEPTH];');
    this.line('  int m = 0;');
    this.line('  int i;');
    /* 从栈顶往下取（栈顶在前，与采样那一档同一种存法 —— 写折叠栈时再倒过来）。 */
    this.line('  for (i = sp; i >= 0 && m < OMNI_PROF_PDEPTH; i--) fr[m++] = omni_prof_stkf[i];');
    this.line('  if (sp + 1 > OMNI_PROF_PDEPTH) omni_prof_pdeep = 1;');
    this.line('  unsigned long long h = 1469598103934665603ull;');
    this.line('  for (i = 0; i < m; i++) { h ^= (unsigned long long) fr[i]; h *= 1099511628211ull; }');
    this.line('  int slot = (int) (h & (OMNI_PROF_PSLOTS - 1));');
    this.line('  int probe;');
    this.line('  for (probe = 0; probe < OMNI_PROF_PSLOTS; probe++) {');
    this.line('    if (omni_prof_pn[slot] == 0) {');
    this.line('      for (i = 0; i < m; i++) omni_prof_pfr[slot][i] = fr[i];');
    this.line('      omni_prof_pn[slot] = m;');
    this.line('      omni_prof_pw[slot] = w;');
    this.line('      omni_prof_pused++;');
    this.line('      return;');
    this.line('    }');
    this.line('    if (omni_prof_pn[slot] == m) {');
    this.line('      int same = 1;');
    this.line('      for (i = 0; i < m; i++) if (omni_prof_pfr[slot][i] != fr[i]) { same = 0; break; }');
    this.line('      if (same) { omni_prof_pw[slot] += w; return; }');
    this.line('    }');
    this.line('    slot = (slot + 1) & (OMNI_PROF_PSLOTS - 1);');
    this.line('  }');
    this.line('  omni_prof_plost++;');
    this.line('}');
    /* 折叠栈落盘：`OMNI_PROF_OUT` 给了就写（与 `omni_prof.c` 那份同一个约定与单位 ——
     * 插桩那一档的权重是**微秒**）。CLI 收尾时读它、印那五张表。 */
    this.line('static void omni_prof_folded(void) {');
    this.line('  const char *p = getenv("OMNI_PROF_OUT");');
    this.line('  if (!p || !p[0] || omni_prof_pused == 0) return;');
    this.line('  FILE *f = fopen(p, "w");');
    this.line('  if (!f) return;');
    this.line('  int i;');
    this.line('  int j;');
    this.line('  for (i = 0; i < OMNI_PROF_PSLOTS; i++) {');
    this.line('    if (omni_prof_pn[i] == 0) continue;');
    this.line('    for (j = omni_prof_pn[i] - 1; j >= 0; j--) {');
    this.line('      fprintf(f, "%s", omni_prof_name[omni_prof_pfr[i][j]]);');
    this.line('      if (j > 0) fprintf(f, ";");');
    this.line('    }');
    this.line('    unsigned long long w = omni_prof_pw[i] / 1000ull;');
    this.line('    if (w == 0) w = 1;');
    this.line('    fprintf(f, " %llu\\n", w);');
    this.line('  }');
    this.line('  fclose(f);');
    this.line('  fprintf(stderr, "prof[%s]: 折叠栈写到了 %s（%d 条路%s%s）\\n", omni_prof_tag, p,'
      + ' omni_prof_pused, omni_prof_plost ? "，有丢" : "", omni_prof_pdeep ? "，有截深" : "");');
    this.line('}');
    this.line('static void omni_prof_enter(int i) {');
    this.line('  omni_prof_calls[i]++;');
    this.line('  if (omni_prof_depth[i]++ == 0) omni_prof_beg[i] = omni_prof_now();');
    this.line('  if (omni_prof_sp < OMNI_PROF_STK) {');
    this.line('    int s = omni_prof_sp;');
    this.line('    omni_prof_stkf[s] = i;');
    this.line('    omni_prof_stkc[s] = 0;');
    this.line('    omni_prof_stkt[s] = omni_prof_now();');
    this.line('  } else {');
    this.line('    omni_prof_ovf = 1;   /* 越界那一层拿不到子树回填，自用时间从此偏大 */');
    this.line('  }');
    this.line('  omni_prof_sp++;');
    this.line('}');
    this.line('static void omni_prof_exit(int i) {');
    this.line('  if (--omni_prof_depth[i] == 0) omni_prof_ns[i] += omni_prof_now() - omni_prof_beg[i];');
    this.line('  if (omni_prof_sp > 0) {');
    this.line('    omni_prof_sp--;');
    this.line('    if (omni_prof_sp < OMNI_PROF_STK) {');
    this.line('      int s = omni_prof_sp;');
    this.line('      unsigned long long dt = omni_prof_now() - omni_prof_stkt[s];');
    this.line('      unsigned long long self = dt - omni_prof_stkc[s];');
    this.line('      omni_prof_self[omni_prof_stkf[s]] += self;');
    this.line('      if (s > 0) omni_prof_stkc[s - 1] += dt;');
    this.line('      omni_prof_path(s, self);');
    this.line('    }');
    this.line('  }');
    this.line('}');
    /* 每份产物各有一张自己的表（都是 static）—— 标签在上面那格已经定过了。 */
    this.line('static void omni_prof_dump(void) {');
    this.line('  omni_prof_folded();');    this.line('  int ord[OMNI_PROF_N];');
    this.line('  int m = 0;');
    this.line('  for (int i = 0; i < OMNI_PROF_N; i++) if (omni_prof_calls[i]) ord[m++] = i;');
    this.line('  for (int a = 1; a < m; a++) {');
    this.line('    int v = ord[a], b = a;');
    this.line('    while (b > 0 && omni_prof_self[ord[b - 1]] < omni_prof_self[v]) { ord[b] = ord[b - 1]; b--; }');
    this.line('    ord[b] = v;');
    this.line('  }');
    // 只印前 40 条会把"排名靠后但正是我要找的那一条"藏起来 —— 追 `cycis_arr_pen` 的
    // 调用者时踩过：两个候选（`cycidx_arr_pen` / `acopy_pen`）都在四十名之外，
    // 光看榜首分不出是哪一条路把它叫了 93 万次。`OMNI_PROF_GREP` 按名字过滤（此时不限名次），
    // `OMNI_PROF_TOP` 改榜长。
    this.line('  const char *omni_pf = getenv("OMNI_PROF_GREP");');
    this.line('  const char *omni_pt = getenv("OMNI_PROF_TOP");');
    this.line('  int omni_ptop = omni_pt && omni_pt[0] ? atoi(omni_pt) : 40;');
    this.line('  fprintf(stderr, "prof[%s]: %d 个函数被调用过（自用 ms / 含子 ms / 次数，按自用降序）\\n", omni_prof_tag, m);');
    this.line('  if (omni_prof_ovf) fprintf(stderr, "prof[%s]: 影子栈超过 %d 层，自用时间不可信（深层子树被记到父亲头上）\\n", omni_prof_tag, OMNI_PROF_STK);');
    this.line('  for (int a = 0; a < m; a++) {');
    this.line('    int i = ord[a];');
    this.line('    if (omni_pf && omni_pf[0]) { if (!strstr(omni_prof_name[i], omni_pf)) continue; }');
    this.line('    else if (a >= omni_ptop) break;');
    this.line('    fprintf(stderr, "prof[%s]: %10.3f %10.3f %12llu  %s\\n", omni_prof_tag,');
    this.line('            omni_prof_self[i] / 1000000.0, omni_prof_ns[i] / 1000000.0,');
    this.line('            omni_prof_calls[i], omni_prof_name[i]);');
    this.line('  }');
    this.line('}');
    this.line();
  }

  proto(f) {
    // 闭包体的第一个形参是闭包记录自己：既是"环境"，也是被 self 指针解释的那块内存
    const self = f.closureId === undefined ? [] : ['omni_fn self_'];
    // 形参/返回值里的向量形状也要登记：一个只做"接进来再传出去"的函数体里
    // 可能一条向量运算都没有，但它的原型仍然要那个 typedef
    this.noteVec(f.ret);
    for (const p of f.params) this.noteVec(p.type);
    const params = [...self, ...f.params.map((p) => `${cTypeName(p.type)} v_${p.name}`)];
    // **别在这儿加 `inline`/`always_inline` —— 试过，没用**（第九十一刀，退掉了）：
    // 生成的 C 用 `-O0` 编（不许开 -O2，那会盖住性能问题），clang 在 -O0 下给每个函数挂
    // `optnone`，而**往 optnone 的调用者里内联是禁掉的** —— 被调方标什么都不起作用。
    // 量出来：pdb 上给"体不超过两句、且体里不出现自己名字"的函数发
    // `static inline __attribute__((always_inline))`，36.0s -> 38.5s（没变好）。
    // 真要消掉热路径上那些调用（`asy__rm` 3.2 亿次、`triple * real` 各 2578 万次），
    // 只有两条路：**发射器自己在调用点摊开**，或者把编译等级提到 `-O1`（那是 ADR 级的决定）。
    /* 插件的那格入口（模块级 let/const 的赋值都在里面）**只能是自己的**：它与核心的
     * 入口同名（都叫 omni_main，而且 P1 把它的来源记成了 host/path.js），只按名字+文件
     * 绑就会绑到**核心的 main** 上 —— 量出来是「插件的类对象一个都没建」，
     * 报 `符号键只在真对象上成立`。发成 static：同一个名字，各自一份。
     * 切出来的那一串 `omni_init_N` 同理，而且更危险：编号是**按这一份的模块顺序**给的，
     * 核心的第 N 格与插件的第 N 格压根不是同一个文件（见 isEntry）。 */
    const st = this.isEntry(f) ? 'static '
      : (this.extern ? '' : 'static ');
    return `${st}${cTypeName(f.ret)} ${f.mangled}(${params.length ? params.join(', ') : 'void'})`;
  }

  /**
   * 这个函数是这一份的入口吗（插件那格入口永远自己发，见 proto 里那段）。
   *
   * 「入口」现在不止 `omni_main` 一格：整份程序的模块级初始化按模块切成了一串
   * `omni_init_N`（frontend-js/lower.js 里那格 `isInit`）。这三件事对每一格都得成立 ——
   * 永远自己发、在插件里发成 static、initGuard 认它。
   */
  isEntry(f) {
    return this.plugin !== null && (f.mangled === this.mod.entry || f.isInit === true);
  }

  /**
   * 插件入口里那句"给不属于自己的模块级变量赋初值"—— 包成"还没人初始化过才做"。
   * 不是这种句子就交 null（照原样发）。
   *
   * 判据要窄：只在**入口**里、只认 `g_X = …` 这一种整句、且 `g_X` 不是自己发的那些。
   */
  initGuard(s) {
    if (!this.inEntry || this.bind === null) return null;
    const e = s.expr;
    if (e === undefined || e === null || e.kind !== 'Assign') return null;
    const t = e.target;
    if (t === undefined || t === null || (t.kind !== 'JsGlobal' && t.kind !== 'GlobalRef')) return null;
    if (this.gFile === undefined) {
      this.gFile = new Map();
      for (const g of this.mod.jsGlobals ?? []) this.gFile.set(g.name, g.file);
    }
    if (!this.gFile.has(t.name)) return null;      // 有类型的那种（核心方言）不管
    if (this.emitsSym(`g_${t.name}`, this.gFile.get(t.name))) return null;
    return `if (g_${t.name}.tag == OMNI_DYN_UNDEF) { ${this.expr(e)}; }`;
  }

  func(f) {
    /* 现在发的是不是这一份的入口（模块级变量的赋值都在它里头）—— initGuard 只认这一格：
     * 函数体里对模块级变量的赋值是**真赋值**，包不得（`asyDeps = []` 那种）。 */
    this.inEntry = this.isEntry(f);
    this.line(`${this.proto(f)} {`);
    this.indent++;
    if (f.closureId !== undefined) {
      const c = (this.mod.closures ?? [])[f.closureId];
      if (c.captures.length) this.line(`struct ${c.mangled}_env *self = (struct ${c.mangled}_env *)self_;`);
      else this.line('(void)self_;');
    }
    // 计时那一对（见 profTable）：出口不靠 `__attribute__((cleanup))`（tcc 上不保准），
    // 而是**每条 return 之前**各发一句 —— return 也是我们自己发的，两边一起改就行。
    this.profId = this.prof ? this.mod.funcs.indexOf(f) : -1;
    this.profRetT = cTypeName(f.ret);
    if (this.profId >= 0) this.line(`omni_prof_enter(${this.profId});`);
    for (const s of f.body.stmts) this.stmt(s);
    if (this.profId >= 0) this.line(`omni_prof_exit(${this.profId});`);
    this.indent--;
    this.line('}');
    this.line();
    this.profId = -1;
  }

  stmt(s) {
    switch (s.kind) {
      case 'Block':
        if (s.transparent) { for (const x of s.stmts) this.stmt(x); break; }
        this.line('{');
        this.indent++;
        for (const x of s.stmts) this.stmt(x);
        this.indent--;
        this.line('}');
        break;
      case 'Local':
        this.noteVec(s.type);
        this.line(`${cTypeName(s.type)} v_${s.name} = ${this.expr(s.init)};`);
        break;
      case 'ExprStmt': {
        /* 插件的入口里，**不属于自己的**模块级变量只在"还没人初始化过"时才初始化
         * （ADR-0021 的 S4）。不加这一格的话：核心的 omni_main 先建了 `g_INT`，
         * 插件的入口又建一个新的塞回同一格，而核心（与先装的别的插件）在模块初始化时
         * 已经把**旧的那个**捕获进了自己的表里 —— 于是 `t !== INT` 成立，
         * 量出来是「字段 file.fd … 这里是 int」这种自相矛盾的诊断。 */
        const g = this.initGuard(s);
        this.line(g !== null ? g : `${this.expr(s.expr)};`);
        break;
      }
      case 'If':
        this.line(`if (${this.expr(s.cond)}) {`);
        this.indent++;
        for (const x of s.then.stmts) this.stmt(x);
        this.indent--;
        if (s.otherwise) {
          this.line('} else {');
          this.indent++;
          for (const x of s.otherwise.stmts) this.stmt(x);
          this.indent--;
        }
        this.line('}');
        break;
      case 'While': {
        const lp = this.pushLoop(s);
        this.line(`while (${this.expr(s.cond)}) {`);
        this.indent++;
        for (const x of s.body.stmts) this.stmt(x);
        if (lp.cont) this.line(`${lp.cont}: ;`);
        this.indent--;
        this.line('}');
        if (lp.brk) this.line(`${lp.brk}: ;`);
        this.loops.pop();
        break;
      }
      case 'For': {
        this.line('{');
        this.indent++;
        if (s.init) this.stmt(s.init);
        const lp = this.pushLoop(s);
        this.line(`for (; ${s.cond ? this.expr(s.cond) : ''}; ${s.step ? this.expr(s.step) : ''}) {`);
        this.indent++;
        for (const x of s.body.stmts) this.stmt(x);
        if (lp.cont) this.line(`${lp.cont}: ;`);
        this.indent--;
        this.line('}');
        if (lp.brk) this.line(`${lp.brk}: ;`);
        this.loops.pop();
        this.indent--;
        this.line('}');
        break;
      }
      case 'ForIn': this.forIn(s); break;
      case 'Return':
        /* 值是一格 **void 的 op**（`(v) => console.log(v)` 这种箭头，promise 的回调里满是）：
         * C 里不能 `return f(x)` —— 那是"从返回 omni_dyn 的函数里返回 void"，clang 当场骂。
         * 先把它当一句发出去，再返回 undefined —— JS 那条腿上这式子的值本来就是 undefined。
         * 只在"这个函数自己不返回 void"时这么改；返回 void 的照旧原样发。 */
        if (s.value !== undefined && s.value !== null && s.value.kind === 'Builtin'
          && JS_ABI[s.value.name] !== undefined && JS_ABI[s.value.name].ret === 'void'
          && this.profRetT !== 'void') {
          this.line(`${this.expr(s.value)};`);
          if (this.profId >= 0) this.line(`omni_prof_exit(${this.profId});`);
          this.line('return omni_dyn_undef();');
          break;
        }
        // 计时打开时，每条 return 之前先结账（见 profTable）。带值那一支要先把值
        // 求出来存进临时量 —— 表达式里可能还会调别的函数，不能先停表。
        if (this.profId >= 0) {
          if (s.value) {
            this.line('{');
            this.indent++;
            this.line(`${this.profRetT} omni_pr_ = ${this.expr(s.value)};`);
            this.line(`omni_prof_exit(${this.profId});`);
            this.line('return omni_pr_;');
            this.indent--;
            this.line('}');
          } else {
            this.line(`omni_prof_exit(${this.profId});`);
            this.line('return;');
          }
          break;
        }
        this.line(s.value ? `return ${this.expr(s.value)};` : 'return;');
        break;
      case 'Break': this.line(this.jump(s, 'break')); break;
      case 'Continue': this.line(this.jump(s, 'continue')); break;
      default: throw new Error(`c.stmt: ${s.kind}`);
    }
  }

  /** 进循环前：按需给这一层起两个标签，压栈。用不上的那个是 null，不会发出来。 */
  pushLoop(s) {
    const need = loopLabelNeeds(s);
    const id = this.tmp++;
    const e = { brk: need.brk ? `omni_brk${id}` : null, cont: need.cont ? `omni_cont${id}` : null };
    this.loops.push(e);
    return e;
  }

  /** `break;` / `continue;`，或者跳到外层那一层的标签上 */
  jump(s, word) {
    const lv = s.level === undefined || s.level === null ? 1 : s.level;
    if (lv === 1) return `${word};`;
    const e = this.loops[this.loops.length - lv];
    const label = e === undefined ? null : (word === 'break' ? e.brk : e.cont);
    if (label === null) throw new Error(`c.${word}: 第 ${lv} 层循环没有标签`);
    return `goto ${label};`;
  }

  /**
   * 迭代协议：list 走 items[0..len)，dict/set 走 keys[0..n) 并跳过墓碑。
   * 条目数组即插入序，所以顺序与 JS 的 Map/Set 迭代逐位一致（ADR-0006）。
   */
  forIn(s) {
    const t = s.iterable.type;
    const id = this.tmp++;
    const c = `it${id}_c`;
    const i = `it${id}_i`;
    this.line('{');
    this.indent++;
    this.line(`${cTypeName(t)} ${c} = ${this.expr(s.iterable)};`);
    const bound = t.k === 'list' ? `${c}->len` : `${c}->n`;
    const lp = this.pushLoop(s);
    this.line(`for (int64_t ${i} = 0; ${i} < ${bound}; ${i}++) {`);
    this.indent++;
    if (t.k !== 'list') this.line(`if (!${c}->live[${i}]) continue;`);
    const slot = t.k === 'list' ? `${c}->items[${i}]` : `${c}->keys[${i}]`;
    this.line(`${cTypeName(s.varType)} v_${s.varName} = ${this.convert(slot, s.elemType, s.varType)};`);
    for (const x of s.body.stmts) this.stmt(x);
    if (lp.cont) this.line(`${lp.cont}: ;`);
    this.indent--;
    this.line('}');
    if (lp.brk) this.line(`${lp.brk}: ;`);
    this.loops.pop();
    this.indent--;
    this.line('}');
  }

  /** 迭代变量类型与元素类型不同时的转换（int -> real、装箱） */
  convert(code, from, to) {
    if (from.k === 'int' && to.k === 'real') return `(double)(${code})`;
    if (to.k === 'dynamic' && from.k !== 'dynamic') return this.box(code, from);
    return code;
  }

  box(code, from) {
    switch (from.k) {
      case 'int': return `omni_dyn_of_int(${code})`;
      case 'real': return `omni_dyn_of_real(${code})`;
      case 'bool': return `omni_dyn_of_bool(${code})`;
      case 'string': return `omni_dyn_of_string(${code})`;
      case 'list': case 'dict': return `omni_dyn_of_ref((void *)(${code}), ${DYN_TAG[from.k]})`;
      case 'dynamic': return code;
      case 'null': return 'omni_dyn_null()';
      /* 函数进 dyn：标签与构造子运行时里本来就有（`OMNI_DYN_FN` / `omni_dyn_of_fn`，
         ADR-0011 那条 JS 互操作路上留下的），四条腿问出来的标签也都是 "function"
         （C 侧那张名字表与 JS 的 typeof 撞上了同一个词）。所以这一格只是把那条路
         接到"静态的函数值"上 —— 方言里 `(dyn (fnref f))` 走的就是它。 */
      case 'fn': return `omni_dyn_of_fn((omni_fn)(${code}))`;
      default: throw new Error(`c.box: ${from.k}`);
    }
  }
  /** 解引用前的检查，回一个可以直接强转的地址。fat 查空 + 查范围，thin 只查空
   *  —— thin 把范围丢掉了，这也是它必须写在 (unsafe …) 里的原因（ADR-0016）。 */
  ptrChk(p, size) {
    return p.type.k === 'tptr'
      ? `omni_tchk(${this.expr(p)})` : `omni_pderef(${this.expr(p)}, ${size})`;
  }

  /** 线性内存的地址：静态偏移在这儿加进去（第二刀）。偏移是常量，所以 C 编译器会把
   *  `a + 8` 折进寻址 —— 与 LLVM 那条腿发一条 `add i64` 是同一件事。 */
  memAddr(e) {
    return e.off === 0 ? this.expr(e.addr) : `(${this.expr(e.addr)}) + ${e.off}`;
  }
  expr(e) {
    switch (e.kind) {
      case 'Const': return this.constant(e);
      case 'ZeroStruct': return `omni_new_S_${e.type.name}()`;
      case 'ZeroEnum': return `omni_new_E_${e.type.name}()`;
      case 'MakeEnum':
        return `omni_mk_E_${e.type.name}_${e.variant}(${e.args.map((x) => this.expr(x)).join(', ')})`;
      case 'EnumTag': return `(${this.expr(e.object)}).tag`;
      case 'EnumPayload': return `(${this.expr(e.object)}).u.v_${e.variant}.f_${e.name}`;
      case 'NullLit': case 'NullRef': case 'NullFn': return 'NULL';
      case 'DynNull': return 'omni_dyn_null()';
      case 'NewObject': return `omni_new_C_${e.type.name}()`;
      case 'MakeClosure': {
        /* 造闭包也是"叫到了谁"（切文件时 `<单元>.c` 要 include 那格 make 的家）：
           量出来的 —— 漏了这一笔，a 里 `[..].map(twice)` 那句撞
           `call to undeclared function 'omni_mk_a_twice'`。 */
        this.useFn(e.make);
        return `${e.make}(${e.args.map((x) => this.expr(x)).join(', ')})`;
      }
      case 'CaptureRef': return `self->c_${e.name}`;
      case 'CallFn':
        return `omni_call_${typeKey(e.fnType)}(${[this.expr(e.callee), ...e.args.map((a) => this.expr(a))].join(', ')})`;
      case 'NewContainer': return `${cTypeName(e.type)}_new()`;
      case 'ListLit': return this.listLit(e);
      case 'DictLit': return this.dictLit(e);
      case 'SetLit': return this.setLit(e);
      case 'VarRef': return `v_${e.name}`;
      // 向量四条（ADR-0014 门槛 6 第一阶段）。splat / lane / hsum 都走那个形状的助手：
      // 复合字面量里把标量重复 N 次会把子表达式求值 N 次，而 (lane E N) 的 E 可能有副作用。
      case 'VecSplat':
        this.noteVec(e.type);
        return `${cTypeName(e.type)}_splat(${this.expr(e.value)})`;
      case 'VecLit': {
        this.noteVec(e.type);
        const lanes = e.lanes.map((x) => this.expr(x)).join(', ');
        return `(${cTypeName(e.type)}){{${lanes}}}`;
      }
      case 'VecLane':
        this.noteVec(e.vec.type);
        return `${cTypeName(e.vec.type)}_lane(${this.expr(e.vec)}, ${e.lane})`;
      case 'VecHsum':
        this.noteVec(e.vec.type);
        return `${cTypeName(e.vec.type)}_hsum(${this.expr(e.vec)})`;
      // 缓冲四条（门槛 7 第一阶段）。结构体按值传，但里面的指针是共享的 —— 引用语义
      // 因此不需要任何拷贝助手：传一份 {n, p} 的副本，指向的还是同一段存储。
      case 'BufNew':
        this.noteVec(e.type);
        return `${cTypeName(e.type)}_new(${this.expr(e.count)})`;
      case 'BufLen':
        this.noteVec(e.buf.type);
        return `(${this.expr(e.buf)}).n`;
      case 'BufGet':
        this.noteVec(e.buf.type);
        return `${cTypeName(e.buf.type)}_get(${this.expr(e.buf)}, ${this.expr(e.index)})`;
      case 'BufSet':
        this.noteVec(e.buf.type);
        return `${cTypeName(e.buf.type)}_set(${this.expr(e.buf)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      // 数组六条（门槛 2 第四刀）。标量元素这里不生成任何东西 —— 实现在运行时的
      // omni_arr.c 里已经按元素单态好了，`cArrOps` 给出的就是那四组符号名之一。
      // 聚合元素（第八刀的 pair[]）多一层 arrLines 发的 static inline，句柄仍是
      // 运行时那一个 blob 头。run-llvm 那条腿调的是同一个符号，所以两边不可能分叉。
      case 'ArrNew':
        return `${cArrOps(this.noteVec(e.type))}_new(${this.expr(e.count)}, ${this.expr(e.zero)})`;
      case 'ArrLen':
        return `${cArrOps(this.noteVec(e.arr.type))}_len(${this.expr(e.arr)})`;
      case 'ArrGet':
        return `${cArrOps(this.noteVec(e.arr.type))}_get(${this.expr(e.arr)}, ${this.expr(e.index)})`;
      case 'ArrSet':
        return `${cArrOps(this.noteVec(e.arr.type))}_set(${this.expr(e.arr)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      case 'ArrPush':
        return `${cArrOps(this.noteVec(e.arr.type))}_push(${this.expr(e.arr)}, ${this.expr(e.value)})`;
      case 'ArrPop':
        return `${cArrOps(this.noteVec(e.arr.type))}_pop(${this.expr(e.arr)})`;
      // 指针（ADR-0016）。真指针：fat 是 omni_ptr（三个字按值传），thin 是 char*。
      // 读写只有这两处按目标类型强转 —— 这就是"运行时里只有一个 omni_ptr"的理由。
      // 范围检查回地址，所以读是一行 `*(int64_t *)omni_pchk(p, 8)`。
      case 'PtrNull': return e.type.k === 'tptr' ? '((char *)0)' : 'omni_pnull()';
      case 'PtrNew': return `omni_pnew_fat(${this.expr(e.count)}, ${e.size})`;
      case 'PtrIsNull': return e.ptr.type.k === 'tptr'
        ? `(${this.expr(e.ptr)} == 0)` : `omni_pisnull(${this.expr(e.ptr)})`;
      case 'PtrThin': return `(${this.expr(e.ptr)}).a`;
      // `(pelem p)`（第十八刀）：omni_ptr 照原样传出去 —— 三个字都不动，只是类型上的一步。
      case 'PtrElem': return this.expr(e.ptr);
      // `(pcast p (ptr U))`（第二百五十九刀）：同上 —— 这一层的 omni_ptr 里没有元素类型
      // （读写那两处才按目标类型强转），所以"换一副眼镜"在 C 这边一个字都不用发。
      case 'PtrCast': return this.expr(e.ptr);
      case 'PtrLoad':
        return `(*(${cTypeName(e.type)} *)${this.ptrChk(e.ptr, e.size)})`;
      case 'PtrStore':
        return `(*(${cTypeName(e.type)} *)${this.ptrChk(e.ptr, e.size)} = ${this.expr(e.value)})`;
      // 线性内存（ADR-0017 第二刀）。与指针那一路同一个形状：先 omni_lin_at 查一次界拿到
      // 真地址，再就地读写 —— 越界那句话因此只有 omni_linmem.c 里那一份，run-llvm 调的是
      // 同一个符号的同一份机器码。宽度与符号靠 C 的强转表达：`*(int8_t*)` 再隐式提升到
      // int64_t 就是符号扩展，`*(uint8_t*)` 就是零扩展。
      case 'MemSize': return 'omni_lin_size()';
      case 'MemGrow': return `omni_lin_grow(${this.expr(e.pages)})`;
      case 'MemLoad': {
        const d = C_MEM_LD[e.mkind];
        const rt = e.type.k === 'real' ? 'double' : 'int64_t';
        return `((${rt})*(${d[0]} *)omni_lin_at(${this.memAddr(e)}, ${d[1]}))`;
      }
      // 写侧当**语句**用（方言里 mstore 是语句）：所以这个 C 表达式的值是被丢掉的。
      // 它的类型是窄类型，值也是截断后的 —— 与 MIR 上"MSTORE 的结果是存进去之前的值"
      // 不同，但那条差别在方言里不可观测（没有 `(let x (mstore …))` 这种写法）。
      case 'MemStore': {
        const d = C_MEM_ST[e.mkind];
        return `(*(${d[0]} *)omni_lin_at(${this.memAddr(e)}, ${d[1]}) = (${d[0]})(${this.expr(e.value)}))`;
      }
      case 'PtrAdd': return e.ptr.type.k === 'tptr'
        ? `(${this.expr(e.ptr)} + (${this.expr(e.delta)}) * ${e.size})`
        : `omni_padd(${this.expr(e.ptr)}, ${this.expr(e.delta)}, ${e.size})`;
      case 'PtrField': return e.ptr.type.k === 'tptr'
        ? `(${this.expr(e.ptr)} + ${e.off})`
        : `omni_padd(${this.expr(e.ptr)}, ${e.off}, 1)`;
      case 'PtrSub': return e.a.type.k === 'tptr'
        ? `((${this.expr(e.a)} - ${this.expr(e.b)}) / ${e.size})`
        : `omni_pdiff(${this.expr(e.a)}, ${this.expr(e.b)}, ${e.size})`;
      // 只比**地址那一个字**：整个 omni_ptr 是 24 字节，C 里结构体之间没有 `==`。
      case 'PtrEq': return e.a.type.k === 'tptr'
        ? `(${this.expr(e.a)} == ${this.expr(e.b)})`
        : `((${this.expr(e.a)}).a == (${this.expr(e.b)}).a)`;
      case 'Field': {
        const obj = this.expr(e.object);
        // class 是引用，可能为 null：显式检查，避免"段错误 vs 异常"的跨后端分叉
        return e.object.type.k === 'class'
          ? `((${cTypeName(e.object.type)})omni_nullck(${obj}))->f_${e.name}`
          : `${obj}.f_${e.name}`;
      }
      case 'Cast':
        // uns = 位当无符号 64 位读（第六十一刀）
        if (e.from.k === 'int' && e.type.k === 'real') {
          return e.uns === true
            ? `(double)(uint64_t)(${this.expr(e.expr)})`
            : `(double)(${this.expr(e.expr)})`;
        }
        throw new Error(`c.cast: ${e.from.k}->${e.type.k}`);
      case 'Box': return this.box(this.expr(e.expr), e.from);
      case 'Logic': return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case 'Un':
        if (e.op === '-' && e.type.k === 'int') return `omni_neg(${this.expr(e.operand)})`;
        return `(${e.op}${this.expr(e.operand)})`;
      case 'Cmp': {
        if (e.opType.k === 'string') {
          return `(omni_str_cmp(${this.expr(e.left)}, ${this.expr(e.right)}) ${e.op} 0)`;
        }
        if (e.opType.k === 'dynamic') {
          const eq = `omni_dyn_eq(${this.expr(e.left)}, ${this.expr(e.right)})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        // 无符号那四个比较（第六十一刀）：两边的位当无符号 64 位读，比法照旧
        if (e.op.startsWith('u')) {
          return `((uint64_t)${this.expr(e.left)} ${e.op.slice(1)} (uint64_t)${this.expr(e.right)})`;
        }
        return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      }
      case 'Bin': return this.bin(e);
      // JS 前端的模块级变量（ADR-0011）：一个真全局，可读可写
      case 'JsGlobal': return `g_${e.name}`;
      case 'GlobalRef': return `g_${e.name}`;
      case 'Ternary': return `(${this.expr(e.cond)} ? ${this.expr(e.then)} : ${this.expr(e.otherwise)})`;
      case 'Assign': return `(${this.expr(e.target)} = ${this.expr(e.value)})`;
      case 'IndexGet': return `${cTypeName(e.recvType)}_get(${this.expr(e.obj)}, ${this.expr(e.index)})`;
      case 'IndexSet':
        return `${cTypeName(e.recvType)}_set(${this.expr(e.obj)}, ${this.expr(e.index)}, ${this.expr(e.value)})`;
      case 'Call': {
        this.useFn(e.func);
        const st = this.stackArgs(e);
        return st !== null ? st : `${e.func}(${e.args.map((a) => this.expr(a)).join(', ')})`;
      }
      case 'Builtin': return this.builtin(e);
      // 外部 C 符号（ADR-0014 决策 4）：实参逐个 marshal，返回值再 marshal 回来。
      // void 的那些包成逗号表达式，让整条仍然是个 dynamic 表达式。
      case 'CCall': {
        /* `raw`（ADR-0022 的 J4b）：实参**已经是机器值**了（有类型的方言那一侧），
           所以一个 marshaler 都不套 —— 只按声明的 C 类型加强制转换。套上去的话是把
           `omni_cabi_i64(int64_t)` 当成 dynamic 装箱，类型当场对不上。
           返回值同理：这一格的类型就是核心类型，不是 dynamic。 */
        if (e.raw === true) {
          const ps = e.sig.params;
          const as = e.args.map((a, i) => {
            const k = a.type === null || a.type === undefined ? '?' : a.type.k;
            /* `string` 交给 C 的是**那块字节的地址**（`omni_str` 是 `{p, len}` 两个字，
               整个结构体强制转成 `void *` 是错的 —— clang 当场就拒）。与 LLVM 那条腿
               `cabiArg` 抽胖指针第 0 格是同一件事，两条腿必须同形。
               结尾的零：字面量是 C 的字符串字面量，本来就带；算出来的串没有那个保证，
               那是用的人要负的责（与 LLVM 那侧同一句话）。 */
            if (k === 'string') return `(void *)((${this.expr(a)}).p)`;
            /* 方言的 `(ptr T)` 在 C 这一侧是 `omni_ptr`（`{a, b, e}` 三个字，界在里头）——
               交给 C 的是"当前"那一格 `.a`，与 LLVM 那条腿抽第 0 格是同一件事。
               界检查留在这一侧：C 那边拿到的就是一个裸地址，越界与否它不知道。
               `(tptr T)`（thin）本来就是一个裸指针，直接转。 */
            if (k === 'ptr') return `(void *)((${this.expr(a)}).a)`;
            if (k === 'tptr') return `(void *)(${this.expr(a)})`;
            /* **函数值**：C 这一侧就是 `omni_fn`（一格闭包对象的地址），原样转过去。
               收的人按 `fp(self, 实参…)` 调它（`omni_call_*` 发的就是那一句）——
               `src/runtime-sched/omni_go.c` 的 `omni_goclos` 是这条约定的另一端。 */
            if (k === 'fn') return `(void *)(${this.expr(a)})`;
            if (i < ps.length) return `(${C_TYPE[ps[i]]})(${this.expr(a)})`;
            /* 变参那一段（`...` 之后）没有声明的类型可用 —— 按**实参自己**那一格来，
               这正是 C 的默认实参提升：整数一律 int64_t、`real` 一律 double。
               别的（bool 那些）在这一层不发：C 里它们各有自己的提升规则，猜错就是读错栈。 */
            if (k === 'int') return `(int64_t)(${this.expr(a)})`;
            if (k === 'real') return `(double)(${this.expr(a)})`;
            throw new OmniError(`c: ${e.entry} 的第 ${i + 1} 个实参落在变参那一段，`
              + `而 ${k} 在这一层的默认实参提升里没有位置`);
          });
          /* 返回 `ptr`/`cstr` 的那些：方言这一侧接它的是 `int`（地址就是一个整数），
             而 C 那边回的是 `void *` —— 指针到整数在 C 里要**明写**这一刀。
             别的词（i32/f32/bool）靠 C 自己的隐式加宽就够。 */
          const call = `${e.entry}(${as.join(', ')})`;
          const rw = e.sig.ret;
          return (rw === 'ptr' || rw === 'cstr') ? `(int64_t)(${call})` : call;
        }
        const sig = C_ABI[e.entry];
        const args = e.args.map((a, i) => `${C_IN[sig.params[i]]}(${this.expr(a)})`);
        const call = `${sig.sym}(${args.join(', ')})`;
        if (sig.ret === 'void') return `(${call}, omni_dyn_undef())`;
        return `${C_OUT[sig.ret]}(${call})`;
      }
      default: throw new Error(`c.expr: ${e.kind}`);
    }
  }

  /**
   * 实参 list 上栈（ADR-0021 的 P3b）。
   *
   * 调用约定是"每个 JS 函数收一条 `list<dynamic>`"，于是每次调用都
   * `omni_list_dynamic_from((omni_dyn[]){…}, n)` —— **两次 arena 分配**（struct + items），
   * 而实参本来就已经在一个栈数组里了。量出来的：一趟 `emit-c src/cli.js` 一共 3.7 亿次
   * 分配、平均 27.2 字节、88% 在 32 字节以内，就是这一类"每个操作一块新内存"堆起来的。
   *
   * 什么时候能上栈：**总是**。实参 list 不逃逸是一条处处成立的不变量 —— 绑形参走只读的
   * `js_arr_get`、rest 走拷一份的 `js_arr_slice`，而唯一会把它当值留住的 `arguments`
   * 现在自己拷一份（见 lower.js 那一句）。于是它活不过这一次调用，可以是一个 C99 的
   * **复合字面量**：块作用域上有自动存储期，覆盖整个调用，而且仍然是**一个表达式**，
   * 不必把调用点改成语句。
   *
   * 只认"实参正好是一条列表字面量"这一个形状；别的（展开、转发一条现成的 list）照旧。
   * @returns {string | null}
   */
  stackArgs(e) {
    if (!this.knownFuncs.has(e.func)) return null;
    if (e.args.length !== 1) return null;
    let a = e.args[0];
    if (a && a.kind === 'Box') a = a.expr;
    if (!a || a.kind !== 'ListLit' || a.items.length === 0) return null;
    const n = cTypeName(a.type);
    const items = a.items.map((x) => this.expr(x)).join(', ');
    return `${e.func}(&(struct ${n}_s){ (${cTypeName(a.type.elem)}[]){${items}}, `
      + `${a.items.length}, ${a.items.length} })`;
  }

  /**
   * 一格 `Box(ListLit)`（装成 dyn 的实参 list）落成**栈上**那一份。不是这个形状回 null。
   *
   * 与 `stackArgs` 同一条不变量（见那儿）：实参 list 不逃逸，所以 C99 的复合字面量够用 ——
   * 它在**这个块**上有自动存储期，覆盖整个调用表达式。空 list 也走这一条：
   * `_from(NULL, 0)` 会为"空"分配一个 struct，而空的那一格是最常见的一格（`this.next()`）。
   * @returns {string | null}
   */
  stackArgList(arg) {
    if (!arg || arg.kind !== 'Box') return null;
    const a = arg.expr;
    if (!a || a.kind !== 'ListLit') return null;
    const n = cTypeName(a.type);
    const dyn = `omni_dyn_of_ref((void *)&(struct ${n}_s)`;
    if (a.items.length === 0) return `${dyn}{ NULL, 0, 0 }, OMNI_DYN_LIST)`;
    const items = a.items.map((x) => this.expr(x)).join(', ');
    return `${dyn}{ (${cTypeName(a.type.elem)}[]){${items}}, `
      + `${a.items.length}, ${a.items.length} }, OMNI_DYN_LIST)`;
  }

  /** 容器字面量用复合字面量传数组，避免为了构造值而引入语句表达式 */
  listLit(e) {    const n = cTypeName(e.type);
    if (!e.items.length) return `${n}_from(NULL, 0)`;
    const items = e.items.map((x) => this.expr(x)).join(', ');
    return `${n}_from((${cTypeName(e.type.elem)}[]){${items}}, ${e.items.length})`;
  }

  dictLit(e) {
    const n = cTypeName(e.type);
    if (!e.entries.length) return `${n}_from(NULL, NULL, 0)`;
    const ks = e.entries.map((en) => this.expr(en.key)).join(', ');
    const vs = e.entries.map((en) => this.expr(en.value)).join(', ');
    return `${n}_from((${cTypeName(e.type.key)}[]){${ks}}, (${cTypeName(e.type.val)}[]){${vs}}, ${e.entries.length})`;
  }

  setLit(e) {
    const n = cTypeName(e.type);
    if (!e.items.length) return `${n}_from(NULL, 0)`;
    const items = e.items.map((x) => this.expr(x)).join(', ');
    return `${n}_from((${cTypeName(e.type.elem)}[]){${items}}, ${e.items.length})`;
  }

  constant(e) {
    switch (e.type.k) {
      case 'int': {
        const v = e.value;
        if (v === INT64_MIN_VALUE) return 'INT64_MIN';
        return `INT64_C(${v})`;
      }
      case 'real': return cReal(e.value);
      case 'bool': return e.value ? 'true' : 'false';
      case 'string': {
        const bytes = utf8Bytes(e.value);
        return `omni_str_new(${cString(bytes)}, ${bytes.length})`;
      }
      default: throw new Error(`c.const: ${e.type.k}`);
    }
  }

  bin(e) {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    // 向量：整条运算收进那个形状的助手里（逐道展开在助手体内，见 vecLines）
    if (e.opType.k === 'vec') {
      this.noteVec(e.opType);
      const suffix = C_VEC_OPS.find((x) => x[0] === e.op);
      if (suffix === undefined) throw new Error(`c.bin vec: ${e.op}`);
      return `${cTypeName(e.opType)}_${suffix[1]}(${a}, ${b})`;
    }
    return this.binCode(e.op, e.opType, a, b);
  }

  /** 二元运算的代码拼装。操作数已经是代码串：标量路径与向量的逐道路径共用它 */
  binCode(op, opType, a, b) {
    if (opType.k === 'int') {
      switch (op) {
        case '+': return `omni_add(${a}, ${b})`;
        case '-': return `omni_sub(${a}, ${b})`;
        case '*': return `omni_mul(${a}, ${b})`;
        case '/': return `omni_div(${a}, ${b})`;
        case '%': return `omni_mod(${a}, ${b})`;
        case '<<': return `omni_shl(${a}, ${b})`;
        case '>>': return `omni_shr(${a}, ${b})`;
        // 无符号那三个（第六十一刀）：位当无符号 64 位读，见 runtime/omni.h
        case 'u/': return `omni_udiv(${a}, ${b})`;
        case 'u%': return `omni_umod(${a}, ${b})`;
        case 'u>>': return `omni_ushr(${a}, ${b})`;
        case '&': case '|': case '^': return `(${a} ${op} ${b})`;
        default: throw new Error(`c.bin int: ${op}`);
      }
    }
    if (opType.k === 'real') {
      if (op === '%') return `fmod(${a}, ${b})`;
      return `(${a} ${op} ${b})`;
    }
    if (opType.k === 'string' && op === '+') return `omni_str_cat(${a}, ${b})`;
    throw new Error(`c.bin: ${op} on ${opType.k}`);
  }

  builtin(e) {
    /* **调用点那条实参 list 上栈**（第一百五十五片；`stackArgs` 那一条的另一半）。
     *
     * 量出来的：`OMNI_PROF=sample dist/omni run tests/cases/01_basics.omni --timeout 10`
     * 里 **55% 的帧落在 `omni_list_dynamic_from`**，栈是
     * `… CGen_next > Cpp_next > Cpp_nextNomacro > Cpp_parseComment > Cpp_peekc >
     * omni_list_dynamic_from` —— 预处理器每读一个字符都要为 `this.peekc()` 那一次调用
     * 堆分配一条实参 list（空的那一条也要！`_from(NULL, 0)` 照样分配一个 struct）。
     * 同一份活在 node 腿上 833ms，在自举出来的原生腿上 60s 都没跑完。
     *
     * `stackArgs` 早就为**直接调用**做了这件事（那儿写着"什么时候能上栈：**总是**"——
     * 实参 list 不逃逸是处处成立的不变量：绑形参走只读的 `js_arr_get`、rest 走拷一份的
     * `js_arr_slice`、`arguments` 自己拷）。可**间接调用**（`js_call` / `js_call_this`，
     * 也就是所有方法调用）走的是通用 builtin 那条路，一直没沾上。不变量与被调者是谁无关，
     * 所以这儿补齐：那一格实参从 `Box(ListLit)` 落成 C99 的复合字面量。 */
    if (e.name === 'js_call' || e.name === 'js_call_this') {
      const at = e.name === 'js_call' ? 1 : 2;
      const st = this.stackArgList(e.args[at]);
      if (st !== null) {
        const a2 = e.args.map((x, i) => (i === at ? st : this.expr(x)));
        return `${JS_ALL[e.name].c}(${a2.join(', ')})`;
      }
    }
    const a = e.args.map((x) => this.expr(x));
    const recv = e.recvType;
    // real 上的数学函数：`rmath_sqrt` -> `omni_r_sqrt`（runtime/omni_math.c 里转手 libm）。
    // 名单由核心方言把关（sexpr/lower.js 的 RMATH），这里不再抄一遍。
    if (e.name.startsWith('rmath_')) return `omni_r_${e.name.slice(6)}(${a.join(', ')})`;
    switch (e.name) {
      case 'print': return `omni_print_${e.argType.k}(${a[0]})`;
      // `(write E)` —— 不补换行（ADR-0016 第四刀）
      case 'write': return `omni_write_string(${a[0]})`;
      case 'str_repeat': return `omni_str_repeat(${a[0]}, ${a[1]})`;
      // `(sbase E 进制)` / `(supper S)`（ADR-0016 第七刀）
      case 'str_base': return `omni_str_base(${a[0]}, ${a[1]})`;
      // `(trunc N E)` / `(zext N E)` / `(sext N E)`（ADR-0031 §8.2）：截到 N 位，64 位是恒等
      case 'int_trunc': return `omni_int_trunc(${a[0]}, ${a[1]})`;
      case 'int_sext': return `omni_int_sext(${a[0]}, ${a[1]})`;
      case 'str_upper': return `omni_str_upper(${a[0]})`;
      // `(sfix E N)`（ADR-0016 第八刀）—— C 的 %.Nf 本身就是那个出处
      case 'str_fixed': return `omni_str_fixed(${a[0]}, ${a[1]})`;
      // `(ssci E N)`（第三十刀）—— C 的 %.Ne，同上：这一条就是出处
      case 'str_sci': return `omni_str_sci(${a[0]}, ${a[1]})`;
      // `(sgen E N)` / `(sgenk E N)`（第三十一刀）—— C 的 %.Ng / %#.Ng
      case 'str_gen': return `omni_str_gen(${a[0]}, ${a[1]})`;
      case 'str_genk': return `omni_str_genk(${a[0]}, ${a[1]})`;
      case 'to_string': return `omni_str_${e.argType.k}(${a[0]})`;
      case 'to_string_g': return `omni_str_realg(${a[0]}, ${a[1]})`;
      case 'trunc': return `omni_trunc(${a[0]})`;
      // 位重解释（ADR-0019 路 1）：位不动，只换一种读法。
      case 'realbits': return `omni_r_bits(${a[0]})`;
      case 'bitsreal': return `omni_r_frombits(${a[0]})`;
      // 引用的身份整数：这条腿上数组就是指针，所以是一次强转（omni.h 里是宏，
      // 真符号留着给 run-llvm 那条腿）。
      case 'refid': return `omni_refid(${a[0]})`;
      case 'chr': return `omni_chr(${a[0]})`;
      case 'fail': return `omni_fail(${a[0]})`;
      case 'repr': return `omni_repr_real(${a[0]})`;
      case 'int_of_string': return `omni_int_of_string(${a[0]})`;
      case 'real_of_string': return `omni_real_of_string(${a[0]})`;
      case 'read_text': return `omni_read_text(${a[0]})`;
      case 'get_env': return `omni_get_env(${a[0]})`;
      case 'write_text': return `omni_write_text(${a[0]}, ${a[1]})`;
      case 'run_proc': return `omni_run_proc(${a[0]})`;
      // `(r3render PATH)`：三维那一档的光栅化（runtime/omni_r3.c，照 reference 的
      // glrender.cc/renderBase.cc/tile.h 与两份 glsl 转写）。C 与 LLVM 两条腿的权威。
      case 'r3_render': return `omni_r3_render(${a[0]}, ${a[1]})`;
      // `(gfxframe PATH W H FB)`：把一帧交出去（表面文件，runtime/omni_fmt.c 里
      // omni_write_text 旁边那一格）。
      case 'gfx_frame': return `omni_gfx_frame(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;
      /* 指针那一档（jnc/C 那一侧的 `int fb[N]`）。运行时的**真符号一律是平的**
         （omni.h 那段头注：不按值收发 omni_ptr），所以这儿先过一次解引用检查拿地址 ——
         那一句顺带把"空指针 / 第一格越界"挡掉。**后面几格的范围它查不到**：裸地址上
         没有长度，长度由调用方的 W×H 负责（与 `(unsafe …)` 那一档同一条口径）。 */
      case 'gfx_framep':
        return `omni_gfx_framep(${a[0]}, ${a[1]}, ${a[2]}, (int64_t *)${this.ptrChk(e.args[3], 8)})`;
      /* `(gfxcall "名字" 实参…)`：图形设备的宿主面。**平签名**（名字 + 个数 + 十二格
         double，不足的补 0）—— 变参在这条腿与 LLVM 那条腿上都是另一笔账，而这一格值不着。 */
      case 'gfx_call': {
        const vs = a.slice(1);
        while (vs.length < 12) vs.push('0.0');
        return `omni_gfx_call(${a[0]}, ${a.length - 1}, ${vs.join(', ')})`;
      }
      /* `(gfxframefn …)`：把每帧那一格函数交给设备（平签名：一格 `void *`）。
         这条腿上**记下不用** —— CPU 备选与本机 OpenGL 那两档自己有循环。 */
      case 'gfx_frame_fn': return `omni_gfx_frame_fn((void *)${e.func})`;
      /* `(gfxdef 种类 名字 内容)`：往设备上登记一格有名字的串（着色器原文 / 名字表）。
         CPU 备选那一档**记下不用** —— 真去 `glsetshader` 才报"这一档没有可编程管线"。 */
      case 'gfx_def': return `omni_gfx_def(${a[0]}, ${a[1]}, ${a[2]})`;
      // 分配器的作用域（omni_mem.c 的 mark/release）。release 回 0 只是为了让它
      // 在方言里是个表达式 —— 调用方把它当语句用。
      case 'arena_mark': return 'omni_arena_mark()';
      case 'arena_release': return `omni_arena_release(${a[0]})`;
      case 'len':
        return recv.k === 'string' ? `omni_str_len(${a[0]})` : `${cTypeName(recv)}_len(${a[0]})`;
      case 'push': case 'add': case 'pop': case 'clear':
      case 'contains': case 'remove': case 'keys': case 'items':
        return `${cTypeName(recv)}_${e.name}(${a.join(', ')})`;
      case 'dictGet': return `${cTypeName(recv)}_get(${a.join(', ')})`;
      case 'dictSet': return `${cTypeName(recv)}_set(${a.join(', ')})`;
      case 'byteAt': return `omni_byte_at(${a[0]}, ${a[1]})`;
      case 'substr': return `omni_substr(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'indexOf': return `omni_index_of(${a[0]}, ${a[1]})`;
      // list<string>.join：直接把条目数组交给运行时，一次算总长一次分配
      case 'join': return `omni_str_join(${a[0]}->items, ${a[0]}->len, ${a[1]})`;
      case 'tag': return `omni_dyn_tag(${a[0]})`;
      case 'asInt': return `omni_dyn_as_int(${a[0]})`;
      case 'asReal': return `omni_dyn_as_real(${a[0]})`;
      case 'asBool': return `omni_dyn_as_bool(${a[0]})`;
      case 'asString': return `omni_dyn_as_string(${a[0]})`;
      /* 拆回一格函数值。**要那一格强转**（与 asList / asDict 同一条）：运行时那一格
         答的是通用的 `omni_fn`，而这一侧手里有真签名 —— 转过去之后 `(callfn …)`
         发的就是一句普通的间接调用。 */
      case 'asFn': return `(${cTypeName(e.type)})omni_dyn_as_fn(${a[0]})`;
      case 'asList': return `(${cTypeName(e.type)})omni_dyn_as_ref(${a[0]}, OMNI_DYN_LIST)`;
      case 'asDict': return `(${cTypeName(e.type)})omni_dyn_as_ref(${a[0]}, OMNI_DYN_DICT)`;
      case 'dynGet': return `omni_dyn_get(${a[0]}, ${a[1]})`;
      case 'dynSet': return `omni_dyn_set_at(${a[0]}, ${a[1]}, ${a[2]})`;
      case 'dynLen': return `omni_dyn_len(${a[0]})`;
      case 'dynIter': return `omni_dyn_iter(${a[0]})`;
      case 'dynPush': return `omni_dyn_push(${a[0]}, ${a[1]})`;
      case 'dynHas': return `omni_dyn_has(${a[0]}, ${a[1]})`;
      case 'dynKeys': return `omni_dyn_keys_of(${a[0]})`;
      case 'boxDeep': return `omni_box_${cTypeName(e.argType)}(${a[0]})`;
      case 'dynAdd': return `omni_dyn_arith('+', ${a[0]}, ${a[1]})`;
      case 'dynSub': return `omni_dyn_arith('-', ${a[0]}, ${a[1]})`;
      case 'dynMul': return `omni_dyn_arith('*', ${a[0]}, ${a[1]})`;
      case 'dynDiv': return `omni_dyn_arith('/', ${a[0]}, ${a[1]})`;
      case 'dynMod': return `omni_dyn_arith('%', ${a[0]}, ${a[1]})`;
      case 'dynNeg': return `omni_dyn_neg(${a[0]})`;
      // JS 前端的运算语义（ADR-0011）。规则写在 runtime/omni_js.c 里，与 prelude.js 一一对应。
      case 'js_undef': return 'omni_dyn_undef()';
      case 'js_ofFn': return `omni_dyn_of_fn(${a[0]})`;
      // 字符串字面量走字面量池（见 s16Lit）：编译期就是 UTF-16 静态数据，取用时零成本。
      // 落单的代理项在 UTF-8 里没有合法编码（Buffer.from 会替成 U+FFFD），按码元发这一条
      // 顺带也解决了 —— 池子存的本来就是码元。JS 侧不需要对应处理：JSON.stringify 自己
      // 就会把落单代理项转义成 \uXXXX，那边天然无损。
      case 'js_s16': {
        const arg = e.args[0];
        if (arg && arg.kind === 'Const' && typeof arg.value === 'string') {
          return `omni_dyn_of_s16(${this.s16Lit(arg.value)})`;
        }
        return `omni_js_s16(${a[0]})`;
      }
      // 下标是编译期常量时走 geti：实参表读参数（arr_get(args, 0)）是最高频的一条
      case 'js_arr_get': {
        const k = constIndex(e.args[1]);
        if (k !== null) return `omni_js_arr_geti(${a[0]}, ${k})`;
        return `omni_js_arr_get(${a[0]}, ${a[1]})`;
      }
      // `x === "字面量"`：特化成能内联的 omni_js_eq_s16k（见 omni.h）。switch 降下来是
      // 一条 if-else 链，编译器自己的 switch (e.kind) 动辄四十路，省下的是四十次调用。
      case 'js_eq': {
        if (e.strict === true) {
          const l = constKey(e.args[0]);
          const r = constKey(e.args[1]);
          if (r !== null) return `omni_js_eq_s16k(${a[0]}, ${this.s16Lit(r)})`;
          if (l !== null) return `omni_js_eq_s16k(${a[1]}, ${this.s16Lit(l)})`;
        }
        return `omni_js_eq(${e.strict === true}, ${a[0]}, ${a[1]})`;
      }
      // 键是字面量时走 ...k：字典的键口径是 UTF-8，字面量池里已经算好了一份静态的，
      // 免掉 omni_js_prop 每次的 UTF-16 -> UTF-8 转换和 arena 分配（见 omni_js_obj.h）。
      case 'js_obj_get': case 'js_obj_set': case 'js_obj_has': case 'js_obj_delete': {
        const k = constKey(e.args[1]);
        if (k !== null) {
          const args = [a[0], this.strLit(k), ...a.slice(2)];
          return `omni_${e.name}k(${args.join(', ')})`;
        }
        return `${JS_ALL[e.name].c}(${a.join(', ')})`;
      }
      default: {
        const abi = JS_ALL[e.name];
        if (!abi) throw new Error(`c.builtin: ${e.name}`);
        /* `noC`：ADR-0020 P1 那一族（真对象 / Symbol / 迭代器协议）还只有 JS 侧的实现。
         * 在**发射的时候**就骂，而不是让它落成一个 C 链接期的 undefined symbol ——
         * 那种错误会指向生成的 .c 的某一行，而真相是"这条腿还没修完"。 */
        if (abi.noC === true) {
          /* 用 OmniError 而不是裸 Error：这是一句**给人看的拒绝**，CLI 那边只印 message
             一行。从前是裸 Error，印出来是一整片 node 栈 —— 响是响了，可看着像我们崩了。 */
          throw new OmniError(`backend-c: '${e.name}' 还没有 C 实现（ADR-0020 P1-c）——`
            + 'JS 的真对象 / Symbol / normalize 那一族现在只在 node 宿主上成立；'
            + '这份程序请走 --backend js 或解释器');
        }
        const lits = (abi.lit ?? []).map((k) => {
          const v = e[k];
          // litText：整个词按 omni_str 传（见 js_abi 的 js_sym_wk）；别的字符串 lit 是一格 op 码
          if (abi.litText === true && typeof v === 'string') {
            const bytes = utf8Bytes(v);
            return `omni_str_new(${cString(bytes)}, ${bytes.length})`;
          }
          return typeof v === 'string' ? `'${v}'` : String(v === true);
        });
        // 少给的尾部实参补 undefined。JS 那边少传就是 undefined，C 是定参函数 ——
        // 不补的话"把一个 op 的 arity 加宽"就会让老调用点在 clang 上炸（曾经就是：
        // js_str_last_index_of 从 2 变 3 之后，tests/oir 里那个两参调用编不过）。
        const pad = [];
        for (let i = a.length; i < (abi.arity ?? a.length); i++) pad.push('omni_dyn_undef()');
        return `${abi.c}(${[...lits, ...a, ...pad].join(', ')})`;
      }
    }
  }
}

function cReal(v) {
  if (Number.isNaN(v)) return '(0.0/0.0)';
  if (v === Infinity) return '(1.0/0.0)';
  if (v === -Infinity) return '(-1.0/0.0)';
  // 负零：`toPrecision` 把符号丢了（JS 里 `(-0).toPrecision(17)` 是 `"0.0000…"`）。
  // 它看得见 —— `(sfix … (int 2))` 印 `-0.00`，五条腿要一致。
  if (v === 0 && 1 / v < 0) return '-0.0';
  // 17 位有效数字保证 double 往返无损
  const s = v.toPrecision(17);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * 字符串的 UTF-8 字节：搬到 `host/utf8.js` 了 —— LLVM 后端第二阶段也要它，
 * 而复制第二份的下场是两条腿在落单代理项上分叉（见那个文件的头）。
 */

/**
 * 属性键里编译期就定下来的那个字符串。前端把 `o.k` / `o['k']` / `'k' in o` 都降成
 * `js_s16(Const)`（见 frontend-js/lower.js 的 s16），所以只认这一个形状。
 * 不是字面量就返回 null，调用点退回通用的那条。
 * @returns {string | null}
 */
function constKey(n) {
  if (!n || n.kind !== 'Builtin' || n.name !== 'js_s16') return null;
  const c = n.args[0];
  if (!c || c.kind !== 'Const' || typeof c.value !== 'string') return null;
  return c.value;
}

/**
 * 下标里编译期就定下来的那个整数。JS 域的数只有 real 一种，所以还要确认它真是个整数
 * 且落在安全整数范围里 —— 不然 `(int64_t)` 的口径和 omni_js_arr_i 的就不是一回事了。
 * @returns {string | null}
 */
function constIndex(n) {
  if (n && n.kind === 'Box') n = n.expr;
  if (!n || n.kind !== 'Const' || typeof n.value !== 'number') return null;
  if (!Number.isInteger(n.value) || Math.abs(n.value) > 9007199254740991) return null;
  return String(n.value);
}

function cString(bytes) {
  let s = '"';
  for (const b of bytes) {
    if (b === 0x22) s += '\\"';
    else if (b === 0x5c) s += '\\\\';
    else if (b === 0x0a) s += '\\n';
    else if (b === 0x0d) s += '\\r';
    else if (b === 0x09) s += '\\t';
    // 问号一律转义：C99 里 ??= ??( ??/ ... 是三字符组，编译器会在**看字符串之前**替换掉
    // （clang 只给个 warning 就换了），于是 '??=' 这个字面量在产出里变成 '#'，长度还对不上。
    // 词法器的标点表里就有它，所以自举出来的编译器认不出 ??= —— 是这么发现的。
    else if (b === 0x3f) s += '\\?';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += `\\${b.toString(8).padStart(3, '0')}`;
  }
  return `${s}"`;
}

/**
 * 模块路径 -> 翻译单元名。取 `src/` 之后那一段、去掉扩展名、非字母数字换成下划线 ——
 * 这样 `.c` / `.o` 的名字与源码树一一对应（`core_frontend-js_lower.c`），
 * 出了问题一眼看出是哪个模块，缓存键也能按模块算。
 */
function modUnitName(file) {
  const s = typeof file === 'string' ? file : '';
  const i = s.lastIndexOf('/src/');
  const rel = i >= 0 ? s.slice(i + 5) : s;
  const cut = rel.replace(/\.[A-Za-z0-9]+$/, '');
  const nm = cut.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return nm === '' ? 'unknown' : nm;
}

/** @param {any} mod OIR 模块 */
/** @param {any} mod OIR 模块 @param {{amalgamate?: boolean}} opts */
export function emitC(mod, opts = {}) {
  return new CEmitter(mod, opts).emit();
}

/**
 * 与 `emitC` 同一趟，但把**按源文件的产出分布**也交出来：`{ text, stats }`。
 * 另开一个入口而不是改 `emitC` 的返回形状：`emitC` 有一二十个调用点，而它交的是一个字符串 ——
 * 改形状要一二十处一起动，多一条只是多一条（与 host 那边 spawn / spawnIn 同一条理由）。
 */
export function emitCWithStats(mod, opts = {}) {
  const e = new CEmitter(mod, opts);
  const text = e.emit();
  return { text, stats: e.stats, syms: e.syms };
}

/**
 * 按模块发射：**一个模块一份 `.c` + 一份同名 `.h`**，跟正常的 C 工程一样 ——
 * `{ gen: {name, h, c}, units: [{ file, name, funcs, bytes, h, c }], stats }`。
 * 与 `emitC` 是两条路而不是一个开关：单体那条路一个字节都不动。
 */
/**
 * **自足的一份模块**（跨文件模块化那条路）：`{ h, c }`。差别见 `moduleFiles` 的头注释 ——
 * 这一条收的是"本来就独立的一段方言"降出来的 OIR。
 */
export function emitCModule(mod, name, opts = {}) {
  const e = new CEmitter(mod, { ...opts, modules: true, selfContained: true });
  e.emit();
  return { ...e.moduleFiles(name), stats: e.stats, syms: e.syms };
}

export function emitCUnits(mod, opts = {}) {
  const e = new CEmitter(mod, { ...opts, modules: true });
  e.emit();
  return { ...e.headers(), stats: e.stats };
}
