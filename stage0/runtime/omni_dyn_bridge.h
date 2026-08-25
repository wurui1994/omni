/* dynamic 的运行期分派：ADR-0008 第 5 节的封闭清单。
 *
 * 要用到具体容器类型（list<dynamic> / dict<string,dynamic>），所以做成宏，
 * 由 C 后端在这两个容器定义之后展开一次。错误消息必须与 JS 侧的 $dyn* 逐字节相同。
 */
#ifndef OMNI_DYN_BRIDGE_H
#define OMNI_DYN_BRIDGE_H

#define OMNI_DYN_BRIDGE(LT, DT) \
static LT omni_dyn_keys_of(omni_dyn v) { \
  DT d = (DT)omni_dyn_as_ref(v, OMNI_DYN_DICT); \
  LT a = LT##_new(); \
  LT##_reserve(a, d->count); \
  for (int64_t i = 0; i < d->n; i++) if (d->live[i]) a->items[a->len++] = omni_dyn_of_string(d->keys[i]); \
  return a; \
} \
static omni_dyn omni_dyn_get(omni_dyn v, omni_dyn k) { \
  if (v.tag == OMNI_DYN_LIST) { \
    if (k.tag != OMNI_DYN_INT) omni_errorf("list index must be int, found %s", omni_dyn_tag_name(k.tag)); \
    return LT##_get((LT)v.u.ref, k.u.i); \
  } \
  if (v.tag == OMNI_DYN_DICT) { \
    if (k.tag != OMNI_DYN_STRING) omni_errorf("dict key must be string, found %s", omni_dyn_tag_name(k.tag)); \
    return DT##_get((DT)v.u.ref, k.u.s); \
  } \
  omni_errorf("cannot index a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return omni_dyn_null(); \
} \
static omni_dyn omni_dyn_set_at(omni_dyn v, omni_dyn k, omni_dyn x) { \
  if (v.tag == OMNI_DYN_LIST) { \
    if (k.tag != OMNI_DYN_INT) omni_errorf("list index must be int, found %s", omni_dyn_tag_name(k.tag)); \
    return LT##_set((LT)v.u.ref, k.u.i, x); \
  } \
  if (v.tag == OMNI_DYN_DICT) { \
    if (k.tag != OMNI_DYN_STRING) omni_errorf("dict key must be string, found %s", omni_dyn_tag_name(k.tag)); \
    return DT##_set((DT)v.u.ref, k.u.s, x); \
  } \
  omni_errorf("cannot index a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return omni_dyn_null(); \
} \
static int64_t omni_dyn_len(omni_dyn v) { \
  if (v.tag == OMNI_DYN_LIST) return ((LT)v.u.ref)->len; \
  if (v.tag == OMNI_DYN_DICT) return ((DT)v.u.ref)->count; \
  if (v.tag == OMNI_DYN_STRING) return v.u.s.len; \
  omni_errorf("dynamic value of tag %s has no length", omni_dyn_tag_name(v.tag)); \
  return 0; \
} \
static LT omni_dyn_iter(omni_dyn v) { \
  if (v.tag == OMNI_DYN_LIST) return (LT)v.u.ref; \
  if (v.tag == OMNI_DYN_DICT) return omni_dyn_keys_of(v); \
  omni_errorf("cannot iterate a dynamic value of tag %s", omni_dyn_tag_name(v.tag)); \
  return NULL; \
} \
static void omni_dyn_push(omni_dyn v, omni_dyn x) { \
  LT##_push((LT)omni_dyn_as_ref(v, OMNI_DYN_LIST), x); \
} \
static bool omni_dyn_has(omni_dyn v, omni_dyn k) { \
  return DT##_contains((DT)omni_dyn_as_ref(v, OMNI_DYN_DICT), omni_dyn_as_string(k)); \
}

#endif /* OMNI_DYN_BRIDGE_H */
