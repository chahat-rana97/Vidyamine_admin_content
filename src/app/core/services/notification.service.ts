import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { ApiService } from './api.service';

export interface AppNotification {
  id: number;
  message: string;
  chapter_id?: number | null;
  is_read: number | boolean;
  created_at: string;
  [key: string]: any;
}

/**
 * Centralised notification state shared across the whole app (topbar bell,
 * dashboard notif card, anywhere else that needs it). Polls the backend,
 * tracks unread state, plays a sound + emits an instant popup event whenever
 * a genuinely new notification shows up (not on the very first load).
 *
 * Only one poll loop runs no matter how many components inject this service,
 * since it's providedIn: 'root'.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService implements OnDestroy {
  private readonly POLL_MS = 30000;

  /** Served from src/public/sounds/notification.mp3 (Angular's `public` folder
   *  is copied to the app's root at build time, so this resolves to
   *  https://yourapp.com/sounds/notification.mp3 in the browser). */
  private readonly SOUND_URL = 'sounds/notification.mp3';

  notifications: AppNotification[] = [];
  loading = false;
  markingAllRead = false;

  /** Emits each newly-arrived notification (post first-load) so any component
   *  can show an instant popup / toast the moment it comes in. */
  readonly newNotification$ = new Subject<AppNotification>();

  private pollHandle: any = null;
  private knownIds = new Set<number>();
  private hasLoadedOnce = false;
  private subscriberCount = 0;

  /** Reused across plays instead of `new Audio()` each time, so rapid-fire
   *  notifications don't pile up separate audio elements. */
  private audioEl: HTMLAudioElement | null = null;

  constructor(private api: ApiService) {}

  get unread(): AppNotification[] {
    return this.notifications.filter(n => !n.is_read);
  }

  get unreadCount(): number {
    return this.unread.length;
  }

  /** Call from any component's ngOnInit. Starts the poll loop on first
   *  subscriber and loads immediately; safe to call from multiple
   *  components — the loop is shared. Pair with release() in ngOnDestroy. */
  start() {
    this.subscriberCount++;
    this.load();
    if (!this.pollHandle) {
      this.pollHandle = setInterval(() => this.load(), this.POLL_MS);
    }
  }

  /** Call from ngOnDestroy. Only stops polling once nothing is listening. */
  release() {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    if (this.subscriberCount === 0 && this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  load() {
    this.loading = true;
    this.api.get<any>('/notifications').subscribe({
      next: (r: any) => {
        const list: AppNotification[] = Array.isArray(r?.data) ? r.data : [];

        if (this.hasLoadedOnce) {
          const freshUnread = list.filter(n => !n.is_read && !this.knownIds.has(Number(n.id)));
          if (freshUnread.length) {
            this.playSound();
            // Emit the most recent new one(s) so subscribers can pop a toast.
            freshUnread.forEach(n => this.newNotification$.next(n));
          }
        }

        this.knownIds = new Set(list.map(n => Number(n.id)));
        this.hasLoadedOnce = true;
        this.notifications = list;
        this.loading = false;
      },
      error: () => { this.loading = false; }
    });
  }

  markRead(n: AppNotification) {
    if (n.is_read) return;
    this.api.put<any>(`/notifications/${n.id}/read`, {}).subscribe({
      next: (r: any) => { if (r?.status) n.is_read = 1; },
      error: () => {}
    });
  }

  markAllRead() {
    if (!this.unreadCount) return;
    this.markingAllRead = true;
    this.api.put<any>('/notifications/read-all', {}).subscribe({
      next: (r: any) => {
        this.markingAllRead = false;
        if (r?.status) this.notifications.forEach(n => n.is_read = 1);
      },
      error: () => { this.markingAllRead = false; }
    });
  }

  timeAgo(dateStr: string | null): string {
    if (!dateStr) return '';
    const then = new Date(dateStr.replace(' ', 'T')).getTime();
    const diffMs = Date.now() - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  /** Plays public/sounds/notification.mp3. Falls back silently if the
   *  browser blocks autoplay (e.g. no user interaction yet on the page) —
   *  same "best effort, never throw" spirit as the old tone generator. */
  private playSound() {
    try {
      if (!this.audioEl) {
        this.audioEl = new Audio(this.SOUND_URL);
        this.audioEl.volume = 0.6;
      }
      // Restart from the beginning in case the previous play is still
      // finishing (e.g. two notifications arrive close together).
      this.audioEl.currentTime = 0;
      this.audioEl.play().catch(() => {
        // Autoplay-blocked or file missing — ignore, same as before.
      });
    } catch {
      // Audio not available — ignore.
    }
  }

  ngOnDestroy() {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }
}