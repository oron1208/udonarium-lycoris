import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { EventSystem } from '@udonarium/core/system';

const STORAGE_KEY = 'udonarium-lycoris.gm-mode';

@Injectable({ providedIn: 'root' })
export class GmModeService {
  private readonly gmModeSubject = new BehaviorSubject<boolean>(this.load());
  readonly gmMode$ = this.gmModeSubject.asObservable();

  get isGm(): boolean { return this.gmModeSubject.value; }

  toggle(): boolean {
    return this.setGmMode(!this.isGm);
  }

  setGmMode(isGm: boolean): boolean {
    this.gmModeSubject.next(isGm);
    try {
      localStorage.setItem(STORAGE_KEY, isGm ? '1' : '0');
    } catch (e) {
      console.warn('GM mode localStorage save failed', e);
    }
    // Notify all components (including OnPush) that GM mode changed
    EventSystem.trigger('GM_MODE_CHANGED', { isGm });
    return isGm;
  }

  private load(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }
}
