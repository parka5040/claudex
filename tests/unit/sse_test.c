#include "test.h"
#include "sse.h"

#include <stdlib.h>

/* Records every dispatched event as "event|data\n" so tests can compare one string. */
typedef struct { buf_t log; int stop_after; int seen; } rec_t;

static int record(void *ud, const char *event, const char *data, size_t data_len) {
    rec_t *r = ud;
    buf_append_str(&r->log, event);
    buf_append_str(&r->log, "|");
    buf_append(&r->log, data, data_len);
    buf_append_str(&r->log, "\n");
    r->seen++;
    return (r->stop_after && r->seen >= r->stop_after) ? 7 : 0;
}

static char *feed_all(const char *stream, size_t chunk) {
    sse_parser_t p; sse_parser_init(&p);
    rec_t r = {0}; buf_init(&r.log);
    size_t n = strlen(stream);
    for (size_t off = 0; off < n; off += chunk) {
        size_t take = n - off < chunk ? n - off : chunk;
        if (sse_feed(&p, stream + off, take, record, &r) != 0) break;
    }
    sse_parser_free(&p);
    if (!r.log.data) buf_append_str(&r.log, "");
    return r.log.data; /* caller frees */
}

TEST(dispatches_named_event_on_blank_line) {
    char *got = feed_all("event: response.created\ndata: {\"a\":1}\n\n", 4096);
    CHECK_STR(got, "response.created|{\"a\":1}\n");
    free(got);
}

TEST(joins_multiple_data_lines_with_newline) {
    char *got = feed_all("data: one\ndata: two\n\n", 4096);
    CHECK_STR(got, "|one\ntwo\n");
    free(got);
}

TEST(strips_only_one_leading_space_after_colon) {
    char *got = feed_all("data:  two spaces\n\ndata:nospace\n\n", 4096);
    CHECK_STR(got, "| two spaces\n|nospace\n");
    free(got);
}

TEST(ignores_comments_and_unknown_fields) {
    char *got = feed_all(": keepalive\nid: 5\nretry: 10\ndata: x\n\n", 4096);
    CHECK_STR(got, "|x\n");
    free(got);
}

TEST(does_not_dispatch_event_without_data) {
    char *got = feed_all("event: ping\n\ndata: real\n\n", 4096);
    CHECK_STR(got, "|real\n");
    free(got);
}

TEST(event_name_resets_after_dispatch) {
    char *got = feed_all("event: a\ndata: 1\n\ndata: 2\n\n", 4096);
    CHECK_STR(got, "a|1\n|2\n");
    free(got);
}

TEST(accepts_crlf_and_bare_cr_line_endings) {
    char *got = feed_all("event: a\r\ndata: 1\r\n\r\ndata: 2\r\r", 4096);
    CHECK_STR(got, "a|1\n|2\n");
    free(got);
}

TEST(result_is_identical_for_every_chunk_size) {
    const char *stream =
        "event: response.output_text.delta\r\ndata: {\"delta\":\"h\\u00e9llo\"}\r\n\r\n"
        ": c\n"
        "event: response.completed\ndata: {\"x\":1}\ndata: {\"y\":2}\n\n";
    char *want = feed_all(stream, 4096);
    CHECK_STR(want, "response.output_text.delta|{\"delta\":\"h\\u00e9llo\"}\n"
                    "response.completed|{\"x\":1}\n{\"y\":2}\n");
    for (size_t chunk = 1; chunk <= 9; chunk++) {
        char *got = feed_all(stream, chunk);
        CHECK_STR(got, want);
        free(got);
    }
    free(want);
}

TEST(incomplete_trailing_event_is_not_dispatched) {
    char *got = feed_all("data: done\n\ndata: partial\n", 4096);
    CHECK_STR(got, "|done\n");
    free(got);
}

TEST(callback_nonzero_return_stops_parsing_and_propagates) {
    sse_parser_t p; sse_parser_init(&p);
    rec_t r = {0}; buf_init(&r.log); r.stop_after = 1;
    const char *s = "data: 1\n\ndata: 2\n\n";
    CHECK_INT(sse_feed(&p, s, strlen(s), record, &r), 7);
    CHECK_STR(r.log.data, "|1\n");
    buf_free(&r.log);
    sse_parser_free(&p);
}

TEST(rejects_line_longer_than_limit) {
    sse_parser_t p; sse_parser_init(&p);
    rec_t r = {0}; buf_init(&r.log);
    size_t n = 1u << 20;
    char *junk = malloc(n); memset(junk, 'a', n);
    int rc = 0;
    for (unsigned i = 0; i < 17 && rc == 0; i++) rc = sse_feed(&p, junk, n, record, &r);
    CHECK_INT(rc, SSE_ERR_TOO_LONG);
    free(junk);
    buf_free(&r.log);
    sse_parser_free(&p);
}

int main(void) {
    RUN(dispatches_named_event_on_blank_line);
    RUN(joins_multiple_data_lines_with_newline);
    RUN(strips_only_one_leading_space_after_colon);
    RUN(ignores_comments_and_unknown_fields);
    RUN(does_not_dispatch_event_without_data);
    RUN(event_name_resets_after_dispatch);
    RUN(accepts_crlf_and_bare_cr_line_endings);
    RUN(result_is_identical_for_every_chunk_size);
    RUN(incomplete_trailing_event_is_not_dispatched);
    RUN(callback_nonzero_return_stops_parsing_and_propagates);
    RUN(rejects_line_longer_than_limit);
    TEST_MAIN_END();
}
