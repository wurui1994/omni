/* 键的显示形式，只出现在 "key not found: ..." 这类错误消息里，纯冷路径。
   hash / eq 本体在 omni.h（内联，dict 每次查找都走）。 */
#include "omni.h"

omni_str omni_kstr_int(int64_t k) { return omni_str_int(k); }
omni_str omni_kstr_real(double k) { return omni_str_real(k); }
omni_str omni_kstr_bool(bool k) { return omni_str_bool(k); }
omni_str omni_kstr_string(omni_str s) { return omni_str_fmt("\"%.*s\"", (int)s.len, s.p); }
