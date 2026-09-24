#!/usr/bin/env node
// ext/r/rt/gen-rmath.js —— `Rmath.h0.in` → `Rmath.h`：R 自己的 configure 做的那一步
//
// `r-source/src/include/Rmath.h0.in` 是模板，两处 `@…@` 由 configure 替掉。我们自己替，
// 理由有两条，第二条才是要紧的：
//
//   1. 参考树没配置过，所以树里没有 `Rmath.h`。
//   2. **本机装的那个 R 的 `Rmath.h` 不能用**：它是 4.6.1 的，而 4.7.0 的四份 bessel
//      要 `M_bessel_j_max_alpha` / `M_bessel_y_max_alpha` / `M_bessel_ik_max_alpha`
//      （`bessel_i.c:29` 的注释明写 "set in Rmath.h ... new (for R 4.7.0)"）。
//      拿旧头编新源码，症状是那四份 `use of undeclared identifier` —— 而"照模板生成"
//      一次解决：**头与源码出自同一棵树**。
//
// 这就是这条路的整个立场：**我们不带一个 R，也不借别人编好的东西** —— 输入只有那棵
// 源码树与一台 C 编译器。
//
//   node ext/r/rt/gen-rmath.js --src <r-source> --out <path>

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const src = argOf('src', null);
const out = argOf('out', null);
if (src === null || out === null) {
  process.stderr.write('gen-rmath.js: 要 --src <r-source> 与 --out <path>\n');
  process.exit(2);
}

const tpl = join(src, 'src/include/Rmath.h0.in');
if (!existsSync(tpl)) {
  process.stderr.write(`gen-rmath.js: 模板不在：${tpl}\n`);
  process.exit(1);
}

/* 版本号：那棵树的 `VERSION` 第一行的第一段（`4.7.0 Under development (unstable)` → `4.7.0`）。
   它只进 `R_VERSION_STRING`，不影响代码 —— 但要是哪天对不上，`Rmath.h` 里那个串会当场说出来。 */
const verFile = join(src, 'VERSION');
const version = existsSync(verFile)
  ? (readFileSync(verFile, 'utf8').split('\n')[0] ?? '').trim().split(/\s+/)[0]
  : '0.0.0';

/* `@RMATH_HAVE_WORKING_LOG1P@` 在 configure 里是"好就发一行 #define，坏就发空"。
   我们这边这件事已经由 `gen-config.js` 探过并写进 `config.h` 了（而 `config.h` 先被
   包含），所以这儿发一行**带守卫**的默认值就行 —— 两处说法不会打架。 */
const SUBST = new Map([
  ['PACKAGE_VERSION', version],
  ['RMATH_HAVE_WORKING_LOG1P', '#define HAVE_WORKING_LOG1P 1'],
]);

const raw = readFileSync(tpl, 'utf8');
const left = new Set();
const body = raw.replace(/@([A-Z_0-9]+)@/g, (m, name) => {
  if (SUBST.has(name)) return SUBST.get(name);
  left.add(name);
  return m;
});
/* 模板里多出一格不认识的 `@…@` 就当场报。**不许留着** —— 留着的话它会以字面量的样子
   进到 C 里，而那时报的错是"@FOO@ 附近语法错误"，离根因很远。 */
if (left.size > 0) {
  process.stderr.write(`gen-rmath.js: 模板里这几格没有替法：${[...left].join(' ')}\n`
    + '（那棵树的 configure.ac 加了新的替换点 —— 在 SUBST 里补上它）\n');
  process.exit(1);
}

const text = `/* ext/r/rt/gen-rmath.js 从 ${tpl.replace(src, '<r-source>')} 生成 —— 不要手改。 */\n${body}`;

if (existsSync(out) && readFileSync(out, 'utf8') === text) {
  process.stdout.write(`Rmath.h 没变（R ${version}）\n`);
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
process.stdout.write(`Rmath.h 生成（R ${version}，替了 ${SUBST.size} 格）\n`);
