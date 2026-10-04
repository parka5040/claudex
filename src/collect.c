#include "collect.h"

#include "errors.h"

#include <stdlib.h>
#include <string.h>
#include <yyjson.h>

#define MAX_BLOCKS 4096

typedef enum { B_TEXT, B_TOOL, B_THINK } btype_t;

typedef struct {
    int     used;
    btype_t type;
    buf_t   text;       /* text, thinking text, or accumulated partial_json */
    char   *id;         /* tool_use id */
    char   *name;       /* tool_use name */
    buf_t   signature;  /* thinking signature */
} block_t;

struct collector {
    char     *msg_id;
    char     *model;
    char     *stop_reason;
    block_t  *blocks;
    size_t    n_blocks;
    long long in_tokens, out_tokens, cache_read, cache_create;
    int       complete;     /* message_stop seen */
    int       err_status;   /* nonzero once an error event arrived */
    buf_t     err_body;
};

collector_t *collector_new(void) {
    collector_t *c = calloc(1, sizeof *c);
    if (c) buf_init(&c->err_body);
    return c;
}

void collector_free(collector_t *c) {
    if (!c) return;
    for (size_t i = 0; i < c->n_blocks; i++) {
        buf_free(&c->blocks[i].text);
        buf_free(&c->blocks[i].signature);
        free(c->blocks[i].id);
        free(c->blocks[i].name);
    }
    free(c->blocks);
    free(c->msg_id);
    free(c->model);
    free(c->stop_reason);
    buf_free(&c->err_body);
    free(c);
}

static void set_str(char **dst, const char *s) {
    if (!s) return;
    char *dup = strdup(s);
    if (!dup) return;
    free(*dst);
    *dst = dup;
}

static block_t *block_at(collector_t *c, yyjson_val *ev) {
    yyjson_val *iv = yyjson_obj_get(ev, "index");
    if (!yyjson_is_int(iv)) return NULL;
    long long idx = yyjson_get_sint(iv);
    if (idx < 0 || idx >= MAX_BLOCKS) return NULL;
    size_t need = (size_t)idx + 1;
    if (need > c->n_blocks) {
        block_t *p = realloc(c->blocks, need * sizeof *p);
        if (!p) return NULL;
        memset(p + c->n_blocks, 0, (need - c->n_blocks) * sizeof *p);
        c->blocks = p;
        c->n_blocks = need;
    }
    return &c->blocks[idx];
}

static int status_for_error_type(const char *type) {
    if (!type) return 502;
    if (!strcmp(type, "invalid_request_error")) return 400;
    if (!strcmp(type, "authentication_error")) return 401;
    if (!strcmp(type, "permission_error")) return 403;
    if (!strcmp(type, "not_found_error")) return 404;
    if (!strcmp(type, "request_too_large")) return 413;
    if (!strcmp(type, "rate_limit_error")) return 429;
    if (!strcmp(type, "overloaded_error")) return 529;
    return 502;
}

static long long get_ll(yyjson_val *obj, const char *key, long long fallback) {
    yyjson_val *v = yyjson_obj_get(obj, key);
    return yyjson_is_int(v) ? yyjson_get_sint(v) : fallback;
}

int collect_on_event(void *ud, const char *event, const char *json, size_t len) {
    collector_t *c = ud;
    yyjson_doc *doc = yyjson_read(json, len, 0);
    if (!doc) return 0;
    yyjson_val *ev = yyjson_doc_get_root(doc);

    if (!strcmp(event, "message_start")) {
        yyjson_val *m = yyjson_obj_get(ev, "message");
        set_str(&c->msg_id, yyjson_get_str(yyjson_obj_get(m, "id")));
        set_str(&c->model, yyjson_get_str(yyjson_obj_get(m, "model")));
    } else if (!strcmp(event, "content_block_start")) {
        block_t *b = block_at(c, ev);
        yyjson_val *cb = yyjson_obj_get(ev, "content_block");
        const char *type = yyjson_get_str(yyjson_obj_get(cb, "type"));
        if (b && type) {
            b->used = 1;
            b->type = !strcmp(type, "tool_use") ? B_TOOL : !strcmp(type, "thinking") ? B_THINK : B_TEXT;
            set_str(&b->id, yyjson_get_str(yyjson_obj_get(cb, "id")));
            set_str(&b->name, yyjson_get_str(yyjson_obj_get(cb, "name")));
        }
    } else if (!strcmp(event, "content_block_delta")) {
        block_t *b = block_at(c, ev);
        yyjson_val *d = yyjson_obj_get(ev, "delta");
        const char *s;
        if (b && b->used) {
            if ((s = yyjson_get_str(yyjson_obj_get(d, "text")))) buf_append_str(&b->text, s);
            else if ((s = yyjson_get_str(yyjson_obj_get(d, "thinking")))) buf_append_str(&b->text, s);
            else if ((s = yyjson_get_str(yyjson_obj_get(d, "partial_json")))) buf_append_str(&b->text, s);
            else if ((s = yyjson_get_str(yyjson_obj_get(d, "signature")))) buf_append_str(&b->signature, s);
        }
    } else if (!strcmp(event, "message_delta")) {
        set_str(&c->stop_reason, yyjson_get_str(yyjson_obj_get(yyjson_obj_get(ev, "delta"), "stop_reason")));
        yyjson_val *u = yyjson_obj_get(ev, "usage");
        c->in_tokens = get_ll(u, "input_tokens", c->in_tokens);
        c->out_tokens = get_ll(u, "output_tokens", c->out_tokens);
        c->cache_read = get_ll(u, "cache_read_input_tokens", c->cache_read);
        c->cache_create = get_ll(u, "cache_creation_input_tokens", c->cache_create);
    } else if (!strcmp(event, "message_stop")) {
        c->complete = 1;
    } else if (!strcmp(event, "error") && !c->err_status) {
        c->err_status = status_for_error_type(yyjson_get_str(yyjson_obj_get(yyjson_obj_get(ev, "error"), "type")));
        buf_append(&c->err_body, json, len);
    }
    yyjson_doc_free(doc);
    return 0;
}

int collector_result(collector_t *c, buf_t *out) {
    if (c->err_status)
        return buf_append(out, c->err_body.data, c->err_body.len) == 0 ? c->err_status : -1;
    if (!c->complete)
        return anthropic_error_body(out, 502, "upstream stream ended before the message completed") == 0 ? 502 : -1;

    yyjson_mut_doc *d = yyjson_mut_doc_new(NULL);
    if (!d) return -1;
    yyjson_mut_val *m = yyjson_mut_obj(d);
    yyjson_mut_doc_set_root(d, m);
    yyjson_mut_obj_add_str(d, m, "id", c->msg_id ? c->msg_id : "msg_claudex");
    yyjson_mut_obj_add_str(d, m, "type", "message");
    yyjson_mut_obj_add_str(d, m, "role", "assistant");
    yyjson_mut_obj_add_str(d, m, "model", c->model ? c->model : "");

    yyjson_mut_val *content = yyjson_mut_arr(d);
    for (size_t i = 0; i < c->n_blocks; i++) {
        block_t *b = &c->blocks[i];
        if (!b->used) continue;
        yyjson_mut_val *o = yyjson_mut_obj(d);
        const char *text = b->text.data ? b->text.data : "";
        if (b->type == B_TEXT) {
            yyjson_mut_obj_add_str(d, o, "type", "text");
            yyjson_mut_obj_add_str(d, o, "text", text);
        } else if (b->type == B_THINK) {
            yyjson_mut_obj_add_str(d, o, "type", "thinking");
            yyjson_mut_obj_add_str(d, o, "thinking", text);
            yyjson_mut_obj_add_str(d, o, "signature", b->signature.data ? b->signature.data : "");
        } else {
            yyjson_mut_obj_add_str(d, o, "type", "tool_use");
            yyjson_mut_obj_add_str(d, o, "id", b->id ? b->id : "");
            yyjson_mut_obj_add_str(d, o, "name", b->name ? b->name : "");
            yyjson_doc *args = b->text.len ? yyjson_read(b->text.data, b->text.len, 0) : NULL;
            yyjson_val *root = args ? yyjson_doc_get_root(args) : NULL;
            yyjson_mut_obj_add_val(d, o, "input", yyjson_is_obj(root) ? yyjson_val_mut_copy(d, root) : yyjson_mut_obj(d));
            yyjson_doc_free(args);
        }
        yyjson_mut_arr_append(content, o);
    }
    yyjson_mut_obj_add_val(d, m, "content", content);
    yyjson_mut_obj_add_str(d, m, "stop_reason", c->stop_reason ? c->stop_reason : "end_turn");
    yyjson_mut_obj_add_null(d, m, "stop_sequence");

    yyjson_mut_val *u = yyjson_mut_obj(d);
    yyjson_mut_obj_add_sint(d, u, "input_tokens", c->in_tokens);
    yyjson_mut_obj_add_sint(d, u, "output_tokens", c->out_tokens);
    yyjson_mut_obj_add_sint(d, u, "cache_creation_input_tokens", c->cache_create);
    yyjson_mut_obj_add_sint(d, u, "cache_read_input_tokens", c->cache_read);
    yyjson_mut_obj_add_val(d, m, "usage", u);

    size_t len = 0;
    char *json = yyjson_mut_write(d, 0, &len);
    yyjson_mut_doc_free(d);
    if (!json) return -1;
    int rc = buf_append(out, json, len);
    free(json);
    return rc == 0 ? 200 : -1;
}
