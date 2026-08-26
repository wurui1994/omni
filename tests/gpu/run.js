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
//   2. **降不了的必须报错**：没有 kernel 的模块、kernel 里有循环/整数除法/局部缓冲/
//      定不下元素类型的形参 —— 一律 `spirv 后端目前不支持`（bad/ 与 NO_KERNEL）。
//   3. **形状快照**：描述符布局、push constant 偏移、merge 块的接法都在这份文本里，
//      改了就该有人看见。
//   4. **设备比对**：还没有 —— 见文件末尾那条 skip，它说清了缺的是什么。
//
//   node tests/gpu/run.js
//   node tests/gpu/run.js --update      # 重写快照
//
// 工具不在环境里时整条轴 skip 而不是 fail：`spirv-as` / `spirv-val` 是 SPIRV-Tools
// 里的东西，不该成为 `npm test` 的硬依赖。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KERNELS, NO_KERNEL } from './kernels.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const cli = join(root, 'stage0', 'src', 'cli.js');
const update = process.argv.includes('--update');
const dir = mkdtempSync(join(tmpdir(), 'omni-gpu-'));

const NOPE = 'spirv 后端目前不支持';

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const ok = (msg) => { pass++; process.stdout.write(`  ok   ${msg}\n`); };
const no = (name, why) => { fail++; failures.push(`${name}\n${why}`); process.stdout.write(`  FAIL ${name}\n`); };
const skip = (msg) => { skipped++; process.stdout.write(`  skip ${msg}\n`); };

const cmd = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', code: r.status ?? 1 };
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

// ------------------------------------------------- 4. 设备比对（还没有）
//
// 门槛 7 的前半句要的是「与同一份 MIR 在 CPU 上的结果一致」。要真跑一遍，缺的是一个
// 宿主：建 instance/device、按描述符集绑三个 StorageBuffer、灌 push constant、
// vkCmdDispatch、把结果读回来和 `interp` 的输出比。那是一份独立的 C 程序（决策 4 的
// C_ABI 正好能接），不是这条轴的一行 —— 所以这里明说缺什么，而不是假装比过了。

skip('device/saxpy [没有 Vulkan 宿主：绑描述符 + dispatch + 读回比对留在第二阶段]');

process.stdout.write(`\n${pass} passed, ${fail} failed, ${skipped} skipped\n`);
if (fail) {
  process.stdout.write(`\n${failures.join('\n\n')}\n\n(kept in ${dir})\n`);
  process.exitCode = 1;
}
