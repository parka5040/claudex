#include "test.h"
#include "schema.h"
#include "buf.h"

#include <stdlib.h>

/* Sanitizes `in` and compares against `want` structurally (key order ignored). */
static void check_sanitized(const char *file, int line, const char *in, const char *want, int root) {
    yyjson_doc *src = yyjson_read(in, strlen(in), 0);
    yyjson_doc *exp = yyjson_read(want, strlen(want), 0);
    yyjson_mut_doc *out = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *got = root ? schema_sanitize_root(out, yyjson_doc_get_root(src))
                               : schema_sanitize(out, yyjson_doc_get_root(src));
    yyjson_mut_doc_set_root(out, got);
    yyjson_doc *got_im = yyjson_mut_doc_imut_copy(out, NULL);
    t_checks++;
    if (!src || !exp || !got_im || !yyjson_equals(yyjson_doc_get_root(got_im), yyjson_doc_get_root(exp))) {
        t_failures++;
        char *s = got_im ? yyjson_write(got_im, 0, NULL) : NULL;
        fprintf(stderr, "    FAIL %s:%d:\n      got  %s\n      want %s\n", file, line, s ? s : "(null)", want);
        free(s);
    }
    yyjson_doc_free(src); yyjson_doc_free(exp); yyjson_doc_free(got_im); yyjson_mut_doc_free(out);
}
#define SANITIZES(in, want)      check_sanitized(__FILE__, __LINE__, in, want, 0)
#define SANITIZES_ROOT(in, want) check_sanitized(__FILE__, __LINE__, in, want, 1)

TEST(keeps_the_supported_subset_untouched) {
    const char *s = "{\"type\":\"object\",\"description\":\"d\",\"properties\":{\"a\":{\"type\":\"string\",\"enum\":[\"x\",\"y\"]},"
                    "\"b\":{\"type\":\"array\",\"items\":{\"type\":\"integer\"},\"minItems\":1}},"
                    "\"required\":[\"a\"],\"additionalProperties\":false}";
    SANITIZES(s, s);
}

TEST(drops_keywords_the_backend_may_reject) {
    SANITIZES("{\"type\":\"string\",\"pattern\":\"^(?<x>a)$\",\"format\":\"uri\",\"minLength\":1,\"maxLength\":9,"
              "\"default\":\"q\",\"title\":\"T\",\"examples\":[\"e\"],\"$schema\":\"http://json-schema.org/draft-07/schema#\"}",
              "{\"type\":\"string\"}");
    SANITIZES("{\"type\":\"number\",\"minimum\":0,\"maximum\":5,\"exclusiveMinimum\":0,\"multipleOf\":2}",
              "{\"type\":\"number\"}");
}

TEST(sanitizes_nested_properties_items_and_additional_properties) {
    SANITIZES("{\"type\":\"object\",\"properties\":{\"p\":{\"type\":\"array\",\"items\":{\"type\":\"string\",\"pattern\":\"x\"}}},"
              "\"additionalProperties\":{\"type\":\"string\",\"format\":\"date\"}}",
              "{\"type\":\"object\",\"properties\":{\"p\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},"
              "\"additionalProperties\":{\"type\":\"string\"}}");
}

TEST(property_literally_named_pattern_is_kept) {
    SANITIZES("{\"type\":\"object\",\"properties\":{\"pattern\":{\"type\":\"string\",\"pattern\":\".*\"},\"format\":{\"type\":\"string\"}}}",
              "{\"type\":\"object\",\"properties\":{\"pattern\":{\"type\":\"string\"},\"format\":{\"type\":\"string\"}}}");
}

TEST(const_becomes_single_value_enum) {
    SANITIZES("{\"const\":\"fixed\"}", "{\"type\":\"string\",\"enum\":[\"fixed\"]}");
}

TEST(boolean_schema_becomes_string) {
    SANITIZES("true", "{\"type\":\"string\"}");
    SANITIZES("{\"type\":\"object\",\"properties\":{\"x\":true}}",
              "{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"string\"}}}");
}

TEST(infers_missing_type) {
    SANITIZES("{\"properties\":{\"a\":{\"type\":\"string\"}}}", "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}");
    SANITIZES("{\"items\":{\"type\":\"string\"}}", "{\"type\":\"array\",\"items\":{\"type\":\"string\"}}");
    SANITIZES("{\"enum\":[\"a\",\"b\"]}", "{\"type\":\"string\",\"enum\":[\"a\",\"b\"]}");
    SANITIZES("{\"minimum\":1}", "{\"type\":\"number\"}");
    SANITIZES("{\"description\":\"anything\"}", "{\"description\":\"anything\"}");
}

TEST(does_not_infer_type_next_to_ref_or_composition) {
    SANITIZES("{\"$ref\":\"#/$defs/T\"}", "{\"$ref\":\"#/$defs/T\"}");
    SANITIZES("{\"anyOf\":[{\"type\":\"string\",\"format\":\"x\"},{\"type\":\"null\"}]}",
              "{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"null\"}]}");
}

TEST(fills_in_empty_properties_and_default_items) {
    SANITIZES("{\"type\":\"object\"}", "{\"type\":\"object\",\"properties\":{}}");
    SANITIZES("{\"type\":\"array\"}", "{\"type\":\"array\",\"items\":{\"type\":\"string\"}}");
}

TEST(keeps_type_arrays_and_definitions) {
    SANITIZES("{\"type\":[\"string\",\"null\"]}", "{\"type\":[\"string\",\"null\"]}");
    SANITIZES("{\"type\":\"object\",\"properties\":{\"n\":{\"$ref\":\"#/$defs/N\"}},\"$defs\":{\"N\":{\"type\":\"integer\",\"minimum\":0}}}",
              "{\"type\":\"object\",\"properties\":{\"n\":{\"$ref\":\"#/$defs/N\"}},\"$defs\":{\"N\":{\"type\":\"integer\"}}}");
}

TEST(malformed_keyword_values_are_dropped) {
    SANITIZES("{\"type\":\"object\",\"properties\":\"oops\",\"required\":\"a\",\"enum\":5}",
              "{\"type\":\"object\",\"properties\":{}}");
    SANITIZES("{\"type\":\"object\",\"properties\":{},\"required\":[\"a\",7]}",
              "{\"type\":\"object\",\"properties\":{},\"required\":[\"a\"]}");
}

TEST(root_is_always_an_object_schema) {
    SANITIZES_ROOT("null", "{\"type\":\"object\",\"properties\":{}}");
    SANITIZES_ROOT("{\"type\":\"string\"}", "{\"type\":\"object\",\"properties\":{}}");
    SANITIZES_ROOT("{}", "{\"type\":\"object\",\"properties\":{}}");
    SANITIZES_ROOT("{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\",\"format\":\"x\"}},\"$schema\":\"s\"}",
                   "{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}");
}

TEST(pathologically_deep_schema_is_cut_off_not_crashed) {
    buf_t b; buf_init(&b);
    int depth = 5000;
    for (int i = 0; i < depth; i++) buf_append_str(&b, "{\"type\":\"array\",\"items\":");
    buf_append_str(&b, "{\"type\":\"string\"}");
    for (int i = 0; i < depth; i++) buf_append_str(&b, "}");
    yyjson_doc *src = yyjson_read(b.data, b.len, 0);
    CHECK(src != NULL);
    yyjson_mut_doc *out = yyjson_mut_doc_new(NULL);
    CHECK(schema_sanitize(out, yyjson_doc_get_root(src)) != NULL);
    yyjson_mut_doc_free(out); yyjson_doc_free(src); buf_free(&b);
}

int main(void) {
    RUN(keeps_the_supported_subset_untouched);
    RUN(drops_keywords_the_backend_may_reject);
    RUN(sanitizes_nested_properties_items_and_additional_properties);
    RUN(property_literally_named_pattern_is_kept);
    RUN(const_becomes_single_value_enum);
    RUN(boolean_schema_becomes_string);
    RUN(infers_missing_type);
    RUN(does_not_infer_type_next_to_ref_or_composition);
    RUN(fills_in_empty_properties_and_default_items);
    RUN(keeps_type_arrays_and_definitions);
    RUN(malformed_keyword_values_are_dropped);
    RUN(root_is_always_an_object_schema);
    RUN(pathologically_deep_schema_is_cut_off_not_crashed);
    TEST_MAIN_END();
}
