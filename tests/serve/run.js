#!/usr/bin/env node
/**
 * tests/serve —— `omni serve` 那一层的判据（`docs/design/omni-serve-studio.md` §6）。
 *
 * 量的是**机制**，不是"拿一堆例子跑图"：起一格服务、打每个端点、比 JSON 的形状，
 * 再把 `/api/run` 的 stdout 与**本地 `omni run`** 对一遍（那一条是这一层唯一的真判据：
 * 服务面必须是"同一个编译器的另一个入口"，不是第二份实现）。
 *
 * 不装无头浏览器：那会带一整套依赖进来，而网页那一侧能自动查的只有"文件拿得到、
 * JSON 结构对"。UI 的好看与好用靠人看。
 */
import { execFileSync, execFile as execFileCb } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import { startServer, shellToArgv, safePath, buildTree } from '../../src/core/serve.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

let pass = 0, fail = 0;
/** `note` 只在**红的时候**印 —— 绿的那一行后面挂一串 `x != x` 是纯噪音。 */
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${note ? ` —— ${note}` : ''}`); }
};

/* ---------------------------------------------------------------- 纯函数那几格 */

/* 白名单闸：三类都必须拒。 */
ok('safePath 拒绝绝对路径', safePath(root, '/etc/passwd') === null);
ok('safePath 拒绝 ..', safePath(root, 'docs/../../.env') === null);
ok('safePath 拒绝白名单外', safePath(root, 'src/core/cli.js') === null);
ok('safePath 放行 docs', safePath(root, 'docs/guide.md') !== null);

/* 等效命令那张表。 */
const eq = (line, want) => {
  const got = shellToArgv(line);
  ok(`shellToArgv ${JSON.stringify(line)}`, JSON.stringify(got) === JSON.stringify(want),
    `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
};
eq('omni run a.go', ['run', 'a.go']);
eq('go run a.go', ['run', 'a.go']);
eq('go build a.go -o a', ['build', 'a.go', '-o', 'a']);
eq('nim r x.nim', ['run', 'x.nim']);
eq('nim c x.nim', ['build', 'x.nim']);
eq('lua x.lua', ['run', 'x.lua']);
eq('tcc a.c -o a', ['c', 'tcc', 'a.c', '-o', 'a']);
eq('awk -f x.awk', ['run', 'x.awk']);
ok('shellToArgv 不认的回 null', shellToArgv('rm -rf /') === null);

/* 树：三棵根、`tests/all.js` 那种跑手不进树。 */
const tree = buildTree(root);
const paths = [];
const collect = (n) => { if (n.kind === 'file') paths.push(n.path); else (n.children ?? []).forEach(collect); };
tree.roots.forEach(collect);
ok('buildTree 三棵根', tree.roots.length === 3, `${tree.roots.length}`);
ok('buildTree 收到文件', paths.length > 300, `${paths.length} 份`);
ok('buildTree 不收判据的跑手', !paths.includes('tests/all.js'));
ok('buildTree 只收 examples/cases', paths.filter((p) => p.startsWith('ext/'))
  .every((p) => p.includes('/examples/')));

/* ---------------------------------------------------------------- 端点 */

const s = await startServer({ port: 0, root });
const get = async (p) => {
  const r = await fetch(s.url + p);
  return { code: r.status, text: await r.text() };
};
const post = async (p, body) => {
  const r = await fetch(s.url + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { code: r.status, json: await r.json() };
};

try {
  const h = await get('/api/health');
  ok('/api/health 200', h.code === 200 && JSON.parse(h.text).ok === true);

  const t = await get('/api/tree');
  ok('/api/tree 200', t.code === 200 && JSON.parse(t.text).roots.length === 3);

  const f = await get(`/api/file?path=${encodeURIComponent('docs/guide.md')}`);
  ok('/api/file 读到文档', f.code === 200 && JSON.parse(f.text).lang === 'markdown');

  ok('/api/file 拦路径穿越', (await get('/api/file?path=../.env')).code === 404);
  ok('/api/file 拦白名单外', (await get('/api/file?path=src/core/cli.js')).code === 404);

  for (const p of ['/', '/studio.css', '/studio.js']) {
    ok(`静态 ${p}`, (await get(p)).code === 200);
  }
  ok('静态拦不存在的', (await get('/nope.js')).code === 404);

  /* **这一层唯一的真判据**：服务跑出来的与本地跑出来的逐字节相同。 */
  const cse = paths.find((p) => p.startsWith('tests/go/cases/01-'));
  const r = await post('/api/run', { path: cse, lang: 'go' });
  const local = execFileSync('node', [join(root, 'src', 'cli.js'), 'run', cse],
    { cwd: root, encoding: 'utf8', timeout: 120000 });
  ok('/api/run 与本地 omni run 逐字节相同', r.json.stdout === local,
    `${JSON.stringify(r.json.stdout)} != ${JSON.stringify(local)}`);
  ok('/api/run 带阶段信息', (r.json.stderr ?? '').split('\n').some((l) => l.startsWith('omni:')));

  const sh = await post('/api/shell', { line: 'omni --help' });
  ok('/api/shell 认 omni', sh.json.code === 0);
  const bad = await post('/api/shell', { line: 'rm -rf /' });
  ok('/api/shell 拒绝不认的命令', bad.json.code === 127);

  /* ---- --client 那一条：经服务跑与本地跑，stdout 逐字节相同、退出码相同 ---- */
  {
    const clientEntry = join(root, 'src', 'client.js');
    const { stdout: clientOut } = await execFile('node', [clientEntry, s.url, 'run', cse],
      { cwd: root, encoding: 'utf8', timeout: 120000 });
    ok('--client 与本地 omni run 逐字节相同', clientOut === local,
      `${JSON.stringify(clientOut.slice(0, 80))} != ${JSON.stringify(local.slice(0, 80))}`);
  }
} finally {
  await s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
