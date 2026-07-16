import { NostrCodec } from "./nostr-codec.js";

const EVENT_REFERENCE_PATTERN_SOURCE =
    String.raw`(?:nostr:(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+|\b(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+)`;

function createEventReferencePattern() {
    return new RegExp(EVENT_REFERENCE_PATTERN_SOURCE, "gi");
}

function decodeEventReference(value) {
    try {
        return NostrCodec.fromNevent(value);
    } catch {
        return null;
    }
}

export function extractEventReferences(text, limit = Infinity) {
    const references = [];
    const maxReferences = Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : Infinity;

    for (const match of String(text ?? "").matchAll(createEventReferencePattern())) {
        if (references.length >= maxReferences) break;

        const reference = decodeEventReference(match[0]);
        if (!reference) continue;

        const alreadyExists = references.some(
            (item) => item.id === reference.id
        );

        if (!alreadyExists) {
            references.push(reference);
        }
    }

    return references;
}

export function stripEventReferences(text) {
    return String(text ?? "")
        .replace(
            createEventReferencePattern(),
            (candidate) => decodeEventReference(candidate) ? "" : candidate
        )
        .trim();
}
