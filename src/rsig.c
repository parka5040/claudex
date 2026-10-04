#include "rsig.h"

#include <stdlib.h>
#include <string.h>

#define RSIG_PREFIX "cx1:"
#define RSIG_PREFIX_LEN 4

static int id_char_ok(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

static int id_ok(const char *id, size_t n) {
    for (size_t i = 0; i < n; i++)
        if (!id_char_ok(id[i])) return 0;
    return 1;
}

int rsig_encode(buf_t *out, const char *id, const char *encrypted) {
    if (!id) id = "";
    if (!encrypted || !*encrypted || !id_ok(id, strlen(id))) return -1;
    size_t mark = out->len;
    if (buf_append_str(out, RSIG_PREFIX) || buf_append_str(out, id) ||
        buf_append_str(out, ":") || buf_append_str(out, encrypted)) {
        out->len = mark;
        if (out->data) out->data[mark] = '\0';
        return -1;
    }
    return 0;
}

int rsig_decode(const char *sig, char **id, char **encrypted) {
    if (strncmp(sig, RSIG_PREFIX, RSIG_PREFIX_LEN) != 0) return -1;
    const char *id_start = sig + RSIG_PREFIX_LEN;
    const char *colon = strchr(id_start, ':');
    if (!colon || colon[1] == '\0') return -1;
    size_t id_len = (size_t)(colon - id_start);
    if (!id_ok(id_start, id_len)) return -1;

    char *i = strndup(id_start, id_len);
    char *e = strdup(colon + 1);
    if (!i || !e) { free(i); free(e); return -1; }
    *id = i;
    *encrypted = e;
    return 0;
}
