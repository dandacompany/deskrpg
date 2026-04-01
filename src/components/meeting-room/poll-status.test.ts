import test from 'node:test';
import assert from 'node:assert/strict';

import { formatPollRaises } from "./poll-status";

test('formatPollRaises renders names from object payloads', () => {
  assert.deepEqual(
    formatPollRaises([
      { name: '으뉴', reason: 'idea' },
      { name: '마틴', reason: 'follow-up' },
    ]),
    ['으뉴', '마틴'],
  );
});

test('formatPollRaises preserves legacy string payloads', () => {
  assert.deepEqual(formatPollRaises(['으뉴', '마틴']), ['으뉴', '마틴']);
});
