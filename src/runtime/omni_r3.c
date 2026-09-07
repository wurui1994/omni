/* omni_r3.c —— 三维那一档的光栅化器（ADR-0014 第十九节）
 *
 * 为什么在 C 里：asy 的三维图**是 OpenGL 画出来的位图**（glrender.cc:523 的
 * glReadPixels 读回来，psfile.cc 的 drawRawImage 原样贴进 EPS）。要逐字节对齐，
 * 就得有同一套光栅化（逐采样 Z-buffer + 多重采样）与同一套片元着色（fragment.glsl
 * 的 PBR，**float 精度**）。这两样都不是"矢量 EPS 交给 gs"能做到的 ——
 * 量过（用 gs 自己当尺子，同一组坐标）：
 *   `fill`   的边有反锯齿：255 227 153 153 …
 *   `shfill` 的边**没有**：255   1   1   1 …（ShadingType 7 不走反锯齿那条路）
 * 所以面片每一片都外溢整整一个像素，而参考那边是 4 采样的覆盖率。差的一圈边就是它。
 *
 * 逐句照抄的四份（reference 里的行号）：
 *   renderBase.cc:111 setDimensions        —— 视景体（正交/透视）
 *   renderBase.cc:205 ortho / frustum      —— glm::ortho / glm::frustum 展开
 *   tile.h:136        beginTile            —— 分块与每块的视景体（单块也按它的公式）
 *   bezierpatch.h:45  normal / :89 Distance、triple.h:398 Straightness / :406 Flatness
 *   bezierpatch.cc:67 BezierPatch::render  —— 自适应细分的判据（res2）
 *   base/shaders/vertex.glsl:52/91         —— 法向与 params（Roughness = 1 - shininess）
 *   base/shaders/fragment.glsl:180-228/232 —— Cook-Torrance 的 D/G/F 与 main
 *
 * 输入是一份**文本清单**（asy 那一侧写的，见 asy_builtins.asy 的 asy__r3hexfn）：
 * 一行一条记录，空白分隔。这么定的原因：方言里还没有"把大数组交给运行时"的 ABI，
 * 而清单这条路两条腿（C / LLVM）一模一样，也方便拿手写的清单单测这个文件。
 *
 *   r3 1
 *   size   oW oH fw fh
 *   proj   ortho|persp  angle(度) zoom
 *   box    mx my mz Mx My Mz
 *   shift  sx sy
 *   bg     r g b
 *   res    res                       （BezierPatch::init 的 res，asy 侧算）
 *   light  dx dy dz  r g b           （可多条；方向已 unit 过，与 GL 同一套坐标）
 *   mat    dr dg db da  er eg eb  sr sg sb  shininess metallic fresnel0 lightOn
 *          —— 之后的 patch/tri/line 都用**最近一条** mat
 *   patch  straight(0/1)  x0 y0 z0 … x15 y15 z15   （16 个控制点，索引 4i+j）
 *   tri    ax ay az bx by bz cx cy cz
 *   line   n  x0 y0 z0 … xn-1 yn-1 zn-1           （折线，1 采样宽）
 *   end
 *
 * 回的是 fw*fh*3 个字节的十六进制（glReadPixels 的行序：**第 0 行在下**），
 * 也就是 asy 那边写进 EPS 的那一串。任何一处不合格就回空串。
 */

#include "omni.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ------------------------------------------------------------------ 三维向量
 * 与 reference 的 triple 一样是 double。**着色那一段才降到 float** ——
 * GL 的片元着色是 float，最后一位由它定。 */
typedef struct { double x, y, z; } r3v;

static r3v r3v_mk(double x, double y, double z) { r3v v; v.x = x; v.y = y; v.z = z; return v; }
static r3v r3v_add(r3v a, r3v b) { return r3v_mk(a.x + b.x, a.y + b.y, a.z + b.z); }
static r3v r3v_sub(r3v a, r3v b) { return r3v_mk(a.x - b.x, a.y - b.y, a.z - b.z); }
static r3v r3v_scl(double s, r3v a) { return r3v_mk(s * a.x, s * a.y, s * a.z); }
static double r3v_dot(r3v a, r3v b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static r3v r3v_cross(r3v a, r3v b) {
  return r3v_mk(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
static double r3v_abs2(r3v a) { return r3v_dot(a, a); }
static r3v r3v_unit(r3v a) {
  double n = sqrt(r3v_abs2(a));
  return n == 0.0 ? a : r3v_scl(1.0 / n, a);
}

/* triple.h:417/423 —— 二阶/三阶导数的那两格（照抄，连系数一起） */
static r3v r3_bezierPP(r3v a, r3v b, r3v c) {
  return r3v_sub(r3v_scl(3.0, r3v_add(a, c)), r3v_scl(6.0, b));
}
static r3v r3_bezierPPP(r3v a, r3v b, r3v c, r3v d) {
  return r3v_add(r3v_sub(d, a), r3v_scl(3.0, r3v_sub(b, c)));
}

/* triple.h:398 Straightness —— c0/c1 离 z0--z1 的两个内控制点的距离**平方**里大的那个 */
static double r3_straightness(r3v z0, r3v c0, r3v c1, r3v z1) {
  const double third = 1.0 / 3.0;
  r3v v = r3v_scl(third, r3v_sub(z1, z0));
  double a = r3v_abs2(r3v_sub(r3v_sub(c0, v), z0));
  double b = r3v_abs2(r3v_sub(r3v_sub(z1, v), c1));
  return a > b ? a : b;
}

/* triple.h:406 Flatness —— a--b 与 c--d 的相对平坦度平方的九分之一 */
static double r3_flatness(r3v a, r3v b, r3v c, r3v d) {
  const double ninth = 1.0 / 9.0;
  r3v u = r3v_sub(b, a);
  r3v v = r3v_sub(d, c);
  double p = r3v_abs2(r3v_cross(u, r3v_unit(v)));
  double q = r3v_abs2(r3v_cross(v, r3v_unit(u)));
  return ninth * (p > q ? p : q);
}

/* ------------------------------------------------------------------ 场景 */
#define R3_MAXLIGHT 8

typedef struct {
  double diffuse[4];    /* rgba */
  double emissive[3];
  double specular[3];
  double shininess;
  double metallic;
  double fresnel0;
  int lightOn;
} r3mat;

typedef struct {
  /* 顶点：位置（视图空间）+ 法向。三个一组一片三角 */
  r3v *pos;
  r3v *nrm;
  const r3mat **mat;
  /* 逐顶点色（rgba，一片三角 12 个 float）。只有清单里出现过 `pcol` 才分配 ——
   * vertex.glsl:77 的那一支：`mat.parameters[3]`（lightOn）非零时顶点色当 diffuse、
   * 为零时加到 emissive 上。 */
  float *col;
  int usecol;
  size_t n, cap;
} r3tris;

typedef struct {
  int oW, oH, fw, fh;
  int ortho;
  double angle, zoom;
  r3v m, M;
  double shiftx, shifty;
  double bg[3];
  double res;
  int nlight;
  r3v ldir[R3_MAXLIGHT];
  double lcol[R3_MAXLIGHT][3];
  /* 视景体（setDimensions 算出来的）*/
  double xmin, xmax, ymin, ymax, znear, zfar;
  /* 投影矩阵，列主序（与 glm 一样：P[col][row]）*/
  double P[4][4];
  /* 细分判据 */
  double res2;
  double epsilon;
  /* 消裂缝的内收量（bezierpatch.cc:39-49 的 `Epsilon`）：不透明面 `FillFactor*res`
   * （FillFactor = 0.1，:31），透明面 0 —— 透明时不能收，收了会露出背面。 */
  double Epsilon;
} r3scene;

/* ------------------------------------------------------------------ 顶点缓冲 */
static int r3tris_grow(r3tris *t, size_t need) {
  if (t->n + need <= t->cap) return 1;
  size_t cap = t->cap == 0 ? 4096 : t->cap;
  while (cap < t->n + need) cap *= 2;
  r3v *pos = (r3v *) realloc(t->pos, cap * sizeof(r3v));
  if (!pos) return 0;
  t->pos = pos;
  r3v *nrm = (r3v *) realloc(t->nrm, cap * sizeof(r3v));
  if (!nrm) return 0;
  t->nrm = nrm;
  const r3mat **mat = (const r3mat **) realloc(t->mat, (cap / 3 + 1) * sizeof(const r3mat *));
  if (!mat) return 0;
  t->mat = mat;
  if (t->usecol) {
    float *col = (float *) realloc(t->col, cap * 4 * sizeof(float));
    if (!col) return 0;
    t->col = col;
  }
  t->cap = cap;
  return 1;
}

/* 顶点法向进表前先归一 —— **vertex.glsl 里那句 `Normal=normalize(normal*normMat)`**。
 * 为什么要紧：`bezierpatch.h:45` 的 normal() 回的是**没归一**的叉乘，模长随那一片的
 * 大小变（球面上相邻顶点能差几倍）。GL 是"逐顶点归一 -> 插值 -> 逐片元再归一"，
 * 我们从前是"直接插值没归一的 -> 逐像素归一"，插出来的方向被模长大的那个顶点带偏。
 * 表现正是量到的样子：平面片逐位相同（法向都平行，归一与否无差），球面上从球心
 * （法向 (0,0,1)，逐位相同）往外平滑变大。
 * 量出来的（`size(100,0); currentprojection=orthographic(0,0,1); draw(unitsphere,red);`
 * 渲成 400x400 逐字节比，480000 字节）：归一前 90930 字节不同、绝对值和 385189；
 * 归一后 **209 / 888**（最大差 16）。平面片那把尺子两边都是 0。
 * 判据上（tests/asy/eps.js，位图不同字节数 前 -> 后）：roll 242997->324、
 * torus 142479->687、cylinder 91051->1126、cones 87622->2911、sphere 341812->56381、
 * hyperboloid 300689->34570、BezierPatch 274160->32057、sacylinder3D 161772->46126。 */
static r3v r3v_unit0(r3v v) {
  double m = r3v_abs2(v);
  if (m <= 0.0) return v;
  return r3v_scl(1.0 / sqrt(m), v);
}

/* 一片三角进表。`c` 是 12 个 float（三个顶点的 rgba），没有顶点色时给 NULL。 */
static int r3tris_pushc(r3tris *t, r3v a, r3v na, r3v b, r3v nb, r3v c, r3v nc,
                        const r3mat *m, const float *vc) {
  if (!r3tris_grow(t, 3)) return 0;
  t->mat[t->n / 3] = m;
  if (t->usecol) {
    float *o = t->col + t->n * 4;
    if (vc) for (int i = 0; i < 12; ++i) o[i] = vc[i];
    else for (int i = 0; i < 12; ++i) o[i] = -1.0f;   /* -1 = 这一片没有顶点色 */
  }
  t->pos[t->n] = a; t->nrm[t->n] = r3v_unit0(na); t->n++;
  t->pos[t->n] = b; t->nrm[t->n] = r3v_unit0(nb); t->n++;
  t->pos[t->n] = c; t->nrm[t->n] = r3v_unit0(nc); t->n++;
  return 1;
}

static int r3tris_push(r3tris *t, r3v a, r3v na, r3v b, r3v nb, r3v c, r3v nc,
                       const r3mat *m) {
  return r3tris_pushc(t, a, na, b, nb, c, nc, m, NULL);
}

/* ------------------------------------------------------------------ 面片细分
 * bezierpatch.h:45 的 normal()：控制网的角法向。一阶叉乘退化时依次退到二阶、三阶
 * （epsilon 是 bezierpatch.cc:70-73 那一段：控制点到 p0 的最大距离平方 × DBL_EPSILON）。 */
static r3v r3_normal(const r3scene *s, r3v l3, r3v l2, r3v l1, r3v mid,
                     r3v r1, r3v r2, r3v r3) {
  double eps = s->epsilon;
  r3v lp = r3v_scl(3.0, r3v_sub(l1, mid));
  r3v rp = r3v_scl(3.0, r3v_sub(r1, mid));
  r3v n = r3v_cross(rp, lp);
  if (r3v_abs2(n) > eps) return n;

  r3v lpp = r3_bezierPP(mid, l1, l2);
  r3v rpp = r3_bezierPP(mid, r1, r2);
  n = r3v_add(r3v_cross(rpp, lp), r3v_cross(rp, lpp));
  if (r3v_abs2(n) > eps) return n;

  r3v lppp = r3_bezierPPP(mid, l1, l2, l3);
  r3v rppp = r3_bezierPPP(mid, r1, r2, r3);
  n = r3v_add(r3v_add(r3v_cross(rpp, lpp), r3v_cross(rppp, lp)), r3v_cross(rp, lppp));
  if (r3v_abs2(n) > eps) return n;

  n = r3v_add(r3v_cross(rppp, lpp), r3v_cross(rpp, lppp));
  if (r3v_abs2(n) > eps) return n;

  return r3v_cross(rppp, lppp);
}

/* bezierpatch.h:89 Distance —— 水平/竖直两个方向各自的"平坦度"
 * （逐行对过：h 是 Flatness(p0,p12,p3,p15) + 四条 4/8 列的 Straightness，
 *  v 是 Flatness(p0,p3,p12,p15) + 四条 1/2 行的 —— 参数次序与 x/y 的对应都一致，
 *  **h/v 没有反**；查 sphere 那 2.8% 时排除过这一格。） */
static void r3_distance(const r3v *p, double *h, double *v) {
  r3v p0 = p[0], p3 = p[3], p12 = p[12], p15 = p[15];
  double H = r3_flatness(p0, p12, p3, p15);
  double t;
  t = r3_straightness(p0, p[4], p[8], p12); if (t > H) H = t;
  t = r3_straightness(p[1], p[5], p[9], p[13]); if (t > H) H = t;
  t = r3_straightness(p[2], p[6], p[10], p[14]); if (t > H) H = t;
  t = r3_straightness(p3, p[7], p[11], p15); if (t > H) H = t;

  double V = r3_flatness(p0, p3, p12, p15);
  t = r3_straightness(p0, p[1], p[2], p3); if (t > V) V = t;
  t = r3_straightness(p[4], p[5], p[6], p[7]); if (t > V) V = t;
  t = r3_straightness(p[8], p[9], p[10], p[11]); if (t > V) V = t;
  t = r3_straightness(p12, p[13], p[14], p15); if (t > V) V = t;

  *h = H; *v = V;
}

/* bezierpatch.h:114 Split3 —— 一条三次曲线对半分（de Casteljau） */
typedef struct { r3v m0, m2, m3, m4, m5; } r3split;
static r3split r3_split3(r3v z0, r3v c0, r3v c1, r3v z1) {
  r3split s;
  s.m0 = r3v_scl(0.5, r3v_add(z0, c0));
  r3v m1 = r3v_scl(0.5, r3v_add(c0, c1));
  s.m2 = r3v_scl(0.5, r3v_add(c1, z1));
  s.m3 = r3v_scl(0.5, r3v_add(s.m0, m1));
  s.m4 = r3v_scl(0.5, r3v_add(m1, s.m2));
  s.m5 = r3v_scl(0.5, r3v_add(s.m3, s.m4));
  return s;
}

/* 控制点索引是 4*i+j（i 是水平、j 是竖直，见 bezierpatch.cc:198 的那张图）。
 * 一刀四分：先按 i 对半，再各自按 j 对半。 */
static void r3_split4(const r3v *p, r3v out[4][16]) {
  r3v L[16], R[16];
  for (int j = 0; j < 4; ++j) {
    r3split s = r3_split3(p[j], p[4 + j], p[8 + j], p[12 + j]);
    L[j] = p[j];      L[4 + j] = s.m0; L[8 + j] = s.m3; L[12 + j] = s.m5;
    R[j] = s.m5;      R[4 + j] = s.m4; R[8 + j] = s.m2; R[12 + j] = p[12 + j];
  }
  const r3v *half[2]; half[0] = L; half[1] = R;
  for (int k = 0; k < 2; ++k) {
    const r3v *q = half[k];
    for (int i = 0; i < 4; ++i) {
      r3split s = r3_split3(q[4 * i + 0], q[4 * i + 1], q[4 * i + 2], q[4 * i + 3]);
      r3v *lo = out[2 * k + 0];
      r3v *hi = out[2 * k + 1];
      lo[4 * i + 0] = q[4 * i + 0]; lo[4 * i + 1] = s.m0;
      lo[4 * i + 2] = s.m3;         lo[4 * i + 3] = s.m5;
      hi[4 * i + 0] = s.m5;         hi[4 * i + 1] = s.m4;
      hi[4 * i + 2] = s.m2;         hi[4 * i + 3] = q[4 * i + 3];
    }
  }
}

/* bezierpatch.h:76 differential —— 三次曲线在 0 处的"导向"（只要方向，长度无所谓）：
 * 先试 `p1-p0`，模方不够大再退到二阶、三阶。门限与法向那边共用 `s->epsilon`。 */
static r3v r3_differential(const r3scene *s, r3v p0, r3v p1, r3v p2, r3v p3) {
  r3v d = r3v_sub(p1, p0);
  if (r3v_abs2(d) > s->epsilon) return d;
  d = r3_bezierPP(p0, p1, p2);
  if (r3v_abs2(d) > s->epsilon) return d;
  return r3_bezierPPP(p0, p1, p2, p3);
}

/* 只切一刀的两种半分（原版 bezierpatch.cc:249-262 与 :342-355）。
 * `j` 是 index+=1 那一维、`i` 是 index+=4 那一维。 */
static void r3_split2j(const r3v *p, r3v a[16], r3v b[16]) {
  for (int i = 0; i < 4; ++i) {
    r3split s = r3_split3(p[4 * i + 0], p[4 * i + 1], p[4 * i + 2], p[4 * i + 3]);
    a[4 * i + 0] = p[4 * i + 0]; a[4 * i + 1] = s.m0;
    a[4 * i + 2] = s.m3;         a[4 * i + 3] = s.m5;
    b[4 * i + 0] = s.m5;         b[4 * i + 1] = s.m4;
    b[4 * i + 2] = s.m2;         b[4 * i + 3] = p[4 * i + 3];
  }
}

static void r3_split2i(const r3v *p, r3v a[16], r3v b[16]) {
  for (int j = 0; j < 4; ++j) {
    r3split s = r3_split3(p[j], p[4 + j], p[8 + j], p[12 + j]);
    a[j] = p[j];  a[4 + j] = s.m0; a[8 + j] = s.m3; a[12 + j] = s.m5;
    b[j] = s.m5;  b[4 + j] = s.m4; b[8 + j] = s.m2; b[12 + j] = p[12 + j];
  }
}

/* 四个角的法向（bezierpatch.cc:79-101，连退化时换哪三条控制线一起抄） */
static void r3_corner_normals(const r3scene *s, const r3v *p, r3v n[4]) {
  r3v p0 = p[0], p3 = p[3], p12 = p[12], p15 = p[15];
  double eps = s->epsilon;

  r3v n0 = r3_normal(s, p3, p[2], p[1], p0, p[4], p[8], p12);
  if (r3v_abs2(n0) <= eps) {
    n0 = r3_normal(s, p3, p[2], p[1], p0, p[13], p[14], p15);
    if (r3v_abs2(n0) <= eps) n0 = r3_normal(s, p15, p[11], p[7], p3, p[4], p[8], p12);
  }
  r3v n1 = r3_normal(s, p0, p[4], p[8], p12, p[13], p[14], p15);
  if (r3v_abs2(n1) <= eps) {
    n1 = r3_normal(s, p0, p[4], p[8], p12, p[11], p[7], p3);
    if (r3v_abs2(n1) <= eps) n1 = r3_normal(s, p3, p[2], p[1], p0, p[13], p[14], p15);
  }
  r3v n2 = r3_normal(s, p12, p[13], p[14], p15, p[11], p[7], p3);
  if (r3v_abs2(n2) <= eps) {
    n2 = r3_normal(s, p12, p[13], p[14], p15, p[2], p[1], p0);
    if (r3v_abs2(n2) <= eps) n2 = r3_normal(s, p0, p[4], p[8], p12, p[11], p[7], p3);
  }
  r3v n3 = r3_normal(s, p15, p[11], p[7], p3, p[2], p[1], p0);
  if (r3v_abs2(n3) <= eps) {
    n3 = r3_normal(s, p15, p[11], p[7], p3, p[4], p[8], p12);
    if (r3v_abs2(n3) <= eps) n3 = r3_normal(s, p12, p[13], p[14], p15, p[2], p[1], p0);
  }
  n[0] = n0; n[1] = n1; n[2] = n2; n[3] = n3;
}

/* bezierpatch.cc:174 的递归，**三个分支都在**：两个方向都平了出两片三角；只有一个方向平
 * 就往另一个方向切一刀（:227 / :319）；都不平才四分（:435）。
 *
 * 原版的关键约定：四个角 P0..P3 与它们的法向 N0..N3 是**从父片传下来的**，不是子片自己
 * 从控制网重算的 —— 只有新出现的中点才现算法向。相邻子片因此共用同一个中点顶点，
 * 网格是缝合的。（从前我们每个子片都调 r3_corner_normals 重算四角，那是另一回事。）
 *
 * 还有一手**消裂缝的内收**：`Epsilon = FillFactor*res`，`FillFactor = 0.1`（:31、:47）。
 * 一条边**第一次**被判定为直、而整片还没平时，那条边的中点被顺着切线往内拉：
 *   m0 -= Epsilon * unit(differential(...));
 * 已经直过的边（flat 标记为真）不再动。透明面 Epsilon = 0（收了会露背面）。
 * 少了这一层的代价是轮廓比参考大，量出来的（/tmp/dot/d3.asy：`draw(X, 10pt+green)`
 * 一颗点，逐像素按覆盖率加权）：参考 面积 1327.0 等效半径 20.5523 最远墨点 22.220，
 * 补之前我们是 1364.5 / 20.8406 / 22.503 —— 半径大 1.40%、面积大 2.83%。
 * 而位置与着色本来就是对的（三颗点质心 dx ≤0.16 px、dy ≤0.02 px，实心区两边都是
 * rgb(0,255,0) 一个字节不差），所以三维位图的残差就是这一处。
 *
 * `r3_split4` 出来的 out[0..3] 依次是原版的 s0/s3/s1/s2（凭据是原版那四行退化赋值
 * `m0 = s0[12]`、`m1 = s1[15]`、`m2 = s2[3]`、`m3 = s3[0]`，:498/506/514/522，
 * 与我们四块的角点一一对上），所以下面用 `sq[] = {q[0], q[2], q[3], q[1]}` 换成 s 序，
 * 之后一律按原版的 s0..s3 读写，省得两套下标混着。 */
/* 面片/三角面片递归的深度上限。原版没有上限（靠判据必然收敛），我们留一个是为了
 * 清单里 res 缺失或判据出 NaN 时不至于一路递归下去。
 * **量过：它就是纯保险，平时碰不到。** 斜相机那把敏感的尺子
 * （`size(200); currentprojection=orthographic(5,4,3); draw(unitsphere,green);`）上
 * 上限取 8 / 10 / 12，位图**一个字节都不差**（都是 56381/1929600、和 433456）。
 * 所以斜相机剩下那 2.8% 与深度上限无关。`OMNI_R3_DEPTH` 留着标定用。 */
static int r3_depthcap(void) {
  const char *e = getenv("OMNI_R3_DEPTH");
  if (e) { int v = atoi(e); if (v > 0) return v; }
  return 8;
}

static int r3_render_patch(const r3scene *s, r3tris *t, const r3v *p,
                           r3v P0, r3v P1, r3v P2, r3v P3,
                           r3v N0, r3v N1, r3v N2, r3v N3,
                           int flat0, int flat1, int flat2, int flat3,
                           const r3mat *mat, const float *C, int depth) {
  double h, v;
  r3_distance(p, &h, &v);
  /* res2 <= 0（清单里没给 res）或者判据不是有限数时**当成平的** —— 不然一片就能
   * 递归到深度上限。深度上限压到 8，原版没有上限，靠的是判据必然收敛。 */
  int bad = !(s->res2 > 0 && h == h && v == v) || depth >= r3_depthcap();
  if (bad || (h < s->res2 && v < s->res2)) {
    if (C) {
      float a[12], b[12];
      for (int i = 0; i < 4; ++i) {
        a[i] = C[i]; a[4 + i] = C[4 + i]; a[8 + i] = C[8 + i];
        b[i] = C[i]; b[4 + i] = C[8 + i]; b[8 + i] = C[12 + i];
      }
      if (!r3tris_pushc(t, P0, N0, P1, N1, P2, N2, mat, a)) return 0;
      if (!r3tris_pushc(t, P0, N0, P2, N2, P3, N3, mat, b)) return 0;
      return 1;
    }
    if (!r3tris_push(t, P0, N0, P1, N1, P2, N2, mat)) return 0;
    if (!r3tris_push(t, P0, N0, P2, N2, P3, N3, mat)) return 0;
    return 1;
  }
  const double eps = s->epsilon;
  const double E = s->Epsilon;

  if (h < s->res2) {
    /* 水平已平，沿竖直（index+=1 那一维）切一刀：s0 是 j∈[0,½]、s1 是 j∈[½,1]。
     * 角： s0 (P0,P1,m0,m1)、s1 (m1,m0,P2,P3)，m0 在 P1P2 上、m1 在 P3P0 上。 */
    r3v s0[16], s1[16];
    r3_split2j(p, s0, s1);

    r3v n0 = r3_normal(s, s0[12], s0[13], s0[14], s0[15], s0[11], s0[7], s0[3]);
    if (r3v_abs2(n0) <= eps) {
      n0 = r3_normal(s, s0[12], s0[13], s0[14], s0[15], s0[2], s0[1], s0[0]);
      if (r3v_abs2(n0) <= eps)
        n0 = r3_normal(s, s0[0], s0[4], s0[8], s0[12], s0[11], s0[7], s0[3]);
    }
    r3v n1 = r3_normal(s, s1[3], s1[2], s1[1], s1[0], s1[4], s1[8], s1[12]);
    if (r3v_abs2(n1) <= eps) {
      n1 = r3_normal(s, s1[3], s1[2], s1[1], s1[0], s1[13], s1[14], s1[15]);
      if (r3v_abs2(n1) <= eps)
        n1 = r3_normal(s, s1[15], s1[11], s1[7], s1[3], s1[4], s1[8], s1[12]);
    }

    r3v m0 = r3v_scl(0.5, r3v_add(P1, P2));
    if (!flat1) {
      if ((flat1 = r3_straightness(p[12], p[13], p[14], p[15]) < s->res2)) {
        if (E) m0 = r3v_sub(m0, r3v_scl(E, r3v_unit(
                      r3_differential(s, s1[12], s1[8], s1[4], s1[0]))));
      } else m0 = s0[15];
    }
    r3v m1 = r3v_scl(0.5, r3v_add(P3, P0));
    if (!flat3) {
      if ((flat3 = r3_straightness(p[0], p[1], p[2], p[3]) < s->res2)) {
        if (E) m1 = r3v_sub(m1, r3v_scl(E, r3v_unit(
                      r3_differential(s, s0[3], s0[7], s0[11], s0[15]))));
      } else m1 = s1[0];
    }

    float a0[16], a1[16];
    if (C) {
      for (int i = 0; i < 4; ++i) {
        float c0 = 0.5f * (C[4 + i] + C[8 + i]);      /* 在 P1P2 上 */
        float c1 = 0.5f * (C[12 + i] + C[i]);         /* 在 P3P0 上 */
        a0[i] = C[i];  a0[4 + i] = C[4 + i]; a0[8 + i] = c0;       a0[12 + i] = c1;
        a1[i] = c1;    a1[4 + i] = c0;       a1[8 + i] = C[8 + i]; a1[12 + i] = C[12 + i];
      }
    }
    if (!r3_render_patch(s, t, s0, P0, P1, m0, m1, N0, N1, n0, n1,
                         flat0, flat1, 0, flat3, mat, C ? a0 : NULL, depth + 1)) return 0;
    return r3_render_patch(s, t, s1, m1, m0, P2, P3, n1, n0, N2, N3,
                           0, flat1, flat2, flat3, mat, C ? a1 : NULL, depth + 1);
  }

  if (v < s->res2) {
    /* 竖直已平，沿水平（index+=4 那一维）切一刀：s0 是 i∈[0,½]、s1 是 i∈[½,1]。
     * 角： s0 (P0,m0,m1,P3)、s1 (m0,P1,P2,m1)，m0 在 P0P1 上、m1 在 P2P3 上。 */
    r3v s0[16], s1[16];
    r3_split2i(p, s0, s1);

    r3v n0 = r3_normal(s, s0[0], s0[4], s0[8], s0[12], s0[13], s0[14], s0[15]);
    if (r3v_abs2(n0) <= eps) {
      n0 = r3_normal(s, s0[0], s0[4], s0[8], s0[12], s0[11], s0[7], s0[3]);
      if (r3v_abs2(n0) <= eps)
        n0 = r3_normal(s, s0[3], s0[2], s0[1], s0[0], s0[13], s0[14], s0[15]);
    }
    r3v n1 = r3_normal(s, s1[15], s1[11], s1[7], s1[3], s1[2], s1[1], s1[0]);
    if (r3v_abs2(n1) <= eps) {
      n1 = r3_normal(s, s1[15], s1[11], s1[7], s1[3], s1[4], s1[8], s1[12]);
      if (r3v_abs2(n1) <= eps)
        n1 = r3_normal(s, s1[12], s1[13], s1[14], s1[15], s1[2], s1[1], s1[0]);
    }

    r3v m0 = r3v_scl(0.5, r3v_add(P0, P1));
    if (!flat0) {
      if ((flat0 = r3_straightness(p[0], p[4], p[8], p[12]) < s->res2)) {
        if (E) m0 = r3v_sub(m0, r3v_scl(E, r3v_unit(
                      r3_differential(s, s1[0], s1[1], s1[2], s1[3]))));
      } else m0 = s0[12];
    }
    r3v m1 = r3v_scl(0.5, r3v_add(P2, P3));
    if (!flat2) {
      if ((flat2 = r3_straightness(p[15], p[11], p[7], p[3]) < s->res2)) {
        if (E) m1 = r3v_sub(m1, r3v_scl(E, r3v_unit(
                      r3_differential(s, s0[15], s0[14], s0[13], s0[12]))));
      } else m1 = s1[3];
    }

    float a0[16], a1[16];
    if (C) {
      for (int i = 0; i < 4; ++i) {
        float c0 = 0.5f * (C[i] + C[4 + i]);          /* 在 P0P1 上 */
        float c1 = 0.5f * (C[8 + i] + C[12 + i]);     /* 在 P2P3 上 */
        a0[i] = C[i]; a0[4 + i] = c0;       a0[8 + i] = c1;       a0[12 + i] = C[12 + i];
        a1[i] = c0;   a1[4 + i] = C[4 + i]; a1[8 + i] = C[8 + i]; a1[12 + i] = c1;
      }
    }
    if (!r3_render_patch(s, t, s0, P0, m0, m1, P3, N0, n0, n1, N3,
                         flat0, 0, flat2, flat3, mat, C ? a0 : NULL, depth + 1)) return 0;
    return r3_render_patch(s, t, s1, m0, P1, P2, m1, n0, N1, N2, n1,
                           flat0, flat1, flat2, 0, mat, C ? a1 : NULL, depth + 1);
  }

  /* 两个方向都不平：四分（bezierpatch.cc:435-556）。
   *   m2
   *  P3--+--P2      s3 s2        m0 在 P0P1、m1 在 P1P2、m2 在 P2P3、m3 在 P3P0、m4 是中心
   * m3+--+--+m1
   *  P0--+--P1      s0 s1
   *      m0                                                                          */
  r3v q[4][16];
  r3_split4(p, q);
  const r3v *sq[4] = { q[0], q[2], q[3], q[1] };   /* s0/s1/s2/s3 */
  const r3v *S0 = sq[0], *S1 = sq[1], *S2 = sq[2], *S3 = sq[3];
  r3v m4 = S0[15];

  r3v n0 = r3_normal(s, S0[0], S0[4], S0[8], S0[12], S0[13], S0[14], S0[15]);
  if (r3v_abs2(n0) <= eps) {
    n0 = r3_normal(s, S0[0], S0[4], S0[8], S0[12], S0[11], S0[7], S0[3]);
    if (r3v_abs2(n0) <= eps)
      n0 = r3_normal(s, S0[3], S0[2], S0[1], S0[0], S0[13], S0[14], S0[15]);
  }
  r3v n1 = r3_normal(s, S1[12], S1[13], S1[14], S1[15], S1[11], S1[7], S1[3]);
  if (r3v_abs2(n1) <= eps) {
    n1 = r3_normal(s, S1[12], S1[13], S1[14], S1[15], S1[2], S1[1], S1[0]);
    if (r3v_abs2(n1) <= eps)
      n1 = r3_normal(s, S1[0], S1[4], S1[8], S1[12], S1[11], S1[7], S1[3]);
  }
  r3v n2 = r3_normal(s, S2[15], S2[11], S2[7], S2[3], S2[2], S2[1], S2[0]);
  if (r3v_abs2(n2) <= eps) {
    n2 = r3_normal(s, S2[15], S2[11], S2[7], S2[3], S2[4], S2[8], S2[12]);
    if (r3v_abs2(n2) <= eps)
      n2 = r3_normal(s, S2[12], S2[13], S2[14], S2[15], S2[2], S2[1], S2[0]);
  }
  r3v n3 = r3_normal(s, S3[3], S3[2], S3[1], S3[0], S3[4], S3[8], S3[12]);
  if (r3v_abs2(n3) <= eps) {
    n3 = r3_normal(s, S3[3], S3[2], S3[1], S3[0], S3[13], S3[14], S3[15]);
    if (r3v_abs2(n3) <= eps)
      n3 = r3_normal(s, S3[15], S3[11], S3[7], S3[3], S3[4], S3[8], S3[12]);
  }
  /* 中心那一点只算一次、不退化（原版 :488 也没有退化分支） */
  r3v n4 = r3_normal(s, S2[3], S2[2], S2[1], m4, S2[4], S2[8], S2[12]);

  r3v m0 = r3v_scl(0.5, r3v_add(P0, P1));
  if (!flat0) {
    if ((flat0 = r3_straightness(p[0], p[4], p[8], p[12]) < s->res2)) {
      if (E) m0 = r3v_sub(m0, r3v_scl(E, r3v_unit(
                    r3_differential(s, S1[0], S1[1], S1[2], S1[3]))));
    } else m0 = S0[12];
  }
  r3v m1 = r3v_scl(0.5, r3v_add(P1, P2));
  if (!flat1) {
    if ((flat1 = r3_straightness(p[12], p[13], p[14], p[15]) < s->res2)) {
      if (E) m1 = r3v_sub(m1, r3v_scl(E, r3v_unit(
                    r3_differential(s, S2[12], S2[8], S2[4], S2[0]))));
    } else m1 = S1[15];
  }
  r3v m2 = r3v_scl(0.5, r3v_add(P2, P3));
  if (!flat2) {
    if ((flat2 = r3_straightness(p[15], p[11], p[7], p[3]) < s->res2)) {
      if (E) m2 = r3v_sub(m2, r3v_scl(E, r3v_unit(
                    r3_differential(s, S3[15], S3[14], S3[13], S3[12]))));
    } else m2 = S2[3];
  }
  r3v m3 = r3v_scl(0.5, r3v_add(P3, P0));
  if (!flat3) {
    if ((flat3 = r3_straightness(p[0], p[1], p[2], p[3]) < s->res2)) {
      if (E) m3 = r3v_sub(m3, r3v_scl(E, r3v_unit(
                    r3_differential(s, S0[3], S0[7], S0[11], S0[15]))));
    } else m3 = S3[0];
  }

  /* 顶点色跟着一起细分（:528-534 那五行：边中点取两端平均、中心取 c0 与 c2 的平均），
   * 四块的角色照 :542-545 分派。sub[k] 已经是 s 序，与 sq[k] 对齐。 */
  float sub[4][16];
  if (C) {
    for (int i = 0; i < 4; ++i) {
      float c0 = 0.5f * (C[i] + C[4 + i]);
      float c1 = 0.5f * (C[4 + i] + C[8 + i]);
      float c2 = 0.5f * (C[8 + i] + C[12 + i]);
      float c3 = 0.5f * (C[12 + i] + C[i]);
      float c4 = 0.5f * (c0 + c2);
      sub[0][i] = C[i]; sub[0][4 + i] = c0;       sub[0][8 + i] = c4;       sub[0][12 + i] = c3;
      sub[1][i] = c0;   sub[1][4 + i] = C[4 + i]; sub[1][8 + i] = c1;       sub[1][12 + i] = c4;
      sub[2][i] = c4;   sub[2][4 + i] = c1;       sub[2][8 + i] = C[8 + i]; sub[2][12 + i] = c2;
      sub[3][i] = c3;   sub[3][4 + i] = c4;       sub[3][8 + i] = c2;       sub[3][12 + i] = C[12 + i];
    }
  }

  if (!r3_render_patch(s, t, S0, P0, m0, m4, m3, N0, n0, n4, n3,
                       flat0, 0, 0, flat3, mat, C ? sub[0] : NULL, depth + 1)) return 0;
  if (!r3_render_patch(s, t, S1, m0, P1, m1, m4, n0, N1, n1, n4,
                       flat0, flat1, 0, 0, mat, C ? sub[1] : NULL, depth + 1)) return 0;
  if (!r3_render_patch(s, t, S2, m4, m1, P2, m2, n4, n1, N2, n2,
                       0, flat1, flat2, 0, mat, C ? sub[2] : NULL, depth + 1)) return 0;
  return r3_render_patch(s, t, S3, m3, m4, m2, P3, n3, n4, n2, N3,
                         0, 0, flat2, flat3, mat, C ? sub[3] : NULL, depth + 1);
}

/* **每一片自己的 res**（原版 bezierpatch.h:185 `init(pixelResolution*ratio)`）。
 * ratio 是 drawsurface.cc:297-316 那三行，配 renderBase.cc:245-251 的实参：
 *   b = (xmin, ymin, Zmin)、B = (xmax, ymax, Zmax)   —— 视景体的横竖界 + 场景 z 界
 *   size2 = hypot(Width, Height)                     —— 光栅目标的像素尺寸
 *   perspective = ortho ? 0 : 1/Zmax
 *   s = perspective ? Min.z * perspective : 1        —— Min 是**这一片控制点**的 bbox
 *   ratio = |(s*(B.x-b.x), s*(B.y-b.y))| / size2
 * pixelResolution = 1.0（render.h:30）。所以
 *   res = s * hypot(xmax-xmin, ymax-ymin) / hypot(fw, fh)，s = (片内最小 z) / M.z
 * 两边都是负数，s >= 1：越靠后的片 res 越大、细分越粗 —— 透视下远处一个像素对应更多
 * 用户单位，正是这一格的意思。
 *
 * 从前这儿用的是清单里那个全局 `res = (M.x-m.x)/fw`（asy_builtins.asy:10670 那一格自己
 * 也写着"具体取值还没量到"）。量出来的代价（/tmp/dot/d7.asy 六颗 10pt 的点，逐像素按
 * 覆盖率加权）：六颗的面积一律比参考大 1.07%~1.43%（半径大 0.5%~0.7%），
 * 而**位置只差 0.16 px 以内** —— 也就是说错的不是投影，是细分的粗细与内收量。 */
static double r3_res_for(const r3scene *s, const r3v *p, int n) {
  double sc = 1.0;
  if (!s->ortho && s->M.z != 0.0) {
    double zmin = p[0].z;
    for (int i = 1; i < n; ++i) if (p[i].z < zmin) zmin = p[i].z;
    sc = zmin / s->M.z;
  }
  /* **宽高取的是"视景体"（setDimensions 出来的小写 xmin/xmax），不是场景盒 —— 试过，
   * 换成场景盒整体变坏。** renderBase.cc:103-105 里那三行用的是大写 `Xmin/Xmax`
   * （构造函数从 `args.m/args.M` 存的场景盒），照抄过来量下来是：
   *   torus 687 → 30150、roll 324 → 32423、cylinder 1126 → 6131、
   *   vertexshading 4792 → 72040、colorpatch 51847 → 77416、BezierPatch 32057 → 49374、
   *   conicurv 41246 → 68601（ink 覆盖 99.1% → 92.9%），
   *   而斜相机那把球尺子几乎不动（56381 → 56384）、正对着的 510 一动不动。
   * 也就是说那三行不是这一格的出处（真正的出处是 drawsurface.cc:297-316 那一族），
   * 已经退回视景体这一版。斜相机那 2.8% 与这一格无关。 */
  double w = sc * (s->xmax - s->xmin), h = sc * (s->ymax - s->ymin);
  double d = hypot((double) s->fw, (double) s->fh);
  /* **就是上面那串公式，不乘任何系数。** 这一格我一度乘过 √2（"一个像素的对角线"），
   * 是拿一把尺子标出来的；第二把尺子把它推翻了，记在这儿免得再犯：
   *   不打光的大球（`draw(unitsphere,yellow,light=nolight)`，位图 4320000 字节）：
   *     系数 1.0 → 2763 字节不同；1.33~1.6 → 40；2.0 → 5994
   *   一条 2bp 的三维线（`draw((-3,0,0)--(3,0,0),linewidth(2bp))`，三维里是根细管）：
   *     系数 ≤1.0 → 墨量比 1.0009（对上）；≥1.414 → **0.7394**，管子细了 26%
   * 两把尺子没有公共的系数 —— 说明"乘个常数"这条路本身不对（真正的公式大概不是
   * 每片乘 `s = 片内最小z / 场景最大z` 这么简单）。在两害之间取按**看得见的误差**算：
   * 细管窄 26% 是肉眼可见的（conicurv 的 ink 重合只有 63.9%，那张图全是 2bp 的线和圆），
   * 而大球那 2763 字节是 0.064% 的着色噪声。所以留 1.0，也就是原版公式的逐句转写。
   * `OMNI_R3_RES` 留着重新标定用。
   *
   * **第三把尺子（逐像素，比上面两把都可信）**：`size(100,0);
   * currentprojection=orthographic(0,0,1); draw(unitsphere,red);`，两边都渲成 400x400
   * 再逐字节比（480000 字节）：
   *   系数 0.25 → 92329 字节不同、最大 64、绝对值和 352039
   *   系数 0.35 → 89254 / 63 / 256889
   *   系数 0.5  → 88136 / 60 / 251946      ← 浅谷底
   *   系数 0.75 → 89149 / 79 / 339601
   *   系数 1.0  → 90930 / 79 / 385189
   *   系数 1.5  → 101005 / 176 / 820207
   *   系数 2.0  → 104208 / 176 / 823836
   * 两条结论：
   *  1. **谷底很浅、而且不收敛到 0** —— 再细分下去（0.25）反而更差。所以剩下的球面
   *     着色差**不是细分密度**造成的，换系数治不了它。
   *  2. 球心（法向正好是 (0,0,1)）两边逐位相同（183,1,1），平面片也逐位相同；差是
   *     **随法向偏离视线方向平滑增大**的 —— 后来查明就是顶点法向没归一（见
   *     `r3v_unit0` 上面那段），补上之后同一把尺子从 90930/385189 掉到 209/888。
   *     **所以上面那张系数表是"法向没归一"时候量的，已经作废**。
   *     归一之后在**斜相机**那把尺子上重量过（`size(200);
   *     currentprojection=orthographic(5,4,3); draw(unitsphere,green);`，1929600 字节）：
   *       0.5 → 53446 / 和 377671；0.7 → 55259 / 402020；1.0 → 56381 / 433456；
   *       1.4 → 101788 / 935415
   *     0.5~1.0 之间几乎是平的（差 5%），1.4 才明显变坏 —— 也就是说斜相机剩下的那 2.8%
   *     **不是系数问题**。同一个球正对着看只差 510/1920000，光的方向、BRDF、render 参数
   *     都单独排除过（见 asy_builtins.asy 光那一行上面的注释），下一刀该比的是
   *     **三角化的拓扑**（r3_render_patch 每一层发三角的顺序/对角线选法对 bezierpatch.cc）。
   * 这一格仍留 1.0：它是原版公式的逐句转写。 */
  return d > 0 ? hypot(w, h) / d : 0.0;
}

/* 这一片的三个细分参数一起落地：res / res2 / Epsilon（透明面不内收，见 :43-47）。
 * `nc` 是顶点色的个数（四边 4、三角 3、没有 0）：**透明与否要连顶点色的 alpha 一起看** ——
 * 参考那边 `BezierPatch::init` 里的 `transparent` 是 `queue(...)` 传进来的，
 * 而那一位在 drawsurface 那层是"材质的 alpha 或顶点色的 alpha 有一个 < 1"
 * （bezierpatch.cc:867 的 `transparent |= c0[3]+c1[3]+c2[3] < 3.0`）。
 * 我们从前只看材质，于是"笔不透明、alpha 全在顶点色里"这一档（`s.colors(palette(...))`
 * 那一族）走了**内收**那一路，几何就与参考差开了。量出来的（探针，同一颗球 128 条 btri）：
 *   `sph_vc2`（笔带 opacity(0.5) + 同色顶点色）30 —— 与不带顶点色的 `sph_trans1` 一样；
 *   `sph_vc1`（默认笔 + 顶点色带 alpha，颜色处处相同）16314；`sph_vcol`（真渐变）17362。
 * 这一条就是那两个数的来源。 */
static void r3_set_res(r3scene *s, const r3v *p, int n, const r3mat *mat,
                       const float *C, int nc) {
  double r = r3_res_for(s, p, n);
  { const char *e = getenv("OMNI_R3_RES");        /* 标定用：res 乘一个系数 */
    if (e) r *= atof(e); }
  if (r > 0) { s->res = r; s->res2 = r * r; }
  int trans = mat && mat->diffuse[3] < 1.0;
  if (!trans && C)
    for (int i = 0; i < nc; ++i) if (C[i * 4 + 3] < 1.0f) { trans = 1; break; }
  s->Epsilon = trans ? 0.0 : 0.1 * s->res;
  { const char *e = getenv("OMNI_R3_FILL");      /* 标定用：临时换 FillFactor */
    if (e) s->Epsilon = trans ? 0.0 : atof(e) * s->res; }
  /* **0.1 就是最优，量过。** 斜相机那把尺子（`size(200);
   * currentprojection=orthographic(5,4,3); draw(unitsphere,green);`，1929600 字节）：
   *   0 → 56832 / 和 433893；0.05 → 56506 / 433583；**0.1 → 56381 / 433456**；
   *   0.2 → 57005 / 434138
   * 原版的 FillFactor 正好落在谷底，而且整个摆幅只有 450 字节 —— 只占那 2.8% 残差的
   * 0.8%，所以消裂缝这一格也不是它。 */
}

/* 一片面片进表：先算 epsilon（bezierpatch.cc:70）与四角法向，再递归。
 * `C` 是四个角的 rgba（16 个 float，角序与 P0..P3 一样），没有顶点色时给 NULL。 */
static int r3_add_patch(r3scene *s, r3tris *t, const r3v *p, int straight,
                        const r3mat *mat, const float *C) {
  r3_set_res(s, p, 16, mat, C, 4);
  double eps = 0;
  for (int i = 1; i < 16; ++i) {
    double d = r3v_abs2(r3v_sub(p[i], p[0]));
    if (d > eps) eps = d;
  }
  s->epsilon = eps * DBL_EPSILON;

  r3v n[4];
  r3_corner_normals(s, p, n);
  r3v P0 = p[0], P1 = p[12], P2 = p[15], P3 = p[3];
  if (straight) {
    if (C) {
      float a[12], b[12];
      for (int i = 0; i < 4; ++i) {
        a[i] = C[i]; a[4 + i] = C[4 + i]; a[8 + i] = C[8 + i];
        b[i] = C[i]; b[4 + i] = C[8 + i]; b[8 + i] = C[12 + i];
      }
      if (!r3tris_pushc(t, P0, n[0], P1, n[1], P2, n[2], mat, a)) return 0;
      if (!r3tris_pushc(t, P0, n[0], P2, n[2], P3, n[3], mat, b)) return 0;
      return 1;
    }
    if (!r3tris_push(t, P0, n[0], P1, n[1], P2, n[2], mat)) return 0;
    if (!r3tris_push(t, P0, n[0], P2, n[2], P3, n[3], mat)) return 0;
    return 1;
  }
  return r3_render_patch(s, t, p, P0, P1, P2, P3, n[0], n[1], n[2], n[3],
                         0, 0, 0, 0, mat, C, 0);
}

/* ------------------------------------------------------------------ 三角面片
 * 管子的接头（球帽、圆盘）就是这一族，粗线在三维那边一定会走到。
 * 控制点十个，编号照 bezierpatch.cc:652 那张图：
 *   0=003(角) 1=102 2=012 3=201 4=111 5=021 6=300(角) 7=210 8=120 9=030(角)
 * 判据是 bezierpatch.h:195 的 Distance：内点离三角形重心多远 + 三条边有多直。 */
static double r3_tri_distance(const r3v *p) {
  const double third = 1.0 / 3.0;
  r3v p0 = p[0], p6 = p[6], p9 = p[9];
  r3v ctr = r3v_scl(third, r3v_add(r3v_add(p0, p6), p9));
  double d = r3v_abs2(r3v_sub(ctr, p[4]));
  double t;
  t = r3_straightness(p0, p[1], p[3], p6); if (t > d) d = t;
  t = r3_straightness(p0, p[2], p[5], p9); if (t > d) d = t;
  t = r3_straightness(p6, p[7], p[8], p9); if (t > d) d = t;
  return d;
}

/* 三个角的法向（bezierpatch.cc:767-769 的那三句，套在整片上） */
static void r3_tri_normals(const r3scene *s, const r3v *p, r3v n[3]) {
  n[0] = r3_normal(s, p[9], p[5], p[2], p[0], p[1], p[3], p[6]);
  n[1] = r3_normal(s, p[0], p[1], p[3], p[6], p[7], p[8], p[9]);
  n[2] = r3_normal(s, p[6], p[7], p[8], p[9], p[5], p[2], p[0]);
}

/* 一刀四分（bezierpatch.cc:706-765 逐句照抄，名字都留着好对照） */
static void r3_tri_split4(const r3v *p, r3v out[4][10]) {
  r3v l003 = p[0], p102 = p[1], p012 = p[2], p201 = p[3], p111 = p[4];
  r3v p021 = p[5], r300 = p[6], p210 = p[7], p120 = p[8], u030 = p[9];
  #define H(a, b) r3v_scl(0.5, r3v_add((a), (b)))
  r3v u021 = H(u030, p021);
  r3v u120 = H(u030, p120);
  r3v p033 = H(p021, p012);
  r3v p231 = H(p120, p111);
  r3v p330 = H(p120, p210);
  r3v p123 = H(p012, p111);
  r3v l012 = H(p012, l003);
  r3v p312 = H(p111, p201);
  r3v r210 = H(p210, r300);
  r3v l102 = H(l003, p102);
  r3v p303 = H(p102, p201);
  r3v r201 = H(p201, r300);
  r3v u012 = H(u021, p033);
  r3v u210 = H(u120, p330);
  r3v l021 = H(p033, l012);
  r3v p4xx = r3v_add(r3v_scl(0.5, p231), r3v_scl(0.25, r3v_add(p111, p102)));
  r3v r120 = H(p330, r210);
  r3v px4x = r3v_add(r3v_scl(0.5, p123), r3v_scl(0.25, r3v_add(p111, p210)));
  r3v pxx4 = r3v_add(r3v_scl(0.25, r3v_add(p021, p111)), r3v_scl(0.5, p312));
  r3v l201 = H(l102, p303);
  r3v r102 = H(p303, r201);
  r3v l210 = H(px4x, l201);
  r3v r012 = H(px4x, r102);
  r3v l300 = H(l201, r102);
  r3v r021 = H(pxx4, r120);
  r3v u201 = H(u210, pxx4);
  r3v r030 = H(u210, r120);
  r3v u102 = H(u012, p4xx);
  r3v l120 = H(l021, p4xx);
  r3v l030 = H(u012, l021);
  r3v l111 = H(p123, l102);
  r3v r111 = H(p312, r210);
  r3v u111 = H(u021, p231);
  r3v c111 = r3v_scl(0.25, r3v_add(r3v_add(p033, p330), r3v_add(p303, p111)));
  #undef H
  r3v L[10] = { l003, l102, l012, l201, l111, l021, l300, l210, l120, l030 };
  r3v R[10] = { l300, r102, r012, r201, r111, r021, r300, r210, r120, r030 };
  r3v U[10] = { l030, u102, u012, u201, u111, u021, r030, u210, u120, u030 };
  r3v C[10] = { r030, u201, r021, u102, c111, r012, l030, l120, l210, l300 };
  for (int i = 0; i < 10; ++i) {
    out[0][i] = L[i]; out[1][i] = R[i]; out[2][i] = U[i]; out[3][i] = C[i];
  }
}

/* bezierpatch.cc:636 的递归。与四边面片同一套约定：三个角 P0..P2 与法向 N0..N2 是父级
 * 传下来的，只有三条边的中点现算；`flat0..2` 记住"这条边已经判直过了"，第一次判直时把中点
 * 顺着切线往内收 Epsilon（:774-799，内收方向是**两个 differential 之和**）。
 * 四块的次序 l/r/u/c 与 r3_tri_split4 的 out[0..3] 一一对上（:762-765）。
 * `c` 那一块（中心）的控制点在原版里被复用成三个中点法向的取样，所以下面一律拿 cq 索引：
 *   cq[0]=r030 cq[1]=u201 cq[2]=r021 cq[3]=u102 cq[4]=c111 cq[5]=r012
 *   cq[6]=l030 cq[7]=l120 cq[8]=l210 cq[9]=l300                                     */
static int r3_render_tri(const r3scene *s, r3tris *t, const r3v *p,
                         r3v P0, r3v P1, r3v P2, r3v N0, r3v N1, r3v N2,
                         int flat0, int flat1, int flat2,
                         const r3mat *mat, const float *C, int depth) {
  double d = r3_tri_distance(p);
  if (!(s->res2 > 0 && d == d) || d < s->res2 || depth >= r3_depthcap())
    return r3tris_pushc(t, P0, N0, P1, N1, P2, N2, mat, C);
  r3v q[4][10];
  r3_tri_split4(p, q);
  const r3v *cq = q[3];
  const double E = s->Epsilon;

  /* 三个新中点的法向。原版这三句没有退化回退（:767-769 就三行） */
  r3v n0 = r3_normal(s, cq[9], cq[5], cq[2], cq[0], cq[1], cq[3], cq[6]);
  r3v n1 = r3_normal(s, cq[0], cq[1], cq[3], cq[6], cq[7], cq[8], cq[9]);
  r3v n2 = r3_normal(s, cq[6], cq[7], cq[8], cq[9], cq[5], cq[2], cq[0]);

  r3v m0 = r3v_scl(0.5, r3v_add(P1, P2));
  if (!flat0) {
    if ((flat0 = r3_straightness(p[6], p[7], p[8], p[9]) < s->res2)) {
      if (E) m0 = r3v_sub(m0, r3v_scl(E, r3v_unit(r3v_add(
                    r3_differential(s, cq[0], cq[2], cq[5], cq[9]),
                    r3_differential(s, cq[0], cq[1], cq[3], cq[6])))));
    } else m0 = cq[0];
  }
  r3v m1 = r3v_scl(0.5, r3v_add(P2, P0));
  if (!flat1) {
    if ((flat1 = r3_straightness(p[0], p[2], p[5], p[9]) < s->res2)) {
      if (E) m1 = r3v_sub(m1, r3v_scl(E, r3v_unit(r3v_add(
                    r3_differential(s, cq[6], cq[3], cq[1], cq[0]),
                    r3_differential(s, cq[6], cq[7], cq[8], cq[9])))));
    } else m1 = cq[6];
  }
  r3v m2 = r3v_scl(0.5, r3v_add(P0, P1));
  if (!flat2) {
    if ((flat2 = r3_straightness(p[0], p[1], p[3], p[6]) < s->res2)) {
      if (E) m2 = r3v_sub(m2, r3v_scl(E, r3v_unit(r3v_add(
                    r3_differential(s, cq[9], cq[8], cq[7], cq[6]),
                    r3_differential(s, cq[9], cq[5], cq[2], cq[0])))));
    } else m2 = cq[9];
  }

  /* 顶点色跟着细分（:804-807 三行边中点，:814-817 四块的分派） */
  float sub[4][12];
  if (C) {
    for (int i = 0; i < 4; ++i) {
      float c0 = 0.5f * (C[4 + i] + C[8 + i]);
      float c1 = 0.5f * (C[8 + i] + C[i]);
      float c2 = 0.5f * (C[i] + C[4 + i]);
      sub[0][i] = C[i]; sub[0][4 + i] = c2;       sub[0][8 + i] = c1;
      sub[1][i] = c2;   sub[1][4 + i] = C[4 + i]; sub[1][8 + i] = c0;
      sub[2][i] = c1;   sub[2][4 + i] = c0;       sub[2][8 + i] = C[8 + i];
      sub[3][i] = c0;   sub[3][4 + i] = c1;       sub[3][8 + i] = c2;
    }
  }

  if (!r3_render_tri(s, t, q[0], P0, m2, m1, N0, n2, n1,
                     0, flat1, flat2, mat, C ? sub[0] : NULL, depth + 1)) return 0;
  if (!r3_render_tri(s, t, q[1], m2, P1, m0, n2, N1, n0,
                     flat0, 0, flat2, mat, C ? sub[1] : NULL, depth + 1)) return 0;
  if (!r3_render_tri(s, t, q[2], m1, m0, P2, n1, n0, N2,
                     flat0, flat1, 0, mat, C ? sub[2] : NULL, depth + 1)) return 0;
  return r3_render_tri(s, t, q[3], m0, m1, m2, n0, n1, n2,
                       0, 0, 0, mat, C ? sub[3] : NULL, depth + 1);
}

static int r3_add_tri3(r3scene *s, r3tris *t, const r3v *p, int straight,
                       const r3mat *mat, const float *C) {
  r3_set_res(s, p, 10, mat, C, 3);
  double eps = 0;
  for (int i = 1; i < 10; ++i) {
    double q = r3v_abs2(r3v_sub(p[i], p[0]));
    if (q > eps) eps = q;
  }
  s->epsilon = eps * DBL_EPSILON;
  r3v n[3];
  r3_tri_normals(s, p, n);
  if (straight) return r3tris_pushc(t, p[0], n[0], p[6], n[1], p[9], n[2], mat, C);
  return r3_render_tri(s, t, p, p[0], p[6], p[9], n[0], n[1], n[2], 0, 0, 0, mat, C, 0);
}

/* ------------------------------------------------------------------ 曲线
 * beziercurve.cc:62 的递归：`Straightness(p0,p1,p2,p3) < res2` 就是一段直线，
 * 否则对半分（同一套 m0..m5）。线段攒进这个表，投影矩阵定了之后再光栅化。 */
typedef struct { r3v *p; const r3mat **mat; size_t n, cap; } r3lines;

static int r3lines_push(r3lines *L, r3v a, r3v b, const r3mat *m) {
  if (L->n + 2 > L->cap) {
    size_t cap = L->cap == 0 ? 256 : L->cap * 2;
    r3v *p = (r3v *) realloc(L->p, cap * sizeof(r3v));
    if (!p) return 0;
    L->p = p;
    const r3mat **mm = (const r3mat **) realloc(L->mat, (cap / 2 + 1) * sizeof(const r3mat *));
    if (!mm) return 0;
    L->mat = mm; L->cap = cap;
  }
  L->mat[L->n / 2] = m;
  L->p[L->n++] = a;
  L->p[L->n++] = b;
  return 1;
}

static int r3_add_bez(const r3scene *s, r3lines *L, const r3v *p,
                      const r3mat *m, int depth) {
  double st = r3_straightness(p[0], p[1], p[2], p[3]);
  if (!(s->res2 > 0 && st == st) || st < s->res2 || depth >= 12)
    return r3lines_push(L, p[0], p[3], m);
  r3v m0 = r3v_scl(0.5, r3v_add(p[0], p[1]));
  r3v m1 = r3v_scl(0.5, r3v_add(p[1], p[2]));
  r3v m2 = r3v_scl(0.5, r3v_add(p[2], p[3]));
  r3v m3 = r3v_scl(0.5, r3v_add(m0, m1));
  r3v m4 = r3v_scl(0.5, r3v_add(m1, m2));
  r3v m5 = r3v_scl(0.5, r3v_add(m3, m4));
  r3v s0[4] = { p[0], m0, m3, m5 };
  r3v s1[4] = { m5, m4, m2, p[3] };
  if (!r3_add_bez(s, L, s0, m, depth + 1)) return 0;
  return r3_add_bez(s, L, s1, m, depth + 1);
}

/* ------------------------------------------------------------------ 视景体与投影
 * renderBase.cc:111 setDimensions 照抄。Width/Height 这里就是 fw/fh
 * （Export 里是 `setDimensions(fullWidth,fullHeight,…)`，glrender.cc:488）。
 * X/Y 是交互平移，出图那一趟是 0。 */
static void r3_set_dimensions(r3scene *s) {
  int Width = s->fw, Height = s->fh;
  if (Width <= 0) Width = 1;
  if (Height <= 0) Height = 1;
  /* **视景体的长宽比不是导出位图的长宽比。** 离屏那一路的 Width/Height 是这么来的
   * （renderBase.cc:932-996，逐句照抄）：
   *   fullW/fullH = ceil(expand * 内容尺寸)（expand=4，见 shipout3）
   *   oldW/oldH   = ceil(内容尺寸 * devicePixelRatio)
   *   w,h         = min(oldW, 屏幕宽), min(oldH, 屏幕高)，再过一遍 fitAspect（按内容长宽比 ceil）
   *   Width       = max(w, min(1024, fullW))、Height = max(h, min(768, fullH))   ← 分块的下限
   *   最后再按 fullW/fullH 用 ceil 套回长宽比
   * 于是 `aspect = Width/Height` 与 `fullW/fullH` 差一个 ceil 的零头（约 1/768）。
   *
   * **这一格是"斜相机那 2.8%"的真根因**（与相机方向无关，是画布尺寸的事）。量出来的
   * （不打光的球、`orthographic(5,4,3)`、画布 800x804）：按位图长宽比 7920/1929600
   * 字节不同、"最高一列"795.5020px；按上面这一串是 **64/1929600**、796.5059px ——
   * 与参考一模一样（旧版正好差 1.004px，就是 1/768 那个零头）。
   * 判据上：sphere 56381 → 482、hyperboloid 34570 → 6747、conicurv 41246 → 13215。
   *
   * 两处只能"照量出来的填"：`devicePixelRatio`（这台机器是 2，`OMNI_R3_DPR` 可改）
   * 与屏幕尺寸（没用上 —— 出图的画布都比工作区小）。**asy 自己在这一格上依赖显示器**，
   * 这不是我们引进的不确定性。内容项顶上来的时候（画布 > 512pt 宽或 > 384pt 高，
   * 例如 cheese 1600x1572、twoSpheres 2268x1968）算出来的 aspect **正好等于位图长宽比**，
   * 也就是回到旧行为 —— 这 12 个例子本来就是对的，所以那一项不能省。
   * `OMNI_R3_ASPECT=full` 退回"直接用位图长宽比"那一版（复现上面那组对照数）。 */
  double aspect;
  { const char *ef = getenv("OMNI_R3_ASPECT");
    double A = ((double) Width) / Height;
    if (ef && strcmp(ef, "full") == 0) aspect = A;
    else {
      double dpr = 2.0;
      { const char *e = getenv("OMNI_R3_DPR"); if (e) dpr = atof(e); }
      double expand = 4.0;
      int oW = (int) (Width / expand + 0.5), oH = (int) (Height / expand + 0.5);
      int w = (int) ceil(oW * dpr), h = (int) ceil(oH * dpr);
      /* fitAspect（renderBase.cc:384）那两个 ceil **要留一点余量**：asy 那边的 `Aspect`
       * 是 `args.width/args.height`（**pt** 那一对，例如 566.98/491.98），我们手上只有
       * 位图那一对（2268/1968）。数学上相等的地方，两种除法的最后一位不一样 ——
       * twoSpheres 上 `1134/A` 真值正好是 984，位图那一对算出来是 984.0000000000001，
       * ceil 就跳到 985，长宽比整整差 0.1%（那个例子的位图差从 2377487 涨到 2391039）。
       * 减 1e-9 只吃掉这种"整数上方一丁点"的情形，真该进位的（764.179 那类）不受影响。 */
      if (w > h * A) w = (int) ceil(h * A - 1e-9); else h = (int) ceil(w / A - 1e-9);
      int tw = Width < 1024 ? Width : 1024;
      int th = Height < 768 ? Height : 768;
      int W0 = w > tw ? w : tw;
      int H0 = h > th ? h : th;
      if ((double) W0 / H0 > A) W0 = (int) ceil(H0 * A - 1e-9);
      else H0 = (int) ceil(W0 / A - 1e-9);
      aspect = (double) W0 / H0;
    } }
  double zoom = s->zoom == 0 ? 1 : s->zoom;
  /* **viewportshift 不乘 zoom。** renderBase.cc:119 那一行是
   *   xshift = (X / Width + Shift.getx() * Xfactor) * zoom
   * 里面的 `* zoom` 是给 `X / Width`（交互时的像素平移量，确实要随 zoom 缩放）用的；
   * 而离屏导出那条路上 `home()`（renderBase.cc:495）已经把 X/Y 置 0，剩下的只有
   * Shift 那一项。asy 自己给出了这一项的单位：three.asy:2940 把同一个 shift 换算成
   * target 偏移时写的是 `P.viewportshift.x*lambda.x/P.zoom` —— **除以** zoom，
   * 也就是说 viewportshift 是以"缩放后的视口"为单位的，换到相机单位要除 zoom；
   * 而下面 `rAspect` 里已经带了一个 zoominv，两者恰好抵消，所以这里一个 zoom 都不乘。
   *
   * 量出来的（label3zoom，唯一一个 zoom != 1 且 viewportshift != 0 的例子）：
   * 乘了 zoom 时 frustum 中心在 x/(-z) 上是 -0.686，而画出来的 22614 片三角占
   * [-0.4166, +0.4162] —— 两个区间不相交，整幅位图是空的（判据：ink 重合 0、
   * 盖住参考 0.0%，参考有 827930 个墨点）。不乘之后中心变成 -0.1225，落在物体里。 */
  double xshift = s->shiftx;
  double yshift = s->shifty;
  double zoominv = 1.0 / zoom;
  double Zmax = s->M.z, Zmin = s->m.z;
  double H = s->ortho ? 0.0 : -tan(0.5 * s->angle * M_PI / 180.0) * Zmax;

  if (s->ortho) {
    double xsize = s->M.x - s->m.x;
    double ysize = s->M.y - s->m.y;
    if (xsize < ysize * aspect) {
      double r = 0.5 * ysize * aspect * zoominv;
      double X0 = 2.0 * r * xshift;
      double Y0 = ysize * zoominv * yshift;
      s->xmin = -r - X0; s->xmax = r - X0;
      s->ymin = s->m.y * zoominv - Y0; s->ymax = s->M.y * zoominv - Y0;
    } else {
      double r = 0.5 * xsize * zoominv / aspect;
      double X0 = xsize * zoominv * xshift;
      double Y0 = 2.0 * r * yshift;
      s->xmin = s->m.x * zoominv - X0; s->xmax = s->M.x * zoominv - X0;
      s->ymin = -r - Y0; s->ymax = r - Y0;
    }
  } else {
    double r = H * zoominv;
    double rAspect = r * aspect;
    double X0 = 2.0 * rAspect * xshift;
    double Y0 = 2.0 * r * yshift;
    s->xmin = -rAspect - X0; s->xmax = rAspect - X0;
    s->ymin = -r - Y0; s->ymax = r - Y0;
  }
  /* glrender.cc:493/495：near/far 是 -Zmax / -Zmin */
  s->znear = -Zmax;
  s->zfar = -Zmin;
  /* 量口：`OMNI_R3_DEBUG` 打开时把 frustum 的输入与输出都印出来。三维那一档"物体跑到
   * 画布外"这类问题，先看这一行 —— 输入（angle/zoom/m/M/aspect）与输出（xmin..zfar）
   * 分开印，就能判断是"收到的数不对"还是"这一段算错了"。 */
  if (getenv("OMNI_R3_DEBUG"))
    fprintf(stderr, "r3dim: %dx%d aspect %.17g ortho %d angle %.17g zoom %.17g\n"
            "       m (%.17g %.17g %.17g) M (%.17g %.17g %.17g)\n"
            "       H %.17g x [%.17g %.17g] y [%.17g %.17g] z [%.17g %.17g]\n",
            Width, Height, aspect, s->ortho ? 1 : 0, s->angle, zoom,
            s->m.x, s->m.y, s->m.z, s->M.x, s->M.y, s->M.z,
            H, s->xmin, s->xmax, s->ymin, s->ymax, s->znear, s->zfar);
}

/* glm::ortho / glm::frustum（右手、深度 [-1,1]），列主序 P[col][row] */
/* **待查（下一刀从这儿起）：远处的几何整体外移约 1% 的画布宽。**
 * 量口（/tmp/cc/D.asy：`draw(circle(O,2),linewidth(2bp))`，perspective(10,-5,5.44)，
 * 位图 1200x536）：一条水平扫描线上，圆的**右**半边两条腿一样（参考 (1094,1108)、
 * 我们 (1093,1108)），**左**半边（远侧）整段左移 11~13 px 而宽度不变（17 px）：
 *   y=134  参考 (102,118)  我们 (89,105)
 *   y=268  参考 (17,25)    我们 (6,14)
 *   y=402  参考 (103,117)  我们 (92,106)
 * 也就是说管子的中心线（就是那个圆）在远侧被推出去了 13 px，而近侧对得上。
 * 判据里这一项就是 conicurv 的 ink 只重合 64% 的主因（那张图两个 2bp 的圆占了大半墨量；
 * 按元素拆开量：两个圆 72.1%、细线与方框 92.9%、箭头带标签 95.5%）。
 * 已经排除的：笔宽/管子半径（8bp、20bp 的直管墨量比 1.0003/1.0010）、虚线
 * （1226.93 对 1229.72）、res 系数（撤回 √2 之后这一项只从 63.9% 动到 64.1%）、
 * **管子本身**（把圆换成默认细笔，同一处照样左移 14~16 px：y=133 参考 (106,110) 对
 * 我们 (90,93)、y=266 参考 (21,23) 对 (6,8)，而右侧 (1190,1192) 逐像素相同）。
 * **范围已经缩到"只有透视这一路"**：同一个圆换成 `orthographic(10,-5,5.44)` 之后
 * 盖住参考 0.947、三条扫描线的段全部落在 1 px 内（y=132 参考 (82,85)/(1113,1117) 对
 * 我们 (82,85)/(1113,1116)）—— 也就是说视图旋转与 x/y 的定标都是对的，差在视景体/透视除法
 * 这一段（下面这个矩阵，或 r3_set_dimensions 给的 znear/zfar/H）。
 * 矢量那半边是**一样**的，所以 asy 侧算出来的投影没问题。
 * 还排除了两条（别重复走）：
 *   - **不是曲线细分太细**。把 res 乘 2/4/8 扫一遍（细笔的圆，y=266 那一行）：我们的左端
 *     从 x=6 只挪到 9~11 就饱和了（k=4 与 k=8 输出相同），参考在 21~23，盖住参考也只从
 *     0.225 涨到 0.294。所以那 12 px 不是弦割出来的。
 *   - **不是单点的投影**。四个 8pt 的点摆在圆上的 0/90/180/270（同一投影、同一画布）：
 *     四个质心的 dx 分别 -0.78 / -1.14 / +0.43 / +1.17 px —— 单点都在 1.2 px 内。
 * 也就是说：点投得对、ortho 对得上、细分不是主因，但**圆在两个基点之间的那一段**差 12 px。
 * 下一刀该去比对"曲线在 3D 里怎么细分成折线"这一段的输入（r3_add_bez 收到的四个控制点）
 * 与 asy 侧 `bez` 清单里那四个数，以及 GL 那边 beziercurve.cc:62 的 Straightness 判据。
 *
 * **又一条排除（范围已经收到最窄）：asy 侧的几何与投影两条腿逐位相同。**
 * 同一个圆，两条腿都打印 `project(point(c,t))` 扫 64 个 t：最左点都在 t=2.8125、
 * x 都是 -2.02152083708767（15 位全同）；控制点也一样（(2,0,0)、(2,1.10456949966159,0)、
 * (1.10456949966159,2,0)、(0,2,0)）。也就是说这 12 px **完全产生在我们的 r3 位图这一路里**。
 * 再加上"点（btri 做的 8pt 圆点）都在 1.2 px 内"这一条 —— btri 那一路对、bez 那一路差，
 * 而两者读的是同一个视图矩阵。所以下一刀的落点很窄：清单里 `bez` 那四个控制点是怎么写出来的
 * （asy_builtins 那一格），以及 r3_add_bez 之后 r3_raster_line 怎么把折线画出来。
 *
 * 再排掉一条、并留下一条**关键线索**：
 *   - 视图变换对 pre/point/post **三个域都作用了**（asy_builtins.asy:7085 的
 *     `real[][] * path3` 逐个乘），不是"只变换结点没变换控制点"那种。
 *   - res 扫到 k=4/8 时整个四分之一圆塌成**一根弦**（输出饱和不再变），此时我们的最左端
 *     在 x=9~11，而参考在 21~23 —— 也就是说**参考那条圆比我们控制点连成的弦还要靠里**。
 *     这一条说明差的不是"细分够不够"：那条曲线在位图里被画小了约 1~2%，而同一张图里的
 *     点（btri）与 ortho 下的同一个圆都对得上，所以也不是全局缩放。
 *   - 建议的下一步：把清单里那条 `bez` 的四个控制点抄出来，手算 r3_project + r3_window，
 *     与位图里实际落墨的位置对一遍 —— 一步就能判出是"清单里的数不对"还是"r3 画错了"。
 *
 * **上面这一步做了，结论是"清单里的数不对"。** 照清单的 `size/proj/box/shift` 复算一遍
 * r3_set_dimensions + r3_projection + r3_window（在 python 里手算，1000 个 t 扫三段）：
 * 最左窗口 x = **7.817**（第 2 段 t=0.802），与我们位图实测的 6~8 一致，而参考在 21~23。
 * 也就是说光栅器与投影是**忠于清单**的，差在清单里 `bez` 那几行的数（或它用的变换）
 * —— 而同一张清单里 `btri` 做的点是对的（1.2 px 内）。两者在 asy_builtins 里是两段
 * 不同的代码：`btri` 走 o3.P3、`bez` 走 `t * o3.g3`（:11905）。下一刀就比这两条路径拿到的
 * 同一个三维点（比如同时画 `dot((0,2,0))` 与过该点的圆）在清单里的坐标是否逐位相同。
 *
 * **顺带发现一个独立的 bug（还没修）：闭合 path3 的收尾段没进清单。**
 * asy_builtins.asy:10789 是 `for (int a = 0; a + 1 < L; ++a)`，对 cyclic 的 path3
 * （`circle(O,2)` 有 4 个结点）只发 3 条 `bez`（实测 `grep -c '^bez'` = 3），
 * 少的是 3→0 那一段。位图上那一段的墨看着还在（墨量 7752 对参考 7666），
 * 所以它大概不是上面那 12 px 的原因，但这一条本身该修。
 * 注意三颗点那把尺子（/tmp/dot/d7.asy）测到的位置差 ≤0.16 px —— 那三颗点的深度只差
 * 15%，而这个圆的深度差约 75%，所以那把尺子盖不住这一项，别拿它当反证。 */
static void r3_projection(r3scene *s) {
  double l = s->xmin, r = s->xmax, b = s->ymin, t = s->ymax;
  double n = s->znear, f = s->zfar;
  memset(s->P, 0, sizeof(s->P));
  if (s->ortho) {
    s->P[0][0] = 2.0 / (r - l);
    s->P[1][1] = 2.0 / (t - b);
    s->P[2][2] = -2.0 / (f - n);
    s->P[3][0] = -(r + l) / (r - l);
    s->P[3][1] = -(t + b) / (t - b);
    s->P[3][2] = -(f + n) / (f - n);
    s->P[3][3] = 1.0;
  } else {
    s->P[0][0] = 2.0 * n / (r - l);
    s->P[1][1] = 2.0 * n / (t - b);
    s->P[2][0] = (r + l) / (r - l);
    s->P[2][1] = (t + b) / (t - b);
    s->P[2][2] = -(f + n) / (f - n);
    s->P[2][3] = -1.0;
    s->P[3][2] = -2.0 * f * n / (f - n);
  }
}

/* ------------------------------------------------------------------ 片元着色
 * fragment.glsl:180-228 与 :232-268 逐句。**全程 float** —— GL 的片元着色是 float，
 * 最后一位由它定；这里用 double 就会与参考差最后几位。 */
typedef struct { float x, y, z; } r3f;

static float r3f_dot(r3f a, r3f b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static r3f r3f_mk(float x, float y, float z) { r3f v; v.x = x; v.y = y; v.z = z; return v; }
static r3f r3f_norm(r3f a) {
  float n = sqrtf(r3f_dot(a, a));
  return n == 0.0f ? a : r3f_mk(a.x / n, a.y / n, a.z / n);
}
static float r3f_max(float a, float b) { return a > b ? a : b; }

typedef struct {
  r3f normal;
  float Roughness, Roughness2, Metallic, Fresnel0;
  float Diffuse[3], Specular[3];
} r3shade;

static float r3_ndf_trg(const r3shade *S, r3f h) {
  float ndoth = r3f_max(r3f_dot(S->normal, h), 0.0f);
  float alpha2 = S->Roughness2 * S->Roughness2;
  float denom = ndoth * ndoth * (alpha2 - 1.0f) + 1.0f;
  return denom != 0.0f ? alpha2 / (denom * denom) : 0.0f;
}

static float r3_ggx_geom(const r3shade *S, r3f v) {
  float ndotv = r3f_max(r3f_dot(v, S->normal), 0.0f);
  float ap = 1.0f + S->Roughness2;
  float k = 0.125f * ap * ap;
  return ndotv / ((ndotv * (1.0f - k)) + k);
}

static float r3_fresnel(r3f h, r3f v, float fresnel0) {
  float a = 1.0f - r3f_max(r3f_dot(h, v), 0.0f);
  float b = a * a;
  return fresnel0 + (1.0f - fresnel0) * b * b * a;
}

/* BRDF（fragment.glsl:208）—— 回三个通道 */
static void r3_brdf(const r3shade *S, r3f viewDir, r3f lightDir, float out[3]) {
  r3f h = r3f_norm(r3f_mk(lightDir.x + viewDir.x, lightDir.y + viewDir.y,
                          lightDir.z + viewDir.z));
  float omegain = r3f_max(r3f_dot(viewDir, S->normal), 0.0f);
  float omegaln = r3f_max(r3f_dot(lightDir, S->normal), 0.0f);
  float D = r3_ndf_trg(S, h);
  float G = r3_ggx_geom(S, viewDir) * r3_ggx_geom(S, lightDir);
  float F = r3_fresnel(h, viewDir, S->Fresnel0);
  float denom = 4.0f * omegain * omegaln;
  float raw = denom > 0.0f ? (D * G) / denom : 0.0f;
  for (int i = 0; i < 3; ++i) {
    float lambertian = S->Diffuse[i];
    float dielectric = lambertian + F * (raw * S->Specular[i] - lambertian);   /* mix */
    float metal = raw * S->Diffuse[i];
    out[i] = dielectric + S->Metallic * (metal - dielectric);
  }
}

/* GL 的 float -> unorm8（规范 2.3.5.2「Conversion from Floating-Point to
 * Normalized Fixed-Point」）：`round(f × 255)`，而那个**乘积按精确值算** ——
 * 不是"先把乘积舍进 float、再加 0.5 取整"。硬件那一格是定点转换，不是一次浮点乘。
 *
 * 这一位真差过：`currentlight=nolight` 的 lightgray（0.9）——
 *   (float) 0.9 = 0.899999976158142，精确乘 255 是 229.49999394 → 该出 **229**；
 *   而在 float 里算 `v * 255.0f`，结果被舍成正好 **229.5**，+0.5f 取整就成了 230。
 * 探针（一片正对相机的平面片，/tmp 里那两份）：不打光那一版 1896075/1920000 个字节
 * 全差 1（参考 229、我们 230），打光那一版本来就逐字节相同。
 *
 * NaN 归 0（从前是 `if (v<0) v=0; if (v>1) v=1;`，NaN 两条都不成立、再 (int) 是 UB）。 */
static unsigned char r3_unorm8(float v) {
  if (!(v > 0.0f)) return 0;
  if (v > 1.0f) v = 1.0f;
  return (unsigned char) (int) ((double) v * 255.0 + 0.5);
}

/* fragment.glsl:232 main —— 一个片元的颜色（不含 alpha 那一格的合成）。
 * `vcol` 是插值出来的逐顶点色（rgba，没有时给 NULL）：vertex.glsl:77 那一支 ——
 * lightOn 非零时它当 diffuse，为零时加到 emissive 上。 */
static void r3_shade(const r3scene *s, const r3mat *mat, r3v nrm, r3v viewPos,
                     int frontFacing, const float *vcol, float out[3]) {
  r3shade S;
  S.normal = r3f_norm(r3f_mk((float) nrm.x, (float) nrm.y, (float) nrm.z));
  if (!frontFacing) S.normal = r3f_mk(-S.normal.x, -S.normal.y, -S.normal.z);
  /* vertex.glsl:91 —— params = (1 - shininess, metallic, fresnel0) */
  S.Roughness = 1.0f - (float) mat->shininess;
  S.Metallic = (float) mat->metallic;
  S.Fresnel0 = (float) mat->fresnel0;
  S.Roughness2 = S.Roughness * S.Roughness;
  for (int i = 0; i < 3; ++i) {
    S.Diffuse[i] = (float) mat->diffuse[i];
    S.Specular[i] = (float) mat->specular[i];
    out[i] = (float) mat->emissive[i];
  }
  if (vcol) {
    if (mat->lightOn) for (int i = 0; i < 3; ++i) S.Diffuse[i] = vcol[i];
    else for (int i = 0; i < 3; ++i) out[i] += vcol[i];
  }
  if (!mat->lightOn) return;


  r3f viewDir;
  /* **"斜相机那 2.8%"已经修了，根子是视景体的长宽比 —— 与相机方向无关。**
   * 见 r3_set_dimensions 里 `aspect` 那一段（那儿记着全部对照数）：离屏那一路的
   * Width/Height 不是导出位图的尺寸，`aspect` 与 fullW/fullH 差一个 ceil 的零头。
   * 判据上 sphere 56381 → 482、hyperboloid 34570 → 6747、conicurv 41246 → 13215。
   *
   * 这一段留着的是**这条路上排除掉的那些**，别重新挖：
   * - 光的方向：探针证明两条腿逐位相同。
   * - `frontFacing`：把绕向判据反过来会整个球翻掉（56381 → 671905、最大差 255）。
   * - 把几何转过去 vs 把相机转过去（`orthographic(0,0,1)` + `rotate(37,(1,1,1))*unitsphere`
   *   对 `orthographic(5,4,3)` + unitsphere）：444/1920000 对 56381/1929600。
   *   **当时据此判定"面片细分/三角化/法向那一侧已经对了、问题在相机侧"—— 结论是对的，
   *   但差的那一格不是着色，是视景体。** 转几何那一版画布是 800x800（ceil 恰好整除）、
   *   转相机那一版是 800x804（不整除），所以这把尺子量到的其实是长宽比那个零头。
   * - FillFactor（0 与 0.1）：不打光的球上两份**逐字节相同**；深度上限 8~14 也相同；
   *   采样点位三族（当前 / alt / 2x2 网格）7920 / 9104 / 8972，当前这族最好。
   * - res 系数：从 4.0 扫到 0.0625，单调但很浅（7920 → 6508），**不是细分密度**。
   *   顺带一条教训：按 ink 面积反推"参考的网格比我们细 6 倍"是错的 —— 用亚像素轮廓
   *   加自相关量出两边弦长是 22px vs 24px（同一档细分）。面积差不能当内接多边形的证据。 */


  if (s->ortho) viewDir = r3f_mk(0.0f, 0.0f, 1.0f);
  else {
    r3f vp = r3f_mk((float) viewPos.x, (float) viewPos.y, (float) viewPos.z);
    r3f u = r3f_norm(vp);
    viewDir = r3f_mk(-u.x, -u.y, -u.z);
  }
  for (int i = 0; i < s->nlight; ++i) {
    r3f ld = r3f_mk((float) s->ldir[i].x, (float) s->ldir[i].y, (float) s->ldir[i].z);
    float cosTheta = r3f_max(r3f_dot(S.normal, ld), 0.0f);
    float brdf[3];
    r3_brdf(&S, viewDir, ld, brdf);
    for (int k = 0; k < 3; ++k) out[k] += brdf[k] * cosTheta * (float) s->lcol[i][k];
  }
}

/* ------------------------------------------------------------------ 光栅化
 * 每像素 **16 个采样点**（4x4 的规则网格），逐采样 Z-buffer + 逐采样颜色，
 * 最后按 16 个采样平均。
 * 为什么是 16 而不是 4：量出来的。参考位图在一条斜边上的一行剖面是
 *   239 207 175 159 127 …（绿是 1,183,1，背景 255）
 * 换成覆盖率是 1/16、3/16、5/16、6/16、8/16 —— **十六分之一一档**，
 * 4 采样只能给出 0、1/4、1/2、3/4、1（我们从前那一版就是 191、128）。 */
#define R3_NS 4
/* **4x MSAA 的标准点位**（相对像素左下角）。
 * 从前这儿写的是 16 个点（4x4 网格），那是被 psfile.cc:74 的 `dealias` 骗了：
 * EPS 那一侧 asy 会把位图再过一遍 **2x2 前向平均**（`antialias=2`，见 outImage），
 * 于是 4 个采样 x 2x2 平均 = 16 档覆盖率、x 投影 8 个值各 2 个 —— 正是标定量到的样子。
 * 真正的管子是：4x MSAA -> 解析（四舍五入）-> dealias（截断）。 */
static float R3_SAMPLE[R3_NS][2] = {
  { 0.625f, 0.125f }, { 0.125f, 0.375f }, { 0.875f, 0.625f }, { 0.375f, 0.875f }
};

/* 对照用：=grid 是 2x2 规则网格、=alt 是另一条对角线的那一族（配对方式反过来）。
 * 哪一族是对的**量出来的**：一段 26.57 度的 1bp 管子（rulers/ln2.asy），
 * alt 那族给出 159,32,32,159、参考是 191,63,63,191；换成上面这族之后
 * **整张位图 0 字节不同**。（两族的 x/y 投影都是 {1,3,5,7}/8，竖边横边分不出来。） */
/* 透明那一趟的覆盖判据（见 r3_raster_tri 里那段注）。**两条都默认关**，逐采样点那一份
   仍是权威 —— 这两个开关留着是因为它们各自的账已经量出来了，别再重挖：
   - `r3_tgate`（`OMNI_R3_TGATE=1`）：中心不在三角里就把这一片在这一格上整片丢掉，
     写哪几个采样点照旧逐采样判。球上**大坏**（40932 → 541353，最大差 116）：
     细分出来的小三角很多，一格的中心只落在其中一个里，其余的贡献全被丢了。
   - `r3_tcenter`（`OMNI_R3_TCENTER=1`）：中心在里面就四个采样点全算。球上好一些
     （40932 → 27804），但把"透明平面片的软边"弄坏（0 → 5967）。 */
static int r3_tgate = 0;
static int r3_tcenter = 0;
/* `OMNI_R3_PIX=x,y`：把这一格上**每个采样点收到的透明片元**印到 stderr
   （排完序之后：颜色、alpha、深度，以及混出来的那三个字节）。查"参考在这一格上
   一层都没混、我们混了"那一类只能靠它 —— 整幅位图的统计问不出更多。 */
static int r3_pix_x = -1, r3_pix_y = -1;
/* 顶点吸到子像素网格的分母（`OMNI_R3_SNAP`，0 = 不吸）。只作用在逐像素那一路上 ——
   见 r3_raster_pix 里那段注（相邻三角共享边上的"两片都认领"）。
   **256 是量出来的**（探针 sph_trans1）：16 → 7155、**256 → 30**、4096 → 477、不吸 → 483。
   正好对上 GL 常见的 8 位子像素精度。 */
static double r3_snap = 256.0;
/* 收不透明底色那一趟放宽到"任一采样点被覆盖"（`OMNI_R3_OPQANY`，**默认开**）。
   见 r3_raster_pix 里那段注。量出来的：sacylinder3D 6467 → 1488、
   vectorfieldsphere 112976 → 67387、twoSpheres 219606 → 209791。 */
static int r3_opqany = 1;
/* 不透明底色在不透明那一趟里顺手收（`OMNI_R3_OPQINLINE=1`）：按**绘制顺序、后写覆盖
   先写**（照 GL 的 SSBO 写）。**量过、更差，所以默认关**：sacylinder3D 1488 → 2530、
   twoSpheres 209791 → 217479、vectorfieldsphere 67387 → 71482。
   也就是说参考那一格的语义更接近"**取最近**（GL_LESS）+ 任一采样点覆盖"——
   即 r3_raster_pix 的 phase 0 那一份。开关留着，别再从这一头重挖。 */
static int r3_opqinline = 0;
/* 透明那一趟走**逐像素**的链（照 count.glsl / blend.glsl 的结构，见 r3_raster_pix 的
   头注）。**默认开** —— 量出来的账（八个三维例子）：sacylinder3D 18813 → 6449、
   triangles 10574 → 183、twoSpheres 435546 → 296130，没有透明的那几个一个字节不差。
   `OMNI_R3_OITPIX=0` 退回逐采样点那一路（那一份也留着，探针 flat_trans 上它是 0）。 */
static int r3_oitpix = 1;

static void r3_pick_samples(void) {
  const char *e = getenv("OMNI_R3_SAMPLES");
  if (!e) return;
  if (strcmp(e, "grid") == 0) {
    static const float q[2] = { 0.25f, 0.75f };
    for (int j = 0; j < 2; ++j)
      for (int i = 0; i < 2; ++i) {
        R3_SAMPLE[j * 2 + i][0] = q[i];
        R3_SAMPLE[j * 2 + i][1] = q[j];
      }
  } else if (strcmp(e, "alt") == 0) {
    static const float m[4][2] = {
      { 0.375f, 0.125f }, { 0.875f, 0.375f }, { 0.125f, 0.625f }, { 0.625f, 0.875f }
    };
    for (int k = 0; k < 4; ++k) { R3_SAMPLE[k][0] = m[k][0]; R3_SAMPLE[k][1] = m[k][1]; }
  }
}

/* 透明那一档：参考那边是 `shaders/blend.glsl` —— **逐像素**存一串透明片元
 * （count.glsl 数、offset 定位、fragment[] 存 vec4、depth[] 存深度），混之前
 * 在这个像素上**按深度降序排一遍**，再 `mix(out, color, color.a)` 逐个混上去，
 * 起点是这个像素的不透明色（没有不透明层就是背景色），深度 >= 不透明层的片元跳过。
 * 这里照着做：两趟过一遍透明三角 —— 先数（tmode=1）、前缀和、再填（tmode=2），
 * 最后逐采样点排序 + 混色。片元条数超过上限（OMNI_R3_OITMAX，默认 24M 条 ≈ 480MB）
 * 就退回老路：按三角质心 z 全局排一次、直接往 colf 上混。
 * 从前只有老路，量出来的差就是"同一个采样点上两片透明面的先后与参考相反"那一批。
 * （老路那一版之所以存在：更早还试过 16 采样 + 逐片元链表，BezierPatch 上被系统
 * OOM 杀掉。现在 R3_NS 是 4，而且按数出来的条数**精确**分配，不再是那个量级。）
 * 不变的是：透明三角**不写深度**（彼此不遮挡），只在比不透明层近时参与。 */
typedef struct {
  int fw, fh;
  float *depth;          /* fw*fh*R3_NS，初值 1（远） */
  unsigned char *col;    /* fw*fh*R3_NS*3 */
  float *colf;           /* 老路那一趟的浮点累加（只在退回老路时分配） */
  unsigned *tcnt;        /* 片元数；前缀和之后当写指针（OIT 那两趟）。
                            逐采样点那一路一格一个采样点，逐像素那一路（oitpix）一格一像素 */
  float *tfrag;          /* 片元表：每条 5 个 float（r, g, b, a, 深度） */
  float *pcol;           /* 逐像素那一路：那一格的不透明色（参考的 opaqueColor[pixel]） */
  float *pdep;           /* 同上的深度（参考的 opaqueDepth[pixel]，0 = 没有不透明层） */
  int tmode;             /* 0 = 直接混（老路） 1 = 只数 2 = 只填 */
  size_t nblend;         /* 混过色的采样点次数（量口） */
} r3fb;


typedef struct { double x, y, z, w; } r3clip;

static r3clip r3_project(const r3scene *s, r3v v) {
  r3clip c;
  c.x = s->P[0][0] * v.x + s->P[1][0] * v.y + s->P[2][0] * v.z + s->P[3][0];
  c.y = s->P[0][1] * v.x + s->P[1][1] * v.y + s->P[2][1] * v.z + s->P[3][1];
  c.z = s->P[0][2] * v.x + s->P[1][2] * v.y + s->P[2][2] * v.z + s->P[3][2];
  c.w = s->P[0][3] * v.x + s->P[1][3] * v.y + s->P[2][3] * v.z + s->P[3][3];
  return c;
}

/* 裁剪坐标 -> 窗口坐标：glViewport 的教科书公式，**不再减半个像素**。
 * 那半个像素本来是 dealias 挪出来的（2x2 前向平均把画面整体挪了 +0.5），
 * 现在 dealias 自己实现了（见文件末尾的 r3_dealias），这里就该照标准口径写。 */
static void r3_window(const r3fb *fb, r3clip c, double *x, double *y, double *z) {
  double inv = 1.0 / c.w;
  *x = (c.x * inv * 0.5 + 0.5) * fb->fw;
  *y = (c.y * inv * 0.5 + 0.5) * fb->fh;
  *z = c.z * inv * 0.5 + 0.5;                 /* glDepthRange 默认 0..1 */
}

/* 一片三角进帧缓冲。位置是视图空间，法向按重心插值，着色在像素中心算一次。
 * `VC` 是三个顶点的 rgba（12 个 float，没有顶点色时给 NULL）。
 *
 * **这个函数是三维那一档的热点本体** —— 剖 elevation（run-c，8s 窗口）：
 * `r3_raster_tri` 4115 个栈顶样本，占整趟 CPU 的 61%（`r3_shade` 只有 48、`r3_brdf` 44 ——
 * 贵的不是着色，是覆盖测试）。下面那几处手工提取都是 **-O2 会替你做的**公共子表达式
 * 消除，而这条腿默认 -O0（cli.js:1895，故意的：不拿优化档盖住性能问题），所以只能自己做。
 * **算式的形状与次序一字不动** —— 浮点重结合会挪动边界像素，而位图那一轴是逐字节对齐的，
 * 所以只提取、不重排：`(wx[1]-sx)*(wy[2]-sy)` 里 `(wy[2]-sy)` 与 x 无关，提出来得到的是
 * 同一个 double，两个乘法与那一个减法照旧。 */
static void r3_raster_tri(const r3scene *s, r3fb *fb, const r3v *P, const r3v *N,
                          const r3mat *mat, const float *VC) {
  r3clip c[3];
  double wx[3], wy[3], wz[3], iw[3];
  for (int i = 0; i < 3; ++i) {
    c[i] = r3_project(s, P[i]);
    if (c[i].w <= 1e-12) return;              /* 近平面后面的先整片丢掉（还没做裁剪） */
    r3_window(fb, c[i], wx + i, wy + i, wz + i);
    iw[i] = 1.0 / c[i].w;
  }
  double area = (wx[1] - wx[0]) * (wy[2] - wy[0]) - (wx[2] - wx[0]) * (wy[1] - wy[0]);
  if (area == 0.0) return;
  /* 量口只读一次环境：getenv 是对整张环境表的线性扫，而这个函数一趟要进十万次 */
  { static int dbg3 = -1;
    if (dbg3 < 0) { const char *e = getenv("OMNI_R3_DEBUG"); dbg3 = (e && e[0] == '3') ? 1 : 0; }
    if (dbg3)
      fprintf(stderr, "tri (%.3f,%.3f) (%.3f,%.3f) (%.3f,%.3f)\n",
              wx[0], wy[0], wx[1], wy[1], wx[2], wy[2]); }
  /* GL 默认正面是逆时针。**方向对了，量过**：把这一句反过来（斜相机的球那把尺子）
   * 从 56381/1929600、和 433456 变成 671905、和 69222498（最大差 255，整个球都翻了）。
   * 所以位图 y 朝下并没有让绕向差个符号，`frontFacing` 这一格不是斜相机残差的来源。 */
  int front = area > 0.0;
  double inv2a = 1.0 / area;

  double xlo = wx[0], xhi = wx[0], ylo = wy[0], yhi = wy[0];
  for (int i = 1; i < 3; ++i) {
    if (wx[i] < xlo) xlo = wx[i];
    if (wx[i] > xhi) xhi = wx[i];
    if (wy[i] < ylo) ylo = wy[i];
    if (wy[i] > yhi) yhi = wy[i];
  }
  int x0 = (int) floor(xlo), x1 = (int) ceil(xhi);
  int y0 = (int) floor(ylo), y1 = (int) ceil(yhi);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > fb->fw) x1 = fb->fw;
  if (y1 > fb->fh) y1 = fb->fh;

  /* 内层循环要的量全部搬进标量：-O0 下 `wx[1]` 每次都是一条带下标计算的栈读 */
  const double wx0 = wx[0], wx1 = wx[1], wx2 = wx[2];
  const double wy0 = wy[0], wy1 = wy[1], wy2 = wy[2];
  const double wz0 = wz[0], wz1 = wz[1], wz2 = wz[2];
  const int fw = fb->fw;
  float *const depth = fb->depth;
  unsigned char *const col = fb->col;

  float alpha = (float) mat->diffuse[3];
  if (VC) {
    /* 顶点色带 alpha 时，透明与否看**这一片**的三个顶点（bezierpatch.cc:867
     * `transparent |= c0[3]+c1[3]+c2[3] < 3.0`）。混色用的是插值出来的那一格。 */
    alpha = VC[3] < VC[7] ? VC[3] : VC[7];
    if (VC[11] < alpha) alpha = VC[11];
  }
  int opaque = !(alpha < 1.0f);
  for (int y = y0; y < y1; ++y) {
    /* **这一行只扫三角真正压到的那几列。**
       量到的账（elevation，`OMNI_R3_DEBUG=1`）：1600x1200 的帧、33384 片三角、光栅 4.31s；
       而 sinc 的三角更多（39171）却只要 0.45s —— 差别在**包围盒**：细分出来的斜长三角，
       包围盒面积远大于三角面积，整行的列都在白算四个采样。
       三角是凸的，所以它落在带 [y, y+1] 里的那一段，横向不会超出"带里的顶点"与
       "三条边与这两条水平线的交点"这几个 x。左右各再放宽 1 个像素：那几处除法的舍入
       误差在 1e-13 像素量级，1 个像素是十三个数量级的余量。
       于是这个区间是真覆盖集的**超集** —— 区间外的采样点三条判据里必有一条为负，
       原来也是被 continue 掉的，所以判据一字没动、结果逐字节相同。 */
    double rlo = 1e300, rhi = -1e300;
    { const double byl = y, byh = y + 1.0;
      for (int e = 0; e < 3; ++e) {
        const int i = e, j = (e + 1) % 3;
        const double yi = wy[i], yj = wy[j], xi = wx[i];
        if (yi >= byl && yi <= byh) {
          if (xi < rlo) rlo = xi;
          if (xi > rhi) rhi = xi;
        }
        const double dyE = yj - yi;
        if (dyE == 0.0) continue;
        for (int q = 0; q < 2; ++q) {
          const double t = ((q == 0 ? byl : byh) - yi) / dyE;
          if (t < 0.0 || t > 1.0) continue;
          const double xq = xi + t * (wx[j] - xi);
          if (xq < rlo) rlo = xq;
          if (xq > rhi) rhi = xq;
        }
      } }
    if (rhi < rlo) continue;                   /* 这一带整个碰不到三角 */
    int rx0 = (int) floor(rlo) - 1, rx1 = (int) ceil(rhi) + 1;
    if (rx0 < x0) rx0 = x0;
    if (rx1 > x1) rx1 = x1;

    /* 只跟 y 有关的三个差：提到 x 循环外面。值与原来逐位相同（同一次减法） */
    double sxo[R3_NS], dy0[R3_NS], dy1[R3_NS], dy2[R3_NS];
    for (int k = 0; k < R3_NS; ++k) {
      double sy = y + R3_SAMPLE[k][1];
      sxo[k] = R3_SAMPLE[k][0];
      dy0[k] = wy0 - sy;
      dy1[k] = wy1 - sy;
      dy2[k] = wy2 - sy;
    }
    const size_t rowbase = (size_t) y * (size_t) fw;
    for (int x = rx0; x < rx1; ++x) {
      int shaded = 0;
      int opqwrote = 0;
      unsigned char cr = 0, cg = 0, cb = 0;
      float frgb[3] = { 0, 0, 0 };
      float ablend = alpha;
      const size_t pixbase = (rowbase + (size_t) x) * R3_NS;
      /* **透明那一族的覆盖口径：还没定案，两头的账都在这儿**（`OMNI_R3_TCENTER=1`
         切到"只看像素中心，中心在里面就整格算"）。探针在 /tmp/r3probe 那几份：
         - 一颗 opacity(0.5) 的球（正交正对）：逐采样 40932/1920000（轮廓那一圈 2321 个
           像素参考是**纯白**、我们涂了色，紧里面一圈我们又偏浅 —— 216 对 235 那一族，
           像是少混了一层）；换成中心判据 27804，多涂的像素 2614 → 1730。
         - 两颗相交的透明球：56154 → 31674，多涂 1484 → 674。
         - 一片 opacity(0.5) 的平面片（边不落在像素边界上）：逐采样**逐字节相同**、
           中心判据反而差 5967（最大差 3）。
         最后这一条否掉了"透明那一趟不做多重采样"这个解释：平面片的边在参考里是软的。
         另一条也否掉了："掠射角上细分出的窄条被 GL 剔掉、我们照涂" —— `rotate(88,Y)`
         的平面片不透明时**逐字节相同**，透明时 8754/67200 但最大差只有 3、多涂 4 个像素。
         **最有用的一组数**（同一颗球、打光，按"非纯白"数墨迹）：不透明那两份
         494760 对 494760 一个像素不差；透明那两份 497016（参考）对 499337（我们），
         参考没有一个像素是我们没涂的。挑一格看透（x=381、y=1）：不透明两边都是 239，
         透明**参考是 255、我们 244** —— 也就是说同一份几何、同样的覆盖，参考的透明那一趟
         在这一格上一层都没混。第三条解释（"中心不在三角里就整片丢掉"，`OMNI_R3_TGATE=1`）
         也否掉了：球上 40932 → **541353**（最大差 116），因为细分出来的小三角很多，
         一格的中心只落在其中一个里、其余的贡献全被丢。
         下一刀该造的是**逐像素的片元转储**（给定 x,y 印出每个采样点上收到的片元：
         深度、alpha、颜色），拿 (381,1) 与 (400,1) 对着看 —— 光靠整幅位图的统计
         已经问不出更多了。 */
      int tc_in = 0;
      double tcz = 0.0;
      if (!opaque && (r3_tgate || r3_tcenter)) {
        double px = x + 0.5, py = y + 0.5;
        double c0 = ((wx1 - px) * (wy2 - py) - (wx2 - px) * (wy1 - py)) * inv2a;
        double c1 = ((wx2 - px) * (wy0 - py) - (wx0 - px) * (wy2 - py)) * inv2a;
        double c2 = 1.0 - c0 - c1;
        if (c0 < 0.0 || c1 < 0.0 || c2 < 0.0) continue;
        if (r3_tcenter) {
          tc_in = 1;
          tcz = c0 * wz0 + c1 * wz1 + c2 * wz2;
        }
      }
      for (int k = 0; k < R3_NS; ++k) {
        double z;
        if (tc_in) {
          z = tcz;                               /* 中心那一格的深度，四个采样点共用 */
        } else {
          double sx = x + sxo[k];
          /* 三个判据**逐个算、逐个否**：原来是把 b0/b1/b2 全算出来再一起比。
             `||` 只短路比较，不短路上面那三行的计算 —— 而包围盒里过半的采样点是
             第一条边就出去的（三角面积约是包围盒的一半）。次序与值一字不动。 */
          double b0 = ((wx1 - sx) * dy2[k] - (wx2 - sx) * dy1[k]) * inv2a;
          if (b0 < 0.0) continue;
          double b1 = ((wx2 - sx) * dy0[k] - (wx0 - sx) * dy2[k]) * inv2a;
          if (b1 < 0.0) continue;
          double b2 = 1.0 - b0 - b1;
          if (b2 < 0.0) continue;
          z = b0 * wz0 + b1 * wz1 + b2 * wz2;
        }
        size_t idx = pixbase + (size_t) k;
        if (!(z < depth[idx])) continue;       /* GL_LESS */
        /* 只数那一趟：不用着色，数完就走（着色是这里最贵的一段） */
        if (fb->tmode == 1 && !opaque) { fb->tcnt[idx]++; fb->nblend++; continue; }
        if (!shaded) {
          /* 像素中心的重心（GL 默认在像素中心求插值，覆盖与否由采样点决定） */
          double px = x + 0.5, py = y + 0.5;
          double a0 = ((wx1 - px) * (wy2 - py) - (wx2 - px) * (wy1 - py)) * inv2a;
          double a1 = ((wx2 - px) * (wy0 - py) - (wx0 - px) * (wy2 - py)) * inv2a;
          double a2 = 1.0 - a0 - a1;
          /* 透视校正：属性按 1/w 加权 */
          double q0 = a0 * iw[0], q1 = a1 * iw[1], q2 = a2 * iw[2];
          double qs = q0 + q1 + q2;
          if (qs == 0.0) { q0 = a0; q1 = a1; q2 = a2; qs = 1.0; }
          r3v nrm = r3v_scl(1.0 / qs,
                            r3v_add(r3v_add(r3v_scl(q0, N[0]), r3v_scl(q1, N[1])),
                                    r3v_scl(q2, N[2])));
          r3v vp = r3v_scl(1.0 / qs,
                           r3v_add(r3v_add(r3v_scl(q0, P[0]), r3v_scl(q1, P[1])),
                                   r3v_scl(q2, P[2])));
          float rgb[3];
          float vc[4];
          if (VC) {
            for (int i = 0; i < 4; ++i)
              vc[i] = (float) ((q0 * VC[i] + q1 * VC[4 + i] + q2 * VC[8 + i]) / qs);
            ablend = vc[3];
            if (ablend < 0.0f) ablend = 0.0f;
            if (ablend > 1.0f) ablend = 1.0f;
          }
          r3_shade(s, mat, nrm, vp, front, VC ? vc : NULL, rgb);
          for (int i = 0; i < 3; ++i) {
            float v = rgb[i];
            if (v < 0.0f) v = 0.0f;
            if (v > 1.0f) v = 1.0f;
            frgb[i] = v;
            unsigned char q = r3_unorm8(v);
            if (i == 0) cr = q;
            else if (i == 1) cg = q;
            else cb = q;
          }
          shaded = 1;
        }
        /* **逐像素那一路的不透明底色就在这一趟收**（`OMNI_R3_OPQINLINE=0` 退回
           r3_raster_pix 的 phase 0）。与参考同一条：GL 那边 fragment shader 只要有一个
           采样点通过深度测试就会跑一次，于是 `opaqueColor[pixel]`/`opaqueDepth[pixel]`
           被写 —— **按绘制顺序、后写覆盖先写**（不是"取最近"），深度取 `gl_FragCoord.z`
           （像素中心处的插值）、颜色就是这一片在中心处的着色（上面那个 frgb）。 */
        if (opaque && fb->pdep && r3_opqinline && !opqwrote) {
          double px = x + 0.5, py = y + 0.5;
          double c0 = ((wx1 - px) * (wy2 - py) - (wx2 - px) * (wy1 - py)) * inv2a;
          double c1 = ((wx2 - px) * (wy0 - py) - (wx0 - px) * (wy2 - py)) * inv2a;
          double c2 = 1.0 - c0 - c1;
          size_t pix = rowbase + (size_t) x;
          fb->pdep[pix] = (float) (c0 * wz0 + c1 * wz1 + c2 * wz2);
          for (int i = 0; i < 3; ++i) fb->pcol[pix * 3 + i] = frgb[i];
          opqwrote = 1;
        }
        if (!opaque) {
          /* 只填那一趟：片元进这个采样点自己那一段。
           * **倒着填**（前缀和是"段末"，写指针往前退）—— 参考那边是
           * `listIndex = atomicAdd(offset[element], -1u) - 1u`（fragment.glsl:295），
           * 于是同一像素上片元在表里的次序是画的次序的**反序**；blend.glsl 的插入排序
           * 用严格 `>`，深度相等的那几片就保持这个反序。 */
          if (fb->tmode == 2) {
            float *f = fb->tfrag + (size_t) (--fb->tcnt[idx]) * 5;
            f[0] = frgb[0]; f[1] = frgb[1]; f[2] = frgb[2];
            f[3] = ablend; f[4] = (float) z;
            continue;
          }
          /* 老路：按三角次序直接混色，**不写深度**。
           * 有 colf 时在**浮点**里累加：每层混完不再落回 8 位。
           * 源色也用着色算出来的浮点 —— 试过按"GL 定点色缓冲先把片元色转成
           * 缓冲精度再混"（GL 4.6 §17.3.6）那一条改，sacylinder3D 的不同字节
           * 从 46130 涨到 99066，退回来了。 */
          if (fb->colf) {
            float *o = fb->colf + idx * 3;
            for (int ch = 0; ch < 3; ++ch) {
              float v = frgb[ch] * ablend + o[ch] * (1.0f - ablend);
              if (v < 0.0f) v = 0.0f;
              if (v > 1.0f) v = 1.0f;
              o[ch] = v;
            }
          } else {
            unsigned char *o = col + idx * 3;
            for (int ch = 0; ch < 3; ++ch) {
              float src = frgb[ch];
              float dst = o[ch] / 255.0f;
              float v = src * ablend + dst * (1.0f - ablend);
              if (v < 0.0f) v = 0.0f;
              if (v > 1.0f) v = 1.0f;
              o[ch] = r3_unorm8(v);
            }
          }
          fb->nblend++;
          continue;
        }
        depth[idx] = (float) z;
        unsigned char *o = col + idx * 3;
        o[0] = cr; o[1] = cg; o[2] = cb;
      }
    }
  }
}

/* **逐像素那一路**（`OMNI_R3_OITPIX=1`，照 count.glsl / blend.glsl 的结构）。
 * 参考的透明是逐**像素**存链的（count.glsl 的下标就是 `gl_FragCoord` 的整数坐标），
 * 混色的底色是那一格的不透明色或纯背景（blend.glsl:101），混完只写一个值；
 * 而我们原来那一路是逐**采样点**的。一格只被部分采样点覆盖时两者必然不同，
 * 而透明那一族的残差正好全长在这种格子上（见 r3_raster_tri 里那段注的账）。
 *
 * 这一份**不动原来的热路**：覆盖只按像素中心判、着色也在中心算一次。
 *   phase 0：过不透明三角，收"那一格的颜色与深度"（pcol/pdep，
 *            对应参考的 opaqueColor[pixel] / opaqueDepth[pixel]；pdep 为 0 = 没有不透明层）
 *   phase 1：过透明三角，只数（tcnt 是逐像素的）
 *   phase 2：过透明三角，填片元（倒着填，与逐采样那一路同一条理由）
 * 着色那几行与 r3_raster_tri 里的**一字相同**（透视校正的重心、法向与视点插值、
 * 顶点色那一支），只是没有采样点循环。 */
static void r3_raster_pix(const r3scene *s, r3fb *fb, const r3v *P, const r3v *N,
                          const r3mat *mat, const float *VC, int phase) {
  r3clip c[3];
  double wx[3], wy[3], wz[3], iw[3];
  for (int i = 0; i < 3; ++i) {
    c[i] = r3_project(s, P[i]);
    if (c[i].w <= 1e-12) return;
    r3_window(fb, c[i], wx + i, wy + i, wz + i);
    iw[i] = 1.0 / c[i].w;
  }
  /* **顶点坐标先吸到子像素网格上**（`OMNI_R3_SNAP`，默认 256 = GL 常见的 1/256 px；
     0 关掉）。为什么要它：相邻两片三角共享的那条边，在浮点里两边算出来的边函数
     不是同一个数 —— 于是紧贴着边的那个像素中心可能**两片都认领**（或都不认领）。
     量到的原形（探针 sph_vcol 的 (388,4)）：那一格收到 **4 个片元** ——
     前面两片几乎一样（深度 0.52843684 / 0.528417289）、背面两片也几乎一样，
     混出来 24，而参考是 72（只两层）。GL 那边顶点是定点的（子像素网格），
     共享边两侧逐位相同，配上 top-left 规则就是"不漏不重"。 */
  if (r3_snap > 0) {
    for (int i = 0; i < 3; ++i) {
      wx[i] = floor(wx[i] * r3_snap + 0.5) / r3_snap;
      wy[i] = floor(wy[i] * r3_snap + 0.5) / r3_snap;
    }
  }
  double area = (wx[1] - wx[0]) * (wy[2] - wy[0]) - (wx[2] - wx[0]) * (wy[1] - wy[0]);
  if (area == 0.0) return;
  int front = area > 0.0;
  double inv2a = 1.0 / area;
  double xlo = wx[0], xhi = wx[0], ylo = wy[0], yhi = wy[0];
  for (int i = 1; i < 3; ++i) {
    if (wx[i] < xlo) xlo = wx[i];
    if (wx[i] > xhi) xhi = wx[i];
    if (wy[i] < ylo) ylo = wy[i];
    if (wy[i] > yhi) yhi = wy[i];
  }
  int x0 = (int) floor(xlo), x1 = (int) ceil(xhi);
  int y0 = (int) floor(ylo), y1 = (int) ceil(yhi);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > fb->fw) x1 = fb->fw;
  if (y1 > fb->fh) y1 = fb->fh;
  const double wx0 = wx[0], wx1 = wx[1], wx2 = wx[2];
  const double wy0 = wy[0], wy1 = wy[1], wy2 = wy[2];
  const double wz0 = wz[0], wz1 = wz[1], wz2 = wz[2];
  float alpha = (float) mat->diffuse[3];
  if (VC) {
    alpha = VC[3] < VC[7] ? VC[3] : VC[7];
    if (VC[11] < alpha) alpha = VC[11];
  }
  /* **GL 的填充规则（top-left）**：判据正好落在 0 上时，只有"左/上边"那一侧算覆盖。
     两个相邻三角共享的那条边在各自里方向相反，于是这样的采样点**只被一个三角**认领。
     原来三条都写 `>= 0`：正方形那条对角线正好穿过像素中心，那 1989 个格子于是混了
     **两层**（探针 flat_trans：参考 242、我们 240）。判据只在"恰好为 0"时起作用，
     其余一个字不动，所以不透明那一路的覆盖集合不受影响。 */
  /* 方向量过：这一档（`dy > 0`，或水平边时 `dx < 0`）在探针上比反过来那档好 ——
     flat_trans 1740 对 3171。 */
  int tb0 = (wy[2] - wy[1]) > 0.0 || ((wy[2] - wy[1]) == 0.0 && (wx[2] - wx[1]) < 0.0);
  int tb1 = (wy[0] - wy[2]) > 0.0 || ((wy[0] - wy[2]) == 0.0 && (wx[0] - wx[2]) < 0.0);
  int tb2 = (wy[1] - wy[0]) > 0.0 || ((wy[1] - wy[0]) == 0.0 && (wx[1] - wx[0]) < 0.0);
  for (int y = y0; y < y1; ++y)
    for (int x = x0; x < x1; ++x) {
      double px = x + 0.5, py = y + 0.5;
      double a0 = ((wx1 - px) * (wy2 - py) - (wx2 - px) * (wy1 - py)) * inv2a;
      double a1 = ((wx2 - px) * (wy0 - py) - (wx0 - px) * (wy2 - py)) * inv2a;
      double a2 = 1.0 - a0 - a1;
      /* 第三条判据用**真正的第三条边函数**，不用 `1-a0-a1`：后者的"恰好为 0"与
         "采样点正好落在 v0->v1 那条边上"不是一回事（差一次舍入），而填充规则的
         tie-break 只在恰好为 0 时起作用。插值照旧用 a2（与原来逐位相同）。
         量出来的：flat_trans 那条对角线 1740 -> 0。 */
      double e2 = ((wx0 - px) * (wy1 - py) - (wx1 - px) * (wy0 - py)) * inv2a;
      int inside = !(a0 < 0.0 || (a0 == 0.0 && !tb0))
                   && !(a1 < 0.0 || (a1 == 0.0 && !tb1))
                   && !(e2 < 0.0 || (e2 == 0.0 && !tb2));
      if (!inside) {
        /* **收不透明底色那一趟（phase 0）可以放宽到"任一采样点被覆盖"**
           （`OMNI_R3_OPQANY=1`）：GL 开着多重采样时，只要有一个采样点被覆盖就会跑
           一次 fragment shader、于是 `opaqueColor[pixel]`/`opaqueDepth[pixel]` 就被写，
           而 `gl_FragCoord` 仍是**像素中心**（重心可能是负的，颜色与深度是外推的）。
           透明那一趟不能这么放（量过：一格只有 1/4 采样点被覆盖时参考没有片元）。 */
        if (!(phase == 0 && r3_opqany)) continue;
        int any = 0;
        for (int k = 0; k < R3_NS && !any; ++k) {
          double sx = x + R3_SAMPLE[k][0], sy = y + R3_SAMPLE[k][1];
          double b0 = ((wx1 - sx) * (wy2 - sy) - (wx2 - sx) * (wy1 - sy)) * inv2a;
          if (b0 < 0.0) continue;
          double b1 = ((wx2 - sx) * (wy0 - sy) - (wx0 - sx) * (wy2 - sy)) * inv2a;
          if (b1 < 0.0) continue;
          if (1.0 - b0 - b1 < 0.0) continue;
          any = 1;
        }
        if (!any) continue;
      }
      double z = a0 * wz0 + a1 * wz1 + a2 * wz2;
      size_t pix = (size_t) y * (size_t) fb->fw + (size_t) x;
      if (phase == 0) {
        /* 不透明那一格：GL_LESS。pdep 为 0 表示这一格还没有不透明层 */
        if (fb->pdep[pix] != 0.0f && !(z < (double) fb->pdep[pix])) continue;
      } else if (phase == 1) {
        fb->tcnt[pix]++;
        continue;
      }
      /* 透视校正 + 着色（与 r3_raster_tri 里那一段一字相同） */
      double q0 = a0 * iw[0], q1 = a1 * iw[1], q2 = a2 * iw[2];
      double qs = q0 + q1 + q2;
      if (qs == 0.0) { q0 = a0; q1 = a1; q2 = a2; qs = 1.0; }
      r3v nrm = r3v_scl(1.0 / qs,
                        r3v_add(r3v_add(r3v_scl(q0, N[0]), r3v_scl(q1, N[1])),
                                r3v_scl(q2, N[2])));
      r3v vp = r3v_scl(1.0 / qs,
                       r3v_add(r3v_add(r3v_scl(q0, P[0]), r3v_scl(q1, P[1])),
                               r3v_scl(q2, P[2])));
      float rgb[3];
      float vc[4];
      float ablend = alpha;
      if (VC) {
        for (int i = 0; i < 4; ++i)
          vc[i] = (float) ((q0 * VC[i] + q1 * VC[4 + i] + q2 * VC[8 + i]) / qs);
        ablend = vc[3];
        if (ablend < 0.0f) ablend = 0.0f;
        if (ablend > 1.0f) ablend = 1.0f;
      }
      r3_shade(s, mat, nrm, vp, front, VC ? vc : NULL, rgb);
      if (phase == 0) {
        /* 不透明那一格照旧夹到 [0,1]（它对应的是写进 RGBA8 帧缓冲的那一步） */
        for (int i = 0; i < 3; ++i) {
          if (rgb[i] < 0.0f) rgb[i] = 0.0f;
          if (rgb[i] > 1.0f) rgb[i] = 1.0f;
        }
        fb->pdep[pix] = (float) z;
        for (int i = 0; i < 3; ++i) fb->pcol[pix * 3 + i] = rgb[i];
      } else {
        /* **透明片元不夹**：参考那边片元存在 SSBO 的 vec4 里（fragment.glsl 写、
           blend.glsl 读），`mix()` 是在**没夹过**的值上做的，只有最后写帧缓冲那一步才夹。
           量到的原形（探针 sph_trans1 的高光，(495,484)）：近的那片是过曝的高光，
           夹到 1 之后混出来是 0.856 → 218，而参考是 **255** —— 不夹的话
           mix(0.712, >1, 0.5) 超过 1，写出去就是 255。 */
        float *f = fb->tfrag + (size_t) (--fb->tcnt[pix]) * 5;
        f[0] = rgb[0]; f[1] = rgb[1]; f[2] = rgb[2];
        f[3] = ablend; f[4] = (float) z;
        fb->nblend++;
      }
    }
}

/* 折线：GL 的线宽默认 1 个采样（glrender.cc 里没有 glLineWidth），
 * 也就是窗口坐标里一条 1 单位宽的带。拿两片三角铺它，颜色取 emissive。 */
static void r3_raster_line(const r3scene *s, r3fb *fb, r3v a, r3v b,
                           const r3mat *mat) {
  r3clip ca = r3_project(s, a), cb = r3_project(s, b);
  if (ca.w <= 1e-12 || cb.w <= 1e-12) return;
  double ax, ay, az, bx, by, bz;
  r3_window(fb, ca, &ax, &ay, &az);
  r3_window(fb, cb, &bx, &by, &bz);
  double dx = bx - ax, dy = by - ay;
  double len = sqrt(dx * dx + dy * dy);
  if (len == 0.0) return;
  double nx = -dy / len * 0.5, ny = dx / len * 0.5;

  unsigned char cr, cg, cbb;
  {
    cr = r3_unorm8((float) mat->emissive[0]);
    cg = r3_unorm8((float) mat->emissive[1]);
    cbb = r3_unorm8((float) mat->emissive[2]);
  }

  int x0 = (int) floor((ax < bx ? ax : bx) - 1);
  int x1 = (int) ceil((ax > bx ? ax : bx) + 1);
  int y0 = (int) floor((ay < by ? ay : by) - 1);
  int y1 = (int) ceil((ay > by ? ay : by) + 1);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > fb->fw) x1 = fb->fw;
  if (y1 > fb->fh) y1 = fb->fh;

  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) {
      /* 逐像素那一路要的"这一格的不透明色与深度"（`fb->pdep` 开着才做）：**线也要收** ——
         不然透明面片压在线上时，混色的底色会退成背景。判据与下面逐采样那一段同一条，
         只把采样点换成像素中心（与 r3_raster_pix 一致）。 */
      if (fb->pdep) {
        double sx = x + 0.5, sy = y + 0.5;
        double t = ((sx - ax) * dx + (sy - ay) * dy) / (len * len);
        if (t >= 0.0 && t <= 1.0) {
          double qx = ax + t * dx, qy = ay + t * dy;
          double ex = sx - qx, ey = sy - qy;
          double d = ex * nx + ey * ny;
          if (d <= 0.5 && d >= -0.5 && sqrt(ex * ex + ey * ey) <= 0.5) {
            double z = az + t * (bz - az);
            size_t pix = (size_t) y * fb->fw + x;
            if (fb->pdep[pix] == 0.0f || z < (double) fb->pdep[pix]) {
              fb->pdep[pix] = (float) z;
              for (int i = 0; i < 3; ++i) {
                float v = (float) mat->emissive[i];
                if (v < 0.0f) v = 0.0f;
                if (v > 1.0f) v = 1.0f;
                fb->pcol[pix * 3 + i] = v;
              }
            }
          }
        }
      }
      for (int k = 0; k < R3_NS; ++k) {
        double sx = x + R3_SAMPLE[k][0];
        double sy = y + R3_SAMPLE[k][1];
        /* 采样点到线段的投影参数与横向距离 */
        double t = ((sx - ax) * dx + (sy - ay) * dy) / (len * len);
        if (t < 0.0 || t > 1.0) continue;
        double px = ax + t * dx, py = ay + t * dy;
        double ex = sx - px, ey = sy - py;
        if (ex * nx + ey * ny > 0.5 || ex * nx + ey * ny < -0.5) continue;
        if (sqrt(ex * ex + ey * ey) > 0.5) continue;
        double z = az + t * (bz - az);
        size_t idx = ((size_t) y * fb->fw + x) * R3_NS + k;
        if (!(z < fb->depth[idx])) continue;
        fb->depth[idx] = (float) z;
        unsigned char *o = fb->col + idx * 3;
        o[0] = cr; o[1] = cg; o[2] = cbb;
      }
    }
  }
  (void) s;
}

/* ------------------------------------------------------------------ 清单解析 */
/* 清单的读头。`nums`/`nn`/`ni` 是**数走内存那一路**（清单头一行是 `r3 2` 时）：
   文本只留关键字与结构，数按顺序放在 asy 侧传进来的 `real[]` 里，`r3_num` 按游标取。
   为什么：面片一片就是 48 个 double，走文本要格式化一遍再解析一遍（量过：pdb 的清单
   65MB、解析 0.82s，asy 侧拼串又是一大块）。`r3 1`（数写在文本里）照旧收 ——
   手写的清单单测、以及 `OMNI_R3_TEXT=1` 那条调试路都靠它。 */
typedef struct {
  const char *p, *end;
  const double *nums;
  int64_t nn, ni;
  int ver;
} r3lex;

/* 关键字后面那一个字节算不算"词到这儿为止"。**换行也要算**：`r3 2` 那一路
   数不在文本里，于是 mat / pcol 那两行就是光秃秃的 `"mat\n"` —— 只认空白的旧判据
   会把它们全数不着，`matcap` 停在 1、材质表被写爆（图元里存的是 `const r3mat *`）。
   踩过一次：位图差从 18813 涨到 233985，且透明误判让 OIT 那一趟白跑（慢十几倍）。 */
static int r3_kwend(char c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static void r3_skipws(r3lex *L) {
  while (L->p < L->end && (*L->p == ' ' || *L->p == '\t' || *L->p == '\r' || *L->p == '\n'))
    L->p++;
}

/* 下一个记号：写进 buf（截断到 cap-1），回是否拿到 */
static int r3_word(r3lex *L, char *buf, size_t cap) {
  r3_skipws(L);
  if (L->p >= L->end) return 0;
  size_t n = 0;
  while (L->p < L->end && *L->p != ' ' && *L->p != '\t' && *L->p != '\r' && *L->p != '\n') {
    if (n + 1 < cap) buf[n++] = *L->p;
    L->p++;
  }
  buf[n] = 0;
  return 1;
}

/* 一个数。十进制照旧收（手写的清单单测里全是十进制），另外收一种
   **`x` 开头的十六进制位模式** —— 那就是这个 double 的 64 位原样，asy 那侧
   `_rhex`（= 方言的 `(sbase (realbits v) 16)`）写的。
   为什么加这一路：`string(v, 17)` 那一次 snprintf 是清单构建里最贵的一格
   （剖 pdb：`sn` 1022 万次调用、自用 3.34s，`OMNI_PROFILE=1` 排前列），
   而位模式两侧都便宜、而且是**精确**的（不像十进制要靠 17 位才round-trip）。 */
static int r3_num(r3lex *L, double *out) {
  /* `r3 2`：数在数组里，按顺序取；文本那侧这一格根本没有记号。 */
  if (L->ver >= 2) {
    if (L->ni >= L->nn) return 0;
    *out = L->nums[L->ni++];
    return 1;
  }
  char buf[64];
  if (!r3_word(L, buf, sizeof buf)) return 0;
  if (buf[0] == 'x') {
    /* 整词都得是十六进制：只判"有没有数字"不够 —— strtoull 会吞前导空白、收 `+`/`-`，
       超过 16 位还会回 ULLONG_MAX 而不报错，于是 `x-1` / `x1zz` / `x1ffffffffffffffff`
       会静默变成一个毫无关系的 double（位模式差一位就是完全另一个数）。 */
    int nd = 0;
    for (const char *q = buf + 1; *q != 0; ++q) {
      int hex = (*q >= '0' && *q <= '9') || (*q >= 'a' && *q <= 'f') || (*q >= 'A' && *q <= 'F');
      if (!hex) return 0;
      nd++;
    }
    if (nd < 1 || nd > 16) return 0;
    char *e = NULL;
    unsigned long long b = strtoull(buf + 1, &e, 16);
    if (e != buf + 1 + nd) return 0;
    uint64_t u = (uint64_t) b;
    double v;
    memcpy(&v, &u, sizeof v);
    *out = v;
    return 1;
  }
  char *e = NULL;
  double v = strtod(buf, &e);
  if (e == buf) return 0;
  *out = v;
  return 1;
}

static int r3_nums(r3lex *L, double *out, int n) {
  for (int i = 0; i < n; ++i) if (!r3_num(L, out + i)) return 0;
  return 1;
}

/* ------------------------------------------------------------------ 入口 */
/* 这一片三角的顶点色（没有就是 NULL）。-1 是"这一片没顶点色"的记号（见 r3tris_pushc）*/
static const float *r3_tri_vcol(const r3tris *t, size_t i) {
  if (!t->usecol || !t->col) return NULL;
  const float *c = t->col + i * 12;
  return c[3] >= 0.0f ? c : NULL;
}

/* 透明与否：材质的 alpha 或者顶点色的 alpha 任一 < 1（bezierpatch.cc:867） */
static int r3_tri_transparent(const r3tris *t, size_t i) {
  if (t->mat[i]->diffuse[3] < 1.0) return 1;
  const float *c = r3_tri_vcol(t, i);
  return c && (c[3] < 1.0f || c[7] < 1.0f || c[11] < 1.0f);
}

omni_str omni_r3_render(omni_str path, omni_arr_f64 nums) {
  clock_t t0 = clock(), t1 = t0, t2 = t0;
  r3_pick_samples();
  { const char *e = getenv("OMNI_R3_TCENTER");
    if (e) r3_tcenter = strcmp(e, "0") != 0; }
  { const char *e = getenv("OMNI_R3_TGATE");
    if (e) r3_tgate = strcmp(e, "0") != 0; }
  { const char *e = getenv("OMNI_R3_OITPIX");
    if (e) r3_oitpix = strcmp(e, "0") != 0; }
  { const char *e = getenv("OMNI_R3_SNAP");
    if (e) r3_snap = atof(e); }
  { const char *e = getenv("OMNI_R3_OPQANY");
    if (e) r3_opqany = strcmp(e, "0") != 0; }
  { const char *e = getenv("OMNI_R3_OPQINLINE");
    if (e) r3_opqinline = strcmp(e, "0") != 0; }
  { const char *e = getenv("OMNI_R3_PIX");
    if (e) {
      char *q = NULL;
      long vx = strtol(e, &q, 10);
      if (q && *q == ',') { r3_pix_x = (int) vx; r3_pix_y = (int) strtol(q + 1, NULL, 10); }
    } }
  char *cpath = omni_cstr(path);
  FILE *f = fopen(cpath, "rb");
  if (!f) return omni_str_new((char *) "", 0);
  if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return omni_str_new((char *) "", 0); }
  long sz = ftell(f);
  if (sz < 0) { fclose(f); return omni_str_new((char *) "", 0); }
  rewind(f);
  char *text = (char *) malloc((size_t) sz + 1);
  if (!text) { fclose(f); return omni_str_new((char *) "", 0); }
  size_t got = sz > 0 ? fread(text, 1, (size_t) sz, f) : 0;
  fclose(f);
  text[got] = 0;

  r3lex L;
  L.p = text;
  L.end = text + got;
  /* 头一行 `r3 2` = 数走 `nums` 那条内存的路；`r3 1` = 数写在文本里（手写的清单、
     以及 `OMNI_R3_TEXT=1` 那条调试路）。这儿只看版本号，记号照旧由下面的循环吃掉。 */
  L.ver = (got >= 4 && text[0] == 'r' && text[1] == '3' && text[2] == ' ' && text[3] == '2') ? 2 : 1;
  L.nums = nums == NULL ? NULL : (const double *) nums->items;
  L.nn = nums == NULL ? 0 : nums->len;
  L.ni = 0;
  r3scene S;
  memset(&S, 0, sizeof S);
  S.zoom = 1;
  S.bg[0] = S.bg[1] = S.bg[2] = 1;
  S.res = 0;

  r3tris tris; memset(&tris, 0, sizeof tris);
  /* 材质表：清单里每条 mat 存一格，后面的图元指到最近那一格。
   * **容量在解析前一次算好，之后绝不 realloc** —— 图元里存的是 `const r3mat *`，
   * 一 realloc 全部变成野指针。量到过的后果（cylinder）：5053 条 mat 让数组搬了十几次，
   * 早先的三角于是读到垃圾 alpha，8896 片里 2942 片被当成透明的，整个圆柱几乎不见
   * （ink 只剩 4.4%）。所以先数一遍有多少条 mat。 */
  r3mat *mats = NULL;
  size_t nmat = 0, matcap = 1;
  for (const char *q = text; q < L.end; ++q)
    if ((q == text || q[-1] == '\n') && q + 3 < L.end
        && q[0] == 'm' && q[1] == 'a' && q[2] == 't' && r3_kwend(q[3]))
      matcap++;
  mats = (r3mat *) malloc(matcap * sizeof(r3mat));
  if (!mats) { free(text); return omni_str_new((char *) "", 0); }
  /* 清单里出现过 `pcol` 才给顶点色开数组（一片三角 48 字节，能省就省）。 */
  for (const char *q = text; q < L.end; ++q)
    if ((q == text || q[-1] == '\n') && q + 4 < L.end
        && q[0] == 'p' && q[1] == 'c' && q[2] == 'o' && q[3] == 'l'
        && r3_kwend(q[4])) { tris.usecol = 1; break; }
  float pend[16]; int npend = 0;
  /* 逐顶点**法向**（`tnrm` 那一行，与 pcol 一样只作用在紧接着的那一条 tri 上）：
   * 三角网那一族（drawTriangles，`render(tessellate=true)` 走它）自带平滑法向，
   * 拿面法向顶的话整张曲面是分片平坦的 —— 量出来的：filesurface 的位图颜色种数
   * 参考 201728、我们只有 2514。 */
  r3v pendn[3]; int npendn = 0;
  /* 线段（曲线在 C 这边细分，见 r3_add_bez） */
  r3lines lns; memset(&lns, 0, sizeof lns);

  int ok = 1, ended = 0, header = 0;
  /* **视景体要在读几何之前就算出来**：每一片的 res 用的是 xmin..ymax（r3_res_for），
   * 而细分是边解析边跑的。清单里 size/proj/box/shift 都在几何之前，所以第一条几何
   * 到达时算一次就够；末尾那一趟看这个标记，不重算（也就不会重复打 r3dim）。 */
  int dimset = 0;
  char kw[32];
  while (ok && r3_word(&L, kw, sizeof kw)) {
    if (strcmp(kw, "r3") == 0) {
      /* 版本号**永远在文本里**（`r3 1` / `r3 2`）：v2 时 r3_num 是从数组取的，
         而这一格必须先于数组那条路读出来。 */
      char vw[8];
      if (!r3_word(&L, vw, sizeof vw)) { ok = 0; break; }
      if (strcmp(vw, "1") != 0 && strcmp(vw, "2") != 0) { ok = 0; break; }
      header = 1;
    } else if (strcmp(kw, "size") == 0) {
      double v[4]; if (!r3_nums(&L, v, 4)) { ok = 0; break; }
      S.oW = (int) v[0]; S.oH = (int) v[1]; S.fw = (int) v[2]; S.fh = (int) v[3];
    } else if (strcmp(kw, "proj") == 0) {
      char m[16]; double v[2];
      if (!r3_word(&L, m, sizeof m) || !r3_nums(&L, v, 2)) { ok = 0; break; }
      S.ortho = strcmp(m, "ortho") == 0;
      S.angle = v[0]; S.zoom = v[1];
    } else if (strcmp(kw, "box") == 0) {
      double v[6]; if (!r3_nums(&L, v, 6)) { ok = 0; break; }
      S.m = r3v_mk(v[0], v[1], v[2]); S.M = r3v_mk(v[3], v[4], v[5]);
    } else if (strcmp(kw, "shift") == 0) {
      double v[2]; if (!r3_nums(&L, v, 2)) { ok = 0; break; }
      S.shiftx = v[0]; S.shifty = v[1];
    } else if (strcmp(kw, "bg") == 0) {
      double v[3]; if (!r3_nums(&L, v, 3)) { ok = 0; break; }
      S.bg[0] = v[0]; S.bg[1] = v[1]; S.bg[2] = v[2];
    } else if (strcmp(kw, "res") == 0) {
      double v; if (!r3_num(&L, &v)) { ok = 0; break; }
      S.res = v;
      /* **res2 必须在这儿就算出来**：面片细分是在解析过程中跑的（读到一条 patch
       * 就递归），而不是解析完之后。原先只在末尾算一次，于是细分时 res2 还是 0 ——
       * 没有一片是"平的"，每片都递归到深度上限（量出来：vN 那把尺子 17 片面片
       * × 4^12 ≈ 2.8 亿次，跑到 8 秒还没完）。 */
      S.res2 = S.res * S.res;
    } else if (strcmp(kw, "light") == 0) {
      double v[6]; if (!r3_nums(&L, v, 6)) { ok = 0; break; }
      if (S.nlight < R3_MAXLIGHT) {
        S.ldir[S.nlight] = r3v_mk(v[0], v[1], v[2]);
        S.lcol[S.nlight][0] = v[3]; S.lcol[S.nlight][1] = v[4]; S.lcol[S.nlight][2] = v[5];
        S.nlight++;
      }
    } else if (strcmp(kw, "mat") == 0) {
      double v[14]; if (!r3_nums(&L, v, 14)) { ok = 0; break; }
      if (nmat + 1 > matcap) { ok = 0; break; }   /* 容量在解析前一次算好，见下面那段 */
      r3mat *M = mats + nmat++;
      memset(M, 0, sizeof *M);
      for (int i = 0; i < 4; ++i) M->diffuse[i] = v[i];
      for (int i = 0; i < 3; ++i) M->emissive[i] = v[4 + i];
      for (int i = 0; i < 3; ++i) M->specular[i] = v[7 + i];
      M->shininess = v[10]; M->metallic = v[11]; M->fresnel0 = v[12];
      M->lightOn = v[13] != 0;
    } else if (strcmp(kw, "pcol") == 0) {
      /* 逐顶点色：`pcol n r g b a …`（n = 4 给 patch、3 给 btri），
       * 只作用在**紧接着的那一条** patch/btri 上。 */
      double n; if (!r3_num(&L, &n)) { ok = 0; break; }
      int nc = (int) n;
      if (nc != 3 && nc != 4) { ok = 0; break; }
      double v[16];
      if (!r3_nums(&L, v, nc * 4)) { ok = 0; break; }
      for (int i = 0; i < nc * 4; ++i) pend[i] = (float) v[i];
      npend = nc;
    } else if (strcmp(kw, "patch") == 0) {
      double st; double cp[48];
      if (!r3_num(&L, &st) || !r3_nums(&L, cp, 48) || nmat == 0) { ok = 0; break; }
      r3v p[16];
      for (int i = 0; i < 16; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      if (!dimset) { r3_set_dimensions(&S); dimset = 1; }
      if (!r3_add_patch(&S, &tris, p, st != 0, mats + (nmat - 1),
                        npend == 4 ? pend : NULL)) { ok = 0; break; }
      npend = 0;
    } else if (strcmp(kw, "btri") == 0) {
      /* 三角面片（管子的接头）：十个控制点，编号照 bezierpatch.cc:652 那张图 */
      double st; double cp[30];
      if (!r3_num(&L, &st) || !r3_nums(&L, cp, 30) || nmat == 0) { ok = 0; break; }
      r3v p[10];
      for (int i = 0; i < 10; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      if (!dimset) { r3_set_dimensions(&S); dimset = 1; }
      if (!r3_add_tri3(&S, &tris, p, st != 0, mats + (nmat - 1),
                       npend == 3 ? pend : NULL)) { ok = 0; break; }
      npend = 0;
    } else if (strcmp(kw, "tnrm") == 0) {
      /* 逐顶点法向，九个数（三个顶点各一个），只作用在紧接着的那一条 tri 上 */
      double v[9]; if (!r3_nums(&L, v, 9)) { ok = 0; break; }
      for (int i = 0; i < 3; ++i)
        pendn[i] = r3v_mk(v[3 * i], v[3 * i + 1], v[3 * i + 2]);
      npendn = 3;
    } else if (strcmp(kw, "tri") == 0) {
      double v[9]; if (!r3_nums(&L, v, 9) || nmat == 0) { ok = 0; break; }
      r3v a = r3v_mk(v[0], v[1], v[2]);
      r3v b = r3v_mk(v[3], v[4], v[5]);
      r3v c = r3v_mk(v[6], v[7], v[8]);
      /* 有 `tnrm` 就用逐顶点法向（drawTriangles 自带的那份），没有才退回面法向。
       * 逐顶点色照 `pcol 3` 那一格走，与 btri 同一条路。 */
      r3v na, nb, nc;
      if (npendn == 3) { na = pendn[0]; nb = pendn[1]; nc = pendn[2]; }
      else {
        r3v n = r3v_cross(r3v_sub(b, a), r3v_sub(c, a));
        na = n; nb = n; nc = n;
      }
      if (!r3tris_pushc(&tris, a, na, b, nb, c, nc, mats + (nmat - 1),
                        npend == 3 ? pend : NULL)) { ok = 0; break; }
      npend = 0; npendn = 0;
    } else if (strcmp(kw, "bez") == 0) {
      /* 一段三次曲线（四个控制点）：细分照 beziercurve.cc:62 在这边做 */
      double cp[12];
      if (!r3_nums(&L, cp, 12) || nmat == 0) { ok = 0; break; }
      r3v p[4];
      for (int i = 0; i < 4; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      /* 曲线也是一段一段各自算 res（beziercurve.h:54 同一格，ratio 由 drawpath3.cc
       * 传进来，公式与面片那边一字不差）。 */
      if (!dimset) { r3_set_dimensions(&S); dimset = 1; }
      r3_set_res(&S, p, 4, mats + (nmat - 1), NULL, 0);   /* 曲线没有顶点色 */
      if (!r3_add_bez(&S, &lns, p, mats + (nmat - 1), 0)) { ok = 0; break; }
    } else if (strcmp(kw, "line") == 0) {
      double cnt; if (!r3_num(&L, &cnt) || nmat == 0) { ok = 0; break; }
      int n = (int) cnt;
      if (n < 2) { ok = 0; break; }
      r3v prev = r3v_mk(0, 0, 0);
      for (int i = 0; i < n; ++i) {
        double v[3]; if (!r3_nums(&L, v, 3)) { ok = 0; break; }
        r3v q = r3v_mk(v[0], v[1], v[2]);
        if (i > 0 && !r3lines_push(&lns, prev, q, mats + (nmat - 1))) { ok = 0; break; }
        prev = q;
      }
    } else if (strcmp(kw, "end") == 0) {
      ended = 1;
      break;
    } else {
      ok = 0;
    }
  }

  omni_str out = omni_str_new((char *) "", 0);
  t1 = clock();                                 /* 解析 + 细分到这里为止 */
  if (ok && ended && header && S.fw > 0 && S.fh > 0) {
    if (!dimset) r3_set_dimensions(&S);
    r3_projection(&S);

    size_t np = (size_t) S.fw * S.fh * R3_NS;
    r3fb fb;
    memset(&fb, 0, sizeof fb);
    fb.fw = S.fw; fb.fh = S.fh;
    fb.depth = (float *) malloc(np * sizeof(float));
    fb.col = (unsigned char *) malloc(np * 3);
    if (fb.depth && fb.col) {
      /* 底色也走同一条 float -> unorm8（glClearColor 收的是 float，清出来的那一格
         也是 unorm8）。bg 常常是 1 或 0，但 0.9 那类值上这一条同样要算对。 */
      unsigned char b0 = r3_unorm8((float) S.bg[0]);
      unsigned char b1 = r3_unorm8((float) S.bg[1]);
      unsigned char b2 = r3_unorm8((float) S.bg[2]);
      for (size_t i = 0; i < np; ++i) {
        fb.depth[i] = 1.0f;
        fb.col[3 * i] = b0; fb.col[3 * i + 1] = b1; fb.col[3 * i + 2] = b2;
      }
      /* 三趟：先不透明（定死深度）、再线段、最后透明（不写深度）。
       * GL 那边也是分开的两个缓冲（bezierpatch.cc 的 triangleData / transparentData）。*/
      size_t ntr = tris.n / 3, ntrans = 0;
      for (size_t t = 0; t < ntr; ++t)
        if (r3_tri_transparent(&tris, t)) ntrans++;
      /* 逐像素那一路要的两格（见 r3_raster_pix 的头注）**在画之前就开好** ——
         线那一趟也要往里收（不然透明面片压在线上时底色会退成背景）。 */
      if (r3_oitpix && ntrans > 0) {
        size_t npx0 = (size_t) S.fw * S.fh;
        fb.pcol = (float *) calloc(npx0 * 3, sizeof(float));
        fb.pdep = (float *) calloc(npx0, sizeof(float));
        if (!fb.pcol || !fb.pdep) {
          free(fb.pcol); fb.pcol = NULL;
          free(fb.pdep); fb.pdep = NULL;
        }
      }
      for (size_t t = 0; t < ntr; ++t) {
        if (r3_tri_transparent(&tris, t)) continue;
        r3_raster_tri(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                      r3_tri_vcol(&tris, t));
      }
      for (size_t i = 0; i + 1 < lns.n; i += 2)
        r3_raster_line(&S, &fb, lns.p[i], lns.p[i + 1], lns.mat[i / 2]);
      if (ntrans > 0 && r3_oitpix) {
        /* **逐像素那一路**（`OMNI_R3_OITPIX=1`，见 r3_raster_pix 的头注）：
         * 收不透明那一格的色与深度 -> 数透明片元 -> 填 -> 按深度降序混，
         * 混出来的一个值写进这一格的**全部**采样点（参考那边 blend.glsl 也是
         * 一格一个值；没有透明片元的格子它 `discard`，所以那些格子照旧是
         * 不透明那一趟多重采样的结果 —— 这里也只碰 cnt > 0 的格子）。 */
        size_t npx = (size_t) S.fw * S.fh;
        /* pcol/pdep 在上面（画之前）就开好了，这儿只在那一步失败时补一次 */
        if (!fb.pcol) fb.pcol = (float *) calloc(npx * 3, sizeof(float));
        if (!fb.pdep) fb.pdep = (float *) calloc(npx, sizeof(float));
        fb.tcnt = (unsigned *) calloc(npx + 1, sizeof(unsigned));
        if (fb.pcol && fb.pdep && fb.tcnt) {
          /* phase 0（收不透明底色）：`r3_opqinline` 开着时不透明那一趟已经顺手收过了 */
          if (!r3_opqinline)
            for (size_t t = 0; t < ntr; ++t) {
              if (r3_tri_transparent(&tris, t)) continue;
              r3_raster_pix(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                            r3_tri_vcol(&tris, t), 0);
            }
          for (size_t t = 0; t < ntr; ++t) {
            if (!r3_tri_transparent(&tris, t)) continue;
            r3_raster_pix(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                          r3_tri_vcol(&tris, t), 1);
          }
          size_t total = 0;
          for (size_t i = 0; i < npx; ++i) total += fb.tcnt[i];
          if (total > 0) fb.tfrag = (float *) malloc(total * 5 * sizeof(float));
          if (total > 0 && fb.tfrag) {
            size_t run = 0;
            for (size_t i = 0; i < npx; ++i) {
              run += fb.tcnt[i];
              fb.tcnt[i] = (unsigned) run;         /* 段末（写指针往前退） */
            }
            fb.tcnt[npx] = (unsigned) total;
            for (size_t t = 0; t < ntr; ++t) {
              if (!r3_tri_transparent(&tris, t)) continue;
              r3_raster_pix(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                            r3_tri_vcol(&tris, t), 2);
            }
            for (size_t i = 0; i < npx; ++i) {
              size_t beg = fb.tcnt[i];
              size_t cnt = (size_t) fb.tcnt[i + 1] - beg;
              if (cnt == 0) continue;
              float *base = fb.tfrag + beg * 5;
              for (size_t a = 1; a < cnt; ++a) {   /* 按深度降序的插入排序 */
                float tmp[5];
                for (int q = 0; q < 5; ++q) tmp[q] = base[a * 5 + q];
                size_t b = a;
                while (b > 0 && tmp[4] > base[(b - 1) * 5 + 4]) {
                  for (int q = 0; q < 5; ++q) base[b * 5 + q] = base[(b - 1) * 5 + q];
                  --b;
                }
                for (int q = 0; q < 5; ++q) base[b * 5 + q] = tmp[q];
              }
              /* 底色：那一格有不透明层就用它的色，否则用背景（blend.glsl:101） */
              float od = fb.pdep[i];
              float acc[3];
              for (int ch = 0; ch < 3; ++ch)
                acc[ch] = od != 0.0f ? fb.pcol[i * 3 + ch] : (float) S.bg[ch];
              int dbg = r3_pix_x >= 0
                        && (int) (i % (size_t) S.fw) == r3_pix_x
                        && (int) (i / (size_t) S.fw) == r3_pix_y;
              if (dbg) {
                fprintf(stderr, "r3pix %d,%d（逐像素那一路）：%zu 个片元，"
                        "不透明深度 %.9g 底色 %.6f %.6f %.6f\n",
                        r3_pix_x, r3_pix_y, cnt, (double) od,
                        (double) acc[0], (double) acc[1], (double) acc[2]);
                for (size_t a = 0; a < cnt; ++a) {
                  const float *f = base + a * 5;
                  fprintf(stderr, "  #%zu rgb %.6f %.6f %.6f alpha %.6f 深度 %.9g\n",
                          a, (double) f[0], (double) f[1], (double) f[2],
                          (double) f[3], (double) f[4]);
                }
              }
              /* 被不透明层挡住的片元跳掉（blend.glsl:104-106，判据是 `>=`） */
              size_t k = 0;
              if (od != 0.0f) while (k < cnt && base[k * 5 + 4] >= od) ++k;
              for (size_t a = k; a < cnt; ++a) {
                const float *f = base + a * 5;
                float al = f[3];
                /* **层与层之间不夹**（`mix()` 就是这一句，GLSL 不夹）：夹了的话
                   过曝的高光会在混色里被削掉，见上面 r3_raster_pix 里那段注。
                   最后 r3_unorm8 会夹。 */
                for (int ch = 0; ch < 3; ++ch)
                  acc[ch] = f[ch] * al + acc[ch] * (1.0f - al);
              }
              unsigned char q0 = r3_unorm8(acc[0]);
              unsigned char q1 = r3_unorm8(acc[1]);
              unsigned char q2 = r3_unorm8(acc[2]);
              for (int sk = 0; sk < R3_NS; ++sk) {
                unsigned char *o = fb.col + (i * R3_NS + (size_t) sk) * 3;
                o[0] = q0; o[1] = q1; o[2] = q2;
              }
            }
          }
        }
        free(fb.pcol); fb.pcol = NULL;
        free(fb.pdep); fb.pdep = NULL;
        free(fb.tcnt); fb.tcnt = NULL;
        free(fb.tfrag); fb.tfrag = NULL;
      } else if (ntrans > 0) {
        /* 透明：**逐采样点**收片元、按深度降序排完再混（照 shaders/blend.glsl）。
         * 三步：数 -> 前缀和 -> 填。三角按**原来的次序**过（不预排）—— 参考那边
         * 片元是按画的次序 append 的，插入排序用的是严格 `>`，所以深度相等的
         * 保持 append 次序；预排会把这个次序打乱。 */
        size_t cap = (size_t) 24 * 1024 * 1024;    /* 片元条数上限（每条 20 字节） */
        { const char *e = getenv("OMNI_R3_OITMAX");
          if (e) cap = (size_t) strtoull(e, NULL, 10); }
        size_t total = 0;
        int oit = 0;
        /* np+1 格：最后一格放总数，填完之后第 i 段就是 [tcnt[i], tcnt[i+1]) */
        fb.tcnt = (unsigned *) calloc(np + 1, sizeof(unsigned));
        if (fb.tcnt) {
          fb.tmode = 1;
          for (size_t t = 0; t < ntr; ++t) {
            if (!r3_tri_transparent(&tris, t)) continue;
            r3_raster_tri(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                          r3_tri_vcol(&tris, t));
          }
          fb.tmode = 0;
          for (size_t i = 0; i < np; ++i) total += fb.tcnt[i];
          if (total == 0) oit = 1;                 /* 一片都没落上，什么都不用做 */
          else if (total <= cap) {
            fb.tfrag = (float *) malloc(total * 5 * sizeof(float));
            oit = fb.tfrag != NULL;
          }
        }
        if (oit && total > 0) {
          size_t run = 0;
          for (size_t i = 0; i < np; ++i) {
            run += fb.tcnt[i];
            fb.tcnt[i] = (unsigned) run;           /* 段末（写指针往前退） */
          }
          fb.tcnt[np] = (unsigned) total;
          fb.tmode = 2;
          for (size_t t = 0; t < ntr; ++t) {
            if (!r3_tri_transparent(&tris, t)) continue;
            r3_raster_tri(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                          r3_tri_vcol(&tris, t));
          }
          fb.tmode = 0;
          /* 填完之后 tcnt[i] 退到了第 i 段的**开头**，下一格就是这一段的末尾 */
          for (size_t i = 0; i < np; ++i) {
            size_t beg = fb.tcnt[i];
            size_t cnt = (size_t) fb.tcnt[i + 1] - beg;
            if (cnt > 0) {
              float *base = fb.tfrag + beg * 5;
              for (size_t a = 1; a < cnt; ++a) {   /* 按深度降序的插入排序 */
                float tmp[5];
                for (int q = 0; q < 5; ++q) tmp[q] = base[a * 5 + q];
                size_t b = a;
                while (b > 0 && tmp[4] > base[(b - 1) * 5 + 4]) {
                  for (int q = 0; q < 5; ++q) base[b * 5 + q] = base[(b - 1) * 5 + q];
                  --b;
                }
                for (int q = 0; q < 5; ++q) base[b * 5 + q] = tmp[q];
              }
              unsigned char *o = fb.col + i * 3;
              float acc[3];
              for (int ch = 0; ch < 3; ++ch) acc[ch] = o[ch] / 255.0f;
              int dbg = 0;
              if (r3_pix_x >= 0) {
                size_t pix = i / R3_NS;
                dbg = (int) (pix % (size_t) S.fw) == r3_pix_x
                      && (int) (pix / (size_t) S.fw) == r3_pix_y;
              }
              if (dbg) {
                fprintf(stderr, "r3pix %d,%d 采样点 %d：%zu 个片元，底色 %u %u %u\n",
                        r3_pix_x, r3_pix_y, (int) (i % R3_NS), cnt,
                        (unsigned) o[0], (unsigned) o[1], (unsigned) o[2]);
                for (size_t a = 0; a < cnt; ++a) {
                  const float *f = base + a * 5;
                  fprintf(stderr, "  #%zu rgb %.6f %.6f %.6f alpha %.6f 深度 %.9g\n",
                          a, (double) f[0], (double) f[1], (double) f[2],
                          (double) f[3], (double) f[4]);
                }
              }
              for (size_t a = 0; a < cnt; ++a) {   /* mix(out, color, color.a) */
                const float *f = base + a * 5;
                float al = f[3];
                for (int ch = 0; ch < 3; ++ch) {
                  float v = f[ch] * al + acc[ch] * (1.0f - al);
                  if (v < 0.0f) v = 0.0f;
                  if (v > 1.0f) v = 1.0f;
                  acc[ch] = v;
                }
              }
              for (int ch = 0; ch < 3; ++ch)
                o[ch] = r3_unorm8(acc[ch]);
              if (dbg)
                fprintf(stderr, "  -> %u %u %u\n",
                        (unsigned) o[0], (unsigned) o[1], (unsigned) o[2]);
            }
          }
        } else if (!oit) {
          /* 退回老路（片元太多或分配不下）：按三角质心的视图空间平均 z 升序排一次
           * （z 越负越远），直接往 colf 上混。同一个采样点上的先后可能与参考相反。 */
          size_t *ord = (size_t *) malloc(ntrans * sizeof(size_t));
          double *key = ord ? (double *) malloc(ntrans * sizeof(double)) : NULL;
          if (key) {
            size_t n = 0;
            for (size_t t = 0; t < ntr; ++t) {
              if (!r3_tri_transparent(&tris, t)) continue;
              ord[n] = t;
              key[n] = (tris.pos[3 * t].z + tris.pos[3 * t + 1].z
                        + tris.pos[3 * t + 2].z) / 3.0;
              n++;
            }
            for (size_t gap = n / 2; gap > 0; gap /= 2)   /* 希尔排序，不额外分配 */
              for (size_t i = gap; i < n; ++i) {
                size_t vi = ord[i]; double vk = key[i];
                size_t j = i;
                while (j >= gap && key[j - gap] > vk) {
                  ord[j] = ord[j - gap]; key[j] = key[j - gap]; j -= gap;
                }
                ord[j] = vi; key[j] = vk;
              }
            free(key);
            fb.colf = (float *) malloc(np * 3 * sizeof(float));
            if (fb.colf)
              for (size_t i = 0; i < np * 3; ++i) fb.colf[i] = fb.col[i] / 255.0f;
            for (size_t k = 0; k < n; ++k) {
              size_t t = ord[k];
              r3_raster_tri(&S, &fb, tris.pos + 3 * t, tris.nrm + 3 * t, tris.mat[t],
                            r3_tri_vcol(&tris, t));
            }
            if (fb.colf) {
              for (size_t i = 0; i < np * 3; ++i)
                fb.col[i] = r3_unorm8(fb.colf[i]);
              free(fb.colf);
              fb.colf = NULL;
            }
          }
          free(ord);
        }
        free(fb.tcnt); fb.tcnt = NULL;
        free(fb.tfrag); fb.tfrag = NULL;
      }

      t2 = clock();                             /* 光栅化到这里为止 */
      /* 量口：`OMNI_R3_DEBUG=1` 时把三角/线段/混色次数与**三段耗时**印到 stderr。
       * 只有这一处对外说话 —— 三维那一档出问题时先看这几个数。 */
      if (getenv("OMNI_R3_DEBUG"))
        fprintf(stderr, "r3: %dx%d 三角 %zu（透明 %zu）线段 %zu 混色 %zu"
                " 进来之前 %.2fs 解析 %.2fs 光栅 %.2fs\n",
                S.fw, S.fh, ntr, ntrans, lns.n / 2, fb.nblend,
                (double) t0 / CLOCKS_PER_SEC,
                (double) (t1 - t0) / CLOCKS_PER_SEC,
                (double) (t2 - t1) / CLOCKS_PER_SEC);

      /* 解析（多重采样求平均，**四舍五入**）+ dealias + 十六进制。
       * 行序照 glReadPixels：**第 0 行在下**。
       * dealias 是 psfile.cc:74 的那一趟（`antialias=2` 默认打开）：
       * 除最后一行、最后一列，每个像素换成它与右、下、右下三格的**平均（截断）**。
       * 两侧对齐的凭据（一条 1bp 竖线，size(120)）：几何 [190.4,194.4]，
       * 解析后 raw = …255,128,0,0,0,128,255…，dealias 后 191,64,0,0,64,191 ——
       * 参考位图逐字节就是这一串。 */
      size_t nb = (size_t) S.fw * S.fh * 3;
      unsigned char *img = (unsigned char *) malloc(nb);
      if (!img) { free(fb.depth); free(fb.col); free(tris.pos); free(tris.nrm);
                  free((void *) tris.mat); free(lns.p); free((void *) lns.mat);
                  free(mats); free(text); return out; }
      for (int y = 0; y < S.fh; ++y)
        for (int x = 0; x < S.fw; ++x) {
          size_t base = ((size_t) y * S.fw + x) * R3_NS;
          for (int ch = 0; ch < 3; ++ch) {
            unsigned sum = 0;
            for (int k = 0; k < R3_NS; ++k) sum += fb.col[(base + k) * 3 + ch];
            img[((size_t) y * S.fw + x) * 3 + ch]
              = (unsigned char) ((sum + R3_NS / 2) / R3_NS);
          }
        }
      /* `OMNI_R3_PIX=x,y` 的第二段：把那一格（与右、下、右下三个邻居 —— 下面那趟
         2x2 盒子取平均要用到它们）在**取平均之后、模糊之前**的字节印出来。
         查"这一格的颜色是自己来的还是被邻居带过来的"就靠这一段。 */
      if (r3_pix_x >= 0 && r3_pix_x + 1 < S.fw && r3_pix_y + 1 < S.fh && r3_pix_y >= 0) {
        for (int dy = 0; dy < 2; ++dy)
          for (int dx = 0; dx < 2; ++dx) {
            int x = r3_pix_x + dx, y = r3_pix_y + dy;
            size_t base = ((size_t) y * S.fw + x) * R3_NS;
            fprintf(stderr, "r3pix (%d,%d) 采样点", x, y);
            for (int k = 0; k < R3_NS; ++k)
              fprintf(stderr, " %u", (unsigned) fb.col[(base + k) * 3]);
            fprintf(stderr, "  平均后 %u\n",
                    (unsigned) img[((size_t) y * S.fw + x) * 3]);
          }
      }
      {
        size_t nw = (size_t) S.fw * 3;
        for (int y = 0; y + 1 < S.fh; ++y)
          for (int x = 0; x + 1 < S.fw; ++x) {
            unsigned char *a = img + (size_t) y * nw + (size_t) x * 3;
            for (int ch = 0; ch < 3; ++ch)
              a[ch] = (unsigned char) (((unsigned) a[ch] + (unsigned) a[ch + 3]
                                        + (unsigned) a[ch + nw]
                                        + (unsigned) a[ch + nw + 3]) / 4);
          }
      }
      char *hex = omni_alloc_bytes(nb * 2 + 1);
      static const char *D = "0123456789abcdef";
      size_t o = 0;
      for (size_t i = 0; i < nb; ++i) {
        hex[o++] = D[(img[i] >> 4) & 15];
        hex[o++] = D[img[i] & 15];
      }
      hex[o] = 0;
      free(img);
      out = omni_str_new(hex, (int64_t) o);
    }
    free(fb.depth);
    free(fb.col);
  }

  free(tris.pos); free(tris.nrm); free((void *) tris.mat); free(tris.col);
  free(lns.p); free((void *) lns.mat);
  free(mats);
  free(text);
  return out;
}
