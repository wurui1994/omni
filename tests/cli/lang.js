#!/usr/bin/env node
/* `#lang <名字>`（ADR-0037 的事情一）：**读入器可换**，默认关着。
 *
 * 判的是四件事，每一件都是"话说清了没有"而不是"数字对不对"：
 *   一、**关着的时候要报**，而且要说清怎么开、装着哪些读入器 —— 静默当注释是最坏的一种
 *       （同 `--profile` 认腿那条纪律：收下开关一声不响，人会以为生效了）。
 *   二、开着的时候**真的换读入器**：一份 `.omni` 里躺 s-expr，跑出来是 s-expr 那门的答案。
 *   三、三处（`#lang` 行 / `--lang` / 后缀）说得不一样时**报"各说了什么"**，不许默默择一。
 *   四、**中性**：不带那一行的文件，一个字节都不受影响。
 *
 *   node tests/cli/lang.js
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const WORK = join(ROOT, '.omni-cache', 'work', 'cli-lang');
mkdirSync(WORK, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };

const omni = (args, envAdd) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 120000, maxBuffer: 8 << 20,
  env: envAdd === undefined ? process.env : { ...process.env, ...envAdd },
});
const both = (r) => `${r.stdout || ''}${r.stderr || ''}`;

/** 一份写好的样本文件（名字带用途，留在工作目录里方便照着跑一遍） */
const sample = (name, text) => {
  const p = join(WORK, name);
  writeFileSync(p, text);
  return p;
};

/* s-expr 那门语言的一小段：`(fn …)` + `(main …)`，形状照 tests/gpu/cases/01-bump.sx。
   放在 **.omni** 里 —— 这一格判的正是"后缀说 omni、`#lang` 说 sx，听谁的"。 */
const SX = '#lang sx\n(module\n  (fn sq ((x int)) int (ret (bin "*" (var x) (var x))))\n'
  + '  (main\n    (print (call sq (int 7)))))\n';
const sxFile = sample('sx-in-omni.omni', SX);

/* ---- 一、默认关着：要报，而且要说清怎么开 */{
  const r = omni(['run', sxFile]);
  const s = both(r);
  if (r.status !== 0 && s.includes('默认关着') && s.includes('--lang-directive')
    && s.includes('OMNI_LANG_DIRECTIVE=1') && s.includes('装着的读入器')) {
    ok('#lang 默认关着：当场报 + 两处开法 + 装着的读入器都印了');
  } else bad('#lang 关着该报', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* ---- 二、开着就真的换读入器（两处开关各判一遍） */{
  const r = omni(['run', sxFile, '--lang-directive']);
  const s = both(r);
  if (r.status === 0 && (r.stdout || '').trim() === '49') {
    ok('--lang-directive：一份 .omni 按 #lang sx 交给 s-expr 那门读（49）');
  } else bad('#lang sx 该换读入器', `rc=${r.status} ${s.slice(-300)}`);
}
{
  const r = omni(['run', sxFile], { OMNI_LANG_DIRECTIVE: '1' });
  if (r.status === 0 && (r.stdout || '').trim() === '49') {
    ok('OMNI_LANG_DIRECTIVE=1：环境那一格等价（给子进程继承用）');
  } else bad('环境那一格该等价', `rc=${r.status} ${both(r).slice(-300)}`);
}

/* ---- `#lang omni` 是核心方言那一支：它不在语言注册表里，得单列一格 */{
  const p = sample('core.omni', '#lang omni\nprint(6 * 7);\n');
  const r = omni(['run', p, '--lang-directive']);
  if (r.status === 0 && (r.stdout || '').trim() === '42') {
    ok('#lang omni：核心方言那一支（词法把那一行整行跳过）');
  } else bad('#lang omni 该走核心方言', `rc=${r.status} ${both(r).slice(-300)}`);
}
{
  /* shebang 与 `#lang` **两行都要跳**（`#!/usr/bin/env omni` 那种脚本形状）。 */
  const p = sample('shebang.omni', '#!/usr/bin/env omni\n#lang omni\nprint(1 + 1);\n');
  const r = omni(['run', p, '--lang-directive']);
  if (r.status === 0 && (r.stdout || '').trim() === '2') {
    ok('shebang + #lang 两行都跳过（脚本形状也认）');
  } else bad('shebang + #lang', `rc=${r.status} ${both(r).slice(-300)}`);
}

/* ---- 三、三处说得不一样：报"各说了什么"，不许默默择一 */{
  const r = omni(['run', sxFile, '--lang-directive', '--lang', 'jnc']);
  const s = both(r);
  if (r.status !== 0 && s.includes('不是同一个') && s.includes('#lang 行 说 sx')
    && s.includes('--lang 说 jnc')) {
    ok('#lang 与 --lang 打架：报出两处各说了什么（不择一）');
  } else bad('冲突该报两处', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  const p = sample('nope.omni', '#lang python\n');
  const r = omni(['run', p, '--lang-directive']);
  const s = both(r);
  if (r.status !== 0 && s.includes("没有 'python' 这台读入器") && s.includes('装着的是')) {
    ok('#lang 写了没装的那门：报 + 印出装着的是哪些');
  } else bad('没装的读入器该报', `rc=${r.status} ${s.slice(0, 300)}`);
}

/* ---- 四、中性：不带那一行的文件一个字节都不受影响
 *
 * 这一格判的是词法与 s-expr 读入器那两处新加的"跳第一行"——它们只在**真有**那一行时动。
 * 拿 bench/fib.omni（普通 `.omni`，没有指令）跑一趟，两个数照旧。 */{
  const r = omni(['run', join(ROOT, 'bench', 'fib.omni')]);
  const out = (r.stdout || '').trim().split('\n');
  if (r.status === 0 && out[0] === '196418' && out[1] === '999794999321') {
    ok('中性：没有 #lang 那一行的文件照旧（196418 / 999794999321）');
  } else bad('不带指令的文件该照旧', `rc=${r.status} ${both(r).slice(-300)}`);
}

/* ---- 五、卫生模板（ADR-0037 的事情一下半，**照 Nim 那两趟**）
 *
 * 判的是三条性质，每一条都能一句话说清"错了会怎样"：
 *   1. 体里的局部不许捕获调用处的同名变量（Nim：locals default to gensym）
 *   2. 体里引用的**模块级变量**不许被调用处的同名局部遮住 —— 这一条就是 Nim 那句
 *      "自由名字在定义处解析成 nkSym"在这门方言里的样子（运算符是字符串，所以捕获只可能
 *      发生在变量上）。gensym-only 的实现**过不了这一条**。
 *   3. 两个洞都是调用处的名字时一个都不许换（经典 swap!）
 * 一份文件三条一起跑，输出对上就三条都成立。 */
const TPL = '(module\n'
  + '  (global counter int)\n'
  + '  (define-template dbl (x)\n'
  + '    (do (let t int (var x)) (print (bin "+" (var t) (var t)))))\n'
  /* 体里写的是普通的 `(var counter)` / `(set counter …)` —— 定义期那一趟自己把它们绑到
     模块级那一格上（改写成 `(gvar …)` / `(gset …)`）。这一格判的正是那一趟。 */
  + '  (define-template bump ()\n'
  + '    (do (set counter (bin "+" (var counter) (int 1))) (print (var counter))))\n'
  + '  (define-template swap! (a b)\n'
  + '    (do (let t int (var a)) (set a (var b)) (set b (var t))))\n'
  + '  (main\n'
  + '    (let t int (int 5))\n'
  + '    (dbl (var t))\n'
  + '    (print (var t))\n'
  + '    (let counter int (int 100))\n'
  + '    (bump)\n'
  + '    (print (var counter))\n'
  + '    (let p int (int 1))\n'
  + '    (let q int (int 2))\n'
  + '    (swap! (var p) (var q))\n'
  + '    (print (var p))\n'
  + '    (print (var q))))\n';
const tplFile = sample('hygiene.sx', TPL);
{
  const r = omni(['run', tplFile, '--lang-directive']);
  const out = (r.stdout || '').trim().split('\n');
  const want = ['10', '5', '1', '100', '2', '1'];
  if (r.status === 0 && out.join(',') === want.join(',')) {
    ok('卫生三条一起过：局部不捕获（10 / 5）、模块级变量不被遮（1 / 100）、swap!（2 / 1）');
  } else bad('卫生三条', `rc=${r.status} 出来的是 ${out.join(',')}\n    ${both(r).slice(-300)}`);
}
{
  const r = omni(['run', tplFile]);
  const s = both(r);
  if (r.status !== 0 && s.includes('默认关着') && s.includes('--lang-directive')) {
    ok('(define-template …) 与 #lang 同一格开关：关着时当场报 + 给开法');
  } else bad('模板该跟 #lang 同一格开关', `rc=${r.status} ${s.slice(0, 300)}`);
}
{
  /* 同一个模板展开两次，两次的局部名**必须不同**（Nim 的 `instID`：一次展开一个号）。
     一样的话两次展开的临时量会互相盖 —— 那是"卫生"没做到的另一种。 */
  const p = sample('twice.sx', '(module\n'
    + '  (define-template dbl (x) (do (let t int (var x)) (print (bin "+" (var t) (var t)))))\n'
    + '  (main (dbl (int 3)) (dbl (int 4))))\n');
  const run = omni(['run', p, '--lang-directive']);
  const js = omni(['emit', 'js', p, '--lang-directive']);
  const names = [...new Set(((js.stdout || '').match(/t_gensym[0-9]+/g) ?? []))];
  if (run.status === 0 && (run.stdout || '').trim() === '6\n8' && names.length === 2) {
    ok(`展开两次两个号：${names.join(' / ')}（6 / 8 也对）`);
  } else bad('两次展开该是两个号', `rc=${run.status} 名字=${names.join(',')}`);
}

/* ---- 六、模板那三处拒绝：每一处都要说到原因上，不是一句"语法错" */{
  const p = sample('free.sx', '(module\n'
    + '  (define-template bad () (print (var nope)))\n  (main (bad)))\n');
  const r = omni(['run', p, '--lang-directive']);
  const s = both(r);
  if (r.status !== 0 && s.includes("引用了 'nope'") && s.includes('定义处')) {
    ok('体里的自由名字查不到：说清"要在定义处就查得到"，并列出形参');
  } else bad('自由名字该报', `rc=${r.status} ${s.slice(0, 250)}`);
}
{
  const p = sample('arity.sx', '(module\n'
    + '  (define-template two (a b) (print (bin "+" (var a) (var b))))\n'
    + '  (main (two (int 1))))\n');
  const r = omni(['run', p, '--lang-directive']);
  const s = both(r);
  if (r.status !== 0 && s.includes("模板 'two' 要 2 个实参")) {
    ok('实参个数不对：报"要几个、给了几个"，并印出形参名');
  } else bad('实参个数该报', `rc=${r.status} ${s.slice(0, 250)}`);
}
{
  /* 模板不是函数：递归展开停不下来。到上限就报，而且要说清**为什么**不能递归。 */
  const p = sample('rec.sx', '(module\n'
    + '  (define-template loop1 (x) (loop1 (var x)))\n  (main (loop1 (int 1))))\n');
  const r = omni(['run', p, '--lang-directive']);
  const s = both(r);
  if (r.status !== 0 && s.includes('在调自己') && s.includes('不能递归')) {
    ok('模板调自己：到展开上限就报，说清"展开是编译期做完的"');
  } else bad('递归该报', `rc=${r.status} ${s.slice(0, 250)}`);
}
{
  /* **中性**：一份没有模板的 `.sx`，开着开关与不开跑出来一模一样
     （没有 `(define-template …)` 时 `expandTemplates` 原样把那棵树交回去，一次遍历都不做）。 */
  const p = join(ROOT, 'tests', 'sexpr', 'cases', '01-core.sx');
  const a = omni(['run', p]);
  const b = omni(['run', p, '--lang-directive']);
  if (a.status === 0 && b.status === 0 && a.stdout === b.stdout) {
    ok('中性：没有模板的 .sx，开关开与不开输出逐字节相同');
  } else bad('没有模板的 .sx 该中性', `rc=${a.status}/${b.status}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
