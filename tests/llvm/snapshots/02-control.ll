; Omni stage0 — MIR -> LLVM IR（ADR-0014 决策 3）

declare void @omni_print_int(i64)
declare void @omni_host_init(i32, ptr)
declare i32 @omni_host_exit_code()
declare void @omni_js_check_uncaught()
declare i32 @fflush(ptr)

define i64 @w__mix(i64 %a0, i64 %a1) {
entry:
  %s0 = alloca i64
  %s1 = alloca i64
  %s2 = alloca i64
  store i64 %a0, ptr %s0
  store i64 %a1, ptr %s1
  store i64 0, ptr %s2
  %v1 = load i64, ptr %s0
  %v2 = load i64, ptr %s1
  %v3 = mul i64 %v1, %v2
  store i64 %v3, ptr %s2
  %v5 = load i64, ptr %s2
  %v6 = add i64 %v5, 16
  ret i64 %v6
}

define i64 @w__tee() {
entry:
  %s0 = alloca i64
  store i64 0, ptr %s0
  store i64 5, ptr %s0
  store i64 7, ptr %s0
  %v3 = add i64 7, 1
  ret i64 %v3
}

define i64 @w__sign(i64 %a0) {
entry:
  %s0 = alloca i64
  store i64 %a0, ptr %s0
  %v0 = load i64, ptr %s0
  %v1 = icmp slt i64 %v0, 0
  br i1 %v1, label %then0, label %else1
then0:
  ret i64 -1
else1:
  %v5 = load i64, ptr %s0
  %v6 = icmp sgt i64 %v5, 0
  br i1 %v6, label %then3, label %else4
then3:
  ret i64 1
else4:
  br label %ifend5
ifend5:
  br label %ifend2
ifend2:
  ret i64 0
}

define i64 @w__cmps() {
entry:
  %s0 = alloca i64
  %s1 = alloca i64
  %s2 = alloca i64
  %s3 = alloca i64
  %s4 = alloca i64
  %s5 = alloca i64
  store i64 0, ptr %s0
  %v1 = icmp eq i64 1, 1
  br i1 %v1, label %then0, label %else1
then0:
  store i64 1, ptr %s1
  br label %ifend2
else1:
  store i64 0, ptr %s1
  br label %ifend2
ifend2:
  %v7 = load i64, ptr %s1
  store i64 %v7, ptr %s0
  %v9 = load i64, ptr %s0
  %v10 = icmp ne i64 1, 2
  br i1 %v10, label %then3, label %else4
then3:
  store i64 1, ptr %s2
  br label %ifend5
else4:
  store i64 0, ptr %s2
  br label %ifend5
ifend5:
  %v16 = load i64, ptr %s2
  %v17 = add i64 %v9, %v16
  store i64 %v17, ptr %s0
  %v19 = load i64, ptr %s0
  %v20 = icmp sle i64 1, 1
  br i1 %v20, label %then6, label %else7
then6:
  store i64 1, ptr %s3
  br label %ifend8
else7:
  store i64 0, ptr %s3
  br label %ifend8
ifend8:
  %v26 = load i64, ptr %s3
  %v27 = add i64 %v19, %v26
  store i64 %v27, ptr %s0
  %v29 = load i64, ptr %s0
  %v30 = icmp sge i64 1, 1
  br i1 %v30, label %then9, label %else10
then9:
  store i64 1, ptr %s4
  br label %ifend11
else10:
  store i64 0, ptr %s4
  br label %ifend11
ifend11:
  %v36 = load i64, ptr %s4
  %v37 = add i64 %v29, %v36
  store i64 %v37, ptr %s0
  %v39 = load i64, ptr %s0
  %v40 = icmp eq i64 0, 0
  br i1 %v40, label %then12, label %else13
then12:
  store i64 1, ptr %s5
  br label %ifend14
else13:
  store i64 0, ptr %s5
  br label %ifend14
ifend14:
  %v46 = load i64, ptr %s5
  %v47 = add i64 %v39, %v46
  store i64 %v47, ptr %s0
  %v49 = load i64, ptr %s0
  ret i64 %v49
}

define i64 @w__even(i64 %a0) {
entry:
  %s0 = alloca i64
  store i64 %a0, ptr %s0
  %v0 = load i64, ptr %s0
  %v1 = icmp eq i64 %v0, 0
  br i1 %v1, label %then0, label %else1
then0:
  ret i64 1
else1:
  br label %ifend2
ifend2:
  %v5 = load i64, ptr %s0
  %v6 = sub i64 %v5, 1
  %v7 = call i64 @w__odd(i64 %v6)
  ret i64 %v7
}

define i64 @w__odd(i64 %a0) {
entry:
  %s0 = alloca i64
  store i64 %a0, ptr %s0
  %v0 = load i64, ptr %s0
  %v1 = icmp eq i64 %v0, 0
  br i1 %v1, label %then0, label %else1
then0:
  ret i64 0
else1:
  br label %ifend2
ifend2:
  %v5 = load i64, ptr %s0
  %v6 = sub i64 %v5, 1
  %v7 = call i64 @w__even(i64 %v6)
  ret i64 %v7
}

define void @w__start() {
entry:
  %v0 = call i64 @w__mix(i64 6, i64 7)
  call void @omni_print_int(i64 %v0)
  %v2 = call i64 @w__tee()
  call void @omni_print_int(i64 %v2)
  %v4 = call i64 @w__sign(i64 -9)
  call void @omni_print_int(i64 %v4)
  %v6 = call i64 @w__sign(i64 0)
  call void @omni_print_int(i64 %v6)
  %v8 = call i64 @w__sign(i64 9)
  call void @omni_print_int(i64 %v8)
  %v10 = call i64 @w__cmps()
  call void @omni_print_int(i64 %v10)
  %v12 = call i64 @w__even(i64 10)
  call void @omni_print_int(i64 %v12)
  %v14 = call i64 @w__odd(i64 10)
  call void @omni_print_int(i64 %v14)
  ret void
}

define void @omni_main() {
entry:
  call void @w__start()
  ret void
}

define i32 @main(i32 %argc, ptr %argv) {
entry:
  call void @omni_host_init(i32 %argc, ptr %argv)
  call void @omni_main()
  call void @omni_js_check_uncaught()
  %fl = call i32 @fflush(ptr null)
  %code = call i32 @omni_host_exit_code()
  ret i32 %code
}
