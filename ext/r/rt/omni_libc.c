/* ext/r/rt/omni_libc.c —— libc 里**按值回 struct** 的那几个，我们自己用 C 写（第十八格）。
 *
 * 为什么要这一份：`tu` 档里按值收发 struct 的外部函数不发桩、等链接
 * （见 `tccgen.js` 的 `externThunk`）—— 它转不了手给宿主的 `callLibc`，因为那扇门只过
 * 标量。R 的 `src/main/printarray.c` 用 `div()` 算行列，于是"链得起"这件事上它是硬缺。
 *
 * `div` / `ldiv` / `lldiv` 的语义就是 C 的 `/` 与 `%`（C99 6.5.5：商向零截断、
 * 余数与被除数同号），所以身子只有两行 —— 唯一要小心的是**别自己发明边角**：
 * `INT_MIN / -1` 与除以 0 在 C 里是未定义，这儿照样交给底下的 `/`，不悄悄改答案。
 */

typedef struct { int quot; int rem; } omni_div_t;
typedef struct { long quot; long rem; } omni_ldiv_t;
typedef struct { long long quot; long long rem; } omni_lldiv_t;

omni_div_t div(int a, int b) {
  omni_div_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}

omni_ldiv_t ldiv(long a, long b) {
  omni_ldiv_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}

omni_lldiv_t lldiv(long long a, long long b) {
  omni_lldiv_t r;
  r.quot = a / b;
  r.rem = a % b;
  return r;
}
