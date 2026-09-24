#!/usr/bin/env node
// ext/r/rt/gen-config.js —— 写 `config.h`：**按本机探出来的那几格**，不抄 R 的 configure 结果
//
// R 的 `src/nmath` 有三份 `.c` 明写 `#include <config.h>`（`fround.c` / `fprec.c` /
// `pcauchy.c`），而那份 `config.h` 是 R 的 configure 生成的 —— 参考树没配置过，所以没有。
//
// 两种办法，挑了后一种：
//   * 抄本机装的那个 R 的 `Rconfig.h` —— **不行**。那是别人的构建结果，而且它只有
//     `Rconfig.h` 那一半（`HAVE_ATANPI` 这些在 `config.h` 里，不在 `Rconfig.h` 里）。
//   * **自己探一遍**：拿编译器试编几段小程序，能编过就 `#define`。这就是 configure 做的事，
//     只是这儿只探 nmath 真正问到的那十几格（名单是 `grep -o 'HAVE_[A-Z_0-9]*' src/nmath/*`
//     出来的，不是猜的）。
//
// 探不出来一律**不定义**（R 那几处的写法都是 `#ifdef HAVE_X` + 退路），所以"探错了"的后果
// 是走慢路而不是算错。唯一例外是 `IEEE_754`：它不定义的话 nmath 会走一条非 IEEE 的旧路径，
// 而那条路我们不想要 —— 所以它是**探到才定义、探不到当场报**。
//
//   node ext/r/rt/gen-config.js --out <path> [--cc clang]

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const out = argOf('out', null);
if (out === null) { process.stderr.write('gen-config.js: 要一格 --out <path>\n'); process.exit(2); }
const cc = argOf('cc', process.env.OMNI_CLANG ?? 'clang');

/* 一格探针：这段 C 编得过就算"有"。**只编不链** —— 我们问的是"这个符号声明得出来吗"，
   而 nmath 那几处用它的地方也只要声明（链接由 libm 兜）。 */
const scratch = join(tmpdir(), `omni-r-conf-${process.pid}`);
mkdirSync(scratch, { recursive: true });
let probes = 0;
function probe(body, extraFlags = []) {
  probes++;
  const src = join(scratch, `p${probes}.c`);
  writeFileSync(src, body);
  const r = spawnSync(cc, ['-std=c99', '-w', '-c', src, '-o', join(scratch, `p${probes}.o`), ...extraFlags],
    { encoding: 'utf8' });
  return r.status === 0;
}

/** 一格数学函数在 `<math.h>` 里有没有。取地址而不是调用 —— 不受"是宏还是函数"影响。 */
const hasFn = (name, type = 'double (*)(double)') => probe(
  `#include <math.h>\n${type.replace('(*)', `(*p_${name})`)} = ${name};\n`,
);

const defs = [];
const yes = (name, v = 1) => defs.push({ name, v });
const note = [];

/* ---- IEEE 754。探不到当场报（见文件头）。 */
if (!probe('#include <math.h>\n#if !defined(__STDC_IEC_559__) && !defined(__APPLE__) && !defined(__linux__)\n#error no ieee\n#endif\nint x;\n')) {
  process.stderr.write(`gen-config.js: 这台机器探不出 IEEE 754 的浮点 —— nmath 会走非 IEEE 的旧路径，`
    + `那条路我们不要。要么这台机器真的不行，要么这格探针写窄了。\n`);
  process.exit(1);
}
yes('IEEE_754');

/* ---- C99 的那几个（R >= 3.5.0 要求，Rmath.h 自己也会补上默认值） */
for (const f of ['expm1', 'log1p', 'nearbyint', 'rint']) if (hasFn(f)) yes(`HAVE_${f.toUpperCase()}`);
if (hasFn('hypot', 'double (*)(double, double)')) yes('HAVE_HYPOT');

/* ---- `log1p` 在老 glibc 上对 -1 附近算不准，R 为此单列一格。能编就算它是好的 ——
       我们**没有**运行期探针（那要跑一遍，而生成头这一步不许跑目标代码）。 */
if (defs.some((d) => d.name === 'HAVE_LOG1P')) yes('HAVE_WORKING_LOG1P');
if (hasFn('log1pl', 'long double (*)(long double)')) yes('HAVE_LOG1PL');

/* ---- `isfinite` 在某些平台上对 long double 是坏的，R 为此单列一格 */
if (probe('#include <math.h>\nint f(double x){return isfinite(x);}\n')) yes('HAVE_WORKING_ISFINITE');

/* ---- long double（nmath 的 `LDOUBLE` 用它攒和） */
if (probe('long double x = 1.0L; int y = sizeof(long double);\n')) yes('HAVE_LONG_DOUBLE');

/* ---- C23 的 `sinpi` 一族与 Apple 的 `__sinpi` 一族（R 两边都认） */
for (const f of ['sinpi', 'cospi', 'tanpi', 'atanpi']) if (hasFn(f)) yes(`HAVE_${f.toUpperCase()}`);
for (const f of ['__sinpi', '__cospi', '__tanpi']) if (hasFn(f)) yes(`HAVE_${f.toUpperCase()}`);

/* ---- 可见性属性（nmath 的 `attribute_hidden`） */
if (probe('__attribute__((visibility("hidden"))) int f(void){return 0;}\n')) yes('HAVE_VISIBILITY_ATTRIBUTE');

rmSync(scratch, { recursive: true, force: true });

const text = `/* ext/r/rt/gen-config.js 生成 —— 不要手改。
 *
 * 这一份是 R 的 \`src/nmath\` 要的那个 \`config.h\`（三份 .c 明写 #include <config.h>）。
 * 里头每一格都是**在这台机器上探出来的**（拿 ${cc} 试编一段小程序），不是抄别人的
 * 构建结果。名单来自 \`grep -o 'HAVE_[A-Z_0-9]*' r-source/src/nmath/*\` —— 只探它真问到的。
 *
 * 探针 ${probes} 次，定下 ${defs.length} 格。
 */
#ifndef OMNI_R_CONFIG_H
#define OMNI_R_CONFIG_H

${defs.map((d) => `#define ${d.name} ${d.v}`).join('\n')}

#endif /* OMNI_R_CONFIG_H */
`;

/* 内容一样就不写 —— ninja 的 `restat` 靠这一格把"头没变"传下去，避免白重编 120 份 .c。 */
if (existsSync(out) && readFileSync(out, 'utf8') === text) {
  process.stdout.write(`config.h 没变（${defs.length} 格）\n`);
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
process.stdout.write(`config.h ${defs.length} 格（探了 ${probes} 次）\n`);
