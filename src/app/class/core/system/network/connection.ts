import { IPeerContext } from './peer-context';

export class ConnectionCallback {
  onOpen!: (peerId: string) => void;
  onClose!: (peerId: string) => void;
  onConnect!: (peerId: string) => void;
  onDisconnect!: (peerId: string) => void;
  onData!: (peerId: string, data: any) => void;
  onError!: (peerId: string, errorType: string, errorMessage: string, errorObject: any) => void;
  /** ピアの接続品質が低下した際に呼ばれる（チャット通知用） */
  onPeerUnstable?: (peerId: string, health: number) => void;
}

export interface Connection {
  readonly peerId: string;
  readonly peerIds: string[];
  readonly peerContext: IPeerContext;
  readonly peerContexts: IPeerContext[];
  readonly callback: ConnectionCallback;
  readonly bandwidthUsage: number;

  open(peerId: string)
  open(userId: string, roomId: string, roomName: string, password: string)
  close()
  connect(peerId: string): boolean
  disconnect(peerId: string): boolean
  disconnectAll()
  send(data: any, sendTo?: string)
  configure?(config: any)
  setApiKey(key: string);
  setSignalingUrl?(url: string);
  setIceServers?(iceServers: RTCIceServer[]);
  listAllPeers(): Promise<string[]>
  forceResync?(): boolean
  manualSaveSnapshot?(): boolean
}
