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
  if (!sd) sd = "/opt/homebrew/share/asymptote/shaders";
  printf("shader 目录     %s\n", sd);
  int bad = omni_gl_shaders_selftest(sd, 2, 48, 1);
  printf(bad == 0 ? "八个 program 全部编过并链成\n" : "有 %d 个没过\n", bad);

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
