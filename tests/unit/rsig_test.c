#include "test.h"
#include "rsig.h"

#include <stdlib.h>

TEST(round_trips_id_and_encrypted_content) {
    buf_t b; buf_init(&b);
    CHECK_INT(rsig_encode(&b, "rs_0123abc", "gAAAAB-_x=="), 0);
    char *id = NULL, *enc = NULL;
    CHECK_INT(rsig_decode(b.data, &id, &enc), 0);
    CHECK_STR(id, "rs_0123abc");
    CHECK_STR(enc, "gAAAAB-_x==");
    free(id); free(enc);
    buf_free(&b);
}

TEST(encrypted_content_may_itself_contain_colons) {
    buf_t b; buf_init(&b);
    CHECK_INT(rsig_encode(&b, "rs_1", "a:b:c"), 0);
    char *id = NULL, *enc = NULL;
    CHECK_INT(rsig_decode(b.data, &id, &enc), 0);
    CHECK_STR(id, "rs_1");
    CHECK_STR(enc, "a:b:c");
    free(id); free(enc);
    buf_free(&b);
}

TEST(missing_id_round_trips_as_empty_string) {
    buf_t b; buf_init(&b);
    CHECK_INT(rsig_encode(&b, NULL, "payload"), 0);
    char *id = NULL, *enc = NULL;
    CHECK_INT(rsig_decode(b.data, &id, &enc), 0);
    CHECK_STR(id, "");
    CHECK_STR(enc, "payload");
    free(id); free(enc);
    buf_free(&b);
}

TEST(encode_rejects_unsafe_id_and_empty_payload) {
    buf_t b; buf_init(&b);
    CHECK_INT(rsig_encode(&b, "rs:evil", "x"), -1);
    CHECK_INT(rsig_encode(&b, "rs 1", "x"), -1);
    CHECK_INT(rsig_encode(&b, "rs_1", ""), -1);
    CHECK_INT(rsig_encode(&b, "rs_1", NULL), -1);
    CHECK_INT(b.len, 0);
    buf_free(&b);
}

TEST(decode_rejects_foreign_signatures) {
    char *id = NULL, *enc = NULL;
    CHECK_INT(rsig_decode("", &id, &enc), -1);
    CHECK_INT(rsig_decode("EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk", &id, &enc), -1);
    CHECK_INT(rsig_decode("cx1:", &id, &enc), -1);
    CHECK_INT(rsig_decode("cx1:rs_1", &id, &enc), -1);
    CHECK_INT(rsig_decode("cx1:rs_1:", &id, &enc), -1);
    CHECK_INT(rsig_decode("cx2:rs_1:x", &id, &enc), -1);
    CHECK_INT(rsig_decode("cx1:rs 1:x", &id, &enc), -1);
    CHECK(id == NULL && enc == NULL);
}

int main(void) {
    RUN(round_trips_id_and_encrypted_content);
    RUN(encrypted_content_may_itself_contain_colons);
    RUN(missing_id_round_trips_as_empty_string);
    RUN(encode_rejects_unsafe_id_and_empty_payload);
    RUN(decode_rejects_foreign_signatures);
    TEST_MAIN_END();
}
