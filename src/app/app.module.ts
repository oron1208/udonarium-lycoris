import { PaletteBrowserComponent } from 'component/palette-browser/palette-browser.component';
import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { BadgeComponent } from 'component/badge/badge.component';
import { CardStackListComponent } from 'component/card-stack-list/card-stack-list.component';
import { CardStackListComponentEx } from 'component/card-stack-list-ex/card-stack-list-ex.component';
import { CardStackListImageComponent } from 'component/card-stack-list-img/card-stack-list-img.component';

import { CardStackComponent } from 'component/card-stack/card-stack.component';
import { CardComponent } from 'component/card/card.component';
import { ChatInputComponent } from 'component/chat-input/chat-input.component';
import { ChatMessageComponent } from 'component/chat-message/chat-message.component';
import { ChatPaletteComponent } from 'component/chat-palette/chat-palette.component';
import { ChatTabSettingComponent } from 'component/chat-tab-setting/chat-tab-setting.component';
import { ChatTabComponent } from 'component/chat-tab/chat-tab.component';
import { ChatWindowComponent } from 'component/chat-window/chat-window.component';

import { ChatTachieComponent } from 'component/chat-tachie/chat-tachie.component';
import { ChatTachieImageComponent } from 'component/chat-tachie-img/chat-tachie-img.component';
import { ChatColorSettingComponent } from 'component/chat-color-setting/chat-color-setting.component';
import { ChatMessageSettingComponent } from 'component/chat-message-setting/chat-message-setting.component';

import { ContextMenuComponent } from 'component/context-menu/context-menu.component';
import { DiceSymbolComponent } from 'component/dice-symbol/dice-symbol.component';
import { FileSelecterComponent } from 'component/file-selecter/file-selecter.component';
import { FileStorageComponent } from 'component/file-storage/file-storage.component';
import { GameCharacterGeneratorComponent } from 'component/game-character-generator/game-character-generator.component';
import { GameCharacterSheetComponent } from 'component/game-character-sheet/game-character-sheet.component';
import { GameCharacterComponent } from 'component/game-character/game-character.component';
import { CharacterGroupComponent } from 'component/character-group/character-group.component';
import { CharacterGroupPartsPanelComponent } from 'component/character-group-parts/character-group-parts.component';
import { GameCharacterGroup } from '@udonarium/game-character-group';
import { GameDataElementComponent } from 'component/game-data-element/game-data-element.component';

import { GameDataElementBuffComponent } from 'component/game-data-element-buff/game-data-element-buff.component';

import { GameObjectInventoryComponent } from 'component/game-object-inventory/game-object-inventory.component';
import { GameTableMaskComponent } from 'component/game-table-mask/game-table-mask.component';
import { GameTableSettingComponent } from 'component/game-table-setting/game-table-setting.component';
import { GameTableComponent } from 'component/game-table/game-table.component';
import { JukeboxComponent } from 'component/jukebox/jukebox.component';
import { LobbyComponent } from 'component/lobby/lobby.component';
import { LinkyModule } from 'ngx-linky';
import { ModalComponent } from 'component/modal/modal.component';
import { NetworkIndicatorComponent } from 'component/network-indicator/network-indicator.component';
import { ServerStatusComponent } from 'component/server-status/server-status.component';
import { NgSelectModule } from '@ng-select/ng-select';
import { OverviewPanelComponent } from 'component/overview-panel/overview-panel.component';
import { PasswordCheckComponent } from 'component/password-check/password-check.component';
import { PeerCursorComponent } from 'component/peer-cursor/peer-cursor.component';
import { PeerMenuComponent } from 'component/peer-menu/peer-menu.component';
import { ReConnectComponent } from 'component/re-connect/re-connect.component';
import { RoomSettingComponent } from 'component/room-setting/room-setting.component';

import { RangeComponent } from 'component/range/range.component';
import { RangeDockingCharacterComponent } from 'component/range-docking-character/range-docking-character.component';

import { TerrainComponent } from 'component/terrain/terrain.component';
import { TextNoteComponent } from 'component/text-note/text-note.component';
import { TextViewComponent } from 'component/text-view/text-view.component';
import { UIPanelComponent } from 'component/ui-panel/ui-panel.component';
import { DraggableDirective } from 'directive/draggable.directive';
import { MovableDirective } from 'directive/movable.directive';
import { ResizableDirective } from 'directive/resizable.directive';
import { RotableDirective } from 'directive/rotable.directive';
import { TooltipDirective } from 'directive/tooltip.directive';
import { SafePipe } from 'pipe/safe.pipe';

import { RemoteControllerComponent } from 'component/remote-controller/remote-controller.component';
import { ControllerInputComponent } from 'component/controller-input/controller-input.component';
import { GameCharacterBuffViewComponent } from 'component/game-character-buff-view/game-character-buff-view.component';

import { OpenUrlComponent } from 'component/open-url/open-url.component';

import { YouTubePlayerModule } from '@angular/youtube-player';

import { CutInListComponent } from 'component/cut-in-list/cut-in-list.component';
import { CutInBgmComponent } from 'component/cut-in-bgm/cut-in-bgm.component';

import { CutInWindowComponent } from 'component/cut-in-window/cut-in-window.component';
import { DiceTableSettingComponent } from 'component/dice-table-setting/dice-table-setting.component';

import { VoteMenuComponent } from 'component/vote-menu/vote-menu.component';
import { VoteWindowComponent } from 'component/vote-window/vote-window.component';
import { VnStageComponent } from 'component/vn-stage/vn-stage.component';
import { LightingLayerComponent } from 'component/lighting-layer/lighting-layer.component';
import { LightingPanelComponent } from 'component/lighting-panel/lighting-panel.component';
import { DiceCutinComponent } from 'component/dice-cutin/dice-cutin.component';
import { ContestedRollCutinComponent } from 'component/contested-roll-cutin/contested-roll-cutin.component';
import { OptionsPanelComponent } from 'component/options-panel/options-panel.component';
import { InitiativeTrackerComponent } from 'component/initiative-tracker/initiative-tracker.component';
import { InitiativePanelComponent } from 'component/initiative-panel/initiative-panel.component';
import { InitiativeDiceRollerComponent } from 'component/initiative-dice-roller/initiative-dice-roller.component';
import { BatchDiceRollerComponent } from 'component/batch-dice-roller/batch-dice-roller.component';
import { BatchDamagePanelComponent } from 'component/batch-damage-panel/batch-damage-panel.component';

import { AlarmMenuComponent } from 'component/alarm-menu/alarm-menu.component';
import { AlarmWindowComponent } from 'component/alarm-window/alarm-window.component';
import { ChatMessageFixComponent } from 'component/chat-message-fix/chat-message-fix.component';
import { MacroHotbarComponent } from 'component/macro-hotbar/macro-hotbar.component';
import { DataImportMenuComponent } from 'component/data-import-menu/data-import-menu.component';
import { EffectManagerComponent } from 'component/effect-manager/effect-manager.component';

import { ImportCharacterImgComponent } from 'component/import-character-img/import-character-img.component';

import { AppConfigService } from 'service/app-config.service';
import { ChatMessageService } from 'service/chat-message.service';
import { ContextMenuService } from 'service/context-menu.service';
import { GameObjectInventoryService } from 'service/game-object-inventory.service';
import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';
import { PointerDeviceService } from 'service/pointer-device.service';
import { TabletopService } from 'service/tabletop.service';

import { AppComponent } from './app.component';

@NgModule({
  declarations: [
    AppComponent,
    BadgeComponent,
    CardComponent,
    CardStackComponent,
    CardStackListComponent,
    CardStackListComponentEx,
//    CardStackListImageComponent,
    ChatMessageComponent,
    ChatPaletteComponent,
    ChatTabComponent,
    ChatTabSettingComponent,
    ChatWindowComponent,

    ChatTachieComponent,
    ChatTachieImageComponent,
    ChatColorSettingComponent,
    ChatMessageSettingComponent,

    ContextMenuComponent,

    RemoteControllerComponent,
    ControllerInputComponent,
    GameCharacterBuffViewComponent,

    FileSelecterComponent,
    FileStorageComponent,
    GameCharacterGeneratorComponent,
    GameCharacterSheetComponent,
    GameCharacterComponent,
    CharacterGroupComponent,
    CharacterGroupPartsPanelComponent,
    GameDataElementComponent,

    GameDataElementBuffComponent,

    GameObjectInventoryComponent,
    GameTableMaskComponent,
    GameTableSettingComponent,
    GameTableComponent,
    JukeboxComponent,

    OpenUrlComponent,

    CutInListComponent,
    CutInBgmComponent,
    CutInWindowComponent,
    DiceTableSettingComponent,

    VoteMenuComponent,
    VoteWindowComponent,
    VnStageComponent,
    PaletteBrowserComponent,
    LightingLayerComponent,
    LightingPanelComponent,
    DiceCutinComponent,
    ContestedRollCutinComponent,
    OptionsPanelComponent,
    InitiativeTrackerComponent,
    InitiativePanelComponent,
    InitiativeDiceRollerComponent,
    BatchDiceRollerComponent,
    BatchDamagePanelComponent,

    AlarmMenuComponent,
    AlarmWindowComponent,

    ChatMessageFixComponent,
    MacroHotbarComponent,
    DataImportMenuComponent,
    EffectManagerComponent,

    ImportCharacterImgComponent,

    LobbyComponent,
    ReConnectComponent,
    ModalComponent,
    OverviewPanelComponent,
    PasswordCheckComponent,
    PeerMenuComponent,
    RoomSettingComponent,
    UIPanelComponent,
    SafePipe,
    ChatPaletteComponent,
    TextViewComponent,
    RangeComponent,
    RangeDockingCharacterComponent,
    TerrainComponent,
    PeerCursorComponent,
    TextNoteComponent,
    MovableDirective,
    RotableDirective,
    NetworkIndicatorComponent,
    ServerStatusComponent,
    DiceSymbolComponent,
    TooltipDirective,
    DraggableDirective,
    ResizableDirective,
    ChatInputComponent
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    CommonModule,
    FormsModule,
    LinkyModule,
    YouTubePlayerModule,
    NgSelectModule
  ],
  providers: [
    AppConfigService,
    ChatMessageService,
    ContextMenuService,
    ModalService,
    GameObjectInventoryService,
    PanelService,
    PointerDeviceService,
    TabletopService
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
