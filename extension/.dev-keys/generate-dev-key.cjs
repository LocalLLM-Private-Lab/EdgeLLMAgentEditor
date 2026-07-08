// Generates a stable dev signing key for unpacked extension loading.
// Chrome/Edge computes the extension ID from the SPKI DER public key,
// so pinning "key" in the manifest keeps the ID stable across reloads.
// This lets the Rust terminal-host validate the WebSocket Origin header.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
const manifestKey = spkiDer.toString('base64');

// Chrome extension ID: first 16 bytes of SHA256(SPKI DER), each nibble
// mapped to a-p (0->a ... 15->p).
const hash = crypto.createHash('sha256').update(spkiDer).digest();
const idBytes = hash.subarray(0, 16);
let extensionId = '';
for (const byte of idBytes) {
  extensionId += String.fromCharCode(97 + (byte >> 4));
  extensionId += String.fromCharCode(97 + (byte & 0x0f));
}

fs.writeFileSync(
  path.join(__dirname, 'dev-key.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
);
fs.writeFileSync(path.join(__dirname, 'manifest-key.txt'), manifestKey);
fs.writeFileSync(path.join(__dirname, 'extension-id.txt'), extensionId);

console.log('manifestKey:', manifestKey);
console.log('extensionId:', extensionId);
