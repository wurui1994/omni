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
