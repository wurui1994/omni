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

// slant（runtime.in:1219 -> transform.h 的 slant）：量过 slant(2) 是 (0,0,1,2,0,1)
transform slant(real s) { return xform(0, 0, 1, s, 0, 1); }

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
  bool iscmyk = false;
  real cyan = 0;
  real magenta = 0;
  real yellow = 0;
  real black = 0;
  bool isinvisible = false;
  string font = "";
  // 虚线那一族（pen.h 的 LineType：pattern/offset/scale/adjust）。这一层只**存着** ——
  // EPS 那一路还没发 setdash，所以虚线画出来还是实线，这条差别写在明处。
  real[] dashpat;
  real dashoffset = 0;
  bool dashscale = true;
  bool dashadjust = true;
  // 笔自己的那个变换（pen.h 的 `pen::t`）：`transform * pen` 攒在这儿，min/max(pen) 用它。
  transform pentrans;
  bool hastrans = false;
  // 笔尖（pen.h 的 `pen::P`）在 asy__nibtab 里的下标，-1 是没有（见那张表旁边的注）。
  // 这里放不下一格 `path`：`struct path` 声明在这个 struct **后面**。
  int nibid = -1;
  // 字号（pen.h 的 `pen::size`）。默认是 12pt 换成 bp 的那个数 —— 量过
  // `fontsize(currentpen)` 就是 11.9551681195517（= 12*72/72.27）。
  real fontsizeval = 11.9551681195517;
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
  q.dashscale = p.dashscale;
  q.dashadjust = p.dashadjust;
  q.pentrans = p.pentrans;
  q.hastrans = p.hastrans;
  q.nibid = p.nibid;
  q.fontsizeval = p.fontsizeval;
  q.fontsizeset = p.fontsizeset;
  q.lineskipval = p.lineskipval;
  q.font = p.font;
  q.fillruleval = p.fillruleval;
  q.basealignval = p.basealignval;
  q.opacityval = p.opacityval;
  q.blend = p.blend;
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

pen linewidth(real w) {
  pen q = pencopy(asy__defpen);
  q.width = w;
  q.setwidth = true;
  return q;
}

pen gray(real g) {
  pen q = pencopy(asy__defpen);
  q.gray = g;
  q.isrgb = false;
  q.setcolor = true;
  return q;
}

pen rgb(real r, real g, real b) {
  pen q = pencopy(asy__defpen);
  q.red = r;
  q.green = g;
  q.blue = b;
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
  if (b.cap != 1) q.cap = b.cap;
  if (b.join != 1) q.join = b.join;
  if (b.miter != 10) q.miter = b.miter;
  if (b.dashpat.length > 0) {
    q.dashpat = copy(b.dashpat);
    q.dashoffset = b.dashoffset;
    q.dashscale = b.dashscale;
    q.dashadjust = b.dashadjust;
  }
  if (b.font != "") q.font = b.font;
  if (b.fontsizeset != 0) {
    q.fontsizeset = b.fontsizeset;
    q.fontsizeval = b.fontsizeval;
  }
  if (b.lineskipval != 0) q.lineskipval = b.lineskipval;
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

// 结点下标：闭合路径上它是绕圈的（asy 的 path::point 对 cycles 取模），开路径上原样
private int asy__nwrap(path g, int i) {
  int n = g.nodes.length;
  if (!g.cyclic || n == 0) return i;
  int k = i % n;
  return k < 0 ? k + n : k;
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
    // 描边那一笔的盒子要加上**笔的盒子**（pen.h:931 的 pen::bounds）：没有笔尖时是
    // ±0.5*linewidth*(maxx,maxy) 加上笔那个变换的平移，maxx/maxy 是线性部分两行的模长
    // （恒等时就是 1）。min/max(pen) 用的是同一份算法，但它们声明在后面，所以这里现写。
    real hw = 0.5 * o.p.width;
    real mx = 1;
    real my = 1;
    real sx = 0;
    real sy = 0;
    if (o.p.hastrans) {
      mx = length((o.p.pentrans.xx, o.p.pentrans.xy));
      my = length((o.p.pentrans.yx, o.p.pentrans.yy));
      sx = o.p.pentrans.x;
      sy = o.p.pentrans.y;
    }
    eb.l -= hw * mx - sx;
    eb.b -= hw * my - sy;
    eb.r += hw * mx + sx;
    eb.t += hw * my + sy;
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
// 这里只有「把元素攒起来」「量 bbox」与「记一下有没有标签」三件事：begingroup /
// endgroup / clip 都还没有，用到它们的地方会明确报"没有这个函数"，不会悄悄给错答案。
struct frame {
  drawop[] ops;
  // 三维那一层记下来的界（第六十七刀）：几何本身这一刀落不下来，界与 x/z、y/z 的比是真的
  bool has3 = false;
  triple min3v = (0, 0, 0);
  triple max3v = (0, 0, 0);
  pair minr = (0, 0);
  pair maxr = (0, 0);
  // 攒过标签没有（runlabel.in:220 的 `labels(frame)`）。这一层没有 TeX，标签的**内容**
  // 落不下来，但"有没有"这一位是真的。
  bool haslabel = false;
}

// `newframe` 那个字面量（camp.l:407 的 newPictureExp）落在这里：一个**新的**空 frame。
// 前端与绘图层之间约定的名字（见 types.js 的 ASY_NEWFRAME）。
frame asy__newframe() {
  frame f;
  return f;
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

// runlabel.in:214 的那一条：`label(frame, string s, string size, transform, pair position,
// pair align, pen)`。注意 size 是**字符串**（TeX 的尺寸文本），不是 real —— 照抄的。
// 这一层没有 TeX，所以内容落不下来，只把"有标签"这一位记上。
// plain_Label.asy:297 的 `label(f,s,size,embed(t)*shiftless(T),S,align,p0)` 要的正是它。
void label(frame f, string s, string size, transform t, pair position, pair align, pen p) {
  f.haslabel = true;
}

bool labels(frame f) { return f.haslabel; }

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

private void asy__ixrec(real[][] out, pair[] a, real ta0, real ta1,
                        pair[] b, real tb0, real tb1, real fuzz, int depth) {
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
  asy__ixrec(out, a0, ta0, tam, b0, tb0, tbm, fuzz, depth - 1);
  asy__ixrec(out, a0, ta0, tam, b1, tbm, tb1, fuzz, depth - 1);
  asy__ixrec(out, a1, tam, ta1, b0, tb0, tbm, fuzz, depth - 1);
  asy__ixrec(out, a1, tam, ta1, b1, tbm, tb1, fuzz, depth - 1);
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

// 全部交点（按 p 上的时间排好、去重）。asy 那边是 path.cc 的 intersections。
// 两步：包围盒细分**圈出**每个交点（12 层，段内约 2e-4），再 Newton 收到机器精度。
real[][] intersections(path p, path q, real fuzz=-1) {
  int np = length(p);
  int nq = length(q);
  real sc = 1;
  for (int i = 0; i <= np; ++i) { real m = length(point(p, i)); if (m > sc) sc = m; }
  for (int j = 0; j <= nq; ++j) { real m = length(point(q, j)); if (m > sc) sc = m; }
  real f = fuzz < 0 ? 1e-9 * sc : fuzz;
  real tol = 1e-12 * sc;
  real[][] raw;
  for (int i = 0; i < np; ++i) {
    pair[] a = asy__segctl(p, i);
    for (int j = 0; j < nq; ++j) {
      pair[] b = asy__segctl(q, j);
      real[][] cand;
      asy__ixrec(cand, a, 0, 1, b, 0, 1, f, 12);
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
  real[][] out;
  for (int k = 0; k < raw.length; ++k) {
    bool dup = false;
    for (int m = 0; m < out.length; ++m) {
      if (abs(out[m][0] - raw[k][0]) < 1e-7 && abs(out[m][1] - raw[k][1]) < 1e-7) dup = true;
    }
    if (dup) continue;
    int at = out.length;
    for (int m = 0; m < out.length; ++m) if (out[m][0] > raw[k][0]) { at = m; break; }
    out.insert(at, raw[k]);
  }
  return out;
}

// 第一个交点的两个时间（没有就是空数组）—— runpath.in:245 的 intersect
real[] intersect(path p, path q, real fuzz=-1) {
  real[][] all = intersections(p, q, fuzz);
  if (all.length == 0) return new real[];
  return all[0];
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
real linewidth(pen p) { return p.width; }

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
real fontsize(pen p) { return p.fontsizeval; }
// runtime.in 的 `real lineskip(pen)`（pen::Lineskip()）：设过就是设的那一格，没设过是
// 字号的 1.2 倍。量过 `lineskip(currentpen)` 是 14.346201743462（= 1.2*11.9551681195517）、
// `lineskip(fontsize(20))` 是 24、`lineskip(fontsize(10,15))` 是 15。slide.asy:258 要它。
real lineskip(pen p) { return p.lineskipval != 0 ? p.lineskipval : 1.2 * p.fontsizeval; }
// runtime.in:585 的 `string font(pen)`（pen::Font()）。没设过 fontcommand 时回的是那串
// 默认的 LaTeX 字体命令 —— 量过真 asy：`font(currentpen)` 与 `font(fontsize(9))` 都是
// `\usefont{\ASYencoding}{\ASYfamily}{\ASYseries}{\ASYshape}`，设过的回设的那一串。
// plain_Label.asy:601 的 `font=font(L.p)`（stringfont 的构造函数里）点名要它。
string font(pen p) {
  return p.font == "" ? "\\usefont{\\ASYencoding}{\\ASYfamily}{\\ASYseries}{\\ASYshape}" : p.font;
}

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
void nowarn(string s) { }
void warning(string s, string t, bool position=false) {
  write("warning: " + t);
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
file input(string name="", bool check=true, string comment="#", string mode="") {
  file f;
  f.comment = substr(comment, 0, 1);
  if (name == "") { f.fd = 0; return f; }        // stdin：这一层读不了（读到才报）
  f.fd = 2;
  f.name = name;
  if (mode != "") return f;                      // 二进制/XDR：打不开（v3d.asy:135 那一格）
  if (!check) return f;
  f.lines = _readlines(name);
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
void defaultpen(pen p) { asy__defpen = pencopy(p); }

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
  return q;
}
real[] linetype(pen p) { return copy(p.dashpat); }
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

// (1) frame 上的分组与 3D 问询（runpicture.in:286/291/778）。分组在 EPS 那一路是
// `gsave/grestore` 那一层的事，我们的 frame 只攒 drawop，所以这两个是空的 —— 画出来一样。
void begingroup(frame f) { }
void endgroup(frame f) { }
bool is3D(frame f) { return false; }
// (1) `gsave`/`grestore`（runpicture.in:276/281）：往 frame 里塞一条 EPS 的图形状态
// 存/取。这一层的 frame 只攒 drawop、没有"往里塞一段 PostScript 正文"这一层
// （postscript(frame,…) 是 abort 的那一档），所以这两个也是空的 —— 与 begingroup/endgroup
// 同一条。用它的只有 patterns.asy:16 的 tiling，而那一句下面紧跟着 postscript()，
// 真跑到那儿会在 postscript 上 abort，不会悄悄画错。
void gsave(frame f) { }
void grestore(frame f) { }

// (1) frame 上的那一批画图内建（runpicture.in）。`fill(frame, path[], …)` 是真做的：
// 每条路径进一笔填充。**明写的差别**：asy 那边一组路径连着 fillrule 是**一个**填充区域
// （挖洞靠它），我们是一笔一笔填，所以带洞的图形会与真 asy 不一样。
void fill(frame f, path[] g, pen p = currentpen, bool copy = true) {
  for (path q : g) addop(f, 1, q, p);
}
// 下面这些是**声明在这里、体是 abort**：签名照参考实现抄准，语义（渐变、裁剪、TeX、
// 分层、翻页、3D 盒子）都还没做。抄准签名是为了让"没做"落在运行期那一句话上，
// 而不是编译期一堆"没有能匹配的签名"。
void latticeshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[][] p, transform t=identity(), bool copy=true) {
  abort("latticeshade 还没做");
}
void axialshade(frame f, path[] g, bool stroke=false, pen pena, pair a,
                bool extenda=true, pen penb, pair b, bool extendb=true,
                bool copy=true) {
  abort("axialshade 还没做");
}
void radialshade(frame f, path[] g, bool stroke=false, pen pena, pair a, real ra,
                 bool extenda=true, pen penb, pair b, real rb, bool extendb=true,
                 bool copy=true) {
  abort("radialshade 还没做");
}
void gouraudshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[] p, pair[] z, int[] edges, bool copy=true) {
  abort("gouraudshade 还没做");
}
void gouraudshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                  pen[] p, int[] edges, bool copy=true) {
  abort("gouraudshade 还没做");
}
void tensorshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                 pen[][] p, path[] b=null, pair[][] z=new pair[][], bool copy=true) {
  abort("tensorshade 还没做");
}
void functionshade(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
                   string shader="", bool copy=true) {
  abort("functionshade 还没做");
}
void clip(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
          bool copy=true) {
  abort("clip(frame) 还没做");
}
void beginclip(frame f, path[] g, bool stroke=false, pen fillrule=currentpen,
               bool copy=true) {
  abort("beginclip 还没做");
}
void endclip(frame f) { abort("endclip 还没做"); }
void layer(frame f) { abort("layer 还没做"); }
void newpage(frame f) { abort("newpage 还没做"); }
void postscript(frame f, string s) { abort("postscript 还没做"); }
void postscript(frame f, string s, pair min, pair max) { abort("postscript 还没做"); }
void tex(frame f, string s) { abort("tex 还没做"); }
void tex(frame f, string s, pair min, pair max) { abort("tex 还没做"); }
void javascript(frame f, string s) { abort("javascript 还没做"); }
void deconstruct(frame f, frame preamble, transform T=identity()) {
  abort("deconstruct 还没做");
}
// 三维的界（runpicture.in:757/762）：记在 frame 上，见 asy__add3
triple min3(frame f) {
  if (!f.has3) { abort("min3: 这一格 frame 里没有三维的东西"); return (0, 0, 0); }
  return f.min3v;
}
triple max3(frame f) {
  if (!f.has3) { abort("max3: 这一格 frame 里没有三维的东西"); return (0, 0, 0); }
  return f.max3v;
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
real[] intersections(path p, pair a, pair b, real fuzz=-1) {
  abort("intersections(path,pair,pair) 还没做"); return new real[];
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

// (1) `transform * frame`（runtime.in:1112）：frame 里每一笔都搬。
frame operator *(transform t, frame f) {
  frame out;
  for (drawop o : f.ops) {
    drawop q;
    q.kind = o.kind;
    q.g = t * o.g;
    // 笔只吃**去掉平移**的那一半（drawelement.h:302 `transformed(shiftless(t),pentype)`）——
    // 量过：`min(shift(3,4)*f)` 是路径搬过去再 ±0.25，笔那一格没有跟着平移。
    q.p = shiftless(t) * o.p;
    out.ops.push(q);
  }
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
  if (p.isinvisible) return a;
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
  if (p.isinvisible) return "";
  if (p.iscmyk) return "cmyk";
  if (p.isrgb) return "rgb";
  return "gray";
}

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
int seconds(string t="", string format="") { abort("seconds 还没做（这一层没有时钟）"); return 0; }
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
path[] _strokepath(path g, pen p=currentpen) {
  abort("_strokepath 还没做（真 asy 是绕 gs 走一趟）"); return new path[];
}
// ---------------- graph/math 那一批余量（第六十七刀）
// 答得出的照 run*.in 的定义写出来，算法重而 import 时又用不到的体是 abort（签名在，
// graph.asy / math.asy 那几句才降得下来）。
real log10(real x) { return log(x) / log(10); }
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
real[] cubicroots(real a, real b, real c, real d) {
  abort("cubicroots 还没做（runmath.in:333 那一段解析解）"); return new real[];
}

// runmath.in:315/324 的 quadraticroots：正文照抄 path.cc:46（实根那份）与 path.cc:103
// （复根那份）。Fuzz2/Fuzz4 是 bound.cc:13 与 path.cc:22 那两个常数。
// math.asy:397 的 `quadraticroots((1,0),(b,0),(t0,0))` 要的是复根那一份。
private real asy__Fuzz2 = 1000.0 * realEpsilon;
private real asy__Fuzz4 = asy__Fuzz2 * asy__Fuzz2;
// sqrt(1+x)-1，小 x 上不掉精度（path.h 的 sqrt1pxm1）
private real asy__sqrt1pxm1(real x) { return x / (sqrt(1 + x) + 1); }
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
real[] solve(real[][] a, real[] b, bool warn=true) {
  abort("solve 还没做（runarray.in:1267 的 LU 分解）"); return new real[];
}
real[][] solve(real[][] a, real[][] b, bool warn=true) {
  abort("solve 还没做（runarray.in:1320 的 LU 分解）"); return new real[][];
}
real[] tridiagonal(real[] a, real[] b, real[] c, real[] f) {
  abort("tridiagonal 还没做（runarray.in:1524 的循环三对角解法）"); return new real[];
}
real _findroot(real f(real), real a, real b, real tolerance, real fa, real fb) {
  abort("_findroot 还没做（runarray.in:1758 的 Brent 法）"); return 0;
}
pair[] fft(pair[] a, int sign=1) {
  abort("fft 还没做（runarray.in:1867 走的是 FFTW）"); return new pair[];
}
// 字形轮廓那两条（runlabel.in:243/349）：真 asy 一条走 TeX、一条读字体文件。
// 这一层没有那两路，所以体是 abort —— 签名在，plain_Label.asy:664 那一句才降得下来。
// 元数与返回类型都是照 runlabel.in 抄的：吃**一串**字符串与一串笔，回**每串一组**轮廓
// （plain_Label.asy:664 之后 `g[i][0]` / `g[i].delete(0)` 那几句钉着 path[][]）。
path[][] _texpath(string[] s, pen[] p) {
  abort("_texpath 还没做（TeX 那一路不在这一层）"); return new path[][];
}
path[][] textpath(string[] s, pen[] p) {
  abort("textpath 还没做（读字体文件那一路不在这一层）"); return new path[][];
}
void _shipout(string prefix="", frame f, frame preamble=null, string format="",
              bool wait=false, bool view=true, transform t=identity()) {
  abort("_shipout 还没做（EPS 那一路走的是自己那份 shipout）");
}
// 三维那两条出口（runpicture.in:486/512）。真 asy 一条走 PRC/v3d 的写盘与 GPU 渲染，
// 一条是 `f->shipout3(prefix,format)` 的短形。这一层两条都没有，所以体是 abort ——
// 签名在，three.asy:2624/2911 那三句才降得下来（`picture *f` 在 asy 那边就是 frame，
// realarray2 就是 real[][]：transform3 是 three.asy 里的 typedef，这一层看不见它）。
string defaultformat3="prc";                     // runpicture.in:121
void shipout3(string prefix, frame f, string format="",
              real width, real height, real angle, real zoom,
              triple m, triple M, pair shift, pair margin, real[][] t,
              real[][] tup, real[] background, triple[] lights, real[][] diffuse,
              bool view=true) {
  abort("shipout3 还没做（PRC/v3d 那一路不在这一层）");
}
void shipout3(string prefix, frame f, string format=defaultformat3) {
  abort("shipout3 还没做（PRC/v3d 那一路不在这一层）");
}
// _eval 两条（builtin.cc）：一条吃源码串，一条吃 `quote{}` 攒的 code。两条都要真去
// 再编一遍源码，这一层没有，所以体是 abort —— 签名在，plain 的 eval 那两支才降得下来。
void _eval(string s, bool embedded, bool interactiveWrite=false) {
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
triple minbezier(triple[][] P, triple b) {
  for (int i = 0; i < P.length; ++i) {
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      b = (min(b.x, v.x), min(b.y, v.y), min(b.z, v.z));
    }
  }
  return b;
}
triple maxbezier(triple[][] P, triple b) {
  for (int i = 0; i < P.length; ++i) {
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      b = (max(b.x, v.x), max(b.y, v.y), max(b.z, v.z));
    }
  }
  return b;
}
// 透视投影下的 x/y 比（picture.cc:135 的 xratio / yratio）
pair minratio(triple[][] P, pair b) {
  for (int i = 0; i < P.length; ++i) {
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      b = (min(b.x, v.x / v.z), min(b.y, v.y / v.z));
    }
  }
  return b;
}
pair maxratio(triple[][] P, pair b) {
  for (int i = 0; i < P.length; ++i) {
    for (int j = 0; j < P[i].length; ++j) {
      triple v = P[i][j];
      b = (max(b.x, v.x / v.z), max(b.y, v.y / v.z));
    }
  }
  return b;
}
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
 * mintimes / maxtimes（runpath.in:386/395 与 runpath3d.in:337）：逐分量取到极值的
 * **时刻**。真 asy 是在算包围盒时顺手记下来的（path.h 的 times.leftBound 那几格，解的是
 * 导数的零点）；这一层与 min/max(path3) 同一条路子 —— 采样取极值，所以时刻是近似的
 * （每段 32 个样点）。代价写在明处：强弯的段上时刻可能偏一点。
 */
private real[] asy__times(path g, bool wantMax)
{
  int n = length(g);
  real[] t = {0, 0};
  pair best = point(g, 0.0);
  int m = n * 32;
  for (int i = 1; i <= m; ++i) {
    real ti = n * (i / m);
    pair z = point(g, ti);
    if (wantMax ? z.x > best.x : z.x < best.x) { best = (z.x, best.y); t[0] = ti; }
    if (wantMax ? z.y > best.y : z.y < best.y) { best = (best.x, z.y); t[1] = ti; }
  }
  return t;
}

real[] mintimes(path g) { return asy__times(g, false); }
real[] maxtimes(path g) { return asy__times(g, true); }

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

void _image(frame f, real[][] data, pair initial, pair final,
            pen[] palette = new pen[], transform t = identity(), bool copy = true,
            bool antialias = false)
{
  abort("_image 还没做（图像要真的输出层）");
}

void _image(frame f, pen[][] data, pair initial, pair final,
            transform t = identity(), bool copy = true, bool antialias = false)
{
  abort("_image 还没做（图像要真的输出层）");
}

void _image(frame f, pen F(int, int), int width, int height,
            pair initial, pair final, transform t = identity(),
            bool antialias = false)
{
  abort("_image 还没做（图像要真的输出层）");
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

// 变换阵作用在单位立方体的八个角上（球/柱/盘那几个原语的界就是这么估的）
private void asy__addbox3(frame f, real[][] t)
{
  for (int i = -1; i <= 1; i += 2)
    for (int j = -1; j <= 1; j += 2)
      for (int k = -1; k <= 1; k += 2)
        asy__add3(f, t * ((i, j, k)));
}

/* Bezier 曲线（runpicture.in:648） */
void _draw(frame f, path3 g, triple center = (0, 0, 0), pen[] p,
           real opacity, real shininess, real metallic, real fresnel0,
           int interaction = 0)
{
  asy__add3(f, g);
}

/* Bezier 面片与三角面片（runpicture.in:660/674） */
void draw(frame f, triple[][] P, triple center, bool straight, pen[] p,
          real opacity, real shininess, real metallic, real fresnel0,
          bool lightOn, pen[] colors, int interaction, int digits,
          bool primitive = false)
{
  asy__add3(f, P);
}

void drawbeziertriangle(frame f, triple[][] P, triple center, bool straight,
                        pen[] p, real opacity, real shininess, real metallic,
                        real fresnel0, bool lightOn, pen[] colors,
                        int interaction, int digits, bool primitive = false)
{
  asy__add3(f, P);
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

/* 球 / 柱 / 盘 / 管（runpicture.in:703-730） */
void drawSphere(frame f, real[][] t, bool half = false, pen[] p, real opacity,
                real shininess, real metallic, real fresnel0, bool lightOn,
                int type)
{
  asy__addbox3(f, t);
}

void drawCylinder(frame f, real[][] t, pen[] p, real opacity, real shininess,
                  real metallic, real fresnel0, bool lightOn, bool core = false)
{
  asy__addbox3(f, t);
}

void drawDisk(frame f, real[][] t, pen[] p, real opacity, real shininess,
              real metallic, real fresnel0, bool lightOn)
{
  asy__addbox3(f, t);
}

void drawTube(frame f, triple[] g, real width, pen[] p, real opacity,
              real shininess, real metallic, real fresnel0, bool lightOn,
              triple min, triple max, bool core = false)
{
  asy__add3(f, min);
  asy__add3(f, max);
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
pair minratio(frame f) { return f.minr; }
pair maxratio(frame f) { return f.maxr; }

/* path3 上的同一对（runpath3d.in:352/357，path3.cc:326）：这一层按节点与控制点取界 */
pair minratio(path3 g)
{
  if (g.nodes.length == 0) { abort("minratio: 空的 path3"); return (0, 0); }
  pair b = (0, 0);
  bool first = true;
  for (int i = 0; i < g.nodes.length; ++i) {
    triple[] vs = {g.nodes[i].point, g.nodes[i].pre, g.nodes[i].post};
    for (int k = 0; k < 3; ++k) {
      triple v = vs[k];
      real rx = v.z == 0 ? 0 : v.x / v.z;
      real ry = v.z == 0 ? 0 : v.y / v.z;
      b = first ? (rx, ry) : (min(b.x, rx), min(b.y, ry));
      first = false;
    }
  }
  return b;
}

pair maxratio(path3 g)
{
  if (g.nodes.length == 0) { abort("maxratio: 空的 path3"); return (0, 0); }
  pair b = (0, 0);
  bool first = true;
  for (int i = 0; i < g.nodes.length; ++i) {
    triple[] vs = {g.nodes[i].point, g.nodes[i].pre, g.nodes[i].post};
    for (int k = 0; k < 3; ++k) {
      triple v = vs[k];
      real rx = v.z == 0 ? 0 : v.x / v.z;
      real ry = v.z == 0 ? 0 : v.y / v.z;
      b = first ? (rx, ry) : (max(b.x, rx), max(b.y, ry));
      first = false;
    }
  }
  return b;
}

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
