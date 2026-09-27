// ext/polydraw/net-rt.js —— **联网那一族**（`net_send` / `net_recv`），落成**生成出来的 IR**。
//
// ## 为什么它在语言这一侧，而且是"一台机器"
//
// `evaldraw.txt:1770` 那一条写着：「You can send packets to yourself. Sometimes, this
// enables simpler code.」—— 而 `NET_ALL` 的定义（`:1725`）就是「Send to everyone,
// **including self**」。也就是说**单机那一档本来就是联网那一档的一个真实情形**：
// `net_players` = 1、`net_me` = 0，发给 `NET_ALL` 的包原路落回自己的收包队列。
//
// 从前这一族在 `ABSENT_FNS` 里（回 0、实参一格不算），于是脚本里这种写法**死循环**：
//
//     if (!net_me) { rseed = …; net_send(NET_ALL,rseed); }
//     while (1) { if (net_recv(&from,&rseed)) { if (!from) { srand(rseed); break; } } }
//
// `games/stratego.kc:26` 就是这两行 —— 它拿"发给自己的那一包"当随机种子的同步点，
// 收不到就永远转。语料里靠这一族的十二份（`netsync` / `asteroids` / `stratego` /
// `kjoust3d` / `snood` / `traffic` / `chess` / `rummiken` / `tictactoe` / `set` /
// `backgammon` / `dragcards`）全是这个形状：**自己发、自己收**。
//
// 所以这一族不是"设备不在场"，是**一格队列**：纯数据、与画布/GPU 无关 ⇒ 按"只有一个模型"
// 放在语言这一侧，四条腿跑同一份代码、逐字节相同。
//
// ## 明写的偏差（照不到的地方不装作照到）
//
// 1. **只有一台机器**：`NET_ALLELSE`（发给除自己以外的所有人）在单机上**没有收件人**
//    ⇒ 什么都不发、回 0。说明书说回值是"实际发出去几个值"，所以 0 正是对的。
// 2. **`NET_ALL` / `NET_ALLELSE` / `NET_NOSYNC` 三个常量的值不可知**（evaldraw 没有源码，
//    说明书只给名字）。这儿按"落在 {0..net_players-1} 之外"编：`-1` / `-2`。
//    单机上能观察到的只有"这一包算不算发给自己" —— 只要这两个值互不相同、且都不是 0
//    （`net_me`），脚本看见的行为就与正本一致。
//    `NET_NOSYNC` 取 **0**：它的意思是「绕开经主机的排序，直接放进自己的收包队列」
//    （`:1775`），而我们只有一台机器、本来就是直接放 —— 加不加它一模一样，所以是 0
//    （这不是"编了个数"，是这一档下它确实什么都不改）。语料里没有一份 `.kc` 用到它。
// 3. **包边界**：队列里一格包是 `[个数, 值…]`。3 参发 / 2 参收时只取第一个值
//    （余下的随那一包一起丢）—— 语料里没有这种混用。
// 4. 队列满（`NETQ` 格）时 `net_send` **回 0**：说明书自己留了这一格
//    （「0 if failed … serious connection or buffering problem」）。
import { ARR, num, nm, bin, call, set, letR, ret, iff, whil, ex, aset, aget, fn, fnT, glob, anew } from './ir.js';

/** 宿主名字/元数 -> 生成出来的那格函数。 */
export const NET_FNS = new Map([
  ['net_send/2', 'pd_netsend2'],
  ['net_send/3', 'pd_netsend3'],
  ['net_recv/2', 'pd_netrecv2'],
  ['net_recv/3', 'pd_netrecv3'],
]);

/** `net_send` 的 `to` 那三格常量（值的来历见文件头第 2 条偏差）。 */
export const NET_CONSTS = new Map([
  ['net_all', -1], ['net_allelse', -2], ['net_nosync', 0],
]);

/** 收包队列有多少格（值 + 每包一格包头）。 */
const NETQ = 4096;
/** 3 参那两格一次最多 512 个值（`evaldraw.txt:1783`）。 */
const NETMAX = 512;

export function netGlobalDecls() {
  return [glob('pd_netq', ARR), glob('pd_neton'), glob('pd_netr'), glob('pd_netw')];
}

/**
 * **这一包不是发给自己的**（那就没有收件人 ⇒ 什么都不发）。
 *
 * 发给自己的只有两种 `to`：`NET_ALL`(-1) 与 `net_me`(0)。`NET_ALLELSE`(-2) 与
 * 「别的玩家」在单机上都落空。
 */
const notSelf = (t) => bin('&&', bin('!=', t, num(-1)), bin('!=', t, num(0)));

/** 队列空了就把两个游标归零 —— 不然发够 `NETQ` 格就再也发不出去。 */
const compact = () => iff(bin('>=', nm('pd_netr'), nm('pd_netw')), [
  set('pd_netr', num(0)), set('pd_netw', num(0)),
]);

export function netFnDecls() {
  return [
    /* 开一次（与 `gl_need` 同一手：数组只在真用到时开）。 */
    fn('pd_netneed', [], [
      iff(bin('!=', nm('pd_neton'), num(0)), [ret(num(0))]),
      set('pd_neton', num(1)),
      set('pd_netq', anew(num(NETQ))),
      set('pd_netr', num(0)), set('pd_netw', num(0)),
      ret(num(0)),
    ]),
    /* 压一格包头（`n` 个值）。回 1 = 有地方，0 = 满了。 */
    fn('pd_netpush', ['n'], [
      ex(call('pd_netneed', [])),
      compact(),
      iff(bin('>', bin('+', bin('+', nm('pd_netw'), num(1)), nm('n')), num(NETQ)), [ret(num(0))]),
      aset('pd_netq', nm('pd_netw'), nm('n')),
      set('pd_netw', bin('+', nm('pd_netw'), num(1))),
      ret(num(1)),
    ]),
    /* `net_send(to,val)`。 */
    fn('pd_netsend2', ['to', 'val'], [
      iff(notSelf(nm('to')), [ret(num(0))]),
      iff(bin('==', call('pd_netpush', [num(1)]), num(0)), [ret(num(0))]),
      aset('pd_netq', nm('pd_netw'), nm('val')),
      set('pd_netw', bin('+', nm('pd_netw'), num(1))),
      ret(num(1)),
    ]),
    /* `net_send(to,buf,leng)`（`buf` 是一整块 ⇒ 形参里两格：块 + 偏移）。 */
    fnT('pd_netsend3', [['to'], ['buf', ARR], ['bo'], ['leng']], [
      letR('n', nm('leng')),
      iff(bin('>', nm('n'), num(NETMAX)), [set('n', num(NETMAX))]),
      iff(bin('<', nm('n'), num(1)), [ret(num(0))]),
      iff(notSelf(nm('to')), [ret(num(0))]),
      iff(bin('==', call('pd_netpush', [nm('n')]), num(0)), [ret(num(0))]),
      letR('i', num(0)),
      whil(bin('<', nm('i'), nm('n')), [
        aset('pd_netq', nm('pd_netw'), aget('buf', bin('+', nm('bo'), nm('i')))),
        set('pd_netw', bin('+', nm('pd_netw'), num(1))),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      ret(nm('n')),
    ]),
    /* `net_recv(&from,&val)`：取一包、只要第一个值。回读到几个（1）或 0。 */
    fnT('pd_netrecv2', [['fr', ARR], ['fo'], ['vl', ARR], ['vo']], [
      ex(call('pd_netneed', [])),
      iff(bin('>=', nm('pd_netr'), nm('pd_netw')), [ret(num(0))]),
      letR('n', aget('pd_netq', nm('pd_netr'))),
      set('pd_netr', bin('+', nm('pd_netr'), num(1))),
      /* 单机只有自己 ⇒ 发件人恒是 `net_me`（0）。 */
      aset('fr', nm('fo'), num(0)),
      aset('vl', nm('vo'), aget('pd_netq', nm('pd_netr'))),
      set('pd_netr', bin('+', nm('pd_netr'), nm('n'))),
      compact(),
      ret(num(1)),
    ]),
    /* `net_recv(&from,buf,leng)`：取一包、往 `buf` 里抄 min(leng, 这包有几个)。 */
    fnT('pd_netrecv3', [['fr', ARR], ['fo'], ['buf', ARR], ['bo'], ['leng']], [
      ex(call('pd_netneed', [])),
      iff(bin('>=', nm('pd_netr'), nm('pd_netw')), [ret(num(0))]),
      letR('n', aget('pd_netq', nm('pd_netr'))),
      set('pd_netr', bin('+', nm('pd_netr'), num(1))),
      letR('m', nm('leng')),
      iff(bin('>', nm('m'), nm('n')), [set('m', nm('n'))]),
      iff(bin('<', nm('m'), num(0)), [set('m', num(0))]),
      aset('fr', nm('fo'), num(0)),
      letR('i', num(0)),
      whil(bin('<', nm('i'), nm('m')), [
        aset('buf', bin('+', nm('bo'), nm('i')), aget('pd_netq', bin('+', nm('pd_netr'), nm('i')))),
        set('i', bin('+', nm('i'), num(1))),
      ]),
      set('pd_netr', bin('+', nm('pd_netr'), nm('n'))),
      compact(),
      ret(nm('m')),
    ]),
  ];
}
