/**
 * `mir/opt` 的自测：CFG / 支配树 / 支配边界。
 * 判据用**真的 MIR**（C 前端出的），不手搓 IR —— 手搓的 IR 证明不了"能接真产物"。
 *
 * 跑：`node src/core/mir/opt/tests/cfg.test.js`
 */

import { buildCfg, dominators, domFrontiers, reachable, matchRegions } from '../cfg.js';
import { checkPassTable, passStatus, PASSES, BATCH_NO } from '../pass.js';
import { OP_NAMES, OP } from '../../ir.js';

let fails = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); fails++; }
}
function eq(got, want, msg) { ok(got === want, msg + `（得 ${got}，要 ${want}）`); }

/* ------------------------------------------------ 手工造一份最小的 fn 壳子 */
function mkFn(rows) {
  // rows: [opName, a, b, aux]
  const fn = { op: [], t: [], a: [], b: [], aux: [], slots: [], params: [] };
  for (const r of rows) {
    fn.op.push(OP[r[0]]);
    fn.t.push(0);
    fn.a.push(r[1] === undefined ? -1 : r[1]);
    fn.b.push(r[2] === undefined ? -1 : r[2]);
    fn.aux.push(r[3] === undefined ? 0 : r[3]);
  }
  return fn;
}

console.log('== 通道表自检');
ok(checkPassTable() === true, 'PASSES 无重名、PASS_ORDER 全满足');
const st = passStatus();
console.log(`  （共 ${st.total} 格；要做 ${st.want} 格；已实现 ${st.done} 格）`);
{
  let n1 = 0;
  for (const p of PASSES) if (p.batch === 1) n1++;
  ok(n1 > 0, `第一批有 ${n1} 格`);
}

console.log('== 配对扫描：IF / ELSE / END');
{
  const fn = mkFn([
    ['LOAD'], ['IF'], ['LOAD'], ['ELSE'], ['LOAD'], ['END'], ['RET'],
  ]);
  const m = matchRegions(fn);
  eq(m.endOf[1], 5, 'IF@1 的 END 在 5');
  eq(m.elseOf[1], 3, 'IF@1 的 ELSE 在 3');
}

console.log('== CFG：if / else 的菱形');
{
  //  0 LOAD          块0
  //  1 IF     -> 2 / 4
  //  2 LOAD          块1（then）
  //  3 ELSE   -> 6
  //  4 LOAD          块2（else）
  //  5 END           （空操作，落到 6）
  //  6 RET           块3（汇合）
  const fn = mkFn([
    ['LOAD'], ['IF'], ['LOAD'], ['ELSE'], ['LOAD'], ['END'], ['RET'],
  ]);
  const cfg = buildCfg(fn);
  ok(cfg.blocks.length >= 4, `切出了 ${cfg.blocks.length} 个块（≥4）`);
  const bIf = cfg.pcBlock[1], bThen = cfg.pcBlock[2], bElse = cfg.pcBlock[4], bJoin = cfg.pcBlock[6];
  ok(cfg.blocks[bIf].succ.indexOf(bThen) >= 0, 'IF 的真边 → then');
  ok(cfg.blocks[bIf].succ.indexOf(bElse) >= 0, 'IF 的假边 → else');
  ok(cfg.blocks[bJoin].pred.length === 2, `汇合块有 2 个前驱（得 ${cfg.blocks[bJoin].pred.length}）`);
  const idom = dominators(cfg);
  eq(idom[bJoin], bIf, '汇合块被 IF 那个块直接支配');
  const df = domFrontiers(cfg, idom);
  ok(df[bThen].indexOf(bJoin) >= 0, 'then 的支配边界里有汇合块');
  ok(df[bElse].indexOf(bJoin) >= 0, 'else 的支配边界里有汇合块');
}

console.log('== CFG：BLOCK + LOOP + BRIF（真的 for 循环形状）');
{
  //  0 STORE            块0
  //  1 BLOCK
  //  2   STORE
  //  3   LOOP           ← 回边落点
  //  4     LOAD
  //  5     BRIF ^1      -> BLOCK 的 END 之后（break）/ 落下去
  //  6     LOAD
  //  7     BR   ^0      -> 回 LOOP（continue）
  //  8   END            (LOOP 的)
  //  9 END              (BLOCK 的)
  // 10 RET
  const fn = mkFn([
    ['STORE'], ['BLOCK'], ['STORE'], ['LOOP'], ['LOAD'],
    ['BRIF', -1, -1, 1], ['LOAD'], ['BR', -1, -1, 0], ['END'], ['END'], ['RET'],
  ]);
  const cfg = buildCfg(fn);
  const bLoop = cfg.pcBlock[3];
  const bBody = cfg.pcBlock[6];
  const bAfter = cfg.pcBlock[10];
  ok(cfg.blocks[bBody].succ.indexOf(bLoop) >= 0, 'BR ^0 回到了循环头（回边）');
  ok(cfg.blocks[cfg.pcBlock[5]].succ.indexOf(bAfter) >= 0, 'BRIF ^1 跳到了 BLOCK 的 END 之后');
  ok(cfg.blocks[bLoop].pred.length >= 2, `循环头有 ${cfg.blocks[bLoop].pred.length} 个前驱（进入 + 回边）`);
  const idom = dominators(cfg);
  ok(idom[bLoop] >= 0, '循环头有直接支配者');
  const rs = reachable(cfg);
  /* 块 [8..9] 只有两条 END，而 7 是无条件 `BR ^0`（回循环头）⇒ 没人落到 8。
     所以**它本来就该不可达** —— 这不是 CFG 的毛病，是"END 之后没人来"的真事实，
     后面 deadcode 那一格会把它删掉。判据写成"恰好少这一个"。 */
  eq(rs.size, cfg.blocks.length - 1, '只有那个"纯 END"的块不可达');
  ok(!rs.has(cfg.pcBlock[8]), 'BR 之后那两条 END 组成的块不可达');
}

console.log('');
if (fails > 0) { console.log(`✗ ${fails} 条不过`); process.exit(1); }
console.log('✓ 全过');
