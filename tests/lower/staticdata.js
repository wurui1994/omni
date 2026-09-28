#!/usr/bin/env node
// tests/lower/staticdata.js —— **标准 IR 能不能表达"一张编译期就定下来的表"**
//
// 这一格判的是公共降级器新加的那三格（`src/core/lower/sx.js` 的 `memory` / `data` /
// `mload`）：从前标准 IR 这一层压根没有它们，于是借来的那几门语言里"一张几万格的常量表"
// 只能落成 `anew` + 一格一条 `aset`（`ext/python/adapter/expr.js` 的列表字面量）——
// 写在函数体里就是**每次调用重建一遍**，几万格根本走不通。
//
// 判据形状：直接拿标准 IR 造一棵模块（不经任何语言的 adapter —— 这一层的账要单独判），
// 降成 `.sx`，再 `omni run` 一趟，输出与手算的期望逐行相同。**四条腿都跑**：
// 解释器 / JS / C 三条各有一份 data 段的实现（ArrayBuffer / `$lin_data` /
// `static const unsigned char` + `omni_lin_data`），一条腿漏了这一格就红在这儿。
//
//   node tests/lower/staticdata.js

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lower } from '../../src/core/lower/lower.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'src', 'core', 'cli.js');

let pass = 0;
let fail = 0;
const ok = (s) => { pass++; process.stdout.write(`  ok   ${s}\n`); };
const bad = (s, why) => { fail++; process.stdout.write(`  FAIL ${s}\n       ${why}\n`); };

/* 一张 256 格的表，值到 65535 —— 按 `i16u` 摆（一格两字节，小端）。
   基址从第 1 页起（第 0 页按 `tests/sexpr/cases/36-memory.sx` 那条约定不用）。 */
const BASE = 65536;
const N = 256;
const tbl = [];
for (let i = 0; i < N; i++) tbl.push((i * 257) & 0xffff);
const bytes = [];
for (const v of tbl) { bytes.push(v & 0xff); bytes.push((v >> 8) & 0xff); }

const memKind = (name) => ({ kind: 'mem-kind', name });
const int = (value) => ({ kind: 'int', value });
/* 第 i 格的地址：BASE + i * 2。 */
const addrOf = (idx) => ({
  kind: 'binop',
  op: '+',
  left: int(BASE),
  right: { kind: 'binop', op: '*', left: idx, right: int(2) },
});

const module_ = {
  kind: 'module',
  decls: [
    { kind: 'memory', min: 2, max: 2 },
    { kind: 'data', off: BASE, bytes },
    {
      kind: 'main',
      body: [
        { kind: 'let', name: 'i', type: { kind: 'int' }, init: int(0) },
        { kind: 'let', name: 'sum', type: { kind: 'int' }, init: int(0) },
        {
          kind: 'while',
          cond: { kind: 'binop', op: '<', left: { kind: 'name', name: 'i' }, right: int(N) },
          body: [
            {
              kind: 'assign',
              target: { kind: 'name', name: 'sum' },
              value: {
                kind: 'binop',
                op: '+',
                left: { kind: 'name', name: 'sum' },
                right: {
                  kind: 'builtin',
                  name: 'mload',
                  args: [memKind('i16u'), addrOf({ kind: 'name', name: 'i' })],
                },
              },
            },
            {
              kind: 'assign',
              target: { kind: 'name', name: 'i' },
              value: { kind: 'binop', op: '+', left: { kind: 'name', name: 'i' }, right: int(1) },
            },
          ],
        },
        {
          kind: 'print',
          value: {
            kind: 'builtin',
            name: 'mload',
            args: [memKind('i16u'), addrOf(int(7))],
          },
        },
        { kind: 'print', value: { kind: 'name', name: 'sum' } },
      ],
    },
  ],
};

let text = null;
try {
  text = lower(module_, {});
  ok(`lower：标准 IR -> .sx（${text.length} 字节，含 (memory 2 2) 与 ${bytes.length} 字节 data）`);
} catch (e) {
  bad('lower：标准 IR -> .sx', e.message);
}

if (text !== null) {
  for (const need of ['(memory 2 2)', `(data ${BASE} `, '(mload i16u']) {
    if (text.includes(need)) ok(`发出来的 .sx 里有 \`${need}\``);
    else bad(`发出来的 .sx 里该有 \`${need}\``, text.slice(0, 200));
  }

  const dir = mkdtempSync(join(tmpdir(), 'omni-staticdata-'));
  const file = join(dir, 'staticdata.sx');
  writeFileSync(file, text);
  const want = `${tbl[7]}\n${tbl.reduce((a, b) => a + b, 0)}\n`;
  /* 三条腿：`run`（解释器）/ `run --backend js` / `build` 出来的原生程序。 */
  const legs = [
    ['interp', [CLI, 'run', file]],
    ['js', [CLI, 'run', file, '--backend', 'js']],
  ];
  for (const [leg, args] of legs) {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) { bad(`${leg} 腿跑不起来`, `rc=${r.status} ${(r.stderr ?? '').slice(0, 300)}`); continue; }
    if (r.stdout !== want) { bad(`${leg} 腿答得不对`, `要 ${JSON.stringify(want)}，得到 ${JSON.stringify(r.stdout)}`); continue; }
    ok(`${leg} 腿：表里第 7 格与 256 格的和都对`);
  }
  const exe = join(dir, 'staticdata');
  const rb = spawnSync(process.execPath, [CLI, 'build', file, '-o', exe], { encoding: 'utf8', timeout: 300000 });
  if (rb.status !== 0) bad('c 腿编不出来', `rc=${rb.status} ${(rb.stderr ?? '').slice(0, 300)}`);
  else {
    const rr = spawnSync(exe, [], { encoding: 'utf8', timeout: 120000 });
    if (rr.stdout !== want) bad('c 腿答得不对', `要 ${JSON.stringify(want)}，得到 ${JSON.stringify(rr.stdout)}`);
    else ok('c 腿：表里第 7 格与 256 格的和都对');
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
