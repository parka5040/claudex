#include <stddef.h>
#include <stdint.h>
#include "translate_req.h"

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    xlate_req_t x; char err[256];
    if (translate_request((const char *)data, size, &x, err, sizeof err) == 0) xlate_req_free(&x);
    return 0;
}
