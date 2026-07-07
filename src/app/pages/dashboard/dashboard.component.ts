import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { RouterLink, Router } from '@angular/router';

interface StatCard {
  label: string;
  value: number | string;
  sub: string;
  route: string;
  accent: string;
  trend?: number; // % change vs previous period, undefined if not applicable
  icon: string;
}

interface FunnelStage {
  label: string;
  value: number;
  color: string;
  route: string;
}

interface DonutSlice {
  label: string;
  value: number;
  color: string;
  pct: number;
  dashOffset: number;
  dashLength: number;
}

interface RankedRow {
  rank: number;
  label: string;
  sub?: string;
  value: number;
  pct: number;
  color: string;
}

interface ComparisonRow {
  label: string;
  a: number; // current period
  b: number; // previous period
  aPct: number;
  bPct: number;
}

interface ActivityItem {
  who: string;
  action: string;
  what: string;
  when: string | null;
  kind: 'book' | 'chapter' | 'topic' | 'user';
}

interface TrendPoint {
  label: string;
  books: number;
  chapters: number;
  topics: number;
}

type ActivityFilter = 'all' | 'book' | 'chapter' | 'topic' | 'user';
type TrendRange = '6m' | '12m';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent implements OnInit, OnDestroy {
  loading = true;
  loadError = false;
  today = new Date();

  // ---- raw datasets ----
  users: any[] = [];
  boards: any[] = [];
  classes: any[] = [];
  subjects: any[] = [];
  publishers: any[] = [];
  books: any[] = [];
  chapters: any[] = [];
  topics: any[] = [];

  // ---- derived view models ----
  stats: StatCard[] = [];
  funnel: FunnelStage[] = [];
  roleDonut: DonutSlice[] = [];
  boardBars: RankedRow[] = [];
  publisherBars: RankedRow[] = [];
  topBoardsByChapters: RankedRow[] = [];
  boardVsPublisherComparison: ComparisonRow[] = [];

  verificationPct = 0;
  verificationVerified = 0;
  verificationTotal = 0;
  screenshotCoveragePct = 0;
  audioEligiblePct = 0;
  activeBooksPct = 0;

  recentUsers: any[] = [];

  activityFeedAll: ActivityItem[] = [];
  activityFilter: ActivityFilter = 'all';
  activityCounts: Record<ActivityFilter, number> = { all: 0, book: 0, chapter: 0, topic: 0, user: 0 };

  // ---- trend chart ----
  trendRange: TrendRange = '6m';
  trendPoints: TrendPoint[] = [];
  trendMaxValue = 1;
  trendTotals = { books: 0, chapters: 0, topics: 0 };
  trendGrowthPct = { books: 0, chapters: 0, topics: 0 };

  // ---- this-month vs last-month snapshot ----
  monthComparison: { label: string; thisMonth: number; lastMonth: number; deltaPct: number }[] = [];

  // ---- notifications (topic assignments etc.) ----
  notifications: any[] = [];
  loadingNotifications = false;
  markingAllRead = false;

  constructor(private api: ApiService, public auth: AuthService, private router: Router) {}

  ngOnInit() {
    this.loadNotifications();
    Promise.all([
      this.api.get<any>('/admin/users').toPromise().catch(() => null),
      this.api.get<any>('/boards').toPromise().catch(() => null),
      this.api.get<any>('/classes').toPromise().catch(() => null),
      this.api.get<any>('/subjects').toPromise().catch(() => null),
      this.api.get<any>('/publishers').toPromise().catch(() => null),
      this.api.get<any>('/books').toPromise().catch(() => null),
      this.api.get<any>('/chapters').toPromise().catch(() => null),
      this.api.get<any>('/topics').toPromise().catch(() => null),
    ]).then(([usersRes, boardsRes, classesRes, subjectsRes, publishersRes, booksRes, chaptersRes, topicsRes]) => {
      this.users      = usersRes?.data      || [];
      this.boards     = boardsRes?.data     || [];
      this.classes    = classesRes?.data    || [];
      this.subjects   = subjectsRes?.data   || [];
      this.publishers = publishersRes?.data || [];
      this.books      = booksRes?.data      || [];
      this.chapters   = chaptersRes?.data   || [];
      this.topics     = topicsRes?.data     || [];

      this.buildStatCards();
      this.buildFunnel();
      this.buildRoleDonut();
      this.buildBoardBars();
      this.buildPublisherBars();
      this.buildVerification();
      this.buildCoverage();
      this.buildActivityFeed();
      this.buildTrend();
      this.buildBoardVsPublisherComparison();
      this.buildMonthComparison();

      this.recentUsers = [...this.users]
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
        .slice(0, 5);

      this.loading = false;
    }).catch(() => {
      this.loading = false;
      this.loadError = true;
    });
  }

  // API values can come back as numbers or numeric strings depending on the
  // driver/row source (PDO, JSON re-serialisation, etc). Always compare IDs
  // as strings so "6" and 6 are treated as the same board/publisher/etc.
  private sameId(a: any, b: any): boolean {
    if (a === null || a === undefined || b === null || b === undefined) return false;
    return String(a) === String(b);
  }

  private buildStatCards() {
    const activeBooks = this.books.filter(b => this.truthy(b.is_active)).length;
    const boardsWithBooks = this.boards.filter(bd => this.books.some(b => this.sameId(b.board_id, bd.id))).length;

    this.stats = [
      { label: 'Admin Users', value: this.users.length, sub: `${this.countByRole('superadmin')} superadmin`, route: '/admin-users', accent: 'indigo', icon: 'users', trend: this.growthTrend(this.users) },
      { label: 'Boards', value: this.boards.length, sub: `${boardsWithBooks} with books`, route: '/boards', accent: 'green', icon: 'layers' },
      { label: 'Books', value: this.books.length, sub: `${activeBooks} active`, route: '/books', accent: 'amber', icon: 'book', trend: this.growthTrend(this.books) },
      { label: 'Chapters', value: this.chapters.length, sub: `${this.chaptersVerifiedCount()} verified`, route: '/chapters', accent: 'teal', icon: 'list', trend: this.growthTrend(this.chapters) },
      { label: 'Topics', value: this.topics.length, sub: `${this.totalScreenshots()} screenshots`, route: '/topics', accent: 'violet', icon: 'grid', trend: this.growthTrend(this.topics) },
      { label: 'Publishers', value: this.publishers.length, sub: `${this.subjects.length} subjects`, route: '/publishers', accent: 'pink', icon: 'building' },
    ];
  }

  /** % change in items created this month vs last month, for the given dataset. Undefined-safe: returns 0 if no created_at data. */
  private growthTrend(rows: any[]): number {
    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthKey = `${prevDate.getFullYear()}-${prevDate.getMonth()}`;

    let thisCount = 0, prevCount = 0;
    for (const r of rows) {
      if (!r.created_at) continue;
      const d = new Date(String(r.created_at).replace(' ', 'T'));
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key === thisMonthKey) thisCount++;
      else if (key === prevMonthKey) prevCount++;
    }
    if (prevCount === 0) return thisCount > 0 ? 100 : 0;
    return Math.round(((thisCount - prevCount) / prevCount) * 100);
  }

  private buildFunnel() {
    this.funnel = [
      { label: 'Boards', value: this.boards.length, color: '#22c55e', route: '/boards' },
      { label: 'Books', value: this.books.length, color: '#f59e0b', route: '/books' },
      { label: 'Chapters', value: this.chapters.length, color: '#14b8a6', route: '/chapters' },
      { label: 'Topics', value: this.topics.length, color: '#a855f7', route: '/topics' },
      { label: 'Screenshots', value: this.totalScreenshots(), color: '#6366f1', route: '/topics' },
    ];
  }

  private buildRoleDonut() {
    const roles: { key: string; label: string; color: string }[] = [
      { key: 'superadmin', label: 'Superadmin', color: '#6366f1' },
      { key: 'admin', label: 'Admin', color: '#14b8a6' },
      { key: 'editor', label: 'Editor', color: '#f59e0b' },
    ];
    const total = this.users.length || 1;
    let offset = 0;

    this.roleDonut = roles.map(r => {
      const count = this.users.filter(u => u.role === r.key).length;
      const pct = (count / total) * 100;
      const slice: DonutSlice = {
        label: r.label,
        value: count,
        color: r.color,
        pct: Math.round(pct),
        dashOffset: -offset,
        dashLength: pct,
      };
      offset += pct;
      return slice;
    }).filter(s => s.value > 0);

    if (this.roleDonut.length === 0) {
      this.roleDonut = [{ label: 'No users', value: 0, color: '#334155', pct: 100, dashOffset: 0, dashLength: 100 }];
    }
  }

  private buildBoardBars() {
    const palette = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#a855f7', '#22c55e', '#38bdf8', '#f43f5e'];

    const counts = this.boards.map((bd, i) => ({
      label: bd.name || bd.board_name || bd.code || `Board ${bd.id}`,
      value: this.books.filter(b => this.sameId(b.board_id, bd.id)).length,
      color: palette[i % palette.length],
    }));

    const max = Math.max(1, ...counts.map(c => c.value));

    this.boardBars = counts
      .filter(c => c.value > 0)
      .map((row, i) => ({ rank: i + 1, ...row, pct: Math.round((row.value / max) * 100) }))
      .sort((a, b) => b.value - a.value)
      .map((row, i) => ({ ...row, rank: i + 1 }))
      .slice(0, 8);

    const chCounts = this.boards.map((bd, i) => {
      const bookIds = this.books.filter(b => this.sameId(b.board_id, bd.id)).map(b => b.id);
      const value = this.chapters.filter(c => bookIds.some(id => this.sameId(c.book_id, id))).length;
      return { label: bd.name || bd.board_name || bd.code || `Board ${bd.id}`, value, color: palette[i % palette.length] };
    });
    const maxCh = Math.max(1, ...chCounts.map(c => c.value));
    this.topBoardsByChapters = chCounts
      .map((row, i) => ({ rank: i + 1, ...row, pct: Math.round((row.value / maxCh) * 100) }))
      .sort((a, b) => b.value - a.value)
      .map((row, i) => ({ ...row, rank: i + 1 }))
      .slice(0, 6);
  }

  private buildPublisherBars() {
    const palette = ['#f59e0b', '#6366f1', '#14b8a6', '#ec4899', '#a855f7', '#22c55e'];

    const counts = this.publishers.map((p, i) => ({
      label: p.name || p.publisher_name || `Publisher ${p.id}`,
      value: this.books.filter(b => this.sameId(b.publisher_id, p.id)).length,
      color: palette[i % palette.length],
    }));

    const max = Math.max(1, ...counts.map(c => c.value));

    this.publisherBars = counts
      .filter(c => c.value > 0)
      .map((row, i) => ({ rank: i + 1, ...row, pct: Math.round((row.value / max) * 100) }))
      .sort((a, b) => b.value - a.value)
      .map((row, i) => ({ ...row, rank: i + 1 }))
      .slice(0, 6);
  }

  /** Head-to-head comparison: top boards vs top publishers, by book count, normalized to the same scale for a side-by-side bar comparison. */
  private buildBoardVsPublisherComparison() {
    const topBoards = [...this.boardBars].slice(0, 5);
    const topPublishers = [...this.publisherBars].slice(0, 5);
    const len = Math.max(topBoards.length, topPublishers.length);
    const maxVal = Math.max(1, ...topBoards.map(b => b.value), ...topPublishers.map(p => p.value));

    const rows: ComparisonRow[] = [];
    for (let i = 0; i < len; i++) {
      const b = topBoards[i];
      const p = topPublishers[i];
      rows.push({
        label: `#${i + 1}`,
        a: b?.value ?? 0,
        b: p?.value ?? 0,
        aPct: Math.round(((b?.value ?? 0) / maxVal) * 100),
        bPct: Math.round(((p?.value ?? 0) / maxVal) * 100),
      });
    }
    this.boardVsPublisherComparison = rows;
  }

  private buildVerification() {
    this.verificationTotal = this.chapters.length;
    this.verificationVerified = this.chaptersVerifiedCount();
    this.verificationPct = this.verificationTotal
      ? Math.round((this.verificationVerified / this.verificationTotal) * 100)
      : 0;
  }

  private buildCoverage() {
    const topicsWithShots = this.topics.filter(t => this.parseScreenshots(t.screenshots).length > 0).length;
    this.screenshotCoveragePct = this.topics.length ? Math.round((topicsWithShots / this.topics.length) * 100) : 0;

    const audioEligible = this.books.filter(b => this.truthy(b.eligible_for_audio)).length;
    this.audioEligiblePct = this.books.length ? Math.round((audioEligible / this.books.length) * 100) : 0;

    const activeBooks = this.books.filter(b => this.truthy(b.is_active)).length;
    this.activeBooksPct = this.books.length ? Math.round((activeBooks / this.books.length) * 100) : 0;
  }

  private buildActivityFeed() {
    const items: ActivityItem[] = [];

    for (const b of this.books) {
      if (b.updated_by) {
        items.push({ who: b.updated_by, action: b.created_at === b.updated_at ? 'created book' : 'updated book', what: b.name, when: b.updated_at, kind: 'book' });
      }
    }
    for (const c of this.chapters) {
      if (c.updated_by) {
        items.push({ who: c.updated_by, action: c.created_at === c.updated_at ? 'created chapter' : 'updated chapter', what: c.name, when: c.updated_at, kind: 'chapter' });
      }
    }
    for (const t of this.topics) {
      if (t.updated_by) {
        items.push({ who: t.updated_by, action: t.created_at === t.updated_at ? 'created topic' : 'updated topic', what: t.name, when: t.updated_at, kind: 'topic' });
      }
    }
    for (const u of this.users) {
      if (u.created_by) {
        items.push({ who: u.created_by, action: 'added user', what: u.name, when: u.created_at, kind: 'user' });
      }
    }

    this.activityFeedAll = items
      .filter(i => !!i.when)
      .sort((a, b) => new Date(b.when as string).getTime() - new Date(a.when as string).getTime());

    this.activityCounts = {
      all: this.activityFeedAll.length,
      book: this.activityFeedAll.filter(i => i.kind === 'book').length,
      chapter: this.activityFeedAll.filter(i => i.kind === 'chapter').length,
      topic: this.activityFeedAll.filter(i => i.kind === 'topic').length,
      user: this.activityFeedAll.filter(i => i.kind === 'user').length,
    };
  }

  /** Monthly content-creation trend (books/chapters/topics) for the last 6 or 12 months, based on created_at. */
  private buildTrend() {
    const months = this.trendRange === '6m' ? 6 : 12;
    const now = new Date();
    const buckets: TrendPoint[] = [];
    const monthLabels: string[] = [];
    const keyOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
    const keyList: string[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleDateString('en-US', { month: 'short' }) + (months === 12 ? ` '${String(d.getFullYear()).slice(2)}` : '');
      monthLabels.push(label);
      keyList.push(keyOf(d));
      buckets.push({ label, books: 0, chapters: 0, topics: 0 });
    }

    const bucketOf = (dateStr: any): number => {
      if (!dateStr) return -1;
      const d = new Date(String(dateStr).replace(' ', 'T'));
      if (isNaN(d.getTime())) return -1;
      return keyList.indexOf(keyOf(d));
    };

    for (const b of this.books) {
      const idx = bucketOf(b.created_at);
      if (idx >= 0) buckets[idx].books++;
    }
    for (const c of this.chapters) {
      const idx = bucketOf(c.created_at);
      if (idx >= 0) buckets[idx].chapters++;
    }
    for (const t of this.topics) {
      const idx = bucketOf(t.created_at);
      if (idx >= 0) buckets[idx].topics++;
    }

    this.trendPoints = buckets;
    this.trendMaxValue = Math.max(1, ...buckets.map(p => Math.max(p.books, p.chapters, p.topics)));

    this.trendTotals = {
      books: buckets.reduce((s, p) => s + p.books, 0),
      chapters: buckets.reduce((s, p) => s + p.chapters, 0),
      topics: buckets.reduce((s, p) => s + p.topics, 0),
    };

    // growth: compare second half of range vs first half
    const half = Math.floor(buckets.length / 2) || 1;
    const firstHalf = buckets.slice(0, half);
    const secondHalf = buckets.slice(half);
    const sum = (arr: TrendPoint[], key: 'books' | 'chapters' | 'topics') => arr.reduce((s, p) => s + p[key], 0);
    const pctChange = (before: number, after: number) => before === 0 ? (after > 0 ? 100 : 0) : Math.round(((after - before) / before) * 100);

    this.trendGrowthPct = {
      books: pctChange(sum(firstHalf, 'books'), sum(secondHalf, 'books')),
      chapters: pctChange(sum(firstHalf, 'chapters'), sum(secondHalf, 'chapters')),
      topics: pctChange(sum(firstHalf, 'topics'), sum(secondHalf, 'topics')),
    };
  }

  setTrendRange(range: TrendRange) {
    this.trendRange = range;
    this.buildTrend();
  }

  /** SVG polyline points for a given trend series, scaled into a 0-100 viewbox. */
  trendLinePoints(key: 'books' | 'chapters' | 'topics'): string {
    const n = this.trendPoints.length;
    if (n === 0) return '';
    const stepX = 100 / (n - 1 || 1);
    return this.trendPoints
      .map((p, i) => {
        const x = i * stepX;
        const y = 100 - (p[key] / this.trendMaxValue) * 92 - 4; // 4-96 vertical padding
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  trendAreaPoints(key: 'books' | 'chapters' | 'topics'): string {
    const line = this.trendLinePoints(key);
    if (!line) return '';
    return `0,100 ${line} 100,100`;
  }

  private buildMonthComparison() {
    const now = new Date();
    const thisMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthKey = `${prevDate.getFullYear()}-${prevDate.getMonth()}`;

    const countInMonth = (rows: any[], key: string) => rows.filter(r => {
      if (!r.created_at) return false;
      const d = new Date(String(r.created_at).replace(' ', 'T'));
      if (isNaN(d.getTime())) return false;
      return `${d.getFullYear()}-${d.getMonth()}` === key;
    }).length;

    const build = (label: string, rows: any[]) => {
      const thisMonth = countInMonth(rows, thisMonthKey);
      const lastMonth = countInMonth(rows, prevMonthKey);
      const deltaPct = lastMonth === 0 ? (thisMonth > 0 ? 100 : 0) : Math.round(((thisMonth - lastMonth) / lastMonth) * 100);
      return { label, thisMonth, lastMonth, deltaPct };
    };

    this.monthComparison = [
      build('Books', this.books),
      build('Chapters', this.chapters),
      build('Topics', this.topics),
    ];
  }

  setActivityFilter(f: ActivityFilter) {
    this.activityFilter = f;
  }

  get activityFeed(): ActivityItem[] {
    const list = this.activityFilter === 'all'
      ? this.activityFeedAll
      : this.activityFeedAll.filter(i => i.kind === this.activityFilter);
    return list.slice(0, 8);
  }

  private chaptersVerifiedCount(): number {
    return this.chapters.filter(c => c.confidence === 'Verified').length;
  }

  private totalScreenshots(): number {
    return this.topics.reduce((sum, t) => sum + this.parseScreenshots(t.screenshots).length, 0);
  }

  private parseScreenshots(raw: any): any[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private truthy(v: any): boolean {
    return v === 1 || v === '1' || v === true;
  }

  countByRole(role: string) {
    return this.users.filter(u => u.role === role).length;
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

  get greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  get firstName(): string {
    return this.auth.user?.name?.split(' ')[0] ?? '';
  }

  get isAdminOrAbove(): boolean {
    const role = this.auth.user?.role;
    return role === 'superadmin' || role === 'admin';
  }

  ringDashArray(dashLength: number): string {
    return `${dashLength} ${100 - dashLength}`;
  }

  max2(a: number, b: number): number {
    return Math.max(a, b);
  }

  // ============================================================
  // NOTIFICATIONS (e.g. "X assigned you a topic")
  // ============================================================

  private notifPollHandle: any = null;
  private knownNotificationIds = new Set<number>();
  private hasLoadedNotificationsOnce = false;

  get unreadNotifications() {
    return this.notifications.filter(n => !n.is_read);
  }

  loadNotifications() {
    this.loadingNotifications = true;
    this.api.get<any>('/notifications').subscribe({
      next: (r: any) => {
        const list = Array.isArray(r?.data) ? r.data : [];

        // Play a sound only for notifications that are new since the last
        // load (not on the very first load, so opening the dashboard with
        // existing unread items doesn't beep every time).
        if (this.hasLoadedNotificationsOnce) {
          const hasNewUnread = list.some((n: any) => !n.is_read && !this.knownNotificationIds.has(Number(n.id)));
          if (hasNewUnread) this.playNotificationSound();
        }

        this.knownNotificationIds = new Set(list.map((n: any) => Number(n.id)));
        this.hasLoadedNotificationsOnce = true;

        this.notifications = list;
        this.loadingNotifications = false;
      },
      error: () => { this.loadingNotifications = false; }
    });

    // Poll every 30s so a running dashboard tab picks up new assignments
    // (and plays the sound) without needing a manual refresh.
    if (!this.notifPollHandle) {
      this.notifPollHandle = setInterval(() => this.loadNotifications(), 30000);
    }
  }

  ngOnDestroy() {
    if (this.notifPollHandle) clearInterval(this.notifPollHandle);
  }

  /** Short two-tone beep via Web Audio API — no sound file/asset needed. */
  private playNotificationSound() {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration + 0.02);
      };
      playTone(880, 0, 0.12);
      playTone(1175, 0.13, 0.16);
    } catch {
      // Audio not available (e.g. autoplay-blocked before any user interaction) — ignore.
    }
  }

  markNotificationRead(n: any) {
    if (n.is_read) return;
    this.api.put<any>(`/notifications/${n.id}/read`, {}).subscribe({
      next: (r: any) => { if (r?.status) n.is_read = 1; },
      error: () => {}
    });
  }

  markAllNotificationsRead() {
    if (!this.unreadNotifications.length) return;
    this.markingAllRead = true;
    this.api.put<any>('/notifications/read-all', {}).subscribe({
      next: (r: any) => {
        this.markingAllRead = false;
        if (r?.status) this.notifications.forEach(n => n.is_read = 1);
      },
      error: () => { this.markingAllRead = false; }
    });
  }

  notificationTimeAgo(dateStr: string): string {
    return this.timeAgo(dateStr);
  }

  /** Navigates to the Topics screen for the topic this notification refers to,
   *  and marks the notification as read along the way. */
  openNotificationTopic(n: any) {
    this.markNotificationRead(n);
    if (!n.chapter_id) return;
    this.router.navigate(['/topics'], { queryParams: { chapter_id: n.chapter_id } });
  }
}