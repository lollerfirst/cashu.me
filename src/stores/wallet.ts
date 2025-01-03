import { defineStore } from "pinia";
import { currentDateStr } from "src/js/utils";
import { Mint, MintClass, useMintsStore, WalletProof } from "./mints";
import { useLocalStorage } from "@vueuse/core";
import { useProofsStore } from "./proofs";
import { useTokensStore } from "./tokens";
import { useReceiveTokensStore } from "./receiveTokensStore";
import { useUiStore } from "src/stores/ui";
import { useP2PKStore } from "src/stores/p2pk";
import { useSendTokensStore } from "src/stores/sendTokensStore";
import { usePRStore } from "./payment-request";
import { useWorkersStore } from "./workers";

import * as _ from "underscore";
import token from "src/js/token";
import {
  notifyApiError,
  notifyError,
  notifySuccess,
  notifyWarning,
  notify,
} from "src/js/notify";
import {
  CashuMint,
  CashuWallet,
  Proof,
  MintQuotePayload,
  MeltQuotePayload,
  MeltQuoteResponse,
  CheckStateEnum,
  MeltQuoteState,
  MintQuoteState,
  PaymentRequest,
  PaymentRequestTransportType,
  PaymentRequestTransport,
  decodePaymentRequest,
  MintQuoteResponse,
  ProofState,
} from "@cashu/cashu-ts";
import { hashToCurve } from "@cashu/crypto/modules/common";
import * as bolt11Decoder from "light-bolt11-decoder";
import { bech32 } from "bech32";
import axios from "axios";
import { date } from "quasar";

// bip39 requires Buffer
// import { Buffer } from 'buffer';
// window.Buffer = Buffer;
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { useSettingsStore } from "./settings";

// HACK: this is a workaround so that the catch block in the melt function does not throw an error when the user exits the app
// before the payment is completed. This is necessary because the catch block in the melt function would otherwise remove all
// quotes from the invoiceHistory and the user would not be able to pay the invoice again after reopening the app.
let isUnloading = false;
window.addEventListener("beforeunload", () => {
  isUnloading = true;
});

type Invoice = {
  amount: number;
  bolt11: string;
  quote: string;
  memo: string;
};

type InvoiceHistory = Invoice & {
  date: string;
  status: "pending" | "paid";
  mint: string;
  unit?: string;
};

type KeysetCounter = {
  id: string;
  counter: number;
};

const receiveStore = useReceiveTokensStore();
const tokenStore = useTokensStore();

export const useWalletStore = defineStore("wallet", {
  state: () => {
    return {
      mnemonic: useLocalStorage("cashu.mnemonic", ""),
      invoiceHistory: useLocalStorage(
        "cashu.invoiceHistory",
        [] as InvoiceHistory[]
      ),
      keysetCounters: useLocalStorage(
        "cashu.keysetCounters",
        [] as KeysetCounter[]
      ),
      oldMnemonicCounters: useLocalStorage(
        "cashu.oldMnemonicCounters",
        [] as { mnemonic: string; keysetCounters: KeysetCounter[] }[]
      ),
      invoiceData: {} as InvoiceHistory,
      payInvoiceData: {
        blocking: false,
        bolt11: "",
        show: false,
        meltQuote: {
          payload: {
            unit: "",
            request: "",
          } as MeltQuotePayload,
          response: {
            quote: "",
            amount: 0,
            fee_reserve: 0,
          } as MeltQuoteResponse,
          error: "",
        },
        multiPartMeltQuotes: {
          payloads: [] as Array<[Mint, MeltQuotePayload]>,
          responses: [] as Array<MeltQuoteResponse>,
          error: "",
        },
        invoice: {
          sat: 0,
          memo: "",
          bolt11: "",
        } as { sat: number; memo: string; bolt11: string } | null,
        lnurlpay: {
          domain: "",
          callback: "",
          minSendable: 0,
          maxSendable: 0,
          metadata: {},
          successAction: {},
          routes: [],
          tag: "",
        },
        lnurlauth: {},
        input: {
          request: "",
          amount: null,
          comment: "",
          quote: "",
        } as {
          request: string;
          amount: number | null;
          comment: string;
          quote: string;
        },
      },
    };
  },
  getters: {
    wallet() {
      const mints = useMintsStore();
      const mint = new CashuMint(mints.activeMintUrl);
      if (this.mnemonic == "") {
        this.mnemonic = generateMnemonic(wordlist);
      }
      const mnemonic: string = this.mnemonic;
      const bip39Seed = mnemonicToSeedSync(mnemonic);
      const wallet = new CashuWallet(mint, {
        keys: mints.activeKeys,
        keysets: mints.activeKeysets,
        mintInfo: mints.activeInfo,
        bip39seed: bip39Seed,
        unit: mints.activeUnit,
      });
      return wallet;
    },
    seed(): Uint8Array {
      return mnemonicToSeedSync(this.mnemonic);
    },
  },
  actions: {
    mnemonicToSeedSync: function (mnemonic: string): Uint8Array {
      return mnemonicToSeedSync(mnemonic);
    },
    newMnemonic: function () {
      // store old mnemonic and keysetCounters
      const oldMnemonicCounters = this.oldMnemonicCounters;
      const keysetCounters = this.keysetCounters;
      oldMnemonicCounters.push({ mnemonic: this.mnemonic, keysetCounters });
      this.keysetCounters = [];
      this.mnemonic = generateMnemonic(wordlist);
    },
    keysetCounter: function (id: string) {
      const keysetCounter = this.keysetCounters.find((c) => c.id === id);
      if (keysetCounter) {
        return keysetCounter.counter;
      } else {
        this.keysetCounters.push({ id, counter: 1 });
        return 1;
      }
    },
    increaseKeysetCounter: function (id: string, by: number) {
      const keysetCounter = this.keysetCounters.find((c) => c.id === id);
      if (keysetCounter) {
        keysetCounter.counter += by;
      } else {
        const newCounter = { id, counter: by } as KeysetCounter;
        this.keysetCounters.push(newCounter);
      }
    },
    getKeyset(): string {
      const mintStore = useMintsStore();
      const keysets = mintStore.activeMint().keysets;
      if (keysets == null || keysets.length == 0) {
        throw new Error("no keysets found.");
      }
      const unitKeysets = mintStore
        .activeMint()
        .unitKeysets(mintStore.activeUnit);
      if (unitKeysets == null || unitKeysets.length == 0) {
        console.error("no keysets found for unit", mintStore.activeUnit);
        throw new Error("no keysets found for unit");
      }
      // select the keyset id
      // const keyset_id = unitKeysets[0].id;
      // rules for selection:
      // - filter all keysets that are active=true
      // - order by id (whether it is hex or base64)
      // - order by input_fee_ppk (ascending) TODO: this is not implemented yet
      // - select the first one
      const activeKeysets = unitKeysets.filter((k) => k.active);
      const hexKeysets = activeKeysets.filter((k) => k.id.startsWith("00"));
      const base64Keysets = activeKeysets.filter((k) => !k.id.startsWith("00"));
      const sortedKeysets = hexKeysets.concat(base64Keysets);
      // const sortedKeysets = _.sortBy(activeKeysets, k => [k.id, k.input_fee_ppk])
      if (sortedKeysets.length == 0) {
        console.error("no active keysets found for unit", mintStore.activeUnit);
        throw new Error("no active keysets found for unit");
      }
      const keyset_id = sortedKeysets[0].id;
      const keys = mintStore
        .activeMint()
        .mint.keys.find((k) => k.id === keyset_id);
      // if (keys) {
      //   this.wallet.keys = keys;
      // }
      return keyset_id;
    },
    /**
     * Sets an invoice status to paid
     */
    setInvoicePaid(quoteId: string) {
      const invoice = this.invoiceHistory.find((i) => i.quote === quoteId);
      if (!invoice) return;
      invoice.status = "paid";
    },
    splitAmount: function (value: number) {
      // returns optimal 2^n split
      const chunks: Array<number> = [];
      for (let i = 0; i < 32; i++) {
        const mask: number = 1 << i;
        if ((value & mask) !== 0) {
          chunks.push(Math.pow(2, i));
        }
      }
      return chunks;
    },
    coinSelectSpendBase64: function (
      proofs: WalletProof[],
      amount: number
    ): WalletProof[] {
      const base64Proofs = proofs.filter((p) => !p.id.startsWith("00"));
      if (base64Proofs.length > 0) {
        base64Proofs.sort((a, b) => b.amount - a.amount);
        let sum = 0;
        let selectedProofs: WalletProof[] = [];
        for (let i = 0; i < base64Proofs.length; i++) {
          const proof = base64Proofs[i];
          sum += proof.amount;
          selectedProofs.push(proof);
          if (sum >= amount) {
            return selectedProofs;
          }
        }
        return [];
      }
      return [];
    },
    coinSelect: function (
      proofs: WalletProof[],
      amount: number,
      includeFees: boolean = false
    ): WalletProof[] {
      if (proofs.reduce((s, t) => (s += t.amount), 0) < amount) {
        // there are not enough proofs to pay the amount
        return [];
      }
      const { send: selectedProofs, keep: _ } = this.wallet.selectProofsToSend(
        proofs,
        amount,
        includeFees
      );
      const selectedWalletProofs = selectedProofs.map((p) => {
        return { ...p, reserved: false } as WalletProof;
      });
      return selectedWalletProofs;
    },
    spendableProofs: function (proofs: WalletProof[], amount: number) {
      const uIStore = useUiStore();
      const proofsStore = useProofsStore();
      const mintStore = useMintsStore();
      const spendableProofs = proofsStore.getUnreservedProofs(proofs);
      if (proofsStore.sumProofs(spendableProofs) < amount) {
        const balance = mintStore.activeMintBalance();
        const unit = mintStore.activeUnit;
        notifyWarning(
          "Balance is too low",
          `${uIStore.formatCurrency(
            balance,
            unit
          )} is not enough to pay ${uIStore.formatCurrency(amount, unit)}.`
        );
        throw Error("Balance too low");
      }
      return spendableProofs;
    },
    getFeesForProofs: function (proofs: Proof[]): number {
      return this.wallet.getFeesForProofs(proofs);
    },
    sendToLock: async function (
      proofs: WalletProof[],
      amount: number,
      receiverPubkey: string
    ) {
      const spendableProofs = this.spendableProofs(proofs, amount);
      const proofsToSend = this.coinSelect(spendableProofs, amount, true);
      const { keep: keepProofs, send: sendProofs } = await this.wallet.send(
        amount,
        proofsToSend,
        { pubkey: receiverPubkey }
      );
      const mintStore = useMintsStore();
      // note: we do not store sendProofs in the proofs store but
      // expect from the caller to store it in the history
      mintStore.addProofs(keepProofs);
      mintStore.removeProofs(proofsToSend);
      return { keepProofs, sendProofs };
    },
    send: async function (
      proofs: WalletProof[],
      amount: number,
      invalidate: boolean = false,
      includeFees: boolean = false
    ): Promise<{ keepProofs: Proof[]; sendProofs: Proof[] }> {
      /*
      splits proofs so the user can keep firstProofs, send scndProofs.
      then sets scndProofs as reserved.

      if invalidate, scndProofs (the one to send) are invalidated
      */
      const mintStore = useMintsStore();
      const proofsStore = useProofsStore();
      const uIStore = useUiStore();
      let proofsToSend: WalletProof[] = [];
      const keysetId = this.getKeyset();
      await uIStore.lockMutex();
      try {
        const spendableProofs = this.spendableProofs(proofs, amount);

        proofsToSend = this.coinSelect(spendableProofs, amount, includeFees);
        const totalAmount = proofsToSend.reduce((s, t) => (s += t.amount), 0);
        const fees = includeFees
          ? this.wallet.getFeesForProofs(proofsToSend)
          : 0;
        const targetAmount = amount + fees;

        let keepProofs: Proof[] = [];
        let sendProofs: Proof[] = [];

        if (totalAmount != targetAmount) {
          const counter = this.keysetCounter(keysetId);
          proofsToSend = this.coinSelect(spendableProofs, targetAmount, true);
          ({ keep: keepProofs, send: sendProofs } = await this.wallet.send(
            targetAmount,
            proofsToSend,
            { counter, proofsWeHave: spendableProofs }
          ));
          this.increaseKeysetCounter(
            keysetId,
            keepProofs.length + sendProofs.length
          );
          mintStore.addProofs(keepProofs);
          mintStore.addProofs(sendProofs);
          mintStore.removeProofs(proofsToSend);
        } else if (totalAmount == targetAmount) {
          keepProofs = [];
          sendProofs = proofsToSend;
        } else {
          throw new Error("could not split proofs.");
        }

        if (invalidate) {
          mintStore.removeProofs(sendProofs);
        }
        proofsStore.setReserved(sendProofs, true);
        return { keepProofs, sendProofs };
      } catch (error: any) {
        proofsStore.setReserved(proofsToSend, false);
        console.error(error);
        notifyApiError(error);
        this.handleOutputsHaveAlreadyBeenSignedError(keysetId, error);
        throw error;
      } finally {
        uIStore.unlockMutex();
      }
    },
    /**
     *
     *
     * @param {array} proofs
     */
    redeem: async function () {
      /*
      uses split to receive new tokens.
      */
      const uIStore = useUiStore();
      const mintStore = useMintsStore();
      const p2pkStore = useP2PKStore();

      receiveStore.showReceiveTokens = false;

      if (receiveStore.receiveData.tokensBase64.length == 0) {
        throw new Error("no tokens provided.");
      }
      const tokenJson = token.decode(receiveStore.receiveData.tokensBase64);
      if (tokenJson == undefined) {
        throw new Error("no tokens provided.");
      }
      let proofs = token.getProofs(tokenJson);

      // activate the mint and the unit
      await mintStore.activateMintUrl(
        token.getMint(tokenJson),
        false,
        false,
        tokenJson.unit
      );

      const inputAmount = proofs.reduce((s, t) => (s += t.amount), 0);
      let fee = 0;
      await uIStore.lockMutex();
      try {
        // redeem
        const keysetId = this.getKeyset();
        const counter = this.keysetCounter(keysetId);
        // const preference = this.outputAmountSelect(amount);
        const privkey = receiveStore.receiveData.p2pkPrivateKey;
        // const decodedToken = getDecodedToken(receiveStore.receiveData.tokensBase64);
        // let tokenCts: Token
        let proofs: Proof[];
        try {
          proofs = await this.wallet.receive(
            receiveStore.receiveData.tokensBase64,
            { counter, privkey, proofsWeHave: mintStore.activeProofs }
          );
          this.increaseKeysetCounter(keysetId, proofs.length);
        } catch (error: any) {
          console.error(error);
          this.handleOutputsHaveAlreadyBeenSignedError(keysetId, error);
          throw new Error("Error receiving tokens: " + error);
        }

        p2pkStore.setPrivateKeyUsed(privkey);
        mintStore.removeProofs(proofs);
        mintStore.addProofs(proofs);

        const outputAmount = proofs.reduce((s, t) => (s += t.amount), 0);

        // if token is already in history, set to paid, else add to history
        if (
          tokenStore.historyTokens.find(
            (t) =>
              t.token === receiveStore.receiveData.tokensBase64 && t.amount > 0
          )
        ) {
          tokenStore.setTokenPaid(receiveStore.receiveData.tokensBase64);
        } else {
          // if this is a self-sent token, we will find an outgoing token with the inverse amount
          if (
            tokenStore.historyTokens.find(
              (t) =>
                t.token === receiveStore.receiveData.tokensBase64 &&
                t.amount < 0
            )
          ) {
            tokenStore.setTokenPaid(receiveStore.receiveData.tokensBase64);
          }
          fee = inputAmount - outputAmount;
          tokenStore.addPaidToken({
            amount: outputAmount,
            serializedProofs: receiveStore.receiveData.tokensBase64,
            unit: mintStore.activeUnit,
            mint: mintStore.activeMintUrl,
            fee: fee,
          });
        }

        if (!!window.navigator.vibrate) navigator.vibrate(200);
        let message =
          "Received " +
          uIStore.formatCurrency(outputAmount, mintStore.activeUnit);
        if (fee > 0) {
          message +=
            " (fee: " + uIStore.formatCurrency(fee, mintStore.activeUnit) + ")";
        }
        notifySuccess(message);
      } catch (error: any) {
        console.error(error);
        notifyApiError(error);
        throw error;
      } finally {
        uIStore.unlockMutex();
      }
      // }
    },

    // /mint
    /**
     * Ask the mint to generate an invoice for the given amount
     * Upon paying the request, the mint will credit the wallet with
     * cashu tokens
     */
    requestMint: async function (amount?: number): Promise<MintQuoteResponse> {
      const mintStore = useMintsStore();

      if (amount) {
        this.invoiceData.amount = amount;
      }
      try {
        // create MintQuotePayload(this.invoiceData.amount) payload
        const payload: MintQuotePayload = {
          amount: this.invoiceData.amount,
          unit: mintStore.activeUnit,
        };
        const data = await mintStore.activeMint().api.createMintQuote(payload);
        this.invoiceData.bolt11 = data.request;
        this.invoiceData.quote = data.quote;
        this.invoiceData.date = currentDateStr();
        this.invoiceData.status = "pending";
        this.invoiceData.mint = mintStore.activeMintUrl;
        this.invoiceData.unit = mintStore.activeUnit;
        this.invoiceHistory.push({
          ...this.invoiceData,
        });
        return data;
      } catch (error: any) {
        console.error(error);
        notifyApiError(error, "Could not request mint");
        throw error;
      } finally {
      }
    },
    getMintQuoteState: async function (
      quote: string,
      mint: CashuMint
    ): Promise<MintQuoteState> {
      // stateless function to check the state of a mint quote
      const resp = await mint.checkMintQuote(quote);
      return resp.state;
    },
    getMeltQuoteState: async function (
      quote: string,
      mint: CashuMint
    ): Promise<MeltQuoteState> {
      // stateless function to check the state of a melt quote
      const resp = await mint.checkMeltQuote(quote);
      return resp.state;
    },
    mint: async function (
      amount: number,
      hash: string,
      verbose: boolean = true
    ) {
      const proofsStore = useProofsStore();
      const mintStore = useMintsStore();
      const tokenStore = useTokensStore();
      const uIStore = useUiStore();
      const keysetId = this.getKeyset();
      await uIStore.lockMutex();
      try {
        // first we check if the mint quote is paid
        const mintQuote = await mintStore.activeMint().api.checkMintQuote(hash);
        console.log("### mintQuote", mintQuote);
        if (mintQuote.state != MintQuoteState.PAID) {
          console.log("### mintQuote not paid yet");
          if (verbose) {
            notify("Invoice still pending");
          }
          throw new Error("invoice not paid yet.");
        }
        const counter = this.keysetCounter(keysetId);
        const proofs = await this.wallet.mintProofs(amount, hash, {
          keysetId,
          counter,
          proofsWeHave: mintStore.activeProofs,
        });
        this.increaseKeysetCounter(keysetId, proofs.length);

        // const proofs = await this.mintApi(split, hash, verbose);
        if (!proofs.length) {
          throw "could not mint";
        }
        mintStore.addProofs(proofs);

        // update UI
        await this.setInvoicePaid(hash);
        const serializedProofs = proofsStore.serializeProofs(proofs);
        if (serializedProofs == null) {
          throw new Error("could not serialize proofs.");
        }
        tokenStore.addPaidToken({
          amount,
          serializedProofs: serializedProofs,
          unit: mintStore.activeUnit,
          mint: mintStore.activeMintUrl,
        });

        return proofs;
      } catch (error: any) {
        console.error(error);
        if (verbose) {
          notifyApiError(error);
        }
        this.handleOutputsHaveAlreadyBeenSignedError(keysetId, error);
        throw error;
      } finally {
        uIStore.unlockMutex();
      }
    },
    /**
     * This method attempts to find Mints supporting NUT-15 and creates a series of melt quotes
     * for a multi-part payment of the invoice.
     * @returns array of MeltQuoteResponse from each mint supporting NUT-15 for "sat" and "bolt11"
     */
    multiPathMeltQuotes: async function () {
      // throw an error if this.payInvoiceData.blocking is true
      if (this.payInvoiceData.blocking) {
        throw new Error("already processing an melt quote.");
      }
      this.payInvoiceData.blocking = true;
      this.payInvoiceData.multiPartMeltQuotes.error = "";
      try {
        const mintStore = useMintsStore();
        if (this.payInvoiceData.input.request == "") {
          throw new Error("no invoice provided.");
        }

        // Get multi-path supporting mints
        const activeUnit = mintStore.activeUnit;
        const multiMints = mintStore.getMultiMints("bolt11", activeUnit);
        if (multiMints.length === 0) {
          throw new Error("no mint supports multi-part payments");
        }

        // Get overall balance and weight distribution across the mints
        const { overallBalance, weights } = mintStore.multiMintBalance(
          "bolt11",
          activeUnit
        );
        const invoiceAmount = this.payInvoiceData.invoice?.sat;
        if (!invoiceAmount) {
          throw new Error("invoice does not have an amount");
        }
        if (overallBalance < invoiceAmount) {
          throw new Error("insufficient multi-mint balance");
        }
        console.log(`invoice amount: ${invoiceAmount}`);
        // Craft melt quote payloads for each mint
        const payloads: Array<[Mint, MeltQuotePayload]> = [];
        let carry = 0.0;
        multiMints.forEach((m, i) => {
          const partialAmountFloat = invoiceAmount! * weights[i] + carry;
          console.log(`partialAmountFloat: ${partialAmountFloat}`);
          const partialAmount = Math.round(partialAmountFloat);
          console.log(`partialAmount (integer): ${partialAmount}`);
          console.log(`for Mint: ${m.url}`);
          carry = partialAmountFloat - partialAmount;
          if (partialAmount > 0) {
            const meltQuotePayload: MeltQuotePayload = {
              unit: activeUnit,
              request: this.payInvoiceData.input.request,
              options: {
                mpp: {
                  amount: partialAmount,
                },
              },
            };
            payloads.push([m, meltQuotePayload]);
          }
        });
        this.payInvoiceData.multiPartMeltQuotes.payloads = payloads;
        // Request melt quotes
        let responses = [];
        for (const payload of payloads) {
          const data = await new MintClass(payload[0]).api.createMeltQuote(
            payload[1]
          );
          responses.push(data);
          mintStore.assertMintError(data);
        }
        console.log(`responses: ${JSON.stringify(responses)}`);
        this.payInvoiceData.multiPartMeltQuotes.responses = responses;
        this.payInvoiceData.blocking = false;
        return responses;
      } catch (error: any) {
        this.payInvoiceData.blocking = false;
        this.payInvoiceData.multiPartMeltQuotes.error = error;
        console.error(error);
        notifyApiError(error);
        throw error;
      } finally {
      }
    },
    // get a melt quote
    meltQuote: async function () {
      // throw an error if this.payInvoiceData.blocking is true
      if (this.payInvoiceData.blocking) {
        throw new Error("already processing an melt quote.");
      }
      this.payInvoiceData.blocking = true;
      this.payInvoiceData.meltQuote.error = "";
      try {
        const mintStore = useMintsStore();
        if (this.payInvoiceData.input.request == "") {
          throw new Error("no invoice provided.");
        }
        const payload: MeltQuotePayload = {
          unit: mintStore.activeUnit,
          request: this.payInvoiceData.input.request,
        };
        this.payInvoiceData.meltQuote.payload = payload;
        const data = await mintStore.activeMint().api.createMeltQuote(payload);
        mintStore.assertMintError(data);
        this.payInvoiceData.meltQuote.response = data;
        this.payInvoiceData.blocking = false;
        return data;
      } catch (error: any) {
        this.payInvoiceData.blocking = false;
        this.payInvoiceData.meltQuote.error = error;
        console.error(error);
        notifyApiError(error);
        throw error;
      } finally {
      }
    },
    melt: async function () {
      const uIStore = useUiStore();
      const proofsStore = useProofsStore();
      const mintStore = useMintsStore();
      const tokenStore = useTokensStore();

      // throw an error if this.payInvoiceData.blocking is true
      if (this.payInvoiceData.blocking) {
        throw new Error("already processing an invoice.");
      }
      console.log("#### pay lightning");
      if (this.payInvoiceData.invoice == null) {
        throw new Error("no invoice provided.");
      }
      const invoice = this.payInvoiceData.invoice.bolt11;
      // throw an error if the invoice is already in invoiceHistory
      if (
        this.invoiceHistory.find(
          (i) => i.bolt11 === invoice && i.amount < 0 && i.status === "paid"
        )
      ) {
        notifyError("Invoice already paid.");
        throw new Error("invoice already paid.");
      }

      const amount_invoice = this.payInvoiceData.invoice.sat;
      const quote = this.payInvoiceData.meltQuote.response;
      if (quote == null) {
        throw new Error("no quote found.");
      }
      const amount = quote.amount + quote.fee_reserve;
      let countChangeOutputs = 0;
      const keysetId = this.getKeyset();
      let keysetCounterIncrease = 0;

      // start melt
      let sendProofs: Proof[] = [];
      try {
        const { keepProofs: keepProofs, sendProofs: _sendProofs } =
          await this.send(mintStore.activeProofs, amount, false, true);
        sendProofs = _sendProofs;
        if (sendProofs.length == 0) {
          throw new Error("could not split proofs.");
        }
      } catch (error: any) {
        console.error(error);
        notifyApiError(error, "Payment failed");
        throw error;
      }

      await uIStore.lockMutex();
      try {
        await this.addOutgoingPendingInvoiceToHistory(quote, sendProofs);

        // NUT-08 blank outputs for change
        const counter = this.keysetCounter(keysetId);

        // QUIRK: we increase the keyset counter by sendProofs and the maximum number of possible change outputs
        // this way, in case the user exits the app before payLnInvoice is completed, the returned change outputs won't cause a "outputs already signed" error
        // if the payment fails, we decrease the counter again
        this.increaseKeysetCounter(keysetId, sendProofs.length);
        if (quote.fee_reserve > 0) {
          countChangeOutputs = Math.ceil(Math.log2(quote.fee_reserve)) || 1;
          this.increaseKeysetCounter(keysetId, countChangeOutputs);
          keysetCounterIncrease += countChangeOutputs;
        }

        // NOTE: if the user exits the app while we're in the API call, JS will emit an error that we would catch below!
        // We have to handle that case in the catch block below
        const data = await this.wallet.meltProofs(quote, sendProofs, {
          keysetId,
          counter,
        });

        if (data.quote.state != MeltQuoteState.PAID) {
          throw new Error("Invoice not paid.");
        }
        let amount_paid = amount - proofsStore.sumProofs(data.change);
        if (!!window.navigator.vibrate) navigator.vibrate(200);

        notifySuccess(
          "Paid " +
            uIStore.formatCurrency(amount_paid, mintStore.activeUnit) +
            " via Lightning"
        );
        console.log("#### pay lightning: token paid");
        // delete spent tokens from db
        mintStore.removeProofs(sendProofs);

        // NUT-08 get change
        if (data.change != null) {
          const changeProofs = data.change;
          console.log(
            "## Received change: " + proofsStore.sumProofs(changeProofs)
          );
          mintStore.addProofs(changeProofs);
        }

        tokenStore.addPaidToken({
          amount: -amount_paid,
          serializedProofs: proofsStore.serializeProofs(sendProofs),
          unit: mintStore.activeUnit,
          mint: mintStore.activeMintUrl,
        });

        this.updateInvoiceInHistory(quote, {
          status: "paid",
          amount: -amount_paid,
        });

        this.payInvoiceData.invoice = { sat: 0, memo: "", bolt11: "" };
        this.payInvoiceData.show = false;
        return data;
      } catch (error: any) {
        if (isUnloading) {
          // NOTE: An error is thrown when the user exits the app while the payment is in progress.
          // do not handle the error if the user exits the app
          throw error;
        }
        // get quote and check state
        const mintQuote = await mintStore
          .activeMint()
          .api.checkMeltQuote(quote.quote);
        if (
          mintQuote.state == MeltQuoteState.PAID ||
          mintQuote.state == MeltQuoteState.PENDING
        ) {
          console.log(
            "### melt: error, but quote is paid or pending. not rolling back."
          );
          throw error;
        }
        // roll back proof management and keyset counter
        proofsStore.setReserved(sendProofs, false);
        this.increaseKeysetCounter(keysetId, -keysetCounterIncrease);
        this.removeOutgoingInvoiceFromHistory(quote.quote);

        console.error(error);
        this.handleOutputsHaveAlreadyBeenSignedError(keysetId, error);
        notifyApiError(error, "Payment failed");
        throw error;
      } finally {
        uIStore.unlockMutex();
      }
    },
    getProofState: async function (proofs: Proof[]) {
      const mintStore = useMintsStore();
      const enc = new TextEncoder();
      const Ys = proofs.map((p) =>
        hashToCurve(enc.encode(p.secret)).toHex(true)
      );
      const payload = { Ys: Ys };
      const { states } = await new CashuMint(mintStore.activeMintUrl).check(
        payload
      );
      return states;
    },
    // /check
    checkProofsSpendable: async function (
      proofs: Proof[],
      update_history = false
    ) {
      /*
      checks with the mint whether an array of proofs is still
      spendable or already invalidated
      */
      const mintStore = useMintsStore();
      const proofsStore = useProofsStore();
      const tokenStore = useTokensStore();
      if (proofs.length == 0) {
        return;
      }
      const enc = new TextEncoder();
      try {
        const proofStates = await this.wallet.checkProofsStates(proofs);
        const spentProofsStates = proofStates.filter(
          (p) => p.state == CheckStateEnum.SPENT
        );
        const spentProofs = proofs.filter((p) =>
          spentProofsStates.find(
            (s) => s.Y == hashToCurve(enc.encode(p.secret)).toHex(true)
          )
        );
        if (spentProofs.length) {
          mintStore.removeProofs(spentProofs);

          // update UI
          const serializedProofs = proofsStore.serializeProofs(spentProofs);
          if (serializedProofs == null) {
            throw new Error("could not serialize proofs.");
          }
          if (update_history) {
            tokenStore.addPaidToken({
              amount: -proofsStore.sumProofs(spentProofs),
              serializedProofs: serializedProofs,
              unit: mintStore.activeUnit,
              mint: mintStore.activeMintUrl,
            });
          }
        }
        // return unspent proofs
        return spentProofs;
      } catch (error: any) {
        console.error(error);
        notifyApiError(error);
        throw error;
      }
    },
    onTokenPaid: async function (tokenStr: string) {
      const sendTokensStore = useSendTokensStore();
      const tokenJson = token.decode(tokenStr);
      const activeMint = useMintsStore().activeMint().mint;
      const mintStore = useMintsStore();
      const settingsStore = useSettingsStore();
      if (!settingsStore.checkSentTokens) {
        console.log(
          "settingsStore.checkSentTokens is disabled, skipping token check"
        );
        return;
      }
      if (
        !settingsStore.useWebsockets ||
        !activeMint.info?.nuts[17]?.supported ||
        !activeMint.info?.nuts[17]?.supported.find(
          (s) =>
            s.method == "bolt11" &&
            s.unit == mintStore.activeUnit &&
            s.commands.indexOf("proof_state") != -1
        )
      ) {
        console.log(
          "Websockets not supported, kicking off token check worker."
        );
        useWorkersStore().checkTokenSpendableWorker(tokenStr);
        return;
      }
      try {
        if (tokenJson == undefined) {
          throw new Error("no tokens provided.");
        }
        const proofs = token.getProofs(tokenJson);
        const oneProof = [proofs[0]];
        const unsub = await this.wallet.onProofStateUpdates(
          oneProof,
          async (proofState: ProofState) => {
            console.log(`Websocket: proof state updated: ${proofState.state}`);
            if (proofState.state == CheckStateEnum.SPENT) {
              const tokenSpent = await this.checkTokenSpendable(tokenStr);
              if (tokenSpent) {
                sendTokensStore.showSendTokens = false;
                unsub();
              }
            }
          },
          async (error: any) => {
            console.error(error);
            notifyApiError(error);
            throw error;
          }
        );
      } catch (error) {
        console.error("Error in websocket subscription", error);
        useWorkersStore().checkTokenSpendableWorker(tokenStr);
      }
    },
    checkTokenSpendable: async function (
      tokenStr: string,
      verbose: boolean = true
    ) {
      /*
      checks whether a base64-encoded token (from the history table) has been spent already.
      if it is spent, the appropraite entry in the history table is set to paid.
      */
      const uIStore = useUiStore();
      const mintStore = useMintsStore();
      const tokenStore = useTokensStore();
      const proofsStore = useProofsStore();

      const tokenJson = token.decode(tokenStr);
      if (tokenJson == undefined) {
        throw new Error("no tokens provided.");
      }
      const proofs = token.getProofs(tokenJson);

      // activate the mint
      const mintInToken = token.getMint(tokenJson);
      await mintStore.activateMintUrl(mintInToken);

      const spentProofs = await this.checkProofsSpendable(proofs);
      if (spentProofs != undefined && spentProofs.length == proofs.length) {
        // all proofs are spent, set token to paid
        tokenStore.setTokenPaid(tokenStr);
      } else if (
        spentProofs != undefined &&
        spentProofs.length &&
        spentProofs.length < proofs.length
      ) {
        // not all proofs are spent, we remove the spent part of the token from the history
        const spentAmount = proofsStore.sumProofs(spentProofs);
        const serializedSpentProofs = proofsStore.serializeProofs(spentProofs);
        const unspentProofs = proofs.filter(
          (p) => !spentProofs.find((sp) => sp.secret === p.secret)
        );
        const unspentAmount = proofsStore.sumProofs(unspentProofs);
        const serializedUnspentProofs =
          proofsStore.serializeProofs(unspentProofs);

        if (serializedSpentProofs && serializedUnspentProofs) {
          const historyToken = tokenStore.editHistoryToken(tokenStr, {
            newAmount: spentAmount,
            newStatus: "paid",
            newToken: serializedSpentProofs,
          });
          // add all unspent proofs back to the history
          // QUICK: we use the historyToken object here because we don't know if the transaction is incoming or outgoing (we don't know the sign of the amount)
          if (historyToken) {
            tokenStore.addPendingToken({
              amount: unspentAmount * Math.sign(historyToken.amount),
              serializedProofs: serializedUnspentProofs,
              unit: historyToken.unit,
              mint: historyToken.mint,
            });
          }
        }
      }
      if (spentProofs != undefined && spentProofs.length) {
        if (!!window.navigator.vibrate) navigator.vibrate(200);
        const proofStore = useProofsStore();
        notifySuccess(
          "Sent " +
            uIStore.formatCurrency(
              proofStore.sumProofs(spentProofs),
              mintStore.activeUnit
            )
        );
      } else {
        console.log("### token not paid yet");
        if (verbose) {
          notify("Token still pending");
        }
        return false;
      }
      return true;
    },
    mintOnPaid: async function (quote: string, verbose = true) {
      const activeMint = useMintsStore().activeMint().mint;
      const mintStore = useMintsStore();
      const settingsStore = useSettingsStore();
      if (
        !settingsStore.useWebsockets ||
        !activeMint.info?.nuts[17]?.supported ||
        !activeMint.info?.nuts[17]?.supported.find(
          (s) =>
            s.method == "bolt11" &&
            s.unit == mintStore.activeUnit &&
            s.commands.indexOf("bolt11_mint_quote") != -1
        )
      ) {
        console.log(
          "Websockets not supported, kicking off invoice check worker."
        );
        useWorkersStore().invoiceCheckWorker(quote);
        return;
      }
      const uIStore = useUiStore();
      const invoice = this.invoiceHistory.find((i) => i.quote === quote);
      if (!invoice) {
        throw new Error("invoice not found");
      }
      try {
        const unsub = await this.wallet.onMintQuotePaid(
          quote,
          async (mintQuoteResponse: MintQuoteResponse) => {
            console.log("Websocket: mint quote paid.");
            const proofs = await this.mint(invoice.amount, quote, verbose);
            uIStore.showInvoiceDetails = false;
            if (!!window.navigator.vibrate) navigator.vibrate(200);
            notifySuccess("Received " + invoice.amount + " via Lightning");
            unsub();
            return proofs;
          },
          async (error: any) => {
            if (verbose) {
              notifyApiError(error);
            }
            console.log("Invoice still pending", invoice.quote);
            throw error;
          }
        );
      } catch (error) {
        console.log("Error in websocket subscription", error);
        useWorkersStore().invoiceCheckWorker(quote);
      }
    },
    checkInvoice: async function (quote: string, verbose = true) {
      const uIStore = useUiStore();
      const mintStore = useMintsStore();
      const invoice = this.invoiceHistory.find((i) => i.quote === quote);
      if (!invoice) {
        throw new Error("invoice not found");
      }
      try {
        // check the state first
        const state = await this.getMintQuoteState(
          invoice.quote,
          new CashuMint(invoice.mint)
        );
        if (state == MintQuoteState.ISSUED) {
          this.setInvoicePaid(invoice.quote);
          return;
        }
        if (state != MintQuoteState.PAID) {
          console.log("### mintQuote not paid yet");
          if (verbose) {
            notify("Invoice still pending");
          }
          throw new Error(`invoice state not paid: ${state}`);
        }
        // activate the mint
        await mintStore.activateMintUrl(
          invoice.mint,
          false,
          false,
          invoice.unit
        );
        const proofs = await this.mint(invoice.amount, invoice.quote, verbose);
        uIStore.showInvoiceDetails = false;
        if (!!window.navigator.vibrate) navigator.vibrate(200);
        notifySuccess(
          "Received " +
            uIStore.formatCurrency(invoice.amount, mintStore.activeUnit) +
            " via Lightning"
        );
        return proofs;
      } catch (error) {
        if (verbose) {
          notify("Invoice still pending");
        }
        console.log("Invoice still pending", invoice.quote);
        throw error;
      }
    },
    checkOutgoingInvoice: async function (quote: string, verbose = true) {
      const uIStore = useUiStore();
      const mintStore = useMintsStore();
      const invoice = this.invoiceHistory.find((i) => i.quote === quote);
      if (!invoice) {
        throw new Error("invoice not found");
      }

      const proofs: Proof[] = mintStore.proofs.filter((p) => p.quote === quote);
      try {
        // this is an outgoing invoice, we first do a getMintQuote to check if the invoice is paid
        const mint = new CashuMint(invoice.mint);
        const mintQuote = await mint.checkMeltQuote(quote);
        if (mintQuote.state == MeltQuoteState.PENDING) {
          console.log("### mintQuote not paid yet");
          if (verbose) {
            notify("Invoice still pending");
          }
          throw new Error("invoice not paid yet.");
        } else if (mintQuote.state == MeltQuoteState.UNPAID) {
          // we assume that the payment failed and we unset the proofs as reserved
          useProofsStore().setReserved(proofs, false);
          this.removeOutgoingInvoiceFromHistory(quote);
          notifyWarning("Lightning payment failed");
        } else if (mintQuote.state == MeltQuoteState.PAID) {
          // if the invoice is paid, we check if all proofs are spent and if so, we invalidate them and set the invoice state in the history to "paid"
          await mintStore.activateMintUrl(
            invoice.mint,
            false,
            false,
            invoice.unit
          );
          const spentProofs = await this.checkProofsSpendable(proofs, true);
          if (spentProofs != undefined && spentProofs.length == proofs.length) {
            mintStore.removeProofs(proofs);
            if (!!window.navigator.vibrate) navigator.vibrate(200);
            notifySuccess(
              "Sent " +
                uIStore.formatCurrency(
                  useProofsStore().sumProofs(proofs),
                  mintStore.activeUnit
                )
            );
          }
          // set invoice in history to paid
          this.setInvoicePaid(quote);
        }
      } catch (error: any) {
        if (verbose) {
          notifyApiError(error);
        }
        console.log("Could not check quote", invoice.quote, error);
        throw error;
      }
    },
    ////////////// UI HELPERS //////////////
    addOutgoingPendingInvoiceToHistory: function (
      quote: MeltQuoteResponse,
      sendProofs: Proof[]
    ) {
      const proofsStore = useProofsStore();
      proofsStore.setReserved(sendProofs, true, quote.quote);
      const mintStore = useMintsStore();
      this.invoiceHistory.push({
        amount: -(quote.amount + quote.fee_reserve),
        bolt11: this.payInvoiceData.input.request,
        quote: quote.quote,
        memo: "Outgoing invoice",
        date: currentDateStr(),
        status: "pending",
        mint: mintStore.activeMintUrl,
        unit: mintStore.activeUnit,
      });
    },
    removeOutgoingInvoiceFromHistory: function (quote: string) {
      const index = this.invoiceHistory.findIndex((i) => i.quote === quote);
      if (index >= 0) {
        this.invoiceHistory.splice(index, 1);
      }
    },
    updateInvoiceInHistory: function (
      quote: MeltQuoteResponse,
      options?: { status?: "pending" | "paid"; amount?: number }
    ) {
      this.invoiceHistory
        .filter((i) => i.quote === quote.quote)
        .forEach((i) => {
          if (options) {
            if (options.status) {
              i.status = options.status;
            }
            if (options.amount) {
              i.amount = options.amount;
            }
          }
        });
    },
    checkPendingTokens: async function (verbose: boolean = true) {
      const tokenStore = useTokensStore();
      const last_n = 5;
      let i = 0;
      // invert for loop
      for (const t of tokenStore.historyTokens.slice().reverse()) {
        if (i >= last_n) {
          break;
        }
        if (t.status === "pending" && t.amount < 0 && t.token) {
          console.log("### checkPendingTokens", t.token);
          this.checkTokenSpendable(t.token, verbose);
          i += 1;
        }
      }
    },
    handleBolt11Invoice: async function () {
      this.payInvoiceData.show = true;
      let invoice;
      try {
        invoice = bolt11Decoder.decode(this.payInvoiceData.input.request);
      } catch (error) {
        notifyWarning("Failed to decode invoice", undefined, 3000);
        this.payInvoiceData.show = false;
        throw error;
      }
      let cleanInvoice = {
        bolt11: invoice.paymentRequest,
        memo: "",
        msat: 0,
        sat: 0,
        fsat: 0,
        hash: "",
        description: "",
        timestamp: 0,
        expireDate: "",
        expired: false,
      };
      _.each(invoice.sections, (tag) => {
        if (_.isObject(tag) && _.has(tag, "name")) {
          if (tag.name === "amount") {
            cleanInvoice.msat = tag.value;
            cleanInvoice.sat = tag.value / 1000;
            cleanInvoice.fsat = cleanInvoice.sat;
          } else if (tag.name === "payment_hash") {
            cleanInvoice.hash = tag.value;
          } else if (tag.name === "description") {
            cleanInvoice.description = tag.value;
          } else if (tag.name === "timestamp") {
            cleanInvoice.timestamp = tag.value;
          } else if (tag.name === "expiry") {
            var expireDate = new Date(
              (cleanInvoice.timestamp + tag.value) * 1000
            );
            cleanInvoice.expireDate = date.formatDate(
              expireDate,
              "YYYY-MM-DDTHH:mm:ss.SSSZ"
            );
            cleanInvoice.expired = false; // TODO
          }
        }
      });

      this.payInvoiceData.invoice = Object.freeze(cleanInvoice);
      // get quote for this request
      await this.meltQuote();
      await this.multiPathMeltQuotes();
    },
    handleCashuToken: function () {
      this.payInvoiceData.show = false;
      receiveStore.showReceiveTokens = true;
    },
    handleP2PK: function (req: string) {
      const sendTokenStore = useSendTokensStore();
      sendTokenStore.sendData.p2pkPubkey = req;
      sendTokenStore.showSendTokens = true;
      sendTokenStore.showLockInput = true;
    },
    handlePaymentRequest: async function (req: string) {
      const prStore = usePRStore();
      await prStore.decodePaymentRequest(req);
    },
    decodeRequest: async function (req: string) {
      const p2pkStore = useP2PKStore();
      req = req.trim();
      this.payInvoiceData.input.request = req;
      if (req.toLowerCase().startsWith("lnbc")) {
        this.payInvoiceData.input.request = req;
        await this.handleBolt11Invoice();
      } else if (req.toLowerCase().startsWith("lightning:")) {
        this.payInvoiceData.input.request = req.slice(10);
        await this.handleBolt11Invoice();
      } else if (req.startsWith("bitcoin:")) {
        const lightningInvoice = req.match(/lightning=([^&]+)/);
        if (lightningInvoice) {
          this.payInvoiceData.input.request = lightningInvoice[1];
          await this.handleBolt11Invoice();
        }
      } else if (req.toLowerCase().startsWith("lnurl:")) {
        this.payInvoiceData.input.request = req.slice(6);
        await this.lnurlPayFirst(this.payInvoiceData.input.request);
      } else if (req.indexOf("lightning=lnurl1") !== -1) {
        this.payInvoiceData.input.request = req
          .split("lightning=")[1]
          .split("&")[0];
        await this.lnurlPayFirst(this.payInvoiceData.input.request);
      } else if (
        req.toLowerCase().startsWith("lnurl1") ||
        req.match(/[\w.+-~_]+@[\w.+-~_]/)
      ) {
        this.payInvoiceData.input.request = req;
        await this.lnurlPayFirst(this.payInvoiceData.input.request);
      } else if (req.startsWith("cashuA") || req.startsWith("cashuB")) {
        // parse cashu tokens from a pasted token
        receiveStore.receiveData.tokensBase64 = req;
        this.handleCashuToken();
      } else if (req.indexOf("token=cashu") !== -1) {
        // parse cashu tokens from a URL like https://example.com#token=cashu...
        const token = req.slice(req.indexOf("token=cashu") + 6);
        receiveStore.receiveData.tokensBase64 = token;
        this.handleCashuToken();
      } else if (p2pkStore.isValidPubkey(req)) {
        this.handleP2PK(req);
      } else if (req.startsWith("http")) {
        const mintStore = useMintsStore();
        mintStore.addMintData = { url: req, nickname: "" };
      } else if (req.startsWith("creqA")) {
        await this.handlePaymentRequest(req);
      }
      const uiStore = useUiStore();
      uiStore.closeDialogs();
    },
    fetchBitcoinPriceUSD: async function () {
      var { data } = await axios.get(
        "https://api.coinbase.com/v2/exchange-rates?currency=BTC"
      );
      return data.data.rates.USD;
    },
    lnurlPayFirst: async function (address: string) {
      var host;
      var data;
      if (address.split("@").length == 2) {
        let [user, lnaddresshost] = address.split("@");
        host = `https://${lnaddresshost}/.well-known/lnurlp/${user}`;
        const resp = await axios.get(host); // Moved it here: we don't want 2 potential calls
        data = resp.data;
      } else if (address.toLowerCase().slice(0, 6) === "lnurl1") {
        let decoded = bech32.decode(address, 20000);
        const words = bech32.fromWords(decoded.words);
        const uint8Array = new Uint8Array(words);
        host = new TextDecoder().decode(uint8Array);

        const resp = await axios.get(host);
        data = resp.data;
      }
      if (host == undefined) {
        notifyError("Invalid LNURL", "LNURL Error");
        return;
      }
      if (data.tag == "payRequest") {
        this.payInvoiceData.lnurlpay = data;
        this.payInvoiceData.lnurlpay.domain = host
          .split("https://")[1]
          .split("/")[0];
        if (
          this.payInvoiceData.lnurlpay.maxSendable ==
          this.payInvoiceData.lnurlpay.minSendable
        ) {
          this.payInvoiceData.input.amount =
            this.payInvoiceData.lnurlpay.maxSendable / 1000;
        }
        this.payInvoiceData.invoice = null;
        this.payInvoiceData.input = {
          request: "",
          amount: null,
          comment: "",
          quote: "",
        };
        this.payInvoiceData.show = true;
      }
    },
    lnurlPaySecond: async function () {
      const mintStore = useMintsStore();
      let amount = this.payInvoiceData.input.amount;
      if (amount == null) {
        notifyError("No amount", "LNURL Error");
        return;
      }
      if (this.payInvoiceData.lnurlpay == null) {
        notifyError("No LNURL data", "LNURL Error");
        return;
      }
      if (
        this.payInvoiceData.lnurlpay.tag == "payRequest" &&
        this.payInvoiceData.lnurlpay.minSendable <= amount * 1000 &&
        this.payInvoiceData.lnurlpay.maxSendable >= amount * 1000
      ) {
        if (mintStore.activeUnit == "usd") {
          try {
            var priceUsd = await this.fetchBitcoinPriceUSD();
          } catch (e) {
            notifyError(
              "Couldn't get Bitcoin price",
              "fetchBitcoinPriceUSD Error"
            );
            return;
          }

          const satPrice = 1 / (priceUsd / 1e8);
          const usdAmount = amount;
          amount = Math.floor(usdAmount * satPrice);
        }
        var { data } = await axios.get(
          `${this.payInvoiceData.lnurlpay.callback}?amount=${amount * 1000}`
        );
        // check http error
        if (data.status == "ERROR") {
          notifyError(data.reason, "LNURL Error");
          return;
        }
        await this.decodeRequest(data.pr);
      }
    },
    initializeMnemonic: function () {
      if (this.mnemonic == "") {
        this.mnemonic = generateMnemonic(wordlist);
      }
      return this.mnemonic;
    },
    handleOutputsHaveAlreadyBeenSignedError: function (
      keysetId: string,
      error: any
    ) {
      if (error.message.includes("outputs have already been signed")) {
        this.increaseKeysetCounter(keysetId, 10);
        notify("Please try again.");
        return true;
      }
      return false;
    },
  },
});
