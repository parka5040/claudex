#include "test.h"
#include "reducer.h"
#include "rsig.h"
#include "sse.h"
#include "buf.h"

#include <stdlib.h>
#include <yyjson.h>

/* ---- recording harness ------------------------------------------------ */

#define MAX_EV 64
typedef struct {
    char        name[MAX_EV][40];
    yyjson_doc *doc[MAX_EV];
    int         n;
    int         fail_at; /* emit callback returns 9 on this (1-based) event; 0 = never */
} rec_t;

static int rec_emit(void *ud, const char *event, const char *json, size_t len) {
    rec_t *r = ud;
    if (r->n < MAX_EV) {
        snprintf(r->name[r->n], sizeof r->name[0], "%s", event);
        r->doc[r->n] = yyjson_read(json, len, 0);
        r->n++;
    }
    return (r->fail_at && r->n >= r->fail_at) ? 9 : 0;
}

static void rec_free(rec_t *r) {
    for (int i = 0; i < r->n; i++) yyjson_doc_free(r->doc[i]);
    r->n = 0;
}

static yyjson_val *at(rec_t *r, int i, const char *ptr) {
    if (i >= r->n || !r->doc[i]) return NULL;
    return yyjson_ptr_get(yyjson_doc_get_root(r->doc[i]), ptr);
}
static const char *str_at(rec_t *r, int i, const char *ptr) { return yyjson_get_str(at(r, i, ptr)); }
static long long   int_at(rec_t *r, int i, const char *ptr) { yyjson_val *v = at(r, i, ptr); return v ? yyjson_get_sint(v) : -999; }

/* Space-separated event names, for asserting the overall sequence at a glance. */
static const char *names(rec_t *r) {
    static char out[2048];
    out[0] = 0;
    for (int i = 0; i < r->n; i++) { if (i) strcat(out, " "); strcat(out, r->name[i]); }
    return out;
}

static void feed(reducer_t *red, const char *json) { reducer_on_event(red, json, strlen(json)); }

static int find(rec_t *r, const char *name, int from) {
    for (int i = from; i < r->n; i++) if (strcmp(r->name[i], name) == 0) return i;
    return -1;
}

/* Common upstream events */
#define CREATED   "{\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}"
#define COMPLETED(in, cached, out) \
    "{\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":" #in \
    ",\"input_tokens_details\":{\"cached_tokens\":" #cached "},\"output_tokens\":" #out \
    ",\"output_tokens_details\":{\"reasoning_tokens\":0},\"total_tokens\":0}}}"

/* ---- tests ------------------------------------------------------------ */

static int sse_to_reducer(void *ud, const char *event, const char *data, size_t n) {
    (void)event;
    return reducer_on_event(ud, data, n);
}

TEST(real_text_fixture_becomes_anthropic_text_stream) {
    rec_t r = {0};
    reducer_t *red = reducer_new("gpt-5.6-sol@high", rec_emit, &r);
    FILE *f = fopen("tests/fixtures/text_simple.sse", "rb");
    CHECK(f != NULL);
    if (f) {
        sse_parser_t p; sse_parser_init(&p);
        char chunk[97]; size_t n;
        while ((n = fread(chunk, 1, sizeof chunk, f)) > 0) sse_feed(&p, chunk, n, sse_to_reducer, red);
        sse_parser_free(&p);
        fclose(f);
    }
    CHECK_INT(reducer_finish(red), 0);
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 0, "/type"), "message_start");
    CHECK_STR(str_at(&r, 0, "/message/role"), "assistant");
    CHECK_STR(str_at(&r, 0, "/message/model"), "gpt-5.6-sol@high");
    CHECK(str_at(&r, 0, "/message/id") && strncmp(str_at(&r, 0, "/message/id"), "msg_", 4) == 0);
    CHECK(yyjson_is_arr(at(&r, 0, "/message/content")));
    CHECK_INT(int_at(&r, 1, "/index"), 0);
    CHECK_STR(str_at(&r, 1, "/content_block/type"), "text");
    CHECK_STR(str_at(&r, 2, "/delta/type"), "text_delta");
    CHECK_STR(str_at(&r, 2, "/delta/text"), "hello");
    CHECK_INT(int_at(&r, 3, "/index"), 0);
    CHECK_STR(str_at(&r, 4, "/delta/stop_reason"), "end_turn");
    CHECK_INT(int_at(&r, 4, "/usage/input_tokens"), 27);
    CHECK_INT(int_at(&r, 4, "/usage/output_tokens"), 5);
    CHECK_INT(reducer_done(red), 1);
    reducer_free(red); rec_free(&r);
}

TEST(streamed_function_call_becomes_tool_use_block) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_abc\",\"name\":\"Read\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"fc_1\",\"delta\":\"{\\\"file_\"}");
    feed(red, "{\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"item_id\":\"fc_1\",\"delta\":\"path\\\":\\\"/a\\\"}\"}");
    feed(red, "{\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"item_id\":\"fc_1\",\"arguments\":\"{\\\"file_path\\\":\\\"/a\\\"}\"}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_abc\",\"name\":\"Read\",\"arguments\":\"{\\\"file_path\\\":\\\"/a\\\"}\"}}");
    feed(red, COMPLETED(10, 0, 3));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 1, "/content_block/type"), "tool_use");
    CHECK_STR(str_at(&r, 1, "/content_block/id"), "call_abc");
    CHECK_STR(str_at(&r, 1, "/content_block/name"), "Read");
    CHECK(yyjson_is_obj(at(&r, 1, "/content_block/input")));
    CHECK_STR(str_at(&r, 2, "/delta/type"), "input_json_delta");
    CHECK_STR(str_at(&r, 2, "/delta/partial_json"), "{\"file_");
    CHECK_STR(str_at(&r, 3, "/delta/partial_json"), "path\":\"/a\"}");
    CHECK_STR(str_at(&r, 5, "/delta/stop_reason"), "tool_use");
    reducer_free(red); rec_free(&r);
}

TEST(function_call_without_argument_deltas_emits_arguments_once) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"Bash\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"Bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 2, "/delta/partial_json"), "{\"command\":\"ls\"}");
    reducer_free(red); rec_free(&r);
}

TEST(function_call_with_empty_arguments_still_yields_valid_json) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"Ping\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c1\",\"name\":\"Ping\",\"arguments\":\"\"}}");
    feed(red, COMPLETED(1, 0, 1));
    int d = find(&r, "content_block_delta", 0);
    CHECK(d > 0);
    CHECK_STR(str_at(&r, d, "/delta/partial_json"), "{}");
    reducer_free(red); rec_free(&r);
}

TEST(function_call_seen_only_at_done_is_still_emitted) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"c9\",\"name\":\"Grep\",\"arguments\":\"{\\\"q\\\":1}\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 1, "/content_block/id"), "c9");
    CHECK_STR(str_at(&r, 4, "/delta/stop_reason"), "tool_use");
    reducer_free(red); rec_free(&r);
}

TEST(parallel_function_calls_get_distinct_indices) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"a\",\"name\":\"Read\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"b\",\"name\":\"Read\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"p\\\":2}\"}");
    feed(red, "{\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"p\\\":1}\"}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"a\",\"name\":\"Read\",\"arguments\":\"{\\\"p\\\":1}\"}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"b\",\"name\":\"Read\",\"arguments\":\"{\\\"p\\\":2}\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_INT(int_at(&r, 1, "/index"), 0);
    CHECK_INT(int_at(&r, 2, "/index"), 1);
    CHECK_INT(int_at(&r, 3, "/index"), 1);
    CHECK_STR(str_at(&r, 3, "/delta/partial_json"), "{\"p\":2}");
    CHECK_INT(int_at(&r, 4, "/index"), 0);
    CHECK_STR(str_at(&r, 4, "/delta/partial_json"), "{\"p\":1}");
    int stops = 0;
    for (int i = 0; i < r.n; i++) if (!strcmp(r.name[i], "content_block_stop")) stops++;
    CHECK_INT(stops, 2);
    reducer_free(red); rec_free(&r);
}

TEST(text_then_tool_call_use_consecutive_indices) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"phase\":\"commentary\"}}");
    feed(red, "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"content_index\":0,\"delta\":\"Let me look.\"}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Let me look.\"}]}}");
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"Read\",\"arguments\":\"\"}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"c\",\"name\":\"Read\",\"arguments\":\"{}\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop "
                         "content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 1, "/content_block/type"), "text");
    CHECK_INT(int_at(&r, 4, "/index"), 1);
    CHECK_STR(str_at(&r, 4, "/content_block/type"), "tool_use");
    reducer_free(red); rec_free(&r);
}

TEST(reasoning_summary_becomes_thinking_block_with_decodable_signature) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_77\",\"type\":\"reasoning\",\"summary\":[]}}");
    feed(red, "{\"type\":\"response.reasoning_summary_part.added\",\"output_index\":0,\"summary_index\":0}");
    feed(red, "{\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":0,\"delta\":\"Plan A\"}");
    feed(red, "{\"type\":\"response.reasoning_summary_part.added\",\"output_index\":0,\"summary_index\":1}");
    feed(red, "{\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":1,\"delta\":\"Plan B\"}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_77\",\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"gAAAenc\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_delta content_block_delta "
                         "content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 1, "/content_block/type"), "thinking");
    CHECK_STR(str_at(&r, 2, "/delta/type"), "thinking_delta");
    CHECK_STR(str_at(&r, 2, "/delta/thinking"), "Plan A");
    CHECK_STR(str_at(&r, 3, "/delta/thinking"), "\n\n");
    CHECK_STR(str_at(&r, 4, "/delta/thinking"), "Plan B");
    CHECK_STR(str_at(&r, 5, "/delta/type"), "signature_delta");
    char *id = NULL, *enc = NULL;
    const char *sig = str_at(&r, 5, "/delta/signature");
    CHECK(sig && rsig_decode(sig, &id, &enc) == 0);
    CHECK_STR(id, "rs_77");
    CHECK_STR(enc, "gAAAenc");
    free(id); free(enc);
    reducer_free(red); rec_free(&r);
}

TEST(reasoning_without_summary_still_carries_signature) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"ENC\"}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 1, "/content_block/type"), "thinking");
    CHECK_STR(str_at(&r, 2, "/delta/type"), "signature_delta");
    reducer_free(red); rec_free(&r);
}

TEST(reasoning_with_nothing_to_carry_emits_no_block) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}");
    feed(red, "{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":null}}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start message_delta message_stop");
    reducer_free(red); rec_free(&r);
}

TEST(cached_tokens_are_split_out_of_input_tokens) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, COMPLETED(1000, 800, 42));
    int d = find(&r, "message_delta", 0);
    CHECK_INT(int_at(&r, d, "/usage/input_tokens"), 200);
    CHECK_INT(int_at(&r, d, "/usage/cache_read_input_tokens"), 800);
    CHECK_INT(int_at(&r, d, "/usage/cache_creation_input_tokens"), 0);
    CHECK_INT(int_at(&r, d, "/usage/output_tokens"), 42);
    reducer_free(red); rec_free(&r);
}

TEST(incomplete_for_token_limit_maps_to_max_tokens) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"partial\"}");
    feed(red, "{\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_1\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}");
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    CHECK_STR(str_at(&r, 4, "/delta/stop_reason"), "max_tokens");
    CHECK_INT(reducer_done(red), 1);
    reducer_free(red); rec_free(&r);
}

TEST(context_overflow_failure_uses_wording_claude_code_recognises) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"Your input exceeds the context window.\"}}}");
    int e = find(&r, "error", 0);
    CHECK(e >= 0);
    CHECK_STR(str_at(&r, e, "/type"), "error");
    CHECK_STR(str_at(&r, e, "/error/type"), "invalid_request_error");
    CHECK(str_at(&r, e, "/error/message") && strstr(str_at(&r, e, "/error/message"), "prompt is too long"));
    CHECK_INT(find(&r, "message_stop", 0), -1);
    reducer_free(red); rec_free(&r);
}

TEST(failure_codes_map_to_anthropic_error_types) {
    static const struct { const char *code, *want; } cases[] = {
        { "rate_limit_exceeded", "rate_limit_error" }, { "usage_limit_reached", "rate_limit_error" },
        { "insufficient_quota", "rate_limit_error" },  { "server_is_overloaded", "overloaded_error" },
        { "invalid_prompt", "invalid_request_error" }, { "something_new", "api_error" },
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        rec_t r = {0};
        reducer_t *red = reducer_new("m", rec_emit, &r);
        buf_t ev; buf_init(&ev);
        buf_appendf(&ev, "{\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"%s\",\"message\":\"m\"}}}", cases[i].code);
        feed(red, ev.data);
        CHECK_STR(str_at(&r, 0, "/error/type"), cases[i].want);
        buf_free(&ev); reducer_free(red); rec_free(&r);
    }
}

TEST(stream_ending_without_terminal_event_is_an_error) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hi\"}");
    CHECK_INT(reducer_done(red), 0);
    CHECK_INT(reducer_finish(red), 0);
    CHECK_STR(r.name[r.n - 1], "error");
    CHECK_STR(str_at(&r, r.n - 1, "/error/type"), "api_error");
    reducer_free(red); rec_free(&r);
}

TEST(finish_after_completion_emits_nothing_more) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, COMPLETED(1, 0, 1));
    int n = r.n;
    CHECK_INT(reducer_finish(red), 0);
    feed(red, "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"late\"}");
    CHECK_INT(r.n, n);
    reducer_free(red); rec_free(&r);
}

TEST(unknown_and_malformed_events_are_ignored_and_keepalive_pings) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, CREATED);
    feed(red, "{not json");
    feed(red, "[1,2,3]");
    feed(red, "{\"no_type\":true}");
    feed(red, "{\"type\":\"response.in_progress\"}");
    feed(red, "{\"type\":\"response.brand_new_thing\",\"x\":1}");
    feed(red, "{\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"web_search_call\",\"id\":\"ws_1\"}}");
    feed(red, "{\"type\":\"keepalive\"}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(names(&r), "message_start ping message_delta message_stop");
    reducer_free(red); rec_free(&r);
}

TEST(message_start_is_synthesised_if_created_never_arrives) {
    rec_t r = {0};
    reducer_t *red = reducer_new("m", rec_emit, &r);
    feed(red, "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hi\"}");
    feed(red, COMPLETED(1, 0, 1));
    CHECK_STR(r.name[0], "message_start");
    CHECK_STR(names(&r), "message_start content_block_start content_block_delta content_block_stop message_delta message_stop");
    reducer_free(red); rec_free(&r);
}

TEST(emit_failure_stops_reduction_and_propagates) {
    rec_t r = {0}; r.fail_at = 2;
    reducer_t *red = reducer_new("m", rec_emit, &r);
    CHECK_INT(reducer_on_event(red, CREATED, strlen(CREATED)), 0);
    const char *d = "{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"hi\"}";
    CHECK_INT(reducer_on_event(red, d, strlen(d)), 9);
    reducer_free(red); rec_free(&r);
}

int main(void) {
    RUN(real_text_fixture_becomes_anthropic_text_stream);
    RUN(streamed_function_call_becomes_tool_use_block);
    RUN(function_call_without_argument_deltas_emits_arguments_once);
    RUN(function_call_with_empty_arguments_still_yields_valid_json);
    RUN(function_call_seen_only_at_done_is_still_emitted);
    RUN(parallel_function_calls_get_distinct_indices);
    RUN(text_then_tool_call_use_consecutive_indices);
    RUN(reasoning_summary_becomes_thinking_block_with_decodable_signature);
    RUN(reasoning_without_summary_still_carries_signature);
    RUN(reasoning_with_nothing_to_carry_emits_no_block);
    RUN(cached_tokens_are_split_out_of_input_tokens);
    RUN(incomplete_for_token_limit_maps_to_max_tokens);
    RUN(context_overflow_failure_uses_wording_claude_code_recognises);
    RUN(failure_codes_map_to_anthropic_error_types);
    RUN(stream_ending_without_terminal_event_is_an_error);
    RUN(finish_after_completion_emits_nothing_more);
    RUN(unknown_and_malformed_events_are_ignored_and_keepalive_pings);
    RUN(message_start_is_synthesised_if_created_never_arrives);
    RUN(emit_failure_stops_reduction_and_propagates);
    TEST_MAIN_END();
}
