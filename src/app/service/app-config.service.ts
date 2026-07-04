import { Injectable } from '@angular/core';
import { Logger } from '../class/core/system/util/logger';

import { EventSystem } from '@udonarium/core/system';

import * as yaml from 'js-yaml';

export interface AppConfig {
  backend?: {
    mode?: string,
    url?: string
  },
  webrtc: {
    key: string,
    signalingUrl?: string,
    config?: {
      iceServers?: RTCIceServer[],
      certificates?: string
    }
  },
  app: {
    title: string,
    mode: string
  }
}

const objectPropertyKeys = Object.getOwnPropertyNames(Object.prototype);
const arrayPropertyKeys = Object.getOwnPropertyNames(Array.prototype);

@Injectable()
export class AppConfigService {

  constructor() { }

  peerHistory: string[] = [];
  isOpen: boolean = false;

  static appConfig: AppConfig = {
    backend: {
      mode: 'skyway2023',
      url: ''
    },
    webrtc: {
      key: ''
    },
    app: {
      title: '',
      mode: ''
    }
  }

  initialize() {
    this.initAppConfig();
  }

  private async initAppConfig() {
    try {
      Logger.debug('YAML読み込み...');
      let config = await this.loadYaml();
      let obj = yaml.load(config);
      AppConfigService.applyConfig(obj);
    } catch (e) {
      Logger.warn(e);
    }
    EventSystem.trigger('LOAD_CONFIG', AppConfigService.appConfig);
  }

  private async loadYaml(): Promise<string> {
    let config = document.querySelector('script[type$="yaml"]');
    if (!config) {
      Logger.warn('loadYaml element not found.');
      return '';
    }

    let url = config.getAttribute('src');

    if (url == null) {
      Logger.warn('loadYaml url undefined.');
      return config.textContent;
    }

    let response = await fetch(url);
    return response.text();
  }

  private static applyConfig(config: Object, root: Object = AppConfigService.appConfig): Object {
    if (config == null) return root;
    let keys = Object.getOwnPropertyNames(config);
    for (let key of keys) {
      let invalidPropertyKeys = Array.isArray(config) || Array.isArray(root) ? objectPropertyKeys.concat(arrayPropertyKeys) : objectPropertyKeys;
      if (invalidPropertyKeys.includes(key)) {
        Logger.debug(`skip invalid key (${key})`);
        continue;
      } else if (config[key] != null && typeof config[key] === 'object') {
        if (root[key] == null) root[key] = Array.isArray(config[key]) ? [] : {};
        AppConfigService.applyConfig(config[key], root[key]);
      } else if (typeof config[key] !== 'function' && typeof root[key] !== 'function') {
        root[key] = config[key];
      }
    }
    return root;
  }
}
