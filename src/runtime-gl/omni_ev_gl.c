/* omni_ev_gl.c —— **EVAL 两门语言（`.pss` / `.kc`）的本机 OpenGL 设备**（第五刀）。
 *
 * 口径与刀法：`docs/design/eval-realtime-gpu.md` 第 13 节。一句话：**命令行那一档的 GPU**。
 * 浏览器那一档（`src/studio/gfx-gl.js`，WebGL2）早就通了；CPU 备选（`src/runtime/omni_fmt.c`
 * 里那一摊 + `src/core/host/gfx-cpu.js`）画得了几何、画不了着色器 —— 那 22 份 `.pss`
 * 就是整幅图本身都在片元着色器里。这一份补的是那一格。
 *
 * ## 为什么与 `omni_r3_gl.c` 分开、又编进同一份 dylib
 *
 * 那一份是 asy 三维那一档的后端（照 asymptote 的 glrender.cc 抄）；这一份是 EVAL 的设备。
 * 两者**没有共用的语义**，但共用同一套"顺手编一下、拿不到就回落"的挂载机制
 * （`cli.js` 的 `glPlugin()` + `-framework OpenGL`），所以同一份 `libomnigl.dylib` 里两组符号。
 *
 * ## 三个定下来的选择（写在这儿免得以后再猜）
 *
 * 1. **上下文用 CGL 的 core profile**（`kCGLOGLPVersion_3_2_Core`，Apple Silicon 上给到
 *    4.1 core），**不许用 legacy 2.1**。这是 2026-09-24 用户定的口径：
 *    **必须与 WebGL 对齐，不允许存在两种模型**。
 *    连带的一条：脚本里那些旧式 GLSL（`attribute`/`varying`/`gl_FragColor`/`ftransform()`）
 *    **不是在这一层翻**，而是在**编译期**（adapter 那一侧、`(gfxdef …)` 发出去之前）翻成
 *    对齐后的 GLSL —— 于是 WebGL2 与本机这两档设备收到的是**同一份文本**，只差 `#version`
 *    那一行（浏览器补 `300 es`、这一档补 `410 core`）。翻两遍就是两份实现，所以不许。
 *    曾经试过 legacy（驱动直接认旧式、省掉翻译）—— **被否**：那等于本机这一档自己一套语义。
 * 2. **离屏 FBO + `glReadPixels`**：命令行那一档要的是一帧 PNG，不是窗口。
 *    所以不碰 NSApp、不要主线程（`omni_r3_gl.c` 的头注里记着 GLFW 在大栈线程上 SIGTRAP 那一课）。
 * 3. **顶点契约与别的两档设备同一格**：一格顶点 12 个 double（位置 4 裁剪空间 /
 *    颜色 4 是 0..1 / 纹理坐标 4），批的类 0 线段 / 1 三角 / 2 点。
 *    变换、拆 mode、合批全在**语言那一侧**（`ext/polydraw/gl-rt.js`）——
 *    这一层只管"上传 + 一次 draw"。**不许**在这儿出现立即模式或第二份变换。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GL_SILENCE_DEPRECATION 1
#include <OpenGL/OpenGL.h>
/* core profile ⇒ `gl3.h`（3.2+ 的那套符号，没有被弃用的那一半）。 */
#include <OpenGL/gl3.h>

/* 出错把话留在这儿，宿主用 `omni_ev_gl_error()` 取（插件不自己往 stderr 喷 ——
   那会把判据那一侧的 stdout/stderr 弄脏）。 */
static char g_err[512];
static void ev_err(const char *fmt, const char *a) {
  if (a == NULL) snprintf(g_err, sizeof(g_err), "%s", fmt);
  else snprintf(g_err, sizeof(g_err), fmt, a);
}
const char *omni_ev_gl_error(void) { return g_err; }

/* ── 设备状态 ────────────────────────────────────────────────────────── */

static CGLContextObj g_ctx;
static GLuint g_fbo, g_color, g_depth, g_vao;
static GLuint g_vbo;
static GLuint g_prog;            /* 内建那对着色器（位置已是裁剪空间） */
static int g_w, g_h;
static int g_on;
static int g_depth_test;

/**
 * 内建那对着色器。**与 `src/studio/gfx-gl.js` 里 WebGL2 那一档逐句对应** ——
 * 差的只有 `#version` 那一行（那边 `300 es` + precision，这边 `410 core`）与属性名之外
 * 一个字都不一样：`a_pos` 已经是**裁剪空间**、颜色与纹理坐标往下传、`u_mvp` 由设备喂。
 */
static const char *VS_SRC =
  "#version 410 core\n"
  "in vec4 a_pos;\n"
  "in vec4 a_col;\n"
  "in vec4 a_tex;\n"
  "out vec4 v_col0;\n"
  "out vec4 v_tex0;\n"
  "uniform mat4 u_mvp;\n"
  "void main() { v_col0 = a_col; v_tex0 = a_tex; gl_Position = u_mvp * a_pos; }\n";

static const char *FS_SRC =
  "#version 410 core\n"
  "in vec4 v_col0;\n"
  "out vec4 o_col;\n"
  "void main() { o_col = v_col0; }\n";

static GLuint ev_compile(GLenum kind, const char *src) {
  GLuint s = glCreateShader(kind);
  glShaderSource(s, 1, &src, NULL);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512];
    GLsizei n = 0;
    glGetShaderInfoLog(s, sizeof(log) - 1, &n, log);
    log[n] = 0;
    ev_err("内建着色器编不过：%s", log);
    return 0;
  }
  return s;
}

/**
 * 开设备：CGL legacy 上下文 + 一格 RGBA8/DEPTH24 的 FBO + 一格 VBO + 内建那对着色器。
 * 回 0 = 成了；非 0 = 这台机器上没有这条腿（话在 `omni_ev_gl_error()` 里）。
 */
int omni_ev_gl_open(int w, int h) {
  if (g_on) return 0;
  if (w <= 0 || h <= 0) { ev_err("尺寸要是正数", NULL); return 1; }
  CGLPixelFormatAttribute attrs[] = {
    kCGLPFAAccelerated,
    /* **core profile**（见头注第 1 条）：Apple Silicon 上这一格给到 4.1 core。 */
    kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
    kCGLPFAColorSize, (CGLPixelFormatAttribute)24,
    kCGLPFADepthSize, (CGLPixelFormatAttribute)24,
    (CGLPixelFormatAttribute)0,
  };
  CGLPixelFormatObj pix = NULL;
  GLint npix = 0;
  if (CGLChoosePixelFormat(attrs, &pix, &npix) != kCGLNoError || pix == NULL) {
    ev_err("CGLChoosePixelFormat 失败（这台机器上没有可用的 GL）", NULL);
    return 1;
  }
  if (CGLCreateContext(pix, NULL, &g_ctx) != kCGLNoError) {
    CGLDestroyPixelFormat(pix);
    ev_err("CGLCreateContext 失败", NULL);
    return 1;
  }
  CGLDestroyPixelFormat(pix);
  CGLSetCurrentContext(g_ctx);

  /* core profile 里画之前**必须绑一格 VAO**（没有默认 VAO —— 不绑就是 INVALID_OPERATION，
     画面全黑而且一行错都没有：踩过）。 */
  glGenVertexArrays(1, &g_vao);
  glBindVertexArray(g_vao);
  glGenFramebuffers(1, &g_fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  glGenTextures(1, &g_color);
  glBindTexture(GL_TEXTURE_2D, g_color);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_color, 0);
  glGenRenderbuffers(1, &g_depth);
  glBindRenderbuffer(GL_RENDERBUFFER, g_depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, w, h);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, g_depth);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
    ev_err("FBO 不完整", NULL);
    return 1;
  }

  GLuint vs = ev_compile(GL_VERTEX_SHADER, VS_SRC);
  GLuint fs = ev_compile(GL_FRAGMENT_SHADER, FS_SRC);
  if (vs == 0 || fs == 0) return 1;
  g_prog = glCreateProgram();
  glAttachShader(g_prog, vs);
  glAttachShader(g_prog, fs);
  glLinkProgram(g_prog);
  GLint ok = 0;
  glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
  if (!ok) { ev_err("内建 program 链不上", NULL); return 1; }

  glGenBuffers(1, &g_vbo);
  glViewport(0, 0, w, h);
  glDisable(GL_DEPTH_TEST);
  glClearColor(0, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  g_w = w;
  g_h = h;
  g_on = 1;
  g_depth_test = 0;
  return 0;
}

/** 清屏（打包好的 `0xRRGGBB`）。 */
void omni_ev_gl_cls(unsigned int rgb) {
  if (!g_on) return;
  CGLSetCurrentContext(g_ctx);
  glClearColor((double)((rgb >> 16) & 255) / 255.0, (double)((rgb >> 8) & 255) / 255.0,
               (double)(rgb & 255) / 255.0, 1.0);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

/** 深度测试（语言那一侧的 `gldepth` 转过来的 —— GPU 的 z 缓冲只有设备做得到）。 */
void omni_ev_gl_depth(int on) {
  if (!g_on) return;
  g_depth_test = on ? 1 : 0;
}

/**
 * **收一段顶点批**：一格顶点 12 个 double（位置 4 裁剪空间 / 颜色 4 / 纹理坐标 4），
 * 类 0 线段 / 1 三角 / 2 点。这一层只做"转 float + 上传 + 一次 draw"。
 *
 * 点那一档用 `GL_POINTS` + `glPointSize(1)`（legacy 上下文里它是可靠的 ——
 * WebGL 那一档不可靠，所以那边把点摊成 1×1 四边形；两档设备的"一个点多大"都是 1 像素）。
 */
void omni_ev_gl_batch(int kind, long n, const double *verts) {
  if (!g_on || n <= 0 || verts == NULL) return;
  CGLSetCurrentContext(g_ctx);
  float *buf = (float *)malloc(sizeof(float) * 12 * (size_t)n);
  if (buf == NULL) return;
  for (long i = 0; i < n * 12; i++) buf[i] = (float)verts[i];

  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  glBindVertexArray(g_vao);
  glViewport(0, 0, g_w, g_h);
  if (g_depth_test) glEnable(GL_DEPTH_TEST);
  else glDisable(GL_DEPTH_TEST);
  glUseProgram(g_prog);
  /* 内建那一档的位置已经是裁剪空间 ⇒ `u_mvp` 是单位矩阵。 */
  static const float I4[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
  GLint mvp = glGetUniformLocation(g_prog, "u_mvp");
  if (mvp >= 0) glUniformMatrix4fv(mvp, 1, GL_FALSE, I4);

  glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(sizeof(float) * 12 * (size_t)n), buf,
               GL_STREAM_DRAW);
  const char *names[3] = { "a_pos", "a_col", "a_tex" };
  GLint locs[3];
  for (int k = 0; k < 3; k++) {
    locs[k] = glGetAttribLocation(g_prog, names[k]);
    if (locs[k] < 0) continue;
    glEnableVertexAttribArray((GLuint)locs[k]);
    glVertexAttribPointer((GLuint)locs[k], 4, GL_FLOAT, GL_FALSE,
                          (GLsizei)(sizeof(float) * 12),
                          (const void *)(size_t)(sizeof(float) * 4 * (size_t)k));
  }
  GLenum mode = kind == 0 ? GL_LINES : (kind == 2 ? GL_POINTS : GL_TRIANGLES);
  glDrawArrays(mode, 0, (GLsizei)n);
  for (int k = 0; k < 3; k++) if (locs[k] >= 0) glDisableVertexAttribArray((GLuint)locs[k]);
  free(buf);
}

/**
 * 把这一帧读回来（`out` 要 `w*h*4` 字节，RGBA）。
 * `glReadPixels` 给的是**下上翻**的，这儿翻正 —— 与 WebGL2 那一档的 `snapshot()` 同一手。
 * 回 0 = 成了。
 */
int omni_ev_gl_read(unsigned char *out) {
  if (!g_on || out == NULL) return 1;
  CGLSetCurrentContext(g_ctx);
  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  glFinish();
  size_t row = (size_t)g_w * 4;
  unsigned char *raw = (unsigned char *)malloc(row * (size_t)g_h);
  if (raw == NULL) return 1;
  glReadPixels(0, 0, g_w, g_h, GL_RGBA, GL_UNSIGNED_BYTE, raw);
  for (int y = 0; y < g_h; y++) {
    memcpy(out + (size_t)y * row, raw + (size_t)(g_h - 1 - y) * row, row);
  }
  free(raw);
  return 0;
}

/** 这台设备开着没有（宿主用它决定回落 CPU 备选）。 */
int omni_ev_gl_ready(void) { return g_on; }
