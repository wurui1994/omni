"""异质的字典：`{"name": "omni", "port": 8080, ...}` —— 值退到 dyn。

python 里的配置字典多是这个样：一张表里躺着串、数、布尔、浮点。方言那一侧落成
`(dict string dyn)`（键还是静态的 —— 方言的字典键只有 int 与 str 两档，
"键有时是数有时是串"在真代码里基本不出现，撞上了当场报）。

顺带钉住：容器装箱子时，**写进去的那一格要先装箱** —— `d["k"] = 1`、`xs[0] = "a"`、
`xs.append(2.5)` 三处都是。
"""

cfg = {"name": "omni", "port": 8080, "debug": True, "ratio": 0.5}
print(cfg["name"])
print(cfg["port"])
print(cfg["debug"])
print(cfg["ratio"])
print(len(cfg))
print("port" in cfg)
print("host" in cfg)

cfg["port"] = 9090
print(cfg["port"])
cfg["port"] = "auto"
print(cfg["port"])
cfg["extra"] = None
print(cfg["extra"], cfg["extra"] is None)
print(len(cfg))

xs = [1, "a"]
xs[0] = "changed"
print(xs[0])
xs.append(2.5)
xs.append(None)
print(xs)
print(len(xs))
