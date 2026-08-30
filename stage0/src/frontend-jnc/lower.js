// Omni stage0 — jancy 前端：jnc 语法树 -> 核心 S 表达式方言（ADR-0016 分步 7）
//
// ## 这一份存在的理由与 asy 那一份相同
//
// 语法那一半是数据（`jnc.grammar`，从七份 `.llk` 转写，那份文件的头里写着 12 处 resolver
// 各自的处置）。这里只做**类型定向**的那一半：jancy 的 `*p` 是"解引用"还是"乘法"、
// `p[i]` 是指针下标还是数组下标、`p - q` 是指针差还是整数减法 —— 每一条都要先知道
// 子表达式的类型，而类型是符号表的事，动作模板里没有符号表。
//
// 出来的仍然是核心方言文本，所以五条腿一条都不知道 jancy 存在。
//
// ## 这一路**没有 oracle**（ADR-0016）
//
// jancy 的 `jnc` 要 LLVM + axl 才编得出来。所以期望输出由我们自己写在 tests/jnc/ 里，
// 每一条注明出处（引哪一份文档、哪一个 `.llk` 规则、哪一份语料）。这与 asy 那条线是
// 两条不同的纪律 —— 那边"每一条都要量"，这边"每一条都要有出处"。
//
// ## 第一刀的边界（都是**刻意**的，不是漏的）
//
// 收：**定宽有符号整数** `char` / `short` / `int` / `long` / `intptr`（8 / 16 / 32 / 64 位，
// 见下面「定宽整数」那一段）、`double`（-> real）、`bool`、`void`、
// `struct`（值语义，降成方言的 `(struct …)`）、函数（含递归、形参、返回值）、
// 局部量与赋值、`+ - * / %` 与比较、`&& || !`、一元 `- ~`、`++ --`（前后缀都收，
// 但只作为语句/for 的步进）、复合赋值 `+= -= *= /=`、`? :`、if/else、while、
// do-while、C 式 for、break/continue/return、**真值化**（`if (n)` / `if (p)` /
// `!n` / `n && m` —— jancy 把整数与指针当条件用，这一层照它办）、
// **指针那一族**（这一刀的主题）：`T*` -> `(ptr T)`、`T thin*` -> `(tptr T)`、
// `new T[n]` -> `(pnew …)`、`*p` 读写、`p[i]` 读写（= `*(p + i)`，jancy 的下标
// 本来就是这个语义）、`p + i` / `p - i` / `p++`、`p - q`（指针差，按元素）、
// `p == q` 与 `p == null`、`p->f` 与 `(*p).f` 读写、`unsafe { … }`、
// `(int thin*)p`（fat 转 thin，-> `(pthin p)`）。
//
// ## 纪律：**jancy 不向方言妥协**
//
// 遇到"jancy 有、方言没有"的东西，动的是**方言**，不是这门语言。这一刀里因此长出了
// 两条核心形式：`(sel c a b)`（条件表达式，惰性）与 `(peq p q)`（指针相等）。理由写在
// sexpr/lower.js 那两处。真值化不用动方言 —— 那本来就是 jancy 侧的一次隐式转换，
// 这一层把它显式写出来（`n != 0` / `!pisnull p`）就对了。定宽整数也是这一类：位宽是
// 这一层的账，回卷是三条已有算符的合成，方言一个字都不用改。
//
// 还没长出来、因此**当场报错**的（每一条都记着该怎么长，不是"不收"）：
//   - `%*d`（宽度从实参来）—— 那要在运行期才知道宽度，与"格式串必须是字面量"同一处边界。
//   - 整数与 `%s` 上的精度（`%.3d` 是"至少三位数字"、`%.5s` 是"最多五个字符"）—— 与小数
//     无关的两件事，各要自己的一段。
//   - `unsigned` —— 要无符号那一半的位宽规则：回卷变成 `x & M`（不摊符号位），
//     `/` `%` `>>` `<` 都得换成无符号那一版。以前是静默忽略的，现在明着拒
//     （见 tests/jnc/bad/unsigned.jnc）。
//   - `&x`（取局部量地址）—— 要局部量可寻址（jancy 那边是"提到 GC 堆上"）。
//   - 真数组 `int a[3]`（jancy 的数组是**值**类型，方言这一层的 `(arr T)` 是引用语义）——
//     要方言有值语义的定长数组。
//   - `printf` 之外的标准库（`std.*`、`io.*`、`gc.*`）
//   - 格式化字面量 `$"…"`、多行字面量、正则 switch
//   - class / union / enum / property / reactor / 事件 / 多播 / 协程
//   - 异常（try/throw/catch）、`assert`、namespace / import
//
// **一处刻意留下的差别**：`sizeof` / `offsetof` 意义上的**存储**宽度。四种位宽在方言里
// 都占一个 64 位的槽（`char*` 与 `int*` 是同一个方言类型），所以 `new char[n]` 占 8n 字节、
// `struct { char c; int i; }` 是 16 字节。这一格从**语义**上看不见（指针算术按元素走，
// 而 `sizeof` / `offsetof` 都不收），所以它不在上面那份名单里；要真接 `sizeof` 才要动。
//
// ## printf 怎么降
//
// jancy 的 `printf` 就是它的打印口（`test/jnc/*.jnc` 里到处是它），语义是 C 的那一套：
// **不补换行**。这一层按 `\n` 把格式串切成若干段，带换行的段发 `(print …)`（它自带换行），
// 末尾不带换行的那段发 `(write …)`。两者在每条腿上共用同一个输出缓冲区，所以交替调用
// 顺序不会乱。收 `%d` / `%i` / `%f` / `%s` / `%c` / `%x` / `%X` / `%o` / `%%`，标志 `-` `0`、
// 十进制宽度与精度 `.N`；`%d` 与 `%x` 也收 bool（jancy 的 bool 底下是 int8，印 1 / 0）。
// 宽度那一格与 C 的 printf **逐字节相同**（含 `%05d` 印负数是 `-0042` 这一条 —— 零补在
// 符号后面）。
//
// `%f` 是 C 的 `%.6f`（**默认精度 6**），走方言第八刀长出来的 `(sfix E N)`。它不是"把这个
// 数印出来"—— 第八刀之前这一格降成 `tostr`（`%.6g`），于是 `printf("%f", 1.5)` 印 `1.5`
// 而 C 印 `1.500000`。舍入定的是 C 那一边（就近取偶），理由写在 sexpr/lower.js 的 `sfix` 处。
//
// `%x` / `%X` / `%o` 靠方言第七刀长出来的 `(sbase E 进制)` 与 `(supper S)`。这一格真正的
// 难处不是"印十六进制"，是**多少位**：C 把实参当 unsigned 读，位数是**默认实参提升之后**
// 那一格，所以 `char d = -56; printf("%x", d)` 是 `ffffffc8` 而不是 `c8`。定宽整数
// （第六刀）在这里第一次真正被用到 —— 掩到 `promo(位宽)` 位再交给 `sbase`。
import { isList, isAtom, isStr, head } from '../sexpr/read.js';
import { OmniError } from '../source/diag.js';

const JNC_NOPE = 'jancy 前端第一刀还不收';

/* ---------------------------------------------------------------- 类型
 * 这一层的类型就是核心方言那几个，外加"这是个指针"。刻意不建自己的一套类型系统：
 * 方言那一层已经有 ptrTargetOk / sizeOf / structLayout（布局由那一层定死，见 ADR-0016），
 * 这里只要能说出"它是什么"就够。
 */
/* ## 定宽整数（ADR-0016 第六刀）
 *
 * jancy 的整数是**定宽有符号**的：`char` 8 位、`short` 16、`int` 32、`long` / `intptr` 64
 * （Lexer.rl 的关键字表 + Type.cpp 的 TypeKind_Int8..Int64）。方言只有一个 64 位的 int，
 * 所以位宽是**这一层的概念**：存储一律用方言的 int，而每个值都保持在它那一格的范围里
 * （**符号扩展后的规范形**），窄格的运算之后补一次回卷。
 *
 * 为什么这样够：只要两个操作数都是规范形，`% & | ^ >> == <` 的结果**天然**还在范围里，
 * 只有 `+ - * / <<` 与一元 `-` 会溢出。于是回卷只发生在这五处加上"赋值到更窄的一格"。
 * 回卷本身不要方言长新形式 —— 它是三条已有算符的合成（掩、异或、减），跟 `~x` -> `x ^ -1`
 * 与真值化同一类：**jancy 侧的一次隐式动作，这一层把它显式写出来**。
 *
 * 与 C 一致的两条规矩也在这儿：**整型提升**（比 32 位窄的先提到 32 位，所以
 * `char*char` 不会在 8 位里溢出）与**常用算术转换**（两边取较宽的那一格）。
 */
const INT_WS = [8, 16, 32, 64];
const INTS = new Map(INT_WS.map((w) => [w, { k: 'int', w }]));
const mkInt = (w) => INTS.get(w);
const T_I8 = mkInt(8);
const T_I16 = mkInt(16);
const T_I32 = mkInt(32);
const T_I64 = mkInt(64);
const T_REAL = { k: 'real' };
const T_BOOL = { k: 'bool' };
const T_VOID = { k: 'void' };
const T_STR = { k: 'string' };
const tPtr = (t) => ({ k: 'ptr', target: t });
const tThin = (t) => ({ k: 'tptr', target: t });

const isInt = (t) => t.k === 'int';

/** 整型提升：比 32 位窄的一律先提到 32 位（C 的规矩，jancy 同）。 */
const promo = (w) => (w < 32 ? 32 : w);

/**
 * 回卷到 w 位有符号。`(x & M) ^ S - S` —— 掩到 w 位、再把最高位当符号位摊开。
 * 64 位就是方言的 int 本身，一个字都不用发。
 *
 * 两条腿上都成立：JS 那侧 int 是 BigInt（`-1n & 255n === 255n`），C 那侧是补码的
 * `int64_t`（`(-1LL) & 255 == 255`）—— 同一串算符给同一个数。
 */
function wrapTo(code, w) {
  if (w >= 64) return code;
  const s = 1n << BigInt(w - 1);
  return `(bin "-" (bin "^" (bin "&" ${code} (int ${s * 2n - 1n})) (int ${s})) (int ${s}))`;
}

/** 类型 -> 核心方言的写法。**四种位宽都写成 `int`** —— 存储就是方言那一个 int。 */
function tyText(t) {
  if (t.k === 'ptr') return `(ptr ${tyText(t.target)})`;
  if (t.k === 'tptr') return `(tptr ${tyText(t.target)})`;
  if (t.k === 'struct') return t.name;
  if (t.k === 'int') return 'int';
  return t.k;
}

/** 给人看的写法（诊断里用）。跟 jancy 自己的拼法一致：`int*` / `int thin*` / `char`。 */
const INT_NAMES = new Map([[8, 'char'], [16, 'short'], [32, 'int'], [64, 'long']]);
function tyName(t) {
  if (t.k === 'ptr') return `${tyName(t.target)}*`;
  if (t.k === 'tptr') return `${tyName(t.target)} thin*`;
  if (t.k === 'struct') return t.name;
  if (t.k === 'int') return INT_NAMES.get(t.w);
  return t.k;
}

function sameTy(a, b) {
  if (a.k !== b.k) return false;
  if (a.k === 'ptr' || a.k === 'tptr') return sameTy(a.target, b.target);
  if (a.k === 'struct') return a.name === b.name;
  if (a.k === 'int') return a.w === b.w;
  return true;
}

/**
 * 隐式的整数转换（赋值、初值、实参、返回、`int` 之间的强制转换都走它）。
 *
 * 加宽不发一个字 —— 规范形里"8 位的 -1"与"64 位的 -1"是同一个数。变窄才回卷。
 */
function intConv(v, to) {
  if (v.type.w === to.w) return v;
  return { code: to.w < v.type.w ? wrapTo(v.code, to.w) : v.code, type: to };
}

const isPtr = (t) => t.k === 'ptr' || t.k === 'tptr';

/** 零值。jancy 保证"用户代码碰到之前每一格都是零"（type_ptr_data.rst），所以没写初值的
 *  局部量这里显式发一个零 —— 方言的 `(let …)` 要一个初值。 */
function zeroOf(t) {
  if (t.k === 'int') return '(int 0)';
  if (t.k === 'real') return '(real 0.0)';
  if (t.k === 'bool') return '(bool false)';
  if (t.k === 'string') return '(str "")';
  if (t.k === 'ptr' || t.k === 'tptr') return `(pnull ${tyText(t)})`;
  return null;
}

/** jnc 语法树 -> 核心方言文本。 */
export function lowerJnc(tree, diags, opts) {
  const L = new JncLower(diags, opts === undefined ? {} : opts);
  return L.run(tree);
}

class JncLower {
  constructor(diags, opts) {
    this.diags = diags;
    this.opts = opts;
    this.decls = [];        // 顶层：struct 与 fn 的文本
    this.structs = new Map();  // 名字 -> [{name, type}]
    this.fns = new Map();      // 名字 -> {params: [type], ret}
    this.scopes = [];          // 局部量：名字 -> 类型
    this.unsafe = false;       // 在 (unsafe …) 里面
    this.mainBody = null;      // `int main()` 的体（降成方言的 `(main …)`）
    this.retTy = T_VOID;       // 当前函数的返回类型
    this.forStep = null;       // 当前所在 for 的步进（非 null 时 continue 要拦，见 stmt）
    this.tmp = 0;              // 生成名字的计数（do-while 的那格标志）
  }

  err(node, msg) {
    this.diags.error(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  nope(node, what) {
    return this.err(node, `${JNC_NOPE}：${what}`);
  }

  /** `(H)` / `(H X)` / `(H-add PREV X)` 三种形状摊成一条平的列表（与 asy 那份同一个套路） */
  flat(node) {
    if (!isList(node)) return [];
    const h = head(node);
    if (h !== null && h.endsWith('-add')) {
      return [...this.flat(node.items[1]), node.items[2]];
    }
    return node.items.slice(1);
  }

  push(name, type) {
    this.scopes[this.scopes.length - 1].set(name, type);
  }

  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i].get(name);
      if (t !== undefined) return t;
    }
    return null;
  }

  run(tree) {
    for (const item of this.flat(tree)) this.topItem(item);
    if (this.mainBody === null) {
      this.diags.error(null, 'jancy 的入口是 `int main()`，这份源码里没有');
      return '';
    }
    const parts = ['(module'];
    for (const d of this.decls) parts.push(d);
    parts.push(`  (main\n${this.mainBody})`);
    parts.push(')');
    return `${parts.join('\n')}\n`;
  }

  /* -------------------------------------------------------------- 顶层 */

  topItem(item) {
    if (!isList(item)) return this.err(item, '认不出的顶层条目');
    const h = head(item);
    if (h === 'empty-stmt') return null;            // 光一个分号
    if (h === 'type-decl') return this.typeDecl(item.items[1]);
    if (h === 'fn-def') return this.fnDef(item);
    if (h === 'var-decl') return this.nope(item, '模块级变量（jancy 的全局量还没接）');
    return this.nope(item, `顶层的 '${h}'`);
  }

  /** `struct S { … }`。jancy 的 struct 是**值**类型（POD），所以降成方言的 `(struct …)`
   *  而不是 `(class …)` —— 与 asy 那边恰好相反（asy 的 struct 是引用类型，量过）。 */
  typeDecl(n) {
    if (!isList(n) || head(n) !== 'agg') return this.nope(n, '带体的命名类型（只收 struct）');
    const key = isAtom(n.items[1]) ? n.items[1].value : null;
    if (key !== 'struct') return this.nope(n, `'${key}'（只收 struct）`);
    const name = this.qname(n.items[2]);
    if (name === null) return this.err(n, '认不出的结构体名字');
    const bases = this.flat(n.items[3]);
    if (bases.length > 0) return this.nope(n, '结构体的基类');
    const fields = [];
    for (const m of this.flat(n.items[4])) {
      if (isList(m) && head(m) === 'empty-stmt') continue;
      if (!isList(m) || head(m) !== 'var-decl') { this.nope(m, '结构体里除字段以外的成员'); continue; }
      const sp = this.specs(m.items[1]);
      if (sp === null) continue;
      for (const d of this.flat(m.items[2])) {
        if (isList(d) && head(d) === 'init') { this.nope(d, '字段的默认值'); continue; }
        const info = this.declarator(d, sp);
        if (info === null) continue;
        if (info.formals !== null) { this.nope(d, '结构体里的方法'); continue; }
        fields.push({ name: info.name, type: info.type });
      }
    }
    if (this.structs.has(name)) return this.err(n, `结构体 '${name}' 声明了两次`);
    this.structs.set(name, fields);
    const fs = fields.map((f) => `(${f.name} ${tyText(f.type)})`).join(' ');
    this.decls.push(`  (struct ${name} ${fs})`);
    return null;
  }

  /* -------------------------------------------------------------- 类型与声明符 */

  qname(n) {
    if (!isList(n)) return null;
    if (head(n) === 'name' && isAtom(n.items[1])) return n.items[1].value;
    return null;   // 限定名（`a.b`）第一刀不收
  }

  /** `(specs 类型说明符 前置修饰符 后置修饰符)` -> 类型 + `thin` 标记。
   *  `thin` 在 jancy 里是**类型修饰符**（Lexer.rl:222），语法上落在说明符表里，
   *  所以它在这儿而不是在 `*` 那一侧。 */
  specs(n) {
    if (!isList(n) || head(n) !== 'specs') { this.err(n, '认不出的说明符表'); return null; }
    const mods = [...this.flat(n.items[2]), ...this.flat(n.items[3])]
      .map((m) => (isAtom(m) ? m.value : '?'));
    let thin = false;
    for (const m of mods) {
      if (m === 'thin') { thin = true; continue; }
      if (m === 'const') continue;                      // 这一层不区分（没有可变性检查）
      // `unsigned` 以前是**静默忽略**的，那在有位宽之后会直接给错答案
      // （`unsigned char c = 200` 该印 200，忽略的话印 -56）。所以现在明着拒。
      if (m === 'unsigned') { this.nope(n, '`unsigned`（要无符号那一半的位宽规则）'); return null; }
      this.nope(n, `修饰符 '${m}'`);
      return null;
    }
    const ts = n.items[1];
    if (isList(ts) && head(ts) === 'no-type') { this.err(n, '这条声明没有类型'); return null; }
    let base = null;
    if (isAtom(ts)) {
      const s = ts.value;
      // 位宽照 jancy：char 8 / short 16 / int 32 / long 与 intptr 64。
      if (s === 'char') base = T_I8;
      else if (s === 'short') base = T_I16;
      else if (s === 'int') base = T_I32;
      else if (s === 'long' || s === 'intptr') base = T_I64;
      else if (s === 'double' || s === 'float') base = T_REAL;
      else if (s === 'bool') base = T_BOOL;
      else if (s === 'void') base = T_VOID;
      else { this.nope(ts, `类型 '${s}'`); return null; }
    } else {
      const nm = this.qname(ts);
      if (nm === null) { this.nope(ts, '这种类型说明符'); return null; }
      if (nm === 'size_t') base = T_I64;                // jancy 的语料里到处是它
      else if (nm === 'string_t') base = T_STR;
      else if (this.structs.has(nm)) base = { k: 'struct', name: nm };
      else { this.err(ts, `没有这个类型：'${nm}'`); return null; }
    }
    return { type: base, thin };
  }

  /** 说明符表 + 一串 `*` -> 类型。`int thin*` 的 thin 管的是**最外层**那个 `*`
   *  （jancy 的 `int thin* p` 是"指向 int 的 thin 指针"）。 */
  ptrsTy(sp, ptrsNode, node) {
    let t = sp.type;
    const groups = this.flat(ptrsNode);
    if (groups.length === 0) {
      if (sp.thin) { this.nope(node, '`thin` 用在不是指针的类型上'); return null; }
      return t;
    }
    for (let i = 0; i < groups.length; i++) {
      const mods = this.flat(groups[i]).flatMap((m) => this.flat(m)).map((m) => (isAtom(m) ? m.value : '?'));
      let thin = sp.thin && i === 0;
      for (const m of mods) {
        if (m === 'thin') { thin = true; continue; }
        if (m === 'const') continue;
        this.nope(node, `指针后面的修饰符 '${m}'`);
        return null;
      }
      t = thin ? tThin(t) : tPtr(t);
    }
    return t;
  }

  specsTy(n) {
    const sp = this.specs(n);
    if (sp === null) return null;
    if (sp.thin) { this.nope(n, '`thin` 用在不是指针的类型上'); return null; }
    return sp.type;
  }

  /** `(dcl 前缀 核心 后缀 构造)` -> `{name, type, formals}`。
   *  `formals` 不是 null 就说明这是个**函数**声明符（后缀里有一对括号）。 */
  declarator(d, sp) {
    if (!isList(d) || head(d) !== 'dcl') return this.err(d, '认不出的声明符');
    if (isList(d.items[4]) && head(d.items[4]) !== 'no-ctor') return this.nope(d, 'C++ 式的构造声明符');
    const name = this.qname(d.items[2]);
    if (name === null) return this.nope(d.items[2], '限定名或特殊名的声明符');
    let t = this.ptrsTy(sp, d.items[1], d);
    if (t === null) return null;
    let formals = null;
    for (const s of this.flat(d.items[3])) {
      const sh = isList(s) ? head(s) : null;
      if (sh === 'fn-suffix') {
        if (formals !== null) return this.nope(s, '返回函数的函数');
        formals = s.items[1];
        continue;
      }
      // `int a[3]` —— jancy 的数组是**值**类型，而方言的 `(arr T)` 是引用语义，两者对不上。
      // 硬接就是给错答案（复制一份 vs 共享同一段），所以这一刀明着不收。
      if (sh === 'array-suffix') return this.nope(s, '数组声明符（`T a[n]`）—— 用 `T* p = new T[n]` 代替');
      return this.nope(s, `声明符后缀 '${sh}'`);
    }
    return { name, type: t, formals };
  }

  /* -------------------------------------------------------------- 函数 */

  fnDef(n) {
    const sp = this.specs(n.items[1]);
    if (sp === null) return null;
    const info = this.declarator(n.items[2], sp);
    if (info === null) return null;
    if (info.formals === null) return this.err(n, `'${info.name}' 有函数体，但声明符上没有形参表`);
    const ps = [];
    for (const f of this.flat(info.formals)) {
      const fh = isList(f) ? head(f) : null;
      if (fh === 'formals-varargs') { this.nope(f, '可变形参'); return null; }
      if (fh === 'formal-anon') { this.nope(f, '无名形参'); return null; }
      if (fh !== 'formal') { this.nope(f, `形参 '${fh}'`); return null; }
      if (f.items[3] !== undefined) { this.nope(f, '形参的默认值'); return null; }
      const fsp = this.specs(f.items[1]);
      if (fsp === null) return null;
      const fi = this.declarator(f.items[2], fsp);
      if (fi === null) return null;
      if (fi.formals !== null) { this.nope(f, '函数类型的形参'); return null; }
      ps.push(fi);
    }
    // `int main()` 是入口：降成方言的 `(main …)`。jancy 的 main 回 int，而方言的入口
    // 不回值 —— 那个返回值是给外面的退出码，这一层没有它，所以 `return 0` 就是 `(ret)`。
    const isMain = info.name === 'main' && ps.length === 0;
    if (isMain && this.mainBody !== null) return this.err(n, '`int main()` 定义了两次');
    if (!isMain) {
      if (this.fns.has(info.name)) return this.err(n, `函数 '${info.name}' 定义了两次`);
      this.fns.set(info.name, { params: ps.map((p) => p.type), ret: info.type });
    }
    this.scopes = [new Map()];
    for (const p of ps) this.push(p.name, p.type);
    const save = this.retTy;
    this.retTy = isMain ? T_VOID : info.type;
    const body = this.block(n.items[3], 4);
    this.retTy = save;
    this.scopes = [];
    if (body === null) return null;
    if (isMain) { this.mainBody = body; return null; }
    const sig = ps.map((p) => `(${p.name} ${tyText(p.type)})`).join(' ');
    this.decls.push(`  (fn ${info.name} (${sig}) ${tyText(info.type)}\n${body})`);
    return null;
  }

  /* -------------------------------------------------------------- 语句 */

  /** `(compound unit)` -> 一串缩进好的语句文本（不含外层的 `(do …)`）。 */
  block(n, ind) {
    if (!isList(n) || head(n) !== 'compound') { this.err(n, '这里要一个 { … } 块'); return null; }
    this.scopes.push(new Map());
    const out = [];
    for (const s of this.flat(n.items[1])) {
      const lines = this.stmt(s, ind);
      if (lines !== null) for (const l of lines) out.push(l);
    }
    this.scopes.pop();
    return out.join('\n');
  }

  /** 一条语句 -> 若干行。返回 null 表示已经报过错。 */
  stmt(n, ind) {
    const pad = ' '.repeat(ind);
    if (!isList(n)) { this.err(n, '认不出的语句'); return null; }
    const h = head(n);
    if (h === 'empty-stmt') return [];
    if (h === 'type-decl') { this.typeDecl(n.items[1]); return []; }
    if (h === 'compound') {
      const b = this.block(n, ind + 2);
      return b === null ? null : [`${pad}(do`, b, `${pad})`];
    }
    if (h === 'var-decl') return this.localDecl(n, ind);
    if (h === 'expr-stmt') return this.exprStmt(n.items[1], ind);
    if (h === 'if') return this.ifStmt(n, ind);
    if (h === 'while') return this.whileStmt(n, ind);
    if (h === 'do') return this.doWhileStmt(n, ind);
    if (h === 'for') return this.forStmt(n, ind);
    if (h === 'return') return this.retStmt(n, ind);
    if (h === 'break' || h === 'continue') {
      const lvl = isAtom(n.items[1]) ? n.items[1].value : '1';
      if (lvl !== '1') { this.nope(n, `带层号的 ${h}${lvl}`); return null; }
      if (h === 'continue' && this.forStep !== null) {
        // 方言的 `cont` 跳到循环头，而 for 的步进在体的末尾 —— 直接接就会漏掉一次步进。
        // 与其给个错答案，不如在这儿停下（要接就得给方言加一条"带步进的循环"）。
        this.nope(n, '带步进的 for 里的 continue（方言的 cont 会跳过步进）');
        return null;
      }
      return [`${pad}(${h === 'break' ? 'brk' : 'cont'})`];
    }
    if (h === 'unsafe') {
      const save = this.unsafe;
      this.unsafe = true;
      const b = this.block(n.items[1], ind + 2);
      this.unsafe = save;
      return b === null ? null : [`${pad}(unsafe`, b, `${pad})`];
    }
    this.nope(n, `语句 '${h}'`);
    return null;
  }

  /** 局部量。没写初值的按零初始化 —— jancy 保证"用户代码碰到之前每一格都是零"。 */
  localDecl(n, ind) {
    const pad = ' '.repeat(ind);
    const sp = this.specs(n.items[1]);
    if (sp === null) return null;
    const out = [];
    for (const d of this.flat(n.items[2])) {
      const dh = isList(d) ? head(d) : null;
      let dcl = d;
      let initNode = null;
      if (dh === 'init') { dcl = d.items[1]; initNode = d.items[2]; }
      else if (dh === 'ref-init') { this.nope(d, '引用初始化（`:=`）'); return null; }
      const info = this.declarator(dcl, sp);
      if (info === null) return null;
      if (info.formals !== null) { this.nope(dcl, '局部的函数原型'); return null; }
      let code = null;
      if (initNode === null) {
        code = zeroOf(info.type);
        if (code === null) {
          // 结构体的零值方言里没有一条形式；`S s;` 要接就得先有"结构体字面量"。
          this.nope(dcl, `${tyName(info.type)} 的局部量不写初值`);
          return null;
        }
      } else {
        let v = this.expr(initNode, info.type);
        if (v === null) return null;
        if (isInt(v.type) && isInt(info.type)) v = intConv(v, info.type);
        if (!sameTy(v.type, info.type)) {
          this.err(initNode, `初值的类型是 ${tyName(v.type)}，声明的是 ${tyName(info.type)}`);
          return null;
        }
        code = v.code;
      }
      // 先降初值再进作用域：`int x = x;` 里右边那个 x 指的是外层那个（C 的规矩，jancy 同）
      this.push(info.name, info.type);
      out.push(`${pad}(let ${info.name} ${tyText(info.type)} ${code})`);
    }
    return out;
  }

  /** 可写的位置。方言里只有两种写法：`(set 名字 值)` 与 `(pstore 指针 值)`。 */
  lvalue(n) {
    if (!isList(n)) return this.err(n, '这里要一个可以赋值的位置');
    const h = head(n);
    if (h === 'name') {
      const nm = n.items[1].value;
      const t = this.lookup(nm);
      if (t === null) return this.err(n, `未声明的变量 '${nm}'`);
      return { kind: 'var', name: nm, type: t };
    }
    // `*p = v`
    if (h === 'indirect') {
      const p = this.expr(n.items[1], null);
      if (p === null) return null;
      if (!isPtr(p.type)) return this.err(n, `'*' 要一个指针，这里是 ${tyName(p.type)}`);
      return { kind: 'ptr', code: p.code, type: p.type.target };
    }
    // `p[i] = v`。jancy 的下标就是 `*(p + i)`，范围检查在解引用那一步
    // （type_ptr_data.rst：Range is checked on both array accesses and pointer dereferences）
    if (h === 'index') {
      const a = this.expr(n.items[1], null);
      if (a === null) return null;
      if (!isPtr(a.type)) return this.err(n, `下标要一个指针，这里是 ${tyName(a.type)}`);
      const i = this.expr(n.items[2], T_I64);
      if (i === null) return null;
      if (!isInt(i.type)) return this.err(n, `下标要整数，这里是 ${tyName(i.type)}`);
      return { kind: 'ptr', code: `(padd ${a.code} ${i.code})`, type: a.type.target };
    }
    // `p->f = v` 与 `(*p).f = v` 是同一件事
    if (h === 'ptr-field') return this.fieldLv(n, n.items[1], n.items[2]);
    if (h === 'field') {
      const ob = n.items[1];
      if (isList(ob) && head(ob) === 'indirect') return this.fieldLv(n, ob.items[1], n.items[2]);
      return this.nope(n, '不经指针的字段赋值（这一刀的结构体只能经指针到达）');
    }
    return this.nope(n, `赋值给 '${h}'`);
  }

  fieldLv(n, ptrNode, memNode) {
    const p = this.expr(ptrNode, null);
    if (p === null) return null;
    if (!isPtr(p.type)) return this.err(n, `'->' 要一个指针，这里是 ${tyName(p.type)}`);
    if (p.type.target.k !== 'struct') return this.err(n, `'->' 的目标不是结构体：${tyName(p.type.target)}`);
    const nm = isAtom(memNode) ? memNode.value : null;
    const fs = this.structs.get(p.type.target.name);
    const f = fs === undefined ? undefined : fs.find((x) => x.name === nm);
    if (f === undefined) return this.err(n, `${p.type.target.name} 没有字段 '${nm}'`);
    return { kind: 'ptr', code: `(pfield ${p.code} ${nm})`, type: f.type };
  }

  store(lv, valueCode) {
    return lv.kind === 'var' ? `(set ${lv.name} ${valueCode})` : `(pstore ${lv.code} ${valueCode})`;
  }

  read(lv) {
    return lv.kind === 'var' ? `(var ${lv.name})` : `(pload ${lv.code})`;
  }

  /** 表达式语句。赋值与 ++/-- 只在这儿（与 for 的两格）成立 —— 方言里它们是语句不是表达式。 */
  exprStmt(n, ind) {
    const pad = ' '.repeat(ind);
    if (!isList(n)) { this.err(n, '认不出的表达式语句'); return null; }
    const h = head(n);
    if (h === 'assign') {
      const op = isStr(n.items[1]) ? n.items[1].value : null;
      const lv = this.lvalue(n.items[2]);
      if (lv === null) return null;
      let v = this.expr(n.items[3], lv.type);
      if (v === null) return null;
      if (op === '=') {
        // 整数之间的赋值是**隐式收窄**（`char c = 300` 存 44）—— C 的规矩，jancy 同。
        if (isInt(lv.type) && isInt(v.type)) v = intConv(v, lv.type);
        if (!sameTy(v.type, lv.type)) {
          this.err(n, `赋值两边不同型：左是 ${tyName(lv.type)}，右是 ${tyName(v.type)}`);
          return null;
        }
        return [`${pad}${this.store(lv, v.code)}`];
      }
      const bin = op === null ? null : op.slice(0, -1);
      if (bin !== '+' && bin !== '-' && bin !== '*' && bin !== '/' && bin !== '%') {
        this.nope(n, `复合赋值 '${op}'`);
        return null;
      }
      // 指针上的 `p += i` 是**指针算术**，不是加法（type_ptr_data.rst 那段就是它）
      if (isPtr(lv.type)) {
        if (bin !== '+' && bin !== '-') { this.nope(n, `指针上的 '${op}'`); return null; }
        if (!isInt(v.type)) { this.err(n, `指针上的 '${op}' 右边要整数，这里是 ${tyName(v.type)}`); return null; }
        const d = bin === '+' ? v.code : `(un "-" ${v.code})`;
        return [`${pad}${this.store(lv, `(padd ${this.read(lv)} ${d})`)}`];
      }
      // `lv op= v` 就是 `lv = (T)(lv op v)`：算完之后回卷到 lv 那一格。
      // 结果宽度总是 >= lv 的宽度（常用算术转换只会变宽），所以直接回卷到 lv 就够，
      // 中间那一次可以省。`%` 不用回卷 —— 余数的绝对值不超过左边，天然在范围里。
      if (isInt(lv.type) && isInt(v.type)) {
        const code = `(bin "${bin}" ${this.read(lv)} ${v.code})`;
        return [`${pad}${this.store(lv, bin === '%' ? code : wrapTo(code, lv.type.w))}`];
      }
      if (!sameTy(v.type, lv.type)) {
        this.err(n, `'${op}' 两边不同型：左是 ${tyName(lv.type)}，右是 ${tyName(v.type)}`);
        return null;
      }
      return [`${pad}${this.store(lv, `(bin "${bin}" ${this.read(lv)} ${v.code})`)}`];
    }
    if (h === 'pre-inc' || h === 'post-inc' || h === 'pre-dec' || h === 'post-dec') {
      // 语句位置上前缀与后缀没有差别（都不取值）
      const lv = this.lvalue(n.items[1]);
      if (lv === null) return null;
      const up = h === 'pre-inc' || h === 'post-inc';
      if (isPtr(lv.type)) {
        return [`${pad}${this.store(lv, `(padd ${this.read(lv)} (int ${up ? '1' : '-1'}))`)}`];
      }
      if (isInt(lv.type)) {
        // `char c = 127; c++;` 是 -128（回卷），不是 128。
        const code = `(bin "${up ? '+' : '-'}" ${this.read(lv)} (int 1))`;
        return [`${pad}${this.store(lv, wrapTo(code, lv.type.w))}`];
      }
      if (lv.type !== T_REAL) {
        this.err(n, `'${up ? '++' : '--'}' 要整数 / real / 指针，这里是 ${tyName(lv.type)}`);
        return null;
      }
      return [`${pad}${this.store(lv, `(bin "${up ? '+' : '-'}" ${this.read(lv)} (real 1.0))`)}`];
    }
    if (h === 'call') return this.callStmt(n, ind);
    this.nope(n, `这条表达式语句（'${h}'）没有副作用，jancy 那边也会拒`);
    return null;
  }

  /** 调用当语句。printf 在这儿拆开；别的走普通调用，返回值丢掉。 */
  callStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const callee = n.items[1];
    const args = this.flat(n.items[2]);
    if (isList(callee) && head(callee) === 'name' && callee.items[1].value === 'printf') {
      return this.printf(n, args, ind);
    }
    const v = this.expr(n, null);
    if (v === null) return null;
    return [`${pad}(expr ${v.code})`];
  }

  /**
   * `printf(格式串, 实参…)` -> 若干条 `print`。
   *
   * 方言的 `print` 自带换行，所以按 `\n` 切开、每段一条。格式串**必须以换行收尾** ——
   * 不以换行收尾的那种要方言里有一条"不换行的输出"，那一格现在只有 JS 后端有。
   * 收的转换只有 `%d` / `%f` / `%s` / `%c` / `%%`。
   */
  printf(n, args, ind) {
    const pad = ' '.repeat(ind);
    if (args.length === 0) { this.err(n, 'printf 至少要一个格式串'); return null; }
    // 字面量是词法层的 `string` 节点（`{kind:'string', value, raw}`），不是 atom。
    if (!isStr(args[0])) {
      this.nope(args[0], 'printf 的格式串不是字面量（要它就得在运行期解释格式）');
      return null;
    }
    const fmt = args[0].value;
    const vals = [];
    for (let i = 1; i < args.length; i++) {
      const v = this.expr(args[i], null);
      if (v === null) return null;
      vals.push(v);
    }
    // 一段一段攒：`pieces` 是当前这一段的若干块（字符串常量与 (tostr …)）。
    // 遇到 `\n` 就发一条 `print`（它自带换行）；末尾那段没有换行时发 `(write …)`
    // ——方言这一刀刚长出 write，所以"不以 \n 收尾的格式串"不再是边界（ADR-0016 第四刀）。
    const out = [];
    let pieces = [];
    let ai = 0;
    let lit = '';
    const flushLit = () => { if (lit !== '') { pieces.push(`(str ${JSON.stringify(lit)})`); lit = ''; } };
    const flush = (nl) => {
      flushLit();
      if (pieces.length === 0) { if (nl) out.push(`${pad}(print (str ""))`); pieces = []; return; }
      let code = pieces[0];
      for (let k = 1; k < pieces.length; k++) code = `(bin "+" ${code} ${pieces[k]})`;
      out.push(`${pad}(${nl ? 'print' : 'write'} ${code})`);
      pieces = [];
    };
    for (let i = 0; i < fmt.length; i++) {
      const c = fmt[i];
      if (c === '\n') { flush(true); continue; }
      if (c !== '%') { lit += c; continue; }
      // 转换说明：`%` [标志] [宽度] [`.` 精度] 转换字符。标志只收 `-`（左对齐）与 `0`
      // （补零），宽度与精度只收十进制常量 —— `%*d`（宽度从实参来）要在运行期才知道宽度，
      // 那是"格式串在运行期解释"那条路，与"格式串必须是字面量"这条边界同一处。
      let j = i + 1;
      let left = false;
      let zero = false;
      while (fmt[j] === '-' || fmt[j] === '0') { if (fmt[j] === '-') left = true; else zero = true; j++; }
      let width = 0;
      while (fmt[j] >= '0' && fmt[j] <= '9') { width = width * 10 + (fmt[j].charCodeAt(0) - 48); j++; }
      // 精度 `.N`（ADR-0016 第八刀）。`.` 后面不写数字在 C 里是 0（`%.f` = `%.0f`）。
      let prec = -1;
      if (fmt[j] === '.') {
        j++;
        prec = 0;
        while (fmt[j] >= '0' && fmt[j] <= '9') { prec = prec * 10 + (fmt[j].charCodeAt(0) - 48); j++; }
      }
      const spec = fmt[j];
      i = j;
      if (spec === '%') { lit += '%'; continue; }
      if (spec !== 'd' && spec !== 'i' && spec !== 'f' && spec !== 's' && spec !== 'c'
        && spec !== 'x' && spec !== 'X' && spec !== 'o') {
        this.nope(n, `printf 的转换 '%${spec === undefined ? '' : spec}'`);
        return null;
      }
      // C 里精度对整数是"至少几位数字"、对 `%s` 是"最多取几个字符"—— 两件与小数无关的
      // 事，各要自己的一段。这一刀只做 `%f` 那一格，别的当场说清。
      if (prec >= 0 && spec !== 'f') {
        this.nope(n, `'%${spec}' 上的精度（C 里它不是小数位数：对整数是"至少几位"、对 %s 是"最多几个字符"）`);
        return null;
      }
      if (prec > 30) { this.err(n, `printf 的精度最多 30 位，这里是 ${prec}`); return null; }
      if (ai >= vals.length) { this.err(n, 'printf 的实参比格式串里的转换少'); return null; }
      const v = vals[ai];
      // 这条转换对应的**实参节点**（诊断要指着它）。`vals[k]` 是第 k 个转换的值，而
      // `args[0]` 是格式串，所以是 `ai + 1`；先取再自增 —— 自增之后取会指到下一个实参上。
      const argNode = args[ai + 1];
      ai++;
      let piece = null;
      // `%c`：一个码位 -> 一个字符。方言的 `(chr E)`（另外四条腿早就有它）。
      if (spec === 'c') {
        if (!isInt(v.type)) {
          this.err(argNode, `'%c' 要整数（jancy 的 char 就是 8 位整数），这里是 ${tyName(v.type)}`);
          return null;
        }
        piece = `(chr ${v.code})`;
      } else if ((spec === 'd' || spec === 'i') && v.type === T_BOOL) {
        // jancy 的 `bool` 底下是 int8，`printf("%d", b)` 印 1 / 0（C 的样子）——
        // 用 `sel` 变成 1 / 0，而不是 `(tostr b)`（那会印 true / false）。
        piece = `(tostr (sel ${v.code} (int 1) (int 0)))`;
      } else if ((spec === 'd' || spec === 'i') && isInt(v.type)) {
        // 四种位宽都收：值已经是规范形（符号扩展过的），照印就是 C 的样子。
        piece = `(tostr ${v.code})`;
      } else if (spec === 'x' || spec === 'X' || spec === 'o') {
        // `%x` / `%X` / `%o`（ADR-0016 第七刀）。C 把实参当 **unsigned** 读，而"多少位"
        // 是**默认实参提升之后**那一格 —— `printf("%x", (char)-56)` 印 `ffffffc8`（提到
        // int 之后当 32 位无符号读），不是 `c8`。所以这儿先掩到 promo(位宽) 位。
        // 64 位不用掩：`(sbase …)` 本来就把它的实参当无符号 64 位读。
        let code = null;
        let w = 32;
        if (v.type === T_BOOL) code = `(sel ${v.code} (int 1) (int 0))`;
        else if (isInt(v.type)) { code = v.code; w = promo(v.type.w); } else {
          this.err(argNode, `'%${spec}' 要整数，这里是 ${tyName(v.type)}`);
          return null;
        }
        if (w < 64) code = `(bin "&" ${code} (int ${(1n << BigInt(w)) - 1n}))`;
        piece = `(sbase ${code} (int ${spec === 'o' ? 8 : 16}))`;
        // 大写走 `(supper …)`：`sbase` 只给小写，这条是它们分工的那一刀。
        if (spec === 'X') piece = `(supper ${piece})`;
      } else if (spec === 'f') {
        // `%f` 是 C 的 `%.6f`（**默认精度 6**），不是"把这个数印出来" —— 原先这一格降成
        // `(tostr …)`（也就是 `%.6g`），于是 `printf("%f", 1.5)` 印 `1.5` 而 C 印
        // `1.500000`。那是一处静默的差别，第八刀把它补上：`(sfix E N)`，N 默认 6。
        if (v.type !== T_REAL) {
          this.err(argNode, `'%f' 要 double，这里是 ${tyName(v.type)}（整数先写 (double)x）`);
          return null;
        }
        piece = `(sfix ${v.code} (int ${prec < 0 ? 6 : prec}))`;
      } else {
        // 到这儿只剩 `%s`（`%d` / `%i` 在整数与 bool 上都在上面接完了，剩下的是类型不对）
        const want = spec === 's' ? T_STR : T_I32;
        if (!sameTy(v.type, want)) {
          this.err(argNode, `'%${spec}' 要 ${tyName(want)}，这里是 ${tyName(v.type)}`);
          return null;
        }
        piece = v.type === T_STR ? v.code : `(tostr ${v.code})`;
      }
      flushLit();
      if (width > 1) {
        // 宽度那一支要**多次读**这段文本（量长度、再拼上去），所以先落成一个局部量。
        // 直接内联的话 `%5d` 里的 `(call f x)` 会被算两遍（补零那一支是四遍）。
        // 落在这儿而不是别处：jancy 与 C 一样在调用前算完所有实参，先算一步更贴。
        const t = `$f${this.tmp}`;
        this.tmp++;
        out.push(`${pad}(let ${t} string ${piece})`);
        pieces.push(this.padTo(`(var ${t})`, width, left,
          zero && !left && spec !== 's' && spec !== 'c'));
      } else pieces.push(piece);
    }
    flush(false);   // 末尾没换行的那一段走 write
    if (ai !== vals.length) { this.err(n, 'printf 的实参比格式串里的转换多'); return null; }
    return out;
  }

  /**
   * 把一段文本补到至少 `w` 个字符宽。补的那一截是 `(srep 填充字符 (bin "-" w (slen s)))`
   * —— `srep` 在个数 <= 0 时回空串，所以"本来就够宽"这一情形不用另写一支。
   *
   * `0` 标志（补零）在 C 里是**补在符号后面**的：`%05d` 印 -42 是 `-0042`，不是 `00-42`。
   * 所以这一支要分开：第一个字符是 `-` 时先把它摘出来，零补在余下那截前面。要补的个数
   * 两种情形一样（`(w-1) - (len-1) == w - len`），所以只有拼法不同。
   * `code` 会被读好几次，调用方**必须**先把它落成一个局部量（见 printf 里那处）。
   */
  padTo(code, w, left, zero) {
    const gap = (fill) => `(srep (str "${fill}") (bin "-" (int ${w}) (slen ${code})))`;
    if (left) return `(bin "+" ${code} ${gap(' ')})`;
    if (!zero) return `(bin "+" ${gap(' ')} ${code})`;
    const rest = `(ssub ${code} (int 1) (bin "-" (slen ${code}) (int 1)))`;
    return `(sel (bin "==" (ssub ${code} (int 0) (int 1)) (str "-"))`
      + ` (bin "+" (str "-") (bin "+" ${gap('0')} ${rest}))`
      + ` (bin "+" ${gap('0')} ${code}))`;
  }

  /* -------------------------------------------------------------- 控制流 */

  /** 控制语句的体：语法上是 decl（属性块挂在它上面，见 jnc.grammar 那段注释），
   *  这里当一条语句降。单条与块都走 `(do …)`，省一处形状判断。 */
  body(n, ind) {
    const pad = ' '.repeat(ind);
    if (isList(n) && head(n) === 'compound') {
      const b = this.block(n, ind + 2);
      return b === null ? null : `${pad}(do\n${b}\n${pad})`;
    }
    this.scopes.push(new Map());
    const lines = this.stmt(n, ind + 2);
    this.scopes.pop();
    if (lines === null) return null;
    return `${pad}(do\n${lines.join('\n')}\n${pad})`;
  }

  /**
   * **真值化**。jancy 会把整数、实数与指针当条件用（C 的规矩，它没改）。方言的条件
   * 只收 bool（ADR-0014 决策 1），所以这一层把 jancy 侧那次隐式转换**显式写出来**。
   *
   * 这不是"向方言妥协"：转换本来就发生，只是 jancy 让它隐着。写出来之后五条腿看到的
   * 是同一句比较，而"整数怎么算真"这件事只有这一处定义。
   */
  truthy(v, node) {
    if (v === null) return null;
    if (v.type === T_BOOL) return v;
    if (isInt(v.type)) return { code: `(bin "!=" ${v.code} (int 0))`, type: T_BOOL };
    if (v.type === T_REAL) return { code: `(bin "!=" ${v.code} (real 0.0))`, type: T_BOOL };
    if (isPtr(v.type)) return { code: `(un "!" (pisnull ${v.code}))`, type: T_BOOL };
    return this.err(node, `${tyName(v.type)} 不能当条件用`);
  }

  cond(n) {
    return this.truthy(this.expr(n, T_BOOL), n);
  }

  ifStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const c = this.cond(n.items[1]);
    if (c === null) return null;
    const t = this.body(n.items[2], ind + 2);
    if (t === null) return null;
    if (n.items[3] === undefined) return [`${pad}(if ${c.code}`, t, `${pad})`];
    const e = this.body(n.items[3], ind + 2);
    if (e === null) return null;
    return [`${pad}(if ${c.code}`, t, e, `${pad})`];
  }

  whileStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const c = this.cond(n.items[1]);
    if (c === null) return null;
    const save = this.forStep;
    this.forStep = null;
    const b = this.body(n.items[2], ind + 2);
    this.forStep = save;
    if (b === null) return null;
    return [`${pad}(while ${c.code}`, b, `${pad})`];
  }

  /**
   * `do BODY while (C);` —— 方言里没有"后置判断的循环"，所以借一格标志：
   *
   *   (let $doN bool true)
   *   (while (bin "||" (var $doN) C)
   *     (do (set $doN (bool false)) BODY))
   *
   * `||` 短路，所以第一圈不会算 C（这一点要紧：C 里可能有第一圈还没成立的东西）。
   * 第二圈起判断落在循环头，也就是第一圈的体之后 —— 与 do-while 的语义一致。
   *
   * 标志清零放在体的**开头**而不是末尾：放末尾时体里的 `continue` 会把它跳过去，
   * 于是变成死循环。放开头就没有这个坑（`break` 照旧从 `while` 里出去）。
   */
  doWhileStmt(n, ind) {
    const pad = ' '.repeat(ind);
    const flag = `$do${this.tmp}`;
    this.tmp++;
    const save = this.forStep;
    this.forStep = null;
    const b = this.body(n.items[1], ind + 4);
    const c = this.cond(n.items[2]);
    this.forStep = save;
    if (b === null || c === null) return null;
    return [
      `${pad}(let ${flag} bool (bool true))`,
      `${pad}(while (bin "||" (var ${flag}) ${c.code})`,
      `${pad}  (do`,
      `${pad}    (set ${flag} (bool false))`,
      b,
      `${pad}  )`,
      `${pad})`,
    ];
  }

  /**
   * `for (INIT; C; STEP) BODY` -> `(do INIT (while C (do BODY STEP)))`。
   *
   * 三格都可以空：没有 C 时是 `(bool true)`。INIT 里的声明要能被 C / STEP / BODY 看到，
   * 所以整条包在一个 `(do …)` 里，而那个 do 自带一层作用域。
   *
   * 步进非空时体里的 `continue` 在 stmt() 里被拦掉 —— 方言的 `cont` 跳到循环头，
   * 会漏掉一次步进。
   */
  forStmt(n, ind) {
    const pad = ' '.repeat(ind);
    this.scopes.push(new Map());
    const out = [`${pad}(do`];
    const init = n.items[1];
    let bad = false;
    if (isList(init) && head(init) === 'none') { /* 空 */ }
    else if (isList(init) && head(init) === 'var-decl') {
      const ls = this.localDecl(init, ind + 2);
      if (ls === null) bad = true; else for (const l of ls) out.push(l);
    } else {
      for (const e of this.flat(init)) {
        const ls = this.exprStmt(e, ind + 2);
        if (ls === null) { bad = true; break; }
        for (const l of ls) out.push(l);
      }
    }
    // 步进：一串表达式语句（`for (…; …; i++, k += 2)`）。先降它 —— 拿到的行要塞进体的末尾。
    const steps = [];
    for (const e of this.flat(n.items[3])) {
      const ls = this.exprStmt(e, ind + 6);
      if (ls === null) { bad = true; break; }
      for (const l of ls) steps.push(l);
    }
    let cond = '(bool true)';
    const cn = n.items[2];
    if (!(isList(cn) && head(cn) === 'none')) {
      const c = this.cond(cn);
      if (c === null) bad = true; else cond = c.code;
    }
    const saveStep = this.forStep;
    this.forStep = steps.length === 0 ? null : steps;
    const b = this.body(n.items[4], ind + 4);
    this.forStep = saveStep;
    this.scopes.pop();
    if (bad || b === null) return null;
    out.push(`${pad}  (while ${cond}`);
    out.push(`${pad}    (do`);
    out.push(b);
    for (const s of steps) out.push(s);
    out.push(`${pad}    )`);
    out.push(`${pad}  )`);
    out.push(`${pad})`);
    return out;
  }

  retStmt(n, ind) {
    const pad = ' '.repeat(ind);
    if (n.items[1] === undefined) {
      if (this.retTy !== T_VOID) {
        this.err(n, `这个函数回 ${tyName(this.retTy)}，光一个 return 不够`);
        return null;
      }
      return [`${pad}(ret)`];
    }
    // `int main()` 降成方言的 `(main …)`，而那个入口不回值 —— `return 0` 就是 `(ret)`。
    // 只放过字面的 0（`return 1` 是"非零退出码"，这一层还没有那一格，得当场说清）。
    if (this.retTy === T_VOID) {
      const v = n.items[1];
      if (isAtom(v) && v.value === '0') return [`${pad}(ret)`];
      return this.nope(n, 'main 里 `return` 一个非 0 的值（方言的入口没有退出码）');
    }
    let v = this.expr(n.items[1], this.retTy);
    if (v === null) return null;
    if (isInt(v.type) && isInt(this.retTy)) v = intConv(v, this.retTy);
    if (!sameTy(v.type, this.retTy)) {
      this.err(n, `return 的类型是 ${tyName(v.type)}，函数声明的是 ${tyName(this.retTy)}`);
      return null;
    }
    return [`${pad}(ret ${v.code})`];
  }

  /* -------------------------------------------------------------- 表达式 */

  /**
   * 一个表达式 -> `{code, type}`。`want` 是**类型提示**，只有两处真的要它：
   *   - `null` 本身没有类型，得从左边（声明/形参/返回）那儿知道自己是什么指针
   *   - jancy 的 int -> double 是隐式的，所以 want 是 real 而结果是 int 时补一条 `toreal`
   * 别的地方 want 只是个建议，不影响结果的类型。
   */
  expr(n, want) {
    const v = this.expr0(n, want);
    if (v === null) return null;
    // int -> real 的隐式加宽（jancy 与 C 同）。反过来**不**做：那是丢精度，
    // jancy 那边也要一次显式强制转换。
    if (want === T_REAL && isInt(v.type)) return { code: `(toreal ${v.code})`, type: T_REAL };
    return v;
  }

  /** 数值字面量。方言的 `(int …)` 只收十进制，所以 `0x` / `0b` / `0o` 在这儿就折成十进制。 */
  numLit(n) {
    const s = n.value;
    if (/^0[xX][0-9a-fA-F]+$/.test(s)) return this.intLit(n, BigInt(`0x${s.slice(2)}`));
    if (/^0[bB][01]+$/.test(s)) return this.intLit(n, BigInt(`0b${s.slice(2)}`));
    if (/^0[oO][0-7]+$/.test(s)) return this.intLit(n, BigInt(`0o${s.slice(2)}`));
    if (/^0[oO][0-9]+$/.test(s)) return this.err(n, `八进制字面量里有 8 或 9：'${s}'`);
    if (/^[0-9]+$/.test(s)) return this.intLit(n, BigInt(s));
    // FP 那两条词法规则出来的形状（`1.5` / `1.` / `1e3` / `1.5e-3`）方言的 realLit 都收
    if (/^[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?$/.test(s)) return { code: `(real ${s})`, type: T_REAL };
    return this.err(n, `认不出的字面量 '${s}'`);
  }

  /**
   * 整数字面量的类型：**装得下就是 `int`（32 位），装不下就是 `long`（64 位）**。C 的规矩，
   * jancy 同。这条有个众所周知的后果，照抄不改：`-2147483648` 是 `long` 而不是 `int`
   * （一元减在字面量**之外**，而 `2147483648` 已经装不下 32 位了）。
   */
  intLit(n, v) {
    if (v > 0x7fffffffffffffffn) return this.err(n, `整数字面量超出 long 能装的范围：'${n.value}'`);
    return { code: `(int ${v})`, type: v > 0x7fffffffn ? T_I64 : T_I32 };
  }

  expr0(n, want) {
    if (isStr(n)) return { code: `(str ${JSON.stringify(n.value)})`, type: T_STR };
    if (isAtom(n)) return this.numLit(n);
    if (!isList(n)) return this.err(n, '认不出的表达式');
    const h = head(n);
    switch (h) {
      case 'true': return { code: '(bool true)', type: T_BOOL };
      case 'false': return { code: '(bool false)', type: T_BOOL };
      case 'null': {
        // `null` 自己没有类型。左边知道要什么时就用它；不知道时（比如 `x == null` 里
        // x 是整数）当场说清，而不是随便挑一个。
        if (want === null || want === undefined || !isPtr(want)) {
          return this.err(n, 'null 得从左边知道自己是哪种指针（这里问不出来）');
        }
        return { code: `(pnull ${tyText(want)})`, type: want };
      }
      case 'name': {
        const nm = n.items[1].value;
        const t = this.lookup(nm);
        if (t === null) {
          if (this.fns.has(nm)) return this.nope(n, `把函数 '${nm}' 当值用`);
          return this.err(n, `未声明的变量 '${nm}'`);
        }
        return { code: `(var ${nm})`, type: t };
      }
      case 'binary': return this.binary(n);
      case 'unary': return this.unary(n, want);
      case 'indirect': return this.load(n, this.derefLv(n));
      case 'index': return this.load(n, this.derefLv(n));
      case 'ptr-field': return this.load(n, this.fieldLv(n, n.items[1], n.items[2]));
      case 'field': {
        const ob = n.items[1];
        if (isList(ob) && head(ob) === 'indirect') {
          return this.load(n, this.fieldLv(n, ob.items[1], n.items[2]));
        }
        return this.nope(n, '不经指针的字段读（这一刀的结构体只能经指针到达）');
      }
      case 'call': return this.callExpr(n);
      case 'new-array': return this.newPtr(n, n.items[1], n.items[2]);
      case 'new': return this.newPtr(n, n.items[1], null);
      case 'cast': return this.cast(n, n.items[1], n.items[2]);
      case 'cond': return this.ternary(n, want);
      case 'addr':
        return this.nope(n, '`&x`（要局部量可寻址，ADR-0016 里单独记着）');
      case 'pre-inc': case 'post-inc': case 'pre-dec': case 'post-dec':
        return this.nope(n, `表达式里的 ${h}（方言里它是语句；单独写成一行就行）`);
      default:
        return this.nope(n, `表达式 '${h}'`);
    }
  }

  /** `(indirect p)` / `(index p i)` 复用 lvalue 那一份 —— 读写两侧算的是同一个地址。 */
  derefLv(n) { return this.lvalue(n); }

  /**
   * 二元。这一层要分三件事，都得先知道两边的类型：
   *   - `p - q` 是**指针差**（按元素），`p + i` / `p - i` 是指针算术
   *   - `p == null` 是 `(pisnull p)`；方言里没有指针相等，所以 `p == q` 明着不收
   *   - 一边 int 一边 real 时把 int 那边加宽（jancy 与 C 同）
   */
  binary(n) {
    const op = isStr(n.items[1]) ? n.items[1].value : (isAtom(n.items[1]) ? n.items[1].value : null);
    if (op === null) return this.err(n, '认不出的二元算符');
    // jancy 自己的三条：`=~` / `!~`（正则）与 `@`（按位与的取反版）。方言里没有对应物。
    if (op === '=~' || op === '!~' || op === '@') return this.nope(n, `算符 '${op}'`);
    // null 那一侧要从另一侧知道自己的类型，所以先降"不是 null"的那一边
    const lNull = isList(n.items[2]) && head(n.items[2]) === 'null';
    const rNull = isList(n.items[3]) && head(n.items[3]) === 'null';
    let a = null;
    let b = null;
    if (lNull && !rNull) {
      b = this.expr(n.items[3], null);
      if (b === null) return null;
      a = this.expr(n.items[2], b.type);
    } else {
      a = this.expr(n.items[2], null);
      if (a === null) return null;
      b = this.expr(n.items[3], isPtr(a.type) && rNull ? a.type : null);
    }
    if (a === null || b === null) return null;
    // `&&` / `||` 两边各自真值化（jancy 与 C 同：`p && n` 是合法的）。方言的
    // `(bin "&&" …)` 是惰性的（Logic 节点），短路语义不用这一层操心。
    if (op === '&&' || op === '||') {
      const ta = this.truthy(a, n.items[2]);
      const tb = this.truthy(b, n.items[3]);
      if (ta === null || tb === null) return null;
      return { code: `(bin "${op}" ${ta.code} ${tb.code})`, type: T_BOOL };
    }
    if (isPtr(a.type) || isPtr(b.type)) {
      if (op === '==' || op === '!=') {
        // 跟 null 比走 `pisnull`（一条指令），两个指针互比走方言新长出来的 `peq`。
        // 两条都是**有定义**的：arena 偏移与真地址都是标量，比相等在两套实现下一致。
        let t = null;
        if (lNull !== rNull) t = `(pisnull ${lNull ? b.code : a.code})`;
        else if (!isPtr(a.type) || !isPtr(b.type)) {
          return this.err(n, `'${op}' 一边是指针一边是 ${tyName(isPtr(a.type) ? b.type : a.type)}`);
        } else if (!sameTy(a.type, b.type)) {
          return this.err(n, `'${op}' 两个指针不同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
        } else t = `(peq ${a.code} ${b.code})`;
        return { code: op === '==' ? t : `(un "!" ${t})`, type: T_BOOL };
      }
      if (op === '-' && isPtr(a.type) && isPtr(b.type)) {
        if (!sameTy(a.type, b.type)) {
          return this.err(n, `指针差要同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
        }
        return { code: `(psub ${a.code} ${b.code})`, type: T_I64 };
      }
      if ((op === '+' || op === '-') && isPtr(a.type) && isInt(b.type)) {
        const d = op === '+' ? b.code : `(un "-" ${b.code})`;
        return { code: `(padd ${a.code} ${d})`, type: a.type };
      }
      // `i + p` 也成立（C 的规矩），但 `i - p` 不成立
      if (op === '+' && isInt(a.type) && isPtr(b.type)) {
        return { code: `(padd ${b.code} ${a.code})`, type: b.type };
      }
      return this.nope(n, `指针上的 '${op}'`);
    }
    const cmp = op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=';
    // 两边都是整数：先常用算术转换定出结果那一格的宽度，再看要不要回卷。
    if (isInt(a.type) && isInt(b.type)) {
      const code = `(bin "${op}" ${a.code} ${b.code})`;
      // 比较不用管宽度：两边都是规范形，直接比就是对的（这也是"规范形"这条不变式的用处）。
      if (cmp) return { code, type: T_BOOL };
      // 移位的结果宽度**只看左边** —— 右边不参与常用算术转换（C 的规矩，jancy 同）。
      const rw = (op === '<<' || op === '>>')
        ? promo(a.type.w)
        : Math.max(promo(a.type.w), promo(b.type.w));
      // 会溢出的只有这五条；`% & | ^ >>` 在规范形上天然还在范围里，一个字都不用发。
      const over = op === '+' || op === '-' || op === '*' || op === '/' || op === '<<';
      return { code: over ? wrapTo(code, rw) : code, type: mkInt(rw) };
    }
    // 一边整数一边 real：加宽整数那一边
    if (isInt(a.type) && b.type === T_REAL) a = { code: `(toreal ${a.code})`, type: T_REAL };
    else if (a.type === T_REAL && isInt(b.type)) b = { code: `(toreal ${b.code})`, type: T_REAL };
    if (!sameTy(a.type, b.type)) {
      return this.err(n, `'${op}' 两边不同型：左是 ${tyName(a.type)}，右是 ${tyName(b.type)}`);
    }
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: cmp ? T_BOOL : a.type };
  }

  unary(n, want) {
    const op = isStr(n.items[1]) ? n.items[1].value : (isAtom(n.items[1]) ? n.items[1].value : null);
    const a = this.expr(n.items[2], op === '!' ? T_BOOL : want);
    if (a === null) return null;
    if (op === '+') {
      // 一元加是恒等，但**带整型提升**（`char c; +c` 是 int）。提升在规范形里不发一个字。
      if (isInt(a.type)) return { code: a.code, type: mkInt(promo(a.type.w)) };
      if (a.type !== T_REAL) return this.err(n, `一元 '+' 要整数 / real，这里是 ${tyName(a.type)}`);
      return a;
    }
    if (op === '-') {
      // `char c = -128; -c` 还是 -128 吗？不是 —— 提到 int 之后是 128。回卷按**提升后**那一格。
      if (isInt(a.type)) {
        const w = promo(a.type.w);
        return { code: wrapTo(`(un "-" ${a.code})`, w), type: mkInt(w) };
      }
      if (a.type !== T_REAL) return this.err(n, `一元 '-' 要整数 / real，这里是 ${tyName(a.type)}`);
      return { code: `(un "-" ${a.code})`, type: a.type };
    }
    if (op === '!') {
      // `!p` / `!n` 也成立（jancy 与 C 同）：先真值化再取反。
      const t = this.truthy(a, n.items[2]);
      if (t === null) return null;
      return { code: `(un "!" ${t.code})`, type: T_BOOL };
    }
    if (op === '~') {
      // 方言的 `un` 只有 `-` 与 `!`，但按位取反不用新形式：`~x` 就是 `x ^ -1`。
      // 不用回卷 —— 提升后那一格里的规范形取反还在同一格里（`~127` = -128）。
      if (!isInt(a.type)) return this.err(n, `'~' 要整数，这里是 ${tyName(a.type)}`);
      return { code: `(bin "^" ${a.code} (int -1))`, type: mkInt(promo(a.type.w)) };
    }
    return this.nope(n, `一元 '${op}'`);
  }

  /**
   * `c ? a : b` -> `(sel c 甲 乙)`。方言这一刀刚长出 `sel`（惰性：只算取中的那一支），
   * 所以这里是一对一的映射，不用拆成临时量加 if —— 那种拆法只在语句位置成立。
   *
   * 两支的类型：jancy 与 C 一样会做常用算术转换，这一层只做 int -> real 那一步
   * （方言的 `sel` 要两支同型，而它刻意不推导）。
   */
  ternary(n, want) {
    const c = this.cond(n.items[1]);
    let a = this.expr(n.items[2], want);
    let b = this.expr(n.items[3], want === null || want === undefined ? (a === null ? null : a.type) : want);
    if (c === null || a === null || b === null) return null;
    // 两支都是整数：结果是较宽的那一格（常用算术转换）。加宽在规范形里不发一个字，
    // 而方言的 `sel` 看到的两支都是它那一个 int，所以这儿只改类型不改代码。
    if (isInt(a.type) && isInt(b.type)) {
      const w = Math.max(promo(a.type.w), promo(b.type.w));
      return { code: `(sel ${c.code} ${a.code} ${b.code})`, type: mkInt(w) };
    }
    if (isInt(a.type) && b.type === T_REAL) a = { code: `(toreal ${a.code})`, type: T_REAL };
    else if (a.type === T_REAL && isInt(b.type)) b = { code: `(toreal ${b.code})`, type: T_REAL };
    if (!sameTy(a.type, b.type)) {
      return this.err(n, `'? :' 两支不同型：甲是 ${tyName(a.type)}，乙是 ${tyName(b.type)}`);
    }
    return { code: `(sel ${c.code} ${a.code} ${b.code})`, type: a.type };
  }

  callExpr(n) {
    const callee = n.items[1];
    const nm = isList(callee) && head(callee) === 'name' ? callee.items[1].value : null;
    if (nm === null) return this.nope(n, '不是直接调一个名字的调用');
    if (nm === 'printf') return this.nope(n, '把 printf 的返回值当值用');
    const sig = this.fns.get(nm);
    if (sig === undefined) return this.err(n, `没有这个函数：'${nm}'`);
    const args = this.flat(n.items[2]);
    if (args.length !== sig.params.length) {
      return this.err(n, `'${nm}' 要 ${sig.params.length} 个实参，这里给了 ${args.length} 个`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      let v = this.expr(args[i], sig.params[i]);
      if (v === null) return null;
      // 实参与赋值同一条规矩：整数隐式转到形参那一格（窄了就回卷）。
      if (isInt(v.type) && isInt(sig.params[i])) v = intConv(v, sig.params[i]);
      if (!sameTy(v.type, sig.params[i])) {
        return this.err(args[i], `'${nm}' 的第 ${i + 1} 个实参要 ${tyName(sig.params[i])}，`
          + `这里是 ${tyName(v.type)}`);
      }
      parts.push(v.code);
    }
    if (sig.ret === T_VOID) return { code: `(call ${nm}${parts.map((p) => ` ${p}`).join('')})`, type: T_VOID };
    return { code: `(call ${nm}${parts.map((p) => ` ${p}`).join('')})`, type: sig.ret };
  }

  /** `new T[n]` -> `(pnew (ptr T) n)`；`new T` -> 一格。两者出来的都是**指针**。 */
  newPtr(n, tnNode, countNode) {
    if (!isList(tnNode) || head(tnNode) !== 'type-name') return this.nope(tnNode, '这种 new 的类型');
    const sp = this.specs(tnNode.items[1]);
    if (sp === null) return null;
    const t = this.ptrsTy(sp, tnNode.items[2], tnNode);
    if (t === null) return null;
    if (t === T_VOID) return this.err(n, 'new void');
    let count = '(int 1)';
    if (countNode !== null) {
      const c = this.expr(countNode, T_I64);
      if (c === null) return null;
      if (!isInt(c.type)) return this.err(countNode, `new T[n] 的 n 要整数，这里是 ${tyName(c.type)}`);
      count = c.code;
    }
    return { code: `(pnew ${tyText(tPtr(t))} ${count})`, type: tPtr(t) };
  }

  /**
   * 强制转换。这一刀只认三种，别的当场报错：
   *   - `(double)i` / `(int)d` -> `(toreal …)` / `(toint …)`
   *   - `(T thin*)p` -> `(pthin p)`（fat 丢掉范围；方言要求它写在 `unsafe` 里）
   *   - 同型（写了但没变）-> 原样
   */
  cast(n, tnNode, exprNode) {
    if (!isList(tnNode) || head(tnNode) !== 'type-name') return this.nope(tnNode, '这种强制转换的类型');
    const sp = this.specs(tnNode.items[1]);
    if (sp === null) return null;
    const to = this.ptrsTy(sp, tnNode.items[2], tnNode);
    if (to === null) return null;
    const v = this.expr(exprNode, to);
    if (v === null) return null;
    if (sameTy(v.type, to)) return v;
    if (isInt(to) && isInt(v.type)) return intConv(v, to);
    if (to === T_REAL && isInt(v.type)) return { code: `(toreal ${v.code})`, type: T_REAL };
    if (isInt(to) && v.type === T_REAL) {
      // 先向零截断成 64 位（方言的 `toint` 就是它），再回卷到目标那一格。
      return intConv({ code: `(toint ${v.code})`, type: T_I64 }, to);
    }
    if (to.k === 'tptr' && v.type.k === 'ptr' && sameTy(to.target, v.type.target)) {
      // 在这儿拦一次而不是等方言报：这条消息能指着 jancy 那一行说话。
      if (!this.unsafe) {
        return this.err(n, '转成 thin 指针要写在 `unsafe { … }` 里 —— 它把范围丢掉了');
      }
      return { code: `(pthin ${v.code})`, type: to };
    }
    return this.nope(n, `把 ${tyName(v.type)} 转成 ${tyName(to)}`);
  }

  load(n, lv) {
    if (lv === null) return null;
    return { code: this.read(lv), type: lv.type };
  }
}


