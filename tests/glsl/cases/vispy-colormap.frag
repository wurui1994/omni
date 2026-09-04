// vispy 的绘图接口，最小例子之三：**颜色表**（横向渐变 + 区间外的颜色）
//
// 复刻的是 vispy 那两份的接口（BSD 许可）：
//   colormaps/hot.glsl   vec3 colormap_hot(float t)
//                        vec3 colormap_hot(float t, vec3 under, vec3 over)   ← **重载**
//   colormaps/util.glsl  vec3 colormap_underover(float t, vec3 c, vec3 u, vec3 o)
//
// 这一份是**函数重载**那一刀的最小见证：`colormap_hot` 有两份，一份一个实参、一份三个，
// 调用点按实参个数与类型挑。vispy 的 15 张颜色表全是这个形状（那也是它那 41 份
// 编不过的原因，见 ADR-0019 与 `tests/glsl/vispy.js`）。
//
//   omni run tests/glsl/cases/vispy-colormap.frag -o cmap.png --size 128

#version 330 core

out vec4 fragColor;

// colormaps/util.glsl
vec3 colormap_underover(float t, vec3 color, vec3 under, vec3 over)
{
    if (t < 0.0) return under;
    if (t > 1.0) return over;
    return color;
}

// colormaps/hot.glsl —— 一个实参那一份
vec3 colormap_hot(float t)
{
    return vec3(smoothstep(0.00, 0.33, t),
                smoothstep(0.33, 0.66, t),
                smoothstep(0.66, 1.00, t));
}

// colormaps/hot.glsl —— 三个实参那一份（**重载**：区间外给别的颜色）
vec3 colormap_hot(float t, vec3 under, vec3 over)
{
    return colormap_underover(t, colormap_hot(t), under, over);
}

void main()
{
    // x 从 -0.2 走到 1.2：两头各留一段落在区间外，好看出 under/over 那两支
    float t = (gl_FragCoord.x / 128.0) * 1.4 - 0.2;
    vec3 c = colormap_hot(t, vec3(0.0, 0.0, 0.4), vec3(0.4, 1.0, 1.0));
    fragColor = vec4(c, 1.0);
}
