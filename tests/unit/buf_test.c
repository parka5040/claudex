#include "test.h"
#include "buf.h"

TEST(append_keeps_contents_nul_terminated) {
    buf_t b; buf_init(&b);
    CHECK_INT(buf_append(&b, "abc", 3), 0);
    CHECK_INT(buf_append_str(&b, "def"), 0);
    CHECK_INT(b.len, 6);
    CHECK_STR(b.data, "abcdef");
    buf_free(&b);
}

TEST(append_grows_past_initial_capacity) {
    buf_t b; buf_init(&b);
    for (int i = 0; i < 10000; i++) CHECK_INT(buf_append(&b, "x", 1), 0);
    CHECK_INT(b.len, 10000);
    CHECK_INT(b.data[9999], 'x');
    CHECK_INT(b.data[10000], 0);
    buf_free(&b);
}

TEST(append_preserves_embedded_nul_bytes) {
    buf_t b; buf_init(&b);
    CHECK_INT(buf_append(&b, "a\0b", 3), 0);
    CHECK_INT(b.len, 3);
    CHECK_INT(b.data[2], 'b');
    buf_free(&b);
}

TEST(appendf_formats_longer_than_any_stack_scratch) {
    buf_t b; buf_init(&b);
    char big[5000]; memset(big, 'y', sizeof big - 1); big[sizeof big - 1] = 0;
    CHECK_INT(buf_appendf(&b, "n=%d s=%s", 42, big), 0);
    CHECK_INT(b.len, 4 + 1 + 2 + 4999);
    CHECK(strncmp(b.data, "n=42 s=yyy", 10) == 0);
    buf_free(&b);
}

TEST(consume_drops_prefix_and_keeps_rest) {
    buf_t b; buf_init(&b);
    buf_append_str(&b, "hello world");
    buf_consume(&b, 6);
    CHECK_STR(b.data, "world");
    CHECK_INT(b.len, 5);
    buf_free(&b);
}

TEST(consume_more_than_len_empties_buffer) {
    buf_t b; buf_init(&b);
    buf_append_str(&b, "abc");
    buf_consume(&b, 99);
    CHECK_INT(b.len, 0);
    CHECK_STR(b.data, "");
    buf_free(&b);
}

TEST(free_resets_to_reusable_empty_state) {
    buf_t b; buf_init(&b);
    buf_append_str(&b, "abc");
    buf_free(&b);
    CHECK(b.data == NULL);
    CHECK_INT(b.len, 0);
    CHECK_INT(buf_append_str(&b, "again"), 0);
    CHECK_STR(b.data, "again");
    buf_free_secret(&b);
    CHECK(b.data == NULL);
}

int main(void) {
    RUN(append_keeps_contents_nul_terminated);
    RUN(append_grows_past_initial_capacity);
    RUN(append_preserves_embedded_nul_bytes);
    RUN(appendf_formats_longer_than_any_stack_scratch);
    RUN(consume_drops_prefix_and_keeps_rest);
    RUN(consume_more_than_len_empties_buffer);
    RUN(free_resets_to_reusable_empty_state);
    TEST_MAIN_END();
}
