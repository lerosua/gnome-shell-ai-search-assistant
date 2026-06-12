#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'extension.js');
let source = fs.readFileSync(sourcePath, 'utf8');

source = source
    .replace(/^import .*;\n/gm, '')
    .replace('export default class AiSearchAssistantExtension extends Extension', 'class AiSearchAssistantExtension extends Extension');

source += '\nthis.AiSearchAssistantExtension = AiSearchAssistantExtension;\n';

const context = {
    Extension: class {},
    console,
};
vm.createContext(context);
vm.runInContext(source, context, {filename: sourcePath});

function createExtension(searchActive = false, searchText = '', options = {}) {
    const extension = new context.AiSearchAssistantExtension();
    const controller = {searchActive};
    let setSearchEntryTextCalls = 0;
    let currentSearchText = searchText;
    const throwOnSetSearchText = options.throwOnSetSearchText ?? true;

    Object.assign(extension, {
        _isAiMode: false,
        _isSubmitting: false,
        _hasAiInputSentinel: false,
        _previousSearchActive: null,
        _searchController: controller,
        _aiButton: null,
        _usesPrimaryIcon: false,
        _icon: {destroy() {}},
        _aiIcon: {},
        _originalSearchPlaceholder: 'Search',
        _aiView: {visible: false, reactive: false, destroy() {}},
        _setEntryIcon() {},
        _setSearchPlaceholder() {},
        _syncModeVisibility() {},
        _scheduleVisibilityReassertion() {},
        _cancelVisibilityReassertion() {},
        _getSearchEntryText() {
            return currentSearchText;
        },
        _setSearchEntryText(value) {
            setSearchEntryTextCalls++;
            if (throwOnSetSearchText)
                throw new Error('AI mode toggle must not mutate the search entry text');

            currentSearchText = String(value ?? '');
        },
    });

    return {
        extension,
        controller,
        get searchText() {
            return currentSearchText;
        },
        get setSearchEntryTextCalls() {
            return setSearchEntryTextCalls;
        },
    };
}

function createVisibilityExtension(searchText = '', hasAiInteraction = false) {
    const extension = new context.AiSearchAssistantExtension();
    const searchActor = {
        visible: true,
        opacity: 255,
        reactive: true,
    };
    const aiView = {
        visible: false,
        reactive: false,
    };

    Object.assign(extension, {
        _isAiMode: true,
        _isSubmitting: false,
        _hasAiInteraction: hasAiInteraction,
        _aiView: aiView,
        _searchResultsActor: searchActor,
        _searchController: {searchActive: false},
        _getSearchEntryText() {
            return searchText;
        },
        _isOverviewTargetVisible() {
            return true;
        },
        _raiseAiView() {},
        _ensureVisibleChain() {},
    });

    return {extension, searchActor, aiView};
}

{
    const harness = createExtension(false);
    harness.extension._setAiMode(true);

    assert.equal(harness.extension._isAiMode, true);
    assert.equal(harness.controller.searchActive, false);
    assert.equal(harness.setSearchEntryTextCalls, 0);
}

{
    const harness = createExtension(false, '');
    harness.extension._setAiMode(true);
    harness.extension._setAiMode(false);

    assert.equal(harness.extension._isAiMode, false);
    assert.equal(harness.controller.searchActive, false);
    assert.equal(harness.extension._previousSearchActive, null);
}

{
    const harness = createExtension(false, 'native query');
    harness.extension._setAiMode(true);
    harness.extension._setAiMode(false);

    assert.equal(harness.controller.searchActive, true);
}

{
    const harness = createExtension(false, '');
    harness.extension._setAiMode(true);
    harness.extension.disable();

    assert.equal(harness.controller.searchActive, false);
    assert.equal(harness.extension._isAiMode, false);
}

{
    const harness = createExtension(false, '_', {throwOnSetSearchText: false});
    harness.extension._isAiMode = true;
    harness.extension._hasAiInputSentinel = true;
    harness.extension._previousSearchActive = false;
    harness.extension._setAiMode(false);

    assert.equal(harness.searchText, '');
    assert.equal(harness.controller.searchActive, false);
}

{
    const harness = createExtension(false, '_next question', {throwOnSetSearchText: false});
    harness.extension._isAiMode = true;
    harness.extension._hasAiInputSentinel = true;
    harness.extension._previousSearchActive = false;
    harness.extension._setAiMode(false);

    assert.equal(harness.searchText, 'next question');
    assert.equal(harness.controller.searchActive, true);
}

{
    const harness = createVisibilityExtension('');
    harness.extension._syncModeVisibility();

    assert.equal(harness.aiView.visible, false);
    assert.equal(harness.searchActor.visible, true);
    assert.equal(harness.searchActor.opacity, 255);
    assert.equal(harness.searchActor.reactive, true);
    assert.equal(harness.extension._searchController.searchActive, false);
}

{
    const harness = createVisibilityExtension('ask ai');
    harness.extension._syncModeVisibility();

    assert.equal(harness.aiView.visible, true);
    assert.equal(harness.searchActor.visible, true);
    assert.equal(harness.searchActor.opacity, 0);
    assert.equal(harness.searchActor.reactive, false);
    assert.equal(harness.extension._searchController.searchActive, true);
}

{
    const harness = createVisibilityExtension('', true);
    harness.extension._syncModeVisibility();

    assert.equal(harness.aiView.visible, true);
    assert.equal(harness.searchActor.opacity, 0);
    assert.equal(harness.searchActor.reactive, false);
}

{
    const harness = createExtension(false, '_next question');
    harness.extension._isAiMode = true;

    assert.equal(harness.extension._extractPromptFromInput('_native query'), '_native query');

    harness.extension._hasAiInputSentinel = true;
    assert.equal(harness.extension._extractPromptFromInput('_'), '');
    assert.equal(harness.extension._extractPromptFromInput('_next question'), 'next question');
    assert.equal(harness.extension._extractPromptFromInput('__literal'), '_literal');

    harness.extension._isAiMode = false;
    assert.equal(harness.extension._extractPromptFromInput('_native query'), '_native query');
}

(async () => {
    let searchText = 'ask ai';
    let queuedVisibilitySync = false;
    const messages = [];
    const responses = [];
    const extension = new context.AiSearchAssistantExtension();

    Object.assign(extension, {
        _isAiMode: true,
        _isSubmitting: false,
        _hasAiInteraction: false,
        _hasAiInputSentinel: false,
        _aiView: {
            visible: false,
            addMessage(sender, text) {
                messages.push([sender, text]);
            },
            async generateResponse(prompt) {
                responses.push(prompt);
            },
        },
        _getSearchEntryText() {
            return searchText;
        },
        _setSearchEntryText(value) {
            searchText = String(value ?? '');
        },
        _queueModeVisibilitySync() {
            queuedVisibilitySync = true;
        },
    });

    await extension._submitAiPrompt();

    assert.equal(searchText, '_');
    assert.deepEqual(messages, [['You', 'ask ai']]);
    assert.deepEqual(responses, ['ask ai']);
    assert.equal(queuedVisibilitySync, true);
    assert.equal(extension._hasAiInteraction, true);
    assert.equal(extension._hasAiInputSentinel, true);
    assert.equal(extension._isSubmitting, false);

    console.log('[PASS] AI mode keeps a sentinel input for answer visibility');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
