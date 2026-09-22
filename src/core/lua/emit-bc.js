// src/core/lua/emit-bc.js —— **Lua CST → 字节码**（照 Ignition 的生成器）
//
// 这一份先只管"数值核心"：局部量、算术、比较、if/while/数值 for、print。
// 够跑通整条流水线（发射 → 装载 → 解释），再往上长表、闭包、方法那几族。
//
// 寄存器分配是**栈规矩**：局部量占 0..nlocals-1 固定格，临时值从水位线往上开，
// 表达式算完就退回去。够用且好查（v8 的生成器也是这个形状：局部量固定、临时按栈）。

import { tag, kids, leaf, isList } from '../lower/cst.js';
import { OP, Buf } from './bc.js';

class Proto {
  constructor(parent = null) {
    this.buf = new Buf();
    this.K = [];                 // 常量池：{t:'num'|'str'|'nil'|'true'|'false'|'proto', v}
    this.kmap = new Map();       // 去重
    this.nreg = 0;               // 用到的最大寄存器数
    this.nfb = 0;                // 反馈槽数
    this.locals = new Map();     // 名字 → 寄存器号
    this.top = 0;                // 临时值的水位线
    this.parent = parent;        // 外层 Proto（upvalue 解析用）
    this.params = [];            // 形参名（localfn 体里的）
    this.ups = [];               // upvalue 描述：[{ kind:'local'|'up', idx }]
    this.upmap = new Map();      // 名字 → ups 的下标
    this.children = [];          // 内嵌 Proto
    this.breakStack = [];        // 当前循环的出口回填点栈
  }
  /** 常量入池（同一个常量只进一次） */
  k(t, v) {
    const key = `${t}:${v}`;
    let i = this.kmap.get(key);
    if (i === undefined) { i = this.K.length; this.K.push({ t, v }); this.kmap.set(key, i); }
    return i;
  }
  fb() { return this.nfb++; }
  /** 一串**连号**的串常量（NewShaped 的键表要连着放，所以这一族不去重） */
  kSeq(names) {
    const first = this.K.length;
    for (const nm of names) this.K.push({ t: 'str', v: nm });
    return first;
  }
  /** 开一格临时寄存器 */
  push() { const r = this.top++; if (this.top > this.nreg) this.nreg = this.top; return r; }
  pop(n = 1) { this.top -= n; }
  reg(name) {
    let r = this.locals.get(name);
    if (r === undefined) {
      r = this.top++;
      if (this.top > this.nreg) this.nreg = this.top;
      this.locals.set(name, r);
    }
    return r;
  }
  // ---- 发指令 ----
  op(name) { this.buf.u8(OP[name]); }
  r(v) { this.buf.u8(v); }
  k16(v) { this.buf.u16(v); }
  f16(v) { this.buf.u16(v); }
  /** 解析一个名字的引用：回 { kind:'local'|'global'|'upvalue', idx } */
  resolve(name) {
    const r = this.locals.get(name);
    if (r !== undefined) return { kind: 'local', idx: r };
    /* 往上找 upvalue */
    let e = this.upmap.get(name);
    if (e !== undefined) return { kind: 'upvalue', idx: e };
    if (this.parent !== null) {
      const outer = this.parent.resolve(name);
      if (outer.kind === 'local') {
        const ui = this.ups.length;
        this.ups.push({ kind: 'local', idx: outer.idx });
        this.upmap.set(name, ui);
        return { kind: 'upvalue', idx: ui };
      }
      if (outer.kind === 'upvalue') {
        const ui = this.ups.length;
        this.ups.push({ kind: 'up', idx: outer.idx });
        this.upmap.set(name, ui);
        return { kind: 'upvalue', idx: ui };
      }
    }
    return { kind: 'global' };
  }
  jumpHole(name, extraR = null) {
    this.op(name);
    if (extraR !== null) this.r(extraR);
    const at = this.buf.pos;
    this.buf.i32(0);
    return at;
  }
  patch(at) { this.buf.patchI32(at, this.buf.pos - (at + 4)); }
  patchTo(at, target) { this.buf.patchI32(at, target - (at + 4)); }
}

const ARITH = { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div', '%': 'Mod', '^': 'Pow', '..': 'Concat' };
const CMP = { '==': 'Eq', '~=': 'Ne', '<': 'Lt', '<=': 'Le', '>': 'Gt', '>=': 'Ge' };

/** 把表达式算到 acc 里 */
function expr(p, x) {
  const t = tag(x), ch = kids(x);
  switch (t) {
    case 'num': { p.op('LdaK'); p.k16(p.k('num', Number(leaf(ch[0])))); return; }
    case 'str': { p.op('LdaK'); p.k16(p.k('str', leaf(ch[0]))); return; }
    case 'nil': p.op('LdaNil'); return;
    case 'true': p.op('LdaTrue'); return;
    case 'false': p.op('LdaFalse'); return;
    case 'paren': expr(p, ch[0]); return;
    case 'name': {
      const nm = leaf(ch[0]);
      const ref = p.resolve(nm);
      if (ref.kind === 'local') { p.op('LdaR'); p.r(ref.idx); return; }
      if (ref.kind === 'upvalue') { p.op('LdaUp'); p.buf.u8(ref.idx); return; }
      p.op('LdaGlobal'); p.k16(p.k('str', nm)); p.f16(p.fb()); return;
    }
    case 'neg': { expr(p, ch[0]); p.op('Neg'); p.f16(p.fb()); return; }
    case 'not': { expr(p, ch[0]); p.op('Not'); return; }
    case 'len': { expr(p, ch[0]); p.op('Len'); p.f16(p.fb()); return; }
    case 'bin': {
      const op = leaf(ch[0]);
      if (op === 'and' || op === 'or') {
        /* 短路：左边落 acc，按真假跳过右边（acc 就是结果，与 lua 的"回值不回布尔"一致） */
        expr(p, ch[1]);
        const hole = p.jumpHole(op === 'and' ? 'JumpIfFalse' : 'JumpIfTrue');
        expr(p, ch[2]);
        p.patch(hole);
        return;
      }
      /* 左操作数进一格临时寄存器，右操作数留在 acc —— 与 Ignition 同一个约定 */
      expr(p, ch[1]);
      const lr = p.push();
      p.op('StaR'); p.r(lr);
      expr(p, ch[2]);
      const name = ARITH[op] ?? CMP[op];
      if (name === undefined) throw new Error(`emit-bc: 还没接这个算子 '${op}'`);
      p.op(name); p.r(lr); p.f16(p.fb());
      p.pop();
      return;
    }
    case 'call': {
      const fn = ch[0], args = ch[1];
      const argList = args ? kids(args) : [];
      /* call 也能做表达式（`fib(n-1) + fib(n-2)` 里两处 call 都是表达式）。
         发法与 stmt 那格 call 完全相同：函数值 + 实参连号、一条 Call 指令。 */
      if (tag(fn) === 'name' && leaf(kids(fn)[0]) === 'print') {
        const base = p.top;
        for (const a of argList) { expr(p, a); const r = p.push(); p.op('StaR'); p.r(r); }
        p.op('Print'); p.r(base); p.buf.u8(argList.length);
        p.pop(argList.length);
        return;
      }
      if (tryFuseSetmeta(p, fn, argList)) return;
      expr(p, fn);
      const base = p.push(); p.op('StaR'); p.r(base);
      for (const a of argList) { expr(p, a); const r = p.push(); p.op('StaR'); p.r(r); }
      p.op('Call'); p.r(base); p.buf.u8(argList.length); p.f16(p.fb());
      p.pop(argList.length + 1);
      return;
    }
    case 'table': {
      /* `{}` / `{a,b}` / `{x=1,y=2}` */
      /* 特殊情况：`{...}` —— 直接发 VarargTable */
      if (ch.length === 1 && tag(ch[0]) === 'item' && tag(kids(ch[0])[0]) === 'vararg') {
        p.op('VarargTable');
        return;
      }
      /* **全是具名字段**（`{x=a,y=b,z=c}`）⇒ 发一条 NewShaped：
         一次分配、形状只求一次、一条 SetNamed 都不发。
         原来是 NewTable + n×SetNamed = 1+n 次分配 + n 次形状迁移；
         smallpt 的 Vec.new 每秒几十万次，这一格是 VM 腿最大的单点。 */
      if (ch.length > 0 && ch.every(it => tag(it) === 'named')) {
        const names = ch.map(it => leaf(kids(it)[0]));
        const base = p.top;
        for (const it of ch) {
          const vr = p.push();
          expr(p, kids(it)[1]);
          p.op('StaR'); p.r(vr);
        }
        const kfirst = p.kSeq(names);
        p.op('NewShaped'); p.k16(kfirst); p.r(base); p.r(names.length); p.f16(p.fb());
        p.pop(names.length);
        return;
      }
      p.op('NewTable'); p.buf.u8(0);
      const tbl = p.push(); p.op('StaR'); p.r(tbl);
      let idx = 1;
      for (const item of ch) {
        if (tag(item) === 'named') {
          const [kn, vn] = kids(item);
          const ki = p.k('str', leaf(kn));
          expr(p, vn);
          p.op('SetNamed'); p.r(tbl); p.k16(ki); p.f16(p.fb());
        } else if (tag(item) === 'item') {
          const kc = p.push();
          p.op('LdaK'); p.k16(p.k('num', idx++)); p.op('StaR'); p.r(kc);
          expr(p, kids(item)[0]);
          p.op('SetKeyed'); p.r(tbl); p.r(kc); p.f16(p.fb());
          p.pop();
        }
      }
      p.op('LdaR'); p.r(tbl);
      p.pop();
      return;
    }
    case 'index': {
      /* `t[k]` */
      expr(p, ch[0]);
      const tr = p.push(); p.op('StaR'); p.r(tr);
      expr(p, ch[1]);
      const kr = p.push(); p.op('StaR'); p.r(kr);
      p.op('GetKeyed'); p.r(tr); p.r(kr); p.f16(p.fb());
      p.pop(2);
      return;
    }
    case 'dot': {
      /* 这一格已经被 GetFields 一块儿读出来了 */
      if (_fused !== null && tag(ch[0]) === 'name') {
        const hit = _fused.get(`${leaf(kids(ch[0])[0])}|${leaf(ch[1])}`);
        if (hit !== undefined) { p.op('LdaR'); p.r(hit); return; }
      }
      /* `t.k` */
      expr(p, ch[0]);
      const tr = p.push(); p.op('StaR'); p.r(tr);
      const ki = p.k('str', leaf(ch[1]));
      p.op('GetNamed'); p.r(tr); p.k16(ki); p.f16(p.fb());
      p.pop();
      return;
    }
    case 'mcall': {
      /* `obj:m(args)` → acc = obj:m(args) */
      const obj = ch[0], mname = leaf(ch[1]), args = ch[2];
      expr(p, obj);
      const base = p.push(); p.op('StaR'); p.r(base);     // self
      /* 先取方法（obj.m 走 GetNamed IC）... */
      const mki = p.k('str', mname);
      p.op('GetNamed'); p.r(base); p.k16(mki); p.f16(p.fb());
      const fr = p.push(); p.op('StaR'); p.r(fr);         // 方法值
      /* 然后实参（self 已经在 base，跟在方法值后面） */
      const argList = args ? kids(args) : [];
      /* 布局：[base]=self [fr]=method [fr+1]=arg1 ... 但 Call 约定是 R[base]=func R[base+1..]=args
         于是把 method 放到 base-1？不——我们换一个布局：
         [fr]=method [fr+1]=self [fr+2]=arg1 ... 然后 Call fr (1+argc) */
      const selfR = p.push(); p.op('LdaR'); p.r(base); p.op('StaR'); p.r(selfR);
      for (const a of argList) { expr(p, a); const r = p.push(); p.op('StaR'); p.r(r); }
      p.op('Call'); p.r(fr); p.buf.u8(1 + argList.length); p.f16(p.fb());
      p.pop(2 + argList.length + 1);    // fr + self + args + base
      return;
    }
    case 'fn': {
      /* 匿名函数表达式 `function(...) ... end` */
      const sub = compileBody(ch[0], p, false);
      const ki = p.K.length; p.K.push({ t: 'proto', v: sub });
      p.op('Closure'); p.k16(ki); p.buf.u8(sub.ups.length);
      for (const u of sub.ups) p.buf.u8(u.kind === 'local' ? 0 : 1), p.buf.u8(u.idx);
      return;
    }
    case 'vararg': {
      /* `...` in expression context — currently only `{...}` (table constructor with vararg) is common.
         For bare `...` we emit VarargTable which creates a table from the extra args. */
      p.op('VarargTable');
      return;
    }
    default:
      throw new Error(`emit-bc: 还没接这格表达式 '${t}'`);
  }
}


/* ---- 同一张表的多个字段读合成一条 GetFields ----
 *
 * 形状：`Vec.new(a.x + b.x, a.y + b.y, a.z + b.z)` —— 六次字段读，每次一遍守卫、一次调用。
 * 合成之后每张表一条 GetFields：**守卫一遍、n 条 load**。
 *
 * 凭什么能提到一块儿：**Lua 不规定同一个表达式里子表达式的求值次序**，
 * 所以这一族读在同一个表达式内部换次序是合法的。于是只在"一条语句的表达式"这个范围里做，
 * 并且**不跨 and/or**（那边有短路，提了会读到本不该读的字段）、**不进闭包**（另一个函数）。
 */
let _fused = null;      // Map<'base|key', 寄存器号>

/** `setmetatable(t, mt)` 直接发 SetMeta —— 省掉一次全局读 + 一次 native 调用（建帧/收参那一套）。
 *  只在名字没被局部量/upvalue 遮住、而且正好两个实参时做。回 true = 已经发了。 */
function tryFuseSetmeta(p, fn, argList) {
  if (tag(fn) !== 'name' || leaf(kids(fn)[0]) !== 'setmetatable') return false;
  if (argList.length !== 2) return false;
  if (p.locals.get('setmetatable') !== undefined) return false;      // 被遮住了
  if (p.upmap.get('setmetatable') !== undefined) return false;
  expr(p, argList[0]);
  const tr = p.push(); p.op('StaR'); p.r(tr);
  expr(p, argList[1]);            // acc = 元表
  p.op('SetMeta'); p.r(tr);       // acc = 那张表（与 setmetatable 的返回值一致）
  p.pop();
  return true;
}

function scanFieldGroups(x, p, out) {
  if (x === null || x === undefined || !isList(x)) return out;
  const t = tag(x);
  if (t === 'fn' || t === 'function') return out;                  // 闭包另发一个函数
  if (t === 'bin' && (leaf(kids(x)[0]) === 'and' || leaf(kids(x)[0]) === 'or')) return out;
  if (t === 'dot' && tag(kids(x)[0]) === 'name') {
    const base = leaf(kids(kids(x)[0])[0]);
    /* **只查自己的 locals，不许调 resolve()** —— resolve 碰到外层的局部量会**顺手登记一格
       upvalue**（有副作用），扫一遍就把闭包的 upvalue 列表搞坏了。踩过一次：
       smallpt 直接段错误（元方法查出个 0 地址调过去）。 */
    const reg = p.locals.get(base);
    if (reg !== undefined) {
      const key = leaf(kids(x)[1]);
      let g = out.get(base);
      if (g === undefined) { g = { reg, keys: [] }; out.set(base, g); }
      if (!g.keys.includes(key)) g.keys.push(key);
    }
  }
  for (const k of kids(x)) scanFieldGroups(k, p, out);
  return out;
}

/** 一条语句的表达式开头：够两个键的组各发一条 GetFields，结果记进 _fused。回要 pop 的格数 */
function emitFieldGroups(p, exprs) {
  const groups = new Map();
  for (const e of exprs) scanFieldGroups(e, p, groups);
  const memo = new Map();
  let pushed = 0;
  for (const [base, g] of groups) {
    if (g.keys.length < 2 || g.keys.length > 8) continue;
    const n = g.keys.length;
    const dst = p.top;
    for (let i = 0; i < n; i++) p.push();
    pushed += n;
    const kfirst = p.kSeq(g.keys);
    const fb0 = p.nfb; p.nfb += n;
    p.op('GetFields'); p.r(g.reg); p.k16(kfirst); p.r(dst); p.r(n); p.f16(fb0);
    for (let i = 0; i < n; i++) memo.set(`${base}|${g.keys[i]}`, dst + i);
  }
  return { memo, pushed };
}

/** 包一条语句：先发 GetFields，再发正文，最后收拾 */
function withFusedFields(p, exprs, body) {
  /* `OMNI_NO_FUSE=1` 关掉合并，用来做干净的 A/B（同一个二进制、两份字节码） */
  if (process.env.OMNI_NO_FUSE) { body(); return; }
  const { memo, pushed } = emitFieldGroups(p, exprs);
  const saved = _fused;
  _fused = memo.size > 0 ? memo : null;
  try { body(); } finally { _fused = saved; if (pushed) p.pop(pushed); }
}

function stmt(p, x) {
  const t = tag(x), ch = kids(x);
  switch (t) {
    case 'local': {
      const names = kids(x).find(y => tag(y) === 'names');
      const values = kids(x).find(y => tag(y) === 'values');
      const nl = names ? kids(names) : [];
      const vl = values ? kids(values) : [];
      /* 多返回值的特殊情况：`local a, b = f()` ——右边只有一个 call，左边多于一个名字 */
      if (nl.length > 1 && vl.length === 1 && (tag(vl[0]) === 'call' || tag(vl[0]) === 'mcall')) {
        expr(p, vl[0]);   // acc = 第一个返回值
        const r0 = p.reg(leaf(nl[0]));
        p.op('StaR'); p.r(r0);
        /* 后续的值从 omni_extra_slot 取 —— 但我们还没有读 extra 的字节码指令。
           暂时用 LdaGlobal 加一个 magic key 或者直接加一条新指令？
           更简单的做法：加一条 LdaExtra i 指令。但那要改 ISA。
           最简单：不加指令，在 VM 里给 Call 做 "auto-extra-store" —— Call 返回后
           如果后面紧跟 StaR，就照常存 acc；但如果是多个 StaR，需要额外取 extra。
           
           实际做法：在编译器侧，对 `local a,b = f()` 生成：
             expr(f(...)) → acc = 第一个返回值
             StaR ra
             LdaExtra 0 → acc = extra[0]
             StaR rb
           需要加 LdaExtra 指令。 */
        /* 临时方案：不加新指令，直接用一个内建调用来取 extra。
           但那太丑了。还是加 LdaExtra 吧 —— 但改 ISA 要 gen-bc-defs。
           
           更简单的临时方案：把多返回值当成"第一个值存第一个名字，其余 nil"。
           这对 smallpt 不行，它依赖 `obj, t = intersect(r)` 的第二个返回值。
           
           必须正面解决。用 SetMeta 的空间？不——直接在 Call 后面约定：
           被调方如果通过 RetMulti 返回了 N 个值，acc = 第一个，omni_extra_slot[0..N-2] = 后续。
           调用方在 Call 指令后立刻用 R[base+1], R[base+2]... 来取 —— 
           不，那样 Call 指令后面的 R[] 已经被释放了。
           
           最干净的做法：给 Call 加一个 "multi-return dst" 模式。
           但那改动太大了。先用全局 extra_slot + LdaEnv 复用（LdaEnv 目前是 TODO）。 */
        for (let i = 1; i < nl.length; i++) {
          /* 复用 LdaEnv 指令来读 extra[i-1] —— 在 VM 里把 LdaEnv 改成读 extra_slot */
          p.op('LdaEnv'); p.buf.u8(i - 1);
          const ri = p.reg(leaf(nl[i]));
          p.op('StaR'); p.r(ri);
        }
        return;
      }
      /* **先给新局部量占好槽、名字最后才绑**（右边求值时看见的还是外层那个绑定，`local x = x` 才对），
         合并用的临时槽推在它们**上面** —— 语句末尾 pop 掉就不会盖到新局部量。
         （原来是"算一个绑一个"，套上合并之后新局部量落在临时槽上面被盖掉：
           量到过 smallpt 校验和 133216 → 31068，快 10% 但是错的。） */
      const lregs = [];
      for (let i = 0; i < nl.length; i++) lregs.push(p.push());
      withFusedFields(p, vl, () => {
        for (let i = 0; i < nl.length; i++) {
          if (vl[i] !== undefined) expr(p, vl[i]); else p.op('LdaNil');
          p.op('StaR'); p.r(lregs[i]);
        }
      });
      for (let i = 0; i < nl.length; i++) p.locals.set(leaf(nl[i]), lregs[i]);
      return;
    }
    case 'assign': {
      const tgts = kids(x).find(y => tag(y) === 'targets');
      const values = kids(x).find(y => tag(y) === 'values');
      const tl = tgts ? kids(tgts) : [];
      const vl = values ? kids(values) : [];
      /* 多返回值的特殊情况：`a, b = f()` */
      if (tl.length > 1 && vl.length === 1 && (tag(vl[0]) === 'call' || tag(vl[0]) === 'mcall')) {
        expr(p, vl[0]);   // acc = 第一个返回值
        /* 先把所有返回值存进临时寄存器 */
        const tmp = [];
        const r0 = p.push(); p.op('StaR'); p.r(r0); tmp.push(r0);
        for (let i = 1; i < tl.length; i++) {
          p.op('LdaEnv'); p.buf.u8(i - 1);  // extra[i-1]
          const ri = p.push(); p.op('StaR'); p.r(ri); tmp.push(ri);
        }
        /* 再逐格写到目标 */
        for (let i = 0; i < tl.length; i++) {
          p.op('LdaR'); p.r(tmp[i]);
          const tg = tl[i];
          if (tag(tg) === 'name') {
            const nm = leaf(kids(tg)[0]);
            const ref = p.resolve(nm);
            if (ref.kind === 'local') { p.op('StaR'); p.r(ref.idx); }
            else if (ref.kind === 'upvalue') { p.op('StaUp'); p.buf.u8(ref.idx); }
            else { p.op('StaGlobal'); p.k16(p.k('str', nm)); p.f16(p.fb()); }
          } else throw new Error(`emit-bc: 多返回值赋值目标还没接 '${tag(tg)}'`);
        }
        p.pop(tl.length);
        return;
      }
      /* 右边先全算进临时寄存器，再逐格写（多重赋值的语义） */
      const tmp = [];
      for (let i = 0; i < tl.length; i++) {
        if (vl[i] !== undefined) expr(p, vl[i]); else p.op('LdaNil');
        const r = p.push(); p.op('StaR'); p.r(r); tmp.push(r);
      }
      for (let i = 0; i < tl.length; i++) {
        p.op('LdaR'); p.r(tmp[i]);
        const tg = tl[i];
        if (tag(tg) === 'name') {
          const nm = leaf(kids(tg)[0]);
          const ref = p.resolve(nm);
          if (ref.kind === 'local') { p.op('StaR'); p.r(ref.idx); }
          else if (ref.kind === 'upvalue') { p.op('StaUp'); p.buf.u8(ref.idx); }
          else { p.op('StaGlobal'); p.k16(p.k('str', nm)); p.f16(p.fb()); }
        } else if (tag(tg) === 'index') {
          const [obj, key] = kids(tg);
          expr(p, obj);
          const or = p.push(); p.op('StaR'); p.r(or);
          expr(p, key);
          const kr2 = p.push(); p.op('StaR'); p.r(kr2);
          p.op('LdaR'); p.r(tmp[i]);
          p.op('SetKeyed'); p.r(or); p.r(kr2); p.f16(p.fb());
          p.pop(2);
        } else if (tag(tg) === 'dot') {
          const [obj, fld] = kids(tg);
          expr(p, obj);
          const or2 = p.push(); p.op('StaR'); p.r(or2);
          p.op('LdaR'); p.r(tmp[i]);
          p.op('SetNamed'); p.r(or2); p.k16(p.k('str', leaf(fld))); p.f16(p.fb());
          p.pop();
        } else throw new Error(`emit-bc: 还没接这格赋值目标 '${tag(tg)}'`);
      }
      p.pop(tl.length);
      return;
    }
    case 'call': {
      const fn = ch[0], args = ch[1];
      const argList = args ? kids(args) : [];
      if (tag(fn) === 'name' && leaf(kids(fn)[0]) === 'print') {
        const base = p.top;
        for (const a of argList) { expr(p, a); const r = p.push(); p.op('StaR'); p.r(r); }
        p.op('Print'); p.r(base); p.buf.u8(argList.length);
        p.pop(argList.length);
        return;
      }
      if (tryFuseSetmeta(p, fn, argList)) return;
      /* 一般的函数调用：Call r i f —— r 是函数值（紧跟着 i 格实参） */
      expr(p, fn);
      const base = p.push(); p.op('StaR'); p.r(base);     // 函数值
      for (const a of argList) { expr(p, a); const r = p.push(); p.op('StaR'); p.r(r); }
      p.op('Call'); p.r(base); p.buf.u8(argList.length); p.f16(p.fb());
      p.pop(argList.length + 1);
      return;
    }
    case 'return': {
      if (ch.length === 0) { p.op('LdaNil'); p.op('Ret'); return; }
      if (ch.length === 1) {
        withFusedFields(p, ch, () => { expr(p, ch[0]); });
        p.op('Ret');
        return;
      }
      /* 多返回值 */
      const base = p.top;
      for (const e of ch) { expr(p, e); const r = p.push(); p.op('StaR'); p.r(r); }
      p.op('RetMulti'); p.r(base); p.buf.u8(ch.length);
      p.pop(ch.length);
      return;
    }
    case 'break': {
      if (p.breakStack.length === 0) throw new Error('emit-bc: break 在循环外面');
      p.breakStack[p.breakStack.length - 1].push(p.jumpHole('Jump'));
      return;
    }
    case 'localfn': {
      const nm = leaf(ch[0]);
      const bodyNode = ch[1];
      /* **先占位再编体** —— lua 的 `local function fib(n) ... fib(n-1) ...` 里，
         fib 的递归调用要能看见自己。如果先编体再注册名字，递归那格会落到全局去。 */
      const r = p.reg(nm);
      const sub = compileBody(bodyNode, p, false);
      const ki = p.K.length; p.K.push({ t: 'proto', v: sub });
      p.op('Closure'); p.k16(ki); p.buf.u8(sub.ups.length);
      /* upvalue 的来源跟在 Closure 指令后面（解释器照这张表去建） */
      for (const u of sub.ups) p.buf.u8(u.kind === 'local' ? 0 : 1), p.buf.u8(u.idx);
      p.op('StaR'); p.r(r);
      return;
    }
    case 'if': {
      const [cond, thenBlk, elifs, elsePart] = ch;
      const branches = [{ cond, blk: thenBlk }];
      if (elifs !== undefined) for (const e of kids(elifs)) branches.push({ cond: kids(e)[0], blk: kids(e)[1] });
      const hasElse = elsePart !== undefined && tag(elsePart) === 'else';
      const ends = [];
      for (const br of branches) {
        expr(p, br.cond);
        const nextHole = p.jumpHole('JumpIfFalse');
        block(p, br.blk);
        ends.push(p.jumpHole('Jump'));
        p.patch(nextHole);
      }
      if (hasElse) block(p, kids(elsePart)[0]);
      for (const e of ends) p.patch(e);
      return;
    }
    case 'while': {
      const [cond, body] = ch;
      const top = p.buf.pos;
      p.breakStack.push([]);
      expr(p, cond);
      const out = p.jumpHole('JumpIfFalse');
      block(p, body);
      const back = p.jumpHole('JumpLoop');
      p.patchTo(back, top);
      p.patch(out);
      for (const h of p.breakStack.pop()) p.patch(h);
      return;
    }
    case 'fornum':
    case 'fornum-step': {
      const [nmNode, from, to, ...rest] = ch;
      const step = t === 'fornum-step' ? rest[0] : null;
      const body = rest[rest.length - 1];
      const nm = leaf(nmNode);
      /* 保存旧状态（for 的循环变量是自己的作用域） */
      const savedTop = p.top;
      const prevReg = p.locals.get(nm);
      /* 三格连号寄存器：i / 上界 / 步长（ForPrep / ForLoop 认这个布局） */
      const base = p.top;
      const ri = p.push(), rlim = p.push(), rstep = p.push();
      expr(p, from); p.op('StaR'); p.r(ri);
      expr(p, to); p.op('StaR'); p.r(rlim);
      if (step !== null) expr(p, step); else { p.op('LdaK'); p.k16(p.k('num', 1)); }
      p.op('StaR'); p.r(rstep);
      const prep = p.jumpHole('ForPrep', base);
      const top = p.buf.pos;
      /* 循环变量紧跟控制三元组（强制新的一格，不复用旧的 reg） */
      const rv = p.push();
      p.locals.set(nm, rv);
      p.op('LdaR'); p.r(ri); p.op('StaR'); p.r(rv);
      block(p, body);
      const loop = p.jumpHole('ForLoop', base);
      p.patchTo(loop, top);
      p.patch(prep);
      /* 恢复作用域 */
      p.top = savedTop;
      if (prevReg !== undefined) p.locals.set(nm, prevReg); else p.locals.delete(nm);
      void rlim; void rstep;
      return;
    }
    case 'fndef': {
      /* `function f(...)` / `function T.m(...)` / `function T:m(...)` */
      const target = ch[0], bodyNode = ch[1];
      if (tag(target) === 'name') {
        const nm = leaf(kids(target)[0]);
        const sub = compileBody(bodyNode, p, false);
        emitClosureOf(p, sub);
        p.op('StaGlobal'); p.k16(p.k('str', nm)); p.f16(p.fb());
        return;
      }
      /* 带点的：**先算 obj 存进临时，再造闭包（留在 acc），最后 SetNamed** ——
         次序反了的话 `expr(obj)` 会把 acc 里的闭包盖掉。 */
      const isMeth = tag(target) === 'method';
      const [objNode, fldNode] = kids(target);
      const fldName = leaf(fldNode);
      expr(p, objNode);
      const objR = p.push(); p.op('StaR'); p.r(objR);
      const sub = compileBody(bodyNode, p, isMeth);
      emitClosureOf(p, sub);
      p.op('SetNamed'); p.r(objR); p.k16(p.k('str', fldName)); p.f16(p.fb());
      p.pop();
      return;
    }
    case 'mcall': {
      /* 语句形式的方法调用 `obj:m(args)` —— 结果丢掉 */
      expr(p, x);
      return;
    }
    case 'forin': {
      /* `for name1, name2, … in exprs do body end`
         
         ipairs(t) 特化：直接展开成数值递增 + GetKeyed，不走 generic-for 协议。
         通用的 generic-for（需要多返回值）以后再加。 */
      const namesNode = ch.find(y => tag(y) === 'names');
      const valuesNode = ch.find(y => tag(y) === 'values');
      const bodyNode = ch.find(y => tag(y) === 'block');
      const nameList = namesNode ? kids(namesNode).map(n => leaf(n)) : [];
      const valExprs = valuesNode ? kids(valuesNode) : [];

      /* 检测是否是 ipairs(t) 调用 */
      const genExpr = valExprs[0];
      const isIpairs = genExpr && tag(genExpr) === 'call' && tag(kids(genExpr)[0]) === 'name'
                     && leaf(kids(kids(genExpr)[0])[0]) === 'ipairs';

      const savedTop = p.top;
      const savedLocals = new Map(p.locals);

      if (isIpairs) {
        /* ipairs 特化：for i, v in ipairs(t) → 数值循环 + GetKeyed */
        const tblExpr = kids(kids(genExpr)[1])[0]; // ipairs 的参数
        expr(p, tblExpr);
        const rTbl = p.push(); p.op('StaR'); p.r(rTbl);
        /* 控制变量 i（从 0 开始，每步 +1） */
        p.op('LdaK'); p.k16(p.k('num', 0));
        const rCtrl = p.push(); p.op('StaR'); p.r(rCtrl);
        /* 循环变量 */
        const rI = nameList[0] ? p.push() : null;
        if (rI !== null) p.locals.set(nameList[0], rI);
        const rV = nameList.length >= 2 ? p.push() : null;
        if (rV !== null) p.locals.set(nameList[1], rV);

        const loopTop = p.buf.pos;
        p.breakStack.push([]);
        /* ctrl = ctrl + 1 */
        p.op('LdaR'); p.r(rCtrl);
        const tmpR = p.push();
        p.op('StaR'); p.r(tmpR);
        p.op('LdaK'); p.k16(p.k('num', 1));
        p.op('Add'); p.r(tmpR); p.f16(p.fb());
        p.op('StaR'); p.r(rCtrl);
        p.pop(); // tmpR
        /* v = t[ctrl]; 如果 nil 就跳出 */
        {
          const tR = p.push(); p.op('LdaR'); p.r(rTbl); p.op('StaR'); p.r(tR);
          const kR = p.push(); p.op('LdaR'); p.r(rCtrl); p.op('StaR'); p.r(kR);
          p.op('GetKeyed'); p.r(tR); p.r(kR); p.f16(p.fb());
          p.pop(2);
        }
        const exitHole = p.jumpHole('JumpIfNil');
        /* acc 还是 v（JumpIfNil 不改 acc）：先存 v，再把 ctrl 存进 i */
        if (rV !== null) { p.op('StaR'); p.r(rV); }
        if (rI !== null) { p.op('LdaR'); p.r(rCtrl); p.op('StaR'); p.r(rI); }
        block(p, bodyNode);
        const back = p.jumpHole('JumpLoop');
        p.patchTo(back, loopTop);
        p.patch(exitHole);
        for (const h of p.breakStack.pop()) p.patch(h);
      } else {
        /* 通用 generic-for：`for v in g do ... end`
           展开为：
             local f = <generator expr>
             while true do
               local v = f()
               if v == nil then break end
               body
             end
        */
        expr(p, valExprs[0]);
        const rF = p.push(); p.op('StaR'); p.r(rF);
        /* 循环变量 */
        const varRegs = [];
        for (const nm of nameList) {
          const r = p.push();
          p.locals.set(nm, r);
          varRegs.push(r);
        }
        const loopTop = p.buf.pos;
        p.breakStack.push([]);
        /* call f() → acc */
        const callBase = p.push();
        p.op('LdaR'); p.r(rF); p.op('StaR'); p.r(callBase);
        p.op('Call'); p.r(callBase); p.buf.u8(0); p.f16(p.fb());
        p.pop();
        /* 如果返回 nil 就跳出 */
        const exitHole = p.jumpHole('JumpIfNil');
        /* 存到循环变量 v */
        if (varRegs.length >= 1) p.op('StaR'); p.r(varRegs[0]);
        block(p, bodyNode);
        const back = p.jumpHole('JumpLoop');
        p.patchTo(back, loopTop);
        p.patch(exitHole);
        for (const h of p.breakStack.pop()) p.patch(h);
      }
      /* 恢复作用域 */
      p.top = savedTop;
      p.locals = savedLocals;
      return;
    }
    case 'do': block(p, ch[0]); return;
    case 'block': block(p, x); return;
    default:
      throw new Error(`emit-bc: 还没接这格语句 '${t}'`);
  }
}

/** 发射 Closure 指令（从 localfn 的模式提取出来复用） */
function emitClosureOf(p, sub) {
  const ki = p.K.length; p.K.push({ t: 'proto', v: sub });
  p.op('Closure'); p.k16(ki); p.buf.u8(sub.ups.length);
  for (const u of sub.ups) p.buf.u8(u.kind === 'local' ? 0 : 1), p.buf.u8(u.idx);
}


function block(p, blk) {
  if (blk === undefined || blk === null) return;
  for (const s of kids(blk)) stmt(p, s);
}

/** 编一格函数体 → 子 Proto */
function compileBody(bodyNode, parent, implicitSelf) {
  /* **进子函数就把合并缓存清掉**：里头是另一套寄存器编号，
     拿外层那张表去解 `a.x` 会读到别的槽（段错误就是这么来的）。 */
  const savedFused = _fused;
  _fused = null;
  try { return compileBodyInner(bodyNode, parent, implicitSelf); }
  finally { _fused = savedFused; }
}

function compileBodyInner(bodyNode, parent, implicitSelf) {
  const params = kids(bodyNode).find(y => tag(y) === 'params');
  const blk = kids(bodyNode).find(y => tag(y) === 'block');
  const paramNames = [];
  let isVararg = false;
  if (implicitSelf) paramNames.push('self');
  if (params) for (const p of kids(params)) {
    if (isList(p) && tag(p) === 'vararg') { isVararg = true; }
    else paramNames.push(leaf(p));
  }
  const sub = new Proto(parent);
  sub.params = paramNames;
  sub.isVararg = isVararg;
  for (const nm of paramNames) sub.reg(nm);      // 形参占 r0..
  if (blk) block(sub, blk);
  sub.op('LdaNil'); sub.op('Ret');
  return sub;
}

/** 顶层：CST → { code, K, nreg, nfb, ups, children } */
export function compile(tree) {
  if (tag(tree) !== 'block') throw new Error('emit-bc: 要一格 (block …)');
  const p = new Proto();
  block(p, tree);
  p.op('LdaNil'); p.op('Ret');
  return finish(p);
}

function finish(p) {
  return {
    code: p.buf.bytes(), K: p.K.map(c => c.t === 'proto' ? { t: 'proto', v: finish(c.v) } : c),
    nreg: Math.max(p.nreg, 1), nfb: p.nfb, nparams: p.params.length, ups: p.ups,
    isVararg: p.isVararg ? 1 : 0,
  };
}

/** 序列化成 VM 认的那份二进制（小端，递归地把子 Proto 也写进去） */
export function serialize(fn) {
  const parts = [];
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); parts.push(b); };
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); parts.push(b); };

  function writeProto(fn) {
    u32(fn.K.length);
    for (const c of fn.K) {
      if (c.t === 'nil') parts.push(new Uint8Array([0]));
      else if (c.t === 'false') parts.push(new Uint8Array([1]));
      else if (c.t === 'true') parts.push(new Uint8Array([2]));
      else if (c.t === 'num') { parts.push(new Uint8Array([3])); f64(c.v); }
      else if (c.t === 'str') {
        parts.push(new Uint8Array([4]));
        const bytes = new TextEncoder().encode(c.v);
        u32(bytes.length); parts.push(bytes);
      }
      else if (c.t === 'proto') { parts.push(new Uint8Array([5])); writeProto(c.v); }
    }
    u32(fn.nparams ?? 0);
    u32(fn.isVararg ?? 0);
    u32(fn.nreg); u32(fn.nfb); u32(fn.code.length);
    parts.push(fn.code);
  }

  parts.push(new Uint8Array([0x4f, 0x4c, 0x42, 0x43]));   // "OLBC"
  u32(2);    // version
  writeProto(fn);
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}
