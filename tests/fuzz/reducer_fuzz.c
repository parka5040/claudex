#include <stddef.h>
#include <stdint.h>
#include "collect.h"
#include "reducer.h"
#include "sse.h"

static int to_reducer(void *ud, const char *e, const char *d, size_t n) { (void)e; return reducer_on_event(ud, d, n); }

/* Whole upstream path: raw SSE bytes -> parser -> reducer -> collector -> final JSON. */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    collector_t *c = collector_new();
    reducer_t *r = reducer_new("gpt-5.6-sol", collect_on_event, c);
    sse_parser_t p; sse_parser_init(&p);
    sse_feed(&p, (const char *)data, size, to_reducer, r);
    reducer_finish(r);
    buf_t out; buf_init(&out);
    collector_result(c, &out);
    buf_free(&out);
    sse_parser_free(&p); reducer_free(r); collector_free(c);
    return 0;
}
