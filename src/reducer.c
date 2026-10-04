#include "reducer.h"

#include "buf.h"
#include "errors.h"
#include "rsig.h"

#include <stdlib.h>
#include <string.h>
#include <yyjson.h>

#define MAX_OUTPUT_ITEMS 4096

typedef enum { K_NONE = 0, K_TEXT, K_TOOL, K_THINK } kind_t;

typedef struct {
    kind_t kind;
    int    open;          /* content_block_start sent, content_block_stop not yet */
    int    closed;        /* content_block_stop sent */
    int    index;         /* Anthropic content block index */
    int    args_streamed; /* at least one input_json_delta forwarded */
} slot_t;

struct reducer {
    char           *client_model;
    reducer_emit_cb emit;
    void           *ud;
    slot_t         *slots;      /* indexed by upstream output_index */
    size_t          n_slots;
    int             next_index;
    int             started;
    int             done;
    int             saw_tool;
};

reducer_t *reducer_new(const char *client_model, reducer_emit_cb emit, void *ud) {
    reducer_t *r = calloc(1, sizeof *r);
    if (!r) return NULL;
    r->client_model = strdup(client_model);
    if (!r->client_model) { free(r); return NULL; }
    r->emit = emit;
    r->ud = ud;
    return r;
}

void reducer_free(reducer_t *r) {
    if (!r) return;
    free(r->client_model);
    free(r->slots);
    free(r);
}

int reducer_done(const reducer_t *r) { return r->done; }

/* ---- emission helpers -------------------------------------------------- */

static int emit_doc(reducer_t *r, const char *event, yyjson_mut_doc *doc) {
    size_t len = 0;
    char *json = yyjson_mut_write(doc, 0, &len);
    yyjson_mut_doc_free(doc);
    if (!json) return -1;
    int rc = r->emit(r->ud, event, json, len);
    free(json);
    return rc;
}

static yyjson_mut_doc *new_event(const char *type, yyjson_mut_val **root) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    if (!doc) return NULL;
    *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, *root);
    yyjson_mut_obj_add_str(doc, *root, "type", type);
    return doc;
}

static void add_usage(yyjson_mut_doc *doc, yyjson_mut_val *parent, long long in, long long cached, long long out) {
    yyjson_mut_val *u = yyjson_mut_obj(doc);
    long long fresh = in - cached;
    yyjson_mut_obj_add_sint(doc, u, "input_tokens", fresh > 0 ? fresh : 0);
    yyjson_mut_obj_add_sint(doc, u, "output_tokens", out);
    yyjson_mut_obj_add_sint(doc, u, "cache_creation_input_tokens", 0);
    yyjson_mut_obj_add_sint(doc, u, "cache_read_input_tokens", cached);
    yyjson_mut_obj_add_val(doc, parent, "usage", u);
}

static int ensure_started(reducer_t *r, const char *response_id) {
    if (r->started) return 0;
    r->started = 1;
    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("message_start", &root);
    if (!doc) return -1;

    buf_t id; buf_init(&id);
    if (response_id && strncmp(response_id, "resp_", 5) == 0) response_id += 5;
    if (buf_appendf(&id, "msg_%s", response_id && *response_id ? response_id : "claudex") != 0) {
        yyjson_mut_doc_free(doc);
        return -1;
    }
    yyjson_mut_val *m = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_strcpy(doc, m, "id", id.data);
    buf_free(&id);
    yyjson_mut_obj_add_str(doc, m, "type", "message");
    yyjson_mut_obj_add_str(doc, m, "role", "assistant");
    yyjson_mut_obj_add_str(doc, m, "model", r->client_model);
    yyjson_mut_obj_add_val(doc, m, "content", yyjson_mut_arr(doc));
    yyjson_mut_obj_add_null(doc, m, "stop_reason");
    yyjson_mut_obj_add_null(doc, m, "stop_sequence");
    add_usage(doc, m, 0, 0, 0);
    yyjson_mut_obj_add_val(doc, root, "message", m);
    return emit_doc(r, "message_start", doc);
}

static slot_t *slot_for(reducer_t *r, long long output_index) {
    if (output_index < 0 || output_index >= MAX_OUTPUT_ITEMS) return NULL;
    size_t need = (size_t)output_index + 1;
    if (need > r->n_slots) {
        slot_t *p = realloc(r->slots, need * sizeof *p);
        if (!p) return NULL;
        memset(p + r->n_slots, 0, (need - r->n_slots) * sizeof *p);
        r->slots = p;
        r->n_slots = need;
    }
    return &r->slots[output_index];
}

static int open_block(reducer_t *r, slot_t *s, kind_t kind, const char *tool_id, const char *tool_name) {
    int rc = ensure_started(r, NULL);
    if (rc) return rc;
    s->kind = kind;
    s->open = 1;
    s->index = r->next_index++;

    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("content_block_start", &root);
    if (!doc) return -1;
    yyjson_mut_obj_add_int(doc, root, "index", s->index);
    yyjson_mut_val *b = yyjson_mut_obj(doc);
    switch (kind) {
    case K_TEXT:
        yyjson_mut_obj_add_str(doc, b, "type", "text");
        yyjson_mut_obj_add_str(doc, b, "text", "");
        break;
    case K_TOOL:
        yyjson_mut_obj_add_str(doc, b, "type", "tool_use");
        yyjson_mut_obj_add_strcpy(doc, b, "id", tool_id);
        yyjson_mut_obj_add_strcpy(doc, b, "name", tool_name);
        yyjson_mut_obj_add_val(doc, b, "input", yyjson_mut_obj(doc));
        break;
    default:
        yyjson_mut_obj_add_str(doc, b, "type", "thinking");
        yyjson_mut_obj_add_str(doc, b, "thinking", "");
        yyjson_mut_obj_add_str(doc, b, "signature", "");
        break;
    }
    yyjson_mut_obj_add_val(doc, root, "content_block", b);
    return emit_doc(r, "content_block_start", doc);
}

static int emit_delta(reducer_t *r, const slot_t *s, const char *delta_type, const char *field, const char *value) {
    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("content_block_delta", &root);
    if (!doc) return -1;
    yyjson_mut_obj_add_int(doc, root, "index", s->index);
    yyjson_mut_val *d = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_str(doc, d, "type", delta_type);
    yyjson_mut_obj_add_strcpy(doc, d, field, value);
    yyjson_mut_obj_add_val(doc, root, "delta", d);
    return emit_doc(r, "content_block_delta", doc);
}

static int close_block(reducer_t *r, slot_t *s) {
    if (!s->open) return 0;
    s->open = 0;
    s->closed = 1;
    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("content_block_stop", &root);
    if (!doc) return -1;
    yyjson_mut_obj_add_int(doc, root, "index", s->index);
    return emit_doc(r, "content_block_stop", doc);
}

static int close_all(reducer_t *r) {
    /* Close in Anthropic index order so the client sees stops in the order of starts. */
    for (int idx = 0; idx < r->next_index; idx++)
        for (size_t i = 0; i < r->n_slots; i++)
            if (r->slots[i].open && r->slots[i].index == idx) {
                int rc = close_block(r, &r->slots[i]);
                if (rc) return rc;
            }
    return 0;
}

static int emit_error(reducer_t *r, int status, const char *message) {
    buf_t b; buf_init(&b);
    if (anthropic_error_body(&b, status, message) != 0) { buf_free(&b); return -1; }
    int rc = r->emit(r->ud, "error", b.data, b.len);
    buf_free(&b);
    return rc;
}

static int emit_ping(reducer_t *r) {
    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("ping", &root);
    return doc ? emit_doc(r, "ping", doc) : -1;
}

/* ---- upstream event handlers ------------------------------------------ */

static long long get_ll(yyjson_val *obj, const char *key) {
    yyjson_val *v = yyjson_obj_get(obj, key);
    return yyjson_is_int(v) ? yyjson_get_sint(v) : 0;
}

static int finish_message(reducer_t *r, yyjson_val *response, const char *stop_reason) {
    int rc = ensure_started(r, yyjson_get_str(yyjson_obj_get(response, "id")));
    if (!rc) rc = close_all(r);
    if (rc) return rc;
    r->done = 1;

    yyjson_val *usage = yyjson_obj_get(response, "usage");
    long long in = get_ll(usage, "input_tokens");
    long long out = get_ll(usage, "output_tokens");
    long long cached = get_ll(yyjson_obj_get(usage, "input_tokens_details"), "cached_tokens");

    yyjson_mut_val *root;
    yyjson_mut_doc *doc = new_event("message_delta", &root);
    if (!doc) return -1;
    yyjson_mut_val *d = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_str(doc, d, "stop_reason", stop_reason);
    yyjson_mut_obj_add_null(doc, d, "stop_sequence");
    yyjson_mut_obj_add_val(doc, root, "delta", d);
    add_usage(doc, root, in, cached, out);
    rc = emit_doc(r, "message_delta", doc);
    if (rc) return rc;

    doc = new_event("message_stop", &root);
    return doc ? emit_doc(r, "message_stop", doc) : -1;
}

static int on_failed(reducer_t *r, yyjson_val *response) {
    r->done = 1;
    yyjson_val *err = yyjson_obj_get(response, "error");
    const char *code = yyjson_get_str(yyjson_obj_get(err, "code"));
    if (!code) code = yyjson_get_str(yyjson_obj_get(err, "type"));
    if (!code) code = "";
    const char *msg = yyjson_get_str(yyjson_obj_get(err, "message"));
    if (!msg) msg = "upstream response failed";

    int status = 500;
    if (!strcmp(code, "context_length_exceeded")) {
        /* Claude Code keys its auto-compaction off this Anthropic phrase. */
        buf_t b; buf_init(&b);
        if (buf_appendf(&b, "prompt is too long: %s", msg) != 0) return -1;
        int rc = emit_error(r, 400, b.data);
        buf_free(&b);
        return rc;
    }
    if (!strcmp(code, "rate_limit_exceeded") || !strcmp(code, "slow_down") ||
        !strcmp(code, "usage_limit_reached") || !strcmp(code, "usage_not_included") ||
        !strcmp(code, "insufficient_quota") || !strcmp(code, "credit_balance_exhausted"))
        status = 429;
    else if (!strcmp(code, "server_is_overloaded"))
        status = 529;
    else if (!strcmp(code, "invalid_prompt") || !strcmp(code, "cyber_policy") ||
             !strcmp(code, "bio_policy") || !strcmp(code, "misalignment_policy_violation"))
        status = 400;
    return emit_error(r, status, msg);
}

static int on_text_delta(reducer_t *r, yyjson_val *ev) {
    const char *delta = yyjson_get_str(yyjson_obj_get(ev, "delta"));
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!delta || !s || s->closed) return 0;
    if (!s->open) {
        int rc = open_block(r, s, K_TEXT, NULL, NULL);
        if (rc) return rc;
    }
    return s->kind == K_TEXT ? emit_delta(r, s, "text_delta", "text", delta) : 0;
}

static int on_item_added(reducer_t *r, yyjson_val *ev) {
    yyjson_val *item = yyjson_obj_get(ev, "item");
    const char *type = yyjson_get_str(yyjson_obj_get(item, "type"));
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!type || !s || s->open || s->closed) return 0;
    if (!strcmp(type, "function_call")) {
        const char *call_id = yyjson_get_str(yyjson_obj_get(item, "call_id"));
        const char *name = yyjson_get_str(yyjson_obj_get(item, "name"));
        s->kind = K_TOOL;
        if (call_id && *call_id && name && *name) return open_block(r, s, K_TOOL, call_id, name);
    } else if (!strcmp(type, "reasoning")) {
        s->kind = K_THINK; /* opened lazily: only if there is text or a signature to carry */
    }
    return 0;
}

static int on_args_delta(reducer_t *r, yyjson_val *ev) {
    const char *delta = yyjson_get_str(yyjson_obj_get(ev, "delta"));
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!delta || !*delta || !s || !s->open || s->kind != K_TOOL) return 0;
    s->args_streamed = 1;
    return emit_delta(r, s, "input_json_delta", "partial_json", delta);
}

static int on_summary_delta(reducer_t *r, yyjson_val *ev) {
    const char *delta = yyjson_get_str(yyjson_obj_get(ev, "delta"));
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!delta || !s || s->closed || (s->open && s->kind != K_THINK)) return 0;
    if (!s->open) {
        int rc = open_block(r, s, K_THINK, NULL, NULL);
        if (rc) return rc;
    }
    return emit_delta(r, s, "thinking_delta", "thinking", delta);
}

static int on_summary_part_added(reducer_t *r, yyjson_val *ev) {
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!s || !s->open || s->kind != K_THINK) return 0;
    return emit_delta(r, s, "thinking_delta", "thinking", "\n\n");
}

static int done_function_call(reducer_t *r, slot_t *s, yyjson_val *item) {
    const char *call_id = yyjson_get_str(yyjson_obj_get(item, "call_id"));
    const char *name = yyjson_get_str(yyjson_obj_get(item, "name"));
    const char *args = yyjson_get_str(yyjson_obj_get(item, "arguments"));
    if (!s->open) {
        if (!call_id || !*call_id || !name || !*name) return 0;
        int rc = open_block(r, s, K_TOOL, call_id, name);
        if (rc) return rc;
    }
    r->saw_tool = 1;
    if (!s->args_streamed) {
        int rc = emit_delta(r, s, "input_json_delta", "partial_json", args && *args ? args : "{}");
        if (rc) return rc;
    }
    return close_block(r, s);
}

static int done_reasoning(reducer_t *r, slot_t *s, yyjson_val *item) {
    const char *enc = yyjson_get_str(yyjson_obj_get(item, "encrypted_content"));
    int have_sig = enc && *enc;
    int rc;

    if (!s->open) {
        /* No summary was streamed: take it from the finished item, if any. */
        buf_t text; buf_init(&text);
        yyjson_val *part;
        yyjson_arr_iter it = yyjson_arr_iter_with(yyjson_obj_get(item, "summary"));
        while ((part = yyjson_arr_iter_next(&it))) {
            const char *t = yyjson_get_str(yyjson_obj_get(part, "text"));
            if (!t || !*t) continue;
            if (text.len) buf_append_str(&text, "\n\n");
            buf_append_str(&text, t);
        }
        if (!have_sig && !text.len) { buf_free(&text); return 0; }
        rc = open_block(r, s, K_THINK, NULL, NULL);
        if (!rc && text.len) rc = emit_delta(r, s, "thinking_delta", "thinking", text.data);
        buf_free(&text);
        if (rc) return rc;
    }
    if (have_sig) {
        buf_t sig; buf_init(&sig);
        if (rsig_encode(&sig, yyjson_get_str(yyjson_obj_get(item, "id")), enc) != 0 &&
            rsig_encode(&sig, NULL, enc) != 0) {
            buf_free(&sig);
            return -1;
        }
        rc = emit_delta(r, s, "signature_delta", "signature", sig.data);
        buf_free(&sig);
        if (rc) return rc;
    }
    return close_block(r, s);
}

static int done_message(reducer_t *r, slot_t *s, yyjson_val *item) {
    if (!s->open && !s->closed) {
        /* Text was not streamed: emit whatever the finished item carries. */
        yyjson_val *part;
        yyjson_arr_iter it = yyjson_arr_iter_with(yyjson_obj_get(item, "content"));
        while ((part = yyjson_arr_iter_next(&it))) {
            const char *t = yyjson_get_str(yyjson_obj_get(part, "text"));
            if (!t || !*t) continue;
            int rc = s->open ? 0 : open_block(r, s, K_TEXT, NULL, NULL);
            if (!rc) rc = emit_delta(r, s, "text_delta", "text", t);
            if (rc) return rc;
        }
    }
    return close_block(r, s);
}

static int on_item_done(reducer_t *r, yyjson_val *ev) {
    yyjson_val *item = yyjson_obj_get(ev, "item");
    const char *type = yyjson_get_str(yyjson_obj_get(item, "type"));
    slot_t *s = slot_for(r, get_ll(ev, "output_index"));
    if (!type || !s || s->closed) return 0;
    if (!strcmp(type, "function_call")) return done_function_call(r, s, item);
    if (!strcmp(type, "reasoning"))     return done_reasoning(r, s, item);
    if (!strcmp(type, "message"))       return done_message(r, s, item);
    return 0;
}

int reducer_on_event(reducer_t *r, const char *json, size_t len) {
    if (r->done) return 0;
    yyjson_doc *doc = yyjson_read(json, len, 0);
    if (!doc) return 0;
    yyjson_val *ev = yyjson_doc_get_root(doc);
    const char *type = yyjson_get_str(yyjson_obj_get(ev, "type"));
    int rc = 0;
    if (!type) {
        /* ignore */
    } else if (!strcmp(type, "response.created")) {
        rc = ensure_started(r, yyjson_get_str(yyjson_obj_get(yyjson_obj_get(ev, "response"), "id")));
    } else if (!strcmp(type, "response.output_text.delta")) {
        rc = on_text_delta(r, ev);
    } else if (!strcmp(type, "response.output_item.added")) {
        rc = on_item_added(r, ev);
    } else if (!strcmp(type, "response.output_item.done")) {
        rc = on_item_done(r, ev);
    } else if (!strcmp(type, "response.function_call_arguments.delta")) {
        rc = on_args_delta(r, ev);
    } else if (!strcmp(type, "response.reasoning_summary_text.delta")) {
        rc = on_summary_delta(r, ev);
    } else if (!strcmp(type, "response.reasoning_summary_part.added")) {
        rc = on_summary_part_added(r, ev);
    } else if (!strcmp(type, "response.completed")) {
        rc = finish_message(r, yyjson_obj_get(ev, "response"), r->saw_tool ? "tool_use" : "end_turn");
    } else if (!strcmp(type, "response.incomplete")) {
        yyjson_val *resp = yyjson_obj_get(ev, "response");
        const char *reason = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(resp, "incomplete_details"), "reason"));
        const char *stop = "end_turn";
        if (reason && !strcmp(reason, "max_output_tokens")) stop = "max_tokens";
        else if (reason && !strcmp(reason, "content_filter")) stop = "refusal";
        rc = finish_message(r, resp, stop);
    } else if (!strcmp(type, "response.failed")) {
        rc = on_failed(r, yyjson_obj_get(ev, "response"));
    } else if (!strcmp(type, "keepalive") || !strcmp(type, "codex.rate_limits")) {
        rc = emit_ping(r);
    }
    yyjson_doc_free(doc);
    return rc;
}

int reducer_finish(reducer_t *r) {
    if (r->done) return 0;
    r->done = 1;
    return emit_error(r, 500, "upstream stream closed before response.completed");
}
