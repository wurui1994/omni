#!/usr/bin/env node
// ext/r/rt/lazyload.js —— 把 base 那几个包的 R 代码**转成 lazyload 库**（R 自己装包的最后一步）。
//
// ## 为什么必须有这一步
//
// `loadNamespace()` 的头一件事是 `sys.source(library/<pkg>/R/<pkg>)`
// （`base/R/namespace.R` 第 567 行），也就是说**那一份文件放的是源码就每次都重新求值一遍**。
// R 自己装包时不会停在这儿：`share/make/basepkg.mk` 的 `mklazy` 之后，
// `R/<pkg>` 会被换成 `share/R/nspackloader.R` 那个十行的桩（它 `lazyLoad(dbbase, ns)`），
// 真正的代码进 `R/<pkg>.rdb`。
//
// 少了这一步，两件事量出来是坏的（2026-09-26）：
//
//   * **stdout 不干净**。`methods` 的 `.onLoad` 在源码里是 `...onLoad`（`methods/R/zzz.R`
//     第 32 行 `cat("initializing class and method definitions ...")`）—— 它本是"装好之后
//     只跑一次"的引导版，跑完会把 `.onLoad` 换成安静的 `..onLoad` 并 `makeLazyLoadDB` 存下来。
//     源码形态下那次保存**没人读**，于是**每一趟**都走引导版、每一趟都往 stdout 印那一行。
//     而 libR 是编译器那一档接不住时的退路 —— 它的 stdout 就是用户要的输出，多一行
//     就是"退了档还答错"。
//   * **慢**。同一件事还要重跑整套 S4 类引导、再写一遍 593KB 的 .rdb：
//     `library(stats); library(grid)` 从 1.51s 降到 0.59s（量出来的）。
//
// ## 三格特例（都照 R 自己的 makefile）
//
//   * `tools`：不能 `tools:::makeLazyLoading("tools")` —— 那要先加载 tools 的命名空间，
//     而 `code2LazyLoadDB` 的第一句就是"命名空间不许已经加载"。R 的办法是**把那份
//     `makeLazyLoad.R` 直接喂进全局环境**再调（`tools/Makefile.in` 第 64..68 行）。
//   * `methods`：`makeLazyLoading` 走的是 `loadNamespace(partial=TRUE)`，而 partial 在
//     跑 `.onLoad` 之前就返回了（`namespace.R` 第 585 行）—— 存下来的 `.onLoad` 还是吵的
//     那一版。R 的办法是**整整加载一趟**（引导版自己会写 .rdb），然后换桩
//     （`methods/Makefile.in` 第 52..56 行）。加载之前要**先把 `tools` 与 `utils` 拉起来**：
//     引导版在 `cat(" done\n")` 之前就把 `is` / `as` / `new` 那几格从 methods 的导出表里
//     删了（`zzz.R` 第 90 行），而它最后一句 `tools:::makeLazyLoadDB` 要现加载 tools ——
//     那时再去要 `is` 就报 `'is' is not an exported object from 'namespace:methods'`
//     （量出来的：先 `loadNamespace("tools")` 与 `loadNamespace("utils")` 就过了）。
//   * `stats4`：要带着 `methods,graphics,stats` 加载（`stats4/Makefile.in` 第 19 行）。
//
// 已经是桩了就跳过（判据与 R 一样：文件大小与 `nspackloader.R` 相同）——
// 所以这一步**可以重复跑**。
//
// 用法：node ext/r/rt/lazyload.js --src <r-source> --home <R_HOME> --pkgs a,b,c

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
const SRC = arg('--src', null);
const HOME = arg('--home', null);
const PKGS = (arg('--pkgs', '') || '').split(',').filter((s) => s !== '');
if (SRC === null || HOME === null || PKGS.length === 0) {
  process.stderr.write('用法：lazyload.js --src <r-source> --home <R_HOME> --pkgs a,b,c\n');
  process.exit(2);
}
const RBIN = join(HOME, 'bin/exec/R');
const LOADER = join(HOME, 'share/R/nspackloader.R');

/** 跑一趟我们自己的 R。`defpkgs` 是 `R_DEFAULT_PACKAGES`（R 的 makefile 里那个 `DEFPKGS`）。 */
const runR = (code, defpkgs, stdin) => spawnSync(RBIN, ['--vanilla', '--no-echo', ...(stdin === undefined ? ['-e', code] : [])], {
  encoding: 'utf8',
  input: stdin,
  env: {
    ...process.env,
    R_HOME: HOME,
    R_ENABLE_JIT: '0',
    R_COMPILE_PKGS: '0',
    R_DISABLE_BYTECODE: '1',
    R_DEFAULT_PACKAGES: defpkgs,
    TZDIR: process.env.TZDIR ?? '/usr/share/zoneinfo',
    LC_ALL: 'C',
  },
});

const die = (p, r) => {
  process.stderr.write(`lazyload: ${p} 转不动（退出码 ${r.status}）\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  process.exit(1);
};
const loaderSize = statSync(LOADER).size;
for (const p of PKGS) {
  const code = join(HOME, 'library', p, 'R', p);
  /* 没有 R 代码的包（`datasets`）没这一步。 */
  if (!existsSync(code)) continue;
  if (statSync(code).size === loaderSize) { process.stdout.write(`lazyload: ${p} 已经是桩了\n`); continue; }
  if (p === 'tools') {
    const boot = readFileSync(join(SRC, 'src/library/tools/R/makeLazyLoad.R'), 'utf8');
    const r = runR(null, 'NULL', `${boot}\nmakeLazyLoading("tools")\n`);
    if (r.status !== 0) die(p, r);
  } else if (p === 'methods') {
    const r = runR('invisible(loadNamespace("tools")); invisible(loadNamespace("utils"));'
      + ' invisible(loadNamespace("methods"))', 'NULL');
    if (r.status !== 0) die(p, r);
    const cp = spawnSync('cp', [LOADER, code], { encoding: 'utf8' });
    if (cp.status !== 0) die(p, cp);
  } else {
    const r = runR(`tools:::makeLazyLoading('${p}')`, p === 'stats4' ? 'methods,graphics,stats' : 'NULL');
    if (r.status !== 0) die(p, r);
  }
  if (statSync(code).size !== loaderSize) {
    process.stderr.write(`lazyload: ${p} 转完了却还不是桩（${statSync(code).size} 字节）\n`);
    process.exit(1);
  }
  process.stdout.write(`lazyload: ${p} -> 桩 + .rdb\n`);
}
