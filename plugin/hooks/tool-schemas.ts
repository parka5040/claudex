// Generated from spikes/native-agents/tool-schemas-2.1.288.json (Claude Code 2.1.288).
export const TOOL_SCHEMAS: Record<string, { name: string; description: string; input_schema: unknown }> = {
  "Bash": {
    "name": "Bash",
    "description": "Executes a bash command and returns its output.\n\n- Working directory persists between calls, but prefer absolute paths \u2014 `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.\n- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\n- Command output is displayed to you, not reliably to the user.\n- `timeout` is in milliseconds: default 120000, max 600000 for a foreground command.\n- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. With it, `timeout` is how long the command may run in the background (default 1800000, max 7200000); at that limit it is stopped and you are re-invoked. No `&` needed.\n\n# Git\n- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.\n- Use the `gh` CLI for GitHub operations (PRs, issues, API).\n- Commit or push only when the user asks. If on the default branch, branch first.\n- End git commit messages and PR bodies with the attribution lines given in the conversation's system-reminder, when one is present.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "command": {
          "description": "The command to execute",
          "type": "string"
        },
        "timeout": {
          "description": "Optional timeout in milliseconds (max 600000 for a foreground command)",
          "type": "number"
        },
        "description": {
          "description": "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nSay what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls \u2192 \"List files in current directory\"\n- git status \u2192 \"Show working tree status\"\n- npm install \u2192 \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; \u2192 \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main \u2192 \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' \u2192 \"Fetch JSON from URL and extract data array elements\"",
          "type": "string"
        },
        "run_in_background": {
          "description": "Set to true to run this command in the background. With it, `timeout` limits how long the command may run in the background before it is stopped (default 1800000 ms, max 7200000 ms).",
          "type": "boolean"
        },
        "dangerouslyDisableSandbox": {
          "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
          "type": "boolean"
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    }
  },
  "Edit": {
    "name": "Edit",
    "description": "Performs exact string replacement in a file.\n\n- You must Read the file in this conversation before editing, or the call will fail.\n- `old_string` must match the file exactly, including indentation, and be unique \u2014 the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.\n- `replace_all: true` replaces every occurrence instead.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to modify",
          "type": "string"
        },
        "old_string": {
          "description": "The text to replace",
          "type": "string"
        },
        "new_string": {
          "description": "The text to replace it with (must be different from old_string)",
          "type": "string"
        },
        "replace_all": {
          "description": "Replace all occurrences of old_string (default false)",
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "file_path",
        "old_string",
        "new_string"
      ],
      "additionalProperties": false
    }
  },
  "Glob": {
    "name": "Glob",
    "description": "Fast file pattern matching. Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". Returns matching file paths sorted by modification time.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The glob pattern to match files against",
          "type": "string"
        },
        "path": {
          "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
          "type": "string"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  "Grep": {
    "name": "Grep",
    "description": "Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash \u2014 results integrate with the permission UI and file links.\n\n- Full regex syntax (e.g. \"log.*Error\", \"function\\s+\\w+\"). Ripgrep, not grep \u2014 escape literal braces (`interface\\{\\}`).\n- Filter with `glob` (e.g. \"**/*.tsx\") or `type` (e.g. \"js\", \"py\", \"rust\").\n- `output_mode`: \"content\" (matching lines), \"files_with_matches\" (paths only, default), or \"count\".\n- `multiline: true` for patterns that span lines.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The regular expression pattern to search for in file contents",
          "type": "string"
        },
        "path": {
          "description": "File or directory to search in (rg PATH). Defaults to current working directory.",
          "type": "string"
        },
        "glob": {
          "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob",
          "type": "string"
        },
        "output_mode": {
          "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
          "type": "string",
          "enum": [
            "content",
            "files_with_matches",
            "count"
          ]
        },
        "-B": {
          "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-A": {
          "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-C": {
          "description": "Alias for context.",
          "type": "number"
        },
        "context": {
          "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-n": {
          "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true.",
          "type": "boolean"
        },
        "-i": {
          "description": "Case insensitive search (rg -i)",
          "type": "boolean"
        },
        "-o": {
          "description": "Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: \"content\", ignored otherwise. Defaults to false.",
          "type": "boolean"
        },
        "type": {
          "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
          "type": "string"
        },
        "head_limit": {
          "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly \u2014 large result sets waste context).",
          "type": "number"
        },
        "offset": {
          "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
          "type": "number"
        },
        "multiline": {
          "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
          "type": "boolean"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  "Read": {
    "name": "Read",
    "description": "Reads a file from the local filesystem.\n\n- `file_path` must be an absolute path.\n- Reads up to 2000 lines by default.\n- When you already know which part of the file you need, only read that part. This can be important for larger files.\n- Results are returned using cat -n format, with line numbers starting at 1\n- Reads images (PNG, JPG, \u2026) and presents them visually. Reads PDFs via the `pages` parameter (e.g. \"1-5\", max 20 pages/request; required for PDFs over 10 pages). Reads Jupyter notebooks (.ipynb) as cells with outputs.\n- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.\n- Do NOT re-read a file you just edited to verify \u2014 Edit/Write would have errored if the change failed, and the harness tracks file state for you.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to read",
          "type": "string"
        },
        "offset": {
          "description": "The line number to start reading from. Only provide if the file is too large to read at once",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "limit": {
          "description": "The number of lines to read. Only provide if the file is too large to read at once.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pages": {
          "description": "Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum 20 pages per request.",
          "type": "string"
        }
      },
      "required": [
        "file_path"
      ],
      "additionalProperties": false
    }
  },
  "Write": {
    "name": "Write",
    "description": "Writes a file to the local filesystem, overwriting if one exists.\n\nWhen to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to write (must be absolute, not relative)",
          "type": "string"
        },
        "content": {
          "description": "The content to write to the file",
          "type": "string"
        }
      },
      "required": [
        "file_path",
        "content"
      ],
      "additionalProperties": false
    }
  }
}
