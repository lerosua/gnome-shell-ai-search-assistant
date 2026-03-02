import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AiView } from './aiView.js';

const AI_ENTRY_PREFIX = '_';

export default class AiSearchAssistantExtension extends Extension {
    enable() {
        console.log('AI Search Assistant: Enabling...');
        
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._settings = this.getSettings();
        this._searchEntry = Main.overview.searchEntry;
        this._searchTextActor = this._searchEntry?.clutter_text ?? null;
        this._usesPrimaryIcon = false;

        // Create the Icon
        this._icon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'search-entry-icon ai-search-entry-icon'
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

            if (key === Clutter.KEY_Escape) {
                this._toggleMode();
                console.log('AI Search Assistant: Escape intercepted, switched to Search Mode');
                return Clutter.EVENT_STOP;
            }

            if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;

            if (this._isSubmitting)
                return Clutter.EVENT_STOP;

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

        // Keep AI result UI visible in AI mode even when search text is cleared.
        if (this._searchTextActor?.connect) {
            this._searchTextSignal = this._searchTextActor.connect('text-changed', () => {
                if (!this._isAiMode)
                    return;

                if (this._isUpdatingSearchText)
                    return;

                const rawText = this._getSearchEntryText();
                if (rawText.trim().length === 0)
                    this._ensureAiPrefix();

                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._syncModeVisibility();
                    this._scheduleVisibilityReassertion();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        // Init AI View
        this._aiView = new AiView(this._settings);
        
        // Locate Search Results Container and attach AI view.
        // Keep AI results in the same visual slot as native search results
        // (below the search entry), so it never covers the search bar.
        try {
            let overviewControls = null;
            if (Main.overview._controls) {
                 overviewControls = Main.overview._controls;
            } else if (Main.overview._overview && Main.overview._overview.controls) {
                 overviewControls = Main.overview._overview.controls;
            }

            this._searchResultsView = null;
            this._searchResultsActor = null;
            this._aiViewParent = null;

            if (overviewControls?._searchController) {
                const sr = overviewControls._searchController._searchResults;
                this._searchResultsView = sr;
                this._searchResultsActor = sr?.actor ?? sr;
            }

            const srParent = this._searchResultsActor?.get_parent?.();
            if (srParent && this._searchResultsActor) {
                srParent.add_child(this._aiView);
                this._aiView.add_constraint(new Clutter.BindConstraint({
                    source: this._searchResultsActor,
                    coordinate: Clutter.BindCoordinate.POSITION,
                    offset: 0,
                }));
                this._aiView.add_constraint(new Clutter.BindConstraint({
                    source: this._searchResultsActor,
                    coordinate: Clutter.BindCoordinate.SIZE,
                    offset: 0,
                }));
                this._aiViewParent = srParent;
                console.log('AI Search Assistant: AI view attached as sibling of search results');
            } else {
                // Last-resort fallback for unusual shell internals.
                const overviewGroup = Main.overview._overview ?? Main.layoutManager.overviewGroup;
                if (overviewGroup) {
                    overviewGroup.add_child(this._aiView);
                    this._aiView.add_constraint(new Clutter.BindConstraint({
                        source: overviewGroup,
                        coordinate: Clutter.BindCoordinate.ALL,
                        offset: 0,
                    }));
                    this._aiViewParent = overviewGroup;
                    console.warn('AI Search Assistant: Falling back to overview overlay attachment');
                } else {
                    console.warn('AI Search Assistant: Could not find a suitable parent for AI view');
                }
            }

            this._aiView.visible = false;
            this._aiView.reactive = true;
            this._raiseAiView();
        } catch (e) {
            console.error('AI Search Assistant: Error attaching AI view', e);
        }
    }

    _toggleMode() {
        this._isAiMode = !this._isAiMode;

        if (this._isAiMode) {
            if (this._aiButton)
                this._aiButton.add_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.add_style_class_name('active');
            this._icon.icon_name = 'chat-message-new-symbolic';
            this._ensureAiPrefix();
            console.log('AI Search Assistant: Switched to AI Mode');
        } else {
            if (this._aiButton)
                this._aiButton.remove_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.remove_style_class_name('active');
            this._icon.icon_name = 'edit-find-symbolic';
            this._clearAiPrefixIfPresent();
            console.log('AI Search Assistant: Switched to Search Mode');
        }

        this._syncModeVisibility();
        this._scheduleVisibilityReassertion();
    }

    async _submitAiPrompt() {
        const text = this._getSearchEntryText();
        const prompt = this._extractPromptFromInput(text);

        if (prompt.length === 0 || this._isSubmitting)
            return;

        this._isSubmitting = true;

        if (this._isAiMode && this._aiView)
            this._aiView.visible = true;

        console.log(`AI Search Assistant: Submitting prompt (${prompt.length} chars): ${prompt.slice(0, 80)}`);

        this._aiView.addMessage('You', prompt);

        this._setSearchEntryText('');
        this._ensureAiPrefix();

        // GNOME Shell's search controller reacts to text changes and hides
        // the search results container when the entry becomes empty.  Since
        // aiView lives inside that container we must re-assert visibility
        // after the search controller has finished processing the empty text.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._isAiMode && this._aiView) {
                this._syncModeVisibility();
                this._scheduleVisibilityReassertion();
            }
            return GLib.SOURCE_REMOVE;
        });

        try {
            await this._aiView.generateResponse(prompt);
        } finally {
            this._isSubmitting = false;
        }
    }

    _getSearchEntryText() {
        const searchText = this._searchEntry?.clutter_text ?? null;
        return searchText?.get_text?.() ?? this._searchEntry?.get_text?.() ?? '';
    }

    _setSearchEntryText(value) {
        this._isUpdatingSearchText = true;
        try {
            const text = String(value ?? '');
            const searchText = this._searchEntry?.clutter_text ?? null;
            if (searchText?.set_text)
                searchText.set_text(text);
            if (this._searchEntry?.set_text)
                this._searchEntry.set_text(text);

            const cursorPos = text.length;
            if (searchText?.set_cursor_position)
                searchText.set_cursor_position(cursorPos);
            if (searchText?.set_selection)
                searchText.set_selection(cursorPos, cursorPos);
        } finally {
            this._isUpdatingSearchText = false;
        }
    }

    _extractPromptFromInput(text) {
        const input = String(text ?? '').trim();
        if (input.length === 0)
            return '';

        return input.replace(/^_+\s*/, '').trim();
    }

    _ensureAiPrefix() {
        if (!this._isAiMode)
            return;

        const current = this._getSearchEntryText();
        if (current.trim().length > 0)
            return;

        this._setSearchEntryText(AI_ENTRY_PREFIX);
    }

    _clearAiPrefixIfPresent() {
        const current = this._getSearchEntryText();
        if (!/^_+\s*$/.test(current.trim()))
            return;

        this._setSearchEntryText('');
    }

    _syncModeVisibility() {
        const searchActor = this._searchResultsActor ?? null;

        if (!this._aiView)
            return;

        if (this._isAiMode) {
            this._aiView.visible = true;
            this._aiView.reactive = true;
            this._raiseAiView();
            this._ensureVisibleChain(this._aiView);

            if (searchActor) {
                searchActor.visible = true;
                searchActor.opacity = 0;
                searchActor.reactive = false;
                this._ensureVisibleChain(searchActor);
            }
            return;
        }

        this._aiView.visible = false;
        if (searchActor) {
            searchActor.visible = true;
            searchActor.opacity = 255;
            searchActor.reactive = true;
        }
    }

    _raiseAiView() {
        if (!this._aiView)
            return;

        const parent = this._aiView.get_parent?.();
        if (!parent)
            return;

        try {
            if (typeof parent.set_child_above_sibling === 'function') {
                parent.set_child_above_sibling(this._aiView, null);
                return;
            }

            if (typeof this._aiView.raise_top === 'function')
                this._aiView.raise_top();
        } catch (e) {
            console.warn(`AI Search Assistant: Failed to raise AI view: ${e.message}`);
        }
    }

    _ensureVisibleChain(actor) {
        for (let node = actor; node; node = node.get_parent?.()) {
            if (node === global.stage)
                break;

            if (!node.visible)
                node.visible = true;
        }
    }

    _scheduleVisibilityReassertion() {
        if (!this._isAiMode || !this._aiView)
            return;

        if (this._visibilityReassertionId) {
            GLib.source_remove(this._visibilityReassertionId);
            this._visibilityReassertionId = null;
        }

        let retries = 6;
        this._visibilityReassertionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            if (!this._isAiMode || !this._aiView) {
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            this._syncModeVisibility();
            retries--;

            if (retries <= 0) {
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        console.log('AI Search Assistant: Disabling...');

        if (this._stageSignal) {
            if (global.stage)
                global.stage.disconnect(this._stageSignal);
            this._stageSignal = null;
        }

        if (this._searchTextSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchTextSignal);
            this._searchTextSignal = null;
        }

        if (this._visibilityReassertionId) {
            GLib.source_remove(this._visibilityReassertionId);
            this._visibilityReassertionId = null;
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

        this._clearAiPrefixIfPresent();
        
        // Restore search results visibility just in case
        if (this._searchResultsActor) {
            this._searchResultsActor.visible = true;
            this._searchResultsActor.opacity = 255;
            this._searchResultsActor.reactive = true;
        }

        this._searchEntry = null;
        this._searchTextActor = null;
        this._searchResultsView = null;
        this._searchResultsActor = null;
        this._aiViewParent = null;
        this._settings = null;
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._usesPrimaryIcon = false;
        this._icon = null;
    }
}
