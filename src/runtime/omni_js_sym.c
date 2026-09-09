/* JS 的 Symbol（ADR-0011 的 ABI 里 js_sym_* 那一段，ADR-0020 P1）
 *
 * 与 backend-js/prelude.js 里的 $js_sym_* 逐条对应 —— 同一个语义的第二次实现，
 * 不是第二份语义。
 *
 * 三件事定死在这儿：
 *   1. **同一性就是地址**。`Symbol("a") !== Symbol("a")` 靠这一条；omni_js_key 的兜底
 *      本来就按地址给引用值发键，所以符号当属性键不必另开一支。
 *   2. `Symbol.for` 另有一张全局注册表，同名共用一格（`Symbol.for("a") === Symbol.for("a")`）。
 *      注册表是一条追加数组：符号总数是个位到十位数，线性找比开哈希便宜，而且
 *      keyFor 那一格本来就是反查。
 *   3. `Symbol()` 与 `Symbol("")` 可观察地不同（前者 description 是 undefined），
 *      所以 has_d 单独记一位，不拿空串当哨兵。
 *
 * 这个运行时不回收（bump arena），所以注册表只增不减，也不必管生存期。
 */
#include "omni.h"

static omni_dyn sym_wrap(omni_js_sym *s) {
  return omni_dyn_of_ref((void *)s, OMNI_DYN_SYM);
}

static omni_js_sym *sym_new_(omni_str d, bool has_d) {
  omni_js_sym *s = (omni_js_sym *)omni_alloc(sizeof(omni_js_sym));
  s->d = d;
  s->has_d = has_d;
  return s;
}

static omni_js_sym *want_sym(omni_dyn v) {
  if (v.tag != OMNI_DYN_SYM) {
    omni_errorf("%s is not a symbol", omni_dyn_tag_name(v.tag));
  }
  return (omni_js_sym *)v.u.ref;
}

/* Symbol.for 的注册表，以及 well-known 那一张 —— 两张是分开的：
   `Symbol.keyFor(Symbol.iterator)` 照规范是 undefined（well-known 不在注册表里）。 */
typedef struct { omni_str key; omni_js_sym *sym; } sym_ent;
static sym_ent *reg_;
static int64_t reg_len_, reg_cap_;
static sym_ent *wk_;
static int64_t wk_len_, wk_cap_;

static omni_js_sym *tbl_find(sym_ent *t, int64_t n, omni_str k) {
  for (int64_t i = 0; i < n; i++) {
    if (omni_str_cmp(t[i].key, k) == 0) return t[i].sym;
  }
  return NULL;
}

static void tbl_add(sym_ent **t, int64_t *n, int64_t *cap, omni_str k, omni_js_sym *s) {
  if (*n == *cap) {
    int64_t c = *cap < 8 ? 8 : *cap * 2;
    sym_ent *p = (sym_ent *)omni_alloc((size_t)c * sizeof(sym_ent));
    for (int64_t i = 0; i < *n; i++) p[i] = (*t)[i];
    *t = p;
    *cap = c;
  }
  (*t)[*n].key = k;
  (*t)[*n].sym = s;
  (*n)++;
}

omni_dyn omni_js_sym_new(omni_dyn desc) {
  if (desc.tag == OMNI_DYN_UNDEF) return sym_wrap(sym_new_(omni_str_new("", 0), false));
  return sym_wrap(sym_new_(omni_s16_to_utf8(omni_js_as_s16(omni_js_str(desc))), true));
}

omni_dyn omni_js_sym_for(omni_dyn key) {
  omni_str k = omni_s16_to_utf8(omni_js_as_s16(omni_js_str(key)));
  omni_js_sym *hit = tbl_find(reg_, reg_len_, k);
  if (hit != NULL) return sym_wrap(hit);
  omni_js_sym *s = sym_new_(k, true);
  tbl_add(&reg_, &reg_len_, &reg_cap_, k, s);
  return sym_wrap(s);
}

omni_dyn omni_js_sym_key_for(omni_dyn s) {
  omni_js_sym *p = want_sym(s);
  for (int64_t i = 0; i < reg_len_; i++) {
    if (reg_[i].sym == p) return omni_js_s16(reg_[i].key);
  }
  return omni_dyn_undef();
}

omni_dyn omni_js_sym_desc(omni_dyn s) {
  omni_js_sym *p = want_sym(s);
  return p->has_d ? omni_js_s16(p->d) : omni_dyn_undef();
}

omni_dyn omni_js_sym_str(omni_dyn s) {
  omni_js_sym *p = want_sym(s);
  omni_str out = omni_str_cat(omni_str_new("Symbol(", 7), p->has_d ? p->d : omni_str_new("", 0));
  return omni_js_s16(omni_str_cat(out, omni_str_new(")", 1)));
}

omni_dyn omni_js_sym_wk(omni_str name) {
  omni_js_sym *hit = tbl_find(wk_, wk_len_, name);
  if (hit != NULL) return sym_wrap(hit);
  /* 描述照 JS：`String(Symbol.iterator)` 是 "Symbol(Symbol.iterator)"，所以描述里
     带上 "Symbol." 前缀（与 prelude 的 $js_sym_wk 同一句）。 */
  omni_js_sym *s = sym_new_(omni_str_cat(omni_str_new("Symbol.", 7), name), true);
  tbl_add(&wk_, &wk_len_, &wk_cap_, name, s);
  return sym_wrap(s);
}
