#include "test.h"
#include "collect.h"
#include "reducer.h"

#include <stdlib.h>
#include <yyjson.h>

static void ev(collector_t *c, const char *name, const char *json) { collect_on_event(c, name, json, strlen(json)); }

static yyjson_doc *result(collector_t *c, int *status) {
    buf_t out; buf_init(&out);
    *status = collector_result(c, &out);
    yyjson_doc *d = out.data ? yyjson_read(out.data, out.len, 0) : NULL;
    buf_free(&out);
    return d;
}
static const char *S(yyjson_doc *d, const char *p) { return d ? yyjson_get_str(yyjson_ptr_get(yyjson_doc_get_root(d), p)) : NULL; }
static long long   I(yyjson_doc *d, const char *p) { yyjson_val *v = d ? yyjson_ptr_get(yyjson_doc_get_root(d), p) : NULL; return v ? yyjson_get_sint(v) : -999; }

#define START "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"gpt-5.6-sol\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}"
#define STOP(i) "{\"type\":\"content_block_stop\",\"index\":" #i "}"
#define MSG_DELTA(reason) "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"" reason "\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":7,\"output_tokens\":3,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":5}}"

TEST(assembles_text_message_with_usage_and_stop_reason) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    ev(c, "content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}");
    ev(c, "ping", "{\"type\":\"ping\"}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}");
    ev(c, "content_block_stop", STOP(0));
    ev(c, "message_delta", MSG_DELTA("end_turn"));
    ev(c, "message_stop", "{\"type\":\"message_stop\"}");
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 200);
    CHECK_STR(S(d, "/id"), "msg_1");
    CHECK_STR(S(d, "/type"), "message");
    CHECK_STR(S(d, "/role"), "assistant");
    CHECK_STR(S(d, "/model"), "gpt-5.6-sol");
    CHECK_STR(S(d, "/content/0/type"), "text");
    CHECK_STR(S(d, "/content/0/text"), "Hello");
    CHECK_STR(S(d, "/stop_reason"), "end_turn");
    CHECK_INT(I(d, "/usage/input_tokens"), 7);
    CHECK_INT(I(d, "/usage/output_tokens"), 3);
    CHECK_INT(I(d, "/usage/cache_read_input_tokens"), 5);
    yyjson_doc_free(d); collector_free(c);
}

TEST(tool_use_input_is_parsed_from_accumulated_partial_json) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    ev(c, "content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Read\",\"input\":{}}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"file_pa\"}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"th\\\":\\\"/a\\\"}\"}}");
    ev(c, "content_block_stop", STOP(0));
    ev(c, "message_delta", MSG_DELTA("tool_use"));
    ev(c, "message_stop", "{\"type\":\"message_stop\"}");
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 200);
    CHECK_STR(S(d, "/content/0/type"), "tool_use");
    CHECK_STR(S(d, "/content/0/id"), "call_1");
    CHECK_STR(S(d, "/content/0/name"), "Read");
    CHECK_STR(S(d, "/content/0/input/file_path"), "/a");
    CHECK_STR(S(d, "/stop_reason"), "tool_use");
    yyjson_doc_free(d); collector_free(c);
}

TEST(unparseable_tool_arguments_become_empty_input_not_a_crash) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    ev(c, "content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"c\",\"name\":\"T\",\"input\":{}}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"trunc\"}}");
    ev(c, "content_block_stop", STOP(0));
    ev(c, "message_delta", MSG_DELTA("tool_use"));
    ev(c, "message_stop", "{\"type\":\"message_stop\"}");
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 200);
    CHECK(yyjson_is_obj(yyjson_ptr_get(yyjson_doc_get_root(d), "/content/0/input")));
    yyjson_doc_free(d); collector_free(c);
}

TEST(thinking_block_keeps_text_and_signature_and_block_order) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    ev(c, "content_block_start", "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"plan\"}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"cx1:rs_1:ENC\"}}");
    ev(c, "content_block_stop", STOP(0));
    ev(c, "content_block_start", "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}");
    ev(c, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}");
    ev(c, "content_block_stop", STOP(1));
    ev(c, "message_delta", MSG_DELTA("end_turn"));
    ev(c, "message_stop", "{\"type\":\"message_stop\"}");
    int st; yyjson_doc *d = result(c, &st);
    CHECK_STR(S(d, "/content/0/type"), "thinking");
    CHECK_STR(S(d, "/content/0/thinking"), "plan");
    CHECK_STR(S(d, "/content/0/signature"), "cx1:rs_1:ENC");
    CHECK_STR(S(d, "/content/1/text"), "done");
    yyjson_doc_free(d); collector_free(c);
}

TEST(stream_error_becomes_the_response_with_matching_status) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    ev(c, "error", "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}");
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 429);
    CHECK_STR(S(d, "/type"), "error");
    CHECK_STR(S(d, "/error/message"), "slow down");
    yyjson_doc_free(d); collector_free(c);

    c = collector_new();
    ev(c, "error", "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: x\"}}");
    d = result(c, &st);
    CHECK_INT(st, 400);
    yyjson_doc_free(d); collector_free(c);
}

TEST(stream_that_never_completes_is_a_502) {
    collector_t *c = collector_new();
    ev(c, "message_start", START);
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 502);
    CHECK_STR(S(d, "/type"), "error");
    yyjson_doc_free(d); collector_free(c);
}

static int feed_reducer(void *ud, const char *e, const char *j, size_t n) { return collect_on_event(ud, e, j, n); }

TEST(works_end_to_end_behind_the_reducer) {
    collector_t *c = collector_new();
    reducer_t *r = reducer_new("gpt-5.6-luna", feed_reducer, c);
    const char *evs[] = {
        "{\"type\":\"response.created\",\"response\":{\"id\":\"resp_9\"}}",
        "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"A title\"}",
        "{\"type\":\"response.completed\",\"response\":{\"id\":\"resp_9\",\"usage\":{\"input_tokens\":12,\"input_tokens_details\":{\"cached_tokens\":2},\"output_tokens\":4,\"total_tokens\":16}}}",
    };
    for (size_t i = 0; i < 3; i++) reducer_on_event(r, evs[i], strlen(evs[i]));
    reducer_finish(r);
    int st; yyjson_doc *d = result(c, &st);
    CHECK_INT(st, 200);
    CHECK_STR(S(d, "/id"), "msg_9");
    CHECK_STR(S(d, "/content/0/text"), "A title");
    CHECK_INT(I(d, "/usage/input_tokens"), 10);
    yyjson_doc_free(d); reducer_free(r); collector_free(c);
}

int main(void) {
    RUN(assembles_text_message_with_usage_and_stop_reason);
    RUN(tool_use_input_is_parsed_from_accumulated_partial_json);
    RUN(unparseable_tool_arguments_become_empty_input_not_a_crash);
    RUN(thinking_block_keeps_text_and_signature_and_block_order);
    RUN(stream_error_becomes_the_response_with_matching_status);
    RUN(stream_that_never_completes_is_a_502);
    RUN(works_end_to_end_behind_the_reducer);
    TEST_MAIN_END();
}
