# ext/mojo/examples/defer.mojo —— 与 go / V / nim / CL 那四份 defer 例子**同一件事**
#
# 期望输出逐行相同：in / b / a / out。
#
# mojo 没有 `defer`，它写的是 `with`：进的时候 `__enter__`、出的时候 `__exit__`。
# 两格都是**方法**（第二十四批），所以这一份不加节点 —— 落的是现成的
# region + scope-exit + call。逆序（后进的先出）与早退也跑（体里那句 `return`）
# 都是 scope-exit 那一格本来就有的语义，五门语言五种语法共用同一格。
#
# 一个 struct 两个实例（不是两个 struct）：**同名方法要类型才分得开**，
# 那笔账明写在 `ext/mojo/tograph.js` 里 —— 所以这儿用 `tag` 这一格字段区分谁是谁。

@value
struct Say:
    var tag: Int

    fn __enter__(self) -> Int:
        return self.tag

    fn __exit__(self):
        if self.tag == 1:
            print("a")
        else:
            print("b")

fn demo():
    with Say(1), Say(2):
        print("in")
        return

fn main():
    demo()
    print("out")
