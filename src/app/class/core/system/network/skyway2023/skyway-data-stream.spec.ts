import { SkyWayDataStream } from './skyway-data-stream';
import { PeerContext } from '../peer-context';
import { clearZeroTimeout } from '../../util/zero-timeout';

describe('SkyWay send flow control', () => {
  let stream: any;
  let channel: any;
  beforeEach(() => {
    stream = SkyWayDataStream.createSubscription({ peer: PeerContext.create('self') } as any, PeerContext.create('other'));
    channel = {
      readyState: 'open', bufferedAmount: 0,
      send: jasmine.createSpy('send'),
      removeEventListener: () => {}, close: () => {}
    };
    stream.dataChannel = channel;
  });
  afterEach(() => stream.disconnect());
  function flush() {
    if (stream.sendTask != null) clearZeroTimeout(stream.sendTask);
    stream.execQueue();
  }
  it('batches small packets in order in one scheduled turn', () => {
    const packets = Array.from({ length: 10 }, (_, i) => new Uint8Array([i]));
    packets.forEach(packet => stream.addSendQueue(packet));
    expect(channel.send).not.toHaveBeenCalled();
    flush();
    expect(channel.send.calls.allArgs().map(args => args[0][0])).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(stream.sendQueue.size).toBe(0);
  });
  it('pauses at the high-water mark, then resumes without losing packets', () => {
    channel.bufferedAmount = 256 * 1024;
    const packet = new Uint8Array([42]);
    stream.addSendQueue(packet);
    flush();
    expect(channel.send).not.toHaveBeenCalled();
    expect(stream.sendTask).toBeNull();
    expect(stream.sendQueue.size).toBe(1);
    channel.bufferedAmount = 64 * 1024;
    stream.onbufferedamountlow();
    flush();
    expect(channel.send).toHaveBeenCalledOnceWith(packet);
  });
  it('yields after a bounded burst instead of monopolizing the UI', () => {
    for (let i = 0; i < 12; i++) stream.addSendQueue(new Uint8Array(16 * 1024));
    flush();
    expect(channel.send).toHaveBeenCalledTimes(4);
    expect(stream.sendQueue.size).toBe(8);
    expect(stream.sendTask).not.toBeNull();
  });
  it('backs off on buffer errors, and stops retrying after the limit', () => {
    jasmine.clock().install();
    try {
      channel.send.and.throwError(new DOMException('full', 'OperationError'));
      const close = jasmine.createSpy('close');
      stream.on('close', close);
      stream.addSendQueue(new Uint8Array([1]));
      flush();
      expect(stream.sendTask).toBeNull();
      expect(close).not.toHaveBeenCalled();
      for (let i = 0; i < 5; i++) { jasmine.clock().tick(100); flush(); }
      expect(channel.send).toHaveBeenCalledTimes(6);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stream.retryTimer).toBeNull();
    } finally { jasmine.clock().uninstall(); }
  });
  it('cancels scheduled work on disconnect', () => {
    stream.addSendQueue(new Uint8Array([1]));
    stream.disconnect();
    expect(stream.sendTask).toBeNull();
    expect(stream.sendQueue.size).toBe(0);
    flush();
    expect(channel.send).not.toHaveBeenCalled();
  });
});
