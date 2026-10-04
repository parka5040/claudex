#include "upstream.h"

#include "auth.h"
#include "models.h"

#include <curl/curl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

#define ERR_BODY_MAX (64u * 1024u)

typedef struct {
    CURL            *curl;
    upstream_data_cb on_data;
    void            *ud;
    upstream_res_t  *res;
} xfer_t;

int upstream_global_init(void) {
    return curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK ? 0 : -1;
}

void upstream_res_free(upstream_res_t *res) {
    buf_free(&res->err_body);
}

static size_t on_body(char *ptr, size_t size, size_t nmemb, void *ud) {
    xfer_t *x = ud;
    size_t n = size * nmemb;
    long status = 0;
    curl_easy_getinfo(x->curl, CURLINFO_RESPONSE_CODE, &status);
    if (status == 200) {
        if (x->on_data(x->ud, ptr, n) != 0) {
            x->res->client_aborted = 1;
            return CURL_WRITEFUNC_ERROR;
        }
    } else if (x->res->err_body.len < ERR_BODY_MAX) {
        size_t room = ERR_BODY_MAX - x->res->err_body.len;
        buf_append(&x->res->err_body, ptr, n < room ? n : room);
    }
    return n;
}

static void copy_header_value(char *dst, size_t dstlen, const char *v, size_t n) {
    while (n && (*v == ' ' || *v == '\t')) { v++; n--; }
    while (n && (v[n - 1] == '\r' || v[n - 1] == '\n' || v[n - 1] == ' ')) n--;
    if (n >= dstlen) n = dstlen - 1;
    memcpy(dst, v, n);
    dst[n] = '\0';
    for (char *p = dst; *p; p++)
        if ((unsigned char)*p < 0x21 || (unsigned char)*p > 0x7e) *p = '?'; /* goes into a log line */
}

static size_t on_header(char *ptr, size_t size, size_t nmemb, void *ud) {
    xfer_t *x = ud;
    size_t n = size * nmemb;
    static const char USED[] = "x-codex-primary-used-percent:";
    static const char LIMIT[] = "x-codex-active-limit:";
    if (n > sizeof USED - 1 && !strncasecmp(ptr, USED, sizeof USED - 1))
        copy_header_value(x->res->used_pct, sizeof x->res->used_pct, ptr + sizeof USED - 1, n - (sizeof USED - 1));
    else if (n > sizeof LIMIT - 1 && !strncasecmp(ptr, LIMIT, sizeof LIMIT - 1))
        copy_header_value(x->res->active_limit, sizeof x->res->active_limit, ptr + sizeof LIMIT - 1, n - (sizeof LIMIT - 1));
    return n;
}

static struct curl_slist *add_header(struct curl_slist *list, const char *name, const char *value, int *ok) {
    buf_t h; buf_init(&h);
    if (buf_appendf(&h, "%s: %s", name, value) != 0) { *ok = 0; return list; }
    struct curl_slist *next = curl_slist_append(list, h.data);
    buf_free_secret(&h);
    if (!next) { *ok = 0; return list; }
    return next;
}

/* curl keeps its own copy of each header line; wipe them, one of them holds the token. */
static void free_headers_secret(struct curl_slist *list) {
    for (struct curl_slist *p = list; p; p = p->next)
        if (p->data) explicit_bzero(p->data, strlen(p->data));
    curl_slist_free_all(list);
}

void upstream_post(const upstream_req_t *req, upstream_data_cb on_data, void *ud, upstream_res_t *res) {
    memset(res, 0, sizeof *res);
    buf_init(&res->err_body);

    CURL *curl = curl_easy_init();
    if (!curl) { snprintf(res->transport_err, sizeof res->transport_err, "curl_easy_init failed"); return; }

    int ok = 1;
    struct curl_slist *h = NULL;
    buf_t bearer; buf_init(&bearer);
    if (buf_appendf(&bearer, "Bearer %s", req->access_token) != 0) ok = 0;
    if (ok) h = add_header(h, "Authorization", bearer.data, &ok);
    buf_free_secret(&bearer);
    h = add_header(h, "ChatGPT-Account-ID", req->account_id, &ok);
    h = add_header(h, "Content-Type", "application/json", &ok);
    h = add_header(h, "Accept", "text/event-stream", &ok);
    h = add_header(h, "originator", UPSTREAM_ORIGINATOR, &ok);
    if (req->session_id && *req->session_id) h = add_header(h, "session-id", req->session_id, &ok);
    h = curl_slist_append(h, "Expect:"); /* no 100-continue round trip */
    if (!ok || !h) {
        snprintf(res->transport_err, sizeof res->transport_err, "out of memory building request");
        free_headers_secret(h);
        curl_easy_cleanup(curl);
        return;
    }

    xfer_t x = { curl, on_data, ud, res };
    char errbuf[CURL_ERROR_SIZE] = "";
    curl_easy_setopt(curl, CURLOPT_URL, req->url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, UPSTREAM_USER_AGENT);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, req->body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)req->body_len);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &x);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, on_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &x);
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, errbuf);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);   /* never carry the bearer to another host */
    curl_easy_setopt(curl, CURLOPT_PROXY, "");            /* ignore *_proxy env: same reason */
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);  /* abort after 300 s of silence, */
    curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 300L); /* matching the official client   */
#ifndef CLAUDEX_TEST
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
#endif

    CURLcode rc = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &res->status);
    if (rc != CURLE_OK && !res->client_aborted && res->status != 200) {
        res->status = 0;
        snprintf(res->transport_err, sizeof res->transport_err, "%s", errbuf[0] ? errbuf : curl_easy_strerror(rc));
    }
    free_headers_secret(h);
    curl_easy_cleanup(curl);
}

/* The fetcher uses exactly the same account and honest identity headers as a response. */
static const char *models_auth_file;
static pthread_mutex_t refresh_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t refresh_cond = PTHREAD_COND_INITIALIZER;
static int refresh_pending;

void upstream_set_auth_file(const char *path) { models_auth_file = path; }

static size_t on_models(char *ptr, size_t size, size_t nmemb, void *ud) {
    buf_t *body = ud;
    size_t n = size * nmemb;
    if (n > 4u * 1024u * 1024u - body->len || buf_append(body, ptr, n) != 0)
        return CURL_WRITEFUNC_ERROR;
    return n;
}

int upstream_fetch_models(char **json, size_t *len) {
    *json = NULL; *len = 0;
    if (!models_auth_file) return -1;
    auth_t auth = {0};
    if (auth_load(models_auth_file, &auth) != AUTH_OK) return -1;
    const char *v = getenv("CLAUDEX_CODEX_VERSION");
    if (!v || !*v) v = "0.160.0";
    size_t vn = strlen(v);
    if (vn > 32) v = "0.160.0";
    else for (size_t i = 0; i < vn; i++)
        if (!((v[i] >= '0' && v[i] <= '9') || v[i] == '.')) { v = "0.160.0"; break; }
    char url[1024];
#ifdef CLAUDEX_TEST
    const char *override = getenv("CLAUDEX_TEST_UPSTREAM");
    const char *responses = override ? strstr(override, "/responses") : NULL;
    if (responses && responses[10] == '\0') {
        size_t prefix = (size_t)(responses - override);
        if (prefix > sizeof url - 100) { auth_free(&auth); return -1; }
        memcpy(url, override, prefix);
        url[prefix] = '\0';
        snprintf(url + prefix, sizeof url - prefix, "/models?client_version=%s", v);
    } else
#endif
        snprintf(url, sizeof url, "https://chatgpt.com/backend-api/codex/models?client_version=%s", v);
    CURL *curl = curl_easy_init();
    buf_t body; buf_init(&body);
    buf_t bearer; buf_init(&bearer);
    int ok = curl && buf_appendf(&bearer, "Bearer %s", auth.access_token) == 0;
    struct curl_slist *h = NULL;
    if (ok) h = add_header(h, "Authorization", bearer.data, &ok);
    buf_free_secret(&bearer);
    if (ok) h = add_header(h, "ChatGPT-Account-ID", auth.account_id, &ok);
    if (ok) h = add_header(h, "Accept", "application/json", &ok);
    if (ok) h = add_header(h, "originator", UPSTREAM_ORIGINATOR, &ok);
    if (!ok) { free_headers_secret(h); if (curl) curl_easy_cleanup(curl); auth_free(&auth); return -1; }
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, h);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, UPSTREAM_USER_AGENT);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_models);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(curl, CURLOPT_PROXY, "");
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
#ifndef CLAUDEX_TEST
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
#endif
    CURLcode rc = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(curl);
    free_headers_secret(h);
    auth_free(&auth);
    if (rc != CURLE_OK || status != 200 || !body.len) { buf_free(&body); return -1; }
    *json = body.data;
    *len = body.len;
    return 0;
}

static void *refresh_thread(void *unused) {
    (void)unused;
    time_t last = 0;
    for (;;) {
        char *json = NULL;
        size_t len = 0;
        int rc = upstream_fetch_models(&json, &len);
        if (rc == 0) rc = models_catalog_load(json, len);
        if (rc != 0) models_catalog_fetch_failed();
        free(json);
        last = time(NULL);
        pthread_mutex_lock(&refresh_lock);
        for (;;) {
            time_t now = time(NULL);
            time_t due = refresh_pending ? last + 60 : last + 6 * 3600;
            if (now >= due) break;
            struct timespec wake = { .tv_sec = due, .tv_nsec = 0 };
            pthread_cond_timedwait(&refresh_cond, &refresh_lock, &wake);
        }
        refresh_pending = 0;
        pthread_mutex_unlock(&refresh_lock);
    }
    return NULL;
}

void upstream_refresh_start(void) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, refresh_thread, NULL) == 0) pthread_detach(thread);
}

void upstream_refresh_soon(void) {
    pthread_mutex_lock(&refresh_lock);
    refresh_pending = 1;
    pthread_cond_signal(&refresh_cond);
    pthread_mutex_unlock(&refresh_lock);
}
