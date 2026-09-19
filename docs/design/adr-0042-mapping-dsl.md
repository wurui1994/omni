# ADR-0042: CST → Graph 映射 DSL（替代手写 tograph.js）

## 状态：提案

## 背景

当前每门语言的 CST→Graph 翻译是一个手写的 JS 函数（`ext/<lang>/tograph.js`），
用 switch-case 逐个处理 CST 标签。

| 语言 | case 数 | 行数 |
|------|---------|------|
| go | 48 | 1773 |
| vlang | 54 | 1581 |
| nim | 34 | 801 |
| cpp | 32 | 534 |
| lua | 30 | 412 |
| mojo | 29 | 363 |
| awk | 25 | 198 |

**问题**：
1. **不可复用**：十门语言的 `if → branch` 各写一遍，逻辑相同、代码不同
2. **不可检查**：grammar 有 LALR 验证，mapping 没有——漏了一个 case 只能靠运行时发现
3. **不可组合**：go 的 `for-range` 和 vlang 的 `for-in` 是同一件事，但各自 50 行代码
4. **工程债务**：go 的 tograph.js 已经 1773 行，每加一个特性（goroutine/channel/select/interface dispatch）只能继续堆 case，没有架构上限

**对比**：grammar 层已经做对了——一份声明式 `.grammar` 文件驱动整个解析器。
CST→Graph 这一步应该有同等的形式化。

## 设计

### 核心思想

引入 **`.mapping`** 文件格式，与 `.grammar` 平级。
grammar 描述"怎么识别"，mapping 描述"识别出来之后怎么翻译"。

```
;; ext/go/go.mapping

;; 一条规则 = CST 模式 → Graph 构造
(map <cst-pattern> <graph-construction>)

;; 内建函数 = 名字 → 展开规则
(builtin <name> <expansion>)

;; 运行时桩 = 包名 → 字段表
(stub <pkg-name> { field: value, ... })
```

### 映射规则的三层

**第一层：直译**（大多数语言共享）
```
(map num          (const $value))
(map str          (const $value))
(map name         (ref $1))
(map (bin op l r) (prim $op [$l $r]))
(map (if c t e)   (branch $c $t $e))
(map (for i c p b)(loop $i $c $p $b))
(map (block body) (region $body))
(map (define l r) (bind $l $r))
(map (assign l r) (set $l $r))
```

这一层是**跨语言共享**的。十门语言的 `if` 都翻译成 `branch`，
不需要十份代码各写一遍。

**第二层：语言特有的语法糖**
```
;; Go 的 for-range
(map (for-range key val iter body)
  (let [__iter $iter __n (prim len [__iter]) __i 0]
    (loop (< __i __n)
      (bind $key __i)
      (bind $val (index-get __iter __i))
      $body
      (set __i (+ __i 1)))))

;; Go 的 defer
(map (defer expr) (scope-exit $expr))

;; Go 的 method 声明
(map (method recv name sig body)
  (bind (mangle $recv.type $name)
        (func (prepend $recv.name $sig.params) $body)))
```

**第三层：运行时语义**（goroutine/channel/interface/type-switch）
```
;; goroutine: 降成同步调用（当前），或接入调度器（未来）
(map (go expr) (call $expr))                ;; phase 1: sync
;; (map (go expr) (rt:spawn $expr))         ;; phase 2: scheduler

;; channel
(map (make chan $type $cap)  (rt:chan-new $cap))
(map (send $ch $val)         (rt:chan-send $ch $val))
(map (recv $ch)              (rt:chan-recv $ch))
(map (select cases)          (rt:select $cases))

;; interface dispatch
(map (call (sel $obj $method) $args)
  (rt:dispatch $obj $method $args))

;; type switch
(map (tswitch $var $cases)
  (rt:type-switch $var $cases))
```

`rt:` 前缀的不是图节点——它们是**运行时函数调用**，
由各后端（js/c/wat）的运行时库实现。

### 运行时库（新增）

每个后端需要一份 Go 运行时库：

```
;; src/core/graph/go-rt.js — Go 语义的 JS 运行时

// Channel（简单队列实现）
class GoChan {
  constructor(cap) { this.buf = []; this.cap = cap; this.closed = false; }
  send(v)  { if (this.closed) throw new Error('send on closed channel'); this.buf.push(v); }
  recv()   { return this.buf.length > 0 ? this.buf.shift() : null; }
  close()  { this.closed = true; }
  [Symbol.iterator]() { return { next: () => this.buf.length > 0 ? {value:this.buf.shift()} : {done:true} }; }
}

// Goroutine（phase 1: 同步）
function goSpawn(fn) { fn(); }

// Interface dispatch（基于 __type 标签）
function goDispatch(obj, method, args) {
  const typeName = obj?.__type;
  if (!typeName) return null;
  const fn = __methods[`${typeName}.${method}`];
  return fn ? fn(obj, ...args) : null;
}

// Type switch
function goTypeSwitch(obj, cases) {
  const typeName = obj?.__type;
  for (const [type, handler] of cases) {
    if (typeName === type) return handler(obj);
  }
  return cases.find(c => c[0] === 'default')?.[1](obj) ?? null;
}

// Struct（带 __type 标签的 record）
function goStruct(typeName, fields, values) {
  const obj = { __type: typeName };
  for (let i = 0; i < fields.length; i++) obj[fields[i]] = values[i];
  return obj;
}

// append（返回数组本身）
function goAppend(slice, elem) { slice.push(elem); return slice; }

// copy
function goCopy(dst, src) {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] = src[i];
  return n;
}
```

### 迁移路径

不是一步替换。分三阶段：

**阶段 1：运行时先行**（本次）
- 写 `go-rt.js`：channel、dispatch、struct、append、copy
- tograph.js 里的 case 调用运行时函数，不再内联展开
- **效果**：tograph.js 缩短，语义集中到运行时库

**阶段 2：共享映射提取**
- 把十门语言共同的 15 个映射（num/str/name/bin/if/for/block/...）抽成 `common.mapping`
- 每门语言只写差异部分
- tograph.js 变成"读 .mapping + 查表 + 少数特殊 case"

**阶段 3：完整 DSL**
- `.mapping` 文件有自己的解析器
- tograph.js 退化成通用的映射解释器（< 200 行）
- 新增一门语言只需写 `.grammar` + `.mapping`

### Go 特性覆盖清单

当前（tograph.js 的 case）vs 目标（mapping + runtime）：

| 特性 | 当前状态 | 归属 |
|------|---------|------|
| 基础值/算子/控制流 | ✅ case 实现 | 共享映射 |
| struct 字面量（带名） | ✅ record-new | 共享映射 |
| struct 字面量（位置） | ❌ 退化成 list | runtime goStruct |
| 方法声明 | ✅ mangle | 映射规则 |
| 方法调用（已知类型） | ✅ MSET dispatch | 映射规则 |
| 方法调用（接口） | ❌ field-get 兜底 | runtime goDispatch |
| goroutine | ⚠️ 降成同步调用 | runtime goSpawn |
| channel make/send/recv | ⚠️ 降成 null/空 | runtime GoChan |
| select | ❌ 降成第一支 | runtime goSelect |
| defer | ✅ scope-exit | 映射规则 |
| type switch | ❌ 未实现 | runtime goTypeSwitch |
| interface | ❌ 无 dispatch | runtime goDispatch |
| append | ⚠️ push 返回 null | runtime goAppend |
| copy | ❌ 降成 len | runtime goCopy |
| delete | ⚠️ 降成 set null | runtime goDelete (map-delete) |
| close | ❌ 未实现 | runtime goChanClose |
| variadic | ❌ 不打包 | 映射规则（调用时包数组） |
| Sprintf/格式化 | ⚠️ 部分 | runtime goSprintf |
| 多返回值 | ✅ values/pick | 共享映射 |
| 闭包 | ✅ func 节点 | 共享映射 |
| 错误处理 | ✅ if err != nil | 共享映射 |
| range map | ⚠️ 部分 | 映射规则 |
| range channel | ❌ | runtime + 映射 |

## 决策

先做阶段 1（运行时先行），因为它：
- 不改架构，只加文件
- 立刻修复 struct/append/channel/interface 四族 bug
- 为阶段 2 的映射提取创造条件（case 里的逻辑变短变纯）
