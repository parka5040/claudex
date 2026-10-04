/* Anthropic-shaped error bodies: {"type":"error","error":{"type":...,"message":...}} */
#ifndef CLAUDEX_ERRORS_H
#define CLAUDEX_ERRORS_H

#include "buf.h"

/* Anthropic error type string for an HTTP status (static storage). */
const char *anthropic_error_type(int status);

/* Appends the JSON error body for `status` to out. Returns 0, or -1 on allocation failure. */
int anthropic_error_body(buf_t *out, int status, const char *message);

#endif
