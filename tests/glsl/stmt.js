// tests/glsl/stmt.js —— 语句那一层的补全：`do while` 与 `switch`（ADR-0019 第十九片）
//
// 为什么单开一门而不是塞进 lower.js：那一门查的是「一份真着色器的像素对不对」，
// 这一门查的是**语义**——穿落、`default` 摆在中间、`break` 归 switch 还是归循环、
// `continue` 在 `do while` 里跳到哪儿。这些用一个返回 float 的小函数就能称清，
// 不必扯上光栅化。
//
// 三件事：
//
//   一、每条用例的期望值由**这门自己独立算一遍**（`REF` 那几个 JS 函数），
//      不是把降级出来的数抄下来 —— 抄下来的话降级错了门也绿。
//   二、三条腿（JS / C / LLVM）都跑，逐字节相同。LLVM 腿值得单查：它是唯一一条
//      向量原生的腿（见 ADR-0019「量：向量在五条腿上分别落成什么」）。
//   三、检查那一侧该骂的明着骂：选择子不是 int、标签重复、default 重复、
//      第一个标签之前有语句、标签不是常量。
//
//   node tests/glsl/stmt.js

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { glslCheck } from '../../src/core/frontend-glsl/check.js';
import { glslLower } from '../../src/core/frontend-glsl/lower.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const GRAMMAR = join(root, 'src', 'core', 'frontend-glsl', 'glsl.grammar');
const OUT = join(tmpdir(), 'omni-glsl-stmt');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

/* 表走带缓存的装载（ADR-0019 决策八第 1 步）：构表在这份语法上是 559 ms、
 * 命中缓存是 8 ms。十四支门各构一遍表，等于每跑一趟全套白花 14 × 559 ms。 */
const { g, tb } = loadGrammarTable(GRAMMAR);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** 一段 GLSL -> 方言文本（片元）。 */
function lower(src) {
  const diags = new Diagnostics();
  const file = new SourceFile('probe.frag', src);
  const toks = lexText(g.lex, file, diags);
  diags.throwIfErrors();
  const tree = glrParse(tb, toks, diags);
  diags.throwIfErrors();
  return glslLower(glslCheck(tree, 'frag'));
}

/* 每条用例都是「一个 `float probe(int k)` + 一个不干事的 main」。main 是必须的
 * （检查那一侧要它），但这一门一格都不碰它 —— 直接调 `glsl_probe`。 */
const SHELL = (body) => `#version 330 core
out vec4 fragColor;
${body}
void main() { fragColor = vec4(probe(0), 0.0, 0.0, 1.0); }
`;

/** 跑一条腿：把 `probe(k)` 对每个 k 印一行。 */
function runLeg(name, glsl, ks, extra) {
  const lib = lower(SHELL(glsl)).trimEnd();
  const driver = ks.map((k) => `    (print (call glsl_probe ${k < 0 ? `(un "-" (int ${-k}))` : `(int ${k})`}))`).join('\n');
  const sx = `${lib.slice(0, -1)}\n  (main\n${driver})\n)\n`;
  const p = join(OUT, `${name}.sx`);
  writeFileSync(p, sx);
  const r = spawnSync(process.execPath, [CLI, 'run', p, ...extra], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { err: (r.stderr ?? '').trim().split('\n').slice(0, 4).join('\n    ') };
  return { lines: r.stdout.trim().split('\n') };
}

/** 一条用例：三条腿都跑，都要与 `ref` 逐字节相同。 */
function probe(name, glsl, ks, ref) {
  const want = ks.map((k) => {
    const v = ref(k);
    /* 方言印 real 的口径：整数值印成整数（`10` 而不是 `10.0`）。 */
    return Number.isInteger(v) ? String(v) : String(v);
  });
  for (const [tag, extra] of [['JS', []], ['C', ['--backend', 'c']], ['LLVM', ['--backend', 'llvm']]]) {
    const r = runLeg(`${name}-${tag}`, glsl, ks, extra);
    if (r.err !== undefined) { bad(`${name}［${tag} 腿］跑不动`, `    ${r.err}`); continue; }
    if (r.lines.length !== want.length) {
      bad(`${name}［${tag} 腿］行数不对`, `    要 ${want.length} 行，来了 ${r.lines.length} 行`);
      continue;
    }
    const diff = [];
    for (let i = 0; i < want.length; i++) {
      if (r.lines[i] !== want[i]) diff.push(`k=${ks[i]}：要 ${want[i]}，得 ${r.lines[i]}`);
    }
    if (diff.length > 0) bad(`${name}［${tag} 腿］`, diff.map((d) => `    ${d}`).join('\n'));
    else ok(`${name}［${tag} 腿］${want.length} 个数逐字节相同`);
  }
}

/* ---- 一、switch：穿落 + default 摆在中间 + 负标签 ------------------------------ */

const SW_FALL = `
float probe(int k) {
  float r = 0.0;
  switch (k) {
    case -1:
      r = 100.0;
      break;
    case 0:
      r = 1.0;
      break;
    case 1:
    case 2:
      r += 2.0;
    default:
      r += 8.0;
      break;
    case 3:
      r += 4.0;
  }
  return r;
}`;

/* 独立算一遍：穿落与「default 在中间」都照 C 的规矩。
 *   k=-1 -> 100；k=0 -> 1；k=1/2 -> 2+8=10；k=3 -> 4（后面没有组了）；
 *   别的 -> 走 default -> 8。 */
const refFall = (k) => {
  if (k === -1) return 100;
  if (k === 0) return 1;
  if (k === 1 || k === 2) return 10;
  if (k === 3) return 4;
  return 8;
};

probe('switch 穿落 + 中间的 default', SW_FALL, [-1, 0, 1, 2, 3, 7], refFall);

/* ---- 二、`do while`：至少走一趟 ----------------------------------------------- */

const DO_ONCE = `
float probe(int k) {
  int n = 0;
  float acc = 0.0;
  do {
    acc += 1.0;
    n++;
  } while (n < k);
  return acc;
}`;

/* `k <= 0` 时条件一开始就是假的，`do` 照样走一趟 —— 这正是它与 `while` 的差别。 */
const refDoOnce = (k) => Math.max(1, k);

probe('do while 至少走一趟', DO_ONCE, [-3, 0, 1, 2, 5], refDoOnce);

/* ---- 三、`do while` 里的 `continue` 跳到判条件之前，不是跳过它 ------------------ */

const DO_CONT = `
float probe(int k) {
  int n = 0;
  float acc = 0.0;
  do {
    n++;
    if (n == 2) { continue; }
    acc += float(n);
  } while (n < k);
  return acc;
}`;

/* `continue` 之后**还要判条件** —— 要是落成「跳过判条件」，k=2 那一格就会死循环
 * 或者多走一趟。独立算：n 从 1 数到 max(1,k)，跳过 n==2 那一次的累加。 */
const refDoCont = (k) => {
  let n = 0;
  let acc = 0;
  do {
    n++;
    if (n === 2) continue;
    acc += n;
  } while (n < k);
  return acc;
};

probe('do while 里的 continue', DO_CONT, [1, 2, 3, 6], refDoCont);

/* ---- 四、switch 在循环里：`break` 归 switch，`continue` 归循环 ------------------ */

const SW_IN_FOR = `
float probe(int k) {
  float acc = 0.0;
  for (int i = 0; i < 6; i++) {
    switch (i) {
      case 1:
        acc += 10.0;
        break;
      case 2:
        continue;
      case 3:
        acc += 100.0;
        break;
      default:
        acc += 1.0;
    }
    acc += float(k);
  }
  return acc;
}`;

/* `break` 只跳出 switch（后面那句 `acc += k` 照走），`continue` 跳的是 `for`
 * （那一句不走）。i=2 那一轮 step 也必须照走 —— 不然死循环。 */
const refSwInFor = (k) => {
  let acc = 0;
  for (let i = 0; i < 6; i++) {
    if (i === 1) acc += 10;
    else if (i === 2) continue;
    else if (i === 3) acc += 100;
    else acc += 1;
    acc += k;
  }
  return acc;
};

probe('switch 在 for 里（break 归 switch、continue 归 for）', SW_IN_FOR, [0, 2], refSwInFor);

/* ---- 五、switch 套 switch ------------------------------------------------------ */

const SW_NEST = `
float probe(int k) {
  float r = 0.0;
  switch (k) {
    case 0:
    case 1:
      switch (k) {
        case 1:
          r += 5.0;
          break;
        default:
          r += 3.0;
      }
      r += 1.0;
      break;
    default:
      r = -1.0;
  }
  return r;
}`;

const refSwNest = (k) => {
  if (k === 0) return 4;
  if (k === 1) return 6;
  return -1;
};

probe('switch 套 switch（里头的 break 只跳里头那一层）', SW_NEST, [0, 1, 9], refSwNest);

/* ---- 六、该骂的明着骂 ---------------------------------------------------------- */

function rejects(name, glsl, want) {
  let msg = null;
  try {
    lower(SHELL(glsl));
  } catch (e) {
    msg = String(e.message ?? e);
  }
  if (msg === null) bad(name, '    一声没骂就收下了');
  else if (!msg.includes(want)) bad(name, `    骂的是别的：${msg.split('\n')[0]}`);
  else ok(`${name}［${want}］`);
}

rejects('选择子不是 int', `
float probe(int k) { switch (float(k)) { case 0: break; } return 0.0; }`,
'switch 的选择子要是 int');

rejects('标签重复', `
float probe(int k) { switch (k) { case 1: case 1: break; } return 0.0; }`,
'case 1 出现了两次');

rejects('default 重复', `
float probe(int k) { switch (k) { default: break; case 1: default: break; } return 0.0; }`,
'default 出现了两次');

rejects('第一个标签之前有语句', `
float probe(int k) { float r = 0.0; switch (k) { r = 1.0; case 1: break; } return r; }`,
'第一个 case/default 之前不能有语句');

rejects('标签不是常量', `
float probe(int k) { switch (k) { case k: break; } return 0.0; }`,
'case 的标签要是整数常量');

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
