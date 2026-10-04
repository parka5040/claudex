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

static char auth_dir[64];
static char auth_file[96];

static void make_auth_dir(void) {
    strcpy(auth_dir, "/tmp/claudex-sbx-XXXXXX");
    if (!mkdtemp(auth_dir)) { perror("mkdtemp"); exit(2); }
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
    char p[128];
    snprintf(p, sizeof p, "%s/new", auth_dir);
    if (open(p, O_WRONLY | O_CREAT, 0600) >= 0) return 4;
    if (unlink(auth_file) == 0) return 5;
    return 0;
}

static int sc_rest_of_filesystem_is_unreadable_and_unwritable(const sandbox_cfg_t *cfg) {
    (void)cfg;
    if (open("/etc/passwd", O_RDONLY) >= 0) return 1;
    if (errno != EACCES) return 2;
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
    int l1 = listener(&allowed_port);
    int l2 = listener(&blocked_port);
    int l3 = listener(&free_port);
    close(l3); /* free_port is now unbound and known */

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
    TEST_MAIN_END();
}
