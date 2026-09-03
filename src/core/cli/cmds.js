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

/* ---- 与语言无关的那几格开关，好几条命令共用。 */
const F_OUT = { name: '-o', arity: 1, value: 'NAME', brief: '产物落在哪儿' };
const F_MODE = { name: '--mode', arity: 1, value: 'M', brief: 'mixed|dynamic|static（ADR-0008）' };
const F_WORK = { name: '--work', arity: 1, value: 'DIR', brief: '生成的中间文件留在这儿' };
const F_BACKEND = {
  name: '--backend', arity: 1, value: 'B',
  brief: 'interp|js|c|llvm|jit|native|spirv',
};

/* ---- C 前端那几格（`-I` 这种只在这儿出现，不在顶层）。 */
const C_CPP_FLAGS = [
  { name: '-I', arity: 1, value: 'DIR', brief: '#include 的搜索目录，可重复' },
  { name: '-D', arity: 1, value: 'M[=V]', brief: '预定义一个宏' },
  { name: '-U', arity: 1, value: 'M', brief: '取消一个预定义宏' },
  { name: '-isystem', arity: 1, value: 'DIR', brief: '系统头的搜索目录' },
  { name: '-include', arity: 1, value: 'FILE', brief: '开头先吃一份头文件' },
  { name: '-MF', arity: 1, value: 'FILE', brief: '依赖表写到这儿' },
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
  { name: '-r', arity: 0, brief: '出可重定位的 .o（tcc -r，从前叫 elf-r）' },
  { name: '--shared', arity: 0, brief: '出共享库' },
  { name: '--rdata', arity: 1, value: 'NAME', brief: '只读节的名字（PE 上叫 .rdata）' },
  { name: '--unwind', arity: 0, brief: '保留 .eh_frame' },
  { name: '-g', arity: 0, brief: '保留 .stab/.stabstr' },
  { name: '-gdwarf', arity: 0, brief: '保留 dwarf 那几节' },
  { name: '--dwarf', arity: 1, value: 'N', brief: 'dwarf 版本' },
];
const LINK_ELF_ONLY = [
  { name: '--static', arity: 0, brief: '（-f elf）静态，不出 .interp/.dynamic' },
  { name: '--pie', arity: 0, brief: '（-f elf）' },
  { name: '--rdynamic', arity: 0, brief: '（-f elf）' },
  { name: '--soname', arity: 1, value: 'NAME', brief: '（-f elf）' },
  { name: '--rpath', arity: 1, value: 'PATH', brief: '（-f elf）' },
  { name: '--enable-new-dtags', arity: 0, brief: '（-f elf）' },
  { name: '--dll', arity: 1, value: 'libfoo.so', brief: '（-f elf）链一个共享库' },
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

/* ---- C 那一组。 */
const C_GROUP = {
  name: 'c',
  brief: 'C 前端（ADR-0017）：预处理、到 MIR、到目标文件、链接、tcc 兼容驱动',
  help: `-I / -D / -U / -isystem / -include 这些**只在这一组里**——它们是 C 的事实，
不该出现在与语言无关的顶层。`,
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

env: OMNI_CC、OMNI_CLANG、OMNI_LLVM_CONFIG`,
  children: [
    {
      name: 'run', key: 'run', usage: 'FILE [-- args...]',
      brief: '编译并执行',
      flags: [F_MODE, F_WORK, F_BACKEND],
    },
    {
      name: 'build', key: 'build', usage: 'FILE -o NAME',
      brief: '编译成产物',
      flags: [F_OUT, F_MODE, F_WORK, F_BACKEND],
    },
    {
      name: 'emit', key: 'emit', usage: 'FORM FILE',
      brief: '印某个中间/目标形态：ast|oir|mir|sx|asy|js|c|llvm|spirv',
      flags: [F_MODE, F_WORK,
        { name: '--amalgamate', arity: 0, brief: '（c）把整份运行时内联进一个文件' },
        { name: '--bytes', arity: 0, brief: '（mir）印大小与每个函数的内容哈希' },
        { name: '--kernel', arity: 1, value: 'NAME', brief: '（spirv）哪一个 kernel' }],
    },
    { name: 'check', key: 'check', usage: 'FILE', brief: '只走前端与检查器，不出产物', flags: [F_MODE] },
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

    /* ---- 旧的扁平名：静默别名（决策六）。 */
    { name: 'run-c', key: 'run-c', hidden: true, flags: [F_MODE, F_WORK] },
    { name: 'run-llvm', key: 'run-llvm', hidden: true, flags: [F_MODE, F_WORK] },
    { name: 'run-jit', key: 'run-jit', hidden: true, flags: [F_MODE, F_WORK] },
    { name: 'build-llvm', key: 'build-llvm', hidden: true, flags: [F_OUT, F_MODE, F_WORK] },
    { name: 'emit-js', key: 'emit-js', hidden: true, flags: [F_MODE] },
    { name: 'emit-c', key: 'emit-c', hidden: true, flags: [F_MODE, { name: '--amalgamate', arity: 0 }] },
    { name: 'emit-llvm', key: 'emit-llvm', hidden: true, flags: [F_MODE] },
    { name: 'emit-spirv', key: 'emit-spirv', hidden: true, flags: [F_MODE, { name: '--kernel', arity: 1 }] },
    { name: 'emit-asy', key: 'emit-asy', hidden: true, flags: [F_MODE] },
    { name: 'ast', key: 'ast', hidden: true, flags: [F_MODE] },
    { name: 'oir', key: 'oir', hidden: true, flags: [F_MODE] },
    { name: 'mir', key: 'mir', hidden: true, flags: [F_MODE, { name: '--bytes', arity: 0 }] },
    { name: 'sx', key: 'sx', hidden: true, flags: [F_MODE] },
    { name: 'interp', key: 'interp', hidden: true, flags: [F_MODE] },
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
