/* omni_gl.h —— `libomnigl`（三维那一档的 OpenGL 后端）与宿主之间的**唯一**约定。
 *
 * 主体运行时（`src/runtime/omni_r3.c` 那一侧）只 include 这个头、只用 dlsym 拿这三个符号，
 * **不 include 任何 GL/GLFW 的头、也不链任何 GL 库** —— 这样 `src/core/cli.js` 里
 * `runtimeObjects()` 那套统一 flags（tcc 那条腿也在其中）一个字都不用改。
 *
 * 版本号：结构一改就加一，插件里会当场比对拒绝，免得宿主与插件不同步时读到垃圾。
 */

#ifndef OMNI_GL_H
#define OMNI_GL_H

#include <stdarg.h>
#include <stddef.h>

#define OMNI_GL_REQ_VERSION 1

/* 上下文能力。`glsl_version` 是照 glrender.cc:1305 算的
   `(int)(100*atof(glGetString(GL_SHADING_LANGUAGE_VERSION))+0.5)`，
   拼 shader 头部的 `#version` 用它 —— 别写死（这台机器是 410，换机器会变）。 */
typedef struct {
  int glsl_version;
  int max_samples;
  char gl_version[128];
  char glsl_string[64];
  char renderer[128];
} omni_gl_info;

/* 一次渲染请求。现在只有"画多大、背景什么色、几个采样"——
   shader 与几何是下一块，加字段时记得把 OMNI_GL_REQ_VERSION 加一。 */
typedef struct {
  int version;
  int width, height;
  int samples;        /* MSAA 采样数；asy 是问设备要最大值，这台机器是 4 */
  float bg[4];
} omni_gl_req;

/* 三个对外符号（宿主按名字 dlsym）：
     omni_gl_probe   —— 建上下文并回报能力；建不起来回 -1，宿主据此回落 CPU 光栅器
     omni_gl_render  —— 渲一块，像素按 RGB8 紧排写进 out_rgb（大小 width*height*3）
     omni_gl_error   —— 最近一次失败的说明；没有失败回 NULL */
int omni_gl_probe(omni_gl_info *out);
int omni_gl_render(const omni_gl_req *req, unsigned char *out_rgb);
const char *omni_gl_error(void);

/* 标定用：把 asy 那八个 program 按它的 `#define` 组合（glrender.cc:265-352）编一遍，
   回没编过的个数（0 = 全过）。用来判定"asy 自己的 shader 在我们的上下文里能不能直接用"，
   免得盲写。宿主平时不调它。 */
int omni_gl_shaders_selftest(const char *shader_dir, int nlights, int nmaterials,
                             int orthographic);

#endif /* OMNI_GL_H */
