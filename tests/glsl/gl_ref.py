"""GL 尺子：拿**本机的 OpenGL** 渲染一份 vert/frag，逐像素印 `x y r g b`。

ADR-0019 决策二说尺子是 llvmpipe。这一份是**另一台尺子**：本机的真 GL
（量过：Apple M1、GL 4.1 Metal）。为什么它也算尺子 ——

  - 覆盖判定、填充规则、插值、`gl_FragCoord` 的原点、缓冲行序：这些是**规范规定**的，
    硬件与 llvmpipe 都得照办。这些格上硬件就是合法的尺子。
  - 只有 `sin`/`cos`/`smoothstep` 那种**实现自由度**上两者才可能不同，
    而那正是「容差」那一节要量的东西。

行序：`fbo.read()` 出来第 0 行是画布**最下面**那一行（`pretty_render.py` 之所以要
`FLIP_TOP_BOTTOM`），与我们那一侧 `qy = 0` 是最下面一行**一致** —— 所以这里按
`y = 0..h-1` 直接印，不翻。

    python3 gl_ref.py spec.json
    spec.json = {"vert": 路径, "frag": 路径, "w": N, "h": N, "uniforms": {"名字": [数…]}}
"""
import json
import sys

import moderngl


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        args = json.load(f)
    with open(args["vert"], encoding="utf-8") as f:
        vert = f.read()
    with open(args["frag"], encoding="utf-8") as f:
        frag = f.read()

    ctx = moderngl.create_standalone_context()
    prog = ctx.program(vertex_shader=vert, fragment_shader=frag)
    for name, vals in args.get("uniforms", {}).items():
        try:
            prog[name].value = vals[0] if len(vals) == 1 else tuple(vals)
        except KeyError:
            # 没用到的 uniform 会被编译器优化掉 —— 那不是错。
            pass

    w, h = args["w"], args["h"]
    vao = ctx.vertex_array(prog, [])
    fbo = ctx.framebuffer([ctx.renderbuffer((w, h), components=4)])
    fbo.use()
    ctx.clear(0.0, 0.0, 0.0, 1.0)
    vao.render(moderngl.TRIANGLES, vertices=3)
    data = fbo.read(components=4)

    lines = []
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            lines.append(f"{x} {y} {data[i]} {data[i + 1]} {data[i + 2]}")
    sys.stdout.write("\n".join(lines) + "\n")
    print(f"# renderer {ctx.info.get('GL_RENDERER')}", file=sys.stderr)


if __name__ == "__main__":
    main()
