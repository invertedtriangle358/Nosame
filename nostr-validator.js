export class EventValidator {
    constructor(storage) {
        this.storage = storage;
    }

    isHex(value, length) {
        return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
    }

    isKindValid(kind) {
        return Number.isInteger(kind) && kind >= 0 && kind <= 65535;
    }
