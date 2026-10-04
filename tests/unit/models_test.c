#include "test.h"
#include "models.h"

#include <stdio.h>
#include <stdlib.h>

static int load(const char *json) { return models_catalog_load(json, strlen(json)); }
static int load_fixture(void) {
    FILE *f = fopen("tests/fixtures/models-2026-10-03.json", "rb");
    if (!f) return -1;
    char data[8192];
    size_t n = fread(data, 1, sizeof data, f);
    fclose(f);
    return models_catalog_load(data, n);
}
static void resolves(const char *name, const char *slug, const char *effort) {
    model_sel_t m;
    CHECK_INT(model_resolve(name, NULL, &m), MODEL_OK);
    CHECK_STR(m.slug, slug);
    CHECK_STR(m.effort, effort);
}

TEST(fallback_and_aliases) {
    models_view_t v;
    models_view(&v);
    CHECK_INT(v.from_backend, 0);
    resolves("luna", "gpt-6-luna", "low");
    resolves("gpt-luna", "gpt-6-luna", "low");
    resolves("gpt-5.6-luna", "gpt-6-luna", "low");
    resolves("gpt-6-luna", "gpt-6-luna", "low");
    resolves("gpt-sol", "gpt-6.1-sol", "high");
    resolves("gpt-5.6-sol", "gpt-6.1-sol", "high");
    resolves("gpt-6-sol", "gpt-6.1-sol", "high");
    resolves("gpt-6.1-sol", "gpt-6.1-sol", "high");
    resolves("gpt-astra", "gpt-6-astra", "xhigh");
    resolves("gpt-6-astra", "gpt-6-astra", "xhigh");
    resolves("gpt-terra", "gpt-6.1-sol", "high");
    resolves("gpt-5.6-terra", "gpt-6.1-sol", "high");
    resolves("terra", "gpt-6.1-sol", "high");
    CHECK_STR(v.family[3], "gpt-6.1-sol");
    CHECK_INT(v.current[3], 0);
    models_mark_rejected("gpt-6-astra");
    models_view(&v);
    CHECK_INT(v.current[2], 0);
    resolves("astra", "gpt-6.1-sol", "high");
    models_mark_rejected("gpt-6.1-sol");
    model_sel_t m;
    CHECK_INT(model_resolve("astra", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("terra", NULL, &m), MODEL_E_UNAVAILABLE);
    char names[4][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 4), 1);
    CHECK_STR(names[0], "gpt-6-luna");
    resolves("luna", "gpt-6-luna", "low");
}

TEST(today_catalog_and_list) {
    CHECK_INT(load_fixture(), 0);
    models_view_t v;
    models_view(&v);
    CHECK_INT(v.from_backend, 1);
    CHECK(v.loaded_at > 0);
    CHECK_STR(v.family[0], "gpt-6-luna");
    CHECK_STR(v.family[1], "gpt-6.1-sol");
    CHECK_STR(v.family[2], "gpt-6-astra");
    CHECK_STR(v.family[3], "gpt-6.1-sol");
    CHECK_INT(v.current[0], 1); CHECK_INT(v.current[1], 1);
    CHECK_INT(v.current[2], 1); CHECK_INT(v.current[3], 0);
    char names[4][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 4), 3);
    CHECK_STR(names[0], "gpt-6-luna");
    CHECK_STR(names[1], "gpt-6.1-sol");
    CHECK_STR(names[2], "gpt-6-astra");
    CHECK_INT(models_list(names, 1), 3);
    resolves("gpt-5.6-terra", "gpt-6.1-sol", "high");
}

TEST(new_generation_and_version_order) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-6.1-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6.1-sol\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    resolves("luna", "gpt-6.1-luna", "low");
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-sol\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-astra\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    models_view_t v; models_view(&v);
    CHECK_INT(v.current[0], 0); CHECK_INT(v.current[1], 1);
    CHECK_INT(v.current[2], 0); CHECK_INT(v.current[3], 0);
    resolves("gpt-luna", "gpt-7-sol", "high");
    model_sel_t m;
    CHECK_INT(model_resolve("gpt-luna@ultra", NULL, &m), MODEL_OK);
    CHECK_STR(m.effort, "ultra"); /* deprecated luna takes sol's effort rules */
    resolves("gpt-astra", "gpt-7-sol", "high");
    resolves("gpt-terra", "gpt-7-sol", "high");
}

TEST(deprecated_family_uses_a_listed_sol_when_available) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-sol\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-astra\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    models_view_t v; models_view(&v);
    CHECK_INT(v.current[0], 1); CHECK_INT(v.current[1], 0); CHECK_INT(v.current[2], 0);
    resolves("sol", "gpt-6-sol", "high");
    resolves("astra", "gpt-6-sol", "high");
    resolves("terra", "gpt-6-sol", "high");
}

TEST(hidden_rows_do_not_change_generation_or_rank) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-8-sol\",\"priority\":1,\"visibility\":\"hide\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-8-luna\",\"priority\":2,\"visibility\":\"list\",\"supported_in_api\":false},"
                   "{\"slug\":\"gpt-6-sol\",\"priority\":99,\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6.1-sol\",\"priority\":200,\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    resolves("sol", "gpt-6.1-sol", "high");
    resolves("luna", "gpt-6.1-sol", "high");
    char names[3][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 3), 1);
    CHECK_STR(names[0], "gpt-6.1-sol");
}

TEST(bad_catalog_preserves_last_good_one) {
    CHECK_INT(load_fixture(), 0);
    const char *bad[] = {"{", "{}", "{\"models\":[]}",
        "{\"models\":[{\"slug\":\"gpt-9-sol\\u0000tail\",\"visibility\":\"list\",\"supported_in_api\":true}]}",
        "{\"models\":[{\"slug\":\"gpt-9-sol\",\"visibility\":\"hide\",\"supported_in_api\":true}]}",
        "{\"models\":[{\"slug\":\"gpt-9-sol\",\"visibility\":\"list\",\"supported_in_api\":false}]}"};
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        CHECK_INT(load(bad[i]), -1);
        resolves("sol", "gpt-6.1-sol", "high");
        models_view_t v; models_view(&v); CHECK_INT(v.from_backend, 1);
    }
}

TEST(failed_network_fetch_uses_fallback_until_success) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-sol\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    resolves("gpt-sol", "gpt-7-sol", "high");
    models_catalog_fetch_failed();
    models_view_t v; models_view(&v);
    CHECK_INT(v.from_backend, 0);
    CHECK(v.loaded_at > 0); /* age still describes the last successful fetch */
    resolves("gpt-sol", "gpt-6.1-sol", "high");
    CHECK_INT(load_fixture(), 0);
    resolves("gpt-sol", "gpt-6.1-sol", "high");
    models_view(&v); CHECK_INT(v.from_backend, 1);
}

TEST(rejected_model_and_reload) {
    CHECK_INT(load_fixture(), 0);
    models_mark_rejected("gpt-6.1-sol");
    models_view_t sol_view; models_view(&sol_view);
    CHECK_INT(sol_view.current[1], 1);
    resolves("gpt-sol", "gpt-6-sol", "high");
    CHECK_INT(load_fixture(), 0);
    resolves("gpt-sol", "gpt-6.1-sol", "high");
    models_mark_rejected("gpt-6-luna");
    models_view_t v; models_view(&v);
    CHECK_INT(v.current[0], 0);
    CHECK_STR(v.family[0], "gpt-6.1-sol");
    resolves("luna", "gpt-6.1-sol", "high");
    char names[4][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 4), 2);
    CHECK_STR(names[0], "gpt-6.1-sol");
    CHECK_STR(names[1], "gpt-6-astra");
    CHECK_INT(load_fixture(), 0);
}

TEST(rejected_single_version_and_exhausted_sol) {
    CHECK_INT(load_fixture(), 0);
    models_mark_rejected("gpt-6-astra");
    models_view_t v; models_view(&v);
    CHECK_INT(v.current[2], 0);
    CHECK_STR(v.family[2], "gpt-6.1-sol");
    resolves("astra", "gpt-6.1-sol", "high");
    models_catalog_fetch_failed();
    models_view(&v);
    CHECK_INT(v.from_backend, 0);
    CHECK_STR(v.family[2], "gpt-6.1-sol");
    resolves("astra", "gpt-6.1-sol", "high");

    CHECK_INT(load_fixture(), 0);
    models_mark_rejected("gpt-6.1-sol");
    resolves("sol", "gpt-6-sol", "high");
    models_mark_rejected("gpt-6-sol");
    models_mark_rejected("gpt-5.6-sol");
    model_sel_t m;
    CHECK_INT(model_resolve("sol", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("terra", NULL, &m), MODEL_E_UNAVAILABLE);
    models_mark_rejected("gpt-6-luna");
    models_mark_rejected("gpt-5.6-luna");
    models_mark_rejected("gpt-6-astra");
    models_mark_rejected("gpt-5.6-terra");
    CHECK_INT(model_resolve("luna", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("astra", NULL, &m), MODEL_E_UNAVAILABLE);
    models_view(&v);
    CHECK_STR(v.family[1], "");
    CHECK_STR(v.family[2], "");
    CHECK_INT(models_list(NULL, 0), 0);
    CHECK_INT(load_fixture(), 0);
    resolves("sol", "gpt-6.1-sol", "high");
}

TEST(fallback_rejections_survive_failed_refresh) {
    CHECK_INT(load_fixture(), 0);
    models_catalog_fetch_failed();
    models_mark_rejected("gpt-6.1-sol");
    resolves("luna", "gpt-6-luna", "low");
    resolves("astra", "gpt-6-astra", "xhigh");
    model_sel_t m;
    CHECK_INT(model_resolve("sol", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("terra", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(models_list(NULL, 0), 2);
    models_mark_rejected("gpt-6-luna");
    models_mark_rejected("gpt-6-astra");
    models_view_t v; models_view(&v);
    CHECK_INT(v.from_backend, 0);
    CHECK_STR(v.family[0], "");
    CHECK_STR(v.family[1], "");
    CHECK_STR(v.family[2], "");
    CHECK_INT(model_resolve("luna", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("sol", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("astra", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("terra", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(models_list(NULL, 0), 0);
    CHECK_INT(load_fixture(), 0);
    resolves("astra", "gpt-6-astra", "xhigh");
}

TEST(terra_only_newest_generation) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-terra\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-terra\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6.1-sol\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-6-astra\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    models_view_t v; models_view(&v);
    CHECK_INT(v.from_backend, 1);
    CHECK_INT(v.current[0], 0); CHECK_INT(v.current[1], 0);
    CHECK_INT(v.current[2], 0); CHECK_INT(v.current[3], 1);
    CHECK_STR(v.family[0], "gpt-6.1-sol");
    CHECK_STR(v.family[1], "gpt-6.1-sol");
    CHECK_STR(v.family[2], "gpt-6.1-sol");
    CHECK_STR(v.family[3], "gpt-7-terra");
    char names[4][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 4), 1);
    CHECK_STR(names[0], "gpt-7-terra");
    resolves("terra", "gpt-7-terra", "medium");
    resolves("luna", "gpt-6.1-sol", "high");
    resolves("sol", "gpt-6.1-sol", "high");
    resolves("astra", "gpt-6.1-sol", "high");
    models_mark_rejected("gpt-7-terra");
    models_view(&v);
    CHECK_INT(v.current[3], 1);
    resolves("terra", "gpt-6-terra", "medium");
    models_mark_rejected("gpt-6-terra");
    models_view(&v);
    CHECK_INT(v.current[3], 0);
    resolves("terra", "gpt-6.1-sol", "high");
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-terra\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    models_view(&v);
    CHECK_INT(v.from_backend, 1);
    CHECK_INT(v.current[3], 1);
    resolves("terra", "gpt-7-terra", "medium");
    model_sel_t m;
    CHECK_INT(model_resolve("sol", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("luna", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(model_resolve("astra", NULL, &m), MODEL_E_UNAVAILABLE);
    CHECK_INT(load_fixture(), 0);
}

TEST(four_current_families_are_listed) {
    CHECK_INT(load("{\"models\":[{\"slug\":\"gpt-7-luna\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-7-sol\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-7-astra\",\"visibility\":\"list\",\"supported_in_api\":true},"
                   "{\"slug\":\"gpt-7-terra\",\"visibility\":\"list\",\"supported_in_api\":true}]}"), 0);
    char names[4][MODEL_SLUG_MAX];
    CHECK_INT(models_list(names, 4), 4);
    CHECK_STR(names[0], "gpt-7-luna");
    CHECK_STR(names[1], "gpt-7-sol");
    CHECK_STR(names[2], "gpt-7-astra");
    CHECK_STR(names[3], "gpt-7-terra");
    resolves("terra", "gpt-7-terra", "medium");
    CHECK_INT(load_fixture(), 0);
}

TEST(effort_and_errors) {
    model_sel_t m;
    CHECK_INT(model_resolve("gpt-sol", "low", &m), MODEL_OK);
    CHECK_STR(m.effort, "low");
    CHECK_INT(model_resolve("gpt-6-sol@max", "low", &m), MODEL_OK);
    CHECK_STR(m.effort, "max");
    CHECK_INT(model_resolve("gpt-luna@ultra", NULL, &m), MODEL_OK);
    CHECK_STR(m.effort, "max");
    CHECK_INT(model_resolve("gpt-terra@ultra[1m]", NULL, &m), MODEL_OK);
    CHECK_STR(m.effort, "ultra");
    CHECK_INT(model_resolve("gpt-sol@turbo", NULL, &m), MODEL_E_BAD_EFFORT);
    CHECK_INT(model_resolve("gpt-sol@", NULL, &m), MODEL_E_BAD_EFFORT);
    CHECK_INT(model_resolve("gpt-6-solar", NULL, &m), MODEL_E_UNKNOWN);
    CHECK_INT(model_resolve("gpt-5.5", NULL, &m), MODEL_E_UNKNOWN);
    CHECK_INT(model_resolve("gpt-6.1.2-sol", NULL, &m), MODEL_E_UNKNOWN);
    CHECK_INT(model_resolve("GPT-6-ASTRA", NULL, &m), MODEL_E_UNKNOWN);
    CHECK_INT(model_resolve("claude-haiku-4-5", "high", &m), MODEL_OK);
    CHECK_STR(m.slug, "gpt-6-luna"); CHECK_STR(m.effort, "low"); CHECK_INT(m.remapped, 1);
}

int main(void) {
    RUN(fallback_and_aliases);
    RUN(today_catalog_and_list);
    RUN(new_generation_and_version_order);
    RUN(deprecated_family_uses_a_listed_sol_when_available);
    RUN(hidden_rows_do_not_change_generation_or_rank);
    RUN(bad_catalog_preserves_last_good_one);
    RUN(failed_network_fetch_uses_fallback_until_success);
    RUN(rejected_model_and_reload);
    RUN(rejected_single_version_and_exhausted_sol);
    RUN(fallback_rejections_survive_failed_refresh);
    RUN(terra_only_newest_generation);
    RUN(four_current_families_are_listed);
    RUN(effort_and_errors);
    TEST_MAIN_END();
}
