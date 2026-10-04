/* Reasoning signature: carries an upstream reasoning item's id and encrypted_content
 * inside the Anthropic thinking block's `signature`, so Claude Code echoes it back and
 * the proxy can rebuild the reasoning input item without keeping any state.
 * Format: "cx1:<id>:<encrypted_content>"  (id may be empty). */
#ifndef CLAUDEX_RSIG_H
#define CLAUDEX_RSIG_H

#include "buf.h"

/* Appends the signature to out. id may be NULL/"". Returns 0, or -1 if the id has
 * characters outside [A-Za-z0-9_-], encrypted is empty, or allocation fails. */
int rsig_encode(buf_t *out, const char *id, const char *encrypted);

/* Splits a signature produced by rsig_encode. On success returns 0 and sets *id and
 * *encrypted to malloc'd strings (*id is "" when absent). Returns -1 for anything
 * else, including genuine Anthropic signatures, which must never be sent upstream. */
int rsig_decode(const char *sig, char **id, char **encrypted);

#endif
