/*
 * Omni — JIT 宿主符号表的内容（ADR-0022 决策 2）。表的来由见 omni_jit_symbols.h。
 *
 * 这张表是**量出来的**，不是猜的：把 tests/ 底下能发 IR 的每一份源码（.omni/.omnis/
 * .jnc/.sx）都发一遍，取里头**外部引用**的名字的并集 —— 84 个运行时函数 + 2 个运行时
 * 变量 + 2 个 libc。两种形态都要取（第一版只 grep 了 `declare`，漏掉 `= external global`
 * 那两格，tests/jit 当场抓着；只量了两个语料，漏掉 51 个数组/线性内存/数学的名字，
 * 又被抓一次）：
 *
 *   for f in $(find tests -name '*.omni' -o -name '*.omnis' -o -name '*.jnc' -o -name '*.sx'); do
 *     node src/cli.js emit llvm "$f" 2>/dev/null; done \
 *     | grep -o '^declare[^@]*@[A-Za-z0-9_.]*\|^@[A-Za-z0-9_.]* = external[^,]*' \
 *     | grep -o '@[A-Za-z0-9_.]*' | sed 's/@//' | sort -u
 *
 * 后端多发一个运行时调用，这张表就要跟着长一行。漏了的后果是**装载之前**一句
 * `omni-jit: unresolved: X`，不是跑到一半崩 —— 那是这一刀的全部意义。
 */

#include "omni_jit_symbols.h"
#include "omni.h"

#include <stdio.h>
#include <string.h>
#include <strings.h>

const omni_jit_sym OMNI_JIT_SYMS[] = {
  /* ---- 运行时的函数：宿主里链着那一份（omni.h 给的是真原型） ---- */
  { "omni_alloc_slow", (void *)omni_alloc_slow },
  { "omni_arr_b8_get", (void *)omni_arr_b8_get },
  { "omni_arr_b8_len", (void *)omni_arr_b8_len },
  { "omni_arr_b8_new", (void *)omni_arr_b8_new },
  { "omni_arr_b8_pop", (void *)omni_arr_b8_pop },
  { "omni_arr_b8_push", (void *)omni_arr_b8_push },
  { "omni_arr_b8_set", (void *)omni_arr_b8_set },
  { "omni_arr_blob_at", (void *)omni_arr_blob_at },
  { "omni_arr_blob_len", (void *)omni_arr_blob_len },
  { "omni_arr_blob_new", (void *)omni_arr_blob_new },
  { "omni_arr_blob_pop", (void *)omni_arr_blob_pop },
  { "omni_arr_blob_push", (void *)omni_arr_blob_push },
  { "omni_arr_f64_get", (void *)omni_arr_f64_get },
  { "omni_arr_f64_len", (void *)omni_arr_f64_len },
  { "omni_arr_f64_new", (void *)omni_arr_f64_new },
  { "omni_arr_f64_pop", (void *)omni_arr_f64_pop },
  { "omni_arr_f64_push", (void *)omni_arr_f64_push },
  { "omni_arr_f64_set", (void *)omni_arr_f64_set },
  { "omni_arr_i64_get", (void *)omni_arr_i64_get },
  { "omni_arr_i64_len", (void *)omni_arr_i64_len },
  { "omni_arr_i64_new", (void *)omni_arr_i64_new },
  { "omni_arr_i64_pop", (void *)omni_arr_i64_pop },
  { "omni_arr_i64_push", (void *)omni_arr_i64_push },
  { "omni_arr_i64_set", (void *)omni_arr_i64_set },
  { "omni_arr_str_get", (void *)omni_arr_str_get },
  { "omni_arr_str_len", (void *)omni_arr_str_len },
  { "omni_arr_str_new", (void *)omni_arr_str_new },
  { "omni_arr_str_pop", (void *)omni_arr_str_pop },
  { "omni_arr_str_push", (void *)omni_arr_str_push },
  { "omni_arr_str_set", (void *)omni_arr_str_set },
  { "omni_chr", (void *)omni_chr },
  { "omni_error", (void *)omni_error },
  { "omni_errorf", (void *)omni_errorf },
  { "omni_fail", (void *)omni_fail },
  { "omni_get_env", (void *)omni_get_env },
  { "omni_host_exit_code", (void *)omni_host_exit_code },
  { "omni_host_init", (void *)omni_host_init },
  { "omni_index_of", (void *)omni_index_of },
  { "omni_js_check_uncaught", (void *)omni_js_check_uncaught },
  { "omni_lin_at", (void *)omni_lin_at },
  { "omni_lin_data", (void *)omni_lin_data },
  { "omni_lin_grow", (void *)omni_lin_grow },
  { "omni_lin_init", (void *)omni_lin_init },
  { "omni_lin_size", (void *)omni_lin_size },
  { "omni_nullck", (void *)omni_nullck },
  { "omni_pchk", (void *)omni_pchk },
  { "omni_pnew", (void *)omni_pnew },
  { "omni_print_bool", (void *)omni_print_bool },
  { "omni_print_int", (void *)omni_print_int },
  { "omni_print_real", (void *)omni_print_real },
  { "omni_print_string", (void *)omni_print_string },
  { "omni_psub", (void *)omni_psub },
  { "omni_r_bits", (void *)omni_r_bits },
  { "omni_r_ceil", (void *)omni_r_ceil },
  { "omni_r_fabs", (void *)omni_r_fabs },
  { "omni_r_floor", (void *)omni_r_floor },
  { "omni_r_fmod", (void *)omni_r_fmod },
  { "omni_r_frombits", (void *)omni_r_frombits },
  { "omni_r_nextafter", (void *)omni_r_nextafter },
  { "omni_r_pow", (void *)omni_r_pow },
  { "omni_r_round", (void *)omni_r_round },
  { "omni_r_sqrt", (void *)omni_r_sqrt },
  /* **超越函数那一族**（从前这张表里只有上面那几格"代数"的）：EVAL 两门语言满地
     `sin/cos/tan/exp/log`，`tigrou/balls2k.pss` 一份就要 6 个 —— 少一个这条腿就停在
     `omni-jit: unresolved: omni_r_cos`。名单照 omni.h 的 `omni_r_*` 那一段抄全，
     别只补眼下报缺的那几个（下一份脚本会缺另外几个）。 */
  { "omni_r_sin", (void *)omni_r_sin },
  { "omni_r_cos", (void *)omni_r_cos },
  { "omni_r_tan", (void *)omni_r_tan },
  { "omni_r_asin", (void *)omni_r_asin },
  { "omni_r_acos", (void *)omni_r_acos },
  { "omni_r_atan", (void *)omni_r_atan },
  { "omni_r_atan2", (void *)omni_r_atan2 },
  { "omni_r_sinh", (void *)omni_r_sinh },
  { "omni_r_cosh", (void *)omni_r_cosh },
  { "omni_r_tanh", (void *)omni_r_tanh },
  { "omni_r_exp", (void *)omni_r_exp },
  { "omni_r_log", (void *)omni_r_log },
  { "omni_r_log10", (void *)omni_r_log10 },
  { "omni_r_cbrt", (void *)omni_r_cbrt },
  { "omni_r_hypot", (void *)omni_r_hypot },
  /* `(gfxarr "名字" a0..a3 数组)`：带一整块数组的宿主调用（§19.1）。它与上面那几格
     `omni_gfx_*` 是一族，漏在表外同一个后果。 */
  { "omni_gfx_arr", (void *)omni_gfx_arr },
  { "omni_read_text", (void *)omni_read_text },
  { "omni_refid", (void *)omni_refid },
  { "omni_run_entry", (void *)omni_run_entry },
  { "omni_run_proc", (void *)omni_run_proc },
  { "omni_str_base", (void *)omni_str_base },
  { "omni_str_bool", (void *)omni_str_bool },
  { "omni_str_cat", (void *)omni_str_cat },
  { "omni_str_fixed", (void *)omni_str_fixed },
  { "omni_str_gen", (void *)omni_str_gen },
  { "omni_str_genk", (void *)omni_str_genk },
  { "omni_str_int", (void *)omni_str_int },
  { "omni_str_length", (void *)omni_str_length },
  { "omni_str_real", (void *)omni_str_real },
  { "omni_str_realg", (void *)omni_str_realg },
  { "omni_str_repeat", (void *)omni_str_repeat },
  { "omni_str_sci", (void *)omni_str_sci },
  { "omni_str_sub", (void *)omni_str_sub },
  { "omni_str_upper", (void *)omni_str_upper },
  { "omni_tchk", (void *)omni_tchk },
  { "omni_trunc", (void *)omni_trunc },
  { "omni_write_string", (void *)omni_write_string },
  { "omni_write_text", (void *)omni_write_text },
  { "omni_gfx_frame", (void *)omni_gfx_frame },
  { "omni_gfx_framep", (void *)omni_gfx_framep },
  { "omni_gfx_call", (void *)omni_gfx_call },
  { "omni_gfx_batch", (void *)omni_gfx_batch },
  { "omni_gfx_tex", (void *)omni_gfx_tex },
  { "omni_gfx_frame_fn", (void *)omni_gfx_frame_fn },
  { "omni_gfx_def", (void *)omni_gfx_def },

  /* ---- 运行时的**变量**：要的是那格存储的地址，不是它现在的值。arena 的两个游标就是
         这一类（`omni_alloc` 的快路径在 IR 里原地重建，于是它直接读写这两格）。
         jancy 那边这一类走 mapVariable、与 mapFunction 分成两个口子，理由正是
         这个"地址 vs 值"。

         **两格都是线程局部的**（omni.h 的 `OMNI_TLS`），这儿填的是"建表这条线程"
         那一份的地址 —— JIT 出来的码只在这条线程上跑，所以成立。编译器不认
         `_Thread_local` 的那条腿（`OMNI_NO_TLS`）根本没有这两个符号：那时状态按
         线程查（`omni_arena_slot`），IR 里要重建快路径就得先调它。 ---- */
#ifdef OMNI_NO_TLS
  { "omni_arena_slot", (void *)omni_arena_slot },
#endif
  /* **认 `_Thread_local` 的那条路上这两格不在表里**：`&omni_arena_ptr` 是线程局部量的
     地址，**不是编译期常量** —— 摆进静态初值里 clang 直接报
     `initializer element is not a compile-time constant`，而它卡住的不是某个脚本，是
     "the jit host failed to build with clang" ⇒ **整条 jit 腿一个脚本都起不来**
     （2026-09-25 在 `tigrou/balls2k.pss` 上撞出来的）。改成在 `omni_jit_symbol()` 里
     现取：那一趟就跑在建表这条线程上，取到的正是它自己那一份 —— 与上面那段注写的
     意思一样，而且比"建表时取一次"更准。 */

  /* ---- libc：IR 里**直接** declare 的那两个 ---- */
  { "fflush", (void *)fflush },
  { "memcmp", (void *)memcmp },

  /* ---- libc：**代码生成器自己合成**的那几个（聚合体的拷贝与清零）。IR 里看不见它们，
         所以"扫一遍 declare"发现不了 —— 这一格必须无条件摆上。与 jancy 的
         addStdSymbols 同一个理由（jnc_ct_Jit.cpp:99-112，它连 darwin 上的
         `bzero` / `__bzero` 都单列）。 ---- */
  { "memcpy", (void *)memcpy },
  { "memset", (void *)memset },
  { "memmove", (void *)memmove },
  { "bzero", (void *)bzero },
  { "__bzero", (void *)bzero },

  { NULL, NULL },
};

void *omni_jit_symbol(const char *name) {
  if (name == NULL) return NULL;
#ifndef OMNI_NO_TLS
  /* 线程局部那两格：现取地址（理由见表里那段注）。 */
  if (strcmp(name, "omni_arena_ptr") == 0) return (void *)&omni_arena_ptr;
  if (strcmp(name, "omni_arena_end") == 0) return (void *)&omni_arena_end;
#endif
  for (int i = 0; OMNI_JIT_SYMS[i].name != NULL; i++) {
    if (strcmp(OMNI_JIT_SYMS[i].name, name) == 0) return OMNI_JIT_SYMS[i].addr;
  }
  return NULL;
}
