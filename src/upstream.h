/* HTTPS+SSE client for the ChatGPT Codex Responses backend (libcurl). */
#ifndef CLAUDEX_UPSTREAM_H
#define CLAUDEX_UPSTREAM_H

#include <stddef.h>
#include "buf.h"

#define CLAUDEX_VERSION   "0.1.0"
#define UPSTREAM_URL      "https://chatgpt.com/backend-api/codex/responses"
/* Honest identity: claudex is a third-party harness and says so. It never sends
 * codex_cli_rs, x-openai-internal-* or any other first-party-only marker. */
#define UPSTREAM_ORIGINATOR "claude-code"
#define UPSTREAM_USER_AGENT "claudex/" CLAUDEX_VERSION " (Claude Code; third-party harness)"

typedef struct {
    const char *url;
    const char *access_token;
    const char *account_id;
    const char *session_id;   /* "" to omit */
    const char *body;
    size_t      body_len;
} upstream_req_t;

typedef struct {
    long  status;             /* HTTP status, 0 if the request never got a response */
    buf_t err_body;           /* response body when status != 200 (capped) */
    char  used_pct[16];       /* x-codex-primary-used-percent */
    char  active_limit[32];   /* x-codex-active-limit */
    char  transport_err[256]; /* libcurl error text when status == 0 */
    int   client_aborted;     /* the data callback asked to stop */
} upstream_res_t;

/* Called with raw SSE bytes of a 200 response. Nonzero return aborts the transfer. */
typedef int (*upstream_data_cb)(void *ud, const char *data, size_t n);

int  upstream_global_init(void);
void upstream_set_auth_file(const char *path);
int  upstream_fetch_models(char **json, size_t *len); /* allocated JSON, caller frees */
void upstream_refresh_start(void);  /* detached, call after applying the sandbox */
void upstream_refresh_soon(void);   /* rate-limited wake after unsupported model */
void upstream_post(const upstream_req_t *req, upstream_data_cb on_data, void *ud, upstream_res_t *res);
void upstream_res_free(upstream_res_t *res);

#endif
