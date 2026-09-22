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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import { startServer, shellToArgv, safePath, buildTree } from '../../src/core/serve.js';
import { natCompare, byIdeOrder } from '../../src/core/studio/shared.js';
/* 网页那一侧的**纯函数那一半**（`src/studio/render.js`：高亮 / markdown / EPS -> SVG /
   GLSL 的源码修修）。它一个 DOM 都不碰，所以在这儿直接 import 就能判 ——
   不必拉一套无头浏览器进来。 */
import {
  highlight, mdToHtml, epsToSvg, glslSource, glslVertex, glslSizeOf, GALLERY,
} from '../../src/studio/render.js';

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

/* render.js 那三样纯函数。 */
ok('highlight 认得 go 关键字', highlight('func main() {}', 'go').includes('class="kw"'));
const md = '# Hello\n\nworld **bold** _it_\n\n- a\n- b\n\n```go\nfunc x()\n```\n';
const h = mdToHtml(md);
ok('mdToHtml 标题', h.includes('<h1>'));
ok('mdToHtml 粗体', h.includes('<b>'));
ok('mdToHtml 列表', h.includes('<li>'));
ok('mdToHtml 围栏代码', h.includes('md-code'));
ok('mdToHtml 代码块里高亮', h.includes('class="kw"'));

/* **GLSL 的 `#version` 可能不在第一行**（vispy 那几份前头有十来行注释）——
   只认行首那一处的话原来那句会留在正文里，浏览器报
   `'version' : #version directive must occur before anything else`。 */
const frag = '// 注释一\n// 注释二\n\n#version 330 core\nout vec4 c;\nvoid main(){ c = vec4(1); }\n';
const es = glslSource(frag);
ok('glslSource 抹掉原来那句 #version', !/#version 330/.test(es));
ok('glslSource 把 300 es 放在第一个字节', es.startsWith('#version 300 es\n'));
ok('glslSource 只留一句 #version', (es.match(/#version/g) ?? []).length === 1);
ok('glslSource 没有 out 时补一格',
  glslSource('#version 120\nvoid main(){ gl_FragColor = vec4(1); }').includes('out vec4 fragColor;'));

/* **顶点段照片元段生成**：写着 `in vec2 v_uv;` 的那几份（`pretty.frag`）少了对应的顶点
   输出在 ES 3.00 上**链不上**。所以 `glslVertex` 要把每一格 `in` 配一格同名 `out`。 */
{
  const vs = glslVertex('#version 330 core\nin vec2 v_uv;\nin float t;\nout vec4 c;\nvoid main(){}');
  ok('glslVertex 给 in 配上同名的 out', vs.includes('out vec2 v_uv;') && vs.includes('out float t;'));
  ok('glslVertex 给它们赋值', vs.includes('v_uv = p;') && vs.includes('t = p.x;'));
  ok('glslVertex 没有 in 时就一格三角形',
    !glslVertex('void main(){}').includes('out '));
}
/* **画多大由文件自己说**：vispy 那几份把坐标写死在 128² 上（头上那行 `omni run … --size 128`），
   用了分辨率 uniform 的那一族回 0 = 跟着显示区走。 */
{
  const rd = (p) => readFileSync(join(root, p), 'utf8');
  ok('glslSizeOf 认文件头上的 --size',
    glslSizeOf(rd('tests/glsl/cases/vispy-disc.frag')) === 128,
    `${glslSizeOf(rd('tests/glsl/cases/vispy-disc.frag'))}`);
  ok('glslSizeOf 分辨率无关的那一族回 0',
    glslSizeOf(rd('tests/glsl/cases/pretty.frag')) === 0);
  ok('glslSizeOf 都没说的按 256（与 CLI 同一个默认）',
    glslSizeOf('void main(){}') === 256);
}

/* **目录树按 IDE 的次序**：目录在前、文件在后；名字里的数字按数值比
   （`ls` 的字典序会把 `100-…` 插到 `10-…` 与 `11-…` 之间）。 */
ok('natCompare 数字按数值', natCompare('10-pairs.asy', '100-local.asy') < 0);
ok('natCompare 09 在 10 前', natCompare('09-arrays.asy', '10-pairs.asy') < 0);
/* 大小写不敏感：`ls` 按字节比会把所有大写名字甩到小写前头（`B`=66 < `a`=97）。 */
ok('natCompare 大小写不敏感', natCompare('Beta.md', 'alpha.md') > 0);
ok('byIdeOrder 目录在文件前',
  byIdeOrder({ kind: 'dir', name: 'zzz' }, { kind: 'file', name: 'aaa' }) < 0);
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
ok('buildTree 收 html 例子', paths.some((p) => p.startsWith('ext/html/examples/') && p.endsWith('.html')));
ok('buildTree 收 asy 的 draw', paths.some((p) => p.startsWith('tests/asy/draw/')));
/* **首页那张策展清单**：每一格都得在树上（首页点一下要能打开它），
   而"它是不是真出图"在下面那一节里真跑一趟。 */
ok('首页清单每一格都在树上',
  GALLERY.every((g) => paths.includes(g.path)),
  GALLERY.filter((g) => !paths.includes(g.path)).map((g) => g.path).join(' '));
ok('首页清单三种腿都有', ['asy', 'glsl', 'html'].every((k) => GALLERY.some((g) => g.kind === k)));
ok('首页清单不收算术例子（那一族没有图）',
  !GALLERY.some((g) => g.path.startsWith('tests/asy/cases/')));
/* 主语言那门自己的例子也得在树上 —— 从前这棵树上一行 `.omni` 都没有。 */
ok('buildTree 收 omni 的例子', paths.some((p) => p.endsWith('.omni')),
  `${paths.filter((p) => p.endsWith('.omni')).length} 份`);
/* 排序那一条的真判据：同一层里 `09` < `10` < `100`，而 `ls` 会把 `100` 排在 `10` 前头。 */
{
  const findDir = (n, want) => {
    if (n.path === want) return n;
    for (const k of n.children ?? []) { const r = findDir(k, want); if (r !== null) return r; }
    return null;
  };
  let cases = null;
  for (const r of tree.roots) { cases = cases ?? findDir(r, 'tests/asy/cases'); }
  const names = (cases?.children ?? []).map((c) => c.name).filter((x) => x.endsWith('.asy'));
  /* 只看以数字开头的那一族：不带号的名字（`mod_au.asy`）本来就排在带号的后头，
     把它们也塞进来会拿 0 去比，判据自己就错了。 */
  const nums = names.filter((x) => /^\d/.test(x));
  const num = (x) => Number(x.match(/^\d+/)[0]);
  ok('目录树按自然序（09 < 10 < 100）',
    nums.length > 20 && nums.every((x, i) => i === 0 || num(nums[i - 1]) <= num(x)),
    nums.slice(8, 14).join(' '));
}

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

  for (const p of ['/', '/studio.css', '/studio.js', '/render.js']) {
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

  /* **会 spawn 的那几门也要收得到输出**（2026-09-22 修的一个真 bug）：
   * 常驻工人把 `process.stdout.write` 换成了收集器，而 `stdio:'inherit'` 的孩子直接写 fd 1
   * —— 那一格在工人里是 NDJSON 协议的通道。症状是 Studio 上 `.asy` `code=0` 而输出空的
   * （整份 EPS 漏进协议管子）。闸在 `host/native.js` 的 `CAPTURED`（`OMNI_CAPTURE=1`）。 */
  const asy = paths.find((p) => p.startsWith('tests/asy/draw/') && p.endsWith('.asy'));
  if (asy !== undefined) {
    const ra = await post('/api/run', { path: asy, lang: 'asy' });
    ok('/api/run 收得到会 spawn 的腿的输出（asy 的 EPS）',
      ra.json.code === 0 && (ra.json.stdout ?? '').startsWith('%!PS'),
      `code=${ra.json.code} stdout=${JSON.stringify((ra.json.stdout ?? '').slice(0, 40))}`);
    /* 顺手把它翻成 SVG —— 预览那一栏就是这么画的。 */
    ok('EPS -> SVG 画得出路径', epsToSvg(ra.json.stdout ?? '').includes('<path '));
  }

  /* **首页清单没骗人**：`kind: 'asy'` 与 `kind: 'svg'` 那几格真跑一趟，
     出来的必须是图 —— asy 是 EPS（翻成 SVG 后真有笔画），svg 那一族 stdout 本身就是 SVG。
     清单是人挑的，"它确实出图"是机器判的。 */
  for (const g of GALLERY.filter((x) => x.kind === 'asy' || x.kind === 'svg')) {
    const rg = await post('/api/run', { path: g.path });
    const out = (rg.json.stdout ?? '').trim();
    const good = g.kind === 'svg'
      ? out.startsWith('<svg') && out.includes('<polyline points=')
      : out.startsWith('%!PS') && epsToSvg(out).includes('<path ');
    ok(`首页「${g.title}」真出图`, rg.json.code === 0 && good,
      `code=${rg.json.code} ${JSON.stringify(out.slice(0, 40))} err=${JSON.stringify((rg.json.stderr ?? '').slice(-300))}`);
  }

  /* **不出图的 asy 不许被甩到画布上**：切不切"绘图"那一格的依据就是这一行
     （`studio.js` 的 `run()` 里看 stdout 是不是 `%!PS`）。`cases` 底下那一大半是算术。 */
  const asyTxt = paths.find((p) => p.startsWith('tests/asy/cases/') && p.endsWith('.asy'));
  if (asyTxt !== undefined) {
    const rt = await post('/api/run', { path: asyTxt, lang: 'asy' });
    ok('不画图的 asy 不是 EPS（预览那一格不该亮）',
      rt.json.code === 0 && !(rt.json.stdout ?? '').startsWith('%!PS'),
      `${asyTxt} code=${rt.json.code} stdout=${JSON.stringify((rt.json.stdout ?? '').slice(0, 40))}`);
  }

  /* **js 两条腿的对照**（Studio 上默认走 `--direct`，勾"我们的解析"才走我们的）：
   * 同一份源码两边**答案必须一样** —— 那正是这一页最该有的判据。 */
  const jsc = paths.find((p) => p.startsWith('tests/js-exec/cases/01-'));
  if (jsc !== undefined) {
    const a = await post('/api/run', { path: jsc, lang: 'js', direct: true });
    const b = await post('/api/run', { path: jsc, lang: 'js' });
    ok('/api/run --direct 交给 node 跑得出来', a.json.code === 0 && (a.json.stdout ?? '').length > 0);
    ok('/api/run js 两条腿答案相同', a.json.stdout === b.json.stdout,
      `direct=${JSON.stringify((a.json.stdout ?? '').slice(0, 60))} ours=${JSON.stringify((b.json.stdout ?? '').slice(0, 60))}`);
    ok('/api/run --direct 说得出自己没过我们这一轮',
      (a.json.stderr ?? '').includes('--direct'));
  }

  /* **借来语言那条路不许把脏留给下一趟**（2026-09-22 抓到的一个真 bug）。
   *
   * `.go` / `.nim` / `.v` 那几门先译成核心方言，那份文本走的是 `cli.js` 的模块级
   * `SRC_SX`。它从前不清 —— 常驻工人里上一趟 `.go` 留下的 sx 被下一趟 `.omni` 捡走，
   * 报的是 `scicomp.omni:2:7: error: expected '(', found 'sum'`，而那个 `sum`
   * **是上一趟那份 go 里的函数**。工人那边"一次只做一件事"防的是并发，防不了这一种。
   * 闸在 `main()` 入口那一行 `SRC_SX = undefined`。 */
  {
    const om = paths.find((p) => p.endsWith('.omni'));
    if (om !== undefined && cse !== undefined) {
      const before = await post('/api/run', { path: om });
      await post('/api/run', { path: cse, lang: 'go' });
      const after = await post('/api/run', { path: om });
      ok('跑过 .go 之后再跑 .omni，还是它自己（SRC_SX 不串味）',
        after.json.code === before.json.code && after.json.stdout === before.json.stdout,
        `before code=${before.json.code} after code=${after.json.code} `
        + `${JSON.stringify((after.json.stderr ?? '').slice(0, 160))}`);
    }
  }

  const sh = await post('/api/shell', { line: 'omni --help' });
  ok('/api/shell 认 omni', sh.json.code === 0);
  const bad = await post('/api/shell', { line: 'rm -rf /' });
  ok('/api/shell 拒绝不认的命令', bad.json.code === 127);

  /* ---- 控制台那一格会话（`/api/repl`，`docs/design/omni-console-scicomp.md` 阶段 1）----
   *
   * 钉住的是这一层**唯一**的性质：**状态留着**。第一行的 `x = 10` 第二行还看得见，
   * 而且那一格答案要与终端上 `omni repl` 逐字相同（`tests/repl/session.in` 的头几行
   * 就是这几句，期望 100 / abcd / 49）。别的都是附带的。
   */
  {
    const say = async (line, extra) => (await post('/api/repl',
      { session: 'judge', line, ...(extra ?? {}) })).json;
    await say('x = 10');
    const r1 = await say('x * x');
    ok('/api/repl 状态跨行留着（x=10 之后 x*x 是 100）', r1.out === '100\n',
      JSON.stringify(r1));
    await say('s = "ab" + "cd"');
    const r2 = await say('s');
    ok('/api/repl 串也留着（abcd）', r2.out === 'abcd\n', JSON.stringify(r2));
    await say('int sq(int n) { return n * n; }');
    const r3 = await say('sq(7)');
    ok('/api/repl 会话里定义的函数下一行就能用（49）', r3.out === '49\n', JSON.stringify(r3));
    /* **括号没闭合 = 还没写完**：不喂、不报错，页面上接着攒（判据与终端那一路同一格）。 */
    const r4 = await say('if (x > 5) {');
    ok('/api/repl 认得出"这一行还没写完"', r4.incomplete === true && r4.err === '',
      JSON.stringify(r4));
    /* **变量栏**：名字、类型、印出来的样子。gsl-shell 没有这东西，这一格是我们加的。 */
    const names = (r3.vars ?? []).map((v) => `${v.name}:${v.type}=${v.value}`).join(' ');
    ok('/api/repl 报得出变量栏（x:int=10 与 s:string=abcd）',
      names.includes('x:int=10') && names.includes('s:string=abcd'), names);
    /* **两格会话互不串味**：另一个 session 里 `x` 是不认识的名字。 */
    const other = (await post('/api/repl', { session: 'judge-2', line: 'x' })).json;
    ok('/api/repl 两格会话互不串味', other.err.includes('undefined variable'),
      JSON.stringify(other));
    /* `reset` 之后从头开始。 */
    const re = await say('x', { reset: true });
    ok('/api/repl reset 把会话忘掉', re.err.includes('undefined variable'), JSON.stringify(re));
  }

  /* ---- 控制台里用矩阵（`std/matrix.omni`，设计文档阶段 3）----
   *
   * 这一格钉的是**那套库在控制台里真能用**：页面上的会话走 `mode: 'mixed'`
   * （`dynamic` 里 `[[1.0, 2.0], …]` 推不成 `list<list<real>>`，`matOf` 会报没有重载 ——
   * 量出来的，不是猜的）。算出来的答案另有一整份判据在 `tests/cases/26_matrix.omni`
   * （那一份是五条腿差分 + 快照）。
   */
  {
    const say = async (line) => (await post('/api/repl',
      { session: 'judge-mat', line, mode: 'mixed' })).json;
    await say('import "std/matrix.omni";');
    await say('Matrix a = matOf([[1.0, 2.0], [3.0, 4.0]]);');
    const d = await say('a.det()');
    ok('控制台里 matOf + det 算得出来（-2）', d.out === '-2\n', JSON.stringify(d));
    const t = await say('a.mul(a).text()');
    ok('控制台里矩阵乘 + 排版（7 10 / 15 22 右对齐）',
      t.out === '[  7 10 ]\n[ 15 22 ]\n', JSON.stringify(t.out));
    const vs = (d.vars ?? []).map((v) => `${v.name}:${v.type}`).join(' ');
    ok('变量栏认得出矩阵那一格', vs.includes('a:record'), vs);
  }

  /* ---- 控制台里的数学函数（`src/core/hir/check.js` 的 MATH_FUNCS，设计文档 §4.5）----
   *
   * 那一族是**语言自己的内建**（降成 `(rmath …)`），所以控制台里不 import 任何东西就该有。
   * 这一格钉的只是"一行就算得出来"这条路通；每个函数的答案另有 js==c 差分在
   * `tests/cases/29_math.omni`。顺带钉一格库里用到它的地方（`Matrix.norm` 里的 sqrt）。
   */
  {
    const say = async (line) => (await post('/api/repl',
      { session: 'judge-math', line, mode: 'mixed' })).json;
    const s = await say('sqrt(2.0)');
    ok('控制台里 sqrt 一行就算得出来（1.41421）', s.out === '1.41421\n', JSON.stringify(s));
    await say('import "std/matrix.omni";');
    const n = await say('matVec([3.0, 4.0]).norm()');
    ok('库里也用得上那一族（3-4-5 的 norm = 5）', n.out === '5\n', JSON.stringify(n));
    /* 复数与 FFT（阶段 6）：常数序列的谱只有直流那一格，等于 n。 */
    await say('import "std/num.omni";');
    await say('import "std/complex.omni";');
    const f = await say('numFft([1.0, 1.0, 1.0, 1.0])[0].text()');
    ok('控制台里 FFT 出得来（常数序列的直流 = 4）', f.out === '4\n', JSON.stringify(f));
  }

  /* ---- 控制台里出图（`std/plot.omni`，设计文档阶段 4）----
   *
   * 出来的是一份 SVG 文本；页面**看输出决定挂哪儿**（以 `<svg` 起头就进绘图栏，
   * 与 asy 那条"看是不是 `%!PS`"同一条纪律）。所以这一格判的就是那一条：
   * 真出 SVG、里头真有那条折线。整份 SVG 的逐字节判据在 `tests/cases/27_plot.omni`
   * （那一份是 js==c 差分 —— 它已经抓到过一个真 bug：非 ASCII 标题被逐字节切开）。
   */
  {
    const say = async (line) => (await post('/api/repl',
      { session: 'judge-plot', line, mode: 'mixed' })).json;
    await say('import "std/plot.omni";');
    await say('list<real> xs = [0.0, 1.0, 2.0, 3.0];');
    await say('list<real> ys = [0.0, 1.0, 4.0, 9.0];');
    const r = await say('plotLine("y = x^2", xs, ys).show()');
    const out = (r.out ?? '').trim();
    ok('控制台里出得来一张 SVG 图',
      out.startsWith('<svg') && out.includes('<polyline points=') && out.endsWith('</svg>'),
      JSON.stringify(out.slice(0, 80)));
  }

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
