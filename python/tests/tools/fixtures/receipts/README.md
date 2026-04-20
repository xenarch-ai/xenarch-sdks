# Signed-receipt test fixtures

**These are test-only keys.** `xenarch_signed.privkey.pem` is an Ed25519 private
key generated solely to produce `xenarch_signed.json` for the receipt-verify
tests. It has no connection to any facilitator that ever holds real funds.

Do NOT:
- reuse this keypair for any production signing,
- copy it into a deployed facilitator's secret store,
- or accept a receipt signed by this key outside of this test suite.

To regenerate, ensure `cryptography` is installed and run a script that:

1. Creates a fresh `Ed25519PrivateKey`.
2. Exports the private key as PKCS#8 PEM (unencrypted, test-only) and the
   public key as PKIX/SubjectPublicKeyInfo PEM.
3. Builds a payload dict (same fields as `xenarch_signed.json` minus
   `signature`), canonicalises it with `xenarch._receipts.canonical_json`,
   signs those bytes, and base64-encodes the signature into the
   `signature` field.
4. Writes all three files back here.

The JSON payload is what the platform's receipt signer produces; keeping
this fixture aligned with the real signer catches canonical-JSON drift.
