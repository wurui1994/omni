// tests/bootstrap/dedup.js —— 把一个文件里**只属于它自己**的重名改掉（ADR-0001 那个棘轮的还债工具）
//
// 自编译现在拦在两类错上，第一类是「模块作用域重名」（JS 前端把整棵 import 树链成一份
// 程序，模块作用域的名字在整份程序里必须唯一）。那 200 多条里绝大多数是**两边各写了一份
// 同名小工具**，纯改名就能解。
//
// 这一支只做**能证明安全**的那一部分：
//
//   * 只改**一个文件**里的名字，而且那个名字在**要改的这个文件里没有 export**
//     -> 别的文件引不到它，所以词边界改名不会漏改任何引用
//   * 同一个文件里的局部遮蔽照旧成立：声明与它的引用是**一起**改的
//
// 判据是「**要改的这一边**导没导出」，不是「两边有没有一边导出」。第一版写成了后者，
// 于是 12 条本来能零成本收掉的被跳过了 —— `utf8Bytes` 那种：`host/utf8.js` 导出它，
// 而 `frontend-c/tccgen.js` 里那一份是**局部**的，改后者一处调用方都不用动。
//
// 两边都导出的（`ret`/`genModule`/`writeObject` 那 10 条）不在这一支的范围里：
// 那要改导出名 + 改调用方（连门里的 import 一起），得一处一处看。
//
//   node tests/bootstrap/dedup.js src/core/link/elf_merge.js mg      # 改，然后印结果
//   node tests/bootstrap/dedup.js --list                             # 只印还剩哪些文件对

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const CLI = join(root, 'src', 'core', 'cli.js');

/** 现在还剩哪些重名：回 `[名字, 文件甲, 文件乙]` 的表（用**前端自己**报的，不另写一份规则）。 */
function dupsNow() {
  const r = spawnSync(process.execPath, [CLI, 'emit-js', CLI],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = [];
  const re = /'([^']+)' is declared at module scope in both '([^']+)' and '([^']+)'/;
  for (const l of (r.stderr ?? '').split('\n')) {
    const m = re.exec(l);
    if (m !== null) out.push([m[1], m[2], m[3]]);
  }
  return out;
}

const args = process.argv.slice(2);
const dups = dupsNow();

if (args[0] === '--list' || args.length === 0) {
  const byPair = new Map();
  for (const [, a, b] of dups) {
    const k = `${a.replace(`${root}/`, '')} + ${b.replace(`${root}/`, '')}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  process.stdout.write(`还剩 ${dups.length} 条重名，按文件对：\n`);
  for (const [k, v] of [...byPair].sort((x, y) => y[1] - x[1])) {
    process.stdout.write(`  ${String(v).padStart(4)}  ${k}\n`);
  }
  process.exit(0);
}

const [rel, prefix] = args;
if (prefix === undefined) {
  process.stdout.write('用法：node tests/bootstrap/dedup.js <文件> <前缀>\n');
  process.exit(1);
}
const target = join(root, rel);

const cache = new Map();
const srcOf = (p) => {
  if (!cache.has(p)) cache.set(p, readFileSync(p, 'utf8'));
  return cache.get(p);
};
/** 这个名字在这份源码里是**导出**的吗（`export function f` 或 `export { f }`）。 */
const isExported = (s, name) => new RegExp(`^export\\s+(async\\s+)?(function|const|let|class)\\s+${name}\\b`, 'm').test(s)
  || new RegExp(`^export\\s*\\{[^}]*\\b${name}\\b`, 'm').test(s);

let s = srcOf(target);
const done = [];
let sites = 0;
for (const [name, a, b] of dups) {
  if (a !== target && b !== target) continue;
  /* 判据是**要改的这一边**导没导出。另一边导不导出与这一次改名无关 ——
   * 我们改的是这个文件里的声明与它自己的引用。 */
  if (isExported(s, name)) continue;
  /* UPPER_SNAKE 前面加 `前缀_`（大写），别的加 `前缀` + 首字母大写 —— 读起来还是原来那个词。 */
  const renamed = /^[A-Z0-9_]+$/.test(name)
    ? `${prefix.toUpperCase()}_${name}`
    : `${prefix}${name[0].toUpperCase()}${name.slice(1)}`;
  const re = new RegExp(`\\b${name}\\b`, 'g');
  const m = s.match(re);
  if (m === null) continue;
  sites += m.length;
  s = s.replace(re, renamed);
  done.push(`${name} -> ${renamed}`);
}
if (done.length === 0) {
  process.stdout.write(`${rel}：没有能直接改的重名（要么都导出了，要么已经改完）\n`);
  process.exit(0);
}
writeFileSync(target, s);
const after = dupsNow().length;
process.stdout.write(`${rel}：改了 ${done.length} 个名字、${sites} 处引用\n`);
process.stdout.write(`  ${done.join('\n  ')}\n`);
process.stdout.write(`重名总数：${dups.length} -> ${after}`
  + '（记得把 tests/bootstrap/ratchet.js 的基线调下来，再跑一遍相关的门）\n');
