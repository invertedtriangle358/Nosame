import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const moduleUrlCache = new Map();
const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

async function moduleDataUrl(absPath) {
    if (!moduleUrlCache.has(absPath)) {
        moduleUrlCache.set(absPath, (async () => {
            const baseDir = dirname(absPath);
            let source = await readFile(absPath, "utf8");
            const imports = [...source.matchAll(/from\s+"(\.\/[^"]+\.js)"/g)];

            for (const match of imports) {
                const specifier = match[1];
                const importedUrl = await moduleDataUrl(resolve(baseDir, specifier));
                source = source.replace(`from "${specifier}"`, `from "${importedUrl}"`);
            }

            return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
        })());
    }

    return moduleUrlCache.get(absPath);
}

async function loadLocalModule(relativePath) {
    return import(await moduleDataUrl(resolve(relativePath)));
}

function createFakeSocket(url = "wss://relay.example") {
    return {
        _relayUrl: url,
        readyState: WebSocket.OPEN,
        sent: [],
        send(data) {
            this.sent.push(data);
        },
        close() {
            this.readyState = WebSocket.CLOSED;
        },
    };
}

function createClientFactory(NostrClient) {
    return function createClient({
        relays = ["wss://relay.example"],
        isEventAuthentic = () => true,
        isEventContentSizeAllowed = () => true,
        isContentInvalid = () => false,
        isPubkeyBlocked = () => false,
    } = {}) {
        const storage = {
            getRelays: () => relays,
        };
        const validator = {
            isEventAuthentic,
            isEventContentSizeAllowed,
            isContentInvalid,
            isPubkeyBlocked,
        };

        return new NostrClient(storage, validator);
    };
}

function createRelaySettingsHandler(SettingsUIHandler, values) {
    const alerts = [];
    globalThis.alert = (message) => alerts.push(message);

    const handler = new SettingsUIHandler(
        {
            buttons: {},
            inputs: {},
            lists: {
                relays: {
                    querySelectorAll: () => values.map((value) => ({ value })),
                },
            },
        },
        {},
        {},
        {}
    );

    return { handler, alerts };
}

globalThis.WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 3,
};

const { CONFIG, NOSTR_KINDS } = await loadLocalModule("config.js");
const { NostrClient } = await loadLocalModule("nostr-client.js");
const { SettingsUIHandler } = await loadLocalModule("ui.js");
const createClient = createClientFactory(NostrClient);
const hex = (char) => char.repeat(64);

test("requestProfiles sends only valid unique pubkeys and stores expected authors", () => {
    const client = createClient();
    const socket = createFakeSocket();
    const pubkey = hex("a");

    client.sockets = [socket];
    client.requestProfiles([pubkey, pubkey.toUpperCase(), "invalid"]);

    assert.equal(socket.sent.length, 1);

    const [, subId, filter] = JSON.parse(socket.sent[0]);
    assert.equal(filter.kinds[0], NOSTR_KINDS.METADATA);
    assert.deepEqual(filter.authors, [pubkey]);
    assert.equal(client.oneShotSubscriptionFilters.get(subId).authors.has(pubkey), true);
});

test("profile one-shot subscription ignores metadata from unrequested pubkeys", () => {
    const client = createClient();
    const socket = createFakeSocket();
    const expectedPubkey = hex("a");
    const unexpectedPubkey = hex("b");
    let metadataCount = 0;

    client.sockets = [socket];
    client.onMetadataCallback = () => {
        metadataCount += 1;
    };
    client.requestProfiles([expectedPubkey]);

    const [, subId] = JSON.parse(socket.sent[0]);
    client._handleMessage({
        data: JSON.stringify([
            "EVENT",
            subId,
            {
                id: hex("1"),
                pubkey: unexpectedPubkey,
                kind: NOSTR_KINDS.METADATA,
                content: "{}",
            },
        ]),
    }, socket);

    client._handleMessage({
        data: JSON.stringify([
            "EVENT",
            subId,
            {
                id: hex("2"),
                pubkey: expectedPubkey,
                kind: NOSTR_KINDS.METADATA,
                content: "{}",
            },
        ]),
    }, socket);

    assert.equal(metadataCount, 1);
});

test("referenced event subscription ignores events whose id was not requested", () => {
    const client = createClient();
    const socket = createFakeSocket();
    const requestedId = hex("3");
    const injectedId = hex("4");
    let referencedCount = 0;

    client.sockets = [socket];
    client.onReferencedEventCallback = () => {
        referencedCount += 1;
    };
    client.requestEvents([requestedId]);

    const [, subId] = JSON.parse(socket.sent[0]);
    client._handleMessage({
        data: JSON.stringify([
            "EVENT",
            subId,
            {
                id: injectedId,
                pubkey: hex("a"),
                kind: NOSTR_KINDS.TEXT,
                content: "injected",
            },
        ]),
    }, socket);

    client._handleMessage({
        data: JSON.stringify([
            "EVENT",
            subId,
            {
                id: requestedId,
                pubkey: hex("a"),
                kind: NOSTR_KINDS.TEXT,
                content: "requested",
            },
        ]),
    }, socket);

    assert.equal(referencedCount, 1);
});

test("oversized relay messages are ignored before JSON parsing", () => {
    const client = createClient();

    assert.doesNotThrow(() => {
        client._handleMessage({ data: "[".repeat(CONFIG.MAX_RELAY_MESSAGE_BYTES + 1) });
    });
});

test("broadcast resolves on accepted OK and rejects when all relays reject", async () => {
    const acceptedClient = createClient();
    const acceptedSocket = createFakeSocket();
    const acceptedEvent = { id: hex("5") };

    acceptedClient.sockets = [acceptedSocket];
    const accepted = acceptedClient._broadcast(acceptedEvent);
    acceptedClient._handleMessage({
        data: JSON.stringify(["OK", acceptedEvent.id, true, ""]),
    }, acceptedSocket);
    await assert.doesNotReject(accepted);

    const rejectedClient = createClient();
    const rejectedSocket = createFakeSocket();
    const rejectedEvent = { id: hex("6") };

    rejectedClient.sockets = [rejectedSocket];
    const rejected = rejectedClient._broadcast(rejectedEvent);
    rejectedClient._handleMessage({
        data: JSON.stringify(["OK", rejectedEvent.id, false, "blocked"]),
    }, rejectedSocket);
    await assert.rejects(rejected, /blocked/);
});

test("connect clears request caches so failed profile and reference requests can be retried", () => {
    const client = createClient({ relays: [] });

    client.requestedProfilePubkeys.set(hex("a"), Date.now());
    client.requestedReferencedEventIds.set(hex("b"), Date.now());
    client.connect();

    assert.equal(client.requestedProfilePubkeys.size, 0);
    assert.equal(client.requestedReferencedEventIds.size, 0);
});

test("draft relay collection trims empty values and accepts valid wss URLs", () => {
    const { handler } = createRelaySettingsHandler(SettingsUIHandler, [
        "  wss://relay.example  ",
        "",
        "wss://relay2.example",
    ]);

    assert.deepEqual(handler._getDraftRelays(), [
        "wss://relay.example",
        "wss://relay2.example",
    ]);
});

test("draft relay collection rejects non-wss URLs", () => {
    const { handler, alerts } = createRelaySettingsHandler(SettingsUIHandler, ["https://relay.example"]);

    assert.equal(handler._getDraftRelays(), null);
    assert.equal(alerts.length, 1);
});

test("draft relay collection rejects duplicates after trailing slash normalization", () => {
    const { handler, alerts } = createRelaySettingsHandler(SettingsUIHandler, [
        "wss://relay.example",
        "wss://relay.example/",
    ]);

    assert.equal(handler._getDraftRelays(), null);
    assert.equal(alerts.length, 1);
});

let failed = 0;

for (const { name, fn } of tests) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (err) {
        failed += 1;
        console.error(`not ok - ${name}`);
        console.error(err);
    }
}

if (failed > 0) {
    process.exitCode = 1;
} else {
    console.log(`${tests.length} tests passed`);
}
