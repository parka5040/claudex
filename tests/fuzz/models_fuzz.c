#include "models.h"

#include <stdint.h>
#include <stddef.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    models_catalog_load((const char *)data, size);
    models_view_t view;
    models_view(&view);
    model_sel_t selection;
    model_resolve("gpt-sol", NULL, &selection);
    return 0;
}
