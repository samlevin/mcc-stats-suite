const assert = require('node:assert/strict');
const test = require('node:test');
test('application boundary is independently targetable', () => {
  assert.equal(require('../package.json').name, '@mcc/player');
});
