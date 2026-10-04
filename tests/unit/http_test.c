#include "test.h"
#include "http.h"

#include <stdlib.h>

static int parse(const char *s, http_req_t *r) { return http_parse_head(s, strlen(s), r); }

TEST(parses_post_with_content_length) {
    http_req_t r;
    const char *s = "POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 12\r\n\r\n{\"a\":\"body\"}";
    CHECK_INT(parse(s, &r), HTTP_OK);
    CHECK_STR(r.method, "POST");
    CHECK_STR(r.path, "/v1/messages");
    CHECK_INT(r.has_content_length, 1);
    CHECK_INT(r.content_length, 12);
    CHECK_STR(s + r.head_len, "{\"a\":\"body\"}");
}

TEST(strips_query_string_from_path) {
    http_req_t r;
    CHECK_INT(parse("POST /v1/messages?beta=true HTTP/1.1\r\ncontent-length: 0\r\n\r\n", &r), HTTP_OK);
    CHECK_STR(r.path, "/v1/messages");
}

TEST(header_names_are_case_insensitive_and_values_trimmed) {
    http_req_t r;
    CHECK_INT(parse("POST /x HTTP/1.1\r\ncOnTeNt-LeNgTh:   42  \r\n\r\n", &r), HTTP_OK);
    CHECK_INT(r.content_length, 42);
}

TEST(get_without_body_needs_no_content_length) {
    http_req_t r;
    CHECK_INT(parse("GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n", &r), HTTP_OK);
    CHECK_STR(r.method, "GET");
    CHECK_INT(r.has_content_length, 0);
    CHECK_INT(r.content_length, 0);
}

TEST(reports_need_more_until_blank_line_arrives) {
    http_req_t r;
    const char *s = "POST /v1/messages HTTP/1.1\r\nContent-Length: 5\r\n\r\n";
    for (size_t n = 0; n < strlen(s); n++) CHECK_INT(http_parse_head(s, n, &r), HTTP_MORE);
    CHECK_INT(http_parse_head(s, strlen(s), &r), HTTP_OK);
}

TEST(post_without_content_length_is_411) {
    http_req_t r;
    CHECK_INT(parse("POST /v1/messages HTTP/1.1\r\nHost: x\r\n\r\n", &r), HTTP_E_LENGTH_REQUIRED);
}

TEST(chunked_request_body_is_501) {
    http_req_t r;
    CHECK_INT(parse("POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", &r), HTTP_E_NOT_IMPLEMENTED);
}

TEST(rejects_malformed_content_length) {
    http_req_t r;
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: 12abc\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: -1\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: \r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: 99999999999999999999999\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
}

TEST(conflicting_duplicate_content_length_is_rejected) {
    http_req_t r;
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
}

TEST(body_over_cap_is_413) {
    http_req_t r;
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: 67108865\r\n\r\n", &r), HTTP_E_BODY_TOO_LARGE);
    CHECK_INT(parse("POST /x HTTP/1.1\r\nContent-Length: 67108864\r\n\r\n", &r), HTTP_OK);
}

TEST(rejects_malformed_request_lines) {
    http_req_t r;
    CHECK_INT(parse("\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST /x\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("POST /x SPDY/9\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("VERYLONGMETHOD /x HTTP/1.1\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("GET x HTTP/1.1\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
    CHECK_INT(parse("GET /x HTTP/1.1\r\nno-colon-here\r\n\r\n", &r), HTTP_E_BAD_REQUEST);
}

TEST(overlong_path_is_rejected_not_truncated) {
    http_req_t r;
    char s[600] = "GET /";
    memset(s + 5, 'a', 300);
    strcpy(s + 305, " HTTP/1.1\r\n\r\n");
    CHECK_INT(parse(s, &r), HTTP_E_BAD_REQUEST);
}

TEST(head_larger_than_cap_is_431_even_without_terminator) {
    http_req_t r;
    size_t n = HTTP_MAX_HEAD + 1;
    char *s = malloc(n);
    memset(s, 'a', n);
    memcpy(s, "GET / HTTP/1.1\r\nX: ", 19);
    CHECK_INT(http_parse_head(s, n, &r), HTTP_E_HEAD_TOO_LARGE);
    free(s);
}

TEST(embedded_nul_in_head_is_rejected) {
    http_req_t r;
    const char s[] = "GET /he\0althz HTTP/1.1\r\n\r\n";
    CHECK_INT(http_parse_head(s, sizeof s - 1, &r), HTTP_E_BAD_REQUEST);
}

int main(void) {
    RUN(parses_post_with_content_length);
    RUN(strips_query_string_from_path);
    RUN(header_names_are_case_insensitive_and_values_trimmed);
    RUN(get_without_body_needs_no_content_length);
    RUN(reports_need_more_until_blank_line_arrives);
    RUN(post_without_content_length_is_411);
    RUN(chunked_request_body_is_501);
    RUN(rejects_malformed_content_length);
    RUN(conflicting_duplicate_content_length_is_rejected);
    RUN(body_over_cap_is_413);
    RUN(rejects_malformed_request_lines);
    RUN(overlong_path_is_rejected_not_truncated);
    RUN(head_larger_than_cap_is_431_even_without_terminator);
    RUN(embedded_nul_in_head_is_rejected);
    TEST_MAIN_END();
}
