/**
 * `mir/emit_js.js` 发出来的那段 JS 要的**运行时**（ADR-0013）。
 *
 * 它只是一张**转发表**：线性内存与 libc 的实现一行都不在这儿，全部指向
 * `interp/builtin.js` 与 `interp/libc.js` 里已经有的那一份。理由与当初 MIR 解释器
 * 复用 `applyBuiltin` 一样 —— **避免语义分叉**：字节序、越界消息、`printf` 的格式化、
 * `exit` 的收摊，五条腿必须逐字节相同，所以只能有一份实现。
 *
 * 这一份存在的价值只有一个：发出来的 JS 里要引的名字**收在一个对象上**，
 * 于是那段源码既能 `new Function('$rt', …)` 在本进程里跑，也能当一个模块文件
 * `import { RT } from '…/mir/js_rt.js'` 之后 `node` 直接跑 —— 两条路上的名字一样。
 */

import {
  memInit, memData, memSize, memGrow, memLoadFn, memStoreFn, memLoadFnN, memStoreFnN,
  flushOut, failRt, InterpFail, InterpUncaught,
} from '../interp/builtin.js';
import { callLibc, hasLibc, ExitCall, setFnPtrCaller, libcAtExit } from '../interp/libc.js';
import { evalJs, stderr } from '../host/native.js';

/* ---- `setjmp` / `longjmp` 那一格（ADR-0047） --------------------------------
 *
 * 为什么不与 `mir/interp.js` 那一份共用：两条腿的"落点"根本不是同一种东西 ——
 * 那边是"某一帧对象 + 某个 pc"，这边是"某一趟调用的记号 + 某条指令的下标"
 * （发出来的 JS 没有 pc，靠 `emit_js.js` 那层导航回去，见它的 `SETJMP_NAMES` 头注）。
 * 共用的是**语义**，那几条都照 C11 7.13.2.1 与那一份逐字对齐：
 *   - 键取 `jmp_buf` 的**地址**（真的 `setjmp` 往那块地方存寄存器，没人读它的内容），
 *     于是"同一个 buf 上后一次 setjmp 盖掉前一次"自然成立；
 *   - `longjmp(buf, 0)` 那边回 **1**；
 *   - 没被 `setjmp` 装过的 buf 上 longjmp 是一条运行期错误，消息与那一份**逐字相同**。
 */

/** 下一趟调用的记号。递归时同一个函数在栈上有好几份，靠它认出"这一跳是给谁的"。 */
let sjSeq = 0;
/** @type {Map<bigint, {tok: number, site: number}>} `jmp_buf` 的地址 -> 落点 */
const sjMap = new Map();

/* 继承 `Error`：封闭子集里 `instanceof` 只对 Error 及其子类成立（ADR-0011 决策 15），
 * 而这一格的判断正是靠 `instanceof`（每一帧要认出"这是给我的那一跳"）。 */
class SjJump extends Error {
  constructor(tok, site, val) {
    super('longjmp');
    this.tok = tok;
    this.site = site;
    this.val = val;
  }
}

function sjTok() {
  sjSeq = sjSeq + 1;
  return sjSeq;
}
function sjSet(buf, tok, site) {
  sjMap.set(BigInt(buf), { tok, site });
  return 0;
}
function sjThrow(buf, val) {
  const rec = sjMap.get(BigInt(buf));
  if (rec === undefined) failRt('longjmp: 这个 jmp_buf 没有被 setjmp 装过');
  /* C11 7.13.2.1：`val` 是 0 的话 `setjmp` 那边回 1。i32 在这条腿上是 number、
     i64 是 BigInt —— 两种表示都要认，不然换一种就静默回 0。 */
  let v = val;
  if (v === 0) v = 1;
  else if (v === 0n) v = 1n;
  throw new SjJump(rec.tok, rec.site, v);
}
/** 这一跳是给我的吗（`tok` 是我这一趟的记号）。不是就回 null，调用方原样再抛。 */
function sjCatch(e, tok) {
  return e instanceof SjJump && e.tok === tok ? e : null;
}

/* ---- 一个 .c 一个 .js：地址得在**装载期**才定（ADR-0047） --------------------
 *
 * 烤死地址的那条路只有一个模块时成立：data 段从 64K 起，取址就是一条 `65552n`。
 * 一份 .c 一份 .js 之后，谁的 data 段落在哪儿是**装载期**才知道的事 —— 于是
 * 每个模块在自己的顶层要一句 `memAlloc(span, 16)` 占好自己那一段，代码里的地址
 * 变成"模块基址 + 偏移"（`emit_js.js` 的 module 档）。
 *
 * 这儿只有两条：占一段（`memAlloc`）、把 data 段铺进去顺手打重定位（`memPut`）。
 * 线性内存本身仍是 `interp/builtin.js` 那一份 —— 全仓只有一块内存，这是"不分叉"。
 */

const MEM_PAGE = 65536;
/** 下一块可分配的字节地址。0 = 还没开张（页 0 永远空着，NULL 打不中）。 */
let memBump = 0;

/**
 * 占一段线性内存，回**字节地址**（number）。内存还没开张就先开一页；
 * 不够长就 `memGrow` —— 长不动是硬错（不像 wasm 那样回 -1 让调用方查：
 * 这是装载期，装不下就是这份程序在这个宿主上跑不起来）。
 */
function memAlloc(bytes, align) {
  if (memBump === 0) {
    const pages = Number(memSize());
    if (pages === 0) memInit(1, 0);
    memBump = Math.max(MEM_PAGE, Number(memSize()) * MEM_PAGE);
  }
  const a = align > 1 ? Math.ceil(memBump / align) * align : memBump;
  const end = a + bytes;
  const need = Math.ceil(end / MEM_PAGE) - Number(memSize());
  if (need > 0 && memGrow(BigInt(need)) === -1n) {
    failRt('memAlloc: 线性内存长不到 ' + end + ' 字节');
  }
  memBump = end;
  return a;
}

/**
 * 铺一段 data 段，顺手把里头装地址的那几格加上 `delta`。
 * `relocs` 是 `[[at, size], …]`（`mem.data[].relocs` 那张表发出来的样子）。
 *
 * `fixes` 是 `[[at, 地址], …]`：那几格装的是**别的模块**那个符号的地址
 * （`static int *p = &arr[2];`）—— 不是"加一个差"能对的，所以直接写进去。
 */
function memPut(off, bytes, relocs, delta, fixes) {
  if (delta !== 0) {
    for (const r of relocs) {
      const at = r[0];
      const size = r[1];
      let v = 0n;
      for (let i = size - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[at + i]);
      v = BigInt.asUintN(64, v + BigInt(delta));
      for (let i = 0; i < size; i += 1) bytes[at + i] = Number((v >> BigInt(i * 8)) & 255n);
    }
  }
  if (fixes !== undefined) {
    for (const fx of fixes) {
      const at = fx[0];
      const v = BigInt.asUintN(64, fx[1]);
      for (let i = 0; i < 8; i += 1) bytes[at + i] = Number((v >> BigInt(i * 8)) & 255n);
    }
  }
  memData(off, bytes);
}

/**
 * **整个程序共用的那个堆**，在内存**尾上**要一页（幂等：第一次叫的时候才要）。
 *
 * 为什么不像单份模块那样把堆底烤进去：堆靠 `MGROW` 往内存尾上长，而 N 份模块各占一段
 * 之后"谁在尾上"要等全部装载完才知道。所以这一档里堆由**入口跑起来的时候**要 ——
 * 那一刻所有模块的 `memAlloc` 都走完了，这一块一定在最后。
 */
let heapDone = false;
function memHeap() {
  if (heapDone) return;
  heapDone = true;
  const base = memAlloc(MEM_PAGE, MEM_PAGE);
  callLibc('__omni_heap_init', [BigInt(base)]);
}

export const RT = {
  memInit,
  memData,
  memAlloc,
  memPut,
  memHeap,
  memSize,
  memGrow,
  memLoadFn,
  memStoreFn,
  memLoadFnN,
  memStoreFnN,
  callLibc,
  hasLibc,
  /* `exit` 抛的那个信号**用谓词而不是类**过去：类在封闭子集里只能出现在
   * `new C(...)` 里（ADR-0011），塞进对象字面量当值当场被拒。
   * 发出来的 JS 于是问 `isExitCall(e)`，不问 `e instanceof ExitCall`。 */
  isExitCall: (e) => e instanceof ExitCall,
  failRt,
  flushOut,
  libcAtExit,
  setFnPtrCaller,
  sjTok,
  sjSet,
  sjThrow,
  sjCatch,
};

/**
 * 在**本进程**里跑一段 `emitMirJs` 的产物：包成一个函数表达式喂给宿主的 `evalJs`，
 * 把 `$rt` 绑上去，然后调 `$run()`。
 *
 * 错误的收法与 `runMirModule` **逐条相同**（同样的前缀、同样的退出码 70，ADR-0005）：
 * 两条腿要在「stdout 逐字节 + stderr 逐字节 + 退出码」这三项上可比，那是
 * `tests/mir/js-parity` 那道门比的东西。`exit` 抛的 ExitCall 在 `$run()` 里就收了
 * （那儿才知道要先 `libcAtExit` 再 `flushOut`）。
 */
export function runMirJs(js) {
  const factory = evalJs(`(function ($rt) {\n${js}\nreturn $run;\n})`);
  try {
    return factory(RT)();
  } catch (e) {
    if (e instanceof InterpFail) {
      stderr(`omni: runtime error: ${e.message}\n`);
      return 70;
    }
    if (e instanceof InterpUncaught) {
      stderr(`omni: uncaught: ${e.message}\n`);
      return 70;
    }
    throw e;
  }
}
