import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest } from '../src/messages';
import { EMPTY_DOCUMENT } from '../src/model';

test('runtime messages validate commands and tab/profile identifiers', () => {
  assert.deepEqual(parseRequest({ type: 'getState' }), { type: 'getState' });
  assert.deepEqual(parseRequest({ type: 'disableAll' }), {
    type: 'disableAll',
  });
  assert.deepEqual(
    parseRequest({ type: 'activate', tabId: 0, profileId: 'profile' }),
    { type: 'activate', tabId: 0, profileId: 'profile' },
  );
  assert.deepEqual(parseRequest({ type: 'deactivate', tabId: 1 }), {
    type: 'deactivate',
    tabId: 1,
  });
  for (const input of [null, 'activate', {}, { type: 'unknown' }]) {
    assert.throws(() => parseRequest(input), /Unknown request/);
  }
  for (const tabId of [undefined, '1', -1, 0.5, NaN, Infinity]) {
    assert.throws(
      () => parseRequest({ type: 'activate', tabId, profileId: 'profile' }),
      /valid tab/,
    );
  }
  assert.throws(
    () => parseRequest({ type: 'activate', tabId: 1 }),
    /Profile not found/,
  );
});

test('save messages validate the document at the runtime boundary', () => {
  assert.deepEqual(
    parseRequest({ type: 'saveDocument', doc: EMPTY_DOCUMENT }),
    { type: 'saveDocument', doc: EMPTY_DOCUMENT },
  );
  assert.throws(() => parseRequest({ type: 'saveDocument' }));
  assert.throws(() =>
    parseRequest({
      type: 'saveDocument',
      doc: { schemaVersion: 2, profiles: [] },
    }),
  );
});
