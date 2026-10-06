import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy } from '@angular/core';
import { ModalService } from 'service/modal.service';

@Component({
  selector: 'memo-edit',
  templateUrl: './memo-edit.component.html',
  styleUrls: ['./memo-edit.component.css']
})
export class MemoEditComponent implements AfterViewInit, OnDestroy {
  memo = '';

  constructor(
    private ngZone: NgZone,
    private modalService: ModalService,
    private elementRef: ElementRef<HTMLElement>,
    private changeDetector: ChangeDetectorRef
  ) { }

  ngAfterViewInit() {
    this.ngZone.run(() => {
      this.memo = this.modalService.option.memo ? this.modalService.option.memo : '';
      this.changeDetector.detectChanges();
    });
    Promise.resolve().then(() => {
      this.modalService.title = this.modalService.option && this.modalService.option.title ? this.modalService.option.title : 'メモ編集';
    });
    Promise.resolve().then(() => {
      const area = this.elementRef.nativeElement.querySelector('textarea');
      if (area) area.focus();
    });
  }

  ngOnDestroy() { }

  save() {
    this.modalService.resolve(this.memo);
  }

  cancel() {
    this.modalService.resolve(null);
  }
}
