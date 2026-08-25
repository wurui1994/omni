"""json_roundtrip.omni 的参照实现：Python 的 json 模块。

separators=(',', ':') 去掉 Python 默认的空格，ensure_ascii=False 让非 ASCII 原样输出
—— 这两项让 json.dumps 的输出和 Omni 的 stringifyJson 处在同一个规范化形式上。
Python 的 dict 同样保插入序，所以键顺序可以直接逐字节比。
"""

import json

docs = [
    '{"a":1,"b":2}',
    '{"z":1,"a":2,"m":3,"b":4}',
    '[1,2,3]',
    '[]',
    '{}',
    'null',
    'true',
    'false',
    '123',
    '-456',
    '0',
    '"hello"',
    '""',
    r'"with \"quotes\" and \\ backslash"',
    r'"tab\there"',
    r'"nl\nhere"',
    r'"\u0041\u005a"',
    r'"\u0001\u001f"',
    r'"\b\f\r"',
    r'"slash \/ solidus"',
    '{"a":[1,{"b":[true,null,"x"]}],"c":{"d":{}}}',
    '  { "a" : [ 1 , 2 ] , "b" : null }  ',
    '[[[[[1]]]]]',
    '{"n":9007199254740993}',
    '{"id":1234567890123456789}',
    '9223372036854775807',
    '-9223372036854775808',
    '[0,-0,1,-1]',
    '{"dup":1,"other":2}',
    '["", " ", "  "]',
]


def dump(v):
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


for s in docs:
    print(dump(json.loads(s)))

for s in docs:
    once = dump(json.loads(s))
    twice = dump(json.loads(once))
    print("true" if once == twice else "false")
