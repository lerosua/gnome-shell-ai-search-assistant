# AI Search Assistant

GNOME Shell extension that adds an AI mode to the overview search entry.

## Features

- Toggle between normal search and AI chat mode from the search icon.
- Stream model responses in the overview result area.
- Persist chat memory across sessions (optional).

## Configuration

Open extension preferences to set:

- API key
- Base URL (OpenAI-compatible)
- Model
- Temperature
- Persistent memory toggle
- Clear local history button

## Privacy and Data Storage

- Network requests are sent only to the configured API endpoint.
- No built-in analytics or telemetry is collected.
- If persistent memory is enabled, prompts and replies are stored locally at:

`~/.local/state/ai-search-assistant/chat-history.jsonl`

- You can disable persistence in preferences at any time.
- You can remove stored history using the **Clear now** button in preferences.

## Development

Install locally:

```bash
./install.sh --dev
```

Compile schemas manually when needed:

```bash
glib-compile-schemas schemas
```
