/* Incremental Server-Sent Events parser (WHATWG event-stream framing). */
#ifndef CLAUDEX_SSE_H
#define CLAUDEX_SSE_H

#include <stddef.h>
#include "buf.h"

#define SSE_MAX_LINE (16u * 1024u * 1024u)

/* Called once per dispatched event. event is "" when no event: field was sent.
 * Return nonzero to stop parsing; sse_feed returns that value. */
typedef int (*sse_event_cb)(void *ud, const char *event, const char *data, size_t data_len);

typedef struct {
    buf_t line;      /* partial line carried across chunks */
    buf_t event;     /* current event name */
    buf_t data;      /* current data, lines joined by '\n' */
    int   have_data;
    int   skip_lf;   /* previous chunk ended in '\r': swallow a leading '\n' */
} sse_parser_t;

void sse_parser_init(sse_parser_t *p);
void sse_parser_free(sse_parser_t *p);

#define SSE_ERR_NOMEM    (-1)
#define SSE_ERR_TOO_LONG (-2)
/* Feed raw bytes. Returns 0, a nonzero callback result, or an SSE_ERR_* code. */
int sse_feed(sse_parser_t *p, const char *chunk, size_t n, sse_event_cb cb, void *ud);

#endif
