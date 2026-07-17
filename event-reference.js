import { CONFIG, NOSTR_KINDS } from "./config.js";
import { NostrCodec } from "./nostr-codec.js";

const EVENT_REFERENCE_PATTERN_SOURCE =
    String.raw`(?:nostr:(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+|\b(?:nevent|note)1[023456789acdefghjklmnpqrstuvwxyz]+)`;

export class EventReference {
    static _createPattern() {
        return new RegExp(
            EVENT_REFERENCE_PATTERN_SOURCE,
            "gi"
        );
    }

    static _normalizeLimit(limit) {
        return Number.isFinite(limit)
            ? Math.max(0, Math.floor(limit))
            : Infinity;
    }

    static isHexId(value) {
        return (
            typeof value === "string" &&
            /^[0-9a-f]{64}$/i.test(value)
        );
    }

    static decode(value) {
        try {
            return NostrCodec.fromNevent(value);
        } catch {
            return null;
        }
    }

    static addUnique(
        references,
        reference,
        limit = Infinity
    ) {
        if (!Array.isArray(references)) return false;

        if (
            references.length >=
            this._normalizeLimit(limit)
        ) {
            return false;
        }

        if (!this.isHexId(reference?.id)) {
            return false;
        }

        const id = reference.id.toLowerCase();

        if (
            references.some(
                (item) => item.id === id
            )
        ) {
            return false;
        }

        references.push({
            ...reference,
            id,
        });

        return true;
    }

    static extractFromText(
        text,
        limit = Infinity
    ) {
        const references = [];
        const maxReferences =
            this._normalizeLimit(limit);

        for (
            const match of String(text ?? "")
                .matchAll(this._createPattern())
        ) {
            if (
                references.length >= maxReferences
            ) {
                break;
            }

            const reference = this.decode(match[0]);

            if (reference) {
                this.addUnique(
                    references,
                    reference,
                    maxReferences
                );
            }
        }

        return references;
    }

    static stripFromText(text) {
        return String(text ?? "")
            .replace(
                this._createPattern(),
                (candidate) =>
                    this.decode(candidate)
                        ? ""
                        : candidate
            )
            .trim();
    }

    static fromEvent(event) {
        if (!this.isHexId(event?.id)) {
            return null;
        }

        return {
            id: event.id.toLowerCase(),

            relays:
                typeof event._relayUrl === "string" &&
                event._relayUrl
                    ? [event._relayUrl]
                    : [],

            author: this.isHexId(event.pubkey)
                ? event.pubkey.toLowerCase()
                : "",

            kind: Number.isInteger(event.kind)
                ? event.kind
                : NOSTR_KINDS.TEXT,
        };
    }

    static toNevent(event) {
        const reference = this.fromEvent(event);

        return reference
            ? NostrCodec.toNevent(reference)
            : "";
    }

    static getEventTagReferences(event) {
        const tags = Array.isArray(event?.tags)
            ? event.tags
            : [];

        return tags
            .filter(
                (tag) =>
                    Array.isArray(tag) &&
                    tag[0] === "e" &&
                    this.isHexId(tag[1])
            )
            .map((tag) => ({
                id: tag[1].toLowerCase(),

                relays:
                    typeof tag[2] === "string" &&
                    tag[2]
                        ? [tag[2]]
                        : [],

                marker:
                    typeof tag[3] === "string"
                        ? tag[3]
                        : "",

                author: this.isHexId(tag[4])
                    ? tag[4].toLowerCase()
                    : "",

                kind: NOSTR_KINDS.TEXT,
            }));
    }

    static getReplyRoot(event) {
        if (
            event?.kind !== NOSTR_KINDS.TEXT
        ) {
            return null;
        }

        const references =
            this.getEventTagReferences(event);

        return (
            references.find(
                (reference) =>
                    reference.marker === "root"
            ) ??
            references[0] ??
            null
        );
    }

    static getReplyParent(event) {
        if (
            event?.kind !== NOSTR_KINDS.TEXT
        ) {
            return null;
        }

        const references =
            this.getEventTagReferences(event);

        return (
            references.find(
                (reference) =>
                    reference.marker === "reply"
            ) ??
            references[
                references.length - 1
            ] ??
            null
        );
    }

    static getParticipantPubkeys(event) {
        const tags = Array.isArray(event?.tags)
            ? event.tags
            : [];

        const pubkeys = [
            event?.pubkey,

            ...tags
                .filter(
                    (tag) =>
                        Array.isArray(tag) &&
                        tag[0] === "p"
                )
                .map((tag) => tag[1]),
        ];

        return [
            ...new Set(
                pubkeys
                    .filter((pubkey) =>
                        this.isHexId(pubkey)
                    )
                    .map((pubkey) =>
                        pubkey.toLowerCase()
                    )
            ),
        ];
    }

    static buildReplyTags(target) {
        const parentReference =
            this.fromEvent(target);

        if (!parentReference) {
            return [];
        }

        const rootReference =
            this.getReplyRoot(target) ??
            parentReference;

        const eventTags =
            rootReference.id ===
            parentReference.id
                ? [[
                    "e",
                    parentReference.id,
                    parentReference.relays[0] ?? "",
                    "root",
                    parentReference.author,
                ]]
                : [
                    [
                        "e",
                        rootReference.id,
                        rootReference.relays[0] ?? "",
                        "root",
                        rootReference.author,
                    ],
                    [
                        "e",
                        parentReference.id,
                        parentReference.relays[0] ?? "",
                        "reply",
                        parentReference.author,
                    ],
                ];

        const pubkeyTags =
            this.getParticipantPubkeys(target)
                .map((pubkey) => [
                    "p",
                    pubkey,
                ]);

        return [
            ...eventTags,
            ...pubkeyTags,
        ];
    }

    static getQuoteReferences(
        event,
        limit =
            CONFIG.MAX_QUOTE_REFERENCES_PER_EVENT
    ) {
        const references = [];

        const tags = Array.isArray(event?.tags)
            ? event.tags
            : [];

        const maxReferences =
            this._normalizeLimit(limit);

        tags
            .filter(
                (tag) =>
                    Array.isArray(tag) &&
                    tag[0] === "q" &&
                    this.isHexId(tag[1])
            )
            .forEach((tag) => {
                this.addUnique(
                    references,
                    {
                        id: tag[1],

                        relays:
                            typeof tag[2] === "string" &&
                            tag[2]
                                ? [tag[2]]
                                : [],

                        author:
                            this.isHexId(tag[3])
                                ? tag[3].toLowerCase()
                                : "",

                        kind: NOSTR_KINDS.TEXT,
                    },
                    maxReferences
                );
            });

        if (
            event?.kind ===
            NOSTR_KINDS.REPOST
        ) {
            this.getEventTagReferences(event)
                .forEach((reference) => {
                    this.addUnique(
                        references,
                        reference,
                        maxReferences
                    );
                });
        } else {
            this.extractFromText(
                event?.content ?? "",
                maxReferences -
                    references.length
            ).forEach((reference) => {
                this.addUnique(
                    references,
                    reference,
                    maxReferences
                );
            });
        }

        return references;
    }

    static getRepostTargetId(event) {
        const [reference] =
            this.getEventTagReferences(event);

        return reference?.id ?? "";
    }

    static hasEventReference(event, id) {
        const normalized =
            String(id ?? "").toLowerCase();

        if (!this.isHexId(normalized)) {
            return false;
        }

        return this
            .getEventTagReferences(event)
            .some(
                (reference) =>
                    reference.id === normalized
            );
    }
}
