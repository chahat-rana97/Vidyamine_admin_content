import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

interface CoverageChapter {
  id: number;
  chapter_code: string;
  chapter_name: string;
  sequence: number;
  confidence: string;
  is_active: number;
  book_id: number;
  book_name: string;
  book_code: string;
  subject_id: number | null;
  subject_name: string | null;
  class_id: number | null;
  class_name: string | null;
  board_id: number | null;
  board_name: string | null;
  topic_count: number;
  final_topics: number;
  pre_final_topics: number;
  pending_topics: number;
  screenshot_count: number;
  // derived
  screenshotStatus?: 'none' | 'some' | 'ok';
  topicStatus?: 'none' | 'some' | 'ok';
}

interface CoverageGroup {
  key: string;
  chapters: CoverageChapter[];
  total: number;
  noScreenshots: number;
  noTopics: number;
  withScreenshots: number;
  withTopics: number;
  pct: number; // overall "has at least something" %
  barColor: string;
}

type ShowFilter = 'all' | 'no-screenshots' | 'no-topics' | 'no-either' | 'complete';
type GroupBy = 'book' | 'subject' | 'class';

@Component({
  selector: 'app-chapter-coverage-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chapter-coverage-report.component.html',
  styleUrls: ['./chapter-coverage-report.component.css']
})
export class ChapterCoverageReportComponent implements OnInit {

  readonly SCREENSHOT_TARGET = 8;
  readonly TOPIC_TARGET = 1; // a chapter "has topics" once it has at least one

  loading = false;
  error = '';

  allChapters: CoverageChapter[] = [];
  filteredChapters: CoverageChapter[] = [];
  groups: CoverageGroup[] = [];
  openGroups = new Set<string>();

  // ── filter option lists, derived from loaded data ──
  boardOptions: { id: number; name: string }[] = [];
  classOptions: { id: number; name: string }[] = [];
  subjectOptions: { id: number; name: string }[] = [];
  bookOptions: { id: number; name: string }[] = [];

  // ── filter state ──
  filterBoard = '';
  filterClass = '';
  /** Subject NAME (not id) — subject ids repeat per class, so matching by
   *  name is what lets "Mathematics" pull chapters from every class at once. */
  filterSubject = '';
  filterBook = '';
  filterSearch = '';
  filterShow: ShowFilter = 'all';
  groupBy: GroupBy = 'book';

  // ── summary tiles ──
  summary = {
    total: 0,
    noScreenshots: 0,
    noTopics: 0,
    noEither: 0,
    fullyCovered: 0,
    totalScreenshots: 0,
    totalTopics: 0
  };

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

    this.api.get<any>('/reports/chapter-coverage').subscribe({
      next: (res: any) => {
        this.loading = false;
        if (!res || res.status === false) {
          this.error = res?.message || 'Failed to load chapter coverage report.';
          return;
        }
        const chapters: CoverageChapter[] = res.data?.chapters || [];
        for (const c of chapters) {
          c.screenshotStatus = this.screenshotStatus(c.screenshot_count);
          c.topicStatus = this.topicStatus(c.topic_count);
        }
        this.allChapters = chapters;
        this.buildFilterOptions();
        this.applyFilters();
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Failed to load chapter coverage report.';
      }
    });
  }

  retry() {
    this.load();
  }

  // ============================================================
  // STATUS HELPERS
  // ============================================================

  screenshotStatus(count: number): 'none' | 'some' | 'ok' {
    if (!count) return 'none';
    return count >= this.SCREENSHOT_TARGET ? 'ok' : 'some';
  }

  topicStatus(count: number): 'none' | 'some' | 'ok' {
    if (!count) return 'none';
    return 'ok';
  }

  // ============================================================
  // FILTER OPTIONS (cascading, derived from data actually loaded)
  // ============================================================

  private uniqBy<T>(arr: T[], key: (t: T) => string | number | null): T[] {
    const seen = new Set<string | number>();
    const out: T[] = [];
    for (const item of arr) {
      const k = key(item);
      if (k === null || k === undefined) continue;
      if (!seen.has(k)) { seen.add(k); out.push(item); }
    }
    return out;
  }

  buildFilterOptions() {
    this.boardOptions = this.uniqBy(this.allChapters, c => c.board_id)
      .map(c => ({ id: c.board_id as number, name: c.board_name || '—' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.refreshDependentOptions();
  }

  refreshDependentOptions() {
    let pool = this.allChapters;
    if (this.filterBoard) pool = pool.filter(c => String(c.board_id) === this.filterBoard);

    this.classOptions = this.uniqBy(pool, c => c.class_id)
      .map(c => ({ id: c.class_id as number, name: c.class_name || '—' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (this.filterClass) pool = pool.filter(c => String(c.class_id) === this.filterClass);

    // Subjects repeat per class (each class has its own "Mathematics" row with a
    // different subject_id), so dedupe by NAME here rather than by id — otherwise
    // the dropdown shows the same subject once per class. When a class filter is
    // already active the pool is scoped to that class, so this naturally still
    // shows just that class's subjects, one each.
    this.subjectOptions = this.uniqBy(pool, c => c.subject_name)
      .map(c => ({ id: c.subject_id as number, name: c.subject_name || '—' }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (this.filterSubject) pool = pool.filter(c => this.subjectMatches(c));

    this.bookOptions = this.uniqBy(pool, c => c.book_id)
      .map(c => ({ id: c.book_id, name: c.book_name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** filterSubject holds a subject NAME (not id) so selecting "Mathematics" matches
   *  every class's Mathematics chapters, not just the one whose id happened to be
   *  used to populate the dropdown. */
  private subjectMatches(c: CoverageChapter): boolean {
    return (c.subject_name || '—') === this.filterSubject;
  }

  onBoardChange() {
    this.filterClass = '';
    this.filterSubject = '';
    this.filterBook = '';
    this.refreshDependentOptions();
    this.applyFilters();
  }

  onClassChange() {
    this.filterSubject = '';
    this.filterBook = '';
    this.refreshDependentOptions();
    this.applyFilters();
  }

  onSubjectChange() {
    this.filterBook = '';
    this.refreshDependentOptions();
    this.applyFilters();
  }

  setShow(s: ShowFilter) {
    this.filterShow = s;
    this.applyFilters();
  }

  setGroupBy(g: GroupBy) {
    this.groupBy = g;
    this.openGroups.clear();
    this.applyFilters();
  }

  clearFilters() {
    this.filterBoard = '';
    this.filterClass = '';
    this.filterSubject = '';
    this.filterBook = '';
    this.filterSearch = '';
    this.filterShow = 'all';
    this.refreshDependentOptions();
    this.applyFilters();
  }

  get filtersActive(): boolean {
    return !!(this.filterBoard || this.filterClass || this.filterSubject || this.filterBook ||
      this.filterSearch.trim() || this.filterShow !== 'all');
  }

  // ============================================================
  // FILTERING + GROUPING
  // ============================================================

  applyFilters() {
    let list = this.allChapters;

    if (this.filterBoard) list = list.filter(c => String(c.board_id) === this.filterBoard);
    if (this.filterClass) list = list.filter(c => String(c.class_id) === this.filterClass);
    if (this.filterSubject) list = list.filter(c => this.subjectMatches(c));
    if (this.filterBook) list = list.filter(c => String(c.book_id) === this.filterBook);

    if (this.filterSearch.trim()) {
      const q = this.filterSearch.trim().toLowerCase();
      list = list.filter(c =>
        (c.chapter_name || '').toLowerCase().includes(q) ||
        (c.chapter_code || '').toLowerCase().includes(q) ||
        (c.book_name || '').toLowerCase().includes(q)
      );
    }

    switch (this.filterShow) {
      case 'no-screenshots':
        list = list.filter(c => c.screenshot_count === 0);
        break;
      case 'no-topics':
        list = list.filter(c => c.topic_count === 0);
        break;
      case 'no-either':
        list = list.filter(c => c.screenshot_count === 0 || c.topic_count === 0);
        break;
      case 'complete':
        list = list.filter(c => c.screenshotStatus === 'ok' && c.topicStatus === 'ok');
        break;
    }

    this.filteredChapters = list;
    this.buildSummary(list);
    this.buildGroups(list);
  }

  private buildSummary(list: CoverageChapter[]) {
    this.summary = {
      total: list.length,
      noScreenshots: list.filter(c => c.screenshot_count === 0).length,
      noTopics: list.filter(c => c.topic_count === 0).length,
      noEither: list.filter(c => c.screenshot_count === 0 || c.topic_count === 0).length,
      fullyCovered: list.filter(c => c.screenshotStatus === 'ok' && c.topicStatus === 'ok').length,
      totalScreenshots: list.reduce((a, c) => a + c.screenshot_count, 0),
      totalTopics: list.reduce((a, c) => a + c.topic_count, 0)
    };
  }

  private groupKey(c: CoverageChapter): string {
    if (this.groupBy === 'class') return c.class_name || 'Unassigned Class';
    if (this.groupBy === 'subject') return c.subject_name || 'Unassigned Subject';
    return c.book_name || 'Unassigned Book';
  }

  private buildGroups(list: CoverageChapter[]) {
    const map = new Map<string, CoverageChapter[]>();
    for (const c of list) {
      const k = this.groupKey(c);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }

    const groups: CoverageGroup[] = [];
    for (const [key, chapters] of map.entries()) {
      const total = chapters.length;
      const noScreenshots = chapters.filter(c => c.screenshot_count === 0).length;
      const noTopics = chapters.filter(c => c.topic_count === 0).length;
      const withScreenshots = total - noScreenshots;
      const withTopics = total - noTopics;
      // "coverage" = chapters that have both screenshots and topics
      const covered = chapters.filter(c => c.screenshot_count > 0 && c.topic_count > 0).length;
      const pct = total ? Math.round((covered / total) * 100) : 0;
      const barColor = (noScreenshots === total || noTopics === total)
        ? 'var(--report-cov-none)'
        : (noScreenshots > 0 || noTopics > 0)
          ? 'var(--report-cov-some)'
          : 'var(--report-cov-ok)';

      groups.push({ key, chapters, total, noScreenshots, noTopics, withScreenshots, withTopics, pct, barColor });
    }

    // Sort groups: worst coverage first, so gaps surface immediately
    groups.sort((a, b) => a.pct - b.pct || a.key.localeCompare(b.key));

    this.groups = groups;

    // Auto-open small result sets or any group with gaps, same spirit as the reference MIS screen
    if (this.openGroups.size === 0) {
      for (const g of groups) {
        if (groups.length <= 3 || g.noScreenshots > 0 || g.noTopics > 0) {
          this.openGroups.add(g.key);
        }
      }
    }
  }

  toggleGroup(key: string) {
    if (this.openGroups.has(key)) this.openGroups.delete(key);
    else this.openGroups.add(key);
  }

  isGroupOpen(key: string): boolean {
    return this.openGroups.has(key);
  }

  // ============================================================
  // NAVIGATION
  // ============================================================

  openChapter(c: CoverageChapter) {
    this.router.navigate(['/reports/chapters', c.id]);
  }

  printReport() {
    window.print();
  }
}