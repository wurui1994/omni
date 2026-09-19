/* 本文件由 tools/gen-bc-defs.js 从 src/core/lua/bc.js 生成 —— 不要手改 */
#ifndef OMNI_LUA_BC_DEFS_H
#define OMNI_LUA_BC_DEFS_H

typedef enum {
    OP_LdaNil = 0,
    OP_LdaTrue = 1,
    OP_LdaFalse = 2,
    OP_LdaK = 3,
    OP_LdaR = 4,
    OP_StaR = 5,
    OP_Mov = 6,
    OP_LdaGlobal = 7,
    OP_StaGlobal = 8,
    OP_LdaUp = 9,
    OP_StaUp = 10,
    OP_LdaEnv = 11,
    OP_StaEnv = 12,
    OP_Add = 13,
    OP_Sub = 14,
    OP_Mul = 15,
    OP_Div = 16,
    OP_Mod = 17,
    OP_Pow = 18,
    OP_Concat = 19,
    OP_Neg = 20,
    OP_Not = 21,
    OP_Len = 22,
    OP_Eq = 23,
    OP_Ne = 24,
    OP_Lt = 25,
    OP_Le = 26,
    OP_Gt = 27,
    OP_Ge = 28,
    OP_NewTable = 29,
    OP_NewShaped = 30,
    OP_GetNamed = 31,
    OP_SetNamed = 32,
    OP_GetKeyed = 33,
    OP_SetKeyed = 34,
    OP_SetMeta = 35,
    OP_Call = 36,
    OP_CallMethod = 37,
    OP_CallBuiltin = 38,
    OP_Ret = 39,
    OP_RetMulti = 40,
    OP_Jump = 41,
    OP_JumpIfTrue = 42,
    OP_JumpIfFalse = 43,
    OP_JumpIfNil = 44,
    OP_JumpLoop = 45,
    OP_ForPrep = 46,
    OP_ForLoop = 47,
    OP_Closure = 48,
    OP_GetFields = 49,
    OP_Print = 50,
    OP_Nop = 51,
    OP_VarargTable = 52,
    OP__COUNT = 53
} OmniOp;

/* 每条指令的总长度（含 opcode 那一字节） */
static const unsigned char omni_op_len[OP__COUNT] = {
    1, 1, 1, 3, 2, 2, 3, 5, 5, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4, 4, 3, 1, 3, 4, 4, 4, 4, 4, 4, 2, 7, 6, 6, 5, 5, 2, 5, 7, 4, 1, 3, 5, 5, 5, 5, 5, 6, 6, 4, 8, 3, 1, 1
};

/* 操作数签名（调试与反汇编用） */
static const char *const omni_op_sig[OP__COUNT] = {
    "", "", "", "k", "r", "r", "rr", "kf", "kf", "i", "i", "i", "i", "rf", "rf", "rf", "rf", "rf", "rf", "rf", "f", "", "f", "rf", "rf", "rf", "rf", "rf", "rf", "i", "kiif", "rkf", "rkf", "rrf", "rrf", "r", "rif", "rkif", "rii", "", "ri", "j", "j", "j", "j", "j", "rj", "rj", "ki", "rkiif", "ri", "", ""
};

static const char *const omni_op_name[OP__COUNT] = {
    "LdaNil", "LdaTrue", "LdaFalse", "LdaK", "LdaR", "StaR", "Mov", "LdaGlobal", "StaGlobal", "LdaUp", "StaUp", "LdaEnv", "StaEnv", "Add", "Sub", "Mul", "Div", "Mod", "Pow", "Concat", "Neg", "Not", "Len", "Eq", "Ne", "Lt", "Le", "Gt", "Ge", "NewTable", "NewShaped", "GetNamed", "SetNamed", "GetKeyed", "SetKeyed", "SetMeta", "Call", "CallMethod", "CallBuiltin", "Ret", "RetMulti", "Jump", "JumpIfTrue", "JumpIfFalse", "JumpIfNil", "JumpLoop", "ForPrep", "ForLoop", "Closure", "GetFields", "Print", "Nop", "VarargTable"
};

#endif /* OMNI_LUA_BC_DEFS_H */
