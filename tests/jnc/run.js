#!/usr/bin/env node
// Omni — jancy 前端（第十五条测试轴，ADR-0016 分步 8 的验收）
//
// 这条轴与 tests/asy 那条是**两条不同的纪律**。asy 那边有 oracle（`/opt/homebrew/bin/asy
// -noV`），所以每一条都要"量"；jancy 的 `jnc` 要 LLVM + axl 才编得出来，我们不装它 ——
// 用户定的是「只借用 jancy 的完整语法和形式」。所以这边每一条期望输出都由我们自己写，
// 而**每一条都要在源文件的注释里注明出处**（引哪一份文档、哪一条 `.llk` 规则、哪一份语料）。
//
// 语法那一半不在这里：`stage0/src/frontend-jnc/jnc.grammar` 在 tests/glr/run.js 的
// `cases/jnc` 那一组里量（526/528 份真实 `.jnc` 唯一成树）。这里量的是**降级**。
//
// 四件事：
//   1. cases/*.jnc 在 run / run-c / interp / interp --mir / run-llvm 五条腿上逐字节相同，
//      且等于 .expected。五方一致比对上期望值更强 —— 指针在这五条腿上是**两套实现**
//      （arena 模拟 vs 真指针，ADR-0016），逐字节相同不是巧合。
//   2. rt/*.jnc 在五条腿上报**同一句**运行期错误。
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
//      属性那一族剩下的七格（结构体的成员属性 —— 取/存那两个体要从"类那一层命名空间"里
//      查过来，结构体在这一层不是；`virtual` 写在属性上 —— 这一层的虚派发按方法名接，属性
//      那两个函数的名字是自己拼的；属性当一格**可写的内存**用（`b.p++` / `&b.p`）—— 读写各是
//      一次调用，"就地改"接不上，而报"没有这个字段"是认错了人；属性指针（`int property* p`）
//      —— 那一格里存的是"取/存两个函数 + 那个对象"，与函数指针两码事，而 `property` 这个词
//      specs 是收下的，不拦就会被悄悄降成一格普通指针；完整声明式 `property p { … }` ——
//      那对花括号开的是一层命名空间（prop_full.rst:15），落到 specs 那儿报的是"这条声明没有
//      类型"，也是认错了人；属性上的复合赋值 `p += 1` —— jancy 那边是先读再写，这一层的赋值
//      只有一句；给 const 属性赋值 —— jancy 自己也拒，prop.rst:17），
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
//      第六十九刀、索引属性（`T property p(下标…)`，读写是 `p[i]`）是第七十刀，在
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
//      cases/65-propmem.jnc、cases/66-propidx.jnc。cases/imports/
//      底下那三份是 57 那一条 import 进来的、cases/incdirs/ 底下那六份是 59 那一条按 `-I`
//      找到的，**都不是**独立的用例 —— 这一层只扫 cases/ 这一级的 `.jnc`。）
//
//      mods/ 里现在两份：lib1.jnc（第六十五刀 —— 没有入口的库模块）、lib2.jnc（第六十六刀
//      —— 语料里 `opaque class` 的真形状：一份只有声明的 API 文件）。
//
//      bad/ 里有**四种**拒，别混：一种是"还没长出来"（做掉就落地）；一种是**这一层不做**
//      （printf-conv-p：`%p` 要观测裸地址，而五条腿上那不是同一个数；ptrcmp-mixed：不同型的
//      两个指针 jancy 那边其实过得去 —— 它自己的 TODO 记着这个检查没做 —— 而这一层降级用的
//      是按元素算差的 `psub`，元素不一样大时"差几个元素"没有意义；import-jncx：`.jncx` 是
//      C++ 扩展库编出来的**构建产物**，整棵参考树里一个都没有，没有源码可降）；
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

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const cmd = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
};
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const want = (f) => (!filters.length || filters.some((x) => f.includes(x)));

const LEGS = [
  { tag: 'run', args: (p) => ['run', p] },
  { tag: 'run-c', args: (p) => ['run-c', p] },
  { tag: 'interp', args: (p) => ['interp', p] },
  { tag: 'interp --mir', args: (p) => ['interp', p, '--mir'] },
  { tag: 'run-llvm', args: (p) => ['run-llvm', p] },
];

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

// ------------------------------------------------- 1. cases/：五条腿一致 + 对上期望值

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
  if (bad.length === 0) ok(`cases/${name} [五方一致 == ${name}.expected]`);
  else no(`cases/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 2. rt/：运行期错误，五条腿同一句话

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
  if (bad.length === 0) ok(`rt/${name} [五条腿同一句：${exp.trim()}]`);
  else no(`rt/${name}`, bad.join('\n'));
}

// ------------------------------------------------- 3. bad/：拒绝，且理由正确
//
// 一条腿就问得清（这些都是降级期拒的），所以只跑 `run`。

for (const f of list('bad', '.jnc')) {
  if (!want(f)) continue;
  const name = basename(f, '.jnc');
  const exp = read(join(here, 'bad', `${name}.expected`));
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  const r = cmd(['run', join(here, 'bad', f), ...extraArgs('bad', name)]);
  if (r.code === 0) { no(`bad/${name}`, '    居然通过了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(exp.trim())) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.trim())}`);
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
const tmp = mods.length === 0 ? null : mkdtempSync(join(tmpdir(), 'omni-jnc-mods-'));
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

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
