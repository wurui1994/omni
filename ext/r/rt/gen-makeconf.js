#!/usr/bin/env node
// ext/r/rt/gen-makeconf.js —— 从 `Makeconf.in` 生出 `R_HOME/etc/Makeconf`。
//
// 这一份是**装包**要的：`tools:::.install_packages()` 一上来就读它（连纯 R 的包也读），
// 而包里的 `src/` 更是全靠它的 `CC` / `CFLAGS` / `SHLIB_LDFLAGS` / `FLIBS` 那一套。
//
// 100 个 `@…@` 里真正管事的是四十来个（编译器、标志、路径、libR 怎么链），
// 剩下的是 autoconf 的条件桩与我们不做的那几档（LTO / NLS / X11 / framework）——
// 那些**替成空**，并且把名字印出来。为什么不像 `gen-rconfig.js` 那样"不认识就报"：
// 这是一份 makefile，空值多半只是"这一格没有"，而**猜一个值**才会在链接时给出怪错。
// 所以这儿的纪律是"空要空得看得见"。
//
// 用法：node ext/r/rt/gen-makeconf.js --src <r-source> --home <R_HOME> --out <Makeconf>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i < 0 ? d : argv[i + 1];
};
const SRC = arg('--src', null);
const HOME = arg('--home', null);
const OUT = arg('--out', null);
const CC = arg('--cc', 'clang');
const FC = arg('--fc', 'gfortran');
if (SRC === null || HOME === null || OUT === null) {
  process.stderr.write('用法：gen-makeconf.js --src <r-source> --home <R_HOME> --out <Makeconf>\n');
  process.exit(2);
}
const version = readFileSync(join(SRC, 'VERSION'), 'utf8').trim().split(' ')[0];
const platform = `${process.arch === 'arm64' ? 'aarch64' : process.arch}-apple-darwin`;
/* gfortran 的运行时在 Homebrew 的 gcc 目录下（`gfortran -print-file-name=libgfortran.dylib`
   给的就是那儿）—— 包里的 Fortran 要链它。 */
const GFDIR = '/opt/homebrew/lib/gcc/current';

/** 管事的那几十格。没列到的一律替成空，并且把名字印出来。 */
const V = new Map(Object.entries({
  CC,
  CC90: CC,
  CC99: CC,
  CC17: CC,
  CC23: CC,
  C90FLAGS: '-std=c90',
  C99FLAGS: '-std=c99',
  C17FLAGS: '-std=c17',
  C23FLAGS: '-std=c23',
  CFLAGS: '-O2 -Wall',
  CPICFLAGS: '-fPIC',
  CPPFLAGS: '-I/opt/homebrew/include',
  C_VISIBILITY: '-fvisibility=hidden',
  CXX_VISIBILITY: '-fvisibility=hidden',
  F_VISIBILITY: '',
  CXX: `${CC}++`,
  CXXFLAGS: '-O2 -Wall',
  CXXPICFLAGS: '-fPIC',
  CXXSTD: '-std=gnu++17',
  OBJC: CC,
  OBJCFLAGS: '-O2',
  OBJCXX: `${CC}++`,
  OBJC_LIBS: '-lobjc',
  FC,
  FFLAGS: '-O2',
  FCFLAGS: '-O2',
  SAFE_FFLAGS: '-O2 -ffp-contract=off',
  FPICFLAGS: '-fPIC',
  FPIEFLAGS: '-fPIE',
  FCLIBS_XTRA: '',
  FLIBS_IN_SO: '',
  LDFLAGS: '-L/opt/homebrew/lib',
  LIBM: '-lm',
  /* 包的 `.so` 怎么链（照 configure.ac 第 1539 行 macOS 那一支） */
  SHLIB_EXT: '.so',
  SHLIB_CFLAGS: '',
  SHLIB_CXXFLAGS: '',
  SHLIB_FFLAGS: '',
  SHLIB_LD: CC,
  SHLIB_LDFLAGS: '-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup',
  SHLIB_CXXLD: `${CC}++`,
  SHLIB_CXXLDFLAGS: '-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup',
  SHLIB_FCLD: CC,
  SHLIB_FCLDFLAGS: '-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup',
  SHLIB_LIBADD: '',
  DYLIB_EXT: '.dylib',
  DYLIB_LD: CC,
  DYLIB_LDFLAGS: '-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup',
  MAIN_LD: CC,
  MAIN_LDFLAGS: '',
  /* `-lR`：包里的 C 要拿到 R 的符号（libR 摆在 `R_HOME/lib` 下） */
  LIBR0: `-L${join(HOME, 'lib')}`,
  LIBR1: '-lR',
  LIBS_PKGS: '',
  LIBINTL_PKGS: '',
  BLAS_LIBS: '-framework Accelerate',
  LAPACK_LIBS: '',
  READLINE_LIBS: '-lreadline',
  R_INCLUDES: `-I${join(HOME, 'include')}`,
  R_XTRA_CPPFLAGS: `-I${join(HOME, 'include')}`,
  R_XTRA_CFLAGS: '',
  R_XTRA_CXXFLAGS: '',
  R_XTRA_FFLAGS: '',
  R_XTRA_LIBS: '',
  R_DEFS: '-DNDEBUG',
  R_ARCH: '',
  R_SHELL: '/bin/sh',
  R_CONFIG_ARGS: 'omni ext/r/build-libR.js',
  LIBnn: 'lib',
  /* 小工具 */
  AR: 'ar',
  NM: 'nm',
  RANLIB: 'ranlib',
  SED: 'sed',
  YACC: 'bison -y',
  STRIP_SHARED_LIB: 'strip -x',
  STRIP_STATIC_LIB: 'strip -S',
  ECHO_C: '',
  ECHO_N: '-n',
  ECHO_T: '',
  configure_input: 'omni ext/r/rt/gen-makeconf.js 生成 —— 别手改',
  /* 三条编译规则：configure 会把 make 片段塞在这儿。 */
  r_cc_rules_frag: '.c.o:\n\t$(CC) $(ALL_CPPFLAGS) $(ALL_CFLAGS) -c $< -o $@\n',
  r_cxx_rules_frag: '.cc.o:\n\t$(CXX) $(ALL_CPPFLAGS) $(ALL_CXXFLAGS) -c $< -o $@\n'
    + '.cpp.o:\n\t$(CXX) $(ALL_CPPFLAGS) $(ALL_CXXFLAGS) -c $< -o $@\n',
  r_objc_rules_frag: '.m.o:\n\t$(OBJC) $(ALL_CPPFLAGS) $(ALL_OBJCFLAGS) -c $< -o $@\n',
}));
/* C++ 的各档（17/20/23/26）：编译器同一个，只有 `-std` 不同。 */
for (const std of ['17', '20', '23', '26']) {
  V.set(`CXX${std}`, `${CC}++`);
  V.set(`CXX${std}FLAGS`, '-O2 -Wall');
  V.set(`CXX${std}PICFLAGS`, '-fPIC');
  V.set(`CXX${std}STD`, `-std=gnu++${std}`);
  V.set(`SHLIB_CXX${std}LD`, `${CC}++`);
  V.set(`SHLIB_CXX${std}LDFLAGS`, '-dynamiclib -Wl,-headerpad_max_install_names -undefined dynamic_lookup');
}

/* **用的是 `etc/Makeconf.in`**（装好的 R 里 `etc/Makeconf` 的模板），不是顶层那份
   `Makeconf.in`（那是编 R 自己用的）。拿错了的症状：包里的 C 一编就报
   `if (nzchar(SHLIB_LIBADD))` —— 因为那一格只在 `etc/` 那份里。 */
const tpl = readFileSync(join(SRC, 'etc/Makeconf.in'), 'utf8');
const emptied = new Set();
const text = tpl.replace(/@([A-Za-z_0-9]+)@/g, (_, k) => {
  if (V.has(k)) return V.get(k);
  emptied.add(k);
  return '';
});

mkdirSync(dirname(OUT), { recursive: true });
if (existsSync(OUT) && readFileSync(OUT, 'utf8') === text) {
  process.stdout.write('gen-makeconf: 没变\n');
  process.exit(0);
}
writeFileSync(OUT, text);
process.stdout.write(`gen-makeconf: 写了 ${OUT}（${text.length} 字节，填了 ${V.size} 格）\n`);
process.stdout.write(`  替成空的 ${emptied.size} 格：${[...emptied].sort().join(' ')}\n`);

