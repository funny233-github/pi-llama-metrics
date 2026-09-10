# Pi Extension: llama.cpp Metrics Display

A Pi coding-agent extension that displays real-time metrics from llama.cpp servers, including prefill speed, generation speed, and token counts.

## Features

- **Live prefill speed** - Shows tokens/second during prompt processing (⚡)
- **Live generation speed** - Shows tokens/second during text generation (🔥)
- **Token counters** - Displays total prompt tokens and generated tokens
- **Auto-discovery** - Automatically detects when a llama.cpp model is selected
- **Status line display** - Shows metrics in the TUI status line
- **Widget mode** - Optional widget above the editor
- **Real-time streaming** - No polling delays, updates as events arrive

## Requirements

1. **llama.cpp server** running with metrics enabled:

   ```bash
   llama-server -m path/to/model.gguf --metrics --port 8080
   ```

2. **Pi coding-agent** installed and configured

3. **llama.cpp provider** configured in Pi with the correct base URL

## Installation

### Option 1: Install as a Pi package (recommended)

```bash
pi install git:/workspace/pi-llama-metrics-display
```

Or from GitHub in the future:

```bash
pi install npm:pi-llama-metrics-display
```

### Option 2: Load manually for testing

```bash
pi -e /workspace/pi-llama-metrics-display/index.ts
```

## Configuration

### llama.cpp server setup

Start your llama.cpp server with the `--metrics` flag:

```bash
llama-server \
  -m models/your-model.gguf \
  --port 8080 \
  --metrics \
  --ctx-size 4096 \
  --n-predict 2048
```

### Pi provider configuration

In your `models.json` or through the Pi UI, configure a llama.cpp provider:

```json
{
  "providers": {
    "llama-cpp": {
      "baseUrl": "http://127.0.0.1:8080",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "your-model-id" }
      ]
    }
  }
}
```

## Usage

### Automatic status line display

Once installed and a llama.cpp model is selected, the extension automatically displays metrics in the status line:

```
🦙 your-model-id • ⚡ 42.5 tok/s • 🔥 38.2 tok/s • 📊 1024 / 512
```

### Commands

#### `/llama-metrics`

Show a metrics widget above the editor:

```
🦙 your-model-id
⚡ Prefill: 42.5 tok/s
🔥 Generation: 38.2 tok/s
📊 Tokens: 1024 / 512
```

#### `/llama-metrics-toggle`

Toggle the metrics display in the status line on/off.

## Metrics Explained

- **⚡ Prefill speed** - Tokens processed per second during prompt analysis (calculated from `prompt_progress` events)
- **🔥 Generation speed** - Tokens generated per second during response creation (calculated from content deltas)
- **📊 Token counts** - Total prompt tokens processed / Total tokens generated

## Debugging

Enable debug logging by setting the environment variable:

```bash
export LLAMA_CPP_METRICS_DEBUG=1
pi -e /workspace/pi-llama-metrics-display/index.ts
```

Logs are written to `/tmp/pi-llama-metrics.log`.

## Troubleshooting

### "No metrics data available"

1. Ensure the llama.cpp server is running with `--metrics` flag
2. Check that the server's base URL matches the one in your Pi configuration
3. Verify the server is accessible: `curl http://localhost:8080/metrics`
4. Start generating text - metrics only update during active generation

### "No llama.cpp model selected"

1. Select a model from the llama.cpp provider in Pi
2. Use `/model` to browse and select models
3. Ensure the provider is configured with the correct base URL

### Metrics not updating

1. Ensure the llama.cpp server is actively generating text (metrics only update during activity)
2. Check that the server is running with `--metrics` flag
3. Verify network connectivity to the llama.cpp server
4. Ensure no firewall is blocking the connection

## Development

### Running in development mode

```bash
# From the extension directory
pi -e ./index.ts
```

### Building for distribution

This extension is designed to run directly from source. No build step required.

### Testing the SSE parsing logic

```bash
cd /workspace
node test-sse-parsing.js  # Verifies SSE event parsing
```

### Testing with a local server

1. Start a llama.cpp server:

   ```bash
   llama-server -m models/gemma-2b.gguf --metrics --port 8080
   ```

2. Configure Pi to use the local server:

   ```json
   {
     "providers": {
       "llama-cpp": {
         "baseUrl": "http://127.0.0.1:8080",
         "api": "openai-completions",
         "apiKey": "local",
         "models": [{"id": "test-model"}]
       }
     }
   }
   ```

3. Load the extension and select the model

## License

MIT
