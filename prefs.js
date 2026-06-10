import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MEMORY_DIRNAME = 'ai-search-assistant';
const MEMORY_FILENAME = 'chat-history.jsonl';
const PROVIDER_ENTRY_WIDTH_CHARS = 32;

export default class AiSearchAssistantPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(680, 460);

        const page = new Adw.PreferencesPage({
            title: 'Provider',
            icon_name: 'network-server-symbolic'
        });

        const group = new Adw.PreferencesGroup({
            title: 'OpenAI Compatible API',
            description: 'Configure base URL, model and credentials for chat completion requests.'
        });

        page.add(group);
        window.add(page);

        this._addEntryRow(group, settings, {
            title: 'API Key',
            subtitle: 'Bearer token for the selected provider',
            key: 'api-key',
            placeholder: 'sk-...'
        });

        this._addEntryRow(group, settings, {
            title: 'Base URL',
            subtitle: 'Example: https://yunwu.ai',
            key: 'base-url',
            placeholder: 'https://example.com'
        });

        this._addEntryRow(group, settings, {
            title: 'Model',
            subtitle: 'Example: gpt-5-mini',
            key: 'model',
            placeholder: 'gpt-5-mini'
        });

        this._addTemperatureRow(group, settings);

        const privacyGroup = new Adw.PreferencesGroup({
            title: 'Privacy',
            description: 'Control persistent memory and local chat history storage.'
        });
        page.add(privacyGroup);

        this._addMemoryToggleRow(privacyGroup, settings);
        this._addClearHistoryRow(privacyGroup);
    }

    _addEntryRow(group, settings, { title, subtitle, key, placeholder }) {
        const row = new Adw.ActionRow({
            title,
            subtitle
        });

        const entry = new Gtk.Entry({
            width_chars: PROVIDER_ENTRY_WIDTH_CHARS,
            max_width_chars: PROVIDER_ENTRY_WIDTH_CHARS,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            placeholder_text: placeholder
        });

        entry.set_text(settings.get_string(key));
        entry.connect('changed', () => {
            settings.set_string(key, entry.get_text().trim());
        });

        row.add_suffix(entry);
        row.activatable_widget = entry;
        group.add(row);
    }

    _addTemperatureRow(group, settings) {
        const row = new Adw.ActionRow({
            title: 'Temperature',
            subtitle: 'Range 0.0 to 2.0'
        });

        const adjustment = new Gtk.Adjustment({
            lower: 0.0,
            upper: 2.0,
            step_increment: 0.1,
            page_increment: 0.1,
            value: settings.get_double('temperature')
        });

        const spin = new Gtk.SpinButton({
            adjustment,
            climb_rate: 0.1,
            digits: 2,
            numeric: true,
            width_chars: 6,
            valign: Gtk.Align.CENTER
        });

        spin.connect('value-changed', () => {
            settings.set_double('temperature', spin.get_value());
        });

        row.add_suffix(spin);
        row.activatable_widget = spin;
        group.add(row);
    }

    _addMemoryToggleRow(group, settings) {
        const row = new Adw.ActionRow({
            title: 'Persistent Memory',
            subtitle: 'Store prompts and replies on disk for future sessions'
        });

        const toggle = new Gtk.Switch({
            active: settings.get_boolean('memory-enabled'),
            valign: Gtk.Align.CENTER
        });

        toggle.connect('state-set', (_widget, state) => {
            settings.set_boolean('memory-enabled', state);
            return false;
        });

        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        group.add(row);
    }

    _addClearHistoryRow(group) {
        const path = this._buildMemoryFilePath();
        const row = new Adw.ActionRow({
            title: 'Clear Stored History',
            subtitle: `Delete local chat history at ${path}`
        });

        const button = new Gtk.Button({
            label: 'Clear now',
            valign: Gtk.Align.CENTER
        });
        button.add_css_class('destructive-action');
        button.connect('clicked', () => {
            const success = this._clearHistoryFile(path);
            row.set_subtitle(success
                ? `Cleared local chat history at ${path}`
                : `No history file found at ${path}`);
        });

        row.add_suffix(button);
        row.activatable = false;
        group.add(row);
    }

    _buildMemoryFilePath() {
        const stateDir = GLib.get_user_state_dir();
        return GLib.build_filenamev([stateDir, MEMORY_DIRNAME, MEMORY_FILENAME]);
    }

    _clearHistoryFile(path) {
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return false;

            GLib.unlink(path);
            return true;
        } catch (_e) {
            return false;
        }
    }
}
