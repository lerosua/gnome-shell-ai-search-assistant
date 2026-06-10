import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { AiView } from './aiView.js';

const AI_PLACEHOLDER_TEXT = 'Ask AI Assistant';
const SEARCH_ICON_NAME = 'edit-find-symbolic';
const AI_ICON_FILENAME = 'ai-search-symbolic.svg';
const TOGGLE_AI_MODE_KEYBINDING = 'toggle-ai-mode';
const debug = false;

function debugLog(...args) {
    if (debug)
        console.log(...args);
}

function debugWarn(...args) {
    if (debug)
        console.warn(...args);
}

function debugError(...args) {
    if (debug)
        console.error(...args);
}

export default class AiSearchAssistantExtension extends Extension {
    enable() {
        debugLog('AI Search Assistant: Enabling...');
        
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._hasAiInteraction = false;
        this._previousSearchActive = null;
        this._modeVisibilityIdleId = null;
        this._focusSearchIdleId = null;
        this._toggleShortcutRegistered = false;
        this._settings = this.getSettings();
        this._searchEntry = Main.overview.searchEntry;
        this._searchTextActor = this._searchEntry?.clutter_text ?? null;
        this._originalSearchPlaceholder = this._getSearchPlaceholder();
        this._usesPrimaryIcon = false;
        this._aiIcon = this._loadAiIcon();

        // Create the Icon
        this._icon = new St.Icon({
            icon_name: SEARCH_ICON_NAME,
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

        // Intercept AI-mode control keys at capture phase.
        this._stageSignal = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._isAiMode)
                return Clutter.EVENT_PROPAGATE;

            const eventType = event.type ? event.type() : event.type;
            if (eventType !== Clutter.EventType.KEY_PRESS &&
                eventType !== Clutter.EventType.KEY_RELEASE)
                return Clutter.EVENT_PROPAGATE;

            return this._handleAiModeKeyEvent(event, eventType);
        });

        // Keep AI result UI visible in AI mode even when search text is cleared.
        if (this._searchTextActor?.connect) {
            this._searchTextSignal = this._searchTextActor.connect('text-changed', () => {
                if (!this._isAiMode)
                    return;

                if (this._isUpdatingSearchText)
                    return;

                this._queueModeVisibilitySync();
            });

            this._searchKeyPressSignal = this._searchTextActor.connect('key-press-event', (_actor, event) => {
                if (!this._isAiMode)
                    return Clutter.EVENT_PROPAGATE;

                return this._handleAiModeKeyEvent(event, Clutter.EventType.KEY_PRESS);
            });

            this._searchKeyReleaseSignal = this._searchTextActor.connect('key-release-event', (_actor, event) => {
                if (!this._isAiMode)
                    return Clutter.EVENT_PROPAGATE;

                return this._handleAiModeKeyEvent(event, Clutter.EventType.KEY_RELEASE);
            });
        }

        this._shortcutChangedSignal = this._settings.connect(
            `changed::${TOGGLE_AI_MODE_KEYBINDING}`,
            () => this._reloadToggleShortcut()
        );
        this._registerToggleShortcut();

        this._overviewShowingSignal = Main.overview.connect('showing', () => {
            if (!this._isAiMode || !this._aiView)
                return;

            this._queueModeVisibilitySync();
            this._queueFocusSearchEntry();
        });

        this._overviewHiddenSignal = Main.overview.connect('hidden', () => {
            if (this._isAiMode) {
                this._setAiMode(false);
                debugLog('AI Search Assistant: Overview hidden, switched to Search Mode');
            } else {
                this._cancelVisibilityReassertion();
            }

            if (this._aiView)
                this._aiView.visible = false;
        });

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
            this._searchController = overviewControls?._searchController ?? null;
            this._aiViewParent = null;

            if (this._searchController) {
                const sr = this._searchController._searchResults;
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
                debugLog('AI Search Assistant: AI view attached as sibling of search results');
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
                    debugWarn('AI Search Assistant: Falling back to overview overlay attachment');
                } else {
                    debugWarn('AI Search Assistant: Could not find a suitable parent for AI view');
                }
            }

            this._aiView.visible = false;
            this._aiView.reactive = true;
            this._raiseAiView();
        } catch (e) {
            debugError('AI Search Assistant: Error attaching AI view', e);
        }
    }

    _toggleMode() {
        this._setAiMode(!this._isAiMode);
    }

    _toggleModeFromShortcut() {
        if (!this._isOverviewTargetVisible()) {
            Main.overview.show();
            this._setAiMode(true);
            this._queueFocusSearchEntry();
            return;
        }

        this._toggleMode();
        this._queueFocusSearchEntry();
    }

    _setAiMode(isAiMode) {
        if (this._isAiMode === isAiMode)
            return false;

        this._isAiMode = isAiMode;

        if (this._isAiMode) {
            this._captureSearchActiveBeforeAiMode();
            if (this._aiButton)
                this._aiButton.add_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.add_style_class_name('active');
            this._setEntryIcon(this._aiIcon);
            this._setSearchPlaceholder(AI_PLACEHOLDER_TEXT);
            debugLog('AI Search Assistant: Switched to AI Mode');
        } else {
            if (this._aiButton)
                this._aiButton.remove_style_pseudo_class('checked');
            if (this._usesPrimaryIcon)
                this._icon.remove_style_class_name('active');
            this._setEntryIcon(null);
            this._setSearchPlaceholder(this._originalSearchPlaceholder);
            this._restoreOverviewSearchActive();
            debugLog('AI Search Assistant: Switched to Search Mode');
        }

        this._syncModeVisibility();
        if (this._isAiMode)
            this._scheduleVisibilityReassertion();
        else
            this._cancelVisibilityReassertion();

        return true;
    }

    _loadAiIcon() {
        const iconPath = GLib.build_filenamev([this.path, AI_ICON_FILENAME]);
        return new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)});
    }

    _setEntryIcon(gicon) {
        if (gicon) {
            this._icon.gicon = gicon;
            return;
        }

        this._icon.gicon = null;
        this._icon.icon_name = SEARCH_ICON_NAME;
    }

    _exitAiMode(reason) {
        if (!this._setAiMode(false))
            return false;

        debugLog(`AI Search Assistant: ${reason}, switched to Search Mode`);
        return true;
    }

    _handleAiModeKeyEvent(event, eventType) {
        const key = event.get_key_symbol();

        if (this._isOverviewToggleKey(key)) {
            this._exitAiMode('Overview toggle key intercepted');
            return Clutter.EVENT_PROPAGATE;
        }

        if (eventType !== Clutter.EventType.KEY_PRESS)
            return Clutter.EVENT_PROPAGATE;

        if (key === Clutter.KEY_Escape) {
            this._exitAiMode('Escape intercepted');
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
        debugLog('AI Search Assistant: Enter intercepted in AI mode');
        return Clutter.EVENT_STOP;
    }

    async _submitAiPrompt() {
        const text = this._getSearchEntryText();
        const prompt = this._extractPromptFromInput(text);

        if (prompt.length === 0 || this._isSubmitting)
            return;

        this._isSubmitting = true;
        this._hasAiInteraction = true;

        if (this._isAiMode && this._aiView)
            this._aiView.visible = true;

        debugLog(`AI Search Assistant: Submitting prompt (${prompt.length} chars)`);

        this._aiView.addMessage('You', prompt);

        this._setSearchEntryText('');

        // GNOME Shell's search controller reacts to text changes and hides
        // the search results container when the entry becomes empty.  Since
        // aiView lives inside that container we must re-assert visibility
        // after the search controller has finished processing the empty text.
        this._queueModeVisibilitySync();

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

    _getSearchPlaceholder() {
        try {
            if (this._searchEntry?.get_hint_text)
                return this._searchEntry.get_hint_text();
            if (this._searchEntry?.hint_text !== undefined)
                return this._searchEntry.hint_text;
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to read search placeholder: ${e.message}`);
        }

        return '';
    }

    _setSearchPlaceholder(value) {
        try {
            const text = String(value ?? '');
            if (this._searchEntry?.set_hint_text) {
                this._searchEntry.set_hint_text(text);
                return;
            }

            if (this._searchEntry?.hint_text !== undefined)
                this._searchEntry.hint_text = text;
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to set search placeholder: ${e.message}`);
        }
    }

    _extractPromptFromInput(text) {
        return String(text ?? '').trim();
    }

    _captureSearchActiveBeforeAiMode() {
        if (this._previousSearchActive !== null)
            return;

        this._previousSearchActive = this._getOverviewSearchActive();
    }

    _getOverviewSearchActive() {
        const controller = this._searchController ?? null;
        if (!controller)
            return null;

        try {
            if (controller.searchActive !== undefined)
                return !!controller.searchActive;
            if (controller._searchActive !== undefined)
                return !!controller._searchActive;
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to read search active state: ${e.message}`);
        }

        return null;
    }

    _setOverviewSearchActive(active) {
        const controller = this._searchController ?? null;
        if (!controller)
            return false;

        try {
            if (controller.searchActive !== undefined) {
                controller.searchActive = !!active;
                return true;
            }

            if (controller._searchActive !== undefined) {
                controller._searchActive = !!active;
                controller.notify?.('search-active');
                return true;
            }
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to set search active state: ${e.message}`);
        }

        return false;
    }

    _restoreOverviewSearchActive() {
        const hasSearchText = this._getSearchEntryText().trim().length > 0;
        const nextSearchActive = hasSearchText
            ? true
            : (this._previousSearchActive ?? false);

        this._setOverviewSearchActive(nextSearchActive);
        this._previousSearchActive = null;
    }

    _shouldShowAiView() {
        if (!this._isAiMode)
            return false;

        if (this._isSubmitting || this._hasAiInteraction)
            return true;

        return this._extractPromptFromInput(this._getSearchEntryText()).length > 0;
    }

    _restoreSearchActorVisibility(searchActor) {
        if (!searchActor)
            return;

        searchActor.visible = true;
        searchActor.opacity = 255;
        searchActor.reactive = true;
    }

    _syncModeVisibility() {
        const searchActor = this._searchResultsActor ?? null;

        if (!this._aiView)
            return;

        if (this._isAiMode) {
            if (!this._isOverviewTargetVisible()) {
                this._aiView.visible = false;
                this._aiView.reactive = false;
                this._restoreSearchActorVisibility(searchActor);
                return;
            }

            if (!this._shouldShowAiView()) {
                this._aiView.visible = false;
                this._aiView.reactive = false;
                this._restoreSearchActorVisibility(searchActor);
                return;
            }

            this._setOverviewSearchActive(true);
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
        this._aiView.reactive = false;
        this._restoreSearchActorVisibility(searchActor);
    }

    _queueModeVisibilitySync() {
        if (this._modeVisibilityIdleId)
            return;

        this._modeVisibilityIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._modeVisibilityIdleId = null;
            if (this._isAiMode && this._aiView) {
                this._syncModeVisibility();
                this._scheduleVisibilityReassertion();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueFocusSearchEntry() {
        if (this._focusSearchIdleId)
            return;

        this._focusSearchIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusSearchIdleId = null;
            this._focusSearchEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusSearchEntry() {
        if (this._searchTextActor?.grab_key_focus) {
            this._searchTextActor.grab_key_focus();
            return;
        }

        this._searchEntry?.grab_key_focus?.();
    }

    _isOverviewTargetVisible() {
        if (Main.overview?.visibleTarget !== undefined)
            return !!Main.overview.visibleTarget;

        return !!Main.overview?.visible;
    }

    _isOverviewToggleKey(key) {
        return key === Clutter.KEY_Super_L ||
            key === Clutter.KEY_Super_R ||
            key === Clutter.KEY_Meta_L ||
            key === Clutter.KEY_Meta_R ||
            key === Clutter.KEY_Hyper_L ||
            key === Clutter.KEY_Hyper_R;
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
            debugWarn(`AI Search Assistant: Failed to raise AI view: ${e.message}`);
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

        this._cancelVisibilityReassertion();

        let retries = 6;
        this._visibilityReassertionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
            if (!this._isAiMode || !this._aiView) {
                this._visibilityReassertionId = null;
                return GLib.SOURCE_REMOVE;
            }

            if (!this._isOverviewTargetVisible()) {
                this._aiView.visible = false;
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

    _cancelVisibilityReassertion() {
        if (!this._visibilityReassertionId)
            return;

        GLib.source_remove(this._visibilityReassertionId);
        this._visibilityReassertionId = null;
    }

    _cancelModeVisibilitySync() {
        if (!this._modeVisibilityIdleId)
            return;

        GLib.source_remove(this._modeVisibilityIdleId);
        this._modeVisibilityIdleId = null;
    }

    _cancelFocusSearch() {
        if (!this._focusSearchIdleId)
            return;

        GLib.source_remove(this._focusSearchIdleId);
        this._focusSearchIdleId = null;
    }

    _registerToggleShortcut() {
        this._removeToggleShortcut();

        const shortcuts = this._settings?.get_strv?.(TOGGLE_AI_MODE_KEYBINDING) ?? [];
        if (shortcuts.length === 0 || !shortcuts[0])
            return;

        try {
            Main.wm.addKeybinding(
                TOGGLE_AI_MODE_KEYBINDING,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleModeFromShortcut()
            );
            this._toggleShortcutRegistered = true;
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to register toggle shortcut: ${e.message}`);
        }
    }

    _removeToggleShortcut() {
        if (!this._toggleShortcutRegistered)
            return;

        try {
            Main.wm.removeKeybinding(TOGGLE_AI_MODE_KEYBINDING);
        } catch (e) {
            debugWarn(`AI Search Assistant: Failed to remove toggle shortcut: ${e.message}`);
        }
        this._toggleShortcutRegistered = false;
    }

    _reloadToggleShortcut() {
        this._registerToggleShortcut();
    }

    disable() {
        debugLog('AI Search Assistant: Disabling...');

        if (this._isAiMode)
            this._restoreOverviewSearchActive();

        if (this._stageSignal) {
            if (global.stage)
                global.stage.disconnect(this._stageSignal);
            this._stageSignal = null;
        }

        if (this._searchTextSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchTextSignal);
            this._searchTextSignal = null;
        }

        if (this._searchKeyPressSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchKeyPressSignal);
            this._searchKeyPressSignal = null;
        }

        if (this._searchKeyReleaseSignal && this._searchTextActor) {
            this._searchTextActor.disconnect(this._searchKeyReleaseSignal);
            this._searchKeyReleaseSignal = null;
        }

        if (this._overviewShowingSignal) {
            Main.overview.disconnect(this._overviewShowingSignal);
            this._overviewShowingSignal = null;
        }

        if (this._overviewHiddenSignal) {
            Main.overview.disconnect(this._overviewHiddenSignal);
            this._overviewHiddenSignal = null;
        }

        this._cancelVisibilityReassertion();
        this._cancelModeVisibilitySync();
        this._cancelFocusSearch();
        this._removeToggleShortcut();

        if (this._shortcutChangedSignal && this._settings) {
            this._settings.disconnect(this._shortcutChangedSignal);
            this._shortcutChangedSignal = null;
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

        if (this._icon) {
            this._icon.destroy();
            this._icon = null;
        }

        if (this._aiView) {
            this._aiView.destroy();
            this._aiView = null;
        }

        this._setSearchPlaceholder(this._originalSearchPlaceholder);
        
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
        this._searchController = null;
        this._aiViewParent = null;
        this._settings = null;
        this._originalSearchPlaceholder = null;
        this._isAiMode = false;
        this._isSubmitting = false;
        this._isUpdatingSearchText = false;
        this._hasAiInteraction = false;
        this._previousSearchActive = null;
        this._modeVisibilityIdleId = null;
        this._focusSearchIdleId = null;
        this._shortcutChangedSignal = null;
        this._toggleShortcutRegistered = false;
        this._usesPrimaryIcon = false;
    }
}
