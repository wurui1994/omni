// asy 的 **C++ 内建面**，用 asy 自己写的一份。
//
// 真 asy 的绘图层是两层：`path` / `pen` / `guide` / `frame` / `transform` 那 19 个类型
// 与 run*.in 里那些函数在 **C++** 里（运行时自带，每个文件每个模块都看得见，base/ 里
// 一行声明都没有），而 `plain*.asy`、`graph.asy` 那一堆是 **asy 源码**。
// 这一份对应前者：`path` 是一个 struct（照 path.h 的 solvedKnot 摆 pre/point/post +
// straight），`--` 是 `operator --`，EPS 是拼出来的字符串。后者**不抄** —— 按
// `ASYMPTOTE_DIR` 引真的那些文件（见 cli.js 的模块查找次序）。
//
// 每个单元在声明遍开头隐式 import 这一份（lower.js 的 builtinsIn，`OMNI_ASY_BUILTINS=1`
// 打开）：struct 只声明一份，类型名与函数通过 modMerge 进来。
//
// 与真 asy 的对照（都是量出来的，`asy -noV -f eps`；cases/40-draweps 钉着）：
//   * 坐标是 %.6g（psfile.h:160 的 `*out << " " << x`，ostream 默认 6 位有效数字）
//   * 图的整体尺寸 = 缩放后的用户 bbox + **笔宽**：size(200) 那一档解的是
//     s*w + pw = 200（量过 150 宽的图出来是 199.5 = 150*1.33，1.33 = (200-0.5)/150）
//   * 摆放是信纸居中再各减 0.5：origin = ((612-w)/2-0.5, (792-h)/2-0.5)
//     （三个尺寸、两种笔宽都对上了；那 0.5 与笔宽无关）
//   * translate = origin - bbox 左下角
//
// 下面带「**垫的**」记号的那几个（size / draw / fill / 颜色常量 / shipout 的包装）
// 其实是 base/plain_*.asy 的东西，**将来要删** —— 它们在这里只是为了在 base 还引不动的
// 时候先把这条线跑通。真正属于这一份的是类型、path 的连接、pen 的构造与 EPS 输出。
//
// 输出这一刀写到**标准输出**，不写文件：核心方言里还没有文件 IO
// （`(print …)` 是唯一的出口）。`shipout` 因此印的是 EPS 正文本身。
// 还没做的：guide 与 `..` 的 Hobby 求解（knot.cc 的三对角）、transform、Label（要 TeX）、
// clip、3D。

// ---------------------------------------------------------------- file
// asy 的 I/O 句柄。**写**那一路只有 stdout（`(print …)` 是核心方言唯一的出口）；
// **读**那一路是真的：`(readtext E)` 把整份文本拿到手，剩下的分行/分词/注释/eof
// 全在这一层用字符串算（实现与量出来的语义见下面 asy__f… 那一族与 input()）。
// 一份内容按 '\n' 切开存着，而不是留一个"读到第几个字节"的下标：这一层的
// `find(s,t,p)` 是 `sfind(substr(s,p))`（frontend-asy/runtime.js 的 asy__sfindp），
// 每次都要把尾巴整份拷一遍 —— 1.2MB 的 worldmap.dat 上那是 6 万次 × 半兆的拷贝。
// 按行切开是一次 O(n)，之后每一步都只在**一行**上算。
struct file {
  int fd;            // 0 = stdin、1 = stdout、2 = 真的输入文件
  string buf;        // 出那一路还没成整行的一截
  string name;
  string[] lines;    // 入那一路：整份内容按 '\n' 切开（元素里不含 '\n'）
  int nl;            // 有效行数（末尾那个 '\n' 切出来的空元素不算一行）
  int li;            // 读到第几行
  int ci;            // 那一行里读到第几个字节（== 行长表示"停在行尾那个 '\n' 上"）
  bool linemode;     // 数组读到行尾就停（fileio.h:65）
  bool csvmode;
  bool wordmode;     // 字符串按空白分词，不是按行
  string comment;    // 一个字节的注释字符；"" = 没有
  bool nullfield;    // 上一次 nexteol 撞到空行（fileio.h:76，读出来是**零值**）
  bool opened;       // isOpen()
  bool eofbit;       // 流的 eof（peek 撞底就置上）
  bool errbit;       // 流的 fail（数组读靠它收尾）
  string white;      // asy 的 whitespace：Read(string) 把它拼在前面

  // `f.line()` / `f.word()` / `f.csv()`：asy 那边这三个是 file 这个内建类型上的
  // **虚字段**（runfile.in:209/227/244 的 lineSet/csvSet/wordSet 各回一个 callable，
  // 于是 `f.line()` 是"取字段再调"）。这一层的 file 是记录，所以写成方法 ——
  // 回的是 this，`input(…).word().line()`（obj.asy:24）才串得起来。
  file line(bool b=true) { linemode = b; return this; }
  file csv(bool b=true) { csvmode = b; if (b) wordmode = false; return this; }
  file word(bool b=true) { wordmode = b; if (b) csvmode = false; return this; }
}

// asy 的 `code`：`quote{ … }` 攒起来的一段**没编译的源码**，交给 `_eval` 在当时的环境里
// 再编一遍（builtin.cc 的 primCode）。这一层也只给**类型**：`quote{}` 造一格空的 code
// （块本身丢掉了），真去 eval 它才报。量出来的理由与 file 那一格同一条 ——
// plain.asy:213 的 `void eval(code s, …)` 与 plain_debugger.asy:13/34 的
// `code s=quote{}` 挡着 plain 的这两支。
struct code { }

// ---------------------------------------------------------------- 数与数组
// asy 在 C++ 里带的一批非绘图内建。量出来的理由：`import graph;` 一句话下去 193 条诊断，
// 「缺的内建函数」占 33 条，而这几个是里面**现在就写得起**的（不需要方言加东西）。
// 每一条的行为都是 `asy -noV` 量的，写在各自那一行。

// pi 在真 asy 里是 C++ 的常量（`pi=acos(-1)`），不是 base 里声明的
real pi = acos(-1);

// C++ 那一批**常量**（builtin.cc:876-887 那一段，照那里的定义写）：
//   intMax=Int_MAX  intMin=Int_MIN  inf=HUGE_VAL  infinity=cbrt(DBL_MAX)
//   nan=nan("")  realMax=DBL_MAX  realMin=DBL_MIN  realEpsilon=DBL_EPSILON
//   realDigits=DBL_DIG  randMax=Int_MAX  VERSION=REVISION
// plain_constants.asy 一上来就用 infinity（finite() 那三个），所以这一批不给，
// 整个 plain 树的正文都走不动。
// intMax **不是** INT64_MAX：common.h:106 在 COMPACT 下留了最高两个值给 DefaultValue
// 与 Undefined，于是 `Int_MAX = INT64_MAX - 2`（量过：asy 的 intMax 是
// 9223372036854775805）。intMin 照旧是 INT64_MIN，不是 -intMax-1。
int intMax = 9223372036854775805;
int intMin = -9223372036854775808;
real realMax = 1.7976931348623157e308;
real realMin = 2.2250738585072014e-308;
real realEpsilon = 2.220446049250313e-16;
int realDigits = 15;
int randMax = intMax;
// HUGE_VAL：IEEE 双精度溢出就是 +inf，所以乘出来
real inf = 1.0e308 * 10.0;
real nan = inf - inf;
// cbrt(DBL_MAX)。这一层没有 cbrt，用 `^` —— 末位可能与 cbrt 差一两个 ulp，而它的用处是
// `abs(x) < infinity` 那种判断，差一个 ulp 不改答案。
real infinity = realMax ^ (1.0 / 3.0);
// 版本串：参照的那份源码是 3.14git（configure.ac 的 AC_INIT）。这是**我们的**串，
// 与机器上装的那个 asy 不一定一样 —— 拿它做判断的地方可能走不同分支，写在明处。
string VERSION = "3.14git";

// 中止（runtime.in:690 的 abort、:701 的 assert）。真 asy 的 `error(s)` 印到 **stderr**
// 并非零退出；这一层没有"中止"这条原语，所以用**越界读**触发方言的运行期错误 ——
// 消息文本不一样（那边形如 `f.asy: 3.5: user-specified error`），但"印出来 + 非零退出"
// 这两件事对上了。只走错误路径，正常路径上一个字都不印。
void abort(string s="") {
  if (s == "") write("abort");
  else write("abort: " + s);
  int[] die;
  int dead = die[0];   // 越界：方言在这里报运行期错误并非零退出
  write(dead);
}

void assert(bool b, string s="") {
  if (b) return;
  if (s == "") abort("assert FAILED");
  else abort("assert FAILED: " + s);
}

// path 的那几个纯查询搬到 struct path 之后（类型名顺序解析，这里还看不见 path）

// minbound / maxbound：逐分量取小/取大（pair.h 与 triple.h 的 minbound/maxbound）。
// 逐分量写开而不调 min/max —— 那两个声明在这一份的后面，而名字解析是顺序的。
pair minbound(pair a, pair b) {
  real x = a.x; if (b.x < x) x = b.x;
  real y = a.y; if (b.y < y) y = b.y;
  return (x, y);
}
pair maxbound(pair a, pair b) {
  real x = a.x; if (b.x > x) x = b.x;
  real y = a.y; if (b.y > y) y = b.y;
  return (x, y);
}
triple minbound(triple a, triple b) {
  real x = a.x; if (b.x < x) x = b.x;
  real y = a.y; if (b.y < y) y = b.y;
  real z = a.z; if (b.z < z) z = b.z;
  return (x, y, z);
}
triple maxbound(triple a, triple b) {
  real x = a.x; if (b.x > x) x = b.x;
  real y = a.y; if (b.y > y) y = b.y;
  real z = a.z; if (b.z > z) z = b.z;
  return (x, y, z);
}

// concat：把几条数组接起来（array.cc 的 arrayConcat 收任意多条、任意元素类型；
// 这一层没有泛型，所以按用到的元素类型各写一份，两条实参那一档）
real[] concat(real[] a, real[] b) {
  real[] out;
  for (real x : a) out.push(x);
  for (real x : b) out.push(x);
  return out;
}
int[] concat(int[] a, int[] b) {
  int[] out;
  for (int x : a) out.push(x);
  for (int x : b) out.push(x);
  return out;
}
pair[] concat(pair[] a, pair[] b) {
  pair[] out;
  for (pair x : a) out.push(x);
  for (pair x : b) out.push(x);
  return out;
}
string[] concat(string[] a, string[] b) {
  string[] out;
  for (string x : a) out.push(x);
  for (string x : b) out.push(x);
  return out;
}

// sgn：量过 sgn(-3.5)=-1、sgn(0.0)=0、sgn(2.1)=1，回的是 int
int sgn(real x) {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

// 弧度/度。real 那一版**不**归一化（量过 degrees(-pi/2) = -90）
real degrees(real r) { return r * 180 / pi; }
real radians(real d) { return d * pi / 180; }

// pair 那一版归一化到 [0,360)（量过：(0,1)->90、(-1,0)->180、(0,-1)->270、
// (-1,-1)->225、(1,-1)->315）。`warn` 在真 asy 那边只管零向量要不要出警告，
// 我们这一刀不出警告，所以它只是把签名对上（graph.asy 里 `degrees(dir,warn=false)`）。
real degrees(pair z, bool warn = true) {
  real a = degrees(atan2(z.y, z.x));
  if (a < 0) a = a + 360;
  return a;
}

// copy：深拷一份（量过 `int[] b=copy(a); b[0]=99;` 之后 a[0] 还是原值）。
// 这里**不写** real[] / int[] / bool[] 那三份手抄的了 —— 降级那一层的 arrCopyHelper
// 是照元素类型现生的通用版，还捎带 `cyclic`（量过真 asy：`b=copy(a)` 之后 b.cyclic 也是
// true，`real[][]` 的内层行同样）。手抄的那三份会把通用版**盖掉**，于是
// `copy` 出来的那份丢了 cyclic —— sphere.asy 就死在 three_surface.asy:1633 的
// `array index out of range: 1 (length 1)` 上。

// search：**最后一个 <= key 的下标**，key 比首元素还小给 -1
// （量过 {1,3,5,7,9}：key=5 -> 2、key=6 -> 2、key=0 -> -1、key=100 -> 4）
int search(real[] a, real key) {
  int lo = -1;
  int hi = a.length;
  while (hi - lo > 1) {
    int mid = (lo + hi) # 2;
    if (a[mid] <= key) lo = mid; else hi = mid;
  }
  return lo;
}

// sequence(n) = 0..n-1；sequence(a,b) = a..b（两头都要，a>b 给空数组）
// 量过：sequence(4)={0,1,2,3}、sequence(1,5)={1,2,3,4,5}、sequence(3,3)={3}、
// sequence(4,2)={}。带函数实参的那两个重载要匿名函数（`new real(int){…}`），还在门外。
int[] sequence(int n) {
  int[] a;
  for (int i = 0; i < n; ++i) a.push(i);
  return a;
}
int[] sequence(int a, int b) {
  int[] r;
  for (int i = a; i <= b; ++i) r.push(i);
  return r;
}

// ---------------------------------------------------------------- transform
// 仿射变换。asy 的 transform 是 6 个 real：平移 (x,y) 加 2x2 的 (xx,xy;yx,yy)，
// 作用在点上是 `(x + xx*px + xy*py, y + yx*px + yy*py)`（量过 shift(3,4)*(1,1) = (4,5)）。
// **字段默认值就是恒等**：base 的 plain_constants.asy 里写的是 `restricted transform
// identity;` —— 不带初值，靠的就是"transform 的零值是恒等"这条（量过 identity*(7,8)
// 还是 (7,8)）。所以 identity 那个**变量**由 base 给，这里只给类型与那几个构造函数。
struct transform {
  real x = 0;
  real y = 0;
  real xx = 1;
  real xy = 0;
  real yx = 0;
  real yy = 1;
}

transform xform(real x, real y, real xx, real xy, real yx, real yy) {
  transform t;
  t.x = x; t.y = y; t.xx = xx; t.xy = xy; t.yx = yx; t.yy = yy;
  return t;
}

transform identity() { return xform(0, 0, 1, 0, 0, 1); }

transform shift(real x, real y) { return xform(x, y, 1, 0, 0, 1); }
transform shift(pair z) { return xform(z.x, z.y, 1, 0, 0, 1); }

// 量过：scale(2) 是 xx=yy=2，xscale/yscale 只动一个方向
transform scale(real s) { return xform(0, 0, s, 0, 0, s); }
transform scale(real sx, real sy) { return xform(0, 0, sx, 0, 0, sy); }
transform xscale(real s) { return xform(0, 0, s, 0, 0, 1); }
transform yscale(real s) { return xform(0, 0, 1, 0, 0, s); }

// slant（runtime.in:1219 -> transform.h 的 slant）：量过 slant(2) 是 (0,0,1,2,0,1)
transform slant(real s) { return xform(0, 0, 1, s, 0, 1); }

// 量过 rotate(90)：xx=6.12323399573677e-17（cos 90° 的双精度值，不是 0）、xy=-1、yx=1
transform rotate(real angle) {
  real c = cos(radians(angle));
  real s = sin(radians(angle));
  return xform(0, 0, c, -s, s, c);
}

// 作用在点上；先摆出来是因为绕点旋转要用它。
// **量过一次、退回来了**：参考那份 asy 的这一句（transform.h:71）被 clang 合成了 4 条
// fmadd（`clang++ -O2 -S` 单独编这一句就能看到），照它换成精确 fma（Dekker）之后
// laserlattice 的帧 min.x **一个 bit 都没动**（还是 -146.6010968244085 对参考的
// …847）—— 那个 ulp 不在这一句上。别再从这里试。
pair operator *(transform t, pair p) {
  return (t.x + t.xx * p.x + t.xy * p.y, t.y + t.yx * p.x + t.yy * p.y);
}

// 精确的 `a*b + c`（**一次**舍入）：Dekker 拆分求准确积，再 two-sum 把尾巴收回来。
// 为什么要它：clang 在 arm64 上把 `a*b + c*d` 这类式子收缩成一条 fmadd（一次舍入），
// 我们这边是两次 —— 差在最后一位。追到的一处（两侧同一份源码的尺子 inv2.asy，
// `t=scale(1.234567)*rotate(17)*shift(3,4)`）：`inverse(t).x` asy 是
// -3.0000000000000004、我们是 -2.9999999999999996，六个数里只有这一个不同；
// 于是 `t*inverse(t)` asy 留 1e-18 的零头、我们是精确的 0，
// `!pentype.getTransform().isIdentity()`（drawelement.h:322）那道闸门就一边开一边关，
// laserlattice 整份 EPS 于是"结构不同"。
private real asy__fma(real a, real b, real c) {
  real p = a * b;
  real SPLIT = 134217729;                 // 2^27 + 1
  real ca = SPLIT * a; real ah = ca - (ca - a); real al = a - ah;
  real cb = SPLIT * b; real bh = cb - (cb - b); real bl = b - bh;
  real e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;   // p + e == a*b（精确）
  real s = p + c;
  real bs = s - p;
  real t = (p - (s - bs)) + (c - bs);                       // s + t == p + c（精确）
  return s + (t + e);
}

// 复合：`(s*sc)*p == s*(sc*p)`（量过 shift(3,4)*scale(2) 作用在 (1,1) 上是 (5,6)）
// 六格都按 **fma** 的口径算（transform.h:77 在 arm64 上被收缩成 fmadd）：
// 平移那两格是 `t.x + t.xx*s.x + t.xy*s.y`，从左往右两次收缩；四个矩阵格是
// `a*b + c*d`，后一个乘法收进加法。判据见 asy__fma 上面那段（`t*inverse(t)` 的零头）。
transform operator *(transform a, transform b) {
  return xform(
    asy__fma(a.xy, b.y, asy__fma(a.xx, b.x, a.x)),
    asy__fma(a.yy, b.y, asy__fma(a.yx, b.x, a.y)),
    asy__fma(a.xx, b.xx, a.xy * b.yx),
    asy__fma(a.xx, b.xy, a.xy * b.yy),
    asy__fma(a.yx, b.xx, a.yy * b.yx),
    asy__fma(a.yx, b.xy, a.yy * b.yy));
}

// 绕一点转：先挪到原点、转、再挪回去（量过 rotate(90,(1,1))*(2,1) = (1,2)）
transform rotate(real angle, pair z) {
  return shift(z) * rotate(angle) * shift(-z);
}

// 关于一条直线镜像。量过 reflect((0,0),(1,1)) 是 (xx,xy;yx,yy) = (0,1;1,0)
transform reflect(pair a, pair b) {
  pair d = b - a;
  real n = d.x * d.x + d.y * d.y;
  real xx = (d.x * d.x - d.y * d.y) / n;
  real xy = 2 * d.x * d.y / n;
  transform m = xform(0, 0, xx, xy, xy, -xx);
  return shift(a) * m * shift(-a);
}

// 去掉平移那一半（量过 shiftless(shift(1,2)*scale(3)) 的 x/y 是 0、xx/yy 还是 3）
transform shiftless(transform t) {
  return xform(0, 0, t.xx, t.xy, t.yx, t.yy);
}

// transform.h:128-138 照抄，**一个字都不能改写**：那边先取倒数 `d=1.0/det` 再一路乘，
// 不是逐项去除；平移那两格也是自己的式子 `(xy*y-yy*x)*d`，不是"求逆的线性部分再取负"。
// 差别就在末位一个 ulp 上，而这个 ulp 会顺着 graph 的迭代放大：量过 spline 的
// `inverse(scale(84.84,19.96))`，yy 是 …3843923（照抄）对 …3843924（先除），
// 再迭代两轮之后 x 方向的比例从 76.8297643074162 走成了 76.8297643074111。
// 顺带把 -0 那一格也对上了：`(xy*y-yy*x)*d` 在 x=y=0 时给 +0，而 `-(ixx*x+ixy*y)` 给 -0。
transform inverse(transform t) {
  real d = asy__fma(t.xx, t.yy, -(t.xy * t.yx));
  d = 1.0 / d;
  return xform(asy__fma(t.xy, t.y, -(t.yy * t.x)) * d,
               asy__fma(t.yx, t.x, -(t.xx * t.y)) * d,
               t.yy * d, -t.xy * d, -t.yx * d, t.xx * d);
}

// 变换的幂：n 次复合，0 是 identity、负数先求逆。**从 identity 起乘**（不是从 t 起），
// 这一点量得出来：`shift((1,2))^-1` 是 (-1,-2,1,0,0,1)，而 `inverse(shift((1,2)))` 是
// (-1,-2,1,-0,-0,1) —— 差在那个 -0 上（identity 乘一遍时 `-0 + 0` 就成了 +0）。
// fjortoft.asy:15 的 `shift(s)^2*box(…)` 就是这一格。
transform operator ^(transform t, int n) {
  transform b = n < 0 ? inverse(t) : t;
  int k = n < 0 ? -n : n;
  transform r = xform(0, 0, 1, 0, 0, 1);
  for (int i = 0; i < k; ++i) r = r * b;
  return r;
}

// 变换相等是**逐分量**比（runtime.in 的 transformEquals）。我们的 struct 是引用类型，
// 默认的 `==` 比的是身份 —— 于是 base 里 `T == identity()`、`s == identity()`
// （plain_picture.asy:650/872/907）全会判错，所以这两支要显式给。
bool operator ==(transform a, transform b) {
  return a.x == b.x && a.y == b.y && a.xx == b.xx
      && a.xy == b.xy && a.yx == b.yx && a.yy == b.yy;
}

bool operator !=(transform a, transform b) { return !(a == b); }

// `real identity(real)` 是内建函数（builtin.cc:767/848 的 addRealFunc）——
// 跟 `transform identity()`、`real[][] identity(int)` 同名不同签名。
// plain_picture.asy:85 的 `scaleT(identity,identity)` 要的是这一支（scalefcn=real(real)）。
real identity(real x) { return x; }


// ---------------------------------------------------------------- pen
// asy 的 pen 是值类型，我们的 struct 是引用类型 —— 所以凡是"改一支笔"的地方都
// 先 pencopy。setwidth/setcolor 是 `p + q` 要的：q 显式设过的属性盖住 p 的那一份。
struct pen {
  real width = 0.5;
  real gray = 0;
  real red = 0;
  real green = 0;
  real blue = 0;
  bool isrgb = false;
  bool evenodd = false;
  int cap = 1;
  int join = 1;
  real miter = 10;
  bool setwidth = false;
  bool setcolor = false;
  // 第四十五刀加的那几格（pen.h 里都有）：现在只**存着**，EPS 那一路还没发它们 ——
  // 用到它们的图会与真 asy 不一样，写在明处（cases/40-draweps 那条量的是宽度与颜色）。
  int fillruleval = 0;
  int basealignval = 0;
  real opacityval = 1;
  string blend = "Compatible";
  // pen.h:126 的 `Transparency::isdefault`：`a+b` 里 b **设过**透明度才盖住 a
  // （pen.h:800 那一句 `q.transparency.isdefault ? p.transparency : q.transparency`）。
  bool transpset = false;
  bool iscmyk = false;
  real cyan = 0;
  real magenta = 0;
  real yellow = 0;
  real black = 0;
  bool isinvisible = false;
  string font = "";
  // 虚线那一族（pen.h 的 LineType：pattern/offset/scale/adjust）。EPS 那一路发的是
  // `[a b …] offset setdash`（psfile.cc:266-274），描边前先按弧长收一收节拍
  // （drawpath.cc:198 的 adjustdash）—— 见 setpen 与 emitop。
  // 与那边差一处：asy 的 `pen::linetype()` 在 `line.isdefault` 时读的是 **defaultpen 的**
  // 那一份，这一层没有 isdefault 这一格，一律读笔自己的（`defaultpen(dashed)` 之后
  // 那些没显式设过虚线的笔，我们当实线）。
  real[] dashpat;
  real dashoffset = 0;
  bool dashscale = true;
  bool dashadjust = true;
  // 「这支笔**显式设过**虚线」= asy 的 `LineType::isdefault == false`（pen.h:28/34）。
  // 光看 dashpat 是不是空的判不出来：`solid` 就是 `linetype(new real[])`（plain_pens.asy:4）——
  // 一份**空**的、但设过的 pattern。pen.h:790 的加法是 `q.line.isdefault ? p.line : q.line`，
  // 所以 `p+solid` 要把虚线**清掉**。少了这一格，plain_arrows.asy:205 的
  // `filltype.fill(f,head,p+solid)` 画出来的箭头还带着虚线节拍 —— mosquito 里参考发
  // `[] 0 setdash` 而我们发 `[8 8]`，一个例子里多出三处。
  bool dashset = false;
  // 笔自己的那个变换（pen.h 的 `pen::t`）：`transform * pen` 攒在这儿，min/max(pen) 用它。
  transform pentrans;
  bool hastrans = false;
  // 笔尖（pen.h 的 `pen::P`）在 asy__nibtab 里的下标，-1 是没有（见那张表旁边的注）。
  // 这里放不下一格 `path`：`struct path` 声明在这个 struct **后面**。
  int nibid = -1;
  // 图案的名字（pen.h 的 `pen::pattern`，patterns.asy 那一族用）：空串是没设过。
  // 设了它就没有颜色道了（量过 `colors(pattern("chk")).length` 是 0、
  // `colors(red+pattern("chk")).length` 也是 0），见 colors / colorspace 那两条。
  string patternval = "";
  // 字号（pen.h 的 `pen::size`）。默认是 12pt 换成 bp 的那个数。
  // **不能**写成抄下来的十进制字面量 `11.9551681195517` —— 那是 write() 印出来的
  // 15 位，末位比真值大 1.7e-14（约 10 个 ulp）。这个数会经 drawlabel.cc:130 的
  // `fuzz=pentype.size()*0.1+0.3` 进标签的界，再顺着 plain_scaling 的单纯形把
  // 解出的 a 推歪，%%BoundingBox 整整差 1bp。写成算式，逐位就是那边的
  // `fontsize*(72.0/72.27)`。asy__tex2ps 声明在后面（名字按位置解析），这里只能重写一遍。
  real fontsizeval = 12.0 * (72 / 72.27);
  // pen.h:167/168 那两格**原样**：没设过就是 0（文字输出只在非零时印它们，见 pen.h:893）。
  // fontsizeval 存的是"实际按哪个字号排"，与它不是一回事。
  real fontsizeset = 0;
  real lineskipval = 0;
}

pen pencopy(pen p) {
  pen q;
  q.width = p.width;
  q.gray = p.gray;
  q.red = p.red;
  q.green = p.green;
  q.blue = p.blue;
  q.isrgb = p.isrgb;
  q.evenodd = p.evenodd;
  q.cap = p.cap;
  q.join = p.join;
  q.miter = p.miter;
  q.setwidth = p.setwidth;
  q.setcolor = p.setcolor;
  q.dashpat = copy(p.dashpat);
  q.dashoffset = p.dashoffset;
  q.dashset = p.dashset;
  q.dashscale = p.dashscale;
  q.dashadjust = p.dashadjust;
  q.pentrans = p.pentrans;
  q.hastrans = p.hastrans;
  q.nibid = p.nibid;
  q.fontsizeval = p.fontsizeval;
  q.fontsizeset = p.fontsizeset;
  q.lineskipval = p.lineskipval;
  q.patternval = p.patternval;
  q.font = p.font;
  q.fillruleval = p.fillruleval;
  q.basealignval = p.basealignval;
  q.opacityval = p.opacityval;
  q.blend = p.blend;
  q.transpset = p.transpset;
  q.iscmyk = p.iscmyk;
  q.cyan = p.cyan;
  q.magenta = p.magenta;
  q.yellow = p.yellow;
  q.black = p.black;
  q.isinvisible = p.isinvisible;
  return q;
}

// defaultpen 那一格（processData().defaultpen）。asy 那边 `defaultpen` 是**函数**不是变量，
// 所以这一格叫别的名字，读写走下面 defaultpen() / defaultpen(pen)。
pen asy__defpen;
pen currentpen;

// 字号/行距是**用的时候才落地**的（pen.h:433 的 `size()` 与 :463 的 `Lineskip()`）：
// 笔自己那一格是 0 就读 **defaultpen 的**那一份。这一层的 `fontsizeval` 是构造时就算好的
// denormalized 值 —— 于是 `currentpen`（声明那一刻就冻住 12pt）在
// `defaultpen(fontsize(8pt))` 之后还是 12pt，mosquito 的每个标签都印
// `\fontsize{12.000000}`、字体挑成 CMSY10 而参考是 CMSY8。
// 所以凡是 asy 那边写 `p.size()` / `p.Lineskip()` 的地方都走这两个，别直接读那一格。
real asy__psize(pen p) {
  if (p.fontsizeset != 0) return p.fontsizeset;
  return asy__defpen.fontsizeset != 0 ? asy__defpen.fontsizeset : asy__defpen.fontsizeval;
}
real asy__plskip(pen p) {
  if (p.lineskipval != 0) return p.lineskipval;
  return asy__defpen.lineskipval != 0 ? asy__defpen.lineskipval : 1.2 * asy__defpen.fontsizeval;
}
// `Font()`（pen.h:437-444）同样两层：笔上没设过就问 defaultpen，两边都空才是那串默认命令。
string asy__pfont(pen p) {
  if (p.font != "") return p.font;
  if (asy__defpen.font != "") return asy__defpen.font;
  return "\usefont{\ASYencoding}{\ASYfamily}{\ASYseries}{\ASYshape}";
}

pen linewidth(real w) {
  pen q = pencopy(asy__defpen);
  q.width = w;
  q.setwidth = true;
  return q;
}

// 颜色分量进来先**削一遍**（pen.h:188 的 pos0 与 :190/:192 的 greyrange/rgbrange）：
// 负的当 0，饱和度超过 1 的整组按 1/sat 缩回去。量出来的（roundpath.asy:29 那一圈
// `rgb(i*0.024, 1-i*0.024, 0)`，i 到 42 之后绿分量是负的）：真 asy 印的是 `1 0 0`，
// 而且**之后 7 圈一句颜色都不印** —— 削完全都一样，psfile 那边就省掉了。
private real asy__pos0(real x) { return x >= 0 ? x : 0; }

pen gray(real g) {
  pen q = pencopy(asy__defpen);
  real y = asy__pos0(g);
  if (y > 1.0) y = 1.0;
  q.gray = y;
  q.isrgb = false;
  q.setcolor = true;
  return q;
}

pen rgb(real r, real g, real b) {
  pen q = pencopy(asy__defpen);
  real x = asy__pos0(r);
  real y = asy__pos0(g);
  real z = asy__pos0(b);
  real sat = x;
  if (y > sat) sat = y;
  if (z > sat) sat = z;
  if (sat > 1.0) { real s = 1.0 / sat; x = x * s; y = y * s; z = z * s; }
  q.red = x;
  q.green = y;
  q.blue = z;
  q.isrgb = true;
  q.setcolor = true;
  return q;
}

pen evenodd() {
  pen q = pencopy(asy__defpen);
  q.evenodd = true;
  return q;
}

// `p + q`：q 显式设过的属性盖住 p 的那一份（asy 的 pen 加法就是这个意思）。
// "设过没有"的判据照 pen.h:790 那一串 —— 各字段自己的默认值就是哨兵
// （linewidth 0.5、linecap 1、linejoin 1、miterlimit 10、fontsize/lineskip 0、
// fillrule 0、baseline 0、font 空、虚线表空）。颜色这一格仍是"盖住"而不是 asy 的
// **相加再夹**（pen.h:749 那个 switch），两支都带颜色时结果会不一样，写在明处。
// 颜色空间在这一层是几个 bool 拼出来的，这里换算成 pen.h:84 那个 enum 的序号
// （DEFCOLOR 0 / INVISIBLE 1 / GRAYSCALE 2 / RGB 3 / CMYK 4 / PATTERN 5）——
// 两支笔相加时"取大的那一档"要按它比。
private int asy__pcs(pen p) {
  if (p.patternval != "") return 5;
  if (p.isinvisible) return 1;
  if (p.iscmyk) return 4;
  if (p.isrgb) return 3;
  if (p.setcolor) return 2;
  return 0;
}
// 一支笔升到 cmyk 那一档（pen.h:602 的 greytocmyk 与 :608 的 rgbtocmyk）。
// 没设过颜色的那一支四道都是 0（asy 那边 DEFCOLOR 的 r/g/b/grey 就是 0）。
private real[] asy__tocmyk(pen p, int cs) {
  real[] v;
  if (cs == 4) { v.push(p.cyan); v.push(p.magenta); v.push(p.yellow); v.push(p.black); return v; }
  if (cs == 2) { v.push(0); v.push(0); v.push(0); v.push(1 - p.gray); return v; }
  if (cs == 3) {
    real sat = p.red;
    if (p.green > sat) sat = p.green;
    if (p.blue > sat) sat = p.blue;
    if (sat == 0) { v.push(0); v.push(0); v.push(0); v.push(1); return v; }
    v.push(1 - p.red / sat);
    v.push(1 - p.green / sat);
    v.push(1 - p.blue / sat);
    v.push(1 - sat);
    return v;
  }
  v.push(0); v.push(0); v.push(0); v.push(0);
  return v;
}
pen operator +(pen a, pen b) {
  pen q = pencopy(a);
  if (b.setwidth) {
    q.width = b.width;
    q.setwidth = true;
  }
  // 颜色是**相加再夹**（pen.h:739 那个 switch），不是"右边盖住左边"：颜色空间取两支里
  // 大的那一档、各自先升上去、分量逐个相加，超饱和了整体缩回来（rgbrange / cmykrange）。
  // 量出来的理由：PythagoreanTree.asy 的 `1/(n+1)*green + n/(n+1)*brown` —— 盖住那一版
  // 只剩 brown 那一支，绿色那 1/13 凭空消失（参考印 `0.461538 0.0769231 0`，
  // 盖住版印 `0.461538 0 0`）。
  int ca = asy__pcs(a);
  int cb = asy__pcs(b);
  int cs = ca > cb ? ca : cb;
  if (cs == 2) {
    real g2 = a.gray + b.gray;
    if (g2 > 1.0) g2 = 1.0;
    q.gray = g2;
    q.isrgb = false;
    q.iscmyk = false;
    q.setcolor = true;
  } else if (cs == 3) {
    // 灰的那一支升成 rgb（三道都等于灰度）；没设过颜色的那一支三道都是 0
    real ar = a.isrgb ? a.red : (ca == 2 ? a.gray : 0);
    real ag = a.isrgb ? a.green : (ca == 2 ? a.gray : 0);
    real ab = a.isrgb ? a.blue : (ca == 2 ? a.gray : 0);
    real br = b.isrgb ? b.red : (cb == 2 ? b.gray : 0);
    real bg = b.isrgb ? b.green : (cb == 2 ? b.gray : 0);
    real bb = b.isrgb ? b.blue : (cb == 2 ? b.gray : 0);
    real r = ar + br;
    real g = ag + bg;
    real bl = ab + bb;
    real sat = r;
    if (g > sat) sat = g;
    if (bl > sat) sat = bl;
    if (sat > 1.0) { r = r / sat; g = g / sat; bl = bl / sat; }
    q.red = r;
    q.green = g;
    q.blue = bl;
    q.isrgb = true;
    q.iscmyk = false;
    q.setcolor = true;
  } else if (cs == 4) {
    real[] u = asy__tocmyk(a, ca);
    real[] v = asy__tocmyk(b, cb);
    real c = u[0] + v[0];
    real m = u[1] + v[1];
    real y = u[2] + v[2];
    real k = u[3] + v[3];
    real sat = c;
    if (m > sat) sat = m;
    if (y > sat) sat = y;
    if (k > sat) sat = k;
    if (sat > 1.0) { c = c / sat; m = m / sat; y = y / sat; k = k / sat; }
    q.cyan = c;
    q.magenta = m;
    q.yellow = y;
    q.black = k;
    q.iscmyk = true;
    q.isrgb = false;
    q.setcolor = true;
  }
  if (b.evenodd) q.evenodd = true;
  // 透明度照 pen.h:800：右边设过才盖住左边（默认那一格不算"设过"）
  if (b.transpset) {
    q.opacityval = b.opacityval;
    q.blend = b.blend;
    q.transpset = true;
  }
  if (b.cap != 1) q.cap = b.cap;
  if (b.join != 1) q.join = b.join;
  if (b.miter != 10) q.miter = b.miter;
  if (b.dashset) {
    q.dashpat = copy(b.dashpat);
    q.dashoffset = b.dashoffset;
    q.dashscale = b.dashscale;
    q.dashadjust = b.dashadjust;
    q.dashset = true;
  }
  if (b.font != "") q.font = b.font;
  if (b.fontsizeset != 0) {
    q.fontsizeset = b.fontsizeset;
    q.fontsizeval = b.fontsizeval;
  }
  if (b.lineskipval != 0) q.lineskipval = b.lineskipval;
  // 图案（pen.h 里图案就是一种颜色空间，见 pattern 那两条）：右边设过就盖住左边
  if (b.patternval != "") q.patternval = b.patternval;
  if (b.fillruleval != 0) q.fillruleval = b.fillruleval;
  if (b.basealignval != 0) q.basealignval = b.basealignval;
  if (b.isinvisible) q.isinvisible = true;
  if (b.hastrans) {
    q.pentrans = b.pentrans;
    q.hastrans = true;
  }
  return q;
}

pen black = gray(0);
pen white = gray(1);
pen red = rgb(1, 0, 0);
pen green = rgb(0, 1, 0);
pen blue = rgb(0, 0, 1);
pen cyan = rgb(0, 1, 1);
pen magenta = rgb(1, 0, 1);
pen yellow = rgb(1, 1, 0);
pen orange = rgb(1, 0.5, 0);
pen purple = rgb(0.5, 0, 1);

// ---------------------------------------------------------------- path
// asy 的 path 是 solvedKnot 的数组 + cycles 标志（path.h）。这里照搬：
// pre/point/post 三个控制点，straight 说"这一段是直线"（两端张力都正好是 1 时
// psfile 发的是 lineto 而不是 curveto，drawpath.cc 那边就是这么判的）。
struct knot {
  pair pre;
  pair point;
  pair post;
  bool straight = false;
  // 这个结点两侧的**连接规格**（第四十六刀）—— asy 那边是 knot::in / knot::out 两个
  // spec 指针（knot.h:212）。0 = open（留给求解器）、1 = `{curl c}`（c 在 …val 里）、
  // 2 = `{z}` 给定方向（角度在 …val 里）。编号与下面那个 private struct spec 的 kind 同。
  int inkind = 0;
  real inval = 1;
  int outkind = 0;
  real outval = 1;
  // 两侧的张力（knot.h:212 的 tin/tout）：alpha = 1/tout、beta = 1/tin（knot.h:219）。
  real tout = 1;
  real tin = 1;
  bool tatout = false;
  bool tatin = false;
}

struct path {
  knot[] nodes;
  bool cyclic = false;
  // 每一段是怎么连上的（`joins.length` == 段数）：0 = `--`（直线）、1 = `..`（要解）、
  // 2 = 控制点已经定了（照 nodes 里存的那两个走）。asy 的 guide 是**没解**的规格、path 是
  // 解好的，而这一层 `guide` 就是 `path`，所以解好的控制点与"怎么连的"两份都得留着：
  // `a..b..c` 每加一段都把整条链重解一遍（knot.cc:solve 也是整条一起解，逐段解出来的
  // 控制点不一样）。段数与这张表不齐时（subpath / nib 这种自己摆控制点的），一律按 2 走。
  int[] joins;
  // `cycle` 那个字面量：它不是路径，是**连接时的记号**。前端把 `cycle` 解析成下面那个
  // `cyclepath`（`cycle` 自己是 LIT，asy 源码里声明不出这个名字），`a--cycle` 于是就是
  // `operator --(path, path)` 见到一个带记号的右操作数。这是前端与绘图层之间唯一的约定名。
  bool ismark = false;
  // 这一格 path 其实是个**连接规格**（第四十五刀）。asy 的 guide 是一棵树，`{z}`、
  // `{curl c}`、`tension`、`controls` 都是树上的结点，`guide operator cast(…)`
  // （runtime.in:880/905）把它们变成 guide；这一层 guide 就是 path，所以那些结点也得
  // 是 path。0 = 不是规格、1 = `{z}` 方向、2 = `{curl c}`、3 = `tension`、4 = `controls`。
  //   1 用 spz0；2 用 spa（gamma）与 spside；3 用 spa/spb（两端张力）与 spat；4 用 spz0/spz1。
  // spside 是 camp.y 那两个 JOIN_OUT/JOIN_IN（0/1）。
  int spkind = 0;
  pair spz0;
  pair spz1;
  real spa = 1;
  real spb = 1;
  bool spat = false;
  int spside = 0;
  // **等着挂给下一个结**的那几格（第四十六刀）。折叠成二元连接之后，`a{d1}..tension t..{d2}b`
  // 是 `((a .. d1) .. t) .. d2) .. b` 四步，前三步收到的规格要留到最后那一步 —— 因为它们
  // 说的是"下一段"与"下一个结的进侧"。asy 那边这份状态在 flatguide 里。
  int pinkind = 0;   // 下一个结的进侧规格（1 = curl、2 = 方向）
  real pinval = 1;
  real ptout = 1;    // 下一段两端的张力
  real ptin = 1;
  bool ptat = false;
  int pctl = 0;      // 下一段的控制点定死了（`controls c0 and c1`）
  pair pc0;
  pair pc1;
}

path cyclepath;
cyclepath.ismark = true;

// `guide` 在 asy 那边是"还没解出来的路径规格"（一棵树），`path` 是解好的，两者之间有隐式
// 转换。这一层让 guide 就是 path 的别名：规格不是攒在一棵树上，而是**边连边记**（结上的
// inkind/outkind/tout/tin 加上 path 上那几格 pending），每接上一个结整条链重解一遍。
// 量出来的理由：asy 那边"摊平成 flatguide 再一次解完"与"每步重解"落在同一个地方 ——
// tests/asy/cases/124-join-specs 的十条与 `asy -noV` 逐字节一致。
typedef path guide;

// 空路径：`nullpath` 是 asy 的内建名，`g--nullpath` 与 `nullpath--g` 都是恒等
path nullpath;

knot knotat(pair z) {
  knot k;
  k.pre = z;
  k.point = z;
  k.post = z;
  return k;
}

path pathof(pair z) {
  path g;
  g.nodes.push(knotat(z));
  return g;
}

int length(path g) {
  if (g.cyclic) return g.nodes.length;
  return g.nodes.length - 1;
}

int size(path g) { return g.nodes.length; }

// 结点下标（path.h:44 的 adjustedIndex）：闭合路径上绕圈取模，开路径上**两头夹住** ——
// 越界不是错，是"回最近那个端点"。量出来的：feynman.asy:165 的 `point(p, size(p))`
// 里 size(p) 正好是结点数（开路径），那一句在真 asy 那边回的是最后一个点，
// 我们从前直接下标越界（fermi.asy 报 "array index out of range: 4 (length 4)"）。
// 空路径两边都是 `nullpath has no points`（path.h:42 的 checkEmpty，量过错话一致）。
private int asy__nwrap(path g, int i) {
  int n = g.nodes.length;
  if (n == 0) abort("nullpath has no points");
  if (g.cyclic) {
    int k = i % n;
    return k < 0 ? k + n : k;
  }
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}

// path.h 里是成员函数，asy 那边是自由函数
bool cyclic(path g) { return g.cyclic; }
path[] concat(path[] a, path[] b) {
  path[] out;
  for (path x : a) out.push(x);
  for (path x : b) out.push(x);
  return out;
}

pair point(path g, int i) { return g.nodes[asy__nwrap(g, i)].point; }

// path.h 的 precontrol/postcontrol：结点两侧那两个控制点
pair precontrol(path g, int i) { return g.nodes[asy__nwrap(g, i)].pre; }
pair postcontrol(path g, int i) { return g.nodes[asy__nwrap(g, i)].post; }

// runpath.in:152 → path.h:167 `path::straight(t)`：第 t 段是不是直线段。
// 非闭合路径**越界回 false**（那边就是 `t >= 0 && t < n ? … : false`，n 是结点数），
// 闭合的走 imod（我们的 `%` 符号跟着除数，n 是正的，与 imod 同）。
// 位置靠前是给 windingnumber 用的 —— 这一层的名字解析是顺序的。
bool straight(path p, int t) {
  int n = p.nodes.length;
  if (n == 0) return false;
  if (p.cyclic) return p.nodes[t % n].straight;
  if (t < 0 || t >= n) return false;
  return p.nodes[t].straight;
}

knot knotcopy(knot k) {
  knot j;
  j.pre = k.pre;
  j.point = k.point;
  j.post = k.post;
  j.straight = k.straight;
  j.inkind = k.inkind;
  j.inval = k.inval;
  j.outkind = k.outkind;
  j.outval = k.outval;
  j.tout = k.tout;
  j.tin = k.tin;
  j.tatout = k.tatout;
  j.tatin = k.tatin;
  return j;
}

// path 在 asy 那边是值类型；我们的 struct 是引用类型，所以每个连接都先复制一份，
// 不然 `path h = g--(1,1);` 会把 g 一起改掉。
path pathcopy(path g) {
  path h;
  h.cyclic = g.cyclic;
  for (int i = 0; i < g.nodes.length; ++i) h.nodes.push(knotcopy(g.nodes[i]));
  for (int i = 0; i < g.joins.length; ++i) h.joins.push(g.joins[i]);
  h.spkind = g.spkind;
  h.spz0 = g.spz0;
  h.spz1 = g.spz1;
  h.spa = g.spa;
  h.spb = g.spb;
  h.spat = g.spat;
  h.spside = g.spside;
  h.pinkind = g.pinkind;
  h.pinval = g.pinval;
  h.ptout = g.ptout;
  h.ptin = g.ptin;
  h.ptat = g.ptat;
  h.pctl = g.pctl;
  h.pc0 = g.pc0;
  h.pc1 = g.pc1;
  return h;
}

// 结点下标：闭合路径上它是绕圈的（asy 的 path::point 对 cycles 取模），开路径上原样。
// path.cc:321 的 path::reverse：结点倒着排（第 i 个取原来的 j = len - i），pre 与 post
// 互换，而 straight 是挂在**左端**那个结上的，所以倒过来第 i 个结的 straight 取原来
// 第 j-1 段的那一格。plain_arrows.asy:192/218/260/283、plain_filldraw.asy:41、
// plain_picture.asy:1435 都在用它。
path reverse(path g) {
  path h;
  h.cyclic = g.cyclic;
  int n = g.nodes.length;
  if (n == 0) return h;
  int len = length(g);
  for (int i = 0; i < n; ++i) {
    int j = len - i;
    knot a = g.nodes[asy__nwrap(g, j)];
    knot k;
    k.pre = a.post;
    k.point = a.point;
    k.post = a.pre;
    // 开路径的最后一个结左边没有段（j-1 == -1），那一格照 asy 是 false
    k.straight = g.cyclic || j > 0 ? g.nodes[asy__nwrap(g, j - 1)].straight : false;
    h.nodes.push(k);
  }
  // "怎么连的"那张表也倒过来：倒过来第 i 段是原来第 len-1-i 段
  if (g.joins.length == len) {
    for (int i = 0; i < len; ++i) h.joins.push(g.joins[len - 1 - i]);
  }
  return h;
}

// 直线段：控制点按 asy 的存法摆在三等分点上，straight 挂在**左**端那个结上
// （psfile 见到它发 lineto，见 psfile.h:303 那一段）。
void pushstraight(path g, pair z) {
  int n = g.nodes.length;
  pair a = g.nodes[n - 1].point;
  knot k = knotat(z);
  g.nodes[n - 1].straight = true;
  g.nodes[n - 1].post = a + (z - a) / 3;
  k.pre = z - (z - a) / 3;
  g.nodes.push(k);
}

// `pair` 出现在要 path 的位置就是一个单点路径。真 asy 里这条是
// `guide operator cast(pair)`（builtin.cc 那张 cast 表），我们还没有 guide，所以落在 path 上。
//
// **只有这一条**加上下面那一份 `operator --(path, path)`，不写 pair 那三种重载 —— 量出来的
// 理由：写了的话 `1 -- 2` 会在"用户的 operator --(real,real)"与"我们的 (pair,pair)"之间
// 打平（int->real 与 int->pair 都是一次转换），而真 asy 那边 `1 -- 2` 是走用户那份的。
// 走 cast 就自动对上了：int -> pair -> path 是**串两次**，第二十七刀刻意不收（asy 也不收）。
path operator cast(pair z) {
  return pathof(z);
}

// `path[] operator cast(path)`：真 asy 那边这一条在 **plain**（plain_paths.asy:44），
// 不在 C++ 内建面里。这一层也备一份 —— 不 import plain 时 `fill(g)` 这种写法要靠它，
// 而 import 了 plain 之后那边会声明**同签名**的一份把这里盖掉（同签名是替换）。
// 有了它，绘图层那几格"图上填充"的短路就都收 `path[]` 了，于是 plain 的同名那份
// （`void fill(picture pic=currentpicture, path[] g, pen p=currentpen)`）与这里
// 一样都要过一次转换 —— 打平之后取后声明的那份，也就是 plain 的。
// 少了这一步的样子（量过 yingyang.asy / 一堆例子）：`fill(circle(…))` 落在这一层的
// `fill(path)` 上，画进了**内建面自己那个 currentpicture**，谁也不印它，那一笔就凭空消失。
path[] operator cast(path p) {
  path[] r;
  r.push(p);
  return r;
}

// ------------------------------------------------------------ Hobby 求解器
// `a..b..c` 的控制点是解一组线性方程得出来的（MetaFont 的那套，asy 在 knot.h/knot.cc
// 里照搬）。这一段是那份代码的 asy 译本。每个结两侧的规格有 open（`..`）、curl（开路径的
// 两头，或者源码里写的 `{curl c}`）、dir（`{z}`，或者挨着一段已定控制点的那一侧由
// partnerUp 推出来）、control（`--`、`controls … and …`、已解好的段）四种；张力从
// 结上的 tout/tin 进方程（alpha = 1/tout、beta = 1/tin），见第四十六刀。
//
// 结的两侧规格。kind：0 open、1 curl（val 是 gamma）、2 dir（val 是角度）、3 control。
private struct spec {
  int kind = 0;
  real val = 1;
  pair cz;
  bool straight = false;
}

// knot.cc:98 的 niceAngle：y 正好是 0 时不看零的符号，免得 a..b..cycle 解出怪路径
private real asy__niceangle(pair z) {
  if (z.y == 0) return z.x >= 0 ? 0 : pi;
  return angle(z);
}

// knot.cc:104 的 reduceAngle
private real asy__reduceangle(real a) {
  if (a > pi) return a - 2 * pi;
  if (a < -pi) return a + 2 * pi;
  return a;
}

// knot.cc:61 的 velocity（MetaPost §131）。张力 `t` 进分母，`atLeast` 那一档再加一道
// 上界（knot.cc:82 的 boundedness condition）。
private real asy__velocityt(real theta, real phi, real t, bool atLeast) {
  real a = sqrt(2);
  real b = 1 / 16;
  real c = 1.5 * (sqrt(5) - 1);
  real d = 1.5 * (3 - sqrt(5));
  real st = sin(theta);
  real ct = cos(theta);
  real sf = sin(phi);
  real cf = cos(phi);
  real denom = t * (3 + c * ct + d * cf);
  real r = denom != 0 ? (2 + a * (st - b * sf) * (sf - b * st) * (ct - cf)) / denom : 4;
  if (r > 4) r = 4;
  if (atLeast) {
    real sine = sin(theta + phi);
    if ((st >= 0 && sf >= 0 && sine > 0) || (st <= 0 && sf <= 0 && sine < 0)) {
      real rmax = sf / sine;
      if (r > rmax) r = rmax;
    }
  }
  return r;
}

// 张力恒为 1、不带 atleast 的那一档（这一层大多数连接就是它）
private real asy__velocity(real theta, real phi) {
  return asy__velocityt(theta, phi, 1, false);
}

// knot.cc:402/433 的 ref + backsub：非闭合的一段，先消元成 theta[j] + post*theta[j+1] = aug，
// 再从后往前回代。方程个数 = 这一段的结点数。
private real[] asy__thetalinear(real[] epre, real[] epiv, real[] epost, real[] eaug) {
  int m = epiv.length;
  real[] rpost;
  real[] raug;
  real lastpost = 0;
  real lastaug = 0;
  for (int j = 0; j < m; ++j) {
    real piv = epiv[j];
    real ag = eaug[j];
    if (j > 0) {
      piv = piv - epre[j] * lastpost;
      ag = ag - epre[j] * lastaug;
    }
    lastpost = epost[j] / piv;
    lastaug = ag / piv;
    rpost.push(lastpost);
    raug.push(lastaug);
  }
  real[] th = new real[m];
  real lasttheta = 0;
  for (int j = m - 1; j >= 0; --j) {
    real t = j == m - 1 ? raug[j] : raug[j] - rpost[j] * lasttheta;
    th[j] = t;
    lasttheta = t;
  }
  return th;
}

// knot.cc:301/344/385 的 recalc + solveForTheta0 + backsubCyclic：闭合的那一档。
// 方程写成 theta[j] + post*theta[j+1] = aug + w*theta[0]，先把 theta[0] 解出来再回代。
private real[] asy__thetacyclic(real[] epre, real[] epiv, real[] epost, real[] eaug) {
  int n = epiv.length;
  real[] wpost = new real[n];
  real[] waug = new real[n];
  real[] ww = new real[n];
  // we[0] 先放个占位的 (post=0, aug=0, w=1)，最后再补上真的那一份
  real lp = 0;
  real la = 0;
  real lw = 1;
  for (int j = 1; j < n; ++j) {
    real piv = epiv[j] - epre[j] * lp;
    real ag = eaug[j] - epre[j] * la;
    real w = -epre[j] * lw;
    lp = epost[j] / piv;
    la = ag / piv;
    lw = w / piv;
    wpost[j] = lp;
    waug[j] = la;
    ww[j] = lw;
  }
  // 再走一步 j = n（n 就是 0）：把占位的那一份换成真的
  real piv0 = epiv[0] - epre[0] * lp;
  wpost[0] = epost[0] / piv0;
  waug[0] = (eaug[0] - epre[0] * la) / piv0;
  ww[0] = -epre[0] * lw / piv0;
  real a = 0;
  real b = 0;
  real c = 1;
  for (int j = 0; j < n; ++j) {
    a += c * waug[j];
    b += c * ww[j];
    c = -c * wpost[j];
  }
  real theta0 = a / (1 - (b + c));
  real[] th = new real[n];
  real lasttheta = theta0;
  for (int j = 1; j <= n; ++j) {
    int k = n - j;
    real t = -wpost[k] * lasttheta + waug[k] + ww[k] * theta0;
    th[k] = t;
    lasttheta = t;
  }
  return th;
}

// knot.cc:180/186 的 controlSpec::outPartner / inPartner：一侧的控制点定了，另一侧 open 时
// 那一侧就是"沿着这个方向"（控制点与结点重合时退成 curl）。别的规格自己就是自己的搭子。
private spec asy__outpartner(spec s, pair z) {
  if (s.kind != 3) return s;
  spec r;
  if (s.cz == z) { r.kind = 1; r.val = 1; return r; }
  r.kind = 2;
  r.val = asy__niceangle(z - s.cz);
  return r;
}
private spec asy__inpartner(spec s, pair z) {
  if (s.kind != 3) return s;
  spec r;
  if (s.cz == z) { r.kind = 1; r.val = 1; return r; }
  r.kind = 2;
  r.val = asy__niceangle(s.cz - z);
  return r;
}

// knot.cc:619 的 solveSection：非闭合的一段（结点 a..b），解出 theta 再摆控制点。
// 张力进来了（第四十六刀）：alpha = 1/tout、beta = 1/tin（knot.h:219），系数照 knot.cc
// 的 eqnprop::mid / curlSpec::eqnOut / eqnIn 原样写。
private void asy__solvesection(path g, spec[] si, spec[] so, int a, int b) {
  int m = b - a;
  if (m <= 0) return;
  pair[] z = new pair[m + 1];
  real[] alpha = new real[m + 1];
  real[] beta = new real[m + 1];
  for (int i = 0; i <= m; ++i) {
    knot k = g.nodes[asy__nwrap(g, a + i)];
    z[i] = k.point;
    alpha[i] = 1 / k.tout;
    beta[i] = 1 / k.tin;
  }
  pair[] dz = new pair[m + 1];
  real[] d = new real[m + 1];
  for (int i = 0; i < m; ++i) {
    dz[i] = z[i + 1] - z[i];
    d[i] = length(dz[i]);
  }
  real[] psi = new real[m + 1];
  for (int i = 1; i < m; ++i) psi[i] = asy__niceangle(dz[i] / dz[i - 1]);
  real[] epre = new real[m + 1];
  real[] epiv = new real[m + 1];
  real[] epost = new real[m + 1];
  real[] eaug = new real[m + 1];
  spec s0 = so[asy__nwrap(g, a)];
  if (s0.kind == 2) {
    epiv[0] = 1;
    eaug[0] = asy__reduceangle(s0.val - asy__niceangle(dz[0]));
  } else {
    real al = alpha[0];
    real be = beta[1];
    real chi = al * al * s0.val / (be * be);
    real C = al * chi + 3 - be;
    real D = (3 - al) * chi + be;
    epiv[0] = C;
    epost[0] = D;
    eaug[0] = -D * psi[1];
  }
  spec sm = si[asy__nwrap(g, b)];
  if (sm.kind == 2) {
    epiv[m] = 1;
    eaug[m] = asy__reduceangle(sm.val - asy__niceangle(dz[m - 1]));
  } else {
    real al = alpha[m - 1];
    real be = beta[m];
    real chi = be * be * sm.val / (al * al);
    epre[m] = (3 - be) * chi + al;
    epiv[m] = be * chi + 3 - al;
  }
  for (int j = 1; j < m; ++j) {
    real infac = 1 / (beta[j] * beta[j] * d[j - 1]);
    real A = alpha[j - 1] * infac;
    real B = (3 - alpha[j - 1]) * infac;
    real outfac = 1 / (alpha[j] * alpha[j] * d[j]);
    real C = (3 - beta[j + 1]) * outfac;
    real D = beta[j + 1] * outfac;
    epre[j] = A;
    epiv[j] = B + C;
    epost[j] = D;
    eaug[j] = -B * psi[j] - D * psi[j + 1];
  }
  bool homog = true;
  for (int j = 0; j <= m; ++j) if (eaug[j] != 0) homog = false;
  // knot.cc:597 的 encodeStraight：两个方程、两边都是 0 —— 那就是直着过去。
  // 张力不是 1 时**不算直线段**（那两个控制点各自往里收 1/tension，knot.cc:606 的 else 支）。
  if (m == 1 && homog) {
    pair step = (z[1] - z[0]) / 3;
    int ia = asy__nwrap(g, a);
    int ib = asy__nwrap(g, b);
    real at = g.nodes[ia].tout;
    real bt = g.nodes[ib].tin;
    if (at == 1 && bt == 1) {
      g.nodes[ia].straight = true;
      g.nodes[ia].post = z[0] + step;
      g.nodes[ib].pre = z[1] - step;
      return;
    }
    g.nodes[ia].straight = false;
    g.nodes[ia].post = z[0] + step / at;
    g.nodes[ib].pre = z[1] - step / bt;
    return;
  }
  real[] th = new real[m + 1];
  if (!homog) th = asy__thetalinear(epre, epiv, epost, eaug);
  real[] phi = new real[m + 1];
  for (int j = 0; j <= m; ++j) phi[j] = -psi[j] - th[j];
  for (int i = 0; i < m; ++i) {
    int ii = asy__nwrap(g, a + i);
    knot k = g.nodes[ii];
    g.nodes[ii].straight = false;
    // knot.cc:505：出侧那个控制点用**这个结的 tout**
    g.nodes[ii].post = z[i]
      + asy__velocityt(th[i], phi[i + 1], k.tout, k.tatout) * expi(th[i]) * dz[i];
  }
  for (int i = 1; i <= m; ++i) {
    int ii = asy__nwrap(g, a + i);
    knot k = g.nodes[ii];
    // knot.cc:537：进侧那个控制点用**这个结的 tin**
    g.nodes[ii].pre = z[i]
      - asy__velocityt(phi[i], th[i - 1], k.tin, k.tatin) * expi(-phi[i]) * dz[i - 1];
  }
}

// 整条闭合链一起解（一个断点都没有：全是 `..`）。knot.cc 那边是 cyclicCompute 那一支。
private void asy__solvecyclic(path g) {
  int n = g.nodes.length;
  pair[] z = new pair[n];
  for (int j = 0; j < n; ++j) z[j] = g.nodes[j].point;
  pair[] dz = new pair[n];
  real[] d = new real[n];
  for (int j = 0; j < n; ++j) {
    dz[j] = z[(j + 1) % n] - z[j];
    d[j] = length(dz[j]);
  }
  real[] psi = new real[n];
  for (int j = 0; j < n; ++j) psi[j] = asy__niceangle(dz[j] / dz[(j + n - 1) % n]);
  real[] alpha = new real[n];
  real[] beta = new real[n];
  for (int j = 0; j < n; ++j) {
    alpha[j] = 1 / g.nodes[j].tout;
    beta[j] = 1 / g.nodes[j].tin;
  }
  real[] epre = new real[n];
  real[] epiv = new real[n];
  real[] epost = new real[n];
  real[] eaug = new real[n];
  for (int j = 0; j < n; ++j) {
    int p = (j + n - 1) % n;
    int k = (j + 1) % n;
    real infac = 1 / (beta[j] * beta[j] * d[p]);
    real A = alpha[p] * infac;
    real B = (3 - alpha[p]) * infac;
    real outfac = 1 / (alpha[j] * alpha[j] * d[j]);
    real C = (3 - beta[k]) * outfac;
    real D = beta[k] * outfac;
    epre[j] = A;
    epiv[j] = B + C;
    epost[j] = D;
    eaug[j] = -B * psi[j] - D * psi[k];
  }
  bool homog = true;
  for (int j = 0; j < n; ++j) if (eaug[j] != 0) homog = false;
  real[] th = new real[n];
  if (!homog) th = asy__thetacyclic(epre, epiv, epost, eaug);
  real[] phi = new real[n];
  for (int j = 0; j < n; ++j) phi[j] = -psi[j] - th[j];
  for (int j = 0; j < n; ++j) {
    int k = (j + 1) % n;
    int p = (j + n - 1) % n;
    knot kn = g.nodes[j];
    g.nodes[j].straight = false;
    g.nodes[j].post = z[j]
      + asy__velocityt(th[j], phi[k], kn.tout, kn.tatout) * expi(th[j]) * dz[j];
    g.nodes[j].pre = z[j]
      - asy__velocityt(phi[j], th[p], kn.tin, kn.tatin) * expi(-phi[j]) * dz[p];
  }
}

// knot.cc:826 的 solve：把"每段怎么连的"变成控制点，整条链一起解。
private void asy__resolve(path g) {
  int n = g.nodes.length;
  if (n == 0) return;
  if (n == 1) {
    g.nodes[0].pre = g.nodes[0].point;
    g.nodes[0].post = g.nodes[0].point;
    return;
  }
  int len = length(g);
  spec[] si;
  spec[] so;
  for (int i = 0; i < n; ++i) {
    // 结上挂着的规格（`{z}` / `{curl c}`）就是这一侧的起点 —— 编号与 spec.kind 一样，
    // 所以照抄（第四十六刀）。没挂的还是 0（open），后面那几步照旧。
    spec p;
    p.kind = g.nodes[i].inkind;
    p.val = g.nodes[i].inval;
    si.push(p);
    spec q;
    q.kind = g.nodes[i].outkind;
    q.val = g.nodes[i].outval;
    so.push(q);
  }
  bool known = g.joins.length == len;
  for (int j = 0; j < len; ++j) {
    int k = asy__nwrap(g, j + 1);
    int kind = known ? g.joins[j] : 2;
    if (kind == 1) continue;               // `..`：两侧都 open，留给求解器
    if (kind == 0) {
      // `--`：runtime.in:817 的 dashesGuide 一句话写着 —— `a--b` 就是
      // `a{curl 1}..{curl 1}b`。所以它不是"钉住控制点"，是两侧各一个 curl 断点：
      // 这一段自己成一节（两个方程都是齐次的），解出来正好是直线。
      so[j].kind = 1;
      si[k].kind = 1;
    } else {                               // 2：照 nodes 里已经存着的那两个走
      pair zj = g.nodes[j].point;
      pair zk = g.nodes[k].point;
      so[j].kind = 3;
      so[j].cz = g.nodes[j].post;
      so[j].straight = g.nodes[j].straight;
      si[k].kind = 3;
      si[k].cz = g.nodes[k].pre;
    }
  }
  // curlEnds（knot.cc:748）：非闭合路径的两头没规格就补 curl 1
  if (!g.cyclic) {
    if (si[0].kind == 0) si[0].kind = 1;
    if (so[n - 1].kind == 0) so[n - 1].kind = 1;
  }
  // controlDuplicates（knot.cc:763）：连着两个点重合就把那一段钉死
  for (int j = 0; j < len; ++j) {
    int k = asy__nwrap(g, j + 1);
    if (so[j].kind != 3 && g.nodes[j].point == g.nodes[k].point) {
      so[j].kind = 3;
      so[j].cz = g.nodes[j].point;
      so[j].straight = true;
      si[k].kind = 3;
      si[k].cz = g.nodes[j].point;
    }
  }
  // partnerUp（knot.cc:735）：一侧有规格、另一侧 open 时，另一侧由这一侧推出来
  for (int j = 0; j < n; ++j) {
    if (si[j].kind == 0 && so[j].kind != 0) si[j] = asy__inpartner(so[j], g.nodes[j].point);
    else if (so[j].kind == 0 && si[j].kind != 0) so[j] = asy__outpartner(si[j], g.nodes[j].point);
  }
  // solveSpecified（knot.cc:692）：找第一个断点，一段一段来
  int first = -1;
  for (int j = 0; j < n; ++j) if (so[j].kind != 0) { first = j; break; }
  if (first < 0) {
    asy__solvecyclic(g);
    return;
  }
  int last = g.cyclic ? first + len : len;
  int a = first;
  while (a != last) {
    int ia = asy__nwrap(g, a);
    if (so[ia].kind == 3) {
      int k = asy__nwrap(g, a + 1);
      g.nodes[ia].post = so[ia].cz;
      g.nodes[ia].straight = so[ia].straight;
      g.nodes[k].pre = si[k].cz;
      a = a + 1;
    } else {
      int b = a + 1;
      while (si[asy__nwrap(g, b)].kind == 0) b = b + 1;
      asy__solvesection(g, si, so, a, b);
      a = b;
    }
  }
  // controlEnds（knot.h:307）：非闭合路径两头的那两个控制点就是端点自己
  if (!g.cyclic) {
    g.nodes[0].pre = g.nodes[0].point;
    g.nodes[n - 1].post = g.nodes[n - 1].point;
  }
}

// ------------------------------------------------------------ path 的连接
// "每段怎么连的"那张表对不上段数时（subpath / nib 这种自己摆控制点的），一律按 2 补齐
private void asy__normjoins(path g) {
  int len = length(g);
  if (g.joins.length == len) return;
  int[] js;
  for (int i = 0; i < len; ++i) js.push(2);
  g.joins = js;
}

// **把一条路"钉死"**（第八十四刀）：joins 全按 2（照已经解出来的控制点走）、结上挂着的
// 规格清空。这一格是 asy 里 `guide` -> `path` 那次 cast 的全部内容 —— guide 是**还没解**
// 的规格，path 是解好的、控制点定死的。这一层 guide 就是 path，所以"解没解过"这件事
// 落在这一格上：往一个**写着 path** 的变量里存的时候钉死，写着 guide 的不钉。
//
// 量出来的（同一份源码，三种写法在真 asy 那边出三种图）：
//   path r=(0,0); r=r--(10,0); r=r..(20,10); r=r--(20,30); r=r..(10,40);
//     -> 那两个 `..` 是**曲线**（curveto），因为每一句赋值都把左边解好钉死了，
//        接缝处的进侧是"已定控制点"，出侧由它推出方向。
//   guide g=…（同样五句） 与 path p=(0,0)--(10,0)..(20,10)--(20,30)..(10,40);
//     -> 全是直线（lineto）：整条链一起解，`--` 是两侧 curl，`..` 那一段夹在两个
//        curl 断点之间，解出来正好是直线。
// roundedpath.asy:37/49 的 `RoundPath=RoundPath--…` / `RoundPath=RoundPath..…`
// （RoundPath 写的是 path）就靠这一格才有圆角。
path asy__solid(path g) {
  int len = length(g);
  if (len == 0) return g;
  path h = pathcopy(g);
  int[] js;
  for (int i = 0; i < len; ++i) js.push(2);
  h.joins = js;
  for (int i = 0; i < h.nodes.length; ++i) {
    h.nodes[i].inkind = 0;
    h.nodes[i].inval = 0;
    h.nodes[i].outkind = 0;
    h.nodes[i].outval = 0;
  }
  h.pinkind = 0;
  h.pinval = 0;
  return h;
}

// 收到一个**规格结点**（第四十六刀）：把它记到累加中的那条路径上。前端把
// `a{d1}..tension t..{d2}b` 折叠成四步二元连接（见 asyJoinExp），前三步走这里 ——
// asy 那边这份"还没落到结上的规格"存在 flatguide 里。
private path asy__spjoin(path a, path b) {
  path h = pathcopy(a);
  int n = h.nodes.length;
  if (b.spkind == 1 || b.spkind == 2) {
    // spkind 1 = `{z}` 方向（spec.kind 2）、2 = `{curl c}`（spec.kind 1）
    int kd = b.spkind == 1 ? 2 : 1;
    real vl = b.spkind == 1 ? asy__niceangle(b.spz0) : b.spa;
    if (b.spside == 0) {            // JOIN_OUT：挂在**最后那个结**的出侧
      if (n > 0) {
        h.nodes[n - 1].outkind = kd;
        h.nodes[n - 1].outval = vl;
      }
    } else {                        // JOIN_IN：挂给**下一个**结
      h.pinkind = kd;
      h.pinval = vl;
    }
    return h;
  }
  if (b.spkind == 3) {              // tension：下一段两端的张力
    h.ptout = b.spa;
    h.ptin = b.spb;
    h.ptat = b.spat;
    return h;
  }
  h.pctl = 1;                       // 4：controls —— 下一段的控制点定死了
  h.pc0 = b.spz0;
  h.pc1 = b.spz1;
  return h;
}

// 攒着的规格只管**下一段**，用掉就清
private void asy__clearpend(path h) {
  h.pinkind = 0;
  h.pinval = 1;
  h.ptout = 1;
  h.ptin = 1;
  h.ptat = false;
  h.pctl = 0;
}

// 连接：kind 0 是 `--`，1 是 `..`。两边接上之后**整条链重解一遍** —— asy 的 guide 是
// 没解的规格，解是在转成 path 时一次做完的，逐段解出来的控制点与那个不一样。
private path asy__join(path a, path b, int kind) {
  if (b.spkind != 0) return asy__spjoin(a, b);
  if (a.spkind != 0) {
    // camp.y 的 `exp join exp` 左边一定是条真路径，所以这只有直呼
    // `operator ..(operator spec(…), g)` 才到得了
    abort("连接的左边是个规格结点");
    return nullpath;
  }
  path h = pathcopy(a);
  asy__normjoins(h);
  int n = h.nodes.length;
  // `controls c0 and c1` 那一段是"控制点已定"（joins 里的 2），别的照传进来的 kind
  int jk = h.pctl != 0 ? 2 : kind;
  // `a--cycle` / `a..cycle`：右边是那个记号，于是闭合
  if (b.ismark) {
    if (n == 0) return h;
    // 只有一个结：`(5,5)--cycle` 是**长度 1** 的闭合路径，两个控制点都落在这个点上，
    // 那一段还算直线段（`..cycle` 也一样）—— 解方程那套在这儿没得解，直接摆好。
    if (n == 1) {
      h.cyclic = true;
      h.nodes[0].pre = h.nodes[0].point;
      h.nodes[0].post = h.nodes[0].point;
      h.nodes[0].straight = true;
      int[] js;
      js.push(2);
      h.joins = js;
      asy__clearpend(h);
      return h;
    }
    h.cyclic = true;
    // 收口那一段的规格：进侧落在第 0 个结上
    if (h.pinkind != 0) {
      h.nodes[0].inkind = h.pinkind;
      h.nodes[0].inval = h.pinval;
    }
    if (h.pctl != 0) {
      h.nodes[n - 1].post = h.pc0;
      h.nodes[0].pre = h.pc1;
    }
    h.nodes[n - 1].tout = h.ptout;
    h.nodes[n - 1].tatout = h.ptat;
    h.nodes[0].tin = h.ptin;
    h.nodes[0].tatin = h.ptat;
    h.joins.push(jk);
    asy__clearpend(h);
    asy__resolve(h);
    return h;
  }
  if (n == 0) return pathcopy(b);
  if (b.nodes.length == 0) return h;
  path t = pathcopy(b);
  asy__normjoins(t);
  // 这一段两端：出侧在 h 的末结上（`{d}` 那一档在 spjoin 里已经挂好了），
  // 进侧与张力落在接缝右边那个结上
  if (h.pinkind != 0) {
    t.nodes[0].inkind = h.pinkind;
    t.nodes[0].inval = h.pinval;
  }
  if (h.pctl != 0) {
    h.nodes[n - 1].post = h.pc0;
    t.nodes[0].pre = h.pc1;
  }
  h.nodes[n - 1].tout = h.ptout;
  h.nodes[n - 1].tatout = h.ptat;
  t.nodes[0].tin = h.ptin;
  t.nodes[0].tatin = h.ptat;
  h.joins.push(jk);
  for (int i = 0; i < t.nodes.length; ++i) {
    h.nodes.push(knotcopy(t.nodes[i]));
    if (i > 0) h.joins.push(t.joins[i - 1]);
  }
  asy__clearpend(h);
  asy__resolve(h);
  return h;
}

// 连接符的元数是**不限**的（builtin.cc:421 那两条注册的是 `guide(... guide[])`）：
// camp.y 把 `a -- b -- c` 降成**一次**调用，而 `interpolate join=operator --;`
// （graph.asy:1920 那一族）要的正是 `path(... path[])` 这个类型。两个实参那一档照旧 ——
// 前端折连接时就是一次两个（见 asyJoinFold）。
path operator --(... path[] g) {
  if (g.length == 0) return nullpath;
  path h = g[0];
  for (int i = 1; i < g.length; ++i) h = asy__join(h, g[i], 0);
  return h;
}

path operator ..(... path[] g) {
  if (g.length == 0) return nullpath;
  path h = g[0];
  for (int i = 1; i < g.length; ++i) h = asy__join(h, g[i], 1);
  return h;
}

// ------------------------------------------------- 连接里的那几个规格（第四十五刀）
// asy 的 guide 是一棵树，`{z}`、`{curl c}`、`tension …`、`controls … and …` 都是树上的
// 结点，各有一个 `guide operator cast(…)` 把自己变成 guide（runtime.in:880/905、
// camp.y 的 specExp 把 `{z}` 变成 `operator spec(z, side)`）。这一层 guide 就是 path，
// 所以它们落成**带 spkind 记号的 path**（见 struct path 上那一段）。
//
// `tensionSpecifier` 与 `curlSpecifier` 是 asy 的**内建类型**（primitives.h:36/37），
// 字段名照 three.asy:733/739 读出来的那几个：out/in/atLeast 与 value/side。
struct tensionSpecifier {
  real out = 1;
  real in = 1;
  bool atLeast = false;
}

struct curlSpecifier {
  real value = 1;
  int side = 0;
}

// runtime.in:885
tensionSpecifier operator tension(real tout, real tin, bool atLeast) {
  tensionSpecifier t;
  t.out = tout;
  t.in = tin;
  t.atLeast = atLeast;
  return t;
}

// runtime.in:864
curlSpecifier operator curl(real gamma, int p) {
  curlSpecifier c;
  c.value = gamma;
  c.side = p;
  return c;
}

// runtime.in:856：`{z}` 那一档。side 是 camp.y 的 JOIN_OUT(0) / JOIN_IN(1)。
guide operator spec(pair z, int p) {
  path g;
  g.spkind = 1;
  g.spz0 = z;
  g.spside = p;
  return g;
}

// runtime.in:908
guide operator controls(pair zout, pair zin) {
  path g;
  g.spkind = 4;
  g.spz0 = zout;
  g.spz1 = zin;
  return g;
}

// runtime.in:905 / 880 的那两个 cast
guide operator cast(tensionSpecifier t) {
  path g;
  g.spkind = 3;
  g.spa = t.out;
  g.spb = t.in;
  g.spat = t.atLeast;
  return g;
}

guide operator cast(curlSpecifier c) {
  path g;
  g.spkind = 2;
  g.spa = c.value;
  g.spside = c.side;
  return g;
}

// `cycleToken` 是 asy 那边 `cycle` 的类型（C++ 面的一个空类型）。这一层的 `cycle` 是
// 带记号的 path（见 cyclepath），所以这个名字只是给 base 里
// `path operator &(path, cycleToken)` 那条声明用的 —— 它永远匹配不上，`p&cycle` 走下面
// 这份 `operator &(path, path)`。
struct cycleToken { }

// `p & cycle`：照 plain_paths.asy:240 那份 ——
//   straight(p,n-1) ? subpath(p,0,n-1)--cycle
//                   : subpath(p,0,n-1)..controls postcontrol(p,n-1) and precontrol(p,n)..cycle
// 也就是：末结去掉，收口那一段接到第 0 个结上。原来那段是直线的话，收口也是直线（控制点得按
// **新的**两端重摆到三等分点）；是曲线的话，末段那两个控制点原样搬过来。已经闭合的原样回。
private path asy__closepath(path a) {
  int n = length(a);
  if (a.nodes.length == 0) return nullpath;
  if (n == 0) return asy__join(a, cyclepath, 0);   // 一个点：`p--cycle`
  if (a.cyclic) return pathcopy(a);
  path h;
  for (int i = 0; i < n; ++i) h.nodes.push(knotcopy(a.nodes[i]));
  h.cyclic = true;
  if (a.nodes[n - 1].straight) {
    pair z0 = h.nodes[n - 1].point;
    pair z1 = h.nodes[0].point;
    pair d = (z1 - z0) / 3;
    h.nodes[n - 1].post = z0 + d;
    h.nodes[0].pre = z1 - d;
  } else {
    h.nodes[0].pre = a.nodes[n].pre;
  }
  return h;                                        // joins 空着：全按"控制点已定"走
}

// path.cc:1119 的 concat：接缝那个结的 pre 来自左边、point/post/straight 来自右边。
// 拼出来的是**解好的**路径（joins 空着 = 每段照 nodes 里的控制点走）。
path operator &(path a, path b) {
  if (b.ismark) return asy__closepath(a);
  if (a.nodes.length == 0) return pathcopy(b);
  if (b.nodes.length == 0) return pathcopy(a);
  int n1 = length(a);
  int n2 = length(b);
  path h;
  for (int i = 0; i < n1 + n2 + 1; ++i) {
    knot k;
    h.nodes.push(k);
  }
  h.nodes[0].pre = point(a, 0);
  int i = 0;
  for (int j = 0; j < n1; ++j) {
    h.nodes[i].point = point(a, j);
    h.nodes[i].straight = a.nodes[asy__nwrap(a, j)].straight;
    h.nodes[i].post = postcontrol(a, j);
    h.nodes[i + 1].pre = precontrol(a, j + 1);
    ++i;
  }
  for (int j = 0; j < n2; ++j) {
    h.nodes[i].point = point(b, j);
    h.nodes[i].straight = b.nodes[asy__nwrap(b, j)].straight;
    h.nodes[i].post = postcontrol(b, j);
    h.nodes[i + 1].pre = precontrol(b, j + 1);
    ++i;
  }
  h.nodes[i].point = point(b, n2);
  h.nodes[i].post = point(b, n2);
  return h;
}

// ---------------------------------------------------------------- bbox
// 每个元素各出一个 bbox，描边的那些还要按笔宽外扩 —— 量过 asy 就是这么算的：
// size(100) 的图里一条 linewidth(2) 的水平线让**横向**多出 2（两头各 1），
// 而三角形的填充一点都不外扩（d5 那个例子：总高 79.4 = 78.4 + 1）。
struct box {
  real l = 0;
  real b = 0;
  real r = 0;
  real t = 0;
  bool empty = true;
}

void addx(box bx, real x) {
  if (x < bx.l) bx.l = x;
  if (x > bx.r) bx.r = x;
}

void addy(box bx, real y) {
  if (y < bx.b) bx.b = y;
  if (y > bx.t) bx.t = y;
}

void addpt(box bx, pair z) {
  if (bx.empty) {
    bx.l = z.x;
    bx.r = z.x;
    bx.b = z.y;
    bx.t = z.y;
    bx.empty = false;
  } else {
    addx(bx, z.x);
    addy(bx, z.y);
  }
}

// 三次贝塞尔在一根轴上的极值：导数是二次式，解出 [0,1] 里的根代回去。
// 直线段用不到，`..` 那一刀的曲线要。
//
// 这一段原先是"数学上对、末位不对"的写法：根用 (-B±sqrt(B²-4AC))/(2A)、阈值是
// 绝对量 1e-14、值用幂基 r³a+3r²tb+3rt²c+t³d。量出来的后果：`size(0,100)` 下
// `fill(scale(2)*unitcircle)` 那张图的 frame 顶是 50 + 1ulp 而不是 50，
// bbox.h:200 的 LowRes 一 ceil 就成了 51 —— %%BoundingBox 整整差 1bp。
// 幂基那条式子**不是**凸组合，能冲出控制点的上界；de Casteljau 每一步都是凸组合，
// 冲不出去。所以逐字照抄 path.cc：
//   * 二次根用 path.cc:46 的 quadraticroots（sqrt1pxm1 那套，不是判别式那套），
//     阈值是**相对**的 Fuzz2/Fuzz4，不是 1e-14
//   * 曲线值用 path.cc:point(double) 的 de Casteljau
//   * 导数系数照 path.cc:462 的括号摆法，一个括号都不能挪
//   * 根的取舍是 path.h:449 的 goodroot，**闭**区间 0<=t<=1，不是开区间
// 后面 min/max(path)（asy__pathbound）用的是同一对函数 —— 原先那儿另有一份，
// 两份都错，而且错得不一样。
private real asy__Fuzz2 = 1000.0 * realEpsilon;      // bound.cc:13
private real asy__Fuzz4 = asy__Fuzz2 * asy__Fuzz2;   // path.cc:22
/*
 * `bound` 那一族的**标量骨架**（bound.h:16 的 Split 与 bound.cc:32..86）：Bezier 面片上
 * 一个分量的**真极值**，靠细分求，不是拿控制点凸包顶。
 *
 * 摆在这么前面是因为它有三个用处、而最早的那个在 `minbezier`（runarray.in:2200）：
 *   界（drawsurface.cc:72）、`minbezier/maxbezier`、比（drawsurface.cc:138，那一支
 *   要 triple 版，在文件后面）。asy 的名字解析是顺着来的，所以早声明。
 */
private real asy__Fuzz = sqrt(asy__Fuzz2);      // bound.cc:14
private int asy__rmaxdepth = 53;                // bound.cc:15 的 DBL_MANT_DIG
// `max`/`min`/`abs`（实数那几格）在这个文件里声明得比这儿晚，所以这一族里不用它们
private real asy__rm(bool mx, real a, real b) {
  return mx ? (a > b ? a : b) : (a < b ? a : b);
}

private real[] asy__splitr(real z0, real c0, real c1, real z1) {
  real m0 = 0.5 * (z0 + c0);
  real m1 = 0.5 * (c0 + c1);
  real m2 = 0.5 * (c1 + z1);
  real m3 = 0.5 * (m0 + m1);
  real m4 = 0.5 * (m1 + m2);
  real m5 = 0.5 * (m3 + m4);
  return new real[] {m0, m1, m2, m3, m4, m5};
}

// bound.cc:32 / :38（四个角 / 另外十二个控制点）
private real asy__scornerbound(real[] P, bool mx) {
  real b = asy__rm(mx, P[0], P[3]);
  b = asy__rm(mx, b, P[12]);
  return asy__rm(mx, b, P[15]);
}

private real asy__scontrolbound(real[] P, bool mx) {
  int[] k = {1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14};
  real b = asy__rm(mx, P[1], P[2]);
  for (int i = 2; i < k.length; ++i) b = asy__rm(mx, b, P[k[i]]);
  return b;
}

// bound.cc:52 的 bound（标量版，十六个控制点的面片）
//
// **这一格现在走的是控制点凸包，不是细分。** 细分那一版逐句照抄过、也确实把封套
// 对上了（cylinder / shellsqrtx01 / sacylinder3D 的矢量半边曾经全部逐字节相同），
// 但它是**热路径**：`minbezier/maxbezier`（每片面片、三个分量各一遍）、
// `asy__addpatch3`、`minratio/maxratio`、以及 `angle()` 每轮的帧乘法都要过它。
// 在这一层（解释执行的 asy）跑 Bezier 细分，AiryDisk 从 4.4s 涨到 73s、bars3 跑不完。
// 真要它就得把 `bound/boundtri` 做成**运行时的原生内建**（JS 那一侧），
// 而不是 asy 层的递归。递归那一版留在下面没人调，等原生版落地时照它搬。
private real asy__sbound(real[] P, bool mx, real b, real fuzz, int depth) {
  real bb = asy__rm(mx, b, asy__scornerbound(P, mx));
  real sgn = mx ? 1 : -1;
  if (sgn * (bb - asy__scontrolbound(P, mx)) >= -fuzz || depth == 0) return bb;
  int d = depth - 1;
  real fz = fuzz * 2;
  real[] c0 = asy__splitr(P[0], P[1], P[2], P[3]);
  real[] c1 = asy__splitr(P[4], P[5], P[6], P[7]);
  real[] c2 = asy__splitr(P[8], P[9], P[10], P[11]);
  real[] c3 = asy__splitr(P[12], P[13], P[14], P[15]);
  real[] c4 = asy__splitr(P[12], P[8], P[4], P[0]);
  real[] c5 = asy__splitr(c3[0], c2[0], c1[0], c0[0]);
  real[] c6 = asy__splitr(c3[3], c2[3], c1[3], c0[3]);
  real[] c7 = asy__splitr(c3[5], c2[5], c1[5], c0[5]);
  real[] c8 = asy__splitr(c3[4], c2[4], c1[4], c0[4]);
  real[] c9 = asy__splitr(c3[2], c2[2], c1[2], c0[2]);
  real[] c10 = asy__splitr(P[15], P[11], P[7], P[3]);
  real[] s0 = {c4[5], c5[5], c6[5], c7[5], c4[3], c5[3], c6[3], c7[3],
               c4[0], c5[0], c6[0], c7[0], P[12], c3[0], c3[3], c3[5]};
  bb = asy__sbound(s0, mx, bb, fz, d);
  real[] s1 = {P[0], c0[0], c0[3], c0[5], c4[2], c5[2], c6[2], c7[2],
               c4[4], c5[4], c6[4], c7[4], c4[5], c5[5], c6[5], c7[5]};
  bb = asy__sbound(s1, mx, bb, fz, d);
  real[] s2 = {c0[5], c0[4], c0[2], P[3], c7[2], c8[2], c9[2], c10[2],
               c7[4], c8[4], c9[4], c10[4], c7[5], c8[5], c9[5], c10[5]};
  bb = asy__sbound(s2, mx, bb, fz, d);
  real[] s3 = {c7[5], c8[5], c9[5], c10[5], c7[3], c8[3], c9[3], c10[3],
               c7[0], c8[0], c9[0], c10[0], c3[5], c3[4], c3[2], P[15]};
  return asy__sbound(s3, mx, bb, fz, d);
}

// bound.cc:88 / :93（三角面片：三个角是 0/6/9，另外七个是控制点）
private real asy__scornerboundtri(real[] P, bool mx) {
  real b = asy__rm(mx, P[0], P[6]);
  return asy__rm(mx, b, P[9]);
}

private real asy__scontrolboundtri(real[] P, bool mx) {
  int[] k = {1, 2, 3, 4, 5, 7, 8};
  real b = asy__rm(mx, P[1], P[2]);
  for (int i = 2; i < k.length; ++i) b = asy__rm(mx, b, P[k[i]]);
  return b;
}

// bound.cc:102 的 boundtri（标量版，十个控制点的三角面片）。
// `Splittri`（bound.h:30）那三十来个中间点在这儿摊开写 —— asy 那边是模板，
// 我们这一侧没有模板，实数版与 triple 版各写一遍。
// bound.cc:102 的 boundtri（标量版，十个控制点的三角面片）——
private real asy__sboundtri(real[] P, bool mx, real b, real fuzz, int depth) {
  real bb = asy__rm(mx, b, asy__scornerboundtri(P, mx));
  real sgn = mx ? 1 : -1;
  if (sgn * (bb - asy__scontrolboundtri(P, mx)) >= -fuzz || depth == 0) return bb;
  int d = depth - 1;
  real fz = fuzz * 2;
  real l003 = P[0]; real p102 = P[1]; real p012 = P[2]; real p201 = P[3];
  real p111 = P[4]; real p021 = P[5]; real r300 = P[6]; real p210 = P[7];
  real p120 = P[8]; real u030 = P[9];
  real u021 = 0.5 * (u030 + p021); real u120 = 0.5 * (u030 + p120);
  real p033 = 0.5 * (p021 + p012); real p231 = 0.5 * (p120 + p111);
  real p330 = 0.5 * (p120 + p210); real p123 = 0.5 * (p012 + p111);
  real l012 = 0.5 * (p012 + l003); real p312 = 0.5 * (p111 + p201);
  real r210 = 0.5 * (p210 + r300); real l102 = 0.5 * (l003 + p102);
  real p303 = 0.5 * (p102 + p201); real r201 = 0.5 * (p201 + r300);
  real u012 = 0.5 * (u021 + p033); real u210 = 0.5 * (u120 + p330);
  real l021 = 0.5 * (p033 + l012); real p4xx = 0.5 * p231 + 0.25 * (p111 + p102);
  real r120 = 0.5 * (p330 + r210); real px4x = 0.5 * p123 + 0.25 * (p111 + p210);
  real pxx4 = 0.25 * (p021 + p111) + 0.5 * p312;
  real l201 = 0.5 * (l102 + p303); real r102 = 0.5 * (p303 + r201);
  real l210 = 0.5 * (px4x + l201); real r012 = 0.5 * (px4x + r102);
  real l300 = 0.5 * (l201 + r102);
  real r021 = 0.5 * (pxx4 + r120); real u201 = 0.5 * (u210 + pxx4);
  real r030 = 0.5 * (u210 + r120);
  real u102 = 0.5 * (u012 + p4xx); real l120 = 0.5 * (l021 + p4xx);
  real l030 = 0.5 * (u012 + l021);
  real l111 = 0.5 * (p123 + l102); real r111 = 0.5 * (p312 + r210);
  real u111 = 0.5 * (u021 + p231);
  real c111 = 0.25 * (p033 + p330 + p303 + p111);
  real[] L = {l003, l102, l012, l201, l111, l021, l300, l210, l120, l030};
  bb = asy__sboundtri(L, mx, bb, fz, d);
  real[] R = {l300, r102, r012, r201, r111, r021, r300, r210, r120, r030};
  bb = asy__sboundtri(R, mx, bb, fz, d);
  real[] U = {l030, u102, u012, u201, u111, u021, r030, u210, u120, u030};
  bb = asy__sboundtri(U, mx, bb, fz, d);
  real[] C = {r030, u201, r021, u102, c111, r012, l030, l120, l210, l300};
  return asy__sboundtri(C, mx, bb, fz, d);
}

// run::norm（bound.h:87）：L∞ 范数
private real asy__norminf(real[] v) {
  real n = 0;
  for (int i = 0; i < v.length; ++i) {
    real t = v[i] < 0 ? -v[i] : v[i];
    if (t > n) n = t;
  }
  return n;
}
// sqrt(1+x)-1，小 x 上不掉精度（path.cc:36）
private real asy__sqrt1pxm1(real x) { return x / (sqrt(1 + x) + 1); }
// path.cc:point(double t) 的 de Casteljau，取一个分量（pair 的加乘是逐分量的，
// 所以拆开算与整对算逐位一样）
real asy__bez(real a, real b, real c, real d, real t) {
  real one_t = 1.0 - t;
  real ab = one_t * a + t * b;
  real bc = one_t * b + t * c;
  real cd = one_t * c + t * d;
  real abc = one_t * ab + t * bc;
  real bcd = one_t * bc + t * cd;
  return one_t * abc + t * bcd;
}
// path.cc:46 的 quadraticroots，只报 bounds() 用得到的那一面：返回要试的 t，
// 顺序与 C++ 那边的 t1、t2 一致（MANY 与 ONE 只报 t1，NONE 报空）。
real[] asy__bezcrit(real a, real b, real c, real d) {
  // path.cc:462 的 derivative(a,b,c, z0,c0,c1,z1)
  real A = d - a + 3.0 * (b - c);
  real B = 2.0 * (a + c) - 4.0 * b;
  real C = b - a;
  real[] out;
  if (fabs(A) <= asy__Fuzz2 * fabs(B) + asy__Fuzz4 * fabs(C)) {
    if (fabs(B) > asy__Fuzz2 * fabs(C)) out.push(-C / B);
    else if (C == 0.0) out.push(0.0);
    return out;
  }
  real factor = 0.5 * B / A;
  real denom = B * factor;
  if (fabs(denom) <= asy__Fuzz2 * fabs(C)) {
    real x = -C / A;
    if (x >= 0.0) { real t2 = sqrt(x); out.push(-t2); out.push(t2); }
    return out;
  }
  real x = -2.0 * C / denom;
  if (x > -1.0) {
    real r2 = factor * asy__sqrt1pxm1(x);
    real r1 = -r2 - 2.0 * factor;
    if (r1 <= r2) { out.push(r1); out.push(r2); }
    else { out.push(r2); out.push(r1); }
  } else if (x == -1.0) {
    out.push(-factor);
  }
  return out;
}
void addcubic1(box bx, bool isx, real a, real b0, real c, real d) {
  for (real u : asy__bezcrit(a, b0, c, d)) {
    if (u < 0.0 || u > 1.0) continue;             // path.h:449 goodroot
    real p = asy__bez(a, b0, c, d, u);
    if (isx) addx(bx, p);
    else addy(bx, p);
  }
}

void addcubic(box bx, pair p0, pair p1, pair p2, pair p3) {
  addpt(bx, p0);
  addpt(bx, p3);
  addcubic1(bx, true, p0.x, p1.x, p2.x, p3.x);
  addcubic1(bx, false, p0.y, p1.y, p2.y, p3.y);
}

// ---------------------------------------------------------------- picture
// 渐变/网格填充那一族的余料（drawfill.h 的 drawShade 一支）。挂在 drawop 上，
// **只有 kind == 2 那些才有**（其余是 null）—— 描边与填充那两档一个字段都不多占。
// st 就是 PostScript 的 ShadingType：1 = lattice、2 = axial、3 = radial、
// 4 = gouraud、7 = tensor（0 留给 functionshade 那一路，还没做）。
struct shadeinfo {
  int st = 0;
  path[] gs;             // 整条超路径：clip 用它，界也用它
  bool stroke = false;
  // axial / radial
  pen pena; pen penb; pair za = (0, 0); pair zb = (0, 0);
  real ra = 0; real rb = 0; bool exta = true; bool extb = true;
  // gouraud
  pen[] vpens; pair[] verts; int[] vedges;
  // lattice 与 tensor 的二维笔阵
  pen[][] mpens;
  // tensor
  path[] bnds; pair[][] tz;
  // lattice 的 /Matrix
  transform tt;
}

struct drawop {
  int kind = 0;      // 0 = 描边，1 = 填充，2 = 渐变/网格（看 sh），3/4 = 裁剪的头与尾
  path g;
  pen p;
  shadeinfo sh = null;
  // 裁剪那一对的 gsave/grestore 省掉没有（picture.cc:301 那个"解释器栈深"的优化：
  // 两格 endclip 挨着时，**前面那一格**与它配对的头都不发 gsave/grestore）。
  bool nosave = false;
  // 这一格是**上一格填充的续**（`fill(f, path[] g, p)` 拆出来的第 2..n 条）：
  // 出图时不发 newpath、也不发笔与 fill，攒到这一组最后一条再发。见 emitop。
  bool merge = false;
  // 位图（kind == 5，`_image`）：像素按行存，**行 0 是下边那一行**（PostScript 的 image
  // 第一条扫描线落在 ImageMatrix 的 y=0 上）。目标平行四边形躺在 `g` 的四个结点上。
  pen[][] img;
  // 逐字照发的一段 PostScript（kind == 6，`postscript(frame, string)`）。带 min/max 的那一份
  // 把界放在 `g` 上（一条矩形），不带的那一份 `g` 是空的 —— 界不参与。
  string psraw = "";
  // 裸位图（kind == 7）：三维那条路渲出来的一整张图（drawimage.h:107 的 drawRawImage）。
  // 与 kind == 5 的差别在**像素怎么存**：那边是 pen[][]，一张 372x400 就是 148800 个 pen；
  // 这边存的是**十六进制文本**（`xxd -p` 出来的那份，见 ADR 第八节）——
  // 我们这一层一个字节都不碰，读进来原样贴进 EPS，filter 用 /ASCIIHexDecode。
  string rawhex = "";
  int rw = 0;
  int rh = 0;
}

struct picture {
  drawop[] ops;
  real xsize = 0;
  real ysize = 0;
}

picture currentpicture;

void size(picture pic, real w, real h) {
  pic.xsize = w;
  pic.ysize = h;
}

void size(real w, real h) { size(currentpicture, w, h); }
void size(real w) { size(currentpicture, w, w); }

void addop(picture pic, int kind, path g, pen p) {
  drawop o;
  o.kind = kind;
  o.g = pathcopy(g);
  o.p = pencopy(p);
  pic.ops.push(o);
}

// 图上的描边与填充：**这一层自己的短路**（不 import plain 时用）。收的是 `path[]` ——
// 与 plain 那几份同一个形状，所以 import 了 plain 之后两边都要过一次 `path[] operator cast`，
// 打平取后声明的那份（plain 的），画进的是 plain 那个 currentpicture。见上面那条 cast 旁边的注。
void draw(picture pic, path[] g, pen p) { for (path q : g) addop(pic, 0, q, p); }
void draw(picture pic, path[] g) { for (path q : g) addop(pic, 0, q, currentpen); }
void draw(path[] g, pen p) { for (path q : g) addop(currentpicture, 0, q, p); }
void draw(path[] g) { for (path q : g) addop(currentpicture, 0, q, currentpen); }

// 这一层自己那份 `fill(picture, path[], …)` 也是**一组一个填充**（与 frame 上那份同一条规矩）
void asy__fillall(picture pic, path[] g, pen p) {
  for (int i = 0; i < g.length; ++i) {
    addop(pic, 1, g[i], p);
    if (i > 0) pic.ops[pic.ops.length - 1].merge = true;
  }
}
void fill(picture pic, path[] g, pen p) { asy__fillall(pic, g, p); }
void fill(picture pic, path[] g) { asy__fillall(pic, g, currentpen); }
void fill(path[] g, pen p) { asy__fillall(currentpicture, g, p); }
void fill(path[] g) { asy__fillall(currentpicture, g, currentpen); }

// 一个元素在缩放 s 下的 bbox。描边按笔宽的一半外扩（默认是圆头圆角，四个方向都是 w/2）。
// 描边那一笔的盒子要加上**笔的盒子**（pen.h:931 的 pen::bounds）：没有笔尖时是
// ±0.5*linewidth*(maxx,maxy) 加上笔那个变换的平移，maxx/maxy 是线性部分两行的模长
// （恒等时就是 1）。min/max(pen) 用的是同一份算法，但它们声明在后面，所以这里现写。
void widen(box eb, pen p) {
  real hw = 0.5 * p.width;
  real mx = 1;
  real my = 1;
  real sx = 0;
  real sy = 0;
  if (p.hastrans) {
    mx = length((p.pentrans.xx, p.pentrans.xy));
    my = length((p.pentrans.yx, p.pentrans.yy));
    sx = p.pentrans.x;
    sy = p.pentrans.y;
  }
  eb.l -= hw * mx - sx;
  eb.b -= hw * my - sy;
  eb.r += hw * mx + sx;
  eb.t += hw * my + sy;
}

// 一条路径自己的界（三次段按控制点解极值，见 addcubic）
void pathbox(box eb, path g, real s) {
  int n = g.nodes.length;
  int segs = length(g);
  for (int i = 0; i < n; ++i) addpt(eb, s * g.nodes[i].point);
  for (int i = 0; i < segs; ++i) {
    int j = i + 1;
    if (j == n) j = 0;
    if (!g.nodes[i].straight) {
      addcubic(eb, s * g.nodes[i].point, s * g.nodes[i].post,
               s * g.nodes[j].pre, s * g.nodes[j].point);
    }
  }
}

box opbox(drawop o, real s) {
  box eb;
  // 渐变那一档的界是**整条超路径**的（drawelement.h:385 的 strokebounds /
  // drawSuperPathPenBase::bounds），描边位打开时再加笔的盒子 —— 与描边那一档同一段代码。
  bool wide = o.kind == 0;
  if (o.kind == 2) {
    for (int i = 0; i < o.sh.gs.length; ++i) pathbox(eb, o.sh.gs[i], s);
    wide = o.sh.stroke;
  } else {
    pathbox(eb, o.g, s);
  }
  if (wide && !eb.empty) widen(eb, o.p);
  return eb;
}

box boxcopy(box a) {
  box r;
  r.l = a.l; r.b = a.b; r.r = a.r; r.t = a.t; r.empty = a.empty;
  return r;
}

void boxadd(box a, box b) {
  if (b.empty) return;
  addpt(a, (b.l, b.b));
  addpt(a, (b.r, b.t));
}

// bbox.h:167 的 clip：空的不动；交出来是空的话整格清空
void boxclip(box a, box b) {
  if (a.empty) return;
  if (b.l > a.l) a.l = b.l;
  if (b.r < a.r) a.r = b.r;
  if (b.b > a.b) a.b = b.b;
  if (b.t < a.t) a.t = b.t;
  if (a.l > a.r || a.b > a.t) { a.l = 0; a.b = 0; a.r = 0; a.t = 0; a.empty = true; }
}

// 一叠 drawop 的界。裁剪那两格（kind 3/4）按 drawclipbegin.h:37 与 drawclipend.h:28 那
// 两段来：进裁剪时把"到这里为止的界"与"裁剪路径的界"各压一格，出裁剪时先把攒到的界
// 交上裁剪路径那一格、再把外面那一格并回来 —— 所以裁剪外面画过的东西不会被裁掉。
box opsbox(drawop[] ops, real s) {
  box bx;
  box[] stk;
  // picture.cc:301 的那个优化就发在**量界这一趟**里（那边 bounds() 顺手改 save 标志）：
  // 两格 endclip 挨着时，前面那一格与它配对的头都不发 gsave/grestore。这里照同一处做，
  // 所以出图那一趟看到的标志与真 asy 一样（量过 colorplanes.asy：少了这一下会多一对）。
  int[] open;
  bool anyclip = false;
  for (int i = 0; i < ops.length; ++i) if (ops[i].kind == 3) { anyclip = true; break; }
  if (anyclip) {
    int[] mate;
    for (int i = 0; i < ops.length; ++i) mate.push(-1);
    for (int i = 0; i < ops.length; ++i) {
      if (ops[i].kind == 3) open.push(i);
      else if (ops[i].kind == 4 && open.length > 0) mate[i] = open.pop();
    }
    for (int i = 1; i < ops.length; ++i) {
      if (ops[i].kind == 4 && ops[i - 1].kind == 4) {
        ops[i - 1].nosave = true;
        if (mate[i - 1] >= 0) ops[mate[i - 1]].nosave = true;
      }
    }
  }
  for (int i = 0; i < ops.length; ++i) {
    drawop o = ops[i];
    if (o.kind == 3) {
      stk.push(boxcopy(bx));
      box pb;
      for (int j = 0; j < o.sh.gs.length; ++j) pathbox(pb, o.sh.gs[j], s);
      if (o.sh.stroke && !pb.empty) widen(pb, o.p);
      stk.push(pb);
      continue;
    }
    if (o.kind == 4) {
      if (stk.length < 2) abort("endclip without matching beginclip");
      box pb = stk.pop();
      boxclip(bx, pb);
      boxadd(bx, stk.pop());
      continue;
    }
    boxadd(bx, opbox(o, s));
  }
  return bx;
}

box picbox(picture pic, real s) { return opsbox(pic.ops, s); }

// ---------------------------------------------------------------- frame
// asy 的 frame 是「已经定好尺寸的一叠元素」（坐标就是最终坐标，不再跟着 size(…) 缩放），
// picture 是「还没定尺寸的」。所以这里存的是同一种 drawop，只是量 bbox 时缩放固定为 1。
//
// 量出来的（asy -noV）：
//   * 空 frame：min/max/size 都是 (0,0)，empty(f) 是 true
//   * `_draw(f,(0,0)--(10,20),currentpen)` 之后 min=(-0.25,-0.25)、max=(10.25,20.25)、
//     size=(10.5,20.5) —— 与 picture 那边同一条规矩：描边按**笔宽的一半**外扩
//     （默认笔宽 0.5，一半 0.25）；size 就是 max - min
//   * `add(g,f)` 把 f 的元素并到 g 上（之后 max(g) 与 max(f) 一样）
//   * frame **没有字段**：`f.min` 那边报 "no matching variable 'f.min'"，是 min(f) 这种写法
//
// 量出来的理由：`import plain;` 现在停在 plain_filldraw.asy:93 的 struct 体里的 `using`，
// 那一行的类型里就有 frame（`void(frame f, path[] g, pen fillpen)`）—— 前端那一刀修好之后
// 紧接着要的就是这个类型。
//
// 这里只有「把元素攒起来」「量 bbox」与「记一下有没有标签」三件事：begingroup /
// endgroup / clip 都还没有，用到它们的地方会明确报"没有这个函数"，不会悄悄给错答案。
// 用户自己加的 TeX 前言（`texpreamble("…")`）。asy 存在 processData().TeXpreamble 里，
// 写 .tex 时由 texdefines 插在 `\let\paperwidth\paperwidthsave` 之后、`\newbox\ASYbox`
// 之前（量出来的：hierarchy 的 `\def\Ham{…}` 就在那一行）。这一份**量标签那一趟也要用** ——
// 不然 `$\Ham(r,2)$` 那一趟 latex 就是未定义控制序列，三个数量不出来。
// 声明放在这里是因为名字解析是顺着来的：asy__measure 在下面，texpreamble 的定义在更后面。
string[] asy__texpre_user;

// 一条标签（drawlabel.h 的 `drawLabel`）。`sz` 是 TeX 的尺寸文本 —— 标签量出来三个数
// 全是 0 时改量它（drawlabel.cc:101）。后三个数是 latex 量出来的（单位已换成 bp）。
struct labelrec {
  // kind：0 是一条真标签，1 是裁剪的头，2 是配对的尾。
  // 为什么标签这一列也要记裁剪：真 asy 的 frame 只有**一列** drawElement，标签与
  // clipbegin/clipend 混在一起，写 .tex 时按原序走一遍，裁剪那两格发的是
  // `\special{ps:gsave}` + `\begin{picture}` + 原始路径 + eoclip（drawclipbegin.h:66-79）。
  // 这一层把标签拆成了另一列，所以裁剪的位置得在这一列里补一份影子 ——
  // 不补的话 UnFill 那种「白底压掉下面的线」在 .tex 里整段没有，
  // 量出来的：buildcycle 与 venn3 的首处结构差就是参考 `gsave` 对我们的颜色那一句。
  int kind = 0;
  // 这一格在**图形那一列**的哪个位置之后（= 塞进来时 `f.ops.length`）。TeX 那条路要按它分层：
  // asy 的 frame 只有一列 drawElement，"画—标签—再画"天然分得开；这一层拆成了两列，
  // 交错的次序只剩这一格记着。见 asy__texship 的分层那一段（texfile.cc:153-180 的 beginlayer）。
  int at = 0;
  string s;
  string sz;
  transform t;
  pair position;
  pair align;
  pen p;
  bool havebounds = false;
  real width = 0;
  real height = 0;
  real depth = 0;
  path[] gs;                                     // kind 1 才有：裁剪的超路径
  bool stroke = false;                           // kind 1 才有
}

struct frame {
  drawop[] ops;
  // 三维那一层记下来的界（第六十七刀）：几何本身这一刀落不下来，界与 x/z、y/z 的比是真的
  bool has3 = false;
  triple min3v = (0, 0, 0);
  triple max3v = (0, 0, 0);
  pair minr = (0, 0);
  pair maxr = (0, 0);
  // 三维那一层的**几何**（位图那一档要它）：真正的 op 表挂在旁边一张登记册上
  // （`asy__f3tab`，见 asy__push3 那一段）—— 不能直接放这儿，因为 `path3` 与
  // `triple[][]` 都在这个文件后面才定义，而 asy 的名字解析是顺着来的。
  // -1 是"还没有三维内容"。
  int f3id = -1;
  // 攒过标签没有（runlabel.in:220 的 `labels(frame)`）
  bool haslabel = false;
  labelrec[] labs;
}

// `newframe` 那个字面量（camp.l:407 的 newPictureExp）落在这里：一个**新的**空 frame。
// 前端与绘图层之间约定的名字（见 types.js 的 ASY_NEWFRAME）。
frame asy__newframe() {
  frame f;
  return f;
}

// 帧与帧合并时，三维那张 op 表也要搬。真身要 `path3` 才写得出来，而 path3 在这个
// 文件后面才有名字 —— 所以这里先摆一个桩，三维那一段再接上（与 asy__dashhook 同一招）。
void asy__merge3fn(frame dest, frame src) {}

void addop(frame f, int kind, path g, pen p) {
  drawop o;
  o.kind = kind;
  o.g = pathcopy(g);
  o.p = pencopy(p);
  f.ops.push(o);
}

// `_draw` 是 asy 的**底层**描边：不走 nib 那一套（plain_filldraw.asy:48 就是这么分岔的）
void _draw(frame f, path g, pen p) { addop(f, 0, g, p); }
void _draw(frame f, path g) { addop(f, 0, g, currentpen); }
void fill(frame f, path g, pen p) { addop(f, 1, g, p); }
void fill(frame f, path g) { addop(f, 1, g, currentpen); }

// runlabel.in:214 的那一条：`label(frame, string s, string size, transform, pair position,
// pair align, pen)`。注意 size 是**字符串**（TeX 的尺寸文本），不是 real —— 照抄的。
// 攒下来，界那一趟再拿 latex 去量（asy_tex.asy 那一段）。
void label(frame f, string s, string size, transform t, pair position, pair align, pen p) {
  f.haslabel = true;
  labelrec r;
  r.s = s;
  r.sz = size;
  // **构造那一步就把平移剥掉**：drawlabel.h:37 的初始化列表是 `T(shiftless(T))`，
  // 注释写得很直白 —— "A linear (shiftless) transformation."。位置由 position 单独扛，
  // T 只管线性那一半；不剥的话 getbounds 里那三处（`inverse(T)*align`、`T*Align`、
  // `T*(-fuzz,-fuzz)`）会把同一个平移各算一遍，界就飞了。
  r.t = shiftless(t);
  r.position = position;
  r.align = align;
  r.p = pencopy(p);
  // 记下这一格落在图形那一列的哪儿（分层要用它，见 labelrec.at）
  r.at = f.ops.length;
  f.labs.push(r);
}

bool labels(frame f) { return f.haslabel; }

// ---------------------------------------------------------- 标签的尺寸要真去问一趟 latex
//
// asy 是与一个**活的** latex 进程对话：drawlabel.cc:62 `\setbox\ASYbox=\hbox{…}`，
// 然后 :38 那句 `\immediate\write16{>dim(\the\wd\ASYbox)dim}` 一个标签问三次
// （wd / ht / dp），从管子里读回来。这一层没有双向管子，所以把**一整批**标签写成一份
// .tex、跑一趟 latex、再从 .log 里把那些 `>dim(…pt)dim` 按次序捞回来 —— 问的是同一个
// TeX、同一个 `\hbox`、同一个 `\the\wd`，只是攒着一次问完。
//
// 为什么非问不可：标签的尺寸**回流进 size() 的定标**。量过 equilateral —— 我们让路径
// 占满了整个 10cm，而 asy 那边路径只有 254.55bp 宽，剩下 28.9bp 是四个 `$A$` 占掉的。
// 横向界（163.767717..447.232283）我们与 dvips 那一份逐字一样，差的正是这一段。
//
// 单位：TeX 说的是 pt，PostScript 要的是 bp，乘 72/72.27（settings.h 的 tex2ps）。
private real asy__tex2ps = 72 / 72.27;

// 从 pt 文本里抠出那个数。自己写而不是用 `(real) s`：那个 cast 声明在这份文件很后面，
// 而这一层的名字解析是顺序的。只需要认 `-?\d*\.?\d*`，TeX 印的就是这个样子。
//
// 尾数要**一口气**攒成整数再除一次 10^k，不能边走边 `v + f*d`（f 逐次 *0.1）：
// 后者每一位都要round一次，攒到最后能差 1 个 ulp。C++ 那边是
// `lexical::cast<double>` → strtod，strtod 是正确舍入的，所以只有"整尾数除一次"
// 这种写法才对得上。量出来的后果：`label("$a \le r \le b$")` 的 height 差 1 ulp，
// 顺着 drawlabel.cc:130 的 vertical 灌进 plain_scaling 的单纯形，解出的 a 差 1 ulp，
// %%BoundingBox 就整整差 1bp。TeX 的 dim 最多 5 位小数、量级又小，尾数远在 2^53
// 以内，10^k（k<=22）也是精确值，所以一次除法就是正确舍入。
private real asy__ptnum(string s) {
  int n = length(s);
  int i = 0;
  real sign = 1;
  if (i < n && substr(s, i, 1) == "-") { sign = -1; i = i + 1; }
  real m = 0;      // 整尾数
  int k = 0;       // 小数位数
  while (i < n) {
    string c = substr(s, i, 1);
    if (c < "0" || c > "9") break;
    m = m * 10 + (find("0123456789", c) + 0);
    i = i + 1;
  }
  if (i < n && substr(s, i, 1) == ".") {
    i = i + 1;
    while (i < n) {
      string c = substr(s, i, 1);
      if (c < "0" || c > "9") break;
      m = m * 10 + (find("0123456789", c) + 0);
      k = k + 1;
      i = i + 1;
    }
  }
  // 指数那一段（`6.10352e-05`）。gs 的 `12 string cvs` 印很小的数时用指数形式，
  // 少了这一段就把 `6.10352e-05` 读成 `6.10352`。量出来的：`$\sqrt{x^2}$` 那条横线
  // （TeX 的 rule，经 dvips 的 `/V`）四个角的 y 是 6.10352e-05 与 -3.99994，
  // 高 4 个单位；读丢指数之后变成 6.10352 与 -3.99994，高 10.1035 —— textpath.asy
  // 的那一个数值差（参考 -65.9638965、我们 -76.6883786）就是它。
  int ex = 0;
  if (i < n && (substr(s, i, 1) == "e" || substr(s, i, 1) == "E")) {
    i = i + 1;
    int esign = 1;
    if (i < n && substr(s, i, 1) == "-") { esign = -1; i = i + 1; }
    else if (i < n && substr(s, i, 1) == "+") { i = i + 1; }
    int ev = 0;
    while (i < n) {
      string c = substr(s, i, 1);
      if (c < "0" || c > "9") break;
      ev = ev * 10 + (find("0123456789", c) + 0);
      i = i + 1;
    }
    ex = esign * ev;
  }
  // 尾数是**整数**（逐位攒的，精确），最后只做一次乘或一次除 —— 十进制的位数
  // 落在 15 位以内时这样是正确舍入的，逐位乘 0.1 会攒误差。
  int d = k - ex;
  real p = 1;
  if (d >= 0) {
    for (int j = 0; j < d; ++j) p = p * 10;
    return sign * (m / p);
  }
  for (int j = 0; j < -d; ++j) p = p * 10;
  return sign * (m * p);
}

// 量过的尺寸记在这儿，按（用户导言 + 字号 + 串）做键。
//
// 为什么非要这一格：plain_Label.asy:320 每标一次标签就现造一个 frame、把标签摆到原点、
// 再拿 min/max(f) 当 truesize —— 也就是**每一条标签、每一趟界**都是一条新的 labelrec，
// `havebounds` 那条短路拦不住。graph 那一摊的界要算好几趟（`pic.scale.x.bound` 那个队列），
// 于是同一个 `$x$` 会被反复问。量过 sinc.asy：一趟跑下来 spawnSync 叫了 **376 次**，
// CPU profile 里 66.4% 的时间花在 child_process 上（18.5s 里的 12.3s）。
// 记住之后同一个键只问一次。
private string[] asy__mkey;
private real[] asy__mw;
private real[] asy__mh;
private real[] asy__md;
// 每一格对应的**原始 pt 文本**（"宽 高 深"，就是 .log 里那三个数的字面）。
// 存文本而不是存那三个 double：`string(real)` 只印 6 位，存 double 会掉精度，而这三个数
// 直接回流进 %%BoundingBox —— 掉一位就是整条 EPS 轴变色。存 pt 文本再走同一句
// `asy__ptnum(...) * asy__tex2ps`，与活着量的那一路逐位一样。
private string[] asy__mpt;
private int asy__mfind(string k) {
  for (int i = 0; i < asy__mkey.length; ++i) if (asy__mkey[i] == k) return i;
  return -1;
}

// ---------------------------------------------------------------- 盘上那一格记忆（纯速度）
//
// 成本在**latex 的启动趟数**，不在标签条数：量过 interpolate1.asy，6.65s 里 3.70s（54.8%）
// 花在 spawnSync 上，26 趟 latex。趟数砍不动 —— 标签是在同一趟界里边造边量的
// （plain_Label.asy:313 每次都新造一条 labelrec），后面那些在第一次量的时候还不存在。
// 投机预量试过，反而从 6.65s 变成 8.07s（跨图量的全是这张图用不到的字）。
//
// 所以换个方向：把量到的记到盘上。同一个例子重跑、以及 220 个例子互相之间，
// 字符串重复得厉害（刻度上的 `$1$`、轴名上的 `$x$`）。latex 对同一份输入是确定的，
// 这一格只影响速度。
//
// 格式：一行头 + 记录流。头里带**剩下那一段的字节数**，对不上就整片不认 ——
// 两个进程同时写的时候 `_writetext` 是"截短再写"，读的那个可能捞到半份；半份要是
// 还能"解析成功"，量出来的尺寸就错了，而尺寸直接回流进 %%BoundingBox。宁可不认。
//   OMNIDIM1 <剩下的字节数>'\n'
//   K<键的字节数>:<键>V<值的字节数>:<宽pt> <高pt> <深pt>;
//
// 两处说清：
//   - 换了 TeX 装置（字体度量变了）这一格就该清掉 —— 键里没有 latex 的版本，
//     那要多跑一趟 `latex --version`。`rm -rf /tmp/omni-asytex` 就是清法。
//   - 两个进程同时写就是后写的赢，丢的只是几条记忆，不会记错（靠上面那个长度）。
private string asy__dimfile = "/tmp/omni-asytex/dims.txt";
private bool asy__dimloaded = false;

private void asy__dimload() {
  if (asy__dimloaded) return;
  asy__dimloaded = true;
  // `_readtext` 读不到就是运行期错误，所以先保证那份在（这一趟本来也要 mkdir 才能写 .tex）
  if (_runproc("mkdir -p /tmp/omni-asytex && touch " + asy__dimfile) != 0) return;
  string all = _readtext(asy__dimfile);
  string head = "OMNIDIM1 ";
  if (length(all) < length(head) || substr(all, 0, length(head)) != head) return;
  int nlpos = find(all, '\n', 0);
  if (nlpos < 0) return;
  int want = (int) asy__ptnum(substr(all, length(head), nlpos - length(head)));
  string s = substr(all, nlpos + 1, length(all) - nlpos - 1);
  if (length(s) != want) return;          // 半份，整片不认
  // 先攒到一边，整片都认得下来才并进记忆
  string[] ks;
  string[] vs;
  int at = 0;
  while (at < length(s)) {
    if (substr(s, at, 1) != "K") return;
    int c = find(s, ":", at);
    if (c < 0) return;
    int kn = (int) asy__ptnum(substr(s, at + 1, c - at - 1));
    if (kn <= 0 || c + 1 + kn >= length(s)) return;
    string k = substr(s, c + 1, kn);
    int v = c + 1 + kn;
    if (substr(s, v, 1) != "V") return;
    int c2 = find(s, ":", v);
    if (c2 < 0) return;
    int vn = (int) asy__ptnum(substr(s, v + 1, c2 - v - 1));
    if (vn <= 0 || c2 + 1 + vn >= length(s)) return;
    string val = substr(s, c2 + 1, vn);
    if (substr(s, c2 + 1 + vn, 1) != ";") return;
    ks.push(k);
    vs.push(val);
    at = c2 + 1 + vn + 1;
  }
  for (int i = 0; i < ks.length; ++i) {
    string three = vs[i];
    int s1 = find(three, " ", 0);
    if (s1 < 0) continue;
    int s2 = find(three, " ", s1 + 1);
    if (s2 < 0) continue;
    asy__mkey.push(ks[i]);
    asy__mpt.push(three);
    asy__mw.push(asy__ptnum(substr(three, 0, s1)) * asy__tex2ps);
    asy__mh.push(asy__ptnum(substr(three, s1 + 1, s2 - s1 - 1)) * asy__tex2ps);
    asy__md.push(asy__ptnum(substr(three, s2 + 1, length(three) - s2 - 1)) * asy__tex2ps);
  }
}

// 记忆整片写回去。条数封了顶：这一格是缓存，涨到没边就自己变成成本了。
private void asy__dimsave() {
  if (asy__mkey.length > 4000) return;
  string s = "";
  for (int i = 0; i < asy__mkey.length; ++i) {
    s = s + "K" + string(length(asy__mkey[i])) + ":" + asy__mkey[i]
      + "V" + string(length(asy__mpt[i])) + ":" + asy__mpt[i] + ";";
  }
  _writetext(asy__dimfile, "OMNIDIM1 " + string(length(s)) + '\n' + s);
}

// 一整批标签量一趟。`havebounds` 的那些跳过（drawlabel.cc:95 的同一条短路）。
private void asy__measure(labelrec[] ls) {
  int[] want;
  for (int i = 0; i < ls.length; ++i) if (ls[i].kind == 0 && !ls[i].havebounds) want.push(i);
  if (want.length == 0) return;
  string nl = '\n';
  string u = "";
  for (int i = 0; i < asy__texpre_user.length; ++i) u = u + asy__texpre_user[i] + nl;
  // 键里带上导言：texpreamble 改了尺寸就可能变
  string ukey = string(length(u)) + ":" + u + ":";
  string[] wkey;       // want 里每条的键
  string[] keys;       // 这一批真要问 latex 的键（去重）
  real[] askfs;        // keys 对应的字号（pt）
  real[] askls;        // keys 对应的行距（pt）
  string[] askfn;      // keys 对应的字体命令
  string[] asks;       // keys 对应的文本
  for (int q = 0; q < want.length; ++q) {
    labelrec r = ls[want[q]];
    real fs = asy__psize(r.p) / asy__tex2ps;
    real ls2 = asy__plskip(r.p) / asy__tex2ps;
    string fn = asy__pfont(r.p);
    // 键上要带**字体**：同一句话在 cmss 与 cmr 下宽度不一样，少了这一格
    // `defaultpen(font(...))` 之后量出来的还是上一份字体的盒子。
    string k = ukey + string(fs) + ":" + string(ls2) + ":" + fn + ":"
      + string(length(r.s)) + ":" + r.s;
    wkey.push(k);
    if (asy__mfind(k) >= 0) continue;
    bool dup = false;
    for (int j = 0; j < keys.length; ++j) if (keys[j] == k) { dup = true; break; }
    if (!dup) { keys.push(k); askfs.push(fs); askls.push(ls2); askfn.push(fn); asks.push(r.s); }
  }
  // 投机那一段试过，**量出来是退步**，所以没有留：既然已经要跑一趟 latex，把"造出来
  // 但还没量过的"全捎上 —— 听起来该赚，实际上 interpolate1 从 6.65s 变成 8.07s。
  // 原因是标签是**在同一趟界里边造边量的**，第一次量的时候后面那些还不存在；而这个例子
  // 有 16 张图，跨图投机量的全是这一张用不到的字，白跑。
  // 真正的成本是「latex 的启动趟数」，砍趟数得换别的办法（见下面那格盘上的记忆）。
  if (keys.length > 0) {
    // 先问盘上那一格：把记忆读进来，再重算"还缺哪些"。命中的话这一趟 latex 整个省掉。
    asy__dimload();
    string[] k2;
    real[] f2;
    real[] l2;
    string[] n2;
    string[] s2;
    for (int k = 0; k < keys.length; ++k) {
      if (asy__mfind(keys[k]) >= 0) continue;
      k2.push(keys[k]); f2.push(askfs[k]); l2.push(askls[k]);
      n2.push(askfn[k]); s2.push(asks[k]);
    }
    keys = k2; askfs = f2; askls = l2; askfn = n2; asks = s2;
  }
  if (keys.length > 0) {
    string dir = "/tmp/omni-asytex";
    // asy 的双引号串是**照字面**的（只有 \" 特殊），单引号串才过转义 —— 与真 asy 一字不差
    // （量过：`"x\\y"` 是 4 个字符、`'p\nq'` 是 3 个）。所以反斜杠写一个就是一个，
    // 换行得用 '\n'。第一版写成 "\\documentclass" 加 "\n"，生出来的 .tex 整份是一行
    // 字面量 —— latex 照样退出 0，三个数全量成了 0，界只差了一点点，很能骗人。
    string t = "\documentclass[12pt]{article}" + nl + u
      + "\newbox\ASYbox" + nl + "\newdimen\ASYdimen" + nl + "\pagestyle{empty}" + nl
      + "\begin{document}" + nl
      // texfile.h:174-181：管道那一路 `\begin{document}` 之后紧跟 latexfontencoding。
      // 少了这六行，下面那句默认字体命令 `\usefont{\ASYencoding}{…}` 全是未定义控制序列 ——
      // 而 latex 在 nonstopmode 下照样退 0，三个数会安静地量成 0。
      + "\makeatletter%" + nl
      + "\let\ASYencoding\f@encoding%" + nl
      + "\let\ASYfamily\f@family%" + nl
      + "\let\ASYseries\f@series%" + nl
      + "\let\ASYshape\f@shape%" + nl
      + "\makeatother%" + nl;
    for (int k = 0; k < keys.length; ++k) {
      // 笔上存的字号是 bp（fontsizeval），TeX 那边要 pt —— 除回去（askfs 里已经是 pt）。
      // 默认那一格 11.9551681195517 / (72/72.27) 正好是 12，与 asy 生的
      // `\fontsize{12.000000}` 对上。
      real fs = askfs[k];
      // 量盒子那一趟也要**先切字体**（drawlabel.cc:81-88 的 setlatexfont + settexfont）：
      // 行距照 `p.Lineskip()*ps2tex`，不是硬写的 1.2 倍。
      t = t + "\fontsize{" + string(fs) + "}{" + string(askls[k]) + "}\selectfont" + nl;
      t = t + askfn[k] + nl;
      t = t + "\setbox\ASYbox=\hbox{" + asks[k] + "}" + nl;
      t = t + "\immediate\write16{>dim(\the\wd\ASYbox)dim}" + nl;
      t = t + "\immediate\write16{>dim(\the\ht\ASYbox)dim}" + nl;
      t = t + "\immediate\write16{>dim(\the\dp\ASYbox)dim}" + nl;
    }
    t = t + "\end{document}" + nl;
    _runproc("mkdir -p " + dir);
    _writetext(dir + "/m.tex", t);
    int rc = _runproc("cd " + dir + " && latex -interaction=nonstopmode m.tex");
    // 跑不起来（没装 latex）就把三个数当 0 收 —— 与 `-tex none` 那一路一样（那时
    // drawlabel.cc:124 直接 `b += position`），至少还能出图。
    string log = "";
    if (rc == 0) log = _readtext(dir + "/m.log");
    // **先把换行去掉**（这一刀）：TeX 的 .log 每 79 列硬折一次，而且折的时候**不插空格** ——
    // 于是 `>dim(7.92493pt)dim` 可能被折成 `>dim(7.9249` + 换行 + `3pt)dim`，`find(">dim(")`
    // 就少认一格、后面整批错位一位。量出来的样子（缓存里那一格）：`$S$` 记的是
    // `87.45552 7.33333 2.66666`，而 TeX 自己的回答是 `wd 7.92493pt ht 8.2pt dp 0.0pt`
    // —— 宽是两截粘起来的、深凭空多出 2.67pt。那 2.67 的深度会顺着 drawlabel 的
    // `Depth/(height+depth)` 挪标签：buildcycle 整份 EPS 只差 1 个数，就是这一处
    // （`\ASYalign(…)(-0.5,-0.733334)` 该是 `(-0.5,-1.0)`）。
    // 去掉换行正好把折断的数拼回去（TeX 折行不加空格，所以拼回来是原样）。
    log = replace(log, "\n", "");
    int at = 0;
    int k = 0;
    while (k < keys.length) {
      real[] three;
      string[] ptt;
      for (int j = 0; j < 3; ++j) {
        int a = find(log, ">dim(", at);
        if (a < 0) break;
        int b = find(log, "pt)dim", a);
        if (b < 0) break;
        string pt = substr(log, a + 5, b - a - 5);
        ptt.push(pt);
        three.push(asy__ptnum(pt) * asy__tex2ps);
        at = b + 6;
      }
      if (three.length < 3) break;
      asy__mkey.push(keys[k]);
      asy__mw.push(three[0]);
      asy__mh.push(three[1]);
      asy__md.push(three[2]);
      asy__mpt.push(ptt[0] + " " + ptt[1] + " " + ptt[2]);
      k = k + 1;
    }
    // 没量到的（latex 不在、或者 .log 里少了几条）也记成 0，别每次界都再跑一趟 latex。
    // **这种不写盘**：latex 没装是这台机器这一趟的事，不该腌进缓存。
    bool full = k == keys.length;
    for (int j = k; j < keys.length; ++j) {
      asy__mkey.push(keys[j]); asy__mw.push(0); asy__mh.push(0); asy__md.push(0);
      asy__mpt.push("0 0 0");
    }
    if (full) asy__dimsave();
  }
  for (int q = 0; q < want.length; ++q) {
    labelrec r = ls[want[q]];
    int h = asy__mfind(wkey[q]);
    if (h >= 0) { r.width = asy__mw[h]; r.height = asy__mh[h]; r.depth = asy__md[h]; }
    r.havebounds = true;
  }
}

// 一条标签占的那个框（drawlabel.cc:106-135 逐句照抄）。默认 baseline 是 NOBASEALIGN，
// 于是 `Depth == depth`、`Align += (0, Depth-depth)` 是个零 —— 那两句留在这儿是为了
// 与那边对得上眼。括号也照那边摆：`Align += pair(0,Depth-depth)` 是先算 Depth-depth
// 再加，写成 `al.y + dep - r.depth` 就多round一次，能差 1 个 ulp。
// `Align *= 0.5/scale0` 同理 —— 先算那个商，不是 `al.x*0.5/s0`。
private void asy__labelbox(box bx, labelrec r) {
  pair al = inverse(r.t) * r.align;
  real s0 = abs(al.x) > abs(al.y) ? abs(al.x) : abs(al.y);
  if (s0 != 0) { real q = 0.5 / s0; al = (al.x * q, al.y * q); }
  al = (al.x - 0.5, al.y - 0.5);
  real vert = r.height + r.depth;
  real dep = r.depth;                       // NOBASEALIGN
  al = (al.x * r.width, al.y * vert);
  al = (al.x, al.y + (dep - r.depth));
  al = r.t * al;
  pair p = r.position + al;
  real fz = asy__psize(r.p) * 0.1 + 0.3;
  addpt(bx, p + r.t * (-fz, -fz));
  addpt(bx, p + r.t * (-fz, vert + fz));
  addpt(bx, p + r.t * (r.width + fz, vert + fz));
  addpt(bx, p + r.t * (r.width + fz, -fz));
}

// 缩放固定为 1 —— frame 的坐标已经是最终坐标了
box framebox(frame f) {
  box bx = opsbox(f.ops, 1);
  if (f.labs.length > 0) {
    asy__measure(f.labs);
    for (int i = 0; i < f.labs.length; ++i) {
      if (f.labs[i].kind != 0) continue;         // 裁剪那两格的影子不占框
      asy__labelbox(bx, f.labs[i]);
    }
  }
  return bx;
}

bool empty(frame f) { return f.ops.length == 0; }

// 空 frame 的 box 四个数都是 0，所以下面三个不用特判空
pair min(frame f) {
  box bx = framebox(f);
  return (bx.l, bx.b);
}

pair max(frame f) {
  box bx = framebox(f);
  return (bx.r, bx.t);
}

pair size(frame f) {
  box bx = framebox(f);
  return (bx.r - bx.l, bx.t - bx.b);
}

void erase(frame f) {
  drawop[] none;
  f.ops = none;
}

// 并进去：src 的元素追加到 dest 后面（量过 `add(g,f)` 之后 max(g) 与 max(f) 一样）。
// 这个名字与用户自己的 `add` 组成同一个重载集 —— 前端按**期望类型**挑重载那一刀补上了，
// 所以 `fold3(add,1,2,3)` 那种写法照样通（cases/42-fntype 钉着）。
void add(frame dest, frame src) {
  // 搬之前记住 dest 里已经有多少格图形：src 的标签记的位置是**在 src 里**的，
  // 搬过来要整段后移这么多，不然分层那一步会把它们全算到第一层去（见 labelrec.at）。
  int base = dest.ops.length;
  for (int i = 0; i < src.ops.length; ++i) dest.ops.push(src.ops[i]);
  // 标签也要跟过来。量出来的：plain_Label.asy:304-310 的 filltype 那一支是
  // 「先 label 到一个临时 frame d，再 add(f,d,filltype)」，不搬的话带 UnFill/Fill 的标签
  // 整条丢掉 —— buildcycle.asy:22 的 `label("$f > 0$",…,UnFill)` 就是这么没的
  // （参考的 %%DocumentFonts 有 CMR12，我们只有 CMMI12，因为那个 `0` 没人排）。
  for (int i = 0; i < src.labs.length; ++i) {
    labelrec q = src.labs[i];
    q.at = q.at + base;
    dest.labs.push(q);
  }
  if (src.haslabel) dest.haslabel = true;
  // 三维那张 op 表与**界**都要跟过来（位图那一档要它们）。界那几格原先故意没搬 ——
  // 那一笔已经作废：`add(picture,picture,triple)` 落到这一格上，不搬界的话子图整段
  // 被裁掉（七行的尺子：参考位图 400x124、我们 404x4）。真身在三维那一段
  // （`path3` 有名字之后）接上，见 asy__merge3hook。
  asy__merge3fn(dest, src);
}

bool fits(picture pic, real s) {
  box bx = picbox(pic, s);
  if (pic.xsize > 0 && bx.r - bx.l > pic.xsize) return false;
  if (pic.ysize > 0 && bx.t - bx.b > pic.ysize) return false;
  return true;
}

// size(…) 那一步解的是「缩放后的 bbox 正好等于要的尺寸」。笔宽**不**跟着缩放，
// 所以宽度是 s 的分段线性函数 —— asy 那边是一个小线性规划（plain_bounds.asy），
// 这里用二分：函数单调，六十四次折半到 1e-19，%.6g 那一档看不出差别。
real fitscale(picture pic) {
  if (pic.xsize <= 0 && pic.ysize <= 0) return 1;
  if (pic.ops.length == 0) return 1;
  real lo = 0;
  real hi = 1;
  while (fits(pic, hi) && hi < 1e9) hi = hi * 2;
  for (int i = 0; i < 64; ++i) {
    real m = 0.5 * (lo + hi);
    if (fits(pic, m)) lo = m;
    else hi = m;
  }
  return lo;
}

// ---------------------------------------------------------------- EPS

// EPS 的每一行都从这里出去。为什么要多这一层：带标签的图**最后一段字节是 dvips 写的**，
// 那条路上底图得先落到盘上（`<前缀>_0.eps`）给 `\includegraphics` 引，而这一层的 write
// 只能往 stdout 去。所以给它一个开关 —— 攒进 `asy__bufs` 还是直接印。
bool asy__tobuf = false;
string asy__bufs = "";
void asy__out(string s) {
  if (asy__tobuf) asy__bufs = asy__bufs + s + '\n';
  else write(s);
}
// 出图落到哪儿：宿主的一格设置（CLI 的 `-o 名字`）。空串 = 印到 stdout，也就是这一层
// 一直以来的默认。与格式那一格同一条道理（ADR-0015）：这是**运行期**的值，不是编译期
// 的选项 —— 同一份产物，`-o a.svg` 与不带 `-o` 跑的是同一个文件。
// 注意只有**图**走这一格：程序自己 `write(...)` 的字还是照旧去 stdout（真 asy 也是
// 这样分的：图进文件，write 进终端）。
string asy__outname() { return _getsetting("OMNI_ASY_OUTNAME"); }
// 出什么格式：同一格宿主设置（CLI 的 `-f FMT`，或者从 `-o 名字`的后缀猜出来的）。
// 隐式出图那一趟（例子结尾）走的 format 是空串 —— plain 那边不把 settings.outformat
// 递下来（真 asy 是 C++ 那一层自己去看 settings::outformat），这一格就是那个位置。
// **格式是运行期的值**，不住在任何模块的变量里。这一条是量出来的教训（ADR-0015）：
// 格式一旦住进某个模块的变量（或者往源码头上贴一句 `asy__defaultformat = "svg";`），
// "编出来的东西"就记住了格式 —— 同一份程序出两种格式得编两遍，产物缓存要按格式分叉。
// 读宿主则相反：一份产物，`-f svg` 与不带 `-f` 跑的是同一个文件，只是那一格设置不同。
string asy__outformat() { return _getsetting("OMNI_ASY_OUTFORMAT"); }
// SVG 那个出口住在文件后面（它要 svgd / svggrad / 那一串属性拼装），而 `shipout(picture)`
// 在前面就要用它。这一层的老办法是**函数变量**（asy__dashadjfn / asy__arclenfn 同一个
// 套路）：这儿声明一格，定义之后装进去。装进去之前是 null，那时只走 EPS。
typedef void asy__svgfn(drawop[], labelrec[], box, real, real, real);
asy__svgfn asy__svgcorefn = null;
// 一份图的前后各一句。回的是那个名字（空串就是"直接印"，两句都是空动作）。
//
// `want` 是**这一张图自己要去的地方**（`shipout("名字")` 那一路，见 `_shipout`）：asy 的规矩是
// `shipout(prefix)` 写 `prefix.<格式>`，主输出只留退出时那次隐式 shipout。不给就照旧用
// `-o` 那个名字（空串 = stdout）。量出来的形状：interpolate1.asy 里有七次
// `shipout("runge1"…"runge7")`，真 asy 落了 8 份（runge1..7.eps 各一张 + interpolate1.eps
// 是退出时那张，也就是第 7 张的副本）；我们从前把 prefix 丢了，七张顺着同一个流叠出来。
string asy__shipbegin(string want = "") {
  string on = want == "" ? asy__outname() : want;
  if (on != "") {
    asy__tobuf = true;
    asy__bufs = "";
  }
  return on;
}
void asy__shipend(string on) {
  if (on == "") return;
  asy__tobuf = false;
  string doc = asy__bufs;
  asy__bufs = "";
  _writetext(on, doc);
}
// 坐标是 **%.9g**，这一条量反过一次，要说准：psfile.h:160 是裸的
// `*out << " " << x`，看着像"ostream 默认 6 位"，但同一个流在 psfile.h:30 写
// `%%HiResBoundingBox` 时做过 `std::setprecision(9)` —— **precision 是粘的**，
// 那一行之后再没有复位（psfile.cc 里没有第二处 precision），所以正文里每个坐标、
// 笔宽、颜色都是 9 位有效数字。先前记成 6 位是因为第一个例子（tri）的数
// 98 / 78.4 / 49 在两档下印出来一样，看不出差别；量一条三次曲线就露了：
// asy 印 `-5.60094532 30.5506108 …`，6 位那一档只有 `-5.60095 30.5506 …`。
// `%%BoundingBox` 那一行是另一路（psfile.h:27 的 setprecision(0)+fixed）。
string ps(real x) { return string(x, 9); }
string ps9(real x) { return string(x, 9); }

// 定点 6 位。TeX 那一侧的数全是这个样子（`\kern -284.527559pt`、`(-0.500000,0.000000)`、
// `bb=-14.589213 …`、`\fontsize{12.000000}`）—— C++ 那边是 `fixed` + `setprecision(6)`，
// 而 `string(x, n)` 是**有效数字**，两回事。
// **负零要留住符号**：C 的 `%f` 印 -0.0 是 `-0.000000`，而 `x < 0` 对 -0.0 是假。
// 量过 spline 的 `\ASYalignT{…}`：参考里是 `1.000000 -0.000000 -0.000000 1.000000`，
// 那两个负号就是 texfile.cc:300 的 `sign*T.getyx()`（sign=-1）乘出来的 -0。
bool asy__negzero(real x) { return x == 0 && 1 / x < 0; }

string asy__f6(real x) {
  bool neg = x < 0 || asy__negzero(x);
  real a = neg ? -x : x;
  real sc = floor(a * 1000000 + 0.5);
  real ip = floor(sc / 1000000);
  int fr = (int) (sc - ip * 1000000);
  string fs = string(fr);
  while (length(fs) < 6) fs = "0" + fs;
  return (neg ? "-" : "") + string((int) ip) + "." + fs;
}

// 定点 9 位。虚线那一句是这个样子（`[3.980000000 3.980000000] 0.000000000 setdash`）——
// psfile.cc:271 那三行把流临时切成 `fixed`，而流的 precision 早先被 `%%HiResBoundingBox`
// 那一处按 9 粘住了，所以是「定点 9 位」，与 TeX 那一侧的定点 6 位不是一回事。
string asy__f9(real x) {
  bool neg = x < 0 || asy__negzero(x);
  real a = neg ? -x : x;
  real sc = floor(a * 1000000000 + 0.5);
  real ip = floor(sc / 1000000000);
  int fr = (int) (sc - ip * 1000000000);
  string fs = string(fr);
  while (length(fs) < 9) fs = "0" + fs;
  return (neg ? "-" : "") + string((int) ip) + "." + fs;
}

// psfile 里 lastpen 一开始是 initialpen —— 与默认笔的每一项都不同，所以第一个元素
// 那几行全印。这里用一个 valid 标志表示"还没有上一支笔"。
pen lastpen;
bool lastvalid = false;

// `gsave` / `grestore` 连**上一支笔**一起存取（psfile.h:303/310：gsave 把 lastpen 压进
// pens 栈，grestore 弹回来）。所以裁剪或渐变那一段里改过的笔，出来之后不算数 ——
// 下一笔要把颜色/宽度那几行重新发一遍。量过 yingyang.asy：`unfill` 那一对 gsave/grestore
// 之后的 `fill` 前面，真 asy 确实又发了 `0 setgray` 那五行。
pen[] pensave;
bool[] pensavevalid;
void gsavepen() {
  pensave.push(pencopy(lastpen));
  pensavevalid.push(lastvalid);
}
void grestorepen() {
  if (pensave.length == 0) return;
  lastpen = pensave.pop();
  lastvalid = pensavevalid.pop();
}

// 颜色分三档，顺序照 psfile.cc:184 的 setcolor：先 cmyk、再 rgb、最后灰。
// 量过 `cmyk(1,0,0.5,0.2)`：asy 发的是 `1 0 0.5 0.2 setcmykcolor`，**不转成 rgb**。
//
// **颜色是 6 位有效数字，不是 9 位**：那一段 C++ 先攒进一个新的 `ostringstream buf`
// （psfile.cc:186），新流的 precision 是默认的 6；坐标与笔宽那些是直接写 `out`，
// 而那个流在印 `%%HiResBoundingBox` 时被 setprecision(9) 粘住了。渐变字典里的颜色又是
// 直接写 out 的（psfile.cc:279 的 write(pen)），所以那一路仍是 9 位（见 wpen）。
// 量出来的：PythagoreanTree.asy 印 `0.461538 0.0769231 0 setrgbcolor`，9 位那一版是
// `0.461538462 …`。
string ps6(real x) { return string(x, 6); }
string colorof(pen p) {
  if (p.iscmyk)
    return ps6(p.cyan) + " " + ps6(p.magenta) + " " + ps6(p.yellow) + " "
      + ps6(p.black) + " setcmykcolor";
  if (p.isrgb) return ps6(p.red) + " " + ps6(p.green) + " " + ps6(p.blue) + " setrgbcolor";
  return ps6(p.gray) + " setgray";
}

bool samecolor(pen a, pen b) {
  // 图案在 asy 那边就是**一种颜色空间**（pen.h，见 patternval 那条），所以"一支带图案、
  // 一支不带"算颜色不同 —— psfile.cc 的 setcolor 比的是 colorspace()。
  // 量出来的：tiling 里 `filldraw(unitcircle, pattern("checker"))` 先按图案填、再用黑笔描边，
  // 参考在描边前发了一句 `0 setgray`；不比这一格的话那一句就被"颜色没变"吞掉了。
  if ((a.patternval != "") != (b.patternval != "")) return false;
  if (a.iscmyk != b.iscmyk || a.isrgb != b.isrgb) return false;
  if (a.iscmyk)
    return a.cyan == b.cyan && a.magenta == b.magenta
      && a.yellow == b.yellow && a.black == b.black;
  if (a.isrgb) return a.red == b.red && a.green == b.green && a.blue == b.blue;
  return a.gray == b.gray;
}

// 虚线那一格（psfile.cc:266-274）：pattern 或 offset 变了就发一句
// `[a b …] offset setdash`。空 pattern 发 `[] 0.000000000 setdash`（实线）——
// 这一句不能省：前一支笔留下的虚线花样会一直粘着后面所有的描边。
bool asy__samedash(pen a, pen b) {
  if (a.dashpat.length != b.dashpat.length) return false;
  for (int i = 0; i < a.dashpat.length; ++i) if (a.dashpat[i] != b.dashpat[i]) return false;
  return a.dashoffset == b.dashoffset;
}
string asy__dashstr(pen p) {
  string s = "[";
  for (int i = 0; i < p.dashpat.length; ++i) {
    if (i > 0) s = s + " ";
    s = s + asy__f9(p.dashpat[i]);
  }
  return s + "] " + asy__f9(p.dashoffset) + " setdash";
}

// 虚线的节拍要按**弧长**收一收（drawpath.cc:198-201：描边前先 adjustdash），而
// `arclength(path)` 与 `adjust(pen,real,bool)` 都定义在这个文件的后面 —— 名字解析是顺着来的，
// 所以这里先摆两个桩，等它们定义好之后在下面接上（搜 asy__dashhook）。
// 弧长按**均匀缩放线性**处理：这一层 emitop 收到的是一个实数缩放 s，
// `arclength(scale(s)*g) == s*arclength(g)`，所以桩只要量原坐标那一份。
real asy__arclenfn(path p) { return 0; }
pen asy__dashadjfn(pen p, real arclen, bool cyclic) { return p; }

// 笔自己带的变换（drawelement.h:322-342 的 penSave/penTranslate/penConcat/penRestore）。
// `isIdentity()`（transform.h:99）比的是**六个数**，不是"看起来像单位"—— 这一格要紧：
// yaxisAt 那句 `t*T*tinv*d` 把 shiftless(t*T*tinv) 摁进笔里，浮点上 s*(1/s) 不见得正好
// 是 1，于是这笔笔笔都要 gsave；而 concat 印出来按 9 位有效数字又正好是 `[ 1 0 0 1 0 0]`。
// 量过 spline 的 x/y 轴：参考里每一条刻度线都套着 gsave/…/grestore。
bool asy__istrans(pen p) {
  // 判据照 asy 的字面：`!pentype.getTransform().isIdentity()`（drawelement.h:322）。
  //
  // 试过换成"只看带没带变换"（`return p.hastrans;`）—— 参考里坐标轴那两笔外面确实套着
  // `gsave` + `[ 1 0 0 1 0 0] concat` + `grestore`（cardioid_0.eps:224-235），说明 asy 那边
  // 那个矩阵不是精确单位（graph.asy 的轴走 `pic.add(…)`，笔上乘过 t 又乘过 inverse(t)，
  // 剩 1e-16；`write(transform)` 只印 6 位，看着像单位）。但**换过去是各有输赢**：
  // cardioid 的首处差从结构挪成了数值（4257 -> 4277 token，参考 4339），而 alignedaxis
  // 反而从 8026 涨到 9367（参考 6590）—— 我们这边 `hastrans` 为真的地方比 asy 那边
  // "矩阵带零头"的地方**多**。所以退回来：这一格要的是"哪些笔真带了变换"这份账，
  // 不是把判据放宽。
  if (!p.hastrans) return false;
  transform t = p.pentrans;
  return !(t.x == 0 && t.y == 0 && t.xx == 1 && t.xy == 0 && t.yx == 0 && t.yy == 1);
}
// `concat` 自己也挡一道单位（psfile.h:330），所以剥掉平移之后仍要再问一次。
void asy__penconcat(pen p) {
  if (!p.hastrans) return;
  transform t = shiftless(p.pentrans);
  if (t.xx == 1 && t.xy == 0 && t.yx == 0 && t.yy == 1) return;
  asy__out("[ " + ps(t.xx) + " " + ps(t.yx) + " " + ps(t.xy) + " " + ps(t.yy)
        + " 0 0] concat");
}
// `translate` 那一句遇到 (0,0) 直接不发（psfile.h:321）。笔上的变换多数是 shiftless 来的，
// 这一格于是基本不出手；留着是为了 `t*pen` 这条明写的路子。
void asy__pentranslate(pen p, real s) {
  if (!p.hastrans) return;
  transform t = p.pentrans;
  if (t.x == 0 && t.y == 0) return;
  asy__out(" " + ps(s * t.x) + " " + ps(s * t.y) + " translate");
}

void setpen(pen p) {
  // 图案那一格在颜色**之前**分岔（psfile.cc:248）：笔带了图案、而且与上一支笔的图案不同，
  // 就发一句 `<名字> setpattern`，**不发颜色**；否则照旧走颜色那一支（哪怕两支笔的图案一样，
  // asy 也是回去问颜色的 —— 照它的字面）。
  if (p.patternval != "" && (!lastvalid || p.patternval != lastpen.patternval)) {
    asy__out(p.patternval + " setpattern");
  } else if (!lastvalid || !samecolor(p, lastpen)) asy__out(colorof(p));
  if (!lastvalid || p.width != lastpen.width) asy__out(ps(p.width) + " Setlinewidth");
  if (!lastvalid || p.cap != lastpen.cap) asy__out(string(p.cap) + " setlinecap");
  if (!lastvalid || p.join != lastpen.join) asy__out(string(p.join) + " setlinejoin");
  if (!lastvalid || p.miter != lastpen.miter) asy__out(ps(p.miter) + " setmiterlimit");
  // 第一支笔那一格与别的几项**不一样**：psfile 的 initialpen 里颜色/宽/cap/join/miter
  // 都是不可能的值（-2、-1、INVISIBLE），所以第一次一定发；而它的 LineType 是
  // `LineType(array(0), 0.0, …)` —— 空 pattern、offset 0（pen.h:411），与实线一模一样，
  // 所以第一条实线**不发** setdash。量出来的：sacylinder 的参考里第一句 setdash 在第 1057 行，
  // 前面那些实线的描边一句都没有。
  bool dashchg = lastvalid ? !asy__samedash(p, lastpen)
    : (p.dashpat.length > 0 || p.dashoffset != 0);
  if (dashchg) asy__out(asy__dashstr(p));
  lastpen = pencopy(p);
  lastvalid = true;
}

// 路径本身（psfile.h:295..312 那一段照搬）：第一句是 `newpath … moveto`，
// 直的段发 lineto、弯的发 curveto；闭合的路径末尾多一句回到起点再 closepath。
// `newPath` 是给**超路径**用的（drawelement.h:397）：一条超路径只发一句 newpath，
// 后面那几条子路径接着发 moveto —— 这样一次 clip 才把它们当同一条路径。
void emitpath(path g, real s, bool newPath=true) {
  int n = g.nodes.length;
  pair z0 = s * g.nodes[0].point;
  asy__out((newPath ? "newpath " : " ") + ps(z0.x) + " " + ps(z0.y) + " moveto");
  for (int i = 1; i < n; ++i) {
    pair z = s * g.nodes[i].point;
    if (g.nodes[i - 1].straight) asy__out(" " + ps(z.x) + " " + ps(z.y) + " lineto");
    else {
      pair c1 = s * g.nodes[i - 1].post;
      pair c2 = s * g.nodes[i].pre;
      asy__out(" " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z.x) + " " + ps(z.y) + " curveto");
    }
  }
  if (g.cyclic) {
    if (g.nodes[n - 1].straight) asy__out(" " + ps(z0.x) + " " + ps(z0.y) + " lineto");
    else {
      pair c1 = s * g.nodes[n - 1].post;
      pair c2 = s * g.nodes[0].pre;
      asy__out(" " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z0.x) + " " + ps(z0.y) + " curveto");
    }
    asy__out("closepath");
  } else if (n == 1) {
    asy__out(" " + ps(z0.x) + " " + ps(z0.y) + " lineto");
  }
}

// ---------------------------------------- 渐变/网格填充（drawfill.h 的 drawShade 一支）
// 颜色空间在这一层用**分量个数**记（pen.h:85 的 ColorComponents）：1 灰、3 rgb、4 cmyk。
// 一族笔取最大的那一档（psfile.h:352 的 maxcolorspace；没设过颜色的按默认笔算，是灰）。
int csof(pen p) { return p.iscmyk ? 4 : (p.isrgb ? 3 : 1); }
int maxcs(pen[] ps) {
  int c = 1;
  for (int i = 0; i < ps.length; ++i) { int m = csof(ps[i]); if (m > c) c = m; }
  return c;
}
int maxcs2(pen[][] ps) {
  int c = 1;
  for (int i = 0; i < ps.length; ++i) { int m = maxcs(ps[i]); if (m > c) c = m; }
  return c;
}
string csname(int c) { return c == 4 ? "CMYK" : (c == 3 ? "RGB" : "Gray"); }

// 一支笔升到 cs 那一档之后的分量（pen.h:591/602/608 的 greytorgb / greytocmyk /
// rgbtocmyk）。cs 是**一族里最大的**那一档，所以只会往上升，不会往下降。
real[] pencomps(pen p, int cs) {
  real[] v;
  int c = csof(p);
  if (cs == 1) { v.push(p.gray); return v; }
  if (cs == 3) {
    if (c == 3) { v.push(p.red); v.push(p.green); v.push(p.blue); }
    else { v.push(p.gray); v.push(p.gray); v.push(p.gray); }
    return v;
  }
  if (c == 4) { v.push(p.cyan); v.push(p.magenta); v.push(p.yellow); v.push(p.black); return v; }
  if (c == 1) { v.push(0); v.push(0); v.push(0); v.push(1 - p.gray); return v; }
  // `max(real,real)` 在这一行还看不见（内建面是顺序解析的，这里只有 `pair max(frame)`）
  real sat = p.red;
  if (p.green > sat) sat = p.green;
  if (p.blue > sat) sat = p.blue;
  if (sat == 0) { v.push(0); v.push(0); v.push(0); v.push(1); return v; }
  v.push(1 - p.red / sat);
  v.push(1 - p.green / sat);
  v.push(1 - p.blue / sat);
  v.push(1 - sat);
  return v;
}

// psfile.cc:279 的 write(pen)：分量用空格分开，**开头不带**空格。
string wpen(pen p, int cs) {
  real[] v = pencomps(p, cs);
  string s = "";
  for (int i = 0; i < v.length; ++i) s += (i == 0 ? "" : " ") + ps(v[i]);
  return s;
}
// psfile.h:168/160 的 write(pair) / write(double)：**开头带**一个空格。
string wpair(pair z) { return " " + ps(z.x) + " " + ps(z.y); }
string wreal(real x) { return " " + ps(x); }

// pen.h:143 的 byte：负的按 0，`(int)(r*256)` 之后顶到 255
string hex2(real r) {
  string d = "0123456789abcdef";
  real x = r < 0 ? 0 : r;
  int c = (int) (x * 256);
  if (c > 255) c = 255;
  return substr(d, c # 16, 1) + substr(d, c % 16, 1);
}

// 一条路径按 t 变过去之后的界（latticeshade 的 /Matrix 要它）
void pathboxT(box eb, path g, transform t, real s) {
  int n = g.nodes.length;
  int segs = length(g);
  for (int i = 0; i < n; ++i) addpt(eb, s * (t * g.nodes[i].point));
  for (int i = 0; i < segs; ++i) {
    int j = i + 1;
    if (j == n) j = 0;
    if (!g.nodes[i].straight) {
      addcubic(eb, s * (t * g.nodes[i].point), s * (t * g.nodes[i].post),
               s * (t * g.nodes[j].pre), s * (t * g.nodes[j].point));
    }
  }
}

// psfile.cc:316 的 latticeshade（/ShadingType 1 + FunctionType 0 的采样表）。
// 行是**从后往前**发的（PostScript 的 /Size 是 [列 行]，数据从下往上），每支笔一行十六进制。
void latshade(shadeinfo h, pen fillrule, real s) {
  int n = h.mpens.length;
  if (n == 0) return;
  int m = h.mpens[0].length;
  int cs = maxcs2(h.mpens);
  // /Matrix 是 t * matrix(界的左下, 界的右上)（drawfill.h:107 的 shade）：界在
  // **t 变回去之后**的坐标里量。matrix(lb,rt) 就是"平移 lb、线性部分 diag(rt-lb)"。
  transform ti = inverse(h.tt);
  box b;
  for (int i = 0; i < h.gs.length; ++i) pathboxT(b, h.gs[i], ti, s);
  if (h.stroke) widen(b, fillrule);
  transform mt = h.tt * xform(b.l, b.b, b.r - b.l, 0, 0, b.t - b.b);
  asy__out("<< /ShadingType 1");
  asy__out("/Matrix [" + wreal(mt.xx) + wreal(mt.yx) + wreal(mt.xy) + wreal(mt.yy)
        + wreal(mt.x) + wreal(mt.y) + "]");
  asy__out("/ColorSpace /Device" + csname(cs));
  asy__out("/Function");
  asy__out("<< /FunctionType 0");
  asy__out("/Order 1");
  asy__out("/Domain [0 1 0 1]");
  string rng = "";
  for (int i = 0; i < cs; ++i) rng += "0 1 ";
  asy__out("/Range [" + rng + "]");
  asy__out("/Decode [" + rng + "]");
  asy__out("/BitsPerSample 8");
  asy__out("/Size [" + string(m) + " " + string(n) + "]");
  asy__out("/DataSource <");
  for (int i = n - 1; i >= 0; --i) {
    pen[] row = h.mpens[i];
    if (row.length != m) abort("matrix must be rectangular");
    for (int j = 0; j < m; ++j) {
      real[] v = pencomps(row[j], cs);
      string t = "";
      for (int k = 0; k < v.length; ++k) t += hex2(v[k]);
      asy__out(t);
    }
  }
  asy__out(">");
  asy__out(">>");
  asy__out(">>");
  asy__out("shfill");
}

// psfile.cc:373 的 gradientshade：axial 是 /ShadingType 2、radial 是 3（radial 多两个半径）。
// **注意这里还会再发一次 clip**（那份 C++ 里 `endclip(pena)` 就在开头），所以渐变那两档的
// EPS 里 clip 出现两次 —— 量过 axialshade.asy 的参考，确实是两行。
void gradshade(shadeinfo h, real s) {
  bool axial = h.st == 2;
  int cs = csof(h.pena);
  if (csof(h.penb) > cs) cs = csof(h.penb);
  asy__out(h.pena.evenodd ? "eoclip" : "clip");
  asy__out("<< /ShadingType " + (axial ? "2" : "3"));
  asy__out("/ColorSpace /Device" + csname(cs));
  string co = wpair(s * h.za);
  if (!axial) co += wreal(s * h.ra);
  co += wpair(s * h.zb);
  if (!axial) co += wreal(s * h.rb);
  asy__out("/Coords [" + co + "]");
  asy__out("/Extend [" + (h.exta ? "true" : "false") + " " + (h.extb ? "true" : "false") + "]");
  asy__out("/Function");
  asy__out("<< /FunctionType 2");
  asy__out("/Domain [0 1]");
  asy__out("/C0 [" + wpen(h.pena, cs) + "]");
  asy__out("/C1 [" + wpen(h.penb, cs) + "]");
  asy__out("/N 1");
  asy__out(">>");
  asy__out(">>");
  asy__out("shfill");
}

// psfile.cc:408 的 gouraudshade（/ShadingType 4）：每行是「边标记 顶点 颜色」
void gourshade(shadeinfo h, pen fillrule, real s) {
  int n = h.vpens.length;
  if (n == 0) return;
  int cs = maxcs(h.vpens);
  asy__out(fillrule.evenodd ? "eoclip" : "clip");
  asy__out("<< /ShadingType 4");
  asy__out("/ColorSpace /Device" + csname(cs));
  asy__out("/DataSource [");
  for (int i = 0; i < n; ++i) {
    asy__out(" " + string(h.vedges[i]) + wpair(s * h.verts[i]) + " " + wpen(h.vpens[i], cs));
  }
  asy__out("]");
  asy__out(">>");
  asy__out("shfill");
}

// psfile.cc:451 的 tensorshade（/ShadingType 7）：每块补丁一行 —— 边标记 0、
// **倒着走**的 12 个边界控制点、4 个内部控制点、4 个角上的颜色（次序 0/3/2/1）。
// 没给内部点时按 Coons 那个公式算（那 1/9 与几个系数照抄）。
void tenshade(shadeinfo h, pen fillrule, real s) {
  int n = h.mpens.length;
  if (n == 0) return;
  int cs = maxcs2(h.mpens);
  asy__out(fillrule.evenodd ? "eoclip" : "clip");
  asy__out("<< /ShadingType 7");
  asy__out("/ColorSpace /Device" + csname(cs));
  asy__out("/DataSource [");
  int nz = h.tz.length;
  real nineth = 1.0 / 9.0;
  for (int i = 0; i < n; ++i) {
    path g = h.bnds[i];
    if (!g.cyclic || length(g) != 4) abort("specify cyclic path of length 4");
    string ln = " 0";
    for (int j = 4; j > 0; --j) {
      ln += wpair(s * point(g, j)) + wpair(s * precontrol(g, j))
        + wpair(s * postcontrol(g, j - 1));
    }
    if (nz == 0) {
      for (int j = 0; j < 4; ++j) {
        pair c = nineth * (-4.0 * point(g, j)
          + 6.0 * (precontrol(g, j) + postcontrol(g, j))
          - 2.0 * (point(g, j - 1) + point(g, j + 1))
          + 3.0 * (precontrol(g, j - 1) + postcontrol(g, j + 1))
          - point(g, j + 2));
        ln += wpair(s * c);
      }
    } else {
      pair[] zi = h.tz[i];
      if (zi.length != 4) abort("specify 4 internal control points for each path");
      ln += wpair(s * zi[0]) + wpair(s * zi[3]) + wpair(s * zi[2]) + wpair(s * zi[1]);
    }
    pen[] pi = h.mpens[i];
    if (pi.length != 4) abort("specify 4 pens for each path");
    ln += " " + wpen(pi[0], cs) + " " + wpen(pi[3], cs)
      + " " + wpen(pi[2], cs) + " " + wpen(pi[1], cs);
    asy__out(ln);
  }
  asy__out("]");
  asy__out(">>");
  asy__out("shfill");
}

// drawfill.h:75 的 drawShade::draw：gsave、超路径当裁剪、endpsclip、发那一段字典、grestore。
void emitshade(drawop o, real s) {
  shadeinfo h = o.sh;
  if (h.gs.length == 0) return;
  asy__out("gsave");
  gsavepen();
  for (int i = 0; i < h.gs.length; ++i) emitpath(h.gs[i], s, i == 0);
  if (h.stroke) asy__out("strokepath");
  asy__out(o.p.evenodd ? "eoclip" : "clip");
  if (h.st == 1) latshade(h, o.p, s);
  else if (h.st == 2 || h.st == 3) gradshade(h, s);
  else if (h.st == 4) gourshade(h, o.p, s);
  else tenshade(h, o.p, s);
  asy__out("grestore");
  grestorepen();
}

/* ---------------------------------------------------------------- 位图那一格
 * `_image(…)` 出图。结构照 dvips 出来的参考**逐字抄**（`.omni-cache/epsref/laserlattice.eps`
 * 那一块，asy 三维那一族嵌进去的图也是同一块，只是 W/H 与 concat 矩阵不同）：
 *
 *   gsave
 *   [ a b c d tx ty] concat            % 单位正方形 -> 目标平行四边形
 *   /DeviceRGB setcolorspace
 *   << /ImageType 1 /Width W /Height H /BitsPerComponent 8 /Decode [0 1 0 1 0 1 ]
 *      /ImageMatrix [W 0 0 H 0 0]
 *      /DataSource currentfile 1 (~>) /SubFileDecode filter /ASCII85Decode filter >>
 *   image
 *   <ASCII85 的字节…>~>
 *   grestore
 *
 * **Flate 那一行我们不发**：`/ASCII85Decode` 单独就是合法的 EPS，字节数约是原始像素的
 * 1.25 倍（与参考同一量级）。参考那边多一层 `/FlateDecode`，所以那一段数据两边**逐字节
 * 对不上是必然的** —— 位图那一档的判据本来就得是"解出来比像素"，不是比 token（ADR-0014）。
 *
 * 第一条扫描线落在 `ImageMatrix` 的 y=0 上，也就是**下**边那一行：`data[0]` 先发
 * （asy 的 `image(real[][] f, …)` 里 f[0] 也是最下面那一行，palette.asy 不翻转）。
 */
// 85 个字符（33 '!' 到 117 'u'）。**反斜杠只写一个** —— asy 的字符串字面量里 `\` 不是
// 转义引导（量过：`"[\\]"` 的 length 是 3，真 asy 与我们都一样），写两个的话这张表就是
// 86 个字符、`\` 之后所有下标偏一位。那个错法很能骗人：图的尺寸、朝向、摆放全对，
// 逐字节比也有 45.8% 相同（平坦的地方偏一位还是同一个颜色），只有颜色变化处冒出
// **不在色板里的颜色**（量出来的：像素 0 我们 (11,246,144)，色板里根本没有这一格）。
private string asy__a85tab =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstu";

// 0..1 -> 一个字节，照 pen.h:143 的 `byte()` 逐字抄：**截断 `r*256`、夹到 255**，
// 不是 `round(r*255)`。量出来的差别：`round(255v)` 那一版逐字节只有 84% 相同（差都是 ±1），
// 换成这一条之后 100% 相同（laserlattice 四块图）。
private int asy__b255(real v) {
  real r = v < 0 ? 0 : v;
  int c = (int) (r * 256);
  return c < 255 ? c : 255;
}

// 一格 pen -> 三个字节（DeviceRGB）。灰与 cmyk 先换成 rgb：那块图的色空间是
// /DeviceRGB，一格一格换比在字典里换色空间省事，而且与 `colorof` 那一份口径一致。
private int[] asy__pixrgb(pen p) {
  int[] o;
  if (p.iscmyk) {
    o.push(asy__b255((1 - p.cyan) * (1 - p.black)));
    o.push(asy__b255((1 - p.magenta) * (1 - p.black)));
    o.push(asy__b255((1 - p.yellow) * (1 - p.black)));
    return o;
  }
  if (p.isrgb) {
    o.push(asy__b255(p.red));
    o.push(asy__b255(p.green));
    o.push(asy__b255(p.blue));
    return o;
  }
  o.push(asy__b255(p.gray));
  o.push(asy__b255(p.gray));
  o.push(asy__b255(p.gray));
  return o;
}

// 同一格换算，但**不量化成字节**：着色（fragment.glsl）整段在 0..1 上算，
// 量化只该发生在最后写像素那一步。位图那一档的 PBR 用这一份。
private real[] asy__penrgb(pen p) {
  if (p.iscmyk)
    return new real[] {(1 - p.cyan) * (1 - p.black),
                       (1 - p.magenta) * (1 - p.black),
                       (1 - p.yellow) * (1 - p.black)};
  if (p.isrgb) return new real[] {p.red, p.green, p.blue};
  return new real[] {p.gray, p.gray, p.gray};
}

// 4 个字节 -> 5 个字符（85 进制，高位先出）。`n` 是这一组真有几个字节：不足 4 的那一组
// 按 0 补齐、只发 n+1 个字符（PostScript 的 ASCII85 就是这条），而且**不缩成 z**。
private string asy__a85grp(int b0, int b1, int b2, int b3, int n) {
  int v = ((b0 * 256 + b1) * 256 + b2) * 256 + b3;
  if (n == 4 && v == 0) return "z";
  int c4 = v % 85; v = v # 85;
  int c3 = v % 85; v = v # 85;
  int c2 = v % 85; v = v # 85;
  int c1 = v % 85; v = v # 85;
  string s = substr(asy__a85tab, v, 1) + substr(asy__a85tab, c1, 1)
    + substr(asy__a85tab, c2, 1) + substr(asy__a85tab, c3, 1)
    + substr(asy__a85tab, c4, 1);
  return substr(s, 0, n + 1);
}

// 像素流 -> 一行一行印出去（末尾那句 `~>` 是 SubFileDecode 的结束记号）
private void asy__emitpixels(pen[][] data, int w, int h) {
  string line = "";
  int[] g = new int[4];
  int gn = 0;
  for (int j = 0; j < h; ++j) {
    pen[] row = data[j];
    for (int i = 0; i < w; ++i) {
      int[] px = asy__pixrgb(row[i]);
      for (int k = 0; k < 3; ++k) {
        g[gn] = px[k];
        gn = gn + 1;
        if (gn == 4) {
          line = line + asy__a85grp(g[0], g[1], g[2], g[3], 4);
          gn = 0;
          if (length(line) >= 76) { asy__out(line); line = ""; }
        }
      }
    }
  }
  if (gn > 0) {
    for (int k = gn; k < 4; ++k) g[k] = 0;
    line = line + asy__a85grp(g[0], g[1], g[2], g[3], gn);
  }
  asy__out(line + "~>");
}

// 裸字节 -> ASCII85（kind == 7 用）。与 asy__emitpixels 同一条，只是像素来源换成
// 一条按 RGB 排好的 int[]：三维那条路一张 372x400 的图是 446400 个字节，
// 走 pen[][] 的话要 148800 个 pen 对象，这一层扛不住。
private void asy__emitbytes(int[] b) {
  string line = "";
  int[] g = new int[4];
  int gn = 0;
  int n = b.length;
  for (int i = 0; i < n; ++i) {
    g[gn] = b[i];
    gn = gn + 1;
    if (gn == 4) {
      line = line + asy__a85grp(g[0], g[1], g[2], g[3], 4);
      gn = 0;
      if (length(line) >= 76) { asy__out(line); line = ""; }
    }
  }
  if (gn > 0) {
    for (int k = gn; k < 4; ++k) g[k] = 0;
    line = line + asy__a85grp(g[0], g[1], g[2], g[3], gn);
  }
  asy__out(line + "~>");
}

// 一个字节 -> 两位十六进制（小写，与 `xxd -p` 一致）
string asy__hex2(int v) {
  string d = "0123456789abcdef";
  int b = v < 0 ? 0 : (v > 255 ? 255 : v);
  return substr(d, b # 16, 1) + substr(d, b % 16, 1);
}

// 一格裸位图（kind == 7）：dict 与 kind == 5 的差别只有 filter —— 数据是十六进制文本，
// 所以是 /ASCIIHexDecode（EOD 记号 `>`），不是 /ASCII85Decode。
private void asy__emitraw(drawop o, real s) {
  int w = o.rw;
  int h = o.rh;
  if (w == 0 || h == 0) return;
  if (length(o.rawhex) == 0) return;
  pair p00 = o.g.nodes[0].point * s;
  pair p10 = o.g.nodes[1].point * s;
  pair p01 = o.g.nodes[3].point * s;
  pair ax = p10 - p00;
  pair ay = p01 - p00;
  asy__out("gsave");
  asy__out("[ " + ps(ax.x) + " " + ps(ax.y) + " " + ps(ay.x) + " " + ps(ay.y)
    + " " + ps(p00.x) + " " + ps(p00.y) + "] concat");
  asy__out("/DeviceRGB setcolorspace");
  asy__out("<<");
  asy__out("/ImageType 1");
  asy__out("/Width " + string(w));
  asy__out("/Height " + string(h));
  asy__out("/BitsPerComponent 8");
  asy__out("/Decode [0 1 0 1 0 1 ]");
  asy__out("/ImageMatrix [" + string(w) + " 0 0 " + string(h) + " 0 0]");
  asy__out("/DataSource currentfile 1 (>) /SubFileDecode filter /ASCIIHexDecode filter");
  asy__out(">>");
  asy__out("image");
  asy__out(o.rawhex);
  asy__out(">");
  asy__out("grestore");
}

// 一格位图（kind == 5）。目标矩形躺在 `o.g` 的前四个结点上（P00 -- P10 -- P11 -- P01），
// 于是 concat 的矩阵就是"把单位正方形送到这四个角"的那一个 —— 旋转过的图（参考里
// laserlattice 那块就是）跟着白捡。`s` 是出图那一层的缩放，与 emitpath 同一个口径。
private void asy__emitimg(drawop o, real s) {
  pen[][] d = o.img;
  int h = d.length;
  if (h == 0) return;
  int w = d[0].length;
  if (w == 0) return;
  pair p00 = o.g.nodes[0].point * s;
  pair p10 = o.g.nodes[1].point * s;
  pair p01 = o.g.nodes[3].point * s;
  pair ax = p10 - p00;
  pair ay = p01 - p00;
  asy__out("gsave");
  // `[` 之后有一个空格 —— asy 那边 `write(transform)` 就是这么印的（`[ 1 0 0 1 0 0]`），
  // 按"数与算符"的流比的时候 `[0` 与 `[` + `0` 是两回事（量出来的：laserlattice 的首处差
  // 就是 `#3730 参考 [ vs 我们 [0`）。
  asy__out("[ " + ps(ax.x) + " " + ps(ax.y) + " " + ps(ay.x) + " " + ps(ay.y)
    + " " + ps(p00.x) + " " + ps(p00.y) + "] concat");
  asy__out("/DeviceRGB setcolorspace");
  asy__out("<<");
  asy__out("/ImageType 1");
  asy__out("/Width " + string(w));
  asy__out("/Height " + string(h));
  asy__out("/BitsPerComponent 8");
  asy__out("/Decode [0 1 0 1 0 1 ]");
  asy__out("/ImageMatrix [" + string(w) + " 0 0 " + string(h) + " 0 0]");
  asy__out("/DataSource currentfile 1 (~>) /SubFileDecode filter /ASCII85Decode filter");
  asy__out(">>");
  asy__out("image");
  asy__emitpixels(d, w, h);
  asy__out("grestore");
}

// 一格 drawop 的 EPS（shipout(picture) 与 _shipout(frame) 共用；两处只有缩放不同）
//
// `cont`/`last` 是**一组填充**里的位置（见 drawop.merge）：asy 那边 `fill(f, path[] g, p)`
// 是**一个** drawFill，drawfill.cc:49-52 走的是 writepath（每条子路径一句、只有第一条发
// newpath）+ 一句 fill —— 一组路径连着 fillrule 才挖得出洞。这一层一条路径一格 op，
// 于是靠这两个标记把一组重新拼回去：中间那些只攒路径，笔与 `fill`/`eofill` 留到最后一条。
void emitop(drawop o, real s, bool cont = false, bool last = true) {
  if (o.kind == 2) { emitshade(o, s); return; }
  if (o.kind == 5) { asy__emitimg(o, s); return; }
  if (o.kind == 7) { asy__emitraw(o, s); return; }
  // 逐字照发（kind == 6）：`postscript(frame, string)` 那一路。asy 那边也是原样进产物
  // （drawVerbatim），所以这儿一个字都不动。
  if (o.kind == 6) { asy__out(o.psraw); return; }
  // 裁剪的两格（drawclipbegin.h:52 / drawclipend.h:45）：`gsave` + 超路径 + clip，
  // 配对的那一格只发 `grestore`。空路径时只有 gsave / grestore（那份 C++ 的 `empty()` 那一支）。
  if (o.kind == 3) {
    if (!o.nosave) { asy__out("gsave"); gsavepen(); }
    for (int i = 0; i < o.sh.gs.length; ++i) emitpath(o.sh.gs[i], s, i == 0);
    if (o.sh.gs.length == 0) return;
    if (o.sh.stroke) asy__out("strokepath");
    asy__out(o.p.evenodd ? "eoclip" : "clip");
    return;
  }
  if (o.kind == 4) { if (!o.nosave) { asy__out("grestore"); grestorepen(); } return; }
  // 不可见的笔什么都不发，空路径也一样 —— 那是 drawpath.cc:195 与 drawfill.cc:48 的第一句
  // （`if(n == 0 || pentype.invisible()) return true;`）。少了这一条，flowchart 的
  // `roundrectangle`（默认 `fillpen=invisible`）在我们这边真的把框涂上了：controlsystem
  // 的第一处差就是它，而且这不只是差字节，是画错了。
  if (o.p.isinvisible || o.g.nodes.length == 0) return;
  // 笔自己的变换要摊开 —— **填充与描边都要**（drawfill.h:39-48 的 palette/fill 与
  // drawpath.cc:203-217 的 draw 走的是同一对 penSave/penRestore，drawelement.h:322-342）：
  //   描边：penSave → penTranslate → 路径 → penConcat → setpen → stroke → penRestore
  //   填充：penSave → penTranslate → 路径 →           setpen → fill   → penRestore
  // **concat 只有描边发**（路径一旦建好就落在设备空间了，之后改 CTM 只影响笔尖形状；
  // 填充用不着），而 gsave/grestore 两边都发。少了填充那一半，cards 里参考把每一笔填充
  // 都裹在 gsave/grestore 里、grestore 还把 lastpen 弹回去（psfile.h:307/313），
  // 我们不裹于是后面那一笔描边多印一句 `0 setgray`。
  // 一组填充（merge）只在**头一格** penSave、**末一格** penRestore。
  bool ptrans = asy__istrans(o.p);
  if (ptrans && !cont) { asy__out("gsave"); gsavepen(); }
  if (!cont) asy__pentranslate(o.p, s);
  emitpath(o.g, s, !cont);
  if (!last) return;
  // 描边前先把虚线的节拍收一收（drawpath.cc:198-201）。填充那一支不看虚线。
  // 与那边有一处对不上要说清：asy 量的是 `p.transformed(inverse(笔的变换))` 的弧长，
  // 这一层的笔基本没有自己的变换（hastrans），所以直接量路径本身。
  pen q = o.p;
  if (o.kind == 0 && q.dashpat.length > 0) {
    q = asy__dashadjfn(q, s * asy__arclenfn(o.g), o.g.cyclic);
  }
  if (o.kind == 0) asy__penconcat(o.p);
  setpen(q);
  if (o.kind == 0) asy__out("stroke");
  else if (o.p.evenodd) asy__out("eofill");
  else asy__out("fill");
  if (ptrans) { asy__out("grestore"); grestorepen(); }
}

// 摆放是量出来的（picture.cc:1187 那一段）：bboxshift = (-b.left,-b.bottom) 之后再加
// 半格"多出来的纸"—— xexcess = max(paperwidth-(宽+1), 0)、yexcess 同理。**那个 max 不能省**：
// 图比纸还宽时 excess 是 0，左边就顶在 0 上（量过 yingyang.asy：宽 708.66 > 611，
// 参考的 %%BoundingBox 左边是 0，而"(612-宽)/2-0.5"那一版给的是 -49）。
// 纸是 letter 的 612x792。
real asy__excess(real paper, real len) {
  real e = paper - (len + 1.0);
  return e < 0 ? 0 : e;
}
// `asy__shipped`：印过一张没有。退出时那一次隐式 shipout 靠它挡重复，见下面 atexit 那一段。
bool asy__shipped = false;
void shipout(picture pic) {
  asy__shipped = true;
  string asy__on = asy__shipbegin();
  real s = fitscale(pic);
  box bx = picbox(pic, s);
  real w = bx.r - bx.l;
  real h = bx.t - bx.b;
  // SVG 那一路（`-f svg`）。这一份出口是"不 import plain 时"走的，标签那一列在这条路上
  // 本来就没有（这一层的 picture 不攒 labelrec），所以递一个空的进去。
  // 不套纸（612x792）—— SVG 的画布就是图本身，与 `_shipout` 那一份同一条。
  if (asy__svgcorefn != null && asy__outformat() == "svg") {
    labelrec[] asy__nolabs;
    asy__svgcorefn(pic.ops, asy__nolabs, bx, w, h, s);
    asy__shipend(asy__on);
    return;
  }
  real ox = 0.5 * asy__excess(612, w);
  real oy = 0.5 * asy__excess(792, h);
  asy__out("%!PS-Adobe-3.0 EPSF-3.0");
  asy__out("%%BoundingBox: " + string(floor(ox)) + " " + string(floor(oy)) + " "
        + string(ceil(ox + w)) + " " + string(ceil(oy + h)));
  asy__out("%%HiResBoundingBox: " + ps9(ox) + " " + ps9(oy) + " "
        + ps9(ox + w) + " " + ps9(oy + h));
  asy__out("%%Creator: Omni asy");
  asy__out("%%Pages: 1");
  asy__out("%%Page: 1 1");
  asy__out("/Setlinewidth {0 exch dtransform dup abs 1 lt {pop 0}{round} ifelse");
  asy__out("idtransform setlinewidth pop} bind def");
  asy__out("gsave");
  asy__out(" " + ps(ox - bx.l) + " " + ps(oy - bx.b) + " translate");
  lastvalid = false;
  for (int i = 0; i < pic.ops.length; ++i)
    emitop(pic.ops[i], s, pic.ops[i].merge,
           i + 1 >= pic.ops.length || !pic.ops[i + 1].merge);
  asy__out("grestore");
  asy__out("showpage");
  asy__out("%%EOF");
  asy__shipend(asy__on);
}

// 刻意**不给** `void shipout()` 与 `void shipout(string)`：plain_shipout.asy:120 那份
// `void shipout(string prefix=…, picture pic=currentpicture, …)` 全是默认值，0 个实参也
// 接得住 —— 再多一份 0 元的，`shipout()` 就真的 ambiguous 了（量过 asy：
// `void f(); void f(int a=2); f();` 报的正是 "call of function 'f()' is ambiguous"）。
// 不 import plain 时写 `shipout(currentpicture)`。

// ------------------------------------------------ C++ 内建面的余量（第四十五刀）
// 下面这一批是 run*.in 里的函数，base 那一堆到处在用。分三档，各自写清是哪一档：
//   (1) 这一层答得出的：照 run*.in 的定义写出来；
//   (2) 这一层**没有那个机制**的（TeX、文件 IO、进程）：空动作或定值，写明代价；
//   (3) 真几何/数值（求交、弧长、笔形）：声明有、体是 abort —— 调到就**大声**失败，
//       不会悄悄给错答案。plain 的**导入**不走这一档，所以它不挡 import。

// (2) TeX 与输出格式（runlabel.in / runsystem.in）。这一层没有 TeX，也只写标准输出。
bool latex() { return true; }          // 默认引擎是 latex 一族
bool pdf() { return false; }           // 这一路出的是 EPS
string nativeformat() { return "eps"; }
bool uptodate() { return false; }
string outname() { return "out"; }
void texpreamble(string s) { asy__texpre_user.push(s); }
void texpreamble() { }
string xasyKEY() { return ""; }
void xasyKEY(string s) { }
string locatefile(string name, bool full=true) { return name; }
string stripdirectory(string s) {
  int k = -1;
  for (int i = 0; i < length(s); ++i) if (substr(s, i, 1) == "/") k = i;
  return k < 0 ? s : substr(s, k + 1, length(s) - k - 1);
}
string stripfile(string s) {
  int k = -1;
  for (int i = 0; i < length(s); ++i) if (substr(s, i, 1) == "/") k = i;
  return k < 0 ? "" : substr(s, 0, k + 1);
}

// (2) 退出/更新钩子（runtime.in:112/122）。asy 那边存起来，shipout / 退出时调；
// 这一层存着但**还没有人调**它们 —— 那一路（shipout 的更新、退出时的清理）没做。
typedef void asy__thunk();
asy__thunk asy__updatefn = null;
asy__thunk asy__exitfn = null;
void atupdate(asy__thunk f) { asy__updatefn = f; }
asy__thunk atupdate() { return asy__updatefn; }
void atexit(asy__thunk f) { asy__exitfn = f; }
asy__thunk atexit() { return asy__exitfn; }
// stdout 那一格缓冲的尾巴（没有换行结尾的那一段）要在退出时冲出去 —— 见 asy__fput。
// 这一格在这里只是**占位**：真正装进去的那个闭包写在 asy__fput 后面（那时 asy__obuf
// 才声明过）。少了它，`write(stdout,"x")` 这种不带换行的输出会被整段吞掉 ——
// 量过（`asy -noV`）：`write(stdout,"A"); write("B");` 参考印的是 `AB\n`，
// 我们从前只印 `B\n`，差分探针（往 base 里插 write 再比两边）也因此一句都看不见。
asy__thunk asy__obufflushfn = null;
// 退出钩子真的会跑：降级那一层在 `(main …)` 的**最后一句**插一条 `(call asy__atexitrun)`
// （lower.js 的 chunk 尾巴）。asy 那边这一条是 C++ 的 `run::cleanup`/exitFunction 调的，
// 与"程序正常跑完"是同一个点，所以插在 main 末尾是同一处语义。
// 先清成 null 再调：plain.asy:53 的 exitfunction 里再 `shipout()` 一次也不会绕回来。
void asy__atexitrun() {
  if (asy__exitfn != null) {
    asy__thunk f = asy__exitfn;
    asy__exitfn = null;
    f();
  }
  // 退出钩子跑完**之后**再冲 stdout 那一格尾巴：钩子自己也可能往 stdout 写。
  if (asy__obufflushfn != null) asy__obufflushfn();
}
// 隐式 shipout：与 plain.asy:53-62 的 exitfunction 同一条 —— 跑完了还没印过、
// currentpicture 又不空，就补一张。真 asy 那边显式 `shipout(currentpicture)` 会在
// plain_shipout.asy:104 那道 `!implicitshipout && defaultprefix` 的门闩上 return，
// 真正印出来的**总是**退出时这一次（量过：显式 shipout 的文件里只有一份 EPS）。
// 我们这边显式 shipout 是当场印的，所以用 asy__shipped 挡住第二份 —— 份数一样。
// 引了真 base 时这一条会被 plain.asy 的 `atexit(exitfunction)` 顶掉（atexit 只存一个），
// 那时走的是 plain 的那条路，到 `_shipout` 落地。
void asy__implicitshipout() {
  if (asy__shipped || currentpicture.ops.length == 0) return;
  shipout(currentpicture);
}
atexit(asy__implicitshipout);
// 断点函数不是 `void()`：它是 `string(string file, int line, int column, code s)`
// （runsystem.in:132 的 callableBp，plain_debugger.asy:86 把 debugger 装进去）。
typedef string asy__bpfn(string, int, int, code);
void atbreakpoint(asy__bpfn f) { }

// (2) 伪随机（runmath.in:206/217）。asy 用的是 C 库的 random()；这一层自带一个
// 线性同余（Numerical Recipes 那组常数），所以**同一个种子出来的数与真 asy 不一样**。
int asy__seed = 1;
// runmath.in:206：asy 只有**这一条** rand（没有零实参那一份，`rand()` 走的是两个默认值），
// 回的是 [a,b] 里的一个数。我们的伪随机数发生器与 asy 的不是同一个（那边是 C++ 的），
// 所以**数列不同** —— 这条差别本来就在，这里只是把签名对上，`rand()` 那一格的返回值不变。
int rand(int a = 0, int b = intMax) {
  asy__seed = (asy__seed * 1664525 + 1013904223) % 2147483647;
  if (asy__seed < 0) asy__seed = -asy__seed;
  if (a == 0 && b == intMax) return asy__seed;
  return a + asy__seed % (b - a + 1);
}
void srand(int s) { asy__seed = s; }
real unitrand() { return rand() / 2147483647.0; }

// (1) 笔的那几格（runpen.in）。asy 那边每个都是"回一支只设了这一项的笔"，
// 与 currentpen 合成时后设的赢 —— 这一层照着摆那一格。
pen linecap(int n) { pen p; p.cap = n; return p; }
int linecap(pen p = currentpen) { return p.cap; }
pen linejoin(int n) { pen p; p.join = n; return p; }
int linejoin(pen p = currentpen) { return p.join; }
pen fillrule(int n) { pen p; p.fillruleval = n; p.evenodd = n == 1; return p; }
int fillrule(pen p) { return p.fillruleval; }
pen basealign(int n) { pen p; p.basealignval = n; return p; }
int basealign(pen p = currentpen) { return p.basealignval; }
pen opacity(real opacity=1.0, string blend="Compatible") {
  pen p; p.opacityval = opacity; p.blend = blend; p.transpset = true; return p;
}
real opacity(pen p) { return p.opacityval; }
pen invisible() { pen p; p.isinvisible = true; return p; }
bool invisible(pen p) { return p.isinvisible; }
pen fontcommand(string s) { pen p; p.font = s; return p; }
pen cmyk(real c, real m, real y, real k) {
  pen p;
  // 与 gray/rgb 同一条（pen.h:391 的四个 pos0 + :202 的 cmykrange）：负的当 0，
  // 饱和度（rgb 三个与 black 里最大的那个）超过 1 时整组按 1/sat 缩回去。
  real cc = asy__pos0(c);
  real mm = asy__pos0(m);
  real yy = asy__pos0(y);
  real kk = asy__pos0(k);
  real sat = cc;
  if (mm > sat) sat = mm;
  if (yy > sat) sat = yy;
  if (kk > sat) sat = kk;
  if (sat > 1.0) {
    real s = 1.0 / sat;
    cc = cc * s; mm = mm * s; yy = yy * s; kk = kk * s;
  }
  p.iscmyk = true; p.setcolor = true;
  p.cyan = cc; p.magenta = mm; p.yellow = yy; p.black = kk;
  // EPS 那一路只发 rgb/gray，所以这里同时算一份 rgb（cmyk -> rgb 的那条直白换算）
  p.isrgb = true;
  p.red = (1 - cc) * (1 - kk);
  p.green = (1 - mm) * (1 - kk);
  p.blue = (1 - yy) * (1 - kk);
  return p;
}
pen cmyk(pen p) { pen q = p; q.iscmyk = true; return q; }
pen interp(pen a, pen b, real t) {
  pen p = a;
  p.red = a.red + (b.red - a.red) * t;
  p.green = a.green + (b.green - a.green) * t;
  p.blue = a.blue + (b.blue - a.blue) * t;
  p.gray = a.gray + (b.gray - a.gray) * t;
  p.width = a.width + (b.width - a.width) * t;
  p.isrgb = a.isrgb || b.isrgb;
  p.setcolor = a.setcolor || b.setcolor;
  return p;
}
void resetdefaultpen() { pen q; asy__defpen = q; }   // runtime.in:350

// (3) 真几何与数值（第四十七刀）。asy 那边这几个在 path.cc / bezier.h 里，算法是
// 自适应求积 + Bezier 细分；这一层照同样的路子写在 asy 里，所以**末位可能与真 asy 差一点**
// （那边是 C++ 的自适应 Simpson，这里是 5 点 Gauss-Legendre + 二分细化）。
// 量出来要它们的地方：examples 里 19 个（arclength 4、arctime 2、subpath 6、
// intersect/intersections 6、tridiagonal 1）。

// 三次 Bezier 在 t 处的速率 |B'(t)|
private real asy__bspeed(pair z0, pair c0, pair c1, pair z1, real t) {
  real r = 1 - t;
  pair d = 3*r*r*(c0 - z0) + 6*r*t*(c1 - c0) + 3*t*t*(z1 - c1);
  return length(d);
}

// 5 点 Gauss-Legendre（区间 [a,b]）
private real asy__gl5(pair z0, pair c0, pair c1, pair z1, real a, real b) {
  real h = (b - a) / 2;
  real m = (a + b) / 2;
  real x1 = 0.906179845938664;
  real x2 = 0.538469310105683;
  real w0 = 0.568888888888889;
  real w1 = 0.236926885056189;
  real w2 = 0.478628670499366;
  return h * (w0 * asy__bspeed(z0, c0, c1, z1, m)
    + w1 * (asy__bspeed(z0, c0, c1, z1, m - h*x1) + asy__bspeed(z0, c0, c1, z1, m + h*x1))
    + w2 * (asy__bspeed(z0, c0, c1, z1, m - h*x2) + asy__bspeed(z0, c0, c1, z1, m + h*x2)));
}

// 二分细化到两次求积一致
private real asy__arcpart(pair z0, pair c0, pair c1, pair z1,
                          real a, real b, int depth) {
  real whole = asy__gl5(z0, c0, c1, z1, a, b);
  real m = (a + b) / 2;
  real half = asy__gl5(z0, c0, c1, z1, a, m) + asy__gl5(z0, c0, c1, z1, m, b);
  if (depth <= 0) return half;
  if (abs(whole - half) <= 1e-15 * (abs(half) + 1e-15)) return half;
  return asy__arcpart(z0, c0, c1, z1, a, m, depth - 1)
    + asy__arcpart(z0, c0, c1, z1, m, b, depth - 1);
}

real arclength(pair z0, pair c0, pair c1, pair z1) {
  return asy__arcpart(z0, c0, c1, z1, 0, 1, 24);
}

// 第 i 段的弧长（直线段直接取弦长 —— 与 asy 同）
private real asy__seglen(path p, int i) {
  if (straight(p, i)) return length(point(p, i + 1) - point(p, i));
  return arclength(point(p, i), postcontrol(p, i), precontrol(p, i + 1), point(p, i + 1));
}

real arclength(path p) {
  real s = 0;
  int segs = length(p);
  for (int i = 0; i < segs; ++i) s = s + asy__seglen(p, i);
  return s;
}

real arctime(path p, real L) {
  int segs = length(p);
  if (segs <= 0) return 0;
  if (L <= 0) return 0;
  real rem = L;
  for (int i = 0; i < segs; ++i) {
    real seg = asy__seglen(p, i);
    if (rem > seg) { rem = rem - seg; continue; }
    if (seg <= 0) return i;
    pair z0 = point(p, i);
    pair c0 = postcontrol(p, i);
    pair c1 = precontrol(p, i + 1);
    pair z1 = point(p, i + 1);
    real lo = 0;
    real hi = 1;
    for (int k = 0; k < 52; ++k) {
      real mid = (lo + hi) / 2;
      if (asy__arcpart(z0, c0, c1, z1, 0, mid, 16) < rem) lo = mid; else hi = mid;
    }
    return i + (lo + hi) / 2;
  }
  return segs;
}
// de Casteljau：三次 Bezier 上 [t0,t1] 那一段的四个控制点（先切 t1 留左半，再切 t0/t1 留右半）
private pair[] asy__subbez(pair z0, pair c0, pair c1, pair z1, real t0, real t1) {
  pair p01 = z0 + (c0 - z0) * t1;
  pair p12 = c0 + (c1 - c0) * t1;
  pair p23 = c1 + (z1 - c1) * t1;
  pair q0 = p01 + (p12 - p01) * t1;
  pair q1 = p12 + (p23 - p12) * t1;
  pair r = q0 + (q1 - q0) * t1;
  real s = t1 == 0 ? 0 : t0 / t1;
  pair u01 = z0 + (p01 - z0) * s;
  pair u12 = p01 + (q0 - p01) * s;
  pair u23 = q0 + (r - q0) * s;
  pair v0 = u01 + (u12 - u01) * s;
  pair v1 = u12 + (u23 - u12) * s;
  pair w = v0 + (v1 - v0) * s;
  pair[] out;
  out.push(w);
  out.push(v1);
  out.push(u23);
  out.push(r);
  return out;
}

path subpath(path p, int a, int b) {
  int n = p.nodes.length;
  if (n == 0) return pathcopy(p);
  if (a > b) return reverse(subpath(p, b, a));
  int ia = a;
  int ib = b;
  if (!p.cyclic) {
    int len = length(p);
    if (ia < 0) ia = 0;
    if (ib > len) ib = len;
    if (ia > len) ia = len;
    if (ib < 0) ib = 0;
  }
  path h;
  for (int i = ia; i <= ib; ++i) {
    knot k = knotcopy(p.nodes[asy__nwrap(p, i)]);
    if (i == ia) k.pre = k.point;
    if (i == ib) { k.post = k.point; k.straight = false; }
    h.nodes.push(k);
  }
  return h;
}

path subpath(path p, real a, real b) {
  int segs = length(p);
  if (segs <= 0) return pathcopy(p);
  if (a > b) return reverse(subpath(p, b, a));
  real ta = a;
  real tb = b;
  if (!p.cyclic) {
    if (ta < 0) ta = 0;
    if (tb < 0) tb = 0;
    if (ta > segs) ta = segs;
    if (tb > segs) tb = segs;
  }
  // `point(path,real)` 声明在这一段**后面**（名字解析是顺序的），所以这里直接用
  // de Casteljau 取那一点
  if (ta == tb) {
    int i0 = floor(ta);
    if (i0 >= segs) i0 = segs - 1;
    real s0 = ta - i0;
    pair[] q0 = asy__subbez(point(p, i0), postcontrol(p, i0),
                            precontrol(p, i0 + 1), point(p, i0 + 1), s0, s0);
    return pathof(q0[0]);
  }
  int ia = floor(ta);
  real fa = ta - ia;
  int ib = floor(tb);
  real fb = tb - ib;
  if (fb == 0) { ib = ib - 1; fb = 1; }
  path h;
  for (int i = ia; i <= ib; ++i) {
    real t0 = i == ia ? fa : 0;
    real t1 = i == ib ? fb : 1;
    pair[] q = asy__subbez(point(p, i), postcontrol(p, i),
                           precontrol(p, i + 1), point(p, i + 1), t0, t1);
    if (i == ia) {
      knot k = knotat(q[0]);
      k.post = q[1];
      k.straight = straight(p, i);
      h.nodes.push(k);
    } else {
      h.nodes[h.nodes.length - 1].post = q[1];
      h.nodes[h.nodes.length - 1].straight = straight(p, i);
    }
    knot e = knotat(q[3]);
    e.pre = q[2];
    h.nodes.push(e);
  }
  return h;
}

// Bezier 段的包围盒（四个控制点的凸包界）相交判定 —— 细分求交的剪枝就靠它
private bool asy__bbhit(pair[] a, pair[] b, real fuzz) {
  real ax0 = a[0].x; real ax1 = a[0].x; real ay0 = a[0].y; real ay1 = a[0].y;
  for (int i = 1; i < 4; ++i) {
    if (a[i].x < ax0) ax0 = a[i].x;
    if (a[i].x > ax1) ax1 = a[i].x;
    if (a[i].y < ay0) ay0 = a[i].y;
    if (a[i].y > ay1) ay1 = a[i].y;
  }
  real bx0 = b[0].x; real bx1 = b[0].x; real by0 = b[0].y; real by1 = b[0].y;
  for (int i = 1; i < 4; ++i) {
    if (b[i].x < bx0) bx0 = b[i].x;
    if (b[i].x > bx1) bx1 = b[i].x;
    if (b[i].y < by0) by0 = b[i].y;
    if (b[i].y > by1) by1 = b[i].y;
  }
  return ax0 - fuzz <= bx1 && bx0 - fuzz <= ax1
    && ay0 - fuzz <= by1 && by0 - fuzz <= ay1;
}

// 细分找交点。`cap` 是**这一对段上最多圈几个**：0 = 不限（intersections 那一路要全部），
// >0 = 攒够就收（intersect 那一路只要第一个，照 path.cc:1050 的 maxcount=9）。
// 不设上限的话两条**几乎重合**的曲线会把这棵树全展开：每一层四个孩子的界盒都相交，
// 12 层就是 4^12 ≈ 1.7e7 次调用 —— 量到过 hyperboloidsilhouette 卡在这里超过 120s
// （solids.asy:14 的 `intersect(p,q,fuzz)` 比的正是两片相距 epsilon 的切片）。
// asy 那边不会卡：runpath.in 的 intersect 传的是 `single=true`，第一个交点一出来
// 整个栈就回去了（path.cc:1053 那四句 `if(single || depth <= mindepth) return true;`）。
private void asy__ixrec(real[][] out, pair[] a, real ta0, real ta1,
                        pair[] b, real tb0, real tb1, real fuzz, int depth,
                        int cap) {
  if (cap > 0 && out.length >= cap) return;
  if (!asy__bbhit(a, b, fuzz)) return;
  if (depth <= 0) {
    real[] r;
    r.push((ta0 + ta1) / 2);
    r.push((tb0 + tb1) / 2);
    out.push(r);
    return;
  }
  real tam = (ta0 + ta1) / 2;
  real tbm = (tb0 + tb1) / 2;
  pair[] a0 = asy__subbez(a[0], a[1], a[2], a[3], 0, 0.5);
  pair[] a1 = asy__subbez(a[0], a[1], a[2], a[3], 0.5, 1);
  pair[] b0 = asy__subbez(b[0], b[1], b[2], b[3], 0, 0.5);
  pair[] b1 = asy__subbez(b[0], b[1], b[2], b[3], 0.5, 1);
  asy__ixrec(out, a0, ta0, tam, b0, tb0, tbm, fuzz, depth - 1, cap);
  asy__ixrec(out, a0, ta0, tam, b1, tbm, tb1, fuzz, depth - 1, cap);
  asy__ixrec(out, a1, tam, ta1, b0, tb0, tbm, fuzz, depth - 1, cap);
  asy__ixrec(out, a1, tam, ta1, b1, tbm, tb1, fuzz, depth - 1, cap);
}

private pair[] asy__segctl(path p, int i) {
  pair[] q;
  q.push(point(p, i));
  q.push(postcontrol(p, i));
  q.push(precontrol(p, i + 1));
  q.push(point(p, i + 1));
  return q;
}

private pair asy__bezat(pair[] a, real t) {
  real r = 1 - t;
  return r*r*r*a[0] + 3*r*r*t*a[1] + 3*r*t*t*a[2] + t*t*t*a[3];
}

private pair asy__bezdt(pair[] a, real t) {
  real r = 1 - t;
  return 3*r*r*(a[1] - a[0]) + 6*r*t*(a[2] - a[1]) + 3*t*t*(a[3] - a[2]);
}

// 两段之间的 Newton 收尾：解 P(t) - Q(s) = 0。细分只用来**把交点圈出来**（浅一点就够），
// 收到机器精度靠这一步 —— 全靠细分要 30 多层，段对多的图（examples/coag）就跑不完了。
private real[] asy__ixnewton(pair[] a, pair[] b, real t0, real s0, real tol) {
  real t = t0;
  real s = s0;
  for (int k = 0; k < 40; ++k) {
    pair F = asy__bezat(a, t) - asy__bezat(b, s);
    if (length(F) <= tol) break;
    pair dp = asy__bezdt(a, t);
    pair dq = asy__bezdt(b, s);
    real det = -dp.x * dq.y + dq.x * dp.y;
    if (abs(det) < 1e-300) break;
    // Δ = -J^{-1} F 已经把负号算进 dt/ds 里了（下面是加）
    real dt = (dq.y * F.x - dq.x * F.y) / det;
    real ds = (dp.y * F.x - dp.x * F.y) / det;
    t = t + dt;
    s = s + ds;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    if (s < 0) s = 0;
    if (s > 1) s = 1;
  }
  real[] r;
  if (length(asy__bezat(a, t) - asy__bezat(b, s)) > tol) return r;
  r.push(t);
  r.push(s);
  return r;
}

// `intersections(path, path)` 从前摆在这儿，第九十五刀挪到了 asy__lineix / asy__addix
// 之后（**必须**在那两个之后：exact 那一支要 lineintersections，去重要按点算，而按点算要
// `point(path, real)`，那一格在这一行下面才声明 —— 这一层的名字解析是顺序的）。

// 第一个交点的两个时间（没有就是空数组）—— runpath.in:245 的 intersect。
// **不是**"把全部算出来再取第一个"：asy 那边这一路传的是 `single=true`，第一个交点一出来
// 整个递归就回去了。这里照那个意思写 —— 段对按 (i, j) 的次序扫（也就是 p 上时间从小到大，
// 与 intersections 排完序取头一个是同一个答案），每一对段上最多圈 9 个候选
// （path.cc:1050 的 maxcount），头一个 Newton 收得住的就是答案。
// 量出来的理由：solids.asy:14 的 tangent 拿两片相距 epsilon 的切片来问这一句，
// 两条几乎重合的曲线会把细分树全展开 —— hyperboloidsilhouette 与 spheresilhouette
// 从前双双超 120s，真 asy 是 0.33s。
real[] intersect(path p, path q, real fuzz=-1) {
  int np = length(p);
  int nq = length(q);
  real sc = 1;
  for (int i = 0; i <= np; ++i) { real m = length(point(p, i)); if (m > sc) sc = m; }
  for (int j = 0; j <= nq; ++j) { real m = length(point(q, j)); if (m > sc) sc = m; }
  real f = fuzz < 0 ? 1e-9 * sc : fuzz;
  real tol = 1e-12 * sc;
  for (int i = 0; i < np; ++i) {
    pair[] a = asy__segctl(p, i);
    for (int j = 0; j < nq; ++j) {
      pair[] b = asy__segctl(q, j);
      real[][] cand;
      asy__ixrec(cand, a, 0, 1, b, 0, 1, f, 12, 9);
      for (int k = 0; k < cand.length; ++k) {
        real[] r = asy__ixnewton(a, b, cand[k][0], cand[k][1], tol);
        if (r.length == 0) continue;
        real[] g;
        g.push(i + r[0]);
        g.push(j + r[1]);
        return g;
      }
    }
  }
  return new real[];
}

// 笔尖（pen.h 的 `pen::P`）。笔这一格在 `struct pen` 里只能是个 int —— `struct pen`
// 排在 `struct path` **前面**（字段的类型只能是前面声明过的记录），所以真正的路径存在
// 旁边这张表里，笔上只带一个下标。没有笔尖就是 -1，`nib` 那时回 nullpath（量过真 asy：
// `length(nib(currentpen))` 是 -1）。plain_pens.asy:257 的
// `pen squarepen=makepen(shift(-0.5,-0.5)*unitsquare)` 点名要它。
path[] asy__nibtab;
path nib(pen p) { return p.nibid < 0 ? nullpath : asy__nibtab[p.nibid]; }
pen makepen(path p) {
  pen q = pencopy(asy__defpen);
  asy__nibtab.push(p);
  q.nibid = asy__nibtab.length - 1;
  return q;
}
// 转置（runarray.in 里它是按元素类型注册的一族）。体不看元素怎么算 —— 逐格搬。
// 量出来要它的地方：plain_picture.asy 的 `pic.nodes` 那一路，examples 里 5 个
// （integraltest / coag / centroidfg / mosquito / layers）。
real[][] transpose(real[][] a) {
  int n = a.length;
  if (n == 0) return new real[][];
  int m = a[0].length;
  real[][] r = new real[m][];
  for (int i = 0; i < m; ++i) {
    real[] row = new real[n];
    for (int j = 0; j < n; ++j) row[j] = a[j][i];
    r[i] = row;
  }
  return r;
}
// pair 的那一份（runarray.in 里 transpose 是按元素类型注册的一族）：math.asy:418
// 的二维 fft 要它。体是真的 —— 转置不看元素怎么算。
pair[][] transpose(pair[][] a) {
  int n = a.length;
  if (n == 0) return new pair[][];
  int m = a[0].length;
  pair[][] r = new pair[m][];
  for (int i = 0; i < m; ++i) {
    pair[] row = new pair[n];
    for (int j = 0; j < n; ++j) row[j] = a[j][i];
    r[i] = row;
  }
  return r;
}
// A^T A（runarray.in 的 AtA）：math.asy:434 的 leastsquares 要它。体是真的。
real[][] AtA(real[][] a) {
  int n = a.length;
  if (n == 0) return new real[][];
  int m = a[0].length;
  real[][] r = new real[m][];
  for (int i = 0; i < m; ++i) {
    real[] row = new real[m];
    for (int j = 0; j < m; ++j) {
      real s = 0;
      for (int k = 0; k < n; ++k) s += a[k][i] * a[k][j];
      row[j] = s;
    }
    r[i] = row;
  }
  return r;
}
// 10^x（runmath.in 的 pow10）：graph.asy:7 的 `scaleT(log10,pow10,…)` 要它**当值**取，
// 所以得是一份真函数（内建那一族的名字取不出函数值来）。
real pow10(real x) { return 10.0 ^ x; }
// 排序（runarray.in 的 sort 那一族）：这一层只收"元素能比大小"的那几个。
// 体是插入排序 —— 稳定，与 asy 的 mergesort 在有重复元素时给的顺序一致。
real[] sort(real[] a) {
  real[] r = copy(a);
  for (int i = 1; i < r.length; ++i) {
    real v = r[i];
    int j = i - 1;
    while (j >= 0 && r[j] > v) { r[j + 1] = r[j]; --j; }
    r[j + 1] = v;
  }
  return r;
}
int[] sort(int[] a) {
  int[] r = copy(a);
  for (int i = 1; i < r.length; ++i) {
    int v = r[i];
    int j = i - 1;
    while (j >= 0 && r[j] > v) { r[j + 1] = r[j]; --j; }
    r[j + 1] = v;
  }
  return r;
}
string[] sort(string[] a) {
  string[] r = copy(a);
  for (int i = 1; i < r.length; ++i) {
    string v = r[i];
    int j = i - 1;
    while (j >= 0 && r[j] > v) { r[j + 1] = r[j]; --j; }
    r[j + 1] = v;
  }
  return r;
}

// (1) 笔的查询那一侧与字号（runpen.in）。base 里 `linewidth(currentpen)`、
// `fontsize(10)` 到处都是。
// 形参那一格默认是 **currentpen**：runtime.in 里这一族都写成 `T f(pen p=CURRENTPEN)`
// （:514 linetype、:545 linecap、:555 linejoin、:565 miterlimit、:575 linewidth、
// :585 font、:596 fontsize、:601 lineskip、:612 overwrite、:622 basealign）。
// logo3.asy:29 的 `0.25*linewidth()` 点名要它。量过 `asy -noV`：不带实参时
// linewidth() 0.5、linecap() 1、linejoin() 1、basealign() 0、fontsize()
// 11.9551681195517、lineskip() 14.346201743462、font() 那串默认字体命令、
// linetype().length 0；`currentpen=linewidth(2)+squarecap+fontsize(20)` 之后
// 是 2 / 0 / 20 / 24。
real linewidth(pen p = currentpen) { return p.width; }

// (1) 字号（runtime.in:590/596）：pen 上存一格。默认那一格是 **12pt 换成 bp**
// 的那个数（量过 `fontsize(currentpen)` 是 11.9551681195517 = 12*72/72.27）。
pen fontsize(real size, real lineskip) {
  pen q = pencopy(asy__defpen);
  q.fontsizeset = size > 0 ? size : 0;
  q.lineskipval = lineskip;
  q.fontsizeval = size > 0 ? size : 0;
  return q;
}
pen fontsize(real size) { return fontsize(size, 1.2 * size); }
real fontsize(pen p = currentpen) { return asy__psize(p); }
// runtime.in 的 `real lineskip(pen)`（pen::Lineskip()）：设过就是设的那一格，没设过是
// 字号的 1.2 倍。量过 `lineskip(currentpen)` 是 14.346201743462（= 1.2*11.9551681195517）、
// `lineskip(fontsize(20))` 是 24、`lineskip(fontsize(10,15))` 是 15。slide.asy:258 要它。
real lineskip(pen p = currentpen) { return asy__plskip(p); }
// runtime.in:585 的 `string font(pen)`（pen::Font()）。没设过 fontcommand 时回的是那串
// 默认的 LaTeX 字体命令 —— 量过真 asy：`font(currentpen)` 与 `font(fontsize(9))` 都是
// `\usefont{\ASYencoding}{\ASYfamily}{\ASYseries}{\ASYshape}`，设过的回设的那一串。
// plain_Label.asy:601 的 `font=font(L.p)`（stringfont 的构造函数里）点名要它。
// asy 的 `"…"` 里**反斜杠不是转义**（量过：`write("a\\b")` 印 `a\\b`、`length("a\\b")`
// 是 4），所以这里写一个反斜杠就是一个。
string font(pen p = currentpen) {
  return asy__pfont(p);
}

// (1) 还差的几个非泛型内建：base 里点名要，语义在参考实现里是一句话。
// unit：**先取倒数再逐分量乘**（pair.h:164 的 `scale=1.0/z.length(); pair(z.x*scale,z.y*scale)`），
// 不是逐分量除。这两条在浮点上不是一回事：a=62.762791874221662 时
// `a/sqrt(a*a)` 正好是 1，而 `a*(1.0/sqrt(a*a))` 是 0.99999999999999989。
// 量出来的代价：laserlattice 的刻度方向本该是那个"差一位的 1"，于是刻度长
// Ticksize*0.99999999999999989 比 Ticksize 少一个 ulp；那一个 ulp 进了图的包围盒，
// 使 picture.fit 的 xgrow=xsize/width 差 3 个 ulp，于是 t*inverse(t) 不再正好是单位，
// 参考里每一笔刻度都套着 gsave/[ 1 0 0 1 0 0] concat/grestore、我们一层都不套 ——
// 7054 对 6273 个 token 的结构差，根子就在这一个乘法上。
// 挡的那一道也照抄：`fpclassify(scale) == FP_NORMAL` —— 0、非规格化、inf、nan
// 一律回 z0（默认 (0,0)），不是"回 z"。非负数上这就是 realMin <= scale <= realMax。
pair unit(pair z) {
  real scale = length(z);
  if (scale >= realMin && scale <= realMax) {
    scale = 1.0 / scale;
    return (z.x * scale, z.y * scale);
  }
  return (0, 0);
}
triple unit(triple v) {
  real scale = length(v);
  if (scale >= realMin && scale <= realMax) {
    scale = 1.0 / scale;
    return (v.x * scale, v.y * scale, v.z * scale);
  }
  return (0, 0, 0);
}

// identity(n)：runarray.in:1247，n x n 单位阵。
real[][] identity(int n) {
  real[][] m;
  for (int i = 0; i < n; ++i) {
    real[] row;
    for (int j = 0; j < n; ++j) row.push(i == j ? 1.0 : 0.0);
    m.push(row);
  }
  return m;
}

// replace(S, {{from,to},…})：runstring.in:215。一趟扫：在当前位置试每一条规则，
// 命中就抄 to、位置前移 len、并**从第一条规则重试**（那个 `i=0`）；都不命中抄一个字符。
string replace(string S, string[][] translate) {
  string buf = "";
  int pos = 0;
  int Len = length(S);
  int n = translate.length;
  while (pos < Len) {
    int i = 0;
    while (i < n) {
      if (translate[i].length != 2) abort("translation table entry must be an array of length 2");
      string pat = translate[i][0];
      int len = length(pat);
      if (len == 0 || substr(S, pos, len) != pat) { ++i; continue; }
      buf = buf + translate[i][1];
      pos = pos + len;
      if (pos == Len) return buf;
      i = 0;
    }
    buf = buf + substr(S, pos, 1);
    ++pos;
  }
  return buf;
}
// 三参那个 replace 是运行时自带的（runtime.js 的 asy__srepl），这里不再声明一份。

// point(path,real)：runpath.in:64 —— 段内按那一段的三次 Bezier 取点。
pair point(path g, real t) {
  int n = g.nodes.length;
  if (n == 0) { abort("point: 空路径"); return (0, 0); }
  int segs = g.cyclic ? n : n - 1;
  if (segs <= 0) return g.nodes[0].point;
  real u = t;
  if (g.cyclic) {
    while (u < 0) u = u + segs;
    while (u >= segs) u = u - segs;
  } else {
    if (u <= 0) return g.nodes[0].point;
    if (u >= segs) return g.nodes[n - 1].point;
  }
  int i = floor(u);
  real s = u - i;
  knot a = g.nodes[i];
  knot b = g.nodes[i + 1 == n ? 0 : i + 1];
  real r = 1 - s;
  return r*r*r*a.point + 3*r*r*s*a.post + 3*r*s*s*b.pre + s*s*s*b.point;
}

// dir：runpath.in:89/94。切向 = 三次 Bezier 的导数（常因子 3 归一化时无所谓）。
// 结点上 sign<0 取入向、sign>0 取出向、sign==0 取两向的单位向量之和（C++ 那边是同一条）。
pair dir(path g, real t, bool normalize=true) {
  int n = g.nodes.length;
  if (n == 0) { abort("dir: 空路径"); return (0, 0); }
  int segs = g.cyclic ? n : n - 1;
  if (segs <= 0) return (0, 0);
  real u = t;
  if (g.cyclic) {
    while (u < 0) u = u + segs;
    while (u >= segs) u = u - segs;
  } else {
    if (u < 0) u = 0;
    if (u > segs) u = segs;
  }
  int i = floor(u);
  if (i >= segs) i = segs - 1;
  real s = u - i;
  knot a = g.nodes[i];
  knot b = g.nodes[i + 1 == n ? 0 : i + 1];
  real r = 1 - s;
  pair d = 3*r*r*(a.post - a.point) + 6*r*s*(b.pre - a.post) + 3*s*s*(b.point - b.pre);
  if (d == (0, 0)) d = b.point - a.point;
  return normalize ? unit(d) : d;
}
pair dir(path g, int i, int sign=0, bool normalize=true) {
  int n = g.nodes.length;
  if (n == 0) { abort("dir: 空路径"); return (0, 0); }
  if (sign < 0) {
    if (i == 0 && !g.cyclic) return dir(g, 0.0, normalize);
    real ti = i == 0 ? n : i;
    return dir(g, ti, normalize);
  }
  if (sign > 0) { real ti = i; return dir(g, ti, normalize); }
  pair din = dir(g, i, -1, true);
  pair dout = dir(g, i, 1, true);
  pair d = din + dout;
  if (d == (0, 0)) d = dout;
  return normalize ? unit(d) : d;
}

// (2) format：runstring.in:246/301 的两个内建。C++ 那边一句 `snprintf(f, x)` 加一段
// 自己的后处理（runstring.in:353-418），这一层照那两段写：
//
//   1. 一个数值转换 `%[flags][width][.prec]{f,F,e,E,g,G}` 落到方言的 sfix/ssci/sgen/sgenk
//      上（前端的 `_sfix`/`_ssci`/`_sgen`/`_sgenk` 四个口子）。**精度是运行期整数** ——
//      `string(x, n)` 那一条（`(tostr E N)`）的 N 必须是字面量，而 format 的精度是从格式串
//      里解析出来的，所以搭不上去。四条腿的舍入都是"就近取偶"= C 的 printf。
//   2. asy 自己那一段：`\phantom{+}`、抹掉假的符号、去掉末尾的零与小数点（`#` 时不去）、
//      把 `e+05` 翻成 `separator + 10^{5}`。
//
// 从前这里只是"把 % 那一格换成这个数的默认写法"，于是 `format("%.6f",-14.173228346456694)`
// 给的是 `-14.1732283464567`（真 asy `-14.173228`）。patterns.asy 的 tiling 头一个撞上它，
// 而更要紧的是 graph.asy 的刻度标签走的就是 `format(defaultformat,x)`（`$%.4g$`）——
// 从前能对上纯属整数刻度上的巧合。
private bool asy__digitc(string c) { return c != "" && find("0123456789", c) >= 0; }
private bool asy__alphac(string c) {
  return c != "" && find("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", c) >= 0;
}

// 一个数值转换。spec 是从 `%` 到那个转换字母（含）的一段。
private string asy__conv1(string spec, real x) {
  int m = length(spec);
  int i = 1;
  bool fminus = false;
  bool fplus = false;
  bool fspace = false;
  bool fhash = false;
  bool fzero = false;
  while (i < m) {
    string c = substr(spec, i, 1);
    if (c == "-") { fminus = true; ++i; continue; }
    if (c == "+") { fplus = true; ++i; continue; }
    if (c == " ") { fspace = true; ++i; continue; }
    if (c == "#") { fhash = true; ++i; continue; }
    if (c == "0") { fzero = true; ++i; continue; }
    break;
  }
  int width = 0;
  while (i < m && asy__digitc(substr(spec, i, 1))) {
    width = width * 10 + find("0123456789", substr(spec, i, 1));
    ++i;
  }
  // 没写 `.` 时 C 的默认精度是 6；写了 `.` 而后面没数字是 0
  int prec = 6;
  if (i < m && substr(spec, i, 1) == ".") {
    ++i;
    prec = 0;
    while (i < m && asy__digitc(substr(spec, i, 1))) {
      prec = prec * 10 + find("0123456789", substr(spec, i, 1));
      ++i;
    }
  }
  if (prec > 30) prec = 30;              // 方言那四条的上界（缓冲有个头）
  string conv = substr(spec, m - 1, 1);
  bool neg = x < 0 || asy__negzero(x);
  real a = neg ? -x : x;
  string body;
  if (conv == "f" || conv == "F") body = _sfix(a, prec);
  else if (conv == "e" || conv == "E") body = _ssci(a, prec);
  else if (conv == "g" || conv == "G") body = fhash ? _sgenk(a, prec) : _sgen(a, prec);
  else body = _sgen(a, prec);            // 别的转换字母（`%s`/`%d` 配实数）在 C 那边是 UB
  if (conv == "E" || conv == "G") body = replace(body, "e", "E");
  string sign = neg ? "-" : (fplus ? "+" : (fspace ? " " : ""));
  string s = sign + body;
  if (length(s) < width) {
    if (fminus) { while (length(s) < width) s = s + " "; }
    else if (fzero) {
      string b2 = body;
      while (length(sign) + length(b2) < width) b2 = "0" + b2;
      s = sign + b2;
    } else { while (length(s) < width) s = " " + s; }
  }
  return s;
}

// 整数那一份（runstring.in:246）：同一段 spec 解析，但**没有**后处理那一段。
// `%d`/`%i` 之外的（`%x`/`%o`/`%c`…）这一刀不做，落回十进制并把它记在这儿。
string format(string fmt, int x, string locale="") {
  int n = length(fmt);
  string out = "";
  int i = 0;
  int start = -1;
  while (i < n) {
    string curr = substr(fmt, i, 1);
    if (curr == "%") {
      ++i;
      if (i >= n || substr(fmt, i, 1) != "%") { start = i - 1; break; }
    }
    if (i < n) out = out + substr(fmt, i, 1);
    ++i;
  }
  if (start < 0) return out;
  int p = start + 1;
  while (p < n) {
    string c = substr(fmt, p, 1);
    if (c == "*" || c == "$") return out;
    if (asy__alphac(c)) { ++p; break; }
    ++p;
  }
  string spec = substr(fmt, start, p - start);
  int m = length(spec);
  int j = 1;
  bool fminus = false;
  bool fplus = false;
  bool fspace = false;
  bool fzero = false;
  while (j < m) {
    string c = substr(spec, j, 1);
    if (c == "-") { fminus = true; ++j; continue; }
    if (c == "+") { fplus = true; ++j; continue; }
    if (c == " ") { fspace = true; ++j; continue; }
    if (c == "#") { ++j; continue; }
    if (c == "0") { fzero = true; ++j; continue; }
    break;
  }
  int width = 0;
  while (j < m && asy__digitc(substr(spec, j, 1))) {
    width = width * 10 + find("0123456789", substr(spec, j, 1));
    ++j;
  }
  int prec = -1;
  if (j < m && substr(spec, j, 1) == ".") {
    ++j;
    prec = 0;
    while (j < m && asy__digitc(substr(spec, j, 1))) {
      prec = prec * 10 + find("0123456789", substr(spec, j, 1));
      ++j;
    }
  }
  bool neg = x < 0;
  string digs = string(neg ? -x : x);
  while (prec > 0 && length(digs) < prec) digs = "0" + digs;
  string sign = neg ? "-" : (fplus ? "+" : (fspace ? " " : ""));
  string s = sign + digs;
  if (length(s) < width) {
    if (fminus) { while (length(s) < width) s = s + " "; }
    else if (fzero && prec < 0) {
      while (length(sign) + length(digs) < width) digs = "0" + digs;
      s = sign + digs;
    } else { while (length(s) < width) s = " " + s; }
  }
  return out + s + substr(fmt, p, n - p);
}

string format(string fmt, bool forcemath=false, string separator, real x,
              string locale="") {
  // runstring.in:304 那句临时的绕法（github issue #29）
  if (fmt == "%") return "";
  // `tex` 那一档：真 asy 看 `getSetting<string>("tex") != "none"`，我们这一层的标签一律走
  // latex（见 asy__texship），所以恒真。
  bool texify = forcemath;
  int n = length(fmt);
  string out = "";
  int i = 0;
  int start = -1;
  string prev = "";
  while (i < n) {
    string curr = substr(fmt, i, 1);
    if (curr == "$" && prev != "\\") texify = true;
    prev = curr;
    if (curr == "%") {
      ++i;
      if (i >= n || substr(fmt, i, 1) != "%") { start = i - 1; break; }
    }
    if (i < n) out = out + substr(fmt, i, 1);
    ++i;
  }
  if (start < 0) return out;
  // 至多一个实参：`*`（宽度来自实参）与 `$`（位置参数）当场放弃
  int p = start + 1;
  while (p < n) {
    string c = substr(fmt, p, 1);
    if (c == "*" || c == "$") return out;
    if (asy__alphac(c)) { ++p; break; }
    ++p;
  }
  int tail = p;
  string f = substr(fmt, start, tail - start);
  string buf = asy__conv1(f, x);
  bool trailingzero = find(f, "#") >= 0;
  bool plus = find(f, "+") >= 0;
  bool space = find(f, " ") >= 0;
  int bn = length(buf);
  int q = 0;
  if (bn > 0 && substr(buf, 0, 1) == " " && texify) { out = out + "\phantom{+}"; ++q; }
  // 抹掉假的符号（`-0.000000` 那种）
  string c0 = q < bn ? substr(buf, q, 1) : "";
  if (c0 == "-" || c0 == "+") {
    int k = q + 1;
    bool allzero = true;
    while (k < bn) {
      string d = substr(buf, k, 1);
      if (!asy__digitc(d) && d != ".") break;
      if (asy__digitc(d) && d != "0") { allzero = false; break; }
      ++k;
    }
    if (allzero) {
      ++q;
      if ((plus || space) && texify) out = out + "\phantom{+}";
    }
  }
  int p0 = q;
  int r = q;
  bool dp = false;
  while (r < bn) {
    string d = substr(buf, r, 1);
    if (!(d == " " || asy__digitc(d) || d == "." || d == "+" || d == "-")) break;
    if (d == ".") dp = true;
    ++r;
  }
  if (dp) {   // 去掉末尾的零与小数点
    --r;
    int nz = 0;
    while (r > q && substr(buf, r, 1) == "0") { --r; ++nz; }
    if (substr(buf, r, 1) == ".") { --r; ++nz; }
    while (q <= r) { out = out + substr(buf, q, 1); ++q; }
    if (!trailingzero) q = q + nz;
  }
  bool zero = r == p0 && r < bn && substr(buf, r, 1) == "0" && !trailingzero;
  // `E+/E-/e+/e-` 翻成 TeX
  while (q < bn) {
    string d = substr(buf, q, 1);
    string d1 = q + 1 < bn ? substr(buf, q + 1, 1) : "";
    if (texify && (d == "E" || d == "e") && (d1 == "+" || d1 == "-")) {
      if (!zero) out = out + separator + "10^{";
      bool pl = d1 == "+";
      ++q;
      if (pl) ++q;
      if (q < bn && substr(buf, q, 1) == "-") { out = out + "-"; ++q; }
      while (q < bn && substr(buf, q, 1) == "0"
             && (zero || (q + 1 < bn && asy__digitc(substr(buf, q + 1, 1))))) ++q;
      while (q < bn && asy__digitc(substr(buf, q, 1))) { out = out + substr(buf, q, 1); ++q; }
      if (!zero) out = out + "}";
      break;
    }
    out = out + d;
    ++q;
  }
  return out + substr(fmt, tail, n - tail);
}

// (1) min/max：builtin.cc:543 的 addOrderedOps —— 对每个**有序**的基本类型（int/real/
// string）都摆四份：两元、数组、二维、三维。这里摆前两份（base 用到的就是这两份）。
int min(int a, int b) { return a < b ? a : b; }
int max(int a, int b) { return a > b ? a : b; }
real min(real a, real b) { return a < b ? a : b; }
real max(real a, real b) { return a > b ? a : b; }
string min(string a, string b) { return a < b ? a : b; }
string max(string a, string b) { return a > b ? a : b; }
int min(int[] a) {
  if (a.length == 0) { abort("min: 空数组"); return 0; }
  int m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] < m) m = a[i];
  return m;
}
int max(int[] a) {
  if (a.length == 0) { abort("max: 空数组"); return 0; }
  int m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] > m) m = a[i];
  return m;
}
real min(real[] a) {
  if (a.length == 0) { abort("min: 空数组"); return 0; }
  real m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] < m) m = a[i];
  return m;
}
real max(real[] a) {
  if (a.length == 0) { abort("max: 空数组"); return 0; }
  real m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] > m) m = a[i];
  return m;
}
string min(string[] a) {
  if (a.length == 0) { abort("min: 空数组"); return ""; }
  string m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] < m) m = a[i];
  return m;
}
string max(string[] a) {
  if (a.length == 0) { abort("max: 空数组"); return ""; }
  string m = a[0];
  for (int i = 1; i < a.length; ++i) if (a[i] > m) m = a[i];
  return m;
}
// 二维那一份（arrayop.h:90 的 binopArray2）：**空的那一行跳过**，一行都没有值才算空数组
// （所以 `min(new real[][] {new real[], new real[] {1}})` 是 1，不是报错）。
// palette.asy:75/:270 的 `min(f)`、`max(f)` 就是这一份 —— 少了它 palette 里那两个
// 函数的体降不出来，25 个例子在核心方言那一层找不到 asy__ov1_palette。
int min(int[][] a) {
  bool empty = true;
  int m = 0;
  for (int i = 0; i < a.length; ++i) {
    int[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] < m) m = r[j];
    }
  }
  if (empty) { abort("min: 空数组"); return 0; }
  return m;
}
int max(int[][] a) {
  bool empty = true;
  int m = 0;
  for (int i = 0; i < a.length; ++i) {
    int[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] > m) m = r[j];
    }
  }
  if (empty) { abort("max: 空数组"); return 0; }
  return m;
}
real min(real[][] a) {
  bool empty = true;
  real m = 0;
  for (int i = 0; i < a.length; ++i) {
    real[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] < m) m = r[j];
    }
  }
  if (empty) { abort("min: 空数组"); return 0; }
  return m;
}
real max(real[][] a) {
  bool empty = true;
  real m = 0;
  for (int i = 0; i < a.length; ++i) {
    real[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] > m) m = r[j];
    }
  }
  if (empty) { abort("max: 空数组"); return 0; }
  return m;
}
string min(string[][] a) {
  bool empty = true;
  string m = "";
  for (int i = 0; i < a.length; ++i) {
    string[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] < m) m = r[j];
    }
  }
  if (empty) { abort("min: 空数组"); return ""; }
  return m;
}
string max(string[][] a) {
  bool empty = true;
  string m = "";
  for (int i = 0; i < a.length; ++i) {
    string[] r = a[i];
    for (int j = 0; j < r.length; ++j) {
      if (empty) { m = r[j]; empty = false; }
      else if (r[j] > m) m = r[j];
    }
  }
  if (empty) { abort("max: 空数组"); return ""; }
  return m;
}

// (1) path / path[] 的包围盒（runpath.in:271/276/290/314）。每段是三次 Bezier，
// 某个分量的极值只能出在两端或**导数为零**处；导数是二次的，所以解那条二次就是精确解
// （C++ 那边 bounds() 走的是同一条路，不是采样）。求根与取值用的是前面那对
// asy__bezcrit / asy__bez（path.cc 的逐字照抄，见它们旁边的注）。
// lo=true 取小、false 取大
real asy__pathbound(path g, bool xaxis, bool lo) {
  int n = g.nodes.length;
  real m = xaxis ? g.nodes[0].point.x : g.nodes[0].point.y;
  int segs = g.cyclic ? n : n - 1;
  for (int i = 0; i < n; ++i) {
    real v = xaxis ? g.nodes[i].point.x : g.nodes[i].point.y;
    if (lo ? v < m : v > m) m = v;
  }
  for (int i = 0; i < segs; ++i) {
    if (g.nodes[i].straight) continue;   // path.cc:485
    knot p = g.nodes[i];
    knot q = g.nodes[i + 1 == n ? 0 : i + 1];
    real a = xaxis ? p.point.x : p.point.y;
    real b = xaxis ? p.post.x : p.post.y;
    real c = xaxis ? q.pre.x : q.pre.y;
    real d = xaxis ? q.point.x : q.point.y;
    for (real t : asy__bezcrit(a, b, c, d)) {
      if (t < 0.0 || t > 1.0) continue;  // path.h:449 goodroot，闭区间
      real v = asy__bez(a, b, c, d, t);
      if (lo ? v < m : v > m) m = v;
    }
  }
  return m;
}
pair min(path g) {
  if (g.nodes.length == 0) { abort("min(path): 空路径"); return (0, 0); }
  return (asy__pathbound(g, true, true), asy__pathbound(g, false, true));
}
pair max(path g) {
  if (g.nodes.length == 0) { abort("max(path): 空路径"); return (0, 0); }
  return (asy__pathbound(g, true, false), asy__pathbound(g, false, false));
}
pair min(path[] g) {
  if (g.length == 0) { abort("min(path[]): 空数组"); return (0, 0); }
  pair m = min(g[0]);
  for (int i = 1; i < g.length; ++i) m = minbound(m, min(g[i]));
  return m;
}
pair max(path[] g) {
  if (g.length == 0) { abort("max(path[]): 空数组"); return (0, 0); }
  pair m = max(g[0]);
  for (int i = 1; i < g.length; ++i) m = maxbound(m, max(g[i]));
  return m;
}

// ------------------------------------------------------------ 数组上的 abs
// builtin.cc 给 real/pair/triple 的数组各现生一份 `real[] abs(T[])`（量过：`abs(int[])`
// **没有**，那句报 no matching variable）。
//
// 标量那四格也在这里摆一份（第七十五刀）：这个前端本来把 abs 写死在调用那一层
// （calls.js 的 mathCall），于是它**没有符号**、当不了函数值 —— `s.map(abs)`
// （examples/cheese.asy:11、pOrbital.asy:25、sphericalharmonic.asy:13）报
// "要 real(triple)，而这个名字的那几个重载里没有同型的一份"。摆成真函数之后
// 名字有候选了，`(fnref …)` 就拿得到；直接调那一层照旧先挑这里的精确匹配。
int abs(int x) { return x < 0 ? -x : x; }
real abs(real x) { return x < 0 ? -x : x; }
real abs(pair z) { return length(z); }
real abs(triple v) { return length(v); }
real[] abs(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = abs(a[i]);
  return r;
}
real[] abs(pair[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = abs(a[i]);
  return r;
}
real[] abs(triple[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = abs(a[i]);
  return r;
}

// ------------------------------------------------------------ 绕数与 inside
// runpath.in:436 的 orient → path.cc:1150 的 orient2d：那个行列式
//   |a.x a.y 1; b.x b.y 1; c.x c.y 1|
// 逆时针为正。式子照 path.cc:1158 那两行摆（detleft - detright），连 `-0` 都跟着 ——
// `orient((0,0),(1,0),(1,0))` 是 `-0`，换成 (b-a)×(c-a) 那种写法就成 `0` 了。
// **明写的差别**：asy 那边 det 落在误差界内时还会转去 orient2dadapt（Shewchuk 的自适应
// 精确谓词，predicates.h），这一层只有这一步。几乎共线的位置上符号可能差一个 ulp ——
// 那会把"点正好落在路径上"判成不在（asy 那种情形回 intMax，见下面的 windingnumber）。
real orient(pair a, pair b, pair c) {
  real detleft = (a.x - c.x) * (b.y - c.y);
  real detright = (a.y - c.y) * (b.x - c.x);
  return detleft - detright;
}

private bool asy__inrange(real x0, real x1, real x) {
  return (x0 <= x && x <= x1) || (x1 <= x && x <= x0);
}

// path.cc:1216 checkstraight：点落在 z0--z1 上就回 true，否则把这一段对绕数的贡献
// 累进 count 里（那边是引用形参，这一层用一格数组顶）。
private bool asy__ckstraight(pair z0, pair z1, pair z, int[] count) {
  if (z0.y <= z.y && z.y <= z1.y) {
    real side = orient(z0, z1, z);
    if (side == 0 && asy__inrange(z0.x, z1.x, z.x)) return true;
    if (z.y < z1.y && side > 0) count[0] = count[0] + 1;
  } else if (z1.y <= z.y && z.y <= z0.y) {
    real side = orient(z0, z1, z);
    if (side == 0 && asy__inrange(z0.x, z1.x, z.x)) return true;
    if (z.y < z0.y && side < 0) count[0] = count[0] - 1;
  }
  return false;
}

// path.cc:1196 insidebbox：四个控制点的包围盒装不装得下 z
private bool asy__inbbox(pair a, pair b, pair c, pair d, pair z) {
  real l = min(min(a.x, b.x), min(c.x, d.x));
  real r = max(max(a.x, b.x), max(c.x, d.x));
  real bo = min(min(a.y, b.y), min(c.y, d.y));
  real t = max(max(a.y, b.y), max(c.y, d.y));
  return l <= z.x && z.x <= r && bo <= z.y && z.y <= t;
}

// path.cc:1232 checkcurve：包围盒装得下就 de Casteljau 对半劈，装不下就按弦算
private bool asy__ckcurve(pair z0, pair c0, pair c1, pair z1, pair z,
                          int[] count, int depth) {
  if (depth == 0) return true;
  int d = depth - 1;
  if (asy__inbbox(z0, c0, c1, z1, z)) {
    pair m0 = 0.5 * (z0 + c0);
    pair m1 = 0.5 * (c0 + c1);
    pair m2 = 0.5 * (c1 + z1);
    pair m3 = 0.5 * (m0 + m1);
    pair m4 = 0.5 * (m1 + m2);
    pair m5 = 0.5 * (m3 + m4);
    if (asy__ckcurve(z0, m0, m3, m5, z, count, d)) return true;
    if (asy__ckcurve(m5, m4, m2, z1, z, count, d)) return true;
  } else {
    if (asy__ckstraight(z0, z1, z, count)) return true;
  }
  return false;
}

// path.cc:1257 path::windingnumber：点落在路径上时回**最大的奇整数**，也就是 intMax
// （common.h:106 的 Int_MAX 本身是奇数，量过：9223372036854775805）。
// 递归的深度上限是 bound.cc:15 的 maxdepth = DBL_MANT_DIG = 53。
int windingnumber(path g, pair z) {
  if (!g.cyclic) { abort("path is not cyclic"); return 0; }
  pair lo = min(g);
  pair hi = max(g);
  if (z.x < lo.x || z.x > hi.x || z.y < lo.y || z.y > hi.y) return 0;
  int[] count;
  count.push(0);
  int n = length(g);
  for (int i = 0; i < n; ++i) {
    if (straight(g, i)) {
      if (asy__ckstraight(point(g, i), point(g, i + 1), z, count)) return intMax;
    } else {
      if (asy__ckcurve(point(g, i), postcontrol(g, i), precontrol(g, i + 1),
                       point(g, i + 1), z, count, 53)) return intMax;
    }
  }
  return count[0];
}

// pen.h:492 的 fillrule.inside：evenodd 看奇偶，否则看非零
bool inside(path g, pair z, pen fillrule=currentpen) {
  int c = windingnumber(g, z);
  if (fillrule.evenodd) return c % 2 != 0;
  return c != 0;
}

// (2) warning / nowarn（runsystem.in:174/182）。C++ 那边过 settings::warn 那张开关表再
// 走 em.warning（带文件位置）。这一层没有那张表也没有位置，就照 "warning: <正文>" 印出来。
//
// **必须走 stderr**：asy 的 em.warning 印到 cerr，而 `-o -` 那一路 EPS 是从 stdout 出去的。
// 从前这里用 write()，于是 `warning: cannot fit picture to xsize 200...enlarging...`
// 变成了 EPS 的第一行 —— 量出来的：logdown / spline / xstitch / lmfit1 四份的首处差
// 就是这一行（参考 `%%BoundingBox:201`，我们 `warning:`）。这一层没有 stderr 的口子，
// 借 _writetext 往 /dev/stderr 写（字符设备，truncate 是空动作）。
void nowarn(string s) { }
void warning(string s, string t, bool position=false) {
  _writetext("/dev/stderr", "warning: " + t + '\n');
}

// (1) `write(file, …)` 那一族（builtin.cc:474 的 addWrite：
// `void write(file file=stdout, string s="", T x, void suffix(file)=endl, ... T[])`）。
// 核心方言只有 `(print …)`，而 print 自己补换行 —— 所以这里把写进去的东西**攒在
// file.buf 里**，攒出整行才交给 print。这样面向行的输出与 asy 逐字节一样；
// 一行没写完就退出时那一截会丢，这条差别记在这儿（asy 那边会 flush 出去）。
typedef void asy__suffix(file);
void flush(file f) { }
// stdout 那一路的行缓冲是**一份**，不挂在 file 那一格上：asy 的 stdout 只有一个
// （plain_constants.asy:64 的 `restricted file stdout=output();`，而 `output()` 每次
// 回来的是新的一格 file，包的却是同一个 stdout）。挂在格子上的时候，
// `write(output(), "false ", none)` 那半行就跟着那一格一起扔了 —— 量出来是整段没了。
private string asy__obuf = "";
void asy__fput(file f, string s) {
  if (f.fd != 1) { f.buf = f.buf + s; return; }
  asy__obuf = asy__obuf + s;
  // 注意：asy 的双引号串**不处理转义**（"\n" 是两个字节 \ 和 n），要真换行得用单引号串。
  int k = find(asy__obuf, '\n');
  while (k >= 0) {
    write(substr(asy__obuf, 0, k));
    asy__obuf = substr(asy__obuf, k + 1, length(asy__obuf) - k - 1);
    k = find(asy__obuf, '\n');
  }
}
// 上面那格占位（asy__obufflushfn）真正装的东西。这一层唯一的 stdout 出口是核心方言的
// `print`，它**总补一个换行**，所以按行攒：攒到 '\n' 就发一行。剩下那截没有换行结尾的
// 尾巴从前就留在 asy__obuf 里烂掉了，现在退出时发出去。
// **这一条差别写在明处**：尾巴那一行会多带一个换行（参考是 `AB`，我们是 `AB\n`）——
// 要一字不差得给核心方言添一路"不补换行的输出"，那要动解释器与四个后端。
// **还有一条**：`write(x)`（只一个实参）走的是前端内建那一族、不经过 asy__obuf
// （见下面 output() 后面那一段的注释），所以"没换行的 write(stdout,…)"与"单参数
// write(…)"混在一起时**次序会反**：参考 `write(stdout,"A"); write("B");` 印 `AB`，
// 我们印 `B\nA\n`。往 base 里插差分探针时因此要让每条探针自己带换行（`write(s)` 或
// `write(stdout, s, endl)`），这样两边次序一致。
asy__obufflushfn = new void() {
  if (asy__obuf == "") return;
  write(asy__obuf);
  asy__obuf = "";
};
void none(file f) { }
void endl(file f) { asy__fput(f, '\n'); }
void newl(file f) { asy__fput(f, '\n'); }
void tab(file f) { asy__fput(f, '\t'); }
void comma(file f) { asy__fput(f, ","); }
// 只给一个 suffix：`write(f, endl)` —— asy 那边是 `write(file, suffix=endl)` 这一支。
void write(file f, asy__suffix suffix) { suffix(f); }
void write(file f, string x, asy__suffix suffix=none) { asy__fput(f, x); suffix(f); }
void write(file f, int x, asy__suffix suffix=none) { asy__fput(f, string(x)); suffix(f); }
void write(file f, real x, asy__suffix suffix=none) { asy__fput(f, string(x)); suffix(f); }
void write(file f, bool x, asy__suffix suffix=none) {
  // asy 的 bool 输出**自带一个尾空格**（量过：`write(f,true,endl)` 是 "true \n"）；
  // 注意 asy 里并没有 string(bool)，所以这儿只能自己拼。
  asy__fput(f, x ? "true " : "false "); suffix(f);
}
void write(file f, pair x, asy__suffix suffix=none) {
  asy__fput(f, "(" + string(x.x) + "," + string(x.y) + ")"); suffix(f);
}
void write(file f, triple x, asy__suffix suffix=none) {
  asy__fput(f, "(" + string(x.x) + "," + string(x.y) + "," + string(x.z) + ")"); suffix(f);
}
void write(file f, string s, int x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, string s, real x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, string s, pair x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, string s, string x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, string s, bool x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, string s, triple x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}


// 笔的**文字**形（pen.h:869 的 operator<<，逐条照抄）。数是裸 ostream 出来的，
// 所以是 6 位有效数字 —— 与 EPS 那一路的 ps() 同一档。量过的几条：
//   currentpen           -> (default)
//   nullpen              -> (default, linewidth=0, invisible)
//   black                -> (default, gray=0)
//   red+linewidth(2)     -> (default, linewidth=2, red=1, green=0, blue=0)
//   fontsize(9)+black    -> (default, fontsize=9, lineskip=10.8, gray=0)
//   evenodd              -> (default, fillrule=EvenOdd)
//   dotted               -> ([0 4])
// 还没有的那几格印不出来，写在明处：笔尖 `path=`（我们没有 nib）、`pattern=`、
// `overwrite=`、`transform=`。
string string(pen p) {
  string s = "(";
  if (p.dashpat.length == 0) s = s + "default";
  else {
    s = s + "[";
    for (int i = 0; i < p.dashpat.length; ++i) {
      if (i > 0) s = s + " ";
      s = s + ps(p.dashpat[i]);
    }
    s = s + "]";
  }
  if (p.dashoffset != 0) s = s + ps(p.dashoffset);
  if (!p.dashscale) s = s + " bp";
  if (!p.dashadjust) s = s + " fixed";
  if (p.width != 0.5) s = s + ", linewidth=" + ps(p.width);
  if (p.cap != 1) s = s + ", linecap=" + (p.cap == 0 ? "square" : "extended");
  if (p.join != 1) s = s + ", linejoin=" + (p.join == 0 ? "miter" : "bevel");
  if (p.miter != 10) s = s + ", miterlimit=" + ps(p.miter);
  if (p.font != "") s = s + ', font="' + p.font + '"';
  if (p.fontsizeset != 0) s = s + ", fontsize=" + ps(p.fontsizeset);
  if (p.lineskipval != 0) s = s + ", lineskip=" + ps(p.lineskipval);
  if (p.isinvisible) s = s + ", invisible";
  else if (p.iscmyk) {
    s = s + ", cyan=" + ps(p.cyan) + ", magenta=" + ps(p.magenta)
      + ", yellow=" + ps(p.yellow) + ", black=" + ps(p.black);
  } else if (p.isrgb) {
    s = s + ", red=" + ps(p.red) + ", green=" + ps(p.green) + ", blue=" + ps(p.blue);
  } else if (p.setcolor) s = s + ", gray=" + ps(p.gray);
  if (p.fillruleval != 0) s = s + ", fillrule=EvenOdd";
  if (p.basealignval != 0) s = s + ", baseline=Align";
  if (p.opacityval != 1) s = s + ", opacity=" + ps(p.opacityval) + ", blend=" + p.blend;
  return s + ")";
}

// 路径的文字形（path.cc:1098 的 operator<<）：直段是 `--`，曲段是
// `.. controls c0 and c1` 加**换行与一个空格**再 `..`；空路径是 `<nullpath>`。
// 坐标与 write(pair) 那一档一样（string(real) 的 15 位有效数字）。
private string asy__pairstr(pair z) { return "(" + string(z.x) + "," + string(z.y) + ")"; }

string string(path g) {
  int n = length(g);
  if (n < 0) return "<nullpath>";
  string s = "";
  for (int i = 0; i < n; ++i) {
    s = s + asy__pairstr(point(g, i));
    if (straight(g, i)) s = s + "--";
    else {
      s = s + ".. controls " + asy__pairstr(postcontrol(g, i)) + " and "
        + asy__pairstr(precontrol(g, i + 1)) + '\n' + " ..";
    }
  }
  if (g.cyclic) return s + "cycle";
  return s + asy__pairstr(point(g, n));
}

// 二维数组的文字形（runarray.in 的 write）：行与行之间是换行、行内是制表符，
// **每行末尾都有换行**（量过 `write(stdout,new real[][]{{1,2},{3,4}})` 是 "1\t2\n3\t4\n"）。
// plain_Label.asy:363 的 `write(file,T3)`（transform3 就是 real[][]）要的是它。
void write(file f, real[][] m, asy__suffix suffix=none) {
  for (int i = 0; i < m.length; ++i) {
    for (int j = 0; j < m[i].length; ++j) {
      if (j > 0) asy__fput(f, '\t');
      asy__fput(f, string(m[i][j]));
    }
    asy__fput(f, '\n');
  }
  suffix(f);
}

// 变换的文字形（transform.h 的 operator<<）：六个分量 `(x,y,xx,xy,yx,yy)`。
// 量过：identity() 是 (0,0,1,0,0,1)、shift(1,2) 是 (1,2,1,0,0,1)。
string string(transform t) {
  return "(" + string(t.x) + "," + string(t.y) + "," + string(t.xx) + ","
    + string(t.xy) + "," + string(t.yx) + "," + string(t.yy) + ")";
}

void write(file f, transform x, asy__suffix suffix=none) {
  asy__fput(f, string(x)); suffix(f);
}
void write(file f, string s, transform x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}

void write(file f, pen x, asy__suffix suffix=none) {  asy__fput(f, string(x)); suffix(f);
}
void write(file f, string s, pen x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
void write(file f, path x, asy__suffix suffix=none) {
  asy__fput(f, string(x)); suffix(f);
}
void write(file f, string s, path x, asy__suffix suffix=none) {
  asy__fput(f, s); write(f, x, suffix);
}
// ------------------------------------------------------------ 读文件那一族
// 语义全是从 asy 的 C++ 那三处量/抄来的：ifile::Read/eol/nexteol/ignoreComment
// （fileio.cc:153-327）、file::read 那个模板（fileio.h:188）与 castop.h 的
// read<T> / readArray（:91、:116）。三条关键的、不看源码想不到的：
//   1. **标量读完，line 模式下还要 nexteol 一次**（castop.h:95）—— 于是"读一行"会把
//      紧跟着的**空行**一起吃掉（量过：s2 是 `7\t8`，中间那个空行没了）。
//   2. nexteol 撞到连着的第二个换行时置 nullfield（fileio.cc:253），而下一次读**不解析**、
//      直接给零值（fileio.h:196 的 `if(!nullfield) Read(val)`）—— 空行读出来是一格 0，
//      不是"没有值"（量过：`real[] r3=a;` 是 `[0]`，`string[] w2=d;` 是 `[""]`）。
//   3. 字符串那一支**不跳注释**（fileio.h:174 的 `ignoreComment(string&) {}` 是空的）：
//      注释是在 Read(string) 里从行内**截掉**的（`##` 是一个字面的 `#`）。
// 刻意没照抄的（都在真数据上到不了）：csv 模式的引号与空字段、`>>` 只吃"数字前缀"
// 那一手（我们要求整个词是一个数）、二进制/XDR 模式、\v 与 \f 不算空白。
private bool asy__fspace(string c) {
  return c == " " || c == '\t' || c == '\r';
}
private bool asy__fdigit(string c) {
  return find("0123456789", c) >= 0 && c != "";
}
/** 停在末尾了？（li 越界就是整份读完） */
private bool asy__fend(file f) { return f.li >= f.nl; }
/** 当前行从 ci 起还剩的那一截 */
private string asy__frest(file f) {
  if (asy__fend(f)) return "";
  return substr(f.lines[f.li], f.ci);
}
/** 一整截都是空白（空串也算） */
private bool asy__fblank(string s) {
  for (int i = 0; i < length(s); ++i) if (!asy__fspace(substr(s, i, 1))) return false;
  return true;
}
/** 停在行尾那个 '\n' 上（行内剩下的都是空白） */
private bool asy__fateol(file f) {
  return !asy__fend(f) && asy__fblank(asy__frest(f));
}
/** 跨过行界：把 '\n' 吃掉 */
private void asy__fnextline(file f) { f.li = f.li + 1; f.ci = 0; }

// input()/output()（runfile.in:45/80）。**写**那一路仍然只有 stdout；**读**那一路是真的：
// `_readtext` 把整份拿到手（前端里唯一的 IO 口子），按 '\n' 切开存在 f.lines 里。
// `check=false`（plain.asy:261 的 `error(input(…,check=false))`）在这一层**不去读**：
// 那句问的是"这个文件在不在"，而这一层没有"文件在不在"这个原语（readtext 读不到就是
// 运行期错误）。于是 check=false 一律当"打不开" —— 文件不在时与 asy 一样，文件在时不一样
// （那句的用法是问输出文件在不在，通常不在）。
// asy 的 `input()` 不是"只看当前目录"：它走 locateFile，与找模块同一条搜索路径。
// 量出来的（d.dat 只放在 ASYMPTOTE_DIR 指的目录、主文件在别处的 CWD）：带 ASYMPTOTE_DIR
// 读到了，不带就是 `Cannot open file "d.dat"`。这一格补上那条路径 ——
// filesurface / linearregression / worldmap 三份读 .dat 的例子就是差这个。
//
// 「这个文件在不在」这一层没有原语（readtext 读不到就直接抛），所以借 `_runproc` 去问
// `test -f`。代价是每个候选目录一次 fork；input() 一份图里最多几次，量不到。
private string[] asy__spdirs;
private bool asy__spdone = false;

private string asy__locate(string name) {
  if (length(name) == 0) return name;
  if (substr(name, 0, 1) == "/") return name;
  if (!asy__spdone) {
    asy__spdone = true;
    string sp = _searchpath();
    int i = 0;
    while (i <= length(sp)) {
      int j = find(sp, ":", i);
      int e = j < 0 ? length(sp) : j;
      if (e > i) asy__spdirs.push(substr(sp, i, e - i));
      if (j < 0) break;
      i = j + 1;
    }
  }
  for (int k = 0; k < asy__spdirs.length; ++k) {
    string cand = asy__spdirs[k] + "/" + name;
    // 单引号包住：名字里真有单引号的那种这一格答不准，先不管（例子里没有）。
    if (_runproc("test -f '" + cand + "'") == 0) return cand;
  }
  return name;
}

file input(string name="", bool check=true, string comment="#", string mode="") {
  file f;
  f.comment = substr(comment, 0, 1);
  if (name == "") { f.fd = 0; return f; }        // stdin：这一层读不了（读到才报）
  f.fd = 2;
  f.name = name;
  if (mode != "") return f;                      // 二进制/XDR：打不开（v3d.asy:135 那一格）
  if (!check) return f;
  f.lines = _readlines(asy__locate(name));
  f.nl = f.lines.length;
  if (f.nl > 0 && f.lines[f.nl - 1] == "") f.nl = f.nl - 1;   // 末尾那个 '\n' 不是一行
  f.opened = true;
  return f;
}
file output(string name="", bool update=false, string comment="#", string mode="") {
  file f; f.fd = 1; return f;
}
file nullFile() { file f; f.fd = -1; return f; }
int precision(file f, int digits=0) { return digits; }

// 不给 file 的那一族：asy 的内建签名是 `void write(file file=stdout, string s="", T x,
// void suffix(file)=endl)`，也就是 `write(x, suffix)` 这个写法**被调方**把 file 填成
// stdout。我们的 write 是前端内建的一族，那一族不收 suffix，所以这几支得显式给。
// plain_constants.asy:107 的 `write(b.value, suffix)`（bool3 那一族）就是这一格。
// 只写 `write(x)` 时仍然走前端那一族（少一个实参、更同型），所以尾巴还是换行。
// 位置在 output() **之后** —— 这个文件里名字是顺序解析的。
void write(string x, asy__suffix suffix) { write(output(), x, suffix); }
void write(int x, asy__suffix suffix) { write(output(), x, suffix); }
void write(real x, asy__suffix suffix) { write(output(), x, suffix); }
void write(bool x, asy__suffix suffix) { write(output(), x, suffix); }
void write(pair x, asy__suffix suffix) { write(output(), x, suffix); }
void write(triple x, asy__suffix suffix) { write(output(), x, suffix); }

// ---- 读那一族的三个原语：整行、跳空白与注释、nexteol ----
/** getline：整行（不含 '\n'），撞底时置 eof+fail 并回空串 */
private string asy__fgetline(file f) {
  if (asy__fend(f)) { f.eofbit = true; f.errbit = true; return ""; }
  string s = asy__frest(f);
  asy__fnextline(f);
  if (asy__fend(f)) f.eofbit = true;         // 最后一行读完了：下一次 peek 就撞底
  return s;
}
/** Read(string) 尾巴上那一段：行内的注释截掉（`##` 是一个字面的 `#`）、去掉行尾的 '\r' */
private string asy__fcut(file f, string s) {
  if (f.comment != "") {
    int p = 0;
    while (true) {
      int k = find(s, f.comment, p);
      if (k < 0) break;
      if (k + 1 < length(s) && substr(s, k + 1, 1) == f.comment) { s = erase(s, k, 1); p = k + 1; }
      else { s = substr(s, 0, k); break; }
    }
  }
  int n = length(s);
  if (n > 0 && substr(s, n - 1, 1) == '\r') s = substr(s, 0, n - 1);
  return s;
}
/**
 * ignoreComment（fileio.cc:153）：吃空白（跨行）、整行的注释跳掉。最后那一手是
 * **unget**：本来就停在行尾时，把跨过的那个 '\n' 退回去 —— 于是紧跟着的 nexteol 还能
 * 看见这个行界（空行读出零值那条路就是这么来的）。
 */
private void asy__fskipws(file f) {
  if (f.comment == "") return;               // asy：comment==0 时这个函数直接回
  bool eol = asy__fateol(f);
  while (true) {
    while (!asy__fend(f)) {
      string r = asy__frest(f);
      if (asy__fblank(r)) { asy__fnextline(f); continue; }
      int i = 0;
      while (asy__fspace(substr(r, i, 1))) i = i + 1;
      f.ci = f.ci + i;
      break;
    }
    if (asy__fend(f)) { f.eofbit = true; return; }
    if (substr(f.lines[f.li], f.ci, 1) == f.comment) { f.white = ""; asy__fnextline(f); continue; }
    if (eol && f.ci == 0 && f.li > 0) { f.li = f.li - 1; f.ci = length(f.lines[f.li]); }
    return;
  }
}
/**
 * nexteol（fileio.cc:228）：吃掉紧跟着的那个行界。回 true = "这一行到头了"。
 * 撞到连着的第二个换行（空行）时置 nullfield —— 下一次读**不解析**，直接给零值。
 */
private bool asy__fnexteol(file f) {
  if (f.nullfield) { f.nullfield = false; return true; }
  if (asy__fend(f)) { f.eofbit = true; return false; }
  string r = asy__frest(f);
  int i = 0;
  while (i < length(r) && asy__fspace(substr(r, i, 1))) i = i + 1;
  if (i < length(r)) { f.ci = f.ci + i; return false; }     // 行内还有非空白：不是行尾
  asy__fnextline(f);                                        // 吃掉行界那个 '\n'
  if (asy__fend(f)) { f.eofbit = true; return true; }
  if (asy__fblank(asy__frest(f))) { f.nullfield = true; return true; }
  string r2 = asy__frest(f);
  int j = 0;
  while (asy__fspace(substr(r2, j, 1))) j = j + 1;
  f.ci = f.ci + j;
  return true;
}
/**
 * 一个"词"：跳空白（跨行）、跳整行的注释，取到下一个空白（或注释字符）为止。
 * 取不到（撞底）时置 errbit —— 数组读就是靠它收尾的。
 */
private string asy__ftok(file f) {
  f.errbit = false;
  while (true) {
    if (asy__fend(f)) { f.eofbit = true; f.errbit = true; return ""; }
    string r = asy__frest(f);
    int i = 0;
    while (i < length(r) && asy__fspace(substr(r, i, 1))) i = i + 1;
    if (i >= length(r)) { asy__fnextline(f); continue; }
    f.ci = f.ci + i;
    if (f.comment != "" && substr(f.lines[f.li], f.ci, 1) == f.comment) { asy__fnextline(f); continue; }
    string rest = asy__frest(f);
    int j = 0;
    while (j < length(rest)) {
      string c = substr(rest, j, 1);
      if (asy__fspace(c)) break;
      if (f.comment != "" && c == f.comment) break;
      j = j + 1;
    }
    f.ci = f.ci + j;
    return substr(rest, 0, j);
  }
}
/** inf / nan 那几个写法（Read(double) 在 fileio.cc:175 里专门认它们，大小写不论） */
private bool asy__finf(string t) {
  return t == "inf" || t == "Inf" || t == "INF" || t == "-inf" || t == "-Inf" || t == "-INF"
    || t == "+inf" || t == "+Inf" || t == "+INF";
}
private bool asy__fnan(string t) {
  return t == "nan" || t == "NaN" || t == "NAN" || t == "-nan" || t == "-NaN" || t == "-NAN"
    || t == "+nan" || t == "+NaN" || t == "+NAN";
}
/** 这个词整个是一个数？（`>>` 只吃数字前缀，我们要求整词 —— 差别记在上面那段说明里） */
private bool asy__fnum(string t) {
  int n = length(t);
  if (n == 0) return false;
  if (asy__finf(t) || asy__fnan(t)) return true;
  int i = 0;
  string c0 = substr(t, 0, 1);
  if (c0 == "+" || c0 == "-") i = 1;
  int d = 0;
  while (i < n && asy__fdigit(substr(t, i, 1))) { i = i + 1; d = d + 1; }
  if (i < n && substr(t, i, 1) == ".") {
    i = i + 1;
    while (i < n && asy__fdigit(substr(t, i, 1))) { i = i + 1; d = d + 1; }
  }
  if (d == 0) return false;
  if (i < n && (substr(t, i, 1) == "e" || substr(t, i, 1) == "E")) {
    i = i + 1;
    if (i < n && (substr(t, i, 1) == "+" || substr(t, i, 1) == "-")) i = i + 1;
    int e = 0;
    while (i < n && asy__fdigit(substr(t, i, 1))) { i = i + 1; e = e + 1; }
    if (e == 0) return false;
  }
  return i == n;
}
// ---- 一次读一格 ----
// 分成两层是照 asy 的分法：`file::read`（fileio.h:188）**不**碰 nexteol，而**标量的 cast**
// （castop.h:91 的 read<T>）读完之后 line 模式下要 nexteol 一次；数组那一族
// （castop.h:116 的 readArray）自己在循环里 nexteol。少分这一层就会多吃一个行界
// （症状：`real[] x=in; real[] y=in;` 里 y 少一行）。
/** file::read(string&)：wordmode/csvmode 取一个词，否则取一整行（注释在行内截掉） */
private string asy__fr1s(file f) {
  if (f.fd == 0) abort("这一层读不了 stdin（只读真的文件：input(\"名字\")）");
  if (!f.opened) { f.eofbit = true; f.errbit = true; return ""; }
  string v = "";
  if (f.nullfield) { f.nullfield = false; f.errbit = false; }   // 空行：零值（空串），不解析
  else if (f.wordmode || f.csvmode) v = asy__ftok(f);
  else { v = f.white + asy__fcut(f, asy__fgetline(f)); }
  f.white = "";
  return v;
}
// 字符串 -> real 的那一格：实现是这个文件**后面**那条 `real operator ecast(string)`
// （量出来的文法与"认不出就是 0"那条都在它那儿），而名字是顺序解析的 —— 所以这里留一格
// 函数值，等那条声明之后再填上（见 ecast 那一段末尾的 `asy__num = …`）。
// 不把整段读文件的代码搬到 ecast 后面：input()/write() 那一族在这里，搬过去就散了。
private real asy__num(string);
/** file::read(double&)：跳空白与注释，取一个词，整词得是一个数（不是就置 errbit） */
private real asy__fr1r(file f) {
  if (f.fd == 0) abort("这一层读不了 stdin（只读真的文件：input(\"名字\")）");
  if (!f.opened) { f.eofbit = true; f.errbit = true; return 0; }
  real v = 0;
  if (f.nullfield) { f.nullfield = false; f.errbit = false; }
  else {
    asy__fskipws(f);
    string t = asy__ftok(f);
    if (!f.errbit) {
      if (asy__finf(t)) v = (substr(t, 0, 1) == "-" ? -inf : inf);
      else if (asy__fnan(t)) v = nan;
      else if (asy__fnum(t)) v = asy__num(t);
      else f.errbit = true;
    }
  }
  f.white = "";
  return v;
}
/** 标量的 cast：读一格，line 模式下再 nexteol 一次（castop.h:95） */
private string asy__fread1s(file f) {
  string v = asy__fr1s(f);
  if (f.linemode) asy__fnexteol(f);
  return v;
}
private real asy__fread1r(file f) {
  real v = asy__fr1r(f);
  if (f.linemode) asy__fnexteol(f);
  return v;
}
// ---- readArray1 / readArray2（castop.h:116）：line 模式下一行一份，否则读到底 ----
private real[] asy__freadr1(file f) {
  real[] out;
  if (!f.opened) { f.eofbit = true; return out; }
  while (true) {
    real v = asy__fr1r(f);
    if (f.errbit) return out;
    out.push(v);
    if (f.linemode && asy__fnexteol(f)) return out;
  }
  return out;
}
private string[] asy__freads1(file f) {
  string[] out;
  if (!f.opened) { f.eofbit = true; return out; }
  while (true) {
    string v = asy__fr1s(f);
    if (f.errbit) return out;
    out.push(v);
    if (f.linemode && asy__fnexteol(f)) return out;
  }
  return out;
}
private real[][] asy__freadr2(file f) {
  real[][] out;
  if (!f.opened) { f.eofbit = true; return out; }
  while (true) {
    real[] row;
    bool put = false;
    while (true) {
      real v = asy__fr1r(f);
      if (f.errbit) return out;
      if (!put) { out.push(row); put = true; }   // asy 也是先挂进去再填（数组是引用）
      row.push(v);
      if (f.linemode && asy__fnexteol(f)) break;
    }
  }
  return out;
}
// 从 file **隐式**读（builtin.cc:494-497 `addCast(ve,t,primFile(),read<T>/readArrayN<T>)`）：
// 标量、一维、二维、三维各一条。这一层给到二维（三维没有真数据用得到，留着报"还没做"）。
int operator cast(file f) { return (int) asy__fread1r(f); }
real operator cast(file f) { return asy__fread1r(f); }
string operator cast(file f) { return asy__fread1s(f); }
pair operator cast(file f) { real x = asy__fread1r(f); real y = asy__fread1r(f); return (x, y); }
triple operator cast(file f) {
  real x = asy__fread1r(f); real y = asy__fread1r(f); real z = asy__fread1r(f);
  return (x, y, z);
}
bool operator cast(file f) { return asy__fread1s(f) == "true"; }
int[] operator cast(file f) {
  real[] r = asy__freadr1(f);
  int[] out;
  for (int i = 0; i < r.length; ++i) out.push((int) r[i]);
  return out;
}
real[] operator cast(file f) { return asy__freadr1(f); }
string[] operator cast(file f) { return asy__freads1(f); }
real[][] operator cast(file f) { return asy__freadr2(f); }
pair[] operator cast(file f) { abort("从 file 读 pair[] 还没做（真数据里还没有用到）"); return new pair[]; }
triple[] operator cast(file f) { abort("从 file 读 triple[] 还没做（真数据里还没有用到）"); return new triple[]; }

// ------------------------------------------------ 数组与标量的算术（逐元素）
// asy 那边是 builtin.cc:454 的 addOps<T,op>：每个 op 挂四份 —— (标量,标量)、
// (标量,数组)、(数组,标量)、(数组,数组)。addBasicOps 给 + -，times 给 *，
// 非整数的还有 /，int 另有 % #（:749-751）。这一层照着补，逐元素。
// 长度不等时 asy 报 "operation attempted on arrays of different lengths: 2 != 1"
// 并退 1（量过），所以这里 abort 的话照抄那一句。
// int[] -> real[] 那条**隐式**转换也在这一族里（builtin.cc 的 arrayToArray）：
// `sequence(n+1)/n`（plain.asy:203）要靠它才能落到 real[] / real 上。
private void asy__samelen(int n, int m) {
  if (n != m) {
    abort("operation attempted on arrays of different lengths: " + (string) n + " != " + (string) m);
  }
}
real[] operator cast(int[] a) { real[] c; for (int x : a) c.push(x); return c; }
real[][] operator cast(int[][] a) { real[][] c; for (int[] x : a) c.push(x); return c; }
// real[] -> pair[] 也在 arrayToArray 那一族里（real -> pair 是内建提升）：
// math.asy:380 的 `return cubicroots(b,c,d,e);`（回 pair[] 的函数里）靠的就是它。
pair[] operator cast(real[] a) { pair[] c; for (real x : a) c.push((x, 0)); return c; }
pair[][] operator cast(real[][] a) { pair[][] c; for (real[] x : a) c.push(x); return c; }
// pair[] -> path[]（asy 那边是 guide[]，见上面那条 `path operator cast(pair)`）：
// graph.asy:2063 的 `join(...z[segment[i]])` 里 z 是 pair[]，而 interpolate 那一格
// 要的是 path[] —— arrayToArray 那一族把元素级的那条提上来。
path[] operator cast(pair[] a) { path[] c; for (pair z : a) c.push(z); return c; }

int[] operator +(int a, int[] b) { int[] c; for (int x : b) c.push(a + x); return c; }
int[] operator +(int[] a, int b) { int[] c; for (int x : a) c.push(x + b); return c; }
int[] operator +(int[] a, int[] b) { asy__samelen(a.length, b.length); int[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] + b[i]); return c; }
int[] operator -(int a, int[] b) { int[] c; for (int x : b) c.push(a - x); return c; }
int[] operator -(int[] a, int b) { int[] c; for (int x : a) c.push(x - b); return c; }
int[] operator -(int[] a, int[] b) { asy__samelen(a.length, b.length); int[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] - b[i]); return c; }
int[] operator *(int a, int[] b) { int[] c; for (int x : b) c.push(a * x); return c; }
int[] operator *(int[] a, int b) { int[] c; for (int x : a) c.push(x * b); return c; }
int[] operator *(int[] a, int[] b) { asy__samelen(a.length, b.length); int[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] * b[i]); return c; }
int[] operator %(int[] a, int b) { int[] c; for (int x : a) c.push(x % b); return c; }
int[] operator #(int[] a, int b) { int[] c; for (int x : a) c.push(x # b); return c; }

real[] operator +(real a, real[] b) { real[] c; for (real x : b) c.push(a + x); return c; }
real[] operator +(real[] a, real b) { real[] c; for (real x : a) c.push(x + b); return c; }
real[] operator +(real[] a, real[] b) { asy__samelen(a.length, b.length); real[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] + b[i]); return c; }
real[] operator -(real a, real[] b) { real[] c; for (real x : b) c.push(a - x); return c; }
real[] operator -(real[] a, real b) { real[] c; for (real x : a) c.push(x - b); return c; }
real[] operator -(real[] a, real[] b) { asy__samelen(a.length, b.length); real[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] - b[i]); return c; }
real[] operator *(real a, real[] b) { real[] c; for (real x : b) c.push(a * x); return c; }
real[] operator *(real[] a, real b) { real[] c; for (real x : a) c.push(x * b); return c; }
real[] operator *(real[] a, real[] b) { asy__samelen(a.length, b.length); real[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] * b[i]); return c; }
real[] operator /(real a, real[] b) { real[] c; for (real x : b) c.push(a / x); return c; }
real[] operator /(real[] a, real b) { real[] c; for (real x : a) c.push(x / b); return c; }
real[] operator /(real[] a, real[] b) { asy__samelen(a.length, b.length); real[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] / b[i]); return c; }
real[] operator ^(real[] a, real b) { real[] c; for (real x : a) c.push(x ^ b); return c; }
real[] operator %(real[] a, real b) { real[] c; for (real x : a) c.push(x % b); return c; }

pair[] operator +(pair a, pair[] b) { pair[] c; for (pair x : b) c.push(a + x); return c; }
pair[] operator +(pair[] a, pair b) { pair[] c; for (pair x : a) c.push(x + b); return c; }
pair[] operator +(pair[] a, pair[] b) { asy__samelen(a.length, b.length); pair[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] + b[i]); return c; }
pair[] operator -(pair a, pair[] b) { pair[] c; for (pair x : b) c.push(a - x); return c; }
pair[] operator -(pair[] a, pair b) { pair[] c; for (pair x : a) c.push(x - b); return c; }
pair[] operator -(pair[] a, pair[] b) { asy__samelen(a.length, b.length); pair[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] - b[i]); return c; }
pair[] operator *(pair a, pair[] b) { pair[] c; for (pair x : b) c.push(a * x); return c; }
pair[] operator *(pair[] a, pair b) { pair[] c; for (pair x : a) c.push(x * b); return c; }
pair[] operator *(pair[] a, pair[] b) { asy__samelen(a.length, b.length); pair[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] * b[i]); return c; }
pair[] operator /(pair[] a, pair b) { pair[] c; for (pair x : a) c.push(x / b); return c; }
pair[] operator /(pair a, pair[] b) { pair[] c; for (pair x : b) c.push(a / x); return c; }
pair[] operator /(pair[] a, pair[] b) { asy__samelen(a.length, b.length); pair[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] / b[i]); return c; }

triple[] operator +(triple a, triple[] b) { triple[] c; for (triple x : b) c.push(a + x); return c; }
triple[] operator +(triple[] a, triple b) { triple[] c; for (triple x : a) c.push(x + b); return c; }
triple[] operator +(triple[] a, triple[] b) { asy__samelen(a.length, b.length); triple[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] + b[i]); return c; }
triple[] operator -(triple a, triple[] b) { triple[] c; for (triple x : b) c.push(a - x); return c; }
triple[] operator -(triple[] a, triple b) { triple[] c; for (triple x : a) c.push(x - b); return c; }
triple[] operator -(triple[] a, triple[] b) { asy__samelen(a.length, b.length); triple[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] - b[i]); return c; }
triple[] operator *(real a, triple[] b) { triple[] c; for (triple x : b) c.push(a * x); return c; }
triple[] operator *(triple[] a, real b) { triple[] c; for (triple x : a) c.push(x * b); return c; }
triple[] operator /(triple[] a, real b) { triple[] c; for (triple x : a) c.push(x / b); return c; }

// 比较那一族（runarray.in 的 Compare）：逐元素，回 bool[]。asy 那边 `A > x`（数组与
// 标量）与 `ap >= a`（两个数组）都在这一族里 —— math.asy:147 与 graph.asy:842 靠的
// 就是它，配上 bool[] 的 `&` 与 find(bool[])。
bool[] operator >(real[] a, real[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] > b[i]); return c; }
bool[] operator >=(real[] a, real[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] >= b[i]); return c; }
bool[] operator <(real[] a, real[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] < b[i]); return c; }
bool[] operator <=(real[] a, real[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] <= b[i]); return c; }
bool[] operator >(real[] a, real b) { bool[] c; for (real x : a) c.push(x > b); return c; }
bool[] operator >=(real[] a, real b) { bool[] c; for (real x : a) c.push(x >= b); return c; }
bool[] operator <(real[] a, real b) { bool[] c; for (real x : a) c.push(x < b); return c; }
bool[] operator <=(real[] a, real b) { bool[] c; for (real x : a) c.push(x <= b); return c; }
bool[] operator >(real a, real[] b) { bool[] c; for (real x : b) c.push(a > x); return c; }
bool[] operator >=(real a, real[] b) { bool[] c; for (real x : b) c.push(a >= x); return c; }
bool[] operator <(real a, real[] b) { bool[] c; for (real x : b) c.push(a < x); return c; }
bool[] operator <=(real a, real[] b) { bool[] c; for (real x : b) c.push(a <= x); return c; }
// bool[] 上的"与"：也是逐元素的（graph.asy:842 的 `A > … & A < …`）
bool[] operator &(bool[] a, bool[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] && b[i]); return c; }
bool[] operator |(bool[] a, bool[] b) { asy__samelen(a.length, b.length); bool[] c; for (int i = 0; i < a.length; ++i) c.push(a[i] || b[i]); return c; }

// 二维数组上的 `*` 是**矩阵乘**，不是逐元素（runarray.in 的 mulArray 那一族）。
// plain_Label.asy:66 的 `conj(U)*A*U` 与 math.asy:434 的 `b*A` 就是这两条。
pair[][] operator *(pair[][] a, pair[][] b) {
  int n = a.length;
  if (n == 0) return new pair[][];
  int m = b.length;
  asy__samelen(a[0].length, m);
  int p = m == 0 ? 0 : b[0].length;
  pair[][] r = new pair[n][];
  for (int i = 0; i < n; ++i) {
    pair[] row = new pair[p];
    for (int j = 0; j < p; ++j) {
      pair s = (0, 0);
      for (int k = 0; k < m; ++k) s += a[i][k] * b[k][j];
      row[j] = s;
    }
    r[i] = row;
  }
  return r;
}
real[][] operator *(real[][] a, real[][] b) {
  int n = a.length;
  if (n == 0) return new real[][];
  int m = b.length;
  asy__samelen(a[0].length, m);
  int p = m == 0 ? 0 : b[0].length;
  real[][] r = new real[n][];
  for (int i = 0; i < n; ++i) {
    real[] row = new real[p];
    for (int j = 0; j < p; ++j) {
      real s = 0;
      for (int k = 0; k < m; ++k) s += a[i][k] * b[k][j];
      row[j] = s;
    }
    r[i] = row;
  }
  return r;
}
real[] operator *(real[] a, real[][] b) {
  int m = b.length;
  asy__samelen(a.length, m);
  int p = m == 0 ? 0 : b[0].length;
  real[] r = new real[p];
  for (int j = 0; j < p; ++j) {
    real s = 0;
    for (int k = 0; k < m; ++k) s += a[k] * b[k][j];
    r[j] = s;
  }
  return r;
}
real[] operator *(real[][] a, real[] b) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) {
    asy__samelen(a[i].length, b.length);
    real s = 0;
    for (int k = 0; k < b.length; ++k) s += a[i][k] * b[k];
    r[i] = s;
  }
  return r;
}

// 一元的 `-` 也有数组那一份（asy 里 `write(-a)` 逐元素取负，量过）
int[] operator -(int[] a) { int[] c; for (int x : a) c.push(-x); return c; }
real[] operator -(real[] a) { real[] c; for (real x : a) c.push(-x); return c; }
pair[] operator -(pair[] a) { pair[] c; for (pair x : a) c.push(-x); return c; }
triple[] operator -(triple[] a) { triple[] c; for (triple x : a) c.push(-x); return c; }

// ---------------------------------------------------- 字节与十六进制那四个
// (1) `transform * path`：逐个结点搬（transform 是仿射，pre/point/post 都搬）。
// runpath.in 的 `path operator *(transform t, path p)` 就是这件事。
path operator *(transform t, path g) {
  path out;
  out.cyclic = g.cyclic;
  out.ismark = g.ismark;
  for (knot k : g.nodes) {
    knot n;
    n.pre = t * k.pre;
    n.point = t * k.point;
    n.post = t * k.post;
    n.straight = k.straight;
    out.nodes.push(n);
  }
  return out;
}

// (1a) `minAfterTransform` / `maxAfterTransform`（runpath.in:338/362）：把每条路径先搬
// 一遍再取盒子，逐分量取最小 / 最大。空数组时 asy 报的是 "nullpath has no points"
// （path.cc:28 的 nopoints）。plain_bounds.asy:316/317/322/323 要的是它们。
pair minAfterTransform(transform t, path[] p) {
  if (p.length == 0) { abort("nullpath has no points"); return (0, 0); }
  pair z = min(t * p[0]);
  real mx = z.x;
  real my = z.y;
  for (int i = 1; i < p.length; ++i) {
    pair w = min(t * p[i]);
    if (w.x < mx) mx = w.x;
    if (w.y < my) my = w.y;
  }
  return (mx, my);
}

pair maxAfterTransform(transform t, path[] p) {
  if (p.length == 0) { abort("nullpath has no points"); return (0, 0); }
  pair z = max(t * p[0]);
  real mx = z.x;
  real my = z.y;
  for (int i = 1; i < p.length; ++i) {
    pair w = max(t * p[i]);
    if (w.x > mx) mx = w.x;
    if (w.y > my) my = w.y;
  }
  return (mx, my);
}

// (1) 笔的盒子（runtime.in:339/344，体是 pen.h:931 的 `pen::bounds()`）：没有笔尖时，
// 盒子是 ±0.5*linewidth*(maxx,maxy) 再加上笔那个变换的平移。恒等变换下 maxx=maxy=1、
// shift=(0,0)，也就是 ±0.5*linewidth 的正方形（plain_boxes.asy:16 用的正是这一条）；
// 带变换时那两个数是"单位圆被线性部分映出去的最大 x/y"，即两行各自的模长。
pair max(pen p) {
  real mx = 1;
  real my = 1;
  pair sh = (0, 0);
  if (p.hastrans) {
    mx = length((p.pentrans.xx, p.pentrans.xy));
    my = length((p.pentrans.yx, p.pentrans.yy));
    sh = p.pentrans * (0, 0);
  }
  real w = 0.5 * linewidth(p);
  return (w * mx + sh.x, w * my + sh.y);
}
pair min(pen p) {
  real mx = 1;
  real my = 1;
  pair sh = (0, 0);
  if (p.hastrans) {
    mx = length((p.pentrans.xx, p.pentrans.xy));
    my = length((p.pentrans.yx, p.pentrans.yy));
    sh = p.pentrans * (0, 0);
  }
  real w = 0.5 * linewidth(p);
  return (-w * mx + sh.x, -w * my + sh.y);
}

// (1) defaultpen 那一族（runtime.in:355/360）：读/写上面那一格。
pen defaultpen() { return pencopy(asy__defpen); }
// 存进来的那一份要把 dashset 抹掉：所有笔的构造函数都是 `pencopy(asy__defpen)` 起手的，
// 抹掉之后 `defaultpen(dashed)` 之后新造的笔仍旧带着那份 pattern（读的人直接读 dashpat，
// 等于把 pen.h:468 那层 fallback 在构造时就落了地），但它们**不会**在 `p+q` 里把左边的
// 虚线盖掉 —— asy 那边 `rgb(1,0,0)` 的 line 一直是 isdefault。
void defaultpen(pen p) { asy__defpen = pencopy(p); asy__defpen.dashset = false; }

// (1) 虚线（runtime.in:503）：负数截成 0（参考实现里那句 `::max(...,0.0)`），
// 别的三个属性照原样存着。`linetype(pen)` 回那份 pattern。
pen linetype(real[] pattern, real offset=0, bool scale=true, bool adjust=true) {
  pen q = pencopy(asy__defpen);
  real[] a;
  for (real x : pattern) a.push(x < 0 ? 0 : x);
  q.dashpat = a;
  q.dashoffset = offset;
  q.dashscale = scale;
  q.dashadjust = adjust;
  q.dashset = true;
  return q;
}
real[] linetype(pen p = currentpen) { return copy(p.dashpat); }
real offset(pen p) { return p.dashoffset; }
bool scale(pen p) { return p.dashscale; }
bool adjust(pen p) { return p.dashadjust; }

// (1) 把虚线的节拍缩到正好铺满弧长（runtime.in:535 -> drawpath.cc:52 的 adjustdash，
// PatternLength 是同一个文件 :21）。逐句照抄，只有一处对不上要说清：那边 `q.linetype()`
// 在 `line.isdefault` 时回的是 **defaultpen 的**那一份，而这一层的笔没有 isdefault 这一格
// （linetype(real[],…) 一造出来就是实的），所以这里读的一律是笔自己那一格。
// `q.adjust(factor)` 就是 pen.h:471 -> LineType::Scale：pattern 每一项与 offset 同乘。
private real asy__patlen(real arclength, real[] pat, bool cyclic, real penwidth) {
  real sum = 0;
  int n = pat.length;
  for (int i = 0; i < n; ++i) sum += pat[i]*penwidth;
  if (sum == 0) return 0;
  if (n % 2 == 1) sum *= 2;              // 奇数项的通断花样两轮才重复
  real pat0 = pat[0];
  if (!cyclic && pat0 == 0) sum += 1e-3*penwidth;
  real terminator = (cyclic && arclength >= 0.5*sum) ? 0 : pat0*penwidth;
  int ncycle = (int) ((arclength-terminator)/sum+0.5);
  return (ncycle >= 1 || terminator >= 0.75*arclength) ? ncycle*sum+terminator : 0;
}
pen adjust(pen p, real arclength, bool cyclic) {
  pen q = pencopy(p);
  int n = q.dashpat.length;
  if (n > 0) {
    real penwidth = q.dashscale ? linewidth(q) : 1;
    real factor = penwidth;
    if (q.dashadjust && arclength != 0) {
      real denom = asy__patlen(arclength, q.dashpat, cyclic, penwidth);
      if (denom != 0) factor *= arclength/denom;
    }
    if (factor != 1) {
      real f = max(factor, 0.1);
      real[] a;
      for (real x : q.dashpat) a.push(x*f);
      q.dashpat = a;
      q.dashoffset = q.dashoffset*f;
    }
  }
  return q;
}

// asy__dashhook：把上面 emitop 用的那两个桩接到真货上（声明在 setpen 之前，见那儿的注）。
// 中间套一层同名包装是因为 `arclength` 是重载名（path / path3 / 四个 pair），
// 直接赋给函数变量要靠签名去挑，这里不指望它。
private real asy__arclen1(path p) { return arclength(p); }
private pen asy__dashadj1(pen p, real a, bool c) { return adjust(p, a, c); }
asy__arclenfn = asy__arclen1;
asy__dashadjfn = asy__dashadj1;

// (1) frame 上的分组与 3D 问询（runpicture.in:286/291/778）。分组在 EPS 那一路是
// `gsave/grestore` 那一层的事，我们的 frame 只攒 drawop，所以这两个是空的 —— 画出来一样。
void begingroup(frame f) { }
void endgroup(frame f) { }
bool is3D(frame f) { return false; }
// (1) `gsave`/`grestore`（runpicture.in:276/281）：往 frame 里塞一条 EPS 的图形状态存/取。
// 落成 `kind == 6`（逐字照发的那一格，与 postscript(frame,string) 同一种 drawop）——
// 它没有路径，所以不进界（opbox 对空路径给空盒）。
// 用它的是 patterns.asy:16-18 的 tiling：图案的画法要被 `gsave`/`grestore` 包起来，
// 参考里那段 `<< … /PaintProc {pop` 之后紧跟的就是这一条 gsave。
void gsave(frame f) {
  drawop o;
  o.kind = 6;
  o.psraw = "gsave";
  o.p = currentpen;
  f.ops.push(o);
}
void grestore(frame f) {
  drawop o;
  o.kind = 6;
  o.psraw = "grestore";
  o.p = currentpen;
  f.ops.push(o);
}

// (1) frame 上的那一批画图内建（runpicture.in）。`fill(frame, path[], …)` 是**一个**填充：
// asy 那边一组路径连着 fillrule 才是一个区域（挖洞靠它），drawfill.cc:49-52 只发一句
// newpath、一句 fill。这一层一条路径一格 op，第 2..n 格挂上 merge，出图时再拼回一组。
void fill(frame f, path[] g, pen p = currentpen, bool copy = true) {
  for (int i = 0; i < g.length; ++i) {
    addop(f, 1, g[i], p);
    if (i > 0) f.ops[f.ops.length - 1].merge = true;
  }
}
// 下面这些是**声明在这里、体是 abort**：签名照参考实现抄准，语义（渐变、裁剪、TeX、
// 分层、翻页、3D 盒子）都还没做。抄准签名是为了让"没做"落在运行期那一句话上，
// 而不是编译期一堆"没有能匹配的签名"。
// 渐变/网格填充那一族（runpicture.in:160..244）：一格 kind == 2 的 drawop，余料挂在 sh 上。
// 出图那一下在 emitshade 里（那一段照 drawfill.h 的 drawShade::draw 与 psfile.cc 的四个
// 发字典的函数抄的）。**没做的两处写在明处**：透明度（setopacity 那一路）与
// functionshade（要把用户那段 PostScript 当函数塞进字典里）。
path[] asy__gcopy(path[] g) {
  path[] r;
  for (int i = 0; i < g.length; ++i) r.push(pathcopy(g[i]));
  return r;
}
pen[] asy__pcopy(pen[] p) {
  pen[] r;
  for (int i = 0; i < p.length; ++i) r.push(pencopy(p[i]));
  return r;
}
pen[][] asy__pcopy2(pen[][] p) {
  pen[][] r;
  for (int i = 0; i < p.length; ++i) r.push(asy__pcopy(p[i]));
  return r;
}
void asy__addshade(frame f, shadeinfo h, pen fillrule) {
  drawop o;
  o.kind = 2;
  o.p = pencopy(fillrule);
  o.sh = h;
  f.ops.push(o);
}
void latticeshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[][] p, transform t=identity(), bool copy=true) {
  shadeinfo h;
  h.st = 1;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  h.mpens = asy__pcopy2(p);
  h.tt = t;
  asy__addshade(f, h, fillrule);
}
void axialshade(frame f, path[] g, bool stroke=false, pen pena, pair a,
                bool extenda=true, pen penb, pair b, bool extendb=true,
                bool copy=true) {
  shadeinfo h;
  h.st = 2;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  h.pena = pencopy(pena);
  h.penb = pencopy(penb);
  h.za = a;
  h.zb = b;
  h.exta = extenda;
  h.extb = extendb;
  // 渐变那两档的裁剪用的是 pena（drawfill.h 的 drawGradientShade 就拿它当 pentype）
  asy__addshade(f, h, pena);
}
void radialshade(frame f, path[] g, bool stroke=false, pen pena, pair a, real ra,
                 bool extenda=true, pen penb, pair b, real rb, bool extendb=true,
                 bool copy=true) {
  shadeinfo h;
  h.st = 3;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  h.pena = pencopy(pena);
  h.penb = pencopy(penb);
  h.za = a;
  h.zb = b;
  h.ra = ra;
  h.rb = rb;
  h.exta = extenda;
  h.extb = extendb;
  asy__addshade(f, h, pena);
}
void gouraudshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[] p, pair[] z, int[] edges, bool copy=true) {
  asy__samelen(p.length, z.length);
  asy__samelen(z.length, edges.length);
  shadeinfo h;
  h.st = 4;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  h.vpens = asy__pcopy(p);
  h.verts = z;
  h.vedges = edges;
  asy__addshade(f, h, fillrule);
}
// 不给顶点那一份（runpicture.in:206）：顶点就是**路径上的结点**，一条条数过去取够 p 那么多
void gouraudshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[] p, int[] edges, bool copy=true) {
  asy__samelen(p.length, edges.length);
  pair[] z;
  int n = p.length;
  for (int j = 0; j < g.length; ++j) {
    int stop = g[j].nodes.length;
    if (stop > n - z.length) stop = n - z.length;
    for (int i = 0; i < stop; ++i) z.push(g[j].nodes[i].point);
  }
  gouraudshade(f, g, stroke, fillrule, p, z, edges, copy);
}
void tensorshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                 pen[][] p, path[] b=null, pair[][] z=new pair[][], bool copy=true) {
  shadeinfo h;
  h.st = 7;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  h.mpens = asy__pcopy2(p);
  h.bnds = b == null ? h.gs : asy__gcopy(b);
  h.tz = z;
  asy__samelen(p.length, h.bnds.length);
  if (z.length != 0) asy__samelen(z.length, p.length);
  asy__addshade(f, h, fillrule);
}
void functionshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                   string shader="", bool copy=true) {
  abort("functionshade 还没做");
}
// runpicture.in:256 的 clip：把**已经攒下的那一叠**整个围起来（那边是 `f->enclose`），
// 之后再画的东西不受裁剪影响。所以这里是"头上插一格 kind 3、尾上追一格 kind 4"。
// 不描边时路径必须闭合（drawclipbegin.h:21 那一句）。
void clip(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
          bool copy=true) {
  if (!stroke) {
    for (int i = 0; i < g.length; ++i) {
      if (!g[i].cyclic) abort("cannot clip to non-cyclic path");
    }
  }
  shadeinfo h;
  h.gs = asy__gcopy(g);
  h.stroke = stroke;
  drawop b;
  b.kind = 3;
  b.p = pencopy(fillrule);
  b.sh = h;
  drawop e;
  e.kind = 4;
  drawop[] out;
  out.push(b);
  for (int i = 0; i < f.ops.length; ++i) out.push(f.ops[i]);
  out.push(e);
  f.ops = out;
  // 标签那一列里也补一对影子（见 labelrec.kind 那段注释）。裁剪把**已经在这个 frame 里**
  // 的东西整个包住，所以头放在最前、尾放在最后；之后再 label 进来的自然落在尾巴后面，
  // 与真 asy 的单列顺序一致。
  labelrec cb;
  cb.kind = 1;
  cb.gs = asy__gcopy(g);
  cb.stroke = stroke;
  cb.p = pencopy(fillrule);
  labelrec ce;
  ce.kind = 2;
  labelrec[] ol;
  ol.push(cb);
  for (int i = 0; i < f.labs.length; ++i) ol.push(f.labs[i]);
  ol.push(ce);
  f.labs = ol;
}
void beginclip(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
               bool copy=true) {
  abort("beginclip 还没做");
}
void endclip(frame f) { abort("endclip 还没做"); }
void layer(frame f) { abort("layer 还没做"); }
void newpage(frame f) { abort("newpage 还没做"); }
// runpicture.in:331/346 的两份 `postscript`：把一段 PostScript **逐字**塞进产物
// （那边是 drawVerbatim）。带 min/max 的那一份还报一个界 —— 它是给 `size()` 定标用的，
// 逐字那一段自己不会告诉别人它有多大。
void postscript(frame f, string s) {
  drawop o;
  o.kind = 6;
  o.psraw = s;
  o.p = currentpen;
  f.ops.push(o);
}
void postscript(frame f, string s, pair min, pair max) {
  drawop o;
  o.kind = 6;
  o.psraw = s;
  o.p = currentpen;
  o.g = min--(max.x, min.y)--max--(min.x, max.y)--cycle;
  f.ops.push(o);
}
void tex(frame f, string s) { abort("tex 还没做"); }
void tex(frame f, string s, pair min, pair max) { abort("tex 还没做"); }
void javascript(frame f, string s) { abort("javascript 还没做"); }
void deconstruct(frame f, frame preamble, transform T=identity()) {
  abort("deconstruct 还没做");
}
// 三维的界（runpicture.in:757/762）：记在 frame 上，见 asy__add3。
// **空 frame 回原点，不报错** —— 量的（`import three; frame f; write(min3(f));`
// 真 asy 印 `(0,0,0)` 两行、退出码 0）。从前这里 abort("没有三维的东西")，而 three.asy
// 里到处是"先量一遍界再决定投影"（2461/2617/2883…），于是 220 例里 29 个例子当场停在这一句。
triple min3(frame f) {
  return f.has3 ? f.min3v : (0, 0, 0);
}
triple max3(frame f) {
  return f.has3 ? f.max3v : (0, 0, 0);
}

// ------------------------------------------------- 三维路径（第四十八刀）
// `path3` 在真 asy 那边是 C++ 的内建类型（path3.h），与 `path` 是同一套结构、坐标换成
// triple。**求解**那一头不在这儿：three.asy 自己写了 `struct flatguide3` 与
// `path3 solve(flatguide3)`（:601/:1247），`guide3` 的 `--` / `..` 也是它自己的
// （:758/:772）。所以这一层要补的只是 path3 这个**原始类型**与 runpath3d.in 那一批
// 取值函数 —— 其中 `path3(pre,point,post,straight,cyclic)`（three.asy:1359 用的那份）
// 是 solve 的落点，最要紧。
struct knot3 {
  triple pre;
  triple point;
  triple post;
  bool straight = false;
}

struct path3 {
  knot3[] nodes;
  bool cyclic = false;
}

path3 nullpath3;

knot3 knot3copy(knot3 k) {
  knot3 j;
  j.pre = k.pre;
  j.point = k.point;
  j.post = k.post;
  j.straight = k.straight;
  return j;
}

// path3 在 asy 那边是值类型；我们的 struct 是引用类型，所以每次都先复制一份
path3 path3copy(path3 g) {
  path3 h;
  h.cyclic = g.cyclic;
  for (int i = 0; i < g.nodes.length; ++i) h.nodes.push(knot3copy(g.nodes[i]));
  return h;
}

// runpath3d.in 的 `path3(triple[] pre, triple[] point, triple[] post, bool[] straight,
// bool cyclic)` —— three.asy:1359 的 solve 就是拿它把解好的结点装成 path3 的
path3 path3(triple[] pre, triple[] point, triple[] post, bool[] straight, bool cyclic) {
  path3 g;
  g.cyclic = cyclic;
  for (int i = 0; i < point.length; ++i) {
    knot3 k;
    k.pre = i < pre.length ? pre[i] : point[i];
    k.point = point[i];
    k.post = i < post.length ? post[i] : point[i];
    k.straight = i < straight.length ? straight[i] : false;
    g.nodes.push(k);
  }
  return g;
}

int length(path3 g) {
  if (g.cyclic) return g.nodes.length;
  return g.nodes.length - 1;
}

int size(path3 g) { return g.nodes.length; }
bool cyclic(path3 g) { return g.cyclic; }

private int asy__nwrap3(path3 g, int i) {
  int n = g.nodes.length;
  if (!g.cyclic || n == 0) return i;
  int k = i % n;
  return k < 0 ? k + n : k;
}

triple point(path3 g, int i) { return g.nodes[asy__nwrap3(g, i)].point; }
triple precontrol(path3 g, int i) { return g.nodes[asy__nwrap3(g, i)].pre; }
triple postcontrol(path3 g, int i) { return g.nodes[asy__nwrap3(g, i)].post; }

bool straight(path3 p, int t) {
  int n = p.nodes.length;
  if (n == 0) return false;
  if (p.cyclic) return p.nodes[t % n].straight;
  if (t < 0 || t >= n) return false;
  return p.nodes[t].straight;
}

// 段内按那一段的三次 Bezier 取点 —— 与 point(path,real) 逐行同，坐标换成 triple
triple point(path3 g, real t) {
  int n = g.nodes.length;
  if (n == 0) { abort("point: 空的 path3"); return (0, 0, 0); }
  int segs = g.cyclic ? n : n - 1;
  if (segs <= 0) return g.nodes[0].point;
  real u = t;
  if (g.cyclic) {
    while (u < 0) u = u + segs;
    while (u >= segs) u = u - segs;
  } else {
    if (u <= 0) return g.nodes[0].point;
    if (u >= segs) return g.nodes[n - 1].point;
  }
  int i = floor(u);
  real s = u - i;
  knot3 a = g.nodes[i];
  knot3 b = g.nodes[i + 1 == n ? 0 : i + 1];
  real r = 1 - s;
  return r*r*r*a.point + 3*r*r*s*a.post + 3*r*s*s*b.pre + s*s*s*b.point;
}

triple dir(path3 g, real t, bool normalize=true) {
  int n = g.nodes.length;
  if (n == 0) { abort("dir: 空的 path3"); return (0, 0, 0); }
  int segs = g.cyclic ? n : n - 1;
  if (segs <= 0) return (0, 0, 0);
  real u = t;
  if (g.cyclic) {
    while (u < 0) u = u + segs;
    while (u >= segs) u = u - segs;
  } else {
    if (u < 0) u = 0;
    if (u > segs) u = segs;
  }
  int i = floor(u);
  if (i >= segs) i = segs - 1;
  real s = u - i;
  knot3 a = g.nodes[i];
  knot3 b = g.nodes[i + 1 == n ? 0 : i + 1];
  real r = 1 - s;
  triple d = 3*r*r*(a.post - a.point) + 6*r*s*(b.pre - a.post) + 3*s*s*(b.point - b.pre);
  if (d == (0, 0, 0)) d = b.point - a.point;
  return normalize ? unit(d) : d;
}

triple dir(path3 g, int i, int sign=0, bool normalize=true) {
  int n = g.nodes.length;
  if (n == 0) { abort("dir: 空的 path3"); return (0, 0, 0); }
  if (sign < 0) return dir(g, i - 1e-9 + (i == 0 && !g.cyclic ? 1e-9 : 0), normalize);
  if (sign > 0) return dir(g, i + (i == length(g) && !g.cyclic ? -1e-9 : 1e-9), normalize);
  triple a = dir(g, i, -1, normalize);
  triple b = dir(g, i, 1, normalize);
  triple s = a + b;
  return normalize ? unit(s) : s;
}

// path3.cc 的 reverse：结点倒排、pre 与 post 互换，straight 挂在左端那个结上
path3 reverse(path3 g) {
  path3 h;
  h.cyclic = g.cyclic;
  int n = g.nodes.length;
  if (n == 0) return h;
  int len = length(g);
  for (int i = 0; i < n; ++i) {
    int j = len - i;
    knot3 a = g.nodes[asy__nwrap3(g, j)];
    knot3 k;
    k.pre = a.post;
    k.point = a.point;
    k.post = a.pre;
    k.straight = g.cyclic || j > 0 ? g.nodes[asy__nwrap3(g, j - 1)].straight : false;
    h.nodes.push(k);
  }
  return h;
}

// de Casteljau：三维那一份（与 asy__subbez 逐行同）
private triple[] asy__subbez3(triple z0, triple c0, triple c1, triple z1,
                              real t0, real t1) {
  triple p01 = z0 + (c0 - z0) * t1;
  triple p12 = c0 + (c1 - c0) * t1;
  triple p23 = c1 + (z1 - c1) * t1;
  triple q0 = p01 + (p12 - p01) * t1;
  triple q1 = p12 + (p23 - p12) * t1;
  triple r = q0 + (q1 - q0) * t1;
  real s = t1 == 0 ? 0 : t0 / t1;
  triple u01 = z0 + (p01 - z0) * s;
  triple u12 = p01 + (q0 - p01) * s;
  triple u23 = q0 + (r - q0) * s;
  triple v0 = u01 + (u12 - u01) * s;
  triple v1 = u12 + (u23 - u12) * s;
  triple w = v0 + (v1 - v0) * s;
  triple[] out;
  out.push(w);
  out.push(v1);
  out.push(u23);
  out.push(r);
  return out;
}

path3 subpath(path3 p, int a, int b) {
  int n = p.nodes.length;
  if (n == 0) return path3copy(p);
  if (a > b) return reverse(subpath(p, b, a));
  int ia = a;
  int ib = b;
  if (!p.cyclic) {
    int len = length(p);
    if (ia < 0) ia = 0;
    if (ib > len) ib = len;
    if (ia > len) ia = len;
    if (ib < 0) ib = 0;
  }
  path3 h;
  for (int i = ia; i <= ib; ++i) {
    knot3 k = knot3copy(p.nodes[asy__nwrap3(p, i)]);
    if (i == ia) k.pre = k.point;
    if (i == ib) { k.post = k.point; k.straight = false; }
    h.nodes.push(k);
  }
  return h;
}

path3 subpath(path3 p, real a, real b) {
  int segs = length(p);
  if (segs <= 0) return path3copy(p);
  if (a > b) return reverse(subpath(p, b, a));
  real ta = a;
  real tb = b;
  if (!p.cyclic) {
    if (ta < 0) ta = 0;
    if (tb < 0) tb = 0;
    if (ta > segs) ta = segs;
    if (tb > segs) tb = segs;
  }
  if (ta == tb) {
    path3 one;
    knot3 k;
    k.pre = point(p, ta);
    k.point = k.pre;
    k.post = k.pre;
    one.nodes.push(k);
    return one;
  }
  int ia = floor(ta);
  real fa = ta - ia;
  int ib = floor(tb);
  real fb = tb - ib;
  if (fb == 0) { ib = ib - 1; fb = 1; }
  path3 h;
  for (int i = ia; i <= ib; ++i) {
    real t0 = i == ia ? fa : 0;
    real t1 = i == ib ? fb : 1;
    triple[] q = asy__subbez3(point(p, i), postcontrol(p, i),
                              precontrol(p, i + 1), point(p, i + 1), t0, t1);
    if (i == ia) {
      knot3 k;
      k.pre = q[0];
      k.point = q[0];
      k.post = q[1];
      k.straight = straight(p, i);
      h.nodes.push(k);
    } else {
      h.nodes[h.nodes.length - 1].post = q[1];
      h.nodes[h.nodes.length - 1].straight = straight(p, i);
    }
    knot3 e;
    e.pre = q[2];
    e.point = q[3];
    e.post = q[3];
    h.nodes.push(e);
  }
  return h;
}

// 弧长与 arctime：与二维那两份同一条路（5 点 Gauss-Legendre + 二分细化）
private real asy__bspeed3(triple z0, triple c0, triple c1, triple z1, real t) {
  real r = 1 - t;
  triple d = 3*r*r*(c0 - z0) + 6*r*t*(c1 - c0) + 3*t*t*(z1 - c1);
  return length(d);
}

private real asy__gl53(triple z0, triple c0, triple c1, triple z1, real a, real b) {
  real h = (b - a) / 2;
  real m = (a + b) / 2;
  real x1 = 0.906179845938664;
  real x2 = 0.538469310105683;
  real w0 = 0.568888888888889;
  real w1 = 0.236926885056189;
  real w2 = 0.478628670499366;
  return h * (w0 * asy__bspeed3(z0, c0, c1, z1, m)
    + w1 * (asy__bspeed3(z0, c0, c1, z1, m - h*x1) + asy__bspeed3(z0, c0, c1, z1, m + h*x1))
    + w2 * (asy__bspeed3(z0, c0, c1, z1, m - h*x2) + asy__bspeed3(z0, c0, c1, z1, m + h*x2)));
}

private real asy__arcpart3(triple z0, triple c0, triple c1, triple z1,
                           real a, real b, int depth) {
  real whole = asy__gl53(z0, c0, c1, z1, a, b);
  real m = (a + b) / 2;
  real half = asy__gl53(z0, c0, c1, z1, a, m) + asy__gl53(z0, c0, c1, z1, m, b);
  if (depth <= 0) return half;
  if (abs(whole - half) <= 1e-15 * (abs(half) + 1e-15)) return half;
  return asy__arcpart3(z0, c0, c1, z1, a, m, depth - 1)
    + asy__arcpart3(z0, c0, c1, z1, m, b, depth - 1);
}

real arclength(triple z0, triple c0, triple c1, triple z1) {
  return asy__arcpart3(z0, c0, c1, z1, 0, 1, 24);
}

private real asy__seglen3(path3 p, int i) {
  if (straight(p, i)) return length(point(p, i + 1) - point(p, i));
  return arclength(point(p, i), postcontrol(p, i), precontrol(p, i + 1), point(p, i + 1));
}

real arclength(path3 p) {
  real s = 0;
  int segs = length(p);
  for (int i = 0; i < segs; ++i) s = s + asy__seglen3(p, i);
  return s;
}

// straightness（runpath3d.in:183/189，公式在 triple.h:398 的 Straightness）：
// c0、c1 离 z0--z1 的 1/3、2/3 两点的距离**平方**里大的那个。tube.asy:19 的 Split 用它。
real straightness(triple z0, triple c0, triple c1, triple z1) {
  triple v = (z1 - z0) / 3;
  triple a = c0 - v - z0;
  triple b = z1 - v - c1;
  real la = dot(a, a);
  real lb = dot(b, b);
  return la > lb ? la : lb;
}

// 段 t 那一份（直段直接 0，与 p.straight(t) 那一支对上）
real straightness(path3 p, int t) {
  if (straight(p, t)) return 0;
  return straightness(point(p, t), postcontrol(p, t), precontrol(p, t + 1),
                      point(p, t + 1));
}

real arctime(path3 p, real L) {
  int segs = length(p);
  if (segs <= 0) return 0;
  if (L <= 0) return 0;
  real rem = L;
  for (int i = 0; i < segs; ++i) {
    real seg = asy__seglen3(p, i);
    if (rem > seg) { rem = rem - seg; continue; }
    if (seg <= 0) return i;
    triple z0 = point(p, i);
    triple c0 = postcontrol(p, i);
    triple c1 = precontrol(p, i + 1);
    triple z1 = point(p, i + 1);
    real lo = 0;
    real hi = 1;
    for (int k = 0; k < 52; ++k) {
      real mid = (lo + hi) / 2;
      if (asy__arcpart3(z0, c0, c1, z1, 0, mid, 16) < rem) lo = mid; else hi = mid;
    }
    return i + (lo + hi) / 2;
  }
  return segs;
}

// 包围盒：控制点的逐分量下/上界（真 asy 是解导数的零点，这一层用控制点的凸包界 ——
// 那是个**外界**，够画图用，与 asy 的数不一定同）
triple min(path3 g) {
  int n = g.nodes.length;
  if (n == 0) { abort("min: 空的 path3"); return (0, 0, 0); }
  triple m = g.nodes[0].point;
  for (int i = 0; i < n; ++i) {
    m = minbound(m, g.nodes[i].point);
    m = minbound(m, g.nodes[i].pre);
    m = minbound(m, g.nodes[i].post);
  }
  return m;
}

triple max(path3 g) {
  int n = g.nodes.length;
  if (n == 0) { abort("max: 空的 path3"); return (0, 0, 0); }
  triple m = g.nodes[0].point;
  for (int i = 0; i < n; ++i) {
    m = maxbound(m, g.nodes[i].point);
    m = maxbound(m, g.nodes[i].pre);
    m = maxbound(m, g.nodes[i].post);
  }
  return m;
}

path3[] concat(path3[] a, path3[] b) {
  path3[] out;
  for (path3 x : a) out.push(x);
  for (path3 x : b) out.push(x);
  return out;
}

// 4x4 齐次变换作用在整条路上（three.asy:1951 的 `t*p[i]`）落在下面 ——
// 它要用 `real[][]*triple`，而那一份声明在这一段**后面**（名字解析是顺序的）。

// (1) 几个零碎的（runtime.in / builtin.cc 的模板那一批）
// shift(transform)：只留平移，线性部分清零（runtime.in:1169 —— 量过是 (3,4,0,0,0,0)）。
transform shift(transform t) { return xform(t.x, t.y, 0, 0, 0, 0); }
pair interp(pair a, pair b, real t) { return a + (b - a) * t; }
// real 上那一份（builtin.cc:571 的 `interp<real>`）：graph.asy:2103 的
// `real t = interp(a, b, i/n);` 要的正是它 —— 少了它那一句挑到 pair 那份上去了
real interp(real a, real b, real t) { return a + (b - a) * t; }
pair minbound(pair[] a) {
  if (a.length == 0) { abort("minbound(pair[])：空数组"); return (0, 0); }
  pair m = a[0];
  for (int i = 1; i < a.length; ++i) m = minbound(m, a[i]);
  return m;
}
pair maxbound(pair[] a) {
  if (a.length == 0) { abort("maxbound(pair[])：空数组"); return (0, 0); }
  pair m = a[0];
  for (int i = 1; i < a.length; ++i) m = maxbound(m, a[i]);
  return m;
}
// ---- 三次/二次实根与"路径与直线求交"（path.cc 那一段照抄） ----
// 摆在这儿而不是与 quadraticroots 一起：名字是**按位置**解析的，下面
// intersections(path,pair,pair) 要用它们。公开的 quadraticroots / cubicroots
// 在后面，正文就是调这几个私有的。
// asy__Fuzz2 / asy__Fuzz4 / asy__sqrt1pxm1 已经在包围盒那一段（min/max(path)）
// 声明过了 —— 那边也要用，而名字按位置解析，只能摆在更前面。
private real asy__BigFuzz = 10.0 * asy__Fuzz2;      // path.cc:23
private real asy__fuzzFactor = 100.0;               // path.cc:24
private real asy__third = 1.0 / 3.0;
// 公开的 abs2 声明在后面（名字按位置解析），这一段自己带一份
private real asy__abs2(pair z) { return z.x * z.x + z.y * z.y; }
// 这一层没有 cbrt（宿主交集里没有），用 `^` 带上符号 —— 末位可能与 cbrt 差一两个 ulp。
// 量过：下面那 8 个探针与内建的 intersections 逐字节一样，所以这个差在这一路上没露头。
private real asy__cbrt(real x) { return x < 0 ? -((-x) ^ asy__third) : x ^ asy__third; }
// cbrt(sqrt(1+x)+1) - cbrt(sqrt(1+x)-1)（path.cc:134）
private real asy__cbrtsqrt1pxm(real x) {
  real s = asy__sqrt1pxm1(x);
  return 2.0 / (asy__cbrt(x + 2.0 * (sqrt(1.0 + x) + 1.0)) + asy__cbrt(x) + asy__cbrt(s * s));
}
// cos((atan(1/w)+pi)/3) 的泰勒展开（path.cc:141）
private real asy__costhetapi3(real w) {
  real c1 = 1.0 / 3.0, c3 = -19.0 / 162.0, c5 = 425.0 / 5832.0, c7 = -16829.0 / 314928.0;
  real w2 = w * w, w3 = w2 * w, w5 = w3 * w2;
  return c1 * w + c3 * w3 + c5 * w5 + c7 * w5 * w2;
}
// path.cc:46 的 quadraticroots，**按重数**报：C++ 那边 roots 与 distinct 是两个数，
// cubicroots 看的是 roots（x == -1 那一格是重根，roots=2、t1=t2）。公开的
// quadraticroots 报的是 distinct 那一套，所以两份不能共用一个正文。
private real[] asy__qroots(real a, real b, real c) {
  real[] r;
  if (abs(a) <= asy__Fuzz2 * abs(b) + asy__Fuzz4 * abs(c)) {
    if (abs(b) > asy__Fuzz2 * abs(c)) { r.push(-c / b); return r; }
    if (c == 0.0) { r.push(0.0); return r; }
    return r;
  }
  real factor = 0.5 * b / a;
  real denom = b * factor;
  if (abs(denom) <= asy__Fuzz2 * abs(c)) {
    real x = -c / a;
    if (x >= 0.0) { real t2 = sqrt(x); r.push(-t2); r.push(t2); }
    return r;
  }
  real x = -2.0 * c / denom;
  if (x > -1.0) {
    real r2 = factor * asy__sqrt1pxm1(x);
    real r1 = -r2 - 2.0 * factor;
    if (r1 <= r2) { r.push(r1); r.push(r2); } else { r.push(r2); r.push(r1); }
    return r;
  }
  if (x == -1.0) { r.push(-factor); r.push(-factor); }
  return r;
}
// path.cc:154 的 cubicroots
private real[] asy__croots(real a, real b, real c, real d) {
  real[] r;
  real ninth = 1.0 / 9.0, fiftyfourth = 1.0 / 54.0;
  // 数值无穷远处的根去掉
  if (abs(a) <= asy__Fuzz2 * (abs(b) + abs(c) * asy__Fuzz2 + abs(d) * asy__Fuzz4))
    return asy__qroots(b, c, d);
  // 数值零那一格的根挑出来
  if (abs(d) <= asy__Fuzz2 * (abs(c) + abs(b) * asy__Fuzz2 + abs(a) * asy__Fuzz4)) {
    r.push(0.0);
    real[] q = asy__qroots(a, b, c);
    for (int i = 0; i < q.length; ++i) r.push(q[i]);
    return r;
  }
  b /= a; c /= a; d /= a;
  real b2 = b * b;
  real Q = 3.0 * c - b2;
  if (abs(Q) < asy__Fuzz2 * (3.0 * abs(c) + abs(b2))) Q = 0.0;
  real R = (3.0 * Q + b2) * b - 27.0 * d;
  if (abs(R) < asy__Fuzz2 * ((3.0 * abs(Q) + abs(b2)) * abs(b) + 27.0 * abs(d))) R = 0.0;
  Q *= ninth; R *= fiftyfourth;
  real Q3 = Q * Q * Q, R2 = R * R, D = Q3 + R2, mthirdb = -b * asy__third;
  if (D > 0.0) {
    real t1 = mthirdb;
    if (R2 != 0.0) t1 += asy__cbrt(R) * asy__cbrtsqrt1pxm(Q3 / R2);
    r.push(t1);
    return r;
  }
  real v = 0.0, theta;
  if (R2 > 0.0) { v = sqrt(-D / R2); theta = atan(v); } else theta = 0.5 * pi;
  real factor = 2.0 * sqrt(-Q) * (R >= 0 ? 1 : -1);
  real t1 = mthirdb + factor * cos(asy__third * theta);
  real t2 = mthirdb - factor * cos(asy__third * (theta - pi));
  real t3 = mthirdb;
  if (R2 > 0.0)
    t3 -= factor * ((v < 100.0) ? cos(asy__third * (theta + pi))
                                : asy__costhetapi3(1.0 / v));
  r.push(t1); r.push(t2); r.push(t3);
  return r;
}
// path.cc:802 的 online：z 在过 p、q 的那条**无穷长**直线上（按范数缩过的容差）
private bool asy__online(pair p, pair q, pair z, real fuzz) {
  real norm = max(max(asy__abs2(p), asy__abs2(q)), asy__abs2(z));
  if (p == q) return asy__abs2(z - p) <= fuzz * fuzz * norm;
  pair v = q - p;
  real cross = (z.x - p.x) * v.y - v.x * (z.y - p.y);
  return cross * cross <= fuzz * fuzz * asy__abs2(v) * norm;
}
// path.cc:815 的 lineintersections（只要 endpoints=false 那一路 —— 交点无穷多时
// 那一路只保证给出**某些**时间，asy 自己的 intersections(path,pair,pair) 走的也是它）。
// 每一段把三次贝塞尔投到"到直线的有向距离"上，得到一个三次多项式，解它的实根。
private void asy__lineix(real[] T, path g, pair p, pair q, real fuzz) {
  int n = length(g);
  if (n == 0) {
    if (asy__online(p, q, point(g, 0), fuzz)) T.push(0.0);
    return;
  }
  bool cycles = cyclic(g);
  real dx = q.x - p.x, dy = q.y - p.y;
  real det = p.y * q.x - p.x * q.y;
  real norm = max(asy__abs2(p), asy__abs2(q));
  for (int i = 0; i < n; ++i) {
    pair z0 = point(g, i);
    pair c0 = postcontrol(g, i);
    pair c1 = precontrol(g, i + 1);
    pair z1 = point(g, i + 1);
    pair t3 = z1 - z0 + 3.0 * (c0 - c1);
    pair t2 = 3.0 * (z0 + c1) - 6.0 * c0;
    pair t1 = 3.0 * (c0 - z0);
    real a = dy * t3.x - dx * t3.y;
    real b = dy * t2.x - dx * t2.y;
    real c = dy * t1.x - dx * t1.y;
    real d = dy * z0.x - dx * z0.y + det;
    real[] r;
    // 四个系数都在数值零那一档时整段都算"在线上"，报 t=0（照抄那边的 else 分支）
    if (max(max(max(a * a, b * b), c * c), d * d)
        > asy__Fuzz4 * max(norm, max(asy__abs2(z0), max(asy__abs2(z1),
                                     max(asy__abs2(c0), asy__abs2(c1))))))
      r = asy__croots(a, b, c, d);
    else r.push(0.0);
    for (int j = 0; j < r.length; ++j) {
      real t = r[j];
      if (t >= -asy__Fuzz2 && t <= 1.0 + asy__Fuzz2) {
        real s = i + t;
        if (cycles && s >= n - asy__Fuzz2) s = 0;
        if (asy__online(p, q, point(g, s), fuzz)) T.push(s);
      }
    }
  }
}
// path.cc:897 的 add：**按点**去重（时间不同但落在同一点的只留一个）
private void asy__addix(real[] S, real s, path p, real fuzz2) {
  pair z = point(p, s);
  for (int i = 0; i < S.length; ++i) if (asy__abs2(point(p, S[i]) - z) <= fuzz2) return;
  S.push(s);
}
// path.cc:906 的 add（两条时间一起进，仍然只按 **p 上那一点** 去重）
private void asy__addix2(real[] S, real[] T, real s, real t, path p, real fuzz2) {
  pair z = point(p, s);
  for (int i = 0; i < S.length; ++i) if (asy__abs2(point(p, S[i]) - z) <= fuzz2) return;
  S.push(s);
  T.push(t);
}

// path.cc:869 的 `intersections(S,T,g,p,q,fuzz)`：**g 与线段 p--q** 的交点，一并给出
// g 上的时间与线段上的参数。走的是 lineintersections（每段一个三次多项式、解实根），
// 所以交点正好落在结点上时给的是**准准的 0 / 整数**，不是细分加 Newton 收出来的 1e-16。
// 这一点就是 bezulate 那个 assert 的命门：`starttime` 差 1.26e-16，
// countIntersections 从 2 变成 3，forward/backward 两路都找不着，assert 就炸了。
private void asy__ixline(real[] S, real[] T, path g, pair p, pair q, real fuzz) {
  real len2 = asy__abs2(q - p);
  real[] S1;
  if (len2 == 0.0) {
    // 线段退化成一点：asy 那边走 intersections(S1,g,p,fuzz)（路径对点）。这一层没有那一份，
    // 用 p--p 这条退化线段代它 —— asy__lineix 的 `p == q` 那一支正是"点在不在段上"。
    asy__lineix(S1, g, p, q, fuzz);
    for (int i = 0; i < S1.length; ++i) { S.push(S1[i]); T.push(0.0); }
    return;
  }
  pair factor = (q - p) / len2;
  asy__lineix(S1, g, p, q, fuzz);
  for (int i = 0; i < S1.length; ++i) {
    real s = S1[i];
    pair d = point(g, s) - p;
    real t = d.x * factor.x + d.y * factor.y;
    if (t >= -asy__Fuzz2 && t <= 1.0 + asy__Fuzz2) { S.push(s); T.push(t); }
  }
}

// 全部交点（按 p 上的时间排好、去重）。asy 那边是 path.cc:958 的 intersections。
//
// 两条路，与那边一样：
//   - **exact 那一支**（path.cc:963/972）：两条里有一条是"一段直线或一个点"时，
//     整条走 asy__ixline —— 解多项式，不细分。
//   - 一般情形：包围盒细分**圈出**每个交点（12 层，段内约 2e-4），再 Newton 收到机器精度。
//
// 去重照 path.cc:897 改成**按点**（从前是按时间差 1e-7）：闭路上 t=0 与 t=length 是同一点、
// 时间差一整圈，按时间比永远不算重复，于是同一个交点报两遍。
real[][] intersections(path p, path q, real fuzz=-1) {
  int np = length(p);
  int nq = length(q);
  real sc = 1;
  for (int i = 0; i <= np; ++i) { real m = length(point(p, i)); if (m > sc) sc = m; }
  for (int j = 0; j <= nq; ++j) { real m = length(point(q, j)); if (m > sc) sc = m; }
  real f = fuzz < 0 ? 1e-9 * sc : fuzz;
  real tol = 1e-12 * sc;
  real fuzz2 = max(asy__fuzzFactor * f * f, asy__Fuzz2);
  real[][] raw;
  // exact：p 是一段直线（或一个点）
  if (np == 0 || (np == 1 && p.nodes[0].straight)) {
    real[] T1;
    real[] S1;
    asy__ixline(T1, S1, q, point(p, 0), point(p, np), f);
    for (int i = 0; i < S1.length; ++i) {
      real[] g;
      g.push(S1[i]);
      g.push(T1[i]);
      raw.push(g);
    }
  } else if (nq == 0 || (nq == 1 && q.nodes[0].straight)) {
    real[] S1;
    real[] T1;
    asy__ixline(S1, T1, p, point(q, 0), point(q, nq), f);
    for (int i = 0; i < S1.length; ++i) {
      real[] g;
      g.push(S1[i]);
      g.push(T1[i]);
      raw.push(g);
    }
  } else for (int i = 0; i < np; ++i) {
    pair[] a = asy__segctl(p, i);
    for (int j = 0; j < nq; ++j) {
      pair[] b = asy__segctl(q, j);
      real[][] cand;
      asy__ixrec(cand, a, 0, 1, b, 0, 1, f, 12, 0);
      real[][] seed;
      for (int k = 0; k < cand.length; ++k) {
        bool near = false;
        for (int m = 0; m < seed.length; ++m) {
          if (abs(seed[m][0] - cand[k][0]) < 1e-3 && abs(seed[m][1] - cand[k][1]) < 1e-3) near = true;
        }
        if (!near) seed.push(cand[k]);
      }
      for (int k = 0; k < seed.length; ++k) {
        real[] r = asy__ixnewton(a, b, seed[k][0], seed[k][1], tol);
        if (r.length == 0) continue;
        real[] g;
        g.push(i + r[0]);
        g.push(j + r[1]);
        raw.push(g);
      }
    }
  }
  real[] S;
  real[] T;
  for (int k = 0; k < raw.length; ++k) asy__addix2(S, T, raw[k][0], raw[k][1], p, fuzz2);
  real[][] out;
  for (int k = 0; k < S.length; ++k) {
    real[] g;
    g.push(S[k]);
    g.push(T[k]);
    int at = out.length;
    for (int m = 0; m < out.length; ++m) if (out[m][0] > S[k]) { at = m; break; }
    out.insert(at, g);
  }
  return out;
}
// runpath.in:235：路径 p 与过 a、b 的那条**无穷长**直线的所有交点时间，升序。
// 量过 8 个探针（三次样条闭路、圆、折线；水平/竖直/斜线/不相交/切过顶点），
// 与内建的 intersections **逐字节一样**，而且这一层跑出来与 asy 跑同一份也逐字节一样。
// plain_paths.asy:318 的 `pair inside(path, pen)` 点名要它 —— three_surface 的
// regularize 一路调下来，`import three;` 就卡在这一格上。
real[] intersections(path p, pair a, pair b, real fuzz=-1) {
  if (fuzz < 0)
    fuzz = asy__BigFuzz * max(max(length(max(p)), length(min(p))),
                              max(length(a), length(b)));
  real fuzz2 = max(asy__fuzzFactor * fuzz * fuzz, asy__Fuzz2);
  real[] S1;
  asy__lineix(S1, p, a, b, fuzz);
  real[] S;
  for (int i = 0; i < S1.length; ++i) asy__addix(S, S1[i], p, fuzz2);
  return sort(S);
}


// (1) `transform * pen`（runtime.in:1107 → pen.h 的 `transformed`）：搬的是笔自己那个
// 变换（`ret.t = p.t.isNull() ? t : t*p.t`）。笔尖（nib）还没有，所以 makepen 造的笔
// 在变换下仍与真 asy 不一样 —— 这条差别写在明处。
// 排在 `transform * frame` 前面：frame 那一支的体里要调它（prelude 内部是顺序解析的）。
pen operator *(transform t, pen p) {
  pen q = pencopy(p);
  q.pentrans = p.hastrans ? t * p.pentrans : t;
  q.hastrans = true;
  return q;
}

// 渐变/网格/裁剪那一格的余料跟着变换搬（drawfill.cc:56-113 的一串 `transformed`，
// 裁剪那一格是 drawclipbegin.h:83）。**每一档搬什么是量出来的，不是猜的**：
//   - 超路径 gs（transpath）与 tensor 的 bnds：整条路径吃 t
//   - axial/radial 的两个中心 za/zb：吃 t；半径按 `length(t*(a+ra)-t*a)` 折算 ——
//     C++ 那边 `a+ra` 是 `pair(double,double=0)` 的隐式转换，即 **只加在 x 上**
//   - gouraud 的 verts、tensor 的 tz：每个点吃 t
//   - lattice 的 /Matrix tt：左乘成 `t*T`
//   - 笔（pena/penb/vpens/mpens）与 stroke/exta/extb 一个字都不动：渐变那几档的
//     `transformed` 传的是 **pentype 原件**，没有 transpen 那一步
shadeinfo asy__shtrans(transform t, shadeinfo h) {
  if (h == null) return null;
  shadeinfo r;
  r.st = h.st;
  for (int i = 0; i < h.gs.length; ++i) r.gs.push(t * h.gs[i]);
  r.stroke = h.stroke;
  r.pena = pencopy(h.pena);
  r.penb = pencopy(h.penb);
  r.za = t * h.za;
  r.zb = t * h.zb;
  r.ra = h.st == 3 ? length(t * (h.za + (h.ra, 0)) - r.za) : h.ra;
  r.rb = h.st == 3 ? length(t * (h.zb + (h.rb, 0)) - r.zb) : h.rb;
  r.exta = h.exta;
  r.extb = h.extb;
  r.vpens = asy__pcopy(h.vpens);
  for (int i = 0; i < h.verts.length; ++i) r.verts.push(t * h.verts[i]);
  r.vedges = copy(h.vedges);
  r.mpens = asy__pcopy2(h.mpens);
  for (int i = 0; i < h.bnds.length; ++i) r.bnds.push(t * h.bnds[i]);
  for (int i = 0; i < h.tz.length; ++i) {
    pair[] row;
    for (int j = 0; j < h.tz[i].length; ++j) row.push(t * h.tz[i][j]);
    r.tz.push(row);
  }
  r.tt = t * h.tt;
  return r;
}

// (1) `transform * frame`（runtime.in:1112）：frame 里每一笔都搬。
frame operator *(transform t, frame f) {
  frame out;
  for (drawop o : f.ops) {
    drawop q;
    q.kind = o.kind;
    q.g = t * o.g;
    // 一组填充的续标记要跟着搬，不然 `shift(w)*p` 那种搬过的帧会退回"一条一笔填"
    q.merge = o.merge;
    // 渐变/裁剪那一格的余料**必须跟着搬**：不搬的话 kind 2/3 的 `o.sh` 是 null，
    // opsbox 里 `o.sh.gs` 就是一发空指针（venn 的 `null reference` 正是这条）。
    q.sh = asy__shtrans(t, o.sh);
    // endclip 那一对省不省 gsave/grestore 是**这一帧自己的形状**决定的，与变换无关
    q.nosave = o.nosave;
    // 位图（kind == 5）：像素**不跟着变**，变的只有那四个角（`g`）—— concat 的矩阵是从
    // 变换后的四个角算出来的（见 asy__emitimg），所以旋转/翻转跟着白捡。
    q.img = o.img;
    // 逐字照发那一段（kind == 6）不跟着变 —— 它是原样的 PostScript，asy 那边也不动它
    q.psraw = o.psraw;
    // 笔只吃**去掉平移**的那一半（drawelement.h:302 `transformed(shiftless(t),pentype)`）——
    // 量过：`min(shift(3,4)*f)` 是路径搬过去再 ±0.25，笔那一格没有跟着平移。
    // 渐变那一档例外：drawfill.cc 的几个 `transformed` 传 pentype 原件，不过一遍 transpen。
    q.p = o.kind == 2 ? pencopy(o.p) : shiftless(t) * o.p;
    out.ops.push(q);
  }
  // 标签照 drawlabel.cc:200-204 的 transformed 搬：T 与 position 整个变换吃下去，
  // align 只吃**去掉平移**的那一半再归一回原长（`length(align)*unit(shiftless(t)*align)`）。
  // 量出来的三个尺寸原样带过去：它们只由正文与笔的字号决定，与变换无关 ——
  // asy 那边是新对象、会再问一趟 latex，问回来是同一组数，这里省掉那一趟。
  for (int i = 0; i < f.labs.length; ++i) {
    labelrec r = f.labs[i];
    labelrec q;
    q.kind = r.kind;
    // 交错的位置跟着搬（变换不动图形那一列的次序，见 labelrec.at）
    q.at = r.at;
    // 裁剪那两格照 drawclipbegin.h:83 的 transformed 搬：只有路径与笔跟着变。
    if (r.kind != 0) {
      for (int j = 0; j < r.gs.length; ++j) q.gs.push(t * r.gs[j]);
      q.stroke = r.stroke;
      q.p = pencopy(r.p);
      out.labs.push(q);
      continue;
    }
    q.s = r.s;
    q.sz = r.sz;
    // `transformed` 递的是 `t*T`（drawlabel.cc:202），但构造函数当场再剥一次平移
    // （drawlabel.h:37）—— 所以真正存下来的是 `shiftless(t*T)`。搬帧时少这一剥，
    // rotate(θ,z) 这类**带轴心**的变换就会把 z 那份平移混进 T：量过 spline 的
    // yaxis 标签，min(d).x 从 -28.9279097135741 变成 -1214.95006198507。
    q.t = shiftless(t * r.t);
    q.position = t * r.position;
    pair a = shiftless(t) * r.align;
    real la = length(r.align);
    q.align = la == 0 || length(a) == 0 ? (0, 0) : (la * a.x / length(a), la * a.y / length(a));
    q.p = pencopy(r.p);
    q.havebounds = r.havebounds;
    q.width = r.width;
    q.height = r.height;
    q.depth = r.depth;
    out.labs.push(q);
  }
  if (f.haslabel) out.haslabel = true;
  return out;
}

// (1) 矩阵那三个乘法（runarray.in:1399/1452/1462）。asy 的 transform3 就是 real[][]，
// 所以 `t*(0,0,0)` 走的是最后那一个 —— 量过它**除以第四行**（齐次坐标）：
//   {{1,0,0,5},{0,2,0,6},{0,0,3,7},{0,0,0,2}} * (1,1,1) 是 (3,4,5)，不是 (6,8,10)。
real[] operator *(real[][] a, real[] b) {
  real[] c;
  for (real[] ai : a) {
    if (ai.length != b.length) abort("real[][]*real[]: 维数不匹配");
    real sum = 0;
    for (int j = 0; j < b.length; ++j) sum += ai[j] * b[j];
    c.push(sum);
  }
  return c;
}
real[][] operator *(real[][] a, real[][] b) {
  real[][] c;
  int m = b.length == 0 ? 0 : b[0].length;
  for (real[] ai : a) {
    if (ai.length != b.length) abort("real[][]*real[][]: 维数不匹配");
    real[] row;
    for (int j = 0; j < m; ++j) {
      real sum = 0;
      for (int k = 0; k < b.length; ++k) sum += ai[k] * b[k][j];
      row.push(sum);
    }
    c.push(row);
  }
  return c;
}
triple operator *(real[][] t, triple v) {
  if (t.length != 4) abort("real[][]*triple: 要 4x4");
  real[] b = {v.x, v.y, v.z, 1};
  real[] r = t * b;
  if (r[3] == 0) abort("real[][]*triple: 第四行算出来是 0");
  return (r[0] / r[3], r[1] / r[3], r[2] / r[3]);
}

// 4x4 齐次变换作用在**整条 path3** 上（three.asy:1951 的 `t*p[i]`）。位置在这儿是
// 因为它要上面那份 `real[][]*triple` —— 名字解析是顺序的。
path3 operator *(real[][] t, path3 p) {
  path3 h;
  h.cyclic = p.cyclic;
  for (int i = 0; i < p.nodes.length; ++i) {
    knot3 k;
    k.pre = t * p.nodes[i].pre;
    k.point = t * p.nodes[i].point;
    k.post = t * p.nodes[i].post;
    k.straight = p.nodes[i].straight;
    h.nodes.push(k);
  }
  return h;
}

// ------------------------------------------------------------ 剩下那一批 C++ 内建
// 签名逐条照 `asy -noV` 量的（`int x = 名字;` 让它把函数类型印在诊断里），
// 体分两档：能写的写准，做不动的是 abort —— 与 frame 那一刀同一个规矩。

// runtime.in:413 colors(pen)：按颜色空间给 0/1/3/4 道。量过 ColorComponents 的四档：
//   默认笔（DEFCOLOR）1 道、nullpen/invisible 0 道、rgb 3 道、cmyk 4 道。
real[] colors(pen p) {
  real[] a;
  if (p.isinvisible || p.patternval != "") return a;
  if (p.iscmyk) {
    a.push(p.cyan); a.push(p.magenta); a.push(p.yellow); a.push(p.black);
    return a;
  }
  if (p.isrgb) {
    a.push(p.red); a.push(p.green); a.push(p.blue);
    return a;
  }
  a.push(p.gray);
  return a;
}

// runtime.in 的 colorspace(pen)：与 colors(pen) 同一套分档，给的是那个空间的名字。
// 量过四档：默认笔与 gray(0.5) 是 "gray"、red 是 "rgb"、cmyk(red) 是 "cmyk"、
// invisible 与 nullpen 是空串（那两格一道都没有）。slide.asy:115 的 texcolor 要它。
string colorspace(pen p) {
  if (p.isinvisible || p.patternval != "") return "";
  if (p.iscmyk) return "cmyk";
  if (p.isrgb) return "rgb";
  return "gray";
}

// runtime.in 的那两条 pattern：`pen pattern(string)` 挂一个图案名上去（图案在 pen.h 里
// 就是一种颜色空间，所以那支笔一道颜色都没有），`string pattern(pen)` 取回来、没设过是
// 空串。量过 `pattern(red+pattern("chk"))` 与 `pattern(pattern("chk")+red)` 都是 chk、
// `pattern(pattern("x")+pattern("y"))` 是 y、`colorless(pattern("chk"))` 那格还留着。
// tiling.asy:6 的 `filldraw(unitcircle,pattern("checker"))` 要它。
pen pattern(string s) {
  pen q;
  q.patternval = s;
  return q;
}

string pattern(pen p) { return p.patternval; }

// runtime.in 的 colorless(pen)：把颜色那几格清回"没设过"（pen.h 的 DEFCOLOR），
// 别的属性（宽度、线帽、虚线…）照旧。量过 `colorless(red+2bp)` 之后 colorspace 是 gray、
// 一道、值 0，宽度还是 2；`colorless(invisible)` 也回到 gray 那一档（不可见那格也清掉）。
// slide.asy:125 要它。
pen colorless(pen p) {
  pen q = pencopy(p);
  q.isrgb = false;
  q.iscmyk = false;
  q.isinvisible = false;
  q.gray = 0;
  q.red = 0;
  q.green = 0;
  q.blue = 0;
  q.cyan = 0;
  q.magenta = 0;
  q.yellow = 0;
  q.black = 0;
  q.setcolor = false;
  return q;
}

// runhistory.in:158/191：没有 readline 的那一路（`#else`）就是回空数组 —— 我们这一层
// 一直是那一路，所以这两条**不是** abort，是照那个分支写准的。
string[] history(string name, int n=1) { return new string[]; }
string[] history(int n=0) { return new string[]; }
// runhistory.in:254 saveline：同一条 `#else` —— 没有 readline 就是**什么都不做**。
void saveline(string name, string value, bool store=true) { }

// runmath.in:191 → mathop.h:260：整除**往下取整**（量过 quotient(-7,2) 是 -4）。
// 我们的 `#` 就是这条语义（asy__quot 那份 helper 已经把"除不尽且异号时减一"补上了），
// 所以这里直接借它，不再抄一遍。
int quotient(int x, int y) { return x # y; }

// runmath.in:243 的 Floor → path.h:31 `(Int) floor(Intcap(t))`：与 floor 的差别只在
// **超出 int 范围时不报错**，先把值夹到两端再取整（Intcap，path.h:21）。stats.asy:78/114/132
// 的分桶用它 —— 那里的下标算出来一定在范围里。
// 夹过头那一档不逐字节跟：asy 那边 `(double)intMax` 舍成 2^63，转回 Int 是 UB，落到
// common.h:106 留给 Undefined 的那一格上，于是**用**那个值时报 "Trying to use uninitialized
// value"（量过 `write(Floor(1e30))` 就是这一句；`floor(1e30)` 报的是 "Integer overflow"）。
// 这一层照 Intcap 的原意回 intMax / intMin。
// Ceil 与 Round 没人用（base 里一处都没有），照旧留在 builtins.tab 的 nope 那一档。
int Floor(real x) {
  if (x >= intMax) return intMax;
  if (x <= intMin) return intMin;
  return floor(x);
}

// runsystem.in:204 → util.cc:265 stripExt(name, "")：suffix 是 "."、n 是 1，
// 所以走的是 `return name.substr(0,p)` 那一支，p 是**最后**一个点。没有点就原样回。
// 量过：`a.b/c` 是 `a`（它不认目录），`abc` 是 `abc`，`x.` 是 `x`。
string stripextension(string s) {
  int n = length(s);
  int i = n - 1;
  while (i >= 0) {
    if (substr(s, i, 1) == ".") return substr(s, 0, i);
    --i;
  }
  return s;
}

// runpicture.in:326（asy 的 `frame` 就是 C++ 的 picture）：src 的元素插到 dest **前面**。
void prepend(frame dest, frame src) {
  drawop[] out;
  for (int i = 0; i < src.ops.length; ++i) out.push(src.ops[i]);
  for (int i = 0; i < dest.ops.length; ++i) out.push(dest.ops[i]);
  dest.ops = out;
  // 标签也要跟过来，而且要跟到**前面**去 —— 量出来的：plain_filldraw.asy:243-248 的
  // `add(dest,src,filltype)` 在 filltype 是 UnFill 时 above 为假，走的是 prepend 不是 add，
  // 所以 buildcycle.asy:22 那个 `label("$f > 0$",…,UnFill)` 是从这条路掉的，不是从 add 那条。
  labelrec[] ol;
  for (int i = 0; i < src.labs.length; ++i) ol.push(src.labs[i]);
  for (int i = 0; i < dest.labs.length; ++i) ol.push(dest.labs[i]);
  dest.labs = ol;
  if (src.haslabel) dest.haslabel = true;
  // 三维那张 op 表：与 add 同一条（界那几格照旧不搬，理由见那边的注释）
  asy__merge3fn(dest, src);
}

string readline(string prompt="", string name="", bool tabcompletion=false) {  abort("readline 还没做（这一层不读 stdin 的交互行）"); return "";
}
// C++ 那边 rename 的形参叫 `from`/`to`，而 `from` 在 asy 的**语法**里是关键字 ——
// 量过真 asy 自己也写不出这个名字（`int from=3;` 与 `rename(from="a",…)` 都是 syntax error），
// 所以这里换成 src/dst：形参名换掉不改变任何写得出来的调用。
int rename(string src, string dst) { abort("rename 还没做（这一层不动文件系统）"); return 0; }
// asy 的 exit() 是**正常**退出（状态 0）；这一层只有 abort 那条越界路径（非零退出），
// 所以这条也是 abort —— 差别写在明处。
void exit() { abort("exit 还没做（这一层没有'正常退出'这条原语）"); }

// runtime.in:381 `rgb(pen)` → pen.h:639 `torgb()`：cmyk 走 cmyktorgb（:620
//   `sat=1-k; r=(1-c)*sat` …），别的（GRAYSCALE 与 DEFCOLOR 两档，量过
//   `colors(rgb(currentpen)).length` 是 3）走 greytorgb（:591 `r=g=b=grey`）。
pen rgb(pen p) {
  pen q = pencopy(p);
  if (q.iscmyk) {
    real sat = 1 - q.black;
    q.red = (1 - q.cyan) * sat;
    q.green = (1 - q.magenta) * sat;
    q.blue = (1 - q.yellow) * sat;
    q.cyan = 0; q.magenta = 0; q.yellow = 0; q.black = 0;
    q.iscmyk = false;
  } else if (!q.isrgb) {
    q.red = q.gray; q.green = q.gray; q.blue = q.gray;
  }
  q.gray = 0;
  q.isrgb = true;
  return q;
}

// runpath.in:281：一族路径的段数之和（量过 `{(0,0)--(1,1)--(2,0), (0,0)--(1,0)}` 是 5）。
// 注意与 `size(path)` 一样，这里数的是**结点数**（我们的 path 上 size 就是那个，见 :479）。
int size(path[] p) {
  int count = 0;
  for (path g : p) count += size(g);
  return count;
}

// runtime.in:663 system(string[])：起一个进程。这一层不起进程。
int system(string[] s) { abort("system 还没做（这一层不起进程）"); return 0; }
// runsystem.in:43 clear(file,line,warn)：调试器那一族的"清一个断点"。
void clear(string file, int line, bool warn=false) {
  abort("clear(string,int) 还没做（调试器那一族）");
}
// 调试器那一族剩下的几条（runsystem.in:132/137/147/155）。签名照抄 —— `code` 那一格
// 现在有类型了（quote{} 造一格空的），所以 plain_debugger.asy 整支降得下来；
// 体都做不动，真调到才报。
void breakpoint(code s=quote{}) { abort("breakpoint 还没做（调试器那一族）"); }
void stop(string file, int line, code s=quote{}) {
  abort("stop(string,int) 还没做（调试器那一族）");
}
void breakpoints() { abort("breakpoints 还没做（调试器那一族）"); }
void clear() { abort("clear() 还没做（调试器那一族）"); }

// 下面这些的签名照量到的抄，体做不动 —— 各自缺的东西写在自己那一行。
// eof / error / eol / close（fileio.h:126-131）。eof 是**流的** eof：peek 撞底才置上，
// 所以"读完最后一行"之后它就是 true（量过：line 模式下读最后一行，eof 当场变 true）。
bool eof(file f) { return f.fd == 2 ? f.eofbit : true; }
bool error(file f) { return f.fd == 2 ? (!f.opened || f.errbit) : false; }
bool eol(file f) { return f.fd == 2 ? (!f.opened || asy__fateol(f)) : false; }
void close(file f) { f.opened = false; f.eofbit = true; }
// `seconds()`（runtime.in 的 `seconds`）：这一层没有时钟。**不带参数那一路回 0**，
// 别 abort —— 唯一用到它的是 plain_strings.asy:249 的 `progress()` 转圈，那边
// `static int lastseconds` 被 `progress(true)` 置成 0，之后 `seconds > lastseconds`
// 永远不成立，于是一个 `\b` 都不发（真 asy 会边算边转圈，往 stdout 吐一串）。
// smoothcontour3 那一族（genustwo/genusthree）就卡在这一句上。
// 给了日期串那一路还是 abort：那是真的要解析时间，答不准就不答。
int seconds(string t="", string format="") {
  if (t != "") abort("seconds(日期串) 还没做（这一层不解析时间）");
  return 0;
}
// `_cputime()`（plain.asy:299 的 `cputime()` 就靠它，而 `import plain;` 那一路会走到）：
// **五格** —— parent user / parent system / child user / child system / 挂钟（plain.asy
// 读的是 a[0]、a[2]、a[3] 与 a[4]）。这一层没有时钟，所以全是 0：回一份长度对的零比
// abort 好 —— 那边只是把它减一减报个耗时。这条差别写在明处：cputime() 出来的都是 0。
real[] _cputime() { return new real[] {0, 0, 0, 0, 0}; }
int delete(string s) { abort("delete(string) 还没做（这一层不动文件系统）"); return 0; }
real dirtime(path p, pair z) { abort("dirtime 还没做（要解三次方程找切向）"); return 0; }
// runtime.in:32 的 windingnumber(array*, pair)：逐条路径的绕数**相加**
int windingnumber(path[] p, pair z) {
  int count = 0;
  for (int i = 0; i < p.length; ++i) count += windingnumber(p[i], z);
  return count;
}
bool inside(path[] g, pair z, pen fillrule=currentpen) {
  int c = windingnumber(g, z);
  if (fillrule.evenodd) return c % 2 != 0;
  return c != 0;
}
// runlabel.in:423 的 `_strokepath`：**让 PostScript 自己算笔的外轮廓**（`strokepath` 那个
// 算符），再靠 `pathforall` 把结果打印出来、拿 gs 跑一趟读回来。真 asy 也是这么绕的 ——
// 笔形（线帽、连接、虚线）那一堆规则不用自己写一遍。
// 机制那一半（写 .ps、跑 gs、把 `M/L/C/c` 解析成 path）与 `_texpath` 共用，而那一份定义在
// 这一行**之后**（这一层的名字解析是顺序的），所以这儿留一格函数变量，后面装进来。
typedef path[] asy__spfn(path, pen);
asy__spfn asy__strokepathfn = null;
path[] _strokepath(path g, pen p=currentpen) {
  if (asy__strokepathfn == null) abort("_strokepath：这一趟没装上（内部错）");
  return asy__strokepathfn(g, p);
}
// ---------------- graph/math 那一批余量（第六十七刀）
// 答得出的照 run*.in 的定义写出来，算法重而 import 时又用不到的体是 abort（签名在，
// graph.asy / math.asy 那几句才降得下来）。
// `log10` **不在这里写**：它已经在 rmath 白名单里（builtins.tab），转手宿主的 log10。
// 曾经这里摆过一份 `log(x)/log(10)` —— 它比宿主的 log10 差 1 ulp，而这 1 ulp 会一路
// 放大成结构差：`log10(1e-4)` 得 -3.9999999999999996 而不是 -4，于是 Log 轴的 userMin
// 差一点、`size(pic,100,100,point(pic,SW),point(pic,NE))` 算出的 xunitsize 就是
// 25.000000000000007 而不是 25，`shiftless(t*T*tinv)`（graph.asy:1206 那句）于是不再是
// **精确**单位 —— asy 那边 `penSave` 比的是六个数（drawelement.h:324），差一点就每条
// 刻度线都套一层 `gsave`/`[ 1 0 0 1 0 0] concat`/`grestore`。
// 量出来的：alignedaxis 参考 0 处笔变换，我们 78 处；改回宿主的 log10 之后 t.xx 精确是 25。
// search 的字符串那一份（二元的实数那份在上面）：同一套二分
int search(string[] a, string key) {
  int lo = -1;
  int hi = a.length;
  while (hi - lo > 1) {
    int mid = (lo + hi) # 2;
    if (a[mid] <= key) lo = mid; else hi = mid;
  }
  return lo;
}
// norm（runarray.in:2137/2148）：各元素绝对值的最大者
real norm(real[] a) {
  real m = 0;
  for (int i = 0; i < a.length; ++i) { real v = fabs(a[i]); if (v > m) m = v; }
  return m;
}
real norm(real[][] a) {
  real m = 0;
  for (int i = 0; i < a.length; ++i) { real v = norm(a[i]); if (v > m) m = v; }
  return m;
}
// find（runarray.in:1190）：第 n 个为真的下标（n 为负从后往前数），没有给 -1
int find(bool[] a, int n=1) {
  if (n > 0) {
    for (int i = 0; i < a.length; ++i) { if (a[i]) { --n; if (n == 0) return i; } }
    return -1;
  }
  if (n < 0) {
    for (int i = a.length - 1; i >= 0; --i) { if (a[i]) { ++n; if (n == 0) return i; } }
  }
  return -1;
}
// all（runarray.in）：math.asy:149 的 `all(b)` 就是这一条。空数组是 true（与 asy 一致）。
// asy 那边**没有** `any`（量过 "no matching variable 'any'"），所以这里也不给。
bool all(bool[] a) {
  for (bool x : a) if (!x) return false;
  return true;
}
// piecewisestraight（runpath.in:162）：每一段都是直线
bool piecewisestraight(path p) {
  int n = length(p);
  for (int i = 0; i < n; ++i) if (!straight(p, i)) return false;
  return true;
}
// runmath.in:333 的 cubicroots：正文就是上面那份 asy__croots（path.cc:154），
// 这里只是把公开名字接上去。math.asy:380 的 `return cubicroots(b,c,d,e);` 要它。
real[] cubicroots(real a, real b, real c, real d) { return asy__croots(a, b, c, d); }

// runmath.in:315/324 的 quadraticroots：正文照抄 path.cc:46（实根那份）与 path.cc:103
// （复根那份）。Fuzz2/Fuzz4/sqrt1pxm1 摆在上面 intersections(path,pair,pair) 那一段里
// （名字按位置解析，那一段要先见到它们）。
// math.asy:397 的 `quadraticroots((1,0),(b,0),(t0,0))` 要的是复根那一份。
// 复数开方（pair.h:190 的 Sqrt）：asy 语言里没有 sqrt(pair)，这是给下面那份用的
private pair asy__csqrt(pair z) {
  real mag = length(z);
  if (mag == 0) return (0, 0);
  if (z.x > 0) {
    real re = sqrt(0.5 * (mag + z.x));
    return (re, 0.5 * z.y / re);
  }
  real im = sqrt(0.5 * (mag - z.x));
  if (z.y < 0) im = -im;
  return (0.5 * z.y / im, im);
}

real[] quadraticroots(real a, real b, real c) {
  real[] roots;
  // 数值无穷远处的根去掉
  if (abs(a) <= asy__Fuzz2 * abs(b) + asy__Fuzz4 * abs(c)) {
    if (abs(b) > asy__Fuzz2 * abs(c)) { roots.push(-c / b); return roots; }
    if (c == 0) { roots.push(0.0); return roots; }
    return roots;
  }
  real factor = 0.5 * b / a;
  real denom = b * factor;
  if (abs(denom) <= asy__Fuzz2 * abs(c)) {
    real x = -c / a;
    if (x >= 0) { real t2 = sqrt(x); roots.push(-t2); roots.push(t2); }
    return roots;
  }
  real x = -2.0 * c / denom;
  if (x > -1.0) {
    real r2 = factor * asy__sqrt1pxm1(x);
    real r1 = -r2 - 2.0 * factor;
    if (r1 <= r2) { roots.push(r1); roots.push(r2); } else { roots.push(r2); roots.push(r1); }
    return roots;
  }
  if (x == -1.0) { roots.push(-factor); }
  return roots;
}

pair[] quadraticroots(explicit pair a, explicit pair b, explicit pair c) {
  pair[] roots;
  if (a == (0, 0)) {
    if (b != (0, 0)) { roots.push(-c / b); return roots; }
    if (c == (0, 0)) { roots.push((0, 0)); }
    return roots;
  }
  pair factor = 0.5 * b / a;
  pair denom = b * factor;
  if (denom == (0, 0)) {
    pair z1 = asy__csqrt(-c / a);
    roots.push(z1);
    roots.push(-z1);
    return roots;
  }
  // 复数上的 sqrt(1+x)-1：与实数那份同一个写法
  pair x = -2.0 * c / denom;
  pair z1 = factor * (x / (asy__csqrt(1 + x) + 1));
  roots.push(z1);
  roots.push(-z1 - 2.0 * factor);
  return roots;
}
// runarray.in:520 的 LUdecompose（Crout 分解，Numerical Recipes 的 ludcmp）：
// a 是 n×n 行优先**平铺**成的一条 real[]，原地改成 LU；index[j] 记第 j 步选到的主元行。
// 回换行次数的符号（±1，determinant 要），奇异时 warn 就报错、否则回 0。
//
// 平铺与下标算法是照抄那份 C++ 的：隐式缩放向量 vv、选主元用 `>=`（并列取后者）、
// 以及"先把 j 列上三角那几格算完、再在同一列上找主元"的次序都跟着 —— 换个次序
// 浮点尾数就不一样，EPS 对不上。
private int asy__LUdecompose(real[] a, int n, int[] index, bool warn=true) {
  real[] vv = new real[n];
  int swap = 1;
  for (int i = 0; i < n; ++i) {
    real big = 0.0;
    for (int j = 0; j < n; ++j) {
      real temp = abs(a[i * n + j]);
      if (temp > big) big = temp;
    }
    if (big == 0.0) {
      if (warn) abort("Singular matrix");
      return 0;
    }
    vv[i] = 1.0 / big;
  }
  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < j; ++i) {
      real sum = a[i * n + j];
      for (int k = 0; k < i; ++k) sum -= a[i * n + k] * a[k * n + j];
      a[i * n + j] = sum;
    }
    real big = 0.0;
    int imax = j;
    for (int i = j; i < n; ++i) {
      real sum = a[i * n + j];
      for (int k = 0; k < j; ++k) sum -= a[i * n + k] * a[k * n + j];
      a[i * n + j] = sum;
      real temp = vv[i] * abs(sum);
      if (temp >= big) { big = temp; imax = i; }
    }
    if (j != imax) {
      for (int k = 0; k < n; ++k) {
        real temp = a[imax * n + k];
        a[imax * n + k] = a[j * n + k];
        a[j * n + k] = temp;
      }
      swap = -swap;
      vv[imax] = vv[j];
    }
    if (index.length > j) index[j] = imax;
    real denom = a[j * n + j];
    if (denom == 0.0) {
      if (warn) abort("Singular matrix");
      return 0;
    }
    for (int i = j + 1; i < n; ++i) a[i * n + j] = a[i * n + j] / denom;
  }
  return swap;
}
// arrayop.h:556 的 copyArray2C：二维摊平成一条，顺手把"必须方/必须矩形"那两句错误
// 也照抄了（量过：`solve({{1,2,3},{2,4,5}}, …)` 印 `matrix must be square`）。
private real[] asy__flat2(real[][] a, bool square=true) {
  int n = a.length;
  int m = (square || n == 0) ? n : a[0].length;
  real[] d = new real[n * m];
  for (int i = 0; i < n; ++i) {
    if (a[i].length != m) {
      if (square) abort("matrix must be square");
      abort("matrix must be rectangular");
    }
    for (int j = 0; j < m; ++j) d[i * m + j] = a[i][j];
  }
  return d;
}
// runarray.in:1267：LU 解 ax=b。解不出来（奇异且 warn=false）回**空数组** ——
// 量过 `solve({{1,2},{2,4}}, {1,2})`：warn 默认 true，那一句是 `Singular matrix`。
real[] solve(real[][] a, real[] b, bool warn=true) {
  int n = a.length;
  if (n == 0) return new real[];
  if (b.length != n) abort("Incommensurate matrices");
  real[] A = asy__flat2(a);
  int[] index = new int[n];
  if (asy__LUdecompose(A, n, index, warn) == 0) return new real[];
  real[] B = new real[n];
  for (int i = 0; i < n; ++i) B[i] = b[i];
  for (int i = 0; i < n; ++i) {
    int ip = index[i];
    real sum = B[ip];
    B[ip] = B[i];
    for (int j = 0; j < i; ++j) sum -= A[i * n + j] * B[j];
    B[i] = sum;
  }
  for (int i = n - 1; i >= 0; --i) {
    real sum = B[i];
    for (int j = i + 1; j < n; ++j) sum -= A[i * n + j] * B[j];
    B[i] = sum / A[i * n + i];
  }
  return B;
}
// runarray.in:1320：同一套分解，右端是 n×m 的一整块（回代按列走，m 步一跨）。
real[][] solve(real[][] a, real[][] b, bool warn=true) {
  int n = a.length;
  if (n == 0) return new real[][];
  if (b.length != n) abort("Incommensurate matrices");
  int m = b[0].length;
  real[] A = asy__flat2(a);
  real[] B = asy__flat2(b, false);
  int[] index = new int[n];
  if (asy__LUdecompose(A, n, index, warn) == 0) return new real[][];
  for (int i = 0; i < n; ++i) {
    int ip = index[i];
    for (int k = 0; k < m; ++k) {
      real sum = B[ip * m + k];
      B[ip * m + k] = B[i * m + k];
      int jk = k;
      for (int j = 0; j < i; ++j) { sum -= A[i * n + j] * B[jk]; jk += m; }
      B[i * m + k] = sum;
    }
  }
  for (int i = n - 1; i >= 0; --i) {
    for (int k = 0; k < m; ++k) {
      real sum = B[i * m + k];
      int jk = (i + 1) * m + k;
      for (int j = i + 1; j < n; ++j) { sum -= A[i * n + j] * B[jk]; jk += m; }
      B[i * m + k] = sum / A[i * n + i];
    }
  }
  real[][] x = new real[n][m];
  for (int i = 0; i < n; ++i) for (int j = 0; j < m; ++j) x[i][j] = B[i * m + j];
  return x;
}
// runarray.in:1524 的循环三对角解法：解 L u = f，L 是
//   [ b0 c0          a0    ]
//   [ a1 b1 c1             ]
//   [    a2 b2 c2          ]
//   [          …           ]
//   [ c_{n-1}   a_{n-1} b_{n-1} ]
// 三条分支照抄那份 C++（零 Dirichlet 边界那一支、n<=2、以及一般的循环情形）——
// 次序与括号都跟着，浮点结果才逐位一样。three.asy:932 的 aim（3D 的 Hobby 求解）
// 与 graph_splinetype.asy 的四份样条点名要它。
real[] tridiagonal(real[] a, real[] b, real[] c, real[] f) {
  int n = a.length;
  real[] u = new real[n];
  if (n == 0) return u;
  // 特例：零 Dirichlet 边界（a[0] 与 c[n-1] 都是 0）
  if (a[0] == 0.0 && c[n - 1] == 0.0) {
    real temp = b[0];
    if (temp == 0.0) abort("tridiagonal: 除以零");
    temp = 1.0 / temp;
    real[] work = new real[n];
    u[0] = f[0] * temp;
    work[0] = -c[0] * temp;
    for (int i = 1; i < n; ++i) {
      real t = b[i] + a[i] * work[i - 1];
      if (t == 0.0) abort("tridiagonal: 除以零");
      t = 1.0 / t;
      u[i] = (f[i] - a[i] * u[i - 1]) * t;
      work[i] = -c[i] * t;
    }
    for (int i = n - 1; i >= 1; --i) u[i - 1] = u[i - 1] + work[i - 1] * u[i];
    return u;
  }
  real binv = b[0];
  if (binv == 0.0) abort("tridiagonal: 除以零");
  binv = 1.0 / binv;
  if (n == 1) { u[0] = f[0] * binv; return u; }
  if (n == 2) {
    real factor = b[0] * b[1] - a[0] * c[1];
    if (factor == 0.0) abort("tridiagonal: 除以零");
    factor = 1.0 / factor;
    real temp = (b[0] * f[1] - c[1] * f[0]) * factor;
    u[0] = (b[1] * f[0] - a[0] * f[1]) * factor;
    u[1] = temp;
    return u;
  }
  real[] gam = new real[n - 2];
  real[] del = new real[n - 2];
  gam[0] = c[0] * binv;
  del[0] = a[0] * binv;
  u[0] = f[0] * binv;
  real beta = c[n - 1];
  real fn = f[n - 1] - beta * u[0];
  real alpha = b[n - 1] - beta * del[0];
  for (int i = 1; i <= n - 3; ++i) {
    real ainv = b[i] - a[i] * gam[i - 1];
    if (ainv == 0.0) abort("tridiagonal: 除以零");
    ainv = 1.0 / ainv;
    beta *= -gam[i - 1];
    gam[i] = c[i] * ainv;
    u[i] = (f[i] - a[i] * u[i - 1]) * ainv;
    fn -= beta * u[i];
    del[i] = -a[i] * del[i - 1] * ainv;
    alpha -= beta * del[i];
  }
  real ainv = b[n - 2] - a[n - 2] * gam[n - 3];
  if (ainv == 0.0) abort("tridiagonal: 除以零");
  ainv = 1.0 / ainv;
  u[n - 2] = (f[n - 2] - a[n - 2] * u[n - 3]) * ainv;
  beta = a[n - 1] - beta * gam[n - 3];
  real dnm1 = (c[n - 2] - a[n - 2] * del[n - 3]) * ainv;
  real temp = alpha - beta * dnm1;
  if (temp == 0.0) abort("tridiagonal: 除以零");
  temp = (fn - beta * u[n - 2]) / temp;
  u[n - 1] = temp;
  u[n - 2] = u[n - 2] - dnm1 * temp;
  for (int i = n - 2; i >= 1; --i) {
    u[i - 1] = u[i - 1] - gam[i - 1] * u[i] - del[i - 1] * temp;
  }
  return u;
}
// runarray.in:1758 的 _findroot：二分**夹着**一步二次插值（那份 C++ 自己说是 Charles
// Staats III 写的 asy 版的移植）。保证回来的 t 在 [a,b] 里、且离一次变号不超过 tolerance。
// fa 与 fb 同号是运行时错（照抄那一句英文）。
//
// 两处细节跟着抄：一是先把函数整体翻成"a 端为负"（sign），后面的比较全按这一版写；
// 二是插值落到区间端点附近（(b-a)*1e-3 以内）时往里推一倍 —— 少了这一步根会贴边，
// 迭代次数与最终尾数都变。
real _findroot(real f(real), real a, real b, real tolerance, real fa, real fb) {
  if (fa == 0.0) return a;
  if (fb == 0.0) return b;
  int sign;
  if (fa < 0.0) {
    if (fb < 0.0) abort("fa and fb must have opposite signs");
    sign = 1;
  } else {
    if (fb > 0.0) abort("fa and fb must have opposite signs");
    fa = -fa;
    fb = -fb;
    sign = -1;
  }
  real t = a;
  real ft = fa;
  real twicetolerance = 2.0 * tolerance;
  while (b - a > tolerance) {
    t = (a + b) * 0.5;
    ft = sign * f(t);
    if (ft == 0.0) return t;
    // 二分这一步本身已经进到 tolerance 里了就不插值了
    if (b - a >= twicetolerance) {
      real factor = 1.0 / (b - a);
      real q_A = 2.0 * (fa - 2.0 * ft + fb) * factor * factor;
      real q_B = (fb - fa) * factor;
      real[] Q = quadraticroots(q_A, q_B, ft);
      real root = 0;
      bool found = Q.length > 0;
      if (found) {
        root = t + Q[0];
        if (root <= a || root >= b) {
          if (Q.length == 1) found = false;
          else {
            root = t + Q[1];
            if (root <= a || root >= b) found = false;
          }
        }
      }
      if (found) {
        if (ft > 0.0) { b = t; fb = ft; } else { a = t; fa = ft; }
        t = root;
        real margin = (b - a) * 1.0e-3;
        if (t - a < margin) t = a + 2.0 * (t - a);
        else if (b - t < margin) t = b - 2.0 * (b - t);
        ft = sign * f(t);
        if (ft == 0.0) return t;
      }
    }
    if (ft > 0.0) { b = t; fb = ft; }
    else if (ft < 0.0) { a = t; fa = ft; }
  }
  return a - (b - a) / (fb - fa) * fa;
}
pair[] fft(pair[] a, int sign=1) {
  abort("fft 还没做（runarray.in:1867 走的是 FFTW）"); return new pair[];
}
// ------------------------------------------------------ 字形的轮廓（runlabel.in:243 _texpath）
//
// 不读字体文件 —— 让 PostScript 自己把轮廓交出来（那份 C++ 也是这么做的）：
//   1. 一份 .tex，每条标签一页；页首用 `\special{ps: …}` 把 `show` 换掉 ——
//      换成 `currentpoint newpath moveto false charpath` 再 `pathforall`，
//      每段 print 出 `M y x` / `L y x` / `C y x y x y x` / `c`。
//      第一次 show 时把当时的 currentpoint 记进 ASYX/ASYY，后面所有坐标都减掉它
//      （所以出来的是**以标签左下角为原点**的相对坐标）。
//   2. latex → dvi → `dvips -R -Pdownload35 -D600` → .ps。
//   3. 拿 gs 跑那份 .ps（`-sOutputFile=/dev/null`，只要它 print 出来的那些字）。
//      **一行就是一页**，也就是一条标签一组轮廓。
//
// 坐标是 600dpi 的设备单位：hscale = 0.12 = 72/600，纵向再取负（vsign = -1，PS 的 y
// 与设备的 y 反向）—— runlabel.in:346 那句 `readpath(psname,keep,0.12,-1.0)` 就是这两个数。
//
// 每一格的两个数是 **y 先 x 后**（runlabel.in:53 readpair 先读 y）—— PS 那边是靠出栈
// 的顺序 print 的，看着反，照抄就对。
//
// 元数与返回类型照 runlabel.in 抄：吃一串字符串与一串笔，回**每串一组**轮廓
// （plain_Label.asy:664 之后 `g[i][0]` / `g[i].delete(0)` 那几句钉着 path[][]）。
private real asy__tpthird = 1.0 / 3.0;

// 一页的那一串 token 变成一组闭合路径。`nodes` 攒一条，遇到 `c` 收一条。
private path[] asy__tpparse(string ln, real hs, real vs) {
  path[] out;
  knot[] nodes;
  pair npre = (0, 0);
  pair npoint = (0, 0);
  pair npost = (0, 0);
  bool active = false;
  int i = 0;
  int n = length(ln);
  while (i < n) {
    string ch = substr(ln, i, 1);
    if (ch == " " || ch == '\t' || ch == '\r') { i = i + 1; continue; }
    // gs 在这一行的末尾还会印一句提示：`>>showpage, press <return> to continue<<`。
    // 里头 "continue" 的那个 **c** 会被当成 closepath，把最后那一组**未闭合**的节点
    // 冲出来，变成一条多余的子路径。asy 那边的扫描是 `buf >> c; if(c == '>') break;`
    // （runlabel.in:146）—— 一见 '>' 就停，未闭合的那一组于是被丢掉（那边的注释写着
    // "Discard noncyclic paths"）。
    // 量出来的：strokepath.asy 我们 525 条子路径 / 16 个 curveto，参考 524 / 12 ——
    // 差的正是尾巴上那 4 个 C（`M … C C C C L …` 后面没有 c）。
    if (ch == ">") break;
    if (ch != "M" && ch != "L" && ch != "C" && ch != "c") { i = i + 1; continue; }
    string op = ch;
    i = i + 1;
    int need = op == "M" ? 2 : (op == "L" ? 2 : (op == "C" ? 6 : 0));
    real[] v;
    bool ok = true;
    for (int q = 0; q < need; ++q) {
      while (i < n) {
        string c2 = substr(ln, i, 1);
        if (c2 == " " || c2 == '\t') { i = i + 1; continue; }
        break;
      }
      int a = i;
      while (i < n) {
        string c2 = substr(ln, i, 1);
        if (c2 == "-" || c2 == "." || c2 == "+" || c2 == "e" || c2 == "E"
            || (c2 >= "0" && c2 <= "9")) { i = i + 1; continue; }
        break;
      }
      if (i == a) { ok = false; break; }
      v.push(asy__ptnum(substr(ln, a, i - a)));
    }
    if (!ok) break;
    if (op == "M") {
      npoint = (hs * v[1], vs * v[0]);
      npre = npoint;
      continue;
    }
    if (op == "L") {
      pair pt = (hs * v[1], vs * v[0]);
      pair d = asy__tpthird * (pt - npoint);
      npost = npoint + d;
      knot k;
      k.pre = npre; k.point = npoint; k.post = npost; k.straight = true;
      nodes.push(k);
      active = true;
      npre = pt - d;
      npoint = pt;
      continue;
    }
    if (op == "C") {
      pair pt = (hs * v[1], vs * v[0]);
      pair pr = (hs * v[3], vs * v[2]);
      npost = (hs * v[5], vs * v[4]);
      knot k;
      k.pre = npre; k.point = npoint; k.post = npost; k.straight = false;
      nodes.push(k);
      active = true;
      npre = pr;
      npoint = pt;
      continue;
    }
    // op == "c"：closepath
    if (active) {
      if (npoint == nodes[0].point) nodes[0].pre = npre;
      else {
        pair d = asy__tpthird * (nodes[0].point - npoint);
        npost = npoint + d;
        nodes[0].pre = nodes[0].point - d;
        knot k;
        k.pre = npre; k.point = npoint; k.post = npost; k.straight = true;
        nodes.push(k);
      }
      path g;
      g.cyclic = true;
      for (int q = 0; q < nodes.length; ++q) g.nodes.push(nodes[q]);
      out.push(g);
      knot[] fresh;
      nodes = fresh;
    }
    active = false;
  }
  return out;
}

path[][] _texpath(string[] s, pen[] p) {
  path[][] out;
  int n = s.length < p.length ? s.length : p.length;
  for (int i = 0; i < n; ++i) { path[] e; out.push(e); }
  if (n == 0) return out;
  string dir = "/tmp/omni-asytex";
  string nl = '\n';
  string u = "";
  for (int i = 0; i < asy__texpre_user.length; ++i) u = u + asy__texpre_user[i] + nl;
  // 这一段就是 runlabel.in:61-66 那几个字符串，一字不改地摆进 \special{ps: …}
  string ASYx = "/ASYx {( ) print ASYX sub 12 string cvs print} bind def";
  string ASYy = "/ASYy {( ) print ASYY sub 12 string cvs print} bind def";
  string forall = "{(M) print ASYy ASYx} {(L) print ASYy ASYx}"
    + " {(C) print ASYy ASYx ASYy ASYx ASYy ASYx} {(c) print} pathforall";
  string ASY1 = "ASY1 {/ASYX currentpoint pop def /ASYY currentpoint exch pop def"
    + " /ASY1 false def} if ";
  // texfile.cc:48 miniprologue：2048pt 的版面（一页放得下任意宽的一行）。
  // 后面那六句是 texfile.h:50 latexfontencoding —— `font(pen)` 回的那串
  // `\usefont{\ASYencoding}{…}` 全靠它，少了这一段 latex 就是一片 undefined control sequence
  // （量过：tp.out 是空的，一条轮廓也出不来，而 latex 在 nonstopmode 下照样退出 0）。
  // 头上那四句（ASYbox/ASYdimen/ASYprefix/ASYbase）也是 miniprologue 的一部分
  // （texfile.h:38 的 beginprologue）——**要照抄**：少了它们这份 .tex 与 asy 那份不是同一份，
  // 而 `\sqrt` 那条横线（TeX 的 rule，走 dvips 的 /V）会落在别的位置上。
  string t = "\documentclass[12pt]{article}" + nl + u
    + "\newbox\ASYbox" + nl
    + "\newdimen\ASYdimen" + nl
    + "\def\ASYprefix{}" + nl
    + "\long\def\ASYbase#1#2{\leavevmode\setbox\ASYbox=\hbox{#1}%\ASYdimen=\ht\ASYbox%" + nl
    + "\setbox\ASYbox=\hbox{#2}\lower\ASYdimen\box\ASYbox}" + nl
    + "\pagestyle{empty}" + nl + "\textheight=2048pt" + nl + "\textwidth=2048pt" + nl
    + "\begin{document}" + nl
    + "\makeatletter%" + nl
    + "\let\ASYencoding\f@encoding%" + nl
    + "\let\ASYfamily\f@family%" + nl
    + "\let\ASYseries\f@series%" + nl
    + "\let\ASYshape\f@shape%" + nl
    + "\makeatother%" + nl;
  for (int i = 0; i < n; ++i) {
    if (i != 0) t = t + "\newpage" + nl;
    // **次序照 texfile.cc 的 setfont：先 `\fontsize…\selectfont`、再字体命令**。
    // 反过来写会让 `$\sqrt{x^2}$` 那条横线换个高度：量出来的（textpath.asy 的第一个
    // 数值差）参考 -65.9638965、我们 -76.6883786，解析回来的那条子路径 miny
    // 参考 -4.50492172、我们 -5.2373368 —— 别的三条子路径逐字相同。
    // 两个数也照那边印六位小数、行尾带 `%`。
    real fs = asy__psize(p[i]) / asy__tex2ps;
    t = t + "\fontsize{" + asy__f6(fs) + "}{"
      + asy__f6(asy__plskip(p[i]) / asy__tex2ps) + "}\selectfont%" + nl;
    t = t + font(p[i]) + "%" + nl;
    t = t + "\special{ps:" + nl + ASYx + nl + ASYy + nl + "/ASY1 true def" + nl
      + "/show {" + ASY1 + "currentpoint newpath moveto false charpath " + forall
      + "} bind def" + nl
      + "/V {" + ASY1 + "Ry neg Rx 4 copy 4 2 roll 2 copy 6 2 roll 2 copy (M) print"
      + " ASYy ASYx (L) print ASYy add ASYx (L) print add ASYy add ASYx (L) print add"
      + " ASYy ASYx (c) print} bind def}" + nl;
    t = t + s[i] + "\ %" + nl;
  }
  t = t + "\end{document}" + nl;
  if (_runproc("mkdir -p " + dir + " && rm -f " + dir + "/tp.*") != 0) return out;
  _writetext(dir + "/tp.tex", t);
  if (_runproc("cd " + dir
      + " && latex -interaction=nonstopmode tp.tex > /dev/null 2>&1") != 0) return out;
  if (_runproc("cd " + dir
      + " && dvips -R -Pdownload35 -D600 -q -o tp.ps tp.dvi > /dev/null 2>&1") != 0) return out;
  // gs 印出来的那些字走 stdout，图本身丢进 /dev/null
  if (_runproc("cd " + dir + " && gs -q -dBATCH -P -sDEVICE=ps2write"
      + " -sOutputFile=/dev/null tp.ps > tp.out 2>/dev/null") != 0) return out;
  string o = _readtext(dir + "/tp.out");
  // 一行一页。空行不占格子（gs 每页之间可能多一个换行）。
  int i = 0;
  int k = 0;
  int len = length(o);
  while (i < len && k < n) {
    int e = find(o, nl, i);
    if (e < 0) e = len;
    string ln = substr(o, i, e - i);
    i = e + 1;
    if (length(ln) == 0) continue;
    out[k] = asy__tpparse(ln, 0.12, -0.12);
    k = k + 1;
  }
  return out;
}
// runlabel.in:423 的 `_strokepath`，机制与 `_texpath` 同一条（写一份 .ps、跑 gs、把打印出来的
// `M/L/C/c` 解析回 path），只是这一份不经 TeX：直接把路径与笔写进 .ps，让 PostScript 的
// `strokepath` 算外轮廓。照那边的次序摆：
//   ASYx / ASYy 两个打印宏 -> `/stroke {ASYinit pathforall} bind def`（把 stroke 换成"打印"）
//   -> setpen -> 路径 -> `strokepath`（真算符，把当前路径换成外轮廓）-> `stroke`（打印它）
//   -> `(M) print currentpoint …`（最后补一格，与那边的 endpath 一致）
// readpath 的默认缩放是 hscale=1、vsign=1（runlabel.in:451 没给参数），所以这儿是 (1, 1)。
private path[] asy__strokepathgs(path g, pen p) {
  path[] out;
  if (g.nodes.length == 0) return out;
  string dir = "/tmp/omni-asytex";
  string nl = '\n';
  string ASYx = "/ASYx {( ) print ASYX sub 12 string cvs print} bind def";
  string ASYy = "/ASYy {( ) print ASYY sub 12 string cvs print} bind def";
  string forall = "{(M) print ASYy ASYx} {(L) print ASYy ASYx}"
    + " {(C) print ASYy ASYx ASYy ASYx ASYy ASYx} {(c) print} pathforall";
  string ASYinit = "/ASYX currentpoint pop def /ASYY currentpoint exch pop def ";
  // 路径与笔那两段要**字符串**，而 emitpath/setpen 是往 asy__out 去的 —— 借 asy__baseeps
  // 那个存旧再改的办法把它们接下来。
  //
  // 笔的状态也要**从头来**：`setpen` 是增量的（只发与 lastpen 不同的那几句，psfile.cc 的
  // 规矩），而主图那边往往刚把同一支笔发过 —— 于是这一份 .ps 里一句 `Setlinewidth` 都没有，
  // gs 拿默认的 1.0 线宽去算外轮廓。量出来的：strokepath.asy 的第一个点我们 186.327、
  // 参考 199.9976，差 13.67 = 14.17-0.5，正是"半个 1cm"换成"半个 1.0"。
  // asy 那边 `_strokepath` 开的是一份**新** psfile（runlabel.in:423），lastpen 是
  // initialpen，所以每一句都发；这一层的 psfile 状态是全局的，所以要自己存取一遍。
  bool save = asy__tobuf;
  string keep = asy__bufs;
  pen keeppen = pencopy(lastpen);
  bool keepvalid = lastvalid;
  asy__tobuf = true;
  asy__bufs = "";
  lastvalid = false;
  setpen(p);
  emitpath(g, 1, true);
  string body = asy__bufs;
  asy__tobuf = save;
  asy__bufs = keep;
  lastpen = keeppen;
  lastvalid = keepvalid;
  string t = "%!PS-Adobe-3.0 EPSF-3.0" + nl
    + "%%BoundingBox: 0 0 612 792" + nl
    // `Setlinewidth` 是主前言里定义的那个过程（psfile.cc 的 prologue，见 asy__shipout），
    // 而 setpen 发的是 `<w> Setlinewidth` —— 这一份 .ps 自己也得有它，不然 gs 撞上
    // undefined 直接不出东西（量到过：外轮廓变成空的，整张图只剩 30 个 token）。
    // asy 那边 `_strokepath` 开的是一份完整的 psfile，前言本来就带着这一句。
    + "/Setlinewidth {0 exch dtransform dup abs 1 lt {pop 0}{round} ifelse" + nl
    + "idtransform setlinewidth pop} bind def" + nl
    + ASYx + nl + ASYy + nl
    + "/stroke {" + ASYinit + forall + "} bind def" + nl
    + body
    + "strokepath" + nl
    + "stroke" + nl
    + "(M) print currentpoint ASYy ASYx" + nl
    + "showpage" + nl + "%%EOF" + nl;
  if (_runproc("mkdir -p " + dir + " && rm -f " + dir + "/sp.*") != 0) return out;
  _writetext(dir + "/sp.ps", t);
  if (_runproc("cd " + dir + " && gs -q -dBATCH -P -sDEVICE=ps2write"
      + " -sOutputFile=/dev/null sp.ps > sp.out 2>/dev/null") != 0) return out;
  string o = _readtext(dir + "/sp.out");
  int i = 0;
  int len = length(o);
  while (i < len) {
    int e = find(o, nl, i);
    if (e < 0) e = len;
    string ln = substr(o, i, e - i);
    i = e + 1;
    if (length(ln) == 0) continue;
    return asy__tpparse(ln, 1, 1);
  }
  return out;
}
asy__strokepathfn = asy__strokepathgs;

// runlabel.in:355-420 那份 `textpath`（`tex=false` 那条路，plain_Label.asy:660 的
// `g=tex ? _texpath(s,p) : textpath(s,p)`）。排版不走 TeX 而是 **groff**
// （settings.cc:1951 的 `textcommand`，选项 `-e -P -b16`），再让 gs 把字形摊成路径。
// 次序照那边：
//   1. 一份 roff：每个标签四段 —— textprologue（".EQ\ndelim $$\n.EN"）、笔的 font 串、
//      正文、textepilogue（".bp"，一页一个标签）
//   2. 一份 .ps，开头是 showpath（runlabel.in:80）：ASYx/ASYy，再把 **stroke 与 fill
//      两个都换成"打印当前路径"** —— `-dNoOutputFonts` 把字形变成真路径，走的是 fill
//   3. `groff … | gs -q -dNoOutputFonts … -sOutputFile=- -` 的输出**追加**到那份 .ps
//   4. 再跑一趟 gs 读它，打印出来的 M/L/C/c 按 hscale=0.1 解析（runlabel.in:420 的
//      `readpath(psname,keep,0.1)`，vsign 默认 1）
// 从前这一格直接转手 `_texpath` —— 于是 `.fam T\n.ps 12` 被当成 LaTeX 字体命令、
// `$ sqrt {x sup 2} $` 被当成 LaTeX 数学式，textpath.asy 的界因此小了一大截
// （我们 336..455，参考 251..540）。
private path[][] asy__textpathgroff(string[] s, pen[] p) {
  path[][] out;
  int n = s.length < p.length ? s.length : p.length;
  for (int i = 0; i < n; ++i) { path[] e; out.push(e); }
  if (n == 0) return out;
  string dir = "/tmp/omni-asytex";
  string nl = '\n';
  string txt = "";
  for (int i = 0; i < n; ++i) {
    txt = txt + ".EQ" + nl + "delim $$" + nl + ".EN" + nl
      + font(p[i]) + nl + s[i] + nl + ".bp" + nl;
  }
  string ASYx = "/ASYx {( ) print ASYX sub 12 string cvs print} bind def";
  string ASYy = "/ASYy {( ) print ASYY sub 12 string cvs print} bind def";
  string forall = "{(M) print ASYy ASYx} {(L) print ASYy ASYx}"
    + " {(C) print ASYy ASYx ASYy ASYx ASYy ASYx} {(c) print} pathforall";
  string ASYinit = "/ASYX currentpoint pop def /ASYY currentpoint exch pop def ";
  // runlabel.in:65 的 ASY1 与 68-72 的 endpath：**第一次**用到时才记原点，
  // 之后每条路径都接着打印；末尾补一格 (M) 与当前点，再把路径清掉。
  string ASY1 = "ASY1 {" + ASYinit + "/ASY1 false def} if ";
  string endp = ASY1 + forall + " (M) print currentpoint ASYy ASYx "
    + "currentpoint newpath moveto} bind def";
  string head = ASYx + nl + ASYy + nl + "/ASY1 true def" + nl
    + "/stroke {strokepath " + endp + nl
    + "/fill {closepath " + endp + nl;
  if (_runproc("mkdir -p " + dir + " && rm -f " + dir + "/tg.*") != 0) return out;
  _writetext(dir + "/tg.roff", txt);
  _writetext(dir + "/tg.head", head);
  if (_runproc("cd " + dir + " && cp tg.head tg.ps"
      + " && groff -e -P -b16 tg.roff 2>/dev/null | gs -q -dNoOutputFonts -dNOPAUSE"
      + " -dBATCH -P -sDEVICE=ps2write -sOutputFile=- - >> tg.ps 2>/dev/null") != 0) return out;
  if (_runproc("cd " + dir + " && gs -q -dBATCH -P -sDEVICE=ps2write"
      + " -sOutputFile=/dev/null tg.ps > tg.out 2>/dev/null") != 0) return out;
  string o = _readtext(dir + "/tg.out");
  int i = 0;
  int k = 0;
  int len = length(o);
  while (i < len && k < n) {
    int e = find(o, nl, i);
    if (e < 0) e = len;
    string ln = substr(o, i, e - i);
    i = e + 1;
    if (length(ln) == 0) continue;
    out[k] = asy__tpparse(ln, 0.1, 0.1);
    k = k + 1;
  }
  return out;
}
// plain_Label.asy 的 `textpath(string[], pen[])` 就是上面那一份（tex=false 那条路）。
path[][] textpath(string[] s, pen[] p) {
  return asy__textpathgroff(s, p);
}
// runpicture.in 的 `_shipout`：**真 plain 那条出口**。plain_shipout.asy:117 走到这儿，
// 手上的 frame 坐标已经是最终的（`pic.fit()` 已经按 size(…) 缩过），所以这里的缩放固定为 1。
// 上面那份 `shipout(picture)` 是这一层自己的短路（不引 plain 时用），两份共用 emitpath /
// setpen / framebox。
//
// prefix / format / wait / view / preamble 这一层都用不上（没有写盘、没有 TeX、没有看图
// 程序）：EPS 正文印到标准输出。`t` 忽略 —— plain 传下来的是 `identity()` 之外只在
// xasy 那一路才不是恒等（量过：`-f eps` 走的是恒等）。
// ------------------------------------------ 带标签的图：latex + dvips 那条路（picture.cc:490）
// 三份中间产物，与 asy 一样（那边加 -k 就能看到）：
//   <前缀>_0.eps  底图（没有标签）。**不摆**、坐标原样 —— dvips 用 -O 去摆，所以它的
//                 llx 是负的（界里已经含了标签占掉的地方）。
//   <前缀>_.tex   固定前言 + \includegraphics{<前缀>_0.eps} + 每个标签一句 \ASYalign
//   <前缀>_.dvi -> <前缀>_.ps   最终那份 EPS 的字节是 dvips 写的
//
// dvips 的偏移不是魔数（picture.cc:520-528 那段 "Magic dvips offsets"）：
//   hoffset = -128.4 + b.left + bboxshift.x
//   voffset = -124.8 + paperHeight - height - b.bottom - bboxshift.y   （height = h + 1）
// 而 bboxshift 正是我们那个居中平移 (ox - bx.l, oy - bx.b)，代进去 b.left / b.bottom
// 两边全消掉，剩下：hoffset = -128.4 + ox、voffset = -124.8 + 792 - (h + 1) - oy。
// 拿 equilateral 对过 asy 自己印在 EPS 里那行 %DVIPSCommandLine（-O35.3677bp,151.056bp）：
// 我们算出 35.367717 / 151.055879。
private string asy__texdir = "/tmp/omni-asytex";

// 底图。与 shipout 那份的差别只有两处：界是 bx 原样（不是居中之后的），没有那对
// gsave/translate（dvips 负责摆）。
private string asy__baseeps(frame f, box bx) {
  // 存旧的那一对再改（不是钉成 false）：外面可能已经在攒了 —— `-o 文件` 那一路就是
  // 整份图先攒起来再落盘，而带标签的图正是经这一趟拿底图的。钉成 false 的时候
  // dvips 出来的那份字节会绕过缓冲直接印到 stdout，文件里落一份空的。
  bool asy__basesave = asy__tobuf;
  string asy__basekeep = asy__bufs;
  asy__tobuf = true;
  asy__bufs = "";
  asy__out("%!PS-Adobe-3.0 EPSF-3.0");
  asy__out("%%BoundingBox: " + string(floor(bx.l)) + " " + string(floor(bx.b)) + " "
        + string(ceil(bx.r)) + " " + string(ceil(bx.t)));
  asy__out("%%HiResBoundingBox: " + ps9(bx.l) + " " + ps9(bx.b) + " "
        + ps9(bx.r) + " " + ps9(bx.t));
  asy__out("%%Creator: Omni asy");
  asy__out("%%Pages: 1");
  asy__out("%%Page: 1 1");
  asy__out("/Setlinewidth {0 exch dtransform dup abs 1 lt {pop 0}{round} ifelse");
  asy__out("idtransform setlinewidth pop} bind def");
  lastvalid = false;
  for (int i = 0; i < f.ops.length; ++i)
    emitop(f.ops[i], 1, f.ops[i].merge,
           i + 1 >= f.ops.length || !f.ops[i + 1].merge);
  asy__out("showpage");
  asy__out("%%EOF");
  string s = asy__bufs;
  asy__tobuf = asy__basesave;
  asy__bufs = asy__basekeep;
  return s;
}

// `<前缀>_.tex`。前言照 texfile.h:63-120 的 texpreamble + dvipsfix 那一段写死 ——
// 它不含任何随例子变的东西（`\ASYprefix` 空、纸张由 dvips 的 -T 定），所以这一份是常量。
private string asy__texpre(string nl) {
  string u = "";
  for (int i = 0; i < asy__texpre_user.length; ++i) u = u + asy__texpre_user[i] + nl;
  return "\documentclass[12pt]{article}" + nl
    + "\let\paperwidthsave\paperwidth\let\paperwidth\undefined" + nl
    + "\usepackage{graphicx}" + nl
    + "\let\paperwidth\paperwidthsave" + nl
    + u
    + "\newbox\ASYbox" + nl
    + "\newdimen\ASYdimen" + nl
    + "\def\ASYprefix{}" + nl
    + "\long\def\ASYbase#1#2{\leavevmode\setbox\ASYbox=\hbox{#1}%\ASYdimen=\ht\ASYbox%" + nl
    + "\setbox\ASYbox=\hbox{#2}\lower\ASYdimen\box\ASYbox}" + nl
    + "\long\def\ASYaligned(#1,#2)(#3,#4)#5#6#7{\leavevmode%" + nl
    + "\setbox\ASYbox=\hbox{#7}%" + nl
    + "\setbox\ASYbox\hbox{\ASYdimen=\ht\ASYbox%" + nl
    + "\advance\ASYdimen by\dp\ASYbox\kern#3\wd\ASYbox\raise#4\ASYdimen\box\ASYbox}%" + nl
    + "\setbox\ASYbox=\hbox{#5\wd\ASYbox 0pt\dp\ASYbox 0pt\ht\ASYbox 0pt\box\ASYbox#6}%" + nl
    + "\hbox to 0pt{\kern#1pt\raise#2pt\box\ASYbox\hss}}%" + nl
    + "\long\def\ASYalignT(#1,#2)(#3,#4)#5#6{%" + nl
    + "\ASYaligned(#1,#2)(#3,#4){%" + nl
    + "\special{ps:gsave currentpoint currentpoint translate [#5 0 0] concat neg exch neg exch translate}%" + nl
    + "}{%" + nl
    + "\special{ps:currentpoint grestore moveto}%" + nl
    + "}{#6}}" + nl
    + "\long\def\ASYalign(#1,#2)(#3,#4)#5{\ASYaligned(#1,#2)(#3,#4){}{}{#5}}" + nl
    + "\def\ASYraw#1{" + nl
    + "currentpoint currentpoint translate matrix currentmatrix" + nl
    + "100 12 div -100 12 div scale" + nl
    + "#1" + nl
    + "setmatrix neg exch neg exch translate}" + nl
    + "\makeatletter" + nl
    + "\def\Ginclude@eps#1{%" + nl
    + " \message{<#1>}%" + nl
    + "  \bgroup" + nl
    + "  \def\@tempa{!}%" + nl
    + "  \dimen@\Gin@req@width" + nl
    + "  \dimen@ii.1bp%" + nl
    + "  \divide\dimen@\dimen@ii" + nl
    + "  \@tempdima\Gin@req@height" + nl
    + "  \divide\@tempdima\dimen@ii" + nl
    + "    \special{PSfile=#1\space" + nl
    + "      llx=\Gin@llx\space" + nl
    + "      lly=\Gin@lly\space" + nl
    + "      urx=\Gin@urx\space" + nl
    + "      ury=\Gin@ury\space" + nl
    + "      \ifx\Gin@scalex\@tempa\else rwi=\number\dimen@\space\fi" + nl
    + "      \ifx\Gin@scaley\@tempa\else rhi=\number\@tempdima\space\fi" + nl
    + "      \ifGin@clip clip\fi}%" + nl
    + "  \egroup}" + nl
    + "\makeatother" + nl;
}

// .tex 里那句 `\special{ps:… }` 的颜色**两条路不同格式**（psfile.cc:184-218）：
// cmyk / rgb 先攒进一个新开的 `ostringstream buf` —— 新流是默认格式，%g 的 6 位有效数字；
// 而 gray 那一支直接往 `*out` 上写，吃的是 texfile 那个流被粘住的 fixed/precision(6)。
// 量出来的：spline 的参考里黑笔是 `0.000000 setgray`，红笔却是 `1 0 0 setrgbcolor`。
private string asy__texcolor(pen p) {
  if (p.iscmyk)
    return string(p.cyan, 6) + " " + string(p.magenta, 6) + " " + string(p.yellow, 6)
      + " " + string(p.black, 6) + " setcmykcolor";
  if (p.isrgb)
    return string(p.red, 6) + " " + string(p.green, 6) + " " + string(p.blue, 6)
      + " setrgbcolor";
  return asy__f6(p.gray) + " setgray";
}

// 裁剪路径写进 .tex 的那一份（drawclipbegin.h:73 的 writeshiftedpath）：形状与 emitpath
// 一样，只有两处不同 —— 数是**定点 6 位**（texfile 那个流的格式），坐标要先按
// bboxshift 平移（量出来的：参考的 `_0.eps` 里是 -0.75，.tex 里是 -0.500000，
// 差的正好是 (-bx.l,-bx.b) = (0.25,0.25)）。
private string asy__texpath(path g, pair sh, bool newPath, string nl) {
  string f2(pair z) { return asy__f6(z.x + sh.x) + " " + asy__f6(z.y + sh.y); }
  int n = g.nodes.length;
  pair z0 = g.nodes[0].point;
  string o = (newPath ? "newpath " : " ") + f2(z0) + " moveto" + nl;
  for (int i = 1; i < n; ++i) {
    pair z = g.nodes[i].point;
    if (g.nodes[i - 1].straight) o = o + " " + f2(z) + " lineto" + nl;
    else o = o + " " + f2(g.nodes[i - 1].post) + " " + f2(g.nodes[i].pre) + " "
      + f2(z) + " curveto" + nl;
  }
  if (g.cyclic) {
    if (g.nodes[n - 1].straight) o = o + " " + f2(z0) + " lineto" + nl;
    else o = o + " " + f2(g.nodes[n - 1].post) + " " + f2(g.nodes[0].pre) + " "
      + f2(z0) + " curveto" + nl;
    o = o + "closepath" + nl;
  } else if (n == 1) {
    o = o + " " + f2(z0) + " lineto" + nl;
  }
  return o;
}

// 一条标签写进 .tex 的那个对齐量（drawlabel.cc:106-117 的 texAlign）。
private pair asy__texalign(labelrec r) {
  pair al = inverse(r.t) * r.align;
  real s0 = abs(al.x) > abs(al.y) ? abs(al.x) : abs(al.y);
  if (s0 != 0) al = (al.x * 0.5 / s0, al.y * 0.5 / s0);
  al = (al.x - 0.5, al.y - 0.5);
  real vert = r.height + r.depth;
  real dep = r.depth;                            // NOBASEALIGN
  if (dep > 0 && vert != 0) al = (al.x, al.y + dep / vert);
  return al;
}

// 走 latex + dvips 出图。成了回 true（字节已经印出去了），没成回 false（外面退回那条
// 不带标签的老路 —— 至少还有图）。
private bool asy__texship(string prefix, frame f, box bx, real ox, real oy, real w, real h) {
  string nl = '\n';
  string dir = asy__texdir;
  // 前缀要用**真名字**：dvips 把 dvi 的文件名写进产物里（`%%Title:` 那一行是注释不算，
  // 但 docinfo 里那个 `(名字_.dvi)` 是正文的一个词），拿 "t" 顶就与参考对不上了 ——
  // 量出来的：equilateral 只差一处，就是 `(equilateral_.dvi)` vs `(t_.dvi)`。
  string pre = prefix == "" ? _mainname() : prefix;
  if (pre == "") pre = "t";
  if (_runproc("mkdir -p " + dir + " && rm -f " + dir + "/" + pre + "_*") != 0) return false;
  // 一张**只有标签**的图不出 eps：texfile.cc:153-180 的 beginlayer 拿的是 picture.cc:1345
  // 那个 `postscript |= (*p)->draw(&out)` —— 画的那几族（drawPath/drawFill/裁剪的头尾）
  // 一律回 true，drawLabel 没有 draw(psfile*)，走的是 drawelement.h:182 那份 false。
  // 于是 ops 一格都没有时 `\includegraphics` 那一段整段换成一个等高的空 vbox，
  // 而且 `_0.eps` 根本不写（量过 `label` 五连的 f1_.tex 是
  // `\leavevmode\vbox to 57.247657pt{}%`，目录里没有 f1_0.eps）。
  bool haseps = f.ops.length > 0;
  if (haseps) _writetext(dir + "/" + pre + "_0.eps", asy__baseeps(f, bx));
  // 标签要先量过才写得出（drawlabel.cc:187 的 checkbounds）。framebox 已经量过了。
  asy__measure(f.labs);
  string t = asy__texpre(nl)
    + "\setlength{\unitlength}{1pt}%" + nl
    + "\pagestyle{empty}" + nl
    + "\textheight=" + asy__f6(h + 18) + "bp" + nl
    + "\textwidth=" + asy__f6(w + 18) + "bp" + nl
    + "\begin{document}" + nl
    + "\makeatletter%" + nl
    + "\let\ASYencoding\f@encoding%" + nl
    + "\let\ASYfamily\f@family%" + nl
    + "\let\ASYseries\f@series%" + nl
    + "\let\ASYshape\f@shape%" + nl
    + "\makeatother%" + nl;
  if (haseps) {
    t = t + "{\catcode`\"=12%" + nl
      + "\includegraphics[bb=" + asy__f6(bx.l) + " " + asy__f6(bx.b) + " "
        + asy__f6(bx.r) + " " + asy__f6(bx.t) + "]{" + pre + "_0.eps}%" + nl
      + "}%" + nl
      + "\kern " + asy__f6(-w / asy__tex2ps) + "pt%" + nl;
  } else {
    t = t + "\leavevmode\vbox to " + asy__f6(h / asy__tex2ps) + "pt{}%" + nl;
  }
  // 走一遍标签那一列。裁剪的头尾按 drawclipbegin.h:66-79 / drawclipend.h:51-56 发：
  // `\begin{picture}` 只在**最外一层**发（texfile.h:268 的 toplevel，嵌套的裁剪只加层数）。
  //
  // `gsave`/`grestore` 省不省照 picture.cc:301-308 那一格：两个 endclip 挨着时，前面那个
  // 与它配对的头都不发。那个标记是 opsbox 走 ops 时打上的（真 asy 是同一个对象两条路共用），
  // 这一层 ops 与 labs 是两列，所以按**序号对齐**搬过来 —— 两列里裁剪的先后完全同一个顺序
  // （clip 往两列都是头进尾出，add/prepend/变换也都保序）。不搬的话 venn3 的
  // intersection123（连着两个 clip）会多出一对 gsave/grestore。
  bool[] nsb;
  bool[] nse;
  for (int i = 0; i < f.ops.length; ++i) {
    if (f.ops[i].kind == 3) nsb.push(f.ops[i].nosave);
    else if (f.ops[i].kind == 4) nse.push(f.ops[i].nosave);
  }
  int ib = 0;
  int ie = 0;
  pair sh = (-bx.l, -bx.b);
  int lvl = 0;
  string lastfont = "<invalid>";
  for (int i = 0; i < f.labs.length; ++i) {
    labelrec r = f.labs[i];
    if (r.kind == 1) {
      bool ns = ib < nsb.length ? nsb[ib] : false;
      ++ib;
      if (!ns) t = t + "\special{ps:gsave}%" + nl;
      if (r.gs.length > 0) {
        if (lvl == 0) {
          t = t + "\begin{picture}( " + asy__f6(w / asy__tex2ps) + ", "
            + asy__f6(h / asy__tex2ps) + ")%" + nl;
        }
        ++lvl;
        t = t + "\special{ps:\ASYraw{" + nl;
        for (int j = 0; j < r.gs.length; ++j) t = t + asy__texpath(r.gs[j], sh, j == 0, nl);
        if (r.stroke) t = t + "strokepath" + nl;
        t = t + (r.p.evenodd ? "eoclip" : "clip") + nl + "}%" + nl + "}%" + nl;
      }
      continue;
    }
    if (r.kind == 2) {
      bool ns = ie < nse.length ? nse[ie] : false;
      ++ie;
      if (lvl > 0) {
        --lvl;
        if (lvl == 0) {
          t = t + "\end{picture}%" + nl
            + "\kern " + asy__f6(-w / asy__tex2ps) + "pt%" + nl;
        }
      }
      if (!ns) t = t + "\special{ps:grestore}%" + nl;
      continue;
    }
    // 空文本的标签**不能在这里扔**：那道 `s == ""` 的门在 plain_Label.asy:314，只挡
    // `Label.label(picture,…)` 这一路；同一个结构体里 292 行的 `label(frame,…)` 没有门。
    // flowchart 的 `circle("")` 走的正是 frame 那一路（block 自己攒帧），于是参考的
    // controlsystem 里两个空标签照样各发一份颜色 special + `\fontsize` + `\ASYalign{}`，
    // 只是排不出字形。这一层把门放在这里，等于把那两格连 lastfont 的推进一起吃掉了。
    real fs = asy__psize(r.p) / asy__tex2ps;
    pair al = asy__texalign(r);
    t = t + "\special{ps:" + asy__texcolor(r.p) + "}%" + nl
      + "\fontsize{" + asy__f6(fs) + "}{"
      + asy__f6(asy__plskip(r.p) / asy__tex2ps) + "}\selectfont%" + nl;
    // 字体那一句是 **变了才发**（texfile.h:216-224 settexfont：`font != lastpen.Font()`）。
    // lastpen 是 `pen(initialpen)`，它的 font 是字面量 `"<invalid>"`（pen.h:419），所以
    // 第一个标签一定发；发完 `lastpen.setfont(p)` 只搬 font 一个字段（texfile.cc:202），
    // 于是同一字体的后续标签一句不发、换字体的当场再发一句。
    // 反过来 `\fontsize`（setlatexfont）与颜色 special **每个标签都发**：initialpen 的
    // fontsize/lineskip 是 -1、colorspace 是 INVISIBLE，永远比不上，量过 lab_.tex 确认
    // 四个标签四份 `\special{ps:0.000000 setgray}` + 四份 `\fontsize`。
    string fnt = font(r.p);
    if (fnt != lastfont) {
      t = t + fnt + "%" + nl;
      lastfont = fnt;
    }
    // 带线性变换的标签走 `\ASYalignT`（texfile.cc:290-302）：多一组 `{xx yx xy yy}`，
    // 而且 **非 pdf 那一路 yx/xy 要取负**（那边的 `sign=-1`，因为 TeX 的 y 轴朝下）。
    // 判定同样是 `!T.isIdentity()` 比六个数 —— 于是 `t*T*inverse(t)` 那种"看着是单位、
    // 末位差一个 ulp"的也走 T 支，印出来正好是 `{1.000000 -0.000000 -0.000000 1.000000}`。
    transform lt = r.t;
    bool ltrans = !(lt.x == 0 && lt.y == 0 && lt.xx == 1 && lt.xy == 0
                    && lt.yx == 0 && lt.yy == 1);
    t = t + "\ASYalign" + (ltrans ? "T" : "")
      + "(" + asy__f6((r.position.x - bx.l) / asy__tex2ps) + ","
      + asy__f6((r.position.y - bx.b) / asy__tex2ps) + ")("
      + asy__f6(al.x) + "," + asy__f6(al.y) + ")";
    if (ltrans)
      t = t + "{" + asy__f6(lt.xx) + " " + asy__f6(-lt.yx)
        + " " + asy__f6(-lt.xy) + " " + asy__f6(lt.yy) + "}";
    t = t + "{" + r.s + "}%" + nl;
  }
  t = t + "\end{document}" + nl;
  _writetext(dir + "/" + pre + "_.tex", t);
  if (_runproc("cd " + dir + " && latex -interaction=nonstopmode " + pre + "_.tex") != 0) {
    return false;
  }
  real ho = -128.4 + ox;
  real vo = -124.8 + 792 - (h + 1) - oy;
  // 这两个数进 dvips 的样子是**6 位有效数字**，不是定点 6 位：picture.cc:540 拼的是
  // `"-O"+String(hoffset)+"bp,…"`，而 `String(double)` 走的是默认精度的 ostringstream
  // （6 位有效数字、去掉末尾的零）。量出来的：alignedaxis 参考那行 %DVIPSCommandLine 是
  // `-O25.3685bp,121.631bp`，我们定点 6 位写成 `-O25.368455bp,121.631230bp` —— 图的字节
  // 一样（dvips 自己按分辨率量化），差的只有它回印在注释里的那一行。
  string cmd = "cd " + dir + " && dvips -R -Pdownload35 -D600"
    + " -O" + string(ho, 6) + "bp," + string(vo, 6) + "bp -T612bp,792bp -q"
    + " -o" + pre + "_.ps " + pre + "_.dvi";
  if (_runproc(cmd) != 0) return false;
  // dvips 出来的是**整页** PostScript（`%!PS-Adobe-2.0`、`%%BoundingBox: 0 0 612 792`）。
  // asy 会再过一遍（picture.cc:552-612）：换掉那行 `%!PS-Adobe-`、把第一处 `%%BoundingBox`
  // 换成自己算的界、扔掉 `%%DocumentPaperSizes:` 与 `%%BeginPaperSize:`..`%%EndPaperSize`
  // 那一段（它另外还把 DVIPSRC 指到 base/nopapersize.ps 去，让 dvips 干脆别发；
  // 这一层不认识 base 在哪，靠这个过滤达到同一个结果）。别的行原样。
  // `TeXDict begin @defspecial` 那一路的 gsave/concat 这里**没做**：那是 bboxshift 要靠
  // 特殊块搬的情形，量过 equilateral 的参考里没有一行是它开头的（那些字样都在前言的
  // 定义里）。哪个例子露出来再补。
  string[] ls = _readlines(dir + "/" + pre + "_.ps");
  bool firstbb = true;
  bool inpaper = false;
  for (int i = 0; i < ls.length; ++i) {
    string s = ls[i];
    if (i == ls.length - 1 && s == "") continue;
    if (inpaper) {
      if (find(s, "%%EndPaperSize", 0) == 0) inpaper = false;
      continue;
    }
    if (find(s, "%%BeginPaperSize:", 0) == 0) { inpaper = true; continue; }
    if (length(s) > 0 && substr(s, 0, 1) == "%") {
      if (find(s, "%%DocumentPaperSizes:", 0) == 0) continue;
      if (find(s, "%!PS-Adobe-", 0) == 0) {
        asy__out("%!PS-Adobe-3.0 EPSF-3.0");
        continue;
      }
      if (firstbb && find(s, "%%BoundingBox:", 0) == 0) {
        asy__out("%%BoundingBox: " + string(floor(ox)) + " " + string(floor(oy)) + " "
              + string(ceil(ox + w)) + " " + string(ceil(oy + h)));
        asy__out("%%HiResBoundingBox: " + ps9(ox) + " " + ps9(oy) + " "
              + ps9(ox + w) + " " + ps9(oy + h));
        firstbb = false;
        continue;
      }
    }
    // **走 asy__out，不是 write**（这一刀）：dvips 那份字节也得听"这一张要去哪儿"那个开关。
    // 从前这一段直接 write 到 stdout，于是 `-o 文件` 时带标签的图落下来是一份**空文件**、
    // 字节全跑去了 stdout；`shipout("名字")` 那一路同理（量出来的：interpolate1 的
    // runge1..7.eps 全是 0 字节，七张图都叠在 stdout 上）。
    asy__out(s);
  }
  return true;
}

// ---------------------------------------- SVG 出口
// 真 asy **没有**原生 SVG：它的 `-f svg` 是先出 EPS/PDF 再交给 dvisvgm 转的。所以这一路
// 没有 oracle 可比，规矩由我们自己定 —— 定的原则是"与 PS 那一路同一份 frame、同一串数"，
// 这样两边的坐标能逐字对照，出了偏差一眼看得出来是谁的。
//
// 坐标系：SVG 的 y 朝下、PS 的 y 朝上。不去改每个点，而是把整张图套进一个
// `translate(-bx.l, bx.t) scale(1,-1)` 的组里 —— 组里的路径坐标与 PS 那一路**一模一样**。
// 文字不能进这个组（会镜像），所以标签单独摆在外面、自己换算一次。
private string asy__xmlesc(string s) {
  string r = "";
  for (int i = 0; i < length(s); ++i) {
    string c = substr(s, i, 1);
    if (c == "&") r = r + "&amp;";
    else if (c == "<") r = r + "&lt;";
    else if (c == ">") r = r + "&gt;";
    else if (c == '"') r = r + "&quot;";
    else r = r + c;
  }
  return r;
}
// 数学模式的 $ 与最外层的 {} 去掉 —— SVG 里排不了 TeX，只能把字面文字放进 <text>。
private string asy__svgtext(string s) {
  string r = "";
  for (int i = 0; i < length(s); ++i) {
    string c = substr(s, i, 1);
    if (c == "$") continue;
    r = r + c;
  }
  return asy__xmlesc(r);
}
private string asy__svghex2(int v) {
  string d = "0123456789abcdef";
  int c = v < 0 ? 0 : (v > 255 ? 255 : v);
  return substr(d, c # 16, 1) + substr(d, c % 16, 1);
}
// cmyk 按 (1-c)(1-k) 折成 rgb（PostScript 的 setcmykcolor 也是这条）
private string asy__svgcolor(pen p) {
  real r; real g; real b;
  if (p.iscmyk) {
    r = (1 - p.cyan) * (1 - p.black);
    g = (1 - p.magenta) * (1 - p.black);
    b = (1 - p.yellow) * (1 - p.black);
  } else if (p.isrgb) { r = p.red; g = p.green; b = p.blue; }
  else { r = p.gray; g = p.gray; b = p.gray; }
  return "#" + asy__svghex2((int) floor(r * 255 + 0.5))
             + asy__svghex2((int) floor(g * 255 + 0.5))
             + asy__svghex2((int) floor(b * 255 + 0.5));
}
private string asy__svgd(path g, real s) {
  int n = g.nodes.length;
  pair z0 = s * g.nodes[0].point;
  string d = "M " + ps(z0.x) + " " + ps(z0.y);
  for (int i = 1; i < n; ++i) {
    pair z = s * g.nodes[i].point;
    if (g.nodes[i - 1].straight) d = d + " L " + ps(z.x) + " " + ps(z.y);
    else {
      pair c1 = s * g.nodes[i - 1].post;
      pair c2 = s * g.nodes[i].pre;
      d = d + " C " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z.x) + " " + ps(z.y);
    }
  }
  if (g.cyclic) {
    if (!g.nodes[n - 1].straight) {
      pair c1 = s * g.nodes[n - 1].post;
      pair c2 = s * g.nodes[0].pre;
      d = d + " C " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z0.x) + " " + ps(z0.y);
    }
    d = d + " Z";
  } else if (n == 1) {
    d = d + " L " + ps(z0.x) + " " + ps(z0.y);
  }
  return d;
}
// cap/join 的编号与 PostScript 一致（0 butt/miter、1 round、2 square/bevel）
private string asy__svgstrokeattrs(pen p) {
  string a = ' stroke="' + asy__svgcolor(p) + '" fill="none"';
  a = a + ' stroke-width="' + ps(p.width == 0 ? 0.5 : p.width) + '"';
  a = a + ' stroke-linecap="' + (p.cap == 1 ? "round" : (p.cap == 2 ? "square" : "butt")) + '"';
  a = a + ' stroke-linejoin="' + (p.join == 1 ? "round" : (p.join == 2 ? "bevel" : "miter")) + '"';
  a = a + ' stroke-miterlimit="' + ps(p.miter == 0 ? 10 : p.miter) + '"';
  if (p.dashpat.length > 0) {
    string ds = "";
    for (int i = 0; i < p.dashpat.length; ++i) {
      if (i > 0) ds = ds + ",";
      ds = ds + ps(p.dashpat[i]);
    }
    a = a + ' stroke-dasharray="' + ds + '"';
    if (p.dashoffset != 0) a = a + ' stroke-dashoffset="' + ps(p.dashoffset) + '"';
  }
  return a;
}
private string asy__svgfillattrs(pen p) {
  return ' fill="' + asy__svgcolor(p) + '" stroke="none"'
    + (p.evenodd ? ' fill-rule="evenodd"' : ' fill-rule="nonzero"');
}
// 一条超路径（path[]）出成**一个** d。分成几个 <path> 是错的：偶奇/非零环绕要看
// 所有子路径一起算（挖洞那一类全靠这个），拆开之后洞就填上了。
private string asy__svgds(path[] gs, real s) {
  string d = "";
  for (int j = 0; j < gs.length; ++j) {
    if (j > 0) d = d + " ";
    d = d + asy__svgd(gs[j], s);
  }
  return d;
}
private int asy__svgclipid = 0;
private int asy__svggradid = 0;

// 渐变：st 2 = axial（PS 的 /ShadingType 2）、st 3 = radial（3）。SVG 这边正好有对应的
// <linearGradient> / <radialGradient>，两端的笔就是两个 stop。
// exta/extb（PS 的 /Extend）对上 SVG 的 spreadMethod="pad" —— SVG 只有"两端一起 pad"，
// 没法只延一头；两头都不延时也只能 pad（差别在渐变盒子外头，形状内一般看不见）。
// radial 的 fr 是 SVG 2 才有的（1.1 没有内圈半径），这儿照发 —— 现在的渲染器都认。
// lattice(1)/gouraud(4)/tensor(7) 这三种 SVG 没有原生对应（要么切网格、要么写 mesh），
// 这一版按那一格自己的笔纯色填，不装作画对了。
private string asy__svggrad(shadeinfo h, real s) {
  if (h.st != 2 && h.st != 3) return "";
  asy__svggradid = asy__svggradid + 1;
  string id = "g" + string(asy__svggradid);
  string stops = '<stop offset="0" stop-color="' + asy__svgcolor(h.pena) + '"/>'
    + '<stop offset="1" stop-color="' + asy__svgcolor(h.penb) + '"/>';
  // 坐标与半径与路径同一个缩放（frame 那一路 s 恒是 1，picture 那一路是 fitscale）
  pair za = s * h.za;
  pair zb = s * h.zb;
  if (h.st == 2)
    asy__out('<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse"'
      + ' x1="' + ps(za.x) + '" y1="' + ps(za.y) + '"'
      + ' x2="' + ps(zb.x) + '" y2="' + ps(zb.y) + '">' + stops + "</linearGradient>");
  else
    asy__out('<radialGradient id="' + id + '" gradientUnits="userSpaceOnUse"'
      + ' cx="' + ps(zb.x) + '" cy="' + ps(zb.y) + '" r="' + ps(s * h.rb) + '"'
      + ' fx="' + ps(za.x) + '" fy="' + ps(za.y) + '" fr="' + ps(s * h.ra) + '">'
      + stops + "</radialGradient>");
  return "url(#" + id + ")";
}

// 一张图出成 SVG。裁剪按 SVG 的办法做：进裁剪开一个 <clipPath> 加一层 <g clip-path>，
// 出裁剪关掉那一层 —— 与 PS 那边 gsave/clip/grestore 的嵌套一一对应。
// axial/radial 走 <linearGradient>/<radialGradient>（见 asy__svggrad），其余网格类纯色填。
//
// 收的是 `drawop[]` 而不是 frame：两个出口都要它 —— `_shipout(frame)`（引了 plain 的
// 那一路）与 `shipout(picture)`（这一层自己的短路）。picture 那一路的坐标要过一道
// fitscale，所以缩放是个参数（frame 那一路恒是 1，与从前一字不差）。
private void asy__svgcore(drawop[] ops, labelrec[] labs, box bx, real w, real h, real s) {
  asy__out('<?xml version="1.0" encoding="UTF-8"?>');
  asy__out('<svg xmlns="http://www.w3.org/2000/svg" version="1.1"'
    + ' width="' + ps(w) + 'pt" height="' + ps(h) + 'pt"'
    + ' viewBox="0 0 ' + ps(w) + " " + ps(h) + '">');
  asy__out('<g transform="translate(' + ps(-bx.l) + " " + ps(bx.t) + ') scale(1 -1)">');
  int depth = 0;               // 开着的 <g clip-path> 层数
  for (int i = 0; i < ops.length; ++i) {
    drawop o = ops[i];
    if (o.kind == 3) {
      if (o.sh.gs.length == 0) { asy__out("<g>"); depth = depth + 1; continue; }
      asy__svgclipid = asy__svgclipid + 1;
      string id = "c" + string(asy__svgclipid);
      asy__out('<clipPath id="' + id + '"'
        + (o.p.evenodd ? ' clip-rule="evenodd"' : ' clip-rule="nonzero"') + ">");
      asy__out('<path d="' + asy__svgds(o.sh.gs, s) + '"/>');
      asy__out("</clipPath>");
      asy__out('<g clip-path="url(#' + id + ')">');
      depth = depth + 1;
      continue;
    }
    if (o.kind == 4) { if (depth > 0) { asy__out("</g>"); depth = depth - 1; } continue; }
    if (o.kind == 2) {
      string paint = asy__svggrad(o.sh, s);
      string at = paint == ""
        ? asy__svgfillattrs(o.p)
        : ' fill="' + paint + '" stroke="none"'
          + (o.p.evenodd ? ' fill-rule="evenodd"' : ' fill-rule="nonzero"');
      if (o.sh.gs.length > 0)
        asy__out('<path d="' + asy__svgds(o.sh.gs, s) + '"' + at + "/>");
      continue;
    }
    pen q = o.p;
    if (o.kind == 0 && q.dashpat.length > 0)
      q = asy__dashadjfn(q, asy__arclenfn(o.g), o.g.cyclic);
    asy__out('<path d="' + asy__svgd(o.g, s) + '"'
      + (o.kind == 0 ? asy__svgstrokeattrs(q) : asy__svgfillattrs(o.p)) + "/>");
  }
  while (depth > 0) { asy__out("</g>"); depth = depth - 1; }
  asy__out("</g>");
  // 标签：文字不进翻转的那一组，自己换算。基线在盒子底往上 depth 那一条。
  // 宽高深是问过 latex 的（与 EPS 那一路同一份数），但字形是 SVG 的字体排的，
  // 所以数学符号会走形 —— 这一条写在这儿，不装作没有。
  for (int i = 0; i < labs.length; ++i) {
    labelrec r = labs[i];
    if (r.kind != 0 || r.s == "") continue;
    pair al = inverse(r.t) * r.align;
    real s0 = abs(al.x) > abs(al.y) ? abs(al.x) : abs(al.y);
    if (s0 != 0) { real qq = 0.5 / s0; al = (al.x * qq, al.y * qq); }
    al = (al.x - 0.5, al.y - 0.5);
    real vert = r.height + r.depth;
    al = (al.x * r.width, al.y * vert);
    al = r.t * al;
    // 位置随图缩放，字号与量出来的宽高深不随（那三个是 latex 给的绝对尺寸）
    pair p = s * r.position + al;
    real sx = p.x - bx.l;
    real sy = bx.t - (p.y + r.depth);
    asy__out('<text x="' + ps(sx) + '" y="' + ps(sy) + '"'
      + ' font-family="serif" font-size="' + ps(asy__psize(r.p)) + '"'
      + ' fill="' + asy__svgcolor(r.p) + '">' + asy__svgtext(r.s) + "</text>");
  }
  asy__out("</svg>");
}
private void asy__svgship(frame f, box bx, real w, real h) {
  asy__svgcore(f.ops, f.labs, bx, w, h, 1);
}
// 装进前面那一格（见 asy__svgcorefn 那一段）：`shipout(picture)` 在文件前面要它。
asy__svgcorefn = asy__svgcore;
// 隐式出图（例子结尾那一趟）走的 format 是空串，兜底那一格在前面（asy__outformat）。

void _shipout(string prefix="", frame f, frame preamble=null, string format="",
              bool wait=false, bool view=true, transform t=identity()) {
  box bx = framebox(f);
  real w = bx.r - bx.l;
  real h = bx.t - bx.b;
  // `shipout("名字")` 那一路自己落盘：`名字.<格式>`（plain_shipout.asy 把 prefix 递到这儿）。
  // **只有名字与主输出不同的时候才分流**：plain 的隐式那一次传的是 defaultfilename
  // （也就是主输出那个名字），它照旧走 `-o`/stdout 那条路 —— 不然这一轴每个例子的
  // stdout 都会空掉。格式为空时兜成 eps（隐式那一趟的 asy__outformat() 回的是空串）。
  string asy__fmt = format == "" ? asy__outformat() : format;
  string asy__ext = asy__fmt == "" ? "eps" : asy__fmt;
  bool asy__own = prefix != "" && prefix != _mainname() && prefix != asy__outname();
  string asy__on = asy__shipbegin(asy__own ? prefix + "." + asy__ext : "");
  // SVG 那一路：framebox 已经把标签量过了，尺寸与 EPS 那一路是同一份数。
  // 不套纸（612x792）—— SVG 的画布就是图本身，没有"摆在信纸中间"这回事。
  if (asy__fmt == "svg") {
    asy__svgship(f, bx, w, h);
    asy__shipend(asy__on);
    return;
  }
  real ox = 0.5 * asy__excess(612, w);
  real oy = 0.5 * asy__excess(792, h);
  // 只有**真有一条标签**才走 latex 那条路。裁剪在 labs 里也占格子（kind 1/2 的影子），
  // 光有裁剪没有标签时那一列不空，但 tex 那一趟没有任何字可排 —— 那种照旧走 psfile。
  bool anylab = false;
  for (int i = 0; i < f.labs.length; ++i) if (f.labs[i].kind == 0 && f.labs[i].s != "") {
    anylab = true;
    break;
  }
  if (anylab && asy__texship(prefix, f, bx, ox, oy, w, h)) {
    asy__shipend(asy__on);
    return;
  }
  asy__out("%!PS-Adobe-3.0 EPSF-3.0");
  asy__out("%%BoundingBox: " + string(floor(ox)) + " " + string(floor(oy)) + " "
        + string(ceil(ox + w)) + " " + string(ceil(oy + h)));
  asy__out("%%HiResBoundingBox: " + ps9(ox) + " " + ps9(oy) + " "
        + ps9(ox + w) + " " + ps9(oy + h));
  asy__out("%%Creator: Omni asy");
  asy__out("%%Pages: 1");
  asy__out("%%Page: 1 1");
  asy__out("/Setlinewidth {0 exch dtransform dup abs 1 lt {pop 0}{round} ifelse");
  asy__out("idtransform setlinewidth pop} bind def");
  asy__out("gsave");
  asy__out(" " + ps(ox - bx.l) + " " + ps(oy - bx.b) + " translate");
  lastvalid = false;
  // 前言那一帧（plain_shipout.asy:126 把 `currentpatterns` 递到这儿）：**在 translate 之后、
  // 正文之前**发。参考里 tiling 那段 `<< … >> matrix makepattern /checker exch def` 就在
  // 这个位置。界不算它 —— framebox 只量 f（真 asy 也一样：图案的定义不占地方）。
  if (preamble != null) {
    for (int i = 0; i < preamble.ops.length; ++i)
      emitop(preamble.ops[i], 1, preamble.ops[i].merge,
             i + 1 >= preamble.ops.length || !preamble.ops[i + 1].merge);
    lastvalid = false;
  }
  for (int i = 0; i < f.ops.length; ++i)
    emitop(f.ops[i], 1, f.ops[i].merge,
           i + 1 >= f.ops.length || !f.ops[i + 1].merge);
  asy__out("grestore");
  asy__out("showpage");
  asy__out("%%EOF");
  asy__shipend(asy__on);
}
// 三维那两条出口（runpicture.in:486/512）。真 asy 一条走 PRC/v3d 的写盘与 GPU 渲染，
// 一条是 `f->shipout3(prefix,format)` 的短形。这一层两条都没有，所以体是 abort ——
// 签名在，three.asy:2624/2911 那三句才降得下来（`picture *f` 在 asy 那边就是 frame，
// realarray2 就是 real[][]：transform3 是 three.asy 里的 typedef，这一层看不见它）。
string defaultformat3="prc";                     // runpicture.in:121
// 这一趟量的是"甲"那条出路（见 ADR「位图那 83 个的施工图」第五节）：`shipout3` 只当
// 记录器 —— 把 3D 那一帧的内容盒子（three.asy:2906 的 `S.width-defaultrender.margin`）
// 记下来，看 three.asy:2920 那句 `return F` 之后隐式 shipout 还剩不剩东西可印。
// 位图那一档的像素：投影 + 发一份临时 EPS + gs 光栅化 + 十六进制读回。
// 真身要 `drawop3` 才写得出来，而它在三维那一节才有名字 —— 先摆一个桩
// （与 asy__merge3fn 同一招），回空串就表示"没渲出来"，调用方用背景色兜底。
string asy__r3hexfn(frame f, int oW, int oH, int fw, int fh, real angle, real zoom,
                    triple m, triple M, pair shift, real expand,
                    real[][] tv) { return ""; }

real asy__r3w = 0;
real asy__r3h = 0;
bool asy__r3on = false;
// 位图那一档在查投影的缩放（施工图第八节末尾那几条）：shipout3 收到什么就记什么，
// 好让一份小脚本在 shipout() 之后把它们印出来对账。
real asy__r3ang = 0;
real asy__r3zoom = 0;
triple asy__r3m = (0, 0, 0);
triple asy__r3M = (0, 0, 0);
real[][] asy__r3t;
real[][] asy__r3tup;
// 光：`Light.position` 与 `Light.diffuse`（three.asy:2913）。位置在 plain_prethree.asy:187
// 已经过 `unit()`，而且**不再乘视图变换** —— glrender.cc:931-937 是原样发给 shader 的
// uniform，帧坐标也已经在视图空间，两边同一套坐标。diffuse 每格是 rgba 四个数。
triple[] asy__r3lights;
real[][] asy__r3ldiff;
// 画布底色（`Light.background()`，没给时是白）。透明那一档要拿它当 dst。
real[] asy__r3bg = new real[] {1, 1, 1};
// 真 billboard 那一趟里，op 表头一格的首点（查 m/M 与 op 是不是同一套坐标）
triple asy__r3op0 = (0, 0, 0);
int asy__r3nops = 0;
// 三维那条路的出口（EPS 那一支）。几何全部照 glrender.cc:531-543 与
// renderBase.cc:932 那两段（施工图第二节，四项与参考逐字节对上）：
//   oW/oH   = ceil(收到的 w/h)            —— initDisplay 的形参是 int
//   expand  = render<0 ? -2*render : render，再乘 antialias（默认 2）-> 默认 4
//   full    = ceil(expand*oW) x ceil(expand*oH)
//   位图铺在 (0,0)-(oW,oH) 上，于是 concat 就是 [ oW 0 0 oH 0 0]
// **像素这一刀还是背景色**（施工图第四节：下一步交给 gs 光栅化矢量那一份）——
// 先把外壳与判据打通，让 83 个从"位图块数 1 vs 0"变成"多少个字节不同"。
void shipout3(string prefix, frame f, string format="",
              real width, real height, real angle, real zoom,
              triple m, triple M, pair shift, pair margin, real[][] t,
              real[][] tup, real[] background, triple[] lights, real[][] diffuse,
              bool view=true) {
  asy__r3w = width;
  asy__r3h = height;
  asy__r3on = true;
  asy__r3ang = angle;
  asy__r3zoom = zoom;
  asy__r3m = m;
  asy__r3M = M;
  asy__r3t = t;
  asy__r3tup = tup;
  asy__r3lights = lights;
  asy__r3ldiff = diffuse;
  // oW/oH = ceil(w)。判据是这么定下来的：收到的 w 是 `S.width - defaultrender.margin`，
  // 也就是"整数尺寸减 0.02"，所以 ceil 正好还原那个整数（billboard 92.98 -> 93、
  // sacylinder3D 的参考 61.98 -> 62）。四舍五入在 92.98 上也对，但那是巧合。
  // **sacylinder3D / cylinder / shellsqrtx01 那三个我们还是大 1**，根子还没量清：
  // 我们收到的 w 是 **62.979999999999997**（印出来的），参考那边反推是 61.98 ——
  // 也就是 `S.width` 我们 63、asy 62。两边跑的是同一份 three.asy，而那一句是
  // `S.width=ceil(lambda.x+2*S.viewportmargin.x)`（three.asy:2836）：所以差的不是模型，
  // 是投影出来的 `lambda.x` 在整数附近差最后几位、被 `ceil` 放大成 1 —— 与前面
  // `t*inverse(t)` 那一族同一个性质。**别去改球柱盘管的界**（drawSphere/drawCylinder
  // 继承 drawPRC，只有 settings.prc 那条路才走它们；prc=false 时圆柱是当 Bezier 面片画的）。
  // 下一刀要量的是 lambda.x 本身。
  // **oW/oH 是 C++ 的 int 转换（截断），不是 ceil。** glrender.cc:1222 那一句
  // `initDisplay(args.width,args.height)` 的形参是 `int`、实参是 `double`（同一份
  // args 在 norender.cc:22 是 `(int)ceil(args.width)`，那儿是另一格）——
  // C++ 的隐式转换向零截断。收到的 w 是 `S.width - defaultrender.margin`
  // （整数减 0.02），所以截断回的是**整数减一**……不对：S.width 里已经含了
  // `2*viewportmargin`（three.asy:2734 的 `ceil(lambda+2*margin)`），
  // 两笔账合起来才对得上。两侧量出来的（透视两行尺子 p1，`size(100,0)`）：
  // S.width=101 -> w=100.98 -> 截断 100，参考的画布正是 400px/4=100pt；
  // 从前 `ceil` 给 101，画布就大 1pt。
  int oW = (int) width;
  int oH = (int) height;
  if (oW <= 0) oW = 1;
  if (oH <= 0) oH = 1;
  // expand = (render<0 ? -2*render : render) * antialias。**这一层读不到 settings**
  // （它是另一个模块，plain 才 import 它），而我们的默认是 render=-1、asy 的 antialias
  // 默认是 2，所以这里是 -2*(-1)*2 = 4。例子自己把 render 设成别的值时这一格会不对 ——
  // 等这一层能读到 settings（或者 three.asy 把它一起传过来）再补。
  real expand = 4;
  int fw = (int) ceil(expand * oW);
  int fh = (int) ceil(expand * oH);
  // 背景：Light.background() 回的是 RGB 三个数（没给时是白）
  int br = 255; int bg = 255; int bb = 255;
  if (background.length >= 3) {
    br = (int) (255 * background[0] + 0.5);
    bg = (int) (255 * background[1] + 0.5);
    bb = (int) (255 * background[2] + 0.5);
    asy__r3bg = new real[] {background[0], background[1], background[2]};
  } else asy__r3bg = new real[] {1, 1, 1};
  // 一整张白（或背景色）的十六进制，按倍增拼 —— 44 万个字节的十六进制是 89 万个字符，
  // 一格一格拼是二次的，倍增是 20 次拷贝。gs 那条路走通时这一份只当兜底。
  string px = asy__hex2(br) + asy__hex2(bg) + asy__hex2(bb);
  string hex = px;
  int need = fw * fh;
  int have = 1;
  while (have * 2 <= need) { hex = hex + hex; have = have * 2; }
  while (have < need) { hex = hex + px; have = have + 1; }
  // 像素：投影 + gs 那一段在三维那一节（`drawop3` 要在那儿才有名字），走下面这个桩。
  string got = asy__r3hexfn(f, oW, oH, fw, fh, angle, zoom, m, M, shift, expand, t);
  if (length(got) == fw * fh * 3 * 2) hex = got;
  drawop o;
  o.kind = 7;
  o.rw = fw;
  o.rh = fh;
  o.rawhex = hex;
  o.p = currentpen;
  o.g = (0, 0) -- (oW, 0) -- (oW, oH) -- (0, oH) -- cycle;
  // 照 glrender.cc:531 那一段：**另起一张空 picture**，只放这一格位图，再 shipout。
  // `add(picture,frame)` 在 plain 那一层，这一层直接往 ops 里塞。
  picture P;
  P.ops.push(o);
  shipout(P);
}
void shipout3(string prefix, frame f, string format=defaultformat3) {
  abort("shipout3 还没做（PRC/v3d 那一路不在这一层）");
}
// _eval 两条（builtin.cc）：一条吃源码串，一条吃 `quote{}` 攒的 code。真去再编一遍源码
// 这一层没有，所以非空的那一支仍然是 abort —— 签名在，plain 的 eval 那两支才降得下来。
//
// **空程序那一支要放行**：plain.asy:238 的 `usersetting()` 就是 `eval(settings.user,true)`，
// 而 `settings.user` 是命令行 `-u` 那一格，默认是空串 —— 于是那句只是 `_eval(";", true)`。
// asy 那边编一段空源码什么都不做；我们从前一律 abort，于是**只要例子调了 usersetting()
// 就整张图都出不来**。量出来的：tvgen.asy:1048 就这一句，它是这一轴上唯一"没出图"的那个。
// 判据是去掉空白与分号之后还剩不剩东西。
private bool asy__evalempty(string s) {
  for (int i = 0; i < length(s); ++i) {
    string c = substr(s, i, 1);
    if (c == " " || c == '\t' || c == '\n' || c == '\r' || c == ";") continue;
    return false;
  }
  return true;
}
void _eval(string s, bool embedded, bool interactiveWrite=false) {
  if (asy__evalempty(s)) return;
  abort("_eval 还没做（要把一段源码在当前环境里再编一遍）");
}
void _eval(code s, bool embedded, bool interactiveWrite=false) {
  abort("_eval(code) 还没做（quote{} 里那段块这一层没留下来）");
}
// runarray.in:2003/2051：Schur 分解，S[0] 是 U、S[1] 是 T。要 Eigen，这一层没有。
real[][][] _schur(real[][] a) { abort("_schur 还没做（真 asy 用的是 Eigen）"); return new real[][][]; }
pair[][][] _schur(pair[][] a) { abort("_schur 还没做（真 asy 用的是 Eigen）"); return new pair[][][]; }

// ---------------------------------------------------------------- 字符串 -> 数
// asy 那边是 castop.h:48 的 castString<T>，走 lexical.h:14 的 lexical::cast：
// `istringstream >> value`，之后要 `(is >> ws).eof()` —— 前后的空白可以有，别的字符一个
// 都不许剩。转不动时它 push 的是 Default，那一格**用起来**才报 "Trying to use
// uninitialized value" 并退 1。这一层没有 Default 这一格，所以是当场 abort：差别是
// "转坏了但没用到"在 asy 那边不响，在这里响。
// 量出来的（asy -noV，逐条）：
//   (real)"  3.5  "=3.5  (real)"+3.5"=3.5  (real)".5"=0.5  (real)"5."=5
//   (int)"007"=7  (int)"+7"=7  (real)"1e10"=10000000000
//   转不动：(int)"42abc" (int)"1.5" (real)"abc" (real)"1e400" (real)"inf" (real)"nan"
//   (real)"0x10"=16 —— C++11 的 `>> double` 收十六进制浮点。这一刀**不收**（下面写了）。
private bool asy__isws(string c) {
  return c == " " || c == "\t" || c == "\n" || c == "\r";
}
private int asy__dig(string s, int i) {
  if (i < 0 || i >= length(s)) return -1;
  return find("0123456789", substr(s, i, 1));
}
private int asy__skipws(string s, int i) {
  while (i < length(s) && asy__isws(substr(s, i, 1))) ++i;
  return i;
}
// 10^k，k 在 0..22。这一段里 10^k 在 double 里是**精确**的（10^22 = 2^22·5^22，
// 5^22 < 2^53），所以"精确的尾数 × 一次精确的 10^k"就是一次 IEEE 运算 —— 与 strtod 的
// 正确舍入是同一个答案。出了这一段（尾数超 2^53 或 |指数| > 22）要正确舍入就得做长除法，
// 那一格这一刀不做：abort，把边界说在明处。
private real asy__pow10(int k) {
  real p = 1;
  for (int i = 0; i < k; ++i) p = p * 10;
  return p;
}
// `(real) s`。按上面那条文法扫一遍：[空白] [+-] (数字[.数字] | .数字) [eE[+-]数字] [空白]。
real operator ecast(string s) {
  int n = length(s);
  int i = asy__skipws(s, 0);
  bool neg = false;
  if (i < n && (substr(s, i, 1) == "+" || substr(s, i, 1) == "-")) {
    neg = substr(s, i, 1) == "-";
    ++i;
  }
  real mant = 0;
  int frac = 0;
  bool any = false;
  bool big = false;
  while (asy__dig(s, i) >= 0) {
    if (mant > 900719925474099) big = true;
    mant = mant * 10 + asy__dig(s, i);
    any = true;
    ++i;
  }
  if (i < n && substr(s, i, 1) == ".") {
    ++i;
    while (asy__dig(s, i) >= 0) {
      if (mant > 900719925474099) big = true;
      mant = mant * 10 + asy__dig(s, i);
      ++frac;
      any = true;
      ++i;
    }
  }
  // 认不出的串**不在这里报错**（量过真 asy）：`real r=(real) "3.14git";` 那一句是通的，
  // 拿到的是一格 Default（未初始化），**读它**才报 "Trying to use uninitialized value"。
  // plain.asy:42 的 `real RELEASE=(real) split(VERSION,"-")[0];` 正好只存不读，所以在
  // 这里 abort 就把 `import plain;` 整条路掐断了。这一层没有"未初始化"这个状态，所以
  // 回 0 —— 差别写在明处：asy 是"用起来才报错"，我们是"用起来是 0"。
  if (!any) return 0;
  int ex = 0;
  if (i < n && (substr(s, i, 1) == "e" || substr(s, i, 1) == "E")) {
    ++i;
    bool eneg = false;
    if (i < n && (substr(s, i, 1) == "+" || substr(s, i, 1) == "-")) {
      eneg = substr(s, i, 1) == "-";
      ++i;
    }
    if (asy__dig(s, i) < 0) abort("把 '" + s + "' 当 real：指数那一段没有数字");
    while (asy__dig(s, i) >= 0) { ex = ex * 10 + asy__dig(s, i); ++i; }
    if (eneg) ex = -ex;
  }
  i = asy__skipws(s, i);
  // 尾巴上还剩东西：与上面那条 `!any` 同一条 —— asy 那一格是 Default，这里回 0。
  // `(real) "3.14git"`（plain.asy:42 那一句）走的正是这一支。
  if (i != n) return 0;
  int net = ex - frac;
  if (big) abort("把 '" + s + "' 当 real：有效数字超过 2^53 —— 要正确舍入得做长除法，这一刀还没做");
  if (net > 22 || net < -22) abort("把 '" + s + "' 当 real：10^" + (string) net
                                   + " 在 double 里不精确 —— 要正确舍入得做长除法，这一刀还没做");
  real v = net >= 0 ? mant * asy__pow10(net) : mant / asy__pow10(-net);
  return neg ? -v : v;
}
// `(int) s`。C++ 的 `>> Int` 只收十进制整数：[空白] [+-] 数字 [空白]。小数点、指数、
// 十六进制都不收（量过 (int)"1.5" 转不动）。溢出那一格 asy 也是转不动，这里 abort。
int operator ecast(string s) {
  int n = length(s);
  int i = asy__skipws(s, 0);
  bool neg = false;
  if (i < n && (substr(s, i, 1) == "+" || substr(s, i, 1) == "-")) {
    neg = substr(s, i, 1) == "-";
    ++i;
  }
  int v = 0;
  int digits = 0;
  while (asy__dig(s, i) >= 0) {
    v = v * 10 + asy__dig(s, i);
    ++digits;
    ++i;
  }
  if (digits == 0) abort("把 '" + s + "' 当 int：这里没有数字（asy 那边这一格是 Default，用起来才报错）");
  if (digits > 18) abort("把 '" + s + "' 当 int：位数超过 18 —— 溢出那一格这一刀不做");
  i = asy__skipws(s, i);
  if (i != n) abort("把 '" + s + "' 当 int：'" + substr(s, i, n - i)
                    + "' 这一段剩下了（asy 要整串都是一个整数）");
  return neg ? -v : v;
}
// `(pair) s` / `(triple) s`：asy 那边是 pair.h:208 / triple.h:310 的 `operator >>`，
// 括号可选、分量之间是逗号**或**空白，最后还要 lexical::cast 那条"整串都吃掉"。
// 量出来的（逐条）：(pair)"1"=(1,0) (pair)"1,2"=(1,2) (pair)"1 "=(1,0) (pair)"(1 2)"=(1,2)
//   (pair)"( 1 , 2 )"=(1,2)；转不动：(pair)"1 2" (pair)"(1)" (pair)"(1,2" (pair)"1,"
//   (triple)"1,2,3"=(1,2,3) (triple)"(1 2 3)"=(1,2,3) (triple)"(1,2 3)"=(1,2,3)；
//   转不动：(triple)"1"（无括号时它 peek 到 eof 就置了 failbit）(triple)"(1,2)"
// **这一刀的边界**：逗号与空白**混着**用的那种（"(1,2 3)"）不收 —— 一次只按一种切。
private string[] asy__parts(string s, bool paren) {
  string[] a = split(s, ",");
  if (a.length > 1 || !paren) return a;
  return split(s, "");
}
private string asy__trim(string s) {
  int b = asy__skipws(s, 0);
  int e = length(s);
  while (e > b && asy__isws(substr(s, e - 1, 1))) --e;
  return substr(s, b, e - b);
}
pair operator ecast(string s) {
  string t = asy__trim(s);
  bool paren = length(t) > 0 && substr(t, 0, 1) == "(";
  if (paren) {
    if (substr(t, length(t) - 1, 1) != ")") abort("把 '" + s + "' 当 pair：左括号没有配对的右括号");
    t = substr(t, 1, length(t) - 2);
  }
  string[] a = asy__parts(t, paren);
  if (a.length == 2) return ((real) a[0], (real) a[1]);
  if (a.length == 1 && !paren) return ((real) a[0], 0);
  abort("把 '" + s + "' 当 pair：切出来 " + (string) a.length + " 个分量，要 2 个"
        + "（无括号时也可以只写 x，那时 y=0）");
  return (0, 0);
}
triple operator ecast(string s) {
  string t = asy__trim(s);
  bool paren = length(t) > 0 && substr(t, 0, 1) == "(";
  if (paren) {
    if (substr(t, length(t) - 1, 1) != ")") abort("把 '" + s + "' 当 triple：左括号没有配对的右括号");
    t = substr(t, 1, length(t) - 2);
  }
  string[] a = asy__parts(t, paren);
  if (a.length == 3) return ((real) a[0], (real) a[1], (real) a[2]);
  abort("把 '" + s + "' 当 triple：切出来 " + (string) a.length + " 个分量，要 3 个");
  return (0, 0, 0);
}

// 把上面那条 `(real) s` 填进读文件那一族留的那格函数值（声明在 asy__fr1r 前面，
// 理由写在那里：名字顺序解析，读文件那一段在这条 ecast 之前）。
asy__num = new real(string s) { return (real) s; };

// downcase/upcase 是 runstring.in:201/207 的 std::transform(tolower/toupper)。
// 这一层没有"一个字节"这一格，按 ASCII 那 26 对换；别的字符原样过（C locale 的
// tolower 对非字母也是原样）。
private string asy__LOWER = "abcdefghijklmnopqrstuvwxyz";
private string asy__UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
string downcase(string s) {
  string r = "";
  for (int i = 0; i < length(s); ++i) {
    string c = substr(s, i, 1);
    int k = find(asy__UPPER, c);
    r += k >= 0 ? substr(asy__LOWER, k, 1) : c;
  }
  return r;
}
string upcase(string s) {
  string r = "";
  for (int i = 0; i < length(s); ++i) {
    string c = substr(s, i, 1);
    int k = find(asy__LOWER, c);
    r += k >= 0 ? substr(asy__UPPER, k, 1) : c;
  }
  return r;
}

// byte/byteinv 是 runtime.in:446/451 转手 pen.h:143/150；hex/ascii 是
// runstring.in:430/441。plain_pens.asy:333 的 `byteinv(hex(substr(s,2i+offset,2)))`
// （`rgb("#ff8000")` 那条路）要 byteinv 与 hex 两个。
// 量过（asy -noV）：byte(0.5)=128 byte(1)=255 byte(-0.2)=0 byte(0.999)=255
//   byteinv(128)=0.5 byteinv(255)=1 byteinv(300)=0.171875（(unsigned char)300=44）
//   byteinv(-3)=0 hex("ff")=255 hex("1A")=26 ascii("A")=65 ascii("abc")=97 ascii("")=-1
int byte(real x) {
  if (x < 0) return 0;
  int c = (int) (x * 256);
  return c < 255 ? c : 255;
}
real byteinv(int x) {
  if (x < 0) return 0;
  int i = x % 256;
  return i == 255 ? 1 : i / 256;
}
private string asy__HEXDIG = "0123456789abcdef";
int hex(string s) {
  int n = length(s);
  int i = asy__skipws(s, 0);
  bool neg = false;
  if (i < n && (substr(s, i, 1) == "+" || substr(s, i, 1) == "-")) {
    neg = substr(s, i, 1) == "-";
    ++i;
  }
  // `0x` / `0X` 前缀：C++ 的 hex basefield 收它
  if (i + 1 < n && substr(s, i, 1) == "0"
      && (substr(s, i + 1, 1) == "x" || substr(s, i + 1, 1) == "X")) i += 2;
  int v = 0;
  int digits = 0;
  while (i < n) {
    int d = find(asy__HEXDIG, downcase(substr(s, i, 1)));
    if (d < 0) break;
    v = v * 16 + d;
    ++digits;
    ++i;
  }
  i = asy__skipws(s, i);
  if (digits == 0 || i != n) abort("invalid hexadecimal cast from string \"" + s + "\"");
  return neg ? -v : v;
}
// 表里那个反斜杠要用**单引号**串写：asy 的双引号串只认 `\"`，`"\\"` 是**两个**
// 反斜杠（量过：length("a\\b")=4，两边都是 4），单引号串才按 C 那套转义。
private string asy__PRINT = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ["
  + '\\' + "]^_`abcdefghijklmnopqrstuvwxyz{|}~";
int ascii(string s) {
  if (length(s) == 0) return -1;
  string c = substr(s, 0, 1);
  if (c == '\t') return 9;
  if (c == '\n') return 10;
  if (c == '\r') return 13;
  int i = find(asy__PRINT, c);
  if (i >= 0) return i + 32;
  // asy 那边回的是**第一个字节**；这一层没有“取一个字节”这一格（substr 从多字节字符
  // 中间切一刀是要报错的），所以非 ASCII 这一格是 abort，不是给个错答案。
  abort("ascii 这一刀只做 ASCII（可见字符与 \t \n \r）—— asy 回的是第一个字节");
  return -1;
}

// ---- 度数三角（runpair.in:125+）：三维那一层与 labelpath3 要它 ----
// 90 度的整数倍上给**精确**值（C++ 那边就是这么分档的），别的照弧度算。
real Sin(real deg) {
  int n = (int) (deg / 90.0);
  if (deg == n * 90.0) {
    int m = n % 4;
    if (m < 0) m += 4;
    if (m == 1) return 1;
    if (m == 3) return -1;
    return 0.0;
  }
  return sin(radians(deg));
}
real Cos(real deg) {
  int n = (int) (deg / 90.0);
  if (deg == n * 90.0) {
    int m = n % 4;
    if (m < 0) m += 4;
    if (m == 0) return 1;
    if (m == 2) return -1;
    return 0.0;
  }
  return cos(radians(deg));
}
real Tan(real deg) {
  int n = (int) (deg / 90.0);
  if (deg == n * 90.0) {
    int m = n % 4;
    if (m < 0) m += 4;
    if (m == 1) return inf;
    if (m == 3) return -inf;
    return 0.0;
  }
  return tan(radians(deg));
}
real aSin(real x) { return degrees(asin(x)); }
real aCos(real x) { return degrees(acos(x)); }
real aTan(real x) { return degrees(atan(x)); }
// ---- 三次 Bézier 的求值与前三阶导（runpair.in:245+ / runtriple.in:146+）----
// three_surface.asy 拿它们算面上的点与法向；式子照 C++ 那边逐项抄，不重排。
pair bezier(pair a, pair b, pair c, pair d, real t) {
  real onemt = 1 - t;
  real onemt2 = onemt * onemt;
  return onemt2 * onemt * a + t * (3.0 * (onemt2 * b + t * onemt * c) + t * t * d);
}
pair bezierP(pair a, pair b, pair c, pair d, real t) {
  return 3.0 * (t * t * (d - a + 3.0 * (b - c)) + t * (2.0 * (a + c) - 4.0 * b) + b - a);
}
pair bezierPP(pair a, pair b, pair c, pair d, real t) {
  return 6.0 * (t * (d - a + 3.0 * (b - c)) + a + c) - 12.0 * b;
}
pair bezierPPP(pair a, pair b, pair c, pair d) {
  return 6.0 * (d - a) + 18.0 * (b - c);
}
triple bezier(triple a, triple b, triple c, triple d, real t) {
  real onemt = 1 - t;
  real onemt2 = onemt * onemt;
  return onemt2 * onemt * a + t * (3.0 * (onemt2 * b + t * onemt * c) + t * t * d);
}
triple bezierP(triple a, triple b, triple c, triple d, real t) {
  return 3.0 * (t * t * (d - a + 3.0 * (b - c)) + t * (2.0 * (a + c) - 4.0 * b) + b - a);
}
triple bezierPP(triple a, triple b, triple c, triple d, real t) {
  return 6.0 * (t * (d - a + 3.0 * (b - c)) + a + c) - 12.0 * b;
}
triple bezierPPP(triple a, triple b, triple c, triple d) {
  return 6.0 * (d - a) + 18.0 * (b - c);
}
// v 里垂直于**单位向量** u 的那一份（triple.h:364）
triple perp(triple v, triple u) { return v - dot(v, u) * u; }
// 四阶齐次变换矩阵把一个三维点投到平面上（runarray.in:1472）：第四行是透视那一行
pair project(triple v, real[][] t) {
  if (t.length != 4) abort("project: 要 4x4 的变换");
  real f = t[3][0] * v.x + t[3][1] * v.y + t[3][2] * v.z + t[3][3];
  if (f == 0.0) abort("project: 除以零");
  f = 1.0 / f;
  return ((t[0][0] * v.x + t[0][1] * v.y + t[0][2] * v.z + t[0][3]) * f,
          (t[1][0] * v.x + t[1][1] * v.y + t[1][2] * v.z + t[1][3]) * f);
}
triple interp(triple a, triple b, real t) { return (1 - t) * a + t * b; }
// 整条路径每一段都是直的？（path3.h:133）
bool piecewisestraight(path3 p) {
  int L = length(p);
  for (int i = 0; i < L; ++i) if (!straight(p, i)) return false;
  return true;
}
// ---- 线性代数那两格（runarray.in:1253 / 1383）：三维的投影矩阵要它们 ----
// C++ 那边是 LU 分解（部分选主元）之后连乘对角线；这里同一套，行交换记在符号上。
real determinant(real[][] a) {
  int n = a.length;
  real[][] A = new real[n][];
  for (int i = 0; i < n; ++i) {
    real[] row = new real[n];
    for (int j = 0; j < n; ++j) row[j] = a[i][j];
    A[i] = row;
  }
  real det = 1;
  for (int i = 0; i < n; ++i) {
    int p = i;
    real m = abs(A[i][i]);
    for (int j = i + 1; j < n; ++j) {
      real v = abs(A[j][i]);
      if (v > m) { m = v; p = j; }
    }
    if (m == 0) return 0.0;
    if (p != i) {
      real[] t = A[i]; A[i] = A[p]; A[p] = t;
      det = -det;
    }
    det = det * A[i][i];
    for (int j = i + 1; j < n; ++j) {
      real f = A[j][i] / A[i][i];
      for (int k = i; k < n; ++k) A[j][k] = A[j][k] - f * A[i][k];
    }
  }
  return det;
}
// n x n 的逆（Gauss-Jordan，与 C++ 那边同一套；奇异矩阵在 asy 那边是运行时错）
real[][] inverse(real[][] a) {
  int n = a.length;
  real[][] A = new real[n][];
  for (int i = 0; i < n; ++i) {
    real[] row = new real[2 * n];
    for (int j = 0; j < n; ++j) row[j] = a[i][j];
    for (int j = 0; j < n; ++j) row[n + j] = i == j ? 1 : 0;
    A[i] = row;
  }
  for (int i = 0; i < n; ++i) {
    int p = i;
    real m = abs(A[i][i]);
    for (int j = i + 1; j < n; ++j) {
      real v = abs(A[j][i]);
      if (v > m) { m = v; p = j; }
    }
    if (m == 0) abort("inverse: 奇异矩阵");
    if (p != i) { real[] t = A[i]; A[i] = A[p]; A[p] = t; }
    real d = A[i][i];
    for (int k = i; k < 2 * n; ++k) A[i][k] = A[i][k] / d;
    for (int j = 0; j < n; ++j) {
      if (j == i) continue;
      real f = A[j][i];
      if (f == 0) continue;
      for (int k = i; k < 2 * n; ++k) A[j][k] = A[j][k] - f * A[i][k];
    }
  }
  real[][] r = new real[n][];
  for (int i = 0; i < n; ++i) {
    real[] row = new real[n];
    for (int j = 0; j < n; ++j) row[j] = A[i][n + j];
    r[i] = row;
  }
  return r;
}
// ---- Bézier 面片的界（runarray.in:2178+）：three_surface.asy 量包围盒要它们 ----
// C++ 那边是"先拿控制点当界、再细分收紧到 Fuzz"；这一刀只到**控制点凸包**那一步 ——
// 凸包界是真界（曲面一定在里面），只是弯得厉害的面片上包围盒会比 asy 的松一点。
// 记在 ADR 里：这是这一层与 asy 量得出的差别之一，不是错。
real change2(triple[][] a) {
  int n = a.length;
  if (n == 0) return 0.0;
  if (a[0].length == 0) return 0.0;
  triple a00 = a[0][0];
  real M = 0.0;
  for (int i = 0; i < n; ++i) {
    for (int j = 0; j < a[i].length; ++j) {
      triple d = a[i][j] - a00;
      real v = dot(d, d);
      if (v > M) M = v;
    }
  }
  return M;
}
/*
 * `minbezier` / `maxbezier`（runarray.in:2200/2212）：**不是控制点凸包**，是对
 * x/y/z 三个分量各跑一遍细分求真极值，fuzz 是 `Fuzz*norm(A,N)`（每个分量各自的 L∞）。
 *
 * 这一对是 `three_surface.asy:280/286` 的 `patch.min()/max()` 用的，也就是
 * `surface.min()/max()`、`tube` 那一格传给 `drawTube` 的 min/max 全从这儿来。
 * 原先按凸包算 —— 凸包偏大，界就偏大。
 *
 * 十个控制点的三角面片走的是 `boundtri`（bound.cc:102，要 Splittri 那一大张表），
 * 还没搬，那一支仍按凸包 —— 记一笔。
 */
private triple asy__bezbound(triple[][] P, triple b, bool mx) {
  real[] cx; real[] cy; real[] cz;
  for (int i = 0; i < P.length; ++i)
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      cx.push(v.x); cy.push(v.y); cz.push(v.z);
    }
  if (cx.length == 10) {
    // 十个控制点的三角面片：bound.cc:102 的 boundtri（bounddouble(N) 按 N 分派）
    return (asy__sboundtri(cx, mx, b.x, asy__Fuzz * asy__norminf(cx), asy__rmaxdepth),
            asy__sboundtri(cy, mx, b.y, asy__Fuzz * asy__norminf(cy), asy__rmaxdepth),
            asy__sboundtri(cz, mx, b.z, asy__Fuzz * asy__norminf(cz), asy__rmaxdepth));
  }
  if (cx.length != 16) {
    for (int i = 0; i < cx.length; ++i)
      b = (asy__rm(mx, b.x, cx[i]), asy__rm(mx, b.y, cy[i]), asy__rm(mx, b.z, cz[i]));
    return b;
  }
  return (asy__sbound(cx, mx, b.x, asy__Fuzz * asy__norminf(cx), asy__rmaxdepth),
          asy__sbound(cy, mx, b.y, asy__Fuzz * asy__norminf(cy), asy__rmaxdepth),
          asy__sbound(cz, mx, b.z, asy__Fuzz * asy__norminf(cz), asy__rmaxdepth));
}
triple minbezier(triple[][] P, triple b) { return asy__bezbound(P, b, false); }
triple maxbezier(triple[][] P, triple b) { return asy__bezbound(P, b, true); }
/*
 * 透视投影下的 x/z、y/z 比（runarray.in:2224/2236 的 `minratio/maxratio(triplearray2*)`）：
 * **不是控制点凸包**，是 `boundtriple(N)` 那一支 —— 对 Bezier 面片细分求 x/z 与 y/z 的
 * 真极值，`fuzz = Fuzz*norm(A,N)`。
 *
 * 这一对是三维出图**最要紧的一格**：three_surface.asy:293/301 的
 * `patch.min(projection)/max(projection)` 走它（透视时 `maxratio(Q,d*bound)/d`），
 * 于是 `pic2` 的二维界、`S.width/S.height`（three.asy:2734）、`oW/oH`、
 * 位图尺寸与封套全从这儿来。
 *
 * 真身 `asy__pbound` 在文件后面（它要 `path3` 那一段的邻居），asy 的名字解析是顺序的，
 * 所以这儿放一个前向桩、下面装上（与 `asy__merge3fn` / `asy__r3hexfn` 同一手法）。
 * 桩本身**不能当兜底**：装不上就等于回到凸包，所以下面那一行赋值不许省。
 */
real asy__pboundfn(triple[] P, bool mx, int which, real b, real fuzz, int depth) {
  return b;
}
// 三角面片那一支的同一手法（path3.cc:860 的 boundtri）
real asy__pboundtrifn(triple[] P, bool mx, int which, real b, real fuzz, int depth) {
  return b;
}

// norm(A,N)（run::norm 的 triple 版）：这里取所有分量绝对值的最大 —— fuzz 只进
// 终止判据的尺度，与逐字节无关；真要对齐再核对 runtime 那一格取的是长度还是分量。
private real asy__norm3(triple[] A) {
  real n = 0;
  for (int i = 0; i < A.length; ++i) {
    real t = abs(A[i].x); if (t > n) n = t;
    t = abs(A[i].y); if (t > n) n = t;
    t = abs(A[i].z); if (t > n) n = t;
  }
  return n;
}

private pair asy__ratio2(triple[][] P, pair b, bool mx) {
  triple[] A;
  for (int i = 0; i < P.length; ++i)
    for (int j = 0; j < P[i].length; ++j) A.push(P[i][j]);
  if (A.length == 10) {
    // 三角面片：path3.cc:860 的 boundtri（boundtriple(N) 按 N 分派）
    real fuzz = asy__Fuzz * asy__norm3(A);
    return (asy__pboundtrifn(A, mx, 0, b.x, fuzz, asy__rmaxdepth),
            asy__pboundtrifn(A, mx, 1, b.y, fuzz, asy__rmaxdepth));
  }
  if (A.length != 16) {
    // 别的点数（NURBS 之类）暂时按凸包
    for (int i = 0; i < A.length; ++i) {
      triple v = A[i];
      b = (mx ? max(b.x, v.x / v.z) : min(b.x, v.x / v.z),
           mx ? max(b.y, v.y / v.z) : min(b.y, v.y / v.z));
    }
    return b;
  }
  real fuzz = asy__Fuzz * asy__norm3(A);
  return (asy__pboundfn(A, mx, 0, b.x, fuzz, asy__rmaxdepth),
          asy__pboundfn(A, mx, 1, b.y, fuzz, asy__rmaxdepth));
}

pair minratio(triple[][] P, pair b) { return asy__ratio2(P, b, false); }
pair maxratio(triple[][] P, pair b) { return asy__ratio2(P, b, true); }
// ---- 数组那几格（runarray.in 里按元素类型注册的一族）：三维那一层要 triple 那一版 ----
triple[][] transpose(triple[][] a) {
  int n = a.length;
  if (n == 0) return new triple[][];
  int m = a[0].length;
  triple[][] r = new triple[m][];
  for (int i = 0; i < m; ++i) {
    triple[] row = new triple[n];
    for (int j = 0; j < n; ++j) row[j] = a[j][i];
    r[i] = row;
  }
  return r;
}
triple minbound(triple[] a) {
  if (a.length == 0) abort("minbound: 空数组");
  triple b = a[0];
  for (int i = 1; i < a.length; ++i) b = minbound(b, a[i]);
  return b;
}
triple maxbound(triple[] a) {
  if (a.length == 0) abort("maxbound: 空数组");
  triple b = a[0];
  for (int i = 1; i < a.length; ++i) b = maxbound(b, a[i]);
  return b;
}
triple minbound(triple[][] a) {
  if (a.length == 0) abort("minbound: 空数组");
  triple b = minbound(a[0]);
  for (int i = 1; i < a.length; ++i) b = minbound(b, minbound(a[i]));
  return b;
}
triple maxbound(triple[][] a) {
  if (a.length == 0) abort("maxbound: 空数组");
  triple b = maxbound(a[0]);
  for (int i = 1; i < a.length; ++i) b = maxbound(b, maxbound(a[i]));
  return b;
}
// ---- Delaunay 三角化（runarray.in:2102 的 triangulate -> Delaunay.cc:44 的 Triangulate）----
// 真 asy 那边的判据走 predicates.cc（Shewchuk 的**精确**几何谓词：先用浮点算一遍，误差
// 界之内再用展开式的精确算术重算）。这一层只有前一半 —— 那个"算不准就重算"的自适应级
// 没有照抄（两千八百行的展开式算术）。差别是**退化输入**上的：四点共圆、三点共线这些
// 落在误差界之内的形状，符号可能与真 asy 相反，于是那一块的三角化连法不一样。
// 非退化的输入两边一样（下面那个 tests/asy/cases/148-triangulate 钉着几组）。
private real asy__orient2d(real ax, real ay, real bx, real by, real cx, real cy) {
  return (ax-cx)*(by-cy)-(ay-cy)*(bx-cx);
}
private real asy__incircle(real ax, real ay, real bx, real by, real cx, real cy,
                           real dx, real dy) {
  real adx = ax-dx; real bdx = bx-dx; real cdx = cx-dx;
  real ady = ay-dy; real bdy = by-dy; real cdy = cy-dy;
  real bdxcdy = bdx*cdy; real cdxbdy = cdx*bdy;
  real alift = adx*adx+ady*ady;
  real cdxady = cdx*ady; real adxcdy = adx*cdy;
  real blift = bdx*bdx+bdy*bdy;
  real adxbdy = adx*bdy; real bdxady = bdx*ady;
  real clift = cdx*cdx+cdy*cdy;
  return alift*(bdxcdy-cdxbdy)+blift*(cdxady-adxcdy)+clift*(adxbdy-bdxady);
}
// presort 那一趟（Delaunay.cc:49 的 `qsort(pxyz,nv,sizeof(XYZ),XYZCompare)`）：比较只看 x，
// **等 x 时回 0**，于是次序全看 qsort 怎么走 —— 而输入里等 x 的点很多（规则网格就是一列
// 好几个）。所以这里照抄的是 BSD/Apple libc 那份 qsort（三点取中的快排，等元素往两头拨，
// 一趟没换过就转插入排，n<7 直接插入排），不是随便一个稳定排：换一份排法连出来的三角化
// 就与真 asy 不一样了（量过：3x3 网格上稳定插入排给的 8 个三角形连法全不同）。
// 元素是"px/py/pi 三个平行数组的同一格"，下面的下标都以**格**为单位（C 那边的 es=1）。
private void asy__vswap(real[] px, real[] py, int[] pi, int i, int j) {
  real tx = px[i]; px[i] = px[j]; px[j] = tx;
  real ty = py[i]; py[i] = py[j]; py[j] = ty;
  int ti = pi[i]; pi[i] = pi[j]; pi[j] = ti;
}
private void asy__vecswap(real[] px, real[] py, int[] pi, int i, int j, int n) {
  for (int k = 0; k < n; ++k) asy__vswap(px, py, pi, i+k, j+k);
}
private int asy__med3(real[] px, int a, int b, int c) {
  return px[a] < px[b]
    ? (px[b] < px[c] ? b : (px[a] < px[c] ? c : a))
    : (px[b] > px[c] ? b : (px[a] < px[c] ? a : c));
}
private void asy__qsortx(real[] px, real[] py, int[] pi, int a0, int n0) {
  int a = a0;
  int n = n0;
  while (true) {
    bool swapped = false;
    if (n < 7) {
      for (int pm = a+1; pm < a+n; ++pm)
        for (int pl = pm; pl > a && px[pl-1] > px[pl]; --pl) asy__vswap(px, py, pi, pl, pl-1);
      return;
    }
    int pm = a + quotient(n, 2);
    int pl = a;
    int pn = a + n - 1;
    if (n > 7) {                          // n == 7 那一格**不取中**（C 那边就是 `if(n > 7)`）
      if (n > 40) {
        int d = quotient(n, 8);
        pl = asy__med3(px, pl, pl+d, pl+2*d);
        pm = asy__med3(px, pm-d, pm, pm+d);
        pn = asy__med3(px, pn-2*d, pn-d, pn);
      }
      pm = asy__med3(px, pl, pm, pn);
    }
    asy__vswap(px, py, pi, a, pm);
    int pa = a+1; int pb = a+1;
    int pc = a+n-1; int pd = a+n-1;
    while (true) {
      while (pb <= pc && px[pb] <= px[a]) {
        if (px[pb] == px[a]) { swapped = true; asy__vswap(px, py, pi, pa, pb); ++pa; }
        ++pb;
      }
      while (pb <= pc && px[pc] >= px[a]) {
        if (px[pc] == px[a]) { swapped = true; asy__vswap(px, py, pi, pc, pd); --pd; }
        --pc;
      }
      if (pb > pc) break;
      asy__vswap(px, py, pi, pb, pc);
      swapped = true;
      ++pb; --pc;
    }
    if (!swapped) {                       // 一趟没换过：转插入排
      for (int pm2 = a+1; pm2 < a+n; ++pm2)
        for (int pl2 = pm2; pl2 > a && px[pl2-1] > px[pl2]; --pl2) asy__vswap(px, py, pi, pl2, pl2-1);
      return;
    }
    pn = a + n;
    int r = pa-a < pb-pa ? pa-a : pb-pa;
    asy__vecswap(px, py, pi, a, pb-r, r);
    r = pd-pc < pn-pd-1 ? pd-pc : pn-pd-1;
    asy__vecswap(px, py, pi, pb, pn-r, r);
    r = pb-pa;
    if (r > 1) asy__qsortx(px, py, pi, a, r);
    r = pd-pc;
    if (r > 1) { a = pn-r; n = r; continue; }   // C 那边是 `goto loop`（省栈）
    return;
  }
}
int[][] triangulate(pair[] z) {
  int nv = z.length;
  int[][] out;
  if (nv < 3) return out;      // 量过：真 asy 那边 nv<3 时回的也是空表
  // 顶点表比 nv 多 3 格（超三角形挂在末尾）。presort 是按 x 升序，用的是照抄的那份
  // BSD qsort（见 asy__qsortx 上面那段注：等 x 的次序必须与真 asy 一样，不然连法不同）。
  real[] px; real[] py; int[] pi;
  for (int i = 0; i < nv; ++i) { px.push(z[i].x); py.push(z[i].y); pi.push(i); }
  asy__qsortx(px, py, pi, 0, nv);
  real xmin = px[0]; real ymin = py[0]; real xmax = xmin; real ymax = ymin;
  for (int i = 1; i < nv; ++i) {
    real x = px[i]; real y = py[i];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  real dx = xmax-xmin;
  real dy = ymax-ymin;
  real xmargin = 0.01*dx;                 // Delaunay.cc:83 的 margin
  real ymargin = 0.01*dy;
  px.push(xmin-xmargin); py.push(ymin-ymargin); pi.push(nv);
  px.push(xmin-xmargin); py.push(ymax+ymargin+dx); pi.push(nv+1);
  px.push(xmax+xmargin+dy); py.push(ymin-ymargin); pi.push(nv+2);
  // 三角形表（三个顶点各一列）与"这一格算完了"的旗子；边表在下面按 nedge 记长度。
  int[] t1; int[] t2; int[] t3; bool[] tdone;
  t1.push(nv); t2.push(nv+1); t3.push(nv+2); tdone.push(false);
  int ntri = 1;
  int[] e1; int[] e2;
  for (int i = 0; i < nv; ++i) {
    int nedge = 0;
    real ddx = px[i]; real ddy = py[i];
    for (int j = 0; j < ntri; ++j) {
      if (tdone[j]) continue;
      real ax = px[t1[j]]; real ay = py[t1[j]];
      real bx = px[t2[j]]; real by = py[t2[j]];
      real cx = px[t3[j]]; real cy = py[t3[j]];
      if (asy__incircle(ax,ay,bx,by,cx,cy,ddx,ddy) <= 0) {
        // 点落在外接圆里（或圆上）：这个三角形的三条边进边表，它自己删掉
        while (e1.length < nedge+3) { e1.push(0); e2.push(0); }
        e1[nedge] = t1[j];   e2[nedge] = t2[j];
        e1[nedge+1] = t2[j]; e2[nedge+1] = t3[j];
        e1[nedge+2] = t3[j]; e2[nedge+2] = t1[j];
        nedge += 3;
        --ntri;
        t1[j] = t1[ntri]; t2[j] = t2[ntri]; t3[j] = t3[ntri]; tdone[j] = tdone[ntri];
        --j;
      } else {
        // d[0] 已经在外接圆右边了：这一格以后都不用再看（Delaunay.cc:145 那一段）
        real A = ax*ax+ay*ay;
        real B = bx*bx+by*by;
        real C = cx*cx+cy*cy;
        real a0 = asy__orient2d(ax,ay,bx,by,cx,cy);
        if (ddx*a0 < 0.5*asy__orient2d(A,ay,B,by,C,cy)) {
          tdone[j] = asy__incircle(ax*a0,ay*a0,bx*a0,by*a0,cx*a0,cy*a0,
                                   ddx*a0, 0.5*asy__orient2d(ax,A,bx,B,cx,C)) > 0;
        }
      }
    }
    // 成对的边（内部边）打上记号：两条方向相反的同一条边都不要
    for (int j = 0; j+1 < nedge; ++j) {
      for (int k = j+1; k < nedge; ++k) {
        if (e1[j] == e2[k] && e2[j] == e1[k]) {
          e1[j] = -1; e2[j] = -1; e1[k] = -1; e2[k] = -1;
        }
      }
    }
    // 剩下的边各与这个点连成一个新三角形
    for (int j = 0; j < nedge; ++j) {
      if (e1[j] < 0 || e2[j] < 0) continue;
      while (t1.length < ntri+1) { t1.push(0); t2.push(0); t3.push(0); tdone.push(false); }
      t1[ntri] = e1[j]; t2[ntri] = e2[j]; t3[ntri] = i; tdone[ntri] = false;
      ++ntri;
    }
  }
  // 带超三角形顶点的那些删掉（顶点号 >= nv）
  for (int i = 0; i < ntri; ++i) {
    if (t1[i] >= nv || t2[i] >= nv || t3[i] >= nv) {
      --ntri;
      t1[i] = t1[ntri]; t2[i] = t2[ntri]; t3[i] = t3[ntri];
      --i;
    }
  }
  // 顶点号换回**排序前**那一份（runarray.in:2124 的 pxyz[Vi->p1].i）
  for (int i = 0; i < ntri; ++i) out.push(new int[] {pi[t1[i]], pi[t2[i]], pi[t3[i]]});
  return out;
}
// 带比较函数的排序（runarray.in 的 sort(T[], bool less(T,T))）：稳定，插入排
triple[] sort(triple[] a, bool less(triple, triple)) {
  triple[] r = new triple[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = a[i];
  for (int i = 1; i < r.length; ++i) {
    triple v = r[i];
    int j = i - 1;
    while (j >= 0 && less(v, r[j])) { r[j + 1] = r[j]; --j; }
    r[j + 1] = v;
  }
  return r;
}
// 二维那一版：按**字典序**比行（runarray.in 的 sort(T[][])）
private bool asy__lexless(real[] a, real[] b) {
  int n = a.length < b.length ? a.length : b.length;
  for (int i = 0; i < n; ++i) {
    if (a[i] < b[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return a.length < b.length;
}
real[][] sort(real[][] a) {
  real[][] r = new real[a.length][];
  for (int i = 0; i < a.length; ++i) r[i] = a[i];
  for (int i = 1; i < r.length; ++i) {
    real[] v = r[i];
    int j = i - 1;
    while (j >= 0 && asy__lexless(v, r[j])) { r[j + 1] = r[j]; --j; }
    r[j + 1] = v;
  }
  return r;
}
// 控制点相对两个结点的距离（runpath.in:404 -> knot.cc:61 的 velocity）：
// 名字有点误导 —— 它是控制点相对结点间距的**倍数**（还是三倍）。式子照 MetaPost
// 第 131 节那一套，tension atleast 那一档的收紧也照抄。形参名不能叫 `atleast` ——
// 那是词法上的关键字（`..tension atleast 2..`），asy 那边的 C++ 签名不受这一条管。
real relativedistance(real theta, real phi, real t, bool atLeast) {
  real VELOCITY_BOUND = 4.0;
  real a = sqrt(2.0);
  real b = 1.0 / 16.0;
  real c = 1.5 * (sqrt(5.0) - 1.0);
  real d = 1.5 * (3.0 - sqrt(5.0));
  real st = sin(theta);
  real ct = cos(theta);
  real sf = sin(phi);
  real cf = cos(phi);
  real denom = t * (3.0 + c * ct + d * cf);
  real r = denom != 0.0
    ? (2.0 + a * (st - b * sf) * (sf - b * st) * (ct - cf)) / denom
    : VELOCITY_BOUND;
  if (r > VELOCITY_BOUND) r = VELOCITY_BOUND;
  if (atLeast) {
    real sine = sin(theta + phi);
    if ((st >= 0.0 && sf >= 0.0 && sine > 0.0)
        || (st <= 0.0 && sf <= 0.0 && sine < 0.0)) {
      real rmax = sf / sine;
      if (r > rmax) r = rmax;
    }
  }
  return r;
}

// 两条三维路径接起来（path3.cc:698 的 concat，`&` 在 C++ 面注册）：接缝那一格取
// 后一条的起点，直/曲的标记跟着各自那一段走。asy 那边不查两端是否重合，这里也不查。
path3 operator &(path3 p, path3 q) {
  int n1 = length(p);
  int n2 = length(q);
  if (n1 == -1) return q;
  if (n2 == -1) return p;
  int n = n1 + n2 + 1;
  triple[] pre = new triple[n];
  triple[] pnt = new triple[n];
  triple[] post = new triple[n];
  bool[] str = new bool[n];
  int i = 0;
  pre[0] = point(p, 0);
  for (int j = 0; j < n1; ++j) {
    pnt[i] = point(p, j);
    str[i] = straight(p, j);
    post[i] = postcontrol(p, j);
    pre[i + 1] = precontrol(p, j + 1);
    ++i;
  }
  for (int j = 0; j < n2; ++j) {
    pnt[i] = point(q, j);
    str[i] = straight(q, j);
    post[i] = postcontrol(q, j);
    pre[i + 1] = precontrol(q, j + 1);
    ++i;
  }
  pnt[i] = point(q, n2);
  post[i] = pnt[i];
  str[i] = false;
  return path3(pre, pnt, post, str, false);
}

// ---- 数组上的 \`==\` / \`!=\` 是**逐格**的（builtin.cc:485 的 addBooleanOps）：回一个
// bool[]，不是一个 bool。量过 \`new real[]{1,2,3} == new real[]{1,5,3}\` 印的是
// true false true；长度不同是**运行期错**（array.h:87 的 checkArrays），这里照那句话报。
// pen 那一格里比的是这一层的 \`==\`（比身份，不比内容）—— 那是先于这一刀的偏差。
bool[] operator ==(int[] a, int[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(int[] a, int[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}
bool[] operator ==(real[] a, real[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(real[] a, real[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}
bool[] operator ==(bool[] a, bool[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(bool[] a, bool[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}
bool[] operator ==(string[] a, string[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(string[] a, string[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}

// 数组对**一个标量**的 `==` / `!=`（builtin.cc 的 addOps 给每个基本类型都现生了这两支，
// 与上面 `>` / `<` 那一族的标量档同一形）。pdb.asy:34 的 `find(Element == e)` 就是这一格。
bool[] operator ==(int[] a, int b) { bool[] c; for (int x : a) c.push(x == b); return c; }
bool[] operator !=(int[] a, int b) { bool[] c; for (int x : a) c.push(x != b); return c; }
bool[] operator ==(int a, int[] b) { bool[] c; for (int x : b) c.push(a == x); return c; }
bool[] operator !=(int a, int[] b) { bool[] c; for (int x : b) c.push(a != x); return c; }
bool[] operator ==(real[] a, real b) { bool[] c; for (real x : a) c.push(x == b); return c; }
bool[] operator !=(real[] a, real b) { bool[] c; for (real x : a) c.push(x != b); return c; }
bool[] operator ==(real a, real[] b) { bool[] c; for (real x : b) c.push(a == x); return c; }
bool[] operator !=(real a, real[] b) { bool[] c; for (real x : b) c.push(a != x); return c; }
bool[] operator ==(string[] a, string b) { bool[] c; for (string x : a) c.push(x == b); return c; }
bool[] operator !=(string[] a, string b) { bool[] c; for (string x : a) c.push(x != b); return c; }
bool[] operator ==(string a, string[] b) { bool[] c; for (string x : b) c.push(a == x); return c; }
bool[] operator !=(string a, string[] b) { bool[] c; for (string x : b) c.push(a != x); return c; }
bool[] operator ==(bool[] a, bool b) { bool[] c; for (bool x : a) c.push(x == b); return c; }
bool[] operator !=(bool[] a, bool b) { bool[] c; for (bool x : a) c.push(x != b); return c; }
bool[] operator ==(bool a, bool[] b) { bool[] c; for (bool x : b) c.push(a == x); return c; }
bool[] operator !=(bool a, bool[] b) { bool[] c; for (bool x : b) c.push(a != x); return c; }
bool[] operator ==(pair[] a, pair[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(pair[] a, pair[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}
bool[] operator ==(triple[] a, triple[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(triple[] a, triple[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}
bool[] operator ==(pen[] a, pen[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = (a[i] == b[i]);
  return r;
}
bool[] operator !=(pen[] a, pen[] b) {
  asy__samelen(a.length, b.length);
  bool[] r = new bool[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = !(a[i] == b[i]);
  return r;
}

// ---- bool[] 当条件的 \`? :\`（runarray.in:1222 的 arrayConditional）----
// 两支都在：逐格选，回一格一样长的。有一支是 null：那一格不要，回筛出来的那些
// （math.asy:160 拿它当"取下标"用）。挑哪一份、null 在哪一支由前端定（见 asyArrCond）。
int[] asy__acond3(bool[] c, int[] a, int[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  int[] r = new int[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
int[] asy__acondT(bool[] c, int[] a) {
  asy__samelen(c.length, a.length);
  int[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
int[] asy__acondF(bool[] c, int[] b) {
  asy__samelen(c.length, b.length);
  int[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
real[] asy__acond3(bool[] c, real[] a, real[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  real[] r = new real[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
real[] asy__acondT(bool[] c, real[] a) {
  asy__samelen(c.length, a.length);
  real[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
real[] asy__acondF(bool[] c, real[] b) {
  asy__samelen(c.length, b.length);
  real[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
bool[] asy__acond3(bool[] c, bool[] a, bool[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  bool[] r = new bool[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
bool[] asy__acondT(bool[] c, bool[] a) {
  asy__samelen(c.length, a.length);
  bool[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
bool[] asy__acondF(bool[] c, bool[] b) {
  asy__samelen(c.length, b.length);
  bool[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
string[] asy__acond3(bool[] c, string[] a, string[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  string[] r = new string[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
string[] asy__acondT(bool[] c, string[] a) {
  asy__samelen(c.length, a.length);
  string[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
string[] asy__acondF(bool[] c, string[] b) {
  asy__samelen(c.length, b.length);
  string[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
pair[] asy__acond3(bool[] c, pair[] a, pair[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  pair[] r = new pair[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
pair[] asy__acondT(bool[] c, pair[] a) {
  asy__samelen(c.length, a.length);
  pair[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
pair[] asy__acondF(bool[] c, pair[] b) {
  asy__samelen(c.length, b.length);
  pair[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
triple[] asy__acond3(bool[] c, triple[] a, triple[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  triple[] r = new triple[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
triple[] asy__acondT(bool[] c, triple[] a) {
  asy__samelen(c.length, a.length);
  triple[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
triple[] asy__acondF(bool[] c, triple[] b) {
  asy__samelen(c.length, b.length);
  triple[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}
pen[] asy__acond3(bool[] c, pen[] a, pen[] b) {
  asy__samelen(c.length, a.length);
  asy__samelen(a.length, b.length);
  pen[] r = new pen[c.length];
  for (int i = 0; i < c.length; ++i) r[i] = c[i] ? a[i] : b[i];
  return r;
}
pen[] asy__acondT(bool[] c, pen[] a) {
  asy__samelen(c.length, a.length);
  pen[] r;
  for (int i = 0; i < c.length; ++i) if (c[i]) r.push(a[i]);
  return r;
}
pen[] asy__acondF(bool[] c, pen[] b) {
  asy__samelen(c.length, b.length);
  pen[] r;
  for (int i = 0; i < c.length; ++i) if (!c[i]) r.push(b[i]);
  return r;
}

// ---- 这一批：pen 的数乘、extension、zpart、数组上的一元数学函数与 gamma ----
// `0.8white` 就是 `0.8 * white`（pen.h:704）：负数当 0，按颜色空间逐道乘再夹回 [0,1]。
// DEFCOLOR（没设过颜色）、invisible、pattern 那几档不动。
private real asy__clamp01(real x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
pen operator *(real x, pen q) {
  pen p = pencopy(q);
  if (x < 0.0) x = 0.0;
  if (!p.setcolor || p.isinvisible) return p;
  if (p.iscmyk) {
    p.cyan = asy__clamp01(p.cyan * x);
    p.magenta = asy__clamp01(p.magenta * x);
    p.yellow = asy__clamp01(p.yellow * x);
    p.black = asy__clamp01(p.black * x);
    return p;
  }
  if (p.isrgb) {
    p.red = asy__clamp01(p.red * x);
    p.green = asy__clamp01(p.green * x);
    p.blue = asy__clamp01(p.blue * x);
    return p;
  }
  p.gray = asy__clamp01(p.gray * x);
  return p;
}
// 两条直线（各给两点）的交点（runpath.in:252）。平行时回 (infinity,infinity)。
pair extension(pair P, pair Q, pair p, pair q) {
  pair ac = P - Q;
  pair bd = q - p;
  real det = ac.x * bd.y - ac.y * bd.x;
  if (det == 0) return (infinity, infinity);
  return P + ((p.x - P.x) * bd.y - (p.y - P.y) * bd.x) * ac / det;
}
// triple 的第三道（runtriple.in:40）。xpart/ypart 那两格早就有了，这一格是漏的。
real zpart(triple v) { return v.z; }

// 一元实函数在 asy 那边都**连带一份数组版**（builtin.cc:225 的 addRealFunc 一次注册两格）：
// `log(real[])` 逐格算，回一格一样长的。slope.asy:75 那句就是它。
real[] sin(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = sin(a[i]);
  return r;
}
real[] cos(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = cos(a[i]);
  return r;
}
real[] tan(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = tan(a[i]);
  return r;
}
real[] asin(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = asin(a[i]);
  return r;
}
real[] acos(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = acos(a[i]);
  return r;
}
real[] atan(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = atan(a[i]);
  return r;
}
real[] exp(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = exp(a[i]);
  return r;
}
real[] log(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = log(a[i]);
  return r;
}
real[] log10(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = log10(a[i]);
  return r;
}
real[] sinh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = sinh(a[i]);
  return r;
}
real[] cosh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = cosh(a[i]);
  return r;
}
real[] tanh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = tanh(a[i]);
  return r;
}
real[] asinh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = asinh(a[i]);
  return r;
}
real[] acosh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = acosh(a[i]);
  return r;
}
real[] atanh(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = atanh(a[i]);
  return r;
}
real[] sqrt(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = sqrt(a[i]);
  return r;
}
real[] cbrt(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = cbrt(a[i]);
  return r;
}
real[] fabs(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = fabs(a[i]);
  return r;
}
real[] abs(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = abs(a[i]);
  return r;
}
real[] expm1(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = expm1(a[i]);
  return r;
}
real[] log1p(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = log1p(a[i]);
  return r;
}
real[] pow10(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = pow10(a[i]);
  return r;
}
real[] identity(real[] a) {
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = identity(a[i]);
  return r;
}

/* ---------------------------------------------------------------- 第六十六刀
 * geometry.asy 那道坡上量出来的几条内建（`import geometry;` 31 -> …）。
 * 都在这一批：map（runarray.in:979 的 arrayFunction）、gamma、abs2、bool 的 `^`、
 * newton（runarray.in:1622/1670 两格）。
 */

/*
 * map：asy 那边是**一格泛型**内建（`Tp[] map(Tp f(T), T[] a)`），我们的内建面是单态的，
 * 所以按 base/examples 里真用到的那几组类型各写一份（colormap.asy:128 的 `int(real)`、
 * graph3.asy:1922 的 `real(real)`、palette.asy:227 的 `pair(pair)`、
 * geometry.asy:79 的 `real(real)` —— 那一句给的还是一个**重载集**的名字）。
 */
real[] map(real f(real), real[] a)
{
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

int[] map(int f(int), int[] a)
{
  int[] r = new int[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

int[] map(int f(real), real[] a)
{
  int[] r = new int[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

pair[] map(pair f(pair), pair[] a)
{
  pair[] r = new pair[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

triple[] map(triple f(triple), triple[] a)
{
  triple[] r = new triple[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

string[] map(string f(string), string[] a)
{
  string[] r = new string[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

real[] map(real f(pair), pair[] a)
{
  real[] r = new real[a.length];
  for (int i = 0; i < a.length; ++i) r[i] = f(a[i]);
  return r;
}

/* abs2：pen.h 那一族的"模长的平方"（三维那边 three_arrows.asy 也用它） */
real abs2(pair z) { return z.x * z.x + z.y * z.y; }
real abs2(triple v) { return v.x * v.x + v.y * v.y + v.z * v.z; }

/*
 * bool 的 `^` 就是异或（量过 `true ^ false` 印 true）。写在这里而不是前端里：
 * `^` 在 real 上是幂，两条规则不同型，交给重载集分。
 */
bool operator ^(bool a, bool b) { return a != b; }

/*
 * gamma：Lanczos（g=7、n=9 那组系数），负半轴走反射公式。刻意分成两个函数而不是
 * 递归 —— 这个文件里名字是**顺序**可见的，一个函数看不见自己。
 */
private real asy__lgam(real z)
{
  real[] p = {
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  };
  real x = z - 1.0;
  real s = p[0];
  for (int i = 1; i < 9; ++i) s += p[i] / (x + i);
  real t = x + 7.5;
  return sqrt(2.0 * pi) * (t ^ (x + 0.5)) * exp(-t) * s;
}

real gamma(real x)
{
  if (x >= 0.5) return asy__lgam(x);
  return pi / (sin(pi * x) * asy__lgam(1.0 - x));
}

/*
 * newton 的两格（runarray.in:1622 与 :1670，逐句照抄）。第一格是纯 Newton-Raphson，
 * 第二格是"括住了根"的那一种（Newton 与二分交替，Numerical Recipes 的 rtsafe）。
 * `verbose` 那几句打印刻意没抄 —— 它印的是 C++ 那边的精度格式，抄不像。
 * 收敛不了时回 realMax（asy 那边是 DBL_MAX），调用处就是这么判的
 * （geometry.asy:2476 的 `if(tx < realMax)`）。
 */
real newton(int iterations = 100, real f(real), real fprime(real), real x,
            bool verbose = false)
{
  real fuzz = 1000.0 * realEpsilon;
  int i = 0;
  real diff = realMax;
  real lastdiff = realMax;
  bool go = true;
  while (go) {
    real x0 = x;
    real dfdx = fprime(x);
    if (dfdx == 0.0) { x = realMax; break; }
    x -= f(x) / dfdx;
    lastdiff = diff;
    diff = fabs(x - x0);
    ++i;
    if (i == iterations) { x = realMax; break; }
    go = diff != 0.0 && (diff < lastdiff || diff > fuzz * fabs(x));
  }
  return x;
}

real newton(int iterations = 100, real f(real), real fprime(real), real x1,
            real x2, bool verbose = false)
{
  real fuzz = 1000.0 * realEpsilon;
  real f1 = f(x1);
  if (f1 == 0.0) return x1;
  real f2 = f(x2);
  if (f2 == 0.0) return x2;
  if ((f1 > 0.0 && f2 > 0.0) || (f1 < 0.0 && f2 < 0.0)) {
    abort("root not bracketed, f(x1)=" + string(f1) + ", f(x2)=" + string(f2));
  }
  real x = 0.5 * (x1 + x2);
  real dxold = fabs(x2 - x1);
  if (f1 > 0.0) { real temp = x1; x1 = x2; x2 = temp; }
  real dx = dxold;
  real y = f(x);
  real dy = fprime(x);
  int j = 0;
  while (j < iterations) {
    if (((x - x2) * dy - y) * ((x - x1) * dy - y) >= 0.0
        || fabs(2.0 * y) > fabs(dxold * dy)) {
      dxold = dx;
      dx = 0.5 * (x2 - x1);
      x = x1 + dx;
      if (x1 == x) return x;
    } else {
      dxold = dx;
      dx = y / dy;
      real temp = x;
      x -= dx;
      if (temp == x) return x;
    }
    if (fabs(dx) < fuzz * fabs(x)) return x;
    y = f(x);
    dy = fprime(x);
    if (y < 0.0) x1 = x; else x2 = x;
    ++j;
  }
  return realMax;
}

/*
 * dot：asy 那边 `real dot(pair,pair)` / `real dot(triple,triple)` 与 plain_markers 的
 * `void dot(picture, …)`、three_surface 的 `void dot(picture, triple, material, …)`
 * 在**同一个重载集**里。这两格原来写死在前端里、不参与打分，于是
 * `dot(align, sign*dir)`（两个 triple）被 `void dot(…, triple v, material p, light …)`
 * 接走了 —— 第二个 triple 走 `light operator cast(triple)` 落进 light 那一格，代价 1，
 * 而写死在前端里的那格代价根本没进比较（graph3.asy:84 与 solids.asy:93 量出来的）。
 * 挪进这个文件就跟别的候选一起打分了。
 */
real dot(pair a, pair b) { return a.x * b.x + a.y * b.y; }
real dot(triple a, triple b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
/* 数组那一格（runarray.in 的 `real dot(real[], real[])`）：ode.asy:317 的
 * `h*dot(tableau.a.weights[i], predictions)` 要它。长度不同时与别的逐元素运算同一句错。 */
real dot(real[] a, real[] b) {
  asy__samelen(a.length, b.length);
  real s = 0;
  for (int i = 0; i < a.length; ++i) s += a[i] * b[i];
  return s;
}

/* ---------------------------------------------------------------- 第六十六刀（续）
 * 三维那一层的坡上量出来的几条：sum、concat 的另外几种元素、mintimes/maxtimes，
 * 以及 `_image` / `_labelpath` 两个**声明**（体是 abort —— 图像与沿路径排字要真的
 * 输出层，那是另一刀；有了声明，palette / labelpath 这两个模块才装得上，别的模块
 * 不碰这两个名字的照样能跑）。
 */

/* sum（runarray.in:1038 那一族）：bool 的那格数 true 的个数 */
int sum(bool[] a) { int s = 0; for (int i = 0; i < a.length; ++i) if (a[i]) ++s; return s; }
int sum(int[] a) { int s = 0; for (int i = 0; i < a.length; ++i) s += a[i]; return s; }
real sum(real[] a) { real s = 0; for (int i = 0; i < a.length; ++i) s += a[i]; return s; }
pair sum(pair[] a) { pair s = (0, 0); for (int i = 0; i < a.length; ++i) s += a[i]; return s; }
triple sum(triple[] a)
{
  triple s = (0, 0, 0);
  for (int i = 0; i < a.length; ++i) s += a[i];
  return s;
}

/* concat 的另外几种元素（three_surface.asy:940 要 pen[] 那一格） */
pen[] concat(pen[] a, pen[] b)
{
  pen[] r;
  for (int i = 0; i < a.length; ++i) r.push(a[i]);
  for (int i = 0; i < b.length; ++i) r.push(b[i]);
  return r;
}

triple[] concat(triple[] a, triple[] b)
{
  triple[] r;
  for (int i = 0; i < a.length; ++i) r.push(a[i]);
  for (int i = 0; i < b.length; ++i) r.push(b[i]);
  return r;
}

bool[] concat(bool[] a, bool[] b)
{
  bool[] r;
  for (int i = 0; i < a.length; ++i) r.push(a[i]);
  for (int i = 0; i < b.length; ++i) r.push(b[i]);
  return r;
}

/*
 * mintimes / maxtimes（runpath.in:386/395）：逐分量取到极值的**时刻**。
 * 真 asy 是在算包围盒时顺手记下来的（path.cc:472 的 `path::bounds()` 把 times 那一份
 * bbox 一起填了，解的是导数的零点），所以时刻是**精确**的。
 *
 * 原先这一层是"每段 32 个样点、取最好的那个样点"—— 近似。代价不是"偏一点"：
 * solids.asy:17 的 `tangent()` 拿 `mintimes(p)[1]` 当迭代的支点，采样的时刻使
 * hyperboloidsilhouette 的第一处坐标从参考的 -3.77470652 变成 -3.77948357
 * （相对 1.3e-3，正好越过这一轴 1e-3 的容差）。所以这里照 path.cc:472 重写：
 *   - 先 `box.add(point(len))`，times 四格都初始化成 len
 *   - 逐段 addpoint(i)；直段跳过；曲段解 x 与 y 两条二次（asy__bezcrit，与包围盒同一份），
 *     goodroot 的闭区间 0<=t<=1，**按 x 的 t1/t2、再 y 的 t1/t2 这个顺序**
 *   - 每次都是 addnonempty(point(i+t), t)：加的是**整个点**（x 的根那一点也参与 y 的比较），
 *     而且 x 那一对是 `if (< left) … else if (> right)`（不是两条独立的 if）——
 *     并列的两格谁先更新会决定平手时记下的是哪个时刻。
 * path3 那一对还是采样的（min3/max3 那一族用它，这一轴上还没有例子踩到）。
 */
private struct asy__tbox {
  real l; real b; real r; real t;
  real tl; real tb; real tr; real tt;
}
// bbox.h:97 的 addnonempty：那个 else if 是照抄的，不是笔误。
private void asy__tadd(asy__tbox bx, pair z, real u) {
  if (z.x < bx.l) { bx.l = z.x; bx.tl = u; }
  else if (z.x > bx.r) { bx.r = z.x; bx.tr = u; }
  if (z.y < bx.b) { bx.b = z.y; bx.tb = u; }
  else if (z.y > bx.t) { bx.t = z.y; bx.tt = u; }
}
private asy__tbox asy__pathtbox(path g) {
  asy__tbox bx = new asy__tbox;
  int nn = g.nodes.length;
  int len = length(g);
  pair z = point(g, (real) len);
  bx.l = z.x; bx.r = z.x; bx.b = z.y; bx.t = z.y;
  bx.tl = len; bx.tb = len; bx.tr = len; bx.tt = len;
  for (int i = 0; i < len; ++i) {
    asy__tadd(bx, point(g, (real) i), i);
    if (g.nodes[i].straight) continue;
    int j = i + 1 == nn ? 0 : i + 1;
    pair p0 = g.nodes[i].point;
    pair p1 = g.nodes[i].post;
    pair p2 = g.nodes[j].pre;
    pair p3 = g.nodes[j].point;
    for (real u : asy__bezcrit(p0.x, p1.x, p2.x, p3.x)) {
      if (u < 0.0 || u > 1.0) continue;
      asy__tadd(bx, point(g, i + u), i + u);
    }
    for (real u : asy__bezcrit(p0.y, p1.y, p2.y, p3.y)) {
      if (u < 0.0 || u > 1.0) continue;
      asy__tadd(bx, point(g, i + u), i + u);
    }
  }
  return bx;
}

real[] mintimes(path g) {
  if (g.nodes.length == 0) return new real[] {0, 0};
  asy__tbox bx = asy__pathtbox(g);
  return new real[] {bx.tl, bx.tb};
}
real[] maxtimes(path g) {
  if (g.nodes.length == 0) return new real[] {0, 0};
  asy__tbox bx = asy__pathtbox(g);
  return new real[] {bx.tr, bx.tt};
}


private real[] asy__times3(path3 g, bool wantMax)
{
  int n = length(g);
  real[] t = {0, 0, 0};
  triple best = point(g, 0.0);
  int m = n * 32;
  for (int i = 1; i <= m; ++i) {
    real ti = n * (i / m);
    triple v = point(g, ti);
    if (wantMax ? v.x > best.x : v.x < best.x) { best = (v.x, best.y, best.z); t[0] = ti; }
    if (wantMax ? v.y > best.y : v.y < best.y) { best = (best.x, v.y, best.z); t[1] = ti; }
    if (wantMax ? v.z > best.z : v.z < best.z) { best = (best.x, best.y, v.z); t[2] = ti; }
  }
  return t;
}

real[] mintimes(path3 g) { return asy__times3(g, false); }
real[] maxtimes(path3 g) { return asy__times3(g, true); }

/* 只有声明这一层的两个（理由见这一批开头那段注释） */
void _labelpath(frame f, string s, string size, path g, string justify,
                pair offset, pen p)
{
  abort("_labelpath 还没做（沿路径排字要真的 TeX 输出层）");
}

// 一格位图进 frame（这一刀）。有效变换是 `t * matrix(initial, final)`
// —— runpicture.in:395-411 三个重载都是这么拼的，而 drawimage.h:26 的界用的正是
// `t*(0,0)` 与 `t*(1,1)`，也就是说 initial/final 只用来**造那个变换**。
// 四个角都算出来（不只两个）：旋转过的图（laserlattice 参考里那块就是）跟着白捡。
private void asy__imgop(frame f, pen[][] data, pair initial, pair final, transform t) {
  int h = data.length;
  if (h == 0) return;
  if (data[0].length == 0) return;
  pair p00 = t * initial;
  pair p10 = t * (final.x, initial.y);
  pair p11 = t * final;
  pair p01 = t * (initial.x, final.y);
  drawop o;
  o.kind = 5;
  o.g = p00--p10--p11--p01--cycle;
  o.p = currentpen;
  o.img = data;
  f.ops.push(o);
}

// 值 -> 色板那一格的映射照 psfile.cc:604 抄：`step = (色板格数-1)/(max-min)`，
// 下标是 `(int)((v-min)*step)`（截断），两头夹住。空色板按 min..max 铺灰。
void _image(frame f, real[][] data, pair initial, pair final,
            pen[] palette = new pen[], transform t = identity(), bool copy = true,
            bool antialias = false)
{
  int h = data.length;
  if (h == 0) return;
  int w = data[0].length;
  if (w == 0) return;
  real mn = data[0][0];
  real mx = mn;
  for (int i = 0; i < h; ++i)
    for (int j = 0; j < w; ++j) {
      real v = data[i][j];
      if (v > mx) mx = v;
      else if (v < mn) mn = v;
    }
  pen[][] px = new pen[h][w];
  int n = palette.length;
  real sp = mx == mn ? 0 : (n == 0 ? 1 : n - 1) / (mx - mn);
  for (int i = 0; i < h; ++i)
    for (int j = 0; j < w; ++j) {
      real u = (data[i][j] - mn) * sp;
      if (n == 0) { px[i][j] = gray(u); continue; }
      // 下标是 `(size_t)((val-min)*step+0.5)`（psfile.cc:611）——**四舍五入，不是截断**。
      // 量出来的：截断那一版与参考逐字节比只有 45.8% 的字节相同（laserlattice 第一块图）。
      int k = (int) (u + 0.5);
      if (k < 0) k = 0;
      if (k >= n) k = n - 1;
      px[i][j] = palette[k];
    }
  asy__imgop(f, px, initial, final, t);
}

void _image(frame f, pen[][] data, pair initial, pair final,
            transform t = identity(), bool copy = true, bool antialias = false)
{
  asy__imgop(f, data, initial, final, t);
}

void _image(frame f, pen F(int, int), int width, int height,
            pair initial, pair final, transform t = identity(),
            bool antialias = false)
{
  if (width <= 0 || height <= 0) return;
  pen[][] px = new pen[height][width];
  for (int j = 0; j < height; ++j)
    for (int i = 0; i < width; ++i) px[j][i] = F(i, j);
  asy__imgop(f, px, initial, final, t);
}

/* ---------------------------------------------------------------- 第六十七刀
 * 三维那一层的**输出原语**（runpicture.in:296-780 那一段与 runpath3d.in:176/352）。
 *
 * asy 那边它们是 `f->append(new draw…3(…))`：往 picture 的节点表里塞一个三维绘图对象，
 * 真出图是 OpenGL / PRC / v3d 那三条路干的。这一层**只记界**：三维对象的坐标进 frame
 * 的 min3v/max3v 与 minr/maxr（后两个是 x/z、y/z 的比，投影层的 `fit` 要它 ——
 * picture.cc:339 的 ratio），几何本身丢掉。
 *
 * 代价写在明处：三维图的**内容**这一层落不下来（EPS 写出来是空的），但整棵 three /
 * graph3 / solids 树的正文能跑到底，界与投影算得出真数。真出图是另一刀。
 */

// 三维那一层的**几何**：一格 op（位图那一档要它 —— 见 ADR「位图那 83 个的施工图」
// 第六节）。从前这些内建的函数体只有一句 `asy__add3`，也就是**只吃界、不留图**，
// 于是 `shipout3` 那条路（3D 出位图）无从下手。
// 材质那几个数（p/opacity/shininess/metallic/fresnel0/lightOn/colors）是
// runpicture.in 的签名里本来就有的，一并存下来 —— 以后自己着色要的正是它们。
//
// 表挂在旁边这张登记册上、不放在 `frame` 里：`frame` 定义在这个文件前面，
// 那时 `path3` 与 `triple[][]` 还没有名字（asy 的解析是顺着来的）。
// 帧上只留一个 `f3id`，-1 是"没有三维内容"。
struct drawop3 {
  // 0 = path3 描边，1 = Bezier 面片，2 = 三角面片，3 = 管子（粗线在三维那边的样子）
  int kind = 0;
  path3 g3;
  triple[][] P3;
  triple[] Q3;             // kind 3：管子的中心折线（drawTube 的 g）
  // kind 4：三角网里的**一个**三角（drawTessellation 那条路，runpicture.in:741）。
  // 三个顶点、三个法向（没给法向时空着，用面法向）、三个顶点色（没给时空着）。
  triple[] T3;
  triple[] N3;
  pen[] VC;
  real width = 0;          // kind 3：管子的直径（drawTube 的 width）
  triple center = (0, 0, 0);
  pen[] p;
  pen[] colors;
  bool straight = false;
  bool lightOn = true;
  real opacity = 1;
  real shininess = 0;
  real metallic = 0;
  real fresnel0 = 0;
  int interaction = 0;
}
private drawop3[][] asy__f3tab;
private int asy__f3id(frame f) {
  if (f.f3id < 0) {
    f.f3id = asy__f3tab.length;
    asy__f3tab.push(new drawop3[]);
  }
  return f.f3id;
}
void asy__push3(frame f, drawop3 o) { asy__f3tab[asy__f3id(f)].push(o); }
drawop3[] asy__ops3(frame f) {
  return f.f3id < 0 ? new drawop3[] : asy__f3tab[f.f3id];
}
// 上面那个桩（asy__merge3fn，在 add(frame,frame) / prepend 里被调）接上真身
private void asy__merge3hook() {
  asy__merge3fn = new void(frame dest, frame src) {
    drawop3[] s = asy__ops3(src);
    for (int i = 0; i < s.length; ++i) asy__push3(dest, s[i]);
    // **界那几格也要搬**（原先故意没搬，见 add(frame,frame) 那儿的注释）。
    // 缩到七行的尺子（/tmp/nl/ar3.asy）：子图里一条 30 单位的线经
    // `add(currentpicture, opic, (0.8,0,0))` 加进来，参考的位图是 400x124（31pt 高）、
    // 我们是 404x4（1pt）—— op 表进来了、界没进来，于是整段被裁掉。
    // 链子：three.asy:2396 -> plain_picture.asy:741 的
    // `add(void d(picture,transform3))` -> `add(f, opic.fit3(identity4,pic2,P))`
    // -> 就是这一格 `add(frame,frame)`。asy 那边帧的界是逐个 drawelement 走出来的，
    // 所以合并才是正解。
    if (src.has3) {
      if (!dest.has3) {
        dest.has3 = true;
        dest.min3v = src.min3v; dest.max3v = src.max3v;
        dest.minr = src.minr; dest.maxr = src.maxr;
      } else {
        dest.min3v = minbound(dest.min3v, src.min3v);
        dest.max3v = maxbound(dest.max3v, src.max3v);
        dest.minr = (min(dest.minr.x, src.minr.x), min(dest.minr.y, src.minr.y));
        dest.maxr = (max(dest.maxr.x, src.maxr.x), max(dest.maxr.y, src.maxr.y));
      }
    }
  };
  // 位图那一档的像素（asy__r3hexfn 的真身）：投影照 renderBase.cc:111 的 setDimensions
  // 与 :154 的 setProjection（施工图第八节）。帧坐标已经在视图空间（相机在原点、朝 -z），
  // 不用再乘 modelview。angle 是**度**（three.asy:2908 用度版 aTan/Tan；C 那边
  // renderBase.cc:47 是 `Angle = args.angle * radians`），正交时是 0。
  // 这一刀只画 path3 那一类（面片先不画）—— 线画那一族就能量出效果。
  asy__r3hexfn = new string(frame f, int oW, int oH, int fw, int fh, real angle,
                           real zoom, triple m, triple M, pair shift, real expand,
                           real[][] tv) {
    bool ortho = angle == 0;
    real Zmax = M.z;
    real Hh = ortho ? 0 : -tan(0.5 * angle * pi / 180) * Zmax;
    real aspect = fw / fh;
    real zm = zoom == 0 ? 1 : zoom;
    real zoominv = 1 / zm;
    real xshift = shift.x * zm;
    real yshift = shift.y * zm;
    real xmn; real xmx; real ymn; real ymx;
    if (ortho) {
      real xsize = M.x - m.x;
      real ysize = M.y - m.y;
      if (xsize < ysize * aspect) {
        real r = 0.5 * ysize * aspect * zoominv;
        real X0 = 2 * r * xshift;
        real Y0 = ysize * zoominv * yshift;
        xmn = -r - X0; xmx = r - X0;
        ymn = m.y * zoominv - Y0; ymx = M.y * zoominv - Y0;
      } else {
        real r = 0.5 * xsize * zoominv / aspect;
        real X0 = xsize * zoominv * xshift;
        real Y0 = 2 * r * yshift;
        xmn = m.x * zoominv - X0; xmx = M.x * zoominv - X0;
        ymn = -r - Y0; ymx = r - Y0;
      }
    } else {
      real r = Hh * zoominv;
      real rA = r * aspect;
      real X0 = 2 * rA * xshift;
      real Y0 = 2 * r * yshift;
      xmn = -rA - X0; xmx = rA - X0;
      ymn = -r - Y0; ymx = r - Y0;
    }
    real near = -Zmax;
    real dx = xmx - xmn;
    real dy = ymx - ymn;
    if (dx == 0) dx = 1;
    if (dy == 0) dy = 1;
    pair pj(triple v) {
      // **`tv`（shipout3 收到的 t）不能就这么乘上去**：试过了，billboard 从
      // 45859/446400 变成 443484/446400（首处就是第 0 个像素，整幅都糊了）。
      // 它是 `tinv*inv` 那一对里的一个 —— 帧坐标已经在视图空间，这里不需要它。
      // 曾经把"图偏小"记成这一格公式的事（"差一个均匀的 2.35 倍缩放、从 near/H 那两格查"）
      // —— **那一笔是错的**。把 glFrustum 展开一遍就够了：
      //   screen_x = (x·near/(-z) - xmin) / (xmax - xmin) · W，
      // 而 xmin/xmax = ∓tan(0.5·fov)·|Zmax|·aspect、near = |Zmax| —— Zmax 整格约掉，
      // 只剩 tan(0.5·fov)、zoom、aspect 三个量。偏小的是 **fov**，而 fov 偏大是因为
      // three.asy:2765 的 angle() 收到的 minratio/maxratio 按"界的八个角"算
      // （订正见 `real[][] * frame` 那一处）。订正之后无标签尺子上 ink 占宽
      // 67.7% -> 100.0%（参考 99.2%），这一格公式一个字没动。
      real x = v.x;
      real y = v.y;
      if (!ortho) {
        real d = -v.z;
        if (d < 1e-12) d = 1e-12;
        x = v.x * near / d;
        y = v.y * near / d;
      }
      // **y 要倒过来画。** 位图那一格的行序是**自下而上**（asy 那边是 glReadPixels
      // 读回来的，OpenGL 的第 0 行在下），而 gs 的 ppmraw 是**自上而下**写的。
      // 量出来的（无标签尺子）：原样只有 887/9938 个参考像素落在我们 1px 邻域内，
      // 上下翻过来是 8006/9938。所以不在字节上翻（那要动 95 万个字符），
      // 而是在这一格把图倒着画 —— gs 自上而下写出来的就正好是要的那个序。
      return ((x - xmn) / dx * oW, oH - (y - ymn) / dy * oH);
    }
    string nl = '\n';
    string doc = "%!PS-Adobe-3.0 EPSF-3.0" + nl
      + "%%BoundingBox: 0 0 " + string(oW) + " " + string(oH) + nl
      + "%%EndComments" + nl
      // 线宽取**一个像素**：这一份 EPS 是 oW x oH pt、按 72*expand dpi 光栅化，
      // 所以 1px = 1/expand pt。GL 那边画线是 1 个采样宽，粗一倍就多一圈 ink。
      + ps(1 / expand) + " setlinewidth 1 setlinecap 1 setlinejoin" + nl;
    drawop3[] ops = asy__ops3(f);
    // 量口：op 表头一格的首点（与 m/M 对量级，见 ADR 第八节末）
    asy__r3nops = ops.length;
    if (ops.length > 0) {
      if (ops[0].kind == 0) asy__r3op0 = ops[0].g3.nodes[0].point;
      else if (ops[0].kind == 3) { if (ops[0].Q3.length > 0) asy__r3op0 = ops[0].Q3[0]; }
      else if (ops[0].P3.length > 0 && ops[0].P3[0].length > 0) asy__r3op0 = ops[0].P3[0][0];
    }
    int nink = 0;
    // **所有 op 一起按深度排。** 视图空间里 z 越负越远，画家算法从远画到近；
    // 键取各自控制点/节点 z 的平均（真 asy 那边是 GPU 的 Z-buffer，glrender.cc:1355
    // 只开 GL_DEPTH_TEST、没有 polygon offset）。
    // 原先是"先所有面片、再所有管子、再所有 path3"三趟 —— 那等于把线一律画在最上面，
    // 于是曲面**背面**的网格线也会透出来（sacylinder3D 那种曲面上压网格的例子里，
    // 逐像素采样两侧的高频花纹对不上就是这一处）。
    // 线（kind 0/3）与它贴着的曲面同深度，所以给线一点**朝相机的偏置**：
    // 与曲面共面的网格线仍在上面，真正被挡住的线（深度差远大于偏置）才被盖掉。
    // 偏置取整个场景深度跨度的千分之一（glrender 那边靠的是线与三角形光栅化的差别）。
    real zbias = 0.001 * (M.z - m.z);
    if (zbias <= 0) zbias = 1e-9;
    int[] idx;
    real[] key;
    for (int i = 0; i < ops.length; ++i) {
      real zs = 0;
      int cnt = 0;
      if (ops[i].kind == 0) {
        path3 g = ops[i].g3;
        for (int a = 0; a < g.nodes.length; ++a) { zs = zs + g.nodes[a].point.z; cnt = cnt + 1; }
        zs = zs + zbias * cnt;
      } else if (ops[i].kind == 3) {
        triple[] Q = ops[i].Q3;
        for (int a = 0; a < Q.length; ++a) { zs = zs + Q[a].z; cnt = cnt + 1; }
        zs = zs + zbias * cnt;
      } else if (ops[i].kind == 4) {
        triple[] T = ops[i].T3;
        for (int a = 0; a < T.length; ++a) { zs = zs + T[a].z; cnt = cnt + 1; }
      } else {
        triple[][] P = ops[i].P3;
        for (int a = 0; a < P.length; ++a)
          for (int b = 0; b < P[a].length; ++b) { zs = zs + P[a][b].z; cnt = cnt + 1; }
      }
      if (cnt == 0) continue;
      idx.push(i);
      key.push(zs / cnt);
    }
    // **排序必须是 O(n log n)。** 原先这儿是插入排序 —— AiryDisk 有约 16 万片面片，
    // 那是 1.3e10 次搬动，量出来这一格吃掉约 35s（整条位图路 73s 里的大头；
    // gs 自己只 0.75s，字符串拼接与 `string(x,9)` 各自 150 万次也只有 1~2s）。
    // 换成自底向上的归并（稳定，与插入排序在等键时的次序一致）。
    int m = idx.length;
    if (m > 1) {
      int[] ti = new int[m];
      real[] tk = new real[m];
      int w = 1;
      while (w < m) {
        int lo = 0;
        while (lo < m) {
          int mid = lo + w;
          int hi = mid + w;
          if (mid > m) mid = m;
          if (hi > m) hi = m;
          int a = lo; int b = mid; int o = lo;
          while (a < mid && b < hi) {
            if (key[b] < key[a]) { ti[o] = idx[b]; tk[o] = key[b]; b = b + 1; }
            else { ti[o] = idx[a]; tk[o] = key[a]; a = a + 1; }
            o = o + 1;
          }
          while (a < mid) { ti[o] = idx[a]; tk[o] = key[a]; a = a + 1; o = o + 1; }
          while (b < hi) { ti[o] = idx[b]; tk[o] = key[b]; b = b + 1; o = o + 1; }
          lo = lo + 2 * w;
        }
        for (int i = 0; i < m; ++i) { idx[i] = ti[i]; key[i] = tk[i]; }
        w = 2 * w;
      }
    }
    // 面片：把边界那四条三次曲线投出来填平色。**平色不是着色** —— 真 asy 那边是
    // PBR 的片元着色，这一刀只把"哪儿有东西、什么颜色"落到位图上。
    // 这一格的颜色取哪一支笔：`material.p` 是 `{diffuse, emissive, specular}`
    // （three.asy 的 struct material）。**不点灯的那一族用 emissive** —— three.asy
    // 画细线/管子时是 `emissive(p)`，diffuse 是黑的。量出来的（/tmp/nl/col.asy，
    // `draw((0,0,0)--(1,0,0),blue+8)`）：`p0=0,0,0  p1=0,0,255  p2=0,0,0`，
    // 而参考的位图里就是**平的** `0,0,255`（不带光照）。原先一律取 p[0]，
    // 于是整族画成黑的（`0,0,0`×24123 对参考的 `0,0,255`×11282 + `255,0,0`×11128）。
    //
    // **着光那一支照 base/shaders/GL/fragment.glsl 逐字转写**（:155 NDF_TRG、
    // :163 GGX_Geom、:171 Geom、:177 Fresnel、:184 BRDF、:209-245 main）。
    // 粗糙度照 vertex.glsl:96-97：`Roughness = 1 - shininess`、`Roughness2 = Roughness^2`。
    // 光的方向与颜色是 shipout3 收到的 `Light.position`/`Light.diffuse`（三维那两格
    // 全局量）—— 位置在 plain_prethree.asy:187 已经 unit 过，glrender.cc:931-937
    // 原样发给 shader，不再乘视图变换。
    // 与真 asy 只差**一片一色**：那边是逐片元，这边每片算一次（法向取面片中心）。
    // `gl_FrontFacing`（:225）这一层没有正反面，等价的做法是把法向翻到朝观察者。
    int nlt = asy__r3lights.length;
    triple cross3(triple a, triple b) {
      return (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
    }
    real mx0(real a) { return a > 0 ? a : 0; }
    real[] shadeop(drawop3 o, triple nrm, triple pos) {
      real[] em = o.p.length > 1 ? asy__penrgb(o.p[1]) : new real[] {0, 0, 0};
      if (o.p.length == 0) return new real[] {0, 0, 0};
      if (!o.lightOn || nlt == 0) return em;
      real[] Dif = asy__penrgb(o.p[0]);
      real[] Spc = o.p.length > 2 ? asy__penrgb(o.p[2]) : new real[] {0, 0, 0};
      real R2 = (1 - o.shininess) * (1 - o.shininess);
      real alpha2 = R2 * R2;
      real ap = 1 + R2;
      real kg = 0.125 * ap * ap;
      triple vd = ortho ? (0, 0, 1) : -unit(pos);
      // fragment.glsl:224 的 `normal=normalize(Normal)` —— **这一句不能漏**：
      // 面片中心的法向是叉乘出来的，长度是任意的，不归一化整条 BRDF 全走偏
      // （量出来的样子是 cosTheta 上千、整面片压成饱和色）。
      real nl = length(nrm);
      if (nl == 0) return em;
      triple n = (1 / nl) * nrm;
      if (dot(n, vd) < 0) n = -n;
      real[] c = new real[] {em[0], em[1], em[2]};
      real omegain = mx0(dot(vd, n));
      real Gv = omegain / (omegain * (1 - kg) + kg);
      for (int i = 0; i < nlt; ++i) {
        triple L = asy__r3lights[i];
        real cosTheta = mx0(dot(n, L));
        if (cosTheta == 0) continue;
        real[] lc = asy__r3ldiff[i];
        triple h = unit(L + vd);
        real ndoth = mx0(dot(n, h));
        real den = ndoth * ndoth * (alpha2 - 1) + 1;
        real D = den != 0 ? alpha2 / (den * den) : 0;
        real omegaln = cosTheta;
        real G = Gv * (omegaln / (omegaln * (1 - kg) + kg));
        real fa = 1 - mx0(dot(h, vd));
        real fb = fa * fa;
        real F = o.fresnel0 + (1 - o.fresnel0) * fb * fb * fa;
        real denom = 4 * omegain * omegaln;
        real raw = denom > 0 ? (D * G) / denom : 0;
        for (int j = 0; j < 3; ++j) {
          real diel = Dif[j] + (raw * Spc[j] - Dif[j]) * F;
          real brdf = diel + (raw * Dif[j] - diel) * o.metallic;
          c[j] = c[j] + brdf * cosTheta * lc[j];
        }
      }
      return c;
    }
    // 透明那一档：GL 那边是 source-over（fragment.glsl:245 的 `vec4(color,diffuse.a)`
    // 加 glrender.cc:1099 那一趟 blend），`alpha*src + (1-alpha)*dst`。
    // 两侧对照的尺子（一块正对相机的面片）：不透明两侧都是 `1,183,1`，
    // 加 `opacity(0.5)` 之后参考是 `128,219,128` —— 正好 `0.5*src + 0.5*255`。
    // **dst 这一层拿不到**：PostScript 没有 alpha，gs 10 的 PS 解释器也不认
    // `.setfillconstantalpha`（量过，undefined）。所以拿**画布底色**当 dst ——
    // 底下没别的东西时逐字节对得上，几层透明面叠着时偏保守。
    real[] shade(drawop3 o, triple nrm, triple pos) {
      real[] c = shadeop(o, nrm, pos);
      real al = o.opacity;
      if (al >= 1) return c;
      if (al < 0) al = 0;
      return new real[] {al * c[0] + (1 - al) * asy__r3bg[0],
                         al * c[1] + (1 - al) * asy__r3bg[1],
                         al * c[2] + (1 - al) * asy__r3bg[2]};
    }
    // 四个角上的法向照 bezierpatch.h:45 的 `normal()`：一阶 `3(left1-middle) x
    // 3(right1-middle)` 不够就退二阶（bezierPP）、三阶（bezierPPP，triple.h:417/423）。
    triple nrm7(triple l3, triple l2, triple l1, triple mid,
                triple r1, triple r2, triple r3, real eps) {
      triple lp = 3 * (l1 - mid);
      triple rp = 3 * (r1 - mid);
      triple n = cross3(rp, lp);
      if (dot(n, n) > eps) return n;
      triple lpp = 3 * (mid + l2) - 6 * l1;
      triple rpp = 3 * (mid + r2) - 6 * r1;
      n = cross3(rpp, lp) + cross3(rp, lpp);
      if (dot(n, n) > eps) return n;
      triple lppp = l3 - mid + 3 * (l1 - l2);
      triple rppp = r3 - mid + 3 * (r1 - r2);
      n = cross3(rpp, lpp) + cross3(rppp, lp) + cross3(rp, lppp);
      if (dot(n, n) > eps) return n;
      n = cross3(rppp, lpp) + cross3(rpp, lppp);
      if (dot(n, n) > eps) return n;
      return cross3(rppp, lppp);
    }
    // bezierpatch.cc:70-73 的 epsilon：控制点到 p[0] 的最大距离平方乘 DBL_EPSILON
    real ceps(triple[][] P, int rows) {
      triple p0 = P[0][0];
      real e = 0;
      for (int i = 0; i < rows; ++i)
        for (int j = 0; j < P[i].length; ++j) {
          triple d = P[i][j] - p0;
          real q = dot(d, d);
          if (q > e) e = q;
        }
      return e * 2.220446049250313e-16;
    }
    // 四边面片四个角的法向（bezierpatch.cc:79-101，含两级退路）。
    // 次序与下面 /ShadingType 7 的 c1..c4 对齐：p0、p12、p15、p3。
    triple[] corner4(triple[][] P) {
      triple p0 = P[0][0]; triple p3 = P[0][3];
      triple p12 = P[3][0]; triple p15 = P[3][3];
      real eps = ceps(P, 4);
      triple n0 = nrm7(p3, P[0][2], P[0][1], p0, P[1][0], P[2][0], p12, eps);
      if (dot(n0, n0) <= eps) {
        n0 = nrm7(p3, P[0][2], P[0][1], p0, P[3][1], P[3][2], p15, eps);
        if (dot(n0, n0) <= eps)
          n0 = nrm7(p15, P[2][3], P[1][3], p3, P[1][0], P[2][0], p12, eps);
      }
      triple n1 = nrm7(p0, P[1][0], P[2][0], p12, P[3][1], P[3][2], p15, eps);
      if (dot(n1, n1) <= eps) {
        n1 = nrm7(p0, P[1][0], P[2][0], p12, P[2][3], P[1][3], p3, eps);
        if (dot(n1, n1) <= eps)
          n1 = nrm7(p3, P[0][2], P[0][1], p0, P[3][1], P[3][2], p15, eps);
      }
      triple n2 = nrm7(p12, P[3][1], P[3][2], p15, P[2][3], P[1][3], p3, eps);
      if (dot(n2, n2) <= eps) {
        n2 = nrm7(p12, P[3][1], P[3][2], p15, P[0][2], P[0][1], p0, eps);
        if (dot(n2, n2) <= eps)
          n2 = nrm7(p0, P[1][0], P[2][0], p12, P[2][3], P[1][3], p3, eps);
      }
      triple n3 = nrm7(p15, P[2][3], P[1][3], p3, P[0][2], P[0][1], p0, eps);
      if (dot(n3, n3) <= eps) {
        n3 = nrm7(p15, P[2][3], P[1][3], p3, P[1][0], P[2][0], p12, eps);
        if (dot(n3, n3) <= eps)
          n3 = nrm7(p12, P[3][1], P[3][2], p15, P[0][2], P[0][1], p0, eps);
      }
      return new triple[] {n0, n1, n2, n3};
    }
    // 三角面片三个角的法向（bezierpatch.cc:573-575）。十个点按行长 1/2/3/4 排，
    // 与 p[0..9] 的对应是 P[0][0]=p0、P[1][0]=p1、P[1][1]=p2、P[2][*]=p3..p5、P[3][*]=p6..p9。
    triple[] corner3(triple[][] P) {
      triple p0 = P[0][0]; triple p6 = P[3][0]; triple p9 = P[3][3];
      real eps = ceps(P, 4);
      return new triple[] {
        nrm7(p9, P[2][2], P[1][1], p0, P[1][0], P[2][0], p6, eps),
        nrm7(p0, P[1][0], P[2][0], p6, P[3][1], P[3][2], p9, eps),
        nrm7(p6, P[3][1], P[3][2], p9, P[2][2], P[1][1], p0, eps)};
    }
    string setrgb(real[] c) {
      real r = c[0] < 0 ? 0 : (c[0] > 1 ? 1 : c[0]);
      real g = c[1] < 0 ? 0 : (c[1] > 1 ? 1 : c[1]);
      real b = c[2] < 0 ? 0 : (c[2] > 1 ? 1 : c[2]);
      return ps(r) + " " + ps(g) + " " + ps(b) + " setrgbcolor" + nl;
    }
    // 一片一个平色不够：真 asy 是逐片元着色。这一层能给到的最接近的形状是 PostScript
    // 的**张量面片着色**（/ShadingType 7，psfile.cc:451 那一格 —— asy 自己矢量那条路
    // 画曲面用的就是它）：十六个控制点原样投下去，四个角各算一次 BRDF，片内由
    // gs 按双线性补齐。几何还是同一条曲边（与从前那句 `fill` 一样），颜色从平色
    // 变成了渐变。DataSource 的次序照 tenshade：边标记 0、**倒着走**的十二个边界点、
    // 四个内部点、四个角的颜色（c1=p11、c2=p14、c3=p44、c4=p41）。
    string wp(triple v) { pair q = pj(v); return " " + ps(q.x) + " " + ps(q.y); }
    string wc(real[] c) {
      real r = c[0] < 0 ? 0 : (c[0] > 1 ? 1 : c[0]);
      real g = c[1] < 0 ? 0 : (c[1] > 1 ? 1 : c[1]);
      real b = c[2] < 0 ? 0 : (c[2] > 1 ? 1 : c[2]);
      return " " + ps(r) + " " + ps(g) + " " + ps(b);
    }
    // 一条三次 Bezier 在 t=1/2 处对半分（bound.h:16 的 Split 同一套七个点）：
    // 左半是 z0,m0,m3,m5，右半是 m5,m4,m2,z1。
    triple[] splitc(triple z0, triple c0, triple c1, triple z1) {
      triple m0 = 0.5 * (z0 + c0); triple m1 = 0.5 * (c0 + c1);
      triple m2 = 0.5 * (c1 + z1);
      triple m3 = 0.5 * (m0 + m1); triple m4 = 0.5 * (m1 + m2);
      triple m5 = 0.5 * (m3 + m4);
      return new triple[] {z0, m0, m3, m5, m4, m2, z1};
    }
    // 一块面片对半分成四块（先按行分 u、再按列分 v）
    triple[][][] split4(triple[][] Q) {
      triple[][] L; triple[][] R;
      for (int i = 0; i < 4; ++i) {
        triple[] s = splitc(Q[i][0], Q[i][1], Q[i][2], Q[i][3]);
        L.push(new triple[] {s[0], s[1], s[2], s[3]});
        R.push(new triple[] {s[3], s[4], s[5], s[6]});
      }
      triple[][][] out;
      triple[][][] half = new triple[][][] {L, R};
      for (int k = 0; k < 2; ++k) {
        triple[][] H = half[k];
        triple[][] A; triple[][] B;
        for (int j = 0; j < 4; ++j) {
          triple[] s = splitc(H[0][j], H[1][j], H[2][j], H[3][j]);
          A.push(new triple[] {s[0], s[1], s[2], s[3]});
          B.push(new triple[] {s[3], s[4], s[5], s[6]});
        }
        // A/B 现在是「列优先」的（A[j][i]），转回 A[i][j]
        triple[][] A2; triple[][] B2;
        for (int i = 0; i < 4; ++i) {
          triple[] ra; triple[] rb;
          for (int j = 0; j < 4; ++j) { ra.push(A[j][i]); rb.push(B[j][i]); }
          A2.push(ra); B2.push(rb);
        }
        out.push(A2); out.push(B2);
      }
      return out;
    }
    // 一块面片的着色记录（/ShadingType 7）
    string sh7(drawop3 o, triple[][] Q) {
      triple[] cn = corner4(Q);
      return "<< /ShadingType 7 /ColorSpace /DeviceRGB /DataSource [ 0"
        + wp(Q[0][0]) + wp(Q[1][0]) + wp(Q[2][0])
        + wp(Q[3][0]) + wp(Q[3][1]) + wp(Q[3][2])
        + wp(Q[3][3]) + wp(Q[2][3]) + wp(Q[1][3])
        + wp(Q[0][3]) + wp(Q[0][2]) + wp(Q[0][1])
        + wp(Q[1][1]) + wp(Q[2][1]) + wp(Q[2][2]) + wp(Q[1][2])
        + wc(shade(o, cn[0], Q[0][0])) + wc(shade(o, cn[1], Q[3][0]))
        + wc(shade(o, cn[2], Q[3][3])) + wc(shade(o, cn[3], Q[0][3]))
        + " ] >> shfill" + nl;
    }
    // 管子（kind == 3）与 path3（kind == 0）这两支**也要用各自的笔色**。
    // 原先这儿是一句 `0 setgray` 把后面全画成黑的 —— 量出来的（/tmp/nl/col.asy：
    // `draw((0,0,0)--(1,0,0),blue+8)` 与 `red+8`）：参考的位图里是
    // `0,0,255`×11282 与 `255,0,0`×11128（**平色、不带光照**），我们那边是
    // `0,0,0`×24123，一片黑。
    // 着光的那一支（`lightOn`）法向取**朝观察者** —— 管子在 GL 那边是实体，
    // 退成一条描边之后能给的最接近的形状就是正中那条母线（法向正对相机）。
    real[] shadeline(drawop3 o, triple pos) {
      triple vd = ortho ? (0, 0, 1) : -unit(pos);
      return shade(o, vd, pos);
    }
    for (int a = 0; a < idx.length; ++a) {
      drawop3 o3 = ops[idx[a]];
      // **看不见的笔一格都不画**（pen.h 的 INVISIBLE 颜色空间）。量出来的：
      // `draw((-1,-1,0)--(-1,-1,0),invisible)` 在参考的位图里什么都没有，
      // 我们那边却落了几点近黑（管子与它的球帽照旧出几何、着色又给了颜色）。
      if (o3.p.length > 0 && o3.p[0].isinvisible) continue;
      if (o3.kind == 3) {
        triple[] Q = o3.Q3;
        if (Q.length < 2) continue;
        doc = doc + setrgb(shadeline(o3, Q[Q.length # 2]));
        pair a0 = pj(Q[0]);
        doc = doc + ps(a0.x) + " " + ps(a0.y) + " moveto" + nl;
        for (int k = 1; k < Q.length; ++k) {
          pair pk = pj(Q[k]);
          doc = doc + ps(pk.x) + " " + ps(pk.y) + " lineto" + nl;
        }
        doc = doc + "stroke" + nl;
        nink = nink + 1;
        continue;
      }
      if (o3.kind == 0) {
        path3 g = o3.g3;
        int n = g.nodes.length;
        if (n < 2) continue;
        doc = doc + setrgb(shadeline(o3, g.nodes[n # 2].point));
        pair a0 = pj(g.nodes[0].point);
        doc = doc + ps(a0.x) + " " + ps(a0.y) + " moveto" + nl;
        for (int k = 1; k < n; ++k) {
          pair c1 = pj(g.nodes[k - 1].post);
          pair c2 = pj(g.nodes[k].pre);
          pair pk = pj(g.nodes[k].point);
          doc = doc + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(pk.x) + " " + ps(pk.y) + " curveto" + nl;
        }
        doc = doc + "stroke" + nl;
        nink = nink + 1;
        continue;
      }
      // 三角网那一族（kind 4，drawTessellation 那条路）：直边三角，
      // 三个顶点各算一次 BRDF，/ShadingType 4 在片内线性插值 —— 与 GL 那边
      // 逐片元的差别只剩片内那一点非线性。顶点色（Gouraud）顶掉 diffuse
      // （fragment.glsl 的 COLOR 那一支是 `diffuse=color`，不点灯时当 emissive）。
      if (o3.kind == 4) {
        triple[] T = o3.T3;
        if (T.length < 3) continue;
        triple fn = cross3(T[1] - T[0], T[2] - T[0]);
        real[][] cc;
        for (int j = 0; j < 3; ++j) {
          triple nj = o3.N3.length == 3 ? o3.N3[j] : fn;
          if (o3.VC.length == 3) {
            drawop3 q;
            q.kind = o3.kind;
            q.p = new pen[] {o3.VC[j],
                             o3.lightOn ? (o3.p.length > 1 ? o3.p[1] : black) : o3.VC[j],
                             o3.p.length > 2 ? o3.p[2] : black};
            q.lightOn = o3.lightOn;
            q.opacity = o3.opacity;
            q.shininess = o3.shininess;
            q.metallic = o3.metallic;
            q.fresnel0 = o3.fresnel0;
            cc.push(shade(q, nj, T[j]));
          } else cc.push(shade(o3, nj, T[j]));
        }
        doc = doc + "<< /ShadingType 4 /ColorSpace /DeviceRGB /DataSource [ 0"
          + wp(T[0]) + wc(cc[0]) + " 0" + wp(T[1]) + wc(cc[1])
          + " 0" + wp(T[2]) + wc(cc[2]) + " ] >> shfill" + nl;
        nink = nink + 1;
        continue;
      }
      triple[][] P = o3.P3;
      void edge(triple c1, triple c2, triple e) {
        pair a1 = pj(c1); pair a2 = pj(c2); pair a3 = pj(e);
        doc = doc + ps(a1.x) + " " + ps(a1.y) + " " + ps(a2.x) + " " + ps(a2.y)
          + " " + ps(a3.x) + " " + ps(a3.y) + " curveto" + nl;
      }
      // **三角面片（kind == 2）的控制点是三角排布**：四行、长度 1/2/3/4（十个点）。
      // 量出来的：`draw(f,unitbox)` 在 render!=0 时是 kind0=4、kind1=48、**kind2=1024**
      // —— 粗线在三维那边是当**管子**画的（12 条棱的侧面是四边面片，接头的球帽是
      // 三角面片）。按 4x4 那套下标去读三角面片会整格漏掉，所以分开写。
      if (o3.kind == 2) {
        if (P.length < 4 || P[3].length < 4) continue;
        bool lit = o3.lightOn && nlt > 0 && o3.p.length > 0;
        // 曲边先当裁剪框（几何一个字不动），再用 /ShadingType 4 的三角网上色。
        // 三角网的边是直的，铺不满曲边那圈鼓出去的地方 —— 所以把三个角**从重心
        // 向外放大**再画：颜色在三角形上是线性的，顶点按同一个倍数外推颜色，
        // 片内那一份场一点不变（越界的那几格由 clamp 收回来）。
        if (lit) doc = doc + "gsave" + nl;
        doc = doc + (lit ? "" : setrgb(shade(o3, (0, 0, 1), (0, 0, 0))));
        pair t00 = pj(P[0][0]);
        doc = doc + ps(t00.x) + " " + ps(t00.y) + " moveto" + nl;
        edge(P[1][0], P[2][0], P[3][0]);
        edge(P[3][1], P[3][2], P[3][3]);
        edge(P[2][2], P[1][1], P[0][0]);
        if (!lit) { doc = doc + "closepath fill" + nl; nink = nink + 1; continue; }
        doc = doc + "closepath clip" + nl;
        triple[] nn = corner3(P);
        triple A = P[0][0]; triple B = P[3][0]; triple C = P[3][3];
        real[] cA = shade(o3, nn[0], A);
        real[] cB = shade(o3, nn[1], B);
        real[] cC = shade(o3, nn[2], C);
        triple ctr = (1.0 / 3.0) * (A + B + C);
        real s = 1.6;
        real[] cbar = new real[] {(cA[0] + cB[0] + cC[0]) / 3,
                                  (cA[1] + cB[1] + cC[1]) / 3,
                                  (cA[2] + cB[2] + cC[2]) / 3};
        real[] xA = new real[3]; real[] xB = new real[3]; real[] xC = new real[3];
        for (int j = 0; j < 3; ++j) {
          xA[j] = cbar[j] + s * (cA[j] - cbar[j]);
          xB[j] = cbar[j] + s * (cB[j] - cbar[j]);
          xC[j] = cbar[j] + s * (cC[j] - cbar[j]);
        }
        doc = doc + "<< /ShadingType 4 /ColorSpace /DeviceRGB /DataSource [ 0"
          + wp(ctr + s * (A - ctr)) + wc(xA) + " 0"
          + wp(ctr + s * (B - ctr)) + wc(xB) + " 0"
          + wp(ctr + s * (C - ctr)) + wc(xC) + " ] >> shfill" + nl + "grestore" + nl;
        nink = nink + 1;
        continue;
      }
      if (P.length < 4 || P[0].length < 4) continue;
      if (!(o3.lightOn && nlt > 0 && o3.p.length > 0)) {
        doc = doc + setrgb(shade(o3, (0, 0, 1), (0, 0, 0)));
        pair q00 = pj(P[0][0]);
        doc = doc + ps(q00.x) + " " + ps(q00.y) + " moveto" + nl;
        edge(P[0][1], P[0][2], P[0][3]);
        edge(P[1][3], P[2][3], P[3][3]);
        edge(P[3][2], P[3][1], P[3][0]);
        edge(P[2][0], P[1][0], P[0][0]);
        doc = doc + "closepath fill" + nl;
        nink = nink + 1;
        continue;
      }
      // 片内的镜面高光是**尖的**：一块面片只在四个角上取色，屏幕上很大的那些面片
      // 会把高光那一道整格抹平（量出来的样子：sacylinder3D 绿通道对得上、红蓝两通道
      // 少 30 —— 少的正是镜面那一份）。真 asy 在 GPU 那边是按 `res` 把面片细分到
      // 一像素以内再逐片元着色（bezierpatch.cc 的 init(res)/render），这一层照同一个
      // 判据来：**按投影后的屏幕尺寸**对半细分，每块子面片自己算角上的法向与颜色。
      // 小面片（AiryDisk 那 16 万块，每块只几个像素）一次都不分，开销不变。
      real xlo = 0; real xhi = 0; real ylo = 0; real yhi = 0;
      for (int i = 0; i < 4; ++i)
        for (int j = 0; j < 4; ++j) {
          pair q = pj(P[i][j]);
          if (i == 0 && j == 0) { xlo = q.x; xhi = q.x; ylo = q.y; yhi = q.y; }
          else {
            if (q.x < xlo) xlo = q.x; if (q.x > xhi) xhi = q.x;
            if (q.y < ylo) ylo = q.y; if (q.y > yhi) yhi = q.y;
          }
        }
      real sz = (xhi - xlo) > (yhi - ylo) ? xhi - xlo : yhi - ylo;
      int lev = 0;
      while (sz > 8 && lev < 3) { sz = 0.5 * sz; lev = lev + 1; }
      triple[][][] cur = new triple[][][] {P};
      for (int L = 0; L < lev; ++L) {
        triple[][][] nxt;
        for (int i = 0; i < cur.length; ++i) {
          triple[][][] four = split4(cur[i]);
          for (int k = 0; k < 4; ++k) nxt.push(four[k]);
        }
        cur = nxt;
      }
      for (int i = 0; i < cur.length; ++i) doc = doc + sh7(o3, cur[i]);
      nink = nink + 1;
    }
    doc = doc + "showpage" + nl + "%%EOF" + nl;
    if (nink == 0) return "";
    // P6 的头是 `P6\n<w> <h>\n255\n`，长度按实际数字位数算；`xxd -p | tr -d` 那一步
    // 让 shell 把字节转成 ASCII —— `_readtext` 是按 utf8 读的，二进制读不回来。
    // P6 的头**不是**固定长度：gs 会多写一行 `# Image generated …` 的注释
    // （量出来的：446468 字节的 ppm 里头占 68 个，按 `P6\n<w> <h>\n255\n` 算只有 15）。
    // 所以不算头长，直接取**最后** w*h*3 个字节 —— 那一定是像素。
    string dir = "/tmp/omni-r3";
    int nbytes = fw * fh * 3;
    if (_runproc("mkdir -p " + dir + " && rm -f " + dir + "/r3.*") != 0) return "";
    _writetext(dir + "/r3.eps", doc);
    if (_runproc("cd " + dir + " && gs -q -dNOPAUSE -dBATCH"
          + " -sDEVICE=ppmraw -g" + string(fw) + "x" + string(fh)
          + " -r" + string((int) (72 * expand))
          // **要反锯齿**：参考那一侧的边是带灰阶的（量出来的一行剖面：
          // 239 207 159 111 79 32 32 64 95 159 191 223），GL 那边开着多重采样；
          // gs 默认是硬边（我们那一行全是 0）。少了这一格，每条棱两侧都多算一圈差。
          + " -dGraphicsAlphaBits=4 -dTextAlphaBits=4"
          + " -sOutputFile=r3.ppm r3.eps 2>/dev/null"
          + " && tail -c " + string(nbytes) + " r3.ppm | xxd -p | tr -d '\n' > r3.hex") != 0)
      return "";
    return _readtext(dir + "/r3.hex");
  };
}
asy__merge3hook();

// bound.h:16 的 Split 的 triple 版（标量版与其余那几格在文件前面，`minbezier` 要它）
private triple[] asy__split3(triple z0, triple c0, triple c1, triple z1) {
  triple m0 = 0.5 * (z0 + c0);
  triple m1 = 0.5 * (c0 + c1);
  triple m2 = 0.5 * (c1 + z1);
  triple m3 = 0.5 * (m0 + m1);
  triple m4 = 0.5 * (m1 + m2);
  triple m5 = 0.5 * (m3 + m4);
  return new triple[] {m0, m1, m2, m3, m4, m5};
}

void asy__add3(frame f, triple v)
{
  real rx = v.z == 0 ? 0 : v.x / v.z;
  real ry = v.z == 0 ? 0 : v.y / v.z;
  if (!f.has3) {
    f.has3 = true;
    f.min3v = v; f.max3v = v;
    f.minr = (rx, ry); f.maxr = (rx, ry);
    return;
  }
  f.min3v = minbound(f.min3v, v);
  f.max3v = maxbound(f.max3v, v);
  f.minr = (min(f.minr.x, rx), min(f.minr.y, ry));
  f.maxr = (max(f.maxr.x, rx), max(f.maxr.y, ry));
}

private void asy__add3(frame f, triple[] v)
{
  for (int i = 0; i < v.length; ++i) asy__add3(f, v[i]);
}

private void asy__add3(frame f, triple[][] v)
{
  for (int i = 0; i < v.length; ++i) asy__add3(f, v[i]);
}

private void asy__add3(frame f, path3 g)
{
  for (int i = 0; i < g.nodes.length; ++i) {
    asy__add3(f, g.nodes[i].point);
    asy__add3(f, g.nodes[i].pre);
    asy__add3(f, g.nodes[i].post);
  }
}

// 四边面片那一格的**界**（drawsurface.cc:72）：直面片只取四个角，其余对 x/y/z
// 三个分量各跑一遍细分，fuzz 是 `Fuzz*norm(c,16)`（L∞ 范数），每个分量各自算。
// 原先这儿走的是 `asy__add3(f, P)`（控制点凸包）—— 凸包偏大。量出来（cylinder）：
// 位图从 412x400 变成 412x404，**高对上了参考的 404**；宽还是 412 对 404，
// 那 8px（2pt）另有来处（见 ADR「界那一侧」）。
private void asy__addpatch3(frame f, triple[][] P, bool straight)
{
  if (P.length < 4 || P[0].length < 4 || P[3].length < 4) { asy__add3(f, P); return; }
  if (straight) {
    asy__add3(f, P[0][0]);
    asy__add3(f, P[0][3]);
    asy__add3(f, P[3][0]);
    asy__add3(f, P[3][3]);
    return;
  }
  real[] cx; real[] cy; real[] cz;
  for (int i = 0; i < 4; ++i)
    for (int j = 0; j < 4; ++j) {
      triple v = P[i][j];
      cx.push(v.x); cy.push(v.y); cz.push(v.z);
    }
  real fx = asy__Fuzz * asy__norminf(cx);
  real fy = asy__Fuzz * asy__norminf(cy);
  real fz = asy__Fuzz * asy__norminf(cz);
  // **种子要用帧上已经攒到的界，不是这一片自己的第一个控制点。** asy 那边
  // `bounds(t, bbox3& b)` 收的就是**累积**的盒子（drawsurface.cc:72），
  // `bound()` 的终止判据是 `m(-1,1)*(b - controlbound) >= -fuzz` ——
  // 有了累积的界，绝大多数面片在**第 0 层**就返回了，只有真正撑出界的那几片才细分。
  // 用这一片自己的点当种子，等于每片都从零开始往下切：量出来 AiryDisk 从 13s 变几十秒。
  real sx = f.has3 ? f.min3v.x : cx[0]; real sX = f.has3 ? f.max3v.x : cx[0];
  real sy = f.has3 ? f.min3v.y : cy[0]; real sY = f.has3 ? f.max3v.y : cy[0];
  real sz = f.has3 ? f.min3v.z : cz[0]; real sZ = f.has3 ? f.max3v.z : cz[0];
  real x = asy__sbound(cx, false, sx, fx, asy__rmaxdepth);
  real X = asy__sbound(cx, true, sX, fx, asy__rmaxdepth);
  real y = asy__sbound(cy, false, sy, fy, asy__rmaxdepth);
  real Y = asy__sbound(cy, true, sY, fy, asy__rmaxdepth);
  real z = asy__sbound(cz, false, sz, fz, asy__rmaxdepth);
  real Z = asy__sbound(cz, true, sZ, fz, asy__rmaxdepth);
  asy__add3(f, (x, y, z));
  asy__add3(f, (X, Y, Z));
}

// 三角面片那一格的界（drawsurface.cc 里 drawBezierTriangle::bounds，与四边那格同构：
// 直面片只取三个角 0/6/9，其余对 x/y/z 各跑一遍 boundtri）
private void asy__addtri3(frame f, triple[][] P, bool straight)
{
  real[] cx; real[] cy; real[] cz;
  for (int i = 0; i < P.length; ++i)
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      cx.push(v.x); cy.push(v.y); cz.push(v.z);
    }
  if (cx.length != 10) { asy__add3(f, P); return; }
  if (straight) {
    asy__add3(f, (cx[0], cy[0], cz[0]));
    asy__add3(f, (cx[6], cy[6], cz[6]));
    asy__add3(f, (cx[9], cy[9], cz[9]));
    return;
  }
  real fx = asy__Fuzz * asy__norminf(cx);
  real fy = asy__Fuzz * asy__norminf(cy);
  real fz = asy__Fuzz * asy__norminf(cz);
  // 种子同上：用帧上累积的界，绝大多数三角面片在第 0 层就返回
  real sx = f.has3 ? f.min3v.x : cx[0]; real sX = f.has3 ? f.max3v.x : cx[0];
  real sy = f.has3 ? f.min3v.y : cy[0]; real sY = f.has3 ? f.max3v.y : cy[0];
  real sz = f.has3 ? f.min3v.z : cz[0]; real sZ = f.has3 ? f.max3v.z : cz[0];
  asy__add3(f, (asy__sboundtri(cx, false, sx, fx, asy__rmaxdepth),
                asy__sboundtri(cy, false, sy, fy, asy__rmaxdepth),
                asy__sboundtri(cz, false, sz, fz, asy__rmaxdepth)));
  asy__add3(f, (asy__sboundtri(cx, true, sX, fx, asy__rmaxdepth),
                asy__sboundtri(cy, true, sY, fy, asy__rmaxdepth),
                asy__sboundtri(cz, true, sZ, fz, asy__rmaxdepth)));
}

/* Bezier 曲线（runpicture.in:648） */
void _draw(frame f, path3 g, triple center = (0, 0, 0), pen[] p,
           real opacity, real shininess, real metallic, real fresnel0,
           int interaction = 0)
{
  asy__add3(f, g);
  drawop3 o;
  o.kind = 0;
  o.g3 = g;
  o.center = center;
  o.p = p;
  o.opacity = opacity;
  o.shininess = shininess;
  o.metallic = metallic;
  o.fresnel0 = fresnel0;
  o.interaction = interaction;
  asy__push3(f, o);
}

/* Bezier 面片与三角面片（runpicture.in:660/674） */
void draw(frame f, triple[][] P, triple center, bool straight, pen[] p,
          real opacity, real shininess, real metallic, real fresnel0,
          bool lightOn, pen[] colors, int interaction, int digits,
          bool primitive = false)
{
  asy__addpatch3(f, P, straight);
  drawop3 o;
  o.kind = 1;
  o.P3 = P;
  o.center = center;
  o.straight = straight;
  o.p = p;
  o.opacity = opacity;
  o.shininess = shininess;
  o.metallic = metallic;
  o.fresnel0 = fresnel0;
  o.lightOn = lightOn;
  o.colors = colors;
  o.interaction = interaction;
  asy__push3(f, o);
}

void drawbeziertriangle(frame f, triple[][] P, triple center, bool straight,
                        pen[] p, real opacity, real shininess, real metallic,
                        real fresnel0, bool lightOn, pen[] colors,
                        int interaction, int digits, bool primitive = false)
{
  asy__addtri3(f, P, straight);
  drawop3 o;
  o.kind = 2;
  o.P3 = P;
  o.center = center;
  o.straight = straight;
  o.p = p;
  o.opacity = opacity;
  o.shininess = shininess;
  o.metallic = metallic;
  o.fresnel0 = fresnel0;
  o.lightOn = lightOn;
  o.colors = colors;
  o.interaction = interaction;
  asy__push3(f, o);
}

/* NURBS 曲线与曲面（runpicture.in:687/697） */
void draw(frame f, triple[] P, real[] knot, real[] weights = new real[], pen p)
{
  asy__add3(f, P);
}

void draw(frame f, triple[][] P, real[] uknot, real[] vknot,
          real[][] weights = new real[][], pen[] p, real opacity,
          real shininess, real metallic, real fresnel0, bool lightOn,
          pen[] colors)
{
  asy__add3(f, P);
}

/*
 * 球 / 柱 / 盘（runpicture.in:703-730）：**这三格一点界都不出。**
 *
 * 它们在 asy 那边是 `drawSphere` / `drawCylinder` / `drawDisk`，都从 `drawPRC` 继承
 * （drawsurface.h:400/423），而 `drawPRC` 没有覆写 `bounds` —— `drawElement` 的默认
 * 那一格是**空的**（drawelement.h:126 `virtual void bounds(const double*, bbox3&) {}`），
 * `ratio` 也是空的（:130）。它们是 PRC 专用的原语，界由同一处那份 surface 出。
 *
 * 原先这儿走 `asy__addbox3(f, t)`（把单位立方体八个角过变换塞进界）—— 那是**多加**的，
 * asy 根本没这一份。**量下来一个数都没动**（cylinder / shellsqrtx01 / sacylinder3D
 * 照旧，七个原本"一样"的三维例子重跑后仍"一样"）—— 那三个例子走的不是这条路。
 * 留着是因为它是照 drawPRC 的正解；`asy__addbox3` 因此没人用了，一并删掉。
 */
void drawSphere(frame f, real[][] t, bool half = false, pen[] p, real opacity,
                real shininess, real metallic, real fresnel0, bool lightOn,
                int type)
{
}

void drawCylinder(frame f, real[][] t, pen[] p, real opacity, real shininess,
                  real metallic, real fresnel0, bool lightOn, bool core = false)
{
}

void drawDisk(frame f, real[][] t, pen[] p, real opacity, real shininess,
              real metallic, real fresnel0, bool lightOn)
{
}

void drawTube(frame f, triple[] g, real width, pen[] p, real opacity,
              real shininess, real metallic, real fresnel0, bool lightOn,
              triple min, triple max, bool core = false)
{
  asy__add3(f, min);
  asy__add3(f, max);
  // 粗线在三维那边就是**管子**：几何要留下来（位图那一档要它）。
  // 注意这一条的界是**实参给的** min/max，而 g 是中心折线 —— 两者是不是同一套坐标，
  // 正是"界 ~68 而 op ~0.5"那 x136 的关键（ADR「位图那 83 个」第八节末）。
  drawop3 o;
  o.kind = 3;
  o.Q3 = g;
  o.width = width;
  o.p = p;
  o.opacity = opacity;
  o.shininess = shininess;
  o.metallic = metallic;
  o.fresnel0 = fresnel0;
  o.lightOn = lightOn;
  asy__push3(f, o);
}

/* 一个像素与三角网（runpicture.in:735/741） */
void drawpixel(frame f, triple v, pen p, real width = 1.0)
{
  asy__add3(f, v);
}

void draw(frame f, triple[] v, int[][] vi, triple center = (0, 0, 0),
          triple[] n, int[][] ni, pen[] p, real opacity, real shininess,
          real metallic, real fresnel0, bool lightOn, pen[] c = new pen[],
          int[][] ci = new int[][], int interaction)
{
  asy__add3(f, v);
  // **三角网也要落到位图上**（原先只出界、一个三角都不画）。
  // 这是 drawTessellation 那条路（three_surface.asy:1766）：`render.tessellate` 打开、
  // 曲面带索引时，整张曲面就是这一族三角，一个面片都不出。
  // 一个三角一格 op —— 画家算法要按三角排深度（真 asy 那边是逐片元的 Z-buffer）。
  for (int k = 0; k < vi.length; ++k) {
    if (vi[k].length < 3) continue;
    drawop3 o;
    o.kind = 4;
    o.T3 = new triple[] {v[vi[k][0]], v[vi[k][1]], v[vi[k][2]]};
    if (k < ni.length && ni[k].length >= 3 && n.length > 0)
      o.N3 = new triple[] {n[ni[k][0]], n[ni[k][1]], n[ni[k][2]]};
    if (k < ci.length && ci[k].length >= 3 && c.length > 0)
      o.VC = new pen[] {c[ci[k][0]], c[ci[k][1]], c[ci[k][2]]};
    o.center = center;
    o.p = p;
    o.opacity = opacity;
    o.shininess = shininess;
    o.metallic = metallic;
    o.fresnel0 = fresnel0;
    o.lightOn = lightOn;
    o.interaction = interaction;
    asy__push3(f, o);
  }
}

/* 分组与变换的记号（runpicture.in:296-317）：这一层不分组，所以是空的 */
void _begingroup3(frame f, string name, real compression, real granularity,
                  bool closed, bool tessellate, bool dobreak, bool nobreak,
                  triple center, int interaction) { }
void endgroup3(frame f) { }
void beginTransform(frame f, string geometry = "", string color = "",
                    real duration) { }
void endTransform(frame f) { }

/* x/z 与 y/z 的比（picture.cc:339 的 ratio；投影层的 fit 要它） */
/*
 * `bound` 那一族（bound.cc 与 path3.cc:760..839，逐句照抄）：Bezier 上 x/z 与 y/z 的
 * **真极值**，靠细分求。
 *
 * 为什么必须是它、不能拿控制点凸包顶：x/z 非线性，控制点凸包比真曲面**胖**
 * （管子截面那四个控制点在半径 1.13w 上，真曲面只到 w）。凸包顶喂给
 * three.asy:2765 的 angle()，fov 就偏大、图偏小。量出来的（无标签尺子）：
 * 参考 ≈ 我们 ×0.993 + 1.3，也就是差 0.68% —— 只描中心线时那 ~1.05px 的 x 偏
 * 就是这一格（ADR「位图那 83 个」）。
 *
 * 终止判据里的 `m(-1.0,1.0)` 就是"取 max 时是 +1、取 min 时是 -1"，这里写成 sgn。
 */
private real asy__rf(int which, triple v) { return which == 0 ? v.x / v.z : v.y / v.z; }

// path3.cc:770 的 ratiobound：控制网包围盒的那个"支配顶点"上取 f
private real asy__ratiobound(triple[] P, bool mx, int which) {
  real MX = -P[0].x;
  real MY = -P[0].y;
  real Z = P[0].z;
  real MZ = -Z;
  for (int i = 1; i < P.length; ++i) {
    triple v = P[i];
    MX = asy__rm(mx, MX, -v.x);
    MY = asy__rm(mx, MY, -v.y);
    Z = asy__rm(mx, Z, v.z);
    MZ = asy__rm(mx, MZ, -v.z);
  }
  return asy__rm(mx, asy__rf(which, (-MX, -MY, Z)), asy__rf(which, (-MX, -MY, -MZ)));
}

// path3.cc:760 的 cornerbound（面片的四个角是 0/3/12/15）
private real asy__cornerbound(triple[] P, bool mx, int which) {
  real b = asy__rm(mx, asy__rf(which, P[0]), asy__rf(which, P[3]));
  b = asy__rm(mx, b, asy__rf(which, P[12]));
  return asy__rm(mx, b, asy__rf(which, P[15]));
}

// path3.cc:803 的 bound（十六个控制点的面片）
// path3.cc:803 的 bound（十六个控制点的面片，比那一版）——
private real asy__pbound(triple[] P, bool mx, int which, real b, real fuzz, int depth) {
  real bb = asy__rm(mx, b, asy__cornerbound(P, mx, which));
  real sgn = mx ? 1 : -1;
  if (sgn * (bb - asy__ratiobound(P, mx, which)) >= -fuzz || depth == 0) return bb;
  int d = depth - 1;
  real fz = fuzz * 2;
  triple[] c0 = asy__split3(P[0], P[1], P[2], P[3]);
  triple[] c1 = asy__split3(P[4], P[5], P[6], P[7]);
  triple[] c2 = asy__split3(P[8], P[9], P[10], P[11]);
  triple[] c3 = asy__split3(P[12], P[13], P[14], P[15]);
  triple[] c4 = asy__split3(P[12], P[8], P[4], P[0]);
  triple[] c5 = asy__split3(c3[0], c2[0], c1[0], c0[0]);
  triple[] c6 = asy__split3(c3[3], c2[3], c1[3], c0[3]);
  triple[] c7 = asy__split3(c3[5], c2[5], c1[5], c0[5]);
  triple[] c8 = asy__split3(c3[4], c2[4], c1[4], c0[4]);
  triple[] c9 = asy__split3(c3[2], c2[2], c1[2], c0[2]);
  triple[] c10 = asy__split3(P[15], P[11], P[7], P[3]);
  triple[] s0 = {c4[5], c5[5], c6[5], c7[5], c4[3], c5[3], c6[3], c7[3],
                 c4[0], c5[0], c6[0], c7[0], P[12], c3[0], c3[3], c3[5]};
  bb = asy__pbound(s0, mx, which, bb, fz, d);
  triple[] s1 = {P[0], c0[0], c0[3], c0[5], c4[2], c5[2], c6[2], c7[2],
                 c4[4], c5[4], c6[4], c7[4], c4[5], c5[5], c6[5], c7[5]};
  bb = asy__pbound(s1, mx, which, bb, fz, d);
  triple[] s2 = {c0[5], c0[4], c0[2], P[3], c7[2], c8[2], c9[2], c10[2],
                 c7[4], c8[4], c9[4], c10[4], c7[5], c8[5], c9[5], c10[5]};
  bb = asy__pbound(s2, mx, which, bb, fz, d);
  triple[] s3 = {c7[5], c8[5], c9[5], c10[5], c7[3], c8[3], c9[3], c10[3],
                 c7[0], c8[0], c9[0], c10[0], c3[5], c3[4], c3[2], P[15]};
  return asy__pbound(s3, mx, which, bb, fz, d);
}

// path3.cc:842 / :849（三角面片的三个角 0/6/9，另外七个控制点）
private real asy__cornerboundtri(triple[] P, bool mx, int which) {
  real b = asy__rm(mx, asy__rf(which, P[0]), asy__rf(which, P[6]));
  return asy__rm(mx, b, asy__rf(which, P[9]));
}

// path3.cc:860 的 boundtri（十个控制点的三角面片，比那一版）
// path3.cc:860 的 boundtri（十个控制点的三角面片，比那一版）——
private real asy__pboundtri(triple[] P, bool mx, int which, real b, real fuzz,
                            int depth) {
  real bb = asy__rm(mx, b, asy__cornerboundtri(P, mx, which));
  real sgn = mx ? 1 : -1;
  if (sgn * (bb - asy__ratiobound(P, mx, which)) >= -fuzz || depth == 0) return bb;
  int d = depth - 1;
  real fz = fuzz * 2;
  triple l003 = P[0]; triple p102 = P[1]; triple p012 = P[2]; triple p201 = P[3];
  triple p111 = P[4]; triple p021 = P[5]; triple r300 = P[6]; triple p210 = P[7];
  triple p120 = P[8]; triple u030 = P[9];
  triple u021 = 0.5 * (u030 + p021); triple u120 = 0.5 * (u030 + p120);
  triple p033 = 0.5 * (p021 + p012); triple p231 = 0.5 * (p120 + p111);
  triple p330 = 0.5 * (p120 + p210); triple p123 = 0.5 * (p012 + p111);
  triple l012 = 0.5 * (p012 + l003); triple p312 = 0.5 * (p111 + p201);
  triple r210 = 0.5 * (p210 + r300); triple l102 = 0.5 * (l003 + p102);
  triple p303 = 0.5 * (p102 + p201); triple r201 = 0.5 * (p201 + r300);
  triple u012 = 0.5 * (u021 + p033); triple u210 = 0.5 * (u120 + p330);
  triple l021 = 0.5 * (p033 + l012); triple p4xx = 0.5 * p231 + 0.25 * (p111 + p102);
  triple r120 = 0.5 * (p330 + r210); triple px4x = 0.5 * p123 + 0.25 * (p111 + p210);
  triple pxx4 = 0.25 * (p021 + p111) + 0.5 * p312;
  triple l201 = 0.5 * (l102 + p303); triple r102 = 0.5 * (p303 + r201);
  triple l210 = 0.5 * (px4x + l201); triple r012 = 0.5 * (px4x + r102);
  triple l300 = 0.5 * (l201 + r102);
  triple r021 = 0.5 * (pxx4 + r120); triple u201 = 0.5 * (u210 + pxx4);
  triple r030 = 0.5 * (u210 + r120);
  triple u102 = 0.5 * (u012 + p4xx); triple l120 = 0.5 * (l021 + p4xx);
  triple l030 = 0.5 * (u012 + l021);
  triple l111 = 0.5 * (p123 + l102); triple r111 = 0.5 * (p312 + r210);
  triple u111 = 0.5 * (u021 + p231);
  triple c111 = 0.25 * (p033 + p330 + p303 + p111);
  triple[] L = {l003, l102, l012, l201, l111, l021, l300, l210, l120, l030};
  bb = asy__pboundtri(L, mx, which, bb, fz, d);
  triple[] R = {l300, r102, r012, r201, r111, r021, r300, r210, r120, r030};
  bb = asy__pboundtri(R, mx, which, bb, fz, d);
  triple[] U = {l030, u102, u012, u201, u111, u021, r030, u210, u120, u030};
  bb = asy__pboundtri(U, mx, which, bb, fz, d);
  triple[] C = {r030, u201, r021, u102, c111, r012, l030, l120, l210, l300};
  return asy__pboundtri(C, mx, which, bb, fz, d);
}

// 把两个前向桩装上（`minratio/maxratio(triple[][])` 那两格要它们 —— 见上面的说明）。
// **这两行不许省**：省了就等于那两格回到控制点凸包，而且不会报错。
asy__pboundfn = asy__pbound;
asy__pboundtrifn = asy__pboundtri;

// bound.cc:140 的 bound（一段三次曲线）
private real asy__cbound(triple z0, triple c0, triple c1, triple z1,
                         bool mx, int which, real b, real fuzz, int depth) {
  real bb = asy__rm(mx, b, asy__rm(mx, asy__rf(which, z0), asy__rf(which, z1)));
  real sgn = mx ? 1 : -1;
  triple[] Q = {z0, c0, c1, z1};
  if (sgn * (bb - asy__ratiobound(Q, mx, which)) >= -fuzz || depth == 0) return bb;
  int d = depth - 1;
  real fz = fuzz * 2;
  triple[] s = asy__split3(z0, c0, c1, z1);
  bb = asy__cbound(z0, s[0], s[3], s[5], mx, which, bb, fz, d);
  return asy__cbound(s[5], s[4], s[2], z1, mx, which, bb, fz, d);
}

// 面片（4x4）那一格的比：drawsurface.cc:138。直面片只取四个角，别的十六个都进细分。
private pair asy__patchratio(triple[][] P, bool straight, bool mx, real fuzz, pair b) {
  triple[] C;
  for (int i = 0; i < 4; ++i) for (int j = 0; j < 4; ++j) C.push(P[i][j]);
  if (straight) {
    real x = asy__rm(mx, b.x, asy__rf(0, C[0]));
    real y = asy__rm(mx, b.y, asy__rf(1, C[0]));
    int[] k = {3, 12, 15};
    for (int i = 0; i < 3; ++i) {
      x = asy__rm(mx, x, asy__rf(0, C[k[i]]));
      y = asy__rm(mx, y, asy__rf(1, C[k[i]]));
    }
    return (x, y);
  }
  return (asy__pbound(C, mx, 0, b.x, fuzz, asy__rmaxdepth),
          asy__pbound(C, mx, 1, b.y, fuzz, asy__rmaxdepth));
}

pair minratio(frame f) { return f.minr; }
pair maxratio(frame f) { return f.maxr; }

/*
 * path3 上的同一对（runpath3d.in:352/357，path3.cc:326）：直段只取结点，曲段走 bound。
 * **fuzz 那一格有一点不逐字节**：asy 是 `Fuzz*(max()-min()).length()`，而它的 max()/min()
 * 也是细分求的真界；这里拿结点+控制点的凸包当那个尺度。fuzz 只进终止判据，
 * 两边都落在真极值的 fuzz 之内（~1e-4 相对），不改量级。
 */
private pair asy__pathratio(path3 g, bool mx)
{
  int n = g.nodes.length;
  if (n == 0) { abort("ratio: 空的 path3"); return (0, 0); }
  triple lo = g.nodes[0].point;
  triple hi = lo;
  for (int i = 0; i < n; ++i) {
    triple[] vs = {g.nodes[i].point, g.nodes[i].pre, g.nodes[i].post};
    for (int k = 0; k < 3; ++k) { lo = minbound(lo, vs[k]); hi = maxbound(hi, vs[k]); }
  }
  real fuzz = asy__Fuzz * abs(hi - lo);
  triple v0 = g.nodes[0].point;
  pair B = (asy__rf(0, v0), asy__rf(1, v0));
  // 每个结点都进（asy 那边直段取 point(i)、末端在 i==length 那一趟取到）
  for (int i = 1; i < n; ++i) {
    triple v = g.nodes[i].point;
    B = (asy__rm(mx, B.x, asy__rf(0, v)), asy__rm(mx, B.y, asy__rf(1, v)));
  }
  int L = g.cyclic ? n : n - 1;
  for (int i = 0; i < L; ++i) {
    if (g.nodes[i].straight) continue;
    int j = (i + 1 == n) ? 0 : i + 1;
    triple z0 = g.nodes[i].point;
    triple c0 = g.nodes[i].post;
    triple c1 = g.nodes[j].pre;
    triple z1 = g.nodes[j].point;
    B = (asy__cbound(z0, c0, c1, z1, mx, 0, B.x, fuzz, asy__rmaxdepth),
         asy__cbound(z0, c0, c1, z1, mx, 1, B.y, fuzz, asy__rmaxdepth));
  }
  return B;
}

pair minratio(path3 g) { return asy__pathratio(g, false); }
pair maxratio(path3 g) { return asy__pathratio(g, true); }

/*
 * unstraighten（runpath3d.in:176，path3.cc 的同名成员）：把直段的控制点摆回 1/3、2/3,
 * 并把 straight 那一位清掉 —— 直段在三维那边不能进 Bezier 面片。
 */
path3 unstraighten(path3 p)
{
  path3 q;
  q.cyclic = p.cyclic;
  int n = p.nodes.length;
  for (int i = 0; i < n; ++i) q.nodes.push(knot3copy(p.nodes[i]));
  for (int i = 0; i < n; ++i) {
    if (!q.nodes[i].straight) continue;
    int j = (i + 1 == n) ? (p.cyclic ? 0 : i) : i + 1;
    triple a = q.nodes[i].point;
    triple b = q.nodes[j].point;
    q.nodes[i].post = a + (b - a) / 3;
    q.nodes[j].pre = a + 2 * (b - a) / 3;
    q.nodes[i].straight = false;
  }
  return q;
}

/* 三维的变换作用在一整格 frame 上（three.asy:3255 的 `shift(t*position)*src`） */
frame operator *(real[][] t, frame f)
{
  frame g;
  for (int i = 0; i < f.ops.length; ++i) g.ops.push(f.ops[i]);
  g.haslabel = f.haslabel;
  if (f.has3) {
    // 界要按变换过的八个角重算（轴对齐盒子变换之后不再是原来那个盒子）
    for (int i = 0; i <= 1; ++i)
      for (int j = 0; j <= 1; ++j)
        for (int k = 0; k <= 1; ++k) {
          triple c = (i == 0 ? f.min3v.x : f.max3v.x,
                      j == 0 ? f.min3v.y : f.max3v.y,
                      k == 0 ? f.min3v.z : f.max3v.z);
          asy__add3(g, t * c);
        }
  }
  // 三维那张 op 表也要跟过来，而且要**把变换作用到几何上** —— 这一处不搬的话，
  // three.asy:2883 的 `if(P.absolute) f=modelview*f` 一走，传给 shipout3 的那张帧上
  // 一格 op 都没有（量出来的：/tmp/omni-r3 压根没建起来、位图永远是兜底的白底）。
  drawop3[] s = asy__ops3(f);
  for (int i = 0; i < s.length; ++i) {
    drawop3 o = s[i];
    drawop3 q;
    q.kind = o.kind;
    q.center = t * o.center;
    q.p = o.p;
    q.colors = o.colors;
    q.straight = o.straight;
    q.lightOn = o.lightOn;
    q.opacity = o.opacity;
    q.shininess = o.shininess;
    q.metallic = o.metallic;
    q.fresnel0 = o.fresnel0;
    q.interaction = o.interaction;
    if (o.kind == 0) {
      // `node3` 是 path3 体里声明的类型、体外看不见，所以走现成的 `real[][] * path3`
      q.g3 = t * o.g3;
    } else if (o.kind == 3) {
      q.width = o.width;
      triple[] Q;
      for (int a = 0; a < o.Q3.length; ++a) Q.push(t * o.Q3[a]);
      q.Q3 = Q;
    } else if (o.kind == 4) {
      // 三角网那一族：点过变换，法向**只过线性那一格**（平移不作用在法向上；
      // 这一层拿不到逆转置，非均匀缩放时会偏一点，正交/均匀缩放下是准的）
      triple[] T;
      for (int a = 0; a < o.T3.length; ++a) T.push(t * o.T3[a]);
      q.T3 = T;
      triple[] N;
      triple o0 = t * (0, 0, 0);
      for (int a = 0; a < o.N3.length; ++a) N.push(t * o.N3[a] - o0);
      q.N3 = N;
      q.VC = o.VC;
    } else {
      triple[][] P;
      for (int a = 0; a < o.P3.length; ++a) {
        triple[] row;
        for (int b = 0; b < o.P3[a].length; ++b) row.push(t * o.P3[a][b]);
        P.push(row);
      }
      q.P3 = P;
    }
    asy__push3(g, q);
  }
  // **界这一格不能在这儿逐个 drawelement 重算 —— 试过，性能塌了。**
  // 上一刀在这里加了"走一遍 op 表求真界"（先自检、再按变换后的几何算），
  // 封套那一层确实对上了（七行尺子逐字节相同、cylinder/shellsqrtx01 的矢量半边对上），
  // **但 `real[][] * frame` 是热路径**：`angle()`（three.asy:2765）那个 autoadjust
  // 循环每一轮都乘一次帧，每次都要对每一片面片跑一遍 Bezier 细分（三个分量各一遍），
  // bars3 / AiryDisk 这类几千片的例子直接从秒级变成分钟级都跑不完。
  // 所以这儿留着"旧包围盒八个角"这个 O(1) 的估法；真界要算，得挪到**只算一次**的地方
  // （shipout3 拿 m/M 之前），见 ADR「界那一侧」。
  // **界要照 asy 逐个 drawelement 重算，不能拿"旧包围盒的八个角过变换"** ——
  // 旋转后八角盒是真界的超集，`lambda.x` 系统性偏大，`oW` 与封套就差 1pt
  // （真实路径上 `embed` 的 P.infinity 那一支先 `S.f = modelview*S.f` 再取 max3-min3）。
  //
  // **这一趟必须是纯 min/max，不能带细分**：细分那一版在这里跑过，AiryDisk 从 4.4s
  // 涨到 73s（真正的大头是另一处 O(n²) 的排序，但细分也占了几秒）。所以这儿直接
  // `asy__add3` 逐点取界 —— 与变换本身同一个数量级。
  //
  // 只有当这一帧的界完全来自 op 表里的几何时才能换：`drawTube` 的界是实参给的
  // min/max（管面比中心折线宽）、`drawpixel`/三角网格/NURBS 也只记界，
  // 那几种走 op 表会把界**缩小**。所以先拿未变换的 op 表自检，一致才换。
  if (f.has3 && s.length > 0) {
    frame b0;
    for (int i = 0; i < s.length; ++i) {
      if (s[i].kind == 0) asy__add3(b0, s[i].g3);
      else if (s[i].kind == 1) asy__addpatch3(b0, s[i].P3, s[i].straight);
      else if (s[i].kind == 2) asy__addtri3(b0, s[i].P3, s[i].straight);
      else asy__add3(b0, s[i].Q3);
    }
    if (b0.has3 && b0.min3v == f.min3v && b0.max3v == f.max3v) {
      drawop3[] gs0 = asy__ops3(g);
      frame b1;
      for (int i = 0; i < gs0.length; ++i) {
        if (gs0[i].kind == 0) asy__add3(b1, gs0[i].g3);
        else if (gs0[i].kind == 1) asy__addpatch3(b1, gs0[i].P3, gs0[i].straight);
        else if (gs0[i].kind == 2) asy__addtri3(b1, gs0[i].P3, gs0[i].straight);
        else asy__add3(b1, gs0[i].Q3);
      }
      if (b1.has3) { g.min3v = b1.min3v; g.max3v = b1.max3v; }
    }
  }
  // **比（minr/maxr）不能拿"界的八个角"来算。** x/z 是非线性的，盒角的比与真几何的比
  // 不是一回事：无标签尺子（`import three; size(100);
  // currentprojection=perspective(1,-2,1); draw(unitbox);`）量出来 —— 按盒角算，
  // three.asy:2765 的 angle() 收到的比是 48.65/107.89 = 0.451，于是 fov 定成 48.67°；
  // 而**真几何**的 y/z 只到 0.257/0.360（取到 y 极值的那个点在 z = -189.28，不在近面），
  // 于是 autoadjust 那个循环把"盒角"摆正了、真图形却偏在一边，位图上 ink 只占宽 67.7%
  // （参考是 99.0%）。asy 那边 picture.cc 的 ratio 是**逐个 drawelement 走**的，
  // 所以这里照它走 op 表。界（min3v/max3v）仍按盒角 —— 还有几格内建只记界不留图
  // （drawpixel、三角网格 draw、drawSphere/Cylinder/Disk），改成走 op 表会整格丢掉。
  drawop3[] gs = asy__ops3(g);
  if (gs.length > 0) {
    // fuzz 照 picture.cc:344：整张图的 3D 界的对角线长乘 Fuzz，一趟只算一次。
    real fuzz = asy__Fuzz * abs(g.max3v - g.min3v);
    pair rmn; pair rmx;
    bool first = true;
    void acc(triple v) {
      real rx = v.z == 0 ? 0 : v.x / v.z;
      real ry = v.z == 0 ? 0 : v.y / v.z;
      if (first) { rmn = (rx, ry); rmx = (rx, ry); first = false; return; }
      rmn = (min(rmn.x, rx), min(rmn.y, ry));
      rmx = (max(rmx.x, rx), max(rmx.y, ry));
    }
    for (int i = 0; i < gs.length; ++i) {
      if (gs[i].kind == 0) {
        // drawpath3.h:84 -> path3.cc:326
        if (gs[i].g3.nodes.length == 0) continue;
        if (first) { acc(gs[i].g3.nodes[0].point); }
        pair lo = asy__pathratio(gs[i].g3, false);
        pair hi = asy__pathratio(gs[i].g3, true);
        rmn = (min(rmn.x, lo.x), min(rmn.y, lo.y));
        rmx = (max(rmx.x, hi.x), max(rmx.y, hi.y));
      } else if (gs[i].kind == 1) {
        // drawsurface.cc:138
        if (gs[i].P3.length < 4 || gs[i].P3[0].length < 4) continue;
        if (first) { acc(gs[i].P3[0][0]); }
        rmn = asy__patchratio(gs[i].P3, gs[i].straight, false, fuzz, rmn);
        rmx = asy__patchratio(gs[i].P3, gs[i].straight, true, fuzz, rmx);
      } else if (gs[i].kind == 2) {
        // 三角面片：drawsurface.cc:391 -> path3.cc:860 的 boundtri
        triple[] A;
        for (int a = 0; a < gs[i].P3.length; ++a)
          for (int b = 0; b < gs[i].P3[a].length; ++b) A.push(gs[i].P3[a][b]);
        if (A.length == 0) continue;
        if (first) { acc(A[0]); }
        if (A.length == 10) {
          if (gs[i].straight) {
            int[] k = {0, 6, 9};
            for (int a = 0; a < 3; ++a) acc(A[k[a]]);
          } else {
            rmn = (asy__pboundtri(A, false, 0, rmn.x, fuzz, asy__rmaxdepth),
                   asy__pboundtri(A, false, 1, rmn.y, fuzz, asy__rmaxdepth));
            rmx = (asy__pboundtri(A, true, 0, rmx.x, fuzz, asy__rmaxdepth),
                   asy__pboundtri(A, true, 1, rmx.y, fuzz, asy__rmaxdepth));
          }
        } else {
          for (int a = 0; a < A.length; ++a) acc(A[a]);
        }
      } else {
        // 管子那一格（kind == 3）暂时按中心折线的点取 —— asy 那边 drawTube 有自己的
        // ratio，还没核对。凸包只会**偏大**，所以只有极值真落在它上面时才差。
        for (int a = 0; a < gs[i].P3.length; ++a)
          for (int b = 0; b < gs[i].P3[a].length; ++b) acc(gs[i].P3[a][b]);
        for (int k = 0; k < gs[i].Q3.length; ++k) acc(gs[i].Q3[k]);
      }
    }
    if (!first) { g.minr = rmn; g.maxr = rmx; }
  }
  return g;
}

// ---- 极角那一族（runtriple.in:86/92/99 与 runpair.in:95）与 norm(triple[][])（:2163）----
// principalBranch：归一到 [0,360)（runpair.in 里那个同名的静态函数）。
real principalBranch(real d) {
  real m = d;
  while (m < 0) m = m + 360;
  while (m >= 360) m = m - 360;
  return m;
}
// `warn` 这一格只为把签名对上：这一刀不出警告（与上面 degrees(pair,bool) 同一条）。
// solids.asy:21 的 `angle(z, warn=false)` 要的就是这一份。
real angle(pair z, bool warn = true) { return atan2(z.y, z.x); }
/*
 * 复数上的 sin / cos（runpair.in:208 与 :213，逐句照抄）。
 *
 * asy 那边这一族各注册两格：`sin(pair)`（收 int/real —— 它们能隐式转 pair）与
 * `sin(explicit pair)`。真正"复数版"是后一格，`explicit` 就是为了不把 `sin(2)` 抢过去。
 * examples/sin3.asy:7 的 `real f(pair z) {return abs(sin(z));}` 要的正是这一格。
 */
pair sin(explicit pair z) { return (sin(z.x) * cosh(z.y), cos(z.x) * sinh(z.y)); }
pair cos(explicit pair z) { return (cos(z.x) * cosh(z.y), -sin(z.x) * sinh(z.y)); }
/*
 * 复数上的 exp / log 与 gamma（runpair.in:22、:203 与 :28，逐句照抄）。
 *
 * 这三格都写成 `explicit pair`，与上面 sin/cos 同一条 —— 而且这里**必须**写：
 * 内建面的 `real exp(real)` 是写死在调用那一层的（calls.js 的 mathCall），根本不在
 * 候选表里，不加 explicit 的话 `exp(1.0)` 会落到复数这一格上、回一个 pair。
 * asy 那边 runpair.in 的 `pair exp(pair)` 没写 explicit，因为它那边标量那份是**真候选**，
 * 逐个同型时赢得过。
 */
pair exp(explicit pair z) { return exp(z.x) * expi(z.y); }
pair log(explicit pair z) { return (log(length(z)), angle(z)); }
// std::pow(complex,complex) 就是 exp(w*log(t))（libc++ 与 libstdc++ 都是这一句）
private pair asy__cpow(pair t, pair w) { return exp(w * log(t)); }
// Lanczos 的九个系数（g=7），照 runpair.in:29 那一串
private real[] asy__lanczos = {0.99999999999980993, 676.5203681218851,
  -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7};
pair gamma(explicit pair z) {
  int n = asy__lanczos.length;
  if (z.x < 0.5) return pi / (sin(pi * z) * gamma(1.0 - z));
  pair w = z - 1.0;
  pair x = (asy__lanczos[0], 0);
  for (int i = 1; i < n; ++i) x += asy__lanczos[i] / (w + i);
  pair t = n - 1.5 + w;
  return sqrt(2 * pi) * asy__cpow(t, w + 0.5) * exp(-t) * x;
}
real colatitude(triple v, bool warn = true) {
  real r = sqrt(abs2(v));
  if (r == 0) return 0;
  return degrees(acos(v.z / r));
}
real latitude(triple v, bool warn = true) { return 90 - colatitude(v, warn); }
real longitude(triple v, bool warn = true) {
  if (v.x == 0 && v.y == 0) return 0;
  return principalBranch(degrees(atan2(v.y, v.x)));
}
// norm(triple[][])：各元素 abs2 的最大者开方（runarray.in:2163）
real norm(triple[][] a) {
  real m = 0;
  for (int i = 0; i < a.length; ++i) {
    for (int j = 0; j < a[i].length; ++j) {
      real v = abs2(a[i][j]);
      if (v > m) m = v;
    }
  }
  return sqrt(m);
}
// concat 的三段形（asy 那边 concat 是 `T[] concat(... T[][] a)` 一格泛型内建，
// 这一刀按真用到的写死：three_surface.asy:944 的 `concat(pen[],pen[],pen[])`）
pen[] concat(pen[] a, pen[] b, pen[] c) { return concat(concat(a, b), c); }
triple[] concat(triple[] a, triple[] b, triple[] c) { return concat(concat(a, b), c); }
path3[] concat(path3[] a, path3[] b, path3[] c) { return concat(concat(a, b), c); }

// ---- path3 的 intersect / intersections（三维那一路）----
// 真 asy 那边是 Bezier 的递归细分（bezierintersect，beziercurve.h）；这一刀按**采样 +
// 邻域二分**做：每段取 16 个样点找最近的一对时刻，再在它周围逐次减半细化 30 轮。
// **代价写在明处**：数值比真 asy 粗，多交点只报最近那一个（三维那几处调用要的都是
// "有没有交、在哪个时刻"：three.asy:1784/1792/2060、three_surface.asy:1295/1312）。
private real[] asy__near3(path3 p, path3 q) {
  int np = length(p);
  int nq = length(q);
  int n = 16;
  real rn = n;
  real bt = 0;
  real bs = 0;
  real bd = -1;
  for (int i = 0; i <= np * n; ++i) {
    real t = i / rn;
    triple a = point(p, t);
    for (int j = 0; j <= nq * n; ++j) {
      real s = j / rn;
      real d = abs2(a - point(q, s));
      if (bd < 0 || d < bd) { bd = d; bt = t; bs = s; }
    }
  }
  real h = 1 / rn;
  for (int k = 0; k < 30; ++k) {
    real best = bd;
    real nt = bt;
    real ns = bs;
    for (int di = -1; di <= 1; ++di) {
      for (int dj = -1; dj <= 1; ++dj) {
        real t = bt + di * h;
        real s = bs + dj * h;
        if (t < 0 || t > np) continue;
        if (s < 0 || s > nq) continue;
        real d = abs2(point(p, t) - point(q, s));
        if (d < best) { best = d; nt = t; ns = s; }
      }
    }
    bt = nt;
    bs = ns;
    bd = best;
    h = h / 2;
  }
  real[] out;
  out.push(bt);
  out.push(bs);
  out.push(bd);
  return out;
}

real[] intersect(path3 p, path3 q, real fuzz = -1) {
  real tol = fuzz > 0 ? fuzz : 1e-5;
  real[] r = asy__near3(p, q);
  real[] none;
  if (sqrt(r[2]) > tol + 1e-6) return none;
  real[] out;
  out.push(r[0]);
  out.push(r[1]);
  return out;
}

real[][] intersections(path3 p, path3 q, real fuzz = -1) {
  real[][] out;
  real[] t = intersect(p, q, fuzz);
  if (t.length == 2) out.push(t);
  return out;
}

// 4x4 控制网上的 Bezier 面（Bernstein 基，三维那一路的 patch 就是这个形状）
private triple asy__bezpt(triple[][] P, real u, real v) {
  real[] bu;
  real[] bv;
  real u1 = 1 - u;
  real v1 = 1 - v;
  bu.push(u1 * u1 * u1);
  bu.push(3 * u * u1 * u1);
  bu.push(3 * u * u * u1);
  bu.push(u * u * u);
  bv.push(v1 * v1 * v1);
  bv.push(3 * v * v1 * v1);
  bv.push(3 * v * v * v1);
  bv.push(v * v * v);
  triple s = (0, 0, 0);
  for (int i = 0; i < 4; ++i) {
    for (int j = 0; j < 4; ++j) s = s + bu[i] * bv[j] * P[i][j];
  }
  return s;
}

real[] intersect(path3 p, triple[][] P, real fuzz = -1) {
  real tol = fuzz > 0 ? fuzz : 1e-5;
  int np = length(p);
  int n = 12;
  real rn = n;
  real bt = 0;
  real bu = 0;
  real bv = 0;
  real bd = -1;
  for (int i = 0; i <= np * n; ++i) {
    real t = i / rn;
    triple a = point(p, t);
    for (int j = 0; j <= n; ++j) {
      real u = j / rn;
      for (int k = 0; k <= n; ++k) {
        real v = k / rn;
        real d = abs2(a - asy__bezpt(P, u, v));
        if (bd < 0 || d < bd) { bd = d; bt = t; bu = u; bv = v; }
      }
    }
  }
  real[] none;
  if (sqrt(bd) > tol + 0.05) return none;
  real[] out;
  out.push(bt);
  out.push(bu);
  out.push(bv);
  return out;
}

real[][] intersections(path3 p, triple[][] P, real fuzz = -1) {
  real[][] out;
  real[] t = intersect(p, P, fuzz);
  if (t.length == 3) out.push(t);
  return out;
}

// diagonal（runarray.in 那格泛型内建的 real 一档）
real[][] diagonal(... real[] a) {
  real[][] m;
  for (int i = 0; i < a.length; ++i) {
    real[] row;
    for (int j = 0; j < a.length; ++j) row.push(i == j ? a[i] : 0);
    m.push(row);
  }
  return m;
}

// unstraighten（path 那一格）：asy 那边把"直段"的标记去掉，控制点不动 ——
// 这一刀的 path 没有那个标记，所以就是原样回去。
path unstraighten(path p) { return p; }

// nurb（runpath.in:136，实现在 path.cc:1310）：把一段有理三次 Bézier 按 m 等份采样成
// m+1 个结，再给中间那些结摆一对"共线"的控制点。three.asy:1368 的透视投影靠它。
path nurb(pair z0, pair z1, pair z2, pair z3,
          real w0, real w1, real w2, real w3, int m) {
  pair[] pt;
  real step = 1.0 / m;
  for (int i = 0; i <= m; ++i) {
    real t = i * step;
    real t2 = t * t;
    real onemt = 1.0 - t;
    real onemt2 = onemt * onemt;
    real W0 = w0 * onemt2 * onemt;
    real W1 = w1 * 3.0 * t * onemt2;
    real W2 = w2 * 3.0 * t2 * onemt;
    real W3 = w3 * t2 * t;
    pt.push((W0 * z0 + W1 * z1 + W2 * z2 + W3 * z3) / (W0 + W1 + W2 + W3));
  }
  real twothirds = 2.0 / 3.0;
  real third = 1.0 / 3.0;
  path h;
  for (int i = 0; i <= m; ++i) {
    knot k;
    k.point = pt[i];
    if (i == 0) {
      k.pre = pt[0];
      k.post = twothirds * pt[0] + third * pt[1];
    } else if (i == m) {
      k.pre = twothirds * pt[m] + third * pt[m - 1];
      k.post = pt[m];
    } else {
      pair pre = twothirds * pt[i] + third * pt[i - 1];
      pair pos = twothirds * pt[i] + third * pt[i + 1];
      pair dir = unit(pos - pre);
      k.pre = pt[i] - length(pt[i] - pre) * dir;
      k.post = pt[i] + length(pos - pt[i]) * dir;
    }
    h.nodes.push(k);
  }
  return h;
}
