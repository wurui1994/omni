#!/usr/bin/env node
// ext/python/rt/gen-ucase.js —— **大小写与分类那张表，从本机 python3 生成一份数据**
//
// 路线：`ext/python/SPEC.md` §一 第 29 条那三条路里的**路 3**（倾向的那条）——
// 表是**数据**不是算法，所以搬它不违反"库函数不自己写"：我们不重写 `To*Full` 的逻辑，
// 只是不再每次去参考树里现编一份 `unicodectype.o`（那一份 175KB，还拖着"要有参考树"）。
//
// **oracle 就是判据自己**：这一份问的是本机 python3，而 `tests/python` 那把尺子量的也是
// 同一个 python3 —— 于是"表对不对"这件事不靠复述 Unicode 标准，靠同一个实现。
//
// 两条不在表里的上下文规矩（sigma 那一族）也**按行为推**，不按标准的属性名推：
//   * `后随算不算 cased`：`("Σ" + c).lower()` 的头一格是 `σ` 还是 `ς`；
//   * `算不算 case-ignorable`：上一条不成立时，`("Σ" + c + "a").lower()` 的头一格是不是 `σ`
//     （c 可忽略的话后头那个 `a` 照旧算"后面还有 cased"）。
// 为什么不查 `unicodedata`：`Case_Ignorable` 里有一半是 `Word_Break` 那几格
// （MidLetter / MidNumLet / Single_Quote），`unicodedata` 根本不交那个属性 ——
// 照类别猜就会在 `'` 这种字符上答错，而那正是 ς 的判据要用的。
//
// 落点 `ext/python/rt/ucase.tab`（文本：几行元信息 + 一长串十六进制字节）。
// 为什么是旁边一份数据文件而不是塞进 `.js`：仓库里已经有这条先例
// （`src/core/frontend-asy/builtins.tab` + `gen-builtins.js`，布局探测在 `host/data.js`）；
// 而几十万字符的数组/串字面量塞进 adapter 源码，会连 `check:self`（我们自己编自己）
// 一起拖下水 —— 那笔账在 `mir/emit_js.js` 的 data 段那一格已经量过。
//
//   node ext/python/rt/gen-ucase.js            生成并写 ucase.tab
//   node ext/python/rt/gen-ucase.js --check    只对账，不写（拿 20 个抽样码点问 python3）

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAB = join(HERE, 'ucase.tab');
const checkOnly = process.argv.includes('--check');

/** 一格记录 56 字节：flags(u16) + 4 个映射各 (count u8 + 3 × 码点 u32)。 */
const REC_SIZE = 56;
const BLOCK = 64;

/* python 那一侧：遍历全部码点、去重成记录、摊两级索引、连记录一起摆成一块字节。
   摆布局也在 python 里做 —— 那一侧有 1.1M 次循环，来回传 stdout 更贵。 */
const PY = String.raw`
import sys
N = 0x110000
BLOCK = 64
REC = 56

def cps(s):
    return tuple(ord(ch) for ch in s)

def enc(m, cp):
    # **单格映射按差值存**（a -> A 与 b -> B 落成同一格记录：差值 -32）。
    # 存绝对码点的话每个码点各成一格记录 —— 量过：1114112 份记录、64MB，
    # 连"记录号装得进 u16"都不成立。多格的（ß -> SS、ﬃ -> FFI）照旧按绝对码点，那种很少。
    if len(m) == 1:
        return (1, m[0] - cp, 0, 0)
    return (len(m),) + m + (0,) * (3 - len(m))

recs = {}
order = []
per = [0] * N
SIG = "\u03a3"
for cp in range(N):
    c = chr(cp)
    u, l, t, f = cps(c.upper()), cps(c.lower()), cps(c.title()), cps(c.casefold())
    flags = (c.isalpha() << 0) | (c.isdigit() << 1) | (c.isdecimal() << 2) \
        | (c.isnumeric() << 3) | (c.isalnum() << 4) | (c.isspace() << 5) \
        | (c.isupper() << 6) | (c.islower() << 7)
    fc = (SIG + c).lower()[0] == "\u03c3"
    ig = (not fc) and (SIG + c + "a").lower()[0] == "\u03c3"
    flags |= (int(fc) << 8) | (int(ig) << 9)
    # 映射长到 3 个码点以上的一格都没有（CPython 的 To*Full 也只给 3）——
    # 真有就当场停下，别静静截断。
    for m in (u, l, t, f):
        if len(m) > 3:
            sys.exit("码点 %d 的映射有 %d 个码点，超出 3" % (cp, len(m)))
    key = (enc(u, cp), enc(l, cp), enc(t, cp), enc(f, cp), flags)
    i = recs.get(key)
    if i is None:
        i = len(order)
        recs[key] = i
        order.append(key)
    per[cp] = i

# 两级索引：一级按块号（N/BLOCK 格），二级是去重之后的块
blocks = {}
idx1 = []
idx2 = []
for b in range(N // BLOCK):
    chunk = tuple(per[b * BLOCK:(b + 1) * BLOCK])
    n = blocks.get(chunk)
    if n is None:
        n = len(blocks)
        blocks[chunk] = n
        idx2.extend(chunk)
    idx1.append(n)

off_idx1 = 0
off_idx2 = off_idx1 + len(idx1) * 2
off_rec = off_idx2 + len(idx2) * 2
size = off_rec + len(order) * REC

buf = bytearray(size)

def u16(off, v):
    buf[off] = v & 0xff
    buf[off + 1] = (v >> 8) & 0xff

def u32(off, v):
    for k in range(4):
        buf[off + k] = (v >> (8 * k)) & 0xff

for i, v in enumerate(idx1):
    u16(off_idx1 + i * 2, v)
for i, v in enumerate(idx2):
    u16(off_idx2 + i * 2, v)
for i, (u, l, t, f, flags) in enumerate(order):
    base = off_rec + i * REC
    u16(base, flags)
    for j, m in enumerate((u, l, t, f)):
        at = base + 2 + j * 13
        buf[at] = m[0]
        # m[0] == 1 时头一格是**差值**（有符号，按补码摆）；>= 2 时那几格是绝对码点。
        for k in range(3):
            u32(at + 1 + k * 4, m[1 + k] & 0xffffffff)

out = sys.stdout
out.write("# ext/python/rt/ucase.tab —— node ext/python/rt/gen-ucase.js 生成的，别手改\n")
out.write("unicode %s\n" % ".".join(str(x) for x in sys.version_info[:3]))
out.write("nrec %d\n" % len(order))
out.write("nblk %d\n" % len(blocks))
out.write("block %d\n" % BLOCK)
out.write("recsize %d\n" % REC)
out.write("off_idx1 %d\n" % off_idx1)
out.write("off_idx2 %d\n" % off_idx2)
out.write("off_rec %d\n" % off_rec)
out.write("size %d\n" % size)
out.write("hex\n")
h = buf.hex()
for i in range(0, len(h), 120):
    out.write(h[i:i + 120] + "\n")
`;

const t0 = Date.now();
const r = spawnSync('python3', ['-c', PY], { encoding: 'utf8', maxBuffer: 1 << 28 });
if (r.status !== 0) {
  process.stderr.write(`python3 那一趟没过（rc=${r.status}）：${(r.stderr ?? '').slice(0, 400)}\n`);
  process.exit(1);
}
const text = r.stdout;
const ms = Date.now() - t0;

/** 元信息（`hex` 那一行之前的几行）。 */
function metaOf(s) {
  const meta = new Map();
  for (const line of s.split('\n')) {
    if (line === 'hex') break;
    if (line.startsWith('#') || line === '') continue;
    const sp = line.indexOf(' ');
    meta.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return meta;
}
const meta = metaOf(text);
const size = Number(meta.get('size'));
const hex = text.slice(text.indexOf('\nhex\n') + 5).replace(/\n/g, '');
if (hex.length !== size * 2) {
  process.stderr.write(`字节数对不上：meta 说 ${size}，十六进制那串是 ${hex.length / 2}\n`);
  process.exit(1);
}

process.stdout.write(`python3 ${meta.get('unicode')}：${meta.get('nrec')} 份记录、`
  + `${meta.get('nblk')} 个块，合计 ${size} 字节`
  + `（一级 ${Number(meta.get('off_idx2')) - Number(meta.get('off_idx1'))}`
  + ` / 二级 ${Number(meta.get('off_rec')) - Number(meta.get('off_idx2'))}`
  + ` / 记录 ${size - Number(meta.get('off_rec'))}）  ${(ms / 1000).toFixed(1)}s\n`);

/* **抽样对账**：表里查出来的四个映射与 python3 现算的逐格相同。
   挑的这几格是那几条规矩各自的代表（ß -> SS、ﬃ -> FFI、İ、ς、Σ、中日韩、emoji、'）。 */
const bytes = new Uint8Array(size);
for (let i = 0; i < size; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
const rd16 = (off) => bytes[off] | (bytes[off + 1] << 8);
const rd32 = (off) => (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16))
  + bytes[off + 3] * 16777216;
const OFF1 = Number(meta.get('off_idx1'));
const OFF2 = Number(meta.get('off_idx2'));
const OFFR = Number(meta.get('off_rec'));
function recOf(cp) {
  const blk = rd16(OFF1 + (cp >> 6) * 2);
  return rd16(OFF2 + (blk * BLOCK + (cp & 63)) * 2);
}
function mapOf(cp, which) {
  const at = OFFR + recOf(cp) * REC_SIZE + 2 + which * 13;
  const n = bytes[at];
  /* n == 1 那一格存的是**差值**（补码，按 32 位读回来）；n >= 2 存的是绝对码点。 */
  if (n === 1) {
    let d = rd32(at + 1);
    if (d >= 0x80000000) d -= 0x100000000;
    return [cp + d];
  }
  const out = [];
  for (let k = 0; k < n; k++) out.push(rd32(at + 1 + k * 4));
  return out;
}

const SAMPLES = [0x61, 0x41, 0xdf, 0xfb03, 0x130, 0x3c2, 0x3a3, 0x4e2d, 0x1f600, 0x27,
  0x1e9e, 0x1c5, 0x2170, 0xff41, 0x660, 0x2160, 0x131, 0x1fbc, 0x345, 0x3b9];
const pyOut = spawnSync('python3', ['-c', `
import sys
for cp in [${SAMPLES.join(',')}]:
    c = chr(cp)
    print(" ".join(",".join(str(ord(x)) for x in m) for m in (c.upper(), c.lower(), c.title(), c.casefold())))
`], { encoding: 'utf8' });
if (pyOut.status !== 0) {
  process.stderr.write(`抽样那一趟 python3 没过：${(pyOut.stderr ?? '').slice(0, 300)}\n`);
  process.exit(1);
}
const want = pyOut.stdout.trim().split('\n');
let bad = 0;
SAMPLES.forEach((cp, i) => {
  const got = [0, 1, 2, 3].map((w) => mapOf(cp, w).join(',')).join(' ');
  if (got !== want[i]) {
    bad += 1;
    process.stderr.write(`U+${cp.toString(16).toUpperCase()}：表里是 ${got}，python3 是 ${want[i]}\n`);
  }
});
if (bad > 0) {
  process.stderr.write(`${bad} 格抽样对不上 —— 没写文件\n`);
  process.exit(1);
}
process.stdout.write(`抽样 ${SAMPLES.length} 格（ß / ﬃ / İ / ς / Σ / 中 / emoji / ' …）与 python3 逐格相同\n`);

if (checkOnly) {
  if (!existsSync(TAB)) {
    process.stderr.write(`--check：${TAB} 还不在\n`);
    process.exit(1);
  }
  const old = readFileSync(TAB, 'utf8');
  if (old === text) process.stdout.write('--check：仓库里那份与现生成的逐字节相同\n');
  else {
    process.stderr.write('--check：仓库里那份与现生成的**不同**（本机 python3 的 Unicode 版本变了？）\n');
    process.exit(1);
  }
} else {
  writeFileSync(TAB, text);
  process.stdout.write(`-> ${TAB}  ${text.length} 字节\n`);
}
