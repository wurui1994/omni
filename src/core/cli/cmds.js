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
/**
 * 运行时 profiler（第一百四十七片）。三档：
 *   cc      编译器插桩（`-finstrument-functions`）。**外部 clang/gcc 与我们自己那台 C
 *           前端都有**（第一百五十片第三格：`emitProfCall`），所以 `--cc self` 也量得到
 *   sample  定时器 + backtrace（低开销）；`sample:997` 指定每秒帧数
 *   stub    发射期插桩（`OMNI_PROFILE=1`，emit.js 里那一份）；`.c` 输入上它与 `cc` 同一台机器
 * `--profile` 一个字不带 = `cc`（外部 cc 那一路）或 `sample`（`--cc self` 那一路）。
 * `--profile-out FILE` 输出折叠栈文件（火焰图 / gprof2dot 吃它）。
 */
const F_PROFILE = {
  name: '--profile', arity: 1, value: 'MODE',
  brief: 'cc（C 腿 / .c 输入，-finstrument-functions，自带前端也有）'
    + ' | stub（C + js + .c 输入，插桩）'
    + ' | sample[:hz]（C 腿 / .c 输入 / --direct，定时器采样）—— 认腿，对不上当场报',
};
/**
 * **`#lang` 那一格的开关**（ADR-0037 的事情一）。默认关着 —— ADR-0009 立的规矩是
 * "一份文件的语言由后缀决定，不猜"，`#lang` 是那条规矩的一个 opt-in 例外，不是替代。
 * 关着的时候遇到 `#lang` **当场报**并给出开法（静默当注释是最坏的一种）。
 * 环境那一格 `OMNI_LANG_DIRECTIVE=1` 是给子进程继承用的，与 `OMNI_PROF` 同一手法。
 */
const F_LANG_DIRECTIVE = {
  name: '--lang-directive', arity: 0,
  brief: '认第一行的 `#lang <名字>`（默认不认；等价 OMNI_LANG_DIRECTIVE=1）',
};
/**
 * 借来语言（`.go`/`.nim`/…）译出来的**核心方言**落一份到 FILE（调试通道）。
 *
 * 默认它只在内存里传一手：那份文本是中间格式，不是产物 —— 落盘就多出一摊
 * `src-sx/<内容哈希>/` 目录与一格谁都不清的缓存。想看就给这个旗子。
 */
/* C 那侧走按模块还是单体（§12）。默认只有 asy 按模块（它的库大、用户文件小，收益全在那儿），
 * 别的语言默认单体 —— 这两格是**显式拨**用的，`run` 与 `build` 都收。 */
const F_MODULES = {
  name: '--modules', arity: 0,
  brief: '（c）一个模块一份 .c/.h，各自一格 .o 暖存（asy 默认就是它）',
};
const F_ONE_FILE = {
  name: '--one-file', arity: 0,
  brief: '（c）整份程序发成一份 .c（asy 上用它退回单体）',
};
const F_EMIT_SX = {
  name: '--emit-sx', arity: 1, value: 'FILE',
  brief: '把译出来的核心方言写到 FILE（默认只在内存里过）',
};
const F_PROFILE_OUT = {
  name: '--profile-out', arity: 1, value: 'FILE',
  brief: '折叠栈写到 FILE（火焰图 / gprof2dot 吃它）；`.svg` 直接出火焰图',
};
/**
 * **不裁产物里的运行时那一段**（js 腿的摇树，见 `backend-js/emit.js` 的 `trimJsRuntime`）。
 *
 * 是逃生门不是调优开关：摇树漏留一个名字的后果是运行期 `xxx is not defined`，
 * 这一格让人一句话把「是不是这一刀削掉的」分清。量出来的账在那个函数头上。
 */
const F_NO_TRIM = {
  name: '--no-trim', arity: 0,
  brief: '（js）不按用到的名字裁运行时那一段 —— 出了事用它把整份带回来对照',
};
/**
 * **一份 `.js` 原样交给 node**（第一百四十八片第二格）。
 *
 * 量到的账（`bench/fib.js` 823 字节）：我们那一轮发出来 371770 字节、整趟 459ms；
 * 直接给 node 是 823 字节、113ms。语义差别明说：直路上没有 ADR-0011 那层
 * （int 的规范形、按字节的字符串…），直路就是 node 自己的语义 —— 所以是开关不是默认。
 */
const F_DIRECT = {
  name: '--direct', arity: 0,
  brief: '（.js）原样交给 node，不过我们这一轮 —— 语义就是 node 自己的',
};
/**
 * 构建统计与依赖图（第一百四十七片第二格）。
 *
 * **与 `--stats` 是两格不同的东西**（名字只差一个 s，所以这儿说清楚）：
 *   `--stats`  按**源文件**的产出分布（哪份源码发了多少字节的 C）
 *   `--stat`   **模块依赖图** + 构建统计（谁 import 谁、最长链、被依赖最多、产出最大）
 * 前者回答「谁大」，后者回答「谁把谁带进来的」——合在一起才看得见该动哪儿。
 */
const F_STAT = {
  name: '--stat', arity: 0,
  brief: '印构建统计与依赖图（--stats 是另一格：按源文件的产出分布）',
};
const F_STAT_OUT = {
  name: '--stat-out', arity: 1, value: 'FILE',
  brief: '依赖图写到 FILE —— `.dot`（graphviz）/ `.json` 按后缀定',
};
/**
 * 两张图**逐格相减**（只在 `--engine graph` 那一路有意思）：本文件是基线，`FILE` 是变换后。
 * 这一格是 `docs/design/node-graph-shrink.md` 第三条要求（「变换是减法：每个 pass 要能报出
 * 删了几格节点」）的量尺 —— 没有它，「缩了没有」只能靠感觉。
 */
const F_STAT_DIFF = {
  name: '--stat-diff', arity: 1, value: 'FILE',
  brief: '（--engine graph）拿 FILE 的图当变换后，按 op 逐格相减（+ 是胀，- 是缩）',
};
/**
 * 图这一层的**第一个 pass**（`src/core/graph/shrink.js`）：常量折叠 + 死绑定删除。
 * 开关本身就会把账印出来（折了几格、删了几格）—— 那是 shrink 文档第三条要求的字面意思，
 * 不是 `-v` 才有的调试话。再给 `--stat` 就连按 op 的差表一起印。
 */
const F_SHRINK = {
  name: '--shrink', arity: 0,
  brief: '（--engine graph）先缩一遍图：常量折叠 + 死绑定删除，并报出删了几格',
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
  /* `-framework Foo`：与 clang 同名同形（`(lib "Foo.framework")` 落到这儿）。
     实现是"到 SDK 里找那份 `.tbd` stub 再按 --dylib 装"——framework 的二进制在 dyld
     的共享缓存里、磁盘上没有那个文件，只有 stub 有符号表。 */
  { name: '-framework', arity: 1, value: 'NAME', brief: '（-f macho）链一个 macOS framework' },
  /* `--stack-size`：主线程栈的大小写进 `LC_MAIN`（ld 的 `-stack_size`）。macOS 上这个
     大小是链接期定死的，而入口留不留在主线程要看它 —— 见 macho_exe 那段说明。 */
  { name: '--stack-size', arity: 1, value: 'N', brief: '（-f macho）主线程的栈 = LC_MAIN.stacksize' },
];
const LINK_PE_ONLY = [
  { name: '--target', arity: 1, value: 'T', brief: '（-f pe）x86_64-win32|arm64-win32|…' },
  { name: '--subsystem', arity: 1, value: 'NAME', brief: '（-f pe）' },
  { name: '--image-base', arity: 1, value: 'HEX', brief: '（-f pe）' },
  { name: '--stack', arity: 1, value: 'N', brief: '（-f pe）' },
  { name: '--section-align', arity: 1, value: 'HEX', brief: '（-f pe）' },
  { name: '--file-align', arity: 1, value: 'HEX', brief: '（-f pe）' },
  /* 链接图：一行 `0x<地址> <名字>`。profile 的每一帧靠它从裸地址翻回名字 ——
     ELF 可执行文件里我们不写 `.symtab`，glibc 的 backtrace 于是只给地址。 */
  { name: '--map', arity: 1, value: 'FILE', brief: '落一份地址->名字的链接图' },
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
  omni run ext/cpp/examples/basics.cpp --engine graph --backend wat

**借来的那些语言不用给 --engine**：它们与 .c 一样按后缀选前端 ——
译成核心方言（.sx，落在 .omni-cache/src-sx/<内容哈希>/）之后走的是和 .sx 输入
一模一样的那条路，所以 --backend / --cc / --profile / 摇树 / 暖存全都照旧管用：
  omni run bench/go/fib.go                      跑掉（默认 js 那条腿）
  omni build bench/go/pt.go -o pt               原生二进制（一条命令，不用先落 .sx）
  omni build ext/chez/examples/basics.ss -o s   Scheme 也一样
  omni emit c bench/go/pt.go                    看生成的 C
后缀名单从 graph/langs.js 那张表算；**已经有主的后缀不抢**（.lua 归它自带的读入器）。
给了 --engine graph 才切到图那一层的后端（那儿的 --backend 是另一套名字）。`,
      flags: [F_MODE, F_WORK, F_BACKEND, F_INC, F_LEG_INTERP, F_LEG_MIR, F_OUT, F_EMIT_SX,
        /* `run` **没有** `--arch`/`--os`/`--sysroot`：它本来就跑在这台机器上，
         * 交叉编译出来的东西这儿跑不动。要换编译器或换 libc 才有意义，所以只有这两格
         * （`--libc self` 那一趟的 sysroot 按本机取自带的，不用给）。 */
        F_CC, F_LIBC, F_MODULES, F_ONE_FILE, F_PROFILE, F_PROFILE_OUT, F_NO_TRIM,
        F_DIRECT, F_LANG_DIRECTIVE,
        /* `--stat` 在 `run` 上只对 `--engine graph` 那一路有话说（图的形状与结构）——
         * 另一台机器的构建统计要 `build --stat`（那儿才有 cgen 的产出分布）。 */
        F_STAT, F_STAT_OUT, F_STAT_DIFF, F_SHRINK,
        { name: '--engine', arity: 1, value: 'E',
          brief: 'omni（默认：前端 -> OIR -> 后端）| graph（节点图 + 契约五问）' },
        { name: '--lang', arity: 1, value: 'L',
          brief: '（graph）这份源码归哪门语言，**优先于文件名后缀**' },
        { name: '--pkg', arity: 0,
          brief: '（graph）把同目录下所有同语言文件一起编（go 的包 = 一个目录）' },
        { name: '--pkgs', arity: 1, value: 'DIR,DIR,...',
          brief: '（graph）按拓扑序编多个包目录到一张图（逗号分隔绝对路径）' },
        { name: '--pkgs-root', arity: 1, value: 'DIR',
          brief: '（graph/go）扫 import 自动发现同级依赖包（DIR 下子目录匹配路径末段）' },
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
  --backend js   一份**自足的 .mjs**（钩子摊在最前面，node 直接跑）—— 默认 -o 后缀是 .mjs
  --backend interp 没有产物：它就是 graph.eval

  omni build ext/cpp/examples/basics.cpp --engine graph --backend wat -o basics.wat
  omni build ext/lua/examples/intmath.lua --engine graph -o intmath.wasm   （二进制，V8 直接吃）`,
      flags: [F_OUT, F_MODE, F_WORK, F_BACKEND_BUILD, F_INC, F_STATS, F_EMIT_SX,
        ...C_TARGET_FLAGS,
        F_SYSROOT, F_LIBC, F_CC, F_MODULES, F_ONE_FILE,
        F_PROFILE, F_PROFILE_OUT, F_STAT, F_STAT_OUT, F_STAT_DIFF,
        F_SHRINK, F_LANG_DIRECTIVE,
        { name: '--engine', arity: 1, value: 'E',
          brief: 'omni（默认）| graph（节点图：产物是 wat / wasm / sx）' },
        { name: '--lang', arity: 1, value: 'L',
          brief: '（graph）这份源码归哪门语言，**优先于文件名后缀**' },
        { name: '--pkg', arity: 0,
          brief: '（graph）把同目录下所有同语言文件一起编（go 的包 = 一个目录）' },
        { name: '--pkgs', arity: 1, value: 'DIR,DIR,...',
          brief: '（graph）按拓扑序编多个包目录到一张图（逗号分隔绝对路径）' },
        { name: '--pkgs-root', arity: 1, value: 'DIR',
          brief: '（graph/go）扫 import 自动发现同级依赖包' },
        { name: '--plugin', arity: 1, value: 'NAME', brief: '出一格插件动态库，NAME 是它的 register 函数' },
        { name: '--fat', arity: 0, brief: '把所有语言都编进核心（默认是薄核心 + plugins/）' },
        { name: '--extern', arity: 0, brief: '生成的函数用外部链接并导出（插件要能绑到它）' },
        { name: '--own', arity: 1, value: 'A,B', brief: '只发这些文件里的函数与全局，别的当 extern' },
        { name: '--bind', arity: 1, value: 'FILE', brief: '按核心的 .syms 决定发哪些：它有的绑过去，没有的自己发' },
        { name: '--plugins', arity: 0, brief: '核心编完接着把默认那一套插件编齐（同一条进程，流水账才算得齐）' }],
    },
    {
      /**
       * 折叠栈 -> 火焰图（第一百四十七片第四格）。
       *
       * 为什么要单独一格命令：`--profile-out x.svg` 只管**这一趟**跑出来的账，而
       * `OMNI_PROF=sample` 那一路是**产物自己**写的折叠栈（自举出来的 `dist/omni`、
       * 交叉编出去的二进制、别人机器上跑的那一份）—— 那些文件回来之后要有一格能渲的门。
       * 渲染归 CLI 这条纪律没变（运行时在信号里，不干这种事）。
       */
      name: 'flame', key: 'flame', usage: 'FILE[.folded|.cpuprofile|.heapprofile] [-o OUT.svg | --table | --diff 基线]',
      brief: '一份聚合回溯的四种读法：火焰图 / 五张表 / 两份对照（时间与**分配**两种账都收）',
      flags: [{ name: '-o', arity: 1, value: 'OUT', brief: '出到哪儿；不给就是 FILE 换成 .svg' },
        { name: '--table', arity: 0, brief: '印那五张（摘要 / 函数表 / 热路径 / 调用边 / 调用树），不出图' },
        { name: '--diff', arity: 1, value: 'BASE', brief: '与基线对照：每格函数的 Δ自用 与 Δ占比（百分点）' },
        { name: '--unit', arity: 1, value: 'U', brief: 'frames（.folded）| us（.cpuprofile）| bytes（.heapprofile）—— 默认按后缀' }],
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
      flags: [F_MODE, F_WORK, F_INC, F_STATS, F_LANG_DIRECTIVE,
        { name: '--amalgamate', arity: 0, brief: '（c）把整份运行时内联进一个文件' },
        { name: '--modules', arity: 0, brief: '（c）按模块各出一份 .c/.h 落到 --work DIR' },
        { name: '--module-files', arity: 0,
          brief: '（c）把这一份当**一个自足的模块**发：.h 只有接口、.c 装实现' },
        { name: '--fat', arity: 0, brief: '把所有语言都编进核心（默认是薄核心 + plugins/）' },
        F_NO_TRIM,
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
    {
      name: 'cache', key: 'cache', usage: 'ls|gc|clean',
      brief: '暖存与暂存的账：多大、多久没动、倒垃圾',
      help: `缓存与暂存是两件事，这条命令把它们分开算：
  缓存（rt/ glr/ incr/ …）  键是内容，命中就省一趟 —— 留着有用
  暂存（work/）             一次性的中间文件 —— **用完就该没了**
  判据（epsref/ …）         真 asy 出的那些参考图 —— gc **一律不碰**

  omni cache ls                 每一格多大、最后动过是什么时候（按大小降序）
  omni cache gc                 倒垃圾：work/ 整棵扔 + 14 天没动过的整格扔
  omni cache gc --days 3        换个天数（--days -1 = 只扔 work/）
  omni cache gc --max-mb 500    还超这个数就从最旧的接着扔
  omni cache clean              整个缓存根扔掉（下一趟全部重算）
  omni cache gc --oracle        连判据那几格也扔（想清楚再用，见下）

为什么要有它：从前没有任何地方回收，量到过 657 个 work 目录 518 MB，
名字还都是 \`c-75d7a0838ed4f474\` 这种路径哈希 —— 一格都看不出是谁的。
现在暂存目录按进程号命名、用完就扔，持久那几格的名字跟着文件名走。

为什么 epsref 要特殊对待：那是近 200 份真 asy 出的图，重做一遍要跑近 200 次
asy（5 分多钟），而 tests/asy/eps.js 默认不生成 —— 清掉之后那一轴不报错，
只安静地把每个例子记成"没有参考、不计分"。这件事真发生过一次。`,
      flags: [{ name: '--days', arity: 1, value: 'N', brief: 'gc：多少天没动就整格扔（默认 14）' },
        { name: '--max-mb', arity: 1, value: 'N', brief: 'gc：总量上限，超了从最旧的接着扔' },
        { name: '--oracle', arity: 0, brief: 'gc：连判据（epsref/…）也扔' },
        { name: '-n', arity: 0, brief: '只说会扔什么，不动手' }],
    },
    {
      name: 'ninja', key: 'ninja', usage: '[目标…]',
      brief: '按一张依赖图把该做的做完（吃 .ninja 与 build.js）',
      help: `入口不给 -f 时按次序找：**build.ninja → build.js**，两者地位不同：
  .ninja  我们自己读，然后跑
  .js     **转交给 node 跑它**（node build.js …，开关与目标原样递过去，退出码带回来）

**build.js 就是一份正常的 JS**：\`node build.js\` 直接能跑，omni 在那个项目里只是一个包 ——
  import { Build } from 'omni-lang/build';
  const b = new Build();
  b.rule('cc', { command: 'cc -c $in -o $out' });
  b.build('a.o', 'cc', 'a.c'); b.default('a.o');
  b.run(process.argv.slice(2));
两种用法是同一段实现（build/engine.js），所以开关与行为一致：

  omni ninja                     做完 default 那些目标
  omni ninja app -j 4            只做 app
  omni ninja -n                  只印要跑什么，不跑（dry run）
  omni ninja --emit-ninja        把图印成一份 .ninja（通向 cmake 那侧生态的单向桥）
  omni ninja -t dirty            印每条边脏不脏 —— "它为什么又要重编"看这个
  omni ninja -t commands|targets|graph|clean

上一趟的命令哈希与耗时记在 ./.omni_log；命令哈希里掺了**编译器自己的指纹**
（OMNI_BUILD_FINGERPRINT 可以指定），所以改了后端、命令字面量没变，该重编的还是会重编。
设计写在 docs/design/build-system.md。`,

      flags: [{ name: '-f', alias: '--file', arity: 1, value: 'FILE', brief: '入口（.ninja 或 .js）' },
        { name: '-j', arity: 1, value: 'N', brief: '并发上限（现在一次一条，见设计 §9）' },
        { name: '-n', arity: 0, brief: '只印不跑' },
        { name: '-k', arity: 0, brief: '一条失败了接着跑别的' },
        { name: '-t', arity: 1, value: 'TOOL', brief: 'commands|targets|graph|clean|dirty' },
        { name: '--emit-ninja', arity: 0, brief: '把图印成 .ninja' }],
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
