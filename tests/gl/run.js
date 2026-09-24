// tests/gl/run.js —— **本机 OpenGL 设备那一档的判据**（`src/runtime-gl/omni_ev_gl.c`）
//
// 口径在 `docs/design/eval-realtime-gpu.md` 第 13 节。这一档是**命令行那一侧的 GPU**：
// 浏览器那一档（WebGL2）早就通了，CPU 备选画得了几何、画不了着色器。
//
// 这份判据判两件事，都不靠"看上去对"：
//   1. 那份插件在这台机器上**编得出来**（`clang -dynamiclib -framework OpenGL`）；
//   2. `dlopen` 挂上之后**离屏真拿到像素**：清成 `0x102030`、画一个裁剪空间的红三角，
//      读回来 **红 = 9600、背景 = 67200**（320×240 里三角占 1/8 —— 那两个数是算出来的，
//      所以它同时钉住"顶点是裁剪空间"这条契约）。
//
// 没有 `OpenGL.framework`（不是 macOS）就整份**跳过**，不算红 —— 与 `omni_r3.c` 那一侧
// "拿不到插件就回落 CPU"同一条口径。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0;
let fail = 0;
const ok = (s, extra) => { pass++; process.stdout.write(`  ok   ${s}${extra === undefined ? '' : ` [${extra}]`}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

if (!existsSync('/System/Library/Frameworks/OpenGL.framework')) {
  process.stdout.write('  --   这台机器上没有 OpenGL.framework，本机 GL 那一档整份跳过\n');
  process.stdout.write('\n0 passed, 0 failed（本机 OpenGL 设备）\n');
  process.exit(0);
}

const out = join(ROOT, '.omni-cache/test-gl');
mkdirSync(out, { recursive: true });
const lib = join(out, 'libomnigl_ev.dylib');
const probe = join(out, 'probe');

const cc = (args) => spawnSync('clang', args, { encoding: 'utf8', cwd: ROOT });

const r1 = cc(['-O2', '-w', '-dynamiclib', '-o', lib,
  join(ROOT, 'src/runtime-gl/omni_ev_gl.c'), '-framework', 'OpenGL']);
if (r1.status !== 0) {
  no('插件编得出来', (r1.stderr ?? '').trim().slice(0, 300));
} else {
  ok('插件编得出来', 'libomnigl_ev.dylib');
  const r2 = cc(['-O2', '-w', '-o', probe, join(ROOT, 'tests/gl/probe.c')]);
  if (r2.status !== 0) {
    no('探针编得出来', (r2.stderr ?? '').trim().slice(0, 300));
  } else {
    const r3 = spawnSync(probe, [lib], { encoding: 'utf8', cwd: ROOT, timeout: 60000 });
    const line = (r3.stdout ?? '').trim();
    const m = /red=(\d+) bg=(\d+)/.exec(line);
    if (r3.status !== 0 || m === null) {
      no('离屏真拿到像素', `${line} ${(r3.stderr ?? '').trim()}`.slice(0, 300));
    } else {
      const red = Number(m[1]);
      const bg = Number(m[2]);
      ok('离屏真拿到像素（裁剪空间的红三角 + 背景）', line);
      if (red === 9600 && bg === 67200) ok('像素数与算出来的一样（红 9600 / 背景 67200）');
      else no('像素数与算出来的一样', `红 ${red}（要 9600）、背景 ${bg}（要 67200）`);
    }
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed（本机 OpenGL 设备）\n`);
process.exit(fail === 0 ? 0 : 1);
