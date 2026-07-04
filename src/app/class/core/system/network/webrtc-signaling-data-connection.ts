import { EventEmitter } from 'events';
import { Logger } from '../util/logger';

export class WebRtcSignalingDataConnection extends EventEmitter {
  private isOpen = false;

  get open(): boolean { return this.isOpen && this.dataChannel.readyState === 'open'; }
  get bufferedAmount(): number { return this.dataChannel.bufferedAmount; }
  // SkyWayDataConnection が参照していた内部プロパティ互換
  get _dc(): RTCDataChannel { return this.dataChannel; }

  constructor(
    readonly remoteId: string,
    private peerConnection: RTCPeerConnection,
    private dataChannel: RTCDataChannel,
    readonly metadata: any = {}
  ) {
    super();
    this.bindDataChannel(dataChannel);
    peerConnection.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(peerConnection.connectionState)) {
        this.close();
      }
    });
  }

  close() {
    if (!this.isOpen && this.dataChannel.readyState === 'closed') return;
    this.isOpen = false;
    try { this.dataChannel.close(); } catch (e) { Logger.warn(e); }
    try { this.peerConnection.close(); } catch (e) { Logger.warn(e); }
    this.emit('close');
  }

  send(data: any) {
    if (!this.open) return;
    this.dataChannel.send(data);
  }

  getPeerConnection(): RTCPeerConnection {
    return this.peerConnection;
  }

  private bindDataChannel(channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      this.isOpen = true;
      this.emit('open');
    });
    channel.addEventListener('close', () => {
      this.isOpen = false;
      this.emit('close');
    });
    channel.addEventListener('error', (event) => {
      this.isOpen = false;
      this.emit('error', event);
    });
    channel.addEventListener('message', (event) => {
      this.emit('data', event.data);
    });
  }
}
