// Dhan Live Market Feed (WebSocket v2) - see
// https://dhanhq.co/docs/v2/live-market-feed/ and
// https://dhanhq.co/docs/v2/annexure/#feed-request-code /
// #feed-response-code for the exact wire format this file implements.
//
// Scope: Quote mode only (LTP, LTQ, LTT, ATP, volume, buy/sell qty
// totals, day OHLC). Deliberately NOT Full mode/Market Depth - this app
// has no use for the order book, and Full carries no additional data we
// need over Quote. Also deliberately NOT a replacement for the
// option-chain REST endpoint: Dhan's WS feed never sends Greeks or IV
// under any mode, so OptionChainSnapshot/OptionContractTick capture stays
// on REST regardless (see the 2026-07-29 WebSocket feasibility note this
// module is the outcome of). This client is purely for the handful of
// REST calls that only ever needed LTP/OHLC/volume - getOhlcQuotes,
// getLtpQuotes, getEquityQuotes - which the WS feed pushes at ~1s
// resolution instead of a 30-60s poll.
//
// No Redis/DB/app dependency here - same DB-agnostic shape as
// DhanClient's onRequest audit callback in index.ts. The caller supplies
// onTick and decides what to do with each update (worker.ts/server.ts
// write it into a small Redis tick cache; see their live-tick-cache
// helpers). Callers are expected to keep their existing REST calls as a
// fallback for any instrument this feed hasn't reported fresh data for
// yet (first few seconds after connecting, or a genuinely stale feed).

export type DhanLiveFeedExchangeSegment = "IDX_I" | "NSE_EQ" | "NSE_FNO" | "NSE_CURRENCY" | "BSE_EQ" | "MCX_COMM" | "BSE_CURRENCY" | "BSE_FNO";

// Numeric codes used in the BINARY response header's Exchange Segment
// byte - distinct from the STRING segment names ("NSE_EQ" etc.) used in
// the JSON subscribe request, which match UnderlyingDefinition.segment /
// FnoStock's segment strings already used elsewhere in this codebase.
const EXCHANGE_SEGMENT_TO_CODE: Record<DhanLiveFeedExchangeSegment, number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8
};
const CODE_TO_EXCHANGE_SEGMENT = new Map<number, DhanLiveFeedExchangeSegment>(
  (Object.entries(EXCHANGE_SEGMENT_TO_CODE) as [DhanLiveFeedExchangeSegment, number][]).map(([segment, code]) => [code, segment])
);

// Feed Request Codes (JSON, client -> server).
const REQUEST_CODE_SUBSCRIBE_QUOTE = 17;
const REQUEST_CODE_DISCONNECT = 12;
// Feed Response Codes (binary, server -> client).
const RESPONSE_CODE_TICKER = 2;
const RESPONSE_CODE_QUOTE = 4;
const RESPONSE_CODE_PREV_CLOSE = 6;
const RESPONSE_CODE_DISCONNECT = 50;

const MAX_INSTRUMENTS_PER_MESSAGE = 100;
const MAX_INSTRUMENTS_PER_CONNECTION = 5000;
// Server pings every 10s and disconnects after 40s of silence (per docs).
// The underlying WebSocket implementation answers protocol-level pings
// automatically - this is a defense-in-depth watchdog for a half-open
// connection (TCP still "open" but no bytes flowing either way), which a
// protocol-level ping/pong alone won't catch.
const SILENT_CONNECTION_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 10_000;
// Node's global WebSocket (the WHATWG/browser-style API used here) has no
// way to send a raw WS-protocol ping frame from application code - unlike
// Node-specific libraries (e.g. `ws`), which expose ws.ping(). Dhan's
// server pings keep the connection alive from ITS side, but our client
// never sends anything outbound after the initial subscribe messages.
// Observed in production (2026-07-29): the connection was abnormally
// closing (code 1006, no close frame) roughly every 11-12 minutes -
// consistent with a NAT/firewall/load balancer somewhere in the path
// treating a connection with no CLIENT-originated traffic as one-way/idle
// and dropping it, even with data flowing in continuously from the
// server. Re-sending a harmless subscribe message for an
// already-subscribed instrument periodically puts real outbound traffic
// on the wire - Dhan's subscribe is idempotent/additive, so resubscribing
// something already subscribed is a safe no-op on their side. Interval is
// well under the ~11-12min disconnect cadence observed, so this refreshes
// the network path's view of the connection before whatever's timing it
// out gets the chance to.
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export interface DhanLiveFeedInstrument {
  exchangeSegment: DhanLiveFeedExchangeSegment;
  securityId: number;
}

export interface DhanLiveFeedTick {
  exchangeSegment: DhanLiveFeedExchangeSegment;
  securityId: number;
  ltp?: number;
  ltt?: number;
  ltq?: number;
  atp?: number;
  volume?: number;
  totalSellQty?: number;
  totalBuyQty?: number;
  dayOpen?: number;
  // Today's closing price - per Dhan's docs this is only populated AFTER
  // market close, so it's useless as a live "previous close" during
  // trading hours. Use prevClose (from the dedicated Prev Close packet)
  // for that instead - never this field.
  dayClose?: number;
  dayHigh?: number;
  dayLow?: number;
  // Previous trading day's closing price - arrives on its own packet
  // (response code 6), sent automatically once any mode is subscribed for
  // an instrument. This is what change/changePercent should be computed
  // against during live trading.
  prevClose?: number;
  // When this client received/parsed the packet - not the same as ltt
  // (Dhan's last-trade-time, which for a quiet instrument can legitimately
  // be old even while the feed itself is perfectly healthy). Callers
  // should judge feed/staleness health off receivedAt, not ltt.
  receivedAt: number;
}

export type DhanLiveFeedStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "reconnecting"; detail: string }
  | { state: "closed" };

export interface DhanLiveFeedOptions {
  baseUrl?: string;
  accessToken: string;
  clientId: string;
  onTick: (tick: DhanLiveFeedTick) => void;
  onStatus?: (status: DhanLiveFeedStatus) => void;
}

function instrumentKey(instrument: DhanLiveFeedInstrument): string {
  return `${instrument.exchangeSegment}:${instrument.securityId}`;
}

export class DhanLiveFeedClient {
  private readonly options: DhanLiveFeedOptions;
  private readonly baseUrl: string;
  private ws: WebSocket | undefined;
  private readonly desired = new Map<string, DhanLiveFeedInstrument>();
  private pendingReconnect: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;
  private closedByCaller = false;
  private reconnectAttempts = 0;

  constructor(options: DhanLiveFeedOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? "wss://api-feed.dhan.co";
  }

  connect(): void {
    this.closedByCaller = false;
    this.openSocket();
  }

  close(): void {
    this.closedByCaller = true;
    if (this.pendingReconnect) {
      clearTimeout(this.pendingReconnect);
      this.pendingReconnect = undefined;
    }
    this.stopWatchdog();
    this.stopKeepAlive();
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ RequestCode: REQUEST_CODE_DISCONNECT }));
      } catch {
        // Best-effort - closing the socket regardless.
      }
    }
    ws?.close();
    this.ws = undefined;
  }

  // Additive/idempotent: instruments already subscribed are ignored, so
  // callers can safely re-call this on a timer with the full desired set
  // (e.g. worker.ts resyncing against the current F&O stock universe or a
  // rolled MCX futures contract) without needing to diff anything
  // themselves.
  subscribe(instruments: DhanLiveFeedInstrument[]): void {
    const newlyAdded: DhanLiveFeedInstrument[] = [];
    for (const instrument of instruments) {
      const key = instrumentKey(instrument);
      if (!this.desired.has(key)) {
        this.desired.set(key, instrument);
        newlyAdded.push(instrument);
      }
    }

    if (this.desired.size > MAX_INSTRUMENTS_PER_CONNECTION) {
      console.warn("DhanLiveFeedClient: desired subscription count exceeds the 5000-instrument-per-connection cap", { count: this.desired.size });
    }

    const ws = this.ws;
    if (!newlyAdded.length || !ws || ws.readyState !== ws.OPEN) {
      return;
    }
    for (let i = 0; i < newlyAdded.length; i += MAX_INSTRUMENTS_PER_MESSAGE) {
      this.sendSubscribe(newlyAdded.slice(i, i + MAX_INSTRUMENTS_PER_MESSAGE));
    }
  }

  private openSocket(): void {
    this.options.onStatus?.({ state: "connecting" });
    const url = `${this.baseUrl}?version=2&token=${encodeURIComponent(this.options.accessToken)}&clientId=${encodeURIComponent(this.options.clientId)}&authType=2`;
    const ws: WebSocket = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageAt = Date.now();
      this.options.onStatus?.({ state: "open" });
      this.subscribeAll();
      this.startWatchdog();
      this.startKeepAlive();
    };

    ws.onmessage = (event: MessageEvent) => {
      this.lastMessageAt = Date.now();
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) {
        this.handleBinaryMessage(data);
      }
    };

    ws.onerror = () => {
      // The close handler (always fired after error, per the WebSocket
      // spec) is what actually schedules the reconnect - nothing further
      // to do here beyond the status callback for visibility.
      this.options.onStatus?.({ state: "reconnecting", detail: "socket error" });
    };

    ws.onclose = (event: { code: number; reason?: string }) => {
      this.stopWatchdog();
      this.stopKeepAlive();
      this.ws = undefined;
      if (this.closedByCaller) {
        this.options.onStatus?.({ state: "closed" });
        return;
      }
      this.options.onStatus?.({ state: "reconnecting", detail: `closed (code ${event.code})` });
      this.scheduleReconnect();
    };
  }

  private subscribeAll(): void {
    const instruments = [...this.desired.values()];
    for (let i = 0; i < instruments.length; i += MAX_INSTRUMENTS_PER_MESSAGE) {
      this.sendSubscribe(instruments.slice(i, i + MAX_INSTRUMENTS_PER_MESSAGE));
    }
  }

  private sendSubscribe(instruments: DhanLiveFeedInstrument[]): void {
    const ws = this.ws;
    if (!instruments.length || !ws || ws.readyState !== ws.OPEN) {
      return;
    }
    const message = {
      RequestCode: REQUEST_CODE_SUBSCRIBE_QUOTE,
      InstrumentCount: instruments.length,
      InstrumentList: instruments.map((instrument) => ({
        ExchangeSegment: instrument.exchangeSegment,
        SecurityId: String(instrument.securityId)
      }))
    };
    ws.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.pendingReconnect) {
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.pendingReconnect = setTimeout(() => {
      this.pendingReconnect = undefined;
      this.openSocket();
    }, delay);
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      const silentForMs = Date.now() - this.lastMessageAt;
      if (silentForMs > SILENT_CONNECTION_TIMEOUT_MS) {
        console.warn("DhanLiveFeedClient: no data received recently, forcing reconnect", { silentForMs });
        this.ws?.close();
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      this.sendKeepAlive();
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  // See KEEP_ALIVE_INTERVAL_MS's comment - resubscribing one already-
  // subscribed instrument is a safe, idempotent way to put outbound
  // traffic on the wire with no protocol support beyond what we already
  // use.
  private sendKeepAlive(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN || !this.desired.size) {
      return;
    }
    const [first] = this.desired.values();
    this.sendSubscribe([first]);
  }

  // Each binary WS message may contain one or more concatenated packets -
  // the response header's message-length field is what lets us walk
  // through them (and safely skip any packet type we don't parse, e.g.
  // OI/PrevClose/Index/MarketStatus, without corrupting our position in
  // the buffer).
  private handleBinaryMessage(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    let offset = 0;
    while (offset + 8 <= view.byteLength) {
      const responseCode = view.getUint8(offset);
      const messageLength = view.getInt16(offset + 1, true);
      const segmentCode = view.getUint8(offset + 3);
      const securityId = view.getInt32(offset + 4, true);

      if (messageLength < 8 || offset + messageLength > view.byteLength) {
        // Malformed/truncated - stop parsing this buffer rather than risk
        // reading garbage past its end.
        break;
      }

      if (responseCode === RESPONSE_CODE_DISCONNECT) {
        const reasonCode = messageLength >= 10 ? view.getInt16(offset + 8, true) : undefined;
        console.warn("DhanLiveFeedClient: server sent a feed-disconnect packet", { reasonCode });
      } else {
        const exchangeSegment = CODE_TO_EXCHANGE_SEGMENT.get(segmentCode);
        if (exchangeSegment) {
          this.parsePacket(view, offset, responseCode, exchangeSegment, securityId, messageLength);
        }
      }

      offset += messageLength;
    }
  }

  private parsePacket(view: DataView, offset: number, responseCode: number, exchangeSegment: DhanLiveFeedExchangeSegment, securityId: number, messageLength: number): void {
    if (responseCode === RESPONSE_CODE_TICKER && messageLength >= 16) {
      this.options.onTick({
        exchangeSegment,
        securityId,
        ltp: view.getFloat32(offset + 8, true),
        ltt: view.getInt32(offset + 12, true),
        receivedAt: Date.now()
      });
      return;
    }

    if (responseCode === RESPONSE_CODE_QUOTE && messageLength >= 50) {
      this.options.onTick({
        exchangeSegment,
        securityId,
        ltp: view.getFloat32(offset + 8, true),
        ltq: view.getInt16(offset + 12, true),
        ltt: view.getInt32(offset + 14, true),
        atp: view.getFloat32(offset + 18, true),
        volume: view.getInt32(offset + 22, true),
        totalSellQty: view.getInt32(offset + 26, true),
        totalBuyQty: view.getInt32(offset + 30, true),
        dayOpen: view.getFloat32(offset + 34, true),
        dayClose: view.getFloat32(offset + 38, true),
        dayHigh: view.getFloat32(offset + 42, true),
        dayLow: view.getFloat32(offset + 46, true),
        receivedAt: Date.now()
      });
      return;
    }

    if (responseCode === RESPONSE_CODE_PREV_CLOSE && messageLength >= 16) {
      this.options.onTick({
        exchangeSegment,
        securityId,
        prevClose: view.getFloat32(offset + 8, true),
        receivedAt: Date.now()
      });
      return;
    }

    // OI (5), Index (1) and Market Status (7) packets are intentionally
    // not parsed - not needed by any current caller. Still safely skipped
    // via handleBinaryMessage's length-based cursor advance, not misread
    // as something else.
  }
}
