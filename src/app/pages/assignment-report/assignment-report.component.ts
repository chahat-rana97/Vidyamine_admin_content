import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

interface AssigneeRow {
  admin_id: number;
  admin_name: string;
  admin_role: string;
  total_assigned: number;
  pending: number;
  pre_final: number;
  final: number;
  last_assigned_at: string | null;
}

interface AssignmentTopicRow {
  id: number;
  chapter_id: number;
  topic_code: string;
  sequence: number;
  name: string;
  topic_status: string;
  assigned_to: number | null;
  assigned_by: number | null;
  assigned_at: string | null;
  assigned_to_name: string | null;
  assigned_to_role: string | null;
  assigned_by_name: string | null;
  chapter_name: string;
  chapter_code: string;
  book_id: number;
  book_name: string;
  book_code: string;
}

@Component({
  selector: 'app-assignment-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './assignment-report.component.html',
  styleUrls: ['./assignment-report.component.css']
})
export class AssignmentReportComponent implements OnInit {

  loading = false;
  error = '';

  summary = {
    total_topics: 0,
    assigned_topics: 0,
    unassigned_topics: 0,
    final_topics: 0,
    pre_final_topics: 0,
    pending_topics: 0
  };

  byAssignee: AssigneeRow[] = [];
  topics: AssignmentTopicRow[] = [];
  filteredTopics: AssignmentTopicRow[] = [];

  // ── Pagination (topics table) ──
  pageSize = 25;
  currentPage = 1;
  pagedTopics: AssignmentTopicRow[] = [];

  // ── Filters ──
  filterAssignee = '';      // '', 'unassigned', or admin id (string)
  filterStatus = '';        // '', 'pending', 'pre_final', 'final'
  filterBook = '';          // '', or book id (string)
  filterChapter = '';       // '', or chapter id (string)
  filterSearch = '';        // free-text match on topic name / code / chapter / book

  bookOptions: { id: string; name: string }[] = [];
  chapterOptions: { id: string; name: string; bookId: string }[] = [];

  constructor(
    private api: ApiService,
    private toast: ToastService,
    private router: Router
  ) {}

  ngOnInit() {
    this.load();
  }

  load() {
    this.loading = true;
    this.error = '';

    this.api.get<any>('/reports/assignments').subscribe({
      next: (res: any) => {
        this.loading = false;
        if (!res || res.status === false) {
          this.error = res?.message || 'Failed to load assignment report.';
          return;
        }
        this.summary = res.data?.summary || this.summary;
        this.byAssignee = res.data?.by_assignee || [];
        this.topics = res.data?.topics || [];
        this.buildFilterOptions();
        this.applyFilters();
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Failed to load assignment report.';
      }
    });
  }

  retry() {
    this.load();
  }

  // ============================================================
  // FILTERS
  // ============================================================

  private buildFilterOptions() {
    const bookMap: { [id: string]: string } = {};
    const chapterMap: { [id: string]: { name: string; bookId: string } } = {};

    for (const t of this.topics) {
      if (t.book_id) bookMap[String(t.book_id)] = t.book_name || `Book #${t.book_id}`;
      if (t.chapter_id) {
        chapterMap[String(t.chapter_id)] = {
          name: t.chapter_name || `Chapter #${t.chapter_id}`,
          bookId: String(t.book_id || '')
        };
      }
    }

    this.bookOptions = Object.keys(bookMap)
      .map(id => ({ id, name: bookMap[id] }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.chapterOptions = Object.keys(chapterMap)
      .map(id => ({ id, name: chapterMap[id].name, bookId: chapterMap[id].bookId }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Chapter options narrowed to the currently selected book, so the Chapter dropdown stays relevant. */
  get visibleChapterOptions() {
    if (!this.filterBook) return this.chapterOptions;
    return this.chapterOptions.filter(c => c.bookId === this.filterBook);
  }

  onBookFilterChange() {
    // If the previously selected chapter doesn't belong to the newly picked book, clear it.
    if (this.filterChapter && !this.visibleChapterOptions.some(c => c.id === this.filterChapter)) {
      this.filterChapter = '';
    }
    this.applyFilters();
  }

  applyFilters() {
    let list = this.topics || [];

    if (this.filterAssignee === 'unassigned') {
      list = list.filter(t => !t.assigned_to);
    } else if (this.filterAssignee) {
      list = list.filter(t => String(t.assigned_to) === this.filterAssignee);
    }

    if (this.filterStatus) {
      list = list.filter(t => (t.topic_status || 'pending') === this.filterStatus);
    }

    if (this.filterBook) {
      list = list.filter(t => String(t.book_id) === this.filterBook);
    }

    if (this.filterChapter) {
      list = list.filter(t => String(t.chapter_id) === this.filterChapter);
    }

    if (this.filterSearch.trim()) {
      const q = this.filterSearch.trim().toLowerCase();
      list = list.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.topic_code || '').toLowerCase().includes(q) ||
        (t.chapter_name || '').toLowerCase().includes(q) ||
        (t.book_name || '').toLowerCase().includes(q)
      );
    }

    this.filteredTopics = list;
    this.currentPage = 1;
    this.updatePagedTopics();
  }

  // ============================================================
  // PAGINATION
  // ============================================================

  private updatePagedTopics() {
    const start = (this.currentPage - 1) * this.pageSize;
    this.pagedTopics = this.filteredTopics.slice(start, start + this.pageSize);
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredTopics.length / this.pageSize));
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
    this.updatePagedTopics();
  }

  nextPage() { this.goToPage(this.currentPage + 1); }
  prevPage() { this.goToPage(this.currentPage - 1); }

  /** Compact page-number list with ellipses, e.g. [1, '…', 4, 5, 6, '…', 12] — mirrors common pagination UIs. */
  get pageNumbers(): (number | string)[] {
    const total = this.totalPages;
    const current = this.currentPage;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

    const pages: (number | string)[] = [1];
    if (current > 3) pages.push('…');

    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let p = start; p <= end; p++) pages.push(p);

    if (current < total - 2) pages.push('…');
    pages.push(total);
    return pages;
  }

  get rangeStart(): number {
    return this.filteredTopics.length === 0 ? 0 : (this.currentPage - 1) * this.pageSize + 1;
  }

  get rangeEnd(): number {
    return Math.min(this.currentPage * this.pageSize, this.filteredTopics.length);
  }

  selectAssignee(id: string) {
    this.filterAssignee = this.filterAssignee === id ? '' : id;
    this.applyFilters();
  }

  /** Template helper: Angular templates can't call the global String() constructor directly. */
  asString(v: any): string {
    return String(v);
  }

  /** Template helper: coerces a pageNumbers entry (number | '…') back to a number for goToPage(). */
  asNumber(v: number | string): number {
    return typeof v === 'number' ? v : parseInt(v, 10);
  }

  clearFilters() {
    this.filterAssignee = '';
    this.filterStatus = '';
    this.filterBook = '';
    this.filterChapter = '';
    this.filterSearch = '';
    this.applyFilters();
  }

  get filtersActive(): boolean {
    return !!(this.filterAssignee || this.filterStatus || this.filterBook || this.filterChapter || this.filterSearch.trim());
  }

  // ============================================================
  // DISPLAY HELPERS
  // ============================================================

  statusClass(status: string): string {
    const s = (status || 'pending').toLowerCase();
    if (s === 'final') return 'status-final';
    if (s === 'pre_final') return 'status-prefinal';
    return 'status-pending';
  }

  statusLabel(status: string): string {
    const s = (status || 'pending').toLowerCase();
    if (s === 'final') return 'Final';
    if (s === 'pre_final') return 'Pre-Final';
    return 'Pending';
  }

  barPct(value: number, total: number): number {
    if (!total) return 0;
    return Math.round((value / total) * 100);
  }

  /** Donut chart segments for the overall status split (Final / Pre-Final / Pending). */
  donutSegments(): { color: string; dash: string; offset: number }[] {
    const r = 54;
    const circumference = 2 * Math.PI * r;
    const s = this.summary;
    const total = s.total_topics || 1;

    const finalLen = (s.final_topics / total) * circumference;
    const preFinalLen = (s.pre_final_topics / total) * circumference;
    const pendingLen = (s.pending_topics / total) * circumference;

    return [
      { color: '#22c55e', dash: `${finalLen} ${circumference - finalLen}`, offset: 0 },
      { color: '#6366f1', dash: `${preFinalLen} ${circumference - preFinalLen}`, offset: -finalLen },
      { color: '#f0a500', dash: `${pendingLen} ${circumference - pendingLen}`, offset: -(finalLen + preFinalLen) }
    ];
  }

  /** Tallest total_assigned value among assignees, used to scale the workload bar chart. */
  get maxAssigned(): number {
    return this.byAssignee.reduce((max, a) => Math.max(max, a.total_assigned), 0) || 1;
  }

  /** Count of distinct chapters that have at least one topic in the current dataset — fills out the overview card. */
  get chaptersInvolved(): number {
    const ids = new Set<number>();
    for (const t of this.topics) if (t.chapter_id) ids.add(t.chapter_id);
    return ids.size;
  }

  initials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    return parts.length > 1
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }

  formatDate(dt: string | null): string {
    if (!dt) return '—';
    const d = new Date(dt.replace(' ', 'T'));
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /** Opens the topic directly on the Topics screen, scrolled to and highlighted (mirrors Chapter Report's "Open" link). */
  openTopic(t: AssignmentTopicRow) {
    if (!t?.chapter_id || !t?.id) return;
    this.router.navigate(['/topics'], { queryParams: { chapter_id: t.chapter_id, topic_id: t.id } });
  }

  goBack() {
    window.history.length > 1 ? window.history.back() : this.router.navigate(['/dashboard']);
  }

  printReport() {
    window.print();
  }
}