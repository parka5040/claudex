#include "test.h"
#include "sandbox.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

/* The sandbox is irreversible, so every scenario runs in a forked child. The child
 * reports through its exit status: 0 = expectation met, otherwise a distinct code.
 * Children leave via _exit() so sanitizer atexit hooks (which use ptrace) do not run. */

static char auth_dir[PATH_MAX];
static char auth_file[PATH_MAX + 32];
static char outside_dir[PATH_MAX];
static char outside_file[PATH_MAX + 32];

static void make_temp_dir(char *dir, size_t len, const char *name) {
    const char *tmp = getenv("TMPDIR");
    int n = snprintf(dir, len, "%s/%s-XXXXXX", tmp && *tmp ? tmp : "/tmp", name);
    struct stat st;
    if (n < 0 || (size_t)n >= len || !mkdtemp(dir) || !*dir || stat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) {
        perror("temp directory"); exit(2);
    }
}

static void make_auth_dir(void) {
    make_temp_dir(auth_dir, sizeof auth_dir, "claudex-sbx");
    snprintf(auth_file, sizeof auth_file, "%s/auth.json", auth_dir);
    int fd = open(auth_file, O_WRONLY | O_CREAT, 0600);
    if (fd < 0 || write(fd, "{}", 2) != 2) { perror("auth file"); exit(2); }
    close(fd);
}

/* Bind a loopback listener on an ephemeral port; returns fd, stores port. */
static int listener(unsigned short *port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    socklen_t len = sizeof a;
    if (fd < 0 || bind(fd, (struct sockaddr *)&a, sizeof a) || listen(fd, 4) ||
        getsockname(fd, (struct sockaddr *)&a, &len)) { perror("listener"); exit(2); }
    *port = ntohs(a.sin_port);
    return fd;
}

static int try_connect(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port),
                             .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    int rc = connect(fd, (struct sockaddr *)&a, sizeof a);
    int e = errno;
    close(fd);
    errno = e;
    return rc;
}

static int try_bind(unsigned short port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(port),
                             .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    int rc = bind(fd, (struct sockaddr *)&a, sizeof a);
    int e = errno;
    close(fd);
    errno = e;
    return rc;
}

typedef int (*scenario_fn)(const sandbox_cfg_t *cfg);

static unsigned short allowed_port, blocked_port, free_port;

static int run_sandboxed(scenario_fn fn) {
    sandbox_cfg_t cfg = { .auth_dir = auth_dir, .listen_port = free_port,
                          .connect_ports = { allowed_port, 0 } };
    sandbox_default_read_dirs(&cfg, "/etc/resolv.conf");
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        char err[256];
        if (sandbox_apply(&cfg, err, sizeof err) != 0) {
            fprintf(stderr, "    sandbox_apply: %s\n", err);
            _exit(99);
        }
        _exit(fn(&cfg));
    }
    int st = 0;
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : 100 + WTERMSIG(st);
}

static int sc_auth_file_readable_but_not_writable(const sandbox_cfg_t *cfg) {
    (void)cfg;
    int fd = open(auth_file, O_RDONLY);
    if (fd < 0) return 1;
    close(fd);
    if (open(auth_file, O_WRONLY) >= 0) return 2;
    if (errno != EACCES) return 3;
    char p[PATH_MAX + 32];
    snprintf(p, sizeof p, "%s/new", auth_dir);
    if (open(p, O_WRONLY | O_CREAT, 0600) >= 0) return 4;
    if (unlink(auth_file) == 0) return 5;
    return 0;
}

static int sc_rest_of_filesystem_is_unreadable_and_unwritable(const sandbox_cfg_t *cfg) {
    (void)cfg;
    if (open(outside_file, O_RDONLY) >= 0) return 1;
    if (errno != EACCES) return 2;
    int fd = open("/etc/passwd", O_RDONLY);
    if (fd < 0) return 6;
    close(fd);
    if (open("/etc/passwd", O_WRONLY) >= 0) return 7;
    if (errno != EACCES) return 8;
    const char *home = getenv("HOME");
    if (home && open(home, O_RDONLY | O_DIRECTORY) >= 0) return 3;
    if (open("/tmp/claudex-sbx-should-not-exist", O_WRONLY | O_CREAT, 0600) >= 0) return 4;
    if (mkdir("/tmp/claudex-sbx-dir", 0700) == 0) return 5;
    return 0;
}

static int sc_exec_is_denied(const sandbox_cfg_t *cfg) {
    (void)cfg;
    /* `false` exits 1, so a successful exec is reported as a failure rather than a pass. */
    char *argv[] = { "false", NULL };
    execv("/usr/bin/false", argv);
    return errno == EPERM || errno == EACCES ? 0 : 2;
}

static int sc_connect_only_to_allowed_port(const sandbox_cfg_t *cfg) {
    (void)cfg;
    if (try_connect(allowed_port) != 0) return 1;
    if (try_connect(blocked_port) == 0) return 2;
    if (errno != EACCES) return 3;
    return 0;
}

static int sc_bind_only_to_listen_port(const sandbox_cfg_t *cfg) {
    if (try_bind(cfg->listen_port) != 0) return 1;
    if (try_bind(0) == 0) return 2;
    if (errno != EACCES) return 3;
    return 0;
}

static int sc_process_is_not_dumpable_and_has_no_core(const sandbox_cfg_t *cfg) {
    (void)cfg;
    struct rlimit rl;
    if (getrlimit(RLIMIT_CORE, &rl) || rl.rlim_max != 0) return 1;
    if (prctl(PR_GET_DUMPABLE) != 0) return 2;
    if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) return 3;
    return 0;
}

static int sc_tls_and_resolver_files_stay_readable(const sandbox_cfg_t *cfg) {
    (void)cfg;
    /* Whatever CA bundle / resolver config exists on this machine must still open. */
    static const char *paths[] = { "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem",
                                   "/etc/resolv.conf", "/etc/hosts", NULL };
    int opened = 0;
    for (int i = 0; paths[i]; i++) {
        int fd = open(paths[i], O_RDONLY);
        if (fd >= 0) { opened++; close(fd); }
        else if (errno == EACCES) return 1;
    }
    if (!opened) return 2;
    struct addrinfo *ai = NULL;
    if (getaddrinfo("localhost", "443", NULL, &ai) != 0) return 3;
    freeaddrinfo(ai);
    return 0;
}

static int run_sandboxed_handshake(const sandbox_cfg_t *cfg, const char *path, const char *replacement) {
    int ready[2], resume[2];
    if (pipe(ready) != 0 || pipe(resume) != 0) { perror("pipe"); exit(2); }
    fflush(NULL);
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); exit(2); }
    if (pid == 0) {
        close(ready[0]); close(resume[1]);
        char err[256], byte;
        if (sandbox_apply(cfg, err, sizeof err) != 0) {
            fprintf(stderr, "    sandbox_apply: %s\n", err);
            _exit(99);
        }
        if (write(ready[1], "r", 1) != 1 || read(resume[0], &byte, 1) != 1) _exit(10);
        int fd = open(path, O_RDONLY);
        char text[4] = {0};
        if (fd < 0 || read(fd, text, sizeof text) != 3 || strcmp(text, "new")) _exit(11);
        close(fd);
        _exit(0);
    }
    close(ready[1]); close(resume[0]);
    char byte;
    int rc = 0;
    if (read(ready[0], &byte, 1) != 1) rc = 12;
    else {
        int fd = open(replacement, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd < 0 || write(fd, "new", 3) != 3) rc = 13;
        if (fd >= 0) close(fd);
        if (!rc && rename(replacement, path) != 0) rc = 14;
        if (write(resume[1], "r", 1) != 1) rc = 15;
    }
    close(ready[0]); close(resume[1]);
    int st = 0;
    if (waitpid(pid, &st, 0) != pid) { perror("waitpid"); exit(2); }
    if (rc) return rc;
    return WIFEXITED(st) ? WEXITSTATUS(st) : 100 + WTERMSIG(st);
}

TEST(resolver_parent_allowlist) {
    static const char *const allowed[] = {
        "/run/systemd/resolve", "/run/NetworkManager", "/run/resolvconf", "/run/connman", "/run/netconfig",
        "/var/run/systemd/resolve", "/var/run/NetworkManager", "/var/run/resolvconf", "/var/run/connman", "/var/run/netconfig",
    };
    static const char *const denied[] = {
        "/", "/run", "/var/run", "/run/user/1000", "/tmp", "/home/u", "/etc", "/run/systemd",
        "/run/NetworkManager/../..", "", NULL,
    };
    for (size_t i = 0; i < sizeof allowed / sizeof allowed[0]; i++) CHECK_INT(sandbox_resolver_parent_ok(allowed[i]), 1);
    for (size_t i = 0; i < sizeof denied / sizeof denied[0]; i++) CHECK_INT(sandbox_resolver_parent_ok(denied[i]), 0);
}

TEST(default_read_dirs_add_only_allowed_symlink_parents) {
    char dir[PATH_MAX], path[PATH_MAX + 32], target[PATH_MAX + 32];
    make_temp_dir(dir, sizeof dir, "claudex-sbx-defaults");
    snprintf(path, sizeof path, "%s/resolv.conf", dir);
    snprintf(target, sizeof target, "%s/x.conf", dir);
    int fd = open(target, O_WRONLY | O_CREAT, 0600);
    if (fd < 0) { perror("resolver target"); exit(2); }
    close(fd);
    CHECK_INT(symlink("/tmp/x.conf", path), 0);
    sandbox_cfg_t cfg = {0};
    sandbox_default_read_dirs(&cfg, path);
    CHECK_STR(cfg.read_dirs[0], "/etc");
    CHECK(cfg.read_dirs[1] == NULL);
    CHECK_INT(unlink(path), 0);
    CHECK_INT(symlink(target, path), 0);
    sandbox_default_read_dirs(&cfg, path);
    CHECK_STR(cfg.read_dirs[0], "/etc");
    CHECK(cfg.read_dirs[1] == NULL);
    CHECK_INT(unlink(path), 0);
    fd = open(path, O_WRONLY | O_CREAT, 0600);
    if (fd < 0) { perror("resolver file"); exit(2); }
    close(fd);
    sandbox_default_read_dirs(&cfg, path);
    CHECK_STR(cfg.read_dirs[0], "/etc");
    CHECK(cfg.read_dirs[1] == NULL);
    unlink(path); unlink(target); rmdir(dir);
}

TEST(resolver_dir_file_replaced_after_confinement_stays_readable) {
    char dir[PATH_MAX], path[PATH_MAX + 32], replacement[PATH_MAX + 32];
    make_temp_dir(dir, sizeof dir, "claudex-sbx-resolver");
    snprintf(path, sizeof path, "%s/resolv.conf", dir);
    snprintf(replacement, sizeof replacement, "%s/resolv.conf.new", dir);
    int fd = open(path, O_WRONLY | O_CREAT, 0600);
    if (fd < 0 || write(fd, "old", 3) != 3) { perror("resolver file"); exit(2); }
    close(fd);
    sandbox_cfg_t cfg = { .auth_dir = auth_dir, .listen_port = free_port,
                          .connect_ports = { allowed_port, 0 }, .read_dirs = { dir, NULL } };
    CHECK_INT(run_sandboxed_handshake(&cfg, path, replacement), 0);
    unlink(path); unlink(replacement); rmdir(dir);
}

TEST(auth_file_readable_but_not_writable)            { CHECK_INT(run_sandboxed(sc_auth_file_readable_but_not_writable), 0); }
TEST(rest_of_filesystem_is_unreadable_and_unwritable){ CHECK_INT(run_sandboxed(sc_rest_of_filesystem_is_unreadable_and_unwritable), 0); }
TEST(exec_is_denied)                                 { CHECK_INT(run_sandboxed(sc_exec_is_denied), 0); }
TEST(connect_only_to_allowed_port)                   { CHECK_INT(run_sandboxed(sc_connect_only_to_allowed_port), 0); }
TEST(bind_only_to_listen_port)                       { CHECK_INT(run_sandboxed(sc_bind_only_to_listen_port), 0); }
TEST(process_is_not_dumpable_and_has_no_core)        { CHECK_INT(run_sandboxed(sc_process_is_not_dumpable_and_has_no_core), 0); }
TEST(tls_and_resolver_files_stay_readable)           { CHECK_INT(run_sandboxed(sc_tls_and_resolver_files_stay_readable), 0); }

TEST(missing_auth_dir_fails_closed) {
    sandbox_cfg_t cfg = { .auth_dir = "/nonexistent/claudex", .listen_port = 1, .connect_ports = { 443, 0 } };
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        char err[256];
        _exit(sandbox_apply(&cfg, err, sizeof err) == -1 && err[0] ? 0 : 1);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    CHECK(WIFEXITED(st) && WEXITSTATUS(st) == 0);
}

int main(void) {
    make_auth_dir();
    make_temp_dir(outside_dir, sizeof outside_dir, "claudex-sbx-outside");
    snprintf(outside_file, sizeof outside_file, "%s/secret", outside_dir);
    int fd = open(outside_file, O_WRONLY | O_CREAT, 0600);
    if (fd < 0 || write(fd, "secret", 6) != 6) { perror("outside file"); exit(2); }
    close(fd);
    int l1 = listener(&allowed_port);
    int l2 = listener(&blocked_port);
    int l3 = listener(&free_port);
    close(l3); /* free_port is now unbound and known */

    RUN(resolver_parent_allowlist);
    RUN(default_read_dirs_add_only_allowed_symlink_parents);
    RUN(resolver_dir_file_replaced_after_confinement_stays_readable);
    RUN(auth_file_readable_but_not_writable);
    RUN(rest_of_filesystem_is_unreadable_and_unwritable);
    RUN(exec_is_denied);
    RUN(connect_only_to_allowed_port);
    RUN(bind_only_to_listen_port);
    RUN(process_is_not_dumpable_and_has_no_core);
    RUN(tls_and_resolver_files_stay_readable);
    RUN(missing_auth_dir_fails_closed);

    close(l1); close(l2);
    unlink(auth_file);
    rmdir(auth_dir);
    unlink(outside_file);
    rmdir(outside_dir);
    TEST_MAIN_END();
}
