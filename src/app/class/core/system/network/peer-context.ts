import * as lzbase62 from 'lzbase62';
import * as SHA256 from 'crypto-js/sha256';

import { base } from '../util/base-x';
import { MutablePeerSessionState, PeerSessionGrade, PeerSessionState } from './peer-session-state';

const Base62 = base('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
const roomIdPattern = /^(\w{6})(\w{3})(\w*)-(\w*)/i;

export interface IPeerContext {
  readonly peerId: string;
  readonly userId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly password: string;
  readonly digestUserId: string;
  readonly digestPassword: string;
  readonly roomChannelName: string;
  readonly isDeveloperJoin: boolean;
  readonly isOpen: boolean;
  readonly isRoom: boolean;
  readonly hasPassword: boolean;
  readonly session: PeerSessionState;
}

export class PeerContext implements IPeerContext {
  peerId: string = '';
  userId: string = '';
  roomId: string = '';
  roomName: string = '';
  password: string = '';
  digestUserId: string = '';
  digestPassword: string = '';
  roomChannelName: string = '';
  isDeveloperJoin: boolean = false;
  isOpen: boolean = false;
  session: MutablePeerSessionState = { grade: PeerSessionGrade.UNSPECIFIED, ping: 0, health: 0, speed: 0, description: '' };

  get isRoom(): boolean { return 0 < this.roomId.length; }
  get hasPassword(): boolean { return 0 < this.password.length + this.digestPassword.length; }

  private constructor(peerId: string) {
    this.parse(peerId);
  }

  private parse(peerId: string) {
    try {
      this.peerId = peerId;
      let regArray = roomIdPattern.exec(peerId);
      let isRoom = regArray != null;
      if (isRoom) {
        this.digestUserId = regArray[1];
        this.roomId = regArray[2];
        this.roomName = lzbase62.decompress(regArray[3]);
        this.digestPassword = regArray[4];
        return;
      }
    } catch (e) {
      console.warn(e);
    }
    this.digestUserId = peerId;
    return;
  }

  verifyPassword(password: string): boolean {
    let digest = calcDigestPassword(this.roomId, password);
    let isCorrect = digest === this.digestPassword;
    return isCorrect;
  }

  verifyPeer(peerId: string): boolean {
    let peer = PeerContext.parse(peerId);
    if (this.roomId !== peer.roomId || this.roomName !== peer.roomName || this.hasPassword !== peer.hasPassword) return false;
    if (!this.hasPassword) return true;
    if (this.isDeveloperJoin && this.digestPassword === peer.digestPassword) return true;
    if (this.password.length < 1) {
      console.error('do not know password.');
      return false;
    }
    return peer.verifyPassword(this.password);
  }

  static parse(peerId: string): PeerContext {
    return new PeerContext(peerId);
  }

  static create(userId: string): PeerContext
  static create(userId: string, roomId: string, roomName: string, password: string): PeerContext
  static create(...args: any[]): PeerContext {
    if (args.length <= 1) {
      return PeerContext._create.apply(this, args);
    } else {
      return PeerContext._createRoom.apply(this, args);
    }
  }

  private static _create(userId: string = ''): PeerContext {
    let digestUserId = calcDigestUserId(userId);
    let peerContext = new PeerContext(digestUserId);

    peerContext.userId = userId;
    return peerContext;
  }

  private static _createRoom(userId: string = '', roomId: string = '', roomName: string = '', password: string = ''): PeerContext {
    let digestUserId = this.generateId('******');
    let developerEntry = parseDeveloperJoinPassword(password);
    let digestPassword = developerEntry ? developerEntry.digestPassword : calcDigestPassword(roomId, password);
    let peerId = `${digestUserId}${roomId}${lzbase62.compress(roomName)}-${digestPassword}`;

    let peerContext = new PeerContext(peerId);
    peerContext.userId = userId;
    peerContext.password = developerEntry ? '' : password;
    if (developerEntry) {
      peerContext.roomChannelName = developerEntry.roomChannelName;
      peerContext.isDeveloperJoin = true;
    }
    return peerContext;
  }

  static createDeveloperJoinPassword(digestPassword: string, roomChannelName: string): string {
    return DEVELOPER_JOIN_PREFIX + btoa(JSON.stringify({ digestPassword, roomChannelName }));
  }

  static generateId(format: string = '********'): string {
    const h: string = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

    let k: string = format;
    k = format.replace(/\*/g, c => h[Math.floor(Math.random() * (h.length))]);

    return k;
  }
}

const DEVELOPER_JOIN_PREFIX = '__UDONARIUM_DEV_JOIN__:';

function parseDeveloperJoinPassword(password: string): { digestPassword: string, roomChannelName: string } | null {
  if (!password || !password.startsWith(DEVELOPER_JOIN_PREFIX)) return null;
  try {
    const data = JSON.parse(atob(password.slice(DEVELOPER_JOIN_PREFIX.length)));
    if (!data || !data.digestPassword || !data.roomChannelName) return null;
    return { digestPassword: String(data.digestPassword), roomChannelName: String(data.roomChannelName) };
  } catch (e) {
    console.warn('developer join password parse failed', e);
    return null;
  }
}

function calcDigestUserId(userId: string): string {
  if (userId == null) return '';
  return calcDigest(userId);
}

function calcDigestPassword(roomId: string, password: string): string {
  if (roomId == null || password == null) return '';
  return 0 < password.length ? calcDigest(roomId + password, 7) : '';
}

function calcDigest(str: string, truncateLength: number = -1): string {
  if (str == null) return '';
  let hash = SHA256(str);
  let array = new Uint8Array(Uint32Array.from(hash.words).buffer);
  let base62 = Base62.encode(array);

  if (truncateLength < 0) truncateLength = base62.length;
  if (base62.length < truncateLength) truncateLength = base62.length;

  base62 = base62.slice(0, truncateLength);
  return base62;
}
