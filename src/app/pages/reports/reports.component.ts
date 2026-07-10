import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

interface BookRow {
  id: number;
  total_books: number; active_books: number; inactive_books: number;
  master_books: number; sub_books: number; audio_books: number;
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.css']
})
export class ReportsComponent implements OnInit {

  // ── View mode: 'overview' | 'book' | 'chapter' ──
  view: 'overview' | 'book' | 'chapter' = 'overview';

  loading = false;
  loadingLookups = false;

  // ── Filters ──
  boards: any[] = [];
  classes: any[] = [];
  subjects: any[] = [];
  filterBoardId = '';
  filterClassId = '';
  filterSubjectId = '';
  filterClassOptions: any[] = [];
  filterSubjectOptions: any[] = [];

  // ── Overview data ──
  overview: any = null;

  // ── Book drill-down ──
  allBooksFlat: any[] = [];
  bookPickerSearch = '';
  selectedBookId: number | null = null;
  bookDetail: any = null;
  loadingBookDetail = false;

  // ── Chapter drill-down ──
  selectedChapterId: number | null = null;
  chapterDetail: any = null;
  loadingChapterDetail = false;

  constructor(private api: ApiService, private toast: ToastService, private route: ActivatedRoute) {}

  private readList(r: any): any[] {
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r)) return r;
    return [];
  }

  ngOnInit() {
    this.loadLookups();
    this.loadAllBooksForPicker();

    const bookIdParam = this.route.snapshot.queryParamMap.get('book_id');
    if (bookIdParam) {
      // deep-linked from Books screen "report" icon — skip the overview and
      // jump straight into that book's chapter report
      this.openBookReport(+bookIdParam);
    } else {
      this.loadOverview();
    }
  }

  // ============================================================
  // LOOKUPS / FILTERS
  // ============================================================

  loadLookups() {
    this.loadingLookups = true;
    this.api.get<any>('/boards').subscribe({
      next: (res) => {
        this.boards = this.readList(res);
        this.loadingLookups = false;
      },
      error: () => { this.loadingLookups = false; }
    });
  }

  onFilterBoardChange() {
    this.filterClassId = '';
    this.filterSubjectId = '';
    this.filterSubjectOptions = [];
    if (!this.filterBoardId) { this.filterClassOptions = []; this.loadOverview(); return; }
    this.api.get<any>(`/classes?board_id=${this.filterBoardId}`).subscribe({
      next: (res) => { this.filterClassOptions = this.readList(res); },
      error: () => {}
    });
    this.loadOverview();
  }

  onFilterClassChange() {
    this.filterSubjectId = '';
    if (!this.filterClassId) { this.filterSubjectOptions = []; this.loadOverview(); return; }
    this.api.get<any>(`/subjects?class_id=${this.filterClassId}`).subscribe({
      next: (res) => { this.filterSubjectOptions = this.readList(res); },
      error: () => {}
    });
    this.loadOverview();
  }

  onFilterSubjectChange() {
    this.loadOverview();
  }

  clearFilters() {
    this.filterBoardId = '';
    this.filterClassId = '';
    this.filterSubjectId = '';
    this.filterClassOptions = [];
    this.filterSubjectOptions = [];
    this.loadOverview();
  }

  get hasActiveFilters(): boolean {
    return !!(this.filterBoardId || this.filterClassId || this.filterSubjectId);
  }

  // ============================================================
  // OVERVIEW
  // ============================================================

  loadOverview() {
    this.loading = true;
    const params: string[] = [];
    if (this.filterBoardId) params.push(`board_id=${this.filterBoardId}`);
    if (this.filterClassId) params.push(`class_id=${this.filterClassId}`);
    if (this.filterSubjectId) params.push(`subject_id=${this.filterSubjectId}`);
    const qs = params.length ? `?${params.join('&')}` : '';

    this.api.get<any>(`/reports/overview${qs}`).subscribe({
      next: (res) => {
        this.overview = res?.data || null;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
        this.toast.error('Failed to load report overview');
      }
    });
  }

  // ── Derived numbers for the top stat cards ──
  get totalBooks(): number { return +this.overview?.books?.total_books || 0; }
  get activeBooks(): number { return +this.overview?.books?.active_books || 0; }
  get totalChapters(): number { return +this.overview?.chapters?.total_chapters || 0; }
  get verifiedChapters(): number { return +this.overview?.chapters?.verified_chapters || 0; }
  get unverifiedChapters(): number { return +this.overview?.chapters?.unverified_chapters || 0; }
  get totalTopics(): number { return +this.overview?.topics?.total_topics || 0; }
  get finalTopics(): number { return +this.overview?.topics?.final_topics || 0; }
  get preFinalTopics(): number { return +this.overview?.topics?.pre_final_topics || 0; }
  get pendingTopics(): number { return +this.overview?.topics?.pending_topics || 0; }
  get assignedTopics(): number { return +this.overview?.topics?.assigned_topics || 0; }
  get unassignedTopics(): number { return +this.overview?.topics?.unassigned_topics || 0; }
  get topicsWithScreenshots(): number { return +this.overview?.topics?.topics_with_screenshots || 0; }
  get topicsWithVideo(): number { return +this.overview?.topics?.topics_with_video || 0; }
  get topicsWithPpt(): number { return +this.overview?.topics?.topics_with_ppt || 0; }
  get topicsWithPdf(): number { return +this.overview?.topics?.topics_with_pdf || 0; }
  get totalScreenshots(): number { return +this.overview?.assets?.total_screenshots || 0; }
  get totalPptVersions(): number { return +this.overview?.assets?.total_ppt_versions || 0; }
  get totalPdfVersions(): number { return +this.overview?.assets?.total_pdf_versions || 0; }

  get avgChaptersPerBook(): string {
    return this.totalBooks ? (this.totalChapters / this.totalBooks).toFixed(1) : '0';
  }
  get avgTopicsPerChapter(): string {
    return this.totalChapters ? (this.totalTopics / this.totalChapters).toFixed(1) : '0';
  }
  get verifiedPct(): number {
    return this.totalChapters ? Math.round((this.verifiedChapters / this.totalChapters) * 100) : 0;
  }
  get finalPct(): number {
    return this.totalTopics ? Math.round((this.finalTopics / this.totalTopics) * 100) : 0;
  }
  get screenshotCoveragePct(): number {
    return this.totalTopics ? Math.round((this.topicsWithScreenshots / this.totalTopics) * 100) : 0;
  }

  // ── Donut chart segments for topic status ──
  get topicStatusDonut(): { label: string; value: number; color: string }[] {
    return [
      { label: 'Final', value: this.finalTopics, color: '#4ade80' },
      { label: 'Pre-Final', value: this.preFinalTopics, color: '#facc15' },
      { label: 'Pending', value: this.pendingTopics, color: '#f87171' },
    ];
  }

  get chapterVerificationDonut(): { label: string; value: number; color: string }[] {
    return [
      { label: 'Verified', value: this.verifiedChapters, color: '#4ade80' },
      { label: 'Unverified', value: this.unverifiedChapters, color: '#facc15' },
    ];
  }

  /** SVG conic-gradient-style donut built from stroke-dasharray segments on stacked circles */
  donutSegments(data: { label: string; value: number; color: string }[]): { color: string; dash: string; offset: number; label: string; value: number; pct: number }[] {
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const circumference = 2 * Math.PI * 40; // r=40
    let cumulative = 0;
    return data.map(d => {
      const pct = d.value / total;
      const dash = `${pct * circumference} ${circumference}`;
      const offset = -cumulative * circumference;
      cumulative += pct;
      return { color: d.color, dash, offset, label: d.label, value: d.value, pct: Math.round(pct * 100) };
    });
  }

  // ── Subject-wise bar chart data (sorted, capped for display) ──
  get subjectBars(): any[] {
    const rows = this.overview?.by_subject || [];
    const max = Math.max(1, ...rows.map((r: any) => +r.topic_count || 0));
    return rows.map((r: any) => ({
      ...r,
      barPct: Math.round(((+r.topic_count || 0) / max) * 100)
    }));
  }

  // ── Board/Class comparison table ──
  get classRows(): any[] {
    return this.overview?.by_class || [];
  }

  // ── Assignee workload ──
  get assigneeRows(): any[] {
    return this.overview?.by_assignee || [];
  }
  get maxAssigneeLoad(): number {
    return Math.max(1, ...this.assigneeRows.map(r => +r.total_assigned || 0));
  }

  // ============================================================
  // BOOK PICKER + DRILL-DOWN
  // ============================================================

  loadAllBooksForPicker() {
    this.api.get<any>('/books').subscribe({
      next: (res) => { this.allBooksFlat = this.readList(res); },
      error: () => {}
    });
  }

  get filteredBookPicker(): any[] {
    const q = this.bookPickerSearch.trim().toLowerCase();
    if (!q) return this.allBooksFlat.slice(0, 12);
    return this.allBooksFlat.filter(b =>
      (b.name || '').toLowerCase().includes(q) ||
      (b.code || '').toLowerCase().includes(q)
    ).slice(0, 12);
  }

  openBookReport(bookId: number) {
    this.selectedBookId = bookId;
    this.view = 'book';
    this.loadingBookDetail = true;
    this.bookDetail = null;
    this.api.get<any>(`/reports/books/${bookId}`).subscribe({
      next: (res) => {
        this.bookDetail = res?.data || null;
        this.loadingBookDetail = false;
      },
      error: () => {
        this.loadingBookDetail = false;
        this.toast.error('Failed to load book report');
      }
    });
  }

  backToOverview() {
    this.view = 'overview';
    this.selectedBookId = null;
    this.bookDetail = null;
    if (!this.overview) {
      this.loadOverview();
    }
  }

  get bookChapterRows(): any[] {
    return this.bookDetail?.chapters || [];
  }

  get bookTotalTopics(): number {
    return this.bookChapterRows.reduce((s, c) => s + (+c.topic_count || 0), 0);
  }
  get bookFinalTopics(): number {
    return this.bookChapterRows.reduce((s, c) => s + (+c.final_count || 0), 0);
  }
  get bookVerifiedChapters(): number {
    return this.bookChapterRows.filter(c => c.confidence === 'Verified').length;
  }

  chapterProgressPct(c: any): number {
    const total = +c.topic_count || 0;
    if (!total) return 0;
    return Math.round(((+c.final_count || 0) / total) * 100);
  }

  // ============================================================
  // CHAPTER DRILL-DOWN
  // ============================================================

  openChapterReport(chapterId: number) {
    this.selectedChapterId = chapterId;
    this.view = 'chapter';
    this.loadingChapterDetail = true;
    this.chapterDetail = null;
    this.api.get<any>(`/reports/chapters/${chapterId}`).subscribe({
      next: (res) => {
        this.chapterDetail = res?.data || null;
        this.loadingChapterDetail = false;
      },
      error: () => {
        this.loadingChapterDetail = false;
        this.toast.error('Failed to load chapter report');
      }
    });
  }

  backToBook() {
    this.view = 'book';
    this.selectedChapterId = null;
    this.chapterDetail = null;
  }

  get chapterTopicRows(): any[] {
    return this.chapterDetail?.topics || [];
  }

  statusLabel(status: string): string {
    if (status === 'final') return 'Final';
    if (status === 'pre_final') return 'Pre-Final';
    return 'Pending';
  }

  statusClass(status: string): string {
    if (status === 'final') return 'status-pill--final';
    if (status === 'pre_final') return 'status-pill--prefinal';
    return 'status-pill--pending';
  }

  // ── Export current overview to CSV (client-side, no backend dependency) ──
  exportSubjectCsv() {
    const rows = this.subjectBars;
    if (!rows.length) return;
    const header = ['Subject', 'Books', 'Chapters', 'Topics', 'Verified Chapters', 'Final Topics'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        `"${(r.subject_name || '').replace(/"/g, '""')}"`,
        r.book_count, r.chapter_count, r.topic_count, r.verified_chapters, r.final_topics
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subject_report.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
}