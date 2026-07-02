import { Component, Input, OnInit } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { ModalService } from 'service/modal.service';
import { PanelService } from 'service/panel.service';

@Component({
  selector: 'text-view',
  templateUrl: './text-view.component.html',
  styleUrls: ['./text-view.component.css']
})
export class TextViewComponent implements OnInit {

  @Input() text: string = '';
  @Input() title: string = '';
  renderedText: SafeHtml = '';

  constructor(
    private panelService: PanelService,
    private modalService: ModalService,
    private sanitizer: DomSanitizer
  ) { }

  ngOnInit() {
    Promise.resolve().then(() => {
      this.panelService.title = this.title;
      if (this.modalService.option && this.modalService.option.title != null) {
        this.modalService.title = this.modalService.option.title ? this.modalService.option.title : '';
        this.text = this.modalService.option.text ? this.modalService.option.text : '';
      }
      this.updateRenderedText();
    });
  }

  private updateRenderedText() {
    // Escape HTML then autolink URLs
    let escaped = this.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    escaped = escaped.replace(
      /(https?:\/\/[^\s]+)/g,
      '<a href="$1" target="_blank" style="color:#5dade2;">$1</a>'
    );
    this.renderedText = this.sanitizer.bypassSecurityTrustHtml(escaped);
  }

  close() {
    this.modalService.resolve(true);
  }

}
