// Omni stage0 — asymptote 前端：asy 语法树 -> 核心 S 表达式方言（ADR-0014 第 2 道门槛）
//
// ## 为什么这里有一个手写的降级，而 tests/sexpr 那门玩具语言没有
//
// （那门语言的名字刻意不写在这里 —— tests/sexpr 那条轴的硬指标就是"编译器源码里不许出现
// 它的名字"，连注释也算。）
//
// 「加一门语言 = grammar + 映射标注」这句话管的是**语法**：asy.grammar 是从 camp.y 照原样
// 转写的，动作模板出来的树跟 camp.y 的 AST 一一对应（84 个真实模块全过，一份不落）。
// 但 asy 的**语义**不是语法能表达的：`1/3` 是实数除法而 `1#3` 是整数商、`3 == 3.0` 要把
// 左边提成 real、`write` 的分隔符规则取决于第一个实参是不是字符串 —— 每一条都要先知道
// 子表达式的类型。类型是符号表的事，模板里没有符号表。
//
// 所以这个文件只做**类型定向**的那一半，而且刻意只出核心方言的文本：出来的东西六条腿
// 都能跑（run / run-c / interp / interp --mir / run-llvm / build），中间没有为 asy 写的
// 第二份降级。语法那一半仍然一行代码都没有。
//
// ## 第一刀的边界（都是**刻意**的，不是漏的）
//
// 支持：int / real / bool / string 四种标量、变量与赋值、`+ - * / # % ^` 与比较、
// `&& ||`、一元 `- !`、`++ --` 与 `+= -= *= /=`、`?:`、if/else、while、do-while、
// C 式 for、break/continue、函数（含递归）、`(int)`/`(real)` 强制转换、`write`
// （含 real 的 %.15g —— 核心方言的 `(tostr E N)` 就是为它加的）、内建数学函数
// sqrt/fabs/abs/floor/ceil/round/fmod（核心方言的 `(rmath …)`）。
//
// 不支持（见到就报错，报错里说清是哪一条）：数组、pair/triple、struct、import/access、
// typedef、算符重载、重载解析、默认实参、命名实参、for-each、超越函数（exp/log/trig ——
// 量过 libm 与 V8 在 atan/tan/log/cos 的最后一位就分叉，收进来六条腿必然有一天对不上）、
// 循环条件里的 `?:`（摊出来的赋值只能落在循环外面，条件就只
// 算一次了 —— 语义会变，所以报错而不是悄悄换个意思）。
//
// ## 与真 asy 的差别，写在这里而不是等着被发现
//
// - 整数溢出：asy 是运行期报错（量过：`2^62 * 4` -> "Integer overflow"），我们回绕。
// - `2^-1`：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
//   我们的 helper 对负指数返回 0（`^` 那条 helper 里写着）。

import { isList, isAtom, isStr, head } from '../sexpr/read.js';

/** 所有「这一刀还没做」的报错都带上这句 —— 测试轴按它判「拒得对不对」 */
export const ASY_NOPE = 'asy 前端第一刀还不支持';

const SCALARS = new Set(['int', 'real', 'bool', 'string']);

/** 算符文本。语法模板里有两种写法：`(bin "+" …)` 给的是字符串节点，
 *  `(self $2 $1 $3)` 直接把 SELFOP **词法 token**（原子）搬过来。两种都要认。
 *  名字带 asy 前缀是封闭 ABI 的要求：模块级的名字全局唯一（mir/print.js 已有一个 opText）。 */
const asyOpText = (n) => (isStr(n) || isAtom(n) ? n.value : null);

/**
 * asy 运行时自带的数学函数（不是 plain.asy 里的定义，所以这一层认它们不算偷偷补模块系统）。
 * 返回类型是量出来的（`asy -noV`）：`floor/ceil/round` 回 **int**（`int i = floor(2.7)`
 * 编得过），`sqrt/fabs/fmod` 回 real，`abs` 按实参分 int/real。
 * 名单只到核心方言 `(rmath …)` 收的那几个为止 —— exp/log/sin 这些各家最后一位就分叉，
 * 方言那边没收（理由在 runtime/omni_math.c 的头注里）。
 */
const ASY_MATH = new Map([
  ['sqrt', { fn: 'sqrt', arity: 1, ret: 'real' }],
  ['fabs', { fn: 'fabs', arity: 1, ret: 'real' }],
  ['abs', { fn: 'fabs', arity: 1, ret: 'real' }],
  ['floor', { fn: 'floor', arity: 1, ret: 'int' }],
  ['ceil', { fn: 'ceil', arity: 1, ret: 'int' }],
  ['round', { fn: 'round', arity: 1, ret: 'int' }],
  ['fmod', { fn: 'fmod', arity: 2, ret: 'real' }],
]);

/** 没写初值时的零值。asy 也是这么定的（未初始化的 int 是 0，string 是空串）。 */
const ZERO = new Map([['int', '(int 0)'], ['real', '(real 0.0)'], ['bool', '(bool false)'], ['string', '(str "")']]);

/** 核心方言的字符串字面量。刻意不用 JSON.stringify：它对控制字符发 \uXXXX，
 *  而 sexpr/read.js 的转义表里没有 \u（那是 WAT 的方言）。只转必须转的五个。 */
function strLit(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out + '"';
}

/**
 * 按需发的 helper 函数。多数是「asy 的算符与核心方言的算符不是同一个」逼出来的：
 * `#` 向下取整、`%` 的符号跟着除数、int 上的 `^` 是幂、`abs(int)` 回 int。
 * 每条都只发一次，且只在用到时发。
 */
const HELPERS = new Map([
  ['asy__iabs', `  (fn asy__iabs ((a int)) int
    ;; 整数取绝对值。核心方言的 (rmath "fabs" …) 只吃 real，而 asy 的 abs(int) 回 int ——
    ;; 绕一趟 real 会在 2^53 以上丢精度，所以这里就是一个比较。
    (if (bin "<" (var a) (int 0)) (do (ret (un "-" (var a)))))
    (ret (var a)))`],
  ['asy__quot', `  (fn asy__quot ((a int) (b int)) int
    ;; asy 的 # 是**向下**取整；核心方言的 / 是截断。差别只在"除不尽且异号"时。
    (let q int (bin "/" (var a) (var b)))
    (if (bin "!=" (bin "%" (var a) (var b)) (int 0))
      (do
        (if (bin "!=" (bin "<" (var a) (int 0)) (bin "<" (var b) (int 0)))
          (do (set q (bin "-" (var q) (int 1)))))))
    (ret (var q)))`],
  ['asy__mod', `  (fn asy__mod ((a int) (b int)) int
    ;; asy 的 % 的符号跟着**除数**（量过：-7%3=2、7%-3=-2）；核心方言是 C 语义。
    (let m int (bin "%" (var a) (var b)))
    (if (bin "&&" (bin "!=" (var m) (int 0)) (bin "!=" (bin "<" (var m) (int 0)) (bin "<" (var b) (int 0))))
      (do (set m (bin "+" (var m) (var b)))))
    (ret (var m)))`],
  ['asy__ipow', `  (fn asy__ipow ((a int) (b int)) int
    ;; asy 的 ^ 是幂，核心方言的 ^ 是异或，所以只能写成循环。
    ;; 负指数：asy 报 "Only 1 and -1 can be raised to negative exponents as integers"，
    ;; 我们这一刀不做那条运行期检查，返回 0 —— 差别写在文件头。
    (let r int (int 1))
    (let i int (int 0))
    (if (bin "<" (var b) (int 0)) (do (ret (int 0))))
    (while (bin "<" (var i) (var b))
      (do
        (set r (bin "*" (var r) (var a)))
        (set i (bin "+" (var i) (int 1)))))
    (ret (var r)))`],
  ['asy__boolstr', `  (fn asy__boolstr ((b bool)) string
    ;; asy 在 bool 后面**总是补一个空格**（量过：write(false) 是 6 字节 "false "，
    ;; write("a",false) 是 "afalse "，所以不是对齐到 5，是算符自带的尾空格）
    (if (var b) (do (ret (str "true "))))
    (ret (str "false ")))`],
]);

class AsyLower {
  constructor(diags) {
    this.diags = diags;
    this.funcs = new Map();    // 名字 -> {ret, params: 类型名数组}
    this.scopes = [];          // 名字 -> 类型名
    this.used = new Set();     // 用到的 helper
    // for 的更新片段栈。C 式 for 降成 while 之后，`continue` 必须**先跑更新**再跳 ——
    // 不这么做 `for(i=0;i<5;++i){if(i==2)continue;}` 就死循环。量过 asy 的行为：更新会跑。
    this.updates = [];
    this.tmp = 0;
    // 当前语句的**前置语句**。核心方言里 `? :` 不是表达式，只能摊成临时量 + if/else，
    // 那两条 if/else 就攒在这里，由 stmt() 的外壳补在这条语句前面。
    // null = 不在语句上下文里（那时见到 `? :` 只能报错，不能悄悄丢）。
    this.pre = null;
    // 文件级变量的名字。核心方言没有全局量，所以函数里碰到它们要给一句**说得清**的错，
    // 而不是"未声明的变量"——后者会让人以为是拼错了。
    this.globals = new Map();
  }

  err(node, msg) {
    this.diags.error(node === null || node === undefined ? null : node.span, msg);
    return null;
  }

  nope(node, what) {
    return this.err(node, `${ASY_NOPE}：${what}`);
  }

  /** `(H)` / `(H X)` / `(H-add PREV X)` 这三种形状摊成一条平的列表 */
  flat(node, name) {
    if (!isList(node)) return [];
    const h = head(node);
    if (h === `${name}-add`) {
      const out = this.flat(node.items[1], name);
      out.push(node.items[2]);
      return out;
    }
    if (h === name) {
      const out = [];
      for (const x of node.items.slice(1)) out.push(x);
      return out;
    }
    return [node];
  }

  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }

  lookup(nm) {
    let i = this.scopes.length - 1;
    while (i >= 0) {
      if (this.scopes[i].has(nm)) return this.scopes[i].get(nm);
      i--;
    }
    return null;
  }

  declare(node, nm, t) {
    if (this.scopes[this.scopes.length - 1].has(nm)) return this.err(node, `'${nm}' 在这一层已经声明过了`);
    this.scopes[this.scopes.length - 1].set(nm, t);
    return t;
  }

  /* ------------------------------------------------------------------ 类型 */

  /** `(name-ty (name int))` -> 'int'。数组/记录/pair 这一刀不做。 */
  type(node, what) {
    if (!isList(node)) return this.err(node, `${what}：这里要一个类型`);
    const h = head(node);
    if (h === 'array-ty') return this.nope(node, '数组类型');
    if (h !== 'name-ty') return this.err(node, `${what}：认不出的类型形状 '${h}'`);
    const nm = this.plainName(node.items[1]);
    if (nm === null) return this.nope(node, '带点的类型名');
    if (nm === 'void') return 'void';
    if (!SCALARS.has(nm)) return this.nope(node, `类型 '${nm}'（这一刀只有 int/real/bool/string）`);
    return nm;
  }

  /** `(name x)` -> 'x'；`(qualified ...)` 与算符名（`operator +`）都回 null */
  plainName(node) {
    if (!isList(node) || head(node) !== 'name') return null;
    const a = node.items[1];
    if (!isAtom(a)) return null;
    if (a.value.startsWith('operator ')) return null;
    return a.value;
  }

  /* ---------------------------------------------------------------- 表达式 */

  /** 出 `{code, type}`；失败回 null（诊断已记） */
  expr(n) {
    if (n === undefined || n === null) return this.err(null, '少了一个表达式');
    // 字面量：LIT 是裸原子（`3` / `3.5` / `true`），STRING 是字符串节点
    if (isStr(n)) return { code: `(str ${strLit(n.value)})`, type: 'string' };
    if (isAtom(n)) return this.lit(n);
    if (!isList(n)) return this.err(n, '认不出的表达式');
    return this.exprList(n, head(n));
  }

  lit(n) {
    const t = n.value;
    if (t === 'true' || t === 'false') return { code: `(bool ${t})`, type: 'bool' };
    if (/^[0-9]/.test(t) || t.startsWith('.')) {
      const real = t.includes('.') || t.includes('e') || t.includes('E');
      return real ? { code: `(real ${t})`, type: 'real' } : { code: `(int ${t})`, type: 'int' };
    }
    return this.nope(n, `字面量 '${t}'`);
  }

  /** 数值提升：asy 允许 `3 == 3.0`（量过），核心方言两边必须同型，于是这里显式插 toreal */
  promote(a, b) {
    if (a.type === b.type) return a.type;
    if (a.type === 'int' && b.type === 'real') { a.code = `(toreal ${a.code})`; a.type = 'real'; return 'real'; }
    if (a.type === 'real' && b.type === 'int') { b.code = `(toreal ${b.code})`; b.type = 'real'; return 'real'; }
    return null;
  }

  /** 往目标类型靠：只有 int -> real 这一个方向，其余不匹配就是错 */
  coerce(v, want, node, what) {
    if (v === null) return null;
    if (v.type === want) return v;
    if (v.type === 'int' && want === 'real') return { code: `(toreal ${v.code})`, type: 'real' };
    return this.err(node, `${what}：要 ${want}，这里是 ${v.type}`);
  }

  exprList(n, h) {
    if (h === 'name-exp') {
      const nm = this.plainName(n.items[1]);
      if (nm === null) return this.nope(n, '带点的名字或算符名');
      const t = this.lookup(nm);
      if (t === null) {
        if (this.globals.has(nm)) return this.nope(n, `函数里引用文件级变量 '${nm}'（核心方言没有全局量）`);
        return this.err(n, `未声明的变量 '${nm}'`);
      }
      return { code: `(var ${nm})`, type: t };
    }
    if (h === 'binary') return this.binary(n);
    if (h === 'equality') return this.compare(n, n.items[1].value);
    if (h === 'and-exp' || h === 'or-exp') return this.logic(n, h === 'and-exp' ? '&&' : '||');
    if (h === 'unary') return this.unary(n);
    if (h === 'cast') return this.cast(n);
    if (h === 'call') return this.call(n);
    if (h === 'cond') return this.cond(n);
    if (h === 'assign' || h === 'self' || h === 'prefix' || h === 'postfix') {
      return this.nope(n, `赋值/自增出现在表达式位置（'${h}'）—— 这一刀只认它们当语句`);
    }
    if (h === 'tuple-exp') return this.nope(n, 'pair / triple');
    if (h === 'subscript' || h === 'slice-exp') return this.nope(n, '下标与切片');
    if (h === 'field') return this.nope(n, '取字段');
    if (h === 'new-array' || h === 'new-record' || h === 'new-function') return this.nope(n, 'new');
    if (h === 'scale') return this.nope(n, '隐式缩放（`105cm` 这种）');
    if (h === 'join-exp' || h === 'join-dir' || h === 'spec' || h === 'spec-curl') return this.nope(n, '路径连接');
    return this.nope(n, `表达式 '${h}'`);
  }

  /** 算术。asy 与核心方言不一致的四个算符（`/` `#` `%` `^`）全在这里换掉。 */
  binary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    if (op === '<' || op === '<=' || op === '>' || op === '>=') return this.cmpCode(n, op, a, b);
    if (op === '#') {
      if (a.type !== 'int' || b.type !== 'int') return this.err(n, `'#' 两边要是 int，这里是 ${a.type} 和 ${b.type}`);
      this.used.add('asy__quot');
      return { code: `(call asy__quot ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '%') {
      if (a.type !== 'int' || b.type !== 'int') return this.nope(n, "real 上的 '%'");
      this.used.add('asy__mod');
      return { code: `(call asy__mod ${a.code} ${b.code})`, type: 'int' };
    }
    if (op === '^') {
      if (a.type === 'int' && b.type === 'int') {
        this.used.add('asy__ipow');
        return { code: `(call asy__ipow ${a.code} ${b.code})`, type: 'int' };
      }
      // 有一边是 real 就走 pow（量过：`2.0^3` 是 8、`2^0.5` 是 1.4142135623731）
      const av = this.coerce(a, 'real', n, "'^' 的左边");
      const bv = this.coerce(b, 'real', n, "'^' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(rmath "pow" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op === '/') {
      // asy 的 `/` 永远是实数除法：`1/3` 是 0.333…，整数商要写 `#`（量过）
      const av = this.coerce(a, 'real', n, "'/' 的左边");
      const bv = this.coerce(b, 'real', n, "'/' 的右边");
      if (av === null || bv === null) return null;
      return { code: `(bin "/" ${av.code} ${bv.code})`, type: 'real' };
    }
    if (op !== '+' && op !== '-' && op !== '*') return this.nope(n, `算符 '${op}'`);
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    if (t === 'string' && op !== '+') return this.err(n, `字符串上只有 '+'，这里是 '${op}'`);
    if (t === 'bool') return this.err(n, `'${op}' 不接受 bool`);
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: t };
  }

  cmpCode(n, op, a, b) {
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `'${op}' 两边要同型：左是 ${a.type}，右是 ${b.type}`);
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  compare(n, op) {
    const a = this.expr(n.items[2]);
    const b = this.expr(n.items[3]);
    if (a === null || b === null) return null;
    return this.cmpCode(n, op, a, b);
  }

  /**
   * `c ? a : b`。核心方言里 `? :` 不是表达式，于是摊成一个临时量加一条 if/else：
   *     (let t T <零值>) (if c (do (set t a)) (do (set t b)))
   * 两支各自的前置语句放进**各自那一支**里 —— 这样嵌套的 `? :` 也不会被提到 if 外面，
   * 短路语义（只算中选的那一支）跟着编码保住了。条件自己的前置语句留在外层：它总要算。
   */
  cond(n) {
    if (this.pre === null) return this.nope(n, '这个位置的 `? :`（它要摊成语句，这里放不下）');
    const c = this.coerce(this.expr(n.items[1]), 'bool', n, '`? :` 的条件');
    const outer = this.pre;
    this.pre = [];
    const a = this.expr(n.items[2]);
    const aPre = this.pre;
    this.pre = [];
    const b = this.expr(n.items[3]);
    const bPre = this.pre;
    this.pre = outer;
    if (c === null || a === null || b === null) return null;
    const t = this.promote(a, b);
    if (t === null) return this.err(n, `\`? :\` 两支要同型：真支是 ${a.type}，假支是 ${b.type}`);
    if (t === 'void') return this.err(n, '`? :` 的两支不能是 void');
    const av = this.coerce(a, t, n, '`? :` 的真支');
    const bv = this.coerce(b, t, n, '`? :` 的假支');
    if (av === null || bv === null) return null;
    const nm = `asy__c${this.tmp++}`;
    const yes = aPre.concat([`(set ${nm} ${av.code})`]).join(' ');
    const no = bPre.concat([`(set ${nm} ${bv.code})`]).join(' ');
    this.pre.push(`(let ${nm} ${t} ${ZERO.get(t)})`);
    this.pre.push(`(if ${c.code} (do ${yes}) (do ${no}))`);
    return { code: `(var ${nm})`, type: t };
  }

  logic(n, op) {
    const a = this.coerce(this.expr(n.items[1]), 'bool', n, `'${op}' 的左边`);
    const b = this.coerce(this.expr(n.items[2]), 'bool', n, `'${op}' 的右边`);
    if (a === null || b === null) return null;
    return { code: `(bin "${op}" ${a.code} ${b.code})`, type: 'bool' };
  }

  unary(n) {
    const op = asyOpText(n.items[1]) ?? '?';
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    if (op === '!') {
      if (v.type !== 'bool') return this.err(n, `'!' 要 bool，这里是 ${v.type}`);
      return { code: `(un "!" ${v.code})`, type: 'bool' };
    }
    if (op === '+') return v;
    if (op === '-') {
      if (v.type !== 'int' && v.type !== 'real') return this.err(n, `一元 '-' 要 int/real，这里是 ${v.type}`);
      return { code: `(un "-" ${v.code})`, type: v.type };
    }
    return this.nope(n, `一元算符 '${op}'`);
  }

  /** `(int) e` / `(real) e`。别的目标类型这一刀不做。 */
  cast(n) {
    const t = this.type(n.items[1], '强制转换');
    if (t === null) return null;
    const v = this.expr(n.items[2]);
    if (v === null) return null;
    if (t === v.type) return v;
    if (t === 'real' && v.type === 'int') return { code: `(toreal ${v.code})`, type: 'real' };
    if (t === 'int' && v.type === 'real') return { code: `(toint ${v.code})`, type: 'int' };
    return this.nope(n, `把 ${v.type} 转成 ${t}`);
  }

  /** 实参表摊平。命名实参与展开都不做 —— 那要重载解析。 */
  args(node) {
    const out = [];
    for (const a of this.flat(node, 'args')) {
      if (!isList(a) || head(a) !== 'arg') {
        this.nope(a, isList(a) && head(a) === 'arg-named' ? '命名实参' : '展开实参');
        return null;
      }
      out.push(a.items[1]);
    }
    return out;
  }

  /** 调用。`write` 是语句（void），在表达式位置见到它就报错。 */
  call(n) {
    const nm = isList(n.items[1]) && head(n.items[1]) === 'name-exp' ? this.plainName(n.items[1].items[1]) : null;
    if (nm === null) return this.nope(n, '调用一个不是普通名字的东西（函数值、方法、算符名）');
    if (nm === 'write') return this.err(n, `${ASY_NOPE}：write 出现在表达式位置（它是语句）`);
    // 内建数学函数先看：asy 里 sqrt/floor/… 是运行时自带的，不是 plain.asy 里的定义，
    // 所以这一层认它们不算"偷偷补模块系统"。用户自己定义了同名函数时以用户的为准
    // （asy 那边是重载，这一刀没有重载，让用户的定义赢至少不会静悄悄换掉语义）。
    if (!this.funcs.has(nm) && ASY_MATH.has(nm)) return this.mathCall(n, nm);
    const d = this.funcs.get(nm);
    if (d === undefined) return this.nope(n, `内建函数 '${nm}'（这一刀只有 write 和你自己定义的函数）`);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== d.params.length) {
      return this.err(n, `'${nm}' 要 ${d.params.length} 个实参，给了 ${args.length} 个（默认实参与重载都还没做）`);
    }
    const parts = [];
    for (let i = 0; i < args.length; i++) {
      const v = this.coerce(this.expr(args[i]), d.params[i], args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    if (d.ret === 'void') return { code: `(call ${nm}${parts.length === 0 ? '' : ' '}${parts.join(' ')})`, type: 'void' };
    return { code: `(call ${nm}${parts.length === 0 ? '' : ' '}${parts.join(' ')})`, type: d.ret };
  }

  /**
   * 内建数学函数。整数上的 `abs` 走一条 helper（核心方言里没有整数取绝对值），
   * 回 int 的那三个在 `(rmath …)` 外面套一层 `(toint …)` —— 结果本来就是整数，
   * 截断是精确的。
   */
  mathCall(n, nm) {
    const spec = ASY_MATH.get(nm);
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length !== spec.arity) {
      return this.err(n, `'${nm}' 要 ${spec.arity} 个实参，给了 ${args.length} 个`);
    }
    const vs = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      vs.push(v);
    }
    if (nm === 'abs' && vs[0].type === 'int') {
      this.used.add('asy__iabs');
      return { code: `(call asy__iabs ${vs[0].code})`, type: 'int' };
    }
    const parts = [];
    for (let i = 0; i < vs.length; i++) {
      const v = this.coerce(vs[i], 'real', args[i], `'${nm}' 的第 ${i + 1} 个实参`);
      if (v === null) return null;
      parts.push(v.code);
    }
    const code = `(rmath "${spec.fn}" ${parts.join(' ')})`;
    if (spec.ret === 'int') return { code: `(toint ${code})`, type: 'int' };
    return { code, type: 'real' };
  }

  /**
   * `write` 的重载是量出来的，形状是 `write(string s="", T x, T[] more..., suffix=endl)`：
   * 前缀 `s` 与第一个 T 之间**没有**分隔符，T 与 T 之间是制表符，而所有 T 必须**同型**。
   * 逐条量过（`asy -noV`，od -c 看字节）：
   *   write("a",1,2)        -> `a1\tab2`  ... 即 "a" "1" TAB "2"
   *   write("a","b","c")    -> `ab\tc`    ... 第一个串当前缀，后两个才是 T=string
   *   write("s",true,false) -> `strue \tfalse `
   *   write(1,"b",2)        -> no matching function 'write(int, string, int)'
   *   write("a","b",1)      -> no matching function（前缀吃掉 "a" 之后 T 定成了 string）
   *   write(true,"x")       -> no matching function（没有前缀，T 定成了 bool）
   * real 这一刀不收：格式对不上（见文件头）。
   */
  writeStmt(n) {
    const args = this.args(n.items[2]);
    if (args === null) return null;
    if (args.length === 0) return this.nope(n, '不带实参的 write');
    const vals = [];
    for (const a of args) {
      const v = this.expr(a);
      if (v === null) return null;
      if (v.type === 'void') return this.err(a, 'write 的实参不能是 void');
      vals.push(v);
    }
    // 只有实参多于一个时第一个串才是前缀 —— 单个 write("a") 里 "a" 就是那个 T
    const prefix = vals.length > 1 && vals[0].type === 'string';
    const rest = vals.slice(prefix ? 1 : 0);
    const t = rest[0].type;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].type === t) continue;
      const at = args[(prefix ? 1 : 0) + i];
      const shape = vals.map((v) => v.type).join(', ');
      return this.err(at, `write 的实参要同型 —— asy 那边 write(${shape}) 就是 no matching function`);
    }
    const parts = vals.map((v) => {
      if (v.type === 'string') return v.code;
      // real 用 15 位有效数字 —— asy 的默认输出就是 %.15g（量过：1/3 是
      // 0.333333333333333、sqrt(2) 是 1.4142135623731、1e-5 是 1e-05、-0.0 是 -0）
      if (v.type === 'real') return `(tostr ${v.code} (int 15))`;
      if (v.type !== 'bool') return `(tostr ${v.code})`;
      this.used.add('asy__boolstr');
      return `(call asy__boolstr ${v.code})`;
    });
    // 前缀与第一个值之间不加分隔符，值与值之间加制表符
    let code = parts[0];
    for (let i = 1; i < parts.length; i++) {
      if (!(i === 1 && prefix)) code = `(bin "+" ${code} (str "\\t"))`;
      code = `(bin "+" ${code} ${parts[i]})`;
    }
    return [`(print ${code})`];
  }

  /* ---------------------------------------------------------------- 语句 */

  /**
   * 一条 asy 语句可能摊成好几条核心方言语句，所以一律回数组；失败回 null。
   *
   * 外壳负责**前置语句**：`? :` 这种"核心方言里不是表达式"的东西，降级时要先算进一个
   * 临时量，那几条就攒在 this.pre 里，由这里补在本条语句前面。每条语句一份 pre，所以
   * 嵌套语句（if 的分支、循环体）各自算各自的，不会被提到外面去。
   */
  stmt(n, ret) {
    const outer = this.pre;
    this.pre = [];
    const lines = this.stmtOne(n, ret);
    const pre = this.pre;
    this.pre = outer;
    if (lines === null) return null;
    if (pre.length === 0) return lines;
    return pre.concat(lines);
  }

  /**
   * 循环条件里不许有前置语句。`? :` 摊出来的临时量赋值只能放在**循环外面**，那样条件就
   * 只算一次，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   * @param {number} mark 算条件之前 this.pre 的长度
   */
  loopCond(node, what, mark) {
    if (this.pre === null || this.pre.length === mark) return true;
    return this.nope(node, `${what} 的条件里的 \`? :\`（它要摊成语句，而循环条件每轮都得重算）`);
  }

  stmtOne(n, ret) {
    if (!isList(n)) return this.err(n, '认不出的语句');
    const h = head(n);
    if (h === 'empty-stm') return [];
    if (h === 'modified') return this.stmt(n.items[2], ret);
    if (h === 'vardec') return this.vardec(n);
    if (h === 'exp-stm') return this.exprStmt(n.items[1]);
    if (h === 'block-stm') {
      const body = this.body(n.items[1], ret);
      return body === null ? null : [`(do ${body.join(' ')})`];
    }
    if (h === 'if') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'if 的条件');
      const t = this.stmt(n.items[2], ret);
      if (c === null || t === null) return null;
      if (n.items[3] === undefined) return [`(if ${c.code} (do ${t.join(' ')}))`];
      const e = this.stmt(n.items[3], ret);
      if (e === null) return null;
      return [`(if ${c.code} (do ${t.join(' ')}) (do ${e.join(' ')}))`];
    }
    if (h === 'while') {
      const c = this.coerce(this.expr(n.items[1]), 'bool', n, 'while 的条件');
      if (this.loopCond(n, 'while', 0) === null) return null;
      this.updates.push([]);
      const b = this.stmt(n.items[2], ret);
      this.updates.pop();
      if (c === null || b === null) return null;
      return [`(while ${c.code} (do ${b.join(' ')}))`];
    }
    if (h === 'do') return this.doWhile(n, ret);
    if (h === 'for') return this.forStmt(n, ret);
    if (h === 'for-each') return this.nope(n, 'for-each（要数组）');
    if (h === 'break') return ['(brk)'];
    if (h === 'continue') {
      // C 式 for 降成 while 之后，continue 要**先跑更新**再跳（量过 asy 的行为）
      const upd = this.updates.length === 0 ? [] : this.updates[this.updates.length - 1];
      const out = [];
      for (const u of upd) out.push(u);
      out.push('(cont)');
      return out;
    }
    if (h === 'return') {
      if (n.items[1] === undefined) return ['(ret)'];
      const v = this.coerce(this.expr(n.items[1]), ret, n, 'return 的值');
      return v === null ? null : [`(ret ${v.code})`];
    }
    return this.nope(n, `语句 '${h}'`);
  }

  /**
   * `do S while (c)` -> `while (true) { S; if (!c) break; }`。
   * 刻意不复制 S（复制会让 S 里的 break 落在循环外面），代价是 `continue` 在这个编码里
   * 会跳过条件检查，语义就错了 —— 所以见到就报错，而不是悄悄换个意思。
   */
  doWhile(n, ret) {
    this.updates.push([]);
    const b = this.stmt(n.items[1], ret);
    this.updates.pop();
    const mark = this.pre === null ? 0 : this.pre.length;
    const c = this.coerce(this.expr(n.items[2]), 'bool', n, 'do-while 的条件');
    if (this.loopCond(n, 'do-while', mark) === null) return null;
    if (b === null || c === null) return null;
    for (const s of b) {
      if (s === '(cont)' || s.includes(' (cont)')) return this.nope(n, 'do-while 里的 continue');
    }
    return [`(while (bool true) (do ${b.join(' ')} (if (un "!" ${c.code}) (do (brk)))))`];
  }

  /** `for (init; test; upd) body` -> `init; while (test) { body; upd }`（continue 见上） */
  forStmt(n, ret) {
    this.push();
    const init = this.forPart(n.items[1], ret);
    const mark = this.pre === null ? 0 : this.pre.length;
    const test = isList(n.items[2]) && head(n.items[2]) === 'none'
      ? { code: '(bool true)', type: 'bool' }
      : this.coerce(this.expr(n.items[2]), 'bool', n, 'for 的条件');
    if (this.loopCond(n, 'for', mark) === null) { this.pop(); return null; }
    const upd = this.forPart(n.items[3], ret);
    if (init === null || test === null || upd === null) { this.pop(); return null; }
    this.updates.push(upd);
    const body = this.stmt(n.items[4], ret);
    this.updates.pop();
    this.pop();
    if (body === null) return null;
    const inner = [];
    for (const s of body) inner.push(s);
    for (const s of upd) inner.push(s);
    return [`(do ${init.join(' ')} (while ${test.code} (do ${inner.join(' ')})))`];
  }

  /** for 的 init / update 段：`(none)` / `(stmexps ...)` / 一条 barevardec */
  forPart(n, ret) {
    if (!isList(n)) return [];
    const h = head(n);
    if (h === 'none') return [];
    if (h === 'vardec') return this.vardec(n);
    const out = [];
    for (const s of this.flat(n, 'stmexps')) {
      const one = this.stmt(s, ret);
      if (one === null) return null;
      for (const x of one) out.push(x);
    }
    return out;
  }

  /** `int a = 1, b;`：没有初值的按类型给零值 —— asy 也是这么定的 */
  vardec(n) {
    const t = this.type(n.items[1], '变量声明');
    if (t === null) return null;
    if (t === 'void') return this.err(n, 'void 变量');
    const out = [];
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') return this.err(d, '认不出的声明项');
      const start = d.items[1];
      if (!isList(start) || head(start) !== 'decidstart') return this.err(start, '认不出的声明项');
      if (start.items.length > 2) return this.nope(start, '声明里带数组维度或形参表');
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '声明里少了名字');
      let init = ZERO.get(t);
      if (d.items[2] !== undefined) {
        const v = this.coerce(this.expr(d.items[2]), t, d, `'${nm}' 的初值`);
        if (v === null) return null;
        init = v.code;
      }
      if (this.declare(start, nm, t) === null) return null;
      out.push(`(let ${nm} ${t} ${init})`);
    }
    return out;
  }

  /** 语句位置的表达式。赋值/自增只认这里 —— 它们在核心方言里是语句，不是表达式。 */
  exprStmt(e) {
    if (!isList(e)) return this.err(e, '认不出的表达式语句');
    const h = head(e);
    if (h === 'assign') return this.assign(e, e.items[1], e.items[2], null);
    if (h === 'self') {
      // SELFOP 是词法给的 token（原子），而 `(prefix "+" …)` 里的算符是模板里的字符串 ——
      // 两种节点都可能，所以一律用 asyOpText 取文本，不假设是哪一种
      const op = asyOpText(e.items[1]);
      if (op === null || op.length !== 2 || !'+-*/#%^'.includes(op.slice(0, 1))) return this.nope(e, `复合赋值 '${op}'`);
      return this.assign(e, e.items[2], e.items[3], op.slice(0, 1));
    }
    if (h === 'prefix' || h === 'postfix') {
      const op = asyOpText(e.items[1]);
      if (op !== '+' && op !== '-') return this.nope(e, `自增/自减 '${op}'`);
      return this.assign(e, e.items[2], null, op);
    }
    if (h === 'call') {
      const nm = isList(e.items[1]) && head(e.items[1]) === 'name-exp' ? this.plainName(e.items[1].items[1]) : null;
      if (nm === 'write') return this.writeStmt(e);
      const v = this.call(e);
      if (v === null) return null;
      return [`(expr ${v.code})`];
    }
    return this.nope(e, `语句位置的表达式 '${h}'`);
  }

  /** 赋值、复合赋值、自增自减都归到这里：目标只能是一个普通变量名 */
  assign(node, lhs, rhs, op) {
    const nm = isList(lhs) && head(lhs) === 'name-exp' ? this.plainName(lhs.items[1]) : null;
    if (nm === null) return this.nope(node, '赋值给不是普通变量的东西（下标、字段、算符名）');
    const t = this.lookup(nm);
    if (t === null) {
      if (this.globals.has(nm)) return this.nope(node, `函数里改文件级变量 '${nm}'（核心方言没有全局量）`);
      return this.err(node, `未声明的变量 '${nm}'`);
    }
    if (op === null) {
      const v = this.coerce(this.expr(rhs), t, node, `给 '${nm}' 赋的值`);
      return v === null ? null : [`(set ${nm} ${v.code})`];
    }
    // 自增自减：右边就是 1，类型跟着变量
    const one = rhs === null ? { code: t === 'real' ? '(real 1.0)' : '(int 1)', type: t } : this.expr(rhs);
    if (one === null) return null;
    if (rhs === null && t !== 'int' && t !== 'real') return this.err(node, `'${nm}' 是 ${t}，不能自增自减`);
    if (op === '#' || op === '%') {
      if (t !== 'int' || one.type !== 'int') return this.err(node, `'${op}=' 两边要是 int`);
      const helper = op === '#' ? 'asy__quot' : 'asy__mod';
      this.used.add(helper);
      return [`(set ${nm} (call ${helper} (var ${nm}) ${one.code}))`];
    }
    if (op === '^') {
      if (t !== 'int' || one.type !== 'int') return this.nope(node, "real 上的 '^='");
      this.used.add('asy__ipow');
      return [`(set ${nm} (call asy__ipow (var ${nm}) ${one.code}))`];
    }
    if (op === '/') {
      if (t !== 'real') return this.nope(node, `int 上的 '/='（asy 的 / 是实数除法，赋回 int 要写 #=）`);
      const v = this.coerce(one, 'real', node, "'/=' 的右边");
      return v === null ? null : [`(set ${nm} (bin "/" (var ${nm}) ${v.code}))`];
    }
    const v = this.coerce(one, t, node, `'${op}=' 的右边`);
    if (v === null) return null;
    if (t === 'string' && op !== '+') return this.err(node, `字符串上只有 '+='`);
    if (t === 'bool') return this.err(node, `bool 上没有 '${op}='`);
    return [`(set ${nm} (bin "${op}" (var ${nm}) ${v.code}))`];
  }

  /** 一段花括号里的东西：`(block-stm BLOCK)` 或直接一条 BLOCK 链 */
  body(n, ret) {
    const inner = isList(n) && head(n) === 'block-stm' ? n.items[1] : n;
    this.push();
    const out = [];
    for (const r of this.flat(inner, 'block')) {
      const one = this.stmt(r, ret);
      if (one === null) { this.pop(); return null; }
      for (const s of one) out.push(s);
    }
    this.pop();
    return out;
  }

  /* ------------------------------------------------------------ 文件与函数 */

  /** `static real f(...)` 这类修饰在文件层是无所谓的，剥掉 */
  unwrapMod(n) {
    let cur = n;
    while (isList(cur) && head(cur) === 'modified') cur = cur.items[2];
    return cur;
  }

  /** 形参表：`(formal (implicit) TYPE (decidstart NAME))`；别的形状都不做 */
  formals(node) {
    const out = [];
    for (const f of this.flat(node, 'formals')) {
      if (!isList(f) || head(f) !== 'formal') return this.nope(f, '关键字形参或可变形参');
      if (f.items.length !== 4) return this.nope(f, f.items.length === 3 ? '无名形参' : '带默认值的形参');
      const ex = f.items[1];
      if (isList(ex) && head(ex) === 'explicit') return this.nope(f, 'explicit 形参');
      const t = this.type(f.items[2], '形参');
      const start = f.items[3];
      if (t === null) return null;
      if (!isList(start) || head(start) !== 'decidstart' || start.items.length !== 2) return this.nope(start, '带维度或形参表的形参名');
      const nm = isAtom(start.items[1]) ? start.items[1].value : null;
      if (nm === null) return this.err(start, '形参少了名字');
      out.push({ name: nm, type: t });
    }
    return out;
  }

  /** 第一遍：登记签名。没有重载 —— 同名第二次就是错。 */
  sig(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    if (nm === null) return;
    if (nm.startsWith('operator ')) { this.nope(n, '算符重载的定义'); return; }
    if (nm === 'write') { this.nope(n, "重新定义 'write'"); return; }
    const ret = this.type(n.items[1], `函数 ${nm} 的返回类型`);
    const ps = this.formals(n.items[3]);
    if (ret === null || ps === null) return;
    if (this.funcs.has(nm)) { this.nope(n, `重载：'${nm}' 定义了不止一次`); return; }
    const types = [];
    for (const p of ps) types.push(p.type);
    this.funcs.set(nm, { ret, params: types });
  }

  /** 第一遍也收文件级变量的名字（只为了给函数里那句错话） */
  globalNames(n) {
    for (const d of this.flat(n.items[2], 'decids')) {
      if (!isList(d) || head(d) !== 'decid') continue;
      const start = d.items[1];
      if (!isList(start) || !isAtom(start.items[1])) continue;
      this.globals.set(start.items[1].value, true);
    }
  }

  /** 第二遍：函数体。核心方言要求非 void 的函数每条路径都有 ret，asy 不要求 —— 差别见下。 */
  func(n) {
    const nm = isAtom(n.items[2]) ? n.items[2].value : null;
    const d = nm === null ? undefined : this.funcs.get(nm);
    if (d === undefined) return null;
    const ps = this.formals(n.items[3]);
    if (ps === null) return null;
    this.push();
    for (const p of ps) this.declare(n, p.name, p.type);
    const body = this.body(n.items[4], d.ret);
    this.pop();
    if (body === null) return null;
    // 掉出函数尾巴：asy 是运行期报 "function did not return a value"，我们补一条零值 ret。
    // 这是**明写的**差别，不是漏的：核心方言的检查在编译期，而这条 ret 永远走不到才对。
    const last = body.length === 0 ? '' : body[body.length - 1];
    if (d.ret !== 'void' && !last.startsWith('(ret ')) body.push(`(ret ${ZERO.get(d.ret)})`);
    const params = [];
    for (const p of ps) params.push(`(${p.name} ${p.type})`);
    const lines = [`  (fn ${nm} (${params.join(' ')}) ${d.ret}`];
    for (const s of body) lines.push(`    ${s}`);
    return `${lines.join('\n')})`;
  }

  /** 整个文件 -> 核心方言文本。函数提到模块层，其余全进 (main ...)。 */
  run(tree) {
    const rs = this.flat(tree, 'block');
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (!isList(r)) continue;
      if (head(r) === 'fundec') this.sig(r);
      else if (head(r) === 'vardec') this.globalNames(r);
    }
    const fns = [];
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (!isList(r) || head(r) !== 'fundec') continue;
      const f = this.func(r);
      if (f !== null) fns.push(f);
    }
    this.push();
    const main = [];
    for (const r0 of rs) {
      const r = this.unwrapMod(r0);
      if (isList(r) && head(r) === 'fundec') continue;
      const s = this.stmt(r, 'void');
      if (s === null) continue;
      for (const x of s) main.push(x);
    }
    this.pop();
    const out = ['(module'];
    for (const [hnm, text] of HELPERS) {
      if (this.used.has(hnm)) out.push(text);
    }
    for (const f of fns) out.push(f);
    const body = [];
    for (const s of main) body.push(`    ${s}`);
    out.push(`  (main${body.length === 0 ? '' : `\n${body.join('\n')}`}))`);
    return out.join('\n') + '\n';
  }
}

/**
 * asy 语法树 -> 核心方言文本。
 * @param {any} tree glrParse 出来的那棵树（asy.grammar 的 file 规则）
 * @param {import('../source/diag.js').Diagnostics} diags
 * @returns {string} 核心方言源文本（诊断有错时内容不可用）
 */
export function lowerAsy(tree, diags) {
  return new AsyLower(diags).run(tree);
}
