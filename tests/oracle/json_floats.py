"""json_floats.omni 的参照实现。

repr_omni 按 ADR-0005 的文字重新表达 repr(real) 的规则，用 Python 自己的 printf 与 strtod
作为原语参照；'%.6g' 就是 print(real) 的规格。json.loads 提供解析参照。
"""

import json

docs = [
    "0.0", "1.0", "-1.0", "-0.0",
    "0.1", "0.5", "1.5", "-0.25", "0.3",
    "3.14159265358979", "2.718281828459045",
    "1e3", "1e-3", "2.5e10", "1e15", "1e16", "1e20", "1e21", "1e-20",
    "123456789.123456789", "1.0000000000000002",
    "1e-7", "6.02214076e23", "1.602176634e-19",
    "9007199254740993.0", "0.000123456789",
    "1.7976931348623157e308", "2.2250738585072014e-308", "5e-324",
    "1E+2", "1.5E-2", "-1.5e+3",
    "1000000000000000000000.0",
]


def repr_omni(v):
    """15/16/17 位里第一个能往返回原值的，末尾补 '.0'（ADR-0005 的序列化格式）"""
    for p in (15, 16, 17):
        s = "%.*g" % (p, v)
        if float(s) == v:
            return s if ("." in s or "e" in s) else s + ".0"
    s = "%.17g" % v
    return s if ("." in s or "e" in s) else s + ".0"


for s in docs:
    print(repr_omni(json.loads(s)))

for s in docs:
    print("%.6g" % json.loads(s))

for s in docs:
    v = json.loads(s)
    print("%.6g" % (v * 2.0))
    print("%.6g" % (v + 1.0))

for s in docs:
    v = json.loads(s)
    back = json.loads(repr_omni(v))
    print("true" if v == back else "false")
