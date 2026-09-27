import { NgZone } from '@angular/core';
import { PopupBridgeService } from './popup-bridge.service';

describe('PopupBridgeService（オーナー別ポップアウト橋渡し）', () => {
  const make = () => new PopupBridgeService(new NgZone({}));

  it('同じオーナーのチャンネルにだけメッセージを届ける', async () => {
    const a = make();
    const b = make();
    const receivedA: any[] = [];
    const receivedOther: any[] = [];
    b.channel('palette:panel:chr1').onMessage(m => receivedA.push(m));
    b.channel('palette:vn').onMessage(m => receivedOther.push(m));
    a.channel('palette:panel:chr1').post({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(receivedA.length).toBe(1);
    expect(receivedA[0].type).toBe('ready');
    expect(receivedOther.length).toBe(0);
    a.ngOnDestroy();
    b.ngOnDestroy();
  });

  it('自分が投げたものは自分に届かない・購読解除もできる', async () => {
    const a = make();
    const received: any[] = [];
    const off = a.channel('chat:main').onMessage(m => received.push(m));
    a.channel('chat:main').post({ type: 'bye' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(received.length).toBe(0);
    off();
    a.ngOnDestroy();
  });

  it('claimした応答者だけがオーナー権を持ち、後続のclaimが権利を奪う', () => {
    const service = make();
    const first = service.claimServe('palette:vn');
    expect(service.isServing('palette:vn', first)).toBeTrue();
    const second = service.claimServe('palette:vn');
    expect(service.isServing('palette:vn', first)).toBeFalse();
    expect(service.isServing('palette:vn', second)).toBeTrue();
    service.releaseServe('palette:vn', second);
    expect(service.isServing('palette:vn', second)).toBeFalse();
    // 権利喪失後の旧トークンによるreleaseは何も壊さない
    service.releaseServe('palette:vn', first);
    expect(service.isServing('palette:vn', second)).toBeFalse();
    service.ngOnDestroy();
  });

  it('openPopupはオーナーごとに別ウィンドウ名・別URLで開く', () => {
    const service = make();
    const open = spyOn(window, 'open');
    service.openPopup('palette', 'palette:panel:chr1', { width: 540, height: 760 });
    expect(open).toHaveBeenCalledWith(
      jasmine.stringMatching(/[?&]kind=palette/), 'lycoris-pop-palette_panel_chr1', jasmine.any(String));
    const callUrl = open.calls.mostRecent().args[0] as string;
    expect(callUrl).toContain('popup=1');
    expect(callUrl).toContain(encodeURIComponent('palette:panel:chr1'));
    expect(callUrl).not.toContain('theme=vn');
    service.openPopup('vnchat', 'chat:vn', { theme: 'vn' });
    expect(open).toHaveBeenCalledWith(
      jasmine.stringMatching(/[?&]theme=vn/), 'lycoris-pop-chat_vn', jasmine.any(String));
    service.ngOnDestroy();
  });

  it('URLパラメータが無ければサブウィンドウと判定しない', () => {
    const service = make();
    expect(service.isWindow).toBeFalse();
    expect(service.windowChannel()).toBeNull();
    service.ngOnDestroy();
  });
});
