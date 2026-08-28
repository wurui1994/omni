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
// asy 的 I/O 句柄类型。这里只给**类型**，不给任何 I/O —— 核心方言里还没有文件 IO
// （`(print …)` 是唯一的出口，见文件头）。
// 量出来的理由：`import plain;` 卡在 plain_constants.asy:73 的 `using suffix=void(file);`，
// 而那一条挡住的是**整个 plain 树** —— Label / frame / filltype / align / marker
// 那一大片都在 plain 里。类型桩让声明过得去；真去读写它的地方会明确报"没有方法"，
// 不会悄悄给错答案。
struct file {
  int fd;
}

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
int intMax = 9223372036854775807;
int intMin = -intMax - 1;
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
// 没有泛型，所以按 base 用到的元素类型各写一份（math.asy 用的是 real[] 与 bool[]）。
real[] copy(real[] a) {
  real[] b;
  for (int i = 0; i < a.length; ++i) b.push(a[i]);
  return b;
}
int[] copy(int[] a) {
  int[] b;
  for (int i = 0; i < a.length; ++i) b.push(a[i]);
  return b;
}
bool[] copy(bool[] a) {
  bool[] b;
  for (int i = 0; i < a.length; ++i) b.push(a[i]);
  return b;
}

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

// 量过 rotate(90)：xx=6.12323399573677e-17（cos 90° 的双精度值，不是 0）、xy=-1、yx=1
transform rotate(real angle) {
  real c = cos(radians(angle));
  real s = sin(radians(angle));
  return xform(0, 0, c, -s, s, c);
}

// 作用在点上；先摆出来是因为绕点旋转要用它
pair operator *(transform t, pair p) {
  return (t.x + t.xx * p.x + t.xy * p.y, t.y + t.yx * p.x + t.yy * p.y);
}

// 复合：`(s*sc)*p == s*(sc*p)`（量过 shift(3,4)*scale(2) 作用在 (1,1) 上是 (5,6)）
transform operator *(transform a, transform b) {
  return xform(
    a.x + a.xx * b.x + a.xy * b.y,
    a.y + a.yx * b.x + a.yy * b.y,
    a.xx * b.xx + a.xy * b.yx,
    a.xx * b.xy + a.xy * b.yy,
    a.yx * b.xx + a.yy * b.yx,
    a.yx * b.xy + a.yy * b.yy);
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

transform inverse(transform t) {
  real det = t.xx * t.yy - t.xy * t.yx;
  real ixx = t.yy / det;
  real ixy = -t.xy / det;
  real iyx = -t.yx / det;
  real iyy = t.xx / det;
  return xform(-(ixx * t.x + ixy * t.y), -(iyx * t.x + iyy * t.y), ixx, ixy, iyx, iyy);
}

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
  bool iscmyk = false;
  real cyan = 0;
  real magenta = 0;
  real yellow = 0;
  real black = 0;
  bool isinvisible = false;
  string font = "";
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
  return q;
}

pen defaultpen;
pen currentpen;

pen linewidth(real w) {
  pen q = pencopy(defaultpen);
  q.width = w;
  q.setwidth = true;
  return q;
}

pen gray(real g) {
  pen q = pencopy(defaultpen);
  q.gray = g;
  q.isrgb = false;
  q.setcolor = true;
  return q;
}

pen rgb(real r, real g, real b) {
  pen q = pencopy(defaultpen);
  q.red = r;
  q.green = g;
  q.blue = b;
  q.isrgb = true;
  q.setcolor = true;
  return q;
}

pen evenodd() {
  pen q = pencopy(defaultpen);
  q.evenodd = true;
  return q;
}

// `p + q`：q 显式设过的属性盖住 p 的那一份（asy 的 pen 加法就是这个意思）
pen operator +(pen a, pen b) {
  pen q = pencopy(a);
  if (b.setwidth) {
    q.width = b.width;
    q.setwidth = true;
  }
  if (b.setcolor) {
    q.gray = b.gray;
    q.red = b.red;
    q.green = b.green;
    q.blue = b.blue;
    q.isrgb = b.isrgb;
    q.setcolor = true;
  }
  if (b.evenodd) q.evenodd = true;
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
pen purple = rgb(0.5, 0, 0.5);

// ---------------------------------------------------------------- path
// asy 的 path 是 solvedKnot 的数组 + cycles 标志（path.h）。这里照搬：
// pre/point/post 三个控制点，straight 说"这一段是直线"（两端张力都正好是 1 时
// psfile 发的是 lineto 而不是 curveto，drawpath.cc 那边就是这么判的）。
struct knot {
  pair pre;
  pair point;
  pair post;
  bool straight = false;
}

struct path {
  knot[] nodes;
  bool cyclic = false;
  // `cycle` 那个字面量：它不是路径，是**连接时的记号**。前端把 `cycle` 解析成下面那个
  // `cyclepath`（`cycle` 自己是 LIT，asy 源码里声明不出这个名字），`a--cycle` 于是就是
  // `operator --(path, path)` 见到一个带记号的右操作数。这是前端与绘图层之间唯一的约定名。
  bool ismark = false;
}

path cyclepath;
cyclepath.ismark = true;

// `guide` 在 asy 那边是"还没解出来的路径规格"，`path` 是解好的，两者之间有隐式转换。
// 这一刀先让 guide 就是 path 的别名。量出来的理由：真 base 里库代码写的 `..` 几乎都
// **显式给了控制点**（graph_splinetype.asy 的 hermite 就是 `..controls A and B..`），
// 那种不需要 Hobby 求解器；要解方程的是用户代码里裸写的 `a..b..c`，那一刀留到量出
// 它真的是下一个坎再写。
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

// path.h 里是成员函数，asy 那边是自由函数
bool cyclic(path g) { return g.cyclic; }
path[] concat(path[] a, path[] b) {
  path[] out;
  for (path x : a) out.push(x);
  for (path x : b) out.push(x);
  return out;
}

pair point(path g, int i) { return g.nodes[i].point; }

knot knotcopy(knot k) {
  knot j;
  j.pre = k.pre;
  j.point = k.point;
  j.post = k.post;
  j.straight = k.straight;
  return j;
}

// path 在 asy 那边是值类型；我们的 struct 是引用类型，所以每个连接都先复制一份，
// 不然 `path h = g--(1,1);` 会把 g 一起改掉。
path pathcopy(path g) {
  path h;
  h.cyclic = g.cyclic;
  for (int i = 0; i < g.nodes.length; ++i) h.nodes.push(knotcopy(g.nodes[i]));
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

path operator --(path a, path b) {
  // `a--cycle`：右边是那个记号，于是闭合 —— 首尾两个结之间的那一段也是直线
  if (b.ismark) {
    path g = pathcopy(a);
    int n = g.nodes.length;
    pair z0 = g.nodes[0].point;
    pair zn = g.nodes[n - 1].point;
    g.nodes[n - 1].straight = true;
    g.nodes[n - 1].post = zn + (z0 - zn) / 3;
    g.nodes[0].pre = z0 - (z0 - zn) / 3;
    g.cyclic = true;
    return g;
  }
  path h = pathcopy(a);
  for (int i = 0; i < b.nodes.length; ++i) {
    if (i == 0) pushstraight(h, b.nodes[0].point);
    else h.nodes.push(knotcopy(b.nodes[i]));
  }
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

// 三次贝塞尔在一根轴上的极值：导数是二次式，解出 (0,1) 里的根代回去。
// 直线段用不到，`..` 那一刀的曲线要。
void addcubic1(box bx, bool isx, real a, real b0, real c, real d) {
  real qa = 3 * (-a + 3 * b0 - 3 * c + d);
  real qb = 6 * (a - 2 * b0 + c);
  real qc = 3 * (b0 - a);
  real[] ts;
  if (fabs(qa) < 1e-14) {
    if (fabs(qb) > 1e-14) ts.push(-qc / qb);
  } else {
    real disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      real sq = sqrt(disc);
      ts.push((-qb + sq) / (2 * qa));
      ts.push((-qb - sq) / (2 * qa));
    }
  }
  for (int i = 0; i < ts.length; ++i) {
    real u = ts[i];
    if (u > 0 && u < 1) {
      real v = 1 - u;
      real p = v * v * v * a + 3 * v * v * u * b0 + 3 * v * u * u * c + u * u * u * d;
      if (isx) addx(bx, p);
      else addy(bx, p);
    }
  }
}

void addcubic(box bx, pair p0, pair p1, pair p2, pair p3) {
  addpt(bx, p0);
  addpt(bx, p3);
  addcubic1(bx, true, p0.x, p1.x, p2.x, p3.x);
  addcubic1(bx, false, p0.y, p1.y, p2.y, p3.y);
}

// ---------------------------------------------------------------- picture
struct drawop {
  int kind = 0;      // 0 = 描边，1 = 填充
  path g;
  pen p;
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

void draw(picture pic, path g, pen p) { addop(pic, 0, g, p); }
void draw(picture pic, path g) { addop(pic, 0, g, currentpen); }
void draw(path g, pen p) { addop(currentpicture, 0, g, p); }
void draw(path g) { addop(currentpicture, 0, g, currentpen); }

void fill(picture pic, path g, pen p) { addop(pic, 1, g, p); }
void fill(picture pic, path g) { addop(pic, 1, g, currentpen); }
void fill(path g, pen p) { addop(currentpicture, 1, g, p); }
void fill(path g) { addop(currentpicture, 1, g, currentpen); }

// 一个元素在缩放 s 下的 bbox。描边按笔宽的一半外扩（默认是圆头圆角，四个方向都是 w/2）。
box opbox(drawop o, real s) {
  box eb;
  path g = o.g;
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
  if (o.kind == 0 && !eb.empty) {
    real hw = 0.5 * o.p.width;
    eb.l -= hw;
    eb.b -= hw;
    eb.r += hw;
    eb.t += hw;
  }
  return eb;
}

box picbox(picture pic, real s) {
  box bx;
  for (int i = 0; i < pic.ops.length; ++i) {
    box eb = opbox(pic.ops[i], s);
    if (!eb.empty) {
      addpt(bx, (eb.l, eb.b));
      addpt(bx, (eb.r, eb.t));
    }
  }
  return bx;
}

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
// 这里只有「把元素攒起来」与「量 bbox」两件事：begingroup / endgroup / clip / label 都
// 还没有，用到它们的地方会明确报"没有这个函数"，不会悄悄给错答案。
struct frame {
  drawop[] ops;
}

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

// 缩放固定为 1 —— frame 的坐标已经是最终坐标了
box framebox(frame f) {
  box bx;
  for (int i = 0; i < f.ops.length; ++i) {
    box eb = opbox(f.ops[i], 1);
    if (!eb.empty) {
      addpt(bx, (eb.l, eb.b));
      addpt(bx, (eb.r, eb.t));
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
  for (int i = 0; i < src.ops.length; ++i) dest.ops.push(src.ops[i]);
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
// 坐标是 %.6g（psfile.h:160 `*out << " " << x`，ostream 的默认精度就是 6），
// HiResBoundingBox 是 %.9g（psfile.h:30 的 setprecision(9)）。
string ps(real x) { return string(x, 6); }
string ps9(real x) { return string(x, 9); }

// psfile 里 lastpen 一开始是 initialpen —— 与默认笔的每一项都不同，所以第一个元素
// 那几行全印。这里用一个 valid 标志表示"还没有上一支笔"。
pen lastpen;
bool lastvalid = false;

string colorof(pen p) {
  if (p.isrgb) return ps(p.red) + " " + ps(p.green) + " " + ps(p.blue) + " setrgbcolor";
  return ps(p.gray) + " setgray";
}

bool samecolor(pen a, pen b) {
  if (a.isrgb != b.isrgb) return false;
  if (a.isrgb) return a.red == b.red && a.green == b.green && a.blue == b.blue;
  return a.gray == b.gray;
}

void setpen(pen p) {
  if (!lastvalid || !samecolor(p, lastpen)) write(colorof(p));
  if (!lastvalid || p.width != lastpen.width) write(ps(p.width) + " Setlinewidth");
  if (!lastvalid || p.cap != lastpen.cap) write(string(p.cap) + " setlinecap");
  if (!lastvalid || p.join != lastpen.join) write(string(p.join) + " setlinejoin");
  if (!lastvalid || p.miter != lastpen.miter) write(ps(p.miter) + " setmiterlimit");
  lastpen = pencopy(p);
  lastvalid = true;
}

// 路径本身（psfile.h:295..312 那一段照搬）：第一句是 `newpath … moveto`，
// 直的段发 lineto、弯的发 curveto；闭合的路径末尾多一句回到起点再 closepath。
void emitpath(path g, real s) {
  int n = g.nodes.length;
  pair z0 = s * g.nodes[0].point;
  write("newpath " + ps(z0.x) + " " + ps(z0.y) + " moveto");
  for (int i = 1; i < n; ++i) {
    pair z = s * g.nodes[i].point;
    if (g.nodes[i - 1].straight) write(" " + ps(z.x) + " " + ps(z.y) + " lineto");
    else {
      pair c1 = s * g.nodes[i - 1].post;
      pair c2 = s * g.nodes[i].pre;
      write(" " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z.x) + " " + ps(z.y) + " curveto");
    }
  }
  if (g.cyclic) {
    if (g.nodes[n - 1].straight) write(" " + ps(z0.x) + " " + ps(z0.y) + " lineto");
    else {
      pair c1 = s * g.nodes[n - 1].post;
      pair c2 = s * g.nodes[0].pre;
      write(" " + ps(c1.x) + " " + ps(c1.y) + " " + ps(c2.x) + " " + ps(c2.y)
            + " " + ps(z0.x) + " " + ps(z0.y) + " curveto");
    }
    write("closepath");
  } else if (n == 1) {
    write(" " + ps(z0.x) + " " + ps(z0.y) + " lineto");
  }
}

// 摆放是量出来的：图的整体尺寸 = 缩放后的 bbox（描边已经算进笔宽了），
// 信纸 612x792 居中再各减 0.5（那 0.5 与笔宽无关，三个尺寸两种笔宽都对上了），
// translate 把 bbox 的左下角搬到那里。
void shipout(picture pic) {
  real s = fitscale(pic);
  box bx = picbox(pic, s);
  real w = bx.r - bx.l;
  real h = bx.t - bx.b;
  real ox = (612 - w) / 2 - 0.5;
  real oy = (792 - h) / 2 - 0.5;
  write("%!PS-Adobe-3.0 EPSF-3.0");
  write("%%BoundingBox: " + string(floor(ox)) + " " + string(floor(oy)) + " "
        + string(ceil(ox + w)) + " " + string(ceil(oy + h)));
  write("%%HiResBoundingBox: " + ps9(ox) + " " + ps9(oy) + " "
        + ps9(ox + w) + " " + ps9(oy + h));
  write("%%Creator: Omni asy");
  write("%%Pages: 1");
  write("%%Page: 1 1");
  write("/Setlinewidth {0 exch dtransform dup abs 1 lt {pop 0}{round} ifelse");
  write("idtransform setlinewidth pop} bind def");
  write("gsave");
  write(" " + ps(ox - bx.l) + " " + ps(oy - bx.b) + " translate");
  lastvalid = false;
  for (int i = 0; i < pic.ops.length; ++i) {
    drawop o = pic.ops[i];
    emitpath(o.g, s);
    setpen(o.p);
    if (o.kind == 0) write("stroke");
    else if (o.p.evenodd) write("eofill");
    else write("fill");
  }
  write("grestore");
  write("showpage");
  write("%%EOF");
}

void shipout() { shipout(currentpicture); }
void shipout(string prefix) { shipout(currentpicture); }

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
void texpreamble(string s) { }         // 空动作：没有 TeX 那一路
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
void atbreakpoint(asy__thunk f) { }

// (2) 伪随机（runmath.in:206/217）。asy 用的是 C 库的 random()；这一层自带一个
// 线性同余（Numerical Recipes 那组常数），所以**同一个种子出来的数与真 asy 不一样**。
int asy__seed = 1;
int rand() {
  asy__seed = (asy__seed * 1664525 + 1013904223) % 2147483647;
  if (asy__seed < 0) asy__seed = -asy__seed;
  return asy__seed;
}
void srand(int s) { asy__seed = s; }
real unitrand() { return rand() / 2147483647.0; }

// (1) 笔的那几格（runpen.in）。asy 那边每个都是"回一支只设了这一项的笔"，
// 与 currentpen 合成时后设的赢 —— 这一层照着摆那一格。
pen linecap(int n) { pen p; p.cap = n; return p; }
int linecap(pen p) { return p.cap; }
pen linejoin(int n) { pen p; p.join = n; return p; }
int linejoin(pen p) { return p.join; }
pen fillrule(int n) { pen p; p.fillruleval = n; p.evenodd = n == 1; return p; }
int fillrule(pen p) { return p.fillruleval; }
pen basealign(int n) { pen p; p.basealignval = n; return p; }
int basealign(pen p) { return p.basealignval; }
pen opacity(real opacity=1.0, string blend="Compatible") {
  pen p; p.opacityval = opacity; p.blend = blend; return p;
}
real opacity(pen p) { return p.opacityval; }
pen invisible() { pen p; p.isinvisible = true; return p; }
bool invisible(pen p) { return p.isinvisible; }
pen fontcommand(string s) { pen p; p.font = s; return p; }
pen cmyk(real c, real m, real y, real k) {
  pen p;
  p.iscmyk = true; p.setcolor = true;
  p.cyan = c; p.magenta = m; p.yellow = y; p.black = k;
  // EPS 那一路只发 rgb/gray，所以这里同时算一份 rgb（cmyk -> rgb 的那条直白换算）
  p.isrgb = true;
  p.red = (1 - c) * (1 - k);
  p.green = (1 - m) * (1 - k);
  p.blue = (1 - y) * (1 - k);
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
void resetdefaultpen() { }

// (3) 真几何与数值：声明在这里，体是 abort。
real arclength(path p) { abort("arclength(path) 还没做"); return 0; }
real arclength(pair z0, pair c0, pair c1, pair z1) {
  abort("arclength(pair,pair,pair,pair) 还没做"); return 0;
}
real arctime(path p, real L) { abort("arctime 还没做"); return 0; }
path subpath(path p, int a, int b) { abort("subpath(path,int,int) 还没做"); return p; }
path subpath(path p, real a, real b) { abort("subpath(path,real,real) 还没做"); return p; }
real[] intersect(path p, path q, real fuzz=-1) {
  abort("intersect(path,path) 还没做"); return new real[];
}
real[][] intersections(path p, path q, real fuzz=-1) {
  abort("intersections(path,path) 还没做"); return new real[][];
}
path nib(pen p) { abort("nib(pen) 还没做"); return new path; }
pen makepen(path p) { abort("makepen(path) 还没做"); return new pen; }
real[][] transpose(real[][] a) { abort("transpose 还没做"); return new real[][]; }

// (1) 笔的查询那一侧与字号（runpen.in）。base 里 `linewidth(currentpen)`、
// `fontsize(10)` 到处都是。
real linewidth(pen p) { return p.width; }
pen fontsize(real size, real lineskip) { pen q; q.font = "fontsize"; return q; }
pen fontsize(real size) { return fontsize(size, 1.2 * size); }

// (1) 还差的几个非泛型内建：base 里点名要，语义在参考实现里是一句话。
// unit：runpair.in:178 —— 零向量回零（C++ 那边 length==0 时原样返回）。
pair unit(pair z) { real r = length(z); return r == 0 ? z : z / r; }
triple unit(triple v) { real r = length(v); return r == 0 ? v : v / r; }

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

// (2) format：runstring.in:246/301 的两个内建。C++ 那边是走 printf 的格式串（还带
// TeX 数学模式与千分位 separator）。这里只做"把 % 那一格换成这个数的默认写法"这一层：
// 精度、指数写法、separator 都还没有，记在这儿。base 里 defaultformat 的那条链要它。
string asy__fmt1(string fmt, string sx) {
  int n = length(fmt);
  string out = "";
  int i = 0;
  bool done = false;
  while (i < n) {
    string c = substr(fmt, i, 1);
    if (c != "%" || done) { out = out + c; ++i; continue; }
    if (i + 1 < n && substr(fmt, i + 1, 1) == "%") { out = out + "%"; i = i + 2; continue; }
    // 跳过这一条 % 规格：标志/宽度/精度/长度，直到那个转换字母
    int j = i + 1;
    while (j < n) {
      string d = substr(fmt, j, 1);
      ++j;
      if (d != "-" && d != "+" && d != " " && d != "#" && d != "." && d != "*"
          && d != "0" && d != "1" && d != "2" && d != "3" && d != "4"
          && d != "5" && d != "6" && d != "7" && d != "8" && d != "9"
          && d != "l" && d != "h" && d != "L") break;
    }
    out = out + sx;
    i = j;
    done = true;
  }
  return out;
}
string format(string fmt, int x, string locale="") { return asy__fmt1(fmt, string(x)); }
string format(string fmt, bool forcemath=false, string separator, real x,
              string locale="") {
  return asy__fmt1(fmt, string(x));
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

// (1) path / path[] 的包围盒（runpath.in:271/276/290/314）。每段是三次 Bezier，
// 某个分量的极值只能出在两端或**导数为零**处；导数是二次的，所以解那条二次就是精确解
// （C++ 那边 bounds() 走的是同一条路，不是采样）。
real asy__bez(real a, real b, real c, real d, real t) {
  real r = 1 - t;
  return r*r*r*a + 3*r*r*t*b + 3*r*t*t*c + t*t*t*d;
}
real[] asy__bezcrit(real a, real b, real c, real d) {
  // B'(t)/3 = A t^2 + B t + C
  real A = -a + 3*b - 3*c + d;
  real B = 2*(a - 2*b + c);
  real C = b - a;
  real[] out;
  if (A == 0) {
    if (B != 0) { real t = -C / B; if (t > 0 && t < 1) out.push(t); }
    return out;
  }
  real disc = B*B - 4*A*C;
  if (disc < 0) return out;
  real s = sqrt(disc);
  real t1 = (-B + s) / (2*A);
  real t2 = (-B - s) / (2*A);
  if (t1 > 0 && t1 < 1) out.push(t1);
  if (t2 > 0 && t2 < 1) out.push(t2);
  return out;
}
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
    knot p = g.nodes[i];
    knot q = g.nodes[i + 1 == n ? 0 : i + 1];
    real a = xaxis ? p.point.x : p.point.y;
    real b = xaxis ? p.post.x : p.post.y;
    real c = xaxis ? q.pre.x : q.pre.y;
    real d = xaxis ? q.point.x : q.point.y;
    for (real t : asy__bezcrit(a, b, c, d)) {
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

// (2) warning / nowarn（runsystem.in:174/182）。C++ 那边过 settings::warn 那张开关表再
// 走 em.warning（带文件位置）。这一层没有那张表也没有位置，就照 "warning: <正文>" 印出来。
void nowarn(string s) { }
void warning(string s, string t, bool position=false) {
  write("warning: " + t);
}

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




