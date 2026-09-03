#version 330 core
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_res;
uniform float u_time;

const float PI = 3.14159265359;

float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdHex(vec2 p, float r) {
    p = abs(p);
    float c = dot(p, normalize(vec2(1.0, 1.7320508)));
    c = max(c, p.x);
    return c - r;
}
mat2 rot(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_res) / min(u_res.x, u_res.y);
    vec2 p = uv;
    p *= rot(u_time * 0.15);

    // Hex grid pattern
    vec2 h = p;
    float scale = 4.0 + 1.5 * sin(u_time * 0.3);
    h *= scale;
    float hex = sdHex(fract(h) - 0.5, 0.42);
    float grid = smoothstep(0.02, 0.0, abs(hex));

    // Glowing orbiting circles
    float glow = 0.0;
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float a = u_time * 0.6 + fi * PI / 3.0;
        vec2 c = vec2(cos(a), sin(a)) * (0.55 + 0.15 * sin(u_time + fi));
        float d = sdCircle(p - c, 0.10 + 0.03 * sin(u_time * 2.0 + fi));
        glow += 0.04 / (abs(d) + 0.02);
    }

    // Color
    float hue = 0.6 + 0.25 * sin(u_time * 0.2) + 0.1 * length(p);
    vec3 col = hsv2rgb(vec3(hue, 0.7, 1.0)) * grid;
    col += hsv2rgb(vec3(hue + 0.1, 0.9, 1.0)) * glow;
    col += 0.03 * hsv2rgb(vec3(hue + 0.5, 0.6, 1.0));

    // Vignette
    col *= smoothstep(1.3, 0.2, length(uv));
    // subtle tone curve
    col = col / (col + 0.6);
    col = pow(col, vec3(0.85));

    fragColor = vec4(col, 1.0);
}
