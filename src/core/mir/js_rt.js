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

export const RT = {
  memInit,
  memData,
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
