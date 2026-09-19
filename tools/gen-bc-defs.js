// tools/gen-bc-defs.js —— 从 `src/core/lua/bc.js` 那张表生成 C 侧的定义
//
// **为什么要生成**：opcode 的编号与操作数宽度在两边各写一份，早晚会漂，
// 而漂了的表现是"解释器读错操作数"——静默的错答案。生成就没有这回事。
// 用法：node tools/gen-bc-defs.js > src/core/lua/bc-defs.h

import { OPS, OPW, opLen } from '../src/core/lua/bc.js';

const lines = [];
lines.push('/* 本文件由 tools/gen-bc-defs.js 从 src/core/lua/bc.js 生成 —— 不要手改 */');
lines.push('#ifndef OMNI_LUA_BC_DEFS_H');
lines.push('#define OMNI_LUA_BC_DEFS_H');
lines.push('');
lines.push('typedef enum {');
for (let i = 0; i < OPS.length; i++) lines.push(`    OP_${OPS[i][0]} = ${i},`);
lines.push(`    OP__COUNT = ${OPS.length}`);
lines.push('} OmniOp;');
lines.push('');
lines.push('/* 每条指令的总长度（含 opcode 那一字节） */');
lines.push('static const unsigned char omni_op_len[OP__COUNT] = {');
lines.push('    ' + OPS.map((_, i) => opLen(i)).join(', '));
lines.push('};');
lines.push('');
lines.push('/* 操作数签名（调试与反汇编用） */');
lines.push('static const char *const omni_op_sig[OP__COUNT] = {');
lines.push('    ' + OPS.map(([, sig]) => JSON.stringify(sig)).join(', '));
lines.push('};');
lines.push('');
lines.push('static const char *const omni_op_name[OP__COUNT] = {');
lines.push('    ' + OPS.map(([n]) => JSON.stringify(n)).join(', '));
lines.push('};');
lines.push('');
lines.push('#endif /* OMNI_LUA_BC_DEFS_H */');
console.log(lines.join('\n'));
