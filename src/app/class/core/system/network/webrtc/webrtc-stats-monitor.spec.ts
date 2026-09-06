import { WebRTCStatsMonitor } from './webrtc-stats-monitor';

describe('Independent WebRTC monitoring', () => {
  const peers: any[] = [];
  afterEach(() => { peers.splice(0).forEach(peer => WebRTCStatsMonitor.remove(peer)); });
  function peer(update: () => Promise<void>): any {
    const p = { open: true, sendPing: jasmine.createSpy('ping'), updateStatsAsync: jasmine.createSpy('stats').and.callFake(update) };
    peers.push(p);
    return p;
  }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  it('a stalled stats call does not stop heartbeats or other peers', async () => {
    const stalled = peer(() => new Promise<void>(() => {}));
    const healthy = peer(() => Promise.resolve());
    WebRTCStatsMonitor.add(stalled);
    WebRTCStatsMonitor.add(healthy);
    await settle();
    (WebRTCStatsMonitor as any).doMonitoringAsync();
    await settle();
    expect(stalled.sendPing).toHaveBeenCalledTimes(2);
    expect(stalled.updateStatsAsync).toHaveBeenCalledTimes(1);
    expect(healthy.updateStatsAsync).toHaveBeenCalledTimes(2);
  });
  it('a stats exception does not prevent the next monitoring cycle', async () => {
    const failing = peer(() => Promise.reject(new Error('stats unavailable')));
    WebRTCStatsMonitor.add(failing);
    await settle();
    (WebRTCStatsMonitor as any).doMonitoringAsync();
    await settle();
    expect(failing.updateStatsAsync).toHaveBeenCalledTimes(2);
    expect(failing.sendPing).toHaveBeenCalledTimes(2);
  });
  it('repeated registration does not cause overlapping stats or ping bursts', async () => {
    const p = peer(() => Promise.resolve());
    WebRTCStatsMonitor.add(p);
    WebRTCStatsMonitor.add(p);
    await settle();
    expect(p.sendPing).toHaveBeenCalledTimes(1);
    expect(p.updateStatsAsync).toHaveBeenCalledTimes(1);
  });
});
