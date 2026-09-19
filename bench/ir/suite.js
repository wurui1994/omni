// bench/ir/suite.js —— **覆盖面基准**：不只数值计算，横跨计算机科学各面
//
// 上一版五个例子全是数值（nbody / mandel / sieve / strcat / matmul），
// 而那一档藏不住的东西是：break 没接（mandel 静默错答案）、表是线性查找（sieve 跑不完）。
// **例子太弱等于没有判据** —— 所以这一份按"计算机科学的面"排：
//
//   num   数值计算    nbody mandel matmul sieve strcat
//   ds    数据结构    btree list heap hash
//   algo  算法        qsort queens lcs bfs bignum
//   str   串与解析    parse revwords
//   fn    闭包/高阶   closure hof
//   oo    对象/分派   method（元表）
//   dyn   动态特性    varargs coro（协程）
//
// 判据是**与参考实现（luajit）的输出逐字节相同**；跑不出来的记成"缺哪一格特性"。
// 用法：node bench/ir/suite.js [--only NAME] [--time]

import { buildRuntime, build, countRtCalls } from './build.js';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WORK = '/tmp/omni-suite-run';
const ROOT = 'bench/ir/suite';
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1] : null;
const wantTime = process.argv.includes('--time');

/** 分类 → 例子名（文件是 `<ROOT>/<组>/<名>.lua`，num 组直接在 ROOT 下） */
const GROUPS = {
  num: ['nbody', 'mandel', 'matmul', 'sieve', 'strcat'],
  ds: ['btree', 'list', 'heap', 'hash'],
  algo: ['qsort', 'queens', 'lcs', 'bfs', 'bignum'],
  str: ['parse', 'revwords'],
  fn: ['closure', 'hof'],
  oo: ['method'],
  dyn: ['varargs', 'coro'],
};

const pathOf = (group, name) => (group === 'num'
  ? `${ROOT}/${name}.lua` : `${ROOT}/${group}/${name}.lua`);

/** 参考答案：拿 luajit 跑一遍（它是这一门的外部尺子） */
function reference(file) {
  try {
    return execSync(`luajit ${file}`, { timeout: 60000, encoding: 'utf8' }).trim();
  } catch { return null; }
}

function timeIt(cmd, n = 3) {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    try { execSync(cmd, { timeout: 60000, stdio: 'ignore' }); } catch { return null; }
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms < best) best = ms;
  }
  return Math.round(best);
}

const rt = buildRuntime(WORK);
const rows = [];

for (const [group, names] of Object.entries(GROUPS)) {
  for (const name of names) {
    if (only && name !== only) continue;
    const file = pathOf(group, name);
    if (!existsSync(file)) { rows.push({ group, name, state: 'missing' }); continue; }
    const src = readFileSync(file, 'utf8');
    const want = reference(file);

    let row = { group, name, want };
    try {
      const b = build(name, src, WORK, rt, 'link');
      row.rt = countRtCalls(b.bin).total;
      let got = null;
      try { got = execSync(b.bin, { timeout: 60000, encoding: 'utf8' }).trim(); } catch { got = '<跑不完/崩>'; }
      row.got = got;
      row.state = (want !== null && got === want) ? 'pass' : 'diff';
      if (wantTime && row.state === 'pass') {
        row.ours = timeIt(b.bin);
        row.ref = timeIt(`luajit ${file}`);
      }
    } catch (e) {
      const msg = (e.stderr || e.stdout || '').toString();
      row.state = 'gap';
      row.why = (msg.split('\n').filter((l) => l.includes('error') || l.includes('emit-mlir'))[0]
        ?? e.message.split('\n')[0]).slice(0, 72);
    }
    rows.push(row);
  }
}

// ---- 印表 ----
let pass = 0, diff = 0, gap = 0;
let lastGroup = null;
for (const r of rows) {
  if (r.group !== lastGroup) { console.log(`\n[${r.group}]`); lastGroup = r.group; }
  if (r.state === 'pass') {
    pass++;
    const t = (r.ours !== undefined && r.ref !== undefined)
      ? `  ours ${String(r.ours).padStart(5)}ms  luajit ${String(r.ref).padStart(5)}ms  ${(r.ref / r.ours).toFixed(2)}x` : '';
    console.log(`  PASS ${r.name.padEnd(9)} rt=${String(r.rt).padStart(3)}${t}`);
  } else if (r.state === 'diff') {
    diff++;
    console.log(`  DIFF ${r.name.padEnd(9)} rt=${String(r.rt).padStart(3)}  got=${JSON.stringify(String(r.got).slice(0, 22))} want=${JSON.stringify(String(r.want).slice(0, 22))}`);
  } else if (r.state === 'gap') {
    gap++;
    console.log(`  GAP  ${r.name.padEnd(9)} ${r.why}`);
  } else {
    console.log(`  ---- ${r.name.padEnd(9)} ${r.state}`);
  }
}
console.log(`\n总计  通过 ${pass}  答案不同 ${diff}  缺特性 ${gap}  /  ${rows.length}`);
