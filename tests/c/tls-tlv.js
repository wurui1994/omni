// tests/c/tls-tlv.js —— `__thread` / `_Thread_local`：**每条线程一份**，不是一格全局量
//
// 从前 `__thread` 落在 `parseBtype` 里「吃掉就行」那一支上（与 `restrict` 并排）：编得过，
// 可它与普通全局量**完全不可区分** —— 所有线程共用一格。那是静静答错里最深的一种：
// 单线程程序一点事都没有，一起线程就错，而错的地方离 `__thread` 那一行十万八千里。
// 量出来的症状（借来的 CPython）：`threading.Thread.start()` 撞
// `Fatal Python error: _PyThreadState_Attach: non-NULL old thread state`。
//
// 尺子是 **clang**（不是 tcc —— tcc 在 Mach-O 上没有 TLV 这一格）。称两件事：
//
//   1. **跑起来的答案**：主线程写 3、子线程写 7，两边各读各的 —— 我们出的 `.o` 与
//      clang 出的 `.o` 逐字节相同的 stdout，退出码都是 0。
//   2. **节与符号的形状**：`__DATA,__thread_vars`（`S_THREAD_LOCAL_VARIABLES`）与
//      `__DATA,__thread_data`（`S_THREAD_LOCAL_REGULAR`）都在，descriptor 指着
//      `__tlv_bootstrap`，而那个名字是**未定义的外部符号**（dyld 给）。
//
//   node tests/c/tls-tlv.js
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');
const CLANG = ['/usr/bin/clang', '/opt/homebrew/opt/llvm/bin/clang'].find((p) => existsSync(p));
const OUT = join(tmpdir(), 'omni-tls-tlv');
const say = (s) => process.stdout.write(`${s}\n`);

/* TLS 那一格只落在 macOS/arm64 上（ELF/PE 两条要 `.tdata` 与 TLS 那族重定位，还没到）。 */
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  say(`tls-tlv: 这一格现在只在 macOS/arm64 上（这台是 ${process.platform}/${process.arch}）—— 跳过`);
  process.exit(0);
}
if (CLANG === undefined) { say('tls-tlv: 本机没有 clang（尺子就是它）—— 跳过'); process.exit(0); }

const PROBE = `#include <stdio.h>
#include <pthread.h>

__thread int tl = 3;
_Thread_local long long tl2 = 100;
__thread char name[8] = "abc";

static void *work(void *arg) {
  tl = 7;
  tl2 = 200;
  name[0] = 'z';
  printf("子 %d %lld %s\\n", tl, tl2, name);
  return NULL;
}

int main(void) {
  pthread_t t;
  if (pthread_create(&t, NULL, work, NULL) != 0) { printf("起不了线程\\n"); return 2; }
  pthread_join(t, NULL);
  printf("主 %d %lld %s\\n", tl, tl2, name);
  return tl == 3 && tl2 == 100 && name[0] == 'a' ? 0 : 1;
}
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const src = join(OUT, 'probe.c');
writeFileSync(src, PROBE);

let bad = 0;
/** 一条：编、链、跑，回 `{ code, out }`。 */
function runWith(label, objArgs) {
  const o = join(OUT, `${label}.o`);
  const exe = join(OUT, label);
  const c = spawnSync(objArgs[0], objArgs.slice(1), { encoding: 'utf8' });
  if (c.status !== 0 || !existsSync(o)) {
    say(`tls-tlv: ${label} 编不出 .o：\n${(c.stderr ?? '').split('\n').slice(0, 4).join('\n')}`);
    return null;
  }
  const l = spawnSync(CLANG, ['-o', exe, o], { encoding: 'utf8' });
  if (l.status !== 0 || !existsSync(exe)) {
    say(`tls-tlv: ${label} 链不起来：\n${(l.stderr ?? '').split('\n').slice(0, 4).join('\n')}`);
    return null;
  }
  const r = spawnSync(exe, [], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trimEnd() };
}

const ours = runWith('ours', [process.execPath, CLI, 'c', 'obj', '-o', join(OUT, 'ours.o'), src]);
const want = runWith('clang', [CLANG, '-c', '-o', join(OUT, 'clang.o'), src]);
if (ours === null || want === null) process.exit(1);

if (ours.out !== want.out || ours.code !== want.code) {
  bad += 1;
  say(`tls-tlv: 答案不同（我们 exit=${ours.code} / clang exit=${want.code}）`
    + `\n  我们：${JSON.stringify(ours.out)}\n  clang：${JSON.stringify(want.out)}`);
} else {
  say(`ok   跑起来的答案与 clang 逐字节相同（exit=${ours.code}）：${JSON.stringify(ours.out)}`);
}

/* 节与符号的形状：两节都在、descriptor 指着 dyld 那个 thunk。 */
const nm = spawnSync('nm', ['-m', join(OUT, 'ours.o')], { encoding: 'utf8' }).stdout ?? '';
const secs = spawnSync('otool', ['-l', join(OUT, 'ours.o')], { encoding: 'utf8' }).stdout ?? '';
for (const s of ['__thread_vars', '__thread_data']) {
  if (!secs.includes(s)) { bad += 1; say(`tls-tlv: 我们那份 .o 里没有 ${s} 这一节`); }
}
if (!nm.includes('__tlv_bootstrap')) {
  bad += 1;
  say('tls-tlv: descriptor 没指着 __tlv_bootstrap（那是 dyld 给的未定义外部符号）');
}
if (!/_tl\b/.test(nm)) { bad += 1; say('tls-tlv: 符号表里没有 _tl'); }
if (bad === 0) say('ok   两节都在、descriptor 指着 __tlv_bootstrap、符号表里有那几个名字');

say('');
say(bad === 0 ? '门：__thread 每条线程一份 —— 过' : `门：__thread 每条线程一份 —— 没过（${bad} 条）`);
process.exit(bad === 0 ? 0 : 1);
