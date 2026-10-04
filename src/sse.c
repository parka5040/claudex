#include "sse.h"

#include <string.h>

void sse_parser_init(sse_parser_t *p) {
    buf_init(&p->line);
    buf_init(&p->event);
    buf_init(&p->data);
    p->have_data = 0;
    p->skip_lf = 0;
}

void sse_parser_free(sse_parser_t *p) {
    buf_free(&p->line);
    buf_free(&p->event);
    buf_free(&p->data);
    p->have_data = 0;
    p->skip_lf = 0;
}

static int set_buf(buf_t *b, const char *s, size_t n) {
    b->len = 0;
    return buf_append(b, s, n);
}

/* Handle one complete line (without its terminator). */
static int on_line(sse_parser_t *p, const char *s, size_t n, sse_event_cb cb, void *ud) {
    if (n == 0) { /* blank line: dispatch */
        int rc = 0;
        if (p->have_data)
            rc = cb(ud, p->event.data ? p->event.data : "", p->data.data ? p->data.data : "", p->data.len);
        p->event.len = 0;
        if (p->event.data) p->event.data[0] = '\0';
        p->data.len = 0;
        if (p->data.data) p->data.data[0] = '\0';
        p->have_data = 0;
        return rc;
    }
    if (s[0] == ':') return 0; /* comment */

    const char *colon = memchr(s, ':', n);
    size_t name_len = colon ? (size_t)(colon - s) : n;
    const char *val = colon ? colon + 1 : s + n;
    size_t val_len = colon ? n - name_len - 1 : 0;
    if (val_len && val[0] == ' ') { val++; val_len--; }

    if (name_len == 4 && memcmp(s, "data", 4) == 0) {
        if (p->have_data && buf_append(&p->data, "\n", 1) != 0) return SSE_ERR_NOMEM;
        if (buf_append(&p->data, val, val_len) != 0) return SSE_ERR_NOMEM;
        p->have_data = 1;
    } else if (name_len == 5 && memcmp(s, "event", 5) == 0) {
        if (set_buf(&p->event, val, val_len) != 0) return SSE_ERR_NOMEM;
    }
    return 0; /* id, retry and unknown fields are ignored */
}

int sse_feed(sse_parser_t *p, const char *chunk, size_t n, sse_event_cb cb, void *ud) {
    size_t i = 0;
    if (p->skip_lf && n) {
        if (chunk[0] == '\n') i = 1;
        p->skip_lf = 0;
    }
    while (i < n) {
        size_t start = i;
        while (i < n && chunk[i] != '\n' && chunk[i] != '\r') i++;
        if (i == n) { /* no terminator yet: stash the partial line */
            if (p->line.len + (i - start) > SSE_MAX_LINE) return SSE_ERR_TOO_LONG;
            if (buf_append(&p->line, chunk + start, i - start) != 0) return SSE_ERR_NOMEM;
            return 0;
        }
        int rc;
        if (p->line.len) {
            if (p->line.len + (i - start) > SSE_MAX_LINE) return SSE_ERR_TOO_LONG;
            if (buf_append(&p->line, chunk + start, i - start) != 0) return SSE_ERR_NOMEM;
            rc = on_line(p, p->line.data, p->line.len, cb, ud);
            p->line.len = 0;
            p->line.data[0] = '\0';
        } else {
            rc = on_line(p, chunk + start, i - start, cb, ud);
        }
        if (chunk[i] == '\r') {
            if (i + 1 < n) { if (chunk[i + 1] == '\n') i++; }
            else p->skip_lf = 1;
        }
        i++;
        if (rc != 0) return rc;
    }
    return 0;
}
