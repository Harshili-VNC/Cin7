"""
Encryption helper for credentials at rest.

IMPORTANT:
- The encryption key must come from Azure Key Vault in production.
- ENCRYPTION_KEY env var below is a placeholder for local testing ONLY.
  In Azure, wire this up via a Key Vault reference in your Function App /
  Container App configuration - never commit a real key to source control.
- Uses Fernet (symmetric encryption, AES-128 under the hood) from the
  'cryptography' library. Install with: pip install cryptography
"""

import os
from cryptography.fernet import Fernet, InvalidToken


class EncryptionError(Exception):
    pass


def _get_fernet() -> Fernet:
    key = os.environ.get("ENCRYPTION_KEY", "bGFzYXNkc2FkYXNkYXNkYXNkYXNkYXNkYXNkYXNkYXM=")
    return Fernet(key.encode())


def encrypt_value(plaintext: str) -> str:
    """Encrypt a plaintext string (e.g. a Cin7 API key) before DB storage."""
    if plaintext is None:
        return None
    f = _get_fernet()
    return f.encrypt(plaintext.encode()).decode()


def decrypt_value(ciphertext: str) -> str:
    """Decrypt a value pulled from the database, immediately before use."""
    if ciphertext is None:
        return None
    f = _get_fernet()
    try:
        return f.decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        raise EncryptionError(
            "Failed to decrypt value - wrong key, or data corrupted/tampered."
        )


def generate_new_key() -> str:
    """
    Run this ONCE to generate your encryption key, then store the result
    in Azure Key Vault. Do not regenerate this casually - doing so makes
    all previously-encrypted data unreadable.
    """
    return Fernet.generate_key().decode()


if __name__ == "__main__":
    print("New encryption key (store this in Azure Key Vault, not here):")
    print(generate_new_key())
