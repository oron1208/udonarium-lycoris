import { EventEmitter } from 'events';
import { SkyWayConnection } from './skyway-connection';
import { PeerContext } from '../peer-context';
import { MessagePack } from '../../util/message-pack';
import { SkyWayDataStream } from './skyway-data-stream';

describe('SkyWay synchronization recovery', () => {
  let connection: any;
  let remote: PeerContext;
  beforeEach(() => {
    connection = new SkyWayConnection();
    connection.skyWay.peer = PeerContext.create('local', 'abc', 'test', '');
    connection.skyWay.peer.isOpen = true;
    remote = PeerContext.create('remote', 'abc', 'test', '');
    connection.skyWay.room = { members: [{ name: remote.peerId }] };
  });
  function fakeStream(): any {
    const stream: any = new EventEmitter();
    stream.peer = remote;
    stream.open = false;
    stream.connect = jasmine.createSpy('connect');
    stream.disconnect = jasmine.createSpy('disconnect');
    stream.send = jasmine.createSpy('send');
    return stream;
  }
  it('retries a failed peer even when no connected peer can advertise it', async () => {
    const first = fakeStream();
    const retry = fakeStream();
    spyOn(SkyWayDataStream, 'createSubscription').and.returnValues(first, retry);
    connection.connect(remote.peerId);
    await Promise.resolve();
    first.emit('close');
    expect(connection.maybeUnavailablePeerIds.has(remote.peerId)).toBeFalse();
    connection.reconcileRoomMembers();
    await Promise.resolve();
    expect(retry.connect).toHaveBeenCalled();
  });
  it('keeps a pending connection, but replaces it after its deadline', async () => {
    const first = fakeStream();
    const retry = fakeStream();
    spyOn(SkyWayDataStream, 'createSubscription').and.returnValues(first, retry);
    connection.connect(remote.peerId);
    connection.reconcileRoomMembers();
    expect(SkyWayDataStream.createSubscription).toHaveBeenCalledTimes(1);
    connection.connectingSince.set(remote.peerId, performance.now() - 31000);
    connection.reconcileRoomMembers();
    await Promise.resolve();
    expect(first.disconnect).toHaveBeenCalled();
    expect(retry.connect).toHaveBeenCalled();
  });
  it('does not remove a replacement when the old stream closes late', () => {
    const old = fakeStream();
    const replacement = fakeStream();
    connection.streams.add(replacement);
    connection.disconnectStream(old);
    expect(connection.streams.find(remote.peerId)).toBe(replacement);
  });
  it('continues receiving after malformed compressed data', async () => {
    const stream = fakeStream();
    connection.callback.onData = jasmine.createSpy('onData');
    connection.onData(stream, { data: new Uint8Array([0, 1, 2]), ttl: 0, isCompressed: true });
    connection.onData(stream, { data: MessagePack.encode([{ position: 42 }]), ttl: 0 });
    await connection.inboundQueue;
    expect(connection.callback.onData).toHaveBeenCalledOnceWith(remote.peerId, [{ position: 42 }]);
    expect(connection.bandwidthUsage).toBe(0);
  });
  it('continues sending after a stream send throws', async () => {
    const stream = fakeStream();
    stream.open = true;
    let attempts = 0;
    stream.send.and.callFake(() => { if (++attempts === 1) throw new Error('send failed'); });
    connection.streams.add(stream);
    connection.send([{ position: 1 }]);
    connection.send([{ position: 2 }]);
    await connection.outboundQueue;
    expect(attempts).toBe(2);
    expect(connection.bandwidthUsage).toBe(0);
  });
  it('routes to actual session IDs, including peers with identical display names', () => {
    const source = fakeStream();
    source.open = true;
    const other = fakeStream();
    other.peer = PeerContext.create('remote', 'abc', 'test', '');
    other.open = true;
    connection.streams.add(source);
    connection.streams.add(other);
    connection.onUpdatePeerIds(source, [remote.peerId, connection.peerId], 'remote');
    expect(connection.relayingPeerIds.get(remote.peerId)).toEqual([other.peer.peerId]);
    connection.onRelay(source, { data: MessagePack.encode([{ position: 7 }]), ttl: 1 });
    expect(other.send).toHaveBeenCalled();
    expect(source.send).not.toHaveBeenCalled();
  });
  it('releases listeners when a connection is canceled before opening', () => {
    const stream: any = SkyWayDataStream.createSubscription(connection.skyWay, remote);
    const removeListener = jasmine.createSpy('removeListener');
    stream.onStreamPublished = { removeListener };
    stream.disconnect();
    expect(removeListener).toHaveBeenCalled();
    expect(stream.peer.isOpen).toBeFalse();
  });
});
