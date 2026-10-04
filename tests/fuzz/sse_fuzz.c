#include <stddef.h>
#include <stdint.h>
#include "sse.h"

static int sink(void *ud, const char *e, const char *d, size_t n) { (void)ud; (void)e; (void)d; (void)n; return 0; }

/* First byte picks the chunk size so the same input exercises many split points. */
int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    if (size < 1) return 0;
    size_t chunk = (size_t)data[0] % 17 + 1;
    sse_parser_t p; sse_parser_init(&p);
    for (size_t off = 1; off < size; off += chunk)
        if (sse_feed(&p, (const char *)data + off, size - off < chunk ? size - off : chunk, sink, NULL) != 0) break;
    sse_parser_free(&p);
    return 0;
}
