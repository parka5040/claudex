#include "buf.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void buf_init(buf_t *b) {
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

void buf_free(buf_t *b) {
    free(b->data);
    buf_init(b);
}

void buf_free_secret(buf_t *b) {
    if (b->data) explicit_bzero(b->data, b->cap);
    buf_free(b);
}

/* Ensure room for `extra` more bytes plus the terminating NUL. */
static int buf_reserve(buf_t *b, size_t extra) {
    if (extra > SIZE_MAX - b->len - 1) return -1;
    size_t need = b->len + extra + 1;
    if (need <= b->cap) return 0;
    size_t cap = b->cap ? b->cap : 256;
    while (cap < need) {
        if (cap > SIZE_MAX / 2) { cap = need; break; }
        cap *= 2;
    }
    char *p = realloc(b->data, cap);
    if (!p) return -1;
    b->data = p;
    b->cap = cap;
    return 0;
}

int buf_append(buf_t *b, const void *p, size_t n) {
    if (buf_reserve(b, n) != 0) return -1;
    if (n) memcpy(b->data + b->len, p, n);
    b->len += n;
    b->data[b->len] = '\0';
    return 0;
}

int buf_append_str(buf_t *b, const char *s) {
    return buf_append(b, s, strlen(s));
}

int buf_appendf(buf_t *b, const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0 || buf_reserve(b, (size_t)n) != 0) {
        va_end(ap2);
        return -1;
    }
    vsnprintf(b->data + b->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    b->len += (size_t)n;
    return 0;
}

void buf_consume(buf_t *b, size_t n) {
    if (!b->data) return;
    if (n > b->len) n = b->len;
    memmove(b->data, b->data + n, b->len - n);
    b->len -= n;
    b->data[b->len] = '\0';
}
