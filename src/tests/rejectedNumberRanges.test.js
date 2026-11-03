import assert from 'node:assert/strict';
import { isRejectedRange, rejectedRanges, rememberRejectedRange } from '../services/rejectedNumberRanges.js';

assert.equal(isRejectedRange('+33162044090'), false);
assert.equal(rememberRejectedRange('+33162044090'), '+3316204');
assert.equal(isRejectedRange('+33162044090'), true);
assert.equal(isRejectedRange('+33 1 62 04 49 44'), true);
assert.equal(isRejectedRange('+33188732537'), false);
assert.equal(isRejectedRange('+33219121444'), false);
assert.equal(isRejectedRange('+33162055000'), false);
assert.equal(isRejectedRange('0162044090'), false);

assert.equal(rememberRejectedRange('+33162055111'), '+3316205');
assert.equal(isRejectedRange('+33162055999'), true);
assert.equal(rememberRejectedRange('+14155550100'), null);
assert.equal(isRejectedRange('+14155550100'), false);
assert.ok(rejectedRanges().includes('+3316204') && rejectedRanges().includes('+3316205'));
console.log('rejectedNumberRanges.test OK');
