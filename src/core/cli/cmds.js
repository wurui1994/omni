/**
 * 这棵命令树的内容（ADR-0018 决策一到三）。`tree.js` 是机制，这一份是**数据**。
 *
 * 每个叶子带一格 `key`：那是 `cli.js` 里那个 `switch` 认的标签。于是新名与旧名可以指向
 * **同一个** `key`——`omni c obj` 与 `omni c-obj` 都是 `'c-obj'`，实现一份。旧名的节点
 * 打了 `hidden: true`，能用、不进清单（决策六：别名是静默的，因为有几道门逐字节比 stdout）。
 *
 * `flags` 里那些 arity 1 的，从前是**顶层**那一坨 26 个 `||` 在认（见 `tree.js` 头上那段）。
 * 搬过来顺带修掉一个靠运气的地方：`--arch`/`--os`/`--format`/`--lang`/`--engine`/`--kernel`
 * 从前**不在**那张表里，所以 `omni c-obj --arch x86_64 x.c` 会把 `x86_64` 当成源文件 ——
 * 现有的门都是 `x.c` 写在前面，所以一直没露。
 */

import { TCC_HELP } from './cmd-tcc.js';
/* `--engine graph` 那几行说明**从图那一层现取**（后端名单是 `contract.js` 里注册出来的）。
 * 这一份是"数据"，本来不该 import 别人；破例的理由只有一条：手抄一份后端名单就是第二处
 * 会过期的账，而这份 help 正是用户唯一看得到的那张清单。 */
import { graphEngineHelp } from '../graph/run.js';

/* ---- 与语言无关的那几格开关，好几条命令共用。 */
const F_OUT = { name: '-o', arity: 1, value: 'NAME', brief: '产物落在哪儿' };
const F_MODE = { name: '--mode', arity: 1, value: 'M', brief: 'mixed|dynamic|static（ADR-0008）' };
const F_WORK = { name: '--work', arity: 1, value: 'DIR', brief: '生成的中间文件留在这儿' };
const F_BACKEND = {
  name: '--backend', arity: 1, value: 'B',
  brief: 'interp|js|c|llvm|jit|native|spirv（--engine graph 时是 interp|js|wat|sx）',
};
/**
 * `build` 那一份**不一样**：`jit` 是「就地编就地跑」（只在 `run` 上有意义），
 * `spirv` 现在只有 `omni emit spirv` 那一档。**声明了就得能用** —— 所以这儿列的
 * 正好是 `build` 真有产物的那几条。
 */
const F_BACKEND_BUILD = {
  name: '--backend', arity: 1, value: 'B',
  brief: 'native|c|js|llvm|interp（interp 出的是 IR 文件）',
};
/* `-I` **不只是 C 的事**：jancy 的 `import` 也按它找（第六十二刀），而 jnc 走的是
 * 与语言无关的 `run`/`build`/`emit`/`check` —— 所以这一格在顶层那几条上也得声明。
 * 量出来的：`tests/jnc` 里那条「找不着 import」的门在「不认识的开关直接骂」之后
 * 报的是「不认识 '-I'」而不是它该报的那句话。 */
const F_INC = { name: '-I', arity: 1, value: 'DIR', brief: '找 import / #include 的目录，可重复' };
/* 产出分布：每个源文件发了多少行、多少字节、多少个函数（印到 stderr）。
   单体构建里"是谁撑起了那几十万行"从前没有答案，而看不见正是最贵的那一笔。 */
const F_STATS = { name: '--stats', arity: 0, brief: '印按源文件的产出分布（stderr）' };
/**
 * 生成的 C 交给谁（第一百四十六片）。**比 `OMNI_CC` 优先** —— 环境变量是「这一整轮都这样」，
 * 命令行是「这一趟这样」，后者盖前者是唯一讲得通的次序（`make CC=…` 也是这个规矩）。
 * `self` 就是缺省：我们自己那台 C 前端 + 我们自己的链接器，一个外部 cc 都不借。
 */
const F_CC = {
  name: '--cc', arity: 1, value: 'CC',
  brief: 'self（默认）|tcc|gcc|clang|cc|一条路径 —— 比 OMNI_CC 优先',
};
/**
 * 链哪一份 libc。`self` 那一格要一份 sysroot（头与 `.def` 都在里头）——
 * **不给 `--sysroot` 就按目标取自带的那一份**（`src/sysroot/<arch>-<os>`），
 * 所以本机上 `--libc self` 一个开关就够。
 */
const F_LIBC = {
  name: '--libc', arity: 1, value: 'KIND',
  brief: 'system（默认）| self：自带 libc，纯静态（sysroot 不给就按目标取自带的）',
};
const F_SYSROOT = {
  name: '--sysroot', arity: 1, value: 'DIR',
  brief: '系统头 DIR/include、符号预设 DIR/lib/*.def；不给就按 --arch/--os 取自带的',
};

/* ---- C 前端那几格（`-I` 这种只在这儿出现，不在顶层）。 */
const C_CPP_FLAGS = [
  { name: '-I', arity: 1, value: 'DIR', brief: '#include 的搜索目录，可重复' },
  { name: '-D', arity: 1, value: 'M[=V]', brief: '预定义一个宏' },
  { name: '-U', arity: 1, value: 'M', brief: '取消一个预定义宏' },
  { name: '-isystem', arity: 1, value: 'DIR', brief: '系统头的搜索目录' },
  { name: '-include', arity: 1, value: 'FILE', brief: '开头先吃一份头文件' },
  { name: '-MF', arity: 1, value: 'FILE', brief: '依赖表写到这儿' },
  /* tcc 的 `-B`（`tcc_lib_path`）：**换掉**自带的那一份系统头（`{B}/include`），
   * 不是多一条 `-isystem`。`omni c tcc` 把 `-B` 递成这个（ADR-0017 第一百三十九片）。
   * 得在这张表里声明 —— 不然带的那个目录会被当成一个**位置参数**（源文件）。 */
  { name: '--tcc-lib-dir', arity: 1, value: 'DIR', brief: 'tcc 的 -B：换掉自带的系统头目录' },
  { name: '-nostdinc', arity: 0, brief: '不带自带/系统那两层头目录（只剩 -I 给的）' },
  { name: '--sysroot', arity: 1, value: 'DIR', brief: '交叉编译：系统头 DIR/include、库 DIR/lib' },
];
const C_TARGET_FLAGS = [
  { name: '--arch', arity: 1, value: 'A', brief: 'arm64|x86_64' },
  { name: '--os', arity: 1, value: 'O', brief: 'linux|osx|win32' },
  {
    name: '--format', alias: '-f', arity: 1, value: 'FMT',
    brief: 'elf|macho|pe —— 容器格式，**与目标分开拨**（tcc 的 -c 在所有目标上都写 ELF）',
  },
];

/* ---- 链接器那几格，按格式分组标出来。 */
const LINK_COMMON = [
  F_OUT,
  ...C_TARGET_FLAGS,
  { name: '-e', arity: 1, value: 'NAME', brief: '入口符号' },
  { name: '-L', arity: 1, value: 'DIR', brief: '库的搜索目录，可重复' },
  { name: '-l', arity: 1, value: 'NAME', brief: '链一个库' },
  /* `--stdlib`：tcc 的 `tcc_add_runtime`（默认 libc + crt 那三个 `.o` + 入口 `_start`）。
   * tcc 那边这件事是 `-nostdlib` 反过来说的；我们摆成开关，因为 `c link` 也用来链
   * 不带 libc 的东西（交叉目标、字节判据）。 */
  { name: '--stdlib', arity: 0, brief: '带上默认 libc 与 crt（= tcc 不给 -nostdlib 时那一份）' },
  { name: '-r', arity: 0, brief: '出可重定位的 .o（tcc -r，从前叫 elf-r）' },
  { name: '--shared', arity: 0, brief: '出共享库' },
  { name: '--rdata', arity: 1, value: 'NAME', brief: '只读节的名字（PE 上叫 .rdata）' },
  { name: '--unwind', arity: 0, brief: '保留 .eh_frame' },
  { name: '-g', arity: 0, brief: '保留 .stab/.stabstr' },
  { name: '-gdwarf', arity: 0, brief: '保留 dwarf 那几节' },
  { name: '--dwarf', arity: 1, value: 'N', brief: 'dwarf 版本' },
  /* `-q`：不印那行产物摘要。给的是**上层命令**用的（`omni run x.c` 内部要链一次，
   * 而 `run` 的 stdout 归被跑的程序）—— 交互着用的时候没必要给。 */
  { name: '-q', arity: 0, brief: '不印产物摘要（给上层命令内部调用用）' },
  { name: '--sysroot', arity: 1, value: 'DIR', brief: '交叉编译：库 DIR/lib；不给就按 --arch/--os 取自带的' },
  /* `--libc self`（第一百四十片）：链 `<sysroot>/libc/*.c` 编出来的那份自带 libc，
   * 一个外部库都不要 —— 出来的是纯静态的可执行文件。sysroot 不给就按目标取自带的
   * （`src/sysroot/<arch>-<os>`，第一百四十六片）。 */
  F_LIBC,
];
const LINK_ELF_ONLY = [
  { name: '--static', arity: 0, brief: '（-f elf）静态，不出 .interp/.dynamic' },
  { name: '--pie', arity: 0, brief: '（-f elf）' },
  { name: '--rdynamic', arity: 0, brief: '（-f elf）' },
  { name: '--soname', arity: 1, value: 'NAME', brief: '（-f elf）' },
  { name: '--rpath', arity: 1, value: 'PATH', brief: '（-f elf）' },
  { name: '--enable-new-dtags', arity: 0, brief: '（-f elf）' },
  { name: '--dll', arity: 1, value: 'libfoo.so', brief: '（-f elf）链一个共享库' },
  { name: '--ar', arity: 1, value: 'libfoo.a', brief: '（-f elf）按需取用一份静态库' },
];
const LINK_MACHO_ONLY = [
  { name: '--dylib', arity: 1, value: 'PATH', brief: '（-f macho）libc.tbd' },
  { name: '--libtcc1', arity: 1, value: 'PATH', brief: '（-f macho）' },
  { name: '--install-name', arity: 1, value: 'NAME', brief: '（-f macho）LC_ID_DYLIB' },
];
const LINK_PE_ONLY = [
  { name: '--target', arity: 1, value: 'T', brief: '（-f pe）x86_64-win32|arm64-win32|…' },
  { name: '--subsystem', arity: 1, value: 'NAME', brief: '（-f pe）' },
  { name: '--image-base', arity: 1, value: 'HEX', brief: '（-f pe）' },
  { name: '--stack', arity: 1, value: 'N', brief: '（-f pe）' },
  { name: '--section-align', arity: 1, value: 'HEX', brief: '（-f pe）' },
  { name: '--file-align', arity: 1, value: 'HEX', brief: '（-f pe）' },
];

/* ---- 「哪条腿」那两格。`--backend` 之外还留着的两个旧写法，实现里现在还在读它们
 * （`cli.js` 的 `rest.includes('--interp')` 与 `'--mir'`）—— 声明在这儿才不会被
 * 「不认识的开关直接骂」挡下来。它们该在分片 4 收尾时并进 `--backend`。 */
const F_LEG_INTERP = { name: '--interp', arity: 0, brief: '走解释器（= --backend interp）' };
const F_LEG_MIR = { name: '--mir', arity: 0, brief: '走 MIR 解释器，不是 OIR 那一条' };

/* ---- C 那一组。 */
const C_GROUP = {  name: 'c',
  brief: 'C 前端（ADR-0017）：预处理、到 MIR、到目标文件、链接、tcc 兼容驱动',
  help: `-D / -U / -isystem / -include 这些**只在这一组里**——它们是 C 的事实，
不该出现在与语言无关的顶层。

-I 是个例外，它在顶层也有：jancy 的 import 也按它找（第六十二刀），
而 jnc 走的是与语言无关的 run/build/emit —— 「上哪儿找源文件」不是某一门语言的事。`,
  children: [
    {
      name: 'cpp', key: 'cpp', usage: 'FILE.c',
      brief: '预处理。输出与 tcc -E -P 逐字节相同，那个相等就是测试轴',
      flags: [...C_CPP_FLAGS,
        { name: '-P', arity: 0, brief: '不印行标记' },
        { name: '-dM', arity: 0, brief: '只印宏定义' },
        { name: '-dD', arity: 0, brief: '连宏定义一起印' },
        /* `-v`/`-vv` 在这一条上是 **tcc 的** `-v`（印搜索路径），不是 omni 的 `--verbose`。
         * 节点自己声明了这个名字，`canonicalize` 就不会把它铺平成 `--verbose`。 */
        { name: '-v', arity: 0, brief: 'tcc 的 -v：印版本条与头文件搜索路径' },
        { name: '-vv', arity: 0, brief: '同上，更细' },
        { name: '-nostdinc', arity: 0, brief: '不找系统头' },
        /* tcc 没有这一格：找不到的头当空文件跳过（每份记一条警告）。开着就**不再**与
         * `tcc -E` 逐字节相同，所以必须在命令行上明说。读别人的源码当语料时要它 ——
         * 一份文件该配哪几个 `-I` 只有那棵树的构建系统知道（账在 ext/cpp/cpp.grammar）。 */
        { name: '--skip-missing-includes', arity: 0, brief: '找不到的头跳过并记警告，不报错' },
        /* 给 make 的依赖清单那一族（tcc 的 `-M` 一家）。`-MF` 在 `C_CPP_FLAGS` 里。 */
        { name: '-M', arity: 0, brief: '只出依赖清单（含系统头）' },
        { name: '-MM', arity: 0, brief: '只出依赖清单（不含系统头）' },
        { name: '-MD', arity: 0, brief: '照常预处理，另写一份依赖清单（含系统头）' },
        { name: '-MMD', arity: 0, brief: '同上，不含系统头' },
        { name: '-MP', arity: 0, brief: '给每个头再补一条空规则' },
        { name: '--arch', arity: 1, value: 'A', brief: '预定义宏跟着它走' },
        { name: '--os', arity: 1, value: 'O', brief: '同上' }],
    },
    {
      name: 'mir', key: 'c-mir', usage: 'FILE.c',
      brief: '一遍过编到 MIR（路径 B，tccgen 等价物 —— 没有 AST）',
      flags: [...C_CPP_FLAGS],
    },
    {
      name: 'run', key: 'c-run', usage: 'FILE.c [-- args...]',
      brief: '同上再跑。退出码是 C main 的返回值，所以 tcc -run 是 oracle',
      flags: [...C_CPP_FLAGS],
    },
    {
      name: 'obj', key: 'c-obj', usage: 'FILE.c -o NAME',
      brief: '编成一个真的目标文件（native，没有线性内存）',
      flags: [F_OUT, ...C_CPP_FLAGS, ...C_TARGET_FLAGS],
    },
    {
      name: 'link', key: 'c-link', usage: 'FILE.o... -o NAME [-f elf|macho|pe]',
      brief: '把 .o 链成可执行/库/可重定位的 .o（收掉 elf-r、elf-link、macho-link、pe-link）',
      help: `格式是**目标的一个属性**，走 -f/--format，不是命令的一级：tcc 的 -c 在所有
目标上都写 ELF，所以「win32 目标 + ELF 容器」是真实存在的组合，格式必须能单独拨。

只对某一个格式有意义的开关在下面标了「（-f …）」。`,
      flags: [...LINK_COMMON, ...LINK_ELF_ONLY, ...LINK_MACHO_ONLY, ...LINK_PE_ONLY],
    },
    /* tcc 兼容驱动（决策三）。**这儿不列 flags** —— 列了反而会被 `canonicalize`/`splitArgv`
     * 按 omni 的规矩动手，而 `-v`、`-r`、`-f` 在 tcc 那边是别的意思。它自己一套解析器。 */
    {
      name: 'tcc', key: 'c-tcc', usage: '[tcc 的开关…] FILE…',
      brief: '与 tcc 同一套开关的驱动 —— 门可以拿同一串 argv 喂两边比字节',
      help: TCC_HELP,
    },
    /* 旧的四条：静默别名，指向各自原来的实现。 */
    { name: 'elf-r', key: 'elf-r', hidden: true, flags: [...LINK_COMMON] },
    { name: 'elf-link', key: 'elf-link', hidden: true, flags: [...LINK_COMMON, ...LINK_ELF_ONLY] },
    { name: 'macho-link', key: 'macho-link', hidden: true, flags: [...LINK_COMMON, ...LINK_MACHO_ONLY] },
    { name: 'pe-link', key: 'pe-link', hidden: true, flags: [...LINK_COMMON, ...LINK_PE_ONLY] },
  ],
};

/* ---- 顶层。 */
export const ROOT = {
  name: 'omni',
  brief: 'stage0 bootstrap compiler',
  help: `前端**由扩展名选**（.omni/.omnid/.omnis、.js、.wat、.sx/.asy、.jnc、.c），
--mode 与 --lang 可以覆盖；后端由 --backend 选。所以顶层只有与语言无关的动词 ——
语言特有的开关在各自那一组里（omni c --help）。

type modes（ADR-0008）：.omni mixed / .omnid dynamic / .omnis static

env: OMNI_CC、OMNI_CLANG、OMNI_LLVM_CONFIG
     **默认不借外部 cc**：生成的 C 交给我们自己那台 C 前端与链接器（可执行文件、.o、
     插件的共享库都行 —— dylib 那格链完自己补一句 codesign）。要走外部 cc 就明说：
     --cc clang（或 tcc / gcc / cc / 一条路径），或者 OMNI_CC=clang ——
     **--cc 比 OMNI_CC 优先**（环境变量管一整轮，命令行管这一趟）。
     代价量在 selfCC 那段注释里。`,
  children: [
    {
      name: 'run', key: 'run', usage: 'FILE [-- args...]',
      brief: '编译并执行',
      help: `.frag/.glsl 走另一条腿（ADR-0019 决策九）：一帧一张 PNG，要 -o。
uniform 由 --set 给，没给的按 0；一个名字对一串数，逗号分开。
采样器（sampler1D/2D）由 --tex 给：宽、高、然后 W×H×4 个 RGBA 分量（行优先）。

  omni run x.frag -o out.png --size 512 --set u_resolution=512,512
  omni run x.frag -o out.png --tex u_tex=2,2,1,0,0,1,0,1,0,1,0,0,1,1,1,1,1,1

.asy 的出图格式与落地文件都是**运行期的一格宿主设置**（ADR-0015）——
产物缓存的印记里没有它们，同一份编好的东西换个设置再跑就换个输出：

  omni run x.asy                 图印到 stdout（EPS）
  omni run x.asy -f svg          图印到 stdout（SVG）
  omni run x.asy -o x.svg        格式按后缀猜（svg），图落到 x.svg
                                 —— 程序自己 write(...) 的字还是走 stdout

--timeout 管的是**整趟 run**（编 + 跑一起算，不是只算跑），默认 30 秒，
--timeout 0 撤掉它。到点的两条出口不一样，而且没法一样：跑在子进程里
（.asy 的默认路、.c、.frag、原生可执行文件）是先杀孩子再印那句话，退出码 124
（与 timeout(1) 同一个约定）；跑在本进程里（--interp 与编成 JS 直接 eval 那条）
只能开枪，退出码 137 —— 被 SIGKILL 的进程没有机会再设自己的退出码。

${graphEngineHelp()}

  omni run ext/lua/examples/basics.lua --engine graph
  omni run x.lua --engine graph --lang gsl-shell        （--lang 盖过后缀）
  omni run ext/cpp/examples/basics.cpp --engine graph --backend wat`,
      flags: [F_MODE, F_WORK, F_BACKEND, F_INC, F_LEG_INTERP, F_LEG_MIR, F_OUT,
        /* `run` **没有** `--arch`/`--os`/`--sysroot`：它本来就跑在这台机器上，
         * 交叉编译出来的东西这儿跑不动。要换编译器或换 libc 才有意义，所以只有这两格
         * （`--libc self` 那一趟的 sysroot 按本机取自带的，不用给）。 */
        F_CC, F_LIBC,
        { name: '--engine', arity: 1, value: 'E',
          brief: 'omni（默认：前端 -> OIR -> 后端）| graph（节点图 + 契约五问）' },
        { name: '--lang', arity: 1, value: 'L',
          brief: '（graph）这份源码归哪门语言，**优先于文件名后缀**' },
        { name: '--format', alias: '-f', arity: 1, value: 'FMT',
          brief: '（asy）出图格式 eps|svg；不给就看 -o 的后缀' },
        { name: '--timeout', arity: 1, value: 'SEC',
          brief: '整趟的墙上时限，默认 30；0 = 不限' },
        { name: '--size', arity: 1, value: 'N[xM]', brief: '（glsl）画布大小，默认 256' },
        { name: '--set', arity: 1, value: 'NAME=v,…', brief: '（glsl）给一个 uniform 赋值，可重复' },
        { name: '--tex', arity: 1, value: 'NAME=W,H,v,…',
          brief: '（glsl）给一个采样器一张图：宽、高、W×H×4 个 RGBA 分量，可重复' }],
    },
    {
      name: 'build', key: 'build', usage: 'FILE -o NAME',
      brief: '编译成产物',
      help: `--engine graph 时落的是**图那一层的产物**（语言按 --lang / 后缀定，同 run）：
  --backend wat  一份自足的 wasm 模块（宿主面就是那四格 print_* 导入）—— 默认。
                 **产物按 -o 的后缀定**：.wat 落文本、**.wasm 落二进制**（真引擎吃的是它）
  --backend sx   一份图的序列化（fromSx 读得回来）
  --backend js   **落不了**：那份文本是一格函数表达式，还要外面喂运行时钩子（记在账上）
  --backend interp 没有产物：它就是 graph.eval

  omni build ext/cpp/examples/basics.cpp --engine graph --backend wat -o basics.wat
  omni build ext/lua/examples/intmath.lua --engine graph -o intmath.wasm   （二进制，V8 直接吃）`,
      flags: [F_OUT, F_MODE, F_WORK, F_BACKEND_BUILD, F_INC, F_STATS,
        ...C_TARGET_FLAGS,
        F_SYSROOT, F_LIBC, F_CC,
        { name: '--engine', arity: 1, value: 'E',
          brief: 'omni（默认）| graph（节点图：产物是 wat / wasm / sx）' },
        { name: '--lang', arity: 1, value: 'L',
          brief: '（graph）这份源码归哪门语言，**优先于文件名后缀**' },
        { name: '--plugin', arity: 1, value: 'NAME', brief: '出一格插件动态库，NAME 是它的 register 函数' },
        { name: '--fat', arity: 0, brief: '把所有语言都编进核心（默认是薄核心 + plugins/）' },
        { name: '--extern', arity: 0, brief: '生成的函数用外部链接并导出（插件要能绑到它）' },
        { name: '--own', arity: 1, value: 'A,B', brief: '只发这些文件里的函数与全局，别的当 extern' },
        { name: '--bind', arity: 1, value: 'FILE', brief: '按核心的 .syms 决定发哪些：它有的绑过去，没有的自己发' },
        { name: '--plugins', arity: 0, brief: '核心编完接着把默认那一套插件编齐（同一条进程，流水账才算得齐）' }],
    },
    {
      name: 'plugins', key: 'plugins', usage: '--core FILE [-o DIR]',
      brief: '把默认那一套插件一次编齐（核心什么都不内建）',
      flags: [F_OUT, F_WORK, F_STATS, F_CC,
        { name: '--core', arity: 1, value: 'FILE', brief: '核心产物（按它旁边那份 .syms 绑符号）' },
        { name: '--only', arity: 1, value: 'A,B', brief: '只编这几格（名字见 core/plugin-set.js）' }],
    },
    {
      name: 'emit', key: 'emit', usage: 'FORM FILE',
      brief: '印某个中间/目标形态：ast|oir|mir|sx|asy|js|c|llvm|spirv',
      flags: [F_MODE, F_WORK, F_INC, F_STATS,
        { name: '--amalgamate', arity: 0, brief: '（c）把整份运行时内联进一个文件' },
        { name: '--split', arity: 0, brief: '（c）按模块分成一个个 .c 落到 --work DIR' },
        { name: '--fat', arity: 0, brief: '把所有语言都编进核心（默认是薄核心 + plugins/）' },
        { name: '--bytes', arity: 0, brief: '（mir）印大小与每个函数的内容哈希' },
        { name: '--kernel', arity: 1, value: 'NAME', brief: '（spirv）哪一个 kernel' }],
    },
    {
      name: 'check', key: 'check', usage: 'FILE',
      brief: '只走前端与检查器，不出产物', flags: [F_MODE, F_INC],
    },
    C_GROUP,
    {
      name: 'glr',
      /* 这一组有 `key`：`omni glr FILE.grammar FILE...` 是旧的扁平写法，而 `table`/`parse`
       * 都不会撞上一个 `.grammar` 路径 —— 于是「下一个记号不是子命令名」就落回组自己，
       * 跑老那一条（`git stash` = `git stash push` 那个套路）。 */
      key: 'glr',
      brief: 'GLR 那一组（ADR-0014 决策二）：建表、拿语法解析',
      flags: [{ name: '--count', arity: 0, brief: '每个输入印一行摘要' },
        { name: '--brief', arity: 0, brief: '（table）只印规则与剩下的冲突' }],
      children: [
        {
          name: 'table', key: 'glr-table', usage: 'FILE.grammar',
          brief: '印解析表', flags: [{ name: '--brief', arity: 0, brief: '只印规则与剩下的冲突' }],
        },
        {
          name: 'parse', key: 'glr', usage: 'FILE.grammar FILE...',
          brief: '解析并印 s-expr（多个输入只建一次表）',
          flags: [{ name: '--count', arity: 0, brief: '每个输入印一行摘要' }],
        },
        {
          name: 'y', key: 'glr-y', usage: 'FILE.y',
          /* `table` / `parse` 两条自己也认 `.y`（load.js 那一格转）。这条是把**转出来的
           * 那份文本**印出来 —— 语法哪里读歪了，看这一份比看表快。 */
          brief: '把 bison/yacc 的 .y 转成 .grammar 印出来', flags: [],
        },
        {
          name: 'ebnf', key: 'glr-ebnf', usage: 'FILE.ebnf',
          /* 与上一条同一件事，换一种方言：W3C / bottlecaps 风的 EBNF（标准里那份语法
           * 本身就是这个形状）。`table` / `parse` 也直接认 `.ebnf`。 */
          brief: '把 W3C 风的 .ebnf 转成 .grammar 印出来', flags: [],
        },
      ],
    },
    {
      name: 'repl', key: 'repl', usage: '（不要源文件）',
      brief: '交互会话',
      flags: [F_MODE,
        { name: '--lang', arity: 1, value: 'L', brief: 'omni|sx|asy|js' },
        { name: '--engine', arity: 1, value: 'E', brief: 'interp|js' }],
    },
    {
      name: 'incr', key: 'incr', usage: 'FILE',
      brief: '过内容寻址的缓存一个函数一个函数地编，印命中/未命中',
      flags: [{ name: '--cache', arity: 1, value: 'DIR', brief: '默认 .omni-cache/incr' },
        { name: '--list', arity: 0, brief: '每个单元一行' }],
    },
    {
      name: 'bootstrap', key: 'bootstrap', usage: '[FILE]',
      brief: '把整条链建进一个目录并查四条不动点',
      flags: [F_OUT, { name: '--quick', alias: '-q', arity: 0, brief: '跳过 C 那一路' }],
    },
    { name: 'help', key: 'help', usage: '[legacy]', brief: '印用法；omni help legacy 是旧名对照表' },

    /* ---- 旧的扁平名：静默别名（决策六）。
     * 这些与新名走**同一段实现**，所以认识的开关也得一样 —— `-I`（jnc 的 import 目录）
     * 少在哪一条上，那一条就会把目录当成源文件。 */
    { name: 'run-c', key: 'run-c', hidden: true, flags: [F_MODE, F_WORK, F_INC] },
    { name: 'run-llvm', key: 'run-llvm', hidden: true, flags: [F_MODE, F_WORK, F_INC] },
    { name: 'run-jit', key: 'run-jit', hidden: true, flags: [F_MODE, F_WORK, F_INC] },
    { name: 'build-llvm', key: 'build-llvm', hidden: true, flags: [F_OUT, F_MODE, F_WORK, F_INC] },
    { name: 'emit-js', key: 'emit-js', hidden: true, flags: [F_MODE, F_INC] },
    {
      name: 'emit-c', key: 'emit-c', hidden: true,
      flags: [F_MODE, F_INC, F_STATS, { name: '--amalgamate', arity: 0 }],
    },
    { name: 'emit-llvm', key: 'emit-llvm', hidden: true, flags: [F_MODE, F_INC] },
    {
      name: 'emit-spirv', key: 'emit-spirv', hidden: true,
      flags: [F_MODE, F_INC, { name: '--kernel', arity: 1 }],
    },
    { name: 'emit-asy', key: 'emit-asy', hidden: true, flags: [F_MODE, F_INC] },
    { name: 'ast', key: 'ast', hidden: true, flags: [F_MODE, F_INC] },
    { name: 'oir', key: 'oir', hidden: true, flags: [F_MODE, F_INC] },
    { name: 'mir', key: 'mir', hidden: true, flags: [F_MODE, F_INC, { name: '--bytes', arity: 0 }] },
    { name: 'sx', key: 'sx', hidden: true, flags: [F_MODE, F_INC] },
    { name: 'interp', key: 'interp', hidden: true, flags: [F_MODE, F_INC, F_LEG_MIR, F_LEG_INTERP] },
    { name: 'asy-units', key: 'asy-units', hidden: true, flags: [] },
    { name: 'glr-table', key: 'glr-table', hidden: true, flags: [{ name: '--brief', arity: 0 }] },
    { name: 'cpp', key: 'cpp', hidden: true, flags: C_GROUP.children[0].flags },
    { name: 'c-mir', key: 'c-mir', hidden: true, flags: [...C_CPP_FLAGS] },
    { name: 'c-run', key: 'c-run', hidden: true, flags: [...C_CPP_FLAGS] },
    { name: 'c-obj', key: 'c-obj', hidden: true, flags: [F_OUT, ...C_CPP_FLAGS, ...C_TARGET_FLAGS] },
    { name: 'elf-r', key: 'elf-r', hidden: true, flags: [...LINK_COMMON] },
    { name: 'elf-link', key: 'elf-link', hidden: true, flags: [...LINK_COMMON, ...LINK_ELF_ONLY] },
    { name: 'macho-link', key: 'macho-link', hidden: true, flags: [...LINK_COMMON, ...LINK_MACHO_ONLY] },
    { name: 'pe-link', key: 'pe-link', hidden: true, flags: [...LINK_COMMON, ...LINK_PE_ONLY] },
  ],
};

/** `omni help legacy` 印的那张表。 */
export const LEGACY = [
  ['run-c', 'run --backend c'],
  ['run-llvm', 'run --backend llvm'],
  ['run-jit', 'run --backend jit'],
  ['build-llvm', 'build --backend llvm'],
  ['emit-js', 'emit js'],
  ['emit-c', 'emit c'],
  ['emit-llvm', 'emit llvm'],
  ['emit-spirv', 'emit spirv'],
  ['emit-asy', 'emit asy'],
  ['ast', 'emit ast'],
  ['oir', 'emit oir'],
  ['mir', 'emit mir'],
  ['sx', 'emit sx'],
  ['cpp', 'c cpp'],
  ['c-mir', 'c mir'],
  ['c-run', 'c run'],
  ['c-obj', 'c obj'],
  ['elf-r', 'c link -r -f elf'],
  ['elf-link', 'c link -f elf'],
  ['macho-link', 'c link -f macho'],
  ['pe-link', 'c link -f pe'],
  ['glr-table', 'glr table'],
  ['glr', 'glr parse'],
];
