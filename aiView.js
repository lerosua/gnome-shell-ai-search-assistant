import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

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
        
        const textLabel = new St.Label({
            text: text,
            style_class: 'ai-message-text'
        });

        textLabel.clutter_text.line_wrap = true;
        const wrapMode = Pango.WrapMode ?? Pango.LineWrapMode;
        if (wrapMode && wrapMode.WORD_CHAR !== undefined)
            textLabel.clutter_text.line_wrap_mode = wrapMode.WORD_CHAR;

        msgBox.add_child(senderLabel);
        msgBox.add_child(textLabel);
        this._contentBox.add_child(msgBox);
        
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

        return textLabel; // Return label for updates
    }

    async generateResponse(prompt) {
        const botLabel = this.addMessage('AI', 'Thinking...');
        const apiKey = this._getApiKey();
        const baseUrl = this._getSettingString('base-url', DEFAULT_BASE_URL);
        const apiUrl = this._buildEndpoint(baseUrl);
        const model = this._getSettingString('model', DEFAULT_CHAT_MODEL);
        const temperature = this._getSettingDouble('temperature', DEFAULT_TEMPERATURE);

        if (!apiKey) {
            botLabel.set_text('Error: Missing API key in settings (api-key) or YUNWU_API_KEY');
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
            temperature
        });
        
        const bytes = new GLib.Bytes(body);
        msg.set_request_body_from_bytes('application/json', bytes);

        try {
            const responseBytes = await this._session.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                null
            );
            const statusCode = msg.status_code ?? msg.get_status?.() ?? 0;
            const responseText = new TextDecoder('utf-8').decode(responseBytes.get_data());

            if (statusCode < 200 || statusCode >= 300) {
                botLabel.set_text(`Error (${statusCode}): ${responseText}`);
                return;
            }

            const responseJson = JSON.parse(responseText);
            const content = responseJson.choices?.[0]?.message?.content?.trim();

            if (!content) {
                botLabel.set_text('Error: Empty response from model');
                return;
            }

            botLabel.set_text(content);
            
        } catch (e) {
            botLabel.set_text(`Error: ${e.message}`);
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
