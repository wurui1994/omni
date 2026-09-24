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
 * 3. **顶点契约与别的两档设备同一格**：一格顶点 16 个 double（位置 4 裁剪空间 /
 *    颜色 4 是 0..1 / 纹理坐标 4 / 法向 4），批的类 0 线段 / 1 三角 / 2 点。
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
/* 文件纹理的解码走这台机器的 ImageIO（§20.2）—— 与上下文用 CGL 同一条道理。 */
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>

/* 出错把话留在这儿，宿主用 `omni_ev_gl_error()` 取（插件不自己往 stderr 喷 ——
   那会把判据那一侧的 stdout/stderr 弄脏）。 */
static char g_err[4096];
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
/** 现在这格视口（抓屏那一族会用到，见 `omni_ev_gl_capbegin`）。 */
static int g_vpw, g_vph;
/** 抓屏那一趟的尺寸（照 c_impl 就是整帧）。 */
static int g_capw, g_caph;
static int g_on;
static int g_depth_test;

/* ── 可编程管线那一摊（与 `src/studio/gfx-gl.js` 的 `SH`/`UNI`/`TX` 一一对应）─────────
 *
 * 语言那一侧把 `.pss` 的 `@v`/`@f`/`@g` 区段与那张名字表**原样**交过来
 * （方言的 `(gfxdef 种类 名字 内容)`，GLSL 已经在编译期对齐好了，见 §13.7），
 * 运行期 `glsetshader(名字下标…)` 按名字挑一对。这儿是那半的 C 实现。
 *
 * 表都是定长的（脚本里这几样都是个位数级）—— 满了就报，不悄悄丢。 */
#define EV_MAXSH 32
#define EV_MAXNAME 256
#define EV_MAXPROG 16
#define EV_MAXUNI 256
#define EV_MAXATTR 16
#define EV_MAXTEX 64

static struct { char name[64]; int kind; char *text; } g_sh[EV_MAXSH];  /* kind 0 vert 1 frag 2 geom */
static int g_nsh;
static struct { int idx; char name[64]; } g_nm[EV_MAXNAME];
static int g_nnm;
static struct { int vi, fi; GLuint prog; } g_progs[EV_MAXPROG];
static int g_nprogs;
static struct { GLuint prog; GLint loc; } g_uni[EV_MAXUNI];
static int g_nuni;
static struct { GLint loc; float v[4]; } g_attr[EV_MAXATTR];
static int g_nattr;
static struct { GLuint id; int w, h, fmt; int slot; GLenum tar; } g_tex[EV_MAXTEX];
static int g_ntex;

static GLuint g_cur;             /* 现在挑着的那格 program（0 = 还没挑） */
static int g_useprog;           /* `batchprog`：0 内建那对、≠0 脚本那格 */
static int g_blend = 1;         /* `batchblend`：0 = alpha 混合 */
static float g_mvp[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
/** `batchmv` 那一格：模型视图（`u_mv`，`gl_ModelViewMatrix` / `gl_NormalMatrix` 用）。 */
static float g_mv[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
static int g_texunit;           /* `glactivetexture` 挑的那格单元 */

/** 一格顶点几个数（位置 4 / 颜色 4 / 纹理坐标 4 / 法向 4）—— 三档设备同一个契约。 */
#define EV_VS 16


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
    ev_err("内建着色器编不过：%s", log);    return 0;
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
  g_vpw = w;
  g_vph = h;
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

/* ── 登记那两张表（`(gfxdef 种类 名字 内容)`）──────────────────────────────────────
 *
 * 收到的着色器主体**已经是对齐后的 GLSL**（编译期翻好的，见 §13.7）—— 这一档只在编的
 * 时候补一行 `#version 410 core`（脚本自带 `#version` 的原样用）。**不在这儿翻**。
 */
void omni_ev_gl_def(const char *kind, const char *name, const char *text) {
  if (kind == NULL || name == NULL || text == NULL) return;
  if (strcmp(kind, "name") == 0) {
    /* 名字表：`名字` 是下标（十进制），`内容` 是那个串。 */
    if (g_nnm >= EV_MAXNAME) return;
    g_nm[g_nnm].idx = atoi(name);
    snprintf(g_nm[g_nnm].name, sizeof(g_nm[0].name), "%s", text);
    g_nnm++;
    return;
  }
  int k = strcmp(kind, "vert") == 0 ? 0 : (strcmp(kind, "frag") == 0 ? 1
    : (strcmp(kind, "geom") == 0 ? 2 : -1));
  if (k < 0 || g_nsh >= EV_MAXSH) return;
  snprintf(g_sh[g_nsh].name, sizeof(g_sh[0].name), "%s", name);
  g_sh[g_nsh].kind = k;
  g_sh[g_nsh].text = strdup(text);
  g_nsh++;
}

/** 名字表里那个下标对应的串（没有回 NULL）。 */
static const char *ev_name(int idx) {
  for (int i = 0; i < g_nnm; i++) if (g_nm[i].idx == idx) return g_nm[i].name;
  return NULL;
}

/**
 * 按**种类 + 名字**找登记过的那份着色器（回下标，没有回 -1）。
 *
 * **种类必须参与匹配**：`.pss` 里 `@v:drawsph` 与 `@f:drawsph` **同名是常态**
 * （`tigrou/balls2k.pss` 就是 `glsetshader("drawsph","drawsph")`）—— 只按名字找的话
 * 顶点与片元会拿到同一份，编出来是 `gl_Position 未声明` 那种错（踩过）。
 */
static int ev_sh_by_name(const char *name, int kind) {
  if (name == NULL) return -1;
  for (int i = 0; i < g_nsh; i++) {
    if (g_sh[i].kind == kind && strcmp(g_sh[i].name, name) == 0) return i;
  }
  return -1;
}

/** 第一份某一类的着色器（脚本没挑过时的默认那一对）。 */
static int ev_first_of(int kind) {
  for (int i = 0; i < g_nsh; i++) if (g_sh[i].kind == kind) return i;
  return -1;
}

/** 编一份脚本的着色器：**只补一行头**（脚本自带 `#version` 的原样用）。 */
static GLuint ev_compile_user(GLenum stage, const char *src) {
  if (strstr(src, "#version") != NULL) return ev_compile(stage, src);
  size_t n = strlen(src) + 32;
  char *buf = (char *)malloc(n);
  if (buf == NULL) return 0;
  snprintf(buf, n, "#version 410 core\n%s", src);
  GLuint s = ev_compile(stage, buf);
  free(buf);
  return s;
}

/**
 * 这一段原文是 **ARB 汇编**（`!!ARBvp1.0` / `!!ARBfp1.0`）不是 GLSL 吗？
 *
 * `ken/` 有 5 份把 `@v:`/`@f:` 段写成 ARB 汇编。core profile 没有那条路，参考实现也没有
 * （`c_impl/src/render/gl_renderer.c:1131` 编不过就留着上一格 program = 内建那对）。
 * 所以**认出来就退回内建那对** —— 只认 `!!ARB` 这一个特征，不做"编不过就悄悄退"
 * （那会把我们自己的 GLSL bug 藏起来）。口径：§19.2。
 */
static int ev_is_arb(const char *s) {
  if (s == NULL) return 0;
  while (*s == ' ' || *s == '\t' || *s == '\r' || *s == '\n') s++;
  return strncmp(s, "!!ARB", 5) == 0;
}

/**
 * 挑一对着色器、编好链好（一对只编一次）。回 0 = 不成（话在 `g_err` 里）。
 *
 * **采样器按名字约定接单元**（与 WebGL2 那一档同一句话）：`tex0..tex7` 那几个 uniform
 * 设成 0..7 号纹理单元 —— PolyDraw 的脚本就是 `glactivetexture(GL_TEXTURE0+i);
 * glbindtexture(i)` 加片元里 `uniform sampler2D tex0`，除此之外没有别的绑定办法。
 */
static GLuint ev_use_program(int vi, int fi) {
  if (vi < 0 || fi < 0) { ev_err("glsetshader：没有这一对着色器（缺 @v 或 @f 区段）", NULL); return 0; }
  /* ARB 汇编那一档：退回内建那对（它收的也是"物体坐标 + `u_mvp`"，正好对得上）。 */
  if (ev_is_arb(g_sh[vi].text) || ev_is_arb(g_sh[fi].text)) { g_cur = g_prog; return g_prog; }
  for (int i = 0; i < g_nprogs; i++) {
    if (g_progs[i].vi == vi && g_progs[i].fi == fi) { g_cur = g_progs[i].prog; return g_cur; }
  }
  if (g_nprogs >= EV_MAXPROG) { ev_err("glsetshader：program 太多（上限 16）", NULL); return 0; }
  GLuint vs = ev_compile_user(GL_VERTEX_SHADER, g_sh[vi].text);
  GLuint fs = ev_compile_user(GL_FRAGMENT_SHADER, g_sh[fi].text);
  if (vs == 0 || fs == 0) return 0;
  GLuint p = glCreateProgram();
  glAttachShader(p, vs);
  glAttachShader(p, fs);
  glLinkProgram(p);
  GLint ok = 0;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    /* **日志要够长**：Apple 的链接器先吐一串 `WARNING: Output of vertex shader 'x' not read
       by fragment shader`，真正的 `ERROR:` 在后头 —— 缓冲太小的话只看得见那句警告，
       会把人引到"不许有没人读的 out"那条岔路上去（踩过）。 */
    char log[4096];
    GLsizei n = 0;
    glGetProgramInfoLog(p, sizeof(log) - 1, &n, log);
    log[n] = 0;
    ev_err("glsetshader：program 链不上：%s", log);
    return 0;
  }
  glUseProgram(p);
  for (int i = 0; i < 8; i++) {
    char nm[8];
    snprintf(nm, sizeof(nm), "tex%d", i);
    GLint loc = glGetUniformLocation(p, nm);
    if (loc >= 0) glUniform1i(loc, i);
  }
  g_progs[g_nprogs].vi = vi;
  g_progs[g_nprogs].fi = fi;
  g_progs[g_nprogs].prog = p;
  g_nprogs++;
  g_cur = p;
  return p;
}

/**
 * **该类里的第 n 份**（照原版 `tsec[].cnt` 的口径 —— 那是分类计数，不是全表下标）。
 * 没有那么多份回 -1，由调用方夹成第 0 份（`setshader_int` 就是这么夹的）。
 */
static int ev_nth_of(int kind, int n) {
  int k = 0;
  for (int i = 0; i < g_nsh; i++) {
    if (g_sh[i].kind != kind) continue;
    if (k == n) return i;
    k++;
  }
  return -1;
}

/**
 * `glsetshader(…)` 的一格实参落到哪一份着色器上。`kind` 是要哪一类（0 顶点 / 1 片元）。
 *
 * 两条路，都照 `polydraw.c`：
 *   * 名字那一档（`kglsetshader3`）：在区段表里按**类别 + 名字**找（`ev_sh_by_name`）；
 *   * 数字那一档（`qglsetshader`）：**该类里的第 idx 份**（`tsec[].cnt`）——
 *     从前这儿用的是**全表下标**，于是 `glsetshader(0)` 把片元那一格指到了 `@v` 那份，
 *     编出来是 `gl_Position 未声明`（`examples/03_custom_shader.pss` 就卡在这儿）。
 * 越界夹成第 0 份（`setshader_int` 里 `sh0/sh2 >= shadn[] -> 0` 那两句）。
 */
static int ev_sh_at(double v, int kind) {
  int idx = (int)v;
  int i = ev_sh_by_name(ev_name(idx), kind);
  if (i >= 0) return i;
  i = ev_nth_of(kind, idx);
  return i >= 0 ? i : ev_first_of(kind);
}

/**
 * `glsetshader(…)`：挑一对。回 0 = 成了。
 * **负下标 = "第一对"** —— 语言那一侧的 `gl_quad` 在脚本没挑过 program 时发的那句
 * （`glquad` 在 PolyDraw 里本来就默认拿 `@v`/`@f` 那一对）。
 */
int omni_ev_gl_shader(int argc, const double *args) {
  if (!g_on) return 1;
  CGLSetCurrentContext(g_ctx);
  if (argc <= 0 || args == NULL) return 1;
  if (argc == 1 && (int)args[0] < 0) {
    return ev_use_program(ev_first_of(0), ev_first_of(1)) == 0 ? 1 : 0;
  }
  if (argc == 1) {
    /* `qglsetshader(d)` = `setshader_int(0, -1, (int)d)`（`polydraw.c:1072`）：
       **顶点固定取第 0 份**、片元取**这一类里第 d 份**。
       这一档**不许查名字表**：一格实参那一档在原版里就是个整数（`GLSETSHADER()`），
       而方言把串换成了名字表下标 —— 两者的数字空间是重的。查名字表的话
       `qglsetshader(0)` 会撞上"第 0 个内部到的串"（`tigrou/balls2k.pss` 里那格是
       `"drawsph"`），于是配出 `@v:lines` + `@f:drawsph`，链接器报
       `Input of fragment shader 'n' not written by vertex shader`（踩过）。 */
    int fi = ev_nth_of(1, (int)args[0]);
    if (fi < 0) fi = ev_first_of(1);
    return ev_use_program(ev_first_of(0), fi) == 0 ? 1 : 0;
  }
  int vi = ev_sh_at(args[0], 0);
  int fi = ev_sh_at(argc >= 3 ? args[2] : args[1], 1);
  return ev_use_program(vi, fi) == 0 ? 1 : 0;
}

/** 脚本还没挑过 program 时，替它挑第一对（uniform/attrib 那两格要当前 program）。 */
static int ev_need_prog(void) {
  if (g_cur != 0) return 1;
  return ev_use_program(ev_first_of(0), ev_first_of(1)) != 0;
}

/** `glgetuniformloc(名字下标)` -> 一格句柄（**按 program 记**）。回 -1 = 不认得那个下标。 */
double omni_ev_gl_uniloc(double idx) {
  if (!g_on) return -1.0;
  CGLSetCurrentContext(g_ctx);
  const char *nm = ev_name((int)idx);
  if (nm == NULL || !ev_need_prog()) return -1.0;
  GLint loc = glGetUniformLocation(g_cur, nm);
  for (int i = 0; i < g_nuni; i++) {
    if (g_uni[i].prog == g_cur && g_uni[i].loc == loc && loc >= 0) return (double)i;
  }
  if (g_nuni >= EV_MAXUNI) return -1.0;
  g_uni[g_nuni].prog = g_cur;
  g_uni[g_nuni].loc = loc;
  return (double)(g_nuni++);
}

/** `gluniform{1,2,3,4}f(句柄, …)`。着色器里没用到那个名字（loc < 0）就静默 —— 与 GL 同。 */
int omni_ev_gl_uni(double h, int n, const double *v) {
  if (!g_on || v == NULL) return 1;
  int i = (int)h;
  if (i < 0 || i >= g_nuni) return 1;
  if (g_uni[i].loc < 0) return 0;
  CGLSetCurrentContext(g_ctx);
  glUseProgram(g_uni[i].prog);
  if (n == 1) glUniform1f(g_uni[i].loc, (float)v[0]);
  else if (n == 2) glUniform2f(g_uni[i].loc, (float)v[0], (float)v[1]);
  else if (n == 3) glUniform3f(g_uni[i].loc, (float)v[0], (float)v[1], (float)v[2]);
  else glUniform4f(g_uni[i].loc, (float)v[0], (float)v[1], (float)v[2], (float)v[3]);
  return 0;
}

/** `gluniform1i(句柄, 整数)`：整数那一档（采样器与开关位都走它 —— `ken/drawsph.pss`）。 */
int omni_ev_gl_uni1i(double h, double v) {
  if (!g_on) return 1;
  int i = (int)h;
  if (i < 0 || i >= g_nuni) return 1;
  if (g_uni[i].loc < 0) return 0;
  CGLSetCurrentContext(g_ctx);
  glUseProgram(g_uni[i].prog);
  glUniform1i(g_uni[i].loc, (GLint)v);
  return 0;
}

/** `glgetattribloc(名字下标)` -> 属性在当前 program 里的位置（就是 GL 那个号）。 */double omni_ev_gl_attrloc(double idx) {
  if (!g_on) return -1.0;
  CGLSetCurrentContext(g_ctx);
  const char *nm = ev_name((int)idx);
  if (nm == NULL || !ev_need_prog()) return -1.0;
  return (double)glGetAttribLocation(g_cur, nm);
}

/** `glvertexattrib*f(位置, …)`：记下那格**常量属性**，画的时候一次性摆上。 */
int omni_ev_gl_attr(double loc, const double *v) {
  if (!g_on || v == NULL) return 1;
  GLint k = (GLint)loc;
  if (k < 0) return 0;
  for (int i = 0; i < g_nattr; i++) {
    if (g_attr[i].loc == k) {
      for (int j = 0; j < 4; j++) g_attr[i].v[j] = (float)v[j];
      return 0;
    }
  }
  if (g_nattr >= EV_MAXATTR) return 1;
  g_attr[g_nattr].loc = k;
  for (int j = 0; j < 4; j++) g_attr[g_nattr].v[j] = (float)v[j];
  g_nattr++;
  return 0;
}

/** `batchprog` / `batchmvp 列 m0..m3` / `batchmv 列 m0..m3` / `batchblend`。 */
void omni_ev_gl_prog(int on) { g_useprog = on ? 1 : 0; }

void omni_ev_gl_mvp(int col, double m0, double m1, double m2, double m3) {
  if (col < 0 || col > 3) return;
  g_mvp[col * 4 + 0] = (float)m0;
  g_mvp[col * 4 + 1] = (float)m1;
  g_mvp[col * 4 + 2] = (float)m2;
  g_mvp[col * 4 + 3] = (float)m3;
}

/** 模型视图那一格（`u_mv`）—— `gl_ModelViewMatrix` 与 `gl_NormalMatrix` 都从它来。 */
void omni_ev_gl_mv(int col, double m0, double m1, double m2, double m3) {
  if (col < 0 || col > 3) return;
  g_mv[col * 4 + 0] = (float)m0;
  g_mv[col * 4 + 1] = (float)m1;
  g_mv[col * 4 + 2] = (float)m2;
  g_mv[col * 4 + 3] = (float)m3;
}

void omni_ev_gl_blend(int mode) { g_blend = mode; }

/* ── 纹理（`(gfxtex 槽 宽 高 层 格 数组)`）─────────────────────────────────────────
 *
 * 与 `src/studio/gfx-gl.js` 的 `texIn` 逐句对应。`格` 是 `KGL_*` 那个打包好的数：
 * 低 4 位像素格式、`0xf0` 过滤、`0xf00` 环绕（`polydraw.c:190-193`）。
 * **槽是脚本自己编号的**（`glbindtexture(槽)` 用的就是它）。
 *
 * 与 WebGL2 那一档的唯一差别：真 GL 有 `GL_BGRA`，但一格 double 是一格打包好的像素、
 * 摊开那一步两边都要做 —— 所以这儿也摊成 RGBA（同一份算法，不给自己留第二条路）。
 */
static int ev_tex_slot(int slot) {
  for (int i = 0; i < g_ntex; i++) if (g_tex[i].slot == slot) return i;
  if (g_ntex >= EV_MAXTEX) return -1;
  g_tex[g_ntex].slot = slot;
  g_tex[g_ntex].tar = GL_TEXTURE_2D;
  glGenTextures(1, &g_tex[g_ntex].id);
  return g_ntex++;
}

/** 过滤与环绕那两段位（`0xf0` / `0xf00`）-> GL 的参数。回 1 = 要 mipmap。 */
static int ev_tex_params_t(GLenum tar, int fmt) {
  int filt = fmt & 0xf0;
  int wrap = fmt & 0xf00;
  int mip = filt >= 0x20;
  glTexParameteri(tar, GL_TEXTURE_MAG_FILTER, filt == 0x10 ? GL_NEAREST : GL_LINEAR);
  glTexParameteri(tar, GL_TEXTURE_MIN_FILTER,
                  mip ? GL_LINEAR_MIPMAP_LINEAR : (filt == 0x10 ? GL_NEAREST : GL_LINEAR));
  GLint w = wrap == 0x100 ? GL_MIRRORED_REPEAT : (wrap == 0 ? GL_REPEAT : GL_CLAMP_TO_EDGE);
  glTexParameteri(tar, GL_TEXTURE_WRAP_S, w);
  glTexParameteri(tar, GL_TEXTURE_WRAP_T, w);
  if (tar == GL_TEXTURE_CUBE_MAP) glTexParameteri(tar, GL_TEXTURE_WRAP_R, w);
  return mip;
}

static int ev_tex_params(int fmt) { return ev_tex_params_t(GL_TEXTURE_2D, fmt); }

/**
 * **一张图 -> 一块 RGBA8**（宽高写回 `*w`/`*h`，回 NULL = 读不到/解不开；调用方 `free`）。
 *
 * 用这台机器的 ImageIO（`CGImageSource`）—— 与上下文用 CGL 同一条道理：平台给的直接用。
 * 画进 `CGBitmapContext` 那一步顺手把方向摆正：CG 的原点在左下、GL 的纹理坐标原点也在
 * 左下，但 `CGContextDrawImage` 出来的行序与我们要的相反，所以**按行倒着抄一趟**
 * （与 `omni_ev_gl_read` 里翻正那一手同一个理）。
 */
static unsigned char *ev_img_load(const char *path, int *w, int *h) {
  CFStringRef sp = CFStringCreateWithCString(NULL, path, kCFStringEncodingUTF8);
  if (sp == NULL) return NULL;
  CFURLRef url = CFURLCreateWithFileSystemPath(NULL, sp, kCFURLPOSIXPathStyle, false);
  CFRelease(sp);
  if (url == NULL) return NULL;
  CGImageSourceRef src = CGImageSourceCreateWithURL(url, NULL);
  CFRelease(url);
  if (src == NULL) return NULL;
  CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
  CFRelease(src);
  if (img == NULL) return NULL;
  int iw = (int)CGImageGetWidth(img);
  int ih = (int)CGImageGetHeight(img);
  if (iw <= 0 || ih <= 0) { CGImageRelease(img); return NULL; }
  unsigned char *buf = (unsigned char *)malloc((size_t)4 * (size_t)iw * (size_t)ih);
  unsigned char *out = (unsigned char *)malloc((size_t)4 * (size_t)iw * (size_t)ih);
  if (buf == NULL || out == NULL) {
    free(buf); free(out); CGImageRelease(img); return NULL;
  }
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef ctx = CGBitmapContextCreate(buf, (size_t)iw, (size_t)ih, 8, (size_t)4 * (size_t)iw,
                                           cs, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(cs);
  if (ctx == NULL) { free(buf); free(out); CGImageRelease(img); return NULL; }
  CGRect r;
  r.origin.x = 0; r.origin.y = 0; r.size.width = iw; r.size.height = ih;
  CGContextDrawImage(ctx, r, img);
  CGContextRelease(ctx);
  CGImageRelease(img);
  for (int y = 0; y < ih; y++) {
    memcpy(out + (size_t)4 * (size_t)iw * (size_t)y,
           buf + (size_t)4 * (size_t)iw * (size_t)(ih - 1 - y), (size_t)4 * (size_t)iw);
  }
  free(buf);
  *w = iw;
  *h = ih;
  return out;
}

int omni_ev_gl_tex(int slot, int w, int h, int d, int fmt, const double *px) {
  if (!g_on || px == NULL) return 1;
  CGLSetCurrentContext(g_ctx);
  int i = ev_tex_slot(slot);
  if (i < 0) return 1;
  /* **3D 纹理那一档**（`ken/texture3d.pss` 是 64³ 那一块）：`层 > 1` 就是它
     （`kglsettexarray3` 的第三格就是 zsiz，`polydraw.c:1400`）。 */
  GLenum tar = d > 1 ? GL_TEXTURE_3D : GL_TEXTURE_2D;
  g_tex[i].tar = tar;
  glActiveTexture(GL_TEXTURE0 + g_texunit);
  glBindTexture(tar, g_tex[i].id);
  long n = (long)w * (long)h * (long)(d > 0 ? d : 1);
  int kind = fmt & 15;
  if (kind == 0) {
    unsigned char *b = (unsigned char *)malloc((size_t)n * 4);
    if (b == NULL) return 1;
    for (long k = 0; k < n; k++) {
      unsigned int v = (unsigned int)(long long)px[k];
      b[k * 4] = (unsigned char)((v >> 16) & 255);
      b[k * 4 + 1] = (unsigned char)((v >> 8) & 255);
      b[k * 4 + 2] = (unsigned char)(v & 255);
      /* **alpha 原样收**（0 就是透明）—— 参考那一侧 `kglsettexarray*` 把那四个字节
         照原样交给 `glTexSubImage`，没有"0 当不透明"这条。从前这儿写着
         `al == 0 ? 255 : al`，于是 `ken/texture3d.pss` 那块体素（`rgba(r,g,b,(issol!=0)*48)`
         —— 空的地方 alpha 就是 0）整块都变实心，一盏灯画成一个渐变方块。
         脚本用 `rgb()` 造的纹理（alpha 0）不受影响：那种脚本不开混合，alpha 没人看。 */
      b[k * 4 + 3] = (unsigned char)((v >> 24) & 255);
    }
    if (tar == GL_TEXTURE_3D) {
      glTexImage3D(tar, 0, GL_RGBA8, w, h, d, 0, GL_RGBA, GL_UNSIGNED_BYTE, b);
    } else {
      glTexImage2D(tar, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, b);
    }
    free(b);
  } else if (kind == 1) {
    unsigned char *b = (unsigned char *)malloc((size_t)n);
    if (b == NULL) return 1;
    for (long k = 0; k < n; k++) {
      double v = px[k];
      b[k] = (unsigned char)(v < 0 ? 0 : (v > 255 ? 255 : (int)v));
    }
    if (tar == GL_TEXTURE_3D) glTexImage3D(tar, 0, GL_R8, w, h, d, 0, GL_RED, GL_UNSIGNED_BYTE, b);
    else glTexImage2D(tar, 0, GL_R8, w, h, 0, GL_RED, GL_UNSIGNED_BYTE, b);
    free(b);
  } else if (kind == 4 || kind == 5) {
    long per = kind == 5 ? 4 : 1;
    float *f = (float *)malloc(sizeof(float) * (size_t)(n * per));
    if (f == NULL) return 1;
    for (long k = 0; k < n * per; k++) f[k] = (float)px[k];
    GLint ifmt = kind == 4 ? GL_R32F : GL_RGBA32F;
    GLenum efmt = kind == 4 ? GL_RED : GL_RGBA;
    if (tar == GL_TEXTURE_3D) glTexImage3D(tar, 0, ifmt, w, h, d, 0, efmt, GL_FLOAT, f);
    else glTexImage2D(tar, 0, ifmt, w, h, 0, efmt, GL_FLOAT, f);
    free(f);
  } else {
    ev_err("gfxtex：这一档没接 KGL 格式（有的是 BGRA32(0)/CHAR(1)/FLOAT(4)/VEC4(5)）", NULL);
    return 1;
  }
  if (ev_tex_params_t(tar, fmt)) glGenerateMipmap(tar);
  g_tex[i].w = w;
  g_tex[i].h = h;
  g_tex[i].fmt = fmt;
  return 0;
}

/**
 * **文件纹理**（`glsettex(槽,"earth.jpg")`，`polydraw.c:1279` 的 `kglsettex2`）。
 *
 * 解码用的是**这台机器上的 ImageIO**（`CGImageSource`）—— 与 CGL 那一格同一条道理：
 * 平台给的东西直接用，不自己再写一份 JPEG/PNG 解码器（参考实现那边用的是 stb_image）。
 * 于是这一刀只有**一份实现**：C 腿直接链它、js/interp 两条腿走 N-API 那个外挂。
 *
 * 立方体贴图的判据照参考：**竖排 6 面**（`宽*6 == 高`），面序 +X,-X,+Y,-Y,+Z,-Z
 * （`c_impl/src/render/gl_renderer.c:1504-1563`；原版是 `CreateEmptyTexture` 里定的，
 * 那一格不在 `polydraw_src` 里）。
 *
 * `colmode` 就是 `KGL_*` 那个打包好的数；一格串那一档的默认是 `KGL_MIPMAP+KGL_REPEAT`
 * （`polydraw.c:1346`）—— 默认值由语言那一侧给，这儿只照办。
 * 回 0 = 成了；读不到/解不开回非 0（**不画占位图** —— 原版那张里有 `rand()` 噪声，
 * 逐像素对照本来就不成立，见 §20.3）。
 */
/**
 * 找并解开一张图：**先按给的路径，找不到就一级一级往上找**（回 NULL = 都没有）。
 *
 * 为什么要往上找：脚本里写的是相对路径，而素材常常摆在**语料根**而不是脚本旁边
 * （`ken/cubetex.pss` 写 `"kensky.jpg"`，那个文件在 `ken/` 的上一级）——
 * 原版的 `kzopen` 是按 cwd 找的，而它本来就在语料根上跑。
 */
static unsigned char *ev_img_find(const char *path, int *w, int *h) {
  unsigned char *p = ev_img_load(path, w, h);
  if (p != NULL) return p;
  char buf[1024];
  snprintf(buf, sizeof(buf), "%s", path);
  for (int lvl = 0; lvl < 8; lvl++) {
    char *base = strrchr(buf, '/');
    if (base == NULL) break;
    *base = 0;
    char *up = strrchr(buf, '/');
    if (up == NULL) break;
    /* `.../ken/kensky.jpg` -> `.../kensky.jpg` -> `.../..` 那样一级一级上去。 */
    memmove(up + 1, base + 1, strlen(base + 1) + 1);
    p = ev_img_load(buf, w, h);
    if (p != NULL) return p;
  }
  return NULL;
}

int omni_ev_gl_texfile(int slot, const char *path, int colmode) {
  if (!g_on || path == NULL) return 1;
  CGLSetCurrentContext(g_ctx);
  int w = 0, h = 0;
  unsigned char *px = ev_img_find(path, &w, &h);
  if (px == NULL) { ev_err("glsettex：读不到/解不开 '%s'", path); return 1; }
  int i = ev_tex_slot(slot);
  if (i < 0) { free(px); return 1; }
  int cube = (w > 0) && (w * 6 == h);
  GLenum tar = cube ? GL_TEXTURE_CUBE_MAP : GL_TEXTURE_2D;
  g_tex[i].tar = tar;
  glActiveTexture(GL_TEXTURE0 + g_texunit);
  glBindTexture(tar, g_tex[i].id);
  if (cube) {
    static const GLenum faces[6] = {
      GL_TEXTURE_CUBE_MAP_POSITIVE_X, GL_TEXTURE_CUBE_MAP_NEGATIVE_X,
      GL_TEXTURE_CUBE_MAP_POSITIVE_Y, GL_TEXTURE_CUBE_MAP_NEGATIVE_Y,
      GL_TEXTURE_CUBE_MAP_POSITIVE_Z, GL_TEXTURE_CUBE_MAP_NEGATIVE_Z,
    };
    int fh = h / 6;
    for (int f = 0; f < 6; f++) {
      glTexImage2D(faces[f], 0, GL_RGBA8, w, fh, 0, GL_RGBA, GL_UNSIGNED_BYTE,
                   px + (size_t)4 * (size_t)w * (size_t)fh * (size_t)f);
    }
  } else {
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
  }
  if (ev_tex_params_t(tar, colmode)) glGenerateMipmap(tar);
  g_tex[i].w = w;
  g_tex[i].h = h;
  g_tex[i].fmt = colmode;
  free(px);
  return 0;
}

/**
 * **`gluniform{1..4}{f,i}v(句柄, 个数, 数组)`**（§19.1）：一次喂一整排 uniform。
 * `comps` 是每格几个分量、`isint` 说走 `glUniform*iv` 还是 `*fv`、`n` 是几格。
 */
int omni_ev_gl_univ(double h, int comps, int isint, long n, const double *v) {
  if (!g_on || v == NULL || n <= 0 || comps < 1 || comps > 4) return 1;
  CGLSetCurrentContext(g_ctx);
  int i = (int)h;
  if (i < 0 || i >= g_nuni) return 1;
  if (g_uni[i].loc < 0) return 0;
  GLint loc = g_uni[i].loc;
  glUseProgram(g_uni[i].prog);
  long total = n * comps;
  if (isint) {
    GLint *b = (GLint *)malloc(sizeof(GLint) * (size_t)total);
    if (b == NULL) return 1;
    for (long i = 0; i < total; i++) b[i] = (GLint)v[i];
    if (comps == 1) glUniform1iv(loc, (GLsizei)n, b);
    else if (comps == 2) glUniform2iv(loc, (GLsizei)n, b);
    else if (comps == 3) glUniform3iv(loc, (GLsizei)n, b);
    else glUniform4iv(loc, (GLsizei)n, b);
    free(b);
    return 0;
  }
  float *b = (float *)malloc(sizeof(float) * (size_t)total);
  if (b == NULL) return 1;
  for (long i = 0; i < total; i++) b[i] = (float)v[i];
  if (comps == 1) glUniform1fv(loc, (GLsizei)n, b);
  else if (comps == 2) glUniform2fv(loc, (GLsizei)n, b);
  else if (comps == 3) glUniform3fv(loc, (GLsizei)n, b);
  else glUniform4fv(loc, (GLsizei)n, b);
  free(b);
  return 0;
}

/**
 * **`glgettex(槽, &数组, 宽, 高, 格)`**（§19.1，**往里写**的那一档）。
 *
 * 口径照原版 `kglgettexarray2`（`polydraw.c:1348`），两条要紧的：
 *
 * 1. **最后那格 `coltype` 是不看的** —— 一格几个 double 由**这一槽自己的格**说
 *    （`tex[itex].coltype`）：`KGL_VEC4` 一像素 4 个 float，别的都是一像素一格。
 *    所以脚本写 `glgettex(2,buf,XT,YT,KGL_VEC4)` 而那一槽是 `KGL_FLOAT` 时，
 *    出来的就是一像素一格 —— 跟着纹理走，不跟着实参走。
 * 2. **写回几格由这一层算**（回值就是它，出错回 -1）：宿主那一侧（N-API / omni_fmt）
 *    只有数组长度，算不出这个数。
 */
int omni_ev_gl_gettex(int slot, int w, int h, long cap, double *out) {
  if (!g_on || out == NULL || w < 1 || h < 1) return -1;
  CGLSetCurrentContext(g_ctx);
  int i = -1;
  for (int k = 0; k < g_ntex; k++) if (g_tex[k].slot == slot) i = k;
  if (i < 0) return -1;
  long n = (long)w * (long)h;
  if (n > (long)g_tex[i].w * (long)g_tex[i].h) return -1;
  int kind = g_tex[i].fmt & 15;
  long per = kind == 5 ? 4 : 1;
  if (n * per > cap) return -1;
  GLenum efmt = GL_BGRA;
  GLenum type = GL_UNSIGNED_BYTE;
  long bpp = 4;
  if (kind == 1) { efmt = GL_RED; type = GL_UNSIGNED_BYTE; bpp = 1; }
  else if (kind == 4) { efmt = GL_RED; type = GL_FLOAT; bpp = 4; }
  else if (kind == 5) { efmt = GL_RGBA; type = GL_FLOAT; bpp = 16; }
  else if (kind != 0) {
    ev_err("glgettex：这一档没接 KGL 格式（有的是 BGRA32(0)/CHAR(1)/FLOAT(4)/VEC4(5)）", NULL);
    return -1;
  }
  unsigned char *b = (unsigned char *)malloc((size_t)(n * bpp));
  if (b == NULL) return -1;
  glActiveTexture(GL_TEXTURE0 + g_texunit);
  glBindTexture(g_tex[i].tar, g_tex[i].id);
  glGetTexImage(g_tex[i].tar, 0, efmt, type, b);
  if (kind == 0) {
    /* `GL_BGRA` + 小端 ⇒ 一格 uint 正好是 0xAARRGGBB（与参考那一行逐字相同）。 */
    for (long k = 0; k < n; k++) out[k] = (double)*(unsigned int *)(b + k * 4);
  } else if (kind == 1) {
    for (long k = 0; k < n; k++) out[k] = (double)b[k];
  } else {
    for (long k = 0; k < n * per; k++) out[k] = (double)*(float *)(b + k * 4);
  }
  free(b);
  return (int)(n * per);

}

/**
 * **抓屏那一族**（`glcapture()` / `glcaptureend(槽)`，§22）。
 *
 * 两份参考在这一格**不是一回事**，这儿跟的是 `c_impl`（也就是逐像素那把尺子）：
 *
 * * `polydraw.c:1195` 的 `qglCapture` 把视口换成 `captexsiz²`（512 往下取到 2 的幂）、
 *   把 PROJECTION 换成定死的 `gluPerspective(45,1,0.1,1000)`、MODELVIEW 换成
 *   `glScalef(高/宽,1,1)`；
 * * `c_impl/src/render/gl_renderer.c:1652` 起是**整帧**：视口不动、矩阵不动，
 *   只把画布清成黑，`glcaptureend` 那一刻把整帧拷进纹理。
 *
 * **为什么跟 c_impl**：原版那个 `glcapture()` 是**零参**的（`myext[]` 里写着
 * `"GLCAPTURE()"`），而 `qglCapture(double dcaptexsiz)` 读的是一格根本没传的实参 ——
 * 于是 `captexsiz` 拿到的是栈上的垃圾，视口边长在原版里就是不确定的。这一格
 * "以 polydraw_src 为准"定不下来；而语料自己的注释（`examples/opengl/25_offscreen_capture.pss`：
 * "glcapture() grabs the current framebuffer into a texture id"）说的正是整帧那一种。
 * 量过：按 polydraw_src 那一种做，这一族六份与参考的差**一律变大**
 * （tree 38.6→64.4、gears 40→82、clock 16.7→40.6、texture 54→全黑）。
 */
int omni_ev_gl_capbegin(int siz) {
  if (!g_on) return 0;
  (void)siz;
  CGLSetCurrentContext(g_ctx);
  g_capw = g_w;
  g_caph = g_h;
  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  glViewport(0, 0, g_vpw, g_vph);
  /* 从干净的黑底起（照 c_impl）：后处理那一趟按 >1 的坐标采样时，采到的只该是
     这一趟画下来的东西，不该是上一帧留下的。 */
  glClearColor(0, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
  return 0;
}

int omni_ev_gl_capend(int slot) {
  if (!g_on) return 0;
  CGLSetCurrentContext(g_ctx);
  int i = ev_tex_slot(slot);
  if (i < 0) return 1;
  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  g_tex[i].tar = GL_TEXTURE_2D;
  glActiveTexture(GL_TEXTURE0 + g_texunit);
  glBindTexture(GL_TEXTURE_2D, g_tex[i].id);
  /* 纹理的第 0 行是帧缓冲的**最下面**一行 —— 与 `glquad()` 那六个顶点的纹理坐标
     （t=0 在下）对得上，所以不用翻。 */
  glCopyTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 0, 0, g_capw, g_caph, 0);
  /* `KGL_BGRA32`（格 0）= LINEAR + REPEAT：后处理那几份着色器按 >1 的坐标采样
     （`clock.pss` 是 3.0*uv），REPEAT 才不会糊成边上那一圈。 */
  ev_tex_params_t(GL_TEXTURE_2D, 0);
  g_tex[i].w = g_capw;
  g_tex[i].h = g_caph;
  g_tex[i].fmt = 0;
  return 0;
}

/** `glbindtexture(槽)` / `glactivetexture(单元)`：把那一槽挂到现在这格单元上。 */
void omni_ev_gl_bindtex(int slot) {
  if (!g_on) return;
  CGLSetCurrentContext(g_ctx);
  int i = ev_tex_slot(slot);
  if (i < 0) return;
  glActiveTexture(GL_TEXTURE0 + g_texunit);
  glBindTexture(g_tex[i].tar, g_tex[i].id);
}

void omni_ev_gl_activetex(int unit) {
  if (!g_on) return;
  g_texunit = unit < 0 ? 0 : (unit > 7 ? 7 : unit);
  CGLSetCurrentContext(g_ctx);
  glActiveTexture(GL_TEXTURE0 + g_texunit);
}





/**
 * **收一段顶点批**：一格顶点 16 个 double（位置 4 裁剪空间 / 颜色 4 / 纹理坐标 4 /
 * 法向 4），类 0 线段 / 1 三角 / 2 点。这一层只做"转 float + 上传 + 一次 draw"。
 *
 * 点那一档用 `GL_POINTS` + `glPointSize(1)`（legacy 上下文里它是可靠的 ——
 * WebGL 那一档不可靠，所以那边把点摊成 1×1 四边形；两档设备的"一个点多大"都是 1 像素）。
 */
void omni_ev_gl_batch(int kind, long n, const double *verts) {
  if (!g_on || n <= 0 || verts == NULL) return;
  CGLSetCurrentContext(g_ctx);
  float *buf = (float *)malloc(sizeof(float) * EV_VS * (size_t)n);
  if (buf == NULL) return;
  for (long i = 0; i < n * EV_VS; i++) buf[i] = (float)verts[i];

  glBindFramebuffer(GL_FRAMEBUFFER, g_fbo);
  glBindVertexArray(g_vao);
  glViewport(0, 0, g_vpw, g_vph);
  if (g_depth_test) glEnable(GL_DEPTH_TEST);
  else glDisable(GL_DEPTH_TEST);
  /* 这一段用哪格 program 由 `batchprog` 说：0 是内建那对（位置**已是裁剪空间** ⇒
     `u_mvp` 单位矩阵），≠0 是脚本 `glsetshader` 挑的那格（位置是**物体坐标**，
     `u_mvp` 由语言那一侧发的四句 `batchmvp` 给）。 */
  static const float I4[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
  GLuint prog = g_prog;
  const float *m = I4;
  const float *mv = I4;
  if (g_useprog && (g_cur != 0 || ev_need_prog())) { prog = g_cur; m = g_mvp; mv = g_mv; }
  glUseProgram(prog);
  GLint mvp = glGetUniformLocation(prog, "u_mvp");
  if (mvp >= 0) glUniformMatrix4fv(mvp, 1, GL_FALSE, m);
  /* `u_mv` 是模型视图那一格（`gl_ModelViewMatrix` / `gl_NormalMatrix` 用它）——
     只有脚本那格着色器引用了它才有位置，内建那对没有。 */
  GLint mvloc = glGetUniformLocation(prog, "u_mv");
  if (mvloc >= 0) glUniformMatrix4fv(mvloc, 1, GL_FALSE, mv);
  /* 混合：`glquad(0)` 那一档要 alpha 混合（语言那一侧发的 `batchblend`）。 */
  if (g_blend == 0) {
    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  } else {
    glDisable(GL_BLEND);
  }

  glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(sizeof(float) * EV_VS * (size_t)n), buf,
               GL_STREAM_DRAW);
  const char *names[4] = { "a_pos", "a_col", "a_tex", "a_nrm" };
  GLint locs[4];
  for (int k = 0; k < 4; k++) {
    locs[k] = glGetAttribLocation(prog, names[k]);
    if (locs[k] < 0) continue;
    glEnableVertexAttribArray((GLuint)locs[k]);
    glVertexAttribPointer((GLuint)locs[k], 4, GL_FLOAT, GL_FALSE,
                          (GLsizei)(sizeof(float) * EV_VS),
                          (const void *)(size_t)(sizeof(float) * 4 * (size_t)k));
  }
  /* `glVertexAttrib*` 设的那几格是**常量属性**（数组关着时 GL 用的就是当前值）。 */
  for (int k = 0; k < g_nattr; k++) {
    glDisableVertexAttribArray((GLuint)g_attr[k].loc);
    glVertexAttrib4fv((GLuint)g_attr[k].loc, g_attr[k].v);
  }
  GLenum mode = kind == 0 ? GL_LINES : (kind == 2 ? GL_POINTS : GL_TRIANGLES);
  glDrawArrays(mode, 0, (GLsizei)n);
  for (int k = 0; k < 4; k++) if (locs[k] >= 0) glDisableVertexAttribArray((GLuint)locs[k]);
  glDisable(GL_BLEND);
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
