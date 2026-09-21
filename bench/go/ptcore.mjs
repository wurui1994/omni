// 把 fogleman/pt **整包**剪成一份 `package main` —— 一把"真项目"的尺子。
//
// 为什么要这一份：`bench/go/pt.go` 是**照 pt 的结构手写**的（自带 PRNG，逐字节可比），
// 而这一份是 pt 的**真源码**（393 格顶层声明、约 3.7 千行），只把"碰文件与位图的那些"剪掉。
// 两把尺子各管一件事：pt.go 量性能与答案，这一份量"编译器还欠什么"。
//
// 怎么剪（机械，没有手挑文件那套打地鼠）：判据只有一条 —— **这一格的正文里出现了禁用包的
// 前缀吗**（`image.` / `png.` / `jpeg.` / `os.` / `bufio.` / `color.` / `binary.`）。
// 然后取**不动点**：引用了被剪掉名字的声明也剪掉，直到不再变。
//
// 两处限制是量出来的，不是想出来的：
//   * 方法名级联只在**这个方法名全树唯一**时才算 —— 不然 `Function.MaterialAt` 会把所有
//     `.MaterialAt(` 的调用点连坐（`Shape` 都被带走，从剪 38 格变成剪 158 格）。
//   * `path.` / `strings.` / `strconv.` 也在禁用之列，理由不是 pt 而是**我们自己**：
//     `--pkgs` 把依赖包摊进同一个平名字空间，`path.Split` 与 `strings.Split` 都落成
//     `Split`，后来的盖掉先来的。那是 `--pkgs` 的架构边界（任务 #94 记着）。
//
// 剪完 `image/color` 整个不 import —— "平名字空间容不下两个 `Color`"那堵墙自然没了
// （pt 自己的 `Color` 成了唯一的主人）。剩下的 import 是 `fmt math math/rand time`。
//
// 末尾补一格**确定性**的驱动（自带 LCG，不用 `math/rand` 的时间种子），印一个校验和 ——
// 于是它与 `go run` 逐字节可比。`go run` 给的是 **616378005**。
//
// 用法：
//   node bench/go/ptcore.mjs > /dev/null        # 写出 /tmp/ptcat/ptcore.go
//   go run /tmp/ptcat/ptcore.go                # 参考答案
//   node src/cli.js build /tmp/ptcat/ptcore.go -o /tmp/ptcat/ptcorebin \
//     --pkgs src/lib/go/math/rand,src/lib/go/sort,src/lib/go/time,\
// src/lib/go/runtime,src/lib/go/omnihost
//
// **这不是判据**（pt 的源码不在这棵树里，路径写死在下面那一行）—— 它是一把探针。
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';

const dir = '/Users/wurui/Documents/Lang/reference/pt/pt';
const OUT = '/tmp/ptcat/ptcore.go';
const BAD = ['image.', 'png.', 'jpeg.', 'os.', 'bufio.', 'color.', 'binary.',
  'image.Image', 'gif.', 'path.', 'strings.', 'strconv.', 'fmt.'];
/* 手工再剪几格：它们本身不碰那几个包，但**只被**被剪掉的东西用，留着是死代码里的洞。
   `Function` 整个剪掉的理由是 `type Func func(x, y float64) float64`：具名函数类型当
   结构体字段（`Function.Function Func`）时声明类型丢了，推成 int ⇒ 报"调一格不是名字的
   东西"。那是编译器欠的一格（任务 #94），不是 pt 的事。
   `SmoothNormals*` 与 `poisson*` / `PoissonDisc` 剪掉的理由是 `map[Vector]…` ——
   **结构体当字典的键**。方言的键只收 int 与 string；那也是编译器欠的一格，而它不在
   出图那条路上（网格平滑与泊松取样用它），所以这把探针先绕过去。 */
const EXTRA_DROP = new Set(['init', 'Function', 'NewFunction', 'Function.Compile',
  'Function.BoundingBox', 'Function.Contains', 'Function.Intersect',
  'Function.MaterialAt', 'Function.NormalAt', 'Function.UV',
  'Mesh.SmoothNormals', 'Mesh.SmoothNormalsThreshold', 'smoothNormalsThreshold',
  'poissonGrid', 'newPoissonGrid', 'poissonGrid.normalize', 'poissonGrid.insert',
  'PoissonDisc']);

/** 一行是不是某个顶层声明的开头？回它的名字（`T.M` 那种带接收者）或 null。 */
function declName(ln) {
  let m = ln.match(/^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s*(\w+)\s*\(/);
  if (m !== null) return `${m[1]}.${m[2]}`;
  m = ln.match(/^func\s+(\w+)\s*\(/);
  if (m !== null) return m[1];
  m = ln.match(/^(?:type|var|const)\s+(\w+)\b/);
  if (m !== null) return m[1];
  m = ln.match(/^(?:var|const)\s*\($/);
  if (m !== null) return '__group';
  return null;
}

/** 把一份文件切成 `{name, text}` 的顶层声明序列（import 与 package 收走）。 */
function declsOf(src, imports) {
  const lines = src.split('\n');
  const out = [];
  let cur = null;
  let inImp = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith('package ')) continue;
    if (inImp) {
      if (t === ')') { inImp = false; continue; }
      if (t !== '') imports.add(t);
      continue;
    }
    if (t === 'import (') { inImp = true; continue; }
    if (t.startsWith('import ')) { imports.add(t.slice(7).trim()); continue; }
    const top = ln.length > 0 && ln[0] !== ' ' && ln[0] !== '\t';
    if (top && ln[0] !== '}' && ln[0] !== ')') {
      const nm = declName(ln);
      if (nm !== null) { cur = { name: nm, text: [] }; out.push(cur); }
    }
    if (cur === null) { cur = { name: '__head', text: [] }; out.push(cur); }
    cur.text.push(ln);
  }
  return out;
}

const imports = new Set();
const decls = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.go')).sort()) {
  for (const d of declsOf(readFileSync(`${dir}/${f}`, 'utf8'), imports)) {
    decls.push({ ...d, file: f, body: d.text.join('\n') });
  }
}

/* 第一轮：正文里出现禁用包前缀的，剪。 */
const dropped = new Set();
for (const d of decls) {
  if (EXTRA_DROP.has(d.name) || BAD.some((b) => d.body.includes(b))) dropped.add(d.name);
}
/* 不动点：引用了被剪名字的声明也剪。两种引用各一条规矩：
   * 被剪的是**函数 / 类型**（`NewColor`）：正文里那个名字作为整词出现就算。
     整词而不是子串 —— 不然 `Color` 会把 `ColorTexture` 也带走（靠巧合对是不算对的）。
   * 被剪的是**方法**（`Renderer.writeImage`）：只在**这个方法名全树唯一**时才按
     `.writeImage` 级联。不加这一条限制的话 `Function.MaterialAt` 会把所有
     `.MaterialAt(` 的调用点连坐 —— 而那是接口方法，十个类型都有（量出来的：
     一下从剪 29 格变成剪 158 格，`Shape` 都被带走了）。 */
const ownersOf = new Map();
for (const d of decls) {
  const dot = d.name.indexOf('.');
  if (dot < 0) continue;
  const m = d.name.slice(dot + 1);
  ownersOf.set(m, (ownersOf.get(m) ?? 0) + 1);
}
for (let pass = 0; pass < 12; pass++) {
  let grew = false;
  for (const d of decls) {
    if (dropped.has(d.name)) continue;
    for (const g of dropped) {
      const dot = g.indexOf('.');
      let re;
      if (dot < 0) re = new RegExp(`\\b${g}\\b`);
      else {
        const m = g.slice(dot + 1);
        if ((ownersOf.get(m) ?? 0) !== 1) continue;      // 多个主人：不连坐
        re = new RegExp(`\\.${m}\\b`);
      }
      if (re.test(d.body)) { dropped.add(d.name); grew = true; break; }
    }
  }
  if (!grew) break;
}

const kept = decls.filter((d) => !dropped.has(d.name));
process.stderr.write(`剪掉 ${dropped.size} 格，留 ${kept.length} 格\n`);
process.stderr.write(`剪掉的：${[...dropped].sort().join(' ')}\n`);

const main = `
// ---------------- 驱动（不是 pt 的源码）----------------
type LCG struct{ S int64 }

func (r *LCG) Next() int64 {
	r.S = r.S*6364136223846793005 + 1442695040888963407
	return (r.S >> 33) & 2147483647
}
func (r *LCG) F() float64 { return float64(r.Next()) / 2147483648.0 }

func main() {
	shapes := []Shape{}
	k := 0
	for i := 0; i < 5; i++ {
		for j := 0; j < 5; j++ {
			x := float64(i)*1.1 - 2.2
			z := float64(j)*1.1 - 2.2
			m := DiffuseMaterial(Color{0.2 + float64(k%4)*0.2, 0.5, 0.8})
			shapes = append(shapes, NewSphere(Vector{x, -0.6, z}, 0.4, m))
			k++
		}
	}
	shapes = append(shapes, NewCube(Vector{-3, -1.2, -3}, Vector{3, -1.0, 3},
		DiffuseMaterial(Color{0.9, 0.9, 0.9})))
	tree := NewTree(shapes)

	rnd := &LCG{12345}
	w := 64
	h := 48
	spp := 8
	sum := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			hits := 0
			for s := 0; s < spp; s++ {
				u := (float64(x) + rnd.F()) / float64(w)
				v := (float64(y) + rnd.F()) / float64(h)
				ox := (u - 0.5) * 4.0
				oy := (0.5 - v) * 3.0
				ray := Ray{Vector{0, 1.2, 6}, Vector{ox, oy, -5}.Normalize()}
				hit := tree.Intersect(ray)
				if hit.Ok() {
					hits++
				}
			}
			sum = (sum*131 + hits) & 1073741823
		}
	}
	println(sum)
}
`;

/* import 那一块：只留**剪完之后还用得到**的。 */
const keptText = kept.map((d) => d.body).join('\n') + main;
const imp = [...imports].filter((i) => {
  const m = i.match(/"([^"]+)"/);
  if (m === null) return false;
  if (i.startsWith('_')) return false;
  const last = m[1].split('/').pop();
  return new RegExp(`\\b${last}\\.`).test(keptText);
}).sort();

mkdirSync(OUT.slice(0, OUT.lastIndexOf('/')), { recursive: true });
writeFileSync(OUT,
  `package main\n\n${imp.length > 0 ? `import (\n${imp.map((i) => `\t${i}`).join('\n')}\n)\n\n` : ''}`
  + keptText);
process.stderr.write(`import：${imp.join(' ')}\n`);
