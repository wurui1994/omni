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
  if ((h < s->res2 && v < s->res2) || depth >= 12) {
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

/* 一片面片进表：先算 epsilon（bezierpatch.cc:70）与四角法向，再递归 */
static int r3_add_patch(r3scene *s, r3tris *t, const r3v *p, int straight,
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
 * 每像素 4 个采样点（GL 的 4x 多重采样，标准点位），逐采样 Z-buffer + 逐采样颜色，
 * 最后按 4 个采样平均 —— 这正是 glrender.cc:819 常开的 GL_MULTISAMPLE 干的事。
 * 采样点相对像素**左下角**（GL 的窗口坐标 y 向上）。 */
#define R3_NS 4
static const float R3_SAMPLE[R3_NS][2] = {
  { 0.375f, 0.125f }, { 0.875f, 0.375f }, { 0.125f, 0.625f }, { 0.625f, 0.875f }
};

typedef struct {
  int fw, fh;
  float *depth;          /* fw*fh*R3_NS，初值 1（远） */
  unsigned char *col;    /* fw*fh*R3_NS*3 */
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

  for (int y = y0; y < y1; ++y) {
    for (int x = x0; x < x1; ++x) {
      int shaded = 0;
      unsigned char cr = 0, cg = 0, cb = 0;
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
            int q = (int) (v * 255.0f + 0.5f);
            if (i == 0) cr = (unsigned char) q;
            else if (i == 1) cg = (unsigned char) q;
            else cb = (unsigned char) q;
          }
          shaded = 1;
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
  /* 材质表：清单里每条 mat 存一格，后面的图元指到最近那一格 */
  r3mat *mats = NULL;
  size_t nmat = 0, matcap = 0;
  /* 线段先攒起来（要等投影矩阵定了才画） */
  r3v *lines = NULL;
  size_t nline = 0, linecap = 0;
  const r3mat **linemat = NULL;

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
    } else if (strcmp(kw, "light") == 0) {
      double v[6]; if (!r3_nums(&L, v, 6)) { ok = 0; break; }
      if (S.nlight < R3_MAXLIGHT) {
        S.ldir[S.nlight] = r3v_mk(v[0], v[1], v[2]);
        S.lcol[S.nlight][0] = v[3]; S.lcol[S.nlight][1] = v[4]; S.lcol[S.nlight][2] = v[5];
        S.nlight++;
      }
    } else if (strcmp(kw, "mat") == 0) {
      double v[14]; if (!r3_nums(&L, v, 14)) { ok = 0; break; }
      if (nmat + 1 > matcap) {
        size_t cap = matcap == 0 ? 32 : matcap * 2;
        r3mat *nm = (r3mat *) realloc(mats, cap * sizeof(r3mat));
        if (!nm) { ok = 0; break; }
        mats = nm; matcap = cap;
      }
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
    } else if (strcmp(kw, "tri") == 0) {
      double v[9]; if (!r3_nums(&L, v, 9) || nmat == 0) { ok = 0; break; }
      r3v a = r3v_mk(v[0], v[1], v[2]);
      r3v b = r3v_mk(v[3], v[4], v[5]);
      r3v c = r3v_mk(v[6], v[7], v[8]);
      r3v n = r3v_cross(r3v_sub(b, a), r3v_sub(c, a));
      if (!r3tris_push(&tris, a, n, b, n, c, n, mats + (nmat - 1))) { ok = 0; break; }
    } else if (strcmp(kw, "line") == 0) {
      double cnt; if (!r3_num(&L, &cnt) || nmat == 0) { ok = 0; break; }
      int n = (int) cnt;
      if (n < 2) { ok = 0; break; }
      for (int i = 0; i + 1 < n; ++i) { /* 攒 n-1 段 */ }
      r3v prev = r3v_mk(0, 0, 0);
      for (int i = 0; i < n; ++i) {
        double v[3]; if (!r3_nums(&L, v, 3)) { ok = 0; break; }
        r3v q = r3v_mk(v[0], v[1], v[2]);
        if (i > 0) {
          if (nline + 2 > linecap) {
            size_t cap = linecap == 0 ? 256 : linecap * 2;
            r3v *nl = (r3v *) realloc(lines, cap * sizeof(r3v));
            if (!nl) { ok = 0; break; }
            lines = nl;
            const r3mat **lm = (const r3mat **) realloc(linemat, (cap / 2 + 1) * sizeof(const r3mat *));
            if (!lm) { ok = 0; break; }
            linemat = lm; linecap = cap;
          }
          linemat[nline / 2] = mats + (nmat - 1);
          lines[nline++] = prev;
          lines[nline++] = q;
        }
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
    fb.fw = S.fw; fb.fh = S.fh;
    fb.depth = (float *) malloc(np * sizeof(float));
    fb.col = (unsigned char *) malloc(np * 3);
    if (fb.depth && fb.col) {
      unsigned char b0 = (unsigned char) (int) (S.bg[0] * 255.0 + 0.5);
      unsigned char b1 = (unsigned char) (int) (S.bg[1] * 255.0 + 0.5);
      unsigned char b2 = (unsigned char) (int) (S.bg[2] * 255.0 + 0.5);
      for (size_t i = 0; i < np; ++i) {
        fb.depth[i] = 1.0f;
        fb.col[3 * i] = b0; fb.col[3 * i + 1] = b1; fb.col[3 * i + 2] = b2;
      }
      for (size_t i = 0; i + 2 < tris.n; i += 3)
        r3_raster_tri(&S, &fb, tris.pos + i, tris.nrm + i, tris.mat[i / 3]);
      for (size_t i = 0; i + 1 < nline; i += 2)
        r3_raster_line(&S, &fb, lines[i], lines[i + 1], linemat[i / 2]);

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
  }

  free(tris.pos); free(tris.nrm); free((void *) tris.mat);
  free(lines); free((void *) linemat);
  free(mats);
  free(text);
  return out;
}
