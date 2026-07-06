import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Toast, ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container">
      <div *ngFor="let t of toasts" class="toast toast-{{t.type}}">
        <span>{{ t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ' }}</span>
        {{ t.message }}
      </div>
    </div>
  `
})
export class ToastComponent implements OnInit {
  toasts: Toast[] = [];

  constructor(private svc: ToastService) {}

  ngOnInit() {
    this.svc.toasts$.subscribe(t => {
      this.toasts.push(t);
      setTimeout(() => this.toasts = this.toasts.filter(x => x.id !== t.id), 3500);
    });
  }
}
