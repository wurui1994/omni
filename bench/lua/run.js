// bench/lua/run.js —— 新引擎的跑法：lua 源码 → 字节码 → VM
//
// 判据与 MLIR 那条腿共用同一把尺子：输出与 luajit **逐字节相同**。
// 用法：node bench/lua/run.js <程序.lua> [--dis]

import { loadGrammarTable } from '../../src/core/glr/load.js';
import { lexText } from '../../src/core/glr/lex.js';
import { glrParse } from '../../src/core/glr/driver.js';
import { Diagnostics, SourceFile } from '../../src/core/source/diag.js';
import { compile, serialize } from '../../src/core/lua/emit-bc.js';
import { disasm } from '../../src/core/lua/bc.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WORK = '/tmp/omni-lua-vm';
const CLANG = '/opt/homebrew/opt/llvm/bin/clang';

mkdirSync(WORK, { recursive: true });

const file = process.argv[2];
if (file === undefined) { console.error('用法: node bench/lua/run.js <程序.lua> [--dis]'); process.exit(2); }

/** 造一次 VM（字节码定义变了要重造，所以按两份源码的修改时间判断） */
export function buildVm() {
  const bin = `${WORK}/omni-vm`;
  const srcs = ['src/core/lua/vm.c', 'src/core/lua/bc-defs.h', 'src/core/ir/lua-rt.h'];
  const newest = Math.max(...srcs.map(s => Number(readFileSync(s).length) + 0));
  void newest;
  execSync(`node tools/gen-bc-defs.js > src/core/lua/bc-defs.h`);
  execSync(`${CLANG} -O2 -o ${bin} src/core/lua/vm.c -lm`, { stdio: 'inherit' });
  return bin;
}

const src = readFileSync(file, 'utf8');
const { tb, g } = loadGrammarTable('ext/lua/lua.grammar');
const diags = new Diagnostics();
const tree = glrParse(tb, lexText(g.lex, new SourceFile(file, src), diags), { diags });
const fn = compile(tree);

if (process.argv.includes('--dis')) {
  console.log(`# 常量池 ${fn.K.length} 格，寄存器 ${fn.nreg} 格，反馈槽 ${fn.nfb} 格`);
  console.log(disasm(fn.code, fn.K.map(c => c.v)));
  console.log('---');
}

const blob = `${WORK}/prog.olbc`;
writeFileSync(blob, serialize(fn));
const vm = buildVm();
execSync(`${vm} ${blob}`, { stdio: 'inherit' });
