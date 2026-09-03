// Omni — MIR 单元用例的小工具（ADR-0017 第一刀）
//
// 为什么会有这个文件：i32 / f32 现在**没有任何前端能产出**（核心方言只有一格 int、
// 一格 real），而它们的语义必须先被钉住 —— C 前端与 wasm 前端都要压在它上面。所以这一组
// 用例**直接造 MIR**，绕开所有前端，然后在两条腿上跑同一份 MIR：
//
//   闭包解释器（mir/interp.js）  —— 值语义的 oracle，32 位回绕与 fround 在它里头是显式的
//   LLVM 后端（backend-llvm）    —— `add i32` / `fadd float` 由硬件与 LLVM 自己定
//
// 两条腿的输出逐字节相同，才算这一格是对的。用例只用「算 -> 转成 i64/f64 -> print」这一种
// 形状：`print.int` 收 i64、`print.real` 收 double（backend-llvm 的 RT_OPS 就这么定的），
// 于是那两条宽度转换指令也顺带被这一轴覆盖了。

import {
  MirModule, MirFunc, OP, T_VOID, T_I64, T_F64, T_I32, T_F32, T_STR,
  CVT_SEXT, CVT_ZEXT, CVT_FCVT, REF_NONE,
} from '../../src/core/mir/ir.js';

/** MirInterp 要一个 OIR 模块拿 struct/enum/class 的定义 —— 这些用例里一个都没有。 */
export const OIR_STUB = { structs: [], enums: [], classes: [], js: false };

/**
 * 一个只有入口函数的模块。返回 {mir, f, k}：k 是常量池的快捷方式。
 *
 * 入口叫 `omni_main` 而不是 `main`：LLVM 后端自己会发一个 C 的 `main`（里头
 * `call omni_run_entry(ptr @入口)`），入口也叫 main 的话 clang 当场报
 * `invalid redefinition of function 'main'`。from_oir 那边的入口名同样是 omni_main。
 */
export function unit() {
  const mir = new MirModule('omni_main');
  const f = new MirFunc('omni_main', [], T_VOID);
  mir.addFunc(f);
  return { mir, f, k: mir.consts };
}

/** 打印一个 i32：先 sext 成 i64（print.int 的签名是 i64）。 */
export function printI32(mir, f, ref) {
  const wide = f.emit(OP.CVT, T_I64, ref, REF_NONE, CVT_SEXT);
  f.emit(OP.CALLOP, T_VOID, mir.opNo('print.int'), f.pushArgs([wide]), 0);
}

/** 打印一个 i32 的**无符号**读法：zext 成 i64。 */
export function printU32(mir, f, ref) {
  const wide = f.emit(OP.CVT, T_I64, ref, REF_NONE, CVT_ZEXT);
  f.emit(OP.CALLOP, T_VOID, mir.opNo('print.int'), f.pushArgs([wide]), 0);
}

/**
 * 打印一个 f32。**不能直接走 `print.real`** —— 它是 `%g`（6 位有效数字），
 * 0.30000001192092896 与 0.30000000000000004 印出来都是 `0.3`，那就等于什么都没测。
 * 所以先 fpext 成 double，再 `to_string_g(x, 17)` 拿到 17 位有效数字的文本。
 */
export function printF32(mir, f, ref) {
  const wide = f.emit(OP.CVT, T_F64, ref, REF_NONE, CVT_FCVT);
  const s = f.emit(OP.CALLOP, T_STR, mir.opNo('to_string_g.real'),
    f.pushArgs([wide, mir.consts.int(17)]), 0);
  f.emit(OP.CALLOP, T_VOID, mir.opNo('print.string'), f.pushArgs([s]), 0);
}

export function printI64(mir, f, ref) {
  f.emit(OP.CALLOP, T_VOID, mir.opNo('print.int'), f.pushArgs([ref]), 0);
}

export function printBool(mir, f, ref) {
  f.emit(OP.CALLOP, T_VOID, mir.opNo('print.bool'), f.pushArgs([ref]), 0);
}

export { OP, T_VOID, T_I64, T_F64, T_I32, T_F32, REF_NONE };
