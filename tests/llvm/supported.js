// LLVM 后端能降的那些 case —— **两条轴共用的一张表**。
//
// AOT（tests/llvm）和 JIT（tests/jit）共用同一个发射器，所以支持面必须是同一张表：
// 分别维护两份的话，某条路悄悄多支持一点就没人拦得住。这张表本身是断言 ——
// 不在表里的 case，两条路都必须以「llvm 后端目前不支持」这个理由拒掉。
//
// 加一条支持面就来这里加一行。

import { join } from 'node:path';

export const SUPPORTED = [
  join('tests', 'wat', 'cases', '01-numeric.wat'),
  join('tests', 'wat', 'cases', '02-control.wat'),
  join('tests', 'cases', '02_numeric.omni'),
  join('tests', 'cases', '04_div_zero.omni'),
  join('tests', 'cases', '16_int_of_real.omni'),
  // 第二阶段（字符串）：核心 s-expr 方言整套都能降了 —— 它只有四个标量类型 + string，
  // 没有容器也没有 dyn，正好是这一阶段支持面的边界。
  join('tests', 'sexpr', 'cases', '01-core.sx'),
  join('tests', 'sexpr', 'cases', '02-strings.sx'),
  // SIMD 第一阶段（门槛 6）：`<N x T>` 那条腿。它和 C 的标量化腿必须逐位相同，
  // 所以这条 case 在这张表里的意义比"又多支持一点"更重 —— 它是那条门槛的度量点。
  join('tests', 'sexpr', 'cases', '03-simd.sx'),
  // 缓冲 + kernel/dispatch（门槛 7 第一阶段）：`{i64, ptr}` 与 arena 快路径都在 IR 里重建，
  // 所以这条腿和 C 那条腿分到的内存在同一个池里。
  join('tests', 'sexpr', 'cases', '04-buffers.sx'),
  // 数组（门槛 2 第四刀）：六条指令全是 call 运行时符号，run-c 那条腿调的是同一个符号。
  join('tests', 'sexpr', 'cases', '05-arrays.sx'),
  // 结构体（门槛 2 第十二刀）：值是指向自己那块内存的指针，NEW/COPY 从 arena 拿，
  // FLD/FLDSET 是 getelementptr + load/store。
  join('tests', 'sexpr', 'cases', '06-structs.sx'),
  // 类（门槛 2 第十三刀）：与结构体只差引用语义，字段访问多一次 @omni_nullck。
  join('tests', 'sexpr', 'cases', '07-classes.sx'),
  // 向量字段（门槛 2 第十五刀）：字段的类型就是 `<N x T>`、零值是 zeroinitializer，
  // 值语义靠 COPY 那条逐字段 load/store 拷那 16 字节。C 那条腿的同一个字段是标量化的
  // 结构体，两边要逐字节相同 —— 所以这份 case 同时是"向量字段"与"两种向量表示"的度量点。
  join('tests', 'sexpr', 'cases', '08-vecfields.sx'),
  // 这一份是**边界那节推过来的**：结构体一支持，01_basics 就整份能降了（它原先被拒
  // 只是因为里面有 struct）。它的输出与 run / interp / omni-c 逐字节相同，所以留在门外
  // 就变成了"其实支持却假装不支持"—— 那正是这张表要防的另一半。
  join('tests', 'cases', '01_basics.omni'),
  // 同一句断言推过来的第二份：类一支持，11_null_reference 也整份能降了。它盯的正是
  // 「空引用在 C 那条腿上必须显式检查，否则是段错误」，所以 LLVM 这条腿也必须在
  // 访问点 call omni_nullck —— 三条腿的 stdout / stderr / 退出码逐字节相同才算过。
  join('tests', 'cases', '11_null_reference.omni'),
];
