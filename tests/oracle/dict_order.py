"""dict_order.omni 的参照实现：Python 的 dict 同样保插入序，
更新已有键不改位置、删除后重新插入移到末尾 —— 与 ADR-0006 钉的语义一致。"""

d = {}

i = 0
while i < 120:
    d[str(i * 7 % 40)] = i
    i += 1
print(len(d))
print("".join(k + "," for k in d))
print("".join(str(d[k]) + "," for k in d))

i = 0
while i < 40:
    if i % 3 == 0:
        d.pop(str(i), None)
    i += 1
print(len(d))
print("".join(k + "," for k in d))

i = 0
while i < 40:
    if i % 3 == 0:
        d[str(i)] = 1000 + i
    i += 1
print(len(d))
print("".join(k + "," for k in d))
print(d["0"])
print(d["39"])

big = {}
i = 0
while i < 500:
    big["k" + str(i)] = i * i
    i += 1
print(len(big))
i = 0
while i < 500:
    if i % 2 == 0:
        big.pop("k" + str(i), None)
    i += 1
print(len(big))
i = 0
while i < 500:
    if i % 2 == 0:
        big["k" + str(i)] = -i
    i += 1
print(len(big))
checksum = 0
for pos, k in enumerate(big):
    checksum += big[k] * (pos + 1)
print(checksum)
print(len(list(big.keys())))

di = {}
i = 0
while i < 50:
    di[i * i - 25 * i] = i
    i += 1
print(len(di))
print("".join(str(k) + "," for k in di))

xs = []
i = 0
while i < 30:
    xs.append(i * 3)
    i += 1
print(len(xs))
print(xs[7])
print(xs.pop())
print(xs.pop())
print(len(xs))
print(sum(xs))
