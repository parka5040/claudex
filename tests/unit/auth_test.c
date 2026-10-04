#include "test.h"
#include "auth.h"
#include "buf.h"

#include <stdlib.h>
#include <unistd.h>

/* Test-only base64url encoder to fabricate JWTs. No real credential is ever used here. */
static void b64url(buf_t *out, const char *s) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t n = strlen(s);
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = (unsigned)(unsigned char)s[i] << 16;
        if (i + 1 < n) v |= (unsigned)(unsigned char)s[i + 1] << 8;
        if (i + 2 < n) v |= (unsigned char)s[i + 2];
        char q[4] = { T[v >> 18 & 63], T[v >> 12 & 63], T[v >> 6 & 63], T[v & 63] };
        buf_append(out, q, i + 2 < n ? 4 : i + 1 < n ? 3 : 2);
    }
}

static char *make_jwt(const char *payload_json) {
    buf_t b; buf_init(&b);
    b64url(&b, "{\"alg\":\"none\"}");
    buf_append_str(&b, ".");
    b64url(&b, payload_json);
    buf_append_str(&b, ".c2ln");
    return b.data;
}

static char tmp_path[64];
static const char *write_tmp(const char *content) {
    strcpy(tmp_path, "/tmp/claudex-auth-test-XXXXXX");
    int fd = mkstemp(tmp_path);
    if (fd < 0) { perror("mkstemp"); exit(2); }
    if (write(fd, content, strlen(content)) < 0) { perror("write"); exit(2); }
    close(fd);
    return tmp_path;
}

TEST(jwt_exp_reads_exp_claim) {
    char *jwt = make_jwt("{\"sub\":\"u\",\"exp\":1790000000,\"iat\":1}");
    CHECK_INT(jwt_exp(jwt), 1790000000LL);
    free(jwt);
}

TEST(jwt_exp_handles_every_base64_padding_length) {
    /* payload lengths chosen so len % 3 covers 0, 1, 2 */
    char *a = make_jwt("{\"exp\":10}");   CHECK_INT(jwt_exp(a), 10);   free(a);
    char *b = make_jwt("{\"exp\":100}");  CHECK_INT(jwt_exp(b), 100);  free(b);
    char *c = make_jwt("{\"exp\":1000}"); CHECK_INT(jwt_exp(c), 1000); free(c);
}

TEST(jwt_exp_returns_minus_one_for_garbage) {
    CHECK_INT(jwt_exp(""), -1);
    CHECK_INT(jwt_exp("not-a-jwt"), -1);
    CHECK_INT(jwt_exp("a.b"), -1);
    CHECK_INT(jwt_exp("a.!!!!.c"), -1);
    char *no_exp = make_jwt("{\"sub\":\"u\"}");
    CHECK_INT(jwt_exp(no_exp), -1);
    free(no_exp);
    char *str_exp = make_jwt("{\"exp\":\"soon\"}");
    CHECK_INT(jwt_exp(str_exp), -1);
    free(str_exp);
}

TEST(loads_chatgpt_login) {
    char *jwt = make_jwt("{\"exp\":1790000000}");
    buf_t f; buf_init(&f);
    buf_appendf(&f, "{\"auth_mode\":\"chatgpt\",\"OPENAI_API_KEY\":null,"
                    "\"tokens\":{\"id_token\":\"x\",\"access_token\":\"%s\",\"refresh_token\":\"r\","
                    "\"account_id\":\"acct-123\"},\"last_refresh\":\"2026-09-10T00:00:00Z\"}", jwt);
    auth_t a = {0};
    CHECK_INT(auth_load(write_tmp(f.data), &a), AUTH_OK);
    CHECK_STR(a.access_token, jwt);
    CHECK_STR(a.account_id, "acct-123");
    CHECK_INT(a.exp, 1790000000LL);
    auth_free(&a);
    CHECK(a.access_token == NULL);
    unlink(tmp_path);
    buf_free(&f);
    free(jwt);
}

TEST(opaque_access_token_loads_with_unknown_expiry) {
    auth_t a = {0};
    const char *p = write_tmp("{\"tokens\":{\"access_token\":\"opaque\",\"account_id\":\"acct\"}}");
    CHECK_INT(auth_load(p, &a), AUTH_OK);
    CHECK_INT(a.exp, -1);
    auth_free(&a);
    unlink(tmp_path);
}

TEST(missing_file_is_io_error) {
    auth_t a = {0};
    CHECK_INT(auth_load("/nonexistent/claudex/auth.json", &a), AUTH_E_IO);
    auth_free(&a);
}

TEST(invalid_json_is_parse_error) {
    auth_t a = {0};
    CHECK_INT(auth_load(write_tmp("{\"tokens\": "), &a), AUTH_E_PARSE);
    auth_free(&a);
    unlink(tmp_path);
}

TEST(api_key_mode_or_missing_fields_is_no_login) {
    auth_t a = {0};
    CHECK_INT(auth_load(write_tmp("{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"sk-x\",\"tokens\":null}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    CHECK_INT(auth_load(write_tmp("{\"tokens\":{\"access_token\":\"t\"}}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    CHECK_INT(auth_load(write_tmp("{\"tokens\":{\"access_token\":\"\",\"account_id\":\"a\"}}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    CHECK_INT(auth_load(write_tmp("{\"tokens\":{\"access_token\":5,\"account_id\":\"a\"}}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    CHECK_INT(auth_load(write_tmp("[]"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    auth_free(&a);
}

TEST(token_with_header_breaking_characters_is_rejected) {
    auth_t a = {0};
    CHECK_INT(auth_load(write_tmp("{\"tokens\":{\"access_token\":\"abc\\r\\nX-Evil: 1\",\"account_id\":\"a\"}}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    CHECK_INT(auth_load(write_tmp("{\"tokens\":{\"access_token\":\"ok\",\"account_id\":\"a\\nb\"}}"), &a), AUTH_E_NO_LOGIN);
    unlink(tmp_path);
    auth_free(&a);
}

int main(void) {
    RUN(jwt_exp_reads_exp_claim);
    RUN(jwt_exp_handles_every_base64_padding_length);
    RUN(jwt_exp_returns_minus_one_for_garbage);
    RUN(loads_chatgpt_login);
    RUN(opaque_access_token_loads_with_unknown_expiry);
    RUN(missing_file_is_io_error);
    RUN(invalid_json_is_parse_error);
    RUN(api_key_mode_or_missing_fields_is_no_login);
    RUN(token_with_header_breaking_characters_is_rejected);
    TEST_MAIN_END();
}
