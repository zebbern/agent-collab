---
description: Check whether the local Cursor CLI (cursor-agent) is ready to use from Claude Code
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" setup --json $ARGUMENTS
```

The probe may take several seconds on Windows because it also checks for cursor-agent inside WSL.

Present the setup output to the user. If the result says cursor-agent is unavailable, add installation guidance that matches the user's platform:

- On macOS or Linux: install the Cursor CLI with:

```bash
curl https://cursor.com/install -fsS | bash
```

- On Windows: there is no native Windows build of cursor-agent. Install it inside WSL by running the same command in a WSL shell:

```bash
curl https://cursor.com/install -fsS | bash
```

If cursor-agent is installed but not authenticated:
- Preserve the guidance to run `cursor-agent login` (inside WSL on Windows).
- Mention that setting the `CURSOR_API_KEY` environment variable also works.

Do not attempt to run the install command or `cursor-agent login` yourself; both are interactive and belong to the user.
