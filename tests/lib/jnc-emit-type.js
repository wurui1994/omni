// tests/lib/jnc-emit-type.js —— 类型三栏表的对账：**拿旧降级的真输出当外部尺**
//
// 期望不是我编的：这把尺子写一份小小的 jancy 源码，让**旧降级**（`omni emit sx`）发一遍，
// 从它的输出里抠出两个位置的真写法 ——
//   字段位置   `(struct S (m_a int) (m_arr (blk int 4)) …)`
//   存储位置   `(fn f ((s (ptr S)) (p (ptr P)) (a (ptr (blk int 3)))) void …)`
// 再拿 `src/lang/jnc/emit-type.js` 那张三栏表照同样的类型算一遍，逐格对。
// 对不上就是表抄错了（旧降级那三个函数在 `frontend-jnc/lower.js:832-879`）。
//
// 用法：node tests/lib/jnc-emit-type.js [--all]

import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { emitType } from '../../src/lang/jnc/emit-type.js';

const all = process.argv.includes('--all');

const SRC = `struct P {
\tint m_x;
}

enum E { A, B }

struct S {
\tint m_a;
\tint m_arr[4];
\tchar const* m_p;
\tP m_p2;
\tE m_e;
\tbool m_b;
\tdouble m_d;
\tint function* m_fn(int);
}

void f(
\tS* s,
\tP p,
\tint a[3]
) {
}

int main() {
\treturn 0;
}
`;

/** 手写的类型对象（与源码里那几格一一对应）。表要算的就是它们。 */
const T_INT = { k: 'int' };
const FIELD_CASES = [
  ['m_a', T_INT],
  ['m_arr', { k: 'arr', el: T_INT, n: 4 }],
  ['m_p', { k: 'ptr', target: T_INT }],
  ['m_p2', { k: 'struct', name: 'P' }],
  ['m_e', { k: 'enum', name: 'E' }],
  ['m_b', { k: 'bool' }],
  ['m_d', { k: 'real' }],
  ['m_fn', { k: 'fnptr', params: [T_INT], ret: T_INT }],
];
const SLOT_CASES = [
  ['s', { k: 'ptr', target: { k: 'struct', name: 'S' } }],
  ['p', { k: 'struct', name: 'P' }],
  ['a', { k: 'arr', el: T_INT, n: 3 }],
];

const dir = mkdtempSync(join(tmpdir(), 'jnc-emit-type-'));
const file = join(dir, 'ty.jnc');
writeFileSync(file, SRC);
let out = '';
try {
  out = execFileSync('node', ['src/cli.js', 'emit', 'sx', file], { encoding: 'utf8' });
} catch (err) {
  console.log(`旧降级发不出来（这把尺子就没法对）：${err.message}`);
  process.exitCode = 1;
  out = '';
}

/** 从 `(struct S (名字 类型) …)` 里抠出那一格的类型文本（括号配平地切）。 */
function fieldOf(text, struct, name) {
  const at = text.indexOf(`(struct ${struct} `);
  if (at < 0) return null;
  const line = text.slice(at, text.indexOf('\n', at));
  const key = `(${name} `;
  const i = line.indexOf(key);
  if (i < 0) return null;
  return balanced(line, i + key.length);
}

/** 从 `(fn f ((名字 类型) …) …` 里抠出形参那一格的类型文本。 */
function paramOf(text, fn, name) {
  const at = text.indexOf(`(fn ${fn} (`);
  if (at < 0) return null;
  const line = text.slice(at, text.indexOf('\n', at));
  const key = `(${name} `;
  const i = line.indexOf(key);
  if (i < 0) return null;
  return balanced(line, i + key.length);
}

/** 从 `from` 起取一格 s-表达式（括号配平；没有括号就取到下一个 `)` 或空格）。 */
function balanced(s, from) {
  if (s[from] !== '(') {
    let j = from;
    while (j < s.length && s[j] !== ')' && s[j] !== ' ') j += 1;
    return s.slice(from, j);
  }
  let depth = 0;
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === '(') depth += 1;
    else if (s[j] === ')') {
      depth -= 1;
      if (depth === 0) return s.slice(from, j + 1);
    }
  }
  return null;
}

const rows = [];
for (const [name, ty] of FIELD_CASES) rows.push(['字段', name, fieldOf(out, 'S', name), emitType(ty, 'field')]);
for (const [name, ty] of SLOT_CASES) rows.push(['存储', name, paramOf(out, 'f', name), emitType(ty, 'slot')]);

const bad = rows.filter(([, , want, got]) => want === null || want !== got);
console.log(`三栏表对账：${rows.length} 格　对上 ${rows.length - bad.length}　对不上 ${bad.length}`);
for (const [pos, name, want, got] of (all ? rows : bad)) {
  console.log(`  ${want === got ? 'ok  ' : '×   '}${pos} ${name}：旧降级 ${want} / 表 ${got}`);
}
process.exitCode = bad.length === 0 ? 0 : 1;
