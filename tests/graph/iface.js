#!/usr/bin/env node
// tests/graph/iface.js —— **G3：子图替换前后，端口 / 效应签名 / region 逐格对上**
//
// 这是 ADR-0033 那五条静态检查里最后一条落地的。前四条早就有判据（G1 在 `node()` 里、
// G2 是"手写 seq 即错"、G4 是次序逐字节相同、G5 是提供者普查），G3 一直只是一句话。
//
// ## 判据长什么样
//
// 一条 case = **两块做同一件事、但一个节点都对不上的子图**（`while` 求和 vs 闭式
// `n*(n+1)/2`）。要求两条一起：
//   1. `ifaceOf` 算出来的四栏 + region 形状**逐格相同**（`sameIface` 回 null）；
//   2. 把两块分别装进同一个宿主程序，**每条能跑的腿上输出逐行相同**。
// 第 2 条是第 1 条的意义所在：接口相同才敢换，而"敢换"必须能在运行时被证伪。
//
// ## 反面同样要有（不然这条判据是空的）
//
// 接口**不同**的替换必须被指出来，而且要说清是哪一栏不同：多印一行（effects）、
// 写了外面的名字（writes）、往外层添了名字（binds）、多包一层 region（shape）。
// 只测正面的话，一个永远回 `null` 的 `sameIface` 也能全绿。
//
//   node tests/graph/iface.js
//   node tests/graph/iface.js sum        只跑名字里带 sum 的

import { node, lit, program, bin } from '../../src/core/graph/graph.js';
import { ifaceOf, ifaceText, sameIface } from '../../src/core/graph/iface.js';
import { backends, Gap } from '../../src/core/graph/contract.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const no = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n${why}\n`); };

const ref = (name) => node('ref', {}, { name });
const say = (x) => node('prim', { args: [x] }, { name: 'print' });
const ret = (x) => node('ret', { value: x });
const fn = (name, params, body) => node('bind', {
  init: node('func', { body }, { params, name }),
}, { name });
const call = (name, args) => node('call', { fn: ref(name), args });

// ---------------------------------------------------------------- 两块等价的子图
//
// 同一件事两种写法。第一种是十门语言的 basics 里那个 `sumto`（一格 loop + 两格局部量），
// 第二种是闭式 —— 图上**一个节点都对不上**，接口却必须一格不差。
const SUM_LOOP = [
  node('bind', { init: lit(0) }, { name: 'acc' }),
  node('bind', { init: lit(1) }, { name: 'i' }),
  node('loop', {
    cond: bin('<=', ref('i'), ref('n')),
    body: [
      node('set', { value: bin('+', ref('acc'), ref('i')) }, { name: 'acc' }),
      node('set', { value: bin('+', ref('i'), lit(1)) }, { name: 'i' }),
    ],
  }),
  ret(ref('acc')),
];
const SUM_CLOSED = [
  ret(bin('/', bin('*', ref('n'), bin('+', ref('n'), lit(1))), lit(2))),
];

/** 换个内部局部量的名字 —— **接口不该动**（它说的是边界，不是里头长什么样）。 */
const SUM_RENAMED = [
  node('bind', { init: lit(0) }, { name: 's' }),
  node('bind', { init: lit(1) }, { name: 'k' }),
  node('loop', {
    cond: bin('<=', ref('k'), ref('n')),
    body: [
      node('set', { value: bin('+', ref('s'), ref('k')) }, { name: 's' }),
      node('set', { value: bin('+', ref('k'), lit(1)) }, { name: 'k' }),
    ],
  }),
  ret(ref('s')),
];

/** 宿主：把一块子图当 `sumto` 的体装进去，印两个数。两块子图共用这一份。 */
const host = (body) => program([
  fn('sumto', ['n'], body),
  say(call('sumto', [lit(5)])),
  say(call('sumto', [lit(10)])),
]);

// ---------------------------------------------------------------- 1) 正面
for (const [name, a, b] of [
  ['sum：while 求和 换成 闭式', SUM_LOOP, SUM_CLOSED],
  ['sum：换掉内部局部量的名字', SUM_LOOP, SUM_RENAMED],
]) {
  if (only.length > 0 && !only.some((x) => name.includes(x))) continue;
  const ia = ifaceOf(a);
  const ib = ifaceOf(b);
  const diff = sameIface(ia, ib);
  if (diff !== null) {
    no(`${name}〔接口〕`, `       ${diff}\n       前: ${ifaceText(ia)}\n       后: ${ifaceText(ib)}`);
  } else ok(`${name}〔接口逐格相同〕 ${ifaceText(ia)}`);
  // 接口相同还不够 —— 装进同一个宿主，每条能跑的腿上输出必须逐行相同
  const want = ['15', '55'];
  for (const back of backends()) {
    if (back.runnable === false) continue;
    const runs = [a, b].map((body) => {
      try {
        return back.lower(host(body)).run().out;
      } catch (err) {
        return err instanceof Gap ? { gap: err.message } : { bad: err.message };
      }
    });
    const [ra, rb] = runs;
    if (ra.gap !== undefined || rb.gap !== undefined) {
      process.stdout.write(`  skip ${name} × ${back.name}：${ra.gap ?? rb.gap}\n`);
      continue;
    }
    if (ra.bad !== undefined || rb.bad !== undefined) {
      no(`${name} × ${back.name}`, `       ${ra.bad ?? rb.bad}`);
      continue;
    }
    if (ra.join(' / ') !== want.join(' / ') || rb.join(' / ') !== want.join(' / ')) {
      no(`${name} × ${back.name}`, `       期望 ${want.join(' / ')}\n`
        + `       前 ${ra.join(' / ')}\n       后 ${rb.join(' / ')}`);
      continue;
    }
    ok(`${name} × ${back.name} [换前换后都是 ${want.join(' / ')}]`);
  }
}

// ---------------------------------------------------------------- 2) 反面：每一栏各一条
//
// 每一条都是"看着也能算出 15/55、但接口不一样"的替换。判据是**报得出是哪一栏**。
const BAD = [
  ['effects 那一栏〔多印一行〕', [say(lit(0)), ...SUM_CLOSED], 'effects'],
  ['writes 那一栏〔写了外面的名字〕',
    [node('set', { value: lit(0) }, { name: 'total' }), ...SUM_CLOSED], 'writes'],
  ['reads 那一栏〔读了别的自由名字〕',
    [ret(bin('*', ref('n'), ref('scale')))], 'reads'],
  ['region 形状〔多包一层 region〕',
    [node('region', { body: SUM_CLOSED })], 'region'],
];
for (const [name, body, col] of BAD) {
  if (only.length > 0 && !only.some((x) => name.includes(x))) continue;
  const diff = sameIface(ifaceOf(SUM_CLOSED), ifaceOf(body));
  if (diff === null) {
    no(`反面：${name}`, '       接口被判成"相同" —— 这条判据是空的');
  } else if (!diff.includes(col)) {
    no(`反面：${name}`, `       报的不是那一栏：${diff}`);
  } else ok(`反面：${name} [${diff}]`);
}

// ---------------------------------------------------------------- 3) binds 那一栏 = 插在哪儿
//
// 顶层 `bind` 算不算接口，取决于这块**与外面共不共用一层作用域**：
//   * 换整块函数体（`shared: false`）—— 那些名字是内部局部量，换掉就没了，不算；
//   * 换宿主 body 里的一截（`shared: true`）—— 那些名字漏给后面没被替换的节点，算。
// 这两条一起才说得清 `ifaceOf` 那个开关不是随手加的。
{
  const withTmp = [node('bind', { init: lit(0) }, { name: 'tmp' }), ...SUM_CLOSED];
  const own = sameIface(ifaceOf(SUM_CLOSED), ifaceOf(withTmp));
  const shared = sameIface(ifaceOf(SUM_CLOSED, { shared: true }), ifaceOf(withTmp, { shared: true }));
  if (own !== null) {
    no('binds：换整块函数体时内部局部量不算接口', `       却报了：${own}`);
  } else ok('binds：换整块函数体时内部局部量不算接口');
  if (shared === null || !shared.includes('binds')) {
    no('binds：共用一层作用域时那格名字算接口', `       期望报 binds 那一栏，得到：${shared}`);
  } else ok(`binds：共用一层作用域时那格名字算接口 [${shared}]`);
}

// ---------------------------------------------------------------- 4) 早退跨不跨得出去
//
// `may-early-exit` 只在**跑得出这块**时才算 —— `loop` 收住 `break`、`func` 收住 `ret`。
// 这是 iface.js 里 `CATCHES` 那张表的全部内容，所以它要有自己的一条判据（正反各一半）。
{
  const inside = [node('loop', {
    cond: lit(false), body: [node('loop-exit', {}, { kind: 'break' })],
  })];
  const bare = [node('loop-exit', {}, { kind: 'break' })];
  const a = ifaceOf(inside);
  const b = ifaceOf(bare);
  if (a.effects.includes('may-early-exit')) {
    no('早退：`break` 在自己的 loop 里跨不出去', `       却算进了效应：${ifaceText(a)}`);
  } else ok(`早退：\`break\` 在自己的 loop 里跨不出去 [${ifaceText(a)}]`);
  if (!b.effects.includes('may-early-exit')) {
    no('早退：光一格 `break` 是跨得出去的', `       却没算进效应：${ifaceText(b)}`);
  } else ok(`早退：光一格 \`break\` 是跨得出去的 [${ifaceText(b)}]`);
}

process.stdout.write(`\n${pass} passed, ${fail} failed（G3：子图替换前后接口逐格对上）\n`);
if (fail > 0) process.exit(1);
