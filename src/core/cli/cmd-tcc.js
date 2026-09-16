/**
 * `omni c tcc` —— tcc 兼容驱动（ADR-0018 决策三）。
 *
 * **它是尺子。** 工程终点是「我们的 tcc 能编 tinycc 全部源码，且写出的字节与 tcc 相同」，
 * 可 32 处门现在在手工拼 `c-obj --arch x86_64 --os linux --format elf -o …`，与尺子那边的
 * `x86_64-tcc -B$SRC -c x.c -o x.o` 是**两串不同的 argv**。中间那层翻译是我们自己写的，
 * 它错了门也未必红。有了这一条，门可以拿**同一串 argv** 喂两边。
 *
 * 所以这一份的规矩与别的命令不同：
 *
 *   1. **自己一套解析器。** tcc 的 `-v`/`-vv` 与 omni 的 `--verbose` 语义不同，`-r` 与
 *      omni 的别名铺平也不同 —— 混在一起必错（`omni c cpp -v` 那一条已经证过一次）。
 *   2. **不认识的开关要骂**，不像别处那样放过：尺子那边 `tcc` 收的它就该收，`tcc` 不收的
 *      收下来只会让门以为比过了。
 *   3. 它只做**翻译**：把 tcc 的一串开关变成 `(哪一条 omni 命令, 那条命令的 argv)`，
 *      实现一份都不复制。
 *
 * 与 tcc 不同的一处，写在明处：目标用 `-b ARCH-OS`（`x86_64-linux`、`arm64-osx`、
 * `x86_64-win32` …）。tcc 那边是**一个目标一个可执行文件**（`x86_64-win32-tcc`），
 * 我们只有一个，所以要有一格说目标。容器格式仍然单独可拨（`-f`）——
 * tcc 的 `-c` 在所有目标上都写 ELF，那是量过的事实。
 */

/** 带一个值的那些（`-o NAME`）。其余都是开关。 */
const WITH_VALUE = new Set([
  '-o', '-I', '-D', '-U', '-L', '-l', '-B', '-b', '-f', '-e', '-MF',
  '-isystem', '-include', '-Xlinker', '-soname', '-rpath',
]);

/** 认得的开关（没有值的那些）。不在这两张表里的一律骂 —— 见文件头第 2 条。 */
const FLAGS = new Set([
  '-c', '-E', '-r', '-run', '-shared', '-static', '-g', '-gdwarf', '-P',
  '-dM', '-dD', '-M', '-MM', '-MD', '-MMD', '-MP', '-nostdinc', '-nostdlib',
  '-pie', '-rdynamic', '-w', '-Wall', '-fPIC', '-funsigned-char', '-m64',
]);

/**
 * `-b x86_64-linux` -> `{arch, os}`。不给 `-b` 就是**这台机器**（`host`）——
 * 从前这儿写死 arm64-osx，代价在 x86_64 容器里量到了：`omni c tcc x.c` 报
 * `/usr/include/gnu/stubs.h:7: error: include file 'gnu/stubs-32.h' not found`
 * （预定义里没有 `__x86_64__`，glibc 的头于是走 32 位那一支）。
 * 与 `omni c` 那一组同一条规矩（第一百四十七片），这一条当时漏了。
 */
function targetOf(b, host) {
  if (b === undefined) return { arch: host.arch, os: host.os };
  const i = b.indexOf('-');
  if (i < 0) throw new Error(`-b 要写成 ARCH-OS（比如 x86_64-linux），给的是 '${b}'`);
  return { arch: b.slice(0, i), os: b.slice(i + 1) };
}

/**
 * 把 tcc 的一串 argv 翻成 `(omni 命令的 key, 那条命令的 argv)`。
 *
 * `err` 是造错误的（`cli.js` 给 `OmniError`）；`host` 是不给 `-b` 时的默认目标
 * （`{arch, os}`，`cli.js` 传 `uname` 问出来的那一份）—— 这一份**不碰宿主**，
 * 宿主的事都由调用方递进来，好单独测。
 */
export function tccTranslate(argv, err, host) {
  /** @type {Map<string, string[]>} */
  const opts = new Map();
  /** `-D`/`-U` **按命令行次序**攒的一串 —— 见下面 `passIncs` 里那段。 */
  const defs = [];
  const files = [];
  let verbose = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (let k = i + 1; k < argv.length; k++) files.push(argv[k]); break; }
    if (a.length > 1 && a.startsWith('-')) {
      /* `-v` 是**数出来**的，不是查表：tcc 那边 `do ++verbose; while (*optarg++ == 'v')`
       * （libtcc.c:2044），于是 `-v` = 1、`-vv` = 2。 */
      if (/^-v+$/.test(a)) { verbose = a.length - 1; continue; }
      /* 粘在一起写的（`-Ifoo`、`-DM=1`、`-lm`、`-obj.o`）—— tcc 收，所以我们也收。 */
      let name = a;
      let val = null;
      if (!WITH_VALUE.has(a) && !FLAGS.has(a)) {
        for (const w of WITH_VALUE) {
          if (a.startsWith(w) && a.length > w.length) { name = w; val = a.slice(w.length); break; }
        }
      }
      if (val === null && WITH_VALUE.has(name)) {
        if (i + 1 >= argv.length) throw err(`c tcc: ${name} 后面缺一个值`);
        val = argv[i + 1];
        i++;
      }
      if (val === null && !FLAGS.has(name)) {
        throw err(`c tcc: 不认识的开关 '${a}'——这一条是拿来与 tcc 对着比的，`
          + '所以宁可骂也不放过（放过了门会以为比过了）');
      }
      const cur = opts.get(name) ?? [];
      cur.push(val === null ? true : val);
      opts.set(name, cur);
      if (name === '-D' || name === '-U') defs.push([name, val]);
      continue;
    }
    files.push(a);
  }

  const has = (n) => opts.has(n);
  const one = (n) => (opts.has(n) ? opts.get(n)[0] : undefined);
  const all = (n) => opts.get(n) ?? [];
  const tgt = targetOf(one('-b'), host);
  /** `-B DIR` 那一格（tcc 里叫 `tcc_lib_path`），没给就是 `null`。 */
  let passB = null;

  /* `-B DIR`：tcc 拿它当「tcc 自己那一套住在哪儿」——`{B}/include` 与 `{B}/libtcc1.a`。
   *
   * 量过搜索序（ADR-0018 那一节）：`-I` 与 `-isystem` 都**压过** `{B}/include`，
   * 而 `{B}/include` **就是** tcc 自带那一份的位置 —— 给了 `-B` 就没有别的自带头了。
   * 所以它对应的不是「多一条 `-isystem`」，而是「把自带那一份换掉」：
   * 递 `--tcc-lib-dir DIR`，由 `cli.js` 的 `cSysInclude(DIR)` 落地。
   *
   * 从前这儿翻成 `-isystem DIR/include`，两处错：一、`src/include` 还赖在搜索序尾巴上
   * （「只有我们有的头」我们找得到而 tcc 找不到）；二、`-c` 那一路**根本不读 `-isystem`**
   * （`c-obj` 只收 `-I`），于是 `-B` 在最要紧的那条路上整个丢了 —— 量出来了，见 ADR-0017
   * 第一百三十九片。 */
  if (one('-B') !== undefined) {
    const b = one('-B');
    passB = b.endsWith('/') ? b.slice(0, -1) : b;
  }

  /* 出来的 argv 用 omni 的规范拼法（`--arch`/`--os`/`--format`），因为底下那几段实现
   * 就是自己在 argv 上找这些名字的。 */
  const out = [];
  const push = (...xs) => { for (const x of xs) out.push(x); };
  const passIncs = () => {
    for (const d of all('-I')) push('-I', d);
    for (const d of all('-isystem')) push('-isystem', d);
    for (const f of all('-include')) push('-include', f);
    /* `-D` 与 `-U` **按命令行次序**，不是「先所有 -D 再所有 -U」：tcc 那边
     * `-DA=1 -UA` 与 `-UA -DA=1` 结果相反，`-dM` 也照命令行次序印出来
     * （量过，`dm-order` 那道门称的就是这一格）。攒成两堆就把这件事弄丢了。 */
    for (const [n, v] of defs) push(n, v);
    /* `-B` 那一格**换掉**自带的系统头目录，所以它不是一条 `-isystem`
     * （`-I`/`-isystem` 照旧压过它，那由 `cli.js` 的次序保证）。 */
    if (passB !== null) push('--tcc-lib-dir', passB);
    if (has('-nostdinc')) push('-nostdinc');
  };
  const passTarget = () => {
    push('--arch', tgt.arch, '--os', tgt.os);
    /* 格式：给了 `-f` 听 `-f`；没给就按目标猜 —— 但 `-c` 那一路**一律 ELF**，
     * 那是量过 tcc 的（`tcc -c` 在所有目标上都写 ELF）。 */
    const f = one('-f');
    if (f !== undefined) push('--format', f);
  };

  if (has('-E')) {
    push(...files);
    passIncs();
    if (has('-P')) push('-P');
    if (has('-dM')) push('-dM');
    if (has('-dD')) push('-dD');
    for (const m of ['-M', '-MM', '-MD', '-MMD', '-MP']) if (has(m)) push(m);
    if (has('-MF')) push('-MF', one('-MF'));
    if (one('-o') !== undefined) push('-o', one('-o'));
    push('--arch', tgt.arch, '--os', tgt.os);
    for (let k = 0; k < verbose; k++) push('-v');
    return { key: 'cpp', argv: out };
  }

  if (has('-run')) {
    push(...files);
    passIncs();
    return { key: 'c-run', argv: out };
  }

  if (has('-c')) {
    if (files.length !== 1) {
      throw err(`c tcc -c: 一次一个源文件（给了 ${files.length} 个）`);
    }
    push(files[0]);
    if (one('-o') !== undefined) push('-o', one('-o'));
    passIncs();
    passTarget();
    /* `-c` 没给 `-f` 就是 ELF —— 见 `passTarget` 里那段。 */
    if (one('-f') === undefined) push('--format', 'elf');
    return { key: 'c-obj', argv: out };
  }

  if (has('-r')) {
    push(...files);
    if (one('-o') !== undefined) push('-o', one('-o'));
    passTarget();
    if (one('-f') === undefined) push('--format', 'elf');
    push('-r');
    return { key: 'elf-r', argv: out };
  }

  /* 链接（没有 `-c`/`-E`/`-r`/`-run`）：容器由目标定，除非 `-f` 说了别的。 */
  const fmt = one('-f') ?? (tgt.os === 'osx' ? 'macho' : tgt.os === 'win32' ? 'pe' : 'elf');
  push(...files);
  if (one('-o') !== undefined) push('-o', one('-o'));
  push('--arch', tgt.arch, '--os', tgt.os, '--format', fmt);
  for (const d of all('-L')) push('-L', d);
  for (const l of all('-l')) push('-l', l);
  if (has('-shared')) push('--shared');
  if (has('-static')) push('--static');
  if (has('-pie')) push('--pie');
  if (has('-rdynamic')) push('--rdynamic');
  if (has('-g')) push('-g');
  if (has('-gdwarf')) push('-gdwarf');
  if (one('-e') !== undefined) push('-e', one('-e'));
  if (one('-soname') !== undefined) push('--soname', one('-soname'));
  if (one('-rpath') !== undefined) push('--rpath', one('-rpath'));
  const KEY = { elf: 'elf-link', macho: 'macho-link', pe: 'pe-link' };
  if (KEY[fmt] === undefined) throw err(`c tcc: 不认识容器格式 '${fmt}'；有 elf macho pe`);
  return { key: KEY[fmt], argv: out };
}

/** `omni c tcc --help` 印的那一份。故意照 tcc 的 usage 排，好逐条对照缺哪个。 */
export const TCC_HELP = `与 tcc 同一套开关，好拿**同一串 argv** 喂两边比字节。

  -c              只编译，出一个目标文件（一律 ELF —— 量过 tcc，所有目标都这样）
  -E              只预处理
  -r              把几份 .o 并成一份（tcc -r）
  -run            编完直接跑，退出码是 C main 的返回值
  -o NAME         产物落在哪儿
  -I D  -D M[=V]  -U M  -isystem D  -include F  -nostdinc
  -L D  -l NAME   -e NAME  -shared  -static  -pie  -rdynamic
  -g  -gdwarf     调试信息
  -P  -dM  -dD    预处理的那几格
  -M -MM -MD -MMD -MP  -MF F        给 make 的依赖清单
  -v  -vv         tcc 的 -v（数出来的：-v=1、-vv=2），**不是** omni 的 --verbose

与 tcc 不同的一处：
  -b ARCH-OS      哪个目标（x86_64-linux / arm64-osx / x86_64-win32 …）。tcc 那边是
                  一个目标一个可执行文件（x86_64-win32-tcc），我们只有一个。
  -f FMT          容器格式（elf|macho|pe），与目标**分开拨** —— tcc 的 -c 在所有目标上
                  都写 ELF，所以这两格不是一回事。

不认识的开关**直接骂**，不像别的命令那样放过：这一条是拿来与 tcc 对着比的，
放过一个开关只会让门以为比过了。`;
