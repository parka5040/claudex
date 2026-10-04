/* Translates an Anthropic Messages request body into an upstream Responses request body. */
#ifndef CLAUDEX_TRANSLATE_REQ_H
#define CLAUDEX_TRANSLATE_REQ_H

#include <stddef.h>
#include "models.h"

typedef struct {
    char       *body;          /* upstream JSON, malloc'd */
    size_t      body_len;
    char       *client_model;  /* model string exactly as the client sent it */
    model_sel_t sel;           /* resolved upstream slug + effort */
    int         stream;        /* did the client ask for a streamed response? */
    char        session_id[80];/* cache-affinity key ("" if the client sent none) */
} xlate_req_t;

/* Returns 0 on success. On failure returns the negative HTTP status to answer with
 * (-400 malformed request, -404 unknown model) and writes a message to err. */
int  translate_request(const char *json, size_t len, xlate_req_t *out, char *err, size_t errlen);
void xlate_req_free(xlate_req_t *x);

#endif
