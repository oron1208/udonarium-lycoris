import { setZeroTimeout } from '../util/zero-timeout';
import { Connection, ConnectionCallback } from './connection';
import { IPeerContext, PeerContext } from './peer-context';
import { Logger } from '../util/logger';
import { RoomBeacon, defaultSignalingUrl } from './room-beacon';

/** How a room is carried: through the server, which is the default, or from member to member over SkyWay. */
export type RoomTransport = 'relay' | 'p2p' | 'signaling';
export type ListedPeer = { peerId: string, transport: RoomTransport };

const TRANSPORT_OF_MODE: { [mode: string]: RoomTransport } = {
  'websocket-relay': 'relay', skyway2023: 'p2p', 'websocket-signaling': 'signaling',
};
const MODE_OF_TRANSPORT: { [transport: string]: string } = {
  relay: 'websocket-relay', p2p: 'skyway2023', signaling: 'websocket-signaling',
};
const ROOM_TRANSPORTS_KEY = 'udonarium.roomTransports.v1';
const ROOM_TRANSPORTS_MAX = 200;

type QueueItem = { data: any, sendTo: string };
type ConnectionClass = new (...args: any[]) => Connection;

const unknownContext = PeerContext.parse('???');

/** What a room's way of being carried is called in the lobby. */
export function transportLabel(transport: string): string {
  return transport === 'p2p' ? 'P2P' : transport === 'signaling' ? 'シグナリング' : transport === 'relay' ? 'サーバー通信' : '';
}

export class Network {
  private static _instance: Network
  static get instance(): Network {
    if (!Network._instance) Network._instance = new Network();
    return Network._instance;
  }

  get peerId(): string { return this.connection ? this.connection.peerId : unknownContext.peerId; }
  get peerIds(): string[] { return this.connection ? this.connection.peerIds.concat() : []; }

  get peerContexts(): IPeerContext[] { return this.connection ? this.connection.peerContexts.concat() : []; }
  get peerContext(): IPeerContext { return this.connection ? this.connection.peerContext : unknownContext; }

  get isOpen(): boolean { return this.connection && this.connection.peerContext ? this.connection.peerContext.isOpen : false; }

  readonly callback: ConnectionCallback = new ConnectionCallback();
  /** How this client is connected right now: by its room's own way, or '' when it is not connected. */
  get transport(): string { return this.currentTransport; }
  get bandwidthUsage(): number { return this.connection ? this.connection.bandwidthUsage : 0; }

  private key: string = '';
  private signalingUrl: string = '';
  private iceServers: RTCIceServer[] = [];
  private config: any = {};
  private connectionClassPromise!: Promise<ConnectionClass>;
  private connectionClass!: ConnectionClass;
  private connection!: Connection;

  private queue: Set<QueueItem> = new Set();
  private sendInterval: number = null;
  private sendCallback = () => { this.sendQueue(); }
  private callbackUnload: any = (e) => { this.close(); };
  private currentTransport = '';
  // How the rooms this client has seen are carried, by room. A reconnection takes the room's own way, after a reload too.
  private roomTransports = new Map<string, RoomTransport>(readStoredRoomTransports());
  private beacon: RoomBeacon = null;
  private lastCorrection: { room: string, transport: RoomTransport, at: number } = null;

  private constructor() {
    Logger.debug('Network ready...');
  }

  configure(config: any) {
    this.config = config || {};
  }

  open(peerId?: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  open(userId: string, roomId: string, roomName: string, password: string, transport: RoomTransport)
  open(...args: any[]) {
    if (this.connectionClassPromise || (this.connection && this.connection.peerContext)) {
      Logger.warn('It is already opened.');
      this.close();
    }

    this.openAsync.apply(this, args);
  }

  private async openAsync(...args: any[]) {
    // A room says how it is carried. A new room says so when it is made.
    const transport = this.resolveTransport(args);
    const promise = this.dynamicImport(MODE_OF_TRANSPORT[transport]);
    this.connectionClassPromise = promise;
    this.connectionClass = await promise;
    if (this.connectionClassPromise !== promise) return;

    Logger.debug('Network open...', args, transport);
    this.currentTransport = transport;
    if (args.length >= 4) this.rememberRoomTransport(args[1], args[2], transport);
    this.connection = this.initializeConnection();
    this.closeBeacon();
    this.connection.open.apply(this.connection, args.slice(0, 4));
    this.openBeacon(transport);

    window.addEventListener('unload', this.callbackUnload, false);
  }

  connectionClose(){//円柱デバッグ
    this.closeBeacon();
    if (this.connection) this.connection.close();
    this.connection = null;
    this.connectionClassPromise = null;
    this.currentTransport = '';
    window.removeEventListener('unload', this.callbackUnload, false);
    Logger.debug('Network close...円柱');
 }

  private close() {
    this.closeBeacon();
    if (this.connection) this.connection.close();
    this.connection = null;
    this.connectionClassPromise = null;
    this.currentTransport = '';
    window.removeEventListener('unload', this.callbackUnload, false);
    Logger.debug('Network close...');
  }

  connect(peerId: string): boolean {
    if (this.connection) return this.connection.connect(peerId);
    return false;
  }

  disconnect(peerId: string) {
    if (!this.connection) return;
    if (this.connection.disconnect(peerId)) {
      Logger.debug('<disconnectPeer()> Peer:' + peerId);
      this.disconnect(peerId);
    }
  }

  send(data: any, sendTo?: string) {
    this.queue.add({ data: data, sendTo: sendTo });
    if (this.sendInterval === null) {
      this.sendInterval = setZeroTimeout(this.sendCallback);
    }
  }

  private sendQueue() {
    let broadcast: any[] = [];
    let unicast: { [sendTo: string]: any[] } = {};
    let echocast: any[] = [];

    let loopCount = this.queue.size < 128 ? this.queue.size : 128;
    for (let item of this.queue) {
      if (loopCount <= 0) break;
      loopCount--;
      this.queue.delete(item);
      if (item.sendTo == null) {
        broadcast.push(item.data);
      } else if (item.sendTo === this.peerId) {
        echocast.push(item.data);
      } else {
        if (!(item.sendTo in unicast)) unicast[item.sendTo] = [];
        unicast[item.sendTo].push(item.data);
      }
    }

    // できるだけ一纏めにして送る
    if (this.connection) {
      if (broadcast.length) this.connection.send(broadcast);
      for (let sendTo in unicast) this.connection.send(unicast[sendTo], sendTo);
    }

    // 自分自身への送信
    if (this.callback.onData) {
      this.callback.onData(null, broadcast);
      this.callback.onData(this.peerId, echocast);
    }

    if (0 < this.queue.size) {
      this.sendInterval = setZeroTimeout(this.sendCallback);
    } else {
      this.sendInterval = null;
    }
  }

  setApiKey(key: string) {
    if (this.key !== key) Logger.debug('Key Change');
    this.key = key;
  }

  setSignalingUrl(url: string) {
    if (this.signalingUrl !== url) Logger.debug('Signaling URL Change');
    this.signalingUrl = url;
  }

  setIceServers(iceServers: RTCIceServer[]) {
    this.iceServers = iceServers || [];
  }

  listAllPeers(): Promise<string[]> {
    return this.connection ? this.connection.listAllPeers() : Promise.resolve([]);
  }

  forceResync(): boolean {
    if (this.connection && this.connection.forceResync) return this.connection.forceResync();
    return false;
  }

  manualSaveSnapshot(): boolean {
    if (this.connection && this.connection.manualSaveSnapshot) return this.connection.manualSaveSnapshot();
    return false;
  }

  /** Rooms may choose how they are carried where server communication is the default. */
  get roomTransportIsOptional(): boolean { return this.configuredMode() === 'websocket-relay'; }

  /** A new room may choose P2P once the server has said that it issues SkyWay tokens. */
  get peerToPeerAvailable(): boolean {
    return this.roomTransportIsOptional && !!(this.connection && (this.connection as any).p2pAvailable);
  }

  /** Every member the lobby can find, with the way its room is carried. */
  async listLobby(): Promise<ListedPeer[]> {
    const listed: ListedPeer[] = [];
    const seen = new Set<string>();
    const take = (peerId: string, transport: RoomTransport) => {
      const context = PeerContext.parse(peerId);
      if (!context.isRoom || seen.has(peerId)) return;
      seen.add(peerId);
      listed.push({ peerId, transport });
      this.rememberRoomTransport(context.roomId, context.roomName, transport);
    };
    // The server's own list says how each room is carried.
    const p2pPeerIds: string[] = (this.connection && (this.connection as any).p2pPeerIds) || [];
    const carriedHere: RoomTransport = this.roomTransportIsOptional ? 'relay' : this.defaultTransport();
    for (const peerId of await this.listAllPeers()) take(peerId, p2pPeerIds.includes(peerId) ? 'p2p' : carriedHere);
    // Rooms made as P2P rooms by clients that do not announce themselves on this server.
    if (this.peerToPeerAvailable) for (const peerId of await this.listPeerToPeerLobby()) take(peerId, 'p2p');
    return listed;
  }

  /** Rooms seen in SkyWay's own lobbies. A context is made for the look alone; no room is joined. */
  private async listPeerToPeerLobby(): Promise<string[]> {
    let facade: any = null;
    let timer: any = null;
    try {
      const { SkyWayFacade } = await import('./skyway2023/skyway-facade');
      facade = new SkyWayFacade();
      facade.url = this.config?.backend?.url || '';
      const opening = facade.open(PeerContext.create(PeerContext.generateId()));
      const looking = (async () => {
        await opening;
        return facade.isOpen ? await facade.listAllPeers() : [];
      })();
      return await Promise.race([looking, new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), 10000); })]);
    } catch (error) {
      Logger.warn('P2P rooms could not be listed', error);
      return [];
    } finally {
      if (timer != null) clearTimeout(timer);
      // An open that is still on its way stops at its next step once the facade is closed.
      if (facade) await facade.close().catch(error => Logger.warn('P2P lobby lookup could not be closed', error));
    }
  }

  private configuredMode(): string { return this.config?.backend?.mode || 'skyway2023'; }

  private defaultTransport(): RoomTransport { return TRANSPORT_OF_MODE[this.configuredMode()] || 'p2p'; }

  /** The way to open: a room is carried the way it says, otherwise the configured way is taken. */
  private resolveTransport(args: any[]): RoomTransport {
    if (args.length < 4) return this.defaultTransport();
    // What is asked for comes first. Otherwise a room is carried the way it is known to be; a choice only
    // exists where server communication is the default.
    const asked: RoomTransport = this.roomTransportIsOptional && isTransport(args[4]) ? args[4] : null;
    const known = this.roomTransportIsOptional ? this.roomTransports.get(args[1] + args[2]) : undefined;
    const chosen = asked || (isTransport(known) ? known : null);
    return chosen || this.defaultTransport();
  }

  private rememberRoomTransport(roomId: string, roomName: string, transport: RoomTransport) {
    if (!roomId || !isTransport(transport)) return;
    const key = roomId + roomName;
    if (this.roomTransports.get(key) === transport) return;
    this.roomTransports.delete(key);
    this.roomTransports.set(key, transport);
    while (ROOM_TRANSPORTS_MAX < this.roomTransports.size) this.roomTransports.delete(this.roomTransports.keys().next().value);
    try {
      localStorage.setItem(ROOM_TRANSPORTS_KEY, JSON.stringify(Object.fromEntries(this.roomTransports)));
    } catch (_) { }
  }

  /** The lobby's list was out of date and the room is carried the other way. Join it the way it is carried. */
  private followRoomTransport(errorObject: any): boolean {
    const carried: RoomTransport = errorObject?.transport === 'p2p' ? 'p2p' : errorObject?.transport === 'relay' ? 'relay' : null;
    const context = this.connection && this.connection.peerContext;
    if (!carried || !context || !context.isRoom || carried === this.currentTransport) return false;
    // The server saying the same thing again at once would be a loop; the error is shown instead.
    const now = Date.now();
    const room = context.roomId + context.roomName;
    if (this.lastCorrection && this.lastCorrection.room === room && this.lastCorrection.transport === carried
      && now - this.lastCorrection.at < 15000) return false;
    this.lastCorrection = { room, transport: carried, at: now };
    this.open(context.userId, context.roomId, context.roomName, context.password, carried);
    return true;
  }

  // A P2P room is carried by SkyWay, but found in the server's lobby.
  private openBeacon(transport: RoomTransport) {
    const peerId = this.connection && this.connection.peerContext ? this.connection.peerContext.peerId : '';
    if (transport !== 'p2p' || !this.roomTransportIsOptional || !peerId || peerId === '???') return;
    this.beacon = new RoomBeacon(this.config?.backend?.url || this.signalingUrl || defaultSignalingUrl(), peerId, message => this.followRoomTransport(message));
    this.beacon.open();
  }

  private closeBeacon() {
    if (!this.beacon) return;
    this.beacon.close();
    this.beacon = null;
  }

  private initializeConnection(): Connection {
    // 通信方式だけ最新版ユドナリウムのSkyWay 2023(P2P)へ戻す。
    // リコリス側の卓改造/サーバー保存APIは残す。
    let store: Connection = new this.connectionClass();
    if (store.configure) store.configure(this.config);
    if (store.setApiKey) store.setApiKey(this.key);
    if (store.setSignalingUrl) store.setSignalingUrl(this.config?.backend?.url || this.signalingUrl);
    if (store.setIceServers) store.setIceServers(this.iceServers);

    store.callback.onOpen = (peerId) => { if (this.callback.onOpen) this.callback.onOpen(peerId); }
    store.callback.onClose = (peerId) => { if (this.callback.onClose) this.callback.onClose(peerId); }
    store.callback.onConnect = (peerId) => { if (this.callback.onConnect) this.callback.onConnect(peerId); }
    store.callback.onDisconnect = (peerId) => { if (this.callback.onDisconnect) this.callback.onDisconnect(peerId); }
    store.callback.onData = (peerId, data: any[]) => { if (this.callback.onData) this.callback.onData(peerId, data); }
    store.callback.onError = (peerId, errorType, errorMessage, errorObject) => {
      if (errorType === 'transport-mismatch' && this.followRoomTransport(errorObject)) return;
      if (this.callback.onError) this.callback.onError(peerId, errorType, errorMessage, errorObject);
    }
    store.callback.onPeerUnstable = (peerId, health) => { if (this.callback.onPeerUnstable) this.callback.onPeerUnstable(peerId, health); }

    if (0 < this.queue.size && this.sendInterval === null) this.sendInterval = setZeroTimeout(this.sendCallback);

    return store;
  }

  private async dynamicImport(mode: string = ''): Promise<ConnectionClass> {
    switch (mode) {
      case 'websocket-relay':
        return (await import(
          /* webpackChunkName: "lib/backend/websocket-relay-connection" */
          './websocket-relay-connection')
        ).WebSocketRelayConnection;
      case 'websocket-signaling':
        return (await import(
          /* webpackChunkName: "lib/backend/websocket-signaling-connection" */
          './websocket-signaling-connection')
        ).WebSocketSignalingConnection;
      case 'skyway2023':
      default:
        return (await import(
          /* webpackChunkName: "lib/backend/skyway2023/skyway-connection" */
          './skyway2023/skyway-connection')
        ).SkyWayConnection;
    }
  }
}

function isTransport(value: any): value is RoomTransport {
  return value === 'relay' || value === 'p2p' || value === 'signaling';
}

function readStoredRoomTransports(): [string, RoomTransport][] {
  try {
    const stored = JSON.parse(localStorage.getItem(ROOM_TRANSPORTS_KEY) || '{}');
    return Object.keys(stored).filter(room => isTransport(stored[room])).map(room => [room, stored[room]]);
  } catch (_) {
    return [];
  }
}
