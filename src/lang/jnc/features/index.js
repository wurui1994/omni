// src/lang/jnc/features/index.js —— jancy 这门语言 = 这几个特性的组合（ADR-0029）
//
// 这一份就是"一门语言由哪些特性拼成"的清单。它可读、可增删、可与别的语言比对：
// 以后 C++ 那门语言会共用 `fields` / `named-types` / `members` 的**引擎**与大部分账，
// 自己换掉 `props`（C++ 没有 jancy 那套属性）、加上模板与 ADL 两个新特性。
//
// 组合的规矩在 core/frontend-engine/feature.js 里：显式优于通配、冲突即错、依赖显式。

import fields from './fields.js';
import namedTypes from './named-types.js';
import members from './members.js';
import props from './props.js';
import moduleItems from './module-items.js';

/** jancy 的特性清单（顺序不重要 —— 冲突是错，不靠顺序解决）。 */
export const JNC_FEATURES = [fields, namedTypes, members, props, moduleItems];

/** 矩阵那两个维度：sort（位置）与 kind（要素）。探针与规格用同一份，免得两边漂开。 */
export const JNC_SORTS = ['module', 'namespace', 'class-body', 'struct-body', 'union-body',
  'opaque-class-body', 'fn-body', 'property-body', 'extension-body'];

export default JNC_FEATURES;
