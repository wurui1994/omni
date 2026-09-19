// bench/lua/regress.js —— **VM 腿的判据**：suite 里每个 .lua 都拿 luajit 的输出当尺子，逐字节比
//
// 为什么放进仓库（原来在 /tmp）：这是唯一的正确性判据，每次动 emit-bc/vm.c/jit-a64.c 都要跑。
// 它**每次重新发射字节码** —— 很重要：加/插一条字节码会改 opcode 编号，旧的 .olbc 全部作废
// （拿旧文件跑会看见乱码/ASAN 报错，像真 bug，其实只是过期产物）。
//
// 用法：node bench/lua/regress.js [名字过滤]
//   OMNI_VM=/path/to/omni-vm   指定要测的二进制（默认现造一份）
//   OMNI_NO_FUSE=1             关掉 GetFields 合并（做 A/B 用）

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { compile, serialize } from '../../src/core/lua/emit-bc.js';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const WORK = '/tmp/omni-lua-vm';
mkdirSync(WORK, { recursive: true });

/** 现造一份 VM（除非 OMNI_VM 指了） */
function theVm() {
  if (process.env.OMNI_VM) return process.env.OMNI_VM;
  execSync(`node ${ROOT}/tools/gen-bc-defs.js > ${ROOT}/src/core/lua/bc-defs.h`);
  execSync(`clang -O2 -o ${WORK}/omni-vm ${ROOT}/src/core/lua/vm.c -lm`);
  return `${WORK}/omni-vm`;
}

function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = `${d}/${e}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.lua')) out.push(p);
  }
  return out;
}

const filter = process.argv[2];
const vm = theVm();
const files = walk(`${ROOT}/bench/ir/suite`).sort()
  .filter(f => filter === undefined || f.includes(filter));
const { tb, g } = loadGrammarTable(`${ROOT}/ext/lua/lua.grammar`);

let pass = 0;
const fail = [];
for (const f of files) {
  const name = f.slice(`${ROOT}/bench/ir/suite/`.length);
  let ours, ref;
  try {
    const diags = new Diagnostics();
    const src = readFileSync(f, 'utf8');
    const tree = glrParse(tb, lexText(g.lex, new SourceFile(f, src), diags), { diags });
    const blob = `${WORK}/regress.olbc`;
    writeFileSync(blob, serialize(compile(tree)));
    ours = execFileSync(vm, [blob], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    fail.push(name);
    console.log(`✗ ${name}  ours 挂了: ${String(e.message).split('\n')[0].slice(0, 70)}`);
    continue;
  }
  try {
    ref = execFileSync('luajit', [f], { encoding: 'utf8', timeout: 180000 });
  } catch {
    console.log(`? ${name}  luajit 挂了（跳过）`);
    continue;
  }
  if (ours === ref) { pass++; console.log(`✓ ${name}`); }
  else {
    fail.push(name);
    console.log(`✗ ${name}\n    ours=${JSON.stringify(ours.slice(0, 90))}\n    ref =${JSON.stringify(ref.slice(0, 90))}`);
  }
}
console.log(`\n${pass}/${files.length} 通过`);
if (fail.length) process.exitCode = 1;
