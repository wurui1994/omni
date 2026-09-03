"""GL 那一侧的性能：照 `benchmark.py` 的口径量（**每帧含 `fbo.read()`**）。

口径逐条抄自 `~/Downloads/benchmark.py`（ADR-0019「尺子」那一节）：
先 warmup 一帧，然后 `iters` 帧，每帧计时包含回读。印一行 `avg_ms mpix_s renderer`。

    python3 gl_bench.py spec.json
    spec.json = {"vert": 路径, "frag": 路径, "w": N, "h": N, "iters": N,
                 "uniforms": {"名字": [数…]}}
"""
import json
import sys
import time

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
            pass

    w, h = args["w"], args["h"]
    iters = args["iters"]
    vao = ctx.vertex_array(prog, [])
    fbo = ctx.framebuffer([ctx.renderbuffer((w, h), components=4)])
    fbo.use()

    # warmup 一帧（照 benchmark.py）
    ctx.clear()
    vao.render(moderngl.TRIANGLES, vertices=3)
    fbo.read()

    t0 = time.perf_counter()
    for _ in range(iters):
        ctx.clear()
        vao.render(moderngl.TRIANGLES, vertices=3)
        fbo.read()
    dt = time.perf_counter() - t0

    avg_ms = dt / iters * 1000.0
    mpix_s = (w * h * iters) / dt / 1e6
    print(f"{avg_ms:.3f} {mpix_s:.2f} {ctx.info.get('GL_RENDERER')}")


if __name__ == "__main__":
    main()
