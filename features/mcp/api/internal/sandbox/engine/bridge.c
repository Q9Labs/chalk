// JSON is the only boundary between QuickJS and Go. No JS values or host pointers cross it.
#include "quickjs.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

__attribute__((import_module("chalk"), import_name("call")))
extern int32_t host_call(const char *, uint32_t, char *, uint32_t);
__attribute__((import_module("chalk"), import_name("emit")))
extern void host_emit(int32_t, const char *, uint32_t);

static unsigned interrupts;
static int interrupt(JSRuntime *rt, void *opaque) {
    (void)rt;
    (void)opaque;
    return ++interrupts > 1000;
}

static JSValue call(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 1) return JS_ThrowTypeError(ctx, "Expected serialized call");
    size_t size;
    const char *request = JS_ToCStringLen(ctx, &size, argv[0]);
    if (!request) return JS_EXCEPTION;
    const uint32_t capacity = 128 * 1024;
    char *response = malloc(capacity);
    if (!response) { JS_FreeCString(ctx, request); return JS_ThrowOutOfMemory(ctx); }
    int32_t n = host_call(request, size, response, capacity);
    JS_FreeCString(ctx, request);
    JSValue result = n >= 0 && (uint32_t)n <= capacity
        ? JS_NewStringLen(ctx, response, n)
        : JS_ThrowInternalError(ctx, "Call limit exceeded");
    free(response);
    return result;
}

static JSValue emit(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    if (argc != 2) return JS_ThrowTypeError(ctx, "Expected output kind and JSON");
    int32_t kind;
    if (JS_ToInt32(ctx, &kind, argv[0]) < 0) return JS_EXCEPTION;
    size_t size;
    const char *data = JS_ToCStringLen(ctx, &size, argv[1]);
    if (!data) return JS_EXCEPTION;
    host_emit(kind, data, size);
    JS_FreeCString(ctx, data);
    return JS_UNDEFINED;
}

__attribute__((export_name("alloc")))
void *alloc(uint32_t size) { return malloc(size); }

__attribute__((export_name("run")))
int run(const char *source, uint32_t size) {
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return -1;
    JS_SetMemoryLimit(rt, 24 * 1024 * 1024);
    JS_SetMaxStackSize(rt, 512 * 1024);
    interrupts = 0;
    JS_SetInterruptHandler(rt, interrupt, NULL);
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) { JS_FreeRuntime(rt); return -1; }
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "__chalk_call", JS_NewCFunction(ctx, call, "call", 1));
    JS_SetPropertyStr(ctx, global, "__chalk_emit", JS_NewCFunction(ctx, emit, "emit", 2));
    JS_FreeValue(ctx, global);
    JSValue value = JS_Eval(ctx, source, size, "chalk-program.js", JS_EVAL_TYPE_GLOBAL);
    int failed = JS_IsException(value);
    JS_FreeValue(ctx, value);
    while (!failed && JS_IsJobPending(rt)) {
        JSContext *job;
        failed = JS_ExecutePendingJob(rt, &job) < 0;
    }
    // The instance is discarded by wazero. Do not walk an attacker-controlled heap on teardown.
    return failed ? -1 : 0;
}
