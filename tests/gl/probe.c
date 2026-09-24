/* tests/gl/probe.c —— **本机 OpenGL 设备那一档的探针**（`src/runtime-gl/omni_ev_gl.c`）
 *
 * 判的是"这台机器上离屏真拿到了像素"这一格：开 320×240 的 FBO、清成 `0x102030`、
 * 画一个红三角（裁剪空间 ±0.5），读回来数两种像素。
 *
 * 为什么用 `dlopen` 而不是直接链：那一份是**插件**（`cli.js` 的 `glPlugin()` 编出来的
 * `libomnigl.dylib`），宿主程序对 GL 零依赖 —— 判据也照这条路走，免得判的是另一种挂法。
 *
 * 期望（320×240、三角形覆盖 0.25 面积、背景占其余）：红 = 9600、背景 = 67200。
 * 那两个数是**算出来的**（0.5×0.5×0.5 = 0.125 的裁剪空间面积 × 76800 = 9600），
 * 不是量出来的 —— 所以它同时钉住"顶点是裁剪空间"这条契约。
 */
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>

int main(int argc, char **argv) {
  if (argc < 2) { printf("用法: probe <libomnigl.dylib>\n"); return 2; }
  void *h = dlopen(argv[1], RTLD_NOW);
  if (h == NULL) { printf("dlopen 失败: %s\n", dlerror()); return 2; }
  int (*op)(int, int) = (int (*)(int, int))dlsym(h, "omni_ev_gl_open");
  void (*cls)(unsigned int) = (void (*)(unsigned int))dlsym(h, "omni_ev_gl_cls");
  void (*bat)(int, long, const double *) =
    (void (*)(int, long, const double *))dlsym(h, "omni_ev_gl_batch");
  int (*rd)(unsigned char *) = (int (*)(unsigned char *))dlsym(h, "omni_ev_gl_read");
  const char *(*er)(void) = (const char *(*)(void))dlsym(h, "omni_ev_gl_error");
  if (op == NULL || cls == NULL || bat == NULL || rd == NULL) { printf("符号缺\n"); return 2; }
  if (op(320, 240) != 0) { printf("open 失败: %s\n", er == NULL ? "?" : er()); return 3; }
  cls(0x102030u);
  double v[36] = {
    -0.5, -0.5, 0, 1,  1, 0, 0, 1,  0, 0, 0, 1,
     0.5, -0.5, 0, 1,  1, 0, 0, 1,  0, 0, 0, 1,
     0.0,  0.5, 0, 1,  1, 0, 0, 1,  0, 0, 0, 1,
  };
  bat(1, 3, v);
  unsigned char *px = (unsigned char *)malloc(320 * 240 * 4);
  if (px == NULL || rd(px) != 0) { printf("read 失败\n"); return 3; }
  long red = 0, bg = 0;
  for (int i = 0; i < 320 * 240; i++) {
    unsigned char r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r > 200 && g < 60 && b < 60) red++;
    else if (r == 0x10 && g == 0x20 && b == 0x30) bg++;
  }
  printf("red=%ld bg=%ld total=%d\n", red, bg, 320 * 240);
  free(px);
  return 0;
}
