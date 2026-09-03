// 预定义的宏 —— tcc 的 `tcc_predefs`（`tccdefs.h` 编译进二进制的那一份）加上
// `tcc_state` 里按目标补的那几条（`libtcc.c` 的 `tcc_new`）。ADR-0017 第八刀第一片。
//
// # 为什么这一份要逐条对着 `tcc -dM -E` 抄
//
// 这些宏是**目标的自述**：`__aarch64__` 决定 libc 头文件走哪一支，`__SIZEOF_LONG__`
// 决定 `size_t` 是什么，`__APPLE__` 决定要不要 `_` 前缀。少一条、多一条、值差一位，
// 系统头文件就会展开成另一份声明 —— 而那种错不会在这一层暴露，会在几千行之后
// 以「类型不匹配」的样子冒出来。所以这一份的 oracle 是 `tcc -dM -E` 的**逐行输出**，
// 顺序也照它（tcc 的 `-dM` 是**边定义边印**，不是最后 dump 一张表，所以顺序就是
// 定义顺序）。
//
// 量出来的（`tcc -dM -E /dev/null`，本机 = macOS + arm64）：50 条，见下面这张表。
// 它是**这一个目标**的样子，不是 C 的样子 —— 换目标要换表，所以表里按 tcc 那边的
// 来源分了段，每段头上写清楚是谁在管。
//
// 三类需要解释的：
//
//   - `_Nonnull` / `_Nullable` / `_Null_unspecified` / `_Nullable_result` 展开成空：
//     macOS 的头文件到处在用 clang 的 nullability 标注，tcc 不认，就抹掉。
//   - `__REDIRECT` 一族与 `__has_builtin`/`__has_feature`/`__has_attribute` 回 0：
//     同一个理由 —— 让 glibc/macOS 的头文件走「编译器什么都不会」那一支。
//   - `_Float16 short unsigned int`：tcc 没有 `_Float16`，拿一个同宽的整型顶着，
//     这样头文件里那些声明至少能过语法。**它不是一份能算的 `_Float16`**，
//     碰到真的半精度运算会算错 —— 这一条是 tcc 自己的取舍，我们照抄，并且记在这儿。
//
// 还没到：`-U` 抹掉预定义、
// `-dM` 的逐行输出（那要一台「边定义边印」的钩子，独立一片）。
// （`__DATE__` / `__TIME__` 不在这张表里 —— 它们随时钟走，是 tccpp.js 的
// `substSpecial` 每次展开现算的，见第一百〇三片。）

/**
 * 目标 CPU 那几条（各后端自己的 `target_machine_defs`：`x86_64-gen.c:121`、
 * `arm64-gen.c:55`）。量出来的（`tcc -dM -E` 两边一 diff）：**整张表就差这三行**，
 * 别的四十几条按 OS 分（第一百〇二片量的是 CPU 这一格，第一百二十九片补上 OS）。
 *
 * 三条一变，tcc 自己的源码就跟着走另一支：`tcc.h` 没给 `TCC_TARGET_*` 时按
 * `__x86_64__` / `__aarch64__` 选目标，所以「编 x86_64 的 tcc」不必手工递
 * `-DTCC_TARGET_X86_64`。
 *
 * 第三格是「只有这个 OS 才有」：`__arm64__` 压在 `arm64-gen.c:57` 那道
 * `#if defined(TCC_TARGET_MACHO)` 里 —— 也就是说 arm64-linux 与 arm64-win32
 * **没有**这一条。这张表于是不只按架构分，还得看 OS。
 */
export const CPU_DEFS = {
  arm64: [
    ['__aarch64__', '1'],
    ['__arm64__', '1', 'osx'],
    ['__AARCH64EL__', '1'],
  ],
  x86_64: [
    ['__x86_64__', '1'],
    ['__x86_64', '1'],
    ['__amd64__', '1'],
  ],
};

/**
 * `char` 默认无符号的目标（各后端的 `CHAR_IS_UNSIGNED` -> `s1->char_is_unsigned`
 * -> `putdef("__CHAR_UNSIGNED__")`）。arm64 上是 `arm64-gen.c:41` 那道
 * `#if !defined(TCC_TARGET_MACHO) && !defined(TCC_TARGET_PE)` —— 只有 arm64-linux。
 *
 * 这一条不光是个宏：tcc 那边它同时改**语言**（`char` 的符号性）。我们现在只把宏
 * 摆对，`char` 的符号性还照 signed 走 —— 那是 arm64-linux 那条腿上的一笔欠账。
 */
const CHAR_UNSIGNED = (arch, os) => arch === 'arm64' && os !== 'osx' && os !== 'win32';

/**
 * 目标 OS 那一段（tccpp.c 的 `target_os_defs`，`tccpp.c:3545-3572`）。整段**照原次序**，
 * 因为 `-dD`/`-dM` 印出来的次序就是这个次序 —— 差一格就对不上。
 *
 * win32 那一支是 `TCC_TARGET_PE`：只有 `_WIN32`/`_WIN64`，**没有** `__unix`
 * 那两条（那两条在 `#else` 里，PE 走不到）。
 */
export const OS_DEFS = {
  linux: [
    ['__linux__', '1'],
    ['__linux', '1'],
    ['__unix__', '1'],
    ['__unix', '1'],
  ],
  osx: [
    ['__APPLE__', '1'],
    ['__unix__', '1'],
    ['__unix', '1'],
  ],
  win32: [
    ['_WIN32', '1'],
    ['_WIN64', '1'],
  ],
};

/**
 * 名字前那条下划线（`s1->leading_underscore`，`tccpp.c:3615`）。Mach-O 上开着，
 * ELF/PE 上不开。位置在 **`__TCC_PP__` 之后** —— 两条都是 tcc_predefs 里那一串
 * `if (…) putdef(…)`，`-dM` 逐行量出来的。
 */
const LEADING_UNDERSCORE = { linux: false, osx: true, win32: false };

/**
 * 数据模型。tccdefs.h 是按 **`__SIZEOF_LONG__`** 分岔的（`tccdefs.h:22-46`）：
 * `long` 4 字节 = 64 位 Windows（LLP64），否则是别的 64 位系统（LP64）。
 * `__INT64_TYPE__` 在 LP64 里还要再分一次：linux 上是 `long`，APPLE/BSD 上是
 * `long long`（`tccdefs.h:41-45`）—— 同一个宽度，两个名字。
 */
const MODEL = {
  linux: { longSize: 8, sizeT: 'unsigned long', ptrdiffT: 'long', name: '__LP64__', int64T: 'long', longMax: '0x7fffffffffffffffL' },
  osx: { longSize: 8, sizeT: 'unsigned long', ptrdiffT: 'long', name: '__LP64__', int64T: 'long long', longMax: '0x7fffffffffffffffL' },
  win32: { longSize: 4, sizeT: 'unsigned long long', ptrdiffT: 'long long', name: '__LLP64__', int64T: 'long long', longMax: '0x7fffffffL' },
};

/** `__WCHAR_TYPE__` / `__WINT_TYPE__`（`tccdefs.h:60-69` 那三支，三个目标三个样）。 */
const WCHAR_DEFS = {
  linux: { wchar: 'int', wint: 'unsigned int' },
  osx: { wchar: 'int', wint: 'int' },
  win32: { wchar: 'unsigned short', wint: 'unsigned short' },
};

/**
 * OS 自己要的那一段（`tccdefs.h:81-134` 那道大 `#if`）。位置在 `__WINT_TYPE__`
 * 之后、`__UINTPTR_TYPE__` 之前。**linux 那一支是空的** —— 也就是说
 * `__GNUC__` 只有 APPLE（与几个 BSD）才有，linux 上一条都不定。
 */
const OS_EXTRA = {
  linux: [],
  osx: [
    // 装成 APPLE-GCC，libc 的头才编得过（`__GNUC__ >= 4` 那些分支要它）
    ['__GNUC__', '4'],
    ['__APPLE_CC__', '1'],
    ['__LITTLE_ENDIAN__', '1'],
    ['_DONT_USE_CTYPE_INLINE_', '1'],
    ['__FINITE_MATH_ONLY__', '1'],
    ['_FORTIFY_SOURCE', '0'],
    ['_Float16', 'short unsigned int'],
  ],
  win32: [
    ['__declspec(x)', '__attribute__((x))'],
    ['__cdecl', undefined],
  ],
};

/**
 * glibc 的 `__REDIRECT` 一族（`tccdefs.h:143-148`，`#if !defined _WIN32`）。
 * macOS 上用不到，tcc 照定，我们照抄；PE 上没有。
 */
const REDIRECT_DEFS = [
  ['__REDIRECT(name,proto,alias)', 'name proto __asm__(#alias)'],
  ['__REDIRECT_NTH(name,proto,alias)', 'name proto __asm__(#alias)__THROW'],
  ['__REDIRECT_NTHNL(name,proto,alias)', 'name proto __asm__(#alias)__THROWNL'],
];

/**
 * 这个目标上的预定义宏，**按定义顺序**。`[名字, 宏体]`，宏体 `undefined` = 空展开。
 * 函数宏把形参写在名字里（`define()` 就是拼一行 `#define`，所以形状与源码一致）。
 *
 * 攒法照着 tcc 的 `tcc_predefs`（`tccpp.c:3585`）一段一段来 —— 那是一串顺着写的
 * `putdef`，不是一张静态表，所以这儿也写成顺着攒。三个目标的整张表都量过
 * （`tcc -dM -E /dev/null` 逐行 diff）：linux 44 条、win32 41 条、osx 51 条。
 *
 * `__BASE_FILE__` 不在里面 —— 它是「主输入文件」，由 `installPredefs` 补在最后，
 * 与 tcc 同一个位置。
 *
 * @param {string} arch `arm64` | `x86_64`
 * @param {string} os `linux` | `osx` | `win32`
 * @param {boolean} forPP 只预处理那一路（多一条 `__TCC_PP__`，见 `PP_ONLY_DEFS`）
 */
export function predefs(arch = 'arm64', os = 'osx', forPP = false) {
  const cpu = CPU_DEFS[arch];
  if (cpu === undefined) throw new Error(`tccdefs: 不认识的架构 ${arch}`);
  const osDefs = OS_DEFS[os];
  if (osDefs === undefined) throw new Error(`tccdefs: 不认识的 OS ${os}`);
  const m = MODEL[os];
  const w = WCHAR_DEFS[os];
  /** @type {Array<[string, (string|undefined)]>} */
  const out = [
    // ---- tcc 自己（`tcc_predefs` 头一行）
    ['__TINYC__', '928'],
    // ---- 目标 CPU（`target_machine_defs`，见 `CPU_DEFS`；第三格是「只有这个 OS 才有」）
    ...cpu.filter((e) => e.length < 3 || e[2] === os).map((e) => [e[0], e[1]]),
    // ---- 目标 OS（`target_os_defs`，见 `OS_DEFS`）
    ...osDefs,
  ];
  // ---- 那一串条件 putdef（`tccpp.c:3595-3616`，照它的次序）
  if (forPP) out.push(...PP_ONLY_DEFS);
  if (CHAR_UNSIGNED(arch, os)) out.push(['__CHAR_UNSIGNED__', '1']);
  if (LEADING_UNDERSCORE[os]) out.push(['__leading_underscore', '1']);
  out.push(
    // ---- 模型（PTR_SIZE / LONG_SIZE，tcc 是两行 cstr_printf）
    ['__SIZEOF_POINTER__', '8'],
    ['__SIZEOF_LONG__', String(m.longSize)],
    // ---- C 标准（tcc 报 C99）
    ['__STDC__', '1'],
    ['__STDC_HOSTED__', '1'],
    ['__STDC_VERSION__', '199901L'],
    // ---- 标准类型的底子（这儿起是 `tccdefs.h`）
    ['__SIZE_TYPE__', m.sizeT],
    ['__PTRDIFF_TYPE__', m.ptrdiffT],
    [m.name, '1'],
    ['__INT64_TYPE__', m.int64T],
    ['__SIZEOF_INT__', '4'],
    ['__INT_MAX__', '0x7fffffff'],
    ['__LONG_MAX__', m.longMax],
    ['__SIZEOF_LONG_LONG__', '8'],
    ['__LONG_LONG_MAX__', '0x7fffffffffffffffLL'],
    ['__CHAR_BIT__', '8'],
    ['__ORDER_LITTLE_ENDIAN__', '1234'],
    ['__ORDER_BIG_ENDIAN__', '4321'],
    ['__BYTE_ORDER__', '__ORDER_LITTLE_ENDIAN__'],
    ['__WCHAR_TYPE__', w.wchar],
    ['__WINT_TYPE__', w.wint],
    // ---- OS 自己那一段（见 `OS_EXTRA`）
    ...OS_EXTRA[os],
    // ---- 指针类型（放在 __PTRDIFF_TYPE__ 之后，宏体里引它）
    ['__UINTPTR_TYPE__', 'unsigned __PTRDIFF_TYPE__'],
    ['__INTPTR_TYPE__', '__PTRDIFF_TYPE__'],
    ['__INT32_TYPE__', 'int'],
    // ---- glibc 的 __REDIRECT 一族（PE 上没有）
    ...(os === 'win32' ? [] : REDIRECT_DEFS),
    ['__PRETTY_FUNCTION__', '__FUNCTION__'],
    // ---- clang 的那三个探测宏：一律回 0 = 「这编译器什么都没有」
    ['__has_builtin(x)', '0'],
    ['__has_feature(x)', '0'],
    ['__has_attribute(x)', '0'],
    // ---- clang 的 nullability 标注：抹掉
    ['_Nonnull', undefined],
    ['_Nullable', undefined],
    ['_Nullable_result', undefined],
    ['_Null_unspecified', undefined],
  );
  return out;
}

/**
 * 只在 **`-E`**（只预处理）那一路上定义的（tcc 的 `tcc_predefs`：
 * `if (s1->output_type == TCC_OUTPUT_PREPROCESS) putdef(cs, "__TCC_PP__")`）。
 *
 * 它就是 tccdefs.h 里那道 `#ifndef __TCC_PP__` 的**开关**：只预处理时，tcc 把
 * 「内建、`__uint128_t`、`__builtin_va_list`」整段跳掉 —— 那一段里有真的声明，
 * 而 `-E` 的输出里不该多出声明。所以 `tcc -dM -E` 量到的那 51 条**只是一半**；
 * 另一半（编译那一路才有的）在下面 `COMPILE_DEFS` 与 `COMPILE_PREAMBLE`。
 */
export const PP_ONLY_DEFS = [
  ['__TCC_PP__', '1'],
];

/**
 * 只在**编译**那一路上定义的宏（tccdefs.h 那道 `#ifndef __TCC_PP__` 里面的宏部分，
 * 按 `__aarch64__` + `__APPLE__` 这一支选）。
 *
 * 这些是**系统头文件当编译器内建来用的东西**：`<math.h>` 拿 `__builtin_huge_val()`
 * 定 `HUGE_VAL`，`<sys/_types/_fd_def.h>` 拿 `__builtin_bzero` 清 fd_set，
 * `<stddef.h>` 拿 `__builtin_offsetof` 定 `offsetof`。少一条，头文件就语法错。
 *
 * `__builtin_va_list` **不在这儿** —— 我们那一份是 `void *` 的 typedef，在 CGen 的
 * 构造函数里预置（`va_list` 就是变参区的地址，见 tccgen.js 的 vaBlock）。tcc 在
 * arm64+APPLE 上把它定成 `struct { void *__stack; }`，形状不同、意思相同。
 */
export const COMPILE_DEFS = [
  ['__builtin_offsetof(type,field)', '((__SIZE_TYPE__)&((type*)0)->field)'],
  ['__builtin_extract_return_addr(x)', 'x'],
  ['__builtin_huge_val()', '1e500'],
  ['__builtin_huge_valf()', '1e50f'],
  ['__builtin_huge_vall()', '1e5000L'],
  ['__builtin_nanf(ignored)', '(0.0F/0.0F)'],
  ['__builtin_flt_rounds()', '1'],
  ['__builtin_bzero(p,ignored)', 'bzero(p, sizeof(*(p)))'],
  ['__int128_t', 'struct __uint128__'],
  ['__uint128_t', 'struct __uint128__'],
];

/**
 * 编译那一路上，主输入文件**之前**先读的一小份源码（tccdefs.h 里那些真的声明）。
 * tcc 把它连着预定义一起塞进 include 栈；我们让语法分析器先读这一份、再读主文件 ——
 * 于是主文件的行号一个不差（把它拼到主文件前面就会全错，那是最容易犯的一个错）。
 *
 * 现在只有一条：`__uint128_t`。macOS 的 `<mach/arm/_structs.h>` 用它声明 NEON 的
 * 寄存器组，而 `#include <stdlib.h>` 会一路带到那儿 —— 也就是说**不认它就编不了
 * 任何一份用系统头的 C**。tcc 的换法是「拿一个同宽同对齐的类型顶着」，我们照抄。
 *
 * 少了什么：tcc 那边还写了 `__attribute((__aligned__(16)))`，我们的
 * `__attribute__` 是**吃掉**（不实现语义），所以这个结构体的对齐是 1 而不是 16 ——
 * 里面装着它的那些结构体（`__darwin_arm_neon_state` 之类）尺寸会与 tcc 不同。
 * 那些结构体我们一个都还没用到；真用到的那天，`__attribute__((aligned))` 得先落地。
 */
export const COMPILE_PREAMBLE = `struct __uint128__ { char x[16]; };
`;

