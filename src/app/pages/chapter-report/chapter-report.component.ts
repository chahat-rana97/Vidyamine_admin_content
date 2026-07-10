import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-chapter-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chapter-report.component.html',
  styleUrls: ['./chapter-report.component.css']
})
export class ChapterReportComponent implements OnInit {

  chapterId: number | null = null;

  loading = false;
  error = '';
  chapter: any = null;
  topics: any[] = [];

  summary = {
    total: 0, final: 0, preFinal: 0, pending: 0,
    assigned: 0, unassigned: 0,
    withScreenshots: 0, withVideo: 0,
    claudePpt: 0, gptPpt: 0, claudePdf: 0,
    pctFinal: 0, pctPreFinal: 0, pctPending: 0
  };

  byAssignee: { name: string; total: number; pending: number; preFinal: number; final: number }[] = [];

  // ── Topic table filters ──
  filterStatus = '';        // '', 'pending', 'pre_final', 'final'
  filterAssignee = '';      // '', 'unassigned', or an admin id (as string)
  filterClaudePpt = '';     // '', 'yes', 'no'
  filterGptPpt = '';        // '', 'yes', 'no'
  filterClaudePdf = '';     // '', 'yes', 'no'
  filterSearch = '';        // free-text match on topic name / topic code

  // Assignee dropdown options, derived from the loaded topics
  assigneeOptions: { id: string; name: string }[] = [];

  filteredTopics: any[] = [];

  constructor(
    private api: ApiService,
    private toast: ToastService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit() {
    this.route.paramMap.subscribe(params => {
      const id = params.get('id');
      this.chapterId = id ? Number(id) : null;
      if (this.chapterId) {
        this.load(this.chapterId);
      } else {
        this.error = 'No chapter specified.';
      }
    });
  }

  load(id: number) {
    this.loading = true;
    this.error = '';
    this.chapter = null;
    this.topics = [];

    this.api.get<any>(`/reports/chapters/${id}`).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (!res || res.status === false) {
          this.error = res?.message || 'Failed to load chapter report.';
          return;
        }
        this.chapter = res.data?.chapter || null;
        this.topics = res.data?.topics || [];
        this.buildSummary();
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Failed to load chapter report.';
      }
    });
  }

  retry() {
    if (this.chapterId) this.load(this.chapterId);
  }

  private buildSummary() {
    const topics = this.topics || [];
    const total = topics.length;

    let final = 0, preFinal = 0, pending = 0, assigned = 0, unassigned = 0;
    let withScreenshots = 0, withVideo = 0, claudePpt = 0, gptPpt = 0, claudePdf = 0;

    const claudePptCols = ['slide_claude_ppt','slide_claude_ppt_v1','slide_claude_ppt_v2','slide_claude_ppt_v3','slide_claude_ppt_v4','slide_claude_ppt_v5'];
    const gptPptCols = ['slide_gpt_ppt','slide_gpt_ppt_v1','slide_gpt_ppt_v2','slide_gpt_ppt_v3','slide_gpt_ppt_v4','slide_gpt_ppt_v5'];
    const claudePdfCols = ['slide_claude_pdf','slide_claude_pdf_v1','slide_claude_pdf_v2','slide_claude_pdf_v3','slide_claude_pdf_v4','slide_claude_pdf_v5'];

    const assigneeMap: { [name: string]: { total: number; pending: number; preFinal: number; final: number } } = {};

    for (const t of topics) {
      const status = (t.topic_status || 'pending').toLowerCase();
      if (status === 'final') final++;
      else if (status === 'pre_final') preFinal++;
      else pending++;

      if (t.assigned_to) assigned++; else unassigned++;

      if (Number(t.screenshot_count) > 0) withScreenshots++;
      if (t.has_video || t.youtube_link) withVideo++;

      if (claudePptCols.some(col => !!t[col])) claudePpt++;
      if (gptPptCols.some(col => !!t[col])) gptPpt++;
      if (claudePdfCols.some(col => !!t[col])) claudePdf++;

      const name = t.assigned_to_name || (t.assigned_to ? `User #${t.assigned_to}` : 'Unassigned');
      if (!assigneeMap[name]) assigneeMap[name] = { total: 0, pending: 0, preFinal: 0, final: 0 };
      assigneeMap[name].total++;
      if (status === 'final') assigneeMap[name].final++;
      else if (status === 'pre_final') assigneeMap[name].preFinal++;
      else assigneeMap[name].pending++;
    }

    this.summary = {
      total, final, preFinal, pending, assigned, unassigned,
      withScreenshots, withVideo, claudePpt, gptPpt, claudePdf,
      pctFinal: total ? Math.round((final / total) * 100) : 0,
      pctPreFinal: total ? Math.round((preFinal / total) * 100) : 0,
      pctPending: total ? Math.round((pending / total) * 100) : 0
    };

    this.byAssignee = Object.keys(assigneeMap)
      .map(name => ({ name, ...assigneeMap[name] }))
      .sort((a, b) => b.total - a.total);

    // Build assignee dropdown options keyed by actual admin id, so two
    // people who happen to share a display name never get merged. Sorted
    // alphabetically for a predictable dropdown.
    const optionMap: { [id: string]: string } = {};
    for (const t of topics) {
      if (t.assigned_to) {
        optionMap[String(t.assigned_to)] = t.assigned_to_name || `User #${t.assigned_to}`;
      }
    }
    this.assigneeOptions = Object.keys(optionMap)
      .map(id => ({ id, name: optionMap[id] }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.applyFilters();
  }

  donutSegments(): { color: string; dash: string; offset: number }[] {
    const r = 54;
    const circumference = 2 * Math.PI * r;
    const s = this.summary;
    const total = s.total || 1;

    const finalLen = (s.final / total) * circumference;
    const preFinalLen = (s.preFinal / total) * circumference;
    const pendingLen = (s.pending / total) * circumference;

    return [
      { color: '#22c55e', dash: `${finalLen} ${circumference - finalLen}`, offset: 0 },
      { color: '#6366f1', dash: `${preFinalLen} ${circumference - preFinalLen}`, offset: -finalLen },
      { color: '#f0a500', dash: `${pendingLen} ${circumference - pendingLen}`, offset: -(finalLen + preFinalLen) }
    ];
  }

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

  isActive(v: any): boolean { return Number(v) === 1; }

  // ============================================================
  // TOPIC TABLE FILTERS
  // ============================================================

  private readonly claudePptCols = ['slide_claude_ppt','slide_claude_ppt_v1','slide_claude_ppt_v2','slide_claude_ppt_v3','slide_claude_ppt_v4','slide_claude_ppt_v5'];
  private readonly gptPptCols = ['slide_gpt_ppt','slide_gpt_ppt_v1','slide_gpt_ppt_v2','slide_gpt_ppt_v3','slide_gpt_ppt_v4','slide_gpt_ppt_v5'];
  private readonly claudePdfCols = ['slide_claude_pdf','slide_claude_pdf_v1','slide_claude_pdf_v2','slide_claude_pdf_v3','slide_claude_pdf_v4','slide_claude_pdf_v5'];

  hasClaudePpt(t: any): boolean { return this.claudePptCols.some(col => !!t[col]); }
  hasGptPpt(t: any): boolean { return this.gptPptCols.some(col => !!t[col]); }
  hasClaudePdf(t: any): boolean { return this.claudePdfCols.some(col => !!t[col]); }

  applyFilters() {
    let list = this.topics || [];

    if (this.filterStatus) {
      list = list.filter(t => (t.topic_status || 'pending').toLowerCase() === this.filterStatus);
    }

    if (this.filterAssignee === 'unassigned') {
      list = list.filter(t => !t.assigned_to);
    } else if (this.filterAssignee) {
      list = list.filter(t => String(t.assigned_to) === this.filterAssignee);
    }

    if (this.filterClaudePpt === 'yes') list = list.filter(t => this.hasClaudePpt(t));
    else if (this.filterClaudePpt === 'no') list = list.filter(t => !this.hasClaudePpt(t));

    if (this.filterGptPpt === 'yes') list = list.filter(t => this.hasGptPpt(t));
    else if (this.filterGptPpt === 'no') list = list.filter(t => !this.hasGptPpt(t));

    if (this.filterClaudePdf === 'yes') list = list.filter(t => this.hasClaudePdf(t));
    else if (this.filterClaudePdf === 'no') list = list.filter(t => !this.hasClaudePdf(t));

    if (this.filterSearch.trim()) {
      const q = this.filterSearch.trim().toLowerCase();
      list = list.filter(t =>
        (t.name || '').toLowerCase().includes(q) ||
        (t.topic_code || '').toLowerCase().includes(q)
      );
    }

    this.filteredTopics = list;
  }

  clearFilters() {
    this.filterStatus = '';
    this.filterAssignee = '';
    this.filterClaudePpt = '';
    this.filterGptPpt = '';
    this.filterClaudePdf = '';
    this.filterSearch = '';
    this.applyFilters();
  }

  get filtersActive(): boolean {
    return !!(this.filterStatus || this.filterAssignee || this.filterClaudePpt || this.filterGptPpt || this.filterClaudePdf || this.filterSearch.trim());
  }

  /** Opens the given topic directly on the Topics screen, scrolled to and highlighted. */
  openTopic(t: any) {
    if (!this.chapterId || !t?.id) return;
    this.router.navigate(['/topics'], { queryParams: { chapter_id: this.chapterId, topic_id: t.id } });
  }

  goBack() {
    // Prefer real browser back so filters/pagination on the chapters list
    // are preserved exactly as the user left them.
    window.history.length > 1 ? window.history.back() : this.router.navigate(['/chapters']);
  }

  printReport() {
    window.print();
  }
}