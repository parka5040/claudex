/* Growable byte buffer. data is always NUL-terminated (data[len] == 0) once non-NULL. */
#ifndef CLAUDEX_BUF_H
#define CLAUDEX_BUF_H

#include <stddef.h>

typedef struct {
    char  *data;
    size_t len;
    size_t cap;
} buf_t;

void buf_init(buf_t *b);
void buf_free(buf_t *b);
/* All appenders return 0 on success, -1 on allocation failure (buffer unchanged). */
int  buf_append(buf_t *b, const void *p, size_t n);
int  buf_append_str(buf_t *b, const char *s);
int  buf_appendf(buf_t *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
/* Drop the first n bytes (n is clamped to len). */
void buf_consume(buf_t *b, size_t n);
/* Overwrite contents with zeros before freeing; for buffers that held secrets. */
void buf_free_secret(buf_t *b);

#endif
