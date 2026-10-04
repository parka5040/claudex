#include "sandbox.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <netdb.h>
#include <seccomp.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* TCP port rules need Landlock ABI 4 (Linux 6.7). Older kernels: refuse to run. */
#define LANDLOCK_MIN_ABI 4

static int fail(char *err, size_t errlen, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static int fail(char *err, size_t errlen, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, errlen, fmt, ap);
    va_end(ap);
    return -1;
}

static int ll_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
    return (int)syscall(SYS_landlock_create_ruleset, attr, size, flags);
}

static int ll_add_rule(int ruleset, enum landlock_rule_type type, const void *attr) {
    return (int)syscall(SYS_landlock_add_rule, ruleset, type, attr, 0);
}

static int ll_restrict_self(int ruleset) {
    return (int)syscall(SYS_landlock_restrict_self, ruleset, 0);
}

/* Read-only rule for a path. Missing optional paths are skipped. */
static int allow_read(int ruleset, const char *path, int required, char *err, size_t errlen) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (!required && (errno == ENOENT || errno == ENOTDIR)) return 0;
        return fail(err, errlen, "sandbox: open %s: %s", path, strerror(errno));
    }
    struct stat st;
    if (fstat(fd, &st) != 0) {
        close(fd);
        return fail(err, errlen, "sandbox: stat %s: %s", path, strerror(errno));
    }
    struct landlock_path_beneath_attr rule = {
        .allowed_access = LANDLOCK_ACCESS_FS_READ_FILE,
        .parent_fd = fd,
    };
    if (S_ISDIR(st.st_mode)) rule.allowed_access |= LANDLOCK_ACCESS_FS_READ_DIR;
    int rc = ll_add_rule(ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule);
    int e = errno;
    close(fd);
    if (rc != 0) return fail(err, errlen, "sandbox: landlock rule %s: %s", path, strerror(e));
    return 0;
}

static int allow_port(int ruleset, __u64 access, unsigned short port, char *err, size_t errlen) {
    struct landlock_net_port_attr rule = { .allowed_access = access, .port = port };
    if (ll_add_rule(ruleset, LANDLOCK_RULE_NET_PORT, &rule) != 0)
        return fail(err, errlen, "sandbox: landlock port %u: %s", (unsigned)port, strerror(errno));
    return 0;
}

static int apply_landlock(const sandbox_cfg_t *cfg, char *err, size_t errlen) {
    int abi = ll_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) return fail(err, errlen, "sandbox: Landlock unavailable: %s", strerror(errno));
    if (abi < LANDLOCK_MIN_ABI)
        return fail(err, errlen, "sandbox: Landlock ABI %d < %d (need TCP port rules)", abi, LANDLOCK_MIN_ABI);

    struct landlock_ruleset_attr attr = {
        .handled_access_fs =
            LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
            LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
            LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
            LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE,
        .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
    };
    size_t attr_size = sizeof attr;
    if (abi >= 5) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
    if (abi >= 6) attr.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL;

    int ruleset = ll_create_ruleset(&attr, attr_size, 0);
    if (ruleset < 0) return fail(err, errlen, "sandbox: landlock_create_ruleset: %s", strerror(errno));

    /* TLS trust store, resolver configuration, and NSS modules getaddrinfo may dlopen. */
    static const char *const optional[] = {
        "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/usr/share/ca-certificates",
        "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/host.conf",
        "/usr/lib", "/usr/lib64", "/lib", "/lib64",
        NULL,
    };
    int rc = allow_read(ruleset, cfg->auth_dir, 1, err, errlen);
    for (int i = 0; rc == 0 && optional[i]; i++) rc = allow_read(ruleset, optional[i], 0, err, errlen);
    if (rc == 0) rc = allow_port(ruleset, LANDLOCK_ACCESS_NET_BIND_TCP, cfg->listen_port, err, errlen);
    for (int i = 0; rc == 0 && i < SANDBOX_MAX_PORTS && cfg->connect_ports[i]; i++)
        rc = allow_port(ruleset, LANDLOCK_ACCESS_NET_CONNECT_TCP, cfg->connect_ports[i], err, errlen);

    if (rc == 0 && ll_restrict_self(ruleset) != 0)
        rc = fail(err, errlen, "sandbox: landlock_restrict_self: %s", strerror(errno));
    close(ruleset);
    return rc;
}

static int apply_seccomp(char *err, size_t errlen) {
    static const char *const denied[] = {
        "execve", "execveat",
        "ptrace", "process_vm_readv", "process_vm_writev", "process_madvise", "pidfd_getfd",
        "mount", "umount2", "pivot_root", "chroot", "move_mount", "open_tree", "fsopen", "fsmount",
        "init_module", "finit_module", "delete_module", "kexec_load", "kexec_file_load",
        "bpf", "perf_event_open", "userfaultfd",
        "io_uring_setup", "io_uring_enter", "io_uring_register",
        "unshare", "setns", "open_by_handle_at", "name_to_handle_at",
        "add_key", "request_key", "keyctl",
        "swapon", "swapoff", "reboot", "acct", "quotactl", "settimeofday", "clock_settime",
        NULL,
    };
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) return fail(err, errlen, "sandbox: seccomp_init failed");
    int rc = 0;
    for (int i = 0; denied[i]; i++) {
        int nr = seccomp_syscall_resolve_name(denied[i]);
        if (nr == __NR_SCMP_ERROR) continue; /* not present on this architecture */
        int r = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0);
        if (r != 0) { rc = fail(err, errlen, "sandbox: seccomp rule %s: %s", denied[i], strerror(-r)); break; }
    }
    if (rc == 0) {
        int r = seccomp_load(ctx);
        if (r != 0) rc = fail(err, errlen, "sandbox: seccomp_load: %s", strerror(-r));
    }
    seccomp_release(ctx);
    return rc;
}

int sandbox_apply(const sandbox_cfg_t *cfg, char *err, size_t errlen) {
    if (errlen) err[0] = '\0';

    /* Load the resolver's NSS modules while the filesystem is still open to us. */
    struct addrinfo *ai = NULL;
    if (getaddrinfo("localhost", NULL, NULL, &ai) == 0) freeaddrinfo(ai);

    struct rlimit no_core = { 0, 0 };
    if (setrlimit(RLIMIT_CORE, &no_core) != 0)
        return fail(err, errlen, "sandbox: setrlimit(RLIMIT_CORE): %s", strerror(errno));
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0)
        return fail(err, errlen, "sandbox: PR_SET_DUMPABLE: %s", strerror(errno));
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
        return fail(err, errlen, "sandbox: PR_SET_NO_NEW_PRIVS: %s", strerror(errno));

    if (apply_landlock(cfg, err, errlen) != 0) return -1;
    return apply_seccomp(err, errlen);
}
