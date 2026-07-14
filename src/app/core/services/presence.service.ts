import { Injectable } from '@angular/core';
import { ApiService } from './api.service';

/**
 * Pings /admin/heartbeat every 8s while the user is logged in, so the
 * Admin Users screen can show accurate online/offline + last-seen.
 *
 * Offline is signalled two ways:
 *  1. Explicit logout -> stopAndMarkOffline() calls /admin/logout with a
 *     normal Authorization header, same as any other API call.
 *  2. Tab/browser closed without logging out -> a pagehide listener uses
 *     navigator.sendBeacon(), sending the token in the body instead of a
 *     header. This matters: sendBeacon can't set custom headers, and an
 *     earlier attempt using fetch(..., {keepalive:true}) with a manual
 *     Authorization header silently failed on unload because it triggers
 *     a CORS preflight (OPTIONS) that browsers don't reliably complete
 *     during page teardown. sendBeacon sends a "simple" request with no
 *     preflight, so it actually survives the tab closing.
 *     If even that doesn't make it out (e.g. OS killed the process), the
 *     15s server-side heartbeat threshold is the final fallback.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private handle: any = null;
  private readonly intervalMs = 8000;
  private pagehideBound = false;

  constructor(private api: ApiService) {}

  start(): void {
    if (this.handle) return; // already running

    this.ping(); // fire immediately so presence updates right after login
    this.handle = setInterval(() => this.ping(), this.intervalMs);

    if (!this.pagehideBound) {
      window.addEventListener('pagehide', this.handlePageHide);
      this.pagehideBound = true;
    }
  }

  /** Stops the interval AND tells the server to mark this user offline right now. */
  stopAndMarkOffline(): void {
    this.stopInterval();
    this.api.post<any>('/admin/logout', {}).subscribe({ error: () => {} });
  }

  private stopInterval(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  private ping(): void {
    this.api.post<any>('/admin/heartbeat', {}).subscribe({
      // Silent by design -- a missed beat just means the user briefly
      // shows offline until the next successful ping; not worth a toast.
      error: () => {}
    });
  }

  /**
   * Arrow function (not a class method) so `this` stays bound when used
   * directly as an event listener reference.
   */
  private handlePageHide = () => {
    if (!this.handle) return; // not running / already logged out

    const token = localStorage.getItem('vm_token');
    if (!token) return;

    // text/plain body keeps this a "simple request" -- no CORS preflight,
    // so it's actually deliverable during page unload. The server reads
    // the token from the body (see Auth::decodeRawToken on /admin/logout).
    const blob = new Blob([JSON.stringify({ token })], { type: 'text/plain' });
    navigator.sendBeacon(`${this.api.BASE}/admin/logout`, blob);
  };
}