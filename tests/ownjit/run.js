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
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
