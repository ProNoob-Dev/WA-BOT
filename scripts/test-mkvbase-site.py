"""Python side of the protocol cross-check (same fixed inputs as the Node test).
Copied verbatim from the harvester's app/protocol.py.
Run: python3 scripts/test-mkvbase-site.py
"""
import hashlib
import hmac
import json


def sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def hmac_sha256_hex(key, msg):
    return hmac.new(key.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()


def xor_encode_hex(term, ts_ms):
    key = ts_ms % 256
    return bytes(b ^ key for b in term.encode("utf-8")).hex()


def solve_pow(salt, difficulty, data_hex, max_iters=2_000_000):
    prefix = "0" * difficulty
    for nonce in range(max_iters):
        h1 = sha256_hex(f"{salt}:{nonce}")
        if sha256_hex(f"{h1}:{data_hex}").startswith(prefix):
            return nonce
    raise RuntimeError("proof-of-work exhausted")


def search_signature(client_key, q_hex, ts_ms, seq, nonce, ent):
    return hmac_sha256_hex(client_key, f"{q_hex}:{ts_ms}:{seq}:{nonce}:{ent}")


TERM = "the beast"
TS_MS = 1763300000123
CLIENT_KEY = "ab" * 32
CHALLENGE = "deadbeefcafe1234:2:1794836000000:0123456789abcdef"
SEQ = "1"
ENT = 10

salt, difficulty = CHALLENGE.split(":")[0], int(CHALLENGE.split(":")[1])
q_hex = xor_encode_hex(TERM, TS_MS)
nonce = solve_pow(salt, difficulty, q_hex)
sig = search_signature(CLIENT_KEY, q_hex, TS_MS, SEQ, nonce, ENT)
print(json.dumps({"q": q_hex, "pow": nonce, "sig": sig}, indent=2))
