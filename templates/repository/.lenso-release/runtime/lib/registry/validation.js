export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
export const SHA256 = /^sha256:[a-f0-9]{64}$/u;
export function isRfc3339(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
    if (!match || !Number.isFinite(Date.parse(value)))
        return false;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    if (hour > 23 || minute > 59 || second > 59)
        return false;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return month >= 1 && month <= 12 && day >= 1 && day <= days;
}
export function isCanonicalNpmIntegrity(value) {
    if (!value.startsWith("sha512-"))
        return false;
    const encoded = value.slice(7);
    try {
        const bytes = Buffer.from(encoded, "base64");
        return bytes.length === 64 && bytes.toString("base64") === encoded;
    }
    catch {
        return false;
    }
}
export function compatibleDigests(left, right) {
    return (left.startsWith("sha256:") && right.startsWith("sha256:")) ||
        (left.startsWith("sha512-") && right.startsWith("sha512-"));
}
