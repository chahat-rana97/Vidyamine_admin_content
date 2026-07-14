import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { ApiService } from './api.service';
import { PresenceService } from './presence.service';

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string;
  is_active: number;
  created_at?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private _user = new BehaviorSubject<AdminUser | null>(null);
  user$ = this._user.asObservable();

  constructor(
    private api: ApiService,
    private router: Router,
    private presence: PresenceService
  ) {
    const stored = localStorage.getItem('vm_user');
    if (stored) this._user.next(JSON.parse(stored));

    // If a session already exists (page refresh / app reopened), resume
    // the heartbeat immediately instead of waiting for a fresh login.
    if (this.isLoggedIn) {
      this.presence.start();
    }
  }

  get user(): AdminUser | null { return this._user.value; }
  get isLoggedIn(): boolean { return !!localStorage.getItem('vm_token'); }

  login(identifier: string, password: string): Observable<any> {
    // API expects "identifier" (email or phone), not "email"
    return this.api.post<any>('/admin/login', { identifier, password }).pipe(
      tap(res => {
        if (res?.status) {
          localStorage.setItem('vm_token', res.token);
          localStorage.setItem('vm_user', JSON.stringify(res.admin));
          this._user.next(res.admin);
          this.presence.start();
        }
      })
    );
  }

  logout(): void {
    // Marks offline on the server immediately, then stops the local
    // heartbeat interval -- order matters, since stopAndMarkOffline()
    // needs the token that's about to be removed from localStorage.
    this.presence.stopAndMarkOffline();
    localStorage.removeItem('vm_token');
    localStorage.removeItem('vm_user');
    this._user.next(null);
    this.router.navigate(['/login']);
  }
}