// vispy 的绘图接口，最小例子之一：**圆点标记 + 抗锯齿填充**
//
// 复刻的是 vispy 那两份的接口（BSD 许可，见 vispy/glsl/）：
//   markers/disc.glsl     float marker_disc(vec2 P, float size)      —— 到边界的有符号距离
//   antialias/filled.glsl vec4  filled(float d, float lw, float aa, vec4 bg)
//
// 为什么是**复刻**而不是 `#include` 那两份：这一份要在没装 vispy 的机器上也能跑
// （门也要能跑），而那两个函数各三五行 —— 抄进来比给门加一个「先装 vispy」的前提便宜。
// `tests/glsl/vispy.js` 那一支才是「真的拿 vispy 那 102 份过一遍前端」。
//
//   omni run tests/glsl/cases/vispy-disc.frag -o disc.png --size 128

#version 330 core

out vec4 fragColor;

// markers/disc.glsl：P 是**相对标记中心**的像素坐标，size 是直径
float marker_disc(vec2 P, float size)
{
    return length(P) - size / 2.0;
}

// antialias/filled.glsl：d 是到边界的有符号距离（像素），linewidth 是描边宽度
vec4 filled(float d, float linewidth, float antialias, vec4 bg_color)
{
    vec4 frag_color;
    float t = linewidth / 2.0 - antialias;
    float signed_distance = d;
    float border_distance = abs(signed_distance) - t;
    float alpha = border_distance / antialias;
    alpha = exp(-alpha * alpha);

    if (border_distance < 0.0) frag_color = bg_color;
    else if (signed_distance < 0.0) frag_color = bg_color;
    else frag_color = vec4(bg_color.rgb, alpha * bg_color.a);
    return frag_color;
}

void main()
{
    // 画布 128²，标记摆在正中、直径 80 像素
    vec2 center = vec2(64.0, 64.0);
    float d = marker_disc(gl_FragCoord.xy - center, 80.0);
    fragColor = filled(d, 1.0, 1.0, vec4(0.15, 0.55, 0.95, 1.0));
}
