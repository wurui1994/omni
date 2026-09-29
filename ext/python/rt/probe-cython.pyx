# ext/python/rt/probe-cython.pyx —— **第四问的被试者：一份真的 Cython 模块**
#
# 为什么不是 lxml：lxml 6.0.2 的源码还不支持我们钉的那一支（它用的 PyUnicode_AS_DATA
# 那一族在 3.12 就删了），而且 wheel 里没打包顶层的 python.pxd。这一份只用稳的那部分
# API，量的是同一件事：**Cython 出的 C，我们自己的前端编得动、我们的运行时装得进、答案对**。
import cython


cdef class Point:
    cdef public double x
    cdef public double y

    def __init__(self, double x, double y):
        self.x = x
        self.y = y

    cpdef double norm(self):
        return (self.x * self.x + self.y * self.y) ** 0.5

    def __repr__(self):
        return f"Point({self.x:g}, {self.y:g})"


cdef class Counter:
    cdef dict _n

    def __init__(self):
        self._n = {}

    cpdef add(self, str k, long long v=1):
        self._n[k] = self._n.get(k, 0) + v

    def top(self, int k):
        items = sorted(self._n.items(), key=lambda kv: (-kv[1], kv[0]))
        return items[:k]


def fib(int n):
    cdef long long a = 0
    cdef long long b = 1
    cdef int i
    for i in range(n):
        a, b = b, a + b
    return a


def sieve(int n):
    cdef list flags = [True] * (n + 1)
    cdef int i, j
    cdef list out = []
    for i in range(2, n + 1):
        if flags[i]:
            out.append(i)
            for j in range(i * i, n + 1, i):
                flags[j] = False
    return out


def words(str text):
    c = Counter()
    for w in text.split():
        c.add(w.strip(".,!?").lower())
    return c.top(3)


def boom(int k):
    try:
        if k == 0:
            raise ValueError("零不行")
        return 100 // k
    except ZeroDivisionError:
        return "除零"
    except ValueError as e:
        return f"值错：{e}"
    finally:
        pass
