#include <stddef.h>
#include <stdint.h>
#include "http.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    http_req_t r;
    http_parse_head((const char *)data, size, &r);
    return 0;
}
