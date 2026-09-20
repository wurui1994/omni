# ADR-0040：接口值 = 一格方法闭包的类（动态分派怎么落）

状态：已定（2026-09-20）。任务 #81。

## 要定的是什么

`go` 的接口、`asy` 的 `struct` 里装函数、`lua` 的 `__index` 链、`cpp` 的虚函数 ——
这四件事在方言里要落成同一台机器：**运行期才知道调谁**。

挡住 pt（34 份 `.go`）的那一句是：

```
列表里的元素类型不一样（r1 / r2 / r1）—— 方言的数组是单态的
```

`type Shape interface { … }` 加 `[]Shape{&Sphere{…}, &Cube{…}}`。

## 定下来的表示

**接口值 = 一格 `class`，每个接口方法一格 `fnty` 字段。**

```
type Shape interface { Area() float64; Name() string }
=>
(class If_Shape (Area (fnty () real)) (Name (fnty () string)))
```

装箱 = 造这格类 + 每个方法塞一格**捕获了接收者**的闭包：

```
(cfn Sq_Shape_Area ((self Sq)) () real (ret (call Sq__Area (cap self))))
…
(let b If_Shape (cnew If_Shape))
(fldset (var b) Area (mkclo Sq_Shape_Area (var s)))
```

分派 = 取字段 + 按值调：`(callfn (fld (var s) Area))`。

## 为什么是这一条（三条备选的账）

任务 #81 里列的三条各自的代价：

1. **`dyn` 那台机器**（#54）：`boxable` 不认记录。装进去要么改 `boxable`、要么把每个
   结构体变成 `(dict string dyn)` —— 后者能跑，pt 的热路径慢两个数量级。
2. **一格标签 + 一格地址**（最像 go 的 itab）：要方言能在 `(ptr rN)` 与整数之间转，
   而 `(ptr T)` 是胖指针（界在里头），从整数造不回来 ⇒ 要么加 `(tptr T)`、要么给方言
   加一格"不带界的记录指针"。**动的是类型系统。**
3. **单态化**：对 `[]Shape` 这种运行期才知道装了谁的容器不成立。

这一条（第四条）的代价是**零** —— 用的全是方言里已经有、已经有判据的东西：

- `(class …)` 的引用语义（`07-classes.sx`）⇒ 接口值就是一个字，`(arr If_Shape)` 是单态的；
- `fnty` 字段（`16-null.sx:17` 就是这个形状）、`(null (fnty …))` 就是 nil 方法；
- `(cfn …)` / `(mkclo …)` / `(callfn …)`（`15-fnvalues.sx`）—— 图那一层是 `func` +
  `liftFnVals`，`go f()` 那一族（#78）已经把这条路跑通了。

探针（`class` + `fnty` 字段 + `mkclo` 抓接收者 + `(arr If_Shape)` 装三个 + 循环
`callfn`）在**解释器腿与原生腿上都过**，两条答案相同。

## 与 go 的差在哪儿（说清，不含糊）

- **装箱的代价**：go 的 itab 是静态的、装箱不分配；我们每装一次造 N 个闭包。
  pt 的形状是"建场景时装一次、之后调几百万次"，所以这一笔在热路径外。
- **热路径的代价**：go 是"itab 取函数 + 带数据指针调"，我们是"记录取字段 + 按值调"，
  **同为一次间接调用**。
- **尺寸**：接口值本身是一个字（类是引用），但被指的那格记录是 N 个字（go 是 2）。
- **`x.(T)` / `switch x.(type)`**：这一格要一格标签字段。pt 里一处都没有，所以**先不做**，
  等第一个真用到的例子再加（加法是往这格类上多一个 `tag int`）。
- **typed nil**：go 里"类型非空、数据空"的接口值 `!= nil`，我们是一格空引用 ⇒ `== nil`。
  这是**明着认的偏差**。

## 方法提升（嵌入）怎么落

`TransformedShape{ Shape; Matrix; Inverse }` 嵌了一格**接口**，只覆盖了
`BoundingBox`/`Intersect` 两个，另外四个由嵌入的那格提升。

提升的那几个各生成一格**转发**（go 自己也生成 wrapper method）：

```
(cfn TS_Shape_UV ((self TransformedShape)) ((v Vector)) Vector
  (ret (callfn (fld (fld (cap self) Shape) UV) (var v))))
```

转发里**当场取字段**，不是装箱那一刻把闭包抄过来 —— 嵌入的那格事后被改也对。

## 判据

- `tests/go/cases/12-iface.go`：接口 + 三个实现 + `[]Shape` + 循环调方法，与 `go run`
  逐字节相同；
- `tests/go/cases/13-iface-embed.go`：嵌入接口 + 方法提升；
- pt 的 `Shape` / `Material` / `Texture` 三族过 `--backend core`；
- `tests/graph` 的 `dyn` 那几格不退（那台机器没动，所以应当纹丝不动）。
