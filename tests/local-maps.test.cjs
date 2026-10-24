const assert = require('node:assert/strict');
const {instruction, position} = require('../src/local-maps.js');
assert.equal(instruction({name:'east00'}, 'Henesys'), 'Take the right-hand portal to Henesys.');
assert.equal(instruction({name:'west10'}, 'Lith Harbor'), 'Take the left-hand portal to Lith Harbor.');
assert.equal(instruction({name:'top00'}, 'Forest'), 'Take the upper portal to Forest.');
assert.equal(instruction({name:'h_in00'}, 'Hidden Street'), 'Take the portal to Hidden Street.');
assert.equal(instruction(null), 'You have arrived.');
// Portal coordinates refer to the original image. Scaling must preserve their position.
assert.deepEqual(position({x:6197,y:1825}, 7000, 2400), {x:6197/7000,y:1825/2400});
assert.equal(position({x:8000,y:5}, 7000, 2400), null);
assert.equal(position({x:5}, 7000, 2400), null);
assert.equal(position({x:-1,y:0}, 7000, 2400), null);
assert.equal(position({x:0,y:0}, 0, 0), null);
console.log('PASS: readable portal directions and source-image coordinate bounds.');
