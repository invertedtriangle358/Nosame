import { NOSTR_KINDS } from "./config.js";

const Bech32 = (() => {
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

    const polymod = (values) => {
        const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;

        values.forEach((value) => {
            const top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ value;
            for (let i = 0; i < 5; i += 1) {
                if ((top >> i) & 1) chk ^= generators[i];
            }
        });

        return chk;
    };

    const hrpExpand = (hrp) => {
        const result = [];
        for (let i = 0; i < hrp.length; i += 1) result.push(hrp.charCodeAt(i) >> 5);
        result.push(0);
        for (let i = 0; i < hrp.length; i += 1) result.push(hrp.charCodeAt(i) & 31);
        return result;
    };

    const createChecksum = (hrp, data) => {
        const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
        const mod = polymod(values) ^ 1;
        const checksum = [];

        for (let i = 0; i < 6; i += 1) {
            checksum.push((mod >> (5 * (5 - i))) & 31);
        }

        return checksum;
    };

    const verifyChecksum = (hrp, data) => polymod([...hrpExpand(hrp), ...data]) === 1;

    const encode = (hrp, data) => {
        const combined = [...data, ...createChecksum(hrp, data)];
        return `${hrp}1${combined.map((value) => CHARSET[value]).join("")}`;
    };

    const decode = (value) => {
        if (typeof value !== "string") throw new Error("Invalid bech32 string.");

        const input = value.toLowerCase();
        const pos = input.lastIndexOf("1");
        if (pos < 1 || pos + 7 > input.length) throw new Error("Invalid bech32 string.");

        const hrp = input.slice(0, pos);
        const data = [];
        for (let i = pos + 1; i < input.length; i += 1) {
            const idx = CHARSET.indexOf(input[i]);
            if (idx === -1) throw new Error("Invalid bech32 character.");
            data.push(idx);
        }

        if (!verifyChecksum(hrp, data)) throw new Error("Invalid bech32 checksum.");
        return { hrp, data: data.slice(0, -6) };
    };

    const convertBits = (data, fromBits, toBits, pad) => {
        let acc = 0;
        let bits = 0;
        const result = [];
        const maxv = (1 << toBits) - 1;

        for (const value of data) {
            if (value < 0 || value >> fromBits) throw new Error("Invalid value.");
            acc = (acc << fromBits) | value;
            bits += fromBits;

            while (bits >= toBits) {
                bits -= toBits;
                result.push((acc >> bits) & maxv);
            }
        }

        if (pad) {
            if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
            throw new Error("Invalid padding.");
        }

        return result;
    };

    return { encode, decode, convertBits };
})();

export class NostrCodec {
    static isHexPubkey(value) {
        return /^[0-9a-f]{64}$/i.test(value);
    }

    static hexToBytes(hex) {
        const bytes = [];
        for (let i = 0; i < hex.length; i += 2) {
            bytes.push(parseInt(hex.slice(i, i + 2), 16));
        }
        return bytes;
    }

    static bytesToHex(bytes) {
        return bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    static numberToBytes(value) {
        return [
            (value >>> 24) & 0xff,
            (value >>> 16) & 0xff,
            (value >>> 8) & 0xff,
            value & 0xff,
        ];
    }

    static bytesToNumber(bytes) {
        return bytes.reduce((result, value) => (result << 8) | value, 0) >>> 0;
    }

    static textToBytes(text) {
        return [...new TextEncoder().encode(text)];
    }

    static bytesToText(bytes) {
        return new TextDecoder().decode(new Uint8Array(bytes));
    }
    
    static toNpub(pubkeyHex) {
        if (typeof pubkeyHex !== "string") throw new Error("Invalid pubkey.");

        const normalized = pubkeyHex.toLowerCase();
        if (!this.isHexPubkey(normalized)) throw new Error("Invalid pubkey.");

        const words = Bech32.convertBits(this.hexToBytes(normalized), 8, 5, true);
        return Bech32.encode("npub", words);
    }

    static fromNpub(npub) {
        const { hrp, data } = Bech32.decode(npub);
        if (hrp !== "npub") throw new Error("Only npub is supported.");

        const bytes = Bech32.convertBits(data, 5, 8, false);
        const hex = this.bytesToHex(bytes);
        if (!this.isHexPubkey(hex)) throw new Error("Invalid npub.");
        return hex;
    }

    static normalizePubkey(value) {
        if (typeof value !== "string") throw new Error("Unsupported pubkey.");

        const trimmed = value.trim();
        if (!trimmed) throw new Error("Empty value.");

        if (trimmed.toLowerCase().startsWith("npub1")) return this.fromNpub(trimmed);
        if (this.isHexPubkey(trimmed)) return trimmed.toLowerCase();
        throw new Error("Unsupported pubkey.");
    }

    static formatShortNpub(pubkeyHex) {
        const npub = this.toNpub(pubkeyHex);
        return {
            npub,
            short: `${npub.slice(0, 10)}...${npub.slice(-6)}`,
        };
    }
    
    static toNevent({ id, relays = [], author = "", kind = NOSTR_KINDS.TEXT } = {}) {
        if (!/^[0-9a-f]{64}$/i.test(id ?? "")) throw new Error("Invalid event id.");

        const tlv = [
            0,
            32,
            ...this.hexToBytes(id.toLowerCase()),
        ];

        relays
            .filter((relay) => typeof relay === "string" && relay)
            .forEach((relay) => {
                const bytes = this.textToBytes(relay);
                tlv.push(1, bytes.length, ...bytes);
            });

        if (this.isHexPubkey(author)) {
            tlv.push(2, 32, ...this.hexToBytes(author.toLowerCase()));
        }

        if (Number.isInteger(kind)) {
            tlv.push(3, 4, ...this.numberToBytes(kind));
        }

        return Bech32.encode("nevent", Bech32.convertBits(tlv, 8, 5, true));
    }

    static fromNevent(value) {
        const raw = String(value ?? "").replace(/^nostr:/i, "");
        const { hrp, data } = Bech32.decode(raw);
        if (hrp !== "nevent" && hrp !== "note") throw new Error("Unsupported event reference.");

        if (hrp === "note") {
            const bytes = Bech32.convertBits(data, 5, 8, false);
            const id = this.bytesToHex(bytes);
            if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error("Invalid note id.");
            return { id, relays: [], author: "", kind: NOSTR_KINDS.TEXT };
        }

        const bytes = Bech32.convertBits(data, 5, 8, false);
        const result = { id: "", relays: [], author: "", kind: undefined };

        for (let i = 0; i < bytes.length;) {
            const type = bytes[i];
            const length = bytes[i + 1];
            const valueBytes = bytes.slice(i + 2, i + 2 + length);

            if (type === 0 && length === 32) result.id = this.bytesToHex(valueBytes);
            if (type === 1) result.relays.push(this.bytesToText(valueBytes));
            if (type === 2 && length === 32) result.author = this.bytesToHex(valueBytes);
            if (type === 3 && length === 4) result.kind = this.bytesToNumber(valueBytes);

            i += 2 + length;
        }

        if (!/^[0-9a-f]{64}$/i.test(result.id)) throw new Error("Invalid nevent id.");
        return result;
    }
}
