// tests/ownjit/run.js —— **自研 JIT 的 D1 判据**（ADR-0045 §6 的第一刀）
//
// 判的是一件事：**我们能不能在运行期造几条机器码、放进可执行内存、跳进去、拿回它的返回值。**
// 这一格是 own-jit 那条腿的地板：D2（运行期重定位 + `--backend ownjit`）之后的每一刀都踩在它上面。
//
// 为什么不进 `tests/jit/`：那一轴判的是 **LLVM ORC**（同一份 IR 换装载方式答案不变，ADR-0014），
// 与"自己发机器码"是两件事，混在一起的话红了分不清是谁的。
//
// 用的口子就是那份**固定的注入宿主**（`src/jit/omni_ffi_host.c`，ADR-0038 第二刀）：
//   mem(n)              -> { addr, buf }   页对齐的内存，buf 是 external ArrayBuffer（零拷贝）
//   protect(addr,n,0)   -> rx（顺手刷 icache：arm64 上 `sys_icache_invalidate`）
//   calli(addr)         -> 把它当 `int64_t (*)(void)` 调一次
// 判据自己编一次那份 addon（约 1s，内容哈希缓存），**不经 cli.js** —— 判据不该依赖被判的那条链。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src/jit/omni_ffi_host.c');
const HDR = join(ROOT, 'src/runtime/omni_napi.h');
let pass = 0;
let fail = 0;
const ok = (name, got, want) => {
  if (String(got) === String(want)) { pass++; process.stdout.write(`  ok   ${name} [${got}]\n`); return true; }
  fail++;
  process.stdout.write(`  FAIL ${name}\n       期望 ${want}，量到 ${got}\n`);
  return false;
};

/** 那份注入宿主：内容哈希当身份，编一次就留着（与 cli.js 的 `ffiHost()` 同一条规矩、各自一份）。 */
function loadHost() {
  const key = createHash('sha256')
    .update(readFileSync(SRC)).update(readFileSync(HDR)).digest('hex').slice(0, 16);
  const dir = join(ROOT, '.omni-cache', 'ownjit', key);
  const node = join(dir, 'omni_ffi_host.node');
  if (!existsSync(node)) {
    mkdirSync(dir, { recursive: true });
    const shared = process.platform === 'darwin'
      ? ['-fPIC', '-shared', '-undefined', 'dynamic_lookup'] : ['-fPIC', '-shared'];
    const r = spawnSync('clang', ['-O2', '-w', ...shared, '-I', join(ROOT, 'src/runtime'),
      SRC, '-o', node], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`注入宿主编不过：\n${r.stderr}`);
  }
  /* `process.dlopen` 那一招照 `src/core/host/ffi_host.js`：把 exports 挂进一格空模块。 */
  const m = { exports: {} };
  process.dlopen(m, node, 0x02 /* RTLD_NOW */ | 0x100 /* RTLD_GLOBAL */);
  return m.exports;
}

/** `return <n>;` 那几条机器码（两个架构各一份，定长，手算出来的）。 */
function retConst(n) {
  if (process.arch === 'arm64') {
    /* movz w0, #n  = 0x52800000 | (n << 5)（n 只填 16 位立即数）；ret = 0xd65f03c0 */
    const b = new Uint8Array(8);
    new DataView(b.buffer).setUint32(0, 0x52800000 | ((n & 0xffff) << 5), true);
    new DataView(b.buffer).setUint32(4, 0xd65f03c0, true);
    return b;
  }
  if (process.arch === 'x64') {
    /* mov eax, imm32 = B8 imm32(le)；ret = C3 */
    const b = new Uint8Array(6);
    b[0] = 0xb8;
    new DataView(b.buffer).setUint32(1, n >>> 0, true);
    b[5] = 0xc3;
    return b;
  }
  return null;
}

const H = loadHost();
process.stdout.write(`\n自研 JIT D1（可执行内存 + 跳进去）—— ${process.platform}/${process.arch}\n`);
for (const k of ['mem', 'protect', 'calli']) {
  ok(`注入宿主导出 ${k}`, typeof H[k], 'function');
}
const code = retConst(42);
if (code === null) {
  process.stdout.write(`  --   ${process.arch} 这个架构还没有手写的那几条码（D4 的账）\n`);
} else {
  /* 一格页、写码、改成可执行、跳进去。三个常量各跑一趟 —— 一次对可能是碰巧。 */
  for (const n of [42, 7, 1234]) {
    const page = H.mem(4096);
    new Uint8Array(page.buf).set(retConst(n));
    H.protect(page.addr, 4096, 0);
    ok(`发 "return ${n}" 的机器码、跳进去`, H.calli(page.addr), n);
  }
  /* 同一块内存改回可写、换一份码、再改成可执行 —— W^X 那一档来回切也要成立
     （lua 那条腿在这儿踩过：放弃编译时忘了把 W^X 标志恢复）。 */
  const p2 = H.mem(4096);
  new Uint8Array(p2.buf).set(retConst(11));
  H.protect(p2.addr, 4096, 0);
  ok('第一次 rx', H.calli(p2.addr), 11);
  H.protect(p2.addr, 4096, 2);            /* 回到 rw */
  new Uint8Array(p2.buf).set(retConst(22));
  H.protect(p2.addr, 4096, 0);            /* 再 rx（这一次必须刷 icache，不然拿到 11） */
  ok('改完再 rx（icache 刷没刷）', H.calli(p2.addr), 22);
}
/* ================================================================ D2 的前半
 *
 * **在 JS 里发一段真会调别人的机器码**：装实参 -> 装被调地址 -> `blr` -> 带栈帧地返回。
 * 这一格通了才谈得上"把 MIR 的一个函数整体发出来"（0045-D2 的后半）。
 *
 * 编码不是猜的：每一条都拿 `clang -c` 编同一句汇编、`otool -t` 读回指令字对过
 * （`stp x29,x30,[sp,#-16]!` = a9bf7bfd · `mov x29,sp` = 910003fd ·
 *  `movz xN,#imm16` = d2800000|imm<<5|N · `movk … lsl16/32/48` = f2a0/f2c0/f2e0 同形 ·
 *  `neg x0,x0` = cb0003e0 · `blr x16` = d63f0200 · `ldp x29,x30,[sp],#16` = a8c17bfd ·
 *  `ret` = d65f03c0）。**这一小格编码器将来要搬进 `src/core/jit/a64.js`** ——
 * 现在留在判据里是因为它还只服务这一格判据，搬家要等 D2 后半有第二个调用方。
 */
function movImm64(reg, v) {
  const out = [];
  const h = [v & 0xffffn, (v >> 16n) & 0xffffn, (v >> 32n) & 0xffffn, (v >> 48n) & 0xffffn];
  out.push(0xd2800000 | (Number(h[0]) << 5) | reg);                 /* movz xN, #imm16 */
  if (h[1] !== 0n) out.push(0xf2a00000 | (Number(h[1]) << 5) | reg); /* movk … lsl #16 */
  if (h[2] !== 0n) out.push(0xf2c00000 | (Number(h[2]) << 5) | reg); /* movk … lsl #32 */
  if (h[3] !== 0n) out.push(0xf2e00000 | (Number(h[3]) << 5) | reg); /* movk … lsl #48 */
  return out;
}

/** `return <被调>(<一个整数实参>)`；`neg` 为真时实参取负（movz 只装得下非负的 16 位段）。 */
function emitCall1(addr, arg, neg) {
  const w = [0xa9bf7bfd, 0x910003fd];
  w.push(...movImm64(0, arg));
  if (neg) w.push(0xcb0003e0);
  w.push(...movImm64(16, addr));
  w.push(0xd63f0200, 0xa8c17bfd, 0xd65f03c0);
  return w;
}

/** 一段指令字写进一页、改成可执行、跳进去。 */
function runWords(words) {
  const page = H.mem(4096);
  const dv = new DataView(page.buf);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  H.protect(page.addr, 4096, 0);
  return H.calli(page.addr);
}

if (process.arch === 'arm64') {
  process.stdout.write('\nD2 前半（发码调符号）\n');
  /* libc 的符号在 node 进程里本来就看得见（`dlsym(RTLD_DEFAULT, …)`），不用 dlopen。 */
  const llabs = H.sym('llabs');
  ok('sym("llabs") 拿到地址', llabs !== 0n, true);
  if (llabs !== 0n) {
    /* 64 位整数往返：-1234567890123 -> llabs -> 1234567890123（`calli` 按 int64 读回值，
       所以这一格同时验了"高 32 位没被截掉"）。 */
    ok('发码调 llabs(-1234567890123)', runWords(emitCall1(llabs, 1234567890123n, true)), 1234567890123n);
    ok('发码调 llabs(-7)', runWords(emitCall1(llabs, 7n, true)), 7n);
  }
  /* 指针实参：另开一页写 "hello\0"，把那个地址装进 x0 调 strlen。 */
  const strlen = H.sym('strlen');
  ok('sym("strlen") 拿到地址', strlen !== 0n, true);
  if (strlen !== 0n) {
    const data = H.mem(4096);
    new Uint8Array(data.buf).set([104, 101, 108, 108, 111, 0]);   /* "hello\0" */
    ok('发码调 strlen("hello")（指针实参）', runWords(emitCall1(strlen, data.addr, false)), 5n);
  }
}

/* ================================================================ D2 的后半
 *
 * **一整个程序在这个进程里跑起来**（`omni c-jit`，ADR-0045 的 D2）。
 *
 * 前半判的是"一条 `blr` 能不能调对一个 libc 符号"；这一格判的是整条链：
 *   我们自己那台 C 前端 -> MIR -> `arm64/from_mir.js` 的机器码 -> 一份 `ET_REL`
 *   -> `flat_image.js` 就地打完重定位 -> `protect(rx)` -> 跳进 `main`。
 * 一个外部 cc、一份可执行文件、一个子进程都不经过。
 *
 * **尺子是 clang**（`-O0`，同一份 `.c`）：stdout 逐字节 + 退出码。为什么不拿
 * `omni c run` 当尺子 —— 那一条是 **MIR 解释器**，它连 `sqrt` 都拒（量到的原话
 * `interp: C ABI call 'sqrt' is not supported by the interpreter`）。尺子必须比被判的
 * 那条路更全，不然判不动。clang 不在仓库的依赖里，没装就**明着跳过**。
 *
 * 四份例子各压一件事，都是"整程序"级别而不是一条指令：
 *   递归 + `printf("%ld")`、串与 `%zu`、**结构体按值传参 + `sqrt`（浮点与外部数学库）**、
 *   循环累加 + 退出码取模。少任何一件，"能跑"都可能是巧合。
 */
{
  /* 这一节要的是"成不成立 + 不成立时那句话"，而上面那个 `ok` 是"两个值相不相等" ——
     两种形状别混用（混了一次：八条全 FAIL 而两边的值明明一样）。 */
  const okIf = (name, cond, note) => {
    if (cond) { pass++; process.stdout.write(`  ok   ${name}\n`); return; }
    fail++;
    process.stdout.write(`  FAIL ${name}\n       ${note}\n`);
  };
  /* 尺子在不在。**用 `spawnSync` 判、而且要看 `status`** —— 写 `execFileSync` 的话
     那个名字在这份文件里根本没 import，`try` 里抛的是 `ReferenceError`，被 `catch`
     一口吞掉之后这一整节"安静地跳过"（踩过一次：clang 明明装着，判据说没有）。 */
  const probe = spawnSync('clang', ['--version'], { encoding: 'utf8', timeout: 20000 });
  const haveClang = probe.status === 0;

  const CASES = {
    'ret.c': 'int main(void) { return 42; }\n',
    'rec.c': '#include <stdio.h>\n'
      + 'static long fib(long n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }\n'
      + 'int main(void) { printf("fib(24)=%ld\\n", fib(24)); return 7; }\n',
    'fp.c': '#include <stdio.h>\n#include <math.h>\n'
      + 'struct P { double x, y; };\n'
      + 'static double dist(struct P a, struct P b) {\n'
      + '  double dx = a.x - b.x, dy = a.y - b.y;\n'
      + '  return sqrt(dx * dx + dy * dy);\n}\n'
      + 'int main(void) {\n'
      + '  struct P a = { 1.5, 2.5 }, b = { 4.5, 6.5 };\n'
      + '  printf("dist=%.3f\\n", dist(a, b));\n'
      + '  return (int)dist(a, b);\n}\n',
    'loop.c': '#include <stdio.h>\n#include <string.h>\n'
      + 'int main(void) {\n'
      + '  long s = 0;\n'
      + '  for (int i = 0; i < 1000; i++) s += i * i;\n'
      + '  printf("sum=%ld len=%zu\\n", s, strlen("hello, own jit"));\n'
      + '  return (int)(s % 251);\n}\n',
  };

  process.stdout.write('\nD2 后半（整个程序在本进程里跑 —— omni c-jit）\n');
  if (!haveClang) {
    process.stdout.write('  skip 这一节（这台机器上没有 clang，少了尺子不许假绿）\n');
  } else {
    const dir = join(ROOT, '.omni-cache', 'work', 'ownjit-judge');
    mkdirSync(dir, { recursive: true });
    for (const [name, src] of Object.entries(CASES)) {
      const cPath = join(dir, name);
      writeFileSync(cPath, src);
      /* 尺子：clang -O0。`-lm` 在 macOS 上是空操作，Linux 上非给不可。 */
      const bin = join(dir, `${name}.clang`);
      const cc = spawnSync('clang', ['-O0', '-w', cPath, '-o', bin, '-lm'], { encoding: 'utf8' });
      if (cc.status !== 0) { okIf(`${name} 尺子编得过`, false, cc.stderr.slice(0, 200)); continue; }
      const want = spawnSync(bin, [], { encoding: 'utf8' });
      /* 被判的那条路。**不许借 `-lm`** —— `sqrt` 是靠 `dlsym(RTLD_DEFAULT,…)` 在
         这个进程里找着的（libSystem / libm 早就装着了），那正是这条路的立场。 */
      const got = spawnSync('node', [join(ROOT, 'src/cli.js'), 'c-jit', cPath],
        { encoding: 'utf8', timeout: 60000 });
      okIf(`${name} 在本进程里跑出来的 stdout 与 clang 逐字节相同`,
        got.stdout === want.stdout, `想要 ${JSON.stringify(want.stdout)}，`
        + `量到 ${JSON.stringify(got.stdout)}${got.stderr ? ` err=${got.stderr.slice(0, 200)}` : ''}`);
      okIf(`${name} 退出码与 clang 相同`, got.status === want.status,
        `想要 ${want.status}，量到 ${got.status}`);
    }
  }
}

/* ================================================================ D3 的头两步
 *
 * **整份 Omni / polydraw 程序在这个进程里跑**（`omni c jit … --rt`）。
 *
 * 上一节判的是"一份自带 `main` 的 C"；这一节判的是**我们自己生成的那份 C** ——
 * 它与那种 C 差两件事，两件都是这一节的全部内容：
 *
 *   1. 入口是 `int main(int argc, char **argv)`，第一句就是 `omni_host_init(argc, argv)`
 *      ⇒ 必须走宿主那格 `calln` 递真的 argc/argv（用 `calli` 调它是踩到哪算哪）；
 *   2. 它调运行时那一族（`omni_print_int` / `omni_run_entry` / …）
 *      ⇒ 运行时那二十来份 `.o` 要与程序那份**一起铺**（`--rt`）。
 *
 * 尺子是**同一份源码走正路**（`omni run`）：stdout 逐字节。
 * 这一格顺手把 ADR-0045 D2 里那句"跑 `01-arith` 一族"兑现了 —— 那是这台 JIT 的目标语料。
 */
{
  const okIf = (name, cond, note) => {
    if (cond) { pass++; process.stdout.write(`  ok   ${name}\n`); return; }
    fail++;
    process.stdout.write(`  FAIL ${name}\n       ${note}\n`);
  };
  const OMNI = join(ROOT, 'src/cli.js');
  const dir = join(ROOT, '.omni-cache', 'work', 'ownjit-judge');
  mkdirSync(dir, { recursive: true });
  const big = { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 };
  process.stdout.write('\nD3 头两步（整份 Omni / polydraw 程序在本进程里跑 —— c jit --rt）\n');
  for (const prog of ['tests/cases/01_basics.omni', 'ext/polydraw/examples/01-arith.pss']) {
    const src = join(ROOT, prog);
    /* 先把那份 C 要出来 —— `emit c` 是正路上的一步，不是这一节新造的东西。 */
    const gen = spawnSync('node', [OMNI, 'emit', 'c', src], big);
    if (gen.status !== 0) { okIf(`${prog} emit c 过得去`, false, gen.stderr.slice(0, 200)); continue; }
    const cPath = join(dir, `${prog.replace(/[/.]/g, '_')}.c`);
    writeFileSync(cPath, gen.stdout);
    const got = spawnSync('node', [OMNI, 'c-jit', cPath, '--rt'], big);
    const want = spawnSync('node', [OMNI, 'run', src], big);
    okIf(`${prog} 在本进程里跑出来的 stdout 与正路逐字节相同`,
      got.stdout === want.stdout && want.stdout.length > 0,
      `想要 ${JSON.stringify(want.stdout.slice(0, 160))}，`
      + `量到 ${JSON.stringify(got.stdout.slice(0, 160))}`
      + `${got.stderr ? ` err=${got.stderr.slice(0, 200)}` : ''}`);
  }

  /* ---- 出图那一族（`02-gl.pss` 立即模式 / `04-shader.pss` 可编程管线）----
   *
   * 这两份**不判 stdout**：那一行是 `#gfx png <路径> 320 240`，而路径按"程序叫什么"取名
   * —— 被判的那一边跑的是生成出来的 `.c`（叫 `frame.png`），正路那一边跑的是 `.pss`
   * （叫 `02-gl.png`）。**那是这一节自己的取名差，不是代码生成的差**，拿它当判据只会
   * 逼着人去改一个与正确性无关的东西。
   *
   * 判的是**那张图的字节**（这一轴本来的口径）：从各自的 `#gfx png …` 那行里把路径读出来，
   * 逐字节比。着色器那一份要 `OMNI_GFX=gl`（哪台设备是**跑的时候**定的），而那份
   * `libomnigl` 由 `cJitRun` 自己顺手编好、路径放进 `OMNI_GL_LIB` —— 少了那一格，
   * 报的是"这格设备（CPU 备选）上没有 'glsetshader'"，看着像方言缺能力。
   */
  for (const [prog, gfx] of [['02-gl.pss', null], ['04-shader.pss', 'gl']]) {
    const src = join(ROOT, 'ext/polydraw/examples', prog);
    const gen = spawnSync('node', [OMNI, 'emit', 'c', src], big);
    if (gen.status !== 0) { okIf(`${prog} emit c 过得去`, false, gen.stderr.slice(0, 200)); continue; }
    const cPath = join(dir, `${prog}.c`);
    writeFileSync(cPath, gen.stdout);
    const envp = gfx === null ? process.env : { ...process.env, OMNI_GFX: gfx };
    const pngOf = (out) => {
      const m = /#gfx png (\S+)/.exec(out);
      return m === null ? null : join(ROOT, m[1]);
    };
    /* **上一份的图先删掉**：被判这一边的产物名是固定的 `.omni-cache/gfx/frame.png`
       （名字从程序来，而这儿的程序都是同一个生成出来的 `.c`）⇒ 两份例子写同一个文件。
       不删的话第二份要是压根没画，读到的是第一份那张 —— 一格白拿的绿。 */
    const stale = join(ROOT, '.omni-cache', 'gfx', 'frame.png');
    if (existsSync(stale)) unlinkSync(stale);
    const got = spawnSync('node', [OMNI, 'c-jit', cPath, '--rt'], { ...big, env: envp });
    const gp = pngOf(got.stdout);
    /* 先把被判那一张收走 —— 正路那一趟写进同一个目录。 */
    const mine = gp === null || !existsSync(gp) ? null : readFileSync(gp);
    /* **正路那一边用默认环境**：哪台设备它自己会挑（量到的：给它 `OMNI_GFX=gl` 反而
       一个 `#gfx png` 都不印）。这一节要的是"同一份源码两条路出的图一样"，
       不是"两边吃同一串环境变量"。 */
    const want = spawnSync('node', [OMNI, 'run', src], big);
    const wp = pngOf(want.stdout);
    const theirs = wp === null ? null : readFileSync(wp);
    okIf(`${prog} 在本进程里出的那张 PNG 与正路逐字节相同`,
      mine !== null && theirs !== null && mine.length > 1000 && mine.equals(theirs),
      `我们 ${mine === null ? '没出图' : `${mine.length} 字节`}，`
      + `正路 ${theirs === null ? '没出图' : `${theirs.length} 字节`}`
      + `${got.stderr ? ` err=${got.stderr.slice(0, 200)}` : ''}`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
