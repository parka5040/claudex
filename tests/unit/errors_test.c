#include "test.h"
#include "errors.h"

#include <yyjson.h>

TEST(maps_http_status_to_anthropic_error_type) {
    CHECK_STR(anthropic_error_type(400), "invalid_request_error");
    CHECK_STR(anthropic_error_type(401), "authentication_error");
    CHECK_STR(anthropic_error_type(403), "permission_error");
    CHECK_STR(anthropic_error_type(404), "not_found_error");
    CHECK_STR(anthropic_error_type(413), "request_too_large");
    CHECK_STR(anthropic_error_type(429), "rate_limit_error");
    CHECK_STR(anthropic_error_type(500), "api_error");
    CHECK_STR(anthropic_error_type(529), "overloaded_error");
}

TEST(unlisted_statuses_fall_back_by_class) {
    CHECK_STR(anthropic_error_type(411), "invalid_request_error");
    CHECK_STR(anthropic_error_type(431), "invalid_request_error");
    CHECK_STR(anthropic_error_type(501), "api_error");
    CHECK_STR(anthropic_error_type(502), "api_error");
    CHECK_STR(anthropic_error_type(503), "overloaded_error");
}

TEST(body_has_anthropic_error_envelope) {
    buf_t b; buf_init(&b);
    CHECK_INT(anthropic_error_body(&b, 429, "slow down"), 0);
    yyjson_doc *d = yyjson_read(b.data, b.len, 0);
    CHECK(d != NULL);
    yyjson_val *root = yyjson_doc_get_root(d);
    CHECK_STR(yyjson_get_str(yyjson_obj_get(root, "type")), "error");
    yyjson_val *e = yyjson_obj_get(root, "error");
    CHECK_STR(yyjson_get_str(yyjson_obj_get(e, "type")), "rate_limit_error");
    CHECK_STR(yyjson_get_str(yyjson_obj_get(e, "message")), "slow down");
    yyjson_doc_free(d);
    buf_free(&b);
}

TEST(message_with_quotes_newlines_and_control_bytes_round_trips) {
    const char *msg = "upstream said: \"bad\"\n\ttab \\ backslash \x01 ctrl \xc3\xa9";
    buf_t b; buf_init(&b);
    CHECK_INT(anthropic_error_body(&b, 400, msg), 0);
    yyjson_doc *d = yyjson_read(b.data, b.len, 0);
    CHECK(d != NULL);
    yyjson_val *e = yyjson_obj_get(yyjson_doc_get_root(d), "error");
    CHECK_STR(yyjson_get_str(yyjson_obj_get(e, "message")), msg);
    yyjson_doc_free(d);
    buf_free(&b);
}

TEST(appends_to_existing_buffer_contents) {
    buf_t b; buf_init(&b);
    buf_append_str(&b, "data: ");
    CHECK_INT(anthropic_error_body(&b, 500, "x"), 0);
    CHECK(strncmp(b.data, "data: {", 7) == 0);
    buf_free(&b);
}

int main(void) {
    RUN(maps_http_status_to_anthropic_error_type);
    RUN(unlisted_statuses_fall_back_by_class);
    RUN(body_has_anthropic_error_envelope);
    RUN(message_with_quotes_newlines_and_control_bytes_round_trips);
    RUN(appends_to_existing_buffer_contents);
    TEST_MAIN_END();
}
