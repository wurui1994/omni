// tests/python/ucase-sweep.js —— 把**查表那一刀的总判据**挂进轴表（薄封装）
//
// 真活在 `ext/python/rt/ucase-sweep.js`：同一份 `.py` 我们跑一遍、本机 python3 跑一遍，
// **逐字节**比。四趟 —— 四个映射 / 尾位 sigma 的前位与后位 / title·capitalize·swapcase /
// 分类那八格。账在 `ext/python/SPEC.md` §一 第 29 条那一段。
//
// **这一格走"稀"的步长**（默认每 211 个码点一格，约 5 千格、4 秒）：
// 全量（步长 1、约 111 万格、90 秒）留给 `npm run py:ucase-sweep` 手动跑 ——
// 天天跑的套件里 60 秒以上的东西不值得（那条规矩在这份仓库里是明说的）。
// 稀的那一趟仍旧覆盖每一族行为：Σ / ß / ﬃ / İ / ǅ 那几格分布在不同块里，
// 而**每一趟都带一格多字符**（`"αΣ"+c` / `("a"+c).title()` / `("A"+c).isupper()`）——
// 上下文那几条规矩只有多字符才现形（那是两回探针写错都躲过单字符判据的原因）。
//
// **前置只要 python3**（oracle）—— 表已经在仓库里（`ext/python/rt/ucase.tab`），
// 不要参考树、不要外部 cc、不要预热的 obj/。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const step = process.env.OMNI_UCASE_STEP ?? '211';

if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.log('  skip 大小写与分类那一族：整表与 python3 逐字节相同（本机没有 python3）');
  console.log('\n0 passed, 0 failed, 1 skipped');
  process.exit(0);
}

const r = spawnSync(process.execPath,
  [join(root, 'ext', 'python', 'rt', 'ucase-sweep.js'), '--step', step],
  { cwd: root, stdio: 'inherit' });
console.log(`\n${r.status === 0 ? 4 : 0} passed, ${r.status === 0 ? 0 : 1} failed, 0 skipped`);
process.exit(r.status === 0 ? 0 : 1);
