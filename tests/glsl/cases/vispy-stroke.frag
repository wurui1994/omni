// vispy 的绘图接口，最小例子之二：**描边**（圆环）
//
// 复刻的是 vispy 那两份的接口（BSD 许可）：
//   markers/ring.glsl      float marker_ring(vec2 P, float size)
//   antialias/stroke.glsl  vec4  stroke(float d, float lw, float aa, vec4 fg)
//
// 与「填充」那一份的区别正是 llvmpipe 里最常见的那类形状：**距离场取绝对值**之后
// 再按线宽做两侧的衰减，所以边缘两边都要抗锯齿，而填充只有一边。
//
//   omni run tests/glsl/cases/vispy-stroke.frag -o stroke.png --size 128

#version 330 core

out vec4 fragColor;

// markers/ring.glsl：外圈减内圈，回的是「到环线的距离」
float marker_ring(vec2 P, float size)
{
    float r1 = length(P) - size / 2.0;
    float r2 = length(P) - size / 4.0;
    return max(r1, -r2);
}

// antialias/stroke.glsl：只画线，不填内部
vec4 stroke(float distance, float linewidth, float antialias, vec4 stroke_color)
{
    vec4 frag_color;
    float t = linewidth / 2.0 - antialias;
    float signed_distance = distance;
    float border_distance = abs(signed_distance) - t;
    float alpha = border_distance / antialias;
    alpha = exp(-alpha * alpha);

    if (border_distance < 0.0) frag_color = stroke_color;
    else frag_color = vec4(stroke_color.rgb, stroke_color.a * alpha);
    return frag_color;
}

void main()
{
    vec2 center = vec2(64.0, 64.0);
    float d = marker_ring(gl_FragCoord.xy - center, 96.0);
    fragColor = stroke(d, 4.0, 1.0, vec4(0.95, 0.35, 0.15, 1.0));
}
