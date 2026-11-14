import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'Blue', 'Red', 'Green', 'Amber', 'Silver', 'Golden', 'Violet', 'Coral',
  'Swift', 'Quiet', 'Bright', 'Lucky', 'Brave', 'Calm', 'Clever', 'Sunny',
  'Misty', 'Jolly', 'Gentle', 'Bold', 'Teal', 'Indigo', 'Rusty', 'Frosty',
];
const ANIMALS = [
  'Fox', 'Owl', 'Otter', 'Hawk', 'Lynx', 'Panda', 'Koala', 'Heron',
  'Badger', 'Falcon', 'Dolphin', 'Tiger', 'Wolf', 'Robin', 'Moose', 'Gecko',
  'Bison', 'Raven', 'Seal', 'Crane', 'Hare', 'Puffin', 'Marten', 'Wren',
];

export function randomNickname() {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]}`;
}
