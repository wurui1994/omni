#!/usr/bin/env node
// ext/python/build.js —— **借 CPython 的 C**：拿 cpython 的源码与一台 C 编译器编出 `libomnipy`
//
//   omni ninja -f ext/python/build.js            # 或者直接 node ext/python/build.js
//   omni ninja -f ext/python/build.js -t dirty   # 谁脏、为什么
//   omni ninja -f ext/python/build.js --emit-ninja > /tmp/py.ninja
//
// ## 借哪一半、不借哪一半
//
// 这一门的架构线（`ext/python/SPEC.md` §一）：**解析与执行归我们，运行时借 CPython 的 C**。
// 借的是那些"位对位才算对、重写要一年"的东西；不借 `Parser/`、`compile.c`、`ceval.c`、
// `import.c` —— 那四格是"解析和执行走我们"那句话的具体内容。
//
// 这一刀借的是第一批，也是最先撞上的那一格：**浮点与串之间的转换**。
//   `Python/dtoa.c`     —— David Gay 的正确舍入 strtod/dtoa（2841 行）
//   `Python/pystrtod.c` —— CPython 的 repr 排版规则（1286 行）
// 两份**一个字都不改**。`repr(0.1)` 要印 `0.1`、`repr(1e15)` 要印 `1000000000000000.0`、
// `repr(1e16)` 要印 `1e+16` —— 这三条门槛自己写一遍，"大多数值对"在这条链上等于没做。
//
// ## 三条纪律（照 R 那一门 `ext/r/build.js` 的账）
//
//   1. **输入只有那棵源码树与一台 C 编译器。** 不借本机装的那个 python 的任何东西
//      （它的版本与那棵树不是一个）。配置宏自己探（`rt/gen-pyconf.js`）。
//   2. **不重写 CPython 已经写好的那部分。** `Py_DTSF_*` 用它的公开头、
//      `_PY_SHORT_FLOAT_REPR` 用它的 `pycore_pymath.h`、`struct Bigint` 由
//      `rt/gen-pyshim.js` 从它的头里**原样切出来**。我们只加两格 configure 替不了的事：
//      探本机（`gen-pyconf.js`）与垫一层地板（`rt/shim/Python.h`）。
//   3. **路径在造图的时候就都是绝对的**，输出目录在 `run()` 之前 mkdir 好（ninja 自己不建目录）。

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Build } from '../../src/core/build/api.js';
import { refDir } from '../../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PYSRC = refDir('cpython', 'CPYTHON_SRC');
const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';

/** 产物落在缓存根下 —— 与别的原生库（`.omni-cache/gl/`、`r-rt/`）一个地方。 */
const OUT = join(ROOT, '.omni-cache', 'py-rt');
const GEN = join(OUT, 'include');   // 两份生成出来的头（**排在包含路径最前**）
const OBJ = join(OUT, 'obj');
const SO = process.platform === 'darwin' ? '.dylib' : '.so';
export const LIB = join(OUT, `libomnipy${SO}`);
export const PROBE = join(OUT, 'pyfloat-probe');

if (!existsSync(join(PYSRC, 'Python/dtoa.c'))) {
  process.stderr.write(`ext/python/build.js: 参考树不在：${PYSRC}\n`
    + '（`CPYTHON_SRC=<路径>` 或 `OMNI_REF_DIR=<那几棵树的父目录>`）\n');
  process.exit(1);
}

/** 借来的那几份（**这张表与 `rt/gen-pyconf.js` 的 SOURCES 一起改** —— 探针名单跟着它算）。 */
const BORROWED = ['Python/dtoa.c', 'Python/pystrtod.c'];
/** 我们自己那几格（一眼能看出哪些代码是谁的）。 */
const OURS = [
  { name: 'omni_pyfloat.c', path: join(HERE, 'rt/omni_pyfloat.c') },
];

for (const d of [GEN, OBJ]) mkdirSync(d, { recursive: true });

const b = new Build();

/* ---- 两份生成出来的头 -----------------------------------------------------
 * 都挂 `restat`：内容没变就把"它没变"传下去，下游不白重编
 * （两个生成器自己也做了"内容一样就不写"那一半 —— 两边都要有，restat 看的是 mtime）。 */

const PYCONF_H = join(GEN, 'omni_pyconf.h');
const STRUCTS_H = join(GEN, 'pycore_interp_structs.h');

b.rule('genpyconf', {
  command: `node ${join(HERE, 'rt/gen-pyconf.js')} --src ${PYSRC} --out $out --cc ${CC}`,
  description: '探本机 -> omni_pyconf.h',
  restat: 'true',
});
b.rule('genpyshim', {
  command: `node ${join(HERE, 'rt/gen-pyshim.js')} --src ${PYSRC} --out $out`,
  description: '切 struct Bigint -> pycore_interp_structs.h',
  restat: 'true',
});

b.build(PYCONF_H, 'genpyconf', [], {
  implicit: [join(HERE, 'rt/gen-pyconf.js'), join(PYSRC, 'pyconfig.h.in')],
});
b.build(STRUCTS_H, 'genpyshim', [], {
  implicit: [join(HERE, 'rt/gen-pyshim.js'), join(PYSRC, 'Include/internal/pycore_interp_structs.h')],
});

/* ---- 编译与链接 -----------------------------------------------------------
 * `-I` 的次序要紧，从紧到松：
 *   1. 生成出来的那两份（`omni_pyconf.h` / `pycore_interp_structs.h`）；
 *   2. 我们垫的那层地板（`shim/Python.h` / `shim/pycore_pystate.h`）；
 *   3. CPython 自己的 `Include/` 与 `Include/internal/` —— 凡是它有的都走它。
 * 这样 `#include <Python.h>` 拿到的是我们那份，而 `#include "pycore_pymath.h"`
 * 拿到的是 CPython 那份。 */
const incs = ['-I', GEN, '-I', join(HERE, 'rt'), '-I', join(HERE, 'rt/shim'),
  '-I', join(PYSRC, 'Include'), '-I', join(PYSRC, 'Include/internal')];
const cflags = ['-O2', '-std=c11', '-w', '-fPIC', ...incs].join(' ');

b.set('cflags', cflags);
b.rule('cc', { command: `${CC} $cflags -c $in -o $out`, description: 'CC $out' });
b.rule('dylib', {
  command: `${CC} ${process.platform === 'darwin' ? `-dynamiclib -install_name ${LIB}` : '-shared'} -o $out $in -lm`,
  description: 'LINK $out',
});
b.rule('exe', { command: `${CC} $cflags -o $out $in -lm`, description: 'LINK $out' });

const objs = [];
for (const rel of BORROWED) {
  const stem = rel.split('/').pop().replace(/\.c$/, '');
  const o = join(OBJ, `${stem}.o`);
  objs.push(o);
  /* 两份生成出来的头挂 `implicit`：它们不进 `$in`，可它们一变就得重编。
     真正的逐头依赖（`depfile`）这套引擎还没实现，所以取"全体挂那两份"这个保守口径 ——
     代价是改一格探针会重编这几份（不到一秒），换来的是**不会漏**。 */
  b.build(o, 'cc', join(PYSRC, rel), { implicit: [PYCONF_H, STRUCTS_H] });
}
for (const s of OURS) {
  const o = join(OBJ, `${s.name.replace(/\.c$/, '')}.o`);
  objs.push(o);
  b.build(o, 'cc', s.path, { implicit: [PYCONF_H, STRUCTS_H, join(HERE, 'rt/omni_pyfloat.h')] });
}

b.build(LIB, 'dylib', objs);
/* 尺子用的那格小程序（`tests/python/rt.js` 跑它，与 python3 的 repr 逐字节比）。 */
b.build(PROBE, 'exe', [join(HERE, 'rt/pyfloat-probe.c'), ...objs], {
  implicit: [PYCONF_H, STRUCTS_H],
});
b.default(LIB, PROBE);

b.run(process.argv.slice(2));
