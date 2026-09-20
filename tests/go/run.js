// tests/go/run.js —— go 这条腿的**端到端**判据：源码 → graph → 核心方言 → MIR 管线 → 原生，
// 跑出来的 stdout 必须与 `go run` 逐字节相同。
//
// 为什么要这一格：go 那条路以前只量到"图能不能建起来"（tograph 的 754/754）。
// 而真正要的是**跑出来对**，而且是走 MIR 管线那一条（性能账在那儿）。
// 有官方 go 当参考，所以这一格不必自己写期望值 —— 参考是别人的实现，不是我们的复述。
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const cases = join(here, 'cases');
const out = join(root, '.omni-cache', 'go-e2e');
mkdirSync(out, { recursive: true });

let pass = 0, fail = 0, skip = 0;
const cli = (args) => execFileSync('node', [join(root, 'src', 'cli.js'), ...args],
  { cwd: root, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });

const files = readdirSync(cases).filter((f) => f.endsWith('.go')).sort();
for (const f of files) {
  const src = join(cases, f);
  const stem = f.slice(0, -3);
  let want = null;
  try {
    /* **两条流一起收**：go 的 `println` 写的是 stderr（不是 stdout），
       而我们的 `print` 写 stdout —— 只比 stdout 会两边都空着"相同"。 */
    want = execFileSync('sh', ['-c', `go run ${JSON.stringify(src)} 2>&1`],
      { encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    console.log(`  skip ${f}（官方 go 跑不了它：${String(e.stderr || e.message).split('\n')[0]}）`);
    skip++;
    continue;
  }
  const sx = join(out, `${stem}.sx`);
  const exe = join(out, stem);
  try {
    cli(['build', '--engine', 'graph', '--lang', 'go', '--backend', 'core', src, '-o', sx]);
  } catch (e) {
    const all = String(e.stderr || e.stdout || e.message);
    const why = all.split('\n').filter((x) => x.trim()).pop();
    /* **有名有姓的缺口算 skip**，与 `tests/graph` 一条规矩：那是"还没接"，不是"接错了"。 */
    if (/还没接/.test(all)) { console.log(`  skip ${f}（缺口：${why?.slice(0, 96)}）`); skip++; continue; }
    console.log(`  FAIL ${f} 落方言：${why?.slice(0, 110)}`);
    fail++;
    continue;
  }
  try {
    execFileSync('node', [join(root, 'src', 'cli.js'), 'build', sx, '-o', exe],
      { cwd: root, encoding: 'utf8', timeout: 300000, stdio: 'pipe',
        env: { ...process.env, OMNI_MIR_OPT: '1' } });
  } catch (e) {
    const why = String(e.stderr || e.stdout || e.message).split('\n').filter((x) => x.trim())[0];
    console.log(`  FAIL ${f} 编原生：${why?.slice(0, 110)}`);
    fail++;
    continue;
  }
  let got = null;
  try { got = execFileSync('sh', ['-c', `${JSON.stringify(exe)} 2>&1`], { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { console.log(`  FAIL ${f} 跑：${String(e.message).slice(0, 110)}`); fail++; continue; }
  if (got === want) { pass++; console.log(`  ok   ${f} [与 go run 逐字节相同：${JSON.stringify(want.slice(0, 40))}]`); }
  else { fail++; console.log(`  FAIL ${f} 输出不同\n       我们：${JSON.stringify(got)}\n       go  ：${JSON.stringify(want)}`); }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
