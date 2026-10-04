#include "translate_req.h"

#include "buf.h"
#include "rsig.h"
#include "schema.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <yyjson.h>

#define TOOL_NAME_MAX 128
#define BILLING_PREFIX "x-anthropic-billing-header:"

typedef yyjson_mut_doc mdoc;
typedef yyjson_mut_val mval;

static int fail(char *err, size_t errlen, int status, const char *fmt, ...) __attribute__((format(printf, 4, 5)));
static int fail(char *err, size_t errlen, int status, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, errlen, fmt, ap);
    va_end(ap);
    return -status;
}

void xlate_req_free(xlate_req_t *x) {
    free(x->body);
    free(x->client_model);
    x->body = NULL;
    x->client_model = NULL;
    x->body_len = 0;
}

/* ---- small builders ---------------------------------------------------- */

static mval *text_part(mdoc *d, const char *type, const char *text) {
    mval *p = yyjson_mut_obj(d);
    yyjson_mut_obj_add_str(d, p, "type", type);
    yyjson_mut_obj_add_strcpy(d, p, "text", text);
    return p;
}

/* Anthropic image block -> input_image part, or a text placeholder if unusable. */
static mval *image_part(mdoc *d, yyjson_val *block) {
    yyjson_val *src = yyjson_obj_get(block, "source");
    const char *stype = yyjson_get_str(yyjson_obj_get(src, "type"));
    mval *p = yyjson_mut_obj(d);
    if (stype && !strcmp(stype, "base64")) {
        const char *mime = yyjson_get_str(yyjson_obj_get(src, "media_type"));
        const char *data = yyjson_get_str(yyjson_obj_get(src, "data"));
        if (mime && data) {
            buf_t url; buf_init(&url);
            if (buf_appendf(&url, "data:%s;base64,%s", mime, data) == 0) {
                yyjson_mut_obj_add_str(d, p, "type", "input_image");
                yyjson_mut_obj_add_strcpy(d, p, "image_url", url.data);
                buf_free(&url);
                return p;
            }
            buf_free(&url);
        }
    } else if (stype && !strcmp(stype, "url")) {
        const char *url = yyjson_get_str(yyjson_obj_get(src, "url"));
        if (url) {
            yyjson_mut_obj_add_str(d, p, "type", "input_image");
            yyjson_mut_obj_add_strcpy(d, p, "image_url", url);
            return p;
        }
    }
    return text_part(d, "input_text", "[image omitted: unsupported source]");
}

static mval *unsupported_part(mdoc *d, const char *part_type, const char *block_type) {
    buf_t b; buf_init(&b);
    buf_appendf(&b, "[unsupported content block omitted: %s]", block_type ? block_type : "unknown");
    mval *p = text_part(d, part_type, b.data ? b.data : "");
    buf_free(&b);
    return p;
}

static void push_message(mdoc *d, mval *input, const char *role, mval *parts) {
    if (yyjson_mut_arr_size(parts) == 0) return;
    mval *m = yyjson_mut_obj(d);
    yyjson_mut_obj_add_str(d, m, "type", "message");
    yyjson_mut_obj_add_str(d, m, "role", role);
    yyjson_mut_obj_add_val(d, m, "content", parts);
    yyjson_mut_arr_append(input, m);
}

static void push_output(mdoc *d, mval *input, const char *call_id, mval *output) {
    mval *o = yyjson_mut_obj(d);
    yyjson_mut_obj_add_str(d, o, "type", "function_call_output");
    yyjson_mut_obj_add_strcpy(d, o, "call_id", call_id);
    yyjson_mut_obj_add_val(d, o, "output", output);
    yyjson_mut_arr_append(input, o);
}

/* ---- tool_result -> function_call_output ------------------------------- */

static void push_tool_result(mdoc *d, mval *input, yyjson_val *block) {
    const char *call_id = yyjson_get_str(yyjson_obj_get(block, "tool_use_id"));
    if (!call_id) return;
    yyjson_val *content = yyjson_obj_get(block, "content");
    int is_error = yyjson_is_true(yyjson_obj_get(block, "is_error"));

    buf_t text; buf_init(&text);
    if (is_error) buf_append_str(&text, "[tool execution error]\n");
    size_t prefix_len = text.len;
    int has_image = 0;

    if (yyjson_is_str(content)) {
        buf_append_str(&text, yyjson_get_str(content));
    } else if (yyjson_is_arr(content)) {
        yyjson_val *part;
        yyjson_arr_iter it = yyjson_arr_iter_with(content);
        while ((part = yyjson_arr_iter_next(&it))) {
            const char *pt = yyjson_get_str(yyjson_obj_get(part, "type"));
            if (pt && !strcmp(pt, "image")) { has_image = 1; continue; }
            const char *t = (pt && !strcmp(pt, "text")) ? yyjson_get_str(yyjson_obj_get(part, "text")) : NULL;
            if (text.len > prefix_len) buf_append_str(&text, "\n");
            if (t) buf_append_str(&text, t);
            else buf_appendf(&text, "[unsupported content block omitted: %s]", pt ? pt : "unknown");
        }
    }

    if (!has_image) {
        push_output(d, input, call_id, yyjson_mut_strcpy(d, text.data ? text.data : ""));
    } else {
        mval *arr = yyjson_mut_arr(d);
        if (text.len) yyjson_mut_arr_append(arr, text_part(d, "input_text", text.data));
        yyjson_val *part;
        yyjson_arr_iter it = yyjson_arr_iter_with(content);
        while ((part = yyjson_arr_iter_next(&it))) {
            const char *pt = yyjson_get_str(yyjson_obj_get(part, "type"));
            if (pt && !strcmp(pt, "image")) yyjson_mut_arr_append(arr, image_part(d, part));
        }
        push_output(d, input, call_id, arr);
    }
    buf_free(&text);
}

/* ---- messages ---------------------------------------------------------- */

static void push_user_message(mdoc *d, mval *input, const char *role, yyjson_val *content) {
    mval *parts = yyjson_mut_arr(d);
    if (yyjson_is_str(content)) {
        if (*yyjson_get_str(content)) yyjson_mut_arr_append(parts, text_part(d, "input_text", yyjson_get_str(content)));
    } else {
        /* Tool outputs first so each stays adjacent to its call; then the rest of the turn. */
        yyjson_val *b;
        yyjson_arr_iter it = yyjson_arr_iter_with(content);
        while ((b = yyjson_arr_iter_next(&it))) {
            const char *bt = yyjson_get_str(yyjson_obj_get(b, "type"));
            if (bt && !strcmp(bt, "tool_result")) push_tool_result(d, input, b);
        }
        it = yyjson_arr_iter_with(content);
        while ((b = yyjson_arr_iter_next(&it))) {
            const char *bt = yyjson_get_str(yyjson_obj_get(b, "type"));
            if (bt && !strcmp(bt, "tool_result")) continue;
            if (bt && !strcmp(bt, "text")) {
                const char *t = yyjson_get_str(yyjson_obj_get(b, "text"));
                if (t && *t) yyjson_mut_arr_append(parts, text_part(d, "input_text", t));
            } else if (bt && !strcmp(bt, "image")) {
                yyjson_mut_arr_append(parts, image_part(d, b));
            } else {
                yyjson_mut_arr_append(parts, unsupported_part(d, "input_text", bt));
            }
        }
    }
    push_message(d, input, role, parts);
}

static void push_assistant_message(mdoc *d, mval *input, yyjson_val *content) {
    mval *parts = yyjson_mut_arr(d);
    if (yyjson_is_str(content)) {
        if (*yyjson_get_str(content)) yyjson_mut_arr_append(parts, text_part(d, "output_text", yyjson_get_str(content)));
        push_message(d, input, "assistant", parts);
        return;
    }
    yyjson_val *b;
    yyjson_arr_iter it = yyjson_arr_iter_with(content);
    while ((b = yyjson_arr_iter_next(&it))) {
        const char *bt = yyjson_get_str(yyjson_obj_get(b, "type"));
        if (!bt) continue;
        if (!strcmp(bt, "text")) {
            const char *t = yyjson_get_str(yyjson_obj_get(b, "text"));
            if (t && *t) yyjson_mut_arr_append(parts, text_part(d, "output_text", t));
        } else if (!strcmp(bt, "tool_use")) {
            const char *id = yyjson_get_str(yyjson_obj_get(b, "id"));
            const char *name = yyjson_get_str(yyjson_obj_get(b, "name"));
            if (!id || !name) continue;
            push_message(d, input, "assistant", parts); /* flush text that preceded the call */
            parts = yyjson_mut_arr(d);
            yyjson_val *in = yyjson_obj_get(b, "input");
            char *args = in ? yyjson_val_write(in, 0, NULL) : NULL;
            mval *call = yyjson_mut_obj(d);
            yyjson_mut_obj_add_str(d, call, "type", "function_call");
            yyjson_mut_obj_add_strcpy(d, call, "call_id", id);
            yyjson_mut_obj_add_strcpy(d, call, "name", name);
            yyjson_mut_obj_add_strcpy(d, call, "arguments", args ? args : "{}");
            free(args);
            yyjson_mut_arr_append(input, call);
        } else if (!strcmp(bt, "thinking")) {
            /* Only reasoning we minted ourselves can go back upstream. */
            const char *sig = yyjson_get_str(yyjson_obj_get(b, "signature"));
            char *id = NULL, *enc = NULL;
            if (!sig || rsig_decode(sig, &id, &enc) != 0) continue;
            push_message(d, input, "assistant", parts);
            parts = yyjson_mut_arr(d);
            mval *r = yyjson_mut_obj(d);
            yyjson_mut_obj_add_str(d, r, "type", "reasoning");
            if (*id) yyjson_mut_obj_add_strcpy(d, r, "id", id);
            yyjson_mut_obj_add_val(d, r, "summary", yyjson_mut_arr(d));
            yyjson_mut_obj_add_strcpy(d, r, "encrypted_content", enc);
            yyjson_mut_arr_append(input, r);
            free(id); free(enc);
        }
        /* redacted_thinking and anything else from the assistant side is dropped */
    }
    push_message(d, input, "assistant", parts);
}

static const char *item_str(mval *item, const char *key) {
    return yyjson_mut_get_str(yyjson_mut_obj_get(item, key));
}

/* The backend rejects unpaired calls/outputs: drop orphan outputs, abort lonely calls. */
static mval *pair_calls(mdoc *d, mval *input) {
    mval *out = yyjson_mut_arr(d);
    size_t idx, max;
    mval *item;
    yyjson_mut_arr_foreach(input, idx, max, item) {
        const char *type = item_str(item, "type");
        int is_call = type && !strcmp(type, "function_call");
        int is_output = type && !strcmp(type, "function_call_output");
        if (!is_call && !is_output) { yyjson_mut_arr_append(out, yyjson_mut_val_mut_copy(d, item)); continue; }

        const char *id = item_str(item, "call_id");
        const char *want = is_call ? "function_call_output" : "function_call";
        int matched = 0;
        size_t j, jmax;
        mval *other;
        yyjson_mut_arr_foreach(input, j, jmax, other) {
            const char *ot = item_str(other, "type");
            const char *oid = item_str(other, "call_id");
            if (ot && oid && id && !strcmp(ot, want) && !strcmp(oid, id) && (is_call ? j > idx : j < idx)) { matched = 1; break; }
        }
        if (is_output && !matched) continue;
        yyjson_mut_arr_append(out, yyjson_mut_val_mut_copy(d, item));
        if (is_call && !matched) push_output(d, out, id ? id : "", yyjson_mut_str(d, "aborted"));
    }
    return out;
}

/* ---- top-level pieces -------------------------------------------------- */

static void add_instructions(mdoc *d, mval *root, yyjson_val *system) {
    buf_t b; buf_init(&b);
    if (yyjson_is_str(system)) {
        buf_append_str(&b, yyjson_get_str(system));
    } else {
        yyjson_val *blk;
        yyjson_arr_iter it = yyjson_arr_iter_with(system);
        while ((blk = yyjson_arr_iter_next(&it))) {
            const char *t = yyjson_get_str(yyjson_obj_get(blk, "text"));
            if (!t || !*t || !strncmp(t, BILLING_PREFIX, sizeof BILLING_PREFIX - 1)) continue;
            if (b.len) buf_append_str(&b, "\n\n");
            buf_append_str(&b, t);
        }
    }
    if (b.len) yyjson_mut_obj_add_strcpy(d, root, "instructions", b.data);
    buf_free(&b);
}

static int tool_name_ok(const char *n) {
    size_t len = strlen(n);
    if (len == 0 || len > TOOL_NAME_MAX) return 0;
    for (size_t i = 0; i < len; i++) {
        char c = n[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static mval *build_tools(mdoc *d, yyjson_val *tools) {
    mval *out = yyjson_mut_arr(d);
    yyjson_val *t;
    yyjson_arr_iter it = yyjson_arr_iter_with(tools);
    while ((t = yyjson_arr_iter_next(&it))) {
        const char *type = yyjson_get_str(yyjson_obj_get(t, "type"));
        if (type && strcmp(type, "custom") != 0) continue; /* Anthropic server tools have no upstream twin */
        const char *name = yyjson_get_str(yyjson_obj_get(t, "name"));
        if (!name || !tool_name_ok(name)) continue;
        mval *f = yyjson_mut_obj(d);
        yyjson_mut_obj_add_str(d, f, "type", "function");
        yyjson_mut_obj_add_strcpy(d, f, "name", name);
        const char *desc = yyjson_get_str(yyjson_obj_get(t, "description"));
        if (desc) yyjson_mut_obj_add_strcpy(d, f, "description", desc);
        yyjson_mut_obj_add_bool(d, f, "strict", false);
        yyjson_mut_obj_add_val(d, f, "parameters", schema_sanitize_root(d, yyjson_obj_get(t, "input_schema")));
        yyjson_mut_arr_append(out, f);
    }
    return out;
}

static int has_tool(mval *tools, const char *name) {
    size_t i, max;
    mval *t;
    yyjson_mut_arr_foreach(tools, i, max, t)
        if (!strcmp(item_str(t, "name"), name)) return 1;
    return 0;
}

static void add_tool_choice(mdoc *d, mval *root, yyjson_val *choice, mval *tools) {
    const char *type = yyjson_get_str(yyjson_obj_get(choice, "type"));
    int have_tools = yyjson_mut_arr_size(tools) > 0;
    int parallel = !yyjson_is_true(yyjson_obj_get(choice, "disable_parallel_tool_use"));
    yyjson_mut_obj_add_bool(d, root, "parallel_tool_calls", parallel);

    if (type && have_tools && !strcmp(type, "any")) {
        yyjson_mut_obj_add_str(d, root, "tool_choice", "required");
    } else if (type && !strcmp(type, "none")) {
        yyjson_mut_obj_add_str(d, root, "tool_choice", "none");
    } else if (type && have_tools && !strcmp(type, "tool")) {
        const char *name = yyjson_get_str(yyjson_obj_get(choice, "name"));
        if (name && has_tool(tools, name)) {
            mval *o = yyjson_mut_obj(d);
            yyjson_mut_obj_add_str(d, o, "type", "function");
            yyjson_mut_obj_add_strcpy(d, o, "name", name);
            yyjson_mut_obj_add_val(d, root, "tool_choice", o);
        } else {
            yyjson_mut_obj_add_str(d, root, "tool_choice", "auto");
        }
    } else {
        yyjson_mut_obj_add_str(d, root, "tool_choice", "auto");
    }
}

static int session_char_ok(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
}

/* Copies s into out only if it is a plausible id; it ends up in an HTTP header. */
static void take_session_id(const char *s, char *out, size_t outlen) {
    size_t n = s ? strlen(s) : 0;
    if (n == 0 || n >= outlen) return;
    for (size_t i = 0; i < n; i++)
        if (!session_char_ok(s[i])) return;
    memcpy(out, s, n + 1);
}

/* Claude Code puts the session in metadata.user_id, either as a JSON document
 * {"device_id":..,"account_uuid":..,"session_id":".."} (current) or as
 * "user_<hash>_account_<uuid>_session_<uuid>" (older releases). */
static void extract_session_id(yyjson_val *root, char *out, size_t outlen) {
    out[0] = '\0';
    const char *uid = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "metadata"), "user_id"));
    if (!uid) return;
    if (uid[0] == '{') {
        yyjson_doc *d = yyjson_read(uid, strlen(uid), 0);
        if (d) take_session_id(yyjson_get_str(yyjson_obj_get(yyjson_doc_get_root(d), "session_id")), out, outlen);
        yyjson_doc_free(d);
        return;
    }
    const char *s = strstr(uid, "_session_");
    if (s) take_session_id(s + strlen("_session_"), out, outlen);
}

int translate_request(const char *json, size_t len, xlate_req_t *out, char *err, size_t errlen) {
    memset(out, 0, sizeof *out);
    yyjson_doc *src = yyjson_read(json, len, 0);
    if (!src) return fail(err, errlen, 400, "request body is not valid JSON");
    yyjson_val *root = yyjson_doc_get_root(src);
    yyjson_val *model_value = yyjson_obj_get(root, "model");
    const char *model = yyjson_get_str(model_value);
    yyjson_val *messages = yyjson_obj_get(root, "messages");
    int rc = 0;
    if (!yyjson_is_obj(root) || !model) rc = fail(err, errlen, 400, "model: field required");
    else if (yyjson_get_len(model_value) != strlen(model)) rc = fail(err, errlen, 400, "model: invalid model name");
    else if (!yyjson_is_arr(messages)) rc = fail(err, errlen, 400, "messages: field required");
    if (rc) { yyjson_doc_free(src); return rc; }

    const char *body_effort = yyjson_get_str(yyjson_obj_get(yyjson_obj_get(root, "output_config"), "effort"));
    int mrc = model_resolve(model, body_effort, &out->sel);
    if (mrc == MODEL_E_UNKNOWN) {
        buf_t names; buf_init(&names);
        char slugs[3][MODEL_SLUG_MAX];
        size_t count = models_list(slugs, 3);
        for (size_t i = 0; i < count && i < 3; i++)
            buf_appendf(&names, "%s%s", names.len ? ", " : "", slugs[i]);
        rc = fail(err, errlen, 404, "model: %.80s is not a claudex tier (available: %s)", model, names.data ? names.data : "");
        buf_free(&names);
    } else if (mrc == MODEL_E_BAD_EFFORT) {
        rc = fail(err, errlen, 400, "model: %.80s has an invalid @effort suffix (use low, medium, high, xhigh, max or ultra)", model);
    }
    if (rc) { yyjson_doc_free(src); return rc; }

    mdoc *d = yyjson_mut_doc_new(NULL);
    if (!d) { yyjson_doc_free(src); return fail(err, errlen, 500, "out of memory"); }
    mval *up = yyjson_mut_obj(d);
    yyjson_mut_doc_set_root(d, up);

    yyjson_mut_obj_add_str(d, up, "model", out->sel.slug);
    add_instructions(d, up, yyjson_obj_get(root, "system"));

    mval *input = yyjson_mut_arr(d);
    yyjson_val *m;
    yyjson_arr_iter it = yyjson_arr_iter_with(messages);
    while ((m = yyjson_arr_iter_next(&it))) {
        const char *role = yyjson_get_str(yyjson_obj_get(m, "role"));
        yyjson_val *content = yyjson_obj_get(m, "content");
        if (!role || !(yyjson_is_str(content) || yyjson_is_arr(content))) continue;
        if (!strcmp(role, "assistant")) push_assistant_message(d, input, content);
        else push_user_message(d, input, !strcmp(role, "user") ? "user" : "developer", content);
    }
    yyjson_mut_obj_add_val(d, up, "input", pair_calls(d, input));

    mval *tools = build_tools(d, yyjson_obj_get(root, "tools"));
    yyjson_mut_obj_add_val(d, up, "tools", tools);
    add_tool_choice(d, up, yyjson_obj_get(root, "tool_choice"), tools);

    mval *reasoning = yyjson_mut_obj(d);
    yyjson_mut_obj_add_str(d, reasoning, "effort", out->sel.effort);
    yyjson_mut_obj_add_str(d, reasoning, "summary", "auto");
    yyjson_mut_obj_add_val(d, up, "reasoning", reasoning);

    yyjson_mut_obj_add_bool(d, up, "store", false);
    yyjson_mut_obj_add_bool(d, up, "stream", true);
    mval *include = yyjson_mut_arr(d);
    yyjson_mut_arr_add_str(d, include, "reasoning.encrypted_content");
    yyjson_mut_obj_add_val(d, up, "include", include);

    extract_session_id(root, out->session_id, sizeof out->session_id);
    if (out->session_id[0]) yyjson_mut_obj_add_str(d, up, "prompt_cache_key", out->session_id);

    mval *text = yyjson_mut_obj(d);
    yyjson_mut_obj_add_str(d, text, "verbosity", "low");
    yyjson_mut_obj_add_val(d, up, "text", text);

    out->stream = yyjson_is_true(yyjson_obj_get(root, "stream"));
    out->client_model = strdup(model);
    out->body = yyjson_mut_write(d, 0, &out->body_len);
    yyjson_mut_doc_free(d);
    yyjson_doc_free(src);
    if (!out->body || !out->client_model) {
        xlate_req_free(out);
        return fail(err, errlen, 500, "out of memory");
    }
    return 0;
}
