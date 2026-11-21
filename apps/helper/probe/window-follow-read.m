#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { int32_t x, y; uint32_t w, h, pid; uint64_t birth; } observation;
extern bool chalk_window_bounds(uint32_t window, observation *out);

int main(int argc, const char **argv) {
    if (argc != 2) return 2;
    observation result = {0};
    bool visible = chalk_window_bounds((uint32_t)strtoul(argv[1], NULL, 10), &result);
    printf("{\"visible\":%s,\"x\":%d,\"y\":%d,\"width\":%u,\"height\":%u}\n",
        visible ? "true" : "false", result.x, result.y, result.w, result.h);
}
