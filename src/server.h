/* Loopback HTTP listener: accepts Anthropic Messages requests, answers from upstream. */
#ifndef CLAUDEX_SERVER_H
#define CLAUDEX_SERVER_H

typedef struct {
    unsigned short port;
    const char    *auth_file;     /* Codex auth.json (read-only) */
    const char    *upstream_url;
    const char    *instance;      /* launcher-chosen nonce echoed by /healthz ("" if none) */
} server_cfg_t;

/* Binds 127.0.0.1:port; returns the listening fd or -1 (reason on stderr). */
int server_listen(const server_cfg_t *cfg);

/* Accept loop; never returns under normal operation. Call after sandbox_apply. */
void server_run(int listen_fd, const server_cfg_t *cfg);

#endif
