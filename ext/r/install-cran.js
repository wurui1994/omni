#!/usr/bin/env node
// ext/r/install-cran.js —— 往**我们自己编的那个 R** 里装 CRAN 的包。
//
//   node ext/r/install-cran.js              # 默认那一串：ggplot2 + 它的 16 个依赖
//   node ext/r/install-cran.js R6 withr     # 只装这几个
//
// 装法就是 R 自己的那条路：`bin/INSTALL` 把参数拼成 `nextArg` 串喂给
// `tools:::.install_packages()`（`src/scripts/INSTALL` 那 30 行）。我们只做两件事：
// 从 CRAN 下 tarball、按次序调它。
//
// **次序是写死的**（拓扑序，手排）—— 不去解析 DESCRIPTION 的依赖图：那要先有一个能跑
// `available.packages()` 的 R，而这一步正是"把包装进去"本身。写死的一串好处是它能被读、
// 能被 diff；哪天要加包，把名字摆在它依赖的后面就行。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const HOME = join(ROOT, '.omni-cache', 'r-rt', 'libR', 'home');
const DL = join(ROOT, '.omni-cache', 'r-rt', 'cran');
const MIRROR = process.env.OMNI_CRAN ?? 'https://cloud.r-project.org';

/** ggplot2 4.x 的依赖闭包，拓扑序（前面的先装）。 */
const DEFAULT = ['glue', 'rlang', 'cli', 'withr', 'lifecycle', 'labeling', 'viridisLite',
  'RColorBrewer', 'R6', 'cpp11', 'farver', 'isoband', 'gtable', 'S7', 'vctrs', 'scales', 'ggplot2'];

const want = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT;
if (!existsSync(join(HOME, 'bin/INSTALL'))) {
  process.stderr.write(`install-cran: 先把 R 建出来 —— node ext/r/build-libR.js\n（缺 ${HOME}/bin/INSTALL）\n`);
  process.exit(1);
}
mkdirSync(DL, { recursive: true });

/** 从 CRAN 的 PACKAGES 索引里查这个包当前的版本，回 tarball 的文件名。 */
let index = null;
function tarballName(pkg) {
  if (index === null) {
    const r = spawnSync('curl', ['-sSL', '--max-time', '120', `${MIRROR}/src/contrib/PACKAGES`], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`install-cran: 取不到 PACKAGES 索引：${r.stderr}`);
    index = r.stdout;
  }
  const m = new RegExp(`^Package: ${pkg}\\nVersion: ([^\\n]+)`, 'm').exec(index);
  if (m === null) throw new Error(`install-cran: CRAN 索引里没有 ${pkg}`);
  return `${pkg}_${m[1]}.tar.gz`;
}

let ok = 0;
let bad = 0;
for (const pkg of want) {
  /* 已经下过就不再下（`.omni-cache` 里那一份就是"下载过"的证据）。 */
  const have = readdirSync(DL).filter((f) => f.startsWith(`${pkg}_`) && f.endsWith('.tar.gz'));
  const name = have.length > 0 ? have[0] : tarballName(pkg);
  const path = join(DL, name);
  if (!existsSync(path)) {
    const r = spawnSync('curl', ['-sSL', '--max-time', '600', '-o', path, `${MIRROR}/src/contrib/${name}`], { stdio: 'inherit' });
    if (r.status !== 0) {
      process.stdout.write(`  ${pkg} ✗ 下不下来\n`);
      bad += 1;
      continue;
    }
  }
  const args = ['-l', join(HOME, 'library'), path].map((a) => `nextArg${a}`).join('');
  const r = spawnSync(join(HOME, 'bin/R'), ['--vanilla', '--no-echo', '--args', args], {
    input: 'tools:::.install_packages()\n',
    encoding: 'utf8',
    env: { ...process.env, R_DEFAULT_PACKAGES: '', LC_COLLATE: 'C' },
    timeout: 900000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/^\* DONE/m.test(out)) {
    ok += 1;
    process.stdout.write(`  ${pkg} ✓ (${name})\n`);
  } else {
    bad += 1;
    const why = out.split('\n').filter((l) => /^ERROR|error:|Error/.test(l)).slice(0, 2).join(' ');
    process.stdout.write(`  ${pkg} ✗ ${why || out.split('\n').slice(-3).join(' ')}\n`);
  }
}
process.stdout.write(`\n装上 ${ok} 个，失败 ${bad} 个（库在 ${join(HOME, 'library')}）\n`);
process.exit(bad === 0 ? 0 : 1);
