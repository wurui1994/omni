#!/usr/bin/env node
// ext/python/rt/gen-pyshim.js —— **把 `struct Bigint` 与 `struct _dtoa_state` 从 CPython
// 自己那份头里原样切出来**，拼成 dtoa.c 能用的一份 `pycore_interp_structs.h`。
//
//   node ext/python/rt/gen-pyshim.js --src <cpython> --out <…/include/pycore_interp_structs.h>
//
// ## 为什么是"切"而不是"抄"
//
// dtoa.c 把 Bigint 的空闲链与"5 的幂"缓存挂在解释器状态上，所以它要
// `struct Bigint` 与 `struct _dtoa_state` 的**真实布局**。而真正的
// `pycore_interp_structs.h` 有一千行，后面跟着整个对象层。
//
// 手抄那两个结构是最省事的办法，也是最会出事的办法：它们一变（`Bigint_Kmax` 改过、
// `PRIVATE_MEM` 改过），抄的那份还是老的，而症状是**运行期越界**（预分配那块算小了），
// 离根因很远。所以这儿按标记切一段出来 —— 切不到就当场报，不猜。
//
// 这与 R 那一门"要编哪些 .c 从 R 自己的 Makefile 里读"是同一条纪律。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i < 0 || i + 1 >= argv.length ? null : argv[i + 1];
};
const SRC = argOf('--src');
const OUT = argOf('--out');
if (SRC === null || OUT === null) {
  process.stderr.write('用法：gen-pyshim.js --src <cpython 树> --out <pycore_interp_structs.h>\n');
  process.exit(2);
}

const HDR = join(SRC, 'Include/internal/pycore_interp_structs.h');
if (!existsSync(HDR)) {
  process.stderr.write(`gen-pyshim.js: 找不到 ${HDR}\n`);
  process.exit(1);
}

const lines = readFileSync(HDR, 'utf8').split('\n');

/* 头一行是 `struct`（`Bigint {` 在下一行 —— CPython 的排版），末一行是那一段的 `#endif`。 */
const from = lines.findIndex((l, i) => /^struct\s*$/.test(l) && /^Bigint\s*\{/.test(lines[i + 1] ?? ''));
if (from < 0) {
  throw new Error('gen-pyshim.js: 在 pycore_interp_structs.h 里找不到 `struct Bigint` 的开头'
    + ' —— 那份头的排版变了，这一格要跟着改（别手抄结构）');
}
const to = lines.findIndex((l, i) => i > from && /^#endif\s*\/\/\s*!Py_USING_MEMORY_DEBUGGER/.test(l));
if (to < 0) {
  throw new Error('gen-pyshim.js: 找不到 `#endif // !Py_USING_MEMORY_DEBUGGER`'
    + ' —— `struct _dtoa_state` 那一段的收尾标记变了');
}
const block = lines.slice(from, to + 1).join('\n');
if (!/struct _dtoa_state/.test(block) || !/Bigint_Pow5size/.test(block)) {
  throw new Error(`gen-pyshim.js: 切出来那一段里没有 struct _dtoa_state / Bigint_Pow5size（${to - from + 1} 行）`);
}

const text = `/* 生成物，别改。来源：Include/internal/pycore_interp_structs.h 第 ${from + 1}~${to + 1} 行
 * （由 ext/python/rt/gen-pyshim.js 原样切出来 —— 手抄会与那棵树分叉，症状是运行期越界）。
 *
 * 借来的 dtoa.c 要的只有这两个结构：\`struct Bigint\` 与 \`struct _dtoa_state\`。
 * 下面那格 PyInterpreterState 是**我们的**：只有 dtoa 那一个成员，因为 dtoa.c 只碰它。
 */
#ifndef OMNI_PY_SHIM_INTERP_STRUCTS_H
#define OMNI_PY_SHIM_INTERP_STRUCTS_H

#include <stdint.h>
#include "pycore_pymath.h"        /* _PY_SHORT_FLOAT_REPR —— 上面那段 #if 要它 */

${block}

struct _omni_py_interp {
    struct _dtoa_state dtoa;
};
typedef struct _omni_py_interp PyInterpreterState;

#endif /* OMNI_PY_SHIM_INTERP_STRUCTS_H */
`;

mkdirSync(dirname(OUT), { recursive: true });
/* 内容一样就不写 —— 配合 ninja 的 `restat`（不然每趟都会重编那两份 .c）。 */
if (existsSync(OUT) && readFileSync(OUT, 'utf8') === text) process.exit(0);
writeFileSync(OUT, text);
