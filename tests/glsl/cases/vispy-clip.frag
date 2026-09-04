#version 330 core
// vispy 的**裁剪 + 标记**那一组的最小复刻（BSD 许可）：
//   transforms/viewport-clipping.glsl 的 clip()  —— `discard` 写在**用户函数**里
//   markers/disc.glsl + antialias/filled.glsl    —— 距离场（这份只取"里外"，不做抗锯齿）
//
// 这一份是 `discard` 那一刀的门（ADR-0019）。两处 discard 是刻意的：
//   - `clip_viewport` 里那一处在**用户函数**里 —— 参考腿上不能靠 `(ret …)` 落
//     （那只出得了那个函数、出不了这个像素），所以它是那一格模块级 `glsl_killed` 的判据；
//   - `main` 里那一处是最常见的写法（vispy 的 antialias/cap*.glsl 就是）。
out vec4 fragColor;

// viewport 是 (x, y, w, h)，与 vispy 那边一样。出了它就不画这个片元。
void clip_viewport(vec4 viewport, vec2 pos) {
  if (pos.x < viewport.x || pos.x > viewport.x + viewport.z
      || pos.y < viewport.y || pos.y > viewport.y + viewport.w) discard;
}

// 有符号距离：负数在圆里
float disc(vec2 pos, vec2 center, float radius) {
  return length(pos - center) - radius;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  clip_viewport(vec4(32.0, 32.0, 64.0, 64.0), p);
  if (disc(p, vec2(64.0, 64.0), 40.0) > 0.0) discard;
  fragColor = vec4(0.15, 0.55, 0.95, 1.0);
}
