#version 330 core
out vec4 fragColor;
uniform vec2 u_resolution;
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec3 col = 0.5 + 0.5 * cos(uv.xyx * 3.0 + vec3(0, 2, 4));
    fragColor = vec4(col, 1.0);
}
