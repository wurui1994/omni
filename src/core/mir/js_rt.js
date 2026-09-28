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
  flushOut, failRt, InterpFail, InterpUncaught, memImage, memImagePut } from '../interp/builtin.js';
import { callLibc, hasLibc, ExitCall, setFnPtrCaller, libcAtExit, setHeapInit } from '../interp/libc.js';
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
/** **数据符号那张表**（按需 import 的另一半，第三十三格）。
 *
 *  从前跨模块的**数据**符号走静态 `import { $sym_x }` —— 那一句把整份提供方拽进来，
 *  于是"函数按需、数据整装"。现在与函数那一格对称：提供方在自己的模块体里
 *  `symBind("x", 地址)`，用的人 `needSym("x")` —— 表里没有就按链接图装那一份、再查一遍，
 *  还没有就 loud 喊（不许静默回 0，那是错地址）。 */
const SYM_TAB = new Map();
function symBind(name, at) { SYM_TAB.set(name, at); }
function needSym(name) {
  const hit = SYM_TAB.get(name);
  if (hit !== undefined) return hit;
  if (linkEnsure(name)) {
    const again = SYM_TAB.get(name);
    if (again !== undefined) return again;
  }
  return failRt("需要数据符号 '" + name + "' 的地址，但没人提供它（链接图里没有，或那一份没绑）");
}

/** **谁的数据段在哪儿**（开机镜像那条路）：镜像里的指针是绝对地址，所以重来一趟时
 *  每份模块必须落回同一个基址。存像那一趟把 `baseLog()` 一起存下来，
 *  铺像那一趟先 `setBaseMap(那张表)` 再按同样的次序装那几份 —— 基址就对得上。 */
let baseMap = null;
const baseLog = new Map();
function setBaseMap(m) { baseMap = m; }
function baseLogOut() { return Object.fromEntries(baseLog); }

function memAlloc(bytes, align, id) {
  if (baseMap !== null && id !== undefined && baseMap[id] !== undefined) {
    const at = baseMap[id];
    /* 钉住的那一段也得**先有内存**：铺像那一趟第一份模块就是从这儿回去的，
       而 `memInit`/`memGrow` 本来长在下面那条分配路上（漏了这一句报的是
       `memory access without a memory`，在 `memPut` 那一行）。 */
    memEnsure(at + bytes);
    /* 钉住的也记一笔：存像是**一轮一轮**的，这一轮存下去的那张表必须把上几轮钉住的
       一起带上（漏了就只剩这一轮新装的那几份，下一轮基址全乱）。 */
    baseLog.set(id, at);
    return at;
  }
  const at = memAllocRaw(bytes, align);
  if (id !== undefined && id !== '') baseLog.set(id, at);
  return at;
}

/** 线性内存至少有 `end` 字节。 */
function memEnsure(end) {
  if (Number(memSize()) === 0) memInit(1, 0);
  const need = Math.ceil(end / MEM_PAGE) - Number(memSize());
  if (need > 0 && memGrow(BigInt(need)) === -1n) {
    failRt('memAlloc: 线性内存长不到 ' + end + ' 字节');
  }
}

function memAllocRaw(bytes, align) {
  /* **堆已经在内存尾上了**：这时晚来的模块（按需装载那条路）不能再从 bump 拿 ——
   * 堆要连续、靠 brk 往内存尾上长，bump 在它后头切一块就把它堵死了。
   * 所以这一刻起模块的 data 段**从堆里要**（那也只是内存，谁给的不重要）。 */
  if (heapDone) {
    const p = Number(callLibc('malloc', [BigInt(bytes + align)]));
    if (p === 0) failRt('memAlloc: 堆里要不到 ' + bytes + ' 字节');
    return (p + align - 1) & ~(align - 1);
  }

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
/* 第一次 `malloc` 就把堆立起来（按需装载那条路上没有"入口"替它发 CCALL）。 */
setHeapInit(() => { memHeap(); });

function memHeap() {
  if (heapDone) return;
  /* **先要那一页，再挂牌**：反过来的话 `memAlloc` 会看见 `heapDone` 就去找 `malloc`，
   * 而 `malloc` 正是叫我们来立堆的那个人 —— 堆底那一页只能从 bump 上拿。 */
  const base = memAlloc(MEM_PAGE, MEM_PAGE, '$heap');
  heapDone = true;
  callLibc('__omni_heap_init', [BigInt(base)]);
}

/**
 * **真的装起来跑了几份**（按需装载那条路上唯一能信的数）。
 *
 * `$load` 那一侧只数得到"我亲手 require 的文件"，而一份模块还可能因为别人要它的
 * **数据符号**被静态 `import` 进来 —— 那一份也解析了、也 `$init` 了，只是没人数它。
 * 每份模块的 `$init` 都恰好叫一次 `setFnPtrCaller`（幂等那道闸在它前头），
 * 所以数它就是数"起来了几份"。
 */
let modsUp = 0;
function rtSetFnPtrCaller(fn) { modsUp += 1; setFnPtrCaller(fn); }
function linkStats() { return { mods: modsUp, files: linkLoaded.size }; }

/**
 * **整个程序共用的那张函数表**（一个 .c 一个 .js 那条路上的"跨模块函数指针"）。
 *
 * 单份模块那一档里函数指针就是「本模块函数号 + 1」，`$FN` 一张本地表查得到。N 份模块
 * 一摆，这个数就不认识了：A 模块造出来的 `37n` 到了 B 模块，`$FN[36]` 是 B 的第 37 个
 * 函数 —— **静默答错**（R 的 `R_FunTab` 正是这个形状：表在 names.c、`do_*` 在几十份
 * 别的 .c 里、读表并调的是 eval.c）。
 *
 * 所以模块档里函数指针的值改成「**这张全程序表**的下标 + 1」，键是**链接名**：
 * 对外可见的函数就是它的名字，`static` 的挂上模块自己的标记（那一格只有本模块能引用，
 * 但值要全局唯一）。槽位**按名字先到先得**地分配（`fnSlot`），谁定义谁往里放身子
 * （`fnBind`）—— 于是"引用在前、定义在后"也接得上（ESM 的装载次序不必操心）。
 */
const FN_SLOT = new Map();
const FN_TAB = [];

/** 名字 -> 指针值（下标 + 1）。没有就现开一格（身子等 `fnBind`）。 */
function fnSlot(name) {
  let i = FN_SLOT.get(name);
  if (i === undefined) {
    i = FN_TAB.length;
    FN_TAB.push(null);
    FN_SLOT.set(name, i);
  }
  return BigInt(i + 1);
}

/**
 * 把身子放进那一格。`pt` 是每个形参"是不是 i32"的一位、`rt` 是回值那一位 ——
 * libc 回调那扇门要按它换口径（libc 那一份的整数一律 BigInt）。
 */
function fnBind(name, fn, pt, rt) {
  const i = Number(fnSlot(name)) - 1;
  FN_TAB[i] = { fn, pt, rt };
}

/**
 * **按需装载**（一个 .c 一个 .js 那条路的第二半）。
 *
 * 从前一份模块要用别人的函数，发的是一句静态 `import` —— ESM 于是把**整张传递闭包**
 * 都装起来：R 那一套 251 份、55 MB，光装载就 30 秒（量出来的）。
 * 而真正会被调到的只是其中一部分。
 *
 * 所以跨模块的函数引用改成**惰性**的：发一个小桩，第一次真被调的时候才问
 * `needFn(名字)` —— 那一格要是还没人绑（`fnBind`），就按**链接图**（`setLinkMap` 交过来的
 * 名字 -> 文件）把提供方那一份装进来，它顶层会把自己的函数绑好。
 *
 * 装载那一下由宿主给：node 上 `require`（Node 23 起 `require` 能同步吃 ESM）、
 * 浏览器上先按同一张图把要用的几份 `await import` 进来（异步预热，同一张图）。
 */
let linkMap = null;
let linkLoad = null;
const linkLoaded = new Set();

function setLinkMap(map, loader) {
  linkMap = map;
  linkLoad = loader;
}

/** 名字 -> 已经绑好的那一格（没绑回 null）。 */
function fnByName(name) {
  const i = FN_SLOT.get(name);
  if (i === undefined) return null;
  return FN_TAB[i] === undefined ? null : FN_TAB[i];
}

/** 装提供 `name` 的那一份模块（幂等）。回 true = 装了或本来就有。 */
function linkEnsure(name) {
  if (linkMap === null) return false;
  const file = linkMap.get(name);
  if (file === undefined) return false;
  if (linkLoaded.has(file)) return false;
  linkLoaded.add(file);
  linkLoad(file);
  return true;
}

/** 惰性桩问的就是这一格：拿到身子（要么已经绑好，要么现装那一份）。 */
function needFn(name) {
  const hit = fnByName(name);
  if (hit !== null) return hit.fn;
  if (linkEnsure(name)) {
    const again = fnByName(name);
    if (again !== null) return again.fn;
  }
  failRt("需要 '" + name + "' 但没人提供它（链接图里没有，或那一份没绑）");
  return undefined;
}

function fnEntry(fp) {
  const no = Number(fp) - 1;
  if (no < 0) failRt('call of a null function pointer');
  const e = FN_TAB[no];
  if (e === undefined) failRt('function pointer index ' + no + ' out of range');
  if (e === null) {
    /* 槽位开了但身子还没绑：按链接图把提供方装进来（函数指针也走按需装载）。 */
    let nm = '?';
    for (const [k, v] of FN_SLOT) if (v === no) nm = k;
    if (linkEnsure(nm)) {
      const again = FN_TAB[no];
      if (again !== null && again !== undefined) return again;
    }
    failRt("call of an unbound function pointer '" + nm + "'（那一份模块没装载？）");
  }
  return e;
}

/** MIR 自己发的 `CALLI`：两侧口径一致，直接调。 */
function fnCall(fp, args) { return fnEntry(fp).fn(...args); }

/** libc 那扇门（qsort 的比较器那一路）：按签名把实参装/卸一次。 */
function fnCallLibc(fp, args) {
  const e = fnEntry(fp);
  const as = [];
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k];
    as.push(e.pt[k] === 1 && typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : v);
  }
  const r = e.fn(...as);
  return e.rt === 1 && typeof r === 'number' ? BigInt(r) : r;
}

/**
 * **data 段用 base64 递进来**（第一百五十二片的速度那一格）。
 *
 * 从前 data 段发成一个 JS 的数组字面量（`memPut(off, [1,2,3,…])`）—— 251 份模块加起来
 * 57 MB，绝大部分就是这些数字，而 V8 解析上百万个数组元素要**28 秒**（量出来的：
 * `import 28398ms`）。换成一个字符串字面量：字节少三成、解析快一个量级。
 *
 * 浏览器那一侧没有 `Buffer`，所以两条路都留着（`atob` 那条）。
 */
const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Map();
for (let i = 0; i < B64_ALPHA.length; i += 1) B64_REV.set(B64_ALPHA[i], i);

function b64(s) {
  let n = s.length;
  while (n > 0 && s[n - 1] === '=') n -= 1;
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i += 1) {
    acc = (acc << 6) | B64_REV.get(s[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return out;
}

/** 开机镜像那一对（第一百五十二片）：内存的字节 + 我们这边那个 bump 指针。
 *  `heapBase`/`errnoAddr` 不进像 —— 每趟 `$init()` 都把它们摆成同一个值。 */
function memImageSave() { return { bytes: memImage(), bump: memBump }; }

function memImageLoad(img) {
  memImagePut(img.bytes);
  memBump = img.bump;
  heapDone = true;            // 像里已经有堆了，别再要一页
}

export const RT = {
  memInit,
  b64,
  setLinkMap,
  needFn,
  symBind,
  needSym,
  memImageSave,
  memImageLoad,
  setBaseMap,
  baseLog: baseLogOut,
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
  fnSlot,
  fnBind,
  fnCall,
  fnCallLibc,
  callLibc,
  hasLibc,
  /* `exit` 抛的那个信号**用谓词而不是类**过去：类在封闭子集里只能出现在
   * `new C(...)` 里（ADR-0011），塞进对象字面量当值当场被拒。
   * 发出来的 JS 于是问 `isExitCall(e)`，不问 `e instanceof ExitCall`。 */
  isExitCall: (e) => e instanceof ExitCall,
  failRt,
  flushOut,
  libcAtExit,
  setFnPtrCaller: rtSetFnPtrCaller,
  linkStats,
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
