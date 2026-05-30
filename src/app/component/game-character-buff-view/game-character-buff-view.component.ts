import { Component, Input, OnInit } from '@angular/core';

import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';

import { TabletopObject } from '@udonarium/tabletop-object';
import { GameCharacter } from '@udonarium/game-character';
import { DataElement } from '@udonarium/data-element';
import { mergeStatusMarkerDictionary, parseStatusMarkerIds, stringifyStatusMarkerIds, StatusMarkerDefinition } from '@udonarium/status-marker-dictionary';
import { TabletopService } from 'service/tabletop.service';

@Component({
  selector: 'game-character-buff-view',
  templateUrl: './game-character-buff-view.component.html',
  styleUrls: ['./game-character-buff-view.component.css']
})
export class GameCharacterBuffViewComponent implements OnInit {

//  @Input() title: string = '';

  @Input() character: TabletopObject = null;

  newBuffName: string = '新規効果';
  newBuffValue: string = '';
  newBuffRounds: number = 1;

  get markerDictionary(): StatusMarkerDefinition[] { return mergeStatusMarkerDictionary(this.tabletopService.currentTable ? this.tabletopService.currentTable.statusMarkerDictionary : '[]'); }
  get gameCharacter(): GameCharacter { return this.character instanceof GameCharacter ? this.character : null; }

  constructor(
    private panelService: PanelService,
    private modalService: ModalService,
    private tabletopService: TabletopService
  ) { }

  ngOnInit() {
/*
    Promise.resolve().then(() => {
      this.panelService.title = this.title;
      if (this.modalService.option && this.modalService.option.title != null) {
        this.modalService.title = this.modalService.option.title ? this.modalService.option.title : '';
        this.text = this.modalService.option.text ? this.modalService.option.text : '';
      }
    });
*/
  }

  addBuff() {
    if (!this.gameCharacter || !this.gameCharacter.buffDataElement) return;
    const root = this.findOrCreateBuffRoot();
    const name = (this.newBuffName || '').trim() || '新規効果';
    const rounds = Number.isFinite(Number(this.newBuffRounds)) ? Number(this.newBuffRounds) : 1;
    const buff = DataElement.create(name, rounds, { type: 'numberResource', currentValue: this.newBuffValue || '' });
    root.appendChild(buff);
    this.gameCharacter.update();
  }

  hasMarker(markerId: string): boolean {
    return !!this.gameCharacter && parseStatusMarkerIds(this.gameCharacter.statusMarkerIds).includes(markerId);
  }

  toggleMarker(markerId: string) {
    if (!this.gameCharacter) return;
    const markers = parseStatusMarkerIds(this.gameCharacter.statusMarkerIds);
    const index = markers.indexOf(markerId);
    if (0 <= index) {
      markers.splice(index, 1);
    } else {
      markers.push(markerId);
    }
    this.gameCharacter.statusMarkerIds = stringifyStatusMarkerIds(markers);
  }

  stopButtonEvent(event?: Event) {
    if (!event) return;
    event.preventDefault();
    event.stopPropagation();
  }

  private findOrCreateBuffRoot(): DataElement {
    let root = this.gameCharacter.buffDataElement.getFirstElementByName('バフ/デバフ');
    if (!root) {
      root = DataElement.create('バフ/デバフ', '');
      this.gameCharacter.buffDataElement.appendChild(root);
    }
    return root;
  }

}
