/* Read-only access to the Codex CLI's ChatGPT login (auth.json).
 * claudex never writes this file and never refreshes tokens: Codex owns the login. */
#ifndef CLAUDEX_AUTH_H
#define CLAUDEX_AUTH_H

#include <stddef.h>

typedef struct {
    char     *access_token;  /* secret */
    char     *account_id;
    long long exp;           /* access token JWT exp (unix seconds), -1 if unknown */
} auth_t;

#define AUTH_OK          0
#define AUTH_E_IO       (-1)  /* cannot open/read, or file too large */
#define AUTH_E_PARSE    (-2)  /* not valid JSON */
#define AUTH_E_NO_LOGIN (-3)  /* no ChatGPT tokens (e.g. API-key mode or logged out) */
#define AUTH_E_NOMEM    (-4)

/* Loads a fresh copy on every call so token rotations by Codex are picked up. */
int  auth_load(const char *path, auth_t *out);
/* Zeroes secrets before freeing. Safe on a zero-initialised or failed auth_t. */
void auth_free(auth_t *a);

/* exp claim of a JWT without verifying it; -1 if it cannot be decoded. */
long long jwt_exp(const char *jwt);

const char *auth_strerror(int code);

#endif
