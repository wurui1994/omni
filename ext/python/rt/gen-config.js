#!/usr/bin/env node
// ext/python/rt/gen-config.js —— **生成 `Modules/config.c`**（构建系统那一步，我们自己站着做）
//
//   node ext/python/rt/gen-config.js --src <cpython> --out .omni-cache/py-rt/gen/config.c
//
// ## 为什么要有这一份
//
// `Modules/config.c` 在借来的那棵树里**压根不存在**（`scope.js` 的 `GENERATED` 记着它）：
// CPython 的 `makesetup` 照 `Modules/config.c.in` 现生成一份，把「哪些模块静态编进解释器」
// 那张表填进去。少了它，`_PyImport_Inittab` 没有定义 —— 链接那把尺子（`py:link`）报的
// 就是这一个符号。
//
// ## 口径
//
//   * 模板照 `Modules/config.c.in` **读**（两个 `ADDMODULE MARKER` 是 makesetup 的插入点）；
//   * 模块名照 `Modules/Setup.bootstrap.in` **读**（`scope.js` 的 `coreModuleNames` ——
//     与 `py:sweep` 量哪几份 `.c` 同一份名单，少一格就对不上）；
//   * 每个模块两行：marker 1 处一条 `extern PyObject* PyInit_<名字>(void);`、
//     marker 2 处一行 `{"<名字>", PyInit_<名字>},`。这正是 makesetup 干的事
//     （`Modules/makesetup` 里那两段 sed）。
//   * 模板里本来就写好的那几条（`marshal` / `_imp` / `builtins` / `sys` / `gc` …）
//     **一个字不改** —— 它们不是"模块行"，是 CPython 自己钉在表里的。
//     所以名单里若与它们重名（`gc` 就在 `Setup.bootstrap.in` 里），要去重，
//     不然 `_PyImport_Inittab` 里同一个名字出现两遍。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { coreModuleNames } from './scope.js';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i < 0 || i + 1 >= argv.length ? d : argv[i + 1];
};
const SRC = argOf('--src', process.env.OMNI_CPYTHON
  ?? join(homedir(), 'Documents', 'Lang', 'reference', 'cpython'));
const OUT = argOf('--out', null);
if (OUT === null) {
  process.stderr.write('gen-config: 要 --out <config.c>\n');
  process.exit(2);
}

const tplPath = join(SRC, 'Modules', 'config.c.in');
let tpl = readFileSync(tplPath, 'utf8');
const M1 = '/* -- ADDMODULE MARKER 1 -- */';
const M2 = '/* -- ADDMODULE MARKER 2 -- */';
for (const m of [M1, M2]) {
  if (!tpl.includes(m)) {
    process.stderr.write(`gen-config: ${tplPath} 里找不到 \`${m}\` —— 那份模板的形状变了\n`);
    process.exit(1);
  }
}

/* 模板里已经钉着的那些名字（`{"marshal", …}` 一族）不再加一遍 */
const already = new Set([...tpl.matchAll(/\{"([^"]+)",/g)].map((m) => m[1]));
const names = coreModuleNames(SRC).filter((n) => !already.has(n));

const externs = names.map((n) => `extern PyObject* PyInit_${n}(void);`).join('\n');
const entries = names.map((n) => `    {"${n}", PyInit_${n}},`).join('\n');

tpl = tpl.replace(M1, externs).replace(M2, entries);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, tpl);
process.stdout.write(`gen-config: ${OUT} —— ${names.length} 个静态模块`
  + `（模板里已有 ${already.size} 条，没动）\n`);
