# claudex — GPT-only Anthropic->Responses proxy for headless Claude Code workers
CC       ?= gcc
TESTCC   ?= clang
PKGS     := libcurl yyjson libseccomp
WARN     := -std=c17 -Wall -Wextra -Werror -Wshadow -Wconversion -Wstrict-prototypes
HARDEN   := -O2 -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE
CFLAGS   += $(WARN) -D_GNU_SOURCE -Isrc $(shell pkg-config --cflags $(PKGS))
LDLIBS   += $(shell pkg-config --libs $(PKGS)) -lpthread
SAN      := -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all

BUILD    := build
LIB_SRCS := $(filter-out src/main.c,$(wildcard src/*.c))
TESTS    := $(patsubst tests/unit/%_test.c,$(BUILD)/test/%_test,$(wildcard tests/unit/*_test.c))

.PHONY: all test integration worker-test service-test install-test plugin-check check fuzz install uninstall install-service uninstall-service dist clean
all: $(BUILD)/claudex-proxy

$(BUILD)/claudex-proxy: $(wildcard src/*.c) $(wildcard src/*.h)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) $(HARDEN) -pie -Wl,-z,relro,-z,now -o $@ $(wildcard src/*.c) $(LDLIBS)

# Unit tests: every test binary is built with ASan+UBSan and CLAUDEX_TEST.
$(BUILD)/test/%_test: tests/unit/%_test.c tests/unit/test.h $(LIB_SRCS) $(wildcard src/*.h)
	@mkdir -p $(BUILD)/test
	@echo "  TESTCC $@"; $(TESTCC) $(CFLAGS) $(SAN) -DCLAUDEX_TEST -Itests/unit -o $@ $< $(LIB_SRCS) $(LDLIBS)

test: $(TESTS)
	@fail=0; for t in $(TESTS); do echo "== $$t"; $$t || fail=1; done; exit $$fail

# Sanitized proxy binary whose upstream URL can be pointed at the fake backend.
$(BUILD)/claudex-proxy-test: $(wildcard src/*.c) $(wildcard src/*.h)
	@mkdir -p $(BUILD)
	@echo "  TESTCC $@"; $(TESTCC) $(CFLAGS) $(SAN) -DCLAUDEX_TEST -o $@ $(wildcard src/*.c) $(LDLIBS)

integration: $(BUILD)/claudex-proxy-test
	@echo "== integration"; bash tests/integration/run.sh

worker-test: $(BUILD)/claudex-proxy-test
	@echo "== worker policy"; bash tests/worker/policy_test.sh
	@echo "== worker jobs"; bash tests/worker/jobs_test.sh
	@echo "== worker step and admission"; bash tests/worker/step_test.sh
	@echo "== worker sandbox"; bash tests/worker/sandbox_test.sh
	@echo "== worker proxy management"; bash tests/worker/proxy_test.sh

service-test:
	@echo "== service installer"; bash tests/service/install_test.sh

install-test:
	@echo "== bootstrap installer"; bash tests/install/bootstrap_test.sh

plugin-check:
	@if command -v claude >/dev/null 2>&1; then claude plugin validate plugin; else echo "UNVERIFIED: plugin checks skipped (claude not found)"; fi
	@if command -v claude >/dev/null 2>&1; then \
		output=$$(claude plugin test plugin 2>&1); rc=$$?; \
		if [ $$rc -eq 0 ]; then [ -z "$$output" ] || printf '%s\n' "$$output"; \
		else case "$$output" in \
			*'hooks modules are turned off in this process'*) printf '%s\n' 'UNVERIFIED: plugin tests skipped (Claude Code hooks modules are switched off for this account/process)' ;; \
			*) printf '%s\n' "$$output"; exit $$rc ;; \
		esac; fi; \
	else echo "UNVERIFIED: plugin checks skipped (claude not found)"; fi
	@if command -v bash >/dev/null 2>&1; then bash tests/worker/mod_footprint_test.sh; else echo "UNVERIFIED: plugin checks skipped (bash not found)"; fi
	@if command -v deno >/dev/null 2>&1; then \
		types="$(MOD_TYPES)"; \
		if [ -z "$$types" ] && [ -f plugin/.claude-plugin/types/claude-code/index.d.ts ]; then types=plugin/.claude-plugin/types/claude-code/index.d.ts; fi; \
		if [ -z "$$types" ] && [ -f .cache/mods-api/claude-code.d.ts ]; then types=.cache/mods-api/claude-code.d.ts; fi; \
		if [ ! -f "$$types" ]; then printf 'UNVERIFIED: plugin type check skipped (no API declarations; set MOD_TYPES)\n'; \
		else map=$$(mktemp "$${TMPDIR:-/tmp}/claudex-mod-imports.XXXXXX.json") || exit 1; \
			printf '{"imports":{"claude-code":"file://%s"}}\n' "$$(realpath "$$types")" > "$$map"; \
			deno check --config tests/mod/deno.json --import-map "$$map" plugin/hooks/*.ts plugin/hooks/*.tsx plugin/tests/*; rc=$$?; rm -f "$$map"; exit $$rc; fi; \
	else echo "UNVERIFIED: plugin checks skipped (deno not found)"; fi

check: test integration worker-test service-test install-test plugin-check

# Fuzzing: `make fuzz` builds every harness and runs each for FUZZ_SECONDS (default 60).
FUZZ_SECONDS ?= 60
FUZZERS := $(patsubst tests/fuzz/%_fuzz.c,$(BUILD)/fuzz/%_fuzz,$(wildcard tests/fuzz/*_fuzz.c))
$(BUILD)/fuzz/%_fuzz: tests/fuzz/%_fuzz.c $(LIB_SRCS) $(wildcard src/*.h)
	@mkdir -p $(BUILD)/fuzz
	@echo "  FUZZCC $@"; clang $(CFLAGS) -g -O1 -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=all -DCLAUDEX_TEST -o $@ $< $(LIB_SRCS) $(LDLIBS)

fuzz: $(FUZZERS)
	@for f in $(FUZZERS); do n=$$(basename $$f); mkdir -p $(BUILD)/corpus/$$n; \
	  cp -n tests/fixtures/* tests/fuzz/seeds/$$n/* $(BUILD)/corpus/$$n/ 2>/dev/null; echo "== $$n ($(FUZZ_SECONDS)s)"; \
	  $$f -max_total_time=$(FUZZ_SECONDS) -max_len=65536 -timeout=10 -dict=tests/fuzz/json.dict -print_final_stats=1 $(BUILD)/corpus/$$n 2>&1 \
	    | grep -E "ERROR|SUMMARY|stat::number_of_executed_units|Sanitizer|crash-|timeout-|oom-" ; done

PREFIX ?= $(HOME)/.local
CONFIG  := $(or $(XDG_CONFIG_HOME),$(HOME)/.config)/claudex/config
# Directory registered as the plugin marketplace (install.sh passes a stable copy).
MARKETPLACE ?= $(CURDIR)

# Installs the binaries for your user and registers this repo as a local plugin marketplace.
# Touches nothing in ~/.claude except Claude Code's own plugin registry.
install: all
	install -Dm755 $(BUILD)/claudex-proxy $(PREFIX)/bin/claudex-proxy
	install -Dm755 plugin/bin/claudex-worker $(PREFIX)/bin/claudex-worker
	@if [ ! -e "$(CONFIG)" ]; then install -Dm644 /dev/null "$(CONFIG)"; \
	  printf '# claudex policy. Every key is optional; see README.md. Environment variables override this file.\n# CLAUDEX=on\n# CLAUDEX_DELEGATION=on-request\n# CLAUDEX_ADVERSARY=on-request\n' > "$(CONFIG)"; echo "created $(CONFIG)"; fi
	@$(PREFIX)/bin/claudex-worker stop-proxy >/dev/null 2>&1 || true
	claude plugin marketplace add "$(MARKETPLACE)" 2>/dev/null || claude plugin marketplace update claudex-local
	claude plugin install claudex@claudex-local --scope user 2>/dev/null || claude plugin update claudex@claudex-local
	@echo "installed. Permission rules are still needed for unattended worker launches:"; \
	 echo '  add "Bash(claudex-worker *)" to permissions.allow in ~/.claude/settings.json'; \
	 echo '  add mcp__claudex__review and mcp__claudex__verdict for native tools'

# Optional: run the proxy as a per-user service (systemd or OpenRC, auto-detected) instead of on demand.
install-service:
	bash service/install.sh install

uninstall-service:
	-bash service/install.sh uninstall

uninstall: uninstall-service
	@$(PREFIX)/bin/claudex-worker stop-proxy >/dev/null 2>&1 || true
	-claude plugin uninstall claudex@claudex-local
	-claude plugin marketplace remove claudex-local
	rm -f $(PREFIX)/bin/claudex-proxy $(PREFIX)/bin/claudex-worker
	@echo "left in place: $(CONFIG) and ~/.local/state/claudex (delete them if you want a clean slate)"

# Downloadable source zip: every tracked file plus uncommitted ones not ignored, under claudex-VERSION/.
VERSION := $(shell sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugin/.claude-plugin/plugin.json)
DIST    := claudex-$(VERSION)
dist:
	@rm -rf $(BUILD)/dist && mkdir -p $(BUILD)/dist/$(DIST)
	git ls-files -co --exclude-standard -z | xargs -0 cp --parents -t $(BUILD)/dist/$(DIST)
	cd $(BUILD)/dist && rm -f ../$(DIST).zip && zip -qrX ../$(DIST).zip $(DIST)
	@echo "wrote $(BUILD)/$(DIST).zip"

clean:
	rm -rf $(BUILD)
