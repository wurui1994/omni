#!/usr/bin/env node
/* **js 腿的摇树**（`backend-js/emit.js` 的 `trimJsRuntime`）：产物按用到的名字裁。
 *
 * 这一格判的是**两件事同时成立**：
 *   一、真的小了 —— 量出来的账钉在这儿（fib.js 371770 -> 142892 字节，-62%）；
 *   二、**行为一个字节都没变** —— 同一份源码，裁过的与 `--no-trim` 那份跑出来逐字节相同。
 *      这是摇树唯一讲得通的判据：削掉的必须是"没人用的"，而"没人用"只能由跑一遍来证。
 *
 * 三个反面（每一格都是量到过的真事故，不是假想）：
 *   * 裸语句要自己成一格：`$js_pm_set(…)` 那一大批（原型成员表）粘在上一格函数里的话，
 *     那格函数被裁掉时它们跟着消失 —— 44-proto-member-values 当场印一片 undefined；
 *   * 裸语句用到的名字也是根：漏了就 `ReferenceError: $js_pm_set is not defined`；
 *   * 一行写完的判据要连括号一起看：序言里有
 *     `function $js_eq(strict, a, b) {  const ta = …;` 这种写法（行末真有分号，花括号还开着），
 *     只看分号会把 9 格函数从中间切开 —— 产物 `SyntaxError: Unexpected end of input`。
 *
 *   node tests/cli/js-trim.js
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CLI = join(ROOT, 'src', 'cli.js');
const WORK = join(ROOT, '.omni-cache', 'work', 'cli-js-trim');

let pass = 0;
let fail = 0;
const ok = (what) => { pass++; process.stdout.write(`  ok   ${what}\n`); };
const bad = (what, why) => { fail++; process.stdout.write(`  FAIL ${what}\n    ${why}\n`); };
const omni = (args) => spawnSync(process.execPath, [CLI, ...args],
  { encoding: 'utf8', timeout: 300000, cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const runNode = (file) => spawnSync(process.execPath, [file],
  { encoding: 'utf8', timeout: 300000, cwd: WORK, maxBuffer: 64 * 1024 * 1024 });

mkdirSync(WORK, { recursive: true });

/** 一份源码两种发法：回 `{ full, trim }` 两段文本（都落盘，好让 node 直接跑）。 */
function bothWays(src, stem) {
  const full = omni(['emit', 'js', src, '--no-trim']).stdout ?? '';
  const trim = omni(['emit', 'js', src]).stdout ?? '';
  const fp = join(WORK, `${stem}.full.js`);
  const tp = join(WORK, `${stem}.trim.js`);
  writeFileSync(fp, full);
  writeFileSync(tp, trim);
  return { full, trim, fp, tp };
}

/* ---- 一、账：小了多少（fib.js 是那份最小的样本，序言占比最大） */
const FIB = join(ROOT, 'bench', 'fib.js');
const fib = bothWays(FIB, 'fib');
{
  const src = readFileSync(FIB, 'utf8').length;
  const cut = 1 - fib.trim.length / fib.full.length;
  if (fib.full.length > 300000 && cut >= 0.5) {
    ok(`fib.js（源 ${src} 字符）：整份 ${fib.full.length} -> 裁后 ${fib.trim.length}`
      + `（-${(cut * 100).toFixed(0)}%）`);
  } else bad('fib.js 该裁掉一半以上', `整份 ${fib.full.length} 裁后 ${fib.trim.length}`);
}
{
  /* 按名字调 op 那扇门（`$js_call_op`）只有解释器用得着：一份普通程序里不该有它，
   * 而它自己就是几千行（C 腿那个孪生量出来 50697 字节 / 那份产物函数字节的 52%）。 */
  if (!fib.trim.includes('$js_call_op(') && fib.full.includes('$js_call_op(')) {
    ok('按名字调 op 的派发器整格没了（程序没走那扇门）');
  } else bad('$js_call_op 该被裁掉', `裁后还在：${fib.trim.includes('$js_call_op(')}`);
}
{
  /* 顶层裸语句一律留，**而且**它用到的名字也留（两条一起判：漏一条就 ReferenceError）。 */
  const hasRows = fib.trim.includes('$js_pm_set(');
  const hasDef = /function\s+\$js_pm_set/.test(fib.trim);
  if (hasRows && hasDef) {
    ok('原型成员表那一大批裸语句留着，`$js_pm_set` 的定义也在（裸语句也是根）');
  } else bad('裸语句与它的定义都得留', `表 ${hasRows} / 定义 ${hasDef}`);
}

/* ---- 二、行为：裁过的与整份逐字节相同（摇树唯一讲得通的判据） */
const CASES = [
  ['fib', FIB],
  /* 这四份各压一族：原型成员当值取（那次事故的现场）、成员方法、类、异常。 */
  ['proto-values', join(ROOT, 'tests', 'js-exec', 'cases', '44-proto-member-values.js')],
  ['lib-methods', join(ROOT, 'tests', 'js-exec', 'cases', '14-lib-methods.js')],
  ['classes', join(ROOT, 'tests', 'js-exec', 'cases', '07-classes.js')],
  ['throw-try', join(ROOT, 'tests', 'js-exec', 'cases', '08-throw-try.js')],
];
for (const [stem, src] of CASES) {
  const b = stem === 'fib' ? fib : bothWays(src, stem);
  const a = runNode(b.fp);
  const t = runNode(b.tp);
  const sa = `${a.stdout ?? ''}${a.stderr ?? ''}`;
  const st = `${t.stdout ?? ''}${t.stderr ?? ''}`;
  /* 判据只有一条：**逐字节相同**。别再叠「输出里不许出现 SyntaxError / is not defined」——
   * 量到过那样叠的后果：`14-lib-methods.js` 自己就印错误消息（里头正好有 `is not defined`），
   * 于是一格好的用例被判红。裁前裁后一样，就是一样。 */
  if (sa === st && sa.length > 0) {
    ok(`${stem}：裁过的与整份跑出来逐字节相同（${sa.split('\n').length - 1} 行）`);
  } else {
    bad(`${stem} 裁前裁后行为要一样`, `整份 ${sa.slice(0, 200)}\n    裁后 ${st.slice(0, 200)}`);
  }
}

/* ---- 三、三扇运行期的门：提到就整份让过（宁可胖，不许悄悄少一个名字） */
{
  const p = join(WORK, 'door.js');
  /* `eval` 进来的那段文本里可以出现**任何**运行时名字，静态看不见 —— 所以这一格不裁。
   * 这一份**不跑**：`eval` 那条路要宿主在旁边挂一格钩子（`installSrcEvalHook`），
   * 单独 `node x.js` 本来就跑不起来 —— 这一格判的是「一格都没裁」，不是它跑不跑。 */
  writeFileSync(p, 'const f = eval("(a) => a * 2");\nprocess.stdout.write(`${f(21)}\\n`);\n');
  const b = bothWays(p, 'door');
  if (b.trim.length === b.full.length && b.trim.includes('$js_call_op(')) {
    ok('程序里有 eval（$js_src_eval 那扇门）：整份让过，一格不裁');
  } else bad('eval 那一格该整份让过', `整份 ${b.full.length} 裁后 ${b.trim.length}`);
}

/* ---- 四、逃生门：`--no-trim` 真的把整份带回来 */
{
  if (fib.full.length > fib.trim.length && fib.full.includes('$js_call_op(')) {
    ok('`--no-trim`：整份带回来（出了事拿它对照）');
  } else bad('--no-trim 该是整份', `${fib.full.length} vs ${fib.trim.length}`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
