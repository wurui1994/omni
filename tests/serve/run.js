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

  /* ---- 虚拟文件系统：编辑与新建（`PUT /api/file`）----
   *
   * 钉住的是"用户改了有没有效果"那一整条：写得进、读得回、进得了树、**跑的是改过的那一份**。
   * 从前 `run()` 里 `S.text` 被 input 处理函数顺手改了，于是 dirty 永远为假 ——
   * 改动根本没递出去。那种 bug 只有"改完再跑，答案跟着变"这一条量得出来。
   */
  const put = async (p, b) => {
    const r = await fetch(s.url + p, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    });
    return { code: r.status, json: await r.json() };
  };
  const probe = 'ext/go/examples/__probe.go';
  const src1 = 'package main\n\nfunc main() { println(6 * 7) }\n';
  const w1 = await put('/api/file', { path: probe, text: src1 });
  ok('PUT /api/file 新建', w1.code === 200 && w1.json.ok === true);

  const back = JSON.parse((await get(`/api/file?path=${encodeURIComponent(probe)}`)).text);
  ok('读回来是改过的那一份', back.text === src1 && back.dirty === true);

  const t2 = JSON.parse((await get('/api/tree')).text);
  const p2 = [];
  const coll2 = (n) => { if (n.kind === 'file') p2.push(n.path); else (n.children ?? []).forEach(coll2); };
  t2.roots.forEach(coll2);
  ok('新建的进了目录树', p2.includes(probe));

  const r1 = await post('/api/run', { path: probe });
  ok('跑的是改过的那一份', (r1.json.stdout ?? '').trim() === '42', JSON.stringify(r1.json.stdout));

  await put('/api/file', { path: probe, text: 'package main\n\nfunc main() { println(1 + 1) }\n' });
  const r2 = await post('/api/run', { path: probe });
  ok('改完再跑答案跟着变', (r2.json.stdout ?? '').trim() === '2', JSON.stringify(r2.json.stdout));

  const r3 = await post('/api/run', { path: probe, text: 'package main\n\nfunc main() { println(9 * 9) }\n' });
  ok('实时模式那一支（body.text）', (r3.json.stdout ?? '').trim() === '81', JSON.stringify(r3.json.stdout));

  ok('PUT 拦路径穿越', (await put('/api/file', { path: '../evil.txt', text: 'x' })).code === 400);

  /* ---- 热工人：第二趟必须**明显**快（这一层"实时性"的全部）---- */
  {
    await post('/api/run', { path: cse });
    const a1 = Date.now();
    await post('/api/run', { path: cse });
    const warm = Date.now() - a1;
    const h2 = JSON.parse((await get('/api/health')).text);
    ok('热工人在干活（/api/health 报得出来）',
      h2.pool !== undefined && h2.pool.served > 0, JSON.stringify(h2.pool));
    /* 冷那一条量出来 180~300ms（node 启动 110ms + 读语法表 15ms + 真跑）。
       热的第二趟在这台机器上是 8~19ms —— 判据卡 150ms：既证明"热了"，
       又不会因为机器忙而假红。 */
    ok('热的那一趟 < 150ms', warm < 150, `${warm}ms`);
    ok('热的那一趟走的是工人', r2.json.via === 'warm', String(r2.json.via));
  }

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
