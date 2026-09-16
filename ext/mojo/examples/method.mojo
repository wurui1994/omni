# ext/mojo/examples/method.mojo —— **方法那一族**（与 nim / go / V 那三份同一件事）
#
# 期望输出（家族里所有语言、所有后端逐行相同）：3 / 9 / 3。
#
# mojo 这一份最省：`self` **本来就写在形参表第一格**（`fn total(self) -> Int`），
# 所以方法落的是现成的 bind + func —— struct 那一层只是把它提到顶层，
# `p.total()` 改写成 `total(p)`。一格新节点也没加，分派也不查表。

@value
struct Point:
    var x: Int
    var y: Int

    fn total(self) -> Int:
        return self.x + self.y

    fn scaled(self, k: Int) -> Int:
        return self.total() * k

fn main():
    var p = Point(1, 2)
    print(p.total())
    print(p.scaled(3))
    print(p.x + p.y)
