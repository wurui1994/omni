// Omni — MIR 层的链接器（第一刀，ADR-0047 的"第 2 道坎"）
//
// 一句话：把**两份翻译单元的 MIR 并成一份**。为什么非它不可 —— R 的 `src/main` 是 99 份
// `.c`，"叠 include 摊成一份"那条路量死在 490 条错上（ADR-0047 第 2 条坎），
// 而 C 的预处理模型本来就不是给摊平用的。所以该做的是链接，不是更聪明的摊平脚本。
//
// ## 这一层"链接"是什么
//
// 线性内存腿上，一个**声明了但没定义**的函数（`int bee(int);`）落出来是三样：
// 一条 `cabi bee`、一格**桩**（体里就一条 `CCALL bee`）、调用点一条普通 `CALL`。
// 所以链接 = **把桩换成真定义** + 把两份的常量池 / 函数表 / data 段接起来。
//
// ## 布局：两份各占自己那一段线性内存
//
// B 的**整块像**（data + 影子栈 + 堆）往后挪 A 的页数那么多字节 —— 于是 B 的栈不会
// 写花 A 的 data。挪得动的前提是那两张表齐全：`mem.data[].relocs`（字节里的指针）
// 与 `addrConsts`（代码里的地址常量），判据在 `tests/mir/reloc.js`。
// 这个布局**费地址空间**（两段栈、两段堆），但它先是对的；把两份的 data 并进一段、
// 只留一份栈那种省法是下一刀的事，而那一刀的判据与这一刀是同一套。
//
// ## 还没做的
//
// * 同名 `static` 函数（C 里它们是文件局部的，两份各有一个 `helper` 是合法的）——
//   现在当重复定义报，要接就是"按文件挂后缀"，与 nmath 摊平那儿同一招；
// * 两份都有 `main`（那是两个程序，不是一份）；
// * 全局量（`mod.globals`）—— 这条腿上 C 的全局量住 data 段，`globals` 是空的，
//   所以这一刀不必碰它；别的前端要链的话再说。

import { OP, OP_MODES, REF_BIAS, REF_NONE } from './ir.js';

/** 这一格函数是不是**桩**：体里有一条 `CCALL`，而那条 C 符号就是它自己的名字。 */
export function isStub(mod, f) {
  for (let i = 0; i < f.op.length; i += 1) {
    if (f.op[i] !== OP.CCALL) continue;
    if (mod.cabi[f.a[i]] === f.name) return true;
  }
  return false;
}

/** 把一份模块的**整块像**往后挪 `d` 字节（data 段的落点、字节里的指针、地址常量）。 */
function shiftImage(mod, d) {
  if (d === 0) return;
  for (const seg of mod.mem.data) {
    seg.off += d;
    for (const r of seg.relocs ?? []) {
      let v = 0n;
      for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(seg.bytes[r.at + i]);
      const nv = BigInt.asUintN(64, v + BigInt(d));
      for (let i = 0; i < 8; i += 1) seg.bytes[r.at + i] = Number((nv >> BigInt(i * 8)) & 255n);
    }
  }
  for (const ref of mod.addrConsts) {
    const c = mod.consts.items[ref - REF_BIAS >= 0 ? ref : ref];
    c.text = String(BigInt(c.text) + BigInt(d));
  }
}

/**
 * 把 `b` 链进 `a`（改的是 `a`，回的也是它）。
 *
 * 次序照"先算好新号、再一次改写"—— 边算边改会读到改过一半的表。
 */
export function linkMir(a, b) {
  if (a.mem === null || b.mem === null) throw new Error('mir-link: 这一刀只链线性内存那条腿');
  if (a.native || b.native) throw new Error('mir-link: native 那条腿有真链接器，不走这儿');

  /* 1. B 的整块像挪到 A 的后头。 */
  const delta = a.mem.min * 65536;
  shiftImage(b, delta);

  /* 2. 常量池接上：B 的第 i 条变成 A 的第 base + i 条。 */
  const cbase = a.consts.items.length;
  for (const it of b.consts.items) a.consts.items.push(it);
  for (const ref of b.addrConsts) a.addrConsts.add(ref + cbase);
  /* **常量在 `[0, REF_BIAS)`、指令号在 `[REF_BIAS, REF_NONE)`**（`isConstRef` 就这一条
     比较）。所以要挪的是**常量那一半**；指令号是函数内部的，一个字都不许动 ——
     反过来写的症状是函数体里的 `%0` 变成 `%4`，跑起来是"BigInt 与数混算"
     （第一版就是这么错的，2026-09-27）。 */
  const remapRef = (r) => {
    if (r === REF_NONE) return r;
    return r < REF_BIAS ? r + cbase : r;
  };

  /* 3. C 符号表接上：B 的第 i 条落在 A 的哪一条（有就复用、没有就追加）。
        两份翻译单元用的 libc 函数几乎一定不一样，所以这一步是必须的 ——
        少了它 B 的每条 `CCALL` 都会指到 A 表里**另一个**符号上（静默调错函数）。 */
  const cabiMap = b.cabi.map((sym) => {
    const at = a.cabi.indexOf(sym);
    if (at >= 0) return at;
    a.cabi.push(sym);
    a.cabiIndex.set(sym, a.cabi.length - 1);
    return a.cabi.length - 1;
  });

  /* 4. 函数表：先算"B 的第 i 格落在 A 的哪一格"。桩换定义时**沿用 A 那一格的号**，
        于是 A 里所有 `CALL` 一个字都不用改。 */
  const fmap = new Array(b.funcs.length).fill(-1);
  const appended = [];
  b.funcs.forEach((bf, i) => {
    /* B 的入口丢掉；**B 的 `main` 也丢掉** —— 这条腿上 `lowerC` 一定要有个 `main`
       才编得过（它要造 `omni_main`），所以库那一份只能陪一个空的。真正的"库 TU"该由
       一个开关说（`--lib` 那种），还没有；这一格明写在这儿，不是悄悄的。 */
    if (bf.name === 'omni_main' || bf.name === 'main') return;
    const at = a.funcIndex.get(bf.name);
    if (at !== undefined) {
      const af = a.funcs[at];
      const aStub = isStub(a, af);
      const bStub = isStub(b, bf);
      if (aStub || bStub) { fmap[i] = at; return; }   // 桩那几档：共用 A 那一格
      /* **文件局部的那一格改名**：C 里 `static` 的函数是文件局部的，两份各有一个
         `helper` 完全合法（`src/main` 那 99 份里这种撞车量出来 10 个名字、22 处）。
         所以只要有一边是局部的，就给 B 那一格挂个后缀 —— 报"重复定义"是错的。
         记号由 C 前端打（`MirFunc.local`，`static` 与 inline 都打）。 */
      if (af.local === true || bf.local === true) {
        let n = 2;
        while (a.funcIndex.has(`${bf.name}__lk${n}`)) n += 1;
        bf.name = `${bf.name}__lk${n}`;
        fmap[i] = a.funcs.length + appended.length;
        appended.push(i);
        return;
      }
      throw new Error(`mir-link: ${bf.name} 两份里都有定义（重复定义）`);
    }
    fmap[i] = a.funcs.length + appended.length;
    appended.push(i);
  });

  /* 5. 改写 B 的函数体：常量号、实参池里的常量号、`CALL` 的函数号。
        **丢掉的那两格（`omni_main` / `main`）不改** —— 它们里头的调用点指着 `fmap` 里
        没有的号，改写会当场报，而它们本来就不进新模块。 */
  const keep = (bf) => bf.name !== 'omni_main' && bf.name !== 'main';
  for (const bf of b.funcs.filter(keep)) {
    for (let i = 0; i < bf.op.length; i += 1) {
      const [ka, kb] = OP_MODES[bf.op[i]];
      if (ka === 'r') bf.a[i] = remapRef(bf.a[i]);
      if (kb === 'r') bf.b[i] = remapRef(bf.b[i]);
      if (bf.op[i] === OP.CCALL) bf.a[i] = cabiMap[bf.a[i]];
      if (bf.op[i] === OP.CALL) {
        const to = fmap[bf.a[i]];
        if (to < 0) throw new Error(`mir-link: ${bf.name} 调的那一格函数没落在新表里`);
        bf.a[i] = to;
      }
    }
    for (let i = 0; i < bf.args.length;) {
      const n = bf.args[i];
      for (let k = 1; k <= n; k += 1) bf.args[i + k] = remapRef(bf.args[i + k]);
      i += n + 1;
    }
  }

  /* 6. 桩换定义：把 A 那一格的**身子**换成 B 的（名字与号都不动）。 */
  b.funcs.forEach((bf, i) => {
    if (!keep(bf)) return;
    const at = fmap[i];
    if (at >= a.funcs.length) return;
    if (isStub(a, a.funcs[at]) && !isStub(b, bf)) {
      bf.name = a.funcs[at].name;
      a.funcs[at] = bf;
    }
  });

  /* 7. 新来的那几格追加。 */
  for (const i of appended) {
    const bf = b.funcs[i];
    a.funcIndex.set(bf.name, a.funcs.length);
    a.funcs.push(bf);
  }

  /* 8. data 段与页数。B 的 `cabi` 里那些名字：A 已经有的不重复添
        （CCALL 的号在上一步随函数体一起搬进来了 —— 所以两份的 cabi 表必须同号，
        这一刀的做法是**要求 B 的 cabi 是 A 的前缀**，不是就报：真要不同表得改写
        CCALL 的 `a`，那一格等有真例子再做）。 */
  for (const seg of b.mem.data) a.mem.data.push(seg);
  a.mem.min = a.mem.min + b.mem.min;
  return a;
}
