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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
