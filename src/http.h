/* Minimal HTTP/1.1 request-head parser for the loopback listener.
 * Scope is deliberately narrow: one request per connection, Content-Length bodies only. */
#ifndef CLAUDEX_HTTP_H
#define CLAUDEX_HTTP_H

#include <stddef.h>

#define HTTP_MAX_HEAD (64u * 1024u)
#define HTTP_MAX_BODY (64u * 1024u * 1024u)

typedef struct {
    char   method[8];
    char   path[256];        /* without query string */
    size_t head_len;         /* bytes up to and including the blank line */
    size_t content_length;
    int    has_content_length;
} http_req_t;

/* Return values: HTTP_OK parsed, HTTP_MORE need more bytes, otherwise the
 * negative of the HTTP status the server should answer with. */
#define HTTP_OK    1
#define HTTP_MORE  0
#define HTTP_E_BAD_REQUEST      (-400)
#define HTTP_E_LENGTH_REQUIRED  (-411)
#define HTTP_E_BODY_TOO_LARGE   (-413)
#define HTTP_E_HEAD_TOO_LARGE   (-431)
#define HTTP_E_NOT_IMPLEMENTED  (-501)

int http_parse_head(const char *buf, size_t len, http_req_t *out);

#endif
