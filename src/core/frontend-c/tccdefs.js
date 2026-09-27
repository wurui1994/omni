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
 * @param {number} cversion `__STDC_VERSION__` 报的那个数（tcc 的 `s->cversion`：
 *   默认 199901，只有 `-std=c11` / `-std=gnu11` 会把它换成 201112，libtcc.c:1994）
 */
export function predefs(arch = 'arm64', os = 'osx', forPP = false, cversion = 199901) {
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
    ['__STDC_VERSION__', `${cversion}L`],
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

  /* `__VERSION__` —— **声称 `__GNUC__` 就得带上它**。gcc 与 clang 都定这一条，
   * 而且真有代码去拼它：CPython 的 `Python/getcompiler.c:17` 写的是
   * `#define COMPILER "[GCC " __VERSION__ "]"`（进 `sys.version`），少了这一条
   * 那一份就报 `';' expected (got '__VERSION__')` —— 量到过。
   *
   * 只装在编译那一路：`cpp/` 那组的尺子是 `tcc -dM` 的宏表逐行相同，而 tcc 没有
   * 这一条。值照 clang 的体例（它在 macOS 上报 `4.2.1 Compatible Apple LLVM …`）——
   * 我们在 osx 上装成 APPLE-GCC 4（见 `OS_EXTRA`），所以也从 `4.2.1 Compatible` 起。 */
  ['__VERSION__', '"4.2.1 Compatible Omni C"'],

  /* `__has_extension` —— **只在编译那一路补上的第四个探测宏**。
   *
   * tcc 的 `include/tccdefs.h:152-154` 只有 `__has_builtin` / `__has_feature` /
   * `__has_attribute` 三个（我们的 `predefs` 照抄那三个，`-dM` 那张表才逐行对得上），
   * 可 macOS 的 `TargetConditionals.h:147` 写的是
   *     #if !defined(__has_extension) || !__has_extension(define_target_os_macros)
   * —— `||` 在 `#if` 里**不短路语法**：右边那一半照样要能解析，而 `__has_extension` 没定义
   * 时它变成 `0 (0)`，于是整行是语法错（`bad preprocessor expression`，tcc 也一样报）。
   * 量到的后果：`Modules/socketmodule.c` 编不出来。
   *
   * 回 0 的意思是"这编译器什么扩展都没有"，与那三个一致：头文件于是走它的保守那一支。
   * 放 `COMPILE_DEFS` 而不是 `predefs`，是为了让 `tcc -dM` 那组判据继续逐行相同。 */
  ['__has_extension(x)', '0'],

  /* `__builtin_constant_p(x)` —— **一律答 0**（"不是编译期常量"）。
   *
   * tcc 有这个内建（`tccgen.c` 的 `TOK_builtin_constant_p`：常量折叠之后看还剩不剩值），
   * 我们还没有。答 0 在语义上**永远安全**：用它的代码形状都是
   * `__builtin_constant_p(x) ? 走常量那条快路 : 走普通那条`，答 0 就是一律走普通那条。
   * 量到的出处：`Modules/socketmodule.c:9454`（少了它那一份出 `.o` 但带一条隐式声明警告 ——
   * 而隐式声明的返回值是 int、值是"调用了一个不存在的函数"，链接那天才炸）。
   *
   * 记一笔：真做成内建（跟着常量折叠回 1）会让那些代码走另一条分支，**那条分支也要编得出来**
   * 才算赚 —— 所以先答 0，等哪天量到"答 0 太慢"再说。 */
  ['__builtin_constant_p(x)', '0'],

  /* ---- `__atomic_*` 那一族（GCC / clang 的内建原子操作）--------------------
   *
   * 为什么要有：**借来的 C 里到处是它**。最先撞上的是 CPython 的
   * `Include/cpython/pyatomic.h` —— 它按编译器挑后端（`__atomic_*` 内建 / C11 的
   * `<stdatomic.h>` / MSVC），三条都挑不中就 `#error "no available pyatomic
   * implementation"`，于是**一份对象层的 .c 都编不了**（量出来的，见
   * `ext/python/SPEC.md` §一之二）。
   *
   * **这一版落成普通读写**，理由写在前头：这条链现在一个线程都不起（后端没有线程，
   * 解释器腿是单线程的 JS），所以"原子"与"普通"在**可观察行为上一样**。
   * 代价说清：这是"claim 了原子性却不提供"。**接线程之前必须换掉** ——
   * 那时这一族要落到 MIR 的原子算子上（现在 MIR 里还没有那一族），
   * 而不是继续用这几条宏。顺序参数（memorder）一律吃掉，两格屏障落成空语句。
   *
   * 写法上借了两样这台前端已经有的：**语句表达式** `({ … })` 与 `__typeof__`
   * （两样都量过能用）—— 于是"要一格临时量"的那几个（exchange / fetch_add）
   * 不必按宽度各写一份。
   */
  ['__ATOMIC_RELAXED', '0'],
  ['__ATOMIC_CONSUME', '1'],
  ['__ATOMIC_ACQUIRE', '2'],
  ['__ATOMIC_RELEASE', '3'],
  ['__ATOMIC_ACQ_REL', '4'],
  ['__ATOMIC_SEQ_CST', '5'],
  ['__atomic_load_n(p,m)', '(*(p))'],
  ['__atomic_store_n(p,v,m)', '((void)(*(p) = (v)))'],
  /* 地址形式（`__atomic_load(p, ret, m)`）—— clang 那条 `__has_builtin` 问的就是它。 */
  ['__atomic_load(p,r,m)', '((void)(*(r) = *(p)))'],
  ['__atomic_store(p,v,m)', '((void)(*(p) = *(v)))'],
  ['__atomic_exchange_n(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = (v); __ao_old; })'],
  ['__atomic_exchange(p,v,r,m)', '((void)(*(r) = __atomic_exchange_n(p, *(v), m)))'],
  /* 比较交换：成了给 1；没成把**现值写回 expected**（这一条是语义，漏了就成死循环）。 */
  ['__atomic_compare_exchange_n(p,e,d,weak,ms,mf)',
    '({ int __ao_ok = (*(p) == *(e)); if (__ao_ok) *(p) = (d); else *(e) = *(p); __ao_ok; })'],
  ['__atomic_compare_exchange(p,e,d,weak,ms,mf)',
    '__atomic_compare_exchange_n(p, e, *(d), weak, ms, mf)'],
  ['__atomic_fetch_add(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = __ao_old + (v); __ao_old; })'],
  ['__atomic_fetch_sub(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = __ao_old - (v); __ao_old; })'],
  ['__atomic_fetch_and(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = __ao_old & (v); __ao_old; })'],
  ['__atomic_fetch_or(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = __ao_old | (v); __ao_old; })'],
  ['__atomic_fetch_xor(p,v,m)', '({ __typeof__(*(p)) __ao_old = *(p); *(p) = __ao_old ^ (v); __ao_old; })'],
  ['__atomic_add_fetch(p,v,m)', '(*(p) = *(p) + (v))'],
  ['__atomic_sub_fetch(p,v,m)', '(*(p) = *(p) - (v))'],
  ['__atomic_and_fetch(p,v,m)', '(*(p) = *(p) & (v))'],
  ['__atomic_or_fetch(p,v,m)', '(*(p) = *(p) | (v))'],
  ['__atomic_xor_fetch(p,v,m)', '(*(p) = *(p) ^ (v))'],
  ['__atomic_test_and_set(p,m)', '({ char __ao_old = *(char *)(p); *(char *)(p) = 1; __ao_old; })'],
  ['__atomic_clear(p,m)', '((void)(*(char *)(p) = 0))'],
  ['__atomic_thread_fence(m)', '((void)0)'],
  ['__atomic_signal_fence(m)', '((void)0)'],
  ['__atomic_is_lock_free(sz,p)', '1'],
  ['__atomic_always_lock_free(sz,p)', '1'],

  /* ---- 位计数那一族（`ffs` / `clz` / `ctz` / `clrsb` / `popcount` / `parity`）------
   *
   * tcc 把这十八个（六族 × int/long/long long）写成 **libtcc1 里的真函数**
   * （`lib/builtin.c`，用 de Bruijn 查表），在 `tccdefs.h` 里只给原型。
   * 我们落成**宏**，理由有两条：
   *   一、不欠链接的债 —— 宏展开出来是纯 C，四条腿（解释器 / JS / native / 产物）
   *       一处都不用加运行时符号；查表那一版还要一份静态数组，宏里放不下。
   *   二、这一层本来就有"内建落成宏"的体例（上面 `__atomic_*` 一族），
   *       而"实参只求值一次"靠的是同一手：语句表达式 `({ … })`。
   *
   * 算法是无表的 SWAR：`popcount` 那四行是 tcc 的 `POPCOUNTI`/`POPCOUNTL` 原样，
   * 别的都从它导出 —— `ctz` = `popcount((x & -x) - 1)`、`clz` = 位宽 - `popcount(填满)`、
   * `ffs` = `x ? ctz + 1 : 0`、`clrsb` = `clz(x<0 ? ~x : x) - 1`、`parity` = `popcount & 1`。
   *
   * `long` 那一族**不另写**：低位那几个（ctz/ffs/popcount/parity）与宽度无关，直接借
   * 64 位那一份；`clz` 只差一个常数，靠已经预定义好的 `__SIZEOF_LONG__` 调 ——
   * 于是 win32（long 是 4 字节）上也对，不必按 OS 分表。
   *
   * 与 tcc 的一处差别记在这儿：**x 为 0 时 `clz` / `ctz` 是未定义的**（C 与 GCC 都这么
   * 说）。tcc 的查表实现给 `clz(0) = 31/63`、`ctz(0) = 0`；我们给 `clz(0) = 32/64`、
   * `ctz(0) = 32/64`。`ffs(0) = 0` 与 `clrsb(0) = 31/63` 两边一样（那两个有定义）。
   * 判据里因此不考 0 的 clz/ctz。
   *
   * 逼出这一族的是 CPython：`Objects/dictobject.c:8609`（`__builtin_clzl`）、
   * `Objects/unicodeobject.c:15436`（`__builtin_ctzll`）、`Python/hamt.c:2897` 与
   * `Objects/longobject.c:7008`（`__builtin_popcount`）—— 从前它们只是"隐式声明"的
   * 警告，而那意味着**链接的时候才炸**。 */
  ['__builtin_popcount(x)',
    '(__extension__ ({ unsigned int __bc = (unsigned int)(x);'
    + ' __bc = __bc - ((__bc >> 1) & 0x55555555u);'
    + ' __bc = (__bc & 0x33333333u) + ((__bc >> 2) & 0x33333333u);'
    + ' __bc = (__bc + (__bc >> 4)) & 0x0f0f0f0fu;'
    + ' (int)(((__bc * 0x01010101u) >> 24) & 0x3f); }))'],
  ['__builtin_popcountll(x)',
    '(__extension__ ({ unsigned long long __bcl = (unsigned long long)(x);'
    + ' __bcl = __bcl - ((__bcl >> 1) & 0x5555555555555555ull);'
    + ' __bcl = (__bcl & 0x3333333333333333ull) + ((__bcl >> 2) & 0x3333333333333333ull);'
    + ' __bcl = (__bcl + (__bcl >> 4)) & 0x0f0f0f0f0f0f0f0full;'
    + ' (int)(((__bcl * 0x0101010101010101ull) >> 56) & 0x7f); }))'],
  ['__builtin_popcountl(x)', '__builtin_popcountll((unsigned long long)(x))'],
  ['__builtin_parity(x)', '(__builtin_popcount(x) & 1)'],
  ['__builtin_parityll(x)', '(__builtin_popcountll(x) & 1)'],
  ['__builtin_parityl(x)', '(__builtin_popcountll((unsigned long long)(x)) & 1)'],
  ['__builtin_ctz(x)',
    '(__extension__ ({ unsigned int __bt = (unsigned int)(x);'
    + ' __builtin_popcount((__bt & (0u - __bt)) - 1u); }))'],
  ['__builtin_ctzll(x)',
    '(__extension__ ({ unsigned long long __btl = (unsigned long long)(x);'
    + ' __builtin_popcountll((__btl & (0ull - __btl)) - 1ull); }))'],
  ['__builtin_ctzl(x)', '__builtin_ctzll((unsigned long long)(x))'],
  ['__builtin_clz(x)',
    '(__extension__ ({ unsigned int __bz = (unsigned int)(x);'
    + ' __bz |= __bz >> 1; __bz |= __bz >> 2; __bz |= __bz >> 4;'
    + ' __bz |= __bz >> 8; __bz |= __bz >> 16;'
    + ' (int)(32 - __builtin_popcount(__bz)); }))'],
  ['__builtin_clzll(x)',
    '(__extension__ ({ unsigned long long __bzl = (unsigned long long)(x);'
    + ' __bzl |= __bzl >> 1; __bzl |= __bzl >> 2; __bzl |= __bzl >> 4;'
    + ' __bzl |= __bzl >> 8; __bzl |= __bzl >> 16; __bzl |= __bzl >> 32;'
    + ' (int)(64 - __builtin_popcountll(__bzl)); }))'],
  ['__builtin_clzl(x)',
    '(__builtin_clzll((unsigned long long)(x)) - (64 - __SIZEOF_LONG__ * 8))'],
  ['__builtin_ffs(x)',
    '(__extension__ ({ unsigned int __bf = (unsigned int)(x);'
    + ' __bf == 0u ? 0 : (int)(__builtin_ctz(__bf) + 1); }))'],
  ['__builtin_ffsll(x)',
    '(__extension__ ({ unsigned long long __bfl = (unsigned long long)(x);'
    + ' __bfl == 0ull ? 0 : (int)(__builtin_ctzll(__bfl) + 1); }))'],
  ['__builtin_ffsl(x)', '__builtin_ffsll((unsigned long long)(x))'],
  ['__builtin_clrsb(x)',
    '(__extension__ ({ int __bs = (int)(x);'
    + ' (int)(__builtin_clz((unsigned int)(__bs < 0 ? ~__bs : __bs)) - 1); }))'],
  ['__builtin_clrsbll(x)',
    '(__extension__ ({ long long __bsl = (long long)(x);'
    + ' (int)(__builtin_clzll((unsigned long long)(__bsl < 0 ? ~__bsl : __bsl)) - 1); }))'],
  /* ---- 浮点的**有序比较**那一族（C99 的 `isgreater` 一家，`<math.h>` 拿它们定同名宏）----
   *
   * macOS 的 `<math.h>:584` 起把 `isgreater`/`isgreaterequal`/`isless`/`islessequal`/
   * `islessgreater`/`isunordered` 六个标准宏**直接定义成这几个内建** —— 也就是说不认它们
   * 就编不了任何一份真用了这几个宏的 `.c`（量到的：`Modules/mathmodule.c:230` 的
   * `isgreater(r, 1.0)`，那是 CPython 的 `math.fmod`/`remainder` 一路）。tcc 也没有这一族。
   *
   * 语义上它们与普通的 `>` `>=` `<` `<=` 差在**不引发"无效"异常**（C99 7.12.14）：
   * 对 NaN 静默地回假而不置标志位。我们这条链**一个浮点异常标志都不读**（四条腿都没有
   * `fetestexcept`），所以"静默"与"置标志"在可观察行为上一样 —— 这一格因此就是那几个比较。
   * 真接了浮点环境的那天，这几条要换成真的静默比较，账记在这儿。
   *
   * `isunordered` 用 `x != x` 判 NaN（IEEE-754 里 NaN 是唯一不等于自己的值）。
   * 六条都用语句表达式把两边各存一次 —— 实参只求值一次（`isgreater(f(), g())`）。 */
  ['__builtin_isgreater(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa > __fb); }))'],
  ['__builtin_isgreaterequal(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa >= __fb); }))'],
  ['__builtin_isless(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa < __fb); }))'],
  ['__builtin_islessequal(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa <= __fb); }))'],
  ['__builtin_islessgreater(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa < __fb || __fa > __fb); }))'],
  ['__builtin_isunordered(x,y)',
    '(__extension__ ({ __typeof__(x) __fa = (x); __typeof__(y) __fb = (y);'
    + ' (int)(__fa != __fa || __fb != __fb); }))'],
  ['__builtin_clrsbl(x)',
    '(__extension__ ({ long __bsw = (long)(x);'
    + ' (int)(__builtin_clzl((unsigned long)(__bsw < 0 ? ~__bsw : __bsw)) - 1); }))'],
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

