import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface Toast { id: number; message: string; type: 'success' | 'error' | 'info'; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  private _toasts = new Subject<Toast>();
  toasts$ = this._toasts.asObservable();
  private counter = 0;

  show(message: string, type: Toast['type'] = 'info') {
    this._toasts.next({ id: ++this.counter, message, type });
  }
  success(msg: string) { this.show(msg, 'success'); }
  error(msg: string) { this.show(msg, 'error'); }
}
