#include "server.h"

#include "auth.h"
#include "buf.h"
#include "collect.h"
#include "errors.h"
#include "http.h"
#include "models.h"
#include "reducer.h"
#include "sse.h"
#include "translate_req.h"
#include "upstream.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <semaphore.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <yyjson.h>

#define MAX_CONNECTIONS 64
#define CLIENT_IO_TIMEOUT_S 60

static sem_t conn_slots;
static atomic_ulong next_request_id;

/* ---- logging: metadata only, never headers or bodies -------------------- */

static void log_line(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void log_line(const char *fmt, ...) {
    char line[512];
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    gmtime_r(&ts.tv_sec, &tm);
    size_t n = strftime(line, sizeof line, "%Y-%m-%dT%H:%M:%SZ ", &tm);
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line + n, sizeof line - n - 1, fmt, ap);
    va_end(ap);
    n = strlen(line);
    line[n++] = '\n';
    ssize_t w = write(STDERR_FILENO, line, n); /* one write per line keeps threads from interleaving */
    (void)w;
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ---- client socket helpers --------------------------------------------- */

static int send_all(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static const char *reason_phrase(int status) {
    switch (status) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 411: return "Length Required";
    case 413: return "Payload Too Large";
    case 429: return "Too Many Requests";
    case 431: return "Request Header Fields Too Large";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 529: return "Overloaded";
    default:  return status >= 500 ? "Internal Server Error" : "Error";
    }
}

static int send_json(int fd, int status, const char *body, size_t len, const char *extra_headers) {
    buf_t h; buf_init(&h);
    int rc = buf_appendf(&h, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%sConnection: close\r\n\r\n",
                         status, reason_phrase(status), len, extra_headers ? extra_headers : "");
    if (rc == 0) rc = send_all(fd, h.data, h.len);
    if (rc == 0) rc = send_all(fd, body, len);
    buf_free(&h);
    return rc;
}

static int send_error(int fd, int status, const char *message, const char *extra_headers) {
    buf_t b; buf_init(&b);
    int rc = anthropic_error_body(&b, status, message);
    if (rc == 0) rc = send_json(fd, status, b.data, b.len, extra_headers);
    buf_free(&b);
    return rc;
}

/* ---- one /v1/messages exchange ------------------------------------------ */

typedef struct {
    int          fd;
    int          stream;        /* client wants SSE */
    int          head_sent;
    int          client_gone;
    reducer_t   *reducer;
    collector_t *collector;
    sse_parser_t parser;
    long long    in_tokens, out_tokens, cached_tokens;
} exchange_t;

/* Reducer output: note usage for the log, then stream it out or collect it. */
static int on_anthropic_event(void *ud, const char *event, const char *json, size_t len) {
    exchange_t *x = ud;
    if (!strcmp(event, "message_delta")) {
        yyjson_doc *d = yyjson_read(json, len, 0);
        yyjson_val *u = d ? yyjson_obj_get(yyjson_doc_get_root(d), "usage") : NULL;
        x->in_tokens = yyjson_get_sint(yyjson_obj_get(u, "input_tokens"));
        x->out_tokens = yyjson_get_sint(yyjson_obj_get(u, "output_tokens"));
        x->cached_tokens = yyjson_get_sint(yyjson_obj_get(u, "cache_read_input_tokens"));
        yyjson_doc_free(d);
    }
    if (!x->stream) return collect_on_event(x->collector, event, json, len);

    buf_t out; buf_init(&out);
    int rc = 0;
    if (!x->head_sent) {
        x->head_sent = 1;
        rc = buf_append_str(&out, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                                  "Cache-Control: no-cache\r\nConnection: close\r\n\r\n");
    }
    if (rc == 0) rc = buf_appendf(&out, "event: %s\ndata: ", event);
    if (rc == 0) rc = buf_append(&out, json, len);
    if (rc == 0) rc = buf_append_str(&out, "\n\n");
    if (rc == 0 && send_all(x->fd, out.data, out.len) != 0) { x->client_gone = 1; rc = 1; }
    buf_free(&out);
    return rc;
}

static int on_upstream_sse_event(void *ud, const char *event, const char *data, size_t len) {
    (void)event; /* the JSON "type" field is authoritative */
    return reducer_on_event(((exchange_t *)ud)->reducer, data, len);
}

static int on_upstream_bytes(void *ud, const char *data, size_t n) {
    exchange_t *x = ud;
    return sse_feed(&x->parser, data, n, on_upstream_sse_event, x);
}

/* Pulls a human-readable message (and retry hint) out of an upstream error body. */
static void describe_upstream_error(const upstream_res_t *res, buf_t *msg, long long *retry_after) {
    *retry_after = -1;
    yyjson_doc *d = res->err_body.len ? yyjson_read(res->err_body.data, res->err_body.len, 0) : NULL;
    yyjson_val *e = d ? yyjson_obj_get(yyjson_doc_get_root(d), "error") : NULL;
    const char *m = yyjson_get_str(yyjson_obj_get(e, "message"));
    if (!m && yyjson_is_str(e)) m = yyjson_get_str(e);
    if (!m) m = yyjson_get_str(yyjson_obj_get(d ? yyjson_doc_get_root(d) : NULL, "detail"));
    if (!m && !d && res->err_body.len) m = res->err_body.data;
    buf_appendf(msg, "upstream %ld: %.2000s", res->status, m ? m : "(no error message)");

    yyjson_val *rs = yyjson_obj_get(e, "resets_in_seconds");
    yyjson_val *ra = yyjson_obj_get(e, "resets_at");
    if (yyjson_is_int(rs)) *retry_after = yyjson_get_sint(rs);
    else if (yyjson_is_int(ra)) *retry_after = yyjson_get_sint(ra) - (long long)time(NULL);
    if (*retry_after < 0) *retry_after = -1;
    yyjson_doc_free(d);
}

static void handle_messages(int fd, const server_cfg_t *cfg, const char *body, size_t len, unsigned long rid) {
    long long t0 = now_ms();
    char err[512];
    xlate_req_t xr;
    int rc = translate_request(body, len, &xr, err, sizeof err);
    if (rc != 0) {
        send_error(fd, -rc, err, NULL);
        log_line("id=%lu status=%d reason=bad_request", rid, -rc);
        return;
    }

    exchange_t x;
    memset(&x, 0, sizeof x);
    x.fd = fd;
    x.stream = xr.stream;
    upstream_res_t res;
    memset(&res, 0, sizeof res);
    buf_init(&res.err_body);
    int auth_rc = AUTH_OK;
    char *prev_token = NULL;

    for (int attempt = 0; attempt < 2; attempt++) {
        auth_t auth = {0};
        auth_rc = auth_load(cfg->auth_file, &auth);
        if (auth_rc != AUTH_OK) break;
        /* A 401 is only worth retrying if Codex rotated the token in the meantime. */
        if (prev_token && !strcmp(prev_token, auth.access_token)) { auth_free(&auth); break; }

        upstream_res_free(&res);
        x.reducer = reducer_new(xr.client_model, on_anthropic_event, &x);
        x.collector = x.stream ? NULL : collector_new();
        sse_parser_init(&x.parser);
        if (!x.reducer || (!x.stream && !x.collector)) { auth_free(&auth); auth_rc = AUTH_E_NOMEM; break; }

        upstream_req_t ur = { cfg->upstream_url, auth.access_token, auth.account_id, xr.session_id, xr.body, xr.body_len };
        upstream_post(&ur, on_upstream_bytes, &x, &res);

        if (prev_token) { explicit_bzero(prev_token, strlen(prev_token)); free(prev_token); }
        prev_token = res.status == 401 ? strdup(auth.access_token) : NULL;
        auth_free(&auth);
        if (res.status != 401) break;

        sse_parser_free(&x.parser);
        reducer_free(x.reducer); x.reducer = NULL;
        collector_free(x.collector); x.collector = NULL;
    }
    if (prev_token) { explicit_bzero(prev_token, strlen(prev_token)); free(prev_token); }

    int status;
    if (auth_rc != AUTH_OK) {
        status = auth_rc == AUTH_E_NOMEM ? 500 : 401;
        send_error(fd, status, auth_strerror(auth_rc), NULL);
    } else if (res.status == 200) {
        reducer_finish(x.reducer);
        if (x.stream) {
            status = 200;
        } else {
            buf_t out; buf_init(&out);
            status = collector_result(x.collector, &out);
            if (status < 0) { status = 500; send_error(fd, 500, "out of memory", NULL); }
            else send_json(fd, status, out.data, out.len, NULL);
            buf_free(&out);
        }
    } else if (res.status == 0) {
        status = 502;
        snprintf(err, sizeof err, "cannot reach upstream: %.200s", res.transport_err);
        send_error(fd, status, err, NULL);
    } else if (res.status == 401) {
        status = 401;
        send_error(fd, status, "ChatGPT login was rejected or has expired. Run `codex exec 'ok'` (or `codex login`) "
                               "so Codex refreshes it; claudex never refreshes tokens itself.", NULL);
    } else {
        if (res.status == 400 && res.err_body.len) {
            yyjson_doc *d = yyjson_read(res.err_body.data, res.err_body.len, 0);
            yyjson_val *root = d ? yyjson_doc_get_root(d) : NULL;
            yyjson_val *error = yyjson_obj_get(root, "error");
            const char *message = yyjson_get_str(yyjson_obj_get(error, "message"));
            if (!message) message = yyjson_get_str(error);
            if (!message) message = yyjson_get_str(yyjson_obj_get(root, "detail"));
            if (!message && !d) message = res.err_body.data;
            if (message && strstr(message, xr.sel.slug) && strstr(message, "not supported")) {
                models_mark_rejected(xr.sel.slug);
            }
            yyjson_doc_free(d);
        }
        buf_t msg; buf_init(&msg);
        long long retry_after;
        describe_upstream_error(&res, &msg, &retry_after);
        char extra[64] = "";
        if (retry_after >= 0) snprintf(extra, sizeof extra, "Retry-After: %lld\r\n", retry_after);
        status = (res.status == 400 || res.status == 403 || res.status == 404 || res.status == 413 || res.status == 429)
                     ? (int)res.status : res.status == 503 ? 529 : 502;
        send_error(fd, status, msg.data ? msg.data : "upstream error", extra);
        buf_free(&msg);
    }

    log_line("id=%lu model=%s effort=%s%s stream=%d status=%d upstream=%ld ms=%lld in=%lld out=%lld cached=%lld used_pct=%s limit=%s%s",
             rid, xr.sel.slug, xr.sel.effort, xr.sel.remapped ? " remapped=1" : "", x.stream, status, res.status,
             now_ms() - t0, x.in_tokens, x.out_tokens, x.cached_tokens,
             res.used_pct[0] ? res.used_pct : "-", res.active_limit[0] ? res.active_limit : "-",
             x.client_gone ? " client_gone=1" : "");

    if (x.reducer) { sse_parser_free(&x.parser); reducer_free(x.reducer); }
    collector_free(x.collector);
    upstream_res_free(&res);
    xlate_req_free(&xr);
}

/* ---- small endpoints ---------------------------------------------------- */

static void handle_models(int fd) {
    buf_t b; buf_init(&b);
    buf_append_str(&b, "{\"data\":[");
    char slugs[3][MODEL_SLUG_MAX];
    size_t count = models_list(slugs, 3);
    for (size_t i = 0; i < count && i < 3; i++)
        buf_appendf(&b, "%s{\"type\":\"model\",\"id\":\"%s\",\"display_name\":\"%s\",\"created_at\":\"2026-01-01T00:00:00Z\"}",
                    i ? "," : "", slugs[i], slugs[i]);
    buf_append_str(&b, "],\"has_more\":false}");
    send_json(fd, 200, b.data, b.len, NULL);
    buf_free(&b);
}

static void handle_count_tokens(int fd, size_t body_len) {
    /* Local estimate (~4 bytes per token); the backend has no counting endpoint. */
    char b[64];
    int n = snprintf(b, sizeof b, "{\"input_tokens\":%zu}", body_len / 4 + 1);
    send_json(fd, 200, b, (size_t)n, NULL);
}

/* ---- connection handling ------------------------------------------------ */

typedef struct { int fd; const server_cfg_t *cfg; } conn_t;

static void serve_connection(int fd, const server_cfg_t *cfg) {
    buf_t in; buf_init(&in);
    http_req_t req;
    int parsed = HTTP_MORE;
    char chunk[16384];

    while (parsed == HTTP_MORE) {
        ssize_t r = recv(fd, chunk, sizeof chunk, 0);
        if (r <= 0) { buf_free(&in); return; }
        if (buf_append(&in, chunk, (size_t)r) != 0) { buf_free(&in); return; }
        parsed = http_parse_head(in.data, in.len, &req);
    }
    if (parsed != HTTP_OK) {
        send_error(fd, -parsed, "malformed HTTP request", NULL);
        buf_free(&in);
        return;
    }
    while (in.len < req.head_len + req.content_length) {
        ssize_t r = recv(fd, chunk, sizeof chunk, 0);
        if (r <= 0) { buf_free(&in); return; }
        if (buf_append(&in, chunk, (size_t)r) != 0) { buf_free(&in); return; }
    }
    const char *body = in.data + req.head_len;
    size_t body_len = req.content_length;
    int is_get = !strcmp(req.method, "GET"), is_post = !strcmp(req.method, "POST");

    if (is_get && !strcmp(req.path, "/healthz")) {
        /* pid + instance let the launcher recognise its own proxy: the process is
         * non-dumpable, so /proc and `ss -p` cannot be used to identify it. */
        models_view_t v; models_view(&v);
        long age = v.loaded_at ? (long)time(NULL) - v.loaded_at : 0;
        if (age < 0) age = 0;
        char ok[512];
        int n = snprintf(ok, sizeof ok, "{\"ok\":true,\"service\":\"claudex-proxy\",\"version\":\"" CLAUDEX_VERSION
                                        "\",\"pid\":%ld,\"instance\":\"%s\",\"models\":{\"luna\":\"%s\",\"sol\":\"%s\","
                                        "\"astra\":\"%s\",\"terra\":\"%s\",\"source\":\"%s\",\"fetched_age_s\":%ld}}",
                         (long)getpid(), cfg->instance, v.family[0], v.family[1], v.family[2], v.family[3],
                         v.from_backend ? "backend" : "fallback", age);
        if (n > 0 && (size_t)n < sizeof ok) send_json(fd, 200, ok, (size_t)n, NULL);
    } else if (is_get && !strcmp(req.path, "/v1/models")) {
        handle_models(fd);
    } else if (is_post && !strcmp(req.path, "/v1/messages")) {
        handle_messages(fd, cfg, body, body_len, atomic_fetch_add(&next_request_id, 1) + 1);
    } else if (is_post && !strcmp(req.path, "/v1/messages/count_tokens")) {
        handle_count_tokens(fd, body_len);
    } else {
        send_error(fd, 404, "claudex-proxy serves /v1/messages, /v1/messages/count_tokens, /v1/models and /healthz", NULL);
    }
    buf_free(&in);
}

static void *connection_thread(void *arg) {
    conn_t *c = arg;
    serve_connection(c->fd, c->cfg);
    shutdown(c->fd, SHUT_WR);
    close(c->fd);
    free(c);
    sem_post(&conn_slots);
    return NULL;
}

int server_listen(const server_cfg_t *cfg) {
    int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("claudex-proxy: socket"); return -1; }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(cfg->port),
                                .sin_addr.s_addr = htonl(INADDR_LOOPBACK) }; /* loopback only, by construction */
    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(fd, 64) != 0) {
        fprintf(stderr, "claudex-proxy: cannot listen on 127.0.0.1:%u: %s\n", (unsigned)cfg->port, strerror(errno));
        close(fd);
        return -1;
    }
    return fd;
}

void server_run(int listen_fd, const server_cfg_t *cfg) {
    sem_init(&conn_slots, 0, MAX_CONNECTIONS);
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    log_line("listening on 127.0.0.1:%u version=%s", (unsigned)cfg->port, CLAUDEX_VERSION);

    for (;;) {
        sem_wait(&conn_slots);
        int fd = accept4(listen_fd, NULL, NULL, SOCK_CLOEXEC);
        if (fd < 0) {
            sem_post(&conn_slots);
            if (errno == EINTR || errno == ECONNABORTED) continue;
            log_line("accept failed: %s", strerror(errno));
            sleep(1);
            continue;
        }
        struct timeval tv = { CLIENT_IO_TIMEOUT_S, 0 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

        conn_t *c = malloc(sizeof *c);
        pthread_t th;
        if (!c) { close(fd); sem_post(&conn_slots); continue; }
        c->fd = fd;
        c->cfg = cfg;
        if (pthread_create(&th, &attr, connection_thread, c) != 0) {
            close(fd); free(c); sem_post(&conn_slots);
        }
    }
}
