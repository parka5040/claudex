/* Reduces upstream Responses-API stream events into Anthropic Messages stream events. */
#ifndef CLAUDEX_REDUCER_H
#define CLAUDEX_REDUCER_H

#include <stddef.h>

/* Receives one Anthropic SSE event (name + JSON body). Nonzero return aborts the
 * reduction (e.g. the client went away) and is propagated to the caller. */
typedef int (*reducer_emit_cb)(void *ud, const char *event, const char *json, size_t len);

typedef struct reducer reducer_t;

/* client_model: the model string to report back to Claude Code (what it asked for). */
reducer_t *reducer_new(const char *client_model, reducer_emit_cb emit, void *ud);
void       reducer_free(reducer_t *r);

/* Feed the JSON payload of one upstream SSE `data:` field. Unknown or malformed
 * events are ignored. Returns 0, the emit callback's nonzero result, or -1 on OOM. */
int reducer_on_event(reducer_t *r, const char *json, size_t len);

/* Upstream ended. If no terminal event was seen, emits an Anthropic error event. */
int reducer_finish(reducer_t *r);

/* 1 once a terminal event (completed / incomplete / failed) has been handled. */
int reducer_done(const reducer_t *r);

#endif
