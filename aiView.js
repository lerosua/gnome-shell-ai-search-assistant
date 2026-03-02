import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DEFAULT_BASE_URL = 'https://yunwu.ai';
const CHAT_PATH = '/v1/chat/completions';
const DEFAULT_CHAT_MODEL = 'gpt-3.5-turbo';
const DEFAULT_TEMPERATURE = 0.7;

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

        this._settings = settings;
        this._session = new Soup.Session();

        // Header
        this._header = new St.Label({
            text: 'AI Assistant',
            style_class: 'ai-view-header',
            x_align: Clutter.ActorAlign.CENTER
        });
        this.add_child(this._header);

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

        // Add a welcome message
        this.addMessage('System', 'Hello! Click the search button to toggle AI mode.');
    }

    addMessage(sender, text) {
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

        this._contentBox.add_child(msgBox);

        const message = {
            sender,
            bodyBox,
            text: '',
            setText: value => {
                message.text = value ?? '';
                this._renderMarkdownToBox(bodyBox, message.text);
            },
            appendText: value => {
                if (!value)
                    return;
                message.text += value;
                this._renderMarkdownToBox(bodyBox, message.text);
            }
        };

        message.setText(text ?? '');

        // Scroll to bottom
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
             const adjustment = this._scrollView.vadjustment ?? this._scrollView.vscroll?.adjustment;
             if (adjustment) {
                 const upper = adjustment.upper ?? adjustment.get_upper?.() ?? 0;
                 const pageSize = adjustment.page_size ?? adjustment.get_page_size?.() ?? 0;
                 adjustment.set_value(Math.max(0, upper - pageSize));
             }
             return GLib.SOURCE_REMOVE;
        });

        return message;
    }

    async generateResponse(prompt) {
        const botMessage = this.addMessage('AI', 'Thinking...');
        const apiKey = this._getApiKey();
        const baseUrl = this._getSettingString('base-url', DEFAULT_BASE_URL);
        const apiUrl = this._buildEndpoint(baseUrl);
        const model = this._getSettingString('model', DEFAULT_CHAT_MODEL);
        const temperature = this._getSettingDouble('temperature', DEFAULT_TEMPERATURE);

        if (!apiKey) {
            botMessage.setText('Error: Missing API key in settings (api-key) or YUNWU_API_KEY');
            return;
        }

        const msg = Soup.Message.new('POST', apiUrl);
        
        msg.request_headers.append('Authorization', `Bearer ${apiKey}`);
        msg.request_headers.append('Content-Type', 'application/json');

        const body = JSON.stringify({
            model,
            messages: [
                {'role': 'user', 'content': prompt}
            ],
            temperature,
            stream: true
        });
        
        const bytes = new GLib.Bytes(body);
        msg.set_request_body_from_bytes('application/json', bytes);

        try {
            const responseStream = await this._session.send_async(msg, GLib.PRIORITY_DEFAULT, null);
            const statusCode = msg.status_code ?? msg.get_status?.() ?? 0;
            const contentType = (msg.response_headers.get_one('Content-Type') ?? '').toLowerCase();

            if (statusCode < 200 || statusCode >= 300) {
                const responseText = await this._readWholeStream(responseStream);
                botMessage.setText(`Error (${statusCode}): ${responseText}`);
                return;
            }

            const streamResult = await this._readStreamResponse(responseStream, contentType, botMessage);
            const content = streamResult.trim();
            if (!content)
                botMessage.setText('Error: Empty response from model');
            
        } catch (e) {
            botMessage.setText(`Error: ${e.message}`);
        }
    }

    async _readStreamResponse(responseStream, contentType, botMessage) {
        const isSse = contentType.includes('text/event-stream');
        if (!isSse)
            return this._readJsonResponse(responseStream, botMessage);

        let buffer = '';
        let fullText = '';
        let rawText = '';
        const decoder = new TextDecoder('utf-8');

        while (true) {
            const bytes = await responseStream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
            if (bytes.get_size() === 0)
                break;

            const chunk = decoder.decode(bytes.get_data(), {stream: true});
            rawText += chunk;
            buffer += chunk.replace(/\r\n/g, '\n');

            while (true) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary === -1)
                    break;

                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const update = this._extractStreamDelta(block);

                if (update.done)
                    return fullText;

                if (!update.delta)
                    continue;

                if (fullText.length === 0)
                    botMessage.setText('');

                fullText += update.delta;
                botMessage.setText(fullText);
            }
        }

        if (buffer.trim().length > 0) {
            const update = this._extractStreamDelta(buffer);
            if (update.delta) {
                if (fullText.length === 0)
                    botMessage.setText('');
                fullText += update.delta;
                botMessage.setText(fullText);
            }
        }

        if (fullText.length > 0)
            return fullText;

        if (rawText.trim().startsWith('{')) {
            const parsed = this._extractContentFromJson(rawText);
            botMessage.setText(parsed);
            return parsed;
        }

        return '';
    }

    async _readJsonResponse(responseStream, botMessage) {
        const responseText = await this._readWholeStream(responseStream);
        const content = this._extractContentFromJson(responseText);
        botMessage.setText(content);
        return content;
    }

    _extractContentFromJson(responseText) {
        const responseJson = JSON.parse(responseText);
        const choice = responseJson.choices?.[0] ?? null;
        const direct = choice?.message?.content ?? choice?.delta?.content ?? '';

        if (Array.isArray(direct))
            return direct.map(part => part?.text ?? '').join('').trim();

        return String(direct).trim();
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
        const decoder = new TextDecoder('utf-8');
        let text = '';

        while (true) {
            const bytes = await stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
            if (bytes.get_size() === 0)
                break;
            text += decoder.decode(bytes.get_data(), {stream: true});
        }

        return text.trim();
    }

    _renderMarkdownToBox(container, markdown) {
        for (const child of container.get_children())
            child.destroy();

        const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
        let paragraph = [];
        let inCode = false;
        let codeLines = [];

        const flushParagraph = () => {
            if (paragraph.length === 0)
                return;
            const text = paragraph.join(' ').trim();
            paragraph = [];
            if (text.length > 0)
                container.add_child(this._createMarkupLabel('ai-message-text', this._inlineMarkdownToMarkup(text)));
        };

        const flushCode = () => {
            if (codeLines.length === 0)
                return;
            const codeText = codeLines.join('\n');
            codeLines = [];
            const escaped = GLib.markup_escape_text(codeText, -1);
            container.add_child(this._createMarkupLabel('ai-message-code', `<tt>${escaped}</tt>`));
        };

        for (const line of lines) {
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
                container.add_child(this._createMarkupLabel(`ai-message-h${level}`, `<b>${text}</b>`));
                continue;
            }

            const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
            if (unordered) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(unordered[1].trim());
                container.add_child(this._createMarkupLabel('ai-message-list', `- ${item}`));
                continue;
            }

            const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
            if (ordered) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(ordered[1].trim());
                container.add_child(this._createMarkupLabel('ai-message-list', `1. ${item}`));
                continue;
            }

            const quote = line.match(/^>\s+(.+)$/);
            if (quote) {
                flushParagraph();
                const item = this._inlineMarkdownToMarkup(quote[1].trim());
                container.add_child(this._createMarkupLabel('ai-message-quote', item));
                continue;
            }

            paragraph.push(line);
        }

        flushParagraph();
        if (inCode)
            flushCode();
    }

    _createMarkupLabel(styleClass, markup) {
        const label = new St.Label({
            style_class: styleClass,
            x_expand: true,
            x_align: Clutter.ActorAlign.START
        });

        label.clutter_text.line_wrap = true;
        const wrapMode = Pango.WrapMode ?? Pango.LineWrapMode;
        if (wrapMode && wrapMode.WORD_CHAR !== undefined)
            label.clutter_text.line_wrap_mode = wrapMode.WORD_CHAR;

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
        const cleanBase = baseUrl.replace(/\/+$/, '');
        return `${cleanBase}${CHAT_PATH}`;
    }
});
