# E2EE v1 public provisioning records

`<host>.pub` is the standard-base64 raw 32-byte X25519 public key for that named host, serving E2EE v1 client and endpoint identity. These public records are signed Git bootstrap inputs, not runtime key discovery. Verify the exact commit against a previously trusted signing key before installing a pin. Never add private keys or authentication tokens here. Rotation requires explicit local replacement; clients never automatically trust this directory.
