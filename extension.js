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

        // Create the AI Button
        this._aiButton = new St.Button({
            style_class: 'search-entry-ai-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Toggle AI Mode',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER
        });

        // Create the Icon
        this._icon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'system-status-icon'
        });
        this._aiButton.set_child(this._icon);

        // Add Click Listener
        this._aiButtonSignal = this._aiButton.connect('clicked', () => {
            this._toggleMode();
        });

        // Add to Search Entry
        this._searchEntry.add_child(this._aiButton);

        // Listen for Enter (Activate) on Search Entry
        this._entrySignal = this._searchEntry.clutter_text.connect('activate', () => {
            if (this._isAiMode) {
                const text = this._searchEntry.get_text();
                if (text && text.trim().length > 0) {
                    this._aiView.addMessage('You', text);
                    this._aiView.generateResponse(text);
                    this._searchEntry.set_text(''); // Clear input
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
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
                 overviewControls.add_child(this._aiView);
                 
                 // Try to find search results to hide them
                 if (overviewControls._searchController) {
                     this._searchResultsView = overviewControls._searchController._searchResults;
                 } else if (overviewControls._searchController) {
                      // Sometimes it might be directly on controls? Unlikely.
                 }
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
            this._aiButton.add_style_pseudo_class('checked');
            this._icon.icon_name = 'system-search-symbolic'; // Switch icon to indicate active state or change functionality
            console.log('AI Search Assistant: Switched to AI Mode');
            
            // Show AI View, Hide Search Results
            this._aiView.visible = true;
            if (searchActor) searchActor.opacity = 0; // Hide but keep layout or use visible=false
            
        } else {
            this._aiButton.remove_style_pseudo_class('checked');
            this._icon.icon_name = 'edit-find-symbolic';
            console.log('AI Search Assistant: Switched to Search Mode');
            
            // Hide AI View, Show Search Results
            this._aiView.visible = false;
            if (searchActor) searchActor.opacity = 255;
        }
    }

    disable() {
        console.log('AI Search Assistant: Disabling...');

        if (this._entrySignal) {
            if (this._searchEntry && this._searchEntry.clutter_text) {
                this._searchEntry.clutter_text.disconnect(this._entrySignal);
            }
            this._entrySignal = null;
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
             if (searchActor) searchActor.opacity = 255;
        }

        this._searchEntry = null;
        this._searchResultsView = null;
        this._settings = null;
        this._isAiMode = false;
    }
}
