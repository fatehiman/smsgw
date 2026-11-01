'use strict';
// Usage: node scripts/hash-password.js "the password"
const { hashPassword } = require('../src/util');

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node scripts/hash-password.js "the password"');
  process.exit(1);
}
console.log(hashPassword(pw));
