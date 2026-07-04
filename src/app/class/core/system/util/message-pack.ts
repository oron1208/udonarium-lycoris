import * as msgpacklite from 'msgpack-lite';
import { Logger } from './logger';

export namespace MessagePack {
  export function encode(object: unknown): Uint8Array {
    try {
      return msgpacklite.encode(object);
    } catch (error) {
      Logger.error(error, object);
    }
    return null;
  }

  export function decode(buffer: Uint8Array): unknown {
    try {
      return msgpacklite.decode(buffer);
    } catch (error) {
      Logger.error(error, buffer);
    }
    return null;
  }
}
