#include "auth.h"

#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <yyjson.h>

#define AUTH_MAX_FILE (1u << 20)

static void secret_free(char *s) {
    if (!s) return;
    explicit_bzero(s, strlen(s));
    free(s);
}

void auth_free(auth_t *a) {
    secret_free(a->access_token);
    free(a->account_id);
    a->access_token = NULL;
    a->account_id = NULL;
    a->exp = -1;
}

const char *auth_strerror(int code) {
    switch (code) {
    case AUTH_OK:         return "ok";
    case AUTH_E_IO:       return "cannot read the Codex auth file; run `codex login` (claudex uses Codex's ChatGPT login)";
    case AUTH_E_PARSE:    return "Codex auth file is not valid JSON";
    case AUTH_E_NO_LOGIN: return "no ChatGPT login in Codex auth file; run `codex login`";
    case AUTH_E_NOMEM:    return "out of memory";
    default:              return "unknown auth error";
    }
}

static int b64url_val(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}

/* Decodes unpadded base64url. Returns malloc'd bytes (NUL-terminated) or NULL. */
static char *b64url_decode(const char *s, size_t n, size_t *out_len) {
    while (n && s[n - 1] == '=') n--;
    if (n % 4 == 1) return NULL;
    char *out = malloc(n / 4 * 3 + 3);
    if (!out) return NULL;
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        int v = b64url_val((unsigned char)s[i]);
        if (v < 0) { free(out); return NULL; }
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (char)((acc >> bits) & 0xff);
        }
    }
    out[o] = '\0';
    *out_len = o;
    return out;
}

long long jwt_exp(const char *jwt) {
    const char *dot1 = strchr(jwt, '.');
    if (!dot1) return -1;
    const char *dot2 = strchr(dot1 + 1, '.');
    if (!dot2) return -1;

    size_t plen;
    char *payload = b64url_decode(dot1 + 1, (size_t)(dot2 - dot1 - 1), &plen);
    if (!payload) return -1;

    long long exp = -1;
    yyjson_doc *doc = yyjson_read(payload, plen, 0);
    if (doc) {
        yyjson_val *v = yyjson_obj_get(yyjson_doc_get_root(doc), "exp");
        if (yyjson_is_int(v)) exp = yyjson_get_sint(v);
        yyjson_doc_free(doc);
    }
    free(payload);
    return exp;
}

/* A value we will place in an HTTP header: non-empty, printable ASCII, no spaces/control. */
static int header_safe(const char *s) {
    if (!s || !*s) return 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        if (*p <= 0x20 || *p >= 0x7f) return 0;
    return 1;
}

static int read_file(const char *path, char **out, size_t *out_len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return AUTH_E_IO;
    size_t cap = AUTH_MAX_FILE + YYJSON_PADDING_SIZE;
    char *buf = calloc(1, cap);
    if (!buf) { close(fd); return AUTH_E_NOMEM; }
    size_t len = 0;
    for (;;) {
        ssize_t r = read(fd, buf + len, AUTH_MAX_FILE - len);
        if (r < 0) { close(fd); explicit_bzero(buf, cap); free(buf); return AUTH_E_IO; }
        if (r == 0) break;
        len += (size_t)r;
        if (len == AUTH_MAX_FILE) { close(fd); explicit_bzero(buf, cap); free(buf); return AUTH_E_IO; }
    }
    close(fd);
    *out = buf;
    *out_len = len;
    return AUTH_OK;
}

int auth_load(const char *path, auth_t *out) {
    out->access_token = NULL;
    out->account_id = NULL;
    out->exp = -1;

    char *file;
    size_t len;
    int rc = read_file(path, &file, &len);
    if (rc != AUTH_OK) return rc;

    /* In-situ parse: string values point into `file`, so zeroing it clears every copy. */
    yyjson_doc *doc = yyjson_read_opts(file, len, YYJSON_READ_INSITU, NULL, NULL);
    if (!doc) {
        rc = AUTH_E_PARSE;
    } else {
        yyjson_val *tokens = yyjson_obj_get(yyjson_doc_get_root(doc), "tokens");
        const char *tok = yyjson_get_str(yyjson_obj_get(tokens, "access_token"));
        const char *acct = yyjson_get_str(yyjson_obj_get(tokens, "account_id"));
        if (!header_safe(tok) || !header_safe(acct)) {
            rc = AUTH_E_NO_LOGIN;
        } else {
            out->access_token = strdup(tok);
            out->account_id = strdup(acct);
            if (!out->access_token || !out->account_id) {
                auth_free(out);
                rc = AUTH_E_NOMEM;
            } else {
                out->exp = jwt_exp(out->access_token);
            }
        }
        yyjson_doc_free(doc);
    }
    explicit_bzero(file, AUTH_MAX_FILE + YYJSON_PADDING_SIZE);
    free(file);
    return rc;
}
