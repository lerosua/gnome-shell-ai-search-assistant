import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
    }

    _addEntryRow(group, settings, { title, subtitle, key, placeholder }) {
        const row = new Adw.ActionRow({
            title,
            subtitle
        });

        const entry = new Gtk.Entry({
            hexpand: true,
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
}
