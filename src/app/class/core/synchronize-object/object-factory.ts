import { GameObject } from './game-object';
import { Logger } from '../system/util/logger';

export declare var Type: FunctionConstructor;
export interface Type<T> extends Function {
  new(...args: any[]): T;
}

export class ObjectFactory {
  private static _instance: ObjectFactory
  static get instance(): ObjectFactory {
    if (!ObjectFactory._instance) ObjectFactory._instance = new ObjectFactory();
    return ObjectFactory._instance;
  }

  private constructorMap: Map<string, Type<GameObject>> = new Map();
  private aliasMap: Map<Type<GameObject>, string> = new Map();

  private constructor() { Logger.debug('ObjectFactory ready...'); };

  register<T extends GameObject>(constructor: Type<T>, alias?: string) {
    if (!alias) alias = constructor.name ?? (constructor.toString().match(/function\s*([^(]*)\(/)?.[1] ?? '');
    if (this.constructorMap.has(alias)) {
      Logger.error('その alias<' + alias + '> はすでに割り当て済みじゃねー？');
      return;
    }
    if (this.aliasMap.has(constructor)) {
      Logger.error('その constructor はすでに登録済みじゃねー？', constructor);
      return;
    }
    Logger.debug('addGameObjectFactory -> ' + alias);
    this.constructorMap.set(alias, constructor);
    this.aliasMap.set(constructor, alias);
  }

  create<T extends GameObject>(alias: string, identifer?: string): T | null {
    let classConstructor = this.constructorMap.get(alias);
    if (!classConstructor) {
      Logger.error(alias + 'という名のＧameObjectクラスは定義されていません');
      return null;
    }
    let gameObject: GameObject = new classConstructor(identifer);
    return <T>gameObject;
  }

  getAlias<T extends GameObject>(constructor: Type<T>): string {
    return this.aliasMap.get(constructor) ?? '';
  }
}
