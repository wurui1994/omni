# Go 内建函数与 IO 的分层设计

## 问题

### 问题一：IO 副作用直接出现在图里

当前 `fmt.Printf("x=%d\n", x)` 在 tograph 里落成 `prim print [__goSprintf(fmt, x)]`。
`print` 是一个有 IO 副作用的 prim，它在图上**直接产生输出**。

这违背了图的设计原则：图是纯计算描述，副作用通过 `effects` 边标记。
`nodes.js` 里 `prim` 的 effects 是按名字查的（`primEffects`），`print` 那一格
标记了 `writes`——但"写到哪儿"没有说清。

正确的分层：
- 图里只有"求值"（纯的）和"副作用标记"（声明的）
- IO 的**执行**发生在后端（js/c/wat），不发生在图的求值里

### 问题二：内建函数靠 if-else 名字硬编码

`tograph.js` 的 `call` case 里：
```javascript
if (callee === 'append' && ...) return ...;
if (callee === 'copy' && ...) return ...;
if (callee === 'delete' && ...) return ...;
if (callee === 'cap' && ...) return ...;
if (callee === 'close' && ...) return ...;
if (callee === 'panic' && ...) return ...;
if (callee === 'print' || callee === 'println') return ...;
if (FORMATS.has(m)) { ... }  // Sprintf/Printf/Errorf
if (PRINTS.has(m)) { ... }   // Println/Print/Fprintln
```

这不是形式化。每加一个内建函数就加一个 if 分支。
`go.mapping` 里的 `(builtin ...)` 规则已经把这些**写成了声明**，
但解释器还没有接管它们——它们仍然在 tograph.js 的 case 里手写。

## 设计

### 一、内建函数的统一分派

在 `.mapping` 文件里，每个内建是一条规则：

```
;; 纯函数型内建（图上用 prim 或 runtime call）
(builtin len     (! len $1))
(builtin cap     (! len $1))
(builtin append  (rt __goAppend $1 $2))
(builtin copy    (rt __goCopy $1 $2))
(builtin delete  (rt __goDelete $1 $2))
(builtin close   (rt __goChanClose $1))
(builtin new     (const nil))

;; IO 型内建（图上用 prim print，effect 边标记 writes）
(builtin panic   (! print $1))
(builtin print   (! print $*1))
(builtin println (! print $*1))

;; 格式化函数（需要运行时 Sprintf）
(method-builtin fmt.Sprintf  (rt __goSprintf $*1))
(method-builtin fmt.Errorf   (rt __goSprintf $*1))
(method-builtin fmt.Printf   (! print (rt __goSprintf $*1)))
(method-builtin fmt.Println  (! print $*1))
```

`tograph.js` 里的 `call` case 只做：
1. 查 builtins 表 → 命中就走声明式规则
2. 查 method-builtins 表（`pkg.method`）→ 命中就走
3. 都没命中 → 走原来的方法分派逻辑（MSET / VARTYPE / field-get 兜底）

### 二、IO 的分层

图的 28 个节点里，有 IO 副作用的只有 `prim print`。
它的 effects 标记是 `writes`（在 `prims.js` 里声明的）。

分层：
- **图层**：`prim print` 是一个**有副作用标记的节点**，不执行 IO
- **后端层**：各后端（js/c/wat）看到 `prim print` 时各自执行 IO
  - js: `console.log` / `process.stdout.write`
  - c: `printf`
  - wat: `fd_write`
- **解释器层**（eval.js）：`prim print` 调 `io.out.push`

当前的问题不是 `print` 这个 prim 不该有——而是 `Printf` 这种**库函数**
不该在图层展开格式解析。格式化是运行时的事。

正确的切法：
- `fmt.Sprintf(fmt, args...)` → `call __goSprintf(fmt, args...)` （运行时函数，纯的）
- `fmt.Printf(fmt, args...)` → `prim print [call __goSprintf(fmt, args...)]` （IO 通过 print 节点）
- `fmt.Println(args...)` → `prim print args` （直接）

**这已经是当前实现的样子**（上一个 commit 改成了 `__goSprintf`）。
问题在于代码组织：这些分派规则散在 tograph.js 的 if-else 里，
而不是集中在 builtins 表里。

### 三、迁移步骤

1. **mapping 解释器支持 builtin 分派**（当前只加载了表，没有查它）
   - `applyBuiltin(calleeName, argNodes, rules.builtins)` → 图节点
   - `call` case 里先查 builtins，命中就不走 if-else

2. **method-builtin 表**（`fmt.Sprintf` 这一族）
   - 在 `.mapping` 里用 `(method-builtin pkg.method expansion)`
   - `sel` call 里先查这张表

3. **逐步迁移 if-else 到 builtins 表**
   - 每迁一个，tograph.js 里删一个 if
   - 判据：迁移前后 46/52 不降

4. **IO 不变**
   - `prim print` 的设计是对的（effect 边标记 writes）
   - 不需要改图的节点定义
   - 要改的是：别在 tograph.js 里手写 IO 分派逻辑

## 不做什么

- 不改 `prim print` 的设计——它是图上唯一的 IO 出口，设计是对的
- 不改 `nodes.js` 的 28 个节点——内建函数走 `prim`，不新开节点
- 不在图上区分"有副作用的 prim"和"纯的 prim"——那是 effects 边的事
