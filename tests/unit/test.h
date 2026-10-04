/* Minimal unit-test harness: TEST(name) { ... } blocks, run with RUN(name). */
#ifndef CLAUDEX_TEST_H
#define CLAUDEX_TEST_H

#include <stdio.h>
#include <string.h>

static int t_failures;
static int t_checks;

#define TEST(name) static void name(void)
#define RUN(name) do { fprintf(stderr, "  %s\n", #name); name(); } while (0)

#define CHECK(cond) do { \
    t_checks++; \
    if (!(cond)) { t_failures++; \
        fprintf(stderr, "    FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } \
} while (0)

#define CHECK_INT(got, want) do { \
    long long g_ = (long long)(got), w_ = (long long)(want); t_checks++; \
    if (g_ != w_) { t_failures++; \
        fprintf(stderr, "    FAIL %s:%d: %s = %lld, want %lld\n", __FILE__, __LINE__, #got, g_, w_); } \
} while (0)

#define CHECK_STR(got, want) do { \
    const char *g_ = (got), *w_ = (want); t_checks++; \
    if (!g_ || strcmp(g_, w_) != 0) { t_failures++; \
        fprintf(stderr, "    FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, g_ ? g_ : "(null)", w_); } \
} while (0)

#define TEST_MAIN_END() do { \
    fprintf(stderr, "  %d checks, %d failures\n", t_checks, t_failures); \
    return t_failures ? 1 : 0; \
} while (0)

#endif
