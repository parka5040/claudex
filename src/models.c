#include "models.h"
#include "upstream.h"

#include <limits.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <yyjson.h>

#define MAX_MODELS 256

enum { LUNA, SOL, ASTRA, TERRA, FAMILIES };
static const char *const NAMES[] = { "luna", "sol", "astra", "terra" };
static const char *const DEFAULTS[] = { "low", "high", "xhigh", "high" };
static const char *const FALLBACK[] = { "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-sol" };
static const char *const EFFORTS[] = { "low", "medium", "high", "xhigh", "max", "ultra" };

typedef struct {
    char slug[MODEL_SLUG_MAX];
    int family, major, minor;
} row_t;
typedef struct {
    row_t rows[MAX_MODELS];
    size_t count;
    long loaded_at;
} catalog_t;
static catalog_t *catalog; /* immutable once installed; protected by catalog_lock */
static char rejected_slugs[MAX_MODELS][MODEL_SLUG_MAX];
static size_t rejected_count;
static int fetch_failed;
static pthread_mutex_t catalog_lock = PTHREAD_MUTEX_INITIALIZER;

/* Accept only anchored, decimal major[.minor] slugs in a known family. */
static int parse_slug(const char *slug, size_t len, row_t *out) {
    if (len < 7 || len >= MODEL_SLUG_MAX || memcmp(slug, "gpt-", 4)) return -1;
    const char *p = slug + 4, *end = slug + len;
    int major = 0, minor = 0;
    if (p == end || *p < '0' || *p > '9') return -1;
    while (p < end && *p >= '0' && *p <= '9') {
        if (major > (INT_MAX - (*p - '0')) / 10) return -1;
        major = major * 10 + (*p++ - '0');
    }
    if (p < end && *p == '.') {
        p++;
        if (p == end || *p < '0' || *p > '9') return -1;
        while (p < end && *p >= '0' && *p <= '9') {
            if (minor > (INT_MAX - (*p - '0')) / 10) return -1;
            minor = minor * 10 + (*p++ - '0');
        }
    }
    if (p == end || *p++ != '-') return -1;
    for (int i = 0; i < FAMILIES; i++) {
        if ((size_t)(end - p) == strlen(NAMES[i]) && !memcmp(p, NAMES[i], (size_t)(end - p))) {
            memset(out, 0, sizeof *out);
            memcpy(out->slug, slug, len);
            out->family = i; out->major = major; out->minor = minor;
            return 0;
        }
    }
    return -1;
}

int models_catalog_load(const char *json, size_t len) {
    if (!json || !len || len > 4u * 1024u * 1024u) return -1;
    yyjson_doc *doc = yyjson_read(json, len, 0);
    if (!doc) return -1;
    yyjson_val *models = yyjson_obj_get(yyjson_doc_get_root(doc), "models");
    if (!yyjson_is_arr(models) || yyjson_arr_size(models) > MAX_MODELS) { yyjson_doc_free(doc); return -1; }
    catalog_t *next = calloc(1, sizeof *next);
    if (!next) { yyjson_doc_free(doc); return -1; }
    yyjson_val *item;
    yyjson_arr_iter it = yyjson_arr_iter_with(models);
    while ((item = yyjson_arr_iter_next(&it))) {
        const char *visibility = yyjson_get_str(yyjson_obj_get(item, "visibility"));
        const char *slug = yyjson_get_str(yyjson_obj_get(item, "slug"));
        if (!visibility || strcmp(visibility, "list") || !yyjson_is_true(yyjson_obj_get(item, "supported_in_api")) || !slug) continue;
        row_t row;
        if (parse_slug(slug, yyjson_get_len(yyjson_obj_get(item, "slug")), &row) != 0) continue;
        next->rows[next->count++] = row;
    }
    yyjson_doc_free(doc);
    if (!next->count) { free(next); return -1; }
    next->loaded_at = (long)time(NULL);
    pthread_mutex_lock(&catalog_lock);
    catalog_t *old = catalog;
    catalog = next;
    rejected_count = 0;
    fetch_failed = 0;
    pthread_mutex_unlock(&catalog_lock);
    free(old);
    return 0;
}

void models_catalog_fetch_failed(void) {
    pthread_mutex_lock(&catalog_lock);
    fetch_failed = 1;
    pthread_mutex_unlock(&catalog_lock);
}

void models_mark_rejected(const char *slug) {
    if (!slug) return;
    size_t len = strlen(slug);
    if (!len || len >= MODEL_SLUG_MAX) return;
    pthread_mutex_lock(&catalog_lock);
    for (size_t i = 0; i < rejected_count; i++)
        if (!strcmp(slug, rejected_slugs[i])) { pthread_mutex_unlock(&catalog_lock); return; }
    if (rejected_count < MAX_MODELS) {
        memcpy(rejected_slugs[rejected_count], slug, len + 1);
        rejected_count++;
    }
    pthread_mutex_unlock(&catalog_lock);
    upstream_refresh_soon();
}

static int rejected(const char *slug) {
    for (size_t i = 0; i < rejected_count; i++)
        if (!strcmp(rejected_slugs[i], slug)) return 1;
    return 0;
}

static void view_locked(models_view_t *out) {
    memset(out, 0, sizeof *out);
    const catalog_t *c = catalog;
    int newest = -1;
    for (size_t i = 0; c && i < c->count; i++)
        if (!rejected(c->rows[i].slug) && c->rows[i].major > newest)
            newest = c->rows[i].major;
    const row_t *best[FAMILIES] = {0};
    for (size_t i = 0; c && i < c->count; i++) {
        const row_t *r = &c->rows[i];
        if (rejected(r->slug)) continue;
        const row_t *b = best[r->family];
        if (!b || r->major > b->major || (r->major == b->major && r->minor > b->minor)) best[r->family] = r;
    }
    int any_current = 0;
    for (int i = LUNA; i <= ASTRA; i++)
        if (best[i] && best[i]->major == newest) any_current = 1;
    out->from_backend = c && !fetch_failed && any_current;
    out->loaded_at = c ? c->loaded_at : 0;
    for (int i = LUNA; i <= ASTRA; i++) {
        int rejected_family = 0;
        for (size_t j = 0; c && j < c->count; j++)
            if (c->rows[j].family == i && rejected(c->rows[j].slug)) rejected_family = 1;
        out->current[i] = out->from_backend && best[i] &&
            (best[i]->major == newest || rejected_family);
        const char *sol = out->from_backend && best[SOL] ? best[SOL]->slug : FALLBACK[SOL];
        const char *slug = out->current[i] ? best[i]->slug : sol;
        if (out->from_backend && rejected_family && !best[i]) slug = FALLBACK[i];
        if (!out->from_backend) slug = FALLBACK[i];
        memcpy(out->family[i], slug, strlen(slug) + 1);
    }
    memcpy(out->family[TERRA], out->family[SOL], MODEL_SLUG_MAX);
}

void models_view(models_view_t *out) {
    pthread_mutex_lock(&catalog_lock);
    view_locked(out);
    pthread_mutex_unlock(&catalog_lock);
}

size_t models_list(char out[][MODEL_SLUG_MAX], size_t cap) {
    models_view_t v; models_view(&v);
    size_t n = 0;
    for (int i = LUNA; i <= ASTRA; i++) {
        if (v.from_backend && !v.current[i]) continue;
        if (n < cap && out) memcpy(out[n], v.family[i], MODEL_SLUG_MAX);
        n++;
    }
    return n;
}

static const char *effort_lookup(const char *s, size_t n) {
    for (size_t i = 0; i < sizeof EFFORTS / sizeof EFFORTS[0]; i++)
        if (strlen(EFFORTS[i]) == n && !memcmp(EFFORTS[i], s, n)) return EFFORTS[i];
    return NULL;
}

int model_resolve(const char *requested, const char *body_effort, model_sel_t *out) {
    if (!requested || !out) return MODEL_E_UNKNOWN;
    size_t n = strlen(requested);
    if (n >= 4 && !memcmp(requested + n - 4, "[1m]", 4)) n -= 4;
    int family = -1, remapped = 0;
    const char *at = memchr(requested, '@', n);
    size_t name_len = at ? (size_t)(at - requested) : n;
    for (int i = 0; i < FAMILIES; i++) {
        if (name_len == strlen(NAMES[i]) && !memcmp(requested, NAMES[i], name_len)) family = i;
        if (name_len == 4 + strlen(NAMES[i]) && !memcmp(requested, "gpt-", 4) && !memcmp(requested + 4, NAMES[i], name_len - 4)) family = i;
    }
    if (family < 0 && name_len >= 4 && !memcmp(requested, "gpt-", 4)) {
        row_t r;
        if (parse_slug(requested, name_len, &r) == 0) family = r.family;
    }
    if (family < 0) {
        if ((n >= 4 && !strncasecmp(requested, "gpt-", 4)) || at) return MODEL_E_UNKNOWN;
        family = LUNA; remapped = 1;
    }
    const char *effort = at ? effort_lookup(at + 1, n - name_len - 1) : NULL;
    if (at && !effort) return MODEL_E_BAD_EFFORT;
    if (!effort && !remapped && body_effort) effort = effort_lookup(body_effort, strlen(body_effort));
    models_view_t v; models_view(&v);
    int resolved_family = (family == TERRA || (v.from_backend && !v.current[family])) ? SOL : family;
    if (!effort) effort = DEFAULTS[resolved_family];
    if (resolved_family == LUNA && !strcmp(effort, "ultra")) effort = "max";
    memcpy(out->slug, v.family[family], MODEL_SLUG_MAX);
    out->effort = effort;
    out->remapped = remapped;
    return MODEL_OK;
}
