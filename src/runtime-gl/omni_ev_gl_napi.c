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
 * 1. **收普通 JS 数组，不收 typed array**：`gfx-cpu.js` 要过 `check:self` 那道门，
 *    而 typed array 还不在那个子集里。代价量过（§16.3）：一格 `napi_get_element` ≈ 50ns，
 *    一帧几千格顶点也在 16.7ms 的预算里。真不够的时候是**把 typed array 扩进子集**，
 *    不是在这一层绕。
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
void omni_ev_gl_batch(int kind, long n, const double *verts);
int omni_ev_gl_read(unsigned char *out);
int omni_ev_gl_ready(void);
const char *omni_ev_gl_error(void);
void omni_ev_gl_def(const char *kind, const char *name, const char *text);
int omni_ev_gl_shader(int argc, const double *args);
double omni_ev_gl_uniloc(double idx);
int omni_ev_gl_uni(double h, int n, const double *v);
double omni_ev_gl_attrloc(double idx);
int omni_ev_gl_attr(double loc, const double *v);
void omni_ev_gl_prog(int on);
void omni_ev_gl_mvp(int col, double m0, double m1, double m2, double m3);
void omni_ev_gl_blend(int mode);
int omni_ev_gl_tex(int slot, int w, int h, int d, int fmt, const double *px);
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
static double *arr(napi_env env, napi_value v, long *n) {
  uint32_t len = 0;
  if (napi_get_array_length(env, v, &len) != omni_napi_ok) { *n = 0; return NULL; }
  double *buf = (double *)malloc(sizeof(double) * (len == 0 ? 1 : len));
  if (buf == NULL) { *n = 0; return NULL; }
  for (uint32_t i = 0; i < len; i++) {
    napi_value e;
    if (napi_get_element(env, v, i, &e) != omni_napi_ok) { buf[i] = 0; continue; }
    buf[i] = num(env, e);
  }
  *n = (long)len;
  return buf;
}

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

/** `batch(类, 顶点数, 顶点[])` —— 一格顶点 12 个数（位置 4 / 颜色 4 / 纹理坐标 4）。 */
static napi_value jsBatch(napi_env env, napi_callback_info info) {
  ARGS(3);
  long n = 0;
  double *v = arr(env, a[2], &n);
  if (v == NULL) return mknum(env, 1);
  long cnt = (long)num(env, a[1]);
  if (cnt * 12 > n) cnt = n / 12;
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
  PUT("batch", jsBatch);
  PUT("readInto", jsReadInto);
  PUT("def", jsDef);
  PUT("shader", jsShader);
  PUT("uniloc", jsUniloc);
  PUT("uni", jsUni);
  PUT("attrloc", jsAttrloc);
  PUT("attr", jsAttr);
  PUT("prog", jsProg);
  PUT("mvp", jsMvp);
  PUT("blend", jsBlend);
  PUT("tex", jsTex);
  PUT("bindtex", jsBindtex);
  PUT("activetex", jsActivetex);
  PUT("error", jsError);
  PUT("ready", jsReady);
  return exports;
}

