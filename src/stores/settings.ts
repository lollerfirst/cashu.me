import { defineStore } from "pinia";
import { useLocalStorage } from "@vueuse/core";

const defaultNostrRelays = [
  "wss://relay.damus.io",
  "wss://relay.8333.space/",
  "wss://nos.lol",
];

export const useSettingsStore = defineStore("settings", {
  state: () => {
    return {
      getBitcoinPrice: useLocalStorage<boolean>(
        "cashu.settings.getBitcoinPrice",
        false
      ),
      checkSentTokens: useLocalStorage<boolean>(
        "cashu.settings.checkSentTokens",
        true
      ),
      checkIncomingInvoices: useLocalStorage<boolean>(
        "cashu.settings.checkIncomingInvoices",
        true
      ),
      periodicallyCheckIncomingInvoices: useLocalStorage<boolean>(
        "cashu.settings.periodicallyCheckIncomingInvoices",
        true
      ),
      checkInvoicesOnStartup: useLocalStorage<boolean>(
        "cashu.settings.checkInvoicesOnStartup",
        true
      ),
      useWebsockets: useLocalStorage<boolean>(
        "cashu.settings.useWebsockets",
        true
      ),
      defaultNostrRelays: useLocalStorage<string[]>(
        "cashu.settings.defaultNostrRelays",
        defaultNostrRelays
      ),
      includeFeesInSendAmount: useLocalStorage<boolean>(
        "cashu.settings.includeFeesInSendAmount",
        false
      ),
      nfcEncoding: useLocalStorage<string>(
        "cashu.settings.nfcEncoding",
        "weburl"
      ),
      useNumericKeyboard: useLocalStorage<boolean>(
        "cashu.settings.useNumericKeyboard",
        false
      ),
      enableReceiveSwaps: useLocalStorage<boolean>(
        "cashu.settings.enableReceiveSwaps",
        false
      ),
      showNfcButtonInDrawer: useLocalStorage(
        "cashu.ui.showNfcButtonInDrawer",
        true
      ),
      autoPasteEcashReceive: useLocalStorage(
        "cashu.settings.autoPasteEcashReceive",
        true
      ),
      auditorEnabled: useLocalStorage<boolean>(
        "cashu.settings.auditorEnabled",
        false
      ),
      auditorUrl: useLocalStorage<string>(
        "cashu.settings.auditorUrl",
        "https://audit.8333.space"
      ),
      auditorApiUrl: useLocalStorage<string>(
        "cashu.settings.auditorApiUrl",
        "https://api.audit.8333.space"
      ),
      bip177BitcoinSymbol: useLocalStorage<boolean>(
        "cashu.settings.bip177",
        false
      ),
      multinutEnabled: useLocalStorage<boolean>(
        "cashu.settings.multinutEnabled",
        false
      ),
      nostrMintBackupEnabled: useLocalStorage<boolean>(
        "cashu.settings.nostrMintBackupEnabled",
        false
      ),
    };
  },
});
