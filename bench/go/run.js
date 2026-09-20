// bench/go/run.js —— go 这条腿的**性能尺子**：我们的原生 vs `go build` 的原生。
//
// 为什么要它：正确性有 `tests/go`，但这条路的目标是**逼近 go 原生**，那只能量。
// 参考是官方 go 编出来的二进制（同一台机器、同一份源码），所以这把尺子不是我们自己的复述。
// 用法：node bench/go/run.js [次数]（交错跑、各取最小 —— 这台机器单次墙上时间抖 ±40%）
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, '.omni-cache', 'go-bench');
mkdirSync(out, { recursive: true });
const N = Number(process.argv[2] || 5);

const wall = (bin) => {
  const t0 = process.hrtime.bigint();
  execFileSync(bin, [], { stdio: 'ignore', timeout: 600000 });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

for (const f of readdirSync(here).filter((x) => x.endsWith('.go')).sort()) {
  const src = join(here, f);
  const stem = f.slice(0, -3);
  const ref = join(out, `${stem}_go`);
  const ours = join(out, `${stem}_ours`);
  const sx = join(out, `${stem}.sx`);
  /* 编不过就报一行、接着量下一份 —— 尺子不该因为一处缺口整趟垮掉。 */
  try {
    execFileSync('go', ['build', '-o', ref, src], { timeout: 300000 });
    execFileSync('node', [join(root, 'src', 'cli.js'), 'build', '--engine', 'graph',
      '--lang', 'go', '--backend', 'core', src, '-o', sx], { cwd: root, stdio: 'pipe', timeout: 300000 });
    execFileSync('node', [join(root, 'src', 'cli.js'), 'build', sx, '-o', ours],
      { cwd: root, stdio: 'pipe', timeout: 300000, env: { ...process.env, OMNI_MIR_OPT: '1' } });
  } catch (e) {
    const all = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    const why = all.split('\n').filter((x) => x.trim()).pop();
    console.log(`${f.padEnd(16)} 编不出来：${String(why).slice(0, 96)}`);
    continue;
  }
  let bg = Infinity, bo = Infinity;
  for (let i = 0; i < N; i++) { bg = Math.min(bg, wall(ref)); bo = Math.min(bo, wall(ours)); }
  console.log(`${f.padEnd(16)} go ${bg.toFixed(0)}ms   我们 ${bo.toFixed(0)}ms   ×${(bo / bg).toFixed(2)}`);
}
