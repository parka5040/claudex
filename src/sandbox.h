/* Irreversible self-confinement, applied once after start-up and before serving:
 *   - no_new_privs, non-dumpable, no core files
 *   - Landlock: filesystem read-only on an allowlist, no writes anywhere;
 *               TCP bind/connect only on listed ports
 *   - seccomp:  exec, ptrace, mount, module, bpf, io_uring, namespace syscalls denied
 * Fails closed: any step that cannot be applied is an error. */
#ifndef CLAUDEX_SANDBOX_H
#define CLAUDEX_SANDBOX_H

#include <stddef.h>
#include <limits.h>

#define SANDBOX_MAX_PORTS 4
#define SANDBOX_MAX_READ_DIRS 4

typedef struct {
    const char    *auth_dir;                          /* directory holding auth.json; read-only */
    unsigned short listen_port;                       /* only port bind() may use */
    unsigned short connect_ports[SANDBOX_MAX_PORTS];  /* zero-terminated; e.g. {443, 53} */
    const char    *read_dirs[SANDBOX_MAX_READ_DIRS + 1]; /* NULL-terminated */
    char           resolver_parent[PATH_MAX];
} sandbox_cfg_t;

int sandbox_resolver_parent_ok(const char *dir);
void sandbox_default_read_dirs(sandbox_cfg_t *cfg, const char *resolv_path);

/* Returns 0 on success; on failure returns -1 and writes a reason to err. */
int sandbox_apply(const sandbox_cfg_t *cfg, char *err, size_t errlen);

#endif
