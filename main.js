import { EventValidator, NostrClient, ProfileStore, StorageManager } from "./nostr-core.js";
import { UIManager } from "./ui.js";

window.addEventListener("DOMContentLoaded", async () => {
    const storage = new StorageManager();
    await storage.loadDefaultNgWords();

    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const profiles = new ProfileStore();
    const ui = new UIManager(client, storage, profiles);

    ui.init();

    client.onEventCallback = (event) => ui.bufferEvent(event);
    client.onMetadataCallback = (event) => {
        const profile = profiles.upsertMetadata(event);
        if (profile) ui.refreshProfileData(profile.pubkey);
    };
    client.onStatusCallback = () => ui.settingsHandler.updateRelayList();

    client.connect();
    client.startSubscription();

    setTimeout(() => {
        const timeline = ui.dom.timeline;
        if (timeline) {
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
        }
    }, 500);
});

