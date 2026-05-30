import { Injectable } from '@angular/core';
import { TabletopObject, TabletopLocation } from '@udonarium/tabletop-object';

interface TabletopMoveSnapshot {
  location: TabletopLocation;
  posZ: number;
}

interface TabletopMoveHistory {
  type: 'move';
  object: TabletopObject;
  from: TabletopMoveSnapshot;
  to: TabletopMoveSnapshot;
}

interface TabletopMoveGroupHistory {
  type: 'moveGroup';
  moves: TabletopMoveHistory[];
}

interface TabletopCreateHistory {
  type: 'create';
  objects: TabletopObject[];
}

type TabletopUndoHistory = TabletopMoveHistory | TabletopMoveGroupHistory | TabletopCreateHistory;

@Injectable({ providedIn: 'root' })
export class TabletopUndoService {
  private readonly maxHistory = 50;
  private moveStarts: { [identifier: string]: TabletopMoveSnapshot } = {};
  private histories: TabletopUndoHistory[] = [];

  beginMove(object: TabletopObject) {
    if (!object) return;
    this.moveStarts[object.identifier] = this.snapshot(object);
  }

  endMove(object: TabletopObject, x: number, y: number, posZ: number) {
    if (!object) return;
    const from = this.moveStarts[object.identifier];
    delete this.moveStarts[object.identifier];
    if (!from) return;

    this.pushMoveHistory(object, from, {
      location: { name: object.location.name, x: x, y: y },
      posZ: posZ
    });
  }

  beginMoveGroup(objects: TabletopObject[]) {
    for (const object of objects || []) this.beginMove(object);
  }

  endMoveGroup(objects: TabletopObject[]) {
    const moves: TabletopMoveHistory[] = [];
    for (const object of objects || []) {
      if (!object) continue;
      const from = this.moveStarts[object.identifier];
      delete this.moveStarts[object.identifier];
      if (!from) continue;
      const to = this.snapshot(object);
      if (this.isSameSnapshot(from, to)) continue;
      moves.push({ type: 'move', object, from, to });
    }
    if (moves.length < 1) return;
    this.histories.push({ type: 'moveGroup', moves });
    this.trimHistory();
  }

  moveToLocation(object: TabletopObject, location: string) {
    if (!object) return;
    const from = this.snapshot(object);
    object.setLocation(location);
    this.pushMoveHistory(object, from, this.snapshot(object));
  }

  recordCreate(objects: TabletopObject[]) {
    const createdObjects = (objects || []).filter(object => !!object);
    if (createdObjects.length < 1) return;
    this.histories.push({ type: 'create', objects: createdObjects });
    this.trimHistory();
  }

  undoLastMove(): boolean {
    const history = this.histories.pop();
    if (!history) return false;

    if (history.type === 'create') {
      for (const object of history.objects.slice().reverse()) {
        if (object) object.destroy();
      }
      return true;
    }

    if (history.type === 'moveGroup') {
      for (const move of history.moves.slice().reverse()) this.applyMoveSnapshot(move.object, move.from);
      return true;
    }

    if (!history.object) return false;
    this.applyMoveSnapshot(history.object, history.from);
    return true;
  }

  private pushMoveHistory(object: TabletopObject, from: TabletopMoveSnapshot, to: TabletopMoveSnapshot) {
    if (this.isSameSnapshot(from, to)) return;
    this.histories.push({ type: 'move', object, from, to });
    this.trimHistory();
  }

  private applyMoveSnapshot(object: TabletopObject, snapshot: TabletopMoveSnapshot) {
    if (!object) return;
    object.location = {
      name: snapshot.location.name,
      x: snapshot.location.x,
      y: snapshot.location.y
    };
    object.posZ = snapshot.posZ;
    object.update();
  }

  private trimHistory() {
    while (this.maxHistory < this.histories.length) this.histories.shift();
  }

  private snapshot(object: TabletopObject): TabletopMoveSnapshot {
    return {
      location: {
        name: object.location.name,
        x: object.location.x,
        y: object.location.y
      },
      posZ: object.posZ
    };
  }

  private isSameSnapshot(a: TabletopMoveSnapshot, b: TabletopMoveSnapshot): boolean {
    return a.location.name === b.location.name
      && a.location.x === b.location.x
      && a.location.y === b.location.y
      && a.posZ === b.posZ;
  }
}
