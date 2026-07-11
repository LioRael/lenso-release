import { createHash } from "node:crypto";
function serialize(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (Number.isFinite(value))
            return JSON.stringify(value);
        throw new TypeError("canonical JSON cannot encode a non-finite number");
    }
    if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
            throw new TypeError("canonical JSON cannot encode a non-JSON array");
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor ||
            lengthDescriptor.enumerable ||
            !("value" in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) ||
            lengthDescriptor.value < 0) {
            throw new TypeError("canonical JSON cannot encode a non-JSON array");
        }
        const length = lengthDescriptor.value;
        const keys = Reflect.ownKeys(value);
        const expectedKeyCount = length + 1;
        if (keys.length !== expectedKeyCount ||
            !keys.every((key) => key === "length" ||
                (typeof key === "string" &&
                    Number.isSafeInteger(Number(key)) &&
                    String(Number(key)) === key &&
                    Number(key) >= 0 &&
                    Number(key) < length))) {
            throw new TypeError("canonical JSON cannot encode a non-JSON array");
        }
        let result = "[";
        for (let index = 0; index < length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor?.enumerable || !("value" in descriptor)) {
                throw new TypeError("canonical JSON cannot encode a non-JSON array");
            }
            if (index > 0)
                result += ",";
            result += serialize(descriptor.value);
        }
        return `${result}]`;
    }
    if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("canonical JSON cannot encode a non-plain object");
        }
        const entries = Reflect.ownKeys(value)
            .map((key) => {
            if (typeof key !== "string") {
                throw new TypeError("canonical JSON cannot encode a symbol-keyed object");
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !("value" in descriptor)) {
                throw new TypeError("canonical JSON cannot encode a non-data property");
            }
            return [key, descriptor.value];
        })
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return `{${entries
            .map(([key, entryValue]) => `${JSON.stringify(key)}:${serialize(entryValue)}`)
            .join(",")}}`;
    }
    throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}
export function canonicalBytes(value) {
    return Buffer.from(serialize(value), "utf8");
}
export function sha256(value) {
    const bytes = value instanceof Uint8Array ? value : canonicalBytes(value);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
