#include "http.h"

#include <stdint.h>
#include <string.h>
#include <strings.h>

/* Find "\r\n\r\n"; returns offset just past it, or 0 if absent. */
static size_t find_head_end(const char *buf, size_t len) {
    if (len < 4) return 0;
    const char *p = memmem(buf, len, "\r\n\r\n", 4);
    return p ? (size_t)(p - buf) + 4 : 0;
}

static int parse_request_line(const char *s, size_t n, http_req_t *out) {
    const char *sp1 = memchr(s, ' ', n);
    if (!sp1) return HTTP_E_BAD_REQUEST;
    size_t mlen = (size_t)(sp1 - s);
    if (mlen == 0 || mlen >= sizeof out->method) return HTTP_E_BAD_REQUEST;

    const char *target = sp1 + 1;
    size_t rest = n - mlen - 1;
    const char *sp2 = memchr(target, ' ', rest);
    if (!sp2) return HTTP_E_BAD_REQUEST;
    size_t tlen = (size_t)(sp2 - target);
    const char *ver = sp2 + 1;
    size_t vlen = rest - tlen - 1;
    if (vlen != 8 || (memcmp(ver, "HTTP/1.1", 8) != 0 && memcmp(ver, "HTTP/1.0", 8) != 0))
        return HTTP_E_BAD_REQUEST;
    if (tlen == 0 || target[0] != '/') return HTTP_E_BAD_REQUEST;

    const char *q = memchr(target, '?', tlen);
    size_t plen = q ? (size_t)(q - target) : tlen;
    if (plen >= sizeof out->path) return HTTP_E_BAD_REQUEST;

    memcpy(out->method, s, mlen);
    out->method[mlen] = '\0';
    memcpy(out->path, target, plen);
    out->path[plen] = '\0';
    return HTTP_OK;
}

static int parse_content_length(const char *v, size_t n, size_t *out) {
    if (n == 0) return HTTP_E_BAD_REQUEST;
    size_t val = 0;
    for (size_t i = 0; i < n; i++) {
        if (v[i] < '0' || v[i] > '9') return HTTP_E_BAD_REQUEST;
        size_t d = (size_t)(v[i] - '0');
        if (val > (SIZE_MAX - d) / 10) return HTTP_E_BAD_REQUEST;
        val = val * 10 + d;
    }
    *out = val;
    return HTTP_OK;
}

int http_parse_head(const char *buf, size_t len, http_req_t *out) {
    size_t head_len = find_head_end(buf, len < HTTP_MAX_HEAD ? len : HTTP_MAX_HEAD);
    if (!head_len) return len > HTTP_MAX_HEAD ? HTTP_E_HEAD_TOO_LARGE : HTTP_MORE;
    if (memchr(buf, '\0', head_len)) return HTTP_E_BAD_REQUEST;

    memset(out, 0, sizeof *out);
    out->head_len = head_len;

    const char *line = buf;
    const char *end = buf + head_len - 2; /* points at the final blank line's CRLF */
    const char *eol = memmem(line, (size_t)(end - line), "\r\n", 2);
    if (!eol) return HTTP_E_BAD_REQUEST;
    int rc = parse_request_line(line, (size_t)(eol - line), out);
    if (rc != HTTP_OK) return rc;

    int chunked = 0;
    for (line = eol + 2; line < end; line = eol + 2) {
        eol = memmem(line, (size_t)(end - line) + 2, "\r\n", 2);
        if (!eol) return HTTP_E_BAD_REQUEST;
        size_t n = (size_t)(eol - line);
        const char *colon = memchr(line, ':', n);
        if (!colon || colon == line) return HTTP_E_BAD_REQUEST;
        size_t name_len = (size_t)(colon - line);
        const char *v = colon + 1;
        size_t vlen = n - name_len - 1;
        while (vlen && (*v == ' ' || *v == '\t')) { v++; vlen--; }
        while (vlen && (v[vlen - 1] == ' ' || v[vlen - 1] == '\t')) vlen--;

        if (name_len == 14 && strncasecmp(line, "content-length", 14) == 0) {
            size_t cl;
            rc = parse_content_length(v, vlen, &cl);
            if (rc != HTTP_OK) return rc;
            if (out->has_content_length && out->content_length != cl) return HTTP_E_BAD_REQUEST;
            out->has_content_length = 1;
            out->content_length = cl;
        } else if (name_len == 17 && strncasecmp(line, "transfer-encoding", 17) == 0) {
            chunked = 1;
        }
    }

    if (chunked) return HTTP_E_NOT_IMPLEMENTED;
    if (out->content_length > HTTP_MAX_BODY) return HTTP_E_BODY_TOO_LARGE;
    if (strcmp(out->method, "POST") == 0 && !out->has_content_length) return HTTP_E_LENGTH_REQUIRED;
    return HTTP_OK;
}
