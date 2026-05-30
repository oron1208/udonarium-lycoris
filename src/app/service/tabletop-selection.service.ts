import { Injectable } from '@angular/core';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { TabletopObject } from '@udonarium/tabletop-object';

@Injectable({ providedIn: 'root' })
export class TabletopSelectionService {
  selectedCharacterIds: Set<string> = new Set<string>();

  clear() {
    this.selectedCharacterIds.clear();
  }

  isSelected(identifier: string): boolean {
    return this.selectedCharacterIds.has(identifier);
  }

  getSelectedTabletopObjects(anchor: TabletopObject): TabletopObject[] {
    if (!anchor || !this.isSelected(anchor.identifier) || this.selectedCharacterIds.size < 2) return [];

    const anchorLocationName = anchor.location && anchor.location.name;
    const objects: TabletopObject[] = [];
    for (const identifier of this.selectedCharacterIds) {
      const object = ObjectStore.instance.get<TabletopObject>(identifier);
      if (!object || object === anchor) continue;
      if (!object.location || object.location.name !== anchorLocationName) continue;
      objects.push(object);
    }
    return objects;
  }
}
