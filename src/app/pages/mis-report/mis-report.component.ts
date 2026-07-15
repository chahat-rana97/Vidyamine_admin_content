import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';

type ReportLevel = 'class' | 'subject' | 'book' | 'chapter';

interface Board {
  id: number;
  name: string;
}

interface ClassOption {
  id: number;
  name: string;
  board_id: number;
}

interface SubjectOption {
  id: number;
  name: string;
  class_id: number;
  board_id: number;
}

interface BookOption {
  id: number;
  name: string;
}

/** A deduped row shown in the class filter UI — one per distinct class name,
 *  holding every underlying class.id (across boards) that name maps to. */
interface ClassFilterOption {
  name: string;
  ids: number[];
}

interface MisRow {
  id: number | string;
  label: string;
  topics: number;
  screenshots: number;
  claude_ppt: number;
  claude_pdf: number;
  gpt_ppt: number;
}

type DocTab = 'claude_ppt' | 'claude_pdf' | 'gpt_ppt';

@Component({
  selector: 'app-mis-report',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mis-report.component.html',
  styleUrls: ['./mis-report.component.css']
})
export class MisReportComponent implements OnInit {

  // ---- master selector state ----
  boards: Board[] = [];
  selectedBoardId: number | 'all' = 'all';

  level: ReportLevel = 'class';

  allClasses: ClassOption[] = [];       // every class row returned by the API (may contain duplicate names across boards)
  classFilterOptions: ClassFilterOption[] = []; // deduped by name, for display
  selectedClassNames: Set<string> = new Set();  // which deduped names are checked (Subject level, multi-select)
  classFilterInitialised = false;               // true after the first successful class load
  showClassFilter = false;

  // ---- Book / Chapter level cascading single-select dropdowns ----
  // (class -> subject -> book, each narrows the next; all optional / "All ...")
  filterClasses: ClassOption[] = [];
  filterSubjects: SubjectOption[] = [];
  filterBooks: BookOption[] = [];
  selectedFilterClassId: number | 'all' = 'all';
  selectedFilterSubjectId: number | 'all' = 'all';
  selectedFilterBookId: number | 'all' = 'all';

  // ---- top tabs (visual emphasis only, doesn't hide other columns) ----
  activeTab: DocTab = 'claude_ppt';

  // ---- table data ----
  rows: MisRow[] = [];
  loading = false;

  constructor(private api: ApiService, private toast: ToastService) {}

  ngOnInit(): void {
    this.loadBoards();
    this.loadClasses();
    this.loadRows();
  }

  // ================= MASTER SELECTOR =================

  loadBoards(): void {
    this.api.get<any>('/boards').subscribe({
      next: (res) => { if (res?.status) this.boards = res.data || []; },
      error: () => this.toast.error('Failed to load boards')
    });
  }

  /** Loads all classes for the current board filter (or every class if 'all').
   *  Feeds both the Subject-level multi-select and the Book/Chapter-level dropdown. */
  loadClasses(): void {
    const url = this.selectedBoardId === 'all'
      ? '/classes'
      : `/classes?board_id=${this.selectedBoardId}`;

    this.api.get<any>(url).subscribe({
      next: (res) => {
        if (res?.status) {
          this.allClasses = res.data || [];

          // Dedupe by name (e.g. "Class 6" may exist under several boards
          // when "All Boards" is selected) — used by the Subject-level filter.
          const byName = new Map<string, number[]>();
          for (const c of this.allClasses) {
            if (!byName.has(c.name)) byName.set(c.name, []);
            byName.get(c.name)!.push(c.id);
          }
          this.classFilterOptions = Array.from(byName.entries()).map(([name, ids]) => ({ name, ids }));

          const isFirstLoad = this.selectedClassNames.size === 0 && !this.classFilterInitialised;
          if (isFirstLoad) {
            this.selectedClassNames = new Set(this.classFilterOptions.map(o => o.name));
          } else {
            const validNames = new Set(this.classFilterOptions.map(o => o.name));
            this.selectedClassNames = new Set(
              Array.from(this.selectedClassNames).filter(n => validNames.has(n))
            );
          }
          this.classFilterInitialised = true;

          // Book/Chapter-level dropdown uses the raw (non-deduped) list, since
          // it's a single-select and each row already has a real class.id.
          this.filterClasses = this.allClasses;
        }
      },
      error: () => this.toast.error('Failed to load classes')
    });
  }

  /** Loads subjects scoped to the selected Book/Chapter-level class filter (or all under the board). */
  loadFilterSubjects(): void {
    if (this.selectedFilterClassId === 'all') {
      // No class chosen — list every subject under the board (or globally).
      this.api.get<any>('/subjects').subscribe({
        next: (res) => { if (res?.status) this.filterSubjects = res.data || []; },
        error: () => this.toast.error('Failed to load subjects')
      });
      return;
    }
    this.api.get<any>(`/subjects?class_id=${this.selectedFilterClassId}`).subscribe({
      next: (res) => { if (res?.status) this.filterSubjects = res.data || []; },
      error: () => this.toast.error('Failed to load subjects')
    });
  }

  /** Loads books matching the current Book/Chapter-level class/subject filters. */
  loadFilterBooks(): void {
    const params: string[] = [];
    if (this.selectedBoardId !== 'all') params.push(`board_id=${this.selectedBoardId}`);
    if (this.selectedFilterClassId !== 'all') params.push(`class_id=${this.selectedFilterClassId}`);
    if (this.selectedFilterSubjectId !== 'all') params.push(`subject_id=${this.selectedFilterSubjectId}`);

    this.api.get<any>(`/books${params.length ? '?' + params.join('&') : ''}`).subscribe({
      next: (res) => { if (res?.status) this.filterBooks = res.data || []; },
      error: () => this.toast.error('Failed to load books')
    });
  }

  onBoardChange(): void {
    this.loadClasses();
    // Board changed — the class/subject/book dropdown chain is no longer
    // guaranteed valid, so reset it back to "All" and reload from scratch.
    this.selectedFilterClassId = 'all';
    this.selectedFilterSubjectId = 'all';
    this.selectedFilterBookId = 'all';
    if (this.level === 'book' || this.level === 'chapter') {
      this.loadFilterSubjects();
      this.loadFilterBooks();
    }
    this.loadRows();
  }

  setLevel(l: ReportLevel): void {
    if (this.level === l) return;
    this.level = l;

    if (l === 'book' || l === 'chapter') {
      this.loadFilterSubjects();
      this.loadFilterBooks();
    }
    this.loadRows();
  }

  /** Class dropdown changed (Book/Chapter level) — narrows subjects and books, resets both downstream selections. */
  onFilterClassChange(): void {
    this.selectedFilterSubjectId = 'all';
    this.selectedFilterBookId = 'all';
    this.loadFilterSubjects();
    this.loadFilterBooks();
    this.loadRows();
  }

  /** Subject dropdown changed (Book/Chapter level) — narrows books, resets book selection. */
  onFilterSubjectChange(): void {
    this.selectedFilterBookId = 'all';
    this.loadFilterBooks();
    this.loadRows();
  }

  /** Book dropdown changed (Chapter level only). */
  onFilterBookChange(): void {
    this.loadRows();
  }

  toggleClassFilter(): void {
    this.showClassFilter = !this.showClassFilter;
  }

  isClassSelected(name: string): boolean {
    return this.selectedClassNames.has(name);
  }

  toggleClassSelection(name: string): void {
    if (this.selectedClassNames.has(name)) {
      this.selectedClassNames.delete(name);
    } else {
      this.selectedClassNames.add(name);
    }
  }

  selectAllClasses(): void {
    this.selectedClassNames = new Set(this.classFilterOptions.map(o => o.name));
  }

  clearAllClasses(): void {
    this.selectedClassNames.clear();
  }

  applyClassFilter(): void {
    this.showClassFilter = false;
    this.loadRows();
  }

  setTab(tab: DocTab): void {
    this.activeTab = tab;
  }

  // ================= DATA LOAD =================

  loadRows(): void {
    this.loading = true;

    const params: string[] = [`mode=${this.level}`];
    if (this.selectedBoardId !== 'all') {
      params.push(`board_id=${this.selectedBoardId}`);
    }

    if (this.level === 'subject') {
      // Class filter is only meaningful in Subject mode — narrows which
      // classes get aggregated into each subject row.
      if (this.selectedClassNames.size > 0 &&
          this.selectedClassNames.size < this.classFilterOptions.length) {
        const ids = this.classFilterOptions
          .filter(o => this.selectedClassNames.has(o.name))
          .flatMap(o => o.ids);
        params.push(`class_ids=${ids.join(',')}`);
      }
    } else if (this.level === 'book') {
      if (this.selectedFilterClassId !== 'all') params.push(`class_id=${this.selectedFilterClassId}`);
      if (this.selectedFilterSubjectId !== 'all') params.push(`subject_id=${this.selectedFilterSubjectId}`);
    } else if (this.level === 'chapter') {
      if (this.selectedFilterClassId !== 'all') params.push(`class_id=${this.selectedFilterClassId}`);
      if (this.selectedFilterSubjectId !== 'all') params.push(`subject_id=${this.selectedFilterSubjectId}`);
      if (this.selectedFilterBookId !== 'all') params.push(`book_id=${this.selectedFilterBookId}`);
    }

    this.api.get<any>(`/reports/mis?${params.join('&')}`).subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.status) {
          this.rows = res.data?.rows || [];
        } else {
          this.toast.error(res?.message || 'Failed to load MIS report');
        }
      },
      error: () => {
        this.loading = false;
        this.toast.error('Failed to load MIS report');
      }
    });
  }

  get selectedClassCountLabel(): string {
    if (this.selectedClassNames.size === this.classFilterOptions.length) return 'All Classes';
    if (this.selectedClassNames.size === 0) return 'No Classes';
    return `${this.selectedClassNames.size} Classes`;
  }

  get columnLabel(): string {
    switch (this.level) {
      case 'class': return 'Class';
      case 'subject': return 'Subject';
      case 'book': return 'Book';
      case 'chapter': return 'Chapter';
    }
  }

  get columnLabelPlural(): string {
    const plurals: Record<ReportLevel, string> = {
      class: 'classes', subject: 'subjects', book: 'books', chapter: 'chapters'
    };
    return this.rows.length === 1 ? this.columnLabel.toLowerCase() : plurals[this.level];
  }

  get totalTopics(): number {
    return this.rows.reduce((sum, r) => sum + (r.topics || 0), 0);
  }

  get totalScreenshots(): number {
    return this.rows.reduce((sum, r) => sum + (r.screenshots || 0), 0);
  }

  get totalClaudePpt(): number {
    return this.rows.reduce((sum, r) => sum + (r.claude_ppt || 0), 0);
  }

  get totalClaudePdf(): number {
    return this.rows.reduce((sum, r) => sum + (r.claude_pdf || 0), 0);
  }

  get totalGptPpt(): number {
    return this.rows.reduce((sum, r) => sum + (r.gpt_ppt || 0), 0);
  }
}