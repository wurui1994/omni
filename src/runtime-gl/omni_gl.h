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
#include <stdint.h>

#define OMNI_GL_REQ_VERSION 2

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

/* 标定用：一个铺满视口的三角，材质只填 emissive=(0.2,0.4,0.6)。Nlights 0 时
   fragment.glsl:248 直走 `outColor = emissive`，所以读回必须逐像素是 51/102/153。
   回 0 = 过。用来验属性按名字绑、int 属性走 I 版、UBO 手绑三步都对。 */
int omni_gl_geom_selftest(const char *shader_dir);

/* ── 场景（照抄 render.h 的内存布局，一个字节都别改） ──────────────────────
 *
 * asy 3.14 的顶点结构（render.h:51-71）。glmCommon.h **没有**定义
 * `GLM_FORCE_DEFAULT_ALIGNED_GENTYPES`，所以 vec3 是 12 字节 align 4、
 * 全部字段紧排、结构体不补洞：28 / 44 / 20。
 *
 * 注意 `omni_gl_cvertex` 前三个字段的偏移与 `omni_gl_mvertex` 完全一致
 * （0/12/24）—— glrender.cc:1006 设 normal 指针时对两者都写
 * `offsetof(MaterialVertex, normal)`，这个"巧合"是照抄的一部分，别动字段次序。 */
typedef struct { float position[3]; float normal[3]; int32_t material; } omni_gl_mvertex;
typedef struct { float position[3]; float normal[3]; int32_t material;
                 float color[4]; } omni_gl_cvertex;
typedef struct { float position[3]; float width; int32_t material; } omni_gl_pvertex;

/* Material（material.h）：四个 vec4 紧排 = 64 字节，std140 下正好逐字段对齐。 */
typedef struct {
  float diffuse[4];
  float emissive[4];
  float specular[4];
  float parameters[4];   /* (shininess, metallic, fresnel0, 未用) */
} omni_gl_material;

/* 一条 buffer：顶点数组 + uint32 索引。空的（nindices==0）整条跳过，
   与 `drawBuffer` 开头 `if(data.indices.empty()) return;` 一致。 */
typedef struct {
  const void *verts;
  size_t nverts;
  const uint32_t *indices;
  size_t nindices;
} omni_gl_buffer;

/* 一帧。六条 buffer 与 asy 的六个全局 buffer 一一对应，绘制次序写死在
   `omni_gl_draw` 里（glrender.cc:1123 `drawBuffers()` 的 ssbo==0 那一路）。
   矩阵一律 **double + 列主序**，与 asy 的 `glm::dmat4` 相同；上传时才截成 float
   （glrender.cc:911 `value_ptr(mat4(projViewMat))`）。 */
typedef struct {
  int version;
  int width, height;
  int samples;          /* MSAA；超过 GL_MAX_SAMPLES 会自动夹到上限 */
  float bg[4];

  double projViewMat[16];
  double viewMat[16];
  double normMat[9];

  const omni_gl_material *materials;
  int nmaterials;       /* = materials.size()，就是 `#define Nmaterials` 的值 */
  const float *light_dirs;    /* 3*nlights */
  const float *light_colors;  /* 3*nlights */
  int nlights;
  int orthographic;

  omni_gl_buffer point;        /* PointVertex,    pixelShader,       GL_POINTS */
  omni_gl_buffer line;         /* MaterialVertex, materialShader,    GL_LINES */
  omni_gl_buffer material;     /* MaterialVertex, materialShader,    GL_TRIANGLES */
  omni_gl_buffer color;        /* ColorVertex,    colorShader,       GL_TRIANGLES */
  omni_gl_buffer triangle;     /* ColorVertex,    generalShader,     GL_TRIANGLES */
  omni_gl_buffer transparent;  /* ColorVertex,    transparentShader, GL_TRIANGLES */
} omni_gl_scene;

/* 画一帧并把像素按 RGB8 紧排写进 out_rgb（width*height*3）。
   `shader_dir` 要指到 **shaders/GL**（根 shaders/ 那份是 Vulkan 的，Apple GL 4.1 编不过）。
   行序与 GL 一致：out_rgb[0] 是**左下角**。 */
int omni_gl_draw(const char *shader_dir, const omni_gl_scene *sc,
                 unsigned char *out_rgb);

#endif /* OMNI_GL_H */
