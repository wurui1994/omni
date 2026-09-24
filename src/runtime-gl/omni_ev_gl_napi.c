/* omni_ev_gl_napi.c —— **EVAL 两门语言的本机 GL 设备在 node 这一侧的入口**（第六刀）。
 *
 * 口径：`docs/design/eval-realtime-gpu.md` §16。一句话：**js 腿也要能走 GPU**。
 *
 * ## 为什么要这一份
 *
 * `--backend js` / `--backend interp` 是"改完立刻能跑"的两条路（没有 cc、没有链接），
 * 浏览器端走的就是编到 JS 那条路的表亲 —— 而实时那一栏要的正是这个。GPU 那一半的代码
 * **已经在 `omni_ev_gl.c` 里了**，这一份只是把它那十几格 C ABI 包成 N-API，让宿主
 * （`src/core/host/gfx-cpu.js` 里那条转发支路）能直接叫。
 *
 * ## 两个定下来的选择
 *
 * 1. **收普通 JS 数组**（uniform / 像素那几族）—— `gfx-cpu.js` 要过 `check:self` 那道门。
 *    **顶点那一族已经不这么走了**：一格 `napi_get_element` ≈ 50ns，`disco ball` 一帧
 *    12 万顶点 × 16 格 = 400 万次跨界 = 115ms/帧（2026-09-25 量的，§16.3 那句
 *    "一帧几千格顶点也在预算里"在这一份上不成立）。现在顶点写进一块 `ArrayBuffer`
 *    （`DataView.setFloat64`，小端）整块递过来 —— ArrayBuffer 与 DataView 本来就在
 *    那个子集里（ADR-0011），所以**不是在这一层绕**，递数组那一路留着当回落。
 * 2. **与 `omni_ev_gl.c` 一起编进同一份 `.node`**：那一份是纯 C、没有 node 依赖，
 *    两份一起编就不必再 dlopen 一次（少一层、少一处路径要对）。
 * 3. **N-API 的声明用我们自己那一份**（`runtime/omni_napi.h`，ADR-0038 的立场：不外挂，
 *    N-API 是稳定 ABI，照着抄一遍就行）—— 所以这一份**不依赖本机装的 node 头**。
 */

#include "../runtime/omni_napi.h"
#include <stdlib.h>
#include <string.h>

/* 那一份设备（`omni_ev_gl.c`）的 C ABI —— 与它的定义逐字相同。 */
int omni_ev_gl_open(int w, int h);
void omni_ev_gl_cls(unsigned int rgb);
void omni_ev_gl_depth(int on);
void omni_ev_gl_cull(int mode);
void omni_ev_gl_batch(int kind, long n, const double *verts);
int omni_ev_gl_read(unsigned char *out);
int omni_ev_gl_ready(void);
const char *omni_ev_gl_error(void);
void omni_ev_gl_def(const char *kind, const char *name, const char *text);
int omni_ev_gl_shader(int argc, const double *args);
double omni_ev_gl_uniloc(double idx);
int omni_ev_gl_uni(double h, int n, const double *v);
int omni_ev_gl_uni1i(double h, double v);
double omni_ev_gl_attrloc(double idx);
int omni_ev_gl_attr(double loc, const double *v);
void omni_ev_gl_prog(int on);
void omni_ev_gl_mvp(int col, double m0, double m1, double m2, double m3);
void omni_ev_gl_mv(int col, double m0, double m1, double m2, double m3);
void omni_ev_gl_blend(int mode);
int omni_ev_gl_tex(int slot, int w, int h, int d, int fmt, const double *px);
int omni_ev_gl_texfile(int slot, const char *path, int colmode);
int omni_ev_gl_univ(double h, int comps, int isint, long n, const double *v);
int omni_ev_gl_gettex(int slot, int w, int h, long cap, double *out);
int omni_ev_gl_capbegin(int siz);
int omni_ev_gl_capend(int slot);
void omni_ev_gl_bindtex(int slot);
void omni_ev_gl_activetex(int unit);

/* ── 取实参那几手 ─────────────────────────────────────────────────────────── */

#define ARGS(n) napi_value a[n]; size_t argc = n; \
  napi_get_cb_info(env, info, &argc, a, NULL, NULL)

static double num(napi_env env, napi_value v) {
  double d = 0;
  napi_get_value_double(env, v, &d);
  return d;
}

static napi_value mknum(napi_env env, double d) {
  napi_value out;
  napi_create_double(env, d, &out);
  return out;
}

/** 一格普通 JS 数组 -> 一段 double（回 NULL = 拿不到；`*n` 是格数）。调用方 free。 */
/**
 * 一格 JS 数组 -> 自己那份 double 拷贝（调用方 free）。`want < 0` = 整个数组。
 *
 * **`want` 那一格是性能命门**：顶点批那几块是**按上限开的**（`gl_ob` 是 OMAX*VS =
 * 49152 格），一趟 flush 往往只用头上几十格。整块抄的话每个 draw call 就是四万多次
 * `napi_get_element` —— `tigrou/tree.pss` 一帧 64×64 要 72 秒，而参考只要 0.39 秒
 * （量过，186 倍）。只抄用得着的那一段之后才谈得上实时。
 */
static double *arrN(napi_env env, napi_value v, long want, long *n) {
  uint32_t len = 0;
  if (napi_get_array_length(env, v, &len) != omni_napi_ok) { *n = 0; return NULL; }
  long cnt = (long)len;
  if (want >= 0 && want < cnt) cnt = want;
  double *buf = (double *)malloc(sizeof(double) * (size_t)(cnt == 0 ? 1 : cnt));
  if (buf == NULL) { *n = 0; return NULL; }
  for (long i = 0; i < cnt; i++) {
    napi_value e;
    if (napi_get_element(env, v, (uint32_t)i, &e) != omni_napi_ok) { buf[i] = 0; continue; }
    buf[i] = num(env, e);
  }
  *n = cnt;
  return buf;
}

static double *arr(napi_env env, napi_value v, long *n) { return arrN(env, v, -1, n); }

/** 一格 JS 串 -> 自己那份拷贝（调用方 free）。 */
static char *str(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != omni_napi_ok) return NULL;
  char *s = (char *)malloc(len + 1);
  if (s == NULL) return NULL;
  napi_get_value_string_utf8(env, v, s, len + 1, &len);
  return s;
}

/* ── 那十几格包装（名字与 `omni_ev_gl_*` 一一对应）──────────────────────────── */

static napi_value jsOpen(napi_env env, napi_callback_info info) {
  ARGS(2);
  return mknum(env, omni_ev_gl_open((int)num(env, a[0]), (int)num(env, a[1])));
}

static napi_value jsCls(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_cls((unsigned int)(long long)num(env, a[0]));
  return mknum(env, 0);
}

static napi_value jsDepth(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_depth((int)num(env, a[0]) != 0);
  return mknum(env, 0);
}

static napi_value jsCull(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_cull((int)num(env, a[0]));
  return mknum(env, 0);
}

/** `batch(类, 顶点数, 顶点)` —— 一格顶点 16 个 double（位置/颜色/纹理坐标/法向，§18.3）。
 *
 * **顶点整块过来**（2026-09-25）：宿主那一侧（`host/gfx-cpu.js`）把这一段写进一块
 * `ArrayBuffer`（小端的 double），这儿一次拿指针，**一格都不抄** —— 先前一格一格取，
 * `disco ball` 一帧 400 万次跨界、115ms。递数组那一路留着当回落。 */
static napi_value jsBatch(napi_env env, napi_callback_info info) {
  ARGS(3);
  long cnt = (long)num(env, a[1]);
  if (cnt <= 0) return mknum(env, 0);
  bool isab = false;
  if (napi_is_arraybuffer(env, a[2], &isab) == omni_napi_ok && isab) {
    void *data = NULL;
    size_t nb = 0;
    if (napi_get_arraybuffer_info(env, a[2], &data, &nb) != omni_napi_ok || data == NULL) {
      return mknum(env, 1);
    }
    long have = (long)(nb / sizeof(double));
    if (cnt * 16 > have) cnt = have / 16;
    if (cnt <= 0) return mknum(env, 0);
    omni_ev_gl_batch((int)num(env, a[0]), cnt, (const double *)data);
    return mknum(env, 0);
  }
  /* 只抄这一批用得着的那一段。 */
  long n = 0;
  double *v = arrN(env, a[2], cnt * 16, &n);
  if (v == NULL) return mknum(env, 1);
  if (cnt * 16 > n) cnt = n / 16;
  omni_ev_gl_batch((int)num(env, a[0]), cnt, v);
  free(v);
  return mknum(env, 0);
}

/**
 * `readInto(out[])` —— 把这一帧读回来，一格一个**打包好的 0xRRGGBB**（不是四个分量）：
 * 宿主那一侧的帧缓冲就是这个形状（`gfx-cpu.js` 的 `D.fb`），于是合成那一步不用再转一遍。
 * 回 0 = 成了。
 */
static napi_value jsReadInto(napi_env env, napi_callback_info info) {
  ARGS(1);
  uint32_t len = 0;
  if (napi_get_array_length(env, a[0], &len) != omni_napi_ok || len == 0) return mknum(env, 1);
  unsigned char *px = (unsigned char *)malloc((size_t)len * 4);
  if (px == NULL) return mknum(env, 1);
  if (omni_ev_gl_read(px) != 0) { free(px); return mknum(env, 1); }
  for (uint32_t i = 0; i < len; i++) {
    unsigned int c = ((unsigned int)px[i * 4] << 16) | ((unsigned int)px[i * 4 + 1] << 8)
      | (unsigned int)px[i * 4 + 2];
    napi_value e;
    napi_create_double(env, (double)c, &e);
    napi_set_element(env, a[0], i, e);
  }
  free(px);
  return mknum(env, 0);
}

static napi_value jsDef(napi_env env, napi_callback_info info) {
  ARGS(3);
  char *k = str(env, a[0]);
  char *n = str(env, a[1]);
  char *t = str(env, a[2]);
  if (k != NULL && n != NULL && t != NULL) omni_ev_gl_def(k, n, t);
  free(k);
  free(n);
  free(t);
  return mknum(env, 0);
}

static napi_value jsShader(napi_env env, napi_callback_info info) {
  ARGS(1);
  long n = 0;
  double *v = arr(env, a[0], &n);
  if (v == NULL) return mknum(env, 1);
  int r = omni_ev_gl_shader((int)n, v);
  free(v);
  return mknum(env, r);
}

/** `texfile(槽, "路径", colmode)` —— 文件纹理（§20）。 */
static napi_value jsTexfile(napi_env env, napi_callback_info info) {
  ARGS(3);
  char *p = str(env, a[1]);
  if (p == NULL) return mknum(env, 1);
  int r = omni_ev_gl_texfile((int)num(env, a[0]), p, (int)num(env, a[2]));
  free(p);
  return mknum(env, r);
}

/**
 * `univ(句柄, 分量数, 是整数, 格数, 值[])` —— `gluniform{1..4}{f,i}v`（§19.1）。
 *
 * **只抄用得着的那一段**（`格数 × 分量数`）：那几格数组是按上限开的（`gpgpu` 那一份
 * 是 XT*YT），整块抄就是每帧几万次 `napi_get_element` —— 与 `jsBatch` 同一条道理。
 */
static napi_value jsUniv(napi_env env, napi_callback_info info) {
  ARGS(5);
  int comps = (int)num(env, a[1]);
  if (comps < 1 || comps > 4) return mknum(env, 1);
  long want = (long)num(env, a[3]) * (long)comps;
  long n = 0;
  double *v = arrN(env, a[4], want, &n);
  if (v == NULL) return mknum(env, 1);
  int r = omni_ev_gl_univ(num(env, a[0]), comps, (int)num(env, a[2]) != 0, n / comps, v);
  free(v);
  return mknum(env, r);
}

/**
 * `gettex(槽, w, h, 数组)` —— 把纹理读回来（§19.1）。
 *
 * 与 `readInto` 一样是**写回 JS 数组**那条路：一格一个 `napi_set_element`。
 * **写回几格由设备说**（回值）：一像素几个 double 只有它知道（那一槽自己的格）。
 */
static napi_value jsGettex(napi_env env, napi_callback_info info) {
  ARGS(4);
  int slot = (int)num(env, a[0]);
  int w = (int)num(env, a[1]);
  int h = (int)num(env, a[2]);
  uint32_t cap = 0;
  if (napi_get_array_length(env, a[3], &cap) != omni_napi_ok) return mknum(env, -1);
  if (w <= 0 || h <= 0 || cap == 0) return mknum(env, -1);
  double *out = (double *)malloc(sizeof(double) * (size_t)cap);
  if (out == NULL) return mknum(env, -1);
  int got = omni_ev_gl_gettex(slot, w, h, (long)cap, out);
  if (got > 0) {
    for (long i = 0; i < (long)got; i++) {
      napi_value e;
      napi_create_double(env, out[i], &e);
      napi_set_element(env, a[3], (uint32_t)i, e);
    }
  }
  free(out);
  return mknum(env, got < 0 ? -1 : 0);
}

static napi_value jsUniloc(napi_env env, napi_callback_info info) {
  ARGS(1);
  return mknum(env, omni_ev_gl_uniloc(num(env, a[0])));
}

static napi_value jsUni(napi_env env, napi_callback_info info) {
  ARGS(3);
  long n = 0;
  double *v = arr(env, a[2], &n);
  if (v == NULL) return mknum(env, 1);
  int r = omni_ev_gl_uni(num(env, a[0]), (int)num(env, a[1]), v);
  free(v);
  return mknum(env, r);
}

static napi_value jsUni1i(napi_env env, napi_callback_info info) {
  ARGS(2);
  return mknum(env, omni_ev_gl_uni1i(num(env, a[0]), num(env, a[1])));
}

static napi_value jsAttrloc(napi_env env, napi_callback_info info) {
  ARGS(1);
  return mknum(env, omni_ev_gl_attrloc(num(env, a[0])));
}

static napi_value jsAttr(napi_env env, napi_callback_info info) {
  ARGS(2);
  long n = 0;
  double *v = arr(env, a[1], &n);
  if (v == NULL || n < 4) { free(v); return mknum(env, 1); }
  int r = omni_ev_gl_attr(num(env, a[0]), v);
  free(v);
  return mknum(env, r);
}

static napi_value jsProg(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_prog((int)num(env, a[0]) != 0);
  return mknum(env, 0);
}

static napi_value jsMvp(napi_env env, napi_callback_info info) {
  ARGS(5);
  omni_ev_gl_mvp((int)num(env, a[0]), num(env, a[1]), num(env, a[2]), num(env, a[3]),
                 num(env, a[4]));
  return mknum(env, 0);
}

/**
 * `mat(哪张, ArrayBuffer)` —— **一整张矩阵一次过来**（16 个小端 double，列主序）。
 * 哪张：0 = `u_mvp`、1 = `u_mv`。摆下去的次序与四句 `mvp`/`mv` 逐字相同。
 *
 * 为什么要它：一段批要发两张矩阵，走 `mvp`/`mv` 是 **8 次**跨界；`disco ball` 一帧
 * 3994 段批 ⇒ 32k 次，量出来 ~24ms/帧（2026-09-25）。顶点那一族已经走整块字节了
 * （见 `jsBatch`），矩阵跟着走同一条路。
 */
static napi_value jsMat(napi_env env, napi_callback_info info) {
  ARGS(2);
  bool isab = false;
  if (napi_is_arraybuffer(env, a[1], &isab) != omni_napi_ok || !isab) return mknum(env, 1);
  void *data = NULL;
  size_t nb = 0;
  if (napi_get_arraybuffer_info(env, a[1], &data, &nb) != omni_napi_ok || data == NULL) {
    return mknum(env, 1);
  }
  if (nb < 16 * sizeof(double)) return mknum(env, 1);
  const double *m = (const double *)data;
  int which = (int)num(env, a[0]);
  for (int c = 0; c < 4; c++) {
    if (which == 0) omni_ev_gl_mvp(c, m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]);
    else omni_ev_gl_mv(c, m[c * 4], m[c * 4 + 1], m[c * 4 + 2], m[c * 4 + 3]);
  }
  return mknum(env, 0);
}

static napi_value jsMv(napi_env env, napi_callback_info info) {
  ARGS(5);
  omni_ev_gl_mv((int)num(env, a[0]), num(env, a[1]), num(env, a[2]), num(env, a[3]),
                num(env, a[4]));
  return mknum(env, 0);
}

static napi_value jsBlend(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_blend((int)num(env, a[0]));
  return mknum(env, 0);
}

static napi_value jsTex(napi_env env, napi_callback_info info) {
  ARGS(6);
  long n = 0;
  double *px = arr(env, a[5], &n);
  if (px == NULL) return mknum(env, 1);
  int r = omni_ev_gl_tex((int)num(env, a[0]), (int)num(env, a[1]), (int)num(env, a[2]),
                         (int)num(env, a[3]), (int)num(env, a[4]), px);
  free(px);
  return mknum(env, r);
}

/** `capbegin(边长)` / `capend(槽)` —— 抓屏那一族（§22）。 */
static napi_value jsCapbegin(napi_env env, napi_callback_info info) {
  ARGS(1);
  return mknum(env, omni_ev_gl_capbegin((int)num(env, a[0])));
}

static napi_value jsCapend(napi_env env, napi_callback_info info) {
  ARGS(1);
  return mknum(env, omni_ev_gl_capend((int)num(env, a[0])));
}

static napi_value jsBindtex(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_bindtex((int)num(env, a[0]));
  return mknum(env, 0);
}

static napi_value jsActivetex(napi_env env, napi_callback_info info) {
  ARGS(1);
  omni_ev_gl_activetex((int)num(env, a[0]));
  return mknum(env, 0);
}

static napi_value jsError(napi_env env, napi_callback_info info) {
  (void)info;
  const char *s = omni_ev_gl_error();
  napi_value out;
  napi_create_string_utf8(env, s == NULL ? "" : s, (size_t)-1, &out);
  return out;
}

static napi_value jsReady(napi_env env, napi_callback_info info) {
  (void)info;
  return mknum(env, omni_ev_gl_ready());
}

#define PUT(name, fn) do { \
  napi_value f; \
  napi_create_function(env, name, (size_t)-1, fn, NULL, &f); \
  napi_set_named_property(env, exports, name, f); \
} while (0)

/* node 按这个名字找入口（`omni_napi.h` 头注那两条约定之一）。 */
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  PUT("open", jsOpen);
  PUT("cls", jsCls);
  PUT("depth", jsDepth);
  PUT("cull", jsCull);
  PUT("batch", jsBatch);
  PUT("readInto", jsReadInto);
  PUT("def", jsDef);
  PUT("shader", jsShader);
  PUT("uniloc", jsUniloc);
  PUT("uni", jsUni);
  PUT("uni1i", jsUni1i);
  PUT("attrloc", jsAttrloc);
  PUT("attr", jsAttr);
  PUT("prog", jsProg);
  PUT("mvp", jsMvp);
  PUT("mv", jsMv);
  PUT("mat", jsMat);
  PUT("blend", jsBlend);
  PUT("tex", jsTex);
  PUT("texfile", jsTexfile);
  PUT("univ", jsUniv);
  PUT("gettex", jsGettex);
  PUT("capbegin", jsCapbegin);
  PUT("capend", jsCapend);
  PUT("bindtex", jsBindtex);
  PUT("activetex", jsActivetex);
  PUT("error", jsError);
  PUT("ready", jsReady);
  return exports;
}

