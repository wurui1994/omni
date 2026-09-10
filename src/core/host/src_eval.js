/**
 * `eval` 与 `Function(src)` 的宿主一侧（ADR-0020 的 P6）。
 *
 * 这两样要**编译器在运行期在场**：产物自己是自洽的一份 JS/C，里面没有编译器。所以约定是
 * 一格运行期的钩子 —— 在本进程里跑程序的场合（`omni run` 的 JS 腿与解释器腿、REPL）由这儿
 * 把钩子装到宿主全局上，产物里的 `$js_src_eval`（prelude）顺着它找；装不上的场合
 * （`omni build` 出来的独立产物、C 那条腿）那两个 op 当场报错，不假装能跑。
 *
 * 编出来的是一段**独立的模块**（每次一个新的 JsFrontSession），所以：
 *   - 看不见调用者的局部量 —— 认下来的是"全局 eval"那一档（规范里的 indirect eval）；
 *   - 拿不到的名字在**编译期**就报，冒到 JS 那一侧是一格 SyntaxError；
 *   - 段里用到的运行时（prelude 那一堆 $js_*）来自已经装好的那一份 —— 间接 eval 把它们
 *     放在宿主全局上，与 REPL 的增量机制是同一条路（见 repl.js 的 JsSession）。
 */

import { SourceFile, Diagnostics } from '../source/diag.js';
import { parseJs } from '../frontend-js/parser.js';
import { JsFrontSession } from '../frontend-js/lower.js';
import { evalJs } from './native.js';

/**
 * 装一次就够（重复调用是空操作）。
 *
 * `emit(mod, opts)` 由**叫它的那一处**给（cli.js 传 `target('js').emit`）：这一格在 host 层，
 * 直接 import backend-js 等于把一整套 JS 后端焊进核心 —— 那是 target-js 插件的事
 * （ADR-0021 的 S4）。
 */
export function installSrcEvalHook(emit) {
  if (typeof globalThis.$OMNI_SRC_EVAL === 'function') return;
  globalThis.$OMNI_SRC_EVAL = (src) => {
    const diags = new Diagnostics();
    const prog = parseJs(new SourceFile('<eval>', `${src}\n`), diags);
    const sess = new JsFrontSession();
    const mod = sess.add(prog, diags, { valueOfLast: true });
    diags.throwIfErrors();
    // chunk 形态：不带 prelude、不带入口调用（那一份运行时已经在宿主全局上了）
    evalJs(emit(mod, { repl: true }));
    return evalJs(`${mod.entry}()`);
  };
}
