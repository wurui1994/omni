// src/core/graph/backend-wat.js —— **第四个后端：wasm（WAT 文本）**
//
// `docs/design/node-graph-contract.md` §9 那段"先量后写"的下一步。这一份的价值不在
// "多一条腿"，在**让缺口清单第一次真的有内容**：前三个后端（interp / sx / js）都住在
// JS 宿主里，什么都接得住，于是 `gaps()` 一直是空转的。wasm 不一样 —— 它没有字符串、
// 没有 GC、控制流是结构化的，接不住的东西当场说出名字。
//
// ## 判据（这一份不许自说自话）
//
// 出来的 WAT 文本交给**另一个前端**（`src/core/frontend-wat/lower.js`，WAT -> OIR）读，
// 再用 `interpretMir` 真跑一遍，输出与 interp / js 两条腿逐行相同。
// 也就是说：这一格的正确性由一条**互不相干的**已有实现来证，不是由我自己证。
//
// ## 能接的子集（量出来的，见设计文档 §9 那三条）
//
//   整数（i64）· 函数 + 调用 + return · if（语句位置与**值位置**都行）· while（含 post 步进）
//   · 打印整数 · **记录与列表**（线性内存 + 一格 bump 分配器）· **多值**（同上）
//   · **切片**（运行期大小的分配 + 一圈拷贝循环）· **break / continue**（block + loop 两格标签）
//   · **出口动作**（`scope-exit`：一格注册标志 + 每条出口上贴动作）
//
// ## 布局（没有类型的那一层怎么排内存）
//
//   * 一块 `(memory 1)` + 一格 `(global $hp (mut i32))`，从 8 号地址起（0 留空）。
//   * 值一律 8 字节（i64）。地址也装在 i64 里，取内存时 `i32.wrap_i64` ——
//     那一格转换就是"wasm 有线性内存但没有原生指针"的样子。
//   * **字段名 -> 槽位是一张管整个模块的表**：图这一层没有类型，`field-get` 只拿到名字，
//     所以 `x` 在任何记录里都落同一格偏移，记录按"它用到的最大槽位"分配。
//     浪费空间但不会错 —— 真正按类型排的布局要等 `carry` 那一问有类型（附录 A.5）。
//   * 列表：**长度存在偏移 0，元素从 8 起**。`index-get` 的边界检查因此有地方读
//     （越界落 `unreachable` —— 那是 `index-get` 与 `field-get` 分两格的理由之一）。
//   * **字符串在 data 段里**，布局与宿主面那格 `print_str` 的约定共用一份：
//     前 8 字节长度、正文从 +8 起、一字节一格。常量的地址编译期就定下，`$hp` 从它们后面起步。
//     "这一格装的是数还是串"没有类型可问，所以做一格最小的静态追踪（见 kindOf）：
//     串只许待在"绑给局部量"与"打印"两处，流到别处一律报缺口。
//
// ## 接不住的，有名有姓（**节点级已经归零**，剩下的是形状上的账，见 WAT_SHAPES）
//
//   * `func` 当值用（真闭包）—— 要函数表 + call_indirect。**嵌套的函数不在这一条里**：
//     只被直接调用的那些走 **lambda 提升**（捕获来的名字当多出来的形参）。
//   * 嵌套的函数写了捕获来的名字 —— 提升是按值传的，那次写外面看不见。
//   * 一格量先装串后装数（或先实数后整数）—— wasm 的局部量只有一种类型。
//   * 字符串的拼接（`+` 落在串上）· 实数进记录 / 列表 / 实参 / 返回值。

import { NODES } from './nodes.js';
// 变参内建（`+ - * /`）的 arity 与折法归这张表 —— 两处各写一套就是两套语义
import { PRIMS } from './prims.js';
// 字符串常量要发成一段字节 —— 与 C / LLVM 两条腿共用同一份编码（宿主的 TextEncoder 不用）
import { utf8Bytes } from '../host/utf8.js';
// 判据那一侧：出来的文本交给**另一个前端**读、用 MIR 的解释器真跑
// （所以这一格的正确性不由我自己证 —— 见文件头"判据"那一段）。
import { lowerWat } from '../frontend-wat/lower.js';
import { Diagnostics, SourceFile } from '../source/diag.js';
import { interpretMir } from '../mir/interp.js';

/** 能接住的节点：**白名单**（不在名单里的一律给一句人话，那句话就是账）。 */
const CAN = new Map([
  ['const', true], ['ref', true], ['bind', true], ['set', true],
  ['call', true], ['prim', true], ['branch', true], ['loop', true],
  ['region', true], ['func', true], ['ret', true],
  // 记录与列表在线性内存里（一格 bump 分配器 + 一张字段偏移表，见文件头"布局"那一段）
  ['record-new', true], ['field-get', true], ['field-set', true],
  ['list-new', true], ['index-get', true], ['index-set', true],
  ['values', true], ['pick', true],
  ['conv', true],
  ['slice', true],
  ['scope-exit', true],
  ['loop-exit', true],
]);

export function watCan(op) {
  const ans = CAN.get(op);
  if (ans === undefined) return NODES.has(op) ? `wat 后端还没接：${op}` : `no such node: ${op}`;
  return ans;
}

/**
 * **形状上的账**：不是"哪格节点接不住"，而是"同一格节点的某种用法接不住"。
 * 分开记的理由是 `gaps()` 只问得出前者 —— 到这一批为止，`CAN` 里已经没有 false 了
 * （节点级缺口 0 格），可矩阵里还有两格在跳。那两格要是不写在这儿，
 * "没有缺口（全接得住）"这句话就成了假话。
 */
export const WAT_SHAPES = [
  {
    what: '`func` 当值用（真闭包）',
    why: '要函数表 + call_indirect（WAT 前端第一阶段不认）。**只被直接调用**的嵌套函数不走这条 —— 它们按 lambda 提升接住了',
  },
  {
    what: '嵌套的函数写了捕获来的名字',
    why: '提升是按值传的，那次写外面看不见 —— 要真的闭包环境（线性内存里的一块）',
  },
  {
    what: '一格量先装串后装数（或先实数后整数）',
    why: 'wasm 的局部量只有一种类型，而图这一层没有类型 —— awk 那种无声明的语言真的答不出来',
  },
  {
    what: '字符串的拼接（`+` 落在串上）',
    why: '运行期造串的机器有了（$__str_join），但"结果也是串"要顺着 kindOf 传，那一步没做',
  },
  {
    what: '实数进记录 / 列表 / 实参 / 返回值',
    why: '内存里一格是 8 字节的 i64，实数要按类型排的布局（附录 A.5 的 carry）',
  },
];

/** 一格算符 -> wasm 指令。比较那一族出 i32（只许在条件位置用），别的出 i64。 */
const ARITH = new Map([
  ['+', 'i64.add'], ['-', 'i64.sub'], ['*', 'i64.mul'],
  ['/', 'i64.div_s'], ['%', 'i64.rem_s'],
]);
const CMP = new Map([
  ['<', 'i64.lt_s'], ['>', 'i64.gt_s'], ['<=', 'i64.le_s'], ['>=', 'i64.ge_s'],
  ['=', 'i64.eq'], ['!=', 'i64.ne'],
]);
/**
 * 实数那一侧的同一批算符。**两张表而不是一张带类型的表**：wasm 的指令名里就带着类型
 * （`i64.add` / `f64.add`），所以"哪种数值类型"这一问在这一层的答案就是"查哪张表"。
 * `%` 不在里面 —— wasm 的 f64 没有取余指令（要报缺口，不许拿 trunc 凑）。
 */
const FARITH = new Map([['+', 'f64.add'], ['-', 'f64.sub'], ['*', 'f64.mul'], ['/', 'f64.div']]);
const FCMP = new Map([
  ['<', 'f64.lt'], ['>', 'f64.gt'], ['<=', 'f64.le'], ['>=', 'f64.ge'],
  ['=', 'f64.eq'], ['!=', 'f64.ne'],
]);

/** wasm 的名字：`$` + 安全化（`max2` / `string-append` 那种带横杠的名字要转）。 */
const wname = (n) => `$${String(n).replace(/[^A-Za-z0-9_]/g, '_')}`;

/**
 * 一格值的**种类**落到 wasm 的哪种类型上。种类是这一层自己算的（图上没有类型）：
 * `int` / `str`（地址）都是 i64，`real` 是 f64 —— **两种数值类型**就差这一格。
 */
const wty = (kind) => (kind === 'real' ? 'f64' : 'i64');

class Gap extends Error {}

/**
 * **运行期造串**：把 `base` 处那 `n` 格 i64 印成一行（空格分隔），出一格串的地址。
 * 只在"打印一格多值"用到，所以按需发（`needJoin`）。
 *
 * 这一格是"缺口清单会变短"的样子：多值本身早就接住了（一块 N 格存储 + 地址），
 * 印成一行缺的只是**把数变成字节**。wasm 上没有 sprintf，所以就是三圈循环：
 * 数位数 → 从末位往前填 → 最后把长度写进偏移 0（与 `print_str` 的约定同一份）。
 *
 * 预留 `8 + n * 22` 字节：一格 i64 最多 20 位数字 + 一格负号 + 一格分隔空格。
 * 写完才知道真长度，所以 `$hp` 按预留量推 —— 浪费几个字节，但不会算错。
 */
const STR_JOIN = `  (func $__str_join (param $base i64) (param $n i64) (result i64)
    (local $out i64) (local $p i32) (local $i i64) (local $v i64) (local $d i64) (local $t i64) (local $j i32)
    (local.set $out (i64.extend_i32_u (global.get $hp)))
    (global.set $hp (i32.add (global.get $hp)
      (i32.add (i32.const 8) (i32.mul (i32.wrap_i64 (local.get $n)) (i32.const 22)))))
    (local.set $p (i32.add (i32.wrap_i64 (local.get $out)) (i32.const 8)))
    (local.set $i (i64.const 0))
    (block $done (loop $each
      (if (i64.ge_s (local.get $i) (local.get $n)) (then (br $done)))
      (if (i64.gt_s (local.get $i) (i64.const 0)) (then
        (i32.store8 (local.get $p) (i32.const 32))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))))
      (local.set $v (i64.load (i32.add (i32.wrap_i64 (local.get $base))
        (i32.wrap_i64 (i64.mul (local.get $i) (i64.const 8))))))
      (if (i64.lt_s (local.get $v) (i64.const 0)) (then
        (i32.store8 (local.get $p) (i32.const 45))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (local.set $v (i64.sub (i64.const 0) (local.get $v)))))
      (local.set $d (i64.const 1))
      (local.set $t (i64.div_s (local.get $v) (i64.const 10)))
      (block $counted (loop $count
        (if (i64.le_s (local.get $t) (i64.const 0)) (then (br $counted)))
        (local.set $d (i64.add (local.get $d) (i64.const 1)))
        (local.set $t (i64.div_s (local.get $t) (i64.const 10)))
        (br $count)))
      (local.set $j (i32.add (local.get $p) (i32.sub (i32.wrap_i64 (local.get $d)) (i32.const 1))))
      (loop $digit
        (i32.store8 (local.get $j)
          (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_s (local.get $v) (i64.const 10)))))
        (local.set $v (i64.div_s (local.get $v) (i64.const 10)))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (if (i32.ge_s (local.get $j) (local.get $p)) (then (br $digit))))
      (local.set $p (i32.add (local.get $p) (i32.wrap_i64 (local.get $d))))
      (local.set $i (i64.add (local.get $i) (i64.const 1)))
      (br $each)))
    (i64.store (i32.wrap_i64 (local.get $out)) (i64.extend_i32_s
      (i32.sub (local.get $p) (i32.add (i32.wrap_i64 (local.get $out)) (i32.const 8)))))
    (local.get $out)
  )`;

/** 缺口那句话：白名单里写好的理由优先（`can` 与 `lower` 说的是同一句）。 */
const why = (op, where) => {
  const ans = CAN.get(op);
  return new Gap(typeof ans === 'string' ? ans : `${where}上还接不住 ${op}`);
};

/**
 * 一格函数的作用域：名字 -> wasm 局部量名。嵌套 region 里同名的量各占一格。
 *
 * 还带一格 `kinds`：那个名字装的是**数**还是**串**。图这一层没有类型，而 wasm 上
 * 串是"内存里的一块地址"、数就是数，打印那一步必须知道是哪一种 —— 所以这里做一格
 * 最小的静态追踪（只认 const / ref / bind / set 这几格，追不到的按数算）。
 * 同一个名字先装串后装数（或反过来）记成 `mix`：那种量在 wasm 上打印不出来，报缺口。
 */
class Scope {
  constructor(fn, parent = null) {
    this.fn = fn; this.parent = parent; this.names = new Map(); this.kinds = new Map();
    /** 提升上来的嵌套函数：图上的名字 -> `{ wat, captures }`（只在它的宿主函数里看得见）。 */
    this.lifts = new Map();
  }

  declareLift(name, info) { this.lifts.set(name, info); }

  lookupLift(name) {
    for (let s = this; s !== null; s = s.parent) if (s.lifts.has(name)) return s.lifts.get(name);
    return null;
  }

  declare(name, kind = 'int') {
    let id = wname(name);
    while (this.fn.taken.has(id)) id = `${id}_`;
    this.fn.taken.add(id);
    this.fn.locals.push({ id, ty: wty(kind) });
    this.names.set(name, id);
    this.kinds.set(name, kind);
    return id;
  }

  lookup(name) {
    for (let s = this; s !== null; s = s.parent) if (s.names.has(name)) return s.names.get(name);
    return null;
  }

  /** 那个名字装的是什么。没登记过（形参、追不到的）按数算。 */
  kindOf(name) {
    for (let s = this; s !== null; s = s.parent) if (s.names.has(name)) return s.kinds.get(name) ?? 'int';
    return 'int';
  }

  /** 赋值：种类不一致就是 `mix`（打印那一步会因此报缺口，而不是印出一格地址）。 */
  merge(name, kind) {
    for (let s = this; s !== null; s = s.parent) {
      if (s.names.has(name)) {
        const had = s.kinds.get(name) ?? 'int';
        if (had !== kind) s.kinds.set(name, 'mix');
        return;
      }
    }
  }
}

const asList = (x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));

/**
 * 一块图里出现的名字：读到的（`ref` / `set`）与绑住的（`bind` / `func` 的形参）。
 * **lambda 提升**要它：自由名字 = 读到的 - 绑住的。
 * 这是一趟纯结构的走查（按端口走，不认识任何具体节点）—— 加新节点不用改它。
 */
function namesIn(x, refs, binds) {
  if (x === null || x === undefined) return;
  if (Array.isArray(x)) { for (const y of x) namesIn(y, refs, binds); return; }
  if (x.op === 'ref' || x.op === 'set') refs.add(x.attrs.name);
  if (x.op === 'bind') binds.add(x.attrs.name);
  if (x.op === 'func') for (const p of asList(x.attrs?.params)) binds.add(String(p));
  for (const k of Object.keys(x.ins ?? {})) namesIn(x.ins[k], refs, binds);
}

/** 这块图里被**写**过的名字（`set`）。捕获来的量只许读，所以要单独数一遍。 */
function writtenIn(x, out = new Set()) {
  if (x === null || x === undefined) return out;
  if (Array.isArray(x)) { for (const y of x) writtenIn(y, out); return out; }
  if (x.op === 'set') out.add(x.attrs.name);
  for (const k of Object.keys(x.ins ?? {})) writtenIn(x.ins[k], out);
  return out;
}

/**
 * 一份 WAT 模块。`funcs` 是"顶层 bind 了一格 func"的那些，别的顶层语句进 `$__entry`。
 * 每个函数自己带一份 `locals`（wasm 的局部量是函数级的，所以 region 只影响名字查找）。
 */
class Mod {
  constructor() { this.fns = new Map(); this.out = []; }

  /** 建一格函数：`taken` 防重名、`locals` 收局部量、`ret` 记它到底出不出值。 */
  fn(name, params, src = null) {
    const f = {
      name, params, locals: [], taken: new Set(params.map(wname)), body: [], ret: false,
      // 它在图上叫什么（提升出来的嵌套函数也要能被 `retOf` 查到 —— 那张表按**图上的名字**排）
      src: src ?? name,
      multi: 0,   // 它返回的是**几格多值**（0 = 不是多值）—— 打印那一步要知道格数
    };
    this.fns.set(name, f);
    return f;
  }

  /** 一格没被占用的函数名（嵌套函数提升上来时可能与顶层同名）。 */
  uniq(base) {
    let id = base;
    while (this.fns.has(id)) id = `${id}_`;
    return id;
  }
}

/** 顶层 bind 的那些函数名（`call` 要认得它们 —— 别的名字当局部量）。 */
function topFuncs(items) {
  const names = new Map();
  for (const it of items) {
    if (it !== null && it !== undefined && it.op === 'bind' && it.ins?.init?.op === 'func') {
      names.set(it.attrs.name, wname(`f_${it.attrs.name}`));
    }
  }
  return names;
}

/**
 * 出一份 WAT。**跑两遍**：第一遍只为把"哪个函数出值"数出来（语句位置的调用要不要
 * `drop` 取决于它），第二遍拿着那张表出正式的文本。图都很小，两遍比猜便宜。
 */
function emitOnce(graph, retOf, multiOf) {
  const items = asList(graph.kind === 'graph' ? graph.body : graph);
  const mod = new Mod();
  const fns = topFuncs(items);
  let loopSeq = 0;
  let tmpSeq = 0;
  /** 当前嵌在哪几格 loop 里（`break` / `continue` 各有一格 block 标签 + 进来时的 region 深度）。 */
  const loops = [];
  /**
   * 当前嵌在哪几格 region 里，每格装着它的**出口动作**。
   * 一格出口动作 = `{ flag, act }`：`flag` 是一格 i64 局部量（注册那一刻置 1），
   * `act` 是动作的语句。**为什么要 flag**：`scope-exit` 可能藏在 `if` 里，
   * 没注册过就不许在出口跑 —— 静态地把动作贴到出口上会把这一条丢掉。
   */
  const regions = [];
  /** 一格 region 的出口：**逆序**，每格看自己的 flag。 */
  const runExits = (marks) => [...marks].reverse()
    .map((m) => `(if (i64.ne (local.get ${m.flag}) (i64.const 0)) (then ${m.act}))`);
  let needMem = false;
  /**
   * **字段名 -> 槽位**（一张表管整个模块）。图这一层没有类型，`field-get` 只拿到名字，
   * 所以 `x` 在任何记录里都落同一格偏移；记录按"它用到的最大槽位"分配。
   * 浪费空间但不会错 —— 真正按类型排的布局要等 `carry` 那一问有类型（附录 A.5）。
   */
  const slots = new Map();
  const slotOf = (name) => {
    if (!slots.has(name)) slots.set(name, slots.size);
    return slots.get(name);
  };
  /** 地址：值一律 i64，取内存要 i32 —— 这一格转换就是"wasm 有内存没有指针"的样子。 */
  const addr = (e) => `(i32.wrap_i64 ${e})`;

  /* ---------------------------------------------- 字符串：data 段里的一块 --------
   * 布局与宿主面那格 `print_str` 的约定**共用一份**（tests/wat/cases/05-print-str.wat
   * 钉的是同一句话）：**前 8 字节是长度，正文从 +8 起，一字节一格**。
   * 常量的地址是编译期就定下的 —— 所以字符串不走 bump 分配器，`$hp` 从它们后面起步。
   * 只认 ASCII：≥ 0x80 的字节报缺口（前端那侧也是当场 fail），理由同一条 ——
   * 拼字节印出乱码比报错糟得多。
   */
  const strs = new Map();     // 文本 -> 地址
  const data = [];            // [{ off, bytes }]
  let dataEnd = 8;            // 0 号地址留空（与 `$hp` 的起点同一条约定）
  let needStr = false;
  let needF64 = false;    // 用到实数了吗（宿主面那格 `print_f64` 按需发）
  let needJoin = false;   // 要不要那格运行期造串的辅助函数（打印多值）
  function strAddr(s) {
    if (strs.has(s)) return strs.get(s);
    const bytes = utf8Bytes(s);
    for (const b of bytes) {
      if (b >= 0x80) throw new Gap('非 ASCII 的字符串还没接：宿主面那格 print_str 只认 ASCII 字节');
    }
    needMem = true;
    const at = dataEnd;
    const len = [];
    for (let i = 0; i < 8; i++) len.push(Math.floor(bytes.length / 256 ** i) % 256);   // 小端
    data.push({ off: at, bytes: [...len, ...bytes] });
    // 8 字节对齐：长度那一格要按 i64 读
    dataEnd = at + 8 + Math.ceil(bytes.length / 8) * 8;
    strs.set(s, at);
    return at;
  }

  /* ---------------------------------------------- 顶层的名字：wasm 的全局量 --------
   * 顶层 `bind` 里**不是函数**的那些落成 `(global $g_x (mut i64) …)`，初值在 `$__entry`
   * 里赋。**为什么不能当 `$__entry` 的局部量**：wasm 的局部量是函数级的，别的函数看不见 ——
   * 而 Scheme 那份 index 例子正是"顶层 define 一格向量、函数体里读它"（`xs`）。
   * 图上它与函数体里的 `bind` 是**同一格节点**；落法分两种只因为 wasm 的作用域分两层。
   */
  const globals = new Map();      // 名字 -> wasm 全局量名
  const globalKinds = new Map();  // 名字 -> 'int' | 'str' | 'mix'
  for (const it of items) {
    if (it !== null && it !== undefined && it.op === 'bind' && it.ins?.init?.op !== 'func') {
      globals.set(it.attrs.name, wname(`g_${it.attrs.name}`));
    }
  }

  /**
   * 这一格值装的是**数**（`int`）、**实数**（`real`）还是**串**（`str`，一格地址）。
   * 图那一层没有类型，所以只能静态追这几格；追不到的一律按 `int` ——
   * 而"串 / 实数流到追不着的地方"这件事在各个消费点上报缺口（见 onlyInt），
   * 所以答案不会悄悄错：要么是数，要么明说接不住。
   */
  function kindOf(x, sc) {
    if (x === null || x === undefined) return 'int';
    if (Array.isArray(x)) {
      const l = asList(x);
      return l.length === 0 ? 'int' : kindOf(l[l.length - 1], sc);
    }
    if (x.lit !== undefined) return litKind(x.lit);
    switch (x.op) {
      case 'const': return litKind(x.attrs.value);
      case 'ref': {
        const nm = x.attrs.name;
        return sc.lookup(nm) !== null ? sc.kindOf(nm) : (globalKinds.get(nm) ?? 'int');
      }
      case 'region': return kindOf(x.ins.body, sc);
      // 表示转换：目标那一栏（`to`）就是答案 —— 这一格是"两种数值类型"的入口
      case 'conv': return x.attrs.to === 'float' ? 'real' : 'int';
      // 算术：**有一边是实数，结果就是实数**（比较出的是真假，算 int）
      case 'prim': {
        if (!ARITH.has(x.attrs.name)) return 'int';
        return asList(x.ins.args).some((a) => kindOf(a, sc) === 'real') ? 'real' : 'int';
      }
      case 'branch': {
        const a = kindOf(x.ins.then, sc); const b = kindOf(x.ins.else, sc);
        return a === b ? a : 'mix';
      }
      default: return 'int';
    }
  }

  /** 一格字面量的种类。**整数与实数在图上都是 number**，判据只有"是不是整"这一条。 */
  const litKind = (v) => {
    if (typeof v === 'string') return 'str';
    if (typeof v === 'number' && !Number.isInteger(v)) return 'real';
    return 'int';
  };

  /** 串只许待在"绑给局部量"与"打印"这两处。别的地方接住了就是给错答案，所以报缺口。 */
  function onlyInt(x, sc, where) {
    const k = kindOf(x, sc);
    if (k === 'str' || k === 'mix') {
      throw new Gap(`${where}上还接不住字符串（wasm 上它是内存里的一块地址，要类型层才认得出）`);
    }
    if (k === 'real') {
      throw new Gap(`${where}上还接不住实数（内存里的一格是 i64，要按类型排的布局）`);
    }
  }

  /**
   * 一格 bump 分配：`$hp` 往前推 n 字节，返回装着地址的那格临时量。
   * `bytes` 给数字就是编译期大小，给字符串就是一格 **i32 表达式**（运行期大小 ——
   * 切片要的就是这一格：长度是算出来的）。
   */
  function alloc(bytes, sc, pre) {
    needMem = true;
    const a = tmp(sc);
    const n = typeof bytes === 'number' ? `(i32.const ${bytes})` : bytes;
    pre.push(`(local.set ${a} (i64.extend_i32_u (global.get $hp)))`);
    pre.push(`(global.set $hp (i32.add (global.get $hp) ${n}))`);
    return a;
  }

  /** 下标的边界检查（`index-get` 与 `field-get` 分两格的理由之一，就是这一句）。 */
  function guard(o, i, pre) {
    pre.push(`(if (i64.lt_s (local.get ${i}) (i64.const 0)) (then (unreachable)))`);
    pre.push(`(if (i64.ge_s (local.get ${i}) (i64.load ${addr(`(local.get ${o})`)}))`
      + ' (then (unreachable)))');
  }

  const isTrue = (x) => x !== null && x !== undefined
    && ((x.lit === true) || (x.op === 'const' && x.attrs.value === true));

  /**
   * 一格临时量。**值位置的 `if` 要它** —— wasm 的 block 不带 result（见文件头那条账）。
   * `ty` 跟着值的种类走（实数要 f64 的那一格）。
   */
  function tmp(sc, ty = 'i64') {
    const id = `$t${++tmpSeq}`;
    sc.fn.taken.add(id);
    sc.fn.locals.push({ id, ty });
    return id;
  }

  /** 条件位置：出 i32。比较那一族直接出，别的与 0 比。 */
  function cond(x, sc, pre) {
    if (isTrue(x)) return '(i32.const 1)';
    if (x !== null && x !== undefined && x.op === 'prim' && CMP.has(x.attrs.name)) {
      const [a, b] = asList(x.ins.args);
      // 有一边是实数就用 f64 那一族（两边都补成 f64）—— 出的还是 i32，条件位置不变
      if (kindOf(a, sc) === 'real' || kindOf(b, sc) === 'real') {
        return `(${FCMP.get(x.attrs.name)} ${asF64(a, sc, pre)} ${asF64(b, sc, pre)})`;
      }
      return `(${CMP.get(x.attrs.name)} ${expr(a, sc, pre)} ${expr(b, sc, pre)})`;
    }
    if (kindOf(x, sc) === 'real') return `(f64.ne ${expr(x, sc, pre)} (f64.const 0))`;
    return `(i64.ne ${expr(x, sc, pre)} (i64.const 0))`;
  }

  /** 把一格值取成 f64：本来是实数就原样，是整数就补一格 convert。 */
  function asF64(y, sc, pre) {
    return kindOf(y, sc) === 'real' ? expr(y, sc, pre) : `(f64.convert_i64_s ${expr(y, sc, pre)})`;
  }

  /**
   * 值位置：出 i64。**只有整数**（字符串 / 记录 / 列表在 `can` 那儿就挡住了）。
   * 要先跑的语句推到 `pre` 里 —— 值位置的 `if` 就是靠这一格落地的。
   */
  function expr(x, sc, pre) {
    if (x === null || x === undefined) return '(i64.const 0)';
    if (Array.isArray(x)) return valueOf(x, sc, pre);
    if (x.lit !== undefined) return litOf(x.lit);
    switch (x.op) {
      case 'const': return litOf(x.attrs.value);
      case 'ref': {
        const id = sc.lookup(x.attrs.name);
        if (id === null) {
          // 顶层绑的名字在 wasm 里是全局量（函数看得见的只有它）
          const g = globals.get(x.attrs.name);
          if (g !== undefined) return `(global.get ${g})`;
          if (fns.has(x.attrs.name)) throw new Gap('函数当值用（闭包）还没接');
          throw new Gap(`没绑过的名字：${x.attrs.name}`);
        }
        return `(local.get ${id})`;
      }
      case 'prim': {
        const args = asList(x.ins.args);
        const name = x.attrs.name;
        // 串上的算术只有一条有意义：`+` 是拼接。那要运行期分配 + 拷贝两段字节，
        // 还得知道结果也是串 —— 这一批没做，明说是缺口（别的算符落在串上本身就是错的）
        for (const a of args) {
          const ka = kindOf(a, sc);
          if (ka === 'str' || ka === 'mix') {
            throw new Gap(name === '+' ? '字符串的拼接（`+`）在 wasm 上还没接：要运行期分配 + 拷贝字节'
              : `${name} 落在字符串上 —— wasm 这一批只有数的算术`);
          }
        }
        // **有一边是实数，整个算式就在 f64 上做**（整数那一边补一格 convert）——
        // "两种数值类型"在这一层就是这一句：查哪张表 + 该不该补转换
        const real = kindOf(x, sc) === 'real';
        const num = (y) => (real ? asF64(y, sc, pre) : expr(y, sc, pre));
        if (real && ARITH.has(name) && !FARITH.has(name)) {
          throw new Gap(`实数上的 ${name} 还没接：wasm 的 f64 没有这条指令`);
        }
        const op = real ? FARITH.get(name) : ARITH.get(name);
        if (op !== undefined) {
          // **一元与二元要分开**：`-1` 是一元的 `-`，当成"少一格实参的二元"就会
          // 悄悄算成 `1 - 0`。这个错是矩阵抓出来的（nim / mojo 那两份 loopexit
          // 从 `var j = -1` 起步，wat 那条腿印出 7 而不是 8）——
          // **少一格实参不许当 0 用**，接不住就报缺口。
          if (args.length === 1) {
            if (name === '-') return real ? `(f64.neg ${num(args[0])})` : `(i64.sub (i64.const 0) ${expr(args[0], sc, pre)})`;
            if (name === '+') return num(args[0]);
            throw new Gap(`一元的 ${name} 还没接`);
          }
          if (args.length !== 2) {
            // **变参的折法归内建表**（`prims.js` 里 `+ - * /` 声明的是 `arity: -1`）：
            // 那张表里 interp 用 `reduce` 左折，所以这儿也左折 —— `(+ a b c)` = `(a + b) + c`。
            // 折法写在两处就是两套语义，所以判据取自同一张表，不由这条腿自己定。
            const arity = PRIMS.get(name)?.arity;
            if (arity !== -1) {
              throw new Gap(`${name} 收到 ${args.length} 格实参 —— 内建表里它声明的是 ${arity} 格`);
            }
            if (args.length === 0) {
              // 空的中性元也归那张表：`+` 是 0、`*` 是 1，`-` / `/` 空本身没有意义
              if (name === '+') return real ? '(f64.const 0)' : '(i64.const 0)';
              if (name === '*') return real ? '(f64.const 1)' : '(i64.const 1)';
              throw new Gap(`一格实参都没有的 ${name} 没有意义`);
            }
            return args.slice(1).reduce((acc, y) => `(${op} ${acc} ${num(y)})`, num(args[0]));
          }
          return `(${op} ${num(args[0])} ${num(args[1])})`;
        }
        if (CMP.has(name)) {
          if (args.length !== 2) throw new Gap(`${name} 收到 ${args.length} 格实参`);
          // 比较出 i32，要当值用得补一格符号扩展
          return `(i64.extend_i32_s ${cond(x, sc, pre)})`;
        }
        // `not`：真假在这一批用 0/1 表示，所以它就是"等于 0"
        if (name === 'not' && args.length === 1) {
          return `(i64.extend_i32_s (i64.eqz ${expr(args[0], sc, pre)}))`;
        }
        throw new Gap(`这格内建还没接：${name}`);
      }
      case 'call': return callOf(x, sc, pre);
      // **表示转换**：目标那一栏（`to`）说了要哪一侧的数值类型，这一层只补那一格指令。
      // 往整数走是 `trunc`（截断，与 interp 那侧的 `Math.trunc` 同一条）；
      // 往实数走是 `convert`。已经在那一侧的就什么都不做 —— 那正是"一格 conv 管 12 格 Op"。
      case 'conv': {
        const v = x.ins.value;
        const kv = kindOf(v, sc);
        if (kv === 'str' || kv === 'mix') throw new Gap('串上的表示转换还没接（要类型层）');
        if (x.attrs.to === 'float') return asF64(v, sc, pre);
        if (x.attrs.to === 'int') {
          return kv === 'real' ? `(i64.trunc_f64_s ${expr(v, sc, pre)})` : expr(v, sc, pre);
        }
        throw new Gap(`这格表示转换还没接：${x.attrs.to}`);
      }
      // **值位置的 `if`**：一格临时量 + 两支各赋值。wasm 的 block 不带 result，
      // 所以"表达式位置的 if"不是接不住，是要**先物化成一格临时量** ——
      // 而临时量本来就是调度器算出来的四样之一（ADR-0033 §3.5）。
      case 'branch': {
        const t = tmp(sc, wty(kindOf(x, sc)));
        const c = cond(x.ins.cond, sc, pre);
        const a = []; const av = valueOf(x.ins.then, new Scope(sc.fn, sc), a);
        const b = []; const bv = valueOf(x.ins.else, new Scope(sc.fn, sc), b);
        pre.push(`(if ${c} (then ${[...a, `(local.set ${t} ${av})`].join(' ')})`
          + ` (else ${[...b, `(local.set ${t} ${bv})`].join(' ')}))`);
        return `(local.get ${t})`;
      }
      // `region` 出值：前面几条当语句，最后一格是值（CL 的 `(let (…) … acc)`）
      case 'region': return valueOf(x.ins.body, new Scope(sc.fn, sc), pre);
      // ---- 记录与列表：**线性内存 + 一格 bump 分配器**（wasm 有内存没有指针）----
      case 'record-new': {
        const names = x.attrs.names ?? [];
        const vals = asList(x.ins.fields);
        const size = 8 * (names.length === 0 ? 1 : 1 + Math.max(...names.map(slotOf)));
        const a = alloc(size, sc, pre);
        names.forEach((k, i) => {
          onlyInt(vals[i], sc, '记录的字段');
          const v = expr(vals[i], sc, pre);
          pre.push(`(i64.store (i32.add ${addr(`(local.get ${a})`)} (i32.const ${8 * slotOf(k)})) ${v})`);
        });
        return `(local.get ${a})`;
      }
      case 'field-get': {
        needMem = true;
        const o = expr(x.ins.obj, sc, pre);
        return `(i64.load (i32.add ${addr(o)} (i32.const ${8 * slotOf(x.attrs.field)})))`;
      }
      // 列表：**长度存在偏移 0，元素从 8 起** —— 边界检查因此有地方读
      case 'list-new': {
        const items = asList(x.ins.items);
        const a = alloc(8 * (items.length + 1), sc, pre);
        pre.push(`(i64.store ${addr(`(local.get ${a})`)} (i64.const ${items.length}))`);
        items.forEach((y, i) => {
          onlyInt(y, sc, '列表的元素');
          const v = expr(y, sc, pre);
          pre.push(`(i64.store (i32.add ${addr(`(local.get ${a})`)} (i32.const ${8 * (i + 1)})) ${v})`);
        });
        return `(local.get ${a})`;
      }
      case 'index-get': {
        needMem = true;
        const o = tmp(sc); pre.push(`(local.set ${o} ${expr(x.ins.obj, sc, pre)})`);
        const i = tmp(sc); pre.push(`(local.set ${i} ${expr(x.ins.index, sc, pre)})`);
        guard(o, i, pre);
        return `(i64.load (i32.add ${addr(`(local.get ${o})`)}`
          + ` (i32.add (i32.const 8) ${addr(`(i64.mul (local.get ${i}) (i64.const 8))`)})))`;
      }
      // ---- 切片：**运行期大小的分配 + 一圈拷贝循环** ------------------------------
      //
      // 三样都是量过才敢写的：`$hp` 推的字节数可以是算出来的（不必编译期常量）、
      // `br` 跳**最内层**的 loop 是允许的（跳外层才报）、长度存在偏移 0 好让边界检查有得读。
      case 'slice': {
        needMem = true;
        const o = tmp(sc); pre.push(`(local.set ${o} ${expr(x.ins.obj, sc, pre)})`);
        const srcLen = `(i64.load ${addr(`(local.get ${o})`)})`;
        const f = tmp(sc);
        pre.push(`(local.set ${f} ${x.ins.from === undefined ? '(i64.const 0)' : expr(x.ins.from, sc, pre)})`);
        const t = tmp(sc);
        pre.push(`(local.set ${t} ${x.ins.to === undefined ? srcLen : expr(x.ins.to, sc, pre)})`);
        // 范围检查：0 <= from <= to <= 源长度（越界落 unreachable，与 interp 那侧报错对应）
        pre.push(`(if (i64.lt_s (local.get ${f}) (i64.const 0)) (then (unreachable)))`);
        pre.push(`(if (i64.gt_s (local.get ${t}) ${srcLen}) (then (unreachable)))`);
        pre.push(`(if (i64.gt_s (local.get ${f}) (local.get ${t})) (then (unreachable)))`);
        const n = tmp(sc);
        pre.push(`(local.set ${n} (i64.sub (local.get ${t}) (local.get ${f})))`);
        const a = alloc(`${addr(`(i64.mul (i64.add (local.get ${n}) (i64.const 1)) (i64.const 8))`)}`, sc, pre);
        pre.push(`(i64.store ${addr(`(local.get ${a})`)} (local.get ${n}))`);
        const i = tmp(sc);
        const lab = `$C${++loopSeq}`;
        pre.push(`(local.set ${i} (i64.const 0))`);
        pre.push(`(loop ${lab} (if (i64.lt_s (local.get ${i}) (local.get ${n})) (then`
          + ` (i64.store (i32.add ${addr(`(local.get ${a})`)}`
          + ` ${addr(`(i64.mul (i64.add (local.get ${i}) (i64.const 1)) (i64.const 8))`)})`
          + ` (i64.load (i32.add ${addr(`(local.get ${o})`)}`
          + ` ${addr(`(i64.mul (i64.add (i64.add (local.get ${f}) (local.get ${i})) (i64.const 1)) (i64.const 8))`)})))`
          + ` (local.set ${i} (i64.add (local.get ${i}) (i64.const 1))) (br ${lab}))))`);
        return `(local.get ${a})`;
      }
      // ---- 多值：**`carry` 那一问的答案就是"线性内存里的一块"** ------------------
      //
      // wasm 的函数只有一格结果（multi-value 提案不在这一批），所以多值落成
      // "一块 N 格的存储 + 返回它的地址"；消费侧的 `pick` 就是"读第 k 格"。
      // **长度不存**：`pick` 的 k 是编译期常量（它是一格附属），用不着运行期长度 ——
      // 与列表正相反（列表的下标是运行期算的，所以那儿存了长度好做边界检查）。
      case 'values': {
        const args = asList(x.ins.args);
        const a = alloc(8 * Math.max(args.length, 1), sc, pre);
        args.forEach((y, i) => {
          onlyInt(y, sc, '多值里的一格');
          const v = expr(y, sc, pre);
          pre.push(`(i64.store (i32.add ${addr(`(local.get ${a})`)} (i32.const ${8 * i})) ${v})`);
        });
        return `(local.get ${a})`;
      }
      case 'pick': {
        needMem = true;
        const from = expr(x.ins.from, sc, pre);
        return `(i64.load (i32.add ${addr(from)} (i32.const ${8 * Number(x.attrs.index ?? 0)})))`;
      }
      default: throw why(x.op, '值位置');
    }
  }

  /**
   * 一串东西的**值**：前面几条当语句，最后一格出值。
   * "最后一格有值出端口就是值"这条规矩与 js 后端的 `jsFnBody` **同一条** ——
   * 判据是出端口那一栏，不是 sort（那条被矩阵抓出来过两次）。
   */
  function valueOf(x, sc, pre) {
    const list = asList(x);
    if (list.length === 0) return '(i64.const 0)';
    for (const y of list.slice(0, -1)) pre.push(...stmt(y, sc, sc.fn));
    const last = list[list.length - 1];
    // **wasm 里打印不出值**（宿主面那几条导入都是 `[] -> []`），落到值位置就是
    // "跑一遍，值算 0"。CL 那份 defer 例子就是这个形状：`(princ "in")` 是 region
    // 的最后一格，于是它同时是"要跑的动作"和"这一格 region 的值"。
    if (isVoidish(last) || noFall(last)) {
      pre.push(...stmt(last, sc, sc.fn));
      return '(i64.const 0)';
    }
    return expr(last, sc, pre);
  }

  /**
   * 这一格**不落回来**：`ret` 与 `loop-exit` 一走就不回值位置了，所以它后面那格
   * "把值放进临时量"是死代码。值位置上碰到它们就当语句发一遍，值给 0（没人读得到）。
   *
   * `if (a > b) { return a } else { return b }` 是最常见的形状：函数体最后一格是
   * branch，两支各是一条 `ret` —— 九门语言里有七门的 max2 就是这么写的。
   */
  function noFall(x) {
    return x !== null && x !== undefined && (x.op === 'ret' || x.op === 'loop-exit');
  }

  /** 这一格在 wasm 上出不出值。`print` 与"调一格不出值的函数"是两处例外。 */
  function isVoidish(x) {
    if (x === null || x === undefined) return false;
    if (x.op === 'prim') return x.attrs.name === 'print';
    if (x.op === 'call') return retOf.get(x.ins.fn?.attrs?.name) !== true;
    return false;
  }

  function litOf(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return `(i64.const ${v})`;
    // 实数：**这一层第二种数值类型**。指数写法先不认（前端只收十进制小数），报缺口不猜
    if (typeof v === 'number' && Number.isFinite(v)) {
      const s = String(v);
      if (/[eE]/.test(s)) throw new Gap(`指数写法的实数字面量还没接：${s}`);
      return `(f64.const ${s})`;
    }
    if (v === true) return '(i64.const 1)';
    if (v === false || v === null || v === undefined) return '(i64.const 0)';
    // 串就是**它那块内存的地址**（编译期定下的常量），与 `print_str` 的约定同一份
    if (typeof v === 'string') return `(i64.const ${strAddr(v)})`;
    throw new Gap(`这格字面量还没接：${JSON.stringify(v)}`);
  }

  function callOf(x, sc, pre) {
    const fn = x.ins.fn;
    const name = fn !== null && fn !== undefined && fn.op === 'ref' ? fn.attrs.name : null;
    const lift = name === null ? null : sc.lookupLift(name);
    if (lift === null && (name === null || !fns.has(name))) {
      throw new Gap('间接调用（函数当值）还没接');
    }
    const args = asList(x.ins.args).map((a) => {
      onlyInt(a, sc, '实参');   // 串传进函数就追不着了（形参没有种类）—— 明说接不住
      return expr(a, sc, pre);
    });
    // 提升上来的那些：捕获来的名字当**多出来的实参**，排在原来的形参前面
    if (lift !== null) {
      const caps = lift.captures.map((nm) => `(local.get ${sc.lookup(nm)})`);
      const all = [...caps, ...args];
      return `(call ${lift.wat}${all.length === 0 ? '' : ` ${all.join(' ')}`})`;
    }
    return `(call ${fns.get(name)}${args.length === 0 ? '' : ` ${args.join(' ')}`})`;
  }

  function stmts(xs, sc, f) { return asList(xs).flatMap((y) => stmt(y, sc, f)); }

  function stmt(x, sc, f) {
    if (x === null || x === undefined) return [];
    if (Array.isArray(x)) return stmts(x, sc, f);
    if (x.lit !== undefined) return [];
    const pre = [];
    switch (x.op) {
      case 'bind': {
        // **嵌套的函数走 lambda 提升**（不是闭包对象）：见 liftFunc
        if (x.ins.init?.op === 'func') return liftFunc(x, sc);
        const k = kindOf(x.ins.init, sc);
        const v = expr(x.ins.init, sc, pre);
        // 顶层的名字落全局量（别的函数要看得见它）；函数体里的还是局部量
        const g = sc === entryScope ? globals.get(x.attrs.name) : undefined;
        if (g !== undefined) {
          globalKinds.set(x.attrs.name, k);
          return [...pre, `(global.set ${g} ${v})`];
        }
        const id = sc.declare(x.attrs.name, k);   // 先算右值再声明：`local x = x` 才对
        return [...pre, `(local.set ${id} ${v})`];
      }
      case 'set': {
        const id = sc.lookup(x.attrs.name);
        const g = id === null ? globals.get(x.attrs.name) : undefined;
        if (id === null && g === undefined) throw new Gap(`赋值到没绑过的名字：${x.attrs.name}`);
        const k = kindOf(x.ins.value, sc);
        const v = expr(x.ins.value, sc, pre);
        if (g !== undefined) {
          const had = globalKinds.get(x.attrs.name) ?? 'int';
          if (had !== k) globalKinds.set(x.attrs.name, 'mix');
          return [...pre, `(global.set ${g} ${v})`];
        }
        sc.merge(x.attrs.name, k);
        // 局部量的 wasm 类型是声明那一刻定下的 —— 换一种数值类型往里塞，wasm 校验器会拒。
        // 与 `mix` 那条同一条纪律：报缺口，不给错答案
        if (wty(k) !== wty(sc.kindOf(x.attrs.name))) {
          throw new Gap(`${x.attrs.name} 先后装了两种数值类型 —— 一格局部量只有一种（要类型层）`);
        }
        return [...pre, `(local.set ${id} ${v})`];
      }
      case 'region': {
        const marks = [];
        regions.push(marks);
        const body = stmts(x.ins.body, new Scope(f, sc), f);
        regions.pop();
        if (marks.length === 0) return body;
        // 进 region 先把每格 flag 清零（wasm 的局部量初值是 0，但 region 可能跑第二遍）
        return [...marks.map((m) => `(local.set ${m.flag} (i64.const 0))`), ...body, ...runExits(marks)];
      }
      // 出口动作：注册那一刻只置一格 flag；动作本身贴在**每一条出口**上
      // （落到 region 末尾、`ret`、`break`/`continue` 穿出去 —— 三条都要跑）。
      case 'scope-exit': {
        if (regions.length === 0) throw new Gap('scope-exit 没有宿主 region');
        const flag = tmp(sc);
        const act = stmts(x.ins.action, new Scope(f, sc), f).join(' ');
        regions[regions.length - 1].push({ flag, act });
        return [`(local.set ${flag} (i64.const 1))`];
      }
      case 'field-set': {
        needMem = true;
        onlyInt(x.ins.value, sc, '记录的字段');
        const o = expr(x.ins.obj, sc, pre);
        const v = expr(x.ins.value, sc, pre);
        return [...pre, `(i64.store (i32.add ${addr(o)} (i32.const ${8 * slotOf(x.attrs.field)})) ${v})`];
      }
      case 'index-set': {
        needMem = true;
        onlyInt(x.ins.value, sc, '列表的元素');
        const o = tmp(sc); pre.push(`(local.set ${o} ${expr(x.ins.obj, sc, pre)})`);
        const i = tmp(sc); pre.push(`(local.set ${i} ${expr(x.ins.index, sc, pre)})`);
        guard(o, i, pre);
        const v = expr(x.ins.value, sc, pre);
        return [...pre, `(i64.store (i32.add ${addr(`(local.get ${o})`)}`
          + ` (i32.add (i32.const 8) ${addr(`(i64.mul (local.get ${i}) (i64.const 8))`)})) ${v})`];
      }
      case 'branch': {
        const c = cond(x.ins.cond, sc, pre);
        const t = stmts(x.ins.then, new Scope(f, sc), f).join(' ');
        if (x.ins.else === undefined) return [...pre, `(if ${c} (then ${t}))`];
        const e = stmts(x.ins.else, new Scope(f, sc), f).join(' ');
        return [...pre, `(if ${c} (then ${t}) (else ${e}))`];
      }
      case 'loop': {
        // while 的形状（三层，每一层都有确切的用处）：
        //
        //   (block $B            ← `break` 跳这儿：跳出整个循环
        //     (loop $L           ← 一轮
        //       (if cond (then
        //         (block $C 体)  ← `continue` 跳这儿：吃掉体的剩下部分，**但步进照跑**
        //         步进
        //         (br $L)))))
        //
        // 中间那一格 `$C` 是关键：`continue` 直接跳 `$L` 会漏掉步进 —— 那正是
        // 调度器那一侧把步进单列成 `post` 端口的同一条理由（漏了就是死循环）。
        const n = ++loopSeq;
        const lab = `$L${n}`;
        const brk = `$B${n}`;
        const cont = `$C${n}`;
        loops.push({ brk, cont, depth: regions.length });
        const inner = new Scope(f, sc);
        const body = stmts(x.ins.body, inner, f).join(' ');
        const post = stmts(x.ins.post, inner, f).join(' ');
        loops.pop();
        const c = cond(x.ins.cond, sc, pre);
        // 条件里若要临时量，那几条得在**每轮**都跑一遍，所以它们进 loop 里面
        return [`(block ${brk} (loop ${lab} ${pre.join(' ')}`
          + ` (if ${c} (then (block ${cont} ${body}) ${post} (br ${lab})))))`];
      }
      // break / continue：跳的是上面那两格 `block` 的标签 —— 深度由 WAT 前端自己算
      // （`level = depth + 1`，四条腿的 Break/Continue 本来就带 level 那一格）。
      case 'loop-exit': {
        if (loops.length === 0) throw new Gap('loop-exit 不在任何一格 loop 里');
        const top = loops[loops.length - 1];
        // 穿出去的时候，**这格 loop 里面开的**那几格 region 的出口要跑（从里往外）
        const unwind = regions.slice(top.depth).reverse().flatMap(runExits);
        return [...unwind, `(br ${x.attrs.kind === 'continue' ? top.cont : top.brk})`];
      }
      case 'ret': {
        if (x.ins.value === undefined) {
          return [...[...regions].reverse().flatMap(runExits), '(return)'];
        }
        // 多值的格数要记下来（打印那一步靠它）。两条 `ret` 给的格数不一样就记成 'mix' ——
        // 那种函数印不出来（要运行期长度），报缺口比猜一个数好
        if (x.ins.value?.op === 'values') {
          const n = asList(x.ins.value.ins.args).length;
          f.multi = (f.multi === 0 || f.multi === n) ? n : 'mix';
        }
        onlyInt(x.ins.value, sc, '返回值');
        const v = expr(x.ins.value, sc, pre);
        f.ret = true;
        // 早退也要经过途中每一格 region 的出口（从里往外）。
        // **返回值先算完再跑出口动作**：调度器那侧就是这个顺序（出口动作看得见的是
        // 已经定下的返回值），所以这儿要落一格临时量，不能把表达式留到出口后面求。
        const unwind = [...regions].reverse().flatMap(runExits);
        if (unwind.length === 0) return [...pre, `(return ${v})`];
        const r = tmp(sc);
        return [...pre, `(local.set ${r} ${v})`, ...unwind, `(return (local.get ${r}))`];
      }
      case 'prim': {
        if (x.attrs.name !== 'print') {
          const v = expr(x, sc, pre);
          return [...pre, `(drop ${v})`];
        }
        const args = asList(x.ins.args);
        if (args.length !== 1) throw new Gap('打印只接一格实参（多格要先有字符串拼接）');
        const one = args[0];
        // `print(f())` 那条 arity 契约（列表里只有最后一格展开）：多值要**印成一行** ——
        // 靠一格运行期造串的辅助函数（`$__str_join`，见 STR_JOIN），格数是编译期就知道的
        const n = one?.op === 'values' ? asList(one.ins.args).length
          : (one?.op === 'call' ? multiOf.get(one.ins.fn?.attrs?.name) : undefined);
        if (n === 'mix') {
          throw new Gap('这格函数不同出口返回的多值格数不一样 —— 印一行要运行期长度');
        }
        if (typeof n === 'number' && n > 0) {
          needStr = true;
          needJoin = true;
          const base = expr(one, sc, pre);
          return [...pre, `(call $print_str ${addr(`(call $__str_join ${base} (i64.const ${n}))`)})`];
        }
        // 数走 `print_i64`，串走 `print_str`（宿主面那格导入认"长度 + 字节"那块内存）。
        // 既装串又装数的量在这儿报缺口 —— 印一格地址是错答案。
        const k = kindOf(one, sc);
        if (k === 'mix') throw new Gap('这一格量既装过串也装过数 —— 打印要知道是哪一种（要类型层）');
        const v = expr(one, sc, pre);
        if (k === 'str') {
          needStr = true;
          return [...pre, `(call $print_str ${addr(v)})`];
        }
        // 实数走宿主面的 `print_f64` —— 小数位的格式因此与别的前端共用一份
        if (k === 'real') {
          needF64 = true;
          return [...pre, `(call $print_f64 ${v})`];
        }
        return [...pre, `(call $print ${v})`];
      }
      case 'call': {
        const fn = x.ins.fn;
        const name = fn?.op === 'ref' ? fn.attrs.name : null;
        const call = callOf(x, sc, pre);
        return [...pre, retOf.get(name) === true ? `(drop ${call})` : call];
      }
      default: throw why(x.op, '语句位置');
    }
  }

  /**
   * **嵌套的函数：lambda 提升，不是闭包**。
   *
   * wasm 的 `call_indirect` 与函数表这一批都不认（WAT 前端第一阶段的边界），所以"函数当值用"
   * 确实接不住。但**嵌套的函数只被直接调用**时用不着闭包对象：把它提到顶层，
   * 捕获来的名字当**多出来的形参**从每个调用点传进去 —— Scheme 那份 basics 的 `go`
   * （捕获外层的 `n`、递归调用自己）就是这个形状。
   *
   * 两条限制是**必须的**，不然按值提升会给错答案，所以都报缺口：
   *   * 捕获来的名字在里面被**写**过 —— 按值传的话外面看不见那次写。
   *   * 捕获来的名字不是整数（实数 / 串）—— 形参这一批只有 i64（与别处同一条账）。
   */
  function liftFunc(x, sc) {
    const fnode = x.ins.init;
    const self = x.attrs.name;
    const params = (fnode.attrs.params ?? []).map((p) => String(p));
    const body = fnode.ins.body;
    const refs = new Set(); const binds = new Set();
    namesIn(body, refs, binds);
    // 自由名字 = 读到的 - 自己绑的 - 形参 - 自己的名字，再筛出"宿主作用域里真有这一格"
    const free = [...refs].filter((nm) => nm !== self && !binds.has(nm) && !params.includes(nm)
      && sc.lookup(nm) !== null);
    const written = writtenIn(body);
    for (const nm of free) {
      if (written.has(nm)) {
        throw new Gap(`嵌套的函数写了捕获来的 ${nm} —— 按值提升会丢掉那次写（要闭包对象）`);
      }
      if (sc.kindOf(nm) !== 'int') {
        throw new Gap(`嵌套的函数捕获了一格非整数的 ${nm} —— 形参这一批只有 i64`);
      }
    }
    const wat = mod.uniq(wname(`f_${self}`));
    const g = mod.fn(wat, [...free, ...params], self);
    const gsc = new Scope(g);
    [...free, ...params].forEach((p) => gsc.names.set(p, wname(p)));
    const info = { wat, captures: free };
    sc.declareLift(self, info);     // 宿主里看得见它
    gsc.declareLift(self, info);    // 它自己也看得见（递归）
    const marks = [];
    regions.push(marks);
    g.body = fnBody(body, gsc, g);
    regions.pop();
    if (marks.length !== 0) {
      g.body = [...marks.map((m) => `(local.set ${m.flag} (i64.const 0))`),
        ...g.body, ...(g.unwound === true ? [] : runExits(marks))];
    }
    return [];   // 提升上去了，宿主这儿一条语句都不留
  }

  /**
   * 一格函数体。**最后一格如果出值，它就是返回值** —— 与 js 后端同一条规矩。
   * 两处例外要挑出来：`print`（wasm 里它不出值）与"调用一格不出值的函数"。
   */
  function fnBody(bodyIns, sc, f) {
    const list = asList(bodyIns);
    if (list.length === 0) return [];
    const head = list.slice(0, -1).flatMap((y) => stmt(y, sc, f));
    const last = list[list.length - 1];
    const voidish = isVoidish(last);
    const hasValue = last !== null && last !== undefined && !voidish
      && (last.lit !== undefined || (last.op !== undefined && (NODES.get(last.op)?.outs.length ?? 0) > 0));
    if (!hasValue) return [...head, ...stmt(last, sc, f)];
    const pre = [];
    onlyInt(last, sc, '返回值');
    const v = expr(last, sc, pre);
    f.ret = true;
    // **落到函数末尾也是一条出口**：这儿走的是"最后一格就是返回值"那条路，所以出口动作
    // 要在这儿跑 —— 贴在 `(return ...)` 后面等于没贴（CL 那份 defer 例子就是这么漏的：
    // 印出 in / out，b 与 a 全丢了）。顺序与 `ret` 那格同一条：先算完返回值，再跑动作。
    const unwind = [...regions].reverse().flatMap(runExits);
    if (unwind.length === 0) return [...head, ...pre, `(return ${v})`];
    f.unwound = true;   // 出口动作已经在这儿跑过，外面别再贴一遍
    const r = tmp(sc);
    return [...head, ...pre, `(local.set ${r} ${v})`, ...unwind, `(return (local.get ${r}))`];
  }

  // ---- 走一遍顶层：函数各成一格 wat func，别的语句进 `$__entry` --------------
  const entry = mod.fn('$__entry', []);
  const entryScope = new Scope(entry);
  const entryMarks = [];
  regions.push(entryMarks);          // 顶层那一段也是一格 region
  for (const it of items) {
    if (it?.op === 'bind' && it.ins?.init?.op === 'func') {
      const fnode = it.ins.init;
      const params = (fnode.attrs.params ?? []).map((p) => String(p));
      const f = mod.fn(fns.get(it.attrs.name), params, it.attrs.name);
      const sc = new Scope(f);
      params.forEach((p) => sc.names.set(p, wname(p)));
      // **函数体本身就是一格 region**（与调度器那侧 `new Env(fn.env, { region: true })`
      // 同一条）—— go / V / nim 的 defer 就挂在这一层上。
      const marks = [];
      regions.push(marks);
      f.body = fnBody(fnode.ins.body, sc, f);
      regions.pop();
      if (marks.length !== 0) {
        f.body = [...marks.map((m) => `(local.set ${m.flag} (i64.const 0))`),
          ...f.body, ...(f.unwound === true ? [] : runExits(marks))];
      }
      continue;
    }
    entry.body.push(...stmt(it, entryScope, entry));
  }

  regions.pop();
  if (entryMarks.length !== 0) {
    entry.body = [...entryMarks.map((m) => `(local.set ${m.flag} (i64.const 0))`),
      ...entry.body, ...runExits(entryMarks)];
  }

  const lines = ['(module', '  (import "omni" "print_i64" (func $print (param i64)))'];
  // 串的那格导入只在**真用到**的时候发（它要读内存，没有 memory 段前端会当场拒）
  if (needStr) lines.push('  (import "omni" "print_str" (func $print_str (param i32)))');
  // 实数那格导入同理：**两种数值类型**在宿主面上也是两条（小数位的格式因此不由这条腿定）
  if (needF64) lines.push('  (import "omni" "print_f64" (func $print_f64 (param f64)))');
  if (needMem) {
    // 一块内存 + 一格堆指针。**从 8 起**：0 号地址留空，好让"没初始化的地址"一眼看出来。
    // 字符串常量躺在 data 段里，所以 `$hp` 从它们**后面**起步 —— 两块内存互不覆盖。
    lines.push('  (memory 1)', `  (global $hp (mut i32) (i32.const ${dataEnd}))`);
    for (const d of data) {
      lines.push(`  (data (i32.const ${d.off}) ${d.bytes.join(' ')})`);
    }
  }
  if (needJoin) lines.push(STR_JOIN);
  for (const [nm, g] of globals) {
    const ty = wty(globalKinds.get(nm) ?? 'int');
    lines.push(`  (global ${g} (mut ${ty}) (${ty}.const 0))`);
  }
  for (const f of mod.fns.values()) {
    const ps = f.params.map((p) => `(param ${wname(p)} i64)`).join(' ');
    const res = f.ret ? ' (result i64)' : '';
    const locals = f.locals.map((l) => `(local ${l.id} ${l.ty})`).join(' ');
    lines.push(`  (func ${f.name}${ps === '' ? '' : ` ${ps}`}${res}`);
    if (locals !== '') lines.push(`    ${locals}`);
    for (const s of f.body) lines.push(`    ${s}`);
    // 出值的函数要有一条兜底的返回值（wasm 要求每条路径都留下一格结果）
    if (f.ret) lines.push('    (i64.const 0)');
    lines.push('  )');
  }
  lines.push('  (export "main" (func $__entry))', ')');
  return {
    text: lines.join('\n'),
    // 两张表按**图上的名字**排（不是 wasm 那边的名字）—— 提升上来的嵌套函数因此也查得到
    rets: new Map([...mod.fns.values()].map((f) => [f.src, f.ret])),
    multis: new Map([...mod.fns.values()].map((f) => [f.src, f.multi])),
  };
}

/**
 * 图 -> WAT 文本。接不住的形状抛 `Gap`（上层把它变成"这一格跳过，理由如下"）。
 */
export function emitWat(graph) {
  // 第一遍只为了那两张表（哪个函数出值 / 出几格多值），第二遍拿着它们出正式的文本。
  // 图都很小，两遍比猜便宜。
  const first = emitOnce(graph, new Map(), new Map());
  return emitOnce(graph, first.rets, first.multis).text;
}

export { Gap };

/**
 * **真跑一遍**：出来的 WAT 交给另一个前端读（`frontend-wat`，WAT -> OIR），
 * 再用 MIR 的解释器跑。输出是靠接管 `process.stdout.write` 收的 ——
 * 那条打印路径（OIR 的 print 内建）本来就是写给宿主 stdout 的，不改它。
 */
export function runWat(text) {
  const diags = new Diagnostics();
  const oir = lowerWat(new SourceFile('graph.wat', text), diags);
  if (oir === null || diags.hasErrors()) {
    throw new Error(`wat 前端不收：${diags.items.map((d) => d.msg).join('; ')}`);
  }
  const out = [];
  const real = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (s) => { buf += String(s); return true; };
  try {
    interpretMir(oir);
  } finally {
    process.stdout.write = real;
  }
  for (const line of buf.split('\n')) if (line !== '') out.push(line);
  return { value: null, out };
}
