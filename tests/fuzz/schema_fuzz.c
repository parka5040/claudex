#include <stddef.h>
#include <stdint.h>
#include "schema.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    yyjson_doc *src = yyjson_read((const char *)data, size, 0);
    if (!src) return 0;
    yyjson_mut_doc *out = yyjson_mut_doc_new(NULL);
    schema_sanitize(out, yyjson_doc_get_root(src));
    schema_sanitize_root(out, yyjson_doc_get_root(src));
    yyjson_mut_doc_free(out);
    yyjson_doc_free(src);
    return 0;
}
