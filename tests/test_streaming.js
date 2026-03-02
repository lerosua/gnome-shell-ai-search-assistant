#!/usr/bin/env -S gjs -m
// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Test: GJS streaming SSE (Server-Sent Events) with Soup 3.0
//
// Usage:
//   gjs -m tests/test_streaming.js
//
// API key resolution (same order as aiView.js):
//   1. Environment variable YUNWU_API_KEY
//   2. gsettings api-key
//
// You can also override the base URL and model:
//   YUNWU_BASE_URL=https://api.openai.com YUNWU_MODEL=gpt-4o gjs -m tests/test_streaming.js

import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ── Configuration ──────────────────────────────────────────────

const CHAT_PATH = '/v1/chat/completions';
const DEFAULT_BASE_URL = 'https://yunwu.ai';
const DEFAULT_MODEL = 'gpt-5-mini';

/**
 * GJS TextDecoder does NOT support the {stream: true} option.
 * Use a simple wrapper that just calls decode() without options.
 */
function bytesToString(bytes) {
    if (bytes instanceof GLib.Bytes)
        bytes = bytes.get_data();
    // bytes is a Uint8Array at this point
    return new TextDecoder('utf-8').decode(bytes);
}

function getApiKey() {
    const fromEnv = GLib.getenv('YUNWU_API_KEY');
    if (fromEnv && fromEnv.trim())
        return fromEnv.trim();

    try {
        const [ok, stdout] = GLib.spawn_command_line_sync(
            "gsettings get org.gnome.shell.extensions.ai-search-assistant api-key"
        );
        if (ok) {
            const val = bytesToString(stdout).trim().replace(/^'|'$/g, '');
            if (val)
                return val;
        }
    } catch (_e) { /* ignore */ }

    return '';
}

function getBaseUrl() {
    const fromEnv = GLib.getenv('YUNWU_BASE_URL');
    if (fromEnv && fromEnv.trim())
        return fromEnv.trim().replace(/\/+$/, '');

    try {
        const [ok, stdout] = GLib.spawn_command_line_sync(
            "gsettings get org.gnome.shell.extensions.ai-search-assistant base-url"
        );
        if (ok) {
            const val = bytesToString(stdout).trim().replace(/^'|'$/g, '');
            if (val)
                return val.replace(/\/+$/, '');
        }
    } catch (_e) { /* ignore */ }

    return DEFAULT_BASE_URL;
}

function buildEndpoint(baseUrl) {
    if (/\/chat\/completions$/i.test(baseUrl))
        return baseUrl;
    if (/\/v1$/i.test(baseUrl))
        return `${baseUrl}/chat/completions`;
    return `${baseUrl}${CHAT_PATH}`;
}

// ── Soup / Gio helpers (mirrors aiView.js) ─────────────────────

function sendMessageAsync(session, message) {
    return new Promise((resolve, reject) => {
        session.send_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (_session, result) => {
                try {
                    const stream = session.send_finish(result);
                    resolve(stream);
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function readBytesAsync(stream, count) {
    return new Promise((resolve, _reject) => {
        stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, null, (src, result) => {
            try {
                resolve(src.read_bytes_finish(result));
            } catch (e) {
                const msg = e.message ?? '';
                if (msg.includes('NO_ERROR') || msg.includes('no error') ||
                    msg.includes('Connection reset') ||
                    e.code === Gio.IOErrorEnum.CONNECTION_CLOSED ||
                    e.code === Gio.IOErrorEnum.BROKEN_PIPE) {
                    resolve(null);
                    return;
                }
                print(`[WARN] stream read error: ${msg}`);
                resolve(null);
            }
        });
    });
}

function extractStreamDelta(block) {
    const lines = block.split('\n');
    const data = [];

    for (const line of lines) {
        if (!line.startsWith('data:'))
            continue;
        data.push(line.slice(5).trimStart());
    }

    if (data.length === 0)
        return {done: false, delta: ''};

    const payload = data.join('\n').trim();
    if (payload.length === 0)
        return {done: false, delta: ''};

    if (payload === '[DONE]')
        return {done: true, delta: ''};

    try {
        const parsed = JSON.parse(payload);
        const choice = parsed.choices?.[0] ?? null;
        let delta = choice?.delta?.content ?? choice?.message?.content ?? '';
        if (Array.isArray(delta))
            delta = delta.map(part => part?.text ?? '').join('');
        return {done: false, delta: String(delta)};
    } catch (_e) {
        return {done: false, delta: ''};
    }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
    const apiKey = getApiKey();
    if (!apiKey) {
        print('[FAIL] No API key found. Set YUNWU_API_KEY or gsettings api-key');
        return 1;
    }

    const baseUrl = getBaseUrl();
    const apiUrl = buildEndpoint(baseUrl);
    const model = GLib.getenv('YUNWU_MODEL') ?? DEFAULT_MODEL;

    print(`── GJS Streaming SSE Test ──`);
    print(`  Endpoint : ${apiUrl}`);
    print(`  Model    : ${model}`);
    print(`  Key      : ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);
    print('');

    // Build request (identical to aiView.js)
    const session = new Soup.Session({timeout: 120});
    const msg = Soup.Message.new('POST', apiUrl);

    msg.request_headers.append('Authorization', `Bearer ${apiKey}`);
    msg.request_headers.append('Content-Type', 'application/json');

    const body = JSON.stringify({
        model,
        messages: [
            {role: 'user', content: '用一句话介绍你自己'}
        ],
        temperature: 0.7,
        stream: true,
    });

    msg.set_request_body_from_bytes('application/json', new GLib.Bytes(body));

    // Send
    print('[INFO] Sending request...');
    let responseStream;
    try {
        responseStream = await sendMessageAsync(session, msg);
    } catch (e) {
        print(`[FAIL] send_async failed: ${e.message}`);
        return 1;
    }

    const statusCode = msg.status_code ?? 0;
    const contentType = (msg.response_headers.get_one('Content-Type') ?? '').toLowerCase();
    print(`[INFO] HTTP ${statusCode}, Content-Type: ${contentType}`);

    if (statusCode < 200 || statusCode >= 300) {
        // Read error body
        let errText = '';
        while (true) {
            const b = await readBytesAsync(responseStream, 4096);
            if (!b || b.get_size() === 0) break;
            errText += bytesToString(b.get_data());
        }
        print(`[FAIL] HTTP ${statusCode}: ${errText.slice(0, 500)}`);
        return 1;
    }

    // ── Stream reading (SSE) ───────────────────────────────────
    const isSse = contentType.includes('text/event-stream');
    print(`[INFO] SSE streaming: ${isSse ? 'YES' : 'NO (will read as JSON)'}`);
    print('');

    if (!isSse) {
        // Fallback: read whole body as JSON
        let text = '';
        while (true) {
            const b = await readBytesAsync(responseStream, 4096);
            if (!b || b.get_size() === 0) break;
            text += bytesToString(b.get_data());
        }

        print('[INFO] Non-streaming response body:');
        print(text.slice(0, 1000));

        try {
            const parsed = JSON.parse(text);
            const content = parsed.choices?.[0]?.message?.content ?? '';
            print('');
            print(`[PASS] Response content: ${content}`);
        } catch (e) {
            print(`[WARN] Could not parse JSON: ${e.message}`);
        }
        return 0;
    }

    // ── SSE stream parsing (mirrors aiView._readStreamResponse) ──
    let buffer = '';
    let fullText = '';
    let chunkCount = 0;
    const startTime = GLib.get_monotonic_time();

    print('── Streaming output ──');

    while (true) {
        const bytes = await readBytesAsync(responseStream, 4096);
        if (bytes === null || bytes.get_size() === 0)
            break;

        chunkCount++;
        const chunk = bytesToString(bytes.get_data());
        buffer += chunk.replace(/\r\n/g, '\n');

        // Parse SSE blocks
        while (true) {
            const boundary = buffer.indexOf('\n\n');
            if (boundary === -1)
                break;

            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const update = extractStreamDelta(block);

            if (update.done) {
                const elapsed = (GLib.get_monotonic_time() - startTime) / 1e6;
                print('');
                print('');
                print(`── Stream complete ──`);
                print(`  Chunks read  : ${chunkCount}`);
                print(`  Total chars  : ${fullText.length}`);
                print(`  Elapsed      : ${elapsed.toFixed(2)}s`);
                print('');
                print('[PASS] GJS SSE streaming works correctly!');
                return 0;
            }

            if (update.delta) {
                fullText += update.delta;
                // GJS print() always appends newline; use printerr-free
                // approach: just accumulate and print lines as they form.
                // For real-time feel we print each delta on its own line.
                print(`  [chunk ${chunkCount}] ${JSON.stringify(update.delta)}`);
            }
        }
    }

    // Handle remaining buffer
    if (buffer.trim().length > 0) {
        const update = extractStreamDelta(buffer);
        if (update.delta) {
            fullText += update.delta;
            print(update.delta);
        }
    }

    const elapsed = (GLib.get_monotonic_time() - startTime) / 1e6;
    print('');
    print(`── Stream ended (no [DONE] marker) ──`);
    print(`  Chunks read  : ${chunkCount}`);
    print(`  Total chars  : ${fullText.length}`);
    print(`  Elapsed      : ${elapsed.toFixed(2)}s`);

    if (fullText.length > 0) {
        print('');
        print(`── Full response ──`);
        print(fullText);
        print('');
        print('[PASS] GJS SSE streaming works (stream closed without [DONE])');
        return 0;
    } else {
        print('[FAIL] No content received from stream');
        return 1;
    }
}

// ── Run with GLib main loop ────────────────────────────────────

const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

main().then(code => {
    exitCode = code;
    loop.quit();
}).catch(e => {
    print(`[FAIL] Unhandled error: ${e.message}`);
    if (e.stack)
        print(e.stack);
    exitCode = 1;
    loop.quit();
});

loop.run();

// Exit after loop ends (GJS ES module doesn't have imports.system)
if (exitCode !== 0) {
    // Use GLib to signal failure
    throw new Error(`Test failed with exit code ${exitCode}`);
}
