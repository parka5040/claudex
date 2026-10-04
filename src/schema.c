#include "schema.h"

#include <string.h>

#define SCHEMA_MAX_DEPTH 64

static yyjson_mut_val *sanitize(yyjson_mut_doc *doc, yyjson_val *s, int depth);

static yyjson_mut_val *string_schema(yyjson_mut_doc *doc) {
    yyjson_mut_val *o = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_str(doc, o, "type", "string");
    return o;
}

/* {"name": <schema>, ...} -> same keys, each value sanitized. */
static yyjson_mut_val *sanitize_map(yyjson_mut_doc *doc, yyjson_val *map, int depth) {
    yyjson_mut_val *out = yyjson_mut_obj(doc);
    yyjson_val *key, *val;
    yyjson_obj_iter it = yyjson_obj_iter_with(map);
    while ((key = yyjson_obj_iter_next(&it))) {
        val = yyjson_obj_iter_get_val(key);
        yyjson_mut_obj_add(out, yyjson_val_mut_copy(doc, key), sanitize(doc, val, depth + 1));
    }
    return out;
}

static yyjson_mut_val *sanitize_list(yyjson_mut_doc *doc, yyjson_val *list, int depth) {
    yyjson_mut_val *out = yyjson_mut_arr(doc);
    yyjson_val *val;
    yyjson_arr_iter it = yyjson_arr_iter_with(list);
    while ((val = yyjson_arr_iter_next(&it))) yyjson_mut_arr_append(out, sanitize(doc, val, depth + 1));
    return out;
}

static int has_numeric_bounds(yyjson_val *s) {
    static const char *const keys[] = { "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf" };
    for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++)
        if (yyjson_obj_get(s, keys[i])) return 1;
    return 0;
}

static yyjson_mut_val *sanitize(yyjson_mut_doc *doc, yyjson_val *s, int depth) {
    if (yyjson_is_bool(s)) return string_schema(doc);
    if (!yyjson_is_obj(s) || depth > SCHEMA_MAX_DEPTH) return yyjson_mut_obj(doc);

    yyjson_mut_val *out = yyjson_mut_obj(doc);
    yyjson_val *v;

    yyjson_val *type = yyjson_obj_get(s, "type");
    int typed = yyjson_is_str(type) || yyjson_is_arr(type);
    if (typed) yyjson_mut_obj_add_val(doc, out, "type", yyjson_val_mut_copy(doc, type));

    if ((v = yyjson_obj_get(s, "$ref")) && yyjson_is_str(v))
        yyjson_mut_obj_add_val(doc, out, "$ref", yyjson_val_mut_copy(doc, v));
    if ((v = yyjson_obj_get(s, "description")) && yyjson_is_str(v))
        yyjson_mut_obj_add_val(doc, out, "description", yyjson_val_mut_copy(doc, v));

    int has_enum = 0;
    if ((v = yyjson_obj_get(s, "enum")) && yyjson_is_arr(v)) {
        yyjson_mut_obj_add_val(doc, out, "enum", yyjson_val_mut_copy(doc, v));
        has_enum = 1;
    } else if ((v = yyjson_obj_get(s, "const"))) {
        yyjson_mut_val *e = yyjson_mut_arr(doc);
        yyjson_mut_arr_append(e, yyjson_val_mut_copy(doc, v));
        yyjson_mut_obj_add_val(doc, out, "enum", e);
        has_enum = 1;
    }

    yyjson_val *items = yyjson_obj_get(s, "items");
    int has_items = yyjson_is_obj(items) || yyjson_is_bool(items);
    if (has_items) yyjson_mut_obj_add_val(doc, out, "items", sanitize(doc, items, depth + 1));
    if ((v = yyjson_obj_get(s, "minItems")) && yyjson_is_uint(v))
        yyjson_mut_obj_add_val(doc, out, "minItems", yyjson_val_mut_copy(doc, v));

    yyjson_val *props = yyjson_obj_get(s, "properties");
    int has_props = yyjson_is_obj(props);
    if (has_props) yyjson_mut_obj_add_val(doc, out, "properties", sanitize_map(doc, props, depth));

    int has_required = 0;
    if ((v = yyjson_obj_get(s, "required")) && yyjson_is_arr(v)) {
        yyjson_mut_val *req = yyjson_mut_arr(doc);
        yyjson_val *name;
        yyjson_arr_iter it = yyjson_arr_iter_with(v);
        while ((name = yyjson_arr_iter_next(&it)))
            if (yyjson_is_str(name)) yyjson_mut_arr_append(req, yyjson_val_mut_copy(doc, name));
        yyjson_mut_obj_add_val(doc, out, "required", req);
        has_required = 1;
    }

    yyjson_val *addl = yyjson_obj_get(s, "additionalProperties");
    int has_addl = yyjson_is_bool(addl) || yyjson_is_obj(addl);
    if (yyjson_is_bool(addl))
        yyjson_mut_obj_add_bool(doc, out, "additionalProperties", yyjson_get_bool(addl));
    else if (yyjson_is_obj(addl))
        yyjson_mut_obj_add_val(doc, out, "additionalProperties", sanitize(doc, addl, depth + 1));

    int composed = 0;
    static const char *const comps[] = { "anyOf", "oneOf", "allOf" };
    for (size_t i = 0; i < sizeof comps / sizeof comps[0]; i++)
        if ((v = yyjson_obj_get(s, comps[i])) && yyjson_is_arr(v)) {
            yyjson_mut_obj_add_val(doc, out, comps[i], sanitize_list(doc, v, depth));
            composed = 1;
        }
    static const char *const defs[] = { "$defs", "definitions" };
    for (size_t i = 0; i < sizeof defs / sizeof defs[0]; i++)
        if ((v = yyjson_obj_get(s, defs[i])) && yyjson_is_obj(v))
            yyjson_mut_obj_add_val(doc, out, defs[i], sanitize_map(doc, v, depth));

    /* Infer a missing type the way the official client does. */
    const char *inferred = NULL;
    if (!typed && !composed && !yyjson_obj_get(s, "$ref")) {
        if (has_props || has_required || has_addl) inferred = "object";
        else if (has_items) inferred = "array";
        else if (has_enum || yyjson_obj_get(s, "format")) inferred = "string";
        else if (has_numeric_bounds(s)) inferred = "number";
        if (inferred) yyjson_mut_obj_add_str(doc, out, "type", inferred);
    }

    const char *t = typed ? yyjson_get_str(type) : inferred;
    if (t && !strcmp(t, "object") && !has_props)
        yyjson_mut_obj_add_val(doc, out, "properties", yyjson_mut_obj(doc));
    if (t && !strcmp(t, "array") && !has_items)
        yyjson_mut_obj_add_val(doc, out, "items", string_schema(doc));
    return out;
}

yyjson_mut_val *schema_sanitize(yyjson_mut_doc *doc, yyjson_val *schema) {
    return sanitize(doc, schema, 0);
}

yyjson_mut_val *schema_sanitize_root(yyjson_mut_doc *doc, yyjson_val *schema) {
    const char *t = yyjson_get_str(yyjson_obj_get(schema, "type"));
    int objectish = yyjson_is_obj(schema) &&
                    ((t && !strcmp(t, "object")) || (!t && yyjson_is_obj(yyjson_obj_get(schema, "properties"))));
    if (!objectish) {
        yyjson_mut_val *o = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, o, "type", "object");
        yyjson_mut_obj_add_val(doc, o, "properties", yyjson_mut_obj(doc));
        return o;
    }
    return sanitize(doc, schema, 0);
}
