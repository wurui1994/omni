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
  t->cap = cap;
  return 1;
}

static int r3tris_push(r3tris *t, r3v a, r3v na, r3v b, r3v nb, r3v c, r3v nc,
                       const r3mat *m) {
  if (!r3tris_grow(t, 3)) return 0;
  t->mat[t->n / 3] = m;
  t->pos[t->n] = a; t->nrm[t->n] = na; t->n++;
  t->pos[t->n] = b; t->nrm[t->n] = nb; t->n++;
  t->pos[t->n] = c; t->nrm[t->n] = nc; t->n++;
  return 1;
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

/* bezierpatch.h:89 Distance —— 水平/竖直两个方向各自的"平坦度" */
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

/* bezierpatch.cc:174 的递归。**这一刀只走两种情形**：平了就出两片三角，不平就四分。
 * 原版还有"只有一个方向平"的两个分支（:227 与 :319，那两处只对半分一次），
 * 三角的落点会不一样 —— 下一刀照抄。判据（res2、Distance）已经是原版。 */
static int r3_render_patch(const r3scene *s, r3tris *t, const r3v *p,
                           r3v P0, r3v P1, r3v P2, r3v P3,
                           r3v N0, r3v N1, r3v N2, r3v N3,
                           const r3mat *mat, int depth) {
  double h, v;
  r3_distance(p, &h, &v);
  /* res2 <= 0（清单里没给 res）或者判据不是有限数时**当成平的** —— 不然一片就能
   * 递归到深度上限，4^12 次。深度上限压到 8（最坏 65536 片），原版没有上限，
   * 靠的是判据必然收敛。 */
  if (!(s->res2 > 0 && h == h && v == v) || (h < s->res2 && v < s->res2) || depth >= 8) {
    if (!r3tris_push(t, P0, N0, P1, N1, P2, N2, mat)) return 0;
    if (!r3tris_push(t, P0, N0, P2, N2, P3, N3, mat)) return 0;
    return 1;
  }
  r3v q[4][16];
  r3_split4(p, q);
  /* 四块的角与法向都从各自的控制网重算（与原版一样：细分后的角法向由子网决定） */
  for (int k = 0; k < 4; ++k) {
    r3v n[4];
    r3_corner_normals(s, q[k], n);
    if (!r3_render_patch(s, t, q[k], q[k][0], q[k][12], q[k][15], q[k][3],
                         n[0], n[1], n[2], n[3], mat, depth + 1)) return 0;
  }
  return 1;
}

/* 一片面片进表：先算 epsilon（bezierpatch.cc:70）与四角法向，再递归 */static int r3_add_patch(r3scene *s, r3tris *t, const r3v *p, int straight,
                        const r3mat *mat) {
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
    if (!r3tris_push(t, P0, n[0], P1, n[1], P2, n[2], mat)) return 0;
    if (!r3tris_push(t, P0, n[0], P2, n[2], P3, n[3], mat)) return 0;
    return 1;
  }
  return r3_render_patch(s, t, p, P0, P1, P2, P3, n[0], n[1], n[2], n[3], mat, 0);
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

static int r3_render_tri(const r3scene *s, r3tris *t, const r3v *p,
                         r3v P0, r3v P1, r3v P2, r3v N0, r3v N1, r3v N2,
                         const r3mat *mat, int depth) {
  double d = r3_tri_distance(p);
  if (!(s->res2 > 0 && d == d) || d < s->res2 || depth >= 8)
    return r3tris_push(t, P0, N0, P1, N1, P2, N2, mat);
  r3v q[4][10];
  r3_tri_split4(p, q);
  for (int k = 0; k < 4; ++k) {
    r3v n[3];
    r3_tri_normals(s, q[k], n);
    if (!r3_render_tri(s, t, q[k], q[k][0], q[k][6], q[k][9],
                       n[0], n[1], n[2], mat, depth + 1)) return 0;
  }
  return 1;
}

static int r3_add_tri3(r3scene *s, r3tris *t, const r3v *p, int straight,
                       const r3mat *mat) {
  double eps = 0;
  for (int i = 1; i < 10; ++i) {
    double q = r3v_abs2(r3v_sub(p[i], p[0]));
    if (q > eps) eps = q;
  }
  s->epsilon = eps * DBL_EPSILON;
  r3v n[3];
  r3_tri_normals(s, p, n);
  if (straight) return r3tris_push(t, p[0], n[0], p[6], n[1], p[9], n[2], mat);
  return r3_render_tri(s, t, p, p[0], p[6], p[9], n[0], n[1], n[2], mat, 0);
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
  double aspect = ((double) Width) / Height;
  double zoom = s->zoom == 0 ? 1 : s->zoom;
  double xshift = s->shiftx * zoom;
  double yshift = s->shifty * zoom;
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
}

/* glm::ortho / glm::frustum（右手、深度 [-1,1]），列主序 P[col][row] */
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

/* fragment.glsl:232 main —— 一个片元的颜色（不含 alpha 那一格的合成） */
static void r3_shade(const r3scene *s, const r3mat *mat, r3v nrm, r3v viewPos,
                     int frontFacing, float out[3]) {
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
  if (!mat->lightOn) return;

  r3f viewDir;
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
#define R3_NS 16
static const float R3_SAMPLE[R3_NS][2] = {
  { 0.125f, 0.125f }, { 0.375f, 0.125f }, { 0.625f, 0.125f }, { 0.875f, 0.125f },
  { 0.125f, 0.375f }, { 0.375f, 0.375f }, { 0.625f, 0.375f }, { 0.875f, 0.375f },
  { 0.125f, 0.625f }, { 0.375f, 0.625f }, { 0.625f, 0.625f }, { 0.875f, 0.625f },
  { 0.125f, 0.875f }, { 0.375f, 0.875f }, { 0.625f, 0.875f }, { 0.875f, 0.875f }
};

/* 透明那一档：GL 那边是把片元攒进逐像素的链表（fragment.glsl 的 TRANSPARENT 分支
 * 往 fragment[]/depth[] 里写），再按深度合成。这里照同一套：透明片元**不写深度**
 * （彼此不遮挡），只在比不透明层近的时候记一条，最后由远到近 source-over。 */
typedef struct { float d, r, g, b, a; int next; } r3frag;

typedef struct {
  int fw, fh;
  float *depth;          /* fw*fh*R3_NS，初值 1（远） */
  unsigned char *col;    /* fw*fh*R3_NS*3 */
  int *head;             /* fw*fh*R3_NS，透明片元链表的头（-1 表示空） */
  r3frag *frag;
  size_t nfrag, capfrag;
  int oom;
} r3fb;

static int r3fb_push_frag(r3fb *fb, size_t idx, float d, const float rgb[3], float a) {
  if (fb->nfrag == fb->capfrag) {
    size_t cap = fb->capfrag == 0 ? 4096 : fb->capfrag * 2;
    r3frag *p = (r3frag *) realloc(fb->frag, cap * sizeof(r3frag));
    if (!p) { fb->oom = 1; return 0; }
    fb->frag = p; fb->capfrag = cap;
  }
  r3frag *f = fb->frag + fb->nfrag;
  f->d = d; f->r = rgb[0]; f->g = rgb[1]; f->b = rgb[2]; f->a = a;
  f->next = fb->head[idx];
  fb->head[idx] = (int) fb->nfrag;
  fb->nfrag++;
  return 1;
}

typedef struct { double x, y, z, w; } r3clip;

static r3clip r3_project(const r3scene *s, r3v v) {
  r3clip c;
  c.x = s->P[0][0] * v.x + s->P[1][0] * v.y + s->P[2][0] * v.z + s->P[3][0];
  c.y = s->P[0][1] * v.x + s->P[1][1] * v.y + s->P[2][1] * v.z + s->P[3][1];
  c.z = s->P[0][2] * v.x + s->P[1][2] * v.y + s->P[2][2] * v.z + s->P[3][2];
  c.w = s->P[0][3] * v.x + s->P[1][3] * v.y + s->P[2][3] * v.z + s->P[3][3];
  return c;
}

/* 裁剪坐标 -> 窗口坐标。**两个方向各减半个像素** —— 这一格是量出来的，不是推的：
 * 拿真 asy 当尺子，同一个满幅方块在 size(40)/60/61/100 四档上，参考位图的边一律落在
 * 「第 1 个像素半覆盖（值 128）、第 W-2 个像素半覆盖」，也就是内容的连续区间是
 * [1.5, W-2.5]；而按 glViewport 的教科书公式 (ndc*0.5+0.5)*W 算出来是
 * [1.967, W-1.97]（视景体 61 单位、内容 60 单位、W=240 那一档）。**宽度对得上**
 * （236.07 vs 236），差的只是一个**与尺寸无关的恒定 -0.5 像素**。
 * 所以这里照量到的口径写；根因（驱动的采样点位 vs glViewport 的口径）另案追。 */
static void r3_window(const r3fb *fb, r3clip c, double *x, double *y, double *z) {
  double inv = 1.0 / c.w;
  *x = (c.x * inv * 0.5 + 0.5) * fb->fw - 0.5;
  *y = (c.y * inv * 0.5 + 0.5) * fb->fh - 0.5;
  *z = c.z * inv * 0.5 + 0.5;                 /* glDepthRange 默认 0..1 */
}

/* 一片三角进帧缓冲。位置是视图空间，法向按重心插值，着色在像素中心算一次。 */
static void r3_raster_tri(const r3scene *s, r3fb *fb, const r3v *P, const r3v *N,
                          const r3mat *mat) {
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
  int front = area > 0.0;                      /* GL 默认正面是逆时针 */
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

  float alpha = (float) mat->diffuse[3];
  int opaque = !(alpha < 1.0f);
  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) {
      int shaded = 0;
      unsigned char cr = 0, cg = 0, cb = 0;
      float frgb[3] = { 0, 0, 0 };
      for (int k = 0; k < R3_NS; ++k) {
        double sx = x + R3_SAMPLE[k][0];
        double sy = y + R3_SAMPLE[k][1];
        double b0 = ((wx[1] - sx) * (wy[2] - sy) - (wx[2] - sx) * (wy[1] - sy)) * inv2a;
        double b1 = ((wx[2] - sx) * (wy[0] - sy) - (wx[0] - sx) * (wy[2] - sy)) * inv2a;
        double b2 = 1.0 - b0 - b1;
        if (b0 < 0.0 || b1 < 0.0 || b2 < 0.0) continue;
        double z = b0 * wz[0] + b1 * wz[1] + b2 * wz[2];
        size_t idx = ((size_t) y * fb->fw + x) * R3_NS + k;
        if (!(z < fb->depth[idx])) continue;   /* GL_LESS */
        if (!shaded) {
          /* 像素中心的重心（GL 默认在像素中心求插值，覆盖与否由采样点决定） */
          double px = x + 0.5, py = y + 0.5;
          double a0 = ((wx[1] - px) * (wy[2] - py) - (wx[2] - px) * (wy[1] - py)) * inv2a;
          double a1 = ((wx[2] - px) * (wy[0] - py) - (wx[0] - px) * (wy[2] - py)) * inv2a;
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
          r3_shade(s, mat, nrm, vp, front, rgb);
          for (int i = 0; i < 3; ++i) {
            float v = rgb[i];
            if (v < 0.0f) v = 0.0f;
            if (v > 1.0f) v = 1.0f;
            frgb[i] = v;
            int q = (int) (v * 255.0f + 0.5f);
            if (i == 0) cr = (unsigned char) q;
            else if (i == 1) cg = (unsigned char) q;
            else cb = (unsigned char) q;
          }
          shaded = 1;
        }
        if (!opaque) {
          /* 透明片元只记一条，**不写深度** —— 与 GL 那边同一套（互不遮挡） */
          if (!r3fb_push_frag(fb, idx, (float) z, frgb, alpha)) return;
          continue;
        }
        fb->depth[idx] = (float) z;
        unsigned char *o = fb->col + idx * 3;
        o[0] = cr; o[1] = cg; o[2] = cb;
      }
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
    float v;
    v = (float) mat->emissive[0]; if (v < 0) v = 0; if (v > 1) v = 1;
    cr = (unsigned char) (int) (v * 255.0f + 0.5f);
    v = (float) mat->emissive[1]; if (v < 0) v = 0; if (v > 1) v = 1;
    cg = (unsigned char) (int) (v * 255.0f + 0.5f);
    v = (float) mat->emissive[2]; if (v < 0) v = 0; if (v > 1) v = 1;
    cbb = (unsigned char) (int) (v * 255.0f + 0.5f);
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
typedef struct { const char *p, *end; } r3lex;

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

static int r3_num(r3lex *L, double *out) {
  char buf[64];
  if (!r3_word(L, buf, sizeof buf)) return 0;
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
omni_str omni_r3_render(omni_str path) {
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

  r3lex L; L.p = text; L.end = text + got;
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
        && q[0] == 'm' && q[1] == 'a' && q[2] == 't' && (q[3] == ' ' || q[3] == '\t'))
      matcap++;
  mats = (r3mat *) malloc(matcap * sizeof(r3mat));
  if (!mats) { free(text); return omni_str_new((char *) "", 0); }
  /* 线段（曲线在 C 这边细分，见 r3_add_bez） */
  r3lines lns; memset(&lns, 0, sizeof lns);

  int ok = 1, ended = 0, header = 0;
  char kw[32];
  while (ok && r3_word(&L, kw, sizeof kw)) {
    if (strcmp(kw, "r3") == 0) {
      double v; if (!r3_num(&L, &v) || v != 1) { ok = 0; break; }
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
    } else if (strcmp(kw, "patch") == 0) {
      double st; double cp[48];
      if (!r3_num(&L, &st) || !r3_nums(&L, cp, 48) || nmat == 0) { ok = 0; break; }
      r3v p[16];
      for (int i = 0; i < 16; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      if (!r3_add_patch(&S, &tris, p, st != 0, mats + (nmat - 1))) { ok = 0; break; }
    } else if (strcmp(kw, "btri") == 0) {
      /* 三角面片（管子的接头）：十个控制点，编号照 bezierpatch.cc:652 那张图 */
      double st; double cp[30];
      if (!r3_num(&L, &st) || !r3_nums(&L, cp, 30) || nmat == 0) { ok = 0; break; }
      r3v p[10];
      for (int i = 0; i < 10; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
      if (!r3_add_tri3(&S, &tris, p, st != 0, mats + (nmat - 1))) { ok = 0; break; }
    } else if (strcmp(kw, "tri") == 0) {
      double v[9]; if (!r3_nums(&L, v, 9) || nmat == 0) { ok = 0; break; }
      r3v a = r3v_mk(v[0], v[1], v[2]);
      r3v b = r3v_mk(v[3], v[4], v[5]);
      r3v c = r3v_mk(v[6], v[7], v[8]);
      r3v n = r3v_cross(r3v_sub(b, a), r3v_sub(c, a));
      if (!r3tris_push(&tris, a, n, b, n, c, n, mats + (nmat - 1))) { ok = 0; break; }
    } else if (strcmp(kw, "bez") == 0) {
      /* 一段三次曲线（四个控制点）：细分照 beziercurve.cc:62 在这边做 */
      double cp[12];
      if (!r3_nums(&L, cp, 12) || nmat == 0) { ok = 0; break; }
      r3v p[4];
      for (int i = 0; i < 4; ++i) p[i] = r3v_mk(cp[3 * i], cp[3 * i + 1], cp[3 * i + 2]);
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
  if (ok && ended && header && S.fw > 0 && S.fh > 0) {
    S.res2 = S.res * S.res;
    r3_set_dimensions(&S);
    r3_projection(&S);

    size_t np = (size_t) S.fw * S.fh * R3_NS;
    r3fb fb;
    memset(&fb, 0, sizeof fb);
    fb.fw = S.fw; fb.fh = S.fh;
    fb.depth = (float *) malloc(np * sizeof(float));
    fb.col = (unsigned char *) malloc(np * 3);
    fb.head = (int *) malloc(np * sizeof(int));
    if (fb.depth && fb.col && fb.head) {
      unsigned char b0 = (unsigned char) (int) (S.bg[0] * 255.0 + 0.5);
      unsigned char b1 = (unsigned char) (int) (S.bg[1] * 255.0 + 0.5);
      unsigned char b2 = (unsigned char) (int) (S.bg[2] * 255.0 + 0.5);
      for (size_t i = 0; i < np; ++i) {
        fb.depth[i] = 1.0f;
        fb.head[i] = -1;
        fb.col[3 * i] = b0; fb.col[3 * i + 1] = b1; fb.col[3 * i + 2] = b2;
      }
      /* 两趟：先不透明（定死深度），再透明（只攒片元，不写深度）。
       * GL 那边也是分开的两个缓冲（bezierpatch.cc 的 triangleData / transparentData）。*/
      for (int pass = 0; pass < 2; ++pass) {
        for (size_t i = 0; i + 2 < tris.n; i += 3) {
          const r3mat *m = tris.mat[i / 3];
          int trans = m->diffuse[3] < 1.0;
          if (trans != pass) continue;
          r3_raster_tri(&S, &fb, tris.pos + i, tris.nrm + i, m);
        }
        if (pass == 0)
          for (size_t i = 0; i + 1 < lns.n; i += 2)
            r3_raster_line(&S, &fb, lns.p[i], lns.p[i + 1], lns.mat[i / 2]);
      }
      /* 量口：`OMNI_R3_DEBUG=1` 时把三角/线段/透明片元的条数印到 stderr。
       * 只有这一处对外说话 —— 三维那一档出问题时先看这三个数。 */
      if (getenv("OMNI_R3_DEBUG")) {
        size_t ntr = tris.n / 3, ntrans = 0;
        for (size_t i = 0; i + 2 < tris.n; i += 3)
          if (tris.mat[i / 3]->diffuse[3] < 1.0) ntrans++;
        fprintf(stderr, "r3: %dx%d 三角 %zu（透明 %zu）线段 %zu 片元 %zu\n",
                S.fw, S.fh, ntr, ntrans, lns.n / 2, fb.nfrag);
      }
      /* 透明片元按深度**由远到近** source-over 盖到不透明层上（每个采样点各自一条链） */
      if (fb.nfrag > 0) {
        for (size_t i = 0; i < np; ++i) {
          if (fb.head[i] < 0) continue;
          /* 链不长（同一采样点上的透明层数），插入排序按 d 降序 */
          int order[64]; int n = 0;
          for (int j = fb.head[i]; j >= 0 && n < 64; j = fb.frag[j].next) order[n++] = j;
          for (int a = 1; a < n; ++a) {
            int v = order[a]; int b = a - 1;
            while (b >= 0 && fb.frag[order[b]].d < fb.frag[v].d) { order[b + 1] = order[b]; b--; }
            order[b + 1] = v;
          }
          float c[3];
          for (int ch = 0; ch < 3; ++ch) c[ch] = fb.col[i * 3 + ch] / 255.0f;
          for (int a = 0; a < n; ++a) {
            const r3frag *f = fb.frag + order[a];
            const float sc[3] = { f->r, f->g, f->b };
            for (int ch = 0; ch < 3; ++ch) c[ch] = sc[ch] * f->a + c[ch] * (1.0f - f->a);
          }
          for (int ch = 0; ch < 3; ++ch) {
            float v = c[ch] < 0 ? 0 : (c[ch] > 1 ? 1 : c[ch]);
            fb.col[i * 3 + ch] = (unsigned char) (int) (v * 255.0f + 0.5f);
          }
        }
      }

      /* 解析（多重采样求平均）+ 十六进制。行序照 glReadPixels：**第 0 行在下**。 */
      size_t nb = (size_t) S.fw * S.fh * 3;
      char *hex = omni_alloc_bytes(nb * 2 + 1);
      static const char *D = "0123456789abcdef";
      size_t o = 0;
      for (int y = 0; y < S.fh; ++y) {
        for (int x = 0; x < S.fw; ++x) {
          size_t base = ((size_t) y * S.fw + x) * R3_NS;
          for (int ch = 0; ch < 3; ++ch) {
            unsigned sum = 0;
            for (int k = 0; k < R3_NS; ++k) sum += fb.col[(base + k) * 3 + ch];
            unsigned v = (sum + R3_NS / 2) / R3_NS;
            hex[o++] = D[(v >> 4) & 15];
            hex[o++] = D[v & 15];
          }
        }
      }
      hex[o] = 0;
      out = omni_str_new(hex, (int64_t) o);
    }
    free(fb.depth);
    free(fb.col);
    free(fb.head);
    free(fb.frag);
  }

  free(tris.pos); free(tris.nrm); free((void *) tris.mat);
  free(lns.p); free((void *) lns.mat);
  free(mats);
  free(text);
  return out;
}
