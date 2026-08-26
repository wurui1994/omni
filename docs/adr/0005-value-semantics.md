# ADR-0005：值语义与打印格式规范

状态：已接受（2026-08-25）· 实现：`stage0/src/backend-js/prelude.js`、`stage0/src/runtime/c_runtime.js`

## 背景

同一份 OIR 要落到 JS 和 C 两个（未来四个）后端。两边的原生数值语义不同：JS 的 `number` 是
f64，C 的有符号溢出是 UB，浮点打印的默认格式也不一样。若不把这些逐条钉死，差分测试会永远
在"看起来差不多"的地方红。

## 决定

**整数**：`int` 是 **i64**。
- JS 后端用 `BigInt`，`+ - * <<` 一律经 `BigInt.asIntN(64, …)` 回绕。
- C 后端的 `+ - * << -(一元)` 走 `omni_add/sub/mul/shl/neg`，内部用 `uint64_t` 运算再转回
  `int64_t` —— 绕开 C 有符号溢出 UB，得到与 JS 相同的回绕结果。
- 移位计数取 `& 63`（两端一致），避免 C 的 UB 与 JS 的大 BigInt 移位分叉。
- `/` 向零截断；`INT64_MIN / -1 == INT64_MIN`，`INT64_MIN % -1 == 0`（显式特判）。
- 整数除零 = 运行时错误，不是 UB：stderr 输出 `omni: runtime error: division by zero`，退出码 **70**。

**浮点**：`real` 是 f64，语义即 IEEE-754，除零得 inf/nan 而**不**报错。

**`int(real)`**：向零截断（`int(-3.7) == -3`，`int(-2.5) == -2`，不是四舍五入也不是向下取整）。
- 非有限值报错：`cannot convert non-finite real to int`。
- **超出 i64 范围也报错**：`real 1e+20 is out of int range`（值按 `%.6g` 格式化）。
  这里刻意**不回绕**：算术回绕是 i64 的约定，但 `int(1e20)` 回绕出来的数不表示任何东西。
  另一个动机是消掉分叉——C 侧超范围的 `(int64_t)` 转换是 UB（arm64 饱和到 `INT64_MAX`，
  x86 给 `INT64_MIN`），JS 侧 `BigInt.asIntN` 会静默回绕，两边只有都报错才对得上。
- 边界在范围内：`int(-9223372036854775808.0)` 可以，`int(9223372036854773760.0)`（= 2^63 - 2^11，
  小于 2^63 的最大 double）可以。用例 `tests/cases/16_int_of_real.omni`。

**打印格式**（`print`/`string()` 共用）：
- `int`：十进制。
- `real`：**C 的 `%.6g`**。JS 侧在 `$fmt_real` 里逐规则复刻（P=6；`-4 <= exp < 6` 用定点否则用
  指数形式；去尾随零；指数至少两位）。特殊值统一为 `inf` / `-inf` / `nan`（不是 JS 的 `Infinity`/`NaN`）。
- `bool`：`true` / `false`。
- `string`：原样输出。
- 每次 `print` 追加一个 `\n`。

选 `%.6g` 而不是最短往返表示，是因为 C 侧实现最短往返需要自带 Grisu/Ryu，成本远大于收益；
`print` 的用途是观察值，不是序列化。将来若需要无损往返，另开 `repr()`，不动 `print`。

**按位数格式化**（核心方言的 `(tostr E N)`，ADR-0014 决策 1）：`%.Ng`，N 是 1..17 的字面量。
它不是另一份格式，就是上面那一份把 P 放开 —— C 走 `%.*g`，两条 JS 腿走同一个 `$fmt_g(x, N)`，
LLVM 走 `omni_str_realg`。加它的理由是别的语言有别的默认位数（asymptote 是 `%.15g`），
`%.6g` 逐字节对不上；Omni 自己的 `print` 与 `string()` 仍然是 P=6，这条规则没动。

**序列化格式**（`repr()`，json 用它）：与 `print` 是两条独立规则。
- `repr(int)` = 十进制，与 `print` 相同。
- `repr(real)` = 依次尝试 `%.15g` / `%.16g` / `%.17g`，取**第一个能 `strtod` 往返回原值**的。
  这是"最短往返"的廉价近似：不需要 Grisu/Ryu，两个后端做的是同一件事，因此结果逐位一致
  （JS 侧 `$repr_real` 复用 `$fmt_g(x, P)`，C 侧就是 `snprintf` + `strtod`）。
- 得到的文本里若既没有 `.` 也没有 `e`，**补一个 `.0` 后缀**：`repr(1000.0)` = `"1000.0"`，不是 `"1000"`。
  理由是往返必须**保类型**，不只是保数值：`"1000"` 再解析回来会变成 `int`，`real → json → real`
  就不是无损的了。这与 Python 的 `repr` 一致；JS 的 `JSON.stringify` 会丢掉 `.0`，但序列化器是我们自己的
  代码，不受它约束。（这条是 `tests/oracle/json_floats` 逼出来的：原先两个后端一起错，差分测试看不见。）
- 非有限值不可序列化：`omni: runtime error: cannot represent non-finite real`。

**json 数字的反向规则**（`stage0/lib/json.omni` 的 `jsonNumber`）：文本带 `.`/`e` 的读成 `real`；
否则按十进制位数定——≤18 位必然放得进 i64，读成 `int`；19 位时与 `"9223372036854775807"`
（负数 `"9223372036854775808"`）做**等长字典序**比较，放得下才是 `int`；≥20 位读成 `real`。
不能简单地"超过 18 位就当 real"：19 位正好是 snowflake ID 的长度，那样会静默丢精度。

**字符串是 UTF-8 字节序列**：`.length` / `byteAt` / `substr` / `indexOf` / `[]` **全部按字节**，
不按字符也不按码点。
- C 侧 `omni_str` 是 `{const char *p; int64_t len;}`，字符串不可变，因此 `substr` 直接别名原缓冲区，零拷贝。
- JS 侧字符串是 UTF-16，所以过一层 `TextEncoder` 并用单条 memo 缓存字节视图，让循环扫描保持 O(1) 摊还。
- 越界是运行时错误而不是 `undefined`/UB：
  `string index out of range: I (length N)`、`substring out of range: start S, length L (string length N)`。

**容器**：`list` / `dict` / `set` 都是引用语义。
- **`dict` / `set` 保持插入序**（ADR-0006 的硬约束）。JS 侧靠 `Map`/`Set` 天然成立；C 侧是
  「条目数组（插入序）+ 开放寻址索引表」，删除只在索引表里打墓碑、条目上清 `live` 标志，
  重建时压实并保持相对顺序。因此"删除后重新插入 ⇒ 键移到末尾"这条 JS `Map` 语义在 C 侧同样成立。
- 索引越界 / 缺键 / 空 pop 都是运行时错误：`list index out of range: I (length N)`、
  `key not found: K`（`K` 的写法：int/real 用打印格式，string 加双引号）、`pop from empty list`。
- `list.contains` 与 `x in c` 要求元素类型有相等语义（int/real/bool/string/class/dynamic）；
  struct/容器元素会在编译期报错，而不是让两个后端各给一个答案。
- struct 的容器字段是**引用**：拷贝 struct 不深拷贝它的容器。C 侧天然如此，JS 侧 `$cp_S` 按引用搬。
- 容器字段的零值是**新建的空容器**，不是空引用：C 侧生成 `omni_new_S_*` / `omni_new_C_*` 逐字段初始化。

**class 是引用类型**：赋值传引用，`==` 是引用相等，默认值是 `null`。
- 空引用解引用在两个后端都是显式检查：`omni: runtime error: null reference`。
  C 侧走 `omni_nullck`，绝不允许退化成段错误 —— 否则诊断就和 JS 分叉了。

**dynamic 是带标签的胖值**（NaN-boxing 已否决，见 ADR-0006）。
- C 侧 `omni_dyn = {int tag; union {bool; int64_t; double; omni_str; void *ref;}}`，
  容器载荷存 `void *`，这样它可以先于任何容器实例化定义。
- 标签名 `null|bool|int|real|string|list|dict` 是语言可见的（`tag()` 的返回值）。
- 取值不匹配是运行时错误：`dynamic value is X, expected Y`。
- 相等：同标签才比较；容器按**引用**相等。

**struct 是值类型**：赋值、传参、返回都复制。
- C 天然如此。
- JS 后端必须显式深拷贝：生成 `$cp_<Struct>`，在「局部变量初始化 / 赋值 / 实参 / 返回值」
  四个位置对**左值来源**（`VarRef` / `Field`）插入拷贝；函数入口对 struct 形参再拷贝一次。
  新鲜值（`ZeroStruct` / `Call` 结果）不拷贝。

**输出缓冲**：JS 侧攒够 8KB 再写；运行时错误路径先 `$flush()`，与 C 的 `fflush(stdout)` 对齐，
保证错误发生前已打印的内容在两个后端上一致。

## 已知偏差（记录在案，不假装不存在）

- 字符串比较：C 按 UTF-8 字节，JS 按 UTF-16 码元。ASCII 与 BMP 内一致；超出 BMP 的码点
  （代理对）排序会分叉。等到有 `char`/索引/长度 API 时统一为「按码点」并补测试。
- `substr` 按字节切分：切在多字节序列中间时，C 侧原样保留半个序列，JS 侧 `TextDecoder`
  会替换成 U+FFFD，于是两边分叉。ASCII 输入无影响。修法与上一条相同（等码点 API）。
- `chr()` 的代理区（U+D800..U+DFFF）在两个后端都产出 U+FFFD —— 这是为了对齐 JS 的
  `String.fromCodePoint` + UTF-8 输出行为，而不是刻意的语言设计。
- dict 的 real 键：JS `Map` 用 SameValueZero（`NaN` 等于自身，`+0` 等于 `-0`），C 侧的
  `omni_eq_real`/`omni_hash_real` 显式复刻了这两条特例。
- 内存目前只分配不释放（C 侧 `malloc` 无 `free`，容器不回收）。ARC 在 P6 引入，届时补上；
  ADR-0007 的 unwind 表就是为这一步准备的。

## 验证

两条测试轴，各管一件事：

- **差分 + 快照**：`node tests/run.js`（`npm test`）。同一 `.omni` 在 js 后端和 c 后端上跑，
  stdout / stderr / 退出码必须逐字节相同。它能发现两边**不一致**。
- **跨语言对照**：`node tests/oracle/run.js`（`npm run test:oracle`）。`tests/oracle/X.omni`
  与 `X.py`（可选 `X.js`）是一组等价程序，输出必须逐字节相同。参照实现刻意用各语言的原生
  设施（Python 的 `json` 模块、`%.6g`、bignum + 显式掩码、保插入序的 `dict`）。它能发现两边
  **一起错** —— 差分测试对此完全免疫。
  当前 6 个用例：`real_format`、`int64_wrap`(2087 行)、`json_roundtrip`、`json_floats`、
  `dict_order`、`string_bytes`。已经逮到两个真 bug：JS 后端的一元负号没做 i64 回绕
  （`-INT64_MIN`），以及 `repr(real)` 丢 `.0` 导致类型往返不保真。
- C 侧另外过一遍 `clang -Wall -Wextra -fsanitize=address,undefined`：
  容器压力用例（`08_container_stress.omni`，含 dict 扩容/墓碑/插入序、嵌套容器、
  class/struct 的容器字段）与 json 往返用例均无报告。这条不在 CI 里，改动 C 运行时后手动跑。

## 执行者

`tests/run.js` 的差分断言：同一 `.omni` 在两个后端上的 stdout / stderr / 退出码必须逐字节相同。
任何一边改了上述规则而另一边没改，测试立刻红。

但差分只能钉住「两边一样」，钉不住「两边对」—— 上面 `repr(real)` 那条规则就是差分全绿、
对照测试才炸出来的。所以凡是本 ADR 里能被外部语言复述的规则（数字格式、i64 语义、
UTF-8 字节语义、插入序、json 往返），都要在 `tests/oracle/` 里有一个参照实现。
