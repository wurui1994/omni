#!/usr/bin/env node
// ext/r/build-libR.js —— **libR**：把 r-source 的 C / Fortran 编成一份我们自己的 `libR.dylib`，
// 再搭一个能跑的 `R_HOME`（base 按**源码**装，不字节码编译 —— 见 ADR-0046）。
//
//   node ext/r/build-libR.js          # 或 omni ninja -f ext/r/build-libR.js
//   node ext/r/build-libR.js -t dirty
//
// 与 `ext/r/build.js` 的分工：那一份编 `libomniRmath`（编译器那一档要的数值库），
// 这一份编 libR（能装 CRAN、能画图那一档）。两档的判据不同，所以分两个文件。
//
// ## 三条纪律（与 build.js 同一条，只是规模大了十倍）
//
//   1. **输入只有那棵源码树 + clang + gfortran。** 本机装的那个 R 一格都不借。
//   2. **要编哪些文件从 R 自己的 Makefile.in 里读**（`SOURCES_C` / `SOURCES_F` / …），
//      不在这儿抄名单 —— 抄的那份会与树分叉，而症状是"链接时少一个符号"。
//   3. configure 的活分三格自己做：`config.h` 探本机（`rt/gen-rconfig.js`）、
//      `Rconfig.h` / `Rversion.h` 跑 R 自己的 `tools/GETCONFIG` 与 `tools/GETVERSION`、
//      `Rmath.h` 替模板（`rt/gen-rmath.js`）。
//
// ## macOS 上这一版的口径（都写在 gen-rconfig.js 那张表里）
//
//   * BLAS / LAPACK 走 **Accelerate.framework**；tre / tzone 用树里自带的那份
//   * quartz（AppKit）留着，X11 / cairo / ICU / NLS / OpenMP 不开
//   * base 装成**源码**（`library/base/R/base` 是 all.R **加上 `baseloader.R` 的尾巴**
//     —— 那条尾巴里的 `.C_*` 原生符号对象是 `addTaskCallback()` 的命根子，见 `mkbase`）
//     —— R 自己那个用 R 写的字节码编译器我们不要，所以跑的时候 `R_ENABLE_JIT=0`

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Build } from '../../src/core/build/api.js';
import { refDir } from '../../tests/lib/refsrc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RSRC = refDir('r-source', 'R_SRC');
const CC = process.env.OMNI_CLANG ?? process.env.CC ?? 'clang';
const FC = process.env.OMNI_GFORTRAN ?? process.env.FC ?? 'gfortran';

const OUT = join(ROOT, '.omni-cache', 'r-rt', 'libR');
const GEN = OUT;                       // 生成出来的头就摆在根上（`-I` 排最前）
const OBJ = join(OUT, 'o');
const HOME = join(OUT, 'home');        // 我们自己的 R_HOME
export const LIBR = join(OUT, `libR${process.platform === 'darwin' ? '.dylib' : '.so'}`);
export const RBIN = join(OUT, 'R.bin');
export const R_HOME = HOME;

if (!existsSync(join(RSRC, 'src/main/Makefile.in'))) {
  process.stderr.write(`ext/r/build-libR.js: 参考树不在：${RSRC}\n`);
  process.exit(1);
}

/* ─── 名单从 R 的 Makefile.in 里读 ─────────────────────────────────────── */

/** 读一格 make 变量（续行接起来），回文件名数组。`opt` 为真时"没有这一格"回空数组
    —— `SOURCES_M` 只有 grDevices 有，`SOURCES_F` 也不是每个包都写。 */
function mkVar(path, name, ext, opt = false) {
  const text = readFileSync(path, 'utf8');
  const m = new RegExp(`^${name}\\s*=([\\s\\S]*?)\\n[A-Za-z_@]`, 'm').exec(text);
  if (m === null) {
    if (opt) return [];
    throw new Error(`build-libR: ${path} 里读不到 ${name}`);
  }
  return m[1].replace(/\\\n/g, ' ').trim().split(/\s+/).filter((s) => s.endsWith(ext));
}

/** 目录里第一份真文件的相对路径（深度优先、名字排序）—— 给 `inst/` 那几条边当输出。 */
function firstFile(dir, rel = '') {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isFile()) return rel === '' ? e.name : `${rel}/${e.name}`;
  }
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) {
      const f = firstFile(join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
      if (f !== null) return f;
    }
  }
  return null;
}

/* src/main：`SOURCES_C` 那 105 份。**四份只被 include 的不在里头**（`machar.c` /
   `qsort-body.c` / `split-incl.c` / `xspline.c` 本来就没进 SOURCES_C），
   而 `EXTRA_SOURCES_C`（alloca / mkdtemp / strdup / strncasecmp）是 `@LIBOBJS@` 那一格 ——
   macOS 上这四个函数都有，所以一份都不编（configure.ac 第 2292 行的 AC_REPLACE_FUNCS）。 */
const mainC = mkVar(join(RSRC, 'src/main/Makefile.in'), 'SOURCES_C', '.c');
const mainF = mkVar(join(RSRC, 'src/main/Makefile.in'), 'SOURCES_F', '.f');
const applC = mkVar(join(RSRC, 'src/appl/Makefile.in'), 'SOURCES_C', '.c');
const applF = mkVar(join(RSRC, 'src/appl/Makefile.in'), 'SOURCES_F', '.f');
const unixC = mkVar(join(RSRC, 'src/unix/Makefile.in'), 'SOURCES_C_BASE', '.c');
const nmathC = mkVar(join(RSRC, 'src/nmath/Makefile.in'), 'SOURCES', '.c');
const treC = mkVar(join(RSRC, 'src/extra/tre/Makefile.in'), 'SOURCES', '.c');
/* tzone：只有这两份（`registryTZ.c` 是 Windows 的）。 */
const tzC = ['localtime.c', 'strftime.c'];

/* 名单以那份 Makefile 为准（这一版读出 99 份）。阈值只是"形状没变"的哨兵：
   读成个位数那一定是正则跟那份 Makefile 走散了。 */
if (mainC.length < 90) throw new Error(`build-libR: src/main 只读出 ${mainC.length} 份，不像话`);

/* ─── 目录 ─────────────────────────────────────────────────────────────── */

for (const d of [GEN, OBJ, join(GEN, 'src/include'), join(HOME, 'lib'), join(HOME, 'etc'),
  join(HOME, 'library/base/R'), join(HOME, 'modules')]) mkdirSync(d, { recursive: true });
/* GETVERSION 认的是 `../../SVN-REVISION`（相对 CWD），所以它得在 <GEN>/src/include 里跑，
   而这一份文件摆在 <GEN> 上。参考树是个 git 检出、没有那份文件，所以我们自己写一份。 */
writeFileSync(join(GEN, 'SVN-REVISION'), 'Revision: 99999\nLast Changed Date: 2026-01-01\n');

const b = new Build();

/* ─── 四份生成出来的头 ─────────────────────────────────────────────────── */

const CONFIG_H = join(GEN, 'config.h');
const RCONFIG_H = join(GEN, 'Rconfig.h');
const RVERSION_H = join(GEN, 'Rversion.h');
const RMATH_H = join(GEN, 'Rmath.h');

b.rule('genrconfig', {
  command: `node ${join(HERE, 'rt/gen-rconfig.js')} --src ${RSRC} --out $out --cc ${CC}`,
  description: '探本机 -> 整份 config.h',
  restat: 'true',
});
b.rule('getconfig', {
  command: `cd ${GEN} && sh ${join(RSRC, 'tools/GETCONFIG')} > $out`,
  description: 'R 的 GETCONFIG -> Rconfig.h',
  restat: 'true',
});
b.rule('getversion', {
  command: `cd ${join(GEN, 'src/include')} && sh ${join(RSRC, 'tools/GETVERSION')} > $out`,
  description: 'R 的 GETVERSION -> Rversion.h',
  restat: 'true',
});
b.rule('genrmath', {
  command: `node ${join(HERE, 'rt/gen-rmath.js')} --src ${RSRC} --out $out`,
  description: 'Rmath.h0.in -> Rmath.h',
  restat: 'true',
});

b.build(CONFIG_H, 'genrconfig', [], {
  implicit: [join(HERE, 'rt/gen-rconfig.js'), join(RSRC, 'src/include/config.h.in')],
});
b.build(RCONFIG_H, 'getconfig', [CONFIG_H], { implicit: [join(RSRC, 'tools/GETCONFIG')] });
b.build(RVERSION_H, 'getversion', [join(RSRC, 'VERSION')], {
  implicit: [join(RSRC, 'tools/GETVERSION'), join(GEN, 'SVN-REVISION')],
});
b.build(RMATH_H, 'genrmath', [join(RSRC, 'src/include/Rmath.h0.in')], {
  implicit: [join(HERE, 'rt/gen-rmath.js')],
});
const HEADERS = [CONFIG_H, RCONFIG_H, RVERSION_H, RMATH_H];

/* ─── 编译 ─────────────────────────────────────────────────────────────── */

const INC = [GEN, join(RSRC, 'src/include'), join(RSRC, 'src/nmath'), join(RSRC, 'src/extra'),
  '/opt/homebrew/include'].map((p) => `-I${p}`).join(' ');
const CFLAGS = `-O2 -w -std=gnu17 -fPIC -DHAVE_CONFIG_H ${INC}`;

b.rule('cc', { command: `${CC} ${CFLAGS} $extra -c $in -o $out`, description: 'CC $out' });
b.rule('fc', { command: `${FC} -O2 -fPIC -c $in -o $out`, description: 'FC $out' });

const objs = [];
/** 一格 C：`extra` 给那几处要额外 `-I` 的（tre / tzone / unix）。 */
const cc = (dir, name, prefix, extra = '') => {
  const o = join(OBJ, `${prefix}${name.replace(/\.c$/, '')}.o`);
  objs.push(o);
  b.build(o, 'cc', join(RSRC, dir, name), { implicit: HEADERS, vars: extra === '' ? undefined : { extra } });
};
const fc = (dir, name, prefix) => {
  const o = join(OBJ, `${prefix}${name.replace(/\.f$/, '')}.o`);
  objs.push(o);
  b.build(o, 'fc', join(RSRC, dir, name));
};

for (const n of mainC) cc('src/main', n, 'main_');
for (const n of applC) cc('src/appl', n, 'appl_');
for (const n of nmathC) cc('src/nmath', n, 'nm_');
for (const n of treC) cc('src/extra/tre', n, 'tre_', `-I${join(RSRC, 'src/extra/tre')}`);
/* tzone 的两份要 `src/main` 上的 `datetime.h`（R 自己的 tzone/Makefile.in 第 21 行也是这么加的）。 */
for (const n of tzC) cc('src/extra/tzone', n, 'tz_', `-I${join(RSRC, 'src/extra/tzone')} -I${join(RSRC, 'src/main')}`);
for (const n of unixC) cc('src/unix', n, 'unix_', `-I${join(RSRC, 'src/unix')}`);
for (const n of mainF) fc('src/main', n, 'f_');
for (const n of applF) fc('src/appl', n, 'f_');

/* ─── 链接 ─────────────────────────────────────────────────────────────── */

/* BLAS / LAPACK 走 Accelerate（macOS 自带，所以树里那份 reference BLAS 与
   `src/modules/lapack` 都不编）。别的库都是这台机器上量到的（pcre2 / zlib / lzma /
   bz2 / curl / iconv / readline）。 */
const gfDir = process.platform === 'darwin' ? '-L/opt/homebrew/lib/gcc/current' : '';
const LIBS = `-framework Accelerate -L/opt/homebrew/lib ${gfDir} `
  + '-lpcre2-8 -lz -llzma -lbz2 -lcurl -liconv -lreadline -lgfortran -lm';
b.rule('dylib', {
  command: process.platform === 'darwin'
    ? `${CC} -dynamiclib -install_name $out -o $out $in ${LIBS}`
    : `${CC} -shared -o $out $in ${LIBS}`,
  description: 'LINK $out',
});
b.build(LIBR, 'dylib', objs);

/* `R.bin`：R 自己的入口（`src/main/Rmain.c`，它不在 SOURCES_C 里 —— 只链进 R.bin）。 */
b.rule('rbin', {
  command: `${CC} ${CFLAGS} $in -o $out ${LIBR} -framework Accelerate`,
  description: 'LINK $out',
});
b.build(RBIN, 'rbin', join(RSRC, 'src/main/Rmain.c'), { implicit: [LIBR, ...HEADERS] });

/* ─── R_HOME：base 按源码装 ─────────────────────────────────────────────── */

const BASE_R = join(HOME, 'library/base/R/base');
const BASE_PROFILE = join(HOME, 'library/base/R/Rprofile');
const BASE_DESC = join(HOME, 'library/base/DESCRIPTION');
const RENVIRON = join(HOME, 'etc/Renviron');
const BASEDIR = join(RSRC, 'src/library/base');
const PROFDIR = join(RSRC, 'src/library/profile');

/* `all.R`：按 `LC_COLLATE=C ls R/*.R R/unix/*.R` 的次序接起来，再替 `@WHICH@`
   （R 自己的 `share/make/basepkg.mk` 第 63..78 行 `mkRbase` 干的就是这两件事）。
   **次序要紧** —— base 里有些定义依赖前面已经存在的东西。

   后面还要**接上 R 自己 `baseloader.R` 的尾巴**（从 `## populate C/Fortran symbols`
   到文件末）。R 正经的构建里 `library/base/R/base` 装的是 `baseloader.R`（懒加载那一条），
   而我们装的是 all.R —— 于是 `baseloader.R` 里**只在那儿**做的三件事全丢了：

     1. `getDLLRegisteredRoutines("base")` 把 `.C_*` / `.F_*` 那批**原生符号对象**
        摆进 base 的命名空间。少了它 `addTaskCallback()` 一调就报
        `object '.C_R_addTaskCallback' not found` —— 而 `cli` 的 `.onLoad` 正好调它，
        于是 `cli` 半死、接着 `'ansi_show_cursor' is not an exported object` 一路报下去
        （量出来的：`omni run ext/r/libr-demo/ggplot.R` 那四行 Error）。
     2. 把 `.S3_methods_table` 里那批 S3 方法包进 `.__S3MethodsTable__.`；
     3. 锁住 `.ArgsEnv` / `.GenericArgsEnv`。

   尾巴是**从 R 的源码里截出来的**，不手抄 —— 与 `rt/ffi.js` 那条纪律同一个理由。 */
b.rule('mkbase', {
  /* `xargs cat` 而不是 shell 的 for 循环：这条命令要过一遍 ninja 的模板展开，
     而那一层看见 `$f` 会当成变量名（展成空）。这儿一格 `$` 都不留 ——
     awk 那一段也是为了这个才不用 `sed -n '/…/,$p'`。 */
  command: `cd ${BASEDIR} && LC_COLLATE=C ls R/*.R R/unix/*.R | xargs cat `
    + '| sed -e "s:@WHICH@:/usr/bin/which:" > $out'
    + ` && awk '/^## populate C/{f=1} f' ${join(BASEDIR, 'baseloader.R')} >> $out`,
  description: 'base 的 all.R + baseloader 的尾巴 -> $out',
});
/* 系统 profile：`Common.R` + `Rprofile.unix` 接起来（`src/library/profile/Makefile.in` 第 19 行）。
   `.Library` 就是在这儿定的 —— 少了它 R 起不来。 */
b.rule('mkprofile', {
  command: `cat ${join(PROFDIR, 'Common.R')} ${join(PROFDIR, 'Rprofile.unix')} > $out`,
  description: 'Rprofile -> $out',
});
const SHORT_VER = readFileSync(join(RSRC, 'VERSION'), 'utf8').trim().split(' ')[0];
const PLATFORM = `${process.arch === 'arm64' ? 'aarch64' : process.arch}-apple-darwin`;
b.rule('mkdesc', {
  command: `sed -e "s/@VERSION@/${SHORT_VER}/" $in > $out && echo "Built: R ${SHORT_VER}; ; ; unix" >> $out`,
  description: 'base 的 DESCRIPTION -> $out',
});
/* `etc/Renviron`：模板里那些 `@…@` 是外部命令的路径。少了这一份 R 会印一句
   "cannot find system Renviron" 然后继续 —— 但那句话会混进每一趟输出里，
   而判据是"逐字节相同"，所以它得有。 */
const RENV_SED = [
  ['@R_GZIPCMD@', 'gzip'], ['@R_UNZIPCMD@', 'unzip'], ['@R_ZIPCMD@', 'zip'],
  ['@R_BZIPCMD@', 'bzip2'], ['@TAR@', 'tar'], ['@LN_S@', 'ln -s'], ['@MAKE@', 'make'],
  ['@SED@', 'sed'], ['@PAGER@', 'less'], ['@R_BROWSER@', 'open'], ['@R_PDFVIEWER@', 'open'],
  ['@R_PRINTCMD@', 'lpr'], ['@R_PAPERSIZE@', 'a4'], ['@R_RD4PDF@', 'times,inconsolata,hyper'],
  ['@TEXI2DVICMD@', 'texi2dvi'], ['@STRIP_SHARED_LIB@', 'strip -x'], ['@STRIP_STATIC_LIB@', 'strip -S'],
  ['@R_PLATFORM@', PLATFORM], ['@configure_input@', 'omni ext/r/build-libR.js'],
].map(([k, v]) => `-e "s:${k}:${v}:"`).join(' ');
b.rule('mkrenviron', {
  command: `sed ${RENV_SED} $in > $out`,
  description: 'Renviron -> $out',
});

b.build(BASE_R, 'mkbase', [], {
  implicit: [join(BASEDIR, 'R/zzz.R'), join(BASEDIR, 'baseloader.R')],
});
b.build(BASE_PROFILE, 'mkprofile', [], { implicit: [join(PROFDIR, 'Common.R'), join(PROFDIR, 'Rprofile.unix')] });
b.build(BASE_DESC, 'mkdesc', join(BASEDIR, 'DESCRIPTION.in'));
b.build(RENVIRON, 'mkrenviron', join(RSRC, 'etc/Renviron.in'));

/* ─── 别的基础包（tools / methods / stats / grid / …） ──────────────────── */

/**
 * 这一批与 base 不同：它们有 `NAMESPACE`、多半还有 `src/`（要编一份 `<pkg>.so`）。
 * 装法照 R 自己的两条路子：
 *   * R 代码：`R/*.R` + `R/unix/*.R` 按 `LC_COLLATE=C` 接成 `library/<pkg>/R/<pkg>`
 *     （与 base 的 `mkRbase` 同一条，只是不字节码编译）；
 *   * C / Fortran / Objective-C：名单从**那个包自己的 `src/Makefile.in`** 里读
 *     （`SOURCES_C` / `SOURCES_F` / `SOURCES_M`）—— 不这么读就会把
 *     `par-common.c`（只被 include 的）与 `devWindows.c`（Windows 的）也编进去；
 *   * `Meta/*.rds` 得**用 R 自己生成**（下面那两条 `tools:::.vinstall_*_as_RDS`）。
 *
 * `compiler` 这个包我们装、但**永不开**（`R_ENABLE_JIT=0`）：装它是因为别的包会
 * `compiler::cmpfun`，不开它是 ADR-0046 那条 —— 编译这件事是我们的活。
 */
const PKGS = ['tools', 'compiler', 'utils', 'methods', 'stats', 'graphics', 'grDevices',
  'grid', 'datasets', 'splines', 'stats4'];
/** 每个包额外要的链接参数（照它自己 `src/Makefile.in` 的 `PKG_LIBS`）。 */
const PKG_LIBS = {
  stats: '-framework Accelerate -L/opt/homebrew/lib/gcc/current -lgfortran',
  grDevices: '-framework AppKit -lz',
};

b.rule('ccpkg', { command: `${CC} ${CFLAGS} -I${join(RSRC, 'src/main')} $extra -c $in -o $out`, description: 'CC $out' });
b.rule('so', {
  command: `${CC} -dynamiclib -undefined dynamic_lookup -o $out $in $libs`,
  description: 'SO $out',
});
b.rule('mkpkgR', {
  command: 'cd $dir && LC_COLLATE=C ls $globs | xargs cat > $out',
  description: '$pkg 的 R 代码 -> $out',
});
b.rule('cp', { command: 'cp $in $out', description: 'CP $out' });
b.rule('mkpkgdesc', {
  command: `sed -e "s/@VERSION@/${SHORT_VER}/" $in > $out && echo "Built: R ${SHORT_VER}; ; ; unix" >> $out`,
  description: 'DESCRIPTION -> $out',
});

const pkgStamps = [];
for (const p of PKGS) {
  const S = join(RSRC, 'src/library', p);
  const D = join(HOME, 'library', p);
  for (const d of [join(D, 'R'), join(D, 'Meta'), join(D, 'libs')]) mkdirSync(d, { recursive: true });
  /* R 代码 */
  const rOut = join(D, 'R', p);
  const globs = existsSync(join(S, 'R/unix')) ? 'R/*.R R/unix/*.R' : 'R/*.R';
  if (existsSync(join(S, 'R'))) {
    b.build(rOut, 'mkpkgR', [], { vars: { dir: S, globs, pkg: p } });
    pkgStamps.push(rOut);
  }
  /* DESCRIPTION / NAMESPACE */
  const desc = join(D, 'DESCRIPTION');
  b.build(desc, 'mkpkgdesc', join(S, 'DESCRIPTION.in'));
  pkgStamps.push(desc);
  if (existsSync(join(S, 'NAMESPACE'))) {
    const ns = join(D, 'NAMESPACE');
    b.build(ns, 'cp', join(S, 'NAMESPACE'));
    pkgStamps.push(ns);
  }
  /* `<pkg>.so` */
  const mk = join(S, 'src/Makefile.in');
  if (!existsSync(mk)) continue;
  const objDir = join(OBJ, `pkg_${p}`);
  mkdirSync(objDir, { recursive: true });
  const pobjs = [];
  const add = (name, rule, extra) => {
    const o = join(objDir, `${name.replace(/\.[cfm]$/, '')}.o`);
    pobjs.push(o);
    b.build(o, rule, join(S, 'src', name), {
      implicit: HEADERS,
      vars: rule === 'ccpkg' ? { extra } : undefined,
    });
  };
  for (const n of mkVar(mk, 'SOURCES_C', '.c')) add(n, 'ccpkg', `-I${join(S, 'src')}`);
  for (const n of mkVar(mk, 'SOURCES_M', '.m', true)) add(n, 'ccpkg', `-I${join(S, 'src')}`);
  const fs2 = mkVar(mk, 'SOURCES_F', '.f', true);
  for (const n of fs2) add(n, 'fc');
  if (pobjs.length > 0) {
    const so = join(D, 'libs', `${p}.so`);
    b.build(so, 'so', pobjs, { vars: { libs: PKG_LIBS[p] ?? '' } });
    pkgStamps.push(so);
  }
}

/* 每个包的 `inst/` 要照搬进去 —— grDevices 的 `enc/` 与 `afm/` 就在那儿，
   少了它 `pdf()` 一开就报 "failed to load encoding file 'ISOLatin1.enc'"。 */
for (const p of PKGS) {
  const S = join(RSRC, 'src/library', p);
  if (!existsSync(join(S, 'inst'))) continue;
  /* 一个包一条规则：路径直接烤进命令里。走 `vars` 那条路在这儿会踩坑 ——
     `$out_dir` 被模板当成 `$out` 后面跟着字面量 `_dir`。 */
  b.rule(`cpinst_${p}`, {
    command: `cp -R ${join(S, 'inst')}/. ${join(HOME, 'library', p)}/ && touch $out`,
    description: `${p} 的 inst/ -> R_HOME`,
  });
  /* 输出要是**目标目录里的一份真文件**，不是 obj 下的印记 ——
     印记那种写法在"把 `home/` 整个删掉重建"时会被当成已经做过（量出来的：
     `enc/` 没抄过去，`pdf()` 又报 failed to load default encoding）。 */
  const first = firstFile(join(S, 'inst'));
  if (first === null) continue;
  b.build(join(HOME, 'library', p, first), `cpinst_${p}`, []);
  pkgStamps.push(join(HOME, 'library', p, first));
}

/* ─── `modules/lapack.so`：R 把 LAPACK 当**模块**动态加载 ────────────────── */

/* `solve()` / `lm()` 走的是 `R_HOME/modules/lapack.so`（`src/modules/lapack/`），
   不在 libR 里。少了它 `library(grDevices)` 都起不来 —— 它的 `.onLoad` 会 `solve()` 一个
   3×3 的 RGB 矩阵。名单照 `src/modules/lapack/Makefile.in` 第 18..23 行：
   `Lapack.c` + `flexiblas.o`（后者在 `src/main` 里，libR 里也有一份，这儿要它自己那份符号）。
   实现由 Accelerate 提供（configure 在 macOS 上也是这么挑的）。 */
const LAPACK_SO = join(HOME, 'modules/lapack.so');
mkdirSync(join(OBJ, 'mod'), { recursive: true });
const lapackObjs = [];
for (const [dir, name] of [['src/modules/lapack', 'Lapack.c'], ['src/main', 'flexiblas.c']]) {
  const o = join(OBJ, 'mod', `${name.replace(/\.c$/, '')}.o`);
  lapackObjs.push(o);
  b.build(o, 'ccpkg', join(RSRC, dir, name), {
    implicit: HEADERS,
    vars: { extra: `-I${join(RSRC, 'src/modules/lapack')}` },
  });
}
b.build(LAPACK_SO, 'so', lapackObjs, { vars: { libs: '-framework Accelerate' } });

/* `etc/repositories`：`install.packages` 要它（树里是现成的一份，直接抄）。 */
const REPOS = join(HOME, 'etc/repositories');
b.build(REPOS, 'cp', join(RSRC, 'etc/repositories'));

/* ─── 装包那一套：`bin/R` / `include/` / `lib/libR` / `etc/Makeconf` ────── */

/* `bin/R`：R 自己那份是 287 行的模板（`src/scripts/R.sh.in`），我们只要两条路 ——
   `R CMD <cmd>` 与"直接起"。`bin/INSTALL` 用 R 自己那份（它只是把参数拼成
   `nextArg` 串再喂给 `tools:::.install_packages()`）。 */
const BIN_R = join(HOME, 'bin/R');
mkdirSync(join(HOME, 'bin/exec'), { recursive: true });
writeFileSync(BIN_R, `#!/bin/sh\n# ext/r/build-libR.js 生成 —— 别手改\n`
  + `R_HOME="${HOME}"; export R_HOME\n`
  + 'R_ENABLE_JIT=0; export R_ENABLE_JIT\n'
  + 'TZDIR=${TZDIR:-/usr/share/zoneinfo}; export TZDIR\n'
  + 'R_SHARE_DIR="${R_HOME}/share"; export R_SHARE_DIR\n'
  + 'R_INCLUDE_DIR="${R_HOME}/include"; export R_INCLUDE_DIR\n'
  + 'R_DOC_DIR="${R_HOME}/doc"; export R_DOC_DIR\n'
  + 'if [ "$1" = CMD ]; then\n'
  + '  shift; cmd="$1"; shift\n'
  + '  if [ -x "${R_HOME}/bin/${cmd}" ]; then exec "${R_HOME}/bin/${cmd}" "$@"; fi\n'
  + '  echo "R CMD ${cmd}：这一版没接" >&2; exit 1\n'
  + 'fi\n'
  + 'exec "${R_HOME}/bin/exec/R" "$@"\n');
chmodSync(BIN_R, 0o755);

b.rule('cpx', { command: 'cp $in $out && chmod +x $out', description: 'CP+x $out' });
const EXEC_R = join(HOME, 'bin/exec/R');
b.build(EXEC_R, 'cpx', RBIN);
/* `INSTALL` / `SHLIB` / `REMOVE` 都用 R 自己那几份 shell 脚本。
   **`SHLIB` 不能漏**：`Rcpp::cppFunction` / `sourceCpp` 现场编 C++ 走的正是
   `R CMD SHLIB`，缺了它 Rcpp 报的是"The tools required to build C++ code for R
   were not found"（一句会把人引到 Xcode 那边去的错话）。 */
const BIN_SCRIPTS = ['INSTALL', 'SHLIB', 'REMOVE'].map((n) => {
  const dst = join(HOME, 'bin', n);
  b.build(dst, 'cpx', join(RSRC, 'src/scripts', n));
  return dst;
});
/* libR 得摆在 `R_HOME/lib` 下 —— 包里的 C 是按 `-L$(R_HOME)/lib -lR` 链的。 */
const LIB_LIBR = join(HOME, 'lib/libR.dylib');
b.build(LIB_LIBR, 'cp', LIBR);
/* 包里的 C 要 `R.h` / `Rinternals.h` / `R_ext/*.h`，还有我们生成的那三份。 */
const INC_STAMP = join(HOME, 'include/Rinternals.h');
b.rule('cpinc', {
  command: `mkdir -p ${join(HOME, 'include/R_ext')} `
    + `&& cp ${join(RSRC, 'src/include')}/R.h ${join(RSRC, 'src/include')}/Rdefines.h `
    + `${join(RSRC, 'src/include')}/Rinternals.h ${join(RSRC, 'src/include')}/Rembedded.h `
    + `${join(RSRC, 'src/include')}/Rinterface.h ${join(HOME, 'include')}/ `
    + `&& cp ${RCONFIG_H} ${RMATH_H} ${RVERSION_H} ${join(HOME, 'include')}/ `
    + `&& cp ${join(RSRC, 'src/include/R_ext')}/*.h ${join(HOME, 'include/R_ext')}/`,
  description: 'include/ -> R_HOME',
});
b.build(INC_STAMP, 'cpinc', [], { implicit: [RCONFIG_H, RMATH_H, RVERSION_H] });
/* `etc/Makeconf`：装包时 `CC` / `CFLAGS` / `SHLIB_LDFLAGS` 那一套都从它来。 */
const MAKECONF = join(HOME, 'etc/Makeconf');
b.rule('genmakeconf', {
  command: `node ${join(HERE, 'rt/gen-makeconf.js')} --src ${RSRC} --home ${HOME} --out $out --cc ${CC} --fc ${FC}`,
  description: 'etc/Makeconf',
  restat: 'true',
});
b.build(MAKECONF, 'genmakeconf', [], {
  implicit: [join(HERE, 'rt/gen-makeconf.js'), join(RSRC, 'etc/Makeconf.in')],
});
const INSTALL_BITS = [EXEC_R, ...BIN_SCRIPTS, LIB_LIBR, INC_STAMP, MAKECONF];

/* `Meta/package.rds` / `features.rds` / `nsInfo.rds`：**第一轮我们自己写**
   （`rt/bootstrap-meta.R`，只用 base 的 `read.dcf` / `saveRDS` / `parseNamespaceFile`）。
   为什么不直接跑 R 自己的 `tools:::.vinstall_*_as_RDS`：那两个函数在 tools 包里，
   而加载 tools 又要先有它的 `package.rds` —— R 的 `src/library/Makefile.in` 自己把这一格
   叫 "bootstrapping problem here: tools uses tools to dump its namespace"。 */
const META = join(OUT, 'meta.ok');
/* `share/` 里有 tools 一加载就要读的东西（`encodings/Adobe-glyphlist`）。 */
const SHARE = join(HOME, 'share/encodings/Adobe-glyphlist');
b.rule('cpshare', {
  command: `mkdir -p ${join(HOME, 'share')} && cp -R ${join(RSRC, 'share')}/. ${join(HOME, 'share')}/`,
  description: 'share/ -> R_HOME',
});
b.build(SHARE, 'cpshare', [], { implicit: [join(RSRC, 'share/encodings/Adobe-glyphlist')] });
b.rule('mkmeta', {
  command: `TZDIR=/usr/share/zoneinfo R_ENABLE_JIT=0 R_DEFAULT_PACKAGES=NULL R_HOME=${HOME} `
    + `${RBIN} --vanilla --no-echo -f ${join(HERE, 'rt/bootstrap-meta.R')} `
    + `--args ${join(HOME, 'library')} ${PKGS.join(' ')} base > ${join(OUT, 'meta.txt')} 2>&1 && date > $out`,
  description: '自举 Meta/*.rds（只用 base）',
});
b.build(META, 'mkmeta', [RBIN, BASE_R, BASE_PROFILE, BASE_DESC, RENVIRON, SHARE, LAPACK_SO, REPOS,
  ...INSTALL_BITS, ...pkgStamps],
  { implicit: [join(HERE, 'rt/bootstrap-meta.R')] });


/* 编出来不等于跑得起来，所以最后一条边是**真跑一趟**：起 R、求一段、对答案。
   `R_ENABLE_JIT=0` 是 ADR-0046 那一条（R 自己那个用 R 写的字节码编译器我们不要）。
   量的是四件事：base 的算术、stats 的 `sd`、**LAPACK**（`lm` 的系数，走 Accelerate）、
   以及 methods 的 S4 起不起来（`library(grid)` 会把它拉起来）。 */
/* `R/sysdata.rda`（包的内部数据）要转成 lazyload 库 —— tools 与 utils 各有一份，
   而 utils 那份里有 `MARC_relator_db`，装任何 CRAN 包都要用（`.install_packages` 读
   DESCRIPTION 的 Authors@R 时会查它）。用的是 R 自己的 `tools:::sysdata2LazyLoadDB`
   （`share/make/basepkg.mk` 第 149..151 行那条 `sysdata` 规则）。 */
const SYSDATA = join(OUT, 'sysdata.ok');
const sysPkgs = PKGS.filter((p) => existsSync(join(RSRC, 'src/library', p, 'R/sysdata.rda')));
b.rule('sysdata', {
  command: sysPkgs.map((p) => `TZDIR=/usr/share/zoneinfo R_ENABLE_JIT=0 R_HOME=${HOME} ${RBIN} `
    + `--vanilla --no-echo -e "tools:::sysdata2LazyLoadDB('${join(RSRC, 'src/library', p, 'R/sysdata.rda')}','${join(HOME, 'library', p, 'R')}')" > /dev/null`).join(' && ')
    + ' && date > $out',
  description: 'sysdata.rda -> lazyload 库',
});
b.build(SYSDATA, 'sysdata', [META]);

const STAMP = join(OUT, 'smoke.ok');
const SMOKE_LOG = join(OUT, 'smoke.txt');
b.rule('smoke', {
  command: `TZDIR=/usr/share/zoneinfo R_ENABLE_JIT=0 R_HOME=${HOME} `
    + `${RBIN} --vanilla --no-echo -e 'library(stats); library(grid); `
    + `fit <- lm(c(1,2,3.1) ~ c(1,2,3)); `
    + `cat(sum(1:10), round(sd(c(1,2,3,4)), 6), round(coef(fit)[2], 4), nrow(data.frame(a=1:3)), "\\n")' `
    + `> ${SMOKE_LOG} 2>&1 && grep -qx "55 1.290994 1.05 3 " ${SMOKE_LOG} && date > $out`,
  description: '起一趟我们自己的 R（stats / grid / methods / LAPACK），对答案',
});
b.build(STAMP, 'smoke', [SYSDATA]);

b.default(STAMP);
b.run(process.argv.slice(2));



