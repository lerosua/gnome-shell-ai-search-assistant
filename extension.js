import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AiView } from './aiView.js';

export default class AiSearchAssistantExtension extends Extension {
    enable() {
        console.log('AI Search Assistant: Enabling...');
        
        this._isAiMode = false;
        this._settings = this.getSettings();
        this._searchEntry = Main.overview.searchEntry;

        this._usesPrimaryIcon = false;

        // Create the Icon
        this._icon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'system-status-icon ai-search-entry-icon'
        });

        // Use primary icon slot so the button does not disappear while typing.
        if (typeof this._searchEntry.set_primary_icon === 'function') {
            this._usesPrimaryIcon = true;
            this._searchEntry.set_primary_icon(this._icon);
            this._iconButtonSignal = this._searchEntry.connect('primary-icon-clicked', () => {
                this._toggleMode();
            });
        } else {
            // Fallback for shells without icon-slot API.
            this._aiButton = new St.Button({
                style_class: 'search-entry-ai-button',
                can_focus: true,
                track_hover: true,
                accessible_name: 'Toggle AI Mode',
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._aiButton.set_child(this._icon);
            this._aiButtonSignal = this._aiButton.connect('clicked', () => {
                this._toggleMode();
            });

            const searchEntryParent = this._searchEntry.get_parent?.();
            if (searchEntryParent)
                searchEntryParent.add_child(this._aiButton);
            else
                this._searchEntry.add_child(this._aiButton);
        }

        // Intercept Enter at capture phase while in AI mode.
        this._stageSignal = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._isAiMode)
                return Clutter.EVENT_PROPAGATE;

            const eventType = event.type ? event.type() : event.type;
            if (eventType !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;

            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;

            const focus = global.stage.get_key_focus?.();
            const searchText = this._searchEntry?.clutter_text ?? null;
            let isSearchFocus = false;
            for (let actor = focus; actor; actor = actor.get_parent?.()) {
                if (actor === searchText || actor === this._searchEntry) {
                    isSearchFocus = true;
                    break;
                }
            }

            if (!isSearchFocus)
                return Clutter.EVENT_PROPAGATE;

            this._submitAiPrompt();
            console.log('AI Search Assistant: Enter intercepted in AI mode');
            return Clutter.EVENT_STOP;
        });

        // Init AI View
        this._aiView = new AiView(this._settings);
        
        // Locate Search Results Container
        // Note: In GNOME 45+, the structure is different.
        // We try to find the controls and search results view.
        try {
            let overviewControls = null;
            if (Main.overview._controls) {
                 // GNOME 45+
                 overviewControls = Main.overview._controls;
            } else if (Main.overview._overview && Main.overview._overview.controls) {
                 // Older versions
                 overviewControls = Main.overview._overview.controls;
            }

            if (overviewControls) {
                 // Try to find search results first so we can mount AI view in the same container.
                 if (overviewControls._searchController)
                     this._searchResultsView = overviewControls._searchController._searchResults;

                 const searchActor = this._searchResultsView ? (this._searchResultsView.actor || this._searchResultsView) : null;
                 const searchParent = searchActor?.get_parent?.() ?? null;

                 if (searchParent) {
                     this._searchContainer = searchParent;
                     this._searchContainer.add_child(this._aiView);
                 } else {
                     // Fallback if shell internals differ.
                     overviewControls.add_child(this._aiView);
                 }

                 this._aiView.visible = false;
                 this._aiView.reactive = true;
                 this._aiView.x_expand = true;
                 this._aiView.y_expand = true;
            } else {
                 console.warn('AI Search Assistant: Could not find overviewControls, AI view might not show.');
            }
        } catch (e) {
            console.error('AI Search Assistant: Error attaching AI view', e);
        }
    }

    _toggleMode() {
        this._isAiMode = !this._isAiMode;
        
        const searchActor = this._searchResultsView ? (this._searchResultsView.actor || this._searchResultsView) : null;

        if (this._isAiMode) {
            if (this._aiButton)
                this._aiButton.add_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.add_style_class_name('active');
            this._icon.icon_name = 'utilities-terminal-symbolic';
            console.log('AI Search Assistant: Switched to AI Mode');
            
            // Show AI View, Hide Search Results
            this._aiView.visible = true;
            if (searchActor) {
                searchActor.visible = false;
                searchActor.reactive = false;
            }
            
        } else {
            if (this._aiButton)
                this._aiButton.remove_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.remove_style_class_name('active');
            this._icon.icon_name = 'edit-find-symbolic';
            console.log('AI Search Assistant: Switched to Search Mode');
            
            // Hide AI View, Show Search Results
            this._aiView.visible = false;
            if (searchActor) {
                searchActor.visible = true;
                searchActor.reactive = true;
            }
        }
    }

    _submitAiPrompt() {
        const text = this._searchEntry?.get_text?.() ?? '';
        const prompt = text.trim();

        if (prompt.length === 0)
            return;

        this._aiView.addMessage('You', prompt);
        this._aiView.generateResponse(prompt);
        this._searchEntry.set_text('');
    }

    disable() {
        console.log('AI Search Assistant: Disabling...');

        if (this._stageSignal) {
            if (global.stage)
                global.stage.disconnect(this._stageSignal);
            this._stageSignal = null;
        }

        if (this._iconButtonSignal && this._searchEntry) {
            this._searchEntry.disconnect(this._iconButtonSignal);
            this._iconButtonSignal = null;
        }

        if (this._usesPrimaryIcon && this._searchEntry && typeof this._searchEntry.set_primary_icon === 'function') {
            this._searchEntry.set_primary_icon(null);
        }

        if (this._aiButton) {
            if (this._aiButtonSignal) {
                this._aiButton.disconnect(this._aiButtonSignal);
                this._aiButtonSignal = null;
            }
            this._aiButton.destroy();
            this._aiButton = null;
        }

        if (this._aiView) {
            this._aiView.destroy();
            this._aiView = null;
        }
        
        // Restore search results visibility just in case
        let overviewControls = null;
        if (Main.overview._controls) {
             overviewControls = Main.overview._controls;
        } else if (Main.overview._overview && Main.overview._overview.controls) {
             overviewControls = Main.overview._overview.controls;
        }

        if (overviewControls && overviewControls._searchController && overviewControls._searchController._searchResults) {
             const searchActor = overviewControls._searchController._searchResults.actor || overviewControls._searchController._searchResults;
             if (searchActor) {
                 searchActor.visible = true;
                 searchActor.reactive = true;
             }
        }

        this._searchEntry = null;
        this._searchResultsView = null;
        this._searchContainer = null;
        this._settings = null;
        this._isAiMode = false;
        this._usesPrimaryIcon = false;
        this._icon = null;
    }
}
