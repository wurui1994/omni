#version 330 core
out vec4 fragColor;
uniform vec2 u_resolution;
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    fragColor = vec4(0.25 + 0.5 * uv.x, 0.25 + 0.5 * uv.y, 0.75, 1.0);
}
