import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MEMORY_DIRNAME = 'ai-search-assistant';
const MEMORY_FILENAME = 'chat-history.jsonl';
const PROVIDER_ENTRY_WIDTH_CHARS = 32;
const TOGGLE_AI_MODE_KEYBINDING = 'toggle-ai-mode';
const SHORTCUT_RECORDING_LABEL = 'Press shortcut...';
const SHORTCUT_DISABLED_LABEL = 'Disabled';

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

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcut',
            description: 'Configure the global shortcut used to toggle AI mode.'
        });
        page.add(shortcutGroup);

        this._addShortcutRow(shortcutGroup, settings);

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

    _addShortcutRow(group, settings) {
        const row = new Adw.ActionRow({
            title: 'Toggle AI Mode',
            subtitle: 'Click the button, then press a shortcut. Backspace clears it.'
        });

        const button = new Gtk.Button({
            valign: Gtk.Align.CENTER
        });

        let recording = false;
        const updateButton = () => {
            button.set_label(recording
                ? SHORTCUT_RECORDING_LABEL
                : this._getShortcutLabel(settings));
        };

        button.connect('clicked', () => {
            recording = true;
            updateButton();
            button.grab_focus();
        });

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!recording)
                return false;

            if (keyval === Gdk.KEY_Escape) {
                recording = false;
                updateButton();
                return true;
            }

            if (keyval === Gdk.KEY_BackSpace) {
                settings.set_strv(TOGGLE_AI_MODE_KEYBINDING, []);
                recording = false;
                updateButton();
                return true;
            }

            const modifiers = state & Gtk.accelerator_get_default_mod_mask();
            if (!this._isValidShortcut(keyval, modifiers))
                return true;

            settings.set_strv(TOGGLE_AI_MODE_KEYBINDING, [
                Gtk.accelerator_name(keyval, modifiers)
            ]);
            recording = false;
            updateButton();
            return true;
        });
        button.add_controller(controller);

        settings.connect(`changed::${TOGGLE_AI_MODE_KEYBINDING}`, () => {
            if (!recording)
                updateButton();
        });
        updateButton();

        row.add_suffix(button);
        row.activatable_widget = button;
        group.add(row);
    }

    _getShortcutLabel(settings) {
        const shortcuts = settings.get_strv(TOGGLE_AI_MODE_KEYBINDING);
        const shortcut = shortcuts[0] ?? '';
        if (!shortcut)
            return SHORTCUT_DISABLED_LABEL;

        const [ok, keyval, modifiers] = Gtk.accelerator_parse(shortcut);
        if (!ok || !Gtk.accelerator_valid(keyval, modifiers))
            return shortcut;

        return Gtk.accelerator_get_label(keyval, modifiers);
    }

    _isValidShortcut(keyval, modifiers) {
        if (!Gtk.accelerator_valid(keyval, modifiers))
            return false;

        const nonShiftModifiers =
            Gdk.ModifierType.CONTROL_MASK |
            Gdk.ModifierType.ALT_MASK |
            Gdk.ModifierType.SUPER_MASK |
            Gdk.ModifierType.META_MASK;

        if ((modifiers & nonShiftModifiers) !== 0)
            return true;

        return keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;
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
