/**
 * Shim for @proton/crypto (CryptoProxy)
 * Provides PGP operations using openpgp package
 */

import * as openpgp from 'openpgp';

export const CryptoProxy = {
    /**
     * Import a public key from armored format
     */
    async importPublicKey({ armoredKey }: { armoredKey: string }): Promise<openpgp.PublicKey> {
        return openpgp.readKey({ armoredKey });
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
};
