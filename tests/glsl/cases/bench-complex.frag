#version 330 core
out vec4 fragColor;
uniform vec2 u_resolution;

float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);

    // Repeated SDF operations for load
    float d = 1e10;
    for (int i = 0; i < 20; i++) {
        float fi = float(i);
        vec2 center = vec2(sin(fi * 0.7) * 0.6, cos(fi * 1.1) * 0.6);
        float r = 0.08 + 0.04 * sin(fi * 1.3);
        d = min(d, sdCircle(uv - center, r));
    }
    for (int i = 0; i < 10; i++) {
        float fi = float(i);
        vec2 center = vec2(cos(fi * 0.9) * 0.5, sin(fi * 0.6 + 1.0) * 0.5);
        d = min(d, sdBox(uv - center, vec2(0.05 + 0.02 * sin(fi))));
    }

    vec3 col = vec3(0.02);
    col += vec3(0.9, 0.3, 0.1) * smoothstep(0.01, 0.0, d);
    col += vec3(0.1, 0.2, 0.8) * smoothstep(0.005, 0.0, abs(d) - 0.003);
    col += 0.15 * vec3(0.5, 0.8, 1.0) * (0.5 + 0.5 * sin(d * 80.0 - uv.x * 20.0));
    col += 0.05 * vec3(sin(uv.x * 10.0), cos(uv.y * 10.0), sin((uv.x + uv.y) * 8.0));
    fragColor = vec4(col, 1.0);
}
