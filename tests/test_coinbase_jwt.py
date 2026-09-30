import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

import app


def decode_segment(segment):
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


class CoinbaseJwtTests(unittest.TestCase):
    def setUp(self):
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.secret = self.private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")

    def build_token(self):
        with patch.dict(os.environ, {
            "COINBASE_API_KEY": "organizations/test/apiKeys/key",
            "COINBASE_API_SECRET": self.secret,
        }):
            return app.build_coinbase_jwt(
                "GET",
                "/api/v3/brokerage/accounts",
            )

    def test_builds_valid_es256_signature_in_process(self):
        token = self.build_token()
        header_segment, payload_segment, signature_segment = token.split(".")
        signature = decode_segment(signature_segment)
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")

        self.private_key.public_key().verify(
            encode_dss_signature(r, s),
            f"{header_segment}.{payload_segment}".encode("utf-8"),
            ec.ECDSA(hashes.SHA256()),
        )

        header = json.loads(decode_segment(header_segment))
        payload = json.loads(decode_segment(payload_segment))
        self.assertEqual(header["alg"], "ES256")
        self.assertEqual(
            payload["uri"],
            "GET api.coinbase.com/api/v3/brokerage/accounts",
        )

    def test_parallel_signing_has_no_shared_subprocess_bottleneck(self):
        with ThreadPoolExecutor(max_workers=16) as executor:
            tokens = list(executor.map(lambda _: self.build_token(), range(32)))

        self.assertEqual(len(set(tokens)), 32)


if __name__ == "__main__":
    unittest.main()
