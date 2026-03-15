/**
 * Crypto Helper for FoE Proxy
 * Contains exact implementations of ff() and GW.encode() from the original
 */

const FoeCrypto = (function () {
    "use strict";

    // ========================================================================
    // FF Class - Binary wrapper (exact original implementation)
    // ========================================================================
    function FF(arrayBuffer) {
        this.length = arrayBuffer.byteLength;
        this.b = new Uint8Array(arrayBuffer);
        this.b.bufferValue = arrayBuffer;
        arrayBuffer.hxBytes = this;
        arrayBuffer.bytes = this.b;
    }

    // Static method to create FF from string (exact original UTF-8 encoding)
    FF.ofString = function (str) {
        const bytes = [];

        for (let i = 0; i < str.length; i++) {
            let code = str.charCodeAt(i);

            // Handle surrogate pairs exactly like original
            if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
                const nextCode = str.charCodeAt(i + 1);
                if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
                    code = ((code - 0xD800) << 10) + (nextCode - 0xDC00) + 0x10000;
                    i++; // Skip next character as we've processed it
                }
            }

            // UTF-8 encoding exactly as in original
            if (code <= 0x7F) {
                bytes.push(code);
            } else if (code <= 0x7FF) {
                bytes.push(0xC0 | (code >> 6));
                bytes.push(0x80 | (code & 0x3F));
            } else if (code <= 0xFFFF) {
                bytes.push(0xE0 | (code >> 12));
                bytes.push(0x80 | ((code >> 6) & 0x3F));
                bytes.push(0x80 | (code & 0x3F));
            } else {
                bytes.push(0xF0 | (code >> 18));
                bytes.push(0x80 | ((code >> 12) & 0x3F));
                bytes.push(0x80 | ((code >> 6) & 0x3F));
                bytes.push(0x80 | (code & 0x3F));
            }
        }

        return new FF(new Uint8Array(bytes).buffer);
    };

    function bitOR(a, b) {
        return ((a >>> 1) | (b >>> 1)) << 1 | (a & 1) | (b & 1);
    }

    function bitXOR(a, b) {
        return ((a >>> 1) ^ (b >>> 1)) << 1 | (a & 1) ^ (b & 1);
    }

    function bitAND(a, b) {
        return ((a >>> 1) & (b >>> 1)) << 1 | (a & 1) & (b & 1);
    }

    function addme(a, b) {
        const lsw = (a & 0xFFFF) + (b & 0xFFFF);
        const msw = (a >>> 16) + (b >>> 16) + (lsw >>> 16);
        return ((msw & 0xFFFF) << 16) | (lsw & 0xFFFF);
    }

    function rol(value, shift) {
        return (value << shift) | (value >>> (32 - shift));
    }

    function cmn(q, a, b, x, s, t) {
        return addme(rol(addme(addme(a, q), addme(x, t)), s), b);
    }

    function ff(a, b, c, d, x, s, t) {
        return cmn(bitOR(bitAND(b, c), bitAND(~b, d)), a, b, x, s, t);
    }

    function gg(a, b, c, d, x, s, t) {
        return cmn(bitOR(bitAND(b, d), bitAND(c, ~d)), a, b, x, s, t);
    }

    function hh(a, b, c, d, x, s, t) {
        return cmn(bitXOR(bitXOR(b, c), d), a, b, x, s, t);
    }

    function ii(a, b, c, d, x, s, t) {
        return cmn(bitXOR(c, bitOR(b, ~d)), a, b, x, s, t);
    }

    const T = [
        -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426,
        -1473231341, -45705983, 1770035416, -1958414417, -42063, -1990404162,
        1804603682, -40341101, -1502002290, 1236535329, -165796510, -1069501632,
        643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
        568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784,
        1735328473, -1926607734, -378558, -2022574463, 1839030562, -35309556,
        -1530992060, 1272893353, -155497632, -1094730640, 681279174, -358537222,
        -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
        -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606,
        -1051523, -2054922799, 1873313359, -30611744, -1560198380, 1309151649,
        -145523070, -1120210379, 718787259, -343485551
    ];

    function str2blks(str) {
        const ff = FF.ofString(str);
        const blockCount = ((ff.length + 8) >> 6) + 1;
        const blocks = new Array(16 * blockCount).fill(0);

        for (let i = 0; i < ff.length; i++) {
            blocks[i >> 2] |= ff.b[i] << (((ff.length * 8) + i) % 4 * 8);
        }

        blocks[ff.length >> 2] |= 0x80 << (((ff.length * 8) + ff.length) % 4 * 8);

        const lengthInBits = ff.length * 8;
        const lastBlockIndex = 16 * blockCount - 2;

        blocks[lastBlockIndex] = lengthInBits & 0xFF;
        blocks[lastBlockIndex] |= ((lengthInBits >>> 8) & 0xFF) << 8;
        blocks[lastBlockIndex] |= ((lengthInBits >>> 16) & 0xFF) << 16;
        blocks[lastBlockIndex] |= ((lengthInBits >>> 24) & 0xFF) << 24;

        return blocks;
    }

    // Main MD5 transformation (exact original sequence)
    function doEncode(blocks) {
        let a = 1732584193;
        let b = -271733879;
        let c = -1732584194;
        let d = 271733878;

        for (let i = 0; i < blocks.length; i += 16) {
            const aa = a;
            const bb = b;
            const cc = c;
            const dd = d;

            // Round 1
            a = ff(a, b, c, d, blocks[i], 7, T[0]);
            d = ff(d, a, b, c, blocks[i + 1], 12, T[1]);
            c = ff(c, d, a, b, blocks[i + 2], 17, T[2]);
            b = ff(b, c, d, a, blocks[i + 3], 22, T[3]);
            a = ff(a, b, c, d, blocks[i + 4], 7, T[4]);
            d = ff(d, a, b, c, blocks[i + 5], 12, T[5]);
            c = ff(c, d, a, b, blocks[i + 6], 17, T[6]);
            b = ff(b, c, d, a, blocks[i + 7], 22, T[7]);
            a = ff(a, b, c, d, blocks[i + 8], 7, T[8]);
            d = ff(d, a, b, c, blocks[i + 9], 12, T[9]);
            c = ff(c, d, a, b, blocks[i + 10], 17, T[10]);
            b = ff(b, c, d, a, blocks[i + 11], 22, T[11]);
            a = ff(a, b, c, d, blocks[i + 12], 7, T[12]);
            d = ff(d, a, b, c, blocks[i + 13], 12, T[13]);
            c = ff(c, d, a, b, blocks[i + 14], 17, T[14]);
            b = ff(b, c, d, a, blocks[i + 15], 22, T[15]);

            // Round 2
            a = gg(a, b, c, d, blocks[i + 1], 5, T[16]);
            d = gg(d, a, b, c, blocks[i + 6], 9, T[17]);
            c = gg(c, d, a, b, blocks[i + 11], 14, T[18]);
            b = gg(b, c, d, a, blocks[i], 20, T[19]);
            a = gg(a, b, c, d, blocks[i + 5], 5, T[20]);
            d = gg(d, a, b, c, blocks[i + 10], 9, T[21]);
            c = gg(c, d, a, b, blocks[i + 15], 14, T[22]);
            b = gg(b, c, d, a, blocks[i + 4], 20, T[23]);
            a = gg(a, b, c, d, blocks[i + 9], 5, T[24]);
            d = gg(d, a, b, c, blocks[i + 14], 9, T[25]);
            c = gg(c, d, a, b, blocks[i + 3], 14, T[26]);
            b = gg(b, c, d, a, blocks[i + 8], 20, T[27]);
            a = gg(a, b, c, d, blocks[i + 13], 5, T[28]);
            d = gg(d, a, b, c, blocks[i + 2], 9, T[29]);
            c = gg(c, d, a, b, blocks[i + 7], 14, T[30]);
            b = gg(b, c, d, a, blocks[i + 12], 20, T[31]);

            // Round 3
            a = hh(a, b, c, d, blocks[i + 5], 4, T[32]);
            d = hh(d, a, b, c, blocks[i + 8], 11, T[33]);
            c = hh(c, d, a, b, blocks[i + 11], 16, T[34]);
            b = hh(b, c, d, a, blocks[i + 14], 23, T[35]);
            a = hh(a, b, c, d, blocks[i + 1], 4, T[36]);
            d = hh(d, a, b, c, blocks[i + 4], 11, T[37]);
            c = hh(c, d, a, b, blocks[i + 7], 16, T[38]);
            b = hh(b, c, d, a, blocks[i + 10], 23, T[39]);
            a = hh(a, b, c, d, blocks[i + 13], 4, T[40]);
            d = hh(d, a, b, c, blocks[i], 11, T[41]);
            c = hh(c, d, a, b, blocks[i + 3], 16, T[42]);
            b = hh(b, c, d, a, blocks[i + 6], 23, T[43]);
            a = hh(a, b, c, d, blocks[i + 9], 4, T[44]);
            d = hh(d, a, b, c, blocks[i + 12], 11, T[45]);
            c = hh(c, d, a, b, blocks[i + 15], 16, T[46]);
            b = hh(b, c, d, a, blocks[i + 2], 23, T[47]);

            // Round 4
            a = ii(a, b, c, d, blocks[i], 6, T[48]);
            d = ii(d, a, b, c, blocks[i + 7], 10, T[49]);
            c = ii(c, d, a, b, blocks[i + 14], 15, T[50]);
            b = ii(b, c, d, a, blocks[i + 5], 21, T[51]);
            a = ii(a, b, c, d, blocks[i + 12], 6, T[52]);
            d = ii(d, a, b, c, blocks[i + 3], 10, T[53]);
            c = ii(c, d, a, b, blocks[i + 10], 15, T[54]);
            b = ii(b, c, d, a, blocks[i + 1], 21, T[55]);
            a = ii(a, b, c, d, blocks[i + 8], 6, T[56]);
            d = ii(d, a, b, c, blocks[i + 15], 10, T[57]);
            c = ii(c, d, a, b, blocks[i + 6], 15, T[58]);
            b = ii(b, c, d, a, blocks[i + 13], 21, T[59]);
            a = ii(a, b, c, d, blocks[i + 4], 6, T[60]);
            d = ii(d, a, b, c, blocks[i + 11], 10, T[61]);
            c = ii(c, d, a, b, blocks[i + 2], 15, T[62]);
            b = ii(b, c, d, a, blocks[i + 9], 21, T[63]);

            // Add this chunk's hash
            a = addme(a, aa);
            b = addme(b, bb);
            c = addme(c, cc);
            d = addme(d, dd);
        }

        return [a, b, c, d];
    }

    // Convert hash to hex string (exact original format)
    function toHex(hashArray) {
        let hex = '';
        for (let i = 0; i < hashArray.length; i++) {
            const num = hashArray[i];
            // Original outputs 8 hex chars per number (4 bytes)
            hex += ((num >>> 0) & 0xFF).toString(16).padStart(2, '0');
            hex += ((num >>> 8) & 0xFF).toString(16).padStart(2, '0');
            hex += ((num >>> 16) & 0xFF).toString(16).padStart(2, '0');
            hex += ((num >>> 24) & 0xFF).toString(16).padStart(2, '0');
        }
        return hex;
    }

    // ========================================================================
    // Public API (exactly what you need)
    // ========================================================================
    return {
        /**
         * Creates a binary wrapper with hxBytes and bytes properties
         * Probably not necessary for export
         * @param {ArrayBuffer} arrayBuffer - The buffer to wrap
         * @returns {FF} FF instance
         */
        FF: FF,

        /**
         * GW.encode - Hash function (exact original implementation)
         * Probably not necessary for export
         * @param {string} str - Input string to hash
         * @returns {string} Hex hash string
         */
        encode: function (str) {
            const blocks = str2blks(str);
            const hash = doEncode(blocks);
            return toHex(hash);
        },

        /**
         * Creates a blob from a string with FF properties attached
         * @param {string} str - Input string
         * @returns {ArrayBuffer} Buffer with hxBytes and bytes properties
         */
        blobber: function (str) {
            const encoder = new TextEncoder();
            const encodedString = encoder.encode(str);
            const buffer = encodedString.buffer;
            buffer.hxBytes = new FF(buffer);
            return buffer;
        },

        /**
         * Generate signature for FoE requests
         * @param {string} jsonHash - The ?h= parameter from URL
         * @param {string} hash - The '*==' parameter from ForgeHX-*.js
         * @param {string} postData - The request post data
         * @returns {string} 10-character signature
         */
        generateSignature: function (jsonHash, hash, postData) {
            const fullSig = this.encode(jsonHash + hash + postData);
            return fullSig.substring(1, 11);
        }
    };
})();

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FoeCrypto;
} else if (typeof window !== 'undefined') {
    window.FoeCrypto = FoeCrypto;
}