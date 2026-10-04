/* Resolves a model family to the newest served slug in the backend catalog. */
#ifndef CLAUDEX_MODELS_H
#define CLAUDEX_MODELS_H

#include <stddef.h>

#define MODEL_SLUG_MAX 64

typedef struct {
    char        slug[MODEL_SLUG_MAX]; /* copied under the catalog lock */
    const char *effort;               /* static storage */
    int         remapped;             /* non-GPT name mapped to the background family */
} model_sel_t;

#define MODEL_OK             0
#define MODEL_E_UNKNOWN     (-1)
#define MODEL_E_BAD_EFFORT  (-2)

/* @effort > body_effort > family default. Optional [1m] is ignored. */
int model_resolve(const char *requested, const char *body_effort, model_sel_t *out);
int models_catalog_load(const char *json, size_t len); /* 0 installed, -1 unchanged */
void models_mark_rejected(const char *slug);
void models_catalog_fetch_failed(void); /* failed network fetch selects fallback, retaining catalog */
typedef struct {
    char family[4][MODEL_SLUG_MAX]; /* luna, sol, astra, terra (served by sol) */
    int current[4];                 /* terra always deprecated */
    int from_backend;
    long loaded_at;
} models_view_t;
void models_view(models_view_t *out);
size_t models_list(char out[][MODEL_SLUG_MAX], size_t cap); /* returns total current families */

#endif
