// ext/go/adapter/conc.js —— **go 的并发**（goroutine / channel / select）
//
// 一格都不给方言加：通道与调度器的体在 `libomnigo`（`src/runtime-sched/omni_go.c`），
// 前端落成 `(ccall omni_go_…)`。这条路的理由与 ADR-0040 的接口同一条 ——
// "方言里已经有的形状"优先于"给中间表示加一族节点"。
//
//   * `make(chan T, n)`  -> `(ccall omni_go_chan_new n)`（通道是**一格句柄**，方言里是 int）
//   * `ch <- v`          -> `(ccall omni_go_chan_send ch v)`
//   * `<-ch`             -> `(ccall omni_go_chan_recv ch)`
//   * `v, ok := <-ch`    -> `recv2` 收一格 + `ok` 取那一位（两句之间不 park，所以不换 M）
//   * `close(ch)` / `len(ch)` -> `chan_close` / `chan_len`
//   * `go f(a…)`         -> `(ccall omni_go_spawnN (fnref f) a…)`（0~3 格实参，照 C 那侧的门面）
//   * `for v := range ch`-> 照 go 规范摊成 `for { v, ok := <-ch; if !ok break; … }`
//   * `select`           -> 先把每一格 case 报上去、`sel_go()` 真选、再按下标落一条 if 链
//
// **`main` 要跑成主 g**（`(ccall omni_go_run (fnref main))`）：`chan_send` 阻塞时要 park
// 当前那条 g 再切走，而主线程本身不是 g。这一格由 `C.needsSched` 那一位管。

import { INT, typeOf } from '../../../src/core/lower/ty-of.js';
import { tag, kids, part } from '../../../src/core/lower/cst.js';
import { exprOf, valueOf, nameOf } from './expr.js';

/** 那几格 C 符号的签名（正本是 `src/runtime-sched/omni_go.h`）。 */
const RT = {
  run: { sym: 'omni_go_run', ret: 'void', ps: ['fn'] },
  spawn0: { sym: 'omni_go_spawn0', ret: 'void', ps: ['fn'] },
  spawn1: { sym: 'omni_go_spawn', ret: 'void', ps: ['fn', 'i64'] },
  spawn2: { sym: 'omni_go_spawn2', ret: 'void', ps: ['fn', 'i64', 'i64'] },
  spawn3: { sym: 'omni_go_spawn3', ret: 'void', ps: ['fn', 'i64', 'i64', 'i64'] },
  chanNew: { sym: 'omni_go_chan_new', ret: 'ptr', ps: ['i64'] },
  chanSend: { sym: 'omni_go_chan_send', ret: 'void', ps: ['ptr', 'i64'] },
  chanRecv: { sym: 'omni_go_chan_recv', ret: 'i64', ps: ['ptr'] },
  chanRecv2: { sym: 'omni_go_chan_recv2', ret: 'i64', ps: ['ptr'] },
  chanOK: { sym: 'omni_go_chan_ok', ret: 'i64', ps: [] },
  chanClose: { sym: 'omni_go_chan_close', ret: 'void', ps: ['ptr'] },
  chanLen: { sym: 'omni_go_chan_len', ret: 'i64', ps: ['ptr'] },
  selBegin: { sym: 'omni_go_sel_begin', ret: 'void', ps: [] },
  selRecv: { sym: 'omni_go_sel_recv', ret: 'void', ps: ['ptr'] },
  selSend: { sym: 'omni_go_sel_send', ret: 'void', ps: ['ptr', 'i64'] },
  selDefault: { sym: 'omni_go_sel_default', ret: 'void', ps: [] },
  selGo: { sym: 'omni_go_sel_go', ret: 'i64', ps: [] },
  selVal: { sym: 'omni_go_sel_val', ret: 'i64', ps: [] },
  selOK: { sym: 'omni_go_sel_ok', ret: 'i64', ps: [] },
};

const nameRef = (n) => ({ kind: 'name', name: n });
const int = (v) => ({ kind: 'int', value: v });

/** 一格运行时调用（顺手把 `(lib …)` / `(cabi …)` 记到模块头上）。 */
function rt(which, args, C) {
  const d = RT[which];
  C.needC(d.sym, d.ret, d.ps);
  C.needsSched = true;
  return {
    kind: 'ccall', sym: d.sym, args, type: d.ret === 'void' ? { kind: 'void' } : INT,
  };
}

/** 一格通道的类型：方言里是**一格句柄**（int），元素类型记在 `chan` 那一位上。 */
export const chanType = (elem) => ({ kind: 'int', chan: elem });

/** `chan T` / `chan<- T` / `<-chan T` 三种写法都是同一格。 */
export function chanTypeOfTok(tok, C, typeOfTok) {
  return chanType(typeOfTok(kids(tok)[0], C));
}

/** `make(chan T, n)`。 */
export function chanMake(capTok, C) {
  const n = capTok === undefined ? int(0) : valueOf(capTok, INT, C);
  return rt('chanNew', [n], C);
}

/** `<-ch`（表达式位置）。 */
export function chanRecv(chTok, C) {
  return rt('chanRecv', [exprOf(chTok, C)], C);
}

/** `close(ch)` / `len(ch)`。 */
export const chanClose = (ch, C) => rt('chanClose', [ch], C);
export const chanLen = (ch, C) => rt('chanLen', [ch], C);

/** `ch <- v`（语句）。 */
export function sendStmts(x, C) {
  const ch = exprOf(kids(x)[0], C);
  const t = typeOf(ch, C.tyCtx());
  return [{
    kind: 'expr-stmt',
    expr: rt('chanSend', [ch, valueOf(kids(x)[1], t.chan ?? INT, C)], C),
  }];
}

/**
 * `go f(a…)` / `go func(…){…}(a…)`。
 * 实参在**这一刻**就算好（与 `defer` 同一条规矩），C 那侧的门面按个数分四格。
 */
export function goStmts(x, C) {
  const callTok = kids(x)[0];
  if (tag(callTok) !== 'call') throw new Error('go->IR: `go` 后面要是一格调用');
  const fnTok = kids(callTok)[0];
  const argsTok = part(callTok, 'args');
  const rawArgs = argsTok === undefined ? [] : kids(argsTok);
  /* 匿名函数提成一格顶层函数；它借走的局部量已经在 `capturedNames` 那一趟提成 global 了。 */
  const name = tag(fnTok) === 'fnlit' ? C.lift(fnTok, null) : C.ref(nameOf(fnTok));
  const sig = C.fns.get(name);
  if (sig === undefined) throw new Error(`go->IR: \`go ${name}(…)\` —— 这个名字没有登记过`);
  if (rawArgs.length > 3) {
    throw new Error('go->IR: `go f(…)` 最多接到三格实参（C 那侧的门面是 spawn0..spawn3）');
  }
  const args = rawArgs.map((a, i) => valueOf(a, sig.params[i]?.type, C));
  const which = ['spawn0', 'spawn1', 'spawn2', 'spawn3'][args.length];
  return [{
    kind: 'expr-stmt',
    expr: rt(which, [{ kind: 'fn-ref', name }, ...args], C),
  }];
}

/**
 * `for v := range ch` —— go 规范里它就是
 * `for { v, ok := <-ch; if !ok { break }; … }`。
 */
export function rangeChanStmts(x, C, box, names, declare, stmtsOf) {
  C.push();
  const raw = names[0];
  const tmp = C.fresh('rcv');
  C.bind(tmp, INT);
  const body = [
    { kind: 'let', name: tmp, type: INT, init: rt('chanRecv2', [box], C) },
    {
      kind: 'if',
      cond: { kind: 'binop', op: '==', left: rt('chanOK', [], C), right: int(0) },
      then: [{ kind: 'break', label: null }],
      else_: null,
    },
  ];
  if (raw !== undefined && raw !== '_') {
    const v = C.ref(raw);
    C.bind(v, INT);
    body.push(declare
      ? { kind: 'let', name: v, type: INT, init: nameRef(tmp) }
      : { kind: 'assign', target: nameRef(v), value: nameRef(tmp) });
  }
  body.push(...C.blockStmts(part(x, 'block')));
  C.pop();
  return [{
    kind: 'for', init: null, cond: { kind: 'bool', value: true }, post: null, body,
  }];
}

/**
 * `select { case v := <-ch: … case ch <- x: … default: … }`。
 * 三段：每一格 case 报上去 → `sel_go()` 真选（回下标）→ 按下标落一条 if 链。
 */
export function selectStmts(x, C, stmtsOf) {
  const out = [{ kind: 'expr-stmt', expr: rt('selBegin', [], C) }];
  const arms = [];
  let dflt = null;
  let n = 0;
  for (const c of kids(x)) {
    if (tag(c) === 'default') {
      out.push({ kind: 'expr-stmt', expr: rt('selDefault', [], C) });
      dflt = { at: n, bodyTok: part(c, 'body') };
      n += 1;
      continue;
    }
    if (tag(c) !== 'case') continue;
    const head = kids(c).find((y) => tag(y) !== 'body');
    const one = { at: n, bodyTok: part(c, 'body'), bind: null, kind: 'recv' };
    if (tag(head) === 'send') {
      const ch = exprOf(kids(head)[0], C);
      const t = typeOf(ch, C.tyCtx());
      out.push({
        kind: 'expr-stmt',
        expr: rt('selSend', [ch, valueOf(kids(head)[1], t.chan ?? INT, C)], C),
      });
      one.kind = 'send';
    } else {
      /* 收那一路：`case <-ch:` / `case v := <-ch:` / `case v = <-ch:`。 */
      const recvTok = recvOf(head);
      if (recvTok === null) throw new Error('go->IR: select 的这一格 case 还没接');
      out.push({ kind: 'expr-stmt', expr: rt('selRecv', [exprOf(kids(recvTok)[0], C)], C) });
      if (tag(head) === 'define' || tag(head) === 'assign') {
        one.bind = nameOf(kids(part(head, 'lhs'))[0]);
        one.declare = tag(head) === 'define';
      }
    }
    arms.push(one);
    n += 1;
  }
  const picked = C.fresh('sel');
  C.bind(picked, INT);
  out.push({ kind: 'let', name: picked, type: INT, init: rt('selGo', [], C) });

  const bodyOf = (one) => {
    C.push();
    const head = [];
    if (one.bind !== undefined && one.bind !== null && one.bind !== '_') {
      const v = C.ref(one.bind);
      C.bind(v, INT);
      head.push(one.declare
        ? { kind: 'let', name: v, type: INT, init: rt('selVal', [], C) }
        : { kind: 'assign', target: nameRef(v), value: rt('selVal', [], C) });
    }
    const body = [...head, ...kids(one.bodyTok ?? { kind: 'list', items: [] })
      .flatMap((s) => stmtsOf(s, C))];
    C.pop();
    return body;
  };
  const all = dflt === null ? arms : [...arms, { ...dflt, bind: null }];
  let chain = null;
  for (let i = all.length - 1; i >= 0; i--) {
    chain = [{
      kind: 'if',
      cond: { kind: 'binop', op: '==', left: nameRef(picked), right: int(all[i].at) },
      then: bodyOf(all[i]),
      else_: chain,
    }];
  }
  return [{ kind: 'block', stmts: [...out, ...(chain ?? [])] }];
}

/** 一格 case 头里那个 `<-ch`（`(recv …)`）。回 null = 这一格不是"收"。 */
function recvOf(head) {
  if (head === undefined || head === null) return null;
  if (tag(head) === 'recv') return head;
  if (tag(head) === 'expr') return recvOf(kids(head)[0]);
  if (tag(head) === 'define' || tag(head) === 'assign') {
    const rhs = part(head, 'rhs');
    return rhs === undefined ? null : recvOf(kids(rhs)[0]);
  }
  return null;
}

/** `main` 要跑成主 g 的那一句。 */
export const runMain = (C) => ({
  kind: 'expr-stmt', expr: rt('run', [{ kind: 'fn-ref', name: 'main' }], C),
});
