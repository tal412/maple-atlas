// Map name in the minimap header: matching recognized text to maps, and finding a drawn
// stand-in strip (no game images in this public repository).
const assert = require('node:assert/strict');
const path = require('node:path');
const name = require(path.join(__dirname, '../src/map-name.js'));

const maps = [
  { id: '10001000', name: 'Henesys', street: 'Victoria Road' },
  { id: '10001001', name: 'Henesys Townstreet', street: 'Victoria Road' },
  { id: '10001040', name: 'Henesys Market', street: 'Victoria Road' },
  { id: '1010', name: 'Amherst', street: 'Maple Road' },
  { id: '10', name: 'Mushroom Town', street: 'Maple Road' },
  { id: '20', name: 'Mushroom Town', street: 'Maple Road' },
  { id: '10005010', name: 'Swampy Land in a Deep Forest', street: 'Dungeon' },
  { id: '10002072', name: 'Tree Dungeon, Forest Up North I', street: 'Dungeon' },
  { id: '10002073', name: 'Tree Dungeon, Forest Up North II', street: 'Dungeon' },
];

// What the recognizer read from a real header (street, then map name), with its typical slips.
assert.equal(name.match('Jictaria Roar\nHenesys\n', maps).id, '10001000');
assert.equal(name.match('Jictoria Road\ndenesys\n', maps).id, '10001000');
assert.equal(name.match('Victoria Road\nHenesys Townstreet', maps).id, '10001001');
assert.equal(name.match('Maple Road\nAmherst', maps).id, '1010');
// A long name wrapped over two lines.
assert.equal(name.match('Dungeon\nSwampy Land in a\nDeep Forest', maps).id, '10005010');
// Numbered maps must be told apart by the number.
assert.equal(name.match('Dungeon\nTree Dungeon, Forest Up North II', maps).id, '10002073');
assert.equal(name.match('Dungeon\nTree Dungeon, Forest Up North I', maps).id, '10002072');
// The same name and street twice: both ids are reported, so the engine can choose.
assert.deepEqual(name.match('Maple Road\nMushroom Town', maps).ids.sort(), ['10', '20']);
// Noise is not a map.
assert.equal(name.match('ERT TTT RTT TT Rt sete', maps), null);
assert.equal(name.match('', maps), null);

// A drawn stand-in: a dark window, a light-blue strip with white "letters", and a sky-blue
// minimap area below it with no letters. The strip with letters is found, not the sky.
function image(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = paint(x, y), i = (y * width + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width, height, data };
}
const frame = image(300, 240, (x, y) => {
  if (y >= 20 && y < 70 && x >= 10 && x < 290) {
    const letter = x >= 70 && x < 250 && ((y >= 28 && y < 40) || (y >= 50 && y < 62)) && x % 9 < 4;
    return letter ? [245, 245, 240] : [160, 200, 228];
  }
  if (y >= 80 && y < 230 && x >= 10 && x < 290) return [120, 170, 230];
  return [30, 32, 40];
});
const strip = name.find(frame);
assert.ok(strip, 'the strip is found');
assert.ok(strip.y >= 18 && strip.y <= 22 && strip.h >= 45 && strip.h <= 52, JSON.stringify(strip));
// Without letters there is no name strip to read.
assert.equal(name.find(image(300, 240, (x, y) => (y >= 80 && y < 230 ? [120, 170, 230] : [30, 32, 40]))), null);
// Ink: letters black, strip white.
const inked = name.ink(image(40, 20, (x) => (x < 20 ? [245, 245, 240] : [160, 200, 228])));
assert.equal(inked.data[0], 0);
assert.equal(inked.data[(30) * 4], 255);
console.log('map-name: matching and strip finding pass');
// Numerals as the recognizer often slips on them.
assert.equal(name.match('Dungeon\nTree Dungeon, Forest Up North Il', maps).id, '10002073');
assert.equal(name.match('Dungeon\nTree Dungeon, Forest Up North 11', maps).id, '10002073');
assert.equal(name.match('Dungeon\nTree Dungeon, Forest Up North l', maps).id, '10002072');
console.log('map-name: numerals pass');
// A dungeon road on "Warning Street" (as read from a real header).
assert.equal(name.match('Warning Street\nThe Roar to the Dungeon\n', [...maps, { id: '10001090', name: 'The Road to the Dungeon', street: 'Warning Street' }]).id, '10001090');
console.log('map-name: Warning Street passes');
// A deep blue sky beside the minimap (a game window over a blue sky) is not the name strip.
{
  const sky = image(300, 240, (x, y) => {
    if (y >= 20 && y < 70 && x >= 10 && x < 150) {
      const letter = x >= 40 && x < 140 && ((y >= 28 && y < 40) || (y >= 50 && y < 62)) && x % 9 < 4;
      return letter ? [245, 245, 240] : [145, 175, 195];
    }
    return [40, 115, 228];   // sky
  });
  const strip = name.find(sky);
  assert.ok(strip && strip.y >= 18 && strip.y <= 22 && strip.h >= 45 && strip.h <= 52 && strip.w <= 150, JSON.stringify(strip));
  console.log('map-name: sky beside the minimap passes');
}
