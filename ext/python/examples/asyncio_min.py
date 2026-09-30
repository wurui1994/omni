# ext/python/examples/asyncio_min.py —— **async/await 的最小闭环**
#
# 跑法与其它例子同一条：`omni run ext/python/examples/asyncio_min.py` ——
# **我们的前端**（adapter -> 标准 IR -> 公共 lower -> OIR -> JS 后端的生成器帧），
# 不借本机 python3、不借 CPython 的 ceval。
#
# asyncio 那两格（`run` / `sleep`）是运行时最小 shim（同步就绪协议）：
#   * `sleep(0)` 是"立即就绪"的一格 —— 真定时器（`sleep(0.5)` 那种）还没接；
#   * `gather` / `wait_for` / TCP 那一族还没接；
#   * 挂起/恢复的语义与 CPython 的协程帧 + `SEND` 同一条：`await` 交出控制权，
#     驱动者把值 `SEND` 回来。
import asyncio


async def work():
    await asyncio.sleep(0)
    return 42


async def twice():
    a = await work()
    b = await work()
    return a + b


print(asyncio.run(work()))
print(asyncio.run(twice()))
