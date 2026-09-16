#!/usr/bin/env node
// Omni — jancy 前端（第十五条测试轴，ADR-0016 分步 8 的验收）
//
// 这条轴与 tests/asy 那条是**两条不同的纪律**。asy 那边有 oracle（`/opt/homebrew/bin/asy
// -noV`），所以每一条都要"量"；jancy 的 `jnc` 要 LLVM + axl 才编得出来，我们不装它 ——
// 用户定的是「只借用 jancy 的完整语法和形式」。所以这边每一条期望输出都由我们自己写，
// 而**每一条都要在源文件的注释里注明出处**（引哪一份文档、哪一条 `.llk` 规则、哪一份语料）。
//
// 语法那一半不在这里：`src/core/frontend-jnc/jnc.grammar` 在 tests/glr/run.js 的
// `cases/jnc` 那一组里量（526/528 份真实 `.jnc` 唯一成树）。这里量的是**降级**。
//
// 四件事：
//   1. cases/*.jnc 在 run / run-c / interp / interp --mir / run-llvm / run-jit 六条腿上
//      逐字节相同，且等于 .expected。多方一致比对上期望值更强 —— 指针在这些腿上是**两套实现**
//      （arena 模拟 vs 真指针，ADR-0016），逐字节相同不是巧合。第六条腿（ORC JIT）是
//      **jancy 自己的执行路径**（它没有 AOT），见 ADR-0022 的 J1；没有 libLLVM 时跳过。
//      **默认只跑 run-jit 与 run 两条** —— jancy 没有 AOT，真的 `jnc` 就是 JIT 跑的，
//      所以这门语言最要紧的那条腿是 `run-jit`；`run` 是最快的基准，且它那边的指针是
//      arena 模拟、JIT 那边是真指针，两套实现各留一边。`OMNI_LEGS=all` 跑齐六条 ——
//      理由与量出来的数在下面 LEGS 那儿。
//   2. rt/*.jnc 在这几条腿上报**同一句**运行期错误。
//   3. bad/*.jnc 必须被拒绝，且拒在正确的理由上。这一组是那些边界的本体：多维数组、
//      数组之间的赋值、`threadlocal`、对 string 的模块级变量取地址、`%p`、
//      `unsafe` 之外的 thin 转换、`%zd` 那一族的长度修饰、函数类型的
//      typedef、`sizeof`（要方言的布局先认整数宽度）、`dynamic countof`（要 fat 指针带的
//      范围）、从一个要先求值的东西上问枚举成员、枚举的底类型是另一个枚举（要枚举之间的基类链）、
//      `using namespace`（要查名从一条线变成一张图）、类的基类里剩下的那几条（多继承、
//      拿结构体当基类、下转、同名方法上再写一遍 `virtual`）、
//      类里的 `destruct`（jancy 自己的文档就说它是 GC 在不确定的时刻调的，disposable.rst:17）、
//      `opaque class` 上那些**实现在宿主里**的成员（两条：方法与 construct —— jancy 那边由
//      扩展库的 JNC_BEGIN_CLASS 宏映到 C++ 的函数地址上，abi.rst:60-70，我们还没有宿主面。
//      construct 那一条尤其不能悄悄放过去：那等于交出一格全零的内存），
//      属性那一族剩下的九格（结构体的成员属性 —— 取/存那两个体要从"类那一层命名空间"里
//      查过来，结构体在这一层不是；`virtual` 写在属性上 —— 这一层的虚派发按方法名接，属性
//      那两个函数的名字是自己拼的；属性当一格**可写的内存**用（`b.p++` / `&b.p`）—— 读写各是
//      一次调用，"就地改"接不上，而报"没有这个字段"是认错了人；属性指针（`int property* p`）
//      —— 那个词写在星号**前面**，于是它进的是那格 `*` 自己的 prefix、落出来是
//      `getPropertyPtrType`（jnc_ct_DeclTypeCalc.cpp:80-85）：里头存的是"取/存两个函数 + 那个
//      对象"，与一格普通指针两码事。函数体、形参、顶层（prop-ptr-top）三处各钉一条 —— 不拦
//      就会被悄悄降成一格普通指针，或者悄悄登记成"类型是 int* 的属性"；完整声明式
//      `property p { … }` —— 那对花括号开的是一层命名空间（prop_full.rst:15），落到 specs
//      那儿报的是"这条声明没有类型"，也是认错了人；`autoget` 写在不是属性的那一格上 —— 它在
//      jancy 里第二个落点是完整声明式体内那格字段（prop_autoget.rst:34），而那种写法整个不收，
//      所以剩下的只能是写错地方，丢掉那个词会让它静默变成一格普通的模块级变量；属性上的复合
//      赋值 `p += 1` —— jancy 那边是先读再写，这一层的赋值只有一句；给 const 属性赋值 ——
//      jancy 自己也拒，prop.rst:17；autoget 与索引一起写 —— 同样是 jancy 自己也拒，
//      prop_autoget.rst:47），
//      构造的**重载**（要重载决议），
//      格式化字面量里的 `$!`（要标准库那一格错误对象）与"再喂给 printf 的那一个裸 `%`"
//      （要运行期的格式解释）、混着拼的字面量（`"a" $"b"`）、二进制字面量 `0x"61 62"` 与
//      `__FILE__` 那族预定义宏（前者要字节宽度、后者要编译期环境）、
//      没写初值的函数指针（方言的函数值那一格没有空值）、函数指针的**字段**（方言的结构体
//      字段放不下函数值 —— 第五十七刀的虚派发因此没走"对象里一格函数指针"，走的是一格整数
//      标签加一段按标签分派的函数）、`function**`、`~()` 的部分应用、
//      一个字段都没有的 struct（卡在方言那一侧：`(struct S )` 要方言认零个字段）、
//      errorcode 那一族剩下的三格（`finally:` —— 不管走哪条路都要跑一遍，连 `return` 也得先
//      绕过去，要的是一张路由表而不是 `catch:` 那一格 bool；传播插不进去的两个位置 ——
//      `&&` / `||` 的右边与表达式位置上 `? :` 的两支是惰性的、循环的条件每圈重求一次，要它们
//      得先能给一条表达式里的每一格切出自己的块；errorcode 的函数当函数指针用 —— 那一位在
//      jancy 那边挂在函数**类型**上，这一层的 fnty 还没有它，从指针调就检不着了），
//      找不着的 `import`（两条：一个目录都没给的、给了 `-I` 还找不着的。jancy 那边都是硬错，
//      这一层记成"还不收" —— 它在翻文件系统之前先翻扩展库里嵌着的源码表，我们没有那张表，
//      所以分不出是名字写错了还是这个名字本来就该从扩展库里拿），
//      加十三条 jancy 自己也拒的（命名项之后不能再写
//      位置项、`double` 上的 `&=`、int 到枚举的隐式转换、非 0 的 int 到 bitflag 枚举、
//      `countof` 作用在指针上、`assert` 的第二个实参不是字面量、给类的变量赋值、隐式下转、
//      造一格还留着 abstract 方法的类、`override` 却没有可覆盖的虚方法、
//      `void errorcode`（void 那一行没有 ErrorCode 那一位，所以定不出出错值）、
//      一个块里两个 `catch:`、两个 `main`）。（`? :`、不换行的 printf、条件真值化曾经在
//      这一组里，第三到第五刀把它们做掉之后转到了 cases/；`&x` 是第九刀、定长数组是第十刀、
//      模块级变量是第十一刀、值语义的结构体是第十二刀、结构体按值传与按值回是第十三刀、
//      花括号初值是第十四刀、不看顺序的名字是第十五刀、指针的地址是第十六刀，现在各在
//      cases/09-addr.jnc、cases/10-arrays.jnc、cases/11-globals.jnc、cases/12-structs.jnc、
//      cases/13-struct-args.jnc、cases/14-curly.jnc、cases/15-forward.jnc、
//      cases/16-ptrptr.jnc；`new T { … }` 是第二十五刀、`static` 的局部量是第二十六刀、
//      整数与 `%s` 上的精度加 `%*d` 是第二十七刀、`%.*f` 是第二十八刀、`+` / 空格 / `#`
//      三个标志是第二十九刀、`%e` / `%E` 是第三十刀、`%g` / `%G` 是第三十一刀、`%u` 是
//      第三十二刀、无符号的 8 / 16 / 32 位是第三十三刀、字面量的进制是第三十四刀、
//      位运算与移位的复合赋值是第三十五刀、`switch` 是第三十六刀、bool 参与整数运算是
//      第三十七刀、`typedef` 是第三十八刀、`enum` 是第三十九刀、`break2` / `continue2` 与
//      switch 里的 continue 是第四十一刀（方言的层号是第四十刀）、带步进的 for 里的 continue
//      是第四十二刀、printf 的长度修饰是第四十四刀、`countof` 是第四十五刀、指针比大小是
//      第四十六刀、`bitflag enum` 是第四十七刀、编译期整数求值是第四十八刀、`assert` 是
//      第四十九刀、int 到枚举的显式转换是第五十刀、`namespace` 是第五十一刀、`class` 是
//      第五十二刀、`construct` 与 `static construct` 是第五十三刀、相邻字面量的拼接是
//      第五十四刀、函数指针（`function*` / `function thin*`）是第五十五刀、单继承是
//      第五十六刀、虚派发（`virtual` / `override` / `abstract`）是第五十七刀、
//      errorcode 那一套（自动传播与 `try`）是第五十八刀、`try { … }` 与 `catch:` 是
//      第五十九刀、`import "x.jnc"` 是第六十刀、64 位的无符号整数是第六十一刀、
//      `-I` 给的 import 目录表是第六十二刀、构造函数体里免分号的 `X.construct(…)` 是
//      第六十三刀、格式化字面量 `$"…"` 是第六十四刀、`opaque class` 是第六十六刀、
//      可变性那一族（`readonly` / `cmut`）与访问控制的 Java 式写法（`public` / `protected`）
//      是第六十七刀、属性（顶层那一格：`T property p` 加体外的 `p.get()` / `p.set()`）
//      是第六十八刀、类的成员属性（`obj.p` 的读写与方法体里裸写属性名补 `this`）是
//      第六十九刀、索引属性（`T property p(下标…)`，读写是 `p[i]`）是第七十刀、
//      `autoget` 属性（取值器不用写，编译器生成的那一格叫 `m_value`）是第七十一刀、
//      类型是指针的属性（`T* property p` —— 那个词写在星号**后面**）是第七十二刀，在
//      cases/24-new-curly.jnc、
//      cases/25-static-local.jnc、cases/26-printf-prec.jnc、cases/27-printf-star-prec.jnc、
//      cases/28-printf-flags.jnc、cases/29-printf-sci.jnc、cases/30-printf-gen.jnc、
//      cases/31-printf-u.jnc、cases/32-unsigned.jnc、cases/33-radix.jnc、
//      cases/34-bitassign.jnc、cases/35-switch.jnc、cases/36-bool-int.jnc、
//      cases/37-typedef.jnc、cases/38-enum.jnc、cases/39-breakn.jnc、cases/40-forcont.jnc、
//      cases/41-printf-len.jnc、cases/42-countof.jnc、cases/43-ptrcmp.jnc、
//      cases/44-bitflag.jnc、cases/45-constfold.jnc、cases/46-assert.jnc、
//      cases/47-enumcast.jnc、cases/48-namespace.jnc、cases/49-class.jnc、
//      cases/50-construct.jnc、cases/51-litcat.jnc、cases/52-fnptr.jnc、
//      cases/53-inherit.jnc、cases/54-virtual.jnc、cases/55-errorcode.jnc、
//      cases/56-catch.jnc、cases/57-import.jnc、cases/58-uint64.jnc、
//      cases/59-incdir.jnc、cases/60-btm-ctor.jnc、cases/61-fmtlit.jnc、
//      cases/62-opaque.jnc、cases/63-dualmod.jnc、cases/64-prop.jnc、
//      cases/65-propmem.jnc、cases/66-propidx.jnc、cases/67-propauto.jnc、
//      cases/68-propptr.jnc。cases/imports/
//      底下那三份是 57 那一条 import 进来的、cases/incdirs/ 底下那六份是 59 那一条按 `-I`
//      找到的，**都不是**独立的用例 —— 这一层只扫 cases/ 这一级的 `.jnc`。）
//
//      mods/ 里现在两份：lib1.jnc（第六十五刀 —— 没有入口的库模块）、lib2.jnc（第六十六刀
//      —— 语料里 `opaque class` 的真形状：一份只有声明的 API 文件）。
//
//      bad/ 里有**四种**拒，别混：一种是"还没长出来"（做掉就落地）；一种是**这一层不做**
//      （printf-conv-p：`%p` 要观测裸地址，而五条腿上那不是同一个数；ptrcmp-mixed：不同型的
//      两个指针 jancy 那边其实过得去 —— 它自己的 TODO 记着这个检查没做 —— 而这一层降级用的
//      是按元素算差的 `psub`，元素不一样大时"差几个元素"没有意义）；
//      （`import "….jncx"` 先前也在这一组里，第二百一十刀退了：那一句在 jancy 里只装那个
//      编译好的库、**声明不在它里头**，所以这一层什么都不缺 —— 它现在只是一句提醒，
//      正面判据在 cases/164-importjncx.jnc）；
//      一种是**C 自己的
//      未定义行为**（printf-plus-hex 的 `%+x`、printf-alt-u 的 `%#u`、bitflag-neg 的
//      `bitflag enum { A = -1 }` —— jancy 算下一格的那句 `2 << getHiBitIdx64(-1)` 在 C++ 里
//      是移位越界、const-shift-wide 的 `1 << 64` —— C99 6.5.7p3；四条都没有可对的答案）；
//      一种是**jancy 自己也拒**（enum-from-int 的 int 到枚举、bitflag-from-int 的非 0 int 到
//      bitflag 枚举、curly-after-named、bitassign-real、countof-ptr、assert-msg-expr 的
//      `assert(C, 一个表达式)`、class-var-assign 的 `a = b`（两边都是类的**变量** ——
//      type_class.rst:19 那句 "You cannot assign varibles or fields of class types"）、
//      import-main-twice 的两个 `main`（import 进来的条目与本地的是平权的一堆，所以"入口
//      只能有一个"自然管到跨文件））
//      —— 这几条落地了也还是拒，
//      只是理由要对得上 jancy 的那一句）。
//
//   node tests/jnc/run.js
//   node tests/jnc/run.js pointers

import { readdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { workDir } from '../work.js';
import { RunCache } from '../lib/incr.js';
import { pickLegs, legNote } from '../lib/legs.js';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

/* 增量层（tests/lib/incr.js）：一条用例六条腿、一条腿一次子进程，而输入常常一个字没变。
 * 键是「命令行 + 实参里那几份文件的内容 + 上一趟装载过的那些模块」，所以：改 frontend-jnc
 * 只让 jnc 这些用例失效，只加一份固件时别的用例全命中。`FORCE=1` 全部重跑。
 *
 * `extra` 是"命令行上看不见但也算输入"的那几格：`cases/imports/` 是 57 那条 `import` 进来的、
 * `cases/incdirs/` 是 59 那条按 `-I` 找的 —— 它们是**数据**不是模块，钩子收不到，所以明写。 */
const cache = new RunCache('jnc');
const extraInputs = [join(here, 'cases', 'imports'), join(here, 'cases', 'incdirs')]
  .filter((p) => existsSync(p));
const cmd = (args) => cache.run([cli, ...args], { cwd: root, extra: extraInputs });
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

let pass = 0;
let fail = 0;
let xfail = 0;
const xfails = [];
const failures = [];
/* 每个例子的耗时都要看得见（否则"这条轴 60s"这句话没法往下问）。
   `ok`/`no` 都从 `mark()` 拿这一格的墙上时间，末尾再印总耗时与最慢的几个。 */
const t0all = Date.now();
let tCase = Date.now();
const times = [];
const mark = (name) => {
  const ms = Date.now() - tCase;
  tCase = Date.now();
  times.push({ name, ms });
  return ms;
};
const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;
const ok = (msg, name) => {
  pass++;
  const ms = mark(name ?? msg);
  process.stdout.write(`  ok   ${msg}  ${secs(ms)}\n`);
};
const no = (name, why) => {
  fail++;
  const ms = mark(name);
  failures.push(`${name}\n${why}`);
  process.stdout.write(`  FAIL ${name}  ${secs(ms)}\n`);
};
/**
 * **旧降级那条边界，规则那条路上还没重画**（第二百五十八刀）。
 *
 * `bad/` 那 140 份是**照旧降级**画出来的墙：它一句一句写着"这一族还不收，理由是…"。
 * 默认那一格翻到规则那条路之后，这些墙有三种下场：
 *   1. 规则那条路照旧拦、话也一样 —— 照旧 `ok`；
 *   2. 规则那条路**已经收下了**这一族（位域的类、`threadlocal`、枚举… 它比旧那条多）——
 *      那这份文件不再是"墙"，该升进 `cases/` 带上 `.expected`；在升之前记成 `xfail`；
 *   3. 规则那条路拦了，可说的是它自己那句账 —— 话要重画；在重画之前记成 `xfail`。
 *
 * `xfail` **不算通过、也不算失败**，末尾单独报一行数。名单在 `bad/xfail.txt`（一行一个名字，
 * `#` 后头是理由）。这样"还差多少"是一份**看得见、会缩短**的清单，而不是一片红或者一片假绿。
 */
const xf = (name, why) => {
  xfail++;
  const ms = mark(name);
  xfails.push(`${name}: ${why}`);
  process.stdout.write(`  xfail ${name}  ${secs(ms)}\n`);
};
const want = (f) => (!filters.length || filters.some((x) => f.includes(x)));

const ALL_LEGS = [
  /* `run` 这一格**明着点后端**：它就是 js 那条腿（生成 JS 在本进程里跑），从前是
   * `omni run` 的默认。默认要改成 c 了 —— 不写出来这一格就与下一格重了。 */
  { tag: 'run', args: (p) => ['run', p, '--backend', 'js'] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

/* 第六条腿：ORC JIT（ADR-0022 的 J1）。它与 `run-llvm` 读**同一份 IR**，换的只是装载方式 ——
   而 jancy 自己的执行路径就是这一条（它没有 AOT，`jnc` 是 JIT 跑的）。所以这门语言的用例
   尤其该在它上面钉住：量出来 69 份里 68 份本来就对，第 69 份差的是 `-I` 没透过去。
   这台机器上没有 libLLVM 时**跳过而不是算失败**（与 tests/jit 同一条规矩）：那时"JIT 这条腿"
   根本无从验证，谎报成功更糟。探一次就够，探针用最小的那份用例。 */
const JIT_LEG = { tag: 'run-jit', args: (p) => ['run-jit', p] };
{
  const probe = cmd(JIT_LEG.args(join(here, 'cases', '01-pointers.jnc')));
  if (probe.code === 0) ALL_LEGS.push(JIT_LEG);
  else process.stdout.write(`  skip run-jit 这条腿：${(probe.err.trim().split('\n')[0] ?? '?')}\n`);
}

/**
 * 平时跑哪几条：开关在 tests/lib/legs.js（`OMNI_LEGS=all` 跑齐全部，提交前那一遍用它），
 * 但**留哪几条是这门语言自己的事**。
 *
 * 这条轴留 `run-jit` 与 `run`：
 *   - `run-jit` 是**jancy 的原生执行路径** —— 它没有 AOT，真的 `jnc` 就是 ORC JIT 跑的
 *     （ADR-0022 的 J1）。这门语言最要紧的那条腿是它，不是别的轴上那条 `run-llvm`。
 *     没有 libLLVM 的机器上它探不着，那时这一趟就退到剩下的那条（不谎报）。
 *   - `run` 是最快的基准，而且它的指针是 **arena 模拟**、JIT 那边是**真指针**
 *     （ADR-0016）—— 上面那句"多方一致比对上期望值更强"靠的就是这两套实现逐字节相同。
 *
 * 这笔钱是量过的：一趟冷跑 578 次子进程 38.9s，按腿分的真跑耗时 interp 35.1s、run 34.7s、
 * run-c 30.1s、run-llvm 27.3s、run-jit 24.8s、sx 0.2s（合 152s CPU / 8 核 ≈ 38s 墙上时间）。
 * 每条腿都是等价的一份钱，砍到两条就是 ~14s。中间那三条（run-c / interp / interp --mir）
 * 盯的是"腿与腿分叉"，那是 tests/sexpr 与 tests/oir 的活。
 */
const LEGS = pickLegs(ALL_LEGS, ['run-jit', 'run']);

const list = (sub, ext) => readdirSync(join(here, sub)).filter((x) => x.endsWith(ext)).sort();

/**
 * 一条 case 可以带一份 `NN.args`（第六十二刀）：里面按空白切开的每一格都追加到命令行后面，
 * 相对路径按 tests/jnc 这一级解。现在只有 `-I` 用它 —— 那个开关是命令行上的东西，
 * 不写在源码里，所以没有别的地方能钉住它。
 */
const extraArgs = (sub, name) => {
  const t = read(join(here, sub, `${name}.args`));
  if (t === null) return [];
  return t.split(/\s+/).filter((x) => x.length !== 0)
    .map((x) => (x.startsWith('-') ? x : join(here, x)));
};

// ------------------------------------------------- 0. 预热：把要跑的子进程并行跑掉
//
// ADR-0023 的 S4。下面三遍判定是顺序的（一条用例先跑第一条腿、再拿别的腿去比），改成并行要动
// 整条轴的骨架；而贵的只是**子进程**那一步 —— 所以先把这一趟要跑的命令列出来、并行跑掉，
// 顺序那三遍照旧走，只是每一次都命中缓存。并行度看 `JOBS`（默认 4，理由在 incr.js 的 warm 里）。

{
  const pre = [];
  for (const f of list('cases', '.jnc')) {
    if (!want(f)) continue;
    const xargs = extraArgs('cases', basename(f, '.jnc'));
    for (const leg of LEGS) pre.push([cli, ...leg.args(join(here, 'cases', f)), ...xargs]);
  }
  for (const f of list('rt', '.jnc')) {
    if (!want(f)) continue;
    for (const leg of LEGS) pre.push([cli, ...leg.args(join(here, 'rt', f))]);
  }
  for (const f of list('bad', '.jnc')) {
    if (!want(f)) continue;
    pre.push([cli, 'run', join(here, 'bad', f), ...extraArgs('bad', basename(f, '.jnc'))]);
  }
  const tWarm = Date.now();
  await cache.warm(pre, { cwd: root, extra: extraInputs });
  /* 预热那一格自己报时间。不报的话它会被算到**第一个例子**头上（量出来过：
     `cases/01-pointers 37.39s`，而那一格其实是整趟预热）。报完把计时归零。 */
  if ((cache.warmed ?? 0) > 0) {
    const jobs = process.env.JOBS ?? '默认';
    process.stdout.write(`  --   预热 ${cache.warmed} 次子进程（并行 ${jobs}）`
      + ` ${((Date.now() - tWarm) / 1000).toFixed(1)}s\n`);
  }
  tCase = Date.now();
}

// ------------------------------------------------- 1. cases/：几条腿一致 + 对上期望值

for (const f of list('cases', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const src = join(here, 'cases', f);
  const expected = read(join(here, 'cases', `${name}.expected`));
  const bad = [];
  const xargs = extraArgs('cases', name);
  const first = cmd([...LEGS[0].args(src), ...xargs]);
  if (first.code !== 0) bad.push(`    ${LEGS[0].tag} exit=${first.code}\n${first.err}`);
  for (const leg of LEGS.slice(1)) {
    const r = cmd([...leg.args(src), ...xargs]);
    if (r.code !== 0) { bad.push(`    ${leg.tag} exit=${r.code}\n${r.err}`); continue; }
    if (r.out !== first.out) {
      bad.push(`    ${leg.tag} 与 ${LEGS[0].tag} 不同\n      ${LEGS[0].tag}: ${JSON.stringify(first.out)}\n      ${leg.tag}: ${JSON.stringify(r.out)}`);
    }
  }
  if (expected === null) bad.push('    缺 .expected');
  else if (first.out !== expected) {
    bad.push(`    对不上期望值\n      want: ${JSON.stringify(expected)}\n      got:  ${JSON.stringify(first.out)}`);
  }
  if (bad.length === 0) ok(`cases/${name} [${LEGS.length} 腿一致 == ${name}.expected]`);
  else no(`cases/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 2. rt/：运行期错误，每条腿同一句话

for (const f of list('rt', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const exp = read(join(here, 'rt', `${name}.expected`));
  if (exp === null) { no(`rt/${name}`, `    缺 ${name}.expected`); continue; }
  const bad = [];
  for (const leg of LEGS) {
    const r = cmd(leg.args(join(here, 'rt', f)));
    if (r.code === 0) { bad.push(`    ${leg.tag} 居然跑完了 —— 这里该报运行期错误`); continue; }
    if (!r.err.includes(exp.trim())) {
      bad.push(`    ${leg.tag} 的消息不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
    }
  }
  if (bad.length === 0) ok(`rt/${name} [${LEGS.length} 腿同一句：${exp.trim()}]`);
  else no(`rt/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 3. bad/：拒绝，且理由正确
//
// 一条腿就问得清（这些都是降级期拒的），所以只跑 `run`。
//
// 名单在 `bad/xfail.txt` 的那几份记成 `xfail`（不算通过、也不算失败）—— 那是"旧降级画的墙，
// 规则那条路上还没重画"的清单，理由见上面 `xf` 那一段。

const XFAIL = (() => {
  const t = read(join(here, 'bad', 'xfail.txt'));
  const m = new Map();
  if (t === null) return m;
  for (const line of t.split('\n')) {
    const s = line.trim();
    if (s === '' || s.startsWith('#')) continue;
    const i = s.indexOf('#');
    m.set(i < 0 ? s : s.slice(0, i).trim(), i < 0 ? '（没写理由）' : s.slice(i + 1).trim());
  }
  return m;
})();

for (const f of list('bad', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const exp = read(join(here, 'bad', `${name}.expected`));
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  const r = cmd(['run', join(here, 'bad', f), ...extraArgs('bad', name)]);
  const good = r.code !== 0 && r.err.includes(exp.trim());
  if (!good && XFAIL.has(name)) { xf(`bad/${name}`, XFAIL.get(name)); continue; }
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(exp.trim())) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
    continue;
  }
  /* 名单里的那几份**已经对上了** —— 那就该从名单里删掉（名单只许缩短，不许躺着）。 */
  if (XFAIL.has(name)) {
    no(`bad/${name}`, '    这一份已经拦对了 —— 把它从 bad/xfail.txt 里删掉');
    continue;
  }
  ok(`bad/${name} [拒绝：${exp.trim()}]`);
}

// ------------------------------------------------- 4. mods/：没有入口的库模块，只问"降得下来"
//
// 语料 662 份里 408 份没有 `int main()`（第六十五刀）。它们是库模块，本来就不该有入口 ——
// `omni sx` 要降得下来。两步都问：先 `sx` 退出码 0，再把降出来的那份 `.sx` 交给 `run` 跑一遍
// （模块级初值那段序幕就是它的全部），于是"降出来的方言文本本身是合法的"也被钉住了 ——
// 只看文本非空的话，降成一堆废话也能过。

const mods = list('mods', '.jnc');
const tmp = mods.length === 0 ? null : workDir('jnc-mods');
for (const f of mods) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const r = cmd(['sx', join(here, 'mods', f), ...extraArgs('mods', name)]);
  if (r.code !== 0) { no(`mods/${name}`, `    sx exit=${r.code}\n${r.err}`); continue; }
  if (!r.out.includes('(module')) { no(`mods/${name}`, `    降出来的不是一个模块：${JSON.stringify(r.out.slice(0, 60))}`); continue; }
  const sxPath = join(tmp, `${name}.sx`);
  writeFileSync(sxPath, r.out);
  const rr = cmd(['run', sxPath]);
  if (rr.code !== 0) { no(`mods/${name}`, `    降出来的 .sx 跑不动 exit=${rr.code}\n${rr.err}`); continue; }
  ok(`mods/${name} [没有入口也降得下来，降出来的 .sx 跑得动]`);
}

/* 总耗时 + 最慢的几个例子 + 最贵的几条子进程命令。慢下来的时候先看这两张榜：
   它们直接说出钱花在哪儿，不必再"为了看清楚"重跑一遍（ADR-0023 那条规矩）。
   例子名掐到方括号之前 —— 后面那一串"几腿一致"每条都一样，没有信息量。 */
const short = (s) => (s.includes(' [') ? s.slice(0, s.indexOf(' [')) : s);
const slow = [...times].sort((a, b) => b.ms - a.ms).slice(0, 8).filter((x) => x.ms >= 200);
process.stdout.write(`\n${pass} passed, ${fail} failed`
  + `${xfail === 0 ? '' : `, ${xfail} xfail（旧降级画的墙，规则那条路还没重画 —— bad/xfail.txt）`}`
  + `  [${cache.report()}]`
  + `${legNote(LEGS) === '' ? '' : `  ${legNote(LEGS)}`}`
  + `  总 ${((Date.now() - t0all) / 1000).toFixed(1)}s\n`);
if (slow.length > 0) {
  process.stdout.write(`  最慢的例子：${slow.map((x) => `${short(x.name)} ${secs(x.ms)}`).join('、')}\n`);
}
const hot = cache.slowest();
if (hot !== '') process.stdout.write(`  最贵的子进程：${hot}\n`);
const per = cache.byCmd();
if (per !== '') process.stdout.write(`  按腿分的真跑耗时：${per}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
