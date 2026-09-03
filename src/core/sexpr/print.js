// Omni stage0 — S 表达式写出器
//
// 存在的理由是**往回比**：读取器读进来的树写回文本，再读一遍，两棵树必须一样
// （tests/sexpr 的往返轴）。这条比"读取器不崩"强得多 —— 它同时钉住了词法的两端。
//
// 排版规矩刻意简单，因为它不是给人读的格式化器：短列表压一行，长列表每项一行。
// 真要漂亮的 WAT 排版是另一件事，等到有人要看生成的 wat 时再说。

/** atom 的文本原样就能写回去；字符串要按 WAT 的转义再包起来 */
function quote(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += `\\${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + '"';
}

function oneLine(n) {
  if (n.kind === 'atom') return n.value;
  if (n.kind === 'string') return quote(n.value);
  return `(${n.items.map(oneLine).join(' ')})`;
}

const WIDTH = 96;

function write(n, indent, out) {
  const flat = oneLine(n);
  if (indent.length + flat.length <= WIDTH || n.kind !== 'list' || n.items.length === 0) {
    out.push(indent + flat);
    return;
  }
  // 头部留在开括号那行（`(func $f` 而不是光一个 `(`）—— WAT 惯例，也好读
  const inner = indent + '  ';
  const first = n.items[0];
  if (first.kind === 'atom') {
    out.push(`${indent}(${first.value}`);
    for (const it of n.items.slice(1)) write(it, inner, out);
  } else {
    out.push(`${indent}(`);
    for (const it of n.items) write(it, inner, out);
  }
  out[out.length - 1] += ')';
}

/** 一串顶层节点 -> 文本（末尾带换行） */
export function printSexpr(nodes) {
  const out = [];
  for (const n of nodes) write(n, '', out);
  return out.length === 0 ? '' : out.join('\n') + '\n';
}
