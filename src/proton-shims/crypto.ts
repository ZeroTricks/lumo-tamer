/**
 * Shim for @proton/crypto (CryptoProxy)
 * Provides PGP operations using openpgp package
 */

import * as openpgp from 'openpgp';

// Re-export key types for convenience
export type PrivateKey = openpgp.PrivateKey;
export type PublicKey = openpgp.PublicKey;

export const CryptoProxy = {
    /**
     * Import a public key from armored format
     */
    async importPublicKey({ armoredKey }: { armoredKey: string }): Promise<openpgp.PublicKey> {
        return openpgp.readKey({ armoredKey });
    },

    /**
     * Import a private key from armored format
     * Decrypts the key if a passphrase is provided
     */
    async importPrivateKey({
        armoredKey,
        passphrase,
    }: {
        armoredKey: string;
        passphrase?: string;
    }): Promise<openpgp.PrivateKey> {
        const privateKey = await openpgp.readPrivateKey({ armoredKey });

        if (passphrase) {
            return openpgp.decryptKey({
                privateKey,
                passphrase,
            });
        }

        return privateKey;
    },

    /**
     * Encrypt a message with a public key
     */
    async encryptMessage({
        binaryData,
        encryptionKeys,
        format,
    }: {
        binaryData: Uint8Array;
        encryptionKeys: openpgp.PublicKey;
        format: 'binary' | 'armored';
    }): Promise<{ message: { toBase64(): string } }> {
        const message = await openpgp.createMessage({ binary: binaryData });
        const encrypted = await openpgp.encrypt({
            message,
            encryptionKeys,
            format: 'binary',
        });

        // encrypted is Uint8Array when format is 'binary'
        const encryptedBytes = encrypted as Uint8Array;

        return {
            message: {
                toBase64(): string {
                    return Buffer.from(encryptedBytes).toString('base64');
                },
            },
        };
    },

    /**
     * Decrypt a message with private keys
     */
    async decryptMessage({
        armoredMessage,
        binaryMessage,
        decryptionKeys,
        format,
    }: {
        armoredMessage?: string;
        binaryMessage?: Uint8Array;
        decryptionKeys: openpgp.PrivateKey | openpgp.PrivateKey[];
        format: 'binary' | 'utf8';
    }): Promise<{ data: Uint8Array | string }> {
        let message: openpgp.Message<Uint8Array>;

        if (armoredMessage) {
            message = await openpgp.readMessage({ armoredMessage });
        } else if (binaryMessage) {
            message = await openpgp.readMessage({ binaryMessage });
        } else {
            throw new Error('Either armoredMessage or binaryMessage must be provided');
        }

        const keys = Array.isArray(decryptionKeys) ? decryptionKeys : [decryptionKeys];

        const decrypted = await openpgp.decrypt({
            message,
            decryptionKeys: keys,
            format: format === 'binary' ? 'binary' : 'utf8',
        });

        return { data: decrypted.data };
    },
};
