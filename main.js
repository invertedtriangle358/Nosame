import { EventValidator, NostrClient, ProfileStore, StorageManager } from "./nostr-core.js";
import { UIManager } from "./ui.js";

window.addEventListener("DOMContentLoaded", async () => {
    // ステップ1：StorageManager を初期化
    const storage = new StorageManager(localStorage);  // テスト可能性向上

    // ステップ2：各コンポーネントを初期化
    const validator = new EventValidator(storage);
    const client = new NostrClient(storage, validator);
    const profiles = new ProfileStore();
    const ui = new UIManager(client, storage, profiles);

    // ステップ3：UI を初期化
    ui.init();

    // ステップ4：コールバック設定
    client.onEventCallback = (event) => {
        client.requestProfiles([event.pubkey]);
        ui.bufferEvent(event);
    };

    client.onProfileNoteCallback = (event) => {
        client.requestProfiles([event.pubkey]);
        ui.renderProfileEvent(event);
    };
    
   client.onReferencedEventCallback = (event) => {
        client.requestProfiles([event.pubkey]);
        ui.storeReferencedEvent(event);
    }; 
    
    client.onMetadataCallback = (event) => {
        const profile = profiles.upsertMetadata(event);
        if (profile) ui.refreshProfileData(profile.pubkey);
    };
    
    client.onStatusCallback = () => ui.settingsHandler.updateRelayList();

    // ステップ5：Nostr 通信開始
    client.connect();
    client.startSubscription();

    // ステップ6：初期スクロール位置設定
    setTimeout(() => {
        const timeline = ui.profilePubkey ? ui.dom.profileTimeline : ui.dom.timeline;
        if (timeline) {
            timeline.scrollLeft = timeline.scrollWidth - timeline.clientWidth;
        }
    }, 500);
});

