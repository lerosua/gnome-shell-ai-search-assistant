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

function createExtension(searchActive = false, searchText = '') {
    const extension = new context.AiSearchAssistantExtension();
    const controller = {searchActive};
    let setSearchEntryTextCalls = 0;

    Object.assign(extension, {
        _isAiMode: false,
        _isSubmitting: false,
        _previousSearchActive: null,
        _searchController: controller,
        _aiButton: null,
        _usesPrimaryIcon: false,
        _icon: {},
        _aiIcon: {},
        _originalSearchPlaceholder: 'Search',
        _aiView: {visible: false, reactive: false, destroy() {}},
        _setEntryIcon() {},
        _setSearchPlaceholder() {},
        _syncModeVisibility() {},
        _scheduleVisibilityReassertion() {},
        _cancelVisibilityReassertion() {},
        _getSearchEntryText() {
            return searchText;
        },
        _setSearchEntryText() {
            setSearchEntryTextCalls++;
            throw new Error('AI mode toggle must not mutate the search entry text');
        },
    });

    return {
        extension,
        controller,
        get setSearchEntryTextCalls() {
            return setSearchEntryTextCalls;
        },
    };
}

{
    const harness = createExtension(false);
    harness.extension._setAiMode(true);

    assert.equal(harness.extension._isAiMode, true);
    assert.equal(harness.controller.searchActive, true);
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

console.log('[PASS] AI mode toggles overview search state without mutating search text');
