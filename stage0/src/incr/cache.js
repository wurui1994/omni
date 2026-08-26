/**
 * 增量编译：函数级编译单元 + 内容哈希 + 缓存产物（ADR-0014 决策 5）。
 *
 * 这一层只做三件事，刻意不碰后端：
 *
 *   1. **算键**。`key = hash(后端标记 + 这个函数的 MIR 内容哈希 + 它调用的那些函数的
 *      **签名**哈希)`。签名而不是函数体 —— 于是「改一个函数的实现」不失效它的调用者。
 *      内容哈希本身来自 `mir/bytes.js`，那边已经保证了「哈希里出现名字、不出现池下标」。
 *   2. **查/存**。缓存是内容寻址的：文件名就是键，没有失效逻辑，也不需要时间戳
 *      （mtime 那套在 runtime .o 缓存上够用，在函数级上不够 —— 同一个文件里改一行，
 *      所有函数的 mtime 都变了，而只有一个函数的内容变了）。
 *   3. **数命中/未命中**。ADR-0014 的验收门槛 4 明确要求用计数断言，不靠计时：
 *      计时会被机器负载和 JIT 预热淹没，计数是确定的。
 *
 * 现在缓存的产物是 **JS 后端的单函数文本**（`emitJsFunc`）。选它不是因为它有用，
 * 是因为它是**今天唯一内容寻址成立**的产物：C 后端的函数体里有 `omni_s16_7` 这种
 * 模块级字符串池下标，同一个函数搬到另一个模块里文本就变了。等 LLVM 那条路进来，
 * 产物换成目标码 buffer + 重定位信息，这一层的键与计数不用动 —— 换的只是 `emitFunc`。
 */

import { readText, writeText, exists, mkdirAll } from '../host/native.js';
import { join } from '../host/path.js';
import { hash16 } from '../host/hash.js';
import { OP } from '../mir/ir.js';
import { moduleHashes } from '../mir/bytes.js';

/**
 * 这个函数**静态依赖**的那些函数名。
 *
 * `CALL` 是直调，被调者写在指令里。`CLOSURE` 也算：造一个闭包等于取那个函数的地址，
 * 它的签名变了这里就得重编。`CALLFN` 是间接调用，被调者是运行期的值 —— 静态依赖里
 * 没有它，这不是漏掉，是它真的不构成编译期依赖（代价是内联那类优化要另记显式依赖，
 * 决策 5 里已经写明）。
 */
export function calleesOf(mir, f) {
  const seen = new Set();
  const out = [];
  let i = 0;
  while (i < f.count()) {
    const op = f.op[i];
    let name = null;
    if (op === OP.CALL) name = mir.funcs[f.a[i]].name;
    if (op === OP.CLOSURE) name = mir.closures[f.a[i]].funcName;
    if (name !== null && !seen.has(name)) { seen.add(name); out.push(name); }
    i++;
  }
  // 排序：依赖集是**集合**，不是序列。指令顺序变了但依赖没变时键不该变化
  out.sort();
  return out;
}

/** 一个编译单元的缓存键。`tag` 是后端标记 —— 换后端就是换缓存空间，不是让它们互相污染。 */
export function unitKey(mir, f, tag, hashes) {
  const parts = [`tag ${tag}`, `body ${hashes.get(f.name).body}`];
  for (const c of calleesOf(mir, f)) {
    const h = hashes.get(c);
    // 被调者不在本模块（宿主 op 走 CALLOP、外部 C 走 CCALL，都不到这里）时只记名字
    parts.push(h === undefined ? `callee ${c}` : `callee ${c} ${h.sig}`);
  }
  return hash16(parts.join('\n'));
}

/**
 * 内容寻址的缓存。目录给 null 就只在内存里 —— 一次进程内的重复编译（REPL、
 * 自举链里同一份源码编好几遍）也是增量的受益者，不必落盘。
 */
export class IncrCache {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
    if (dir !== null) mkdirAll(dir);
  }

  pathOf(key) { return join(this.dir, `u-${key}.unit`); }

  /** 命中返回文本，未命中返回 null。 */
  get(key) {
    if (this.mem.has(key)) return this.mem.get(key);
    if (this.dir === null) return null;
    const p = this.pathOf(key);
    if (!exists(p)) return null;
    const t = readText(p);
    this.mem.set(key, t);
    return t;
  }

  put(key, text) {
    this.mem.set(key, text);
    if (this.dir !== null) writeText(this.pathOf(key), text);
  }

  /** 刻意是方法：访问器不在语言子集里（ADR-0011 决策 2）。 */
  count() { return this.mem.size; }
}

/**
 * 按函数走一遍缓存。`emitFunc(name)` 只在未命中时被调用 —— 这就是「命中时完全不跑
 * 编译管线」的可观测形式：计数说了几次，那个回调就被调了几次。
 */
export function compileIncremental(mir, tag, cache, emitFunc) {
  const hashes = moduleHashes(mir);
  const units = [];
  let hits = 0;
  let misses = 0;
  let emitted = 0;
  for (const f of mir.funcs) {
    const key = unitKey(mir, f, tag, hashes);
    let text = cache.get(key);
    if (text === null) {
      text = emitFunc(f.name);
      emitted = emitted + 1;
      cache.put(key, text);
      misses = misses + 1;
    } else {
      hits = hits + 1;
    }
    units.push({ name: f.name, key: key, text: text });
  }
  return { units: units, hits: hits, misses: misses, emitted: emitted };
}

/**
 * 一行一个函数 + 一行汇总。这份文本是测试轴断言的对象，所以它是**确定的**：
 * 顺序按模块里的函数顺序，键是内容哈希，没有路径、没有时间。
 */
export function incrReport(res, verbose) {
  const L = [];
  if (verbose) {
    for (const u of res.units) L.push(`${u.key}  ${u.text.length} bytes  ${u.name}`);
  }
  L.push(`units=${res.units.length} hit=${res.hits} miss=${res.misses} emit=${res.emitted}`);
  return L.join('\n') + '\n';
}
