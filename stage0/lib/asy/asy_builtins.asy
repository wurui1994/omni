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




