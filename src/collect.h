/* Assembles a complete (non-streamed) Anthropic message from Anthropic stream events.
 * Plug collect_on_event in as the reducer's emit callback. */
#ifndef CLAUDEX_COLLECT_H
#define CLAUDEX_COLLECT_H

#include <stddef.h>
#include "buf.h"

typedef struct collector collector_t;

collector_t *collector_new(void);
void         collector_free(collector_t *c);

/* reducer_emit_cb-compatible; ud is the collector. */
int collect_on_event(void *ud, const char *event, const char *json, size_t len);

/* After the stream ends:
 *   returns 200 and appends the message JSON to out, or
 *   returns the HTTP status of a captured stream error and appends the error JSON, or
 *   returns 502 with an error body if the stream never completed. -1 on OOM. */
int collector_result(collector_t *c, buf_t *out);

#endif
