#include "test.h"
#include "translate_req.h"
#include "rsig.h"
#include "buf.h"

#include <stdlib.h>
#include <yyjson.h>

/* Translate `in`, parse the upstream body, and keep both around for assertions. */
typedef struct { xlate_req_t x; yyjson_doc *doc; yyjson_val *root; int rc; char err[256]; } tr_t;

static tr_t tr(const char *in) {
    tr_t t; memset(&t, 0, sizeof t);
    t.rc = translate_request(in, strlen(in), &t.x, t.err, sizeof t.err);
    if (t.rc == 0) {
        t.doc = yyjson_read(t.x.body, t.x.body_len, 0);
        t.root = yyjson_doc_get_root(t.doc);
    }
    return t;
}
static void tr_free(tr_t *t) { yyjson_doc_free(t->doc); xlate_req_free(&t->x); }

static yyjson_val *P(tr_t *t, const char *ptr) { return t->root ? yyjson_ptr_get(t->root, ptr) : NULL; }
static const char *S(tr_t *t, const char *ptr) { return yyjson_get_str(P(t, ptr)); }
static long long   N(tr_t *t, const char *ptr) { yyjson_val *v = P(t, ptr); return yyjson_is_arr(v) ? (long long)yyjson_arr_size(v) : -1; }

#define REQ(rest) "{\"model\":\"gpt-6-sol\",\"max_tokens\":32000,\"temperature\":1,\"stream\":true," rest "}"
#define USER_HI   "\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]"

TEST(minimal_request_gets_fixed_upstream_fields) {
    tr_t t = tr(REQ("\"system\":\"Be brief.\"," USER_HI));
    CHECK_INT(t.rc, 0);
    CHECK_STR(S(&t, "/model"), "gpt-6.1-sol");
    CHECK_STR(S(&t, "/instructions"), "Be brief.");
    CHECK_STR(S(&t, "/input/0/type"), "message");
    CHECK_STR(S(&t, "/input/0/role"), "user");
    CHECK_STR(S(&t, "/input/0/content/0/type"), "input_text");
    CHECK_STR(S(&t, "/input/0/content/0/text"), "hi");
    CHECK(yyjson_is_false(P(&t, "/store")));
    CHECK(yyjson_is_true(P(&t, "/stream")));
    CHECK(yyjson_is_true(P(&t, "/parallel_tool_calls")));
    CHECK_STR(S(&t, "/tool_choice"), "auto");
    CHECK_STR(S(&t, "/include/0"), "reasoning.encrypted_content");
    CHECK_STR(S(&t, "/reasoning/effort"), "high");
    CHECK_STR(S(&t, "/reasoning/summary"), "auto");
    CHECK_STR(S(&t, "/text/verbosity"), "low");
    CHECK_INT(N(&t, "/tools"), 0);
    CHECK(P(&t, "/max_output_tokens") == NULL);
    CHECK(P(&t, "/max_tokens") == NULL);
    CHECK(P(&t, "/temperature") == NULL);
    CHECK(P(&t, "/metadata") == NULL);
    CHECK_STR(t.x.client_model, "gpt-6-sol");
    CHECK_INT(t.x.stream, 1);
    tr_free(&t);
}

TEST(non_streaming_client_is_recorded_but_upstream_still_streams) {
    tr_t t = tr("{\"model\":\"gpt-6-luna\"," USER_HI "}");
    CHECK_INT(t.rc, 0);
    CHECK_INT(t.x.stream, 0);
    CHECK(yyjson_is_true(P(&t, "/stream")));
    tr_free(&t);
}

TEST(model_suffix_and_body_effort_resolve_through_models) {
    tr_t t = tr("{\"model\":\"gpt-6-astra@ultra[1m]\"," USER_HI "}");
    CHECK_STR(S(&t, "/model"), "gpt-6-astra");
    CHECK_STR(S(&t, "/reasoning/effort"), "ultra");
    CHECK_STR(t.x.client_model, "gpt-6-astra@ultra[1m]");
    tr_free(&t);
    t = tr("{\"model\":\"gpt-5.6-terra\",\"output_config\":{\"effort\":\"max\"}," USER_HI "}");
    CHECK_STR(S(&t, "/model"), "gpt-6.1-sol");
    CHECK_STR(S(&t, "/reasoning/effort"), "max");
    tr_free(&t);
    t = tr("{\"model\":\"gpt-sol\"," USER_HI "}");
    CHECK_STR(S(&t, "/model"), "gpt-6.1-sol");
    tr_free(&t);
}

TEST(unknown_gpt_model_is_404_and_bad_effort_is_400) {
    tr_t t = tr("{\"model\":\"gpt-5.6\"," USER_HI "}");
    CHECK_INT(t.rc, -404);
    CHECK(strstr(t.err, "gpt-6.1-sol") != NULL);
    CHECK(strstr(t.err, "gpt-6-luna") != NULL);
    CHECK(strstr(t.err, "gpt-6-astra") != NULL);
    CHECK(strstr(t.err, "gpt-5.6-terra") == NULL);
    tr_free(&t);
    t = tr("{\"model\":\"gpt-6-sol@turbo\"," USER_HI "}");
    CHECK_INT(t.rc, -400);
    tr_free(&t);
    t = tr("{\"model\":\"gpt-sol\\u0000suffix\"," USER_HI "}");
    CHECK_INT(t.rc, -400);
    tr_free(&t);
}

TEST(malformed_requests_are_400) {
    tr_t t = tr("{not json");                                   CHECK_INT(t.rc, -400); tr_free(&t);
    t = tr("[]");                                               CHECK_INT(t.rc, -400); tr_free(&t);
    t = tr("{\"model\":\"gpt-6-sol\"}");                      CHECK_INT(t.rc, -400); tr_free(&t);
    t = tr("{\"model\":\"gpt-6-sol\",\"messages\":\"x\"}");   CHECK_INT(t.rc, -400); tr_free(&t);
    t = tr("{\"messages\":[]}");                                CHECK_INT(t.rc, -400); tr_free(&t);
}

TEST(system_blocks_are_joined_and_billing_header_block_dropped) {
    tr_t t = tr(REQ("\"system\":[{\"type\":\"text\",\"text\":\"x-anthropic-billing-header: cc_version=1\"},"
                    "{\"type\":\"text\",\"text\":\"You are Claude Code.\",\"cache_control\":{\"type\":\"ephemeral\"}},"
                    "{\"type\":\"text\",\"text\":\"Env info.\"}]," USER_HI));
    CHECK_STR(S(&t, "/instructions"), "You are Claude Code.\n\nEnv info.");
    tr_free(&t);
}

TEST(absent_system_prompt_omits_instructions) {
    tr_t t = tr(REQ(USER_HI));
    CHECK(P(&t, "/instructions") == NULL);
    tr_free(&t);
}

TEST(user_image_block_becomes_data_url) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"see\"},"
                    "{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"iVBORw0KGgo=\"}}]}]"));
    CHECK_STR(S(&t, "/input/0/content/1/type"), "input_image");
    CHECK_STR(S(&t, "/input/0/content/1/image_url"), "data:image/png;base64,iVBORw0KGgo=");
    tr_free(&t);
}

TEST(assistant_text_and_tool_use_keep_their_order) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"read it\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Looking.\"},"
        "{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"/a\",\"n\":2}}]},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\",\"content\":\"file body\"}]}]"));
    CHECK_INT(N(&t, "/input"), 4);
    CHECK_STR(S(&t, "/input/1/role"), "assistant");
    CHECK_STR(S(&t, "/input/1/content/0/type"), "output_text");
    CHECK_STR(S(&t, "/input/1/content/0/text"), "Looking.");
    CHECK_STR(S(&t, "/input/2/type"), "function_call");
    CHECK_STR(S(&t, "/input/2/call_id"), "toolu_1");
    CHECK_STR(S(&t, "/input/2/name"), "Read");
    /* arguments is a JSON *string* that parses back to the original input */
    const char *args = S(&t, "/input/2/arguments");
    CHECK(args != NULL);
    if (args) {
        yyjson_doc *a = yyjson_read(args, strlen(args), 0);
        CHECK(a && !strcmp(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(a), "file_path")), "/a"));
        yyjson_doc_free(a);
    }
    CHECK_STR(S(&t, "/input/3/type"), "function_call_output");
    CHECK_STR(S(&t, "/input/3/call_id"), "toolu_1");
    CHECK_STR(S(&t, "/input/3/output"), "file body");
    tr_free(&t);
}

TEST(tool_result_variants) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"go\"},"
        "{\"role\":\"assistant\",\"content\":["
          "{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"T\",\"input\":{}},"
          "{\"type\":\"tool_use\",\"id\":\"b\",\"name\":\"T\",\"input\":{}},"
          "{\"type\":\"tool_use\",\"id\":\"c\",\"name\":\"T\",\"input\":{}},"
          "{\"type\":\"tool_use\",\"id\":\"d\",\"name\":\"T\",\"input\":{}}]},"
        "{\"role\":\"user\",\"content\":["
          "{\"type\":\"tool_result\",\"tool_use_id\":\"a\",\"content\":[{\"type\":\"text\",\"text\":\"one\"},{\"type\":\"text\",\"text\":\"two\"}]},"
          "{\"type\":\"tool_result\",\"tool_use_id\":\"b\",\"is_error\":true,\"content\":\"boom\"},"
          "{\"type\":\"tool_result\",\"tool_use_id\":\"c\"},"
          "{\"type\":\"tool_result\",\"tool_use_id\":\"d\",\"content\":[{\"type\":\"text\",\"text\":\"shot\"},"
            "{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/jpeg\",\"data\":\"/9j/4A==\"}}]},"
          "{\"type\":\"text\",\"text\":\"and continue\"}]}]"));
    CHECK_INT(t.rc, 0);
    /* input: user, 4 calls, 4 outputs, trailing user text */
    CHECK_INT(N(&t, "/input"), 10);
    CHECK_STR(S(&t, "/input/5/output"), "one\ntwo");
    CHECK_STR(S(&t, "/input/6/output"), "[tool execution error]\nboom");
    CHECK_STR(S(&t, "/input/7/output"), "");
    CHECK_STR(S(&t, "/input/8/output/0/type"), "input_text");
    CHECK_STR(S(&t, "/input/8/output/1/type"), "input_image");
    CHECK_STR(S(&t, "/input/8/output/1/image_url"), "data:image/jpeg;base64,/9j/4A==");
    CHECK_STR(S(&t, "/input/9/role"), "user");
    CHECK_STR(S(&t, "/input/9/content/0/text"), "and continue");
    tr_free(&t);
}

TEST(user_text_before_tool_result_is_flushed_first) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"go\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"T\",\"input\":{}}]},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"note\"},"
          "{\"type\":\"tool_result\",\"tool_use_id\":\"a\",\"content\":\"ok\"}]}]"));
    /* The call's output must directly follow the call; the note comes after the pair. */
    CHECK_STR(S(&t, "/input/1/type"), "function_call");
    CHECK_STR(S(&t, "/input/2/type"), "function_call_output");
    CHECK_STR(S(&t, "/input/3/content/0/text"), "note");
    tr_free(&t);
}

TEST(our_thinking_signature_round_trips_to_a_reasoning_item) {
    buf_t sig; buf_init(&sig);
    rsig_encode(&sig, "rs_42", "gAAAAenc");
    buf_t req; buf_init(&req);
    buf_appendf(&req, REQ("\"messages\":[{\"role\":\"user\",\"content\":\"q\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hmm\",\"signature\":\"%s\"},"
        "{\"type\":\"tool_use\",\"id\":\"a\",\"name\":\"T\",\"input\":{}}]},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"a\",\"content\":\"ok\"}]}]"), sig.data);
    tr_t t = tr(req.data);
    CHECK_STR(S(&t, "/input/1/type"), "reasoning");
    CHECK_STR(S(&t, "/input/1/id"), "rs_42");
    CHECK_STR(S(&t, "/input/1/encrypted_content"), "gAAAAenc");
    CHECK_INT(N(&t, "/input/1/summary"), 0);
    CHECK_STR(S(&t, "/input/2/type"), "function_call");
    tr_free(&t); buf_free(&sig); buf_free(&req);
}

TEST(foreign_and_redacted_thinking_blocks_are_dropped) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"q\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"x\",\"signature\":\"EqQBCgIYAhIM\"},"
        "{\"type\":\"redacted_thinking\",\"data\":\"abc\"},{\"type\":\"thinking\",\"thinking\":\"y\"},"
        "{\"type\":\"text\",\"text\":\"answer\"}]},{\"role\":\"user\",\"content\":\"next\"}]"));
    CHECK_INT(N(&t, "/input"), 3);
    CHECK_STR(S(&t, "/input/1/content/0/text"), "answer");
    tr_free(&t);
}

TEST(unpaired_calls_get_aborted_output_and_orphan_outputs_are_dropped) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"go\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"lonely\",\"name\":\"T\",\"input\":{}}]},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"ghost\",\"content\":\"x\"},"
          "{\"type\":\"text\",\"text\":\"never mind\"}]}]"));
    CHECK_INT(N(&t, "/input"), 4);
    CHECK_STR(S(&t, "/input/1/call_id"), "lonely");
    CHECK_STR(S(&t, "/input/2/type"), "function_call_output");
    CHECK_STR(S(&t, "/input/2/call_id"), "lonely");
    CHECK_STR(S(&t, "/input/2/output"), "aborted");
    CHECK_STR(S(&t, "/input/3/content/0/text"), "never mind");
    tr_free(&t);
}

TEST(empty_text_blocks_and_empty_messages_are_not_emitted) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"user\",\"content\":\"a\"},"
        "{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"\"}]},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}]"));
    CHECK_INT(N(&t, "/input"), 2);
    tr_free(&t);
}

TEST(system_role_message_becomes_developer_and_unknown_blocks_are_noted) {
    tr_t t = tr(REQ("\"messages\":[{\"role\":\"system\",\"content\":\"mid rule\"},"
        "{\"role\":\"user\",\"content\":[{\"type\":\"document\",\"source\":{}},{\"type\":\"text\",\"text\":\"q\"}]}]"));
    CHECK_STR(S(&t, "/input/0/role"), "developer");
    CHECK_STR(S(&t, "/input/0/content/0/text"), "mid rule");
    CHECK_STR(S(&t, "/input/1/content/0/text"), "[unsupported content block omitted: document]");
    CHECK_STR(S(&t, "/input/1/content/1/text"), "q");
    tr_free(&t);
}

TEST(tools_become_function_tools_with_sanitized_schema) {
    tr_t t = tr(REQ(USER_HI ",\"tools\":["
        "{\"name\":\"Read\",\"description\":\"Reads a file\",\"input_schema\":{\"type\":\"object\",\"properties\":"
          "{\"file_path\":{\"type\":\"string\",\"pattern\":\"^/\",\"format\":\"path\"}},\"required\":[\"file_path\"],\"$schema\":\"x\"}},"
        "{\"type\":\"web_search_20250305\",\"name\":\"web_search\",\"max_uses\":5},"
        "{\"name\":\"bad name!\",\"input_schema\":{\"type\":\"object\"}},"
        "{\"name\":\"mcp__srv__do-it\",\"input_schema\":{\"type\":\"object\"}}]"));
    CHECK_INT(N(&t, "/tools"), 2);
    CHECK_STR(S(&t, "/tools/0/type"), "function");
    CHECK_STR(S(&t, "/tools/0/name"), "Read");
    CHECK_STR(S(&t, "/tools/0/description"), "Reads a file");
    CHECK(yyjson_is_false(P(&t, "/tools/0/strict")));
    CHECK_STR(S(&t, "/tools/0/parameters/properties/file_path/type"), "string");
    CHECK(P(&t, "/tools/0/parameters/properties/file_path/pattern") == NULL);
    CHECK(P(&t, "/tools/0/parameters/$schema") == NULL);
    CHECK_STR(S(&t, "/tools/0/parameters/required/0"), "file_path");
    CHECK_STR(S(&t, "/tools/1/name"), "mcp__srv__do-it");
    tr_free(&t);
}

TEST(tool_choice_mapping) {
    #define TOOLS ",\"tools\":[{\"name\":\"Read\",\"input_schema\":{\"type\":\"object\"}}]"
    tr_t t = tr(REQ(USER_HI TOOLS ",\"tool_choice\":{\"type\":\"any\"}"));
    CHECK_STR(S(&t, "/tool_choice"), "required"); tr_free(&t);
    t = tr(REQ(USER_HI TOOLS ",\"tool_choice\":{\"type\":\"none\"}"));
    CHECK_STR(S(&t, "/tool_choice"), "none"); tr_free(&t);
    t = tr(REQ(USER_HI TOOLS ",\"tool_choice\":{\"type\":\"tool\",\"name\":\"Read\"}"));
    CHECK_STR(S(&t, "/tool_choice/type"), "function");
    CHECK_STR(S(&t, "/tool_choice/name"), "Read"); tr_free(&t);
    t = tr(REQ(USER_HI TOOLS ",\"tool_choice\":{\"type\":\"tool\",\"name\":\"Missing\"}"));
    CHECK_STR(S(&t, "/tool_choice"), "auto"); tr_free(&t);
    t = tr(REQ(USER_HI ",\"tool_choice\":{\"type\":\"any\"}"));
    CHECK_STR(S(&t, "/tool_choice"), "auto"); tr_free(&t);
    t = tr(REQ(USER_HI TOOLS ",\"tool_choice\":{\"type\":\"auto\",\"disable_parallel_tool_use\":true}"));
    CHECK_STR(S(&t, "/tool_choice"), "auto");
    CHECK(yyjson_is_false(P(&t, "/parallel_tool_calls"))); tr_free(&t);
}

TEST(session_id_is_taken_from_claude_code_metadata) {
    tr_t t = tr(REQ(USER_HI ",\"metadata\":{\"user_id\":\"user_abc123_account_1111-22_session_0f8fad5b-d9cb-469f-a165-70867728950e\"}"));
    CHECK_STR(t.x.session_id, "0f8fad5b-d9cb-469f-a165-70867728950e");
    CHECK_STR(S(&t, "/prompt_cache_key"), "0f8fad5b-d9cb-469f-a165-70867728950e");
    tr_free(&t);
    /* Claude Code >= 2.1.27x sends user_id as a JSON document instead. */
    t = tr(REQ(USER_HI ",\"metadata\":{\"user_id\":\"{\\\"device_id\\\":\\\"abc\\\",\\\"account_uuid\\\":\\\"\\\",\\\"session_id\\\":\\\"e3631a2f-698c-405f-a79a-2d902d3282f6\\\"}\"}"));
    CHECK_STR(t.x.session_id, "e3631a2f-698c-405f-a79a-2d902d3282f6");
    CHECK_STR(S(&t, "/prompt_cache_key"), "e3631a2f-698c-405f-a79a-2d902d3282f6");
    tr_free(&t);
    t = tr(REQ(USER_HI ",\"metadata\":{\"user_id\":\"{\\\"session_id\\\":\\\"bad id\\\\r\\\\nX: 1\\\"}\"}"));
    CHECK_STR(t.x.session_id, "");
    tr_free(&t);
    t = tr(REQ(USER_HI ",\"metadata\":{\"user_id\":\"{broken json\"}"));
    CHECK_STR(t.x.session_id, "");
    tr_free(&t);
    t = tr(REQ(USER_HI));
    CHECK_STR(t.x.session_id, "");
    CHECK(P(&t, "/prompt_cache_key") == NULL);
    tr_free(&t);
    t = tr(REQ(USER_HI ",\"metadata\":{\"user_id\":\"x_session_bad id\\r\\nInjected: 1\"}"));
    CHECK_STR(t.x.session_id, "");
    tr_free(&t);
}

TEST(background_request_for_a_claude_model_goes_to_luna) {
    tr_t t = tr("{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":512," USER_HI "}");
    CHECK_INT(t.rc, 0);
    CHECK_STR(S(&t, "/model"), "gpt-6-luna");
    CHECK_STR(S(&t, "/reasoning/effort"), "low");
    CHECK_INT(t.x.sel.remapped, 1);
    tr_free(&t);
}

int main(void) {
    RUN(minimal_request_gets_fixed_upstream_fields);
    RUN(non_streaming_client_is_recorded_but_upstream_still_streams);
    RUN(model_suffix_and_body_effort_resolve_through_models);
    RUN(unknown_gpt_model_is_404_and_bad_effort_is_400);
    RUN(malformed_requests_are_400);
    RUN(system_blocks_are_joined_and_billing_header_block_dropped);
    RUN(absent_system_prompt_omits_instructions);
    RUN(user_image_block_becomes_data_url);
    RUN(assistant_text_and_tool_use_keep_their_order);
    RUN(tool_result_variants);
    RUN(user_text_before_tool_result_is_flushed_first);
    RUN(our_thinking_signature_round_trips_to_a_reasoning_item);
    RUN(foreign_and_redacted_thinking_blocks_are_dropped);
    RUN(unpaired_calls_get_aborted_output_and_orphan_outputs_are_dropped);
    RUN(empty_text_blocks_and_empty_messages_are_not_emitted);
    RUN(system_role_message_becomes_developer_and_unknown_blocks_are_noted);
    RUN(tools_become_function_tools_with_sanitized_schema);
    RUN(tool_choice_mapping);
    RUN(session_id_is_taken_from_claude_code_metadata);
    RUN(background_request_for_a_claude_model_goes_to_luna);
    TEST_MAIN_END();
}
