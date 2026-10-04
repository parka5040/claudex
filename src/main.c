/* claudex-proxy: GPT-only Anthropic Messages -> ChatGPT Codex Responses proxy.
 * Loopback only, sandboxed, read-only on the Codex login, honest about what it is. */
#include "sandbox.h"
#include "server.h"
#include "upstream.h"

#include <libgen.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_PORT 18765

static void usage(void) {
    fprintf(stderr,
            "usage: claudex-proxy [--port N] [--auth-file PATH]\n"
            "  --port N          loopback port to listen on (default %d)\n"
            "  --auth-file PATH  Codex auth.json (default $CODEX_HOME/auth.json or ~/.codex/auth.json)\n"
            "  --version\n", DEFAULT_PORT);
}

static char *default_auth_file(void) {
    const char *codex_home = getenv("CODEX_HOME");
    const char *home = getenv("HOME");
    char *path = NULL;
    if (codex_home && *codex_home) {
        if (asprintf(&path, "%s/auth.json", codex_home) < 0) return NULL;
    } else if (home && *home) {
        if (asprintf(&path, "%s/.codex/auth.json", home) < 0) return NULL;
    }
    return path;
}

#ifdef CLAUDEX_TEST
/* Test builds may point at a fake upstream on loopback; release builds cannot. */
static unsigned short port_of(const char *url) {
    const char *p = strstr(url, "://");
    p = p ? strchr(p + 3, ':') : NULL;
    return p ? (unsigned short)atoi(p + 1) : 0;
}
#endif

int main(int argc, char **argv) {
    server_cfg_t cfg = { DEFAULT_PORT, NULL, UPSTREAM_URL, "" };
    char *auth_file = NULL;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--port") && i + 1 < argc) {
            long p = strtol(argv[++i], NULL, 10);
            if (p < 1 || p > 65535) { fprintf(stderr, "claudex-proxy: bad port\n"); return 2; }
            cfg.port = (unsigned short)p;
        } else if (!strcmp(argv[i], "--auth-file") && i + 1 < argc) {
            auth_file = strdup(argv[++i]);
        } else if (!strcmp(argv[i], "--version")) {
            puts("claudex-proxy " CLAUDEX_VERSION);
            return 0;
        } else {
            usage();
            return 2;
        }
    }
    if (!auth_file) auth_file = default_auth_file();
    if (!auth_file) { fprintf(stderr, "claudex-proxy: cannot determine auth file (no HOME)\n"); return 2; }
    cfg.auth_file = auth_file;
    upstream_set_auth_file(auth_file);

    /* Echoed verbatim inside a JSON string, so accept plain alphanumerics only. */
    const char *instance = getenv("CLAUDEX_INSTANCE");
    if (instance && *instance) {
        size_t n = strlen(instance);
        int ok = n <= 64;
        for (size_t i = 0; ok && i < n; i++)
            ok = (instance[i] >= '0' && instance[i] <= '9') || (instance[i] >= 'a' && instance[i] <= 'z') ||
                 (instance[i] >= 'A' && instance[i] <= 'Z');
        if (!ok) { fprintf(stderr, "claudex-proxy: CLAUDEX_INSTANCE must be 1-64 alphanumerics\n"); return 2; }
        cfg.instance = instance;
    }

    sandbox_cfg_t sb = { .listen_port = cfg.port, .connect_ports = { 443, 53, 0 } };
#ifdef CLAUDEX_TEST
    const char *override = getenv("CLAUDEX_TEST_UPSTREAM");
    if (override && *override) {
        cfg.upstream_url = override;
        sb.connect_ports[0] = port_of(override);
        sb.connect_ports[1] = 0;
    }
#endif

    signal(SIGPIPE, SIG_IGN);
    if (upstream_global_init() != 0) { fprintf(stderr, "claudex-proxy: libcurl init failed\n"); return 1; }

    int listen_fd = server_listen(&cfg);
    if (listen_fd < 0) return 1;

    /* dirname() may modify its argument, so work on a copy. */
    char *dir_copy = strdup(auth_file);
    if (!dir_copy) return 1;
    sb.auth_dir = dirname(dir_copy);
    char err[256];
    if (sandbox_apply(&sb, err, sizeof err) != 0) {
        fprintf(stderr, "claudex-proxy: refusing to run unsandboxed: %s\n", err);
        return 1;
    }

    upstream_refresh_start();
    server_run(listen_fd, &cfg);
    return 0;
}
