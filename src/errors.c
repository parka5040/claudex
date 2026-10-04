#include "errors.h"

#include <stdlib.h>
#include <yyjson.h>

const char *anthropic_error_type(int status) {
    switch (status) {
    case 401: return "authentication_error";
    case 403: return "permission_error";
    case 404: return "not_found_error";
    case 413: return "request_too_large";
    case 429: return "rate_limit_error";
    case 503:
    case 529: return "overloaded_error";
    default:  return status >= 500 ? "api_error" : "invalid_request_error";
    }
}

int anthropic_error_body(buf_t *out, int status, const char *message) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc) return -1;
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_val *err = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_str(doc, root, "type", "error");
    yyjson_mut_obj_add_str(doc, err, "type", anthropic_error_type(status));
    yyjson_mut_obj_add_str(doc, err, "message", message);
    yyjson_mut_obj_add_val(doc, root, "error", err);

    size_t len = 0;
    char *json = yyjson_mut_write(doc, 0, &len);
    yyjson_mut_doc_free(doc);
    if (!json) return -1;
    int rc = buf_append(out, json, len);
    free(json);
    return rc;
}
