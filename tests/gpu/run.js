#!/usr/bin/env node
// Omni — SPIR-V / GPU（第十五条测试轴，ADR-0014 门槛 7 的另一半）
//
// 门槛 7 的原文是两句话：「**CPU**：缓冲与 kernel/dispatch 在六条腿上逐字节相同」，
// 已经由 tests/sexpr 的 04-buffers 钉住；「**GPU**：`kernel` 的 SPIR-V 输出与同一份
// MIR 在 CPU 上的结果一致；无 GPU 时至少过官方 validator」——这条轴管后半句。
//
// 四件事：
//   1. **发得出来且合法**：清单里的每个 kernel 经 `spirv-as --target-env vulkan1.1`
//      汇编、`spirv-val` 校验。用官方工具而不是自己检查，理由和「发汇编文本而不是
//      二进制字」是同一条：字对不对由它们说，我们只负责降级。
//   2. **降不了的必须报错**：没有 kernel 的模块、kernel 里有循环/整数除法（有符号的
//      `/` `%` 与无符号的 `u/` `u%` 各一条 —— 理由不同，前者还多一格 INT64_MIN/-1）/
//      局部缓冲/定不下元素类型的形参 —— 一律 `spirv 后端目前不支持`（bad/ 与 NO_KERNEL）。
//   3. **形状快照**：描述符布局、push constant 偏移、merge 块的接法都在这份文本里，
//      改了就该有人看见。
//   4. **设备比对**：cases/ 里的 case 在 dispatch 前后各印一遍整个缓冲，于是一份源同时
//      给出「设备该拿什么当输入」和「设备该算出什么」；宿主 src/gpu/omni_vk.c 把同一个
//      kernel 在真设备上跑一遍，两边按数值比。设备缺特性时 skip，理由是宿主量出来的。
//
//   node tests/gpu/run.js
//   node tests/gpu/run.js --update      # 重写快照
//
// 工具不在环境里时整条轴 skip 而不是 fail：`spirv-as` / `spirv-val` 是 SPIRV-Tools
// 里的东西，不该成为 `npm test` 的硬依赖。

import { spawnSync } from 'node:child_process';
import { mixedRunner } from '../lib/incr.js';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { workDir } from '../work.js';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KERNELS, NO_KERNEL, DEVICE } from './kernels.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'src', 'core', 'cli.js');
const { cache, run: mixedRun } = mixedRunner('gpu');
const update = process.argv.includes('--update');
const dir = workDir('gpu');

const NOPE = 'spirv 后端目前不支持';

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const skip = (msg) => { skipped++; process.stdout.write(`  skip ${msg}\n`); };

/* node 那几次走 RunCache（只记依赖、不缓存，ADR-0023 的 S7）：轴级指纹要"这一趟装了哪些
   模块"这一份；`which` / 驱动那些外部命令照旧原样跑。 */
const cmd = (bin, args) => {
  const r = mixedRun(bin, args);
  return { out: r.out, err: r.err, code: r.code };
};
const omni = (args) => cmd(process.execPath, [cli, ...args]);
const has = (bin) => cmd('which', [bin]).code === 0;
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const tools = has('spirv-as') && has('spirv-val');

// ------------------------------------------------- 1. 发得出来，而且官方工具认

for (const entry of KERNELS) {
  const src = join(root, entry.src);
  for (const k of entry.kernels) {
    const label = `${basename(entry.src)}:${k}`;
    const r = omni(['emit-spirv', src, '--kernel', k]);
    if (r.code !== 0) { no(`emit/${label}`, `    emit-spirv exit=${r.code}\n${r.err}`); continue; }
    const asmPath = join(dir, `${basename(entry.src, '.sx')}-${k}.spvasm`);
    writeFileSync(asmPath, r.out);
    if (!tools) { skip(`validate/${label} [没有 spirv-as / spirv-val]`); continue; }
    const spv = `${asmPath.slice(0, -7)}.spv`;
    const as = cmd('spirv-as', ['--target-env', 'vulkan1.1', asmPath, '-o', spv]);
    if (as.code !== 0) { no(`assemble/${label}`, `    spirv-as 拒了这份汇编\n${as.err}`); continue; }
    const val = cmd('spirv-val', ['--target-env', 'vulkan1.1', spv]);
    if (val.code !== 0) { no(`validate/${label}`, `    spirv-val 不认这份模块\n${val.err}`); continue; }
    ok(`validate/${label} [spirv-as + spirv-val, vulkan1.1] ${r.out.split('\n').length - 1} 行`);
  }
}

// ------------------------------------------------- 2. 边界：降不了的要报错

for (const rel of NO_KERNEL) {
  const r = omni(['emit-spirv', join(root, rel)]);
  const name = `boundary/${basename(rel)}`;
  if (r.code === 0) { no(name, '    居然发出来了 —— 这份源文件里没有 kernel'); continue; }
  if (!r.err.includes(NOPE)) { no(name, `    报错的理由不对：${JSON.stringify(r.err.slice(0, 160))}`); continue; }
  ok(`${name} [没有 kernel，明确拒绝]`);
}

for (const f of readdirSync(join(here, 'bad')).filter((x) => x.endsWith('.sx')).sort()) {
  const name = basename(f, '.sx');
  const exp = read(join(here, 'bad', `${name}.expected`));
  const r = omni(['emit-spirv', join(here, 'bad', f)]);
  if (exp === null) { no(`bad/${name}`, `    缺 ${name}.expected`); continue; }
  if (r.code === 0) { no(`bad/${name}`, '    居然发出来了 —— 这条边界是刻意划的'); continue; }
  if (!r.err.includes(NOPE) || !r.err.includes(exp.trim())) {
    no(`bad/${name}`, `    拒的理由不对\n      want: ${JSON.stringify(exp.trim())}\n      got:  ${JSON.stringify(r.err.split('\n')[0])}`);
    continue;
  }
  ok(`bad/${name} [拒绝：${exp.trim()}]`);
  // 这些 case 在 CPU 那几条腿上必须照跑 —— 边界是这一层的，不是语言的
  const cpu = omni(['run', join(here, 'bad', f)]);
  if (cpu.code !== 0) no(`bad/${name}/cpu`, `    CPU 那条腿也跑不了（exit=${cpu.code}）：\n${cpu.err}`);
  else ok(`bad/${name}/cpu [同一份源在 CPU 上照跑]`);
}

// ------------------------------------------------- 3. 形状快照

const snapDir = join(here, 'snapshots');
const snapPath = join(snapDir, '04-buffers-saxpy.spvasm');
const snapSrc = join(root, 'tests', 'sexpr', 'cases', '04-buffers.sx');
const got = omni(['emit-spirv', snapSrc, '--kernel', 'saxpy']);
if (got.code !== 0) {
  no('snapshot/saxpy', `    emit-spirv exit=${got.code}\n${got.err}`);
} else if (update) {
  if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
  writeFileSync(snapPath, got.out);
  ok(`snapshot/saxpy [written] ${got.out.split('\n').length - 1} 行`);
} else {
  const want = read(snapPath);
  if (want === null) no('snapshot/saxpy', `    缺快照 ${snapPath}（用 --update 生成）`);
  else if (want === got.out) ok(`snapshot/saxpy [== snapshots/04-buffers-saxpy.spvasm] ${got.out.split('\n').length - 1} 行`);
  else {
    const wl = want.split('\n');
    const gl = got.out.split('\n');
    let i = 0;
    while (i < wl.length && i < gl.length && wl[i] === gl[i]) i++;
    no('snapshot/saxpy', `    第 ${i + 1} 行起不同\n    want: ${JSON.stringify(wl[i])}\n    got:  ${JSON.stringify(gl[i])}`);
  }
}

// ------------------------------------------------- 4. 设备比对
//
// 门槛 7 的前半句：「`kernel` 的 SPIR-V 输出与同一份 MIR 在 CPU 上的结果一致」。
// 一份 case 同时给出输入与 CPU 答案（dispatch 前后各印一遍整个缓冲），宿主
// src/gpu/omni_vk.c 把同一个 kernel 在真设备上跑一遍，两边按数值比。
//
// 三处会 skip 而不是 fail，每处的理由都是**量出来的**，不是"大概不行"：
//   - 没有 clang / 没有 vulkan 的 pkg-config：这台机器上没法建宿主。
//   - 没有设备（宿主退 3）。
//   - 设备缺特性（宿主退 3）—— Apple 的 Metal 没有双精度，所以 02-saxpy 在这里必然 skip。
//     那是平台的事实：`OpCapability Float64` 是模块自己说的，宿主读出来再问设备。

const vkHost = buildVkHost();

for (const d of DEVICE) {
  const label = `device/${basename(d.src)}:${d.kernel}`;
  const src = join(root, d.src);
  const cells = d.bufs.reduce((n, b) => n + b.cells.length, 0);
  // CPU 侧：先确认这份 case 本身没漂（对得上 .expected），再切成 before / after 两半
  const cpu = omni(['interp', src]);
  if (cpu.code !== 0) { no(label, `    interp exit=${cpu.code}\n${cpu.err}`); continue; }
  const want = read(`${src.slice(0, -3)}.expected`);
  if (want !== null && want !== cpu.out) { no(label, '    CPU 输出与 .expected 不同 —— 先修那条'); continue; }
  const lines = cpu.out.split('\n').filter((x) => x !== '');
  if (lines.length !== cells * 2) {
    no(label, `    这份 case 该印 ${cells * 2} 行（前后各 ${cells} 个格），实际 ${lines.length} 行`);
    continue;
  }
  // DEVICE 表里的初值必须与 case 印出来的前一半相同 —— 表不会悄悄和 case 走散
  const before = [];
  for (const b of d.bufs) for (const c of b.cells) before.push(c);
  const drift = before.findIndex((v, i) => Number(v) !== Number(lines[i]));
  if (drift >= 0) {
    no(label, `    DEVICE 表的初值第 ${drift + 1} 个与 case 印的不同：`
      + `表 ${JSON.stringify(before[drift])}，case ${JSON.stringify(lines[drift])}`);
    continue;
  }
  if (vkHost === null) { skip(`${label} [建不出 Vulkan 宿主：缺 clang 或 vulkan 的 pkg-config]`); continue; }
  if (!tools) { skip(`${label} [没有 spirv-as]`); continue; }

  const asmR = omni(['emit-spirv', src, '--kernel', d.kernel]);
  if (asmR.code !== 0) { no(label, `    emit-spirv exit=${asmR.code}\n${asmR.err}`); continue; }
  const asmPath = join(dir, `dev-${basename(d.src, '.sx')}-${d.kernel}.spvasm`);
  const spv = `${asmPath.slice(0, -7)}.spv`;
  writeFileSync(asmPath, asmR.out);
  const as = cmd('spirv-as', ['--target-env', 'vulkan1.1', asmPath, '-o', spv]);
  if (as.code !== 0) { no(label, `    spirv-as 拒了这份汇编\n${as.err}`); continue; }

  const args = [spv, `k_${d.kernel}`, '--grid', String(d.grid)];
  for (const b of d.bufs) args.push('--buf', `${b.type}:${b.cells.join(',')}`);
  for (const p of d.push) args.push('--push', p);
  const dev = cmd(vkHost, args);
  if (dev.code === 3) { skip(`${label} [设备跑不了：${dev.err.trim().split('\n').pop()}]`); continue; }
  if (dev.code !== 0) { no(label, `    宿主 exit=${dev.code}\n${dev.err}`); continue; }

  // 设备侧：一行一个缓冲，值之间一个空格。按数值比 —— 两边的打印格式本来就不同
  // （Omni 的 print 与 %.17g），要比的是数，不是字符串。
  const got = [];
  for (const line of dev.out.split('\n')) {
    if (line === '') continue;
    for (const v of line.split(' ')) got.push(v);
  }
  const after = lines.slice(cells);
  if (got.length !== after.length) {
    no(label, `    设备印了 ${got.length} 个格，CPU 那边是 ${after.length} 个`);
    continue;
  }
  const bad = got.findIndex((v, i) => Number(v) !== Number(after[i]));
  if (bad >= 0) {
    no(label, `    第 ${bad + 1} 个格不同：CPU ${JSON.stringify(after[bad])}，`
      + `设备 ${JSON.stringify(got[bad])}\n    （宿主说：${dev.err.trim()}）`);
    continue;
  }
  ok(`${label} [设备 == CPU，${got.length} 个格] ${dev.err.trim()}`);
}

/**
 * 建 Vulkan 宿主。头文件与库靠 pkg-config 问 —— 路径不写死在这里，
 * 换台机器（或换个包管理器）不用改代码。建不出来就返回 null，上面记 skip。
 */
function buildVkHost() {
  const cc = process.env.OMNI_CLANG || 'clang';
  if (cmd('which', [cc]).code !== 0) return null;
  const cf = cmd('pkg-config', ['--cflags', 'vulkan']);
  const lf = cmd('pkg-config', ['--libs', 'vulkan']);
  if (cf.code !== 0 || lf.code !== 0) return null;
  const src = join(root, 'src', 'gpu', 'omni_vk.c');
  const exe = join(dir, 'omni_vk');
  const args = ['-O2', '-w', src, ...cf.out.trim().split(/\s+/), ...lf.out.trim().split(/\s+/), '-o', exe];
  const r = cmd(cc, args.filter((x) => x !== ''));
  if (r.code !== 0) { no('device/host', `    宿主编不过：\n${r.err}`); return null; }
  return exe;
}

const rep = cache.report();
process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped${rep === '' ? '' : `  （${rep}）`}\n`);

if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
