/* omni_r3_gl.c —— 三维那一档的 **OpenGL 后端**（主路；`src/runtime/omni_r3.c` 是没有 GPU
 * 时的备选）。照 reference/asymptote-3.14 的 `glrender.cc` + `shaders.cc` 抄，
 * 目标是与 `asy -novulkan` 的输出逐字节相同。
 *
 * **为什么单独一个文件、还编成 dylib 用 dlopen 挂**：
 *   - `src/core/cli.js:1934` 的 `runtimeObjects()` 把 src/runtime 下所有 .c 全部按同一套
 *     `ccFlags(cc)` 编成 `.o`，而 tcc 也是那套腿之一（二进制对齐的尺子是 tcc）。
 *     GLFW/OpenGL 那些 `-I`/`-framework` 塞进去会把 tcc 那条腿带坏。
 *   - asy 自己也是这么分的：`libasyopengl.so` / `libasyvulkan.so` 都是运行期 dlopen 的插件
 *     （`rendererloader.cc`），拿不到就回落。
 *   所以本文件**不在** `src/runtime/` 下，由 cli 单独编，主体运行时对 GL 零依赖。
 *
 * 本机（Apple M1 + macOS）已经量到的事实，写代码时不要再猜：
 *   - `asy -novulkan -vvv` 自报 `GLSL version 4.10 (GLSLversion=410)`；
 *     `GLSLversion = (int)(100*atof(glGetString(GL_SHADING_LANGUAGE_VERSION))+0.5)`
 *     （glrender.cc:1305）—— **不要写死 410**，按驱动报的算。
 *   - `#version` 之后 macOS 上**一条 `#extension` 都不发**（shaders.cc:101 的 `#ifndef __APPLE__`），
 *     紧接着按 `shaderParams` 的顺序发 `#define`，然后原文附上 shader 文件。
 *     `vertex.glsl` 里 `layout(binding=0) uniform` 在 `#version 410` 下 Apple 的编译器容忍，
 *     所以**不需要 shader 适配层**。
 *   - `No SSBO support` → 次序无关透明不可用，透明走
 *     `glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)`（glrender.cc:290）。
 *     `omni_r3.c` 里照 `blend.glsl` 抄的逐像素 OIT 链是 SSBO 那一路的语义，**这儿不用**。
 *   - MSAA 采样数是问设备要的最大值，这台机器上是 **4**（`asy -vv` 自报 sample width 4）。
 *
 * 这一版是**最小闭环**：只把离屏上下文 + 多重采样 FBO + 清背景 + 解析 + readback 走通，
 * 还没有 shader 与几何。它的用处是先把"能在这台机器上离屏拿到像素"这一格钉死，
 * 再往里逐块填（shader → 顶点缓冲 → 两趟绘制 → 分块导出）。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define GL_SILENCE_DEPRECATION 1
/* GLFW 默认会带进 `<OpenGL/gl.h>`（2.1 那一档），与我们要的 `gl3.h` 同时出现时
   Apple 的头会警告"两个都被 include 了"。让 GLFW 什么都别带，我们自己 include。 */
#define GLFW_INCLUDE_NONE 1
#include <GLFW/glfw3.h>
#include <OpenGL/gl3.h>

#include "omni_gl.h"

/* 出错时把话留在这儿，宿主用 `omni_gl_error()` 取 —— 插件不自己往 stderr 喷，
   免得把判据那一侧的输出弄脏。 */
static char omni_gl_err[512];

const char *omni_gl_error(void) { return omni_gl_err[0] ? omni_gl_err : NULL; }

static int fail(const char *fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(omni_gl_err, sizeof omni_gl_err, fmt, ap);
  va_end(ap);
  return -1;
}

/* 离屏上下文。GLFW 的隐藏窗口是 asy 自己也在用的那条路（glrender.cc 的 initWindow）；
   macOS 上要的是 **4.1 core profile + forward compatible**，否则拿到的是 2.1 兼容档，
   `#version 410` 直接编不过。 */
static GLFWwindow *ctx = NULL;

static int ctx_init(void)
{
  if (ctx) return 0;
  if (!glfwInit()) return fail("glfwInit failed");
  glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 4);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 1);
  glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
  glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
  ctx = glfwCreateWindow(1, 1, "omni-gl", NULL, NULL);
  if (!ctx) return fail("glfwCreateWindow failed (no GL 4.1 core context)");
  glfwMakeContextCurrent(ctx);
  return 0;
}

int omni_gl_probe(omni_gl_info *out)
{
  if (ctx_init() != 0) return -1;
  const char *gl = (const char *) glGetString(GL_VERSION);
  const char *sl = (const char *) glGetString(GL_SHADING_LANGUAGE_VERSION);
  const char *rd = (const char *) glGetString(GL_RENDERER);
  if (!gl || !sl) return fail("glGetString returned NULL");
  /* 照 glrender.cc:1305 —— 不要写死 */
  out->glsl_version = (int) (100 * atof(sl) + 0.5);
  snprintf(out->gl_version, sizeof out->gl_version, "%s", gl);
  snprintf(out->glsl_string, sizeof out->glsl_string, "%s", sl);
  snprintf(out->renderer, sizeof out->renderer, "%s", rd ? rd : "?");
  glGetIntegerv(GL_MAX_SAMPLES, &out->max_samples);
  return 0;
}

/* ── shader ────────────────────────────────────────────────────────────────
 * 照 `shaders.cc:92-130` 的 `createShaderFile` 拼源码：
 *     "#version <GLSLversion>\n"
 *     [`#ifndef __APPLE__` 那几条 #extension —— **macOS 上一条都不发**]
 *     "#define <flag>\n"  ← 按 defineflags 的顺序，一行一个
 *     <shader 文件原文>
 * `#version` 的值来自驱动（glrender.cc:1305），不写死。 */

static int glsl_version_cached = 0;

static char *read_file(const char *path, size_t *len)
{
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (n < 0) { fclose(f); return NULL; }
  char *p = (char *) malloc((size_t) n + 1);
  if (!p) { fclose(f); return NULL; }
  size_t got = fread(p, 1, (size_t) n, f);
  fclose(f);
  p[got] = 0;
  if (len) *len = got;
  return p;
}

static GLuint make_shader(const char *dir, const char *file, GLenum type,
                          const char *const *defs, int ndefs)
{
  char path[1024];
  snprintf(path, sizeof path, "%s/%s", dir, file);
  size_t blen = 0;
  char *body = read_file(path, &blen);
  if (!body) { fail("读不到 shader 文件 %s", path); return 0; }

  /* 头部：#version + #define（macOS 不发 #extension） */
  size_t cap = 64 + blen;
  for (int i = 0; i < ndefs; ++i) cap += strlen(defs[i]) + 16;
  char *src = (char *) malloc(cap);
  if (!src) { free(body); fail("内存不够"); return 0; }
  int off = snprintf(src, cap, "#version %d\n", glsl_version_cached);
  for (int i = 0; i < ndefs; ++i)
    off += snprintf(src + off, cap - (size_t) off, "#define %s\n", defs[i]);
  snprintf(src + off, cap - (size_t) off, "%s", body);
  free(body);

  GLuint sh = glCreateShader(type);
  const char *one = src;
  glShaderSource(sh, 1, &one, NULL);
  glCompileShader(sh);
  GLint ok = 0;
  glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char info[1024];
    GLsizei n = 0;
    glGetShaderInfoLog(sh, (GLsizei) sizeof info, &n, info);
    fail("%s 编不过：%.*s", file, (int) n, info);
    free(src);
    glDeleteShader(sh);
    return 0;
  }
  free(src);
  return sh;
}

/* 属性 location：asy **不**用 glGetAttribLocation，而是链接前按名字绑死
   （shaders.h:31 的枚举 + shaders.cc:37-41 的 glBindAttribLocation）。
   照抄这个次序，编号才与它一致。 */
enum { A_POS = 0, A_NRM = 1, A_MAT = 2, A_COL = 3, A_WID = 4 };

/* 照 `compileAndLinkShader`：顶点 + 片元两个，链成一个 program。 */
static GLuint make_program(const char *dir, const char *vert, const char *frag,
                           const char *const *defs, int ndefs)
{
  GLuint vs = make_shader(dir, vert, GL_VERTEX_SHADER, defs, ndefs);
  if (!vs) return 0;
  GLuint fs = make_shader(dir, frag, GL_FRAGMENT_SHADER, defs, ndefs);
  if (!fs) { glDeleteShader(vs); return 0; }
  GLuint pr = glCreateProgram();
  glAttachShader(pr, vs);
  glAttachShader(pr, fs);
  /* 必须在 glLinkProgram **之前**（shaders.cc:37-41） */
  glBindAttribLocation(pr, A_POS, "position");
  glBindAttribLocation(pr, A_NRM, "normal");
  glBindAttribLocation(pr, A_MAT, "material");
  glBindAttribLocation(pr, A_COL, "color");
  glBindAttribLocation(pr, A_WID, "width");
  glLinkProgram(pr);
  GLint ok = 0;
  glGetProgramiv(pr, GL_LINK_STATUS, &ok);
  glDeleteShader(vs);
  glDeleteShader(fs);
  if (!ok) {
    char info[1024];
    GLsizei n = 0;
    glGetProgramInfoLog(pr, (GLsizei) sizeof info, &n, info);
    fail("链接失败：%.*s", (int) n, info);
    glDeleteProgram(pr);
    return 0;
  }
  return pr;
}

/* asy 那一套 program 的 `#define` 组合（glrender.cc:265-352）。
 *
 * **注意 `shaderParams` 是个栈，而且 NORMAL/COLOR/GENERAL 一路只 push 不 pop** ——
 * 所以 color 那两个其实带着 NORMAL、general 带着 NORMAL+COLOR、transparent 带着
 * NORMAL+COLOR+GENERAL。这不是笔误，是源码的实际行为，照抄，别"理顺"。
 *   common          = [USE_IBL] MATERIAL [ORTHOGRAPHIC] "Nlights N" "Nmaterials N"
 *   pixel           = common + WIDTH
 *   material[0]     = common + NORMAL
 *   material[1]     = common + NORMAL + OPAQUE
 *   color[0]        = common + NORMAL + COLOR
 *   color[1]        = common + NORMAL + COLOR + OPAQUE
 *   general[0]      = common + NORMAL + COLOR + GENERAL [+ WIREFRAME]
 *   general[1]      = common + NORMAL + COLOR + GENERAL + OPAQUE
 *   transparent     = common + NORMAL + COLOR + GENERAL + TRANSPARENT
 * SSBO 那一路的 count/compress/zero/blend 本机不走（`ssbo == 0`）。 */
int omni_gl_shaders_selftest(const char *shader_dir, int nlights, int nmaterials,
                             int orthographic)
{
  if (ctx_init() != 0) return -1;
  if (!glsl_version_cached) {
    const char *sl = (const char *) glGetString(GL_SHADING_LANGUAGE_VERSION);
    if (!sl) return fail("拿不到 GL_SHADING_LANGUAGE_VERSION");
    glsl_version_cached = (int) (100 * atof(sl) + 0.5);
  }

  char lights[32], mats[32];
  snprintf(lights, sizeof lights, "Nlights %d", nlights);
  snprintf(mats, sizeof mats, "Nmaterials %d", nmaterials);

  const char *st[10];
  int n = 0;
  st[n++] = "MATERIAL";
  if (orthographic) st[n++] = "ORTHOGRAPHIC";
  st[n++] = lights;
  st[n++] = mats;
  const int ncommon = n;

  struct { const char *name; int extra; const char *defs[4]; } want[] = {
    { "pixel",       1, { "WIDTH" } },
    { "material[0]", 1, { "NORMAL" } },
    { "material[1]", 2, { "NORMAL", "OPAQUE" } },
    { "color[0]",    2, { "NORMAL", "COLOR" } },
    { "color[1]",    3, { "NORMAL", "COLOR", "OPAQUE" } },
    { "general[0]",  3, { "NORMAL", "COLOR", "GENERAL" } },
    { "general[1]",  4, { "NORMAL", "COLOR", "GENERAL", "OPAQUE" } },
    { "transparent", 4, { "NORMAL", "COLOR", "GENERAL", "TRANSPARENT" } },
  };

  int bad = 0;
  for (size_t i = 0; i < sizeof want / sizeof want[0]; ++i) {
    n = ncommon;
    for (int k = 0; k < want[i].extra; ++k) st[n++] = want[i].defs[k];
    GLuint pr = make_program(shader_dir, "vertex.glsl", "fragment.glsl", st, n);
    if (!pr) { printf("  %-13s 失败：%s\n", want[i].name, omni_gl_error()); bad++; }
    else { printf("  %-13s ok (program %u)\n", want[i].name, (unsigned) pr);
           glDeleteProgram(pr); }
  }
  return bad;
}

/* 第三块的第一步：**一个三角形**。
 *
 * 判据取得很硬：`fragment.glsl:248` 在 `NORMAL` 且 `Nlights == 0` 时是
 * `outColor = emissive;` —— 不经光照、不经色调映射。所以把 UBO 里那个材质的
 * `emissive` 设成 (0.2,0.4,0.6,1)，读回来的像素**必须**是
 * round(255*0.2)=51、round(255*0.4)=102、round(255*0.6)=153。
 * 三个通道刻意互不相同：通道错位、std140 偏移算错、材质下标取错、
 * 或误走了 `m.emissive` 那一支，都会立刻现形，不会"看着像对"。
 *
 * 同时验的四件事：属性按名字绑（GL 那份 shader 没有 `layout(location=)`）、
 * `material` 是 `in int` 必须走 `glVertexAttribIPointer`、
 * 无 `binding=` 的 UBO 要 `glGetUniformBlockIndex`+`glUniformBlockBinding`+
 * `glBindBufferBase` 三步手绑、`projViewMat` 的列主序与我们送的一致。 */
int omni_gl_geom_selftest(const char *shader_dir)
{
  if (ctx_init() != 0) return -1;
  if (!glsl_version_cached) {
    const char *sl = (const char *) glGetString(GL_SHADING_LANGUAGE_VERSION);
    if (!sl) return fail("拿不到 GL_SHADING_LANGUAGE_VERSION");
    glsl_version_cached = (int) (100 * atof(sl) + 0.5);
  }

  /* material[1]（不透明那档）：common + NORMAL + OPAQUE，光照数取 0 */
  const char *defs[] = { "MATERIAL", "ORTHOGRAPHIC", "Nlights 0", "Nmaterials 1",
                         "NORMAL", "OPAQUE" };
  GLuint pr = make_program(shader_dir, "vertex.glsl", "fragment.glsl",
                           defs, (int) (sizeof defs / sizeof defs[0]));
  if (!pr) return -1;

  const int W = 4, H = 2;
  GLuint fbo = 0, crb = 0, drb = 0;
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glGenRenderbuffers(1, &crb);
  glBindRenderbuffer(GL_RENDERBUFFER, crb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, 4, GL_RGBA8, W, H);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, crb);
  glGenRenderbuffers(1, &drb);
  glBindRenderbuffer(GL_RENDERBUFFER, drb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, 4, GL_DEPTH_COMPONENT32F, W, H);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, drb);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("FBO 不完整");
  glViewport(0, 0, W, H);
  glClearColor(1, 1, 1, 1);
  glClearDepth(1.0);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

  glUseProgram(pr);

  /* uniform：单位矩阵。GL 的 mat 是列主序，单位阵看不出行列序问题，
     所以这一步只验"三角没跑出视口"；行列序留到接真实 projViewMat 时再验。 */
  const GLfloat I4[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
  const GLfloat I3[9] = { 1,0,0, 0,1,0, 0,0,1 };
  GLint u = glGetUniformLocation(pr, "projViewMat");
  if (u < 0) return fail("拿不到 projViewMat");
  glUniformMatrix4fv(u, 1, GL_FALSE, I4);
  u = glGetUniformLocation(pr, "normMat");
  if (u >= 0) glUniformMatrix3fv(u, 1, GL_FALSE, I3);

  /* UBO：std140 下 `struct Material{vec4 diffuse,emissive,specular; vec4 parameters;}`
     就是四个 vec4 紧排 = 64 字节，全 16 字节对齐。 */
  GLfloat mat[16] = {
    0.9f, 0.9f, 0.9f, 1.0f,      /* diffuse   —— Nlights 0 时用不上 */
    0.2f, 0.4f, 0.6f, 1.0f,      /* emissive  ←—— 判据就看它 */
    0.0f, 0.0f, 0.0f, 1.0f,      /* specular  */
    0.0f, 0.0f, 0.0f, 0.0f       /* parameters */
  };
  GLuint ubo = 0;
  glGenBuffers(1, &ubo);
  glBindBuffer(GL_UNIFORM_BUFFER, ubo);
  glBufferData(GL_UNIFORM_BUFFER, sizeof mat, mat, GL_STATIC_DRAW);
  GLuint blk = glGetUniformBlockIndex(pr, "MaterialBuffer");
  if (blk == GL_INVALID_INDEX) return fail("找不到 uniform block MaterialBuffer");
  glUniformBlockBinding(pr, blk, 0);
  glBindBufferBase(GL_UNIFORM_BUFFER, 0, ubo);

  /* 覆盖整幅的三角（NDC 直给，projViewMat 是单位阵） */
  const GLfloat pos[9] = { -1,-1,0,  3,-1,0,  -1,3,0 };
  const GLfloat nrm[9] = { 0,0,1,  0,0,1,  0,0,1 };
  const GLint   mid[3] = { 0, 0, 0 };

  GLuint vao = 0, vp = 0, vn = 0, vm = 0;
  glGenVertexArrays(1, &vao);
  glBindVertexArray(vao);
  GLint a = glGetAttribLocation(pr, "position");
  if (a < 0) return fail("拿不到属性 position");
  glGenBuffers(1, &vp);
  glBindBuffer(GL_ARRAY_BUFFER, vp);
  glBufferData(GL_ARRAY_BUFFER, sizeof pos, pos, GL_STATIC_DRAW);
  glVertexAttribPointer((GLuint) a, 3, GL_FLOAT, GL_FALSE, 0, NULL);
  glEnableVertexAttribArray((GLuint) a);

  a = glGetAttribLocation(pr, "normal");
  if (a >= 0) {
    glGenBuffers(1, &vn);
    glBindBuffer(GL_ARRAY_BUFFER, vn);
    glBufferData(GL_ARRAY_BUFFER, sizeof nrm, nrm, GL_STATIC_DRAW);
    glVertexAttribPointer((GLuint) a, 3, GL_FLOAT, GL_FALSE, 0, NULL);
    glEnableVertexAttribArray((GLuint) a);
  }

  a = glGetAttribLocation(pr, "material");
  if (a >= 0) {
    glGenBuffers(1, &vm);
    glBindBuffer(GL_ARRAY_BUFFER, vm);
    glBufferData(GL_ARRAY_BUFFER, sizeof mid, mid, GL_STATIC_DRAW);
    /* **整数属性必须用 I 版**；用 glVertexAttribPointer 不报错但值全错 */
    glVertexAttribIPointer((GLuint) a, 1, GL_INT, 0, NULL);
    glEnableVertexAttribArray((GLuint) a);
  }

  glEnable(GL_DEPTH_TEST);
  glDepthFunc(GL_LESS);
  glDrawArrays(GL_TRIANGLES, 0, 3);

  /* 解析 + 读回 */
  GLuint rfbo = 0, rtex = 0;
  glGenFramebuffers(1, &rfbo);
  glGenTextures(1, &rtex);
  glBindTexture(GL_TEXTURE_2D, rtex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glBindFramebuffer(GL_FRAMEBUFFER, rfbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, rtex, 0);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, rfbo);
  glBlitFramebuffer(0, 0, W, H, 0, 0, W, H, GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, rfbo);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  unsigned char px[4 * 2 * 3];
  glReadPixels(0, 0, W, H, GL_RGB, GL_UNSIGNED_BYTE, px);

  GLenum e = glGetError();
  printf("  三角读回：");
  for (int i = 0; i < 6; ++i) printf(" %d", px[i]);
  printf(" …（应为 51 102 153 重复）\n");
  int bad = 0;
  for (int i = 0; i < W * H; ++i) {
    if (px[i * 3] != 51 || px[i * 3 + 1] != 102 || px[i * 3 + 2] != 153) { bad = 1; break; }
  }
  if (e != GL_NO_ERROR) { fail("GL 报错 0x%x", (unsigned) e); bad = 1; }
  glDeleteProgram(pr);
  return bad;
}

/* ── 第三块：真几何（照抄 glrender.cc 的 drawBuffers/drawBuffer/setUniformsOpenGL） ──
 *
 * 本机 `ssbo == 0`，所以走的是**没有次序无关透明**那一路：
 *   initShaders 里一次性 `glEnable(GL_BLEND)` +
 *   `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)`（glrender.cc:288-292），
 *   **之后整帧再也不 glDisable(GL_BLEND)** —— 不透明那几趟也是开着混合画的
 *   （alpha=1 时等价，但 alpha 写脏就会露出来，照抄别"优化"）。
 * 一帧的次序（glrender.cc:1123-1152）：
 *   points → lines → materials → colors → triangles → [透明：排序 + 关深度写 + 一趟]
 * `Opaque` 是 bool 当下标：**只要场景里有任何透明物**，连不透明那几趟也用不带
 * `OPAQUE` 宏的变体。 */

typedef struct {
  GLuint pixel, material[2], color[2], general[2], transparent;
  char dir[512];
  int nlights, nmaterials, ortho;
  int built;
} gl_progset;

static gl_progset progs;

static GLuint one_prog(const char *dir, const char *const *common, int ncommon,
                       const char *const *extra, int nextra)
{
  const char *st[10];
  int n = 0;
  for (int i = 0; i < ncommon; ++i) st[n++] = common[i];
  for (int i = 0; i < nextra; ++i) st[n++] = extra[i];
  return make_program(dir, "vertex.glsl", "fragment.glsl", st, n);
}

/* asy 的 `initShaders`：Nlights/Nmaterials 是 **#define**，所以它们一变就得重编
 * （glrender.cc:424-428 的 deleteShaders()+initShaders()）。这儿同样按三元键缓存。
 * `nmaterials = materials.size()`（glrender.cc:246），不是某个上限。 */
static int build_progs(const char *dir, int nlights, int nmaterials, int ortho)
{
  if (progs.built && progs.nlights == nlights && progs.nmaterials == nmaterials &&
      progs.ortho == ortho && strcmp(progs.dir, dir) == 0)
    return 0;
  if (progs.built) {
    glDeleteProgram(progs.pixel);
    glDeleteProgram(progs.material[0]); glDeleteProgram(progs.material[1]);
    glDeleteProgram(progs.color[0]);    glDeleteProgram(progs.color[1]);
    glDeleteProgram(progs.general[0]);  glDeleteProgram(progs.general[1]);
    glDeleteProgram(progs.transparent);
    memset(&progs, 0, sizeof progs);
  }

  static char lights[32], mats[32];
  snprintf(lights, sizeof lights, "Nlights %d", nlights);
  snprintf(mats, sizeof mats, "Nmaterials %d", nmaterials > 0 ? nmaterials : 1);
  const char *common[4];
  int nc = 0;
  common[nc++] = "MATERIAL";
  if (ortho) common[nc++] = "ORTHOGRAPHIC";
  common[nc++] = lights;
  common[nc++] = mats;

  /* 这一串 extra 就是那个只 push 不 pop 的栈（glrender.cc:265-352） */
  const char *e_pixel[] = { "WIDTH" };
  const char *e_mat0[]  = { "NORMAL" };
  const char *e_mat1[]  = { "NORMAL", "OPAQUE" };
  const char *e_col0[]  = { "NORMAL", "COLOR" };
  const char *e_col1[]  = { "NORMAL", "COLOR", "OPAQUE" };
  const char *e_gen0[]  = { "NORMAL", "COLOR", "GENERAL" };
  const char *e_gen1[]  = { "NORMAL", "COLOR", "GENERAL", "OPAQUE" };
  const char *e_tr[]    = { "NORMAL", "COLOR", "GENERAL", "TRANSPARENT" };

  progs.pixel       = one_prog(dir, common, nc, e_pixel, 1);
  progs.material[0] = one_prog(dir, common, nc, e_mat0, 1);
  progs.material[1] = one_prog(dir, common, nc, e_mat1, 2);
  progs.color[0]    = one_prog(dir, common, nc, e_col0, 2);
  progs.color[1]    = one_prog(dir, common, nc, e_col1, 3);
  progs.general[0]  = one_prog(dir, common, nc, e_gen0, 3);
  progs.general[1]  = one_prog(dir, common, nc, e_gen1, 4);
  progs.transparent = one_prog(dir, common, nc, e_tr, 4);
  if (!progs.pixel || !progs.material[0] || !progs.material[1] ||
      !progs.color[0] || !progs.color[1] || !progs.general[0] ||
      !progs.general[1] || !progs.transparent)
    return -1;   /* omni_gl_err 里已经有具体是哪一个编不过 */

  snprintf(progs.dir, sizeof progs.dir, "%s", dir);
  progs.nlights = nlights;
  progs.nmaterials = nmaterials;
  progs.ortho = ortho;
  progs.built = 1;
  return 0;
}

/* 全局材质 UBO（asy 的 `materialsBuffer`，binding 0）。 */
static GLuint materials_ubo = 0;

/* 照 `setUniformsOpenGL`（glrender.cc:891-956）。
   矩阵在 CPU 侧是 double，上传前才 `mat4(...)` 截成 float —— 这一步的截断次序
   要与 asy 相同，别在 double 域里先做别的运算。 */
static void set_uniforms(GLuint pr, const omni_gl_scene *sc, int normal)
{
  glUseProgram(pr);

  GLfloat m[16];
  for (int i = 0; i < 16; ++i) m[i] = (GLfloat) sc->projViewMat[i];
  GLint u = glGetUniformLocation(pr, "projViewMat");
  if (u >= 0) glUniformMatrix4fv(u, 1, GL_FALSE, m);

  for (int i = 0; i < 16; ++i) m[i] = (GLfloat) sc->viewMat[i];
  u = glGetUniformLocation(pr, "viewMat");
  if (u >= 0) glUniformMatrix4fv(u, 1, GL_FALSE, m);

  if (normal) {
    GLfloat n3[9];
    for (int i = 0; i < 9; ++i) n3[i] = (GLfloat) sc->normMat[i];
    u = glGetUniformLocation(pr, "normMat");
    if (u >= 0) glUniformMatrix3fv(u, 1, GL_FALSE, n3);
    /* `uniform uint width` 是帧缓冲宽度（SSBO 索引用），非 pixelShader 才发 */
    u = glGetUniformLocation(pr, "width");
    if (u >= 0) glUniform1ui(u, (GLuint) sc->width);
  }

  u = glGetUniformLocation(pr, "nlights");
  if (u >= 0) glUniform1ui(u, (GLuint) sc->nlights);
  for (int i = 0; i < sc->nlights; ++i) {
    char nm[64];
    snprintf(nm, sizeof nm, "lights[%d].direction", i);
    u = glGetUniformLocation(pr, nm);
    if (u >= 0) glUniform3f(u, sc->light_dirs[3*i], sc->light_dirs[3*i+1],
                            sc->light_dirs[3*i+2]);
    snprintf(nm, sizeof nm, "lights[%d].color", i);
    u = glGetUniformLocation(pr, nm);
    if (u >= 0) glUniform3f(u, sc->light_colors[3*i], sc->light_colors[3*i+1],
                            sc->light_colors[3*i+2]);
  }

  /* MaterialBuffer 没有 `binding=`，要手绑三步 */
  GLuint blk = glGetUniformBlockIndex(pr, "MaterialBuffer");
  if (blk != GL_INVALID_INDEX) {
    glUniformBlockBinding(pr, blk, 0);
    glBindBufferBase(GL_UNIFORM_BUFFER, 0, materials_ubo);
  }
}

/* 照 `drawBuffer`（glrender.cc:958-1054）。
   `kind`：0 = PointVertex（pixelShader）、1 = MaterialVertex、2 = ColorVertex。
   stride/offset 全部照抄，特别是 **normal 的 offset 对两种结构都写 12**，
   以及 material 必须走 `glVertexAttribIPointer`。 */
static int draw_buffer(const omni_gl_buffer *b, GLuint pr, int kind,
                       GLenum drawType, const omni_gl_scene *sc,
                       const uint32_t *idx_override)
{
  if (b->nindices == 0) return 0;
  int normal = (kind != 0);
  int color = (kind == 2);
  GLsizei stride = kind == 2 ? 44 : (kind == 1 ? 28 : 20);
  size_t vsz = (size_t) stride * b->nverts;

  GLuint vb = 0, ib = 0;
  glGenBuffers(1, &vb);
  glBindBuffer(GL_ARRAY_BUFFER, vb);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr) vsz, b->verts, GL_STATIC_DRAW);
  glGenBuffers(1, &ib);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ib);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER,
               (GLsizeiptr) (b->nindices * sizeof(uint32_t)),
               idx_override ? idx_override : b->indices, GL_STATIC_DRAW);

  set_uniforms(pr, sc, normal);

  glVertexAttribPointer(A_POS, 3, GL_FLOAT, GL_FALSE, stride, (void *) 0);
  glEnableVertexAttribArray(A_POS);

  if (normal && sc->nlights > 0) {
    /* offsetof(MaterialVertex, normal) == offsetof(ColorVertex, normal) == 12 */
    glVertexAttribPointer(A_NRM, 3, GL_FLOAT, GL_FALSE, stride, (void *) 12);
    glEnableVertexAttribArray(A_NRM);
  }
  if (!normal) {
    glVertexAttribPointer(A_WID, 1, GL_FLOAT, GL_FALSE, stride, (void *) 12);
    glEnableVertexAttribArray(A_WID);
  }
  glVertexAttribIPointer(A_MAT, 1, GL_INT, stride,
                         (void *) (size_t) (normal ? 24 : 16));
  glEnableVertexAttribArray(A_MAT);
  if (color) {
    glVertexAttribPointer(A_COL, 4, GL_FLOAT, GL_FALSE, stride, (void *) 28);
    glEnableVertexAttribArray(A_COL);
  }

  glDrawElements(drawType, (GLsizei) b->nindices, GL_UNSIGNED_INT, (void *) 0);

  glDisableVertexAttribArray(A_POS);
  if (normal && sc->nlights > 0) glDisableVertexAttribArray(A_NRM);
  if (!normal) glDisableVertexAttribArray(A_WID);
  glDisableVertexAttribArray(A_MAT);
  if (color) glDisableVertexAttribArray(A_COL);
  glBindBuffer(GL_UNIFORM_BUFFER, 0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
  glDeleteBuffers(1, &vb);
  glDeleteBuffers(1, &ib);
  return 0;
}

/* 照 `sortTriangles.cc`：键是 `projView` 的**第 2 列**前三个分量点乘顶点位置
   （注意是列不是行、也不含平移项 —— 常数项对排序无影响），
   三角形的键取三顶点之和，**升序**。qsort 粒度 3 个 uint32。 */
static double *sort_zbuf = NULL;

static int tri_compare(const void *p, const void *P)
{
  const uint32_t *a = (const uint32_t *) p, *b = (const uint32_t *) P;
  double za = sort_zbuf[a[0]] + sort_zbuf[a[1]] + sort_zbuf[a[2]];
  double zb = sort_zbuf[b[0]] + sort_zbuf[b[1]] + sort_zbuf[b[2]];
  return za < zb ? -1 : 1;
}

static uint32_t *sort_transparent(const omni_gl_scene *sc)
{
  const omni_gl_buffer *b = &sc->transparent;
  const omni_gl_cvertex *v = (const omni_gl_cvertex *) b->verts;
  sort_zbuf = (double *) malloc(b->nverts * sizeof(double));
  uint32_t *idx = (uint32_t *) malloc(b->nindices * sizeof(uint32_t));
  if (!sort_zbuf || !idx) { free(sort_zbuf); sort_zbuf = NULL; free(idx); return NULL; }
  double Tz0 = sc->projViewMat[8], Tz1 = sc->projViewMat[9], Tz2 = sc->projViewMat[10];
  for (size_t i = 0; i < b->nverts; ++i)
    sort_zbuf[i] = Tz0 * v[i].position[0] + Tz1 * v[i].position[1]
                 + Tz2 * v[i].position[2];
  memcpy(idx, b->indices, b->nindices * sizeof(uint32_t));
  qsort(idx, b->nindices / 3, 3 * sizeof(uint32_t), tri_compare);
  free(sort_zbuf);
  sort_zbuf = NULL;
  return idx;
}

int omni_gl_draw(const char *shader_dir, const omni_gl_scene *sc,
                 unsigned char *out_rgb)
{
  if (sc->version != OMNI_GL_REQ_VERSION)
    return fail("场景结构版本不符：插件要 %d，宿主给 %d",
                OMNI_GL_REQ_VERSION, sc->version);
  if (sc->width <= 0 || sc->height <= 0)
    return fail("尺寸不合格 %dx%d", sc->width, sc->height);
  if (ctx_init() != 0) return -1;
  if (!glsl_version_cached) {
    const char *sl = (const char *) glGetString(GL_SHADING_LANGUAGE_VERSION);
    if (!sl) return fail("拿不到 GL_SHADING_LANGUAGE_VERSION");
    glsl_version_cached = (int) (100 * atof(sl) + 0.5);
  }

  /* Nlights：`nlights == 0 ? 0 : max(Nlights, nlights)`（glrender.cc:245）。
     导出是一帧一次，所以就等于 nlights。 */
  if (build_progs(shader_dir, sc->nlights, sc->nmaterials, sc->orthographic) != 0)
    return -1;

  /* VAO 只生成一次并一直绑着（glrender.cc:213-215） */
  static GLuint vao = 0;
  if (!vao) { glGenVertexArrays(1, &vao); glBindVertexArray(vao); }

  if (!materials_ubo) glGenBuffers(1, &materials_ubo);
  glBindBuffer(GL_UNIFORM_BUFFER, materials_ubo);
  glBufferData(GL_UNIFORM_BUFFER,
               (GLsizeiptr) (sizeof(omni_gl_material) *
                             (sc->nmaterials > 0 ? sc->nmaterials : 1)),
               sc->materials, GL_STATIC_DRAW);
  glBindBuffer(GL_UNIFORM_BUFFER, 0);

  int ns = sc->samples > 0 ? sc->samples : 1;
  int maxs = 1;
  glGetIntegerv(GL_MAX_SAMPLES, &maxs);
  if (ns > maxs) ns = maxs;

  GLuint fbo = 0, crb = 0, drb = 0;
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glGenRenderbuffers(1, &crb);
  glBindRenderbuffer(GL_RENDERBUFFER, crb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, ns, GL_RGBA8,
                                   sc->width, sc->height);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                            GL_RENDERBUFFER, crb);
  glGenRenderbuffers(1, &drb);
  glBindRenderbuffer(GL_RENDERBUFFER, drb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, ns, GL_DEPTH_COMPONENT32F,
                                   sc->width, sc->height);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
                            GL_RENDERBUFFER, drb);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("多重采样 FBO 不完整（%dx%d, %d 采样）", sc->width, sc->height, ns);

  /* ssbo == 0：混合开一次就不关了（glrender.cc:288-292） */
  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  glEnable(GL_DEPTH_TEST);            /* glrender.cc:1349 */
  glEnable(GL_PROGRAM_POINT_SIZE);    /* glrender.cc:1352，gl_PointSize 才生效 */

  glViewport(0, 0, sc->width, sc->height);
  glClearColor(sc->bg[0], sc->bg[1], sc->bg[2], sc->bg[3]);
  glClearDepth(1.0);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

  /* Opaque 是 bool 当下标（glrender.cc:1127） */
  int Opaque = sc->transparent.nindices == 0;
  int transparent = !Opaque;

  draw_buffer(&sc->point, progs.pixel, 0, GL_POINTS, sc, NULL);
  draw_buffer(&sc->line, progs.material[Opaque], 1, GL_LINES, sc, NULL);
  draw_buffer(&sc->material, progs.material[Opaque], 1, GL_TRIANGLES, sc, NULL);
  draw_buffer(&sc->color, progs.color[Opaque], 2, GL_TRIANGLES, sc, NULL);
  draw_buffer(&sc->triangle, progs.general[Opaque], 2, GL_TRIANGLES, sc, NULL);

  if (transparent) {
    uint32_t *idx = sort_transparent(sc);
    if (!idx) return fail("透明排序时内存不够");
    glDepthMask(GL_FALSE);      /* 透明那一趟不写深度 */
    draw_buffer(&sc->transparent, progs.transparent, 2, GL_TRIANGLES, sc, idx);
    glDepthMask(GL_TRUE);
    free(idx);
  }

  /* 解析 + 读回 */
  GLuint rfbo = 0, rtex = 0;
  glGenFramebuffers(1, &rfbo);
  glGenTextures(1, &rtex);
  glBindTexture(GL_TEXTURE_2D, rtex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, sc->width, sc->height, 0,
               GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glBindFramebuffer(GL_FRAMEBUFFER, rfbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                         rtex, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("解析用的 FBO 不完整");
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, rfbo);
  glBlitFramebuffer(0, 0, sc->width, sc->height, 0, 0, sc->width, sc->height,
                    GL_COLOR_BUFFER_BIT, GL_NEAREST);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, rfbo);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, sc->width, sc->height, GL_RGB, GL_UNSIGNED_BYTE, out_rgb);

  GLenum e = glGetError();
  glDeleteFramebuffers(1, &rfbo);
  glDeleteTextures(1, &rtex);
  glDeleteRenderbuffers(1, &crb);
  glDeleteRenderbuffers(1, &drb);
  glDeleteFramebuffers(1, &fbo);
  if (e != GL_NO_ERROR) return fail("GL 报错 0x%x", (unsigned) e);
  return 0;
}

int omni_gl_render(const omni_gl_req *req, unsigned char *out_rgb)
{
  if (req->version != OMNI_GL_REQ_VERSION)
    return fail("请求结构版本不符：插件要 %d，宿主给 %d",
                OMNI_GL_REQ_VERSION, req->version);
  if (req->width <= 0 || req->height <= 0)
    return fail("尺寸不合格 %dx%d", req->width, req->height);
  if (ctx_init() != 0) return -1;

  int ns = req->samples > 0 ? req->samples : 1;
  int maxs = 1;
  glGetIntegerv(GL_MAX_SAMPLES, &maxs);
  if (ns > maxs) ns = maxs;

  /* 多重采样那一份：颜色与深度都是 renderbuffer（asy 的 colorImg/depthImg 同样是
     多重采样附件；深度用 32 位浮点，对应 vkrender 那边的 eD32Sfloat）。 */
  GLuint fbo = 0, crb = 0, drb = 0;
  glGenFramebuffers(1, &fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glGenRenderbuffers(1, &crb);
  glBindRenderbuffer(GL_RENDERBUFFER, crb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, ns, GL_RGBA8,
                                   req->width, req->height);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                            GL_RENDERBUFFER, crb);
  glGenRenderbuffers(1, &drb);
  glBindRenderbuffer(GL_RENDERBUFFER, drb);
  glRenderbufferStorageMultisample(GL_RENDERBUFFER, ns, GL_DEPTH_COMPONENT32F,
                                   req->width, req->height);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT,
                            GL_RENDERBUFFER, drb);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("多重采样 FBO 不完整（%dx%d, %d 采样）", req->width, req->height, ns);

  glViewport(0, 0, req->width, req->height);
  glClearColor(req->bg[0], req->bg[1], req->bg[2], req->bg[3]);
  glClearDepth(1.0);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

  /* TODO(下一块)：shader 编译（`#version` + macOS 不发 extension + `#define` 表）、
     顶点/材质/光照上传、不透明与透明两趟绘制。 */

  /* 解析：多重采样那一份 blit 到单采样的 FBO，再 readback。
     `GL_NEAREST` 是 blit 多重采样到单采样时唯一允许的过滤方式。 */
  GLuint rfbo = 0, rtex = 0;
  glGenFramebuffers(1, &rfbo);
  glGenTextures(1, &rtex);
  glBindTexture(GL_TEXTURE_2D, rtex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, req->width, req->height, 0,
               GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glBindFramebuffer(GL_FRAMEBUFFER, rfbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
                         rtex, 0);
  if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    return fail("解析用的 FBO 不完整");
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, rfbo);
  glBlitFramebuffer(0, 0, req->width, req->height, 0, 0, req->width, req->height,
                    GL_COLOR_BUFFER_BIT, GL_NEAREST);

  glBindFramebuffer(GL_READ_FRAMEBUFFER, rfbo);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, req->width, req->height, GL_RGB, GL_UNSIGNED_BYTE, out_rgb);

  GLenum e = glGetError();
  glDeleteFramebuffers(1, &rfbo);
  glDeleteTextures(1, &rtex);
  glDeleteRenderbuffers(1, &crb);
  glDeleteRenderbuffers(1, &drb);
  glDeleteFramebuffers(1, &fbo);
  if (e != GL_NO_ERROR) return fail("GL 报错 0x%x", (unsigned) e);
  return 0;
}

#ifdef OMNI_GL_MAIN
/* 自检：`cc -DOMNI_GL_MAIN ...` 编出来直接跑，打印上下文信息与一小块清屏结果。
   这一步不依赖 Omni 的任何东西，专门用来判定"这台机器能不能离屏拿到像素"。 */
int main(void)
{
  omni_gl_info inf;
  if (omni_gl_probe(&inf) != 0) { printf("probe 失败：%s\n", omni_gl_error()); return 1; }
  printf("GL_VERSION      %s\n", inf.gl_version);
  printf("GLSL            %s -> GLSLversion=%d\n", inf.glsl_string, inf.glsl_version);
  printf("GL_RENDERER     %s\n", inf.renderer);
  printf("GL_MAX_SAMPLES  %d\n", inf.max_samples);

  const char *sd = getenv("OMNI_GL_SHADERS");
  if (!sd) sd = "/opt/homebrew/share/asymptote/shaders/GL";
  printf("shader 目录     %s\n", sd);
  int bad = omni_gl_shaders_selftest(sd, 2, 48, 1);
  printf(bad == 0 ? "八个 program 全部编过并链成\n" : "有 %d 个没过\n", bad);

  int gbad = omni_gl_geom_selftest(sd);
  if (gbad != 0) printf("一个三角那一步没过：%s\n", omni_gl_error() ? omni_gl_error() : "像素不符");
  else printf("一个三角：属性/UBO/片元输出三处全对\n");

  /* 第三块整条路：走 omni_gl_draw（八个 program + 六条 buffer + 排序 + 混合），
     用 materialData 那一条送一个铺满的三角，判据同样是 51/102/153。 */
  {
    omni_gl_scene sc;
    memset(&sc, 0, sizeof sc);
    sc.version = OMNI_GL_REQ_VERSION;
    sc.width = 4; sc.height = 2; sc.samples = 4;
    sc.bg[0] = sc.bg[1] = sc.bg[2] = sc.bg[3] = 1.0f;
    static const double I4[16] = { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 };
    static const double I3[9] = { 1,0,0, 0,1,0, 0,0,1 };
    memcpy(sc.projViewMat, I4, sizeof I4);
    memcpy(sc.viewMat, I4, sizeof I4);
    memcpy(sc.normMat, I3, sizeof I3);
    omni_gl_material mt;
    memset(&mt, 0, sizeof mt);
    mt.diffuse[0] = mt.diffuse[1] = mt.diffuse[2] = 0.9f; mt.diffuse[3] = 1.0f;
    mt.emissive[0] = 0.2f; mt.emissive[1] = 0.4f; mt.emissive[2] = 0.6f;
    mt.emissive[3] = 1.0f;
    sc.materials = &mt; sc.nmaterials = 1;
    sc.nlights = 0; sc.orthographic = 1;
    omni_gl_mvertex mv[3] = {
      { { -1,-1, 0 }, { 0,0,1 }, 0 },
      { {  3,-1, 0 }, { 0,0,1 }, 0 },
      { { -1, 3, 0 }, { 0,0,1 }, 0 },
    };
    static const uint32_t ix[3] = { 0, 1, 2 };
    sc.material.verts = mv; sc.material.nverts = 3;
    sc.material.indices = ix; sc.material.nindices = 3;
    unsigned char p2[4 * 2 * 3];
    memset(p2, 0x5a, sizeof p2);
    if (omni_gl_draw(sd, &sc, p2) != 0)
      printf("omni_gl_draw 失败：%s\n", omni_gl_error());
    else {
      int ok = 1;
      for (int i = 0; i < 4 * 2; ++i)
        if (p2[i*3] != 51 || p2[i*3+1] != 102 || p2[i*3+2] != 153) { ok = 0; break; }
      printf("omni_gl_draw（materialData 一条三角）：%s ——", ok ? "对" : "不对");
      for (int i = 0; i < 6; ++i) printf(" %d", p2[i]);
      printf("\n");
      if (!ok) bad++;
    }
  }

  omni_gl_req req;
  memset(&req, 0, sizeof req);
  req.version = OMNI_GL_REQ_VERSION;
  req.width = 4; req.height = 2; req.samples = 4;
  req.bg[0] = 1.0f; req.bg[1] = 1.0f; req.bg[2] = 1.0f; req.bg[3] = 1.0f;
  unsigned char px[4 * 2 * 3];
  memset(px, 0x5a, sizeof px);
  if (omni_gl_render(&req, px) != 0) { printf("render 失败：%s\n", omni_gl_error()); return 1; }
  printf("清成白底之后的 4x2：");
  for (size_t i = 0; i < sizeof px; ++i) printf(" %d", px[i]);
  printf("\n");
  return bad == 0 ? 0 : 1;
}
#endif
