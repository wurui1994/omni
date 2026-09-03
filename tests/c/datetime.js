// tests/c/datetime.js —— `__DATE__` / `__TIME__`：每次展开现读一次时钟
// （ADR-0017 第九刀第一百〇三片）
//
// 这两条以前是**刻意的边界**：值随时钟走，进不了「逐字节相同」那根轴。第一百〇三片把它们
// 做了，尺子换一种称法：
//
//   1. **日期那一串逐字符相同** —— 同一天里两台编译器印出的 `__DATE__` 必须一模一样，
//      连宽度都算（tcc 的格式是 `"%s %2d %d"`，日**空格**右对齐到两位，所以 9 月 3 日是
//      `Sep  3 2026`，两个空格）。
//   2. **时间只差几秒** —— `"%02d:%02d:%02d"`，两次调用之间隔着一次进程启动，只能比
//      「差值在容差内」。顺带称格式：冒号分隔、每格两位。
//   3. **整份输出除了时间那一串以外逐字节相同** —— 把 `hh:mm:ss` 换成占位符再比，
//      这一格才是真正的「与 tcc 同形」：换行、空格、`# line` 标记全算。
//   4. **一份文件里展开两次，时钟各读一次**（`tccpp.c:3378-3393` 是在展开这一格里
//      `time()` 的，不是启动时算一次存着）—— 我们与 tcc 都得让两次展开各自成立。
//
//   node tests/c/datetime.js

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TCC_DIR = join(root, '.omni-cache', 'tcc-build');
const TCC = join(TCC_DIR, 'tcc');
const CLI = join(root, 'src', 'core', 'cli.js');
const OUT = join(tmpdir(), 'omni-datetime');

const PROBE = 'const char *d = __DATE__;\n'
  + 'const char *t = __TIME__;\n'
  + '#define STAMP __DATE__ " " __TIME__\n'
  + 'const char *both = STAMP;\n'
  + 'const char *again = __TIME__;\n';

const DATE_RE = /^[A-Z][a-z]{2} [ \d]\d \d{4}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;
const TIME_G = /\d{2}:\d{2}:\d{2}/g;

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; process.stdout.write(`  ok   ${name}\n`); };
const bad = (name, detail) => { fail++; process.stdout.write(`  FAIL ${name}\n${detail}\n`); };

if (!existsSync(TCC)) {
  process.stdout.write(`  skip 整组：尺子不在（${TCC}）\n`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const src = join(OUT, 'probe.c');
writeFileSync(src, PROBE);

/** 把 `"..."` 里的串按出现顺序摘出来。 */
const strs = (text) => [...text.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
const secs = (s) => {
  const [h, m, sec] = s.split(':').map((x) => Number(x));
  return h * 3600 + m * 60 + sec;
};

const ref = spawnSync(TCC, ['-B', TCC_DIR, '-E', src], { encoding: 'utf8' });
const mine = spawnSync(process.execPath, [CLI, 'cpp', src],
  { encoding: 'utf8', maxBuffer: 1 << 26 });

if (ref.status !== 0) {
  bad('尺子 tcc -E', `    ${(ref.stderr ?? '').trim().split('\n')[0]}`);
} else if (mine.status !== 0) {
  bad('我们的 cpp', `    ${(mine.stderr ?? '').trim().split('\n').slice(0, 3).join('\n    ')}`);
} else {
  /* 摘出来的顺序：日期、时间、日期、空格、时间、时间（`STAMP` 那行是三段拼接）。 */
  const R = strs(ref.stdout);
  const M = strs(mine.stdout);

  const rDates = R.filter((s) => DATE_RE.test(s));
  const mDates = M.filter((s) => DATE_RE.test(s));
  const rTimes = R.filter((s) => TIME_RE.test(s));
  const mTimes = M.filter((s) => TIME_RE.test(s));

  if (mDates.length !== 2 || mTimes.length !== 3) {
    bad('格式：两处 __DATE__、三处 __TIME__ 各自成形',
      `    ours 日期 ${JSON.stringify(mDates)} 时间 ${JSON.stringify(mTimes)}\n`
      + `    tcc  日期 ${JSON.stringify(rDates)} 时间 ${JSON.stringify(rTimes)}`);
  } else {
    ok(`格式：__DATE__ ×2 与 __TIME__ ×3 都合 tcc 的两句 snprintf（${mDates[0]} / ${mTimes[0]}）`);
  }

  if (mDates[0] !== rDates[0] || mDates[1] !== rDates[1]) {
    bad('日期那一串与 tcc 逐字符相同',
      `    tcc : ${JSON.stringify(rDates)}\n    ours: ${JSON.stringify(mDates)}`);
  } else {
    ok(`日期与 tcc 一字不差（"${mDates[0]}"，日是空格右对齐到两位）`);
  }

  const drift = Math.max(...mTimes.map((t) => Math.abs(secs(t) - secs(rTimes[0] ?? '00:00:00'))));
  if (!(drift <= 5)) {
    bad('时间与 tcc 差在容差内',
      `    tcc : ${rTimes[0]}\n    ours: ${JSON.stringify(mTimes)}（差 ${drift} 秒）`);
  } else {
    ok(`时间与 tcc 差 ${drift} 秒（两次进程启动之间的间隔，容差 5 秒）`);
  }

  /* 把时间那一串抹成占位符，剩下的必须逐字节相同 —— 从**第一个字节**起。
   * （第一百〇七片起 `<command line>` 那一层我们也开着，序幕不必再削。） */
  const mask = (t) => t.replace(TIME_G, 'HH:MM:SS');
  if (mask(mine.stdout) !== mask(ref.stdout)) {
    bad('抹掉时间之后整份输出与 tcc 逐字节相同',
      `    tcc :\n${mask(ref.stdout).trimEnd().split('\n').map((l) => `      ${l}`).join('\n')}\n`
      + `    ours:\n${mask(mine.stdout).trimEnd().split('\n').map((l) => `      ${l}`).join('\n')}`);
  } else {
    ok('抹掉时间之后整份 -E 输出与 tcc 逐字节相同（含空白与字符串拼接的形状）');
  }
}

rmSync(OUT, { recursive: true, force: true });
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
