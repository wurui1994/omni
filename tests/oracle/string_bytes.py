"""string_bytes.omni 的参照实现。

参照的是 Python 的 str.encode('utf-8') / bytes.find —— ADR-0005 钉的是
「string 是 UTF-8 字节序列，.length 和 byteAt 都按字节」，所以这里一律先 encode
再量长度、取下标、找子串，Omni 的输出必须逐字节等于它。

非 ASCII 全部写成显式码点转义而不是字面量：字面量会被编辑器归一化
（分解的 e+U+0301 会变成预组合的 U+00E9），那样参照实现自己就先跑偏了。
"""


def b(v):
    """Omni 打印 bool 是小写的 true/false，Python 是 True/False。"""
    return "true" if v else "false"


strs = [
    "",
    "a",
    "abc",
    "hello world",
    "h\u00e9llo",
    "\u4e16\u754c",
    "a\u2192b",
    "\u00ff",
    "\U0001d11e",
    "e\u0301",
]

for s in strs:
    print(len(s.encode("utf-8")))

for s in strs:
    print("".join(str(byte) + "," for byte in s.encode("utf-8")))

# substr / indexOf 只在 ASCII 上对照：切在多字节序列中间是已记录的偏差（ADR-0005）
t = "the quick brown fox jumps".encode("utf-8")
print(len(t))
print(t[4 : 4 + 5].decode("utf-8"))
print(t[0:3].decode("utf-8"))
print(t[len(t) - 3 : len(t)].decode("utf-8"))
print(b(t[0:0] == b""))
print(t.find(b"quick"))
print(t.find(b"fox"))
print(t.find(b"the"))
print(t.find(b"zzz"))
print(t.find(b""))
print(t.find(t))

print("ab" + "cd")
print(len(("ab" + "cd").encode("utf-8")))
print("h\u00e9llo" + "\u4e16\u754c")
print(len(("h\u00e9llo" + "\u4e16\u754c").encode("utf-8")))
print(b("abc".encode("utf-8") < "abd".encode("utf-8")))
print(b("abc".encode("utf-8") < "ab".encode("utf-8")))
print(b("abc".encode("utf-8") == "abc".encode("utf-8")))
print(b("Z".encode("utf-8") < "a".encode("utf-8")))

for cp in [65, 233, 19990, 8594, 255, 119070, 0, 127]:
    raw = chr(cp).encode("utf-8")
    print(len(raw))
    print("".join(str(byte) + "," for byte in raw))
