// src/core/lua/bc.js —— **字节码那份契约**（照 v8 的 Ignition 定形）
//
// 为什么是寄存器 + 一格累加器：v8 的 `Ldar`/`Star` 就是这个形状（src/interpreter/bytecodes.h）。
// 栈式的话每个算子都要压/弹，字节码条数多一倍；纯寄存器式的话每条指令都要三个操作数。
// 累加器这一格把"上一步的结果"隐含掉，最常见的形状（`a.x * b.x`）因此只发两条。
//
// 三层共用这一份：
//   * Tier 0 解释器（vm.c，computed goto）
//   * Tier 1 基线 JIT（jit-a64.c，一条字节码一段机器码）—— 照 Sparkplug，
//     它不做优化，只把派发开销去掉，**反馈槽号在机器码里是立即数**
//   * 以后的优化层
//
// **操作数只有四类**（也照 Ignition）：
//   r = 寄存器号（u8）      k = 常量池下标（u16）
//   i = 立即数（u8）        f = 反馈槽号（u16）      j = 跳转偏移（i32，相对本指令末尾）
//
// 这张表是**唯一的真相**：`tools/gen-bc-defs.js` 从它生成 C 那边的 opcode 枚举与宽度表，
// 所以两边不会漂。加一条指令只改这儿。

/** 操作数类型 → 字节宽度 */
export const OPW = { r: 1, k: 2, i: 1, f: 2, j: 4 };

/**
 * 指令表：`[名字, 操作数串, 说明]`
 * 顺序就是 opcode 编号（0 起），**只许往后加，不许插队**（生成的 C 头要对得上）。
 */
export const OPS = [
  // ---- 取值 / 存值 ----
  ['LdaNil',    '',     'acc = nil'],
  ['LdaTrue',   '',     'acc = true'],
  ['LdaFalse',  '',     'acc = false'],
  ['LdaK',      'k',    'acc = K[k]（数 / 串）'],
  ['LdaR',      'r',    'acc = r'],
  ['StaR',      'r',    'r = acc'],
  ['Mov',       'rr',   'r2 = r1'],
  ['LdaGlobal', 'kf',   'acc = 全局[K[k]]'],
  ['StaGlobal', 'kf',   '全局[K[k]] = acc'],
  ['LdaUp',     'i',    'acc = 创建者那份 env[i]（闭包捕获的）'],
  ['StaUp',     'i',    '创建者那份 env[i] = acc'],
  ['LdaEnv',    'i',    'acc = 本帧 env[i]（自己被内层捕获的局部量）'],
  ['StaEnv',    'i',    '本帧 env[i] = acc'],

  // ---- 算术与比较（acc 是右操作数，寄存器是左操作数；f 记类型反馈）----
  ['Add',       'rf',   'acc = r + acc'],
  ['Sub',       'rf',   'acc = r - acc'],
  ['Mul',       'rf',   'acc = r * acc'],
  ['Div',       'rf',   'acc = r / acc'],
  ['Mod',       'rf',   'acc = r % acc'],
  ['Pow',       'rf',   'acc = r ^ acc'],
  ['Concat',    'rf',   'acc = r .. acc'],
  ['Neg',       'f',    'acc = -acc'],
  ['Not',       '',     'acc = not acc'],
  ['Len',       'f',    'acc = #acc'],
  ['Eq',        'rf',   'acc = (r == acc)'],
  ['Ne',        'rf',   'acc = (r ~= acc)'],
  ['Lt',        'rf',   'acc = (r < acc)'],
  ['Le',        'rf',   'acc = (r <= acc)'],
  ['Gt',        'rf',   'acc = (r > acc)'],
  ['Ge',        'rf',   'acc = (r >= acc)'],

  // ---- 表 ----
  ['NewTable',  'i',    'acc = {}（i 是数组部分的预估大小）'],
  ['NewShaped', 'kiif', 'acc = 按 K[k..k+n-1] 那 n 个串键造表（n = 第二个 i），字段值取 r(i1)..；形状缓存在反馈槽 f'],
  ['GetNamed',  'rkf',  'acc = r[K[k]]（串键，走内联缓存）'],
  ['SetNamed',  'rkf',  'r[K[k]] = acc'],
  ['GetKeyed',  'rrf',  'acc = r1[r2]'],
  ['SetKeyed',  'rrf',  'r1[r2] = acc'],
  ['SetMeta',   'r',    'setmetatable(r, acc)；acc = r'],

  // ---- 调用 ----
  ['Call',      'rif',  'acc = r(r+1 … r+i)'],
  ['CallMethod','rkif', 'acc = r:K[k](r+1 … r+i)'],
  ['CallBuiltin','rii', 'acc = 内建[i1](r … r+i2-1)'],
  ['Ret',       '',     'return acc'],
  ['RetMulti',  'ri',   'return r … r+i-1（第二格起走边槽）'],

  // ---- 控制流 ----
  ['Jump',        'j',  'pc += j'],
  ['JumpIfTrue',  'j',  'acc 为真 ⇒ pc += j'],
  ['JumpIfFalse', 'j',  'acc 为假 ⇒ pc += j'],
  ['JumpIfNil',   'j',  'acc 是 nil ⇒ pc += j'],
  ['JumpLoop',    'j',  '回边：pc += j（j < 0），顺手记热度 ⇒ 升层'],
  ['ForPrep',     'rj', '数值 for 的准备：r=初值 r+1=上界 r+2=步长；不进循环就跳'],
  ['ForLoop',     'rj', '数值 for 的一轮：自增 + 判界，继续就跳回'],

  // ---- 函数值 ----
  ['Closure',   'ki',   'acc = 按 K[k] 那份原型造闭包，捕获 i 格 upvalue（取自 r0…）'],

  /* **同一张表的 n 个具名字段一次取完**（守卫只做一遍、形状只查一遍）。
     r = 表，k = 第一个键常量（连号 n 个），i1 = 目标寄存器起点（连号 n 格），
     i2 = n，f = 反馈槽起点（占 n 格）。
     **发这一条的前提是那几个读原本属于同一个表达式** —— Lua 不规定同一表达式里
     子表达式的求值次序，所以把它们提到一块儿是合法的；发射器只在那种位置发它。 */
  ['GetFields', 'rkiif', 'R[i1+j] = r[K[k+j]]，j<i2；一次守卫，n 条 load'],

  // ---- 杂 ----
  ['Print',     'ri',   'print(r … r+i-1)'],
  ['Nop',       '',     ''],
  ['VarargTable','',    'acc = 变长参数打包成表（{...}）'],
];

/** 名字 → opcode */
export const OP = Object.fromEntries(OPS.map(([n], i) => [n, i]));

/** 一条指令的字节长度（含 opcode 那一字节） */
export function opLen(op) {
  const sig = OPS[op][1];
  let n = 1;
  for (const c of sig) n += OPW[c];
  return n;
}

/** 反汇编一段字节码（调试用；出错时能看见发了什么） */
export function disasm(code, K = []) {
  const out = [];
  let pc = 0;
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  while (pc < code.length) {
    const op = code[pc];
    const [name, sig] = OPS[op] ?? ['??', ''];
    let at = pc + 1;
    const args = [];
    for (const c of sig) {
      if (c === 'r') { args.push(`r${code[at]}`); at += 1; }
      else if (c === 'i') { args.push(String(code[at])); at += 1; }
      else if (c === 'k') { const v = dv.getUint16(at, true); args.push(`K${v}${K[v] !== undefined ? `(${JSON.stringify(K[v]).slice(0, 18)})` : ''}`); at += 2; }
      else if (c === 'f') { args.push(`f${dv.getUint16(at, true)}`); at += 2; }
      else if (c === 'j') { args.push(`${dv.getInt32(at, true) >= 0 ? '+' : ''}${dv.getInt32(at, true)}`); at += 4; }
    }
    out.push(`${String(pc).padStart(4)}  ${name.padEnd(11)} ${args.join(' ')}`);
    pc = at;
  }
  return out.join('\n');
}

/** 往字节数组里写指令的小助手（发射器用） */
export class Buf {
  constructor() { this.b = []; }
  get pos() { return this.b.length; }
  u8(v) { this.b.push(v & 0xff); }
  u16(v) { this.b.push(v & 0xff, (v >> 8) & 0xff); }
  i32(v) { this.b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }
  /** 回填一格 i32（跳转的目标是后来才知道的） */
  patchI32(at, v) {
    this.b[at] = v & 0xff; this.b[at + 1] = (v >> 8) & 0xff;
    this.b[at + 2] = (v >> 16) & 0xff; this.b[at + 3] = (v >> 24) & 0xff;
  }
  bytes() { return Uint8Array.from(this.b); }
}
