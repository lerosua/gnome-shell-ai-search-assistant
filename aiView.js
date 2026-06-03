import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DEFAULT_BASE_URL = 'https://yunwu.ai';
const CHAT_PATH = '/v1/chat/completions';
const DEFAULT_CHAT_MODEL = 'gpt-5-mini';
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_HISTORY_TURNS = 8;
const DEFAULT_MAX_RECALL_ITEMS = 6;
const DEFAULT_MAX_VISIBLE_MESSAGES = 2;
const MAX_HISTORY_SESSIONS = 60;
const HISTORY_TITLE_CHARS = 96;
const HISTORY_PREVIEW_CHARS = 180;
const MEMORY_DIRNAME = 'ai-search-assistant';
const MEMORY_FILENAME = 'chat-history.jsonl';
const MAX_DISPLAY_CHARS = 24000;
const MAX_RENDER_BLOCKS = 800;
const MAX_STREAM_FALLBACK_CHARS = 65536;
const MAX_WHOLE_RESPONSE_CHARS = 65536;
const STREAM_RENDER_INTERVAL_MS = 80;
const STREAM_RENDER_CHAR_DELTA = 512;
const TRUNCATED_NOTICE = '\n\n[Output truncated to keep GNOME Shell responsive.]';

export const AiView = GObject.registerClass(
class AiView extends St.BoxLayout {
    _init(settings = null) {
        super._init({
            style_class: 'ai-view-container',
            vertical: true,
            x_expand: true,
            y_expand: true,
            visible: false
        });
        this.add_style_class_name('search-section-content');

        this._settings = settings;
        this._session = new Soup.Session({
            timeout: 120,
        });
        this._conversationHistory = [];
        this._maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS;
        this._maxRecallItems = DEFAULT_MAX_RECALL_ITEMS;
        this._maxVisibleMessages = DEFAULT_MAX_VISIBLE_MESSAGES;
        this._visibleMessages = [];
        this._memoryFilePath = this._buildMemoryFilePath();
        this._allMemoryEntries = [];
        this._currentSessionId = `${Date.now()}`;
        this._sessionGeneration = 0;
        this._thinkingAnimationId = null;
        this._activeTab = 'chat';
        this._selectedHistorySessionId = null;

        this.connect('destroy', () => {
            this._stopThinkingAnimation();
        });

        this._textDecoder = null;
        try {
            if (typeof TextDecoder === 'function')
                this._textDecoder = new TextDecoder('utf-8');
        } catch (_e) {
            this._textDecoder = null;
        }

        this._headerRow = new St.BoxLayout({
            style_class: 'ai-view-header-row',
            x_expand: true
        });
        this.add_child(this._headerRow);

        this._header = new St.Label({
            text: 'AI Assistant',
            style_class: 'ai-view-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        });
        this._headerRow.add_child(this._header);

        this._newSessionButton = new St.Button({
            style_class: 'ai-new-session-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'New conversation',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._newSessionButton.set_child(new St.Icon({
            icon_name: 'document-new-symbolic',
            style_class: 'ai-new-session-icon'
        }));
        this._newSessionButton.connect('clicked', () => {
            this._startNewConversation();
        });
        this._headerRow.add_child(this._newSessionButton);

        this._tabRow = new St.BoxLayout({
            style_class: 'ai-view-tabs',
            x_expand: true
        });
        this.add_child(this._tabRow);

        this._chatTabButton = this._createTabButton('Chat', 'chat');
        this._historyTabButton = this._createTabButton('History', 'history');
        this._tabRow.add_child(this._chatTabButton);
        this._tabRow.add_child(this._historyTabButton);

        // Scroll View for Chat
        this._scrollView = new St.ScrollView({
            style_class: 'ai-view-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true
        });
        this.add_child(this._scrollView);

        // Content Container inside ScrollView
        this._contentBox = new St.BoxLayout({
            style_class: 'ai-view-content',
            vertical: true,
            x_expand: true
        });
        this._scrollView.set_child(this._contentBox);

        this._historyScrollView = new St.ScrollView({
            style_class: 'ai-view-scroll ai-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            visible: false
        });
        this.add_child(this._historyScrollView);

        this._historyBox = new St.BoxLayout({
            style_class: 'ai-history-content',
            vertical: true,
            x_expand: true
        });
        this._historyScrollView.set_child(this._historyBox);

        this._restoreConversationFromMemory();
        if (this._conversationHistory.length === 0)
            this.addMessage('System', 'Hello! Click the search button to toggle AI mode.');

        this._syncTabState();
    }

    addMessage(sender, text) {
        if (this._activeTab !== 'chat')
            this._setActiveTab('chat');

        const msgBox = new St.BoxLayout({
            style_class: 'ai-message-box',
            vertical: true
        });

        const senderLabel = new St.Label({
            text: sender,
            style_class: 'ai-message-sender'
        });
        
        msgBox.add_child(senderLabel);

        const bodyBox = new St.BoxLayout({
            style_class: 'ai-message-body',
            vertical: true,
            x_expand: true
        });
        msgBox.add_child(bodyBox);

        const message = {
            sender,
            actor: msgBox,
            bodyBox,
            text: '',
            renderMode: null,
            plainLabel: null,
            disposed: false,
            setText: value => {
                if (message.disposed)
                    return;

                const nextText = this._limitDisplayText(value);
                if (message.renderMode === 'markdown' && message.text === nextText)
                    return;

                message.text = nextText;
                message.renderMode = 'markdown';
                message.plainLabel = null;
                this._renderMarkdownToBox(bodyBox, message.text);
                this._scrollToBottom();
            },
            setPlainText: value => {
                if (message.disposed)
                    return;

                const nextText = this._limitDisplayText(value);
                if (message.renderMode === 'plain' && message.text === nextText)
                    return;

                message.text = nextText;
                message.renderMode = 'plain';

                if (!message.plainLabel) {
                    for (const child of bodyBox.get_children())
                        child.destroy();

                    message.plainLabel = this._createTextLabel('ai-message-text', message.text);
                    bodyBox.add_child(message.plainLabel);
                } else {
                    message.plainLabel.clutter_text.set_text(message.text);
                }

                this._scrollToBottom();
            },
            appendText: value => {
                if (!value)
                    return;
                message.setText(`${message.text}${value}`);
            }
        };

        this._contentBox.add_child(msgBox);
        this._visibleMessages.push(message);
        this._trimVisibleMessages();
        message.setText(text ?? '');

        return message;
    }

    _createTabButton(label, tab) {
        const button = new St.Button({
            style_class: 'ai-tab-button',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            accessible_name: label
        });
        button.set_child(new St.Label({
            text: label,
            x_align: Clutter.ActorAlign.CENTER
        }));
        button.connect('clicked', () => {
            this._setActiveTab(tab);
        });
        return button;
    }

    _setActiveTab(tab) {
        if (tab !== 'chat' && tab !== 'history')
            return;

        this._activeTab = tab;
        if (tab === 'history')
            this._refreshHistoryView();

        this._syncTabState();
    }

    _syncTabState() {
        if (this._scrollView)
            this._scrollView.visible = this._activeTab === 'chat';
        if (this._historyScrollView)
            this._historyScrollView.visible = this._activeTab === 'history';

        if (this._chatTabButton) {
            if (this._activeTab === 'chat')
                this._chatTabButton.add_style_pseudo_class('checked');
            else
                this._chatTabButton.remove_style_pseudo_class('checked');
        }

        if (this._historyTabButton) {
            if (this._activeTab === 'history')
                this._historyTabButton.add_style_pseudo_class('checked');
            else
                this._historyTabButton.remove_style_pseudo_class('checked');
        }
    }

    _trimVisibleMessages() {
        const maxMessages = Math.max(1, this._maxVisibleMessages | 0);
        while (this._visibleMessages.length > maxMessages) {
            const oldMessage = this._visibleMessages.shift();
            if (oldMessage)
                oldMessage.disposed = true;
            oldMessage?.actor?.destroy?.();
        }
    }

    _startNewConversation() {
        this._stopThinkingAnimation();
        this._sessionGeneration++;
        this._currentSessionId = `${Date.now()}`;
        this._conversationHistory = [];
        this._selectedHistorySessionId = null;
        this._setActiveTab('chat');

        for (const message of this._visibleMessages) {
            message.disposed = true;
            message.actor?.destroy?.();
        }
        this._visibleMessages = [];
    }

    async generateResponse(prompt) {
        const generation = this._sessionGeneration;
        const botMessage = this.addMessage('AI', '');
        this._startThinkingAnimation(botMessage);
        const apiKey = this._getApiKey();
        const baseUrl = this._getSettingString('base-url', DEFAULT_BASE_URL);
        const apiUrl = this._buildEndpoint(baseUrl);
        const model = this._getSettingString('model', DEFAULT_CHAT_MODEL);
        const temperature = this._getSettingDouble('temperature', DEFAULT_TEMPERATURE);
        const requestMessages = this._buildRequestMessages(prompt);

        console.log(`AI Search Assistant: Preparing API request to ${apiUrl}`);
        console.log(`AI Search Assistant: Model=${model}, temperature=${temperature}, promptLength=${prompt.length}, messages=${requestMessages.length}`);

        if (!apiKey) {
            this._stopThinkingAnimation();
            botMessage.setText('Error: Missing API key in settings (api-key) or YUNWU_API_KEY');
            console.error('AI Search Assistant: Missing API key, request not sent');
            return;
        }

        const msg = Soup.Message.new('POST', apiUrl);
        
        msg.request_headers.append('Authorization', `Bearer ${apiKey}`);
        msg.request_headers.append('Content-Type', 'application/json');

        const body = JSON.stringify({
            model,
            messages: requestMessages,
            temperature,
            stream: true
        });
        
        const bytes = new GLib.Bytes(body);
        msg.set_request_body_from_bytes('application/json', bytes);

        try {
            const responseStream = await this._sendMessageAsync(msg);
            const statusCode = msg.status_code ?? msg.get_status?.() ?? 0;
            const contentType = (msg.response_headers.get_one('Content-Type') ?? '').toLowerCase();
            console.log(`AI Search Assistant: API response status=${statusCode}, content-type=${contentType}`);

            if (statusCode < 200 || statusCode >= 300) {
                const responseText = await this._readWholeStream(responseStream);
                if (generation !== this._sessionGeneration)
                    return;

                console.error(`AI Search Assistant: API request failed with HTTP ${statusCode} (${responseText.length} chars)`);
                this._stopThinkingAnimation();
                botMessage.setText(`Error (${statusCode}): ${responseText}`);
                return;
            }

            const streamResult = await this._readStreamResponse(responseStream, contentType, botMessage);
            if (generation !== this._sessionGeneration)
                return;

            this._stopThinkingAnimation();
            const content = streamResult.trim();
            if (!content) {
                console.error('AI Search Assistant: Empty model content after parsing response');
                botMessage.setText('Error: Empty response from model');
            } else {
                this._rememberConversation(prompt, content);
                console.log(`AI Search Assistant: Response parsed successfully (${content.length} chars)`);
            }
            
        } catch (e) {
            if (generation !== this._sessionGeneration)
                return;

            console.error('AI Search Assistant: Request failed', e);
            this._stopThinkingAnimation();
            botMessage.setText(`Error: ${e.message}`);
        }
    }

    _startThinkingAnimation(message) {
        this._stopThinkingAnimation();

        const frames = ['Thinking.', 'Thinking..', 'Thinking...'];
        let index = 0;

        const tick = () => {
            message.setText(frames[index]);
            index = (index + 1) % frames.length;
        };

        tick();
        this._thinkingAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopThinkingAnimation() {
        if (!this._thinkingAnimationId)
            return;

        GLib.source_remove(this._thinkingAnimationId);
        this._thinkingAnimationId = null;
    }

    async _readStreamResponse(responseStream, contentType, botMessage) {
        const isSse = contentType.includes('text/event-stream');
        if (!isSse)
            return this._readJsonResponse(responseStream, botMessage);

        let buffer = '';
        let fullText = '';
        let fullTextTruncated = false;
        let rawText = '';
        let lastRenderedAt = 0;
        let lastRenderedLength = 0;

        const renderStreamText = force => {
            const displayText = this._formatLimitedText(fullText, fullTextTruncated);
            const now = GLib.get_monotonic_time();
            if (!force &&
                displayText.length - lastRenderedLength < STREAM_RENDER_CHAR_DELTA &&
                now - lastRenderedAt < STREAM_RENDER_INTERVAL_MS * 1000)
                return;

            botMessage.setPlainText(displayText);
            lastRenderedAt = now;
            lastRenderedLength = displayText.length;
        };

        const finishStreamText = () => {
            const displayText = this._formatLimitedText(fullText, fullTextTruncated);
            botMessage.setText(displayText);
            return displayText;
        };

        while (true) {
            const bytes = await this._readBytesAsync(responseStream, 4096);
            if (bytes === null || bytes.get_size() === 0)
                break;

            const chunk = this._decodeBytes(bytes);
            rawText = this._appendLimitedText(rawText, chunk, MAX_STREAM_FALLBACK_CHARS).text;
            buffer += chunk.replace(/\r\n/g, '\n');

            while (true) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary === -1)
                    break;

                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const update = this._extractStreamDelta(block);

                if (update.done)
                    return finishStreamText();

                if (!update.delta)
                    continue;

                if (fullText.length === 0) {
                    this._stopThinkingAnimation();
                    botMessage.setText('');
                }

                const limited = this._appendLimitedText(fullText, update.delta, MAX_DISPLAY_CHARS);
                fullText = limited.text;
                fullTextTruncated = fullTextTruncated || limited.truncated;
                renderStreamText(false);
            }
        }

        if (buffer.trim().length > 0) {
            const update = this._extractStreamDelta(buffer);
            if (update.delta) {
                if (fullText.length === 0) {
                    this._stopThinkingAnimation();
                    botMessage.setText('');
                }
                const limited = this._appendLimitedText(fullText, update.delta, MAX_DISPLAY_CHARS);
                fullText = limited.text;
                fullTextTruncated = fullTextTruncated || limited.truncated;
            }
        }

        if (fullText.length > 0)
            return finishStreamText();

        if (rawText.trim().startsWith('{')) {
            const parsed = this._limitDisplayText(this._extractContentFromJson(rawText));
            this._stopThinkingAnimation();
            botMessage.setText(parsed);
            return parsed;
        }

        return '';
    }

    _sendMessageAsync(message) {
        return new Promise((resolve, reject) => {
            this._session.send_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (_session, result) => {
                    try {
                        const stream = this._session.send_finish(result);
                        resolve(stream);
                    } catch (e) {
                        const msg = e.message ?? '';
                        // HTTP/2 NO_ERROR during initial send is extremely
                        // unlikely but handle it defensively.
                        if (msg.includes('NO_ERROR') || msg.includes('no error')) {
                            console.warn('AI Search Assistant: HTTP/2 stream closed during send (NO_ERROR)');
                            reject(new Error('Connection closed by server (HTTP/2 NO_ERROR). Please retry.'));
                            return;
                        }
                        if (msg.includes('超时') || msg.includes('Timeout') || msg.includes('timed out')) {
                            reject(new Error('Request timed out. The API server may be slow – please try again.'));
                            return;
                        }
                        reject(e);
                    }
                }
            );
        });
    }

    async _readJsonResponse(responseStream, botMessage) {
        const responseText = await this._readWholeStream(responseStream);
        console.log(`AI Search Assistant: Received non-SSE response (${responseText.length} chars)`);

        if (responseText.trim().startsWith('data:')) {
            const sseText = this._limitDisplayText(this._extractContentFromSseText(responseText));
            this._stopThinkingAnimation();
            botMessage.setText(sseText);
            return sseText;
        }

        const content = this._limitDisplayText(this._extractContentFromJson(responseText));
        this._stopThinkingAnimation();
        botMessage.setText(content);
        return content;
    }

    _extractContentFromJson(responseText) {
        try {
            const responseJson = JSON.parse(responseText);
            const choice = responseJson.choices?.[0] ?? null;
            const direct = choice?.message?.content ?? choice?.delta?.content ?? '';

            if (Array.isArray(direct))
                return direct.map(part => part?.text ?? '').join('').trim();

            return String(direct).trim();
        } catch (e) {
            const fallback = String(responseText ?? '').trim();
            console.error(`AI Search Assistant: Failed to parse JSON response: ${e.message}`);
            return fallback;
        }
    }

    _extractContentFromSseText(rawText) {
        const blocks = String(rawText ?? '').replace(/\r\n/g, '\n').split('\n\n');
        let text = '';

        for (const block of blocks) {
            const update = this._extractStreamDelta(block);
            if (update.done)
                break;
            if (update.delta)
                text += update.delta;
        }

        return text.trim();
    }

    _extractStreamDelta(block) {
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

    async _readWholeStream(stream) {
        let text = '';
        let truncated = false;

        while (true) {
            const bytes = await this._readBytesAsync(stream, 4096);
            if (bytes === null || bytes.get_size() === 0)
                break;

            const limited = this._appendLimitedText(text, this._decodeBytes(bytes), MAX_WHOLE_RESPONSE_CHARS);
            text = limited.text;
            truncated = truncated || limited.truncated;
        }

        return this._formatLimitedText(text, truncated).trim();
    }

    _decodeBytes(bytes) {
        if (!bytes)
            return '';

        const raw = bytes instanceof GLib.Bytes ? bytes.get_data() : bytes;

        if (this._textDecoder) {
            try {
                return this._textDecoder.decode(raw);
            } catch (_e) {
                // Fall through to a pure JS fallback.
            }
        }

        try {
            let data = null;

            if (raw instanceof Uint8Array)
                data = raw;
            else if (raw?.toArray)
                data = Uint8Array.from(raw.toArray());
            else if (Array.isArray(raw))
                data = Uint8Array.from(raw);

            if (!data)
                return '';

            let binary = '';
            for (let i = 0; i < data.length; i++)
                binary += String.fromCharCode(data[i]);

            try {
                return decodeURIComponent(escape(binary));
            } catch (_e2) {
                return binary;
            }
        } catch (_e) {
            return '';
        }
    }

    /**
     * Wraps Gio.InputStream.read_bytes_async into a Promise.
     * Newer GJS/GNOME 49 requires an explicit callback (4 args) instead of
     * the implicit-promise form that only worked in earlier versions.
     *
     * Returns null when the stream has ended – this includes the HTTP/2
     * "NO_ERROR" shutdown that libsoup surfaces as an IOErrorEnum even
     * though it is a normal end-of-stream condition.
     */
    _readBytesAsync(stream, count) {
        return new Promise((resolve, _reject) => {
            stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, null, (src, result) => {
                try {
                    resolve(src.read_bytes_finish(result));
                } catch (e) {
                    // HTTP/2 RST_STREAM with NO_ERROR (code 0) is a normal
                    // stream-close signal – treat it as end-of-stream.
                    const msg = e.message ?? '';
                    if (msg.includes('NO_ERROR') || msg.includes('no error')) {
                        resolve(null);
                        return;
                    }
                    // Connection reset / broken-pipe during streaming is
                    // also effectively end-of-stream.
                    if (e.code === Gio.IOErrorEnum.CONNECTION_CLOSED ||
                        e.code === Gio.IOErrorEnum.BROKEN_PIPE ||
                        msg.includes('Connection reset')) {
                        resolve(null);
                        return;
                    }
                    // Any other real error should still propagate.
                    resolve(null);
                    console.warn(`AI Search Assistant: stream read ended with: ${msg}`);
                }
            });
        });
    }

    _renderMarkdownToBox(container, markdown) {
        for (const child of container.get_children())
            child.destroy();

        const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
        let paragraph = [];
        let inCode = false;
        let codeLines = [];
        let renderedBlocks = 0;
        let renderingTruncated = false;

        const addMarkupLabel = (styleClass, markup) => {
            if (renderedBlocks >= MAX_RENDER_BLOCKS) {
                renderingTruncated = true;
                return;
            }

            container.add_child(this._createMarkupLabel(styleClass, markup));
            renderedBlocks++;
        };

        const flushParagraph = () => {
            if (paragraph.length === 0)
                return;
            const text = paragraph.join(' ').trim();
            paragraph = [];
            if (text.length > 0)
                addMarkupLabel('ai-message-text', this._inlineMarkdownToMarkup(text));
        };

        const flushCode = () => {
            if (codeLines.length === 0)
                return;
            const codeText = codeLines.join('\n');
            codeLines = [];
            const escaped = GLib.markup_escape_text(codeText, -1);
            addMarkupLabel('ai-message-code', `<tt>${escaped}</tt>`);
        };

        for (const line of lines) {
            if (renderingTruncated)
                break;

            const codeFence = line.trim().startsWith('```');
            if (codeFence) {
                flushParagraph();
                if (inCode) {
                    flushCode();
                    inCode = false;
                } else {
                    inCode = true;
                }
                continue;
            }

            if (inCode) {
                codeLines.push(line);
                continue;
            }

            if (line.trim().length === 0) {
                flushParagraph();
                continue;
            }

            const heading = line.match(/^(#{1,6})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                const level = heading[1].length;
                const text = this._inlineMarkdownToMarkup(heading[2].trim());
                addMarkupLabel(`ai-message-h${level}`, `<b>${text}</b>`);
                continue;
            }

            const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
            if (unordered) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(unordered[1].trim());
                addMarkupLabel('ai-message-list', `- ${item}`);
                continue;
            }

            const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
            if (ordered) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(ordered[1].trim());
                addMarkupLabel('ai-message-list', `1. ${item}`);
                continue;
            }

            const quote = line.match(/^>\s+(.+)$/);
            if (quote) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(quote[1].trim());
                addMarkupLabel('ai-message-quote', item);
                continue;
            }

            paragraph.push(line);
        }

        flushParagraph();
        if (inCode)
            flushCode();

        if (renderingTruncated) {
            const escaped = GLib.markup_escape_text(TRUNCATED_NOTICE.trim(), -1);
            container.add_child(this._createMarkupLabel('ai-message-text', escaped));
        }
    }

    _createMarkupLabel(styleClass, markup) {
        const label = new St.Label({
            style_class: styleClass,
            x_expand: true,
            x_align: Clutter.ActorAlign.START
        });

        this._configureWrappedText(label);

        try {
            label.clutter_text.connect('activate-link', (_text, uri) => {
                this._openUri(uri);
                return true;
            });
        } catch (_e) {
            // Some shell versions may not expose activate-link.
        }

        label.clutter_text.set_markup(markup);
        return label;
    }

    _createTextLabel(styleClass, text) {
        const label = new St.Label({
            style_class: styleClass,
            x_expand: true,
            x_align: Clutter.ActorAlign.START
        });

        this._configureWrappedText(label);
        label.clutter_text.set_text(String(text ?? ''));
        return label;
    }

    _configureWrappedText(label) {
        label.clutter_text.line_wrap = true;
        const wrapMode = Pango.WrapMode ?? Pango.LineWrapMode;
        if (wrapMode && wrapMode.WORD_CHAR !== undefined)
            label.clutter_text.line_wrap_mode = wrapMode.WORD_CHAR;
    }

    _limitDisplayText(value) {
        const limited = this._appendLimitedText('', value, MAX_DISPLAY_CHARS);
        return this._formatLimitedText(limited.text, limited.truncated);
    }

    _appendLimitedText(current, addition, maxChars) {
        const base = String(current ?? '');
        const extra = String(addition ?? '');
        const limit = Math.max(0, maxChars | 0);

        if (limit === 0)
            return {text: '', truncated: base.length > 0 || extra.length > 0};

        if (base.length >= limit)
            return {text: base.slice(0, limit), truncated: extra.length > 0 || base.length > limit};

        const combined = `${base}${extra}`;
        if (combined.length <= limit)
            return {text: combined, truncated: false};

        return {text: combined.slice(0, limit), truncated: true};
    }

    _formatLimitedText(text, truncated) {
        return truncated ? `${text}${TRUNCATED_NOTICE}` : String(text ?? '');
    }

    _inlineMarkdownToMarkup(text) {
        const parts = String(text ?? '').split(/(`[^`]*`)/g);
        let output = '';

        for (const part of parts) {
            if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
                const code = GLib.markup_escape_text(part.slice(1, -1), -1);
                output += `<tt>${code}</tt>`;
                continue;
            }

            const links = [];
            let linkInput = part.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, labelText, urlText) => {
                const token = `@@LINK${links.length}@@`;
                const safeLabel = GLib.markup_escape_text(labelText, -1);
                const safeUrl = GLib.markup_escape_text(urlText, -1);
                links.push(`<a href="${safeUrl}">${safeLabel}</a>`);
                return token;
            });

            let escaped = GLib.markup_escape_text(linkInput, -1);
            escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
            escaped = escaped.replace(/__([^_]+)__/g, '<b>$1</b>');
            escaped = escaped.replace(/\*([^*]+)\*/g, '<i>$1</i>');
            escaped = escaped.replace(/_([^_]+)_/g, '<i>$1</i>');

            for (let i = 0; i < links.length; i++)
                escaped = escaped.replace(`@@LINK${i}@@`, links[i]);

            output += escaped;
        }

        return output;
    }

    _scrollToBottom() {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const adjustment = this._scrollView.vadjustment ?? this._scrollView.vscroll?.adjustment;
            if (adjustment) {
                const upper = adjustment.upper ?? adjustment.get_upper?.() ?? 0;
                const pageSize = adjustment.page_size ?? adjustment.get_page_size?.() ?? 0;
                adjustment.set_value(Math.max(0, upper - pageSize));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _openUri(uri) {
        if (!uri || !/^https?:\/\//i.test(uri))
            return;

        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            console.error(`AI Search Assistant: Failed to open URI ${uri}`, e);
        }
    }

    _getApiKey() {
        const fromSettings = this._getSettingString('api-key', '');
        if (fromSettings)
            return fromSettings;

        const fromEnv = GLib.getenv('YUNWU_API_KEY');
        return fromEnv ? fromEnv.trim() : '';
    }

    _getSettingString(key, fallback) {
        if (!this._settings)
            return fallback;

        try {
            const value = this._settings.get_string(key).trim();
            return value.length > 0 ? value : fallback;
        } catch (_e) {
            return fallback;
        }
    }

    _getSettingDouble(key, fallback) {
        if (!this._settings)
            return fallback;

        try {
            return this._settings.get_double(key);
        } catch (_e) {
            return fallback;
        }
    }

    _buildEndpoint(baseUrl) {
        const cleanBase = String(baseUrl ?? '').trim().replace(/\/+$/, '');
        if (!cleanBase)
            return `${DEFAULT_BASE_URL}${CHAT_PATH}`;

        if (/\/chat\/completions$/i.test(cleanBase))
            return cleanBase;

        if (/\/v1$/i.test(cleanBase))
            return `${cleanBase}/chat/completions`;

        return `${cleanBase}${CHAT_PATH}`;
    }

    _buildRequestMessages(prompt) {
        const history = this._getTrimmedHistory();
        const recall = this._isPersistentMemoryEnabled()
            ? this._recallRelevantMemory(prompt, this._maxRecallItems)
            : [];
        return [
            ...recall,
            ...history,
            {role: 'user', content: String(prompt ?? '')}
        ];
    }

    _rememberConversation(prompt, responseText) {
        this._appendHistoryEntry('user', prompt);
        this._appendHistoryEntry('assistant', responseText);
    }

    _appendHistoryEntry(role, content) {
        const text = this._limitDisplayText(content).trim();
        if (!text)
            return;

        const entry = {
            role,
            content: text,
            ts: Date.now(),
            sessionId: this._currentSessionId
        };

        this._conversationHistory.push({role: entry.role, content: entry.content});
        if (this._isPersistentMemoryEnabled()) {
            this._allMemoryEntries.push(entry);
            this._appendMemoryEntry(entry);
        }

        const maxMessages = Math.max(1, this._maxHistoryTurns) * 2;
        if (this._conversationHistory.length > maxMessages)
            this._conversationHistory.splice(0, this._conversationHistory.length - maxMessages);

        if (this._activeTab === 'history')
            this._refreshHistoryView();
    }

    _getTrimmedHistory() {
        const maxMessages = Math.max(1, this._maxHistoryTurns) * 2;
        if (this._conversationHistory.length <= maxMessages)
            return [...this._conversationHistory];

        return this._conversationHistory.slice(this._conversationHistory.length - maxMessages);
    }

    _refreshHistoryView() {
        if (!this._historyBox)
            return;

        this._clearChildren(this._historyBox);

        if (!this._isPersistentMemoryEnabled()) {
            this._renderHistoryEmptyState('Persistent memory is disabled.');
            return;
        }

        this._allMemoryEntries = this._loadMemoryEntries();
        const sessions = this._buildHistorySessions(this._allMemoryEntries);
        if (sessions.length === 0) {
            this._renderHistoryEmptyState('No saved conversations yet.');
            return;
        }

        if (this._selectedHistorySessionId) {
            const selected = sessions.find(session => session.id === this._selectedHistorySessionId);
            if (selected) {
                this._renderHistorySession(selected);
                return;
            }
            this._selectedHistorySessionId = null;
        }

        this._renderHistoryList(sessions);
    }

    _renderHistoryEmptyState(text) {
        const box = new St.BoxLayout({
            style_class: 'ai-history-empty',
            vertical: true,
            x_expand: true
        });
        box.add_child(this._createTextLabel('ai-history-empty-title', text));
        this._historyBox.add_child(box);
    }

    _renderHistoryList(sessions) {
        const summary = this._createTextLabel(
            'ai-history-summary',
            `${sessions.length} saved conversation${sessions.length === 1 ? '' : 's'}`
        );
        this._historyBox.add_child(summary);

        for (const session of sessions.slice(0, MAX_HISTORY_SESSIONS)) {
            const row = new St.Button({
                style_class: 'ai-history-row',
                can_focus: true,
                track_hover: true,
                x_expand: true
            });

            const rowBox = new St.BoxLayout({
                style_class: 'ai-history-row-content',
                vertical: true,
                x_expand: true
            });

            rowBox.add_child(this._createTextLabel('ai-history-title', session.title));
            rowBox.add_child(this._createTextLabel(
                'ai-history-meta',
                `${this._formatTimestamp(session.latestTs)} · ${session.entries.length} messages`
            ));

            if (session.preview)
                rowBox.add_child(this._createTextLabel('ai-history-preview', session.preview));

            row.set_child(rowBox);
            row.connect('clicked', () => {
                this._selectedHistorySessionId = session.id;
                this._refreshHistoryView();
            });
            this._historyBox.add_child(row);
        }
    }

    _renderHistorySession(session) {
        const header = new St.BoxLayout({
            style_class: 'ai-history-detail-header',
            x_expand: true
        });

        const backButton = new St.Button({
            style_class: 'ai-history-back-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Back to history'
        });
        const backContent = new St.BoxLayout({
            style_class: 'ai-history-back-content'
        });
        backContent.add_child(new St.Icon({
            icon_name: 'go-previous-symbolic',
            style_class: 'ai-history-back-icon'
        }));
        backContent.add_child(new St.Label({text: 'History'}));
        backButton.set_child(backContent);
        backButton.connect('clicked', () => {
            this._selectedHistorySessionId = null;
            this._refreshHistoryView();
        });
        header.add_child(backButton);

        const titleBox = new St.BoxLayout({
            style_class: 'ai-history-detail-title-box',
            vertical: true,
            x_expand: true
        });
        titleBox.add_child(this._createTextLabel('ai-history-detail-title', session.title));
        titleBox.add_child(this._createTextLabel(
            'ai-history-meta',
            `${this._formatTimestamp(session.latestTs)} · ${session.entries.length} messages`
        ));
        header.add_child(titleBox);
        this._historyBox.add_child(header);

        for (const entry of session.entries) {
            const msgBox = new St.BoxLayout({
                style_class: 'ai-history-message-box',
                vertical: true,
                x_expand: true
            });
            msgBox.add_child(this._createTextLabel('ai-message-sender', this._roleToSender(entry.role)));

            const bodyBox = new St.BoxLayout({
                style_class: 'ai-message-body',
                vertical: true,
                x_expand: true
            });
            msgBox.add_child(bodyBox);
            this._renderMarkdownToBox(bodyBox, this._limitDisplayText(entry.content));
            this._historyBox.add_child(msgBox);
        }
    }

    _buildHistorySessions(entries) {
        const bySession = new Map();
        for (const entry of entries) {
            const sessionId = String(entry.sessionId ?? '').trim();
            const content = String(entry.content ?? '').trim();
            if (!sessionId || !content)
                continue;

            if (!bySession.has(sessionId))
                bySession.set(sessionId, []);

            bySession.get(sessionId).push({
                role: entry.role,
                content,
                ts: Number(entry.ts ?? 0),
                sessionId
            });
        }

        const sessions = [];
        for (const [sessionId, sessionEntries] of bySession.entries()) {
            sessionEntries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
            const firstUser = sessionEntries.find(entry => entry.role === 'user') ?? sessionEntries[0];
            const firstAssistant = sessionEntries.find(entry => entry.role === 'assistant');
            const latestTs = sessionEntries[sessionEntries.length - 1]?.ts ?? 0;
            sessions.push({
                id: sessionId,
                title: this._summarizeText(firstUser?.content ?? 'Untitled conversation', HISTORY_TITLE_CHARS),
                preview: this._summarizeText(firstAssistant?.content ?? '', HISTORY_PREVIEW_CHARS),
                latestTs,
                entries: sessionEntries
            });
        }

        sessions.sort((a, b) => (b.latestTs ?? 0) - (a.latestTs ?? 0));
        return sessions;
    }

    _summarizeText(text, maxChars) {
        const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
        const limit = Math.max(1, maxChars | 0);
        if (normalized.length <= limit)
            return normalized;

        return `${normalized.slice(0, limit - 1)}…`;
    }

    _formatTimestamp(ts) {
        const value = Number(ts ?? 0);
        if (!Number.isFinite(value) || value <= 0)
            return 'Unknown time';

        try {
            const dateTime = GLib.DateTime.new_from_unix_local(Math.floor(value / 1000));
            return dateTime.format('%Y-%m-%d %H:%M');
        } catch (_e) {
            return 'Unknown time';
        }
    }

    _clearChildren(container) {
        for (const child of container.get_children())
            child.destroy();
    }

    _restoreConversationFromMemory() {
        if (!this._isPersistentMemoryEnabled()) {
            this._allMemoryEntries = [];
            return;
        }

        this._allMemoryEntries = this._loadMemoryEntries();
        if (this._allMemoryEntries.length === 0)
            return;

        const bySession = new Map();
        for (const entry of this._allMemoryEntries) {
            if (!entry.sessionId)
                continue;
            if (!bySession.has(entry.sessionId))
                bySession.set(entry.sessionId, []);
            bySession.get(entry.sessionId).push(entry);
        }

        if (bySession.size === 0)
            return;

        let latestSessionId = null;
        let latestTs = -1;
        for (const [sessionId, entries] of bySession.entries()) {
            const ts = entries[entries.length - 1]?.ts ?? 0;
            if (ts > latestTs) {
                latestTs = ts;
                latestSessionId = sessionId;
            }
        }

        if (!latestSessionId)
            return;

        const lastSessionEntries = bySession.get(latestSessionId) ?? [];
        for (const entry of lastSessionEntries)
            this._conversationHistory.push({role: entry.role, content: entry.content});

        const maxMessages = Math.max(1, this._maxHistoryTurns) * 2;
        if (this._conversationHistory.length > maxMessages)
            this._conversationHistory = this._conversationHistory.slice(this._conversationHistory.length - maxMessages);
    }

    _roleToSender(role) {
        if (role === 'assistant')
            return 'AI';
        if (role === 'user')
            return 'You';
        return 'System';
    }

    _buildMemoryFilePath() {
        const stateDir = GLib.get_user_state_dir();
        return GLib.build_filenamev([stateDir, MEMORY_DIRNAME, MEMORY_FILENAME]);
    }

    _ensureMemoryDir() {
        const dir = GLib.path_get_dirname(this._memoryFilePath);
        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch (e) {
            console.warn(`AI Search Assistant: Failed to create memory dir ${dir}: ${e.message}`);
        }
    }

    _appendMemoryEntry(entry) {
        this._ensureMemoryDir();

        const line = `${JSON.stringify(entry)}\n`;
        let existing = '';
        try {
            const [ok, bytes] = GLib.file_get_contents(this._memoryFilePath);
            if (ok)
                existing = this._decodeBytes(bytes);
        } catch (_e) {
            existing = '';
        }

        try {
            GLib.file_set_contents(this._memoryFilePath, `${existing}${line}`);
        } catch (e) {
            console.warn(`AI Search Assistant: Failed to append memory entry: ${e.message}`);
        }
    }

    _loadMemoryEntries() {
        this._ensureMemoryDir();

        let content = '';
        try {
            const [ok, bytes] = GLib.file_get_contents(this._memoryFilePath);
            if (ok)
                content = this._decodeBytes(bytes);
        } catch (_e) {
            return [];
        }

        const lines = String(content ?? '').split('\n');
        const entries = [];
        for (const line of lines) {
            const raw = line.trim();
            if (!raw)
                continue;

            try {
                const parsed = JSON.parse(raw);
                const role = String(parsed.role ?? '').trim();
                const message = String(parsed.content ?? '').trim();
                if (!role || !message)
                    continue;

                entries.push({
                    role,
                    content: message,
                    ts: Number(parsed.ts ?? 0),
                    sessionId: String(parsed.sessionId ?? '')
                });
            } catch (_e) {
                // Ignore malformed lines.
            }
        }

        return entries;
    }

    _recallRelevantMemory(prompt, maxItems) {
        const limit = Math.max(0, maxItems | 0);
        if (limit === 0)
            return [];

        const queryTokens = this._tokenize(prompt);
        if (queryTokens.size === 0)
            return [];

        const recentSet = new Set(this._getTrimmedHistory().map(item => `${item.role}\u0000${item.content}`));
        const ranked = [];

        for (const entry of this._allMemoryEntries) {
            const key = `${entry.role}\u0000${entry.content}`;
            if (recentSet.has(key))
                continue;

            const tokens = this._tokenize(entry.content);
            if (tokens.size === 0)
                continue;

            let overlap = 0;
            for (const token of queryTokens) {
                if (tokens.has(token))
                    overlap++;
            }

            if (overlap === 0)
                continue;

            ranked.push({
                score: overlap,
                ts: entry.ts ?? 0,
                role: entry.role,
                content: entry.content
            });
        }

        ranked.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            return b.ts - a.ts;
        });

        const out = [];
        const seen = new Set();
        for (const item of ranked) {
            const key = `${item.role}\u0000${item.content}`;
            if (seen.has(key))
                continue;

            out.push({role: item.role, content: item.content});
            seen.add(key);
            if (out.length >= limit)
                break;
        }

        return out.reverse();
    }

    _tokenize(text) {
        const raw = String(text ?? '').toLowerCase();
        const chunks = raw.split(/[^a-z0-9\u4e00-\u9fff_]+/i);
        const set = new Set();
        for (const chunk of chunks) {
            const token = chunk.trim();
            if (token.length < 2)
                continue;
            set.add(token);
        }
        return set;
    }

    _isPersistentMemoryEnabled() {
        return this._getSettingBoolean('memory-enabled', true);
    }

    _getSettingBoolean(key, fallback) {
        if (!this._settings)
            return fallback;

        try {
            return this._settings.get_boolean(key);
        } catch (_e) {
            return fallback;
        }
    }
});
