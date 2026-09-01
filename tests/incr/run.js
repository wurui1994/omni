#!/usr/bin/env node
// Omni — 增量编译（第十一条测试轴，ADR-0014 决策 5 / 验收门槛 4）
//
// 门槛的原话是「改一个函数体，重编只发生在那一个函数上，用**缓存命中/未命中计数**断言，
// 不靠计时」。所以这条轴一次计时都不做 —— 计时会被机器负载和 JIT 预热淹没，计数是确定的。
//
// 五组断言，每组对应一种会让增量退化成全量的失效模式：
//
//   1. 冷/热：第一次全 miss，同一份源码第二次全 hit（**跨进程**，缓存在磁盘上）。
//   2. 改一个函数体：miss 恰好是 1。改的那个函数的调用者不能失效 —— 键里带的是被调者的
//      **签名**哈希，不是函数体哈希。
//   3. 在文件开头插一个带新常量的新函数：原有函数照样 hit。这一条防的是「哈希里带池下标」：
//      MIR 指令字节里的常量 ref、CALL 的函数下标全是模块级下标，插一个函数就会让它后面
//      所有函数的字节变化。所以缓存键用的是规范化文本而不是裸字节（mir/bytes.js）。
//   4. 被调者签名变了，调用者必须失效（在 unitKey 层直接验，不绕源码）。
//   5. 缓存里的产物**就是后端会发出的那段文本** —— 否则命中就是在拿一段假货换真编译。
//
//   node tests/incr/run.js

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Diagnostics } from '../../stage0/src/source/diag.js';
import { loadProgram, MODE_BY_EXT } from '../../stage0/src/module/load.js';
import { check } from '../../stage0/src/hir/check.js';
import { lowerToMir } from '../../stage0/src/mir/from_oir.js';
import { moduleHashes } from '../../stage0/src/mir/bytes.js';
import { emitJs, emitJsFunc } from '../../stage0/src/backend-js/emit.js';
import { IncrCache, compileIncremental, unitKey, calleesOf } from '../../stage0/src/incr/cache.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');

let pass = 0;
let fail = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const bad = (label, detail) => {
  fail++;
  failures.push(`${label}\n${detail}`);
  process.stdout.write(`  FAIL ${label}\n`);
};

const dir = workDir('incr');

/** `omni incr` 一次，返回 {units, hit, miss, emit}。子进程 = 缓存真的过了磁盘。 */
function incr(src, cache, extra = []) {
  const out = execFileSync('node', [cli, 'incr', src, '--cache', cache, ...extra], { encoding: 'utf8' });
  const last = out.trim().split('\n').pop();
  const m = /^units=(\d+) hit=(\d+) miss=(\d+) emit=(\d+)$/.exec(last);
  if (m === null) throw new Error(`看不懂 incr 的输出：${JSON.stringify(last)}`);
  return { text: out, units: +m[1], hit: +m[2], miss: +m[3], emit: +m[4] };
}

function toMir(path) {
  const diags = new Diagnostics();
  const ext = path.slice(path.lastIndexOf('.'));
  const mode = MODE_BY_EXT[ext] ?? 'mixed';
  const { decls, imports } = loadProgram({ path, mode, diags });
  diags.throwIfErrors();
  const mod = check({ kind: 'Program', decls, imports }, diags, mode);
  diags.throwIfErrors();
  return { mod, mir: lowerToMir(mod) };
}

// ------------------------------------------------- 1. 冷 / 热

const SRC = (gBody, extra = '', tail = '') => [
  extra,
  'int f(int a) { return a + 1; }',
  `int g(int a) { return ${gBody}; }`,
  'int caller(int a) { return f(a) + g(a); }',
  'print(caller(3));',
  tail,
  '',
].join('\n');

const pa = join(dir, 'a.omni');
const cacheA = join(dir, 'cache-a');
writeFileSync(pa, SRC('a * 2'));

const cold = incr(pa, cacheA);
if (cold.miss !== cold.units || cold.hit !== 0) {
  bad('cold', `    冷缓存应该全 miss，实得 hit=${cold.hit} miss=${cold.miss} / ${cold.units}`);
} else {
  ok(`cold [${cold.units} units 全 miss]`);
}

const warm = incr(pa, cacheA);
if (warm.hit !== warm.units || warm.miss !== 0 || warm.emit !== 0) {
  bad('warm', `    热缓存应该全 hit 且一次都不发，实得 hit=${warm.hit} miss=${warm.miss} emit=${warm.emit}`);
} else {
  ok(`warm [${warm.units} units 全 hit，emit=0，缓存跨进程]`);
}

// 落盘的条目数 = 单元数（内容寻址：文件名就是键）
const files = readdirSync(cacheA).filter((f) => f.endsWith('.unit'));
if (files.length !== cold.units) bad('cache/files', `    ${files.length} 个 .unit，应该 ${cold.units} 个`);
else ok(`cache/files [${files.length} 个内容寻址条目]`);

// ------------------------------------------------- 2. 改一个函数体：miss 恰好 1

const pb = join(dir, 'b.omni');
writeFileSync(pb, SRC('a * 3'));
const one = incr(pb, cacheA);
if (one.miss !== 1) {
  bad('one-body-change', `    只改了 g 的函数体，应该只 miss 1 个，实得 miss=${one.miss}\n${one.text}`);
} else {
  ok(`one-body-change [miss=1 hit=${one.hit}：caller 没失效，键里是被调者的签名哈希]`);
}

// ------------------------------------------------- 3. 插一个带新常量的函数：老函数照样 hit

const pc = join(dir, 'c.omni');
// 新常量 424242 会挤进模块常量池的前面 —— 裸字节做哈希的话，f/g/caller 的常量 ref
// 全部位移，这一条就会变成全 miss。
//
// `inserted` **必须真的被调到**：摇树那一刀（42c084f）之后没人调的函数在降级前就被摘掉，
// 它的常量根本不会进池 —— 那样这一条什么都没测（那个版本里它"通过"是因为 miss=0，
// 而不是因为键对）。代价是 omni_main 的函数体也跟着变，所以预期是 miss=2：
// inserted 是新的、omni_main 改了，而 f/g/caller 三个的键不含常量池下标，照样 hit。
writeFileSync(pc, SRC('a * 3', 'int inserted(int a) { return a + 424242; }', 'print(inserted(1));'));
const ins = incr(pc, cacheA);
if (ins.miss !== 2 || ins.hit !== 3) {
  bad('insert-front', `    插一个被调到的新函数应该 miss=2（inserted 与 omni_main）hit=3，实得 miss=${ins.miss} hit=${ins.hit}\n${ins.text}`);
} else {
  ok(`insert-front [miss=2 hit=${ins.hit}：f/g/caller 的键不含常量池下标]`);
}

// ------------------------------------------------- 4. 被调者签名变了，调用者要失效

{
  const { mir } = toMir(pa);
  const caller = mir.funcs.filter((f) => f.name === 'u_caller')[0];
  const cs = calleesOf(mir, caller);
  const h = moduleHashes(mir);
  const k0 = unitKey(mir, caller, 'js', h);
  // 只动被调者的**签名**哈希：调用者的键必须跟着变
  const h2 = new Map(h);
  h2.set('u_g', { body: h.get('u_g').body, sig: 'deadbeefdeadbeef' });
  const k1 = unitKey(mir, caller, 'js', h2);
  // 只动被调者的**函数体**哈希：调用者的键不能变
  const h3 = new Map(h);
  h3.set('u_g', { body: 'feedfacefeedface', sig: h.get('u_g').sig });
  const k2 = unitKey(mir, caller, 'js', h3);
  const detail = [];
  if (cs.join(',') !== 'u_f,u_g') detail.push(`    caller 的静态依赖应该是 u_f,u_g，实得 ${cs.join(',')}`);
  if (k0 === k1) detail.push('    被调者签名变了，调用者的键没变');
  if (k0 !== k2) detail.push('    只改被调者函数体，调用者的键却变了');
  // 后端标记进键：同一个函数在两个后端是两个条目
  if (unitKey(mir, caller, 'llvm', h) === k0) detail.push('    换后端标记键没变，两个后端会互相污染');
  if (detail.length > 0) bad('sig-vs-body', detail.join('\n'));
  else ok(`sig-vs-body [依赖=${cs.join(',')}；签名变→失效，函数体变→不失效；后端标记进键]`);
}

// ------------------------------------------------- 5. 缓存里的产物就是后端发出的那段文本

{
  const { mod, mir } = toMir(pa);
  const byName = new Map();
  for (const f of mod.funcs) byName.set(f.mangled, f);
  const res = compileIncremental(mir, 'js', new IncrCache(null), (name) => emitJsFunc(mod, byName.get(name)));
  const whole = emitJs(mod);
  const detail = [];
  for (const u of res.units) {
    if (!whole.includes(u.text.trimEnd())) detail.push(`    ${u.name} 的缓存产物不在整模块产物里`);
  }
  // 内存缓存也要能命中：同一份 mir 再走一遍全是 hit
  const cache = new IncrCache(null);
  compileIncremental(mir, 'js', cache, (name) => emitJsFunc(mod, byName.get(name)));
  const again = compileIncremental(mir, 'js', cache, () => { throw new Error('命中时不该调 emitFunc'); });
  if (again.hits !== again.units.length) detail.push(`    内存缓存第二遍应该全 hit，实得 ${again.hits}/${again.units.length}`);
  if (detail.length > 0) bad('unit-is-real-output', detail.join('\n'));
  else ok(`unit-is-real-output [${res.units.length} 段产物逐段出现在整模块产物里；内存缓存全命中]`);
}

// ------------------------------------------------- 6. 编译器自己：一次全 miss，一次全 hit

{
  const cacheSelf = join(dir, 'cache-self');
  const c1 = incr(join(root, 'stage0', 'src', 'cli.js'), cacheSelf);
  const c2 = incr(join(root, 'stage0', 'src', 'cli.js'), cacheSelf);
  if (c1.miss !== c1.units || c2.hit !== c2.units) {
    bad('self', `    编译器自己：第一遍 miss=${c1.miss}/${c1.units}，第二遍 hit=${c2.hit}/${c2.units}`);
  } else {
    ok(`self [${c1.units} 个函数：冷全 miss，热全 hit]`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n`);
  process.exitCode = 1;
}
